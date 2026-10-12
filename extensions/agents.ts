import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { Type } from "typebox";
import { Key } from "@earendil-works/pi-tui";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as piSdk from "@earendil-works/pi-coding-agent";
import {
  agentNames, childResourceArgs, completeProjectAgentConfig, detectProfileIntent, isAgentName, loadAgentConfig, profiles, routeSubagent, subagentTools,
  type AgentConfig, type AgentName, type Effort,
} from "../lib/agents.ts";
import { limitOutput, piInvocation, runSubagent } from "../lib/subagent-runner.ts";
import { normalizeSubagentScope, SubagentScheduler, type SchedulerStatus } from "../lib/subagent-scheduler.ts";

const AgentSchema = Type.Union(agentNames.map((name) => Type.Literal(name)));
const parameters = Type.Object({
  agent: AgentSchema,
  purpose: Type.Optional(Type.Literal("explore", { description: "Use the configured small_model for read-only codebase exploration; available only for ask when delegate_exploration is enabled." })),
  mode: Type.Optional(Type.Union([Type.Literal("read"), Type.Literal("write")], { description: "Declared work mode. Defaults to write, except read-only plan/ask and exploration. Read mode selects only read tools." })),
  paths: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "Repository-relative files or directories the task may modify. Missing paths mean broad write ownership. Overlaps and shared configuration serialize writes." })),
  task: Type.String({ minLength: 1, maxLength: 50_000, description: "Self-contained task including needed context; conversation history is not inherited." }),
});
const stateType = "piexis-agent";
const profileChoices = [...agentNames, "auto"];

export default function agentsExtension(pi: ExtensionAPI) {
  let active: AgentName = "code";
  let pinned = false;
  let activationOrigin: "manual" | "automatic" | undefined;
  let autoProfileEnabled = false;
  let explorationEnabled = false;
  let switching = false;
  let startupHandled = false;
  const depthText = process.env.PIEXIS_SUBAGENT_DEPTH ?? "0";
  const depth = /^[0-2]$/.test(depthText) ? Number(depthText) : 2;
  const jobs = new Map<AbortController, Promise<unknown>>();
  let scheduler = new SubagentScheduler();
  const childStatuses = new Map<AbortController, { agent: AgentName; status: "queued" | "running" }>();

  function childStatus(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;
    const groups = (["running", "queued"] as const).map((state) => {
      const names = [...childStatuses.values()].filter((job) => job.status === state).map((job) => job.agent);
      return names.length ? `${names.length} ${state}: ${names.join(", ")}` : "";
    }).filter(Boolean);
    ctx.ui.setStatus("piexis-subagents", groups.length ? `subagents · ${groups.join(" · ")}` : undefined);
  }
  const inheritedScope = process.env.PIEXIS_SUBAGENT_SCOPE ? JSON.parse(process.env.PIEXIS_SUBAGENT_SCOPE) : undefined;
  const extensionPath = fileURLToPath(import.meta.url);

  pi.registerFlag("agent", { description: `Agent profile: ${agentNames.join(", ")}`, type: "string" });

  function status(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;
    ctx.ui.setStatus("piexis-agent", `agent:${active}`);
    ctx.ui.setStatus("piexis-agent-mode", autoProfileEnabled ? (pinned ? "manual" : "auto") : "");
  }

  function persist() {
    pi.appendEntry(stateType, { agent: active, origin: activationOrigin, pinned });
  }

  function canSwitch(ctx: ExtensionContext) {
    return !switching && ctx.isIdle() && jobs.size === 0;
  }

  async function activate(name: AgentName, ctx: ExtensionContext, origin: "manual" | "automatic", config?: AgentConfig): Promise<boolean> {
    if (!canSwitch(ctx)) {
      ctx.ui.notify("Wait for the current agent to finish before switching profiles.", "warning");
      return false;
    }
    switching = true;
    const previousModel = ctx.model;
    const previousEffort = (ctx.thinkingLevel ?? pi.getThinkingLevel()) as Effort;
    const previousState = { active, activationOrigin, pinned };
    let modelChanged = false;
    let effortChanged = false;
    try {
      config ??= await loadAgentConfig(ctx.cwd, getAgentDir(), ctx.isProjectTrusted());
      const override = config.subagent_variant_overrides?.[name];
      const modelId = override?.model ?? config.model;
      if (modelId) {
        const slash = modelId.indexOf("/");
        const model = ctx.modelRegistry.find(modelId.slice(0, slash), modelId.slice(slash + 1));
        if (!model || !(await pi.setModel(model))) throw new Error(`Configured model unavailable: ${modelId}. Check /model and /login.`);
        modelChanged = true;
      }
      if (override?.effort !== undefined) { effortChanged = true; pi.setThinkingLevel(override.effort); }
      active = name;
      activationOrigin = origin;
      pinned = origin === "manual";
      persist();
      autoProfileEnabled = config.auto_profile === true;
      status(ctx);
      if (origin === "manual" || name !== previousState.active) {
        ctx.ui.notify(`Agent: ${active}${origin === "automatic" ? " (automatic)" : ""}`, "info");
      }
      return true;
    } catch (error) {
      // setModel can succeed before a later setting throws; keep a failed route atomic.
      active = previousState.active;
      activationOrigin = previousState.activationOrigin;
      pinned = previousState.pinned;
      try {
        if (modelChanged && previousModel && !(await pi.setModel(previousModel))) throw new Error("Previous model unavailable");
        if (modelChanged || effortChanged) pi.setThinkingLevel(previousEffort);
      } catch (rollbackError) {
        ctx.ui.notify(`Agents: could not restore previous settings: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`, "warning");
      }
      ctx.ui.notify(`Agents: ${error instanceof Error ? error.message : String(error)}`, "warning");
      return false;
    } finally {
      switching = false;
    }
  }

  function restore(ctx: ExtensionContext) {
    active = "code";
    pinned = false;
    activationOrigin = undefined;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== stateType) continue;
      const data = entry.data as { agent?: unknown; origin?: unknown; pinned?: unknown } | undefined;
      if (!isAgentName(data?.agent)) continue;
      active = data.agent;
      activationOrigin = data.origin === "automatic" ? "automatic" : "manual";
      pinned = typeof data.pinned === "boolean" ? data.pinned : true;
    }
    status(ctx);
  }

  pi.on("session_start", async (event, ctx) => {
    if (jobs.size === 0) scheduler = new SubagentScheduler();
    try {
      const config = await loadAgentConfig(ctx.cwd, getAgentDir(), ctx.isProjectTrusted());
      explorationEnabled = Boolean(config.delegate_exploration);
      autoProfileEnabled = config.auto_profile === true;
    } catch { explorationEnabled = false; autoProfileEnabled = false; }
    restore(ctx);
    childStatus(ctx);
    if (!startupHandled && (!event.reason || event.reason === "startup")) {
      const flag = pi.getFlag("agent");
      if (isAgentName(flag)) {
        active = flag;
        activationOrigin = "manual";
        // Child processes receive --agent as their fixed role; only main branches persist a pin.
        if (depth === 0) { pinned = true; persist(); }
      } else if (flag !== undefined && flag !== "") ctx.ui.notify(`Unknown agent: ${flag}. Choose ${agentNames.join(", ")}.`, "warning");
    }
    startupHandled = true;
    status(ctx);
    if (depth >= 2) pi.setActiveTools(pi.getActiveTools().filter((name) => name !== "subagent"));
    // Only initialize a new main session; explicit CLI choices and resumed models remain authoritative.
    if (depth !== 0 || (event.reason && event.reason !== "startup" && event.reason !== "new") ||
      ctx.sessionManager.getBranch().some((entry) => entry.type === "message")) return;
    const args = process.argv.slice(2).slice(0, process.argv.indexOf("--") < 0 ? undefined : process.argv.indexOf("--") - 2);
    if (args.some((arg) => arg === "--model" || arg === "--models" || arg.startsWith("--model=") || arg.startsWith("--models="))) return;
    try {
      const config = await loadAgentConfig(ctx.cwd, getAgentDir(), ctx.isProjectTrusted());
      if (config.model) {
        const slash = config.model.indexOf("/");
        const model = ctx.modelRegistry.find(config.model.slice(0, slash), config.model.slice(slash + 1));
        if (!model || !(await pi.setModel(model))) throw new Error(`Configured model unavailable: ${config.model}`);
      }
    } catch (error) { ctx.ui.notify(`Agents: ${error instanceof Error ? error.message : String(error)}`, "warning"); }
  });
  pi.on("session_tree", (_event, ctx) => restore(ctx));

  pi.on("input", async (event, ctx) => {
    if (depth !== 0 || switching || jobs.size > 0 || !ctx.isIdle() ||
      (event.source !== "interactive" && event.source !== "rpc") || event.streamingBehavior === "steer" || event.streamingBehavior === "followUp" ||
      event.text.trimStart().startsWith("/")) return { action: "continue" as const };
    let config;
    try { config = await loadAgentConfig(ctx.cwd, getAgentDir(), ctx.isProjectTrusted()); }
    catch (error) {
      ctx.ui.notify(`Agents: ${error instanceof Error ? error.message : String(error)}. Request was not submitted.`, "warning");
      return { action: "handled" as const };
    }
    autoProfileEnabled = config.auto_profile === true;
    status(ctx);
    if (!autoProfileEnabled || pinned) return { action: "continue" as const };
    const name = detectProfileIntent(event.text);
    // The initial code profile has not applied a variant yet; an explicit first Execute must do so.
    if (!name || (name === active && activationOrigin !== undefined)) return { action: "continue" as const };
    if (!(await activate(name, ctx, "automatic", config))) {
      ctx.ui.notify("Automatic profile activation failed; request was not submitted. Fix the configuration or model and retry.", "warning");
      return { action: "handled" as const };
    }
    return { action: "continue" as const };
  });

  pi.registerCommand("setup-agents", {
    description: "Fill missing project agent.json settings with defaults without replacing configured values",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();
      if (!ctx.isProjectTrusted()) { ctx.ui.notify("Agent configuration is available only in trusted projects.", "warning"); return; }
      try {
        const currentModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
        const result = await completeProjectAgentConfig(ctx.cwd, getAgentDir(), currentModel);
        const message = result === "created" ? "Created .pi/agent.json with default agent settings."
          : result === "updated" ? "Added missing .pi/agent.json settings; existing values were preserved."
          : "Your project agent configuration is already complete.";
        ctx.ui.notify(message, "info");
      } catch (error) {
        ctx.ui.notify(`Agent configuration was not updated: ${error instanceof Error ? error.message : String(error)}`, "warning");
      }
    },
  });

  pi.registerCommand("profile", {
    description: "Switch agent profile (plan, orchestrator, debug, ask, code) or resume automatic routing (auto)",
    getArgumentCompletions: (prefix) => {
      const matches = profileChoices.filter((choice) => choice.startsWith(prefix));
      return matches.length > 0 ? matches.map((choice) => ({ value: choice, label: choice })) : null;
    },
    handler: async (args, ctx) => {
      await ctx.waitForIdle();
      let name: string | undefined = args.trim() || undefined;
      if (!name) {
        if (!ctx.hasUI) { ctx.ui.notify(`Current agent: ${active}. Use /profile <${profileChoices.join("|")}>.`, "info"); return; }
        name = await ctx.ui.select(`Agent profile (current: ${active})`, profileChoices);
        if (!name) return;
      }
      if (name === "auto") {
        let config;
        try { config = await loadAgentConfig(ctx.cwd, getAgentDir(), ctx.isProjectTrusted()); }
        catch (error) { ctx.ui.notify(`Agents: ${error instanceof Error ? error.message : String(error)}`, "warning"); return; }
        if (!config.auto_profile) { ctx.ui.notify("Enable auto_profile in agent.json before using /profile auto.", "warning"); return; }
        if (!canSwitch(ctx)) { ctx.ui.notify("Wait for the current agent to finish before switching profiles.", "warning"); return; }
        autoProfileEnabled = true;
        if (pinned) { pinned = false; persist(); }
        status(ctx);
        ctx.ui.notify("Agent profile routing is automatic.", "info");
        return;
      }
      if (!isAgentName(name)) { ctx.ui.notify(`Unknown agent: ${name}. Choose ${profileChoices.join(", ")}.`, "error"); return; }
      await activate(name, ctx, "manual");
    },
  });

  pi.registerShortcut(Key.alt("a"), {
    description: "Cycle agent profile (plan → orchestrator → debug → ask → code)",
    handler: async (ctx) => {
      if (ctx.mode !== "tui") return;
      await activate(agentNames[(agentNames.indexOf(active) + 1) % agentNames.length], ctx, "manual");
    },
  });

  pi.on("before_agent_start", (event) => ({
    systemPrompt: `${event.systemPrompt}\n\nPiexis agent profile: ${active}\n${profiles[active]}\n${depth > 0
      ? `You are a delegated subagent. Work only on the supplied task.${inheritedScope ? ` Declared ownership: ${inheritedScope.mode}; paths: ${JSON.stringify(inheritedScope.paths)}. Modify only these paths (an empty write list means broad ownership); keep nested delegation within this ownership.` : ""} If user input is needed, return the question to the parent; no terminal interaction is available. Report changed files, results, and unexecuted checks. If the subagent tool is available, use purpose: explore only for bounded read-only codebase exploration and return concise file paths, line numbers, and uncertainties.`
      : explorationEnabled
        ? "All five profiles are callable through subagent. Delegate only when a separate context helps; supply a focused task and all relevant context. For bounded codebase exploration involving discovery, several files, or a summary, delegate to subagent with agent: ask and purpose: explore. It uses the configured small model and must return concise findings with file paths, line numbers, and uncertainties. Keep planning, judgment, edits, and final verification here; do not delegate a trivial single read."
        : "All five profiles are callable through subagent. Delegate only when a separate context helps; supply a focused task and all relevant context."}`,
  }));

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: "Delegate a self-contained task to plan, orchestrator, debug, ask, or code in an isolated Pi process in this workspace. With delegate_exploration enabled, ask plus purpose: explore always uses the configured small_model with read-only tools. Other small tasks can automatically use small_model; variant overrides win. Model, effort, and routing reason are returned. Orchestrator calls can run concurrently, up to two, only for non-conflicting declared scopes. Other profiles remain sequential. Declare mode and precise paths; broad writes and shared configuration serialize writes. Scopes are cooperative, not sandboxing; child questions return to the parent.",
    executionMode: "parallel",
    parameters,
    async execute(_id, params, signal, onUpdate, ctx) {
      const parentProfile = active;
      const controller = new AbortController();
      const abort = () => controller.abort(signal?.reason);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      // Track preparation as well as queued/running work so shutdown and switching cannot race it.
      const job = executeJob();
      jobs.set(controller, job);
      try { return await job; }
      finally {
        jobs.delete(controller);
        childStatuses.delete(controller);
        childStatus(ctx);
        signal?.removeEventListener("abort", abort);
      }

      async function executeJob() {
        controller.signal.throwIfAborted();
        if (depth >= 2) throw new Error("Subagent delegation depth limit (2) reached");
        if (!isAgentName(params.agent) || !params.task.trim() || params.task.length > 50_000) throw new Error("A valid agent and non-empty task of at most 50000 characters are required");
        if ((parentProfile === "plan" || parentProfile === "ask") && params.agent !== "plan" && params.agent !== "ask") {
          throw new Error(`${parentProfile} may delegate only to plan or ask; switch to code, debug, or orchestrator for changes`);
        }
        const exploration = params.purpose === "explore";
        if (exploration && params.agent !== "ask") throw new Error("Exploration delegation requires agent: ask");
        const readOnly = exploration || params.agent === "plan" || params.agent === "ask";
        const parentScope = inheritedScope ? await normalizeSubagentScope(ctx.cwd, inheritedScope) : undefined;
        const scope = await normalizeSubagentScope(ctx.cwd, {
          mode: params.mode,
          paths: params.paths ?? (parentScope?.mode === "write" && !readOnly && params.mode !== "read" ? parentScope.paths : undefined),
        }, readOnly);
        if (scope.mode === "write" && parentScope) {
          if (parentScope.mode === "read" || (parentScope.paths.length > 0 && !parentScope.paths.includes(".") &&
            (scope.paths.length === 0 || scope.paths.some((path) => !parentScope.paths.some((owner) => path === owner || path.startsWith(`${owner}/`)))))) {
            throw new Error("Nested write scope must stay within the parent's declared ownership");
          }
        }
        if (!ctx.model) throw new Error("Select a main model before delegating");
        const config = await loadAgentConfig(ctx.cwd, getAgentDir(), ctx.isProjectTrusted());
        if (exploration && !config.delegate_exploration) throw new Error("Enable delegate_exploration in agent.json before delegating exploration");
        const route = routeSubagent(config, params.agent, params.task, `${ctx.model.provider}/${ctx.model.id}`, (ctx.thinkingLevel ?? pi.getThinkingLevel()) as Effort, exploration);
        const slash = route.model.indexOf("/");
        const selected = ctx.modelRegistry.find(route.model.slice(0, slash), route.model.slice(slash + 1));
        if (!selected || !ctx.modelRegistry.hasConfiguredAuth(selected)) throw new Error(`Subagent model unavailable: ${route.model}. Check /model and /login.`);
        const tools = subagentTools(scope.mode === "read" ? "ask" : params.agent, pi.getActiveTools(), depth + 1, config.delegate_exploration && !exploration);
        let scheduling: SchedulerStatus = { status: "queued" };
        const details = () => ({ agent: params.agent, ...route, mode: scope.mode, paths: scope.paths, broad: scope.broad, ...scheduling });
        const update = (text: string) => onUpdate?.({ content: [{ type: "text" as const, text: `${params.agent} · ${route.model} · ${route.effort} (${route.reason})\n${text}` }], details: details() });
        const args = ["--mode", "json", "--print", "--no-session", "--model", route.model,
          "--thinking", route.effort, "--agent", params.agent,
          ctx.isProjectTrusted() ? "--approve" : "--no-approve", ...childResourceArgs(process.argv.slice(2)),
          "--extension", resolve(extensionPath), "--tools", tools.join(",")];
        if (tools.length === 0) args.push("--no-tools");
        // Callable MCP tools must not escape a read-only child's explicit built-in loadout.
        if (scope.mode === "read") {
          if ("createMcpExtension" in piSdk) args.push("--no-mcp");
          args.push("--exclude-tools", "mcp__*");
        }
        const reportStatus = (state: SchedulerStatus) => {
          scheduling = state;
          if (state.status === "queued" || state.status === "running") {
            childStatuses.set(controller, { agent: params.agent, status: state.status });
          } else childStatuses.delete(controller);
          childStatus(ctx);
          update(`${state.status}${state.reason ? ` (${state.reason})` : ""} · ${scope.mode}${scope.paths.length ? ` · ${scope.paths.join(", ")}` : ""}`);
        };
        controller.signal.throwIfAborted();
        const result = await scheduler.schedule({
          scope, controller, serial: parentProfile !== "orchestrator",
          run: async () => {
            // A previous writer may have created a symlink while this request was queued.
            await normalizeSubagentScope(ctx.cwd, scope);
            return runSubagent({ invocation: piInvocation(), args, cwd: ctx.cwd, depth: depth + 1,
              task: params.task, scope, signal: controller.signal, onProgress: update });
          },
          onStatus: (state) => {
            // Runner results can resolve with provider errors; classify before reporting completion.
            if (state.status !== "completed") reportStatus(state);
          },
        });
        const failed = result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted" || Boolean(result.error);
        reportStatus({ status: result.stopReason === "aborted" ? "aborted" : failed ? "failed" : "completed" });
        return {
          content: [{ type: "text" as const, text: `${params.agent} · ${route.model} · ${route.effort} (${route.reason})\n${limitOutput(failed ? result.error || result.stderr || result.output || "Subagent failed" : result.output)}` }],
          details: { ...details(), ...result }, usage: result.usage, isError: failed,
        };
      }
    },
  });

  pi.on("session_shutdown", async () => {
    const closing = scheduler.shutdown("Session shutdown");
    for (const controller of jobs.keys()) controller.abort("Session shutdown");
    await closing;
    await Promise.allSettled(jobs.values());
  });
}
