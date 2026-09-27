import type { ExtensionAPI, ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import {
  ALT_M_CYCLE,
  FLAG_ONLY_MODES,
  MODE_LABELS,
  evaluatePermission,
  type SessionApproval,
  type Mode
} from "../lib/mode-policy.ts";
import { classifierAction, createClassifier, type Classifier } from "../lib/permission-classifier.ts";
import { resolveWorkspaceRoot } from "../lib/path-policy.ts";
import { initializeProjectPermissionConfig } from "../lib/permission-config.ts";
import { INTENT_PROVENANCE, IntentTracker, redactIntentSecrets, userIntentFromBranch, type UserIntent } from "../lib/permission-intent.ts";
import { randomUUID } from "node:crypto";
import { MANAGED_TASK_TOOLS, TASK_INVALIDATED, TASK_PERMISSION_SERVICE, validateTaskScope, type TaskPermissionService, type TaskSpec } from "../lib/task-permissions.ts";
import { bashApprovalFingerprint } from "../lib/bash-approvals.ts";
import { DEFAULT_DENIAL_LIMITS, DenialTracker, denialLimit } from "../lib/permission-denials.ts";

const STATE = "piexis-permission-mode";
const modes = Object.keys(MODE_LABELS) as Mode[];
const AUTO_PRIVACY_NOTICE = "Auto review sends bounded user requests, action details, and narrow approval scopes to the configured classifier provider.";

const MODE_INSTRUCTIONS: Record<Mode, string> = {
  default: "You are in Manual mode. Follow the user's request normally; permission prompts are handled by the host.",
  acceptEdits: "You are in Accept Edits mode. Make requested file edits directly; do not behave as if you are in Plan mode.",
  plan: "You are in Plan mode. Explore and propose a concrete implementation plan. Do not make edits or run mutating commands; explain what you would change and why.",
  auto: "You are in Auto mode. Execute the user's requested work directly; do not behave as if you are in Plan mode.",
  dontAsk: "You are in Don't Ask mode. Execute pre-approved actions directly; do not behave as if you are in Plan mode.",
  bypassPermissions: "You are in Bypass Permissions mode. Execute the user's requested work directly; do not behave as if you are in Plan mode."
};

export default function (pi: ExtensionAPI) {
  let mode: Mode = "default";
  const sessionApprovals: SessionApproval[] = [];
  const approvalRequests = new WeakMap<SessionApproval, string>();
  const intentTracker = new IntentTracker();
  let authorizationRevision = 0;
  const denials = new DenialTracker();
  let nextApprovalId = 1;
  let workspaceRoot = "";
  let permissionContext: ExtensionContext | undefined;
  const taskControllers = new Set<AbortController>();
  function invalidateTasks(reason = "authorization") {
    authorizationRevision++;
    pi.events.emit(TASK_INVALIDATED, { reason });
    for (const controller of taskControllers) controller.abort();
    taskControllers.clear();
  }
  let classifier: Classifier = {
    available: false,
    review: async () => ({ decision: "deny", category: "unavailable", reason: "Classifier is unavailable." })
  };

  pi.registerFlag("permission-repeat-limit", { description: "Stop after this many identical denied actions (1–50; default 3)", type: "string" });
  pi.registerFlag("permission-denial-limit", { description: "Stop after this many total denials per user request (1–50; default 6)", type: "string" });
  pi.registerFlag("permission-mode", { description: "Start in a permission mode", type: "string" });
  pi.registerFlag("dangerously-skip-permissions", { description: "Enable bypassPermissions mode", type: "boolean", default: false });

  function setStatus(ctx: ExtensionContext) {
    if (ctx.hasUI) ctx.ui.setStatus(STATE, MODE_LABELS[mode]);
  }
  async function choose(next: Mode, ctx: ExtensionContext, allowDuringAgent = false) {
    if (FLAG_ONLY_MODES.has(next) && next !== mode)
      throw new Error(`${next} can only be selected at launch with --permission-mode.`);
    if (next === "auto" && !classifier.available)
      throw new Error("Auto mode requires a configured classifier model.");
    if (!allowDuringAgent && !ctx.isIdle())
      throw new Error("Wait until the agent is idle before changing permission modes");
    invalidateTasks();
    mode = next;
    pi.events.emit("piexis:permission-mode", mode);
    pi.appendEntry(STATE, { version: 2, mode });
    setStatus(ctx);
    if (ctx.hasUI)
      ctx.ui.notify(`Permission mode: ${MODE_LABELS[mode]}${mode === "auto" ? `\n${AUTO_PRIVACY_NOTICE}` : ""}`, mode === "bypassPermissions" ? "warning" : "info");
  }

  pi.registerCommand("piexis-init", {
    description: "Create Piexis project configuration files",
    handler: async (_args, ctx) => {
      invalidateTasks();
      await initializeProjectPermissionConfig(ctx.cwd, ctx.modelRegistry, ctx.model);
      classifier = await createClassifier(ctx.cwd, ctx.modelRegistry);
      if (ctx.hasUI) ctx.ui.notify("Piexis project configuration initialized.", "info");
    }
  });
  pi.registerCommand("permissions", {
    description: "Inspect session grants, revoke <id>, or clear all grants",
    handler: async (args, ctx) => {
      const [verb = "list", id, ...extra] = args.trim().split(/\s+/).filter(Boolean);
      if (!["list", "revoke", "clear"].includes(verb) || extra.length ||
        (verb === "revoke" ? !id : Boolean(id))) throw new Error("Usage: /permissions [list | revoke <id> | clear]");
      if (verb !== "list") {
        if (!ctx.isIdle()) throw new Error("Wait until the agent is idle before changing permissions.");
        if (verb === "clear") sessionApprovals.length = 0;
        else {
          const index = sessionApprovals.findIndex((approval) => approval.id === id);
          if (index < 0) throw new Error(`Unknown permission grant ${id}.`);
          sessionApprovals.splice(index, 1);
        }
        invalidateTasks();
      }
      const grants = sessionApprovals.map((approval) => redactIntentSecrets(JSON.stringify(approval,
        (key, value) => key === "fingerprint" ? undefined : value))).join("\n") || "No session grants.";
      const text = `Permission mode: ${mode}\nDenials: ${denials.total}/${denials.limits.total}${denials.stopped ? " (run stopped; submit a new request)" : ""}\n${grants}`;
      if (ctx.hasUI) ctx.ui.notify(text, "info");
      else process.stderr.write(`${text}\n`);
    }
  });
  pi.registerCommand("plan", {
    description: "Enter read-only Plan mode and optionally start a planning task",
    handler: async (args, ctx) => {
      if (!ctx.isIdle()) throw new Error("Wait until the agent is idle before entering Plan mode");
      if (mode !== "plan") await choose("plan", ctx);
      if (args.trim()) pi.sendUserMessage(args.trim());
    }
  });

  async function cycleMode(ctx: ExtensionContext) {
    const available = ALT_M_CYCLE.filter((candidate) => candidate !== "auto" || classifier.available);
    const index = available.indexOf(mode);
    await choose(available[index < 0 ? 0 : (index + 1) % available.length]!, ctx);
  }
  pi.registerShortcut("alt+m", { description: "Cycle permission mode", handler: cycleMode });

  async function restoreMode(ctx: ExtensionContext) {
    mode = "default";
    const saved = [...ctx.sessionManager.getBranch()].reverse()
      .find((entry: any) => entry.type === "custom" && entry.customType === STATE) as any;
    const restored = saved?.data?.mode as Mode | undefined;
    if (restored && modes.includes(restored) && !FLAG_ONLY_MODES.has(restored) && (restored !== "auto" || classifier.available)) mode = restored;
    setStatus(ctx);
    pi.events.emit("piexis:permission-mode", mode);
  }

  pi.on("input", (event) => {
    invalidateTasks();
    if (!event.streamingBehavior) intentTracker.reset();
    intentTracker.input(event.text, event.source);
  });
  pi.on("agent_settled", () => { intentTracker.reset(); });
  pi.on("message_end", (event) => {
    const provenance = intentTracker.message(event.message);
    if (provenance) {
      invalidateTasks();
      if (provenance.source === "interactive" || provenance.source === "rpc") denials.reset();
      pi.appendEntry(INTENT_PROVENANCE, provenance);
    }
  });
  pi.on("session_shutdown", () => { permissionContext = undefined; invalidateTasks("session"); intentTracker.reset(); });

  pi.on("session_start", async (event, ctx) => {
    permissionContext = undefined;
    invalidateTasks("session");
    intentTracker.reset();
    sessionApprovals.length = 0;
    denials.reset();
    denials.limits = {
      repeated: denialLimit(pi.getFlag("permission-repeat-limit"), DEFAULT_DENIAL_LIMITS.repeated),
      total: denialLimit(pi.getFlag("permission-denial-limit"), DEFAULT_DENIAL_LIMITS.total)
    };
    workspaceRoot = await resolveWorkspaceRoot(ctx.cwd);
    const isStartup = event.reason === "startup";
    const bypassRequested = isStartup && pi.getFlag("dangerously-skip-permissions") === true;
    classifier = await createClassifier(ctx.cwd, ctx.modelRegistry);
    const requested = pi.getFlag("permission-mode");
    if (isStartup && typeof requested === "string" && !modes.includes(requested as Mode))
      throw new Error(`Unknown permission mode: ${requested}`);
    if (isStartup && bypassRequested && requested && requested !== "bypassPermissions")
      throw new Error("--dangerously-skip-permissions conflicts with --permission-mode.");
    await restoreMode(ctx);
    const selected = bypassRequested ? "bypassPermissions" : isStartup && typeof requested === "string" ? requested as Mode : undefined;
    if (selected === "auto" && !classifier.available) throw new Error("Auto mode requires a configured classifier model.");
    if (selected) mode = selected;
    if (mode === "auto" && ctx.hasUI) ctx.ui.notify(AUTO_PRIVACY_NOTICE, "info");
    setStatus(ctx);
    pi.events.emit("piexis:permission-mode", mode);
    permissionContext = ctx;
    if (ctx.mode === "tui") ctx.ui.onTerminalInput((data) => {
      if (data !== "\u001bm") return;
      void cycleMode(ctx).catch((error) => ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning"));
      return { consume: true };
    });
  });

  pi.on("session_tree", async (_event, ctx) => {
    invalidateTasks();
    intentTracker.reset();
    sessionApprovals.length = 0;
    denials.reset();
    await restoreMode(ctx);
  });
  pi.on("before_agent_start", async (event) => ({ systemPrompt: `${event.systemPrompt}\n\n${MODE_INSTRUCTIONS[mode]}` }));

  async function checkTool(event: ToolCallEvent, ctx: ExtensionContext, delegated?: { spec: TaskSpec; intent: UserIntent; worktree?: string }) {
    const worker = Boolean(delegated?.worktree);
    if (mode === "bypassPermissions" && !worker || event.toolName === "AskQuestion") return;
    const root = delegated?.worktree ?? (workspaceRoot || await resolveWorkspaceRoot(ctx.cwd));
    const evaluationRevision = authorizationRevision;
    const activeIntent = mode === "auto" ? userIntentFromBranch(ctx.sessionManager.getBranch()) : undefined;
    const eligibleApprovals = delegated ? [] : mode !== "auto" ? sessionApprovals : sessionApprovals.filter((approval) =>
      activeIntent?.complete && !intentTracker.hasPendingInput && approvalRequests.get(approval) === activeIntent.currentRequestId);
    const decision = await evaluatePermission({
      mode, tool: event.toolName, input: event.input, cwd: ctx.cwd, workspaceRoot: root,
      authorization: { approvals: eligibleApprovals }, actor: worker
        ? { kind: "worker", scope: delegated!.spec } : { kind: "foreground" }
    });
    if (decision.decision === "allow") {
      if (decision.reason === "session-approval" && evaluationRevision !== authorizationRevision)
        return { block: true, reason: "Authorization changed while checking the session grant." };
      return;
    }
    if (decision.decision === "deny")
      return { block: true, reason: `Permission policy denied action (${decision.reason}).` };
    const pathPolicy = decision.pathPolicy?.decision === "deny" ? undefined : decision.pathPolicy;

    if (decision.decision === "require-model-review") {
      if (!classifier.available)
        return { block: true, reason: "Auto mode is unavailable: configure a classifier model." };
      try {
        const revision = authorizationRevision;
        const intent = delegated?.intent ?? userIntentFromBranch(ctx.sessionManager.getBranch());
        const intentSnapshot = JSON.stringify(intent);
        if (intentTracker.hasPendingInput) {
          intent.complete = false;
          intent.issues.push("undelivered-user-input");
        }
        // Only valid reusable grants could have bypassed review above. Stale or
        // ineligible execution grants must not influence the model as permission.
        const approvals = eligibleApprovals.filter((approval) => approval.tool === event.toolName &&
          (approval.scope === "file" || approval.scope === "directory"));
        const verdict = await classifier.review(classifierAction(event.toolName, event.input), {
          cwd: ctx.cwd, workspaceRoot: root, intent, approvals, delegation: delegated?.spec,
          policy: { reason: decision.reason, pathPolicy: decision.pathPolicy },
          findings: { shellSemantics: decision.bash?.status ?? "not-applicable", bash: decision.bash, fileContents: "excluded" }
        }, ctx.signal);
        if (revision !== authorizationRevision || !delegated && intentSnapshot !== JSON.stringify(userIntentFromBranch(ctx.sessionManager.getBranch())))
          return { block: true, reason: "Auto authorization changed during review; the action was not executed." };
        if (verdict.decision === "deny")
          return { block: true, reason: `Auto review denied action (${verdict.category}): ${verdict.reason}` };
        return;
      } catch (error) {
        return { block: true, reason: `Auto classifier failed closed: ${error instanceof Error ? error.message : String(error)}` };
      }
    }

    if (!ctx.hasUI) return { block: true, reason: "Approval required but no permission UI is available." };

    const request = JSON.stringify(event.input).slice(0, 1_000);
    const allowOnce = `Allow once: ${event.toolName}`;
    const allowAll = `Allow ALL ${event.toolName} actions for this session`;
    const options = [allowOnce];
    const isBash = event.toolName === "bash" && event.input && typeof event.input === "object";
    const command = isBash ? String((event.input as { command?: unknown }).command ?? "").trim() : "";
    if (!delegated && isBash && decision.bashFingerprint) {
      options.push("Allow this exact Bash command in this directory for this session");
      options.push("Allow Git status queries in this directory for this session");
    }
    if (!delegated && pathPolicy && pathPolicy.reason !== "recursive-boundary") {
      options.push("Allow this file for this session");
      if (pathPolicy.scope !== "sensitive") options.push("Allow this directory for this session");
      if (pathPolicy.scope === "project") options.push("Allow project files for this tool for this session");
    }
    if (!delegated && !MANAGED_TASK_TOOLS.has(event.toolName) && (!pathPolicy || pathPolicy.scope !== "sensitive")) options.push(allowAll);
    options.push("Deny");
    const approvalRequestId = userIntentFromBranch(ctx.sessionManager?.getBranch() ?? []).currentRequestId;
    const revision = authorizationRevision;
    const choice = await ctx.ui.select(`${delegated ? `Delegated task data: ${delegated.spec.task.slice(0, 500)}\nDirectory: ${ctx.cwd}\nPaths: ${JSON.stringify(delegated.spec.paths)}; Bash: ${delegated.spec.bash}; Model: ${delegated.spec.model ?? "parent"}\n` : ""}Permission required: ${event.toolName} (${decision.reason})\nRequested: ${request}${decision.bash ? `\nShell findings: ${decision.bash.findings.join(", ") || "literal command"}` : ""}`, options, { signal: ctx.signal });
    if (revision !== authorizationRevision) return { block: true, reason: "Permission request changed while awaiting approval." };
    if (choice?.includes("in this directory") && decision.bashFingerprint !== await bashApprovalFingerprint(command, ctx.cwd, root))
      return { block: true, reason: "Command environment/configuration changed while awaiting approval." };
    if (revision !== authorizationRevision || ctx.signal?.aborted || denials.stopped) return { block: true, reason: "Permission request changed, was cancelled, or the run stopped while awaiting approval." };
    const approvalCount = sessionApprovals.length;
    if (!choice || !options.includes(choice)) return { block: true, reason: "Blocked by user" };
    if (choice === allowAll) sessionApprovals.push({ tool: event.toolName, scope: "tool" });
    else if (choice === "Allow this exact Bash command in this directory for this session" && decision.bashFingerprint && decision.canonicalCwd)
      sessionApprovals.push({ tool: "bash", scope: "command", command, cwd: decision.canonicalCwd, fingerprint: decision.bashFingerprint });
    else if (choice === "Allow Git status queries in this directory for this session" && decision.bashFingerprint && decision.canonicalCwd)
      sessionApprovals.push({ tool: "bash", scope: "subcommand", family: "git-status", cwd: decision.canonicalCwd, fingerprint: decision.bashFingerprint });
    else if (pathPolicy && choice === "Allow this file for this session") sessionApprovals.push({ tool: event.toolName, scope: "file", path: pathPolicy.path });
    else if (pathPolicy && choice === "Allow this directory for this session") sessionApprovals.push({ tool: event.toolName, scope: "directory", path: pathPolicy.directory });
    else if (pathPolicy && choice === "Allow project files for this tool for this session") sessionApprovals.push({ tool: event.toolName, scope: "project" });
    else if (choice !== allowOnce) return { block: true, reason: "Blocked by user" };
    if (sessionApprovals.length > approvalCount) {
      const approval = sessionApprovals[sessionApprovals.length - 1]!;
      approval.id = String(nextApprovalId++);
      if (approvalRequestId) approvalRequests.set(approval, approvalRequestId);
    }
  }

  function recordDenial(tool: string, input: unknown, reason: string, ctx: ExtensionContext) {
    const state = denials.deny(tool, input);
    if (state.stopped) {
      invalidateTasks();
      pi.appendEntry("piexis-permission-stop", { total: state.total, repeated: state.repeated, mode });
      if (ctx.hasUI) ctx.ui.notify("Permission denial limit reached; the agent run was stopped.", "warning");
      else process.stderr.write(`Piexis permission_blocked: denial limit reached (${state.total} total, ${state.repeated} repeated).\n`);
      ctx.abort();
      return "Permission denial limit reached. This run is stopped; wait for a new user request. Do not switch tools or modes to retry the denied effect.";
    }
    return `${reason} Choose a genuinely narrower action, ask for clarification, or wait for explicit authorization. Do not use another tool to achieve the same denied effect. (${state.total}/${denials.limits.total} denials)`;
  }

  // These task handlers perform authorization with their complete task/patch
  // metadata through the service below; do not charge/review them twice.
  pi.on("tool_call", async (event, ctx) => {
    if (mode === "bypassPermissions" || event.toolName === "AskQuestion" || MANAGED_TASK_TOOLS.has(event.toolName) && !["plan", "dontAsk"].includes(mode)) return;
    const stop = () => {
      ctx.abort();
      return { block: true, reason: "Permission denial limit reached. This run is stopped; wait for a new user request. Do not switch tools or modes to retry the denied effect." };
    };
    if (denials.stopped) return stop();
    if (ctx.signal?.aborted) return { block: true, reason: "Permission request cancelled." };
    const revision = denials.revision;
    let outcome;
    try { outcome = await checkTool(event, ctx); }
    catch { outcome = { block: true, reason: "Permission evaluation failed closed." }; }
    if (revision !== denials.revision || ctx.signal?.aborted) return { block: true, reason: "Permission request changed or was cancelled during evaluation." };
    if (denials.stopped) return stop();
    if (!outcome?.block) return outcome;
    return { block: true, reason: recordDenial(event.toolName, event.input, outcome.reason, ctx) };
  });

  pi.events.on?.(TASK_PERMISSION_SERVICE, (message) => {
    const ctx = permissionContext;
    if (!ctx) return;
    const revision = authorizationRevision;
    const current = () => permissionContext === ctx && authorizationRevision === revision && !denials.stopped;
    const requireCurrent = () => { if (!current()) throw new Error("Task authorization is no longer current."); };
    const service: TaskPermissionService = {
      declined(tool, id, reason = "Task operation was not approved.") {
        requireCurrent();
        return recordDenial(tool, { id }, reason, ctx);
      },
      async control(tool, id) {
        requireCurrent();
        const decision = await evaluatePermission({ mode, tool, input: { id }, cwd: ctx.cwd, workspaceRoot });
        requireCurrent();
        if (decision.decision !== "allow") throw new Error(`Task operation denied (${decision.reason}).`);
      },
      async open(proposed, userCommand, signal) {
        requireCurrent();
        if (typeof proposed.task !== "string" || !proposed.task.trim() || proposed.task.length > 20000)
          throw new Error("Task description must contain 1–20,000 characters.");
        const spec: TaskSpec = { task: proposed.task, model: proposed.model, ...validateTaskScope(proposed.paths, proposed.bash) };
        let intent = userIntentFromBranch(ctx.sessionManager.getBranch());
        if (userCommand) {
          const id = `task-command-${randomUUID()}`;
          const text = redactIntentSecrets(spec.task);
          const messages = [...intent.messages, { id, source: ctx.mode === "rpc" ? "rpc" as const : "interactive" as const, text }];
          intent = { currentRequestId: id, messages, issues: intent.issues,
            complete: (!intent.messages.length || intent.complete) && text === spec.task && text.length <= 6000 &&
              messages.length <= 16 && messages.reduce((sum, item) => sum + item.text.length, 0) <= 24000 };
        }
        const input = { ...spec };
        const policy = await evaluatePermission({ mode, tool: "background_task", input, cwd: ctx.cwd, workspaceRoot });
        if (policy.decision === "deny") throw new Error(`Delegation denied (${policy.reason}).`);
        const outcome = userCommand && mode !== "auto" ? undefined : await checkTool(
          { type: "tool_call", toolCallId: randomUUID(), toolName: "background_task", input } as ToolCallEvent,
          { ...ctx, signal }, { spec, intent });
        requireCurrent();
        if (signal?.aborted) throw new Error("Task launch cancelled.");
        if (outcome?.block) throw new Error(recordDenial("background_task", input, outcome.reason, ctx));
        const controller = new AbortController();
        const workerDenials = new DenialTracker(denials.limits);
        const abort = () => controller.abort();
        signal?.addEventListener("abort", abort, { once: true });
        taskControllers.add(controller);
        const valid = () => current() && !controller.signal.aborted && !signal?.aborted;
        return {
          signal: controller.signal,
          limits: { ...workerDenials.limits },
          valid,
          close() { signal?.removeEventListener("abort", abort); taskControllers.delete(controller); controller.abort(); },
          async authorize(tool, action, worktree, actionSignal) {
            if (!valid()) return { allow: false, reason: "Task authorization was cancelled or invalidated." };
            const signals = [controller.signal, ...(actionSignal ? [actionSignal] : [])];
            const combined = AbortSignal.any(signals);
            try {
              const result = await checkTool({ type: "tool_call", toolCallId: randomUUID(), toolName: tool, input: action } as ToolCallEvent,
                { ...ctx, cwd: worktree, signal: combined }, { spec, intent, worktree });
              if (!valid() || combined.aborted) return { allow: false, reason: "Task authorization changed during review." };
              if (!result?.block) return { allow: true };
              const state = workerDenials.deny(tool, action);
              if (state.stopped) controller.abort();
              return { allow: false, reason: state.stopped ? "Worker denial limit reached; task stopped." : result.reason };
            } catch {
              controller.abort();
              return { allow: false, reason: "Worker permission evaluation failed closed." };
            }
          }
        };
      }
    };
    (message as { provide(service: TaskPermissionService): void }).provide(service);
  });
}
