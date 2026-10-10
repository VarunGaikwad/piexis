import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { Type } from "typebox";
import { Key } from "@earendil-works/pi-tui";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as piSdk from "@earendil-works/pi-coding-agent";
import {
  agentNames, childResourceArgs, isAgentName, loadAgentConfig, profiles, routeSubagent, subagentTools,
  type AgentName, type Effort,
} from "../lib/agents.ts";
import { limitOutput, piInvocation, runSubagent } from "../lib/subagent-runner.ts";

const AgentSchema = Type.Union(agentNames.map((name) => Type.Literal(name)));
const parameters = Type.Object({
  agent: AgentSchema,
  task: Type.String({ minLength: 1, maxLength: 50_000, description: "Self-contained task including needed context; conversation history is not inherited." }),
});
const stateType = "piexis-agent";

export default function agentsExtension(pi: ExtensionAPI) {
  let active: AgentName = "code";
  const depthText = process.env.PIEXIS_SUBAGENT_DEPTH ?? "0";
  const depth = /^[0-2]$/.test(depthText) ? Number(depthText) : 2;
  const jobs = new Map<AbortController, Promise<unknown>>();
  const extensionPath = fileURLToPath(import.meta.url);

  pi.registerFlag("agent", { description: `Agent profile: ${agentNames.join(", ")}`, type: "string" });

  function status(ctx: ExtensionContext) {
    if (ctx.hasUI) ctx.ui.setStatus("piexis-agent", `agent:${active}`);
  }

  function activate(name: AgentName, ctx: ExtensionContext) {
    active = name;
    pi.appendEntry(stateType, { agent: active });
    status(ctx);
    ctx.ui.notify(`Agent: ${active}`, "info");
  }

  function restore(ctx: ExtensionContext, applyFlag = false) {
    active = "code";
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== stateType) continue;
      const agent = (entry.data as { agent?: unknown } | undefined)?.agent;
      if (isAgentName(agent)) active = agent;
    }
    const flag = applyFlag ? pi.getFlag("agent") : undefined;
    if (isAgentName(flag)) active = flag;
    else if (flag !== undefined && flag !== "") ctx.ui.notify(`Unknown agent: ${flag}. Choose ${agentNames.join(", ")}.`, "warning");
    status(ctx);
  }

  pi.on("session_start", async (_event, ctx) => {
    restore(ctx, true);
    if (depth >= 2) pi.setActiveTools(pi.getActiveTools().filter((name) => name !== "subagent"));
    // Only initialize a new main session; explicit CLI choices and resumed models remain authoritative.
    if (depth !== 0 || ctx.sessionManager.getBranch().some((entry) => entry.type === "message")) return;
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

  pi.registerCommand("agent", {
    description: "Switch agent profile (plan, orchestrator, debug, ask, code)",
    handler: async (args, ctx) => {
      await ctx.waitForIdle();
      let name: string | undefined = args.trim() || undefined;
      if (!name) {
        if (!ctx.hasUI) { ctx.ui.notify(`Current agent: ${active}. Use /agent <${agentNames.join("|")}>.`, "info"); return; }
        name = await ctx.ui.select(`Agent profile (current: ${active})`, [...agentNames]);
        if (!name) return;
      }
      if (!isAgentName(name)) { ctx.ui.notify(`Unknown agent: ${name}. Choose ${agentNames.join(", ")}.`, "error"); return; }
      activate(name, ctx);
    },
  });

  pi.registerShortcut(Key.alt("a"), {
    description: "Cycle agent profile (plan → orchestrator → debug → ask → code)",
    handler: (ctx) => {
      if (ctx.mode !== "tui") return;
      if (!ctx.isIdle() || jobs.size > 0) {
        ctx.ui.notify("Wait for the current agent to finish before switching profiles.", "warning");
        return;
      }
      activate(agentNames[(agentNames.indexOf(active) + 1) % agentNames.length], ctx);
    },
  });

  pi.on("before_agent_start", (event) => ({
    systemPrompt: `${event.systemPrompt}\n\nPiexis agent profile: ${active}\n${profiles[active]}\n${depth > 0
      ? "You are a delegated subagent. Work only on the supplied task. If user input is needed, return the question to the parent; no terminal interaction is available. Report changed files, results, and unexecuted checks."
      : "All five profiles are callable through subagent. Delegate only when a separate context helps; supply a focused task and all relevant context."}`,
  }));

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: "Delegate a self-contained task to plan, orchestrator, debug, ask, or code in an isolated Pi process in this workspace. Small tasks automatically use the configured small_model; variant overrides win. Model, effort, and routing reason are returned. Calls are sequential to avoid concurrent workspace edits. No sandboxing; child questions return to the parent.",
    executionMode: "sequential",
    parameters,
    async execute(_id, params, signal, onUpdate, ctx) {
      if (depth >= 2) throw new Error("Subagent delegation depth limit (2) reached");
      if (!isAgentName(params.agent) || !params.task.trim() || params.task.length > 50_000) throw new Error("A valid agent and non-empty task of at most 50000 characters are required");
      if ((active === "plan" || active === "ask") && params.agent !== "plan" && params.agent !== "ask") {
        throw new Error(`${active} may delegate only to plan or ask; switch to code, debug, or orchestrator for changes`);
      }
      if (!ctx.model) throw new Error("Select a main model before delegating");
      const config = await loadAgentConfig(ctx.cwd, getAgentDir(), ctx.isProjectTrusted());
      const route = routeSubagent(config, params.agent, params.task, `${ctx.model.provider}/${ctx.model.id}`, (ctx.thinkingLevel ?? pi.getThinkingLevel()) as Effort);
      const slash = route.model.indexOf("/");
      const selected = ctx.modelRegistry.find(route.model.slice(0, slash), route.model.slice(slash + 1));
      if (!selected || !ctx.modelRegistry.hasConfiguredAuth(selected)) throw new Error(`Subagent model unavailable: ${route.model}. Check /model and /login.`);
      const tools = subagentTools(params.agent, pi.getActiveTools(), depth + 1);
      const controller = new AbortController();
      const abort = () => controller.abort(signal?.reason);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      const details = { agent: params.agent, ...route };
      const args = ["--mode", "json", "--print", "--no-session", "--model", route.model,
        "--thinking", route.effort, "--agent", params.agent,
        ctx.isProjectTrusted() ? "--approve" : "--no-approve", ...childResourceArgs(process.argv.slice(2)),
        "--extension", resolve(extensionPath), "--tools", tools.join(",")];
      if (tools.length === 0) args.push("--no-tools");
      // Callable MCP tools must not escape a read-only child's explicit built-in loadout.
      if (params.agent === "plan" || params.agent === "ask") {
        if ("createMcpExtension" in piSdk) args.push("--no-mcp");
        args.push("--exclude-tools", "mcp__*");
      }
      const job = runSubagent({ invocation: piInvocation(), args, cwd: ctx.cwd, depth: depth + 1,
        task: params.task, signal: controller.signal,
        onProgress: (text) => onUpdate?.({ content: [{ type: "text", text: `${params.agent} · ${route.model} · ${route.effort} (${route.reason})\n${text}` }], details }),
      });
      jobs.set(controller, job);
      try {
        const result = await job;
        const failed = result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted" || Boolean(result.error);
        return {
          content: [{ type: "text" as const, text: `${params.agent} · ${route.model} · ${route.effort} (${route.reason})\n${limitOutput(failed ? result.error || result.stderr || result.output || "Subagent failed" : result.output)}` }],
          details: { ...details, ...result }, usage: result.usage, isError: failed,
        };
      } finally {
        jobs.delete(controller);
        signal?.removeEventListener("abort", abort);
      }
    },
  });

  pi.on("session_shutdown", async () => {
    for (const controller of jobs.keys()) controller.abort("Session shutdown");
    await Promise.allSettled(jobs.values());
  });
}
