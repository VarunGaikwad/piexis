import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createModeRuntime, nativeTools, type ModeRuntime } from "../lib/mode-guard.ts";
import {
  DEFAULT_SETTINGS, MANAGED_TOOLS, MODES, STATE_VERSION, isPlanFile, parseMode, parseSettings, policyPrompt, resolveToolPath,
  type ManagedTool, type Mode, type ModeSettings
} from "../lib/mode-policy.ts";
export { MODES } from "../lib/mode-policy.ts";

const STATE = "piexis-mode";
const ownPath = fileURLToPath(import.meta.url);
export default function modeExtension(pi: ExtensionAPI, makeRuntime: typeof createModeRuntime = createModeRuntime) {
  let runtime: ModeRuntime | undefined;
  let planChanged = false;
  function report(ctx: ExtensionContext, message: string, warning = false) {
    if (ctx.hasUI) ctx.ui.notify(message, warning ? "warning" : "info");
    else pi.sendMessage({ customType: "piexis-mode-notice", content: message, display: true }, { triggerTurn: false });
  }
  function status(ctx: ExtensionContext) {
    if (!ctx.hasUI || !runtime) return;
    const label = MODES.find(m => m.id === runtime!.mode)!.label;
    const text = `Mode: ${label} | Sandbox: ${runtime.sandboxStatus}`;
    ctx.ui.setStatus(STATE, runtime.mode === "yolo" && ctx.ui.theme ? ctx.ui.theme.fg("error", `⚠ ${text}`) : text);
  }
  function selectMode(next: Mode, ctx: ExtensionContext) {
    if (!runtime) throw new Error("Permission runtime has not started");
    if (!ctx.isIdle() || runtime.busy) throw new Error("Wait for the current task and tool calls to finish before switching modes");
    if (runtime.mode === next) return;
    runtime.setMode(next);
    planChanged = false;
    pi.appendEntry(STATE, { version: STATE_VERSION, mode: next });
    status(ctx);
    if (next === "yolo") report(ctx, "YOLO: no permission prompts, sandbox, or protected-path backstop.", true);
    else report(ctx, `Permission mode: ${MODES.find(m => m.id === next)!.label}`);
  }
  async function restore(ctx: ExtensionContext, startupFlag: boolean) {
    await runtime?.close();
    runtime = undefined;
    planChanged = false;
    const root = await realpath(ctx.cwd);
    let mode: Mode = "default";
    const entry = [...ctx.sessionManager.getBranch()].reverse().find(e => e.type === "custom" && e.customType === STATE);
    if (entry?.type === "custom") {
      const data = entry.data as { version?: number; mode?: unknown } | null;
      const saved = data?.version === STATE_VERSION ? parseMode(data.mode) : undefined;
      if (saved) mode = saved;
      else report(ctx, "Legacy or invalid permission state reset to Default.", true);
    }
    if (startupFlag) {
      const value = pi.getFlag("permission-mode");
      if (value !== undefined && value !== "") {
        const selected = parseMode(value);
        if (selected) mode = selected;
        else { mode = "default"; report(ctx, "Invalid --permission-mode; using Default.", true); }
      }
    }
    let settings: ModeSettings = DEFAULT_SETTINGS;
    let configurationError: string | undefined;
    try {
      settings = parseSettings(JSON.parse(await readFile(join(getAgentDir(), "permission-modes.json"), "utf8")), getAgentDir());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") configurationError = `Invalid permission-modes.json: ${(error as Error).message}`;
    }
    runtime = makeRuntime({ root, mode, settings, configurationError });
    // Persist an explicit CLI selection so reload doesn't lose it. It doesn't override later /mode changes.
    if (startupFlag && pi.getFlag("permission-mode")) pi.appendEntry(STATE, { version: STATE_VERSION, mode });
    status(ctx);
    if (configurationError && mode !== "yolo") report(ctx, configurationError, true);
    if (mode === "yolo") report(ctx, "YOLO: no permission prompts, sandbox, or protected-path backstop.", true);
  }

  pi.registerFlag("permission-mode", { description: "Permission mode: default, plan, build, or yolo", type: "string" });
  pi.registerShortcut("ctrl+shift+m", {
    description: "Cycle permission mode",
    handler: async (ctx) => {
      try {
        if (!runtime) throw new Error("Permission runtime unavailable; /reload and check startup errors");
        const index = MODES.findIndex(mode => mode.id === runtime!.mode);
        const next = MODES[(index + 1) % MODES.length]?.id;
        if (next) selectMode(next, ctx);
      } catch (error) { report(ctx, (error as Error).message, true); }
    }
  });
  pi.registerCommand("mode", {
    description: "Select Default, Plan Mode, Build, or YOLO permissions",
    getArgumentCompletions(prefix) {
      const items = MODES.filter(m => m.id.startsWith(prefix.toLowerCase())).map(m => ({ value: m.id, label: m.label, description: m.description }));
      return items.length ? items : null;
    },
    async handler(args, ctx) {
      try {
        if (!runtime) throw new Error("Permission runtime unavailable; /reload and check startup errors");
        if (!ctx.isIdle() || runtime.busy) throw new Error("Wait for the current task and tool calls to finish before switching modes");
        let value = args.trim();
        if (!value) {
          if (!ctx.hasUI) { report(ctx, `Current mode: ${runtime.mode}. Usage: /mode default|plan|build|yolo`); return; }
          const choices = MODES.map(m => `${m.label} — ${m.description}`);
          const current = runtime;
          const choice = await ctx.ui.select("Permission mode", choices);
          if (choice === undefined || runtime !== current) return;
          value = MODES[choices.indexOf(choice)]?.id ?? "";
        }
        const mode = parseMode(value);
        if (!mode) throw new Error(`Unknown mode: ${value}. Use default, plan, build, or yolo.`);
        selectMode(mode, ctx);
      } catch (error) { report(ctx, (error as Error).message, true); }
    }
  });

  for (const tool of nativeTools(process.cwd())) {
    pi.registerTool({
      ...tool,
      async execute(id, input, signal, onUpdate, ctx) {
        if (!runtime) throw new Error("Permission runtime unavailable; refusing tool execution");
        try {
          const args = input as Record<string, unknown>; // Pi already validated the retained built-in schema.
          const result = await runtime.execute(tool.name as ManagedTool, id, args, signal, onUpdate, ctx);
          if (runtime.mode === "plan" && ["write", "edit"].includes(tool.name) && typeof args.path === "string") {
            const root = await realpath(ctx.cwd);
            planChanged ||= isPlanFile(resolveToolPath(args.path, root), root);
          }
          return result;
        } finally { status(ctx); }
      }
    });
  }
  pi.on("tool_call", async event => {
    if (!runtime) return { block: true, reason: "Permission runtime unavailable; refusing execution" };
    if (runtime.mode === "yolo") return;
    if (!MANAGED_TOOLS.includes(event.toolName as ManagedTool)) {
      return { block: true, reason: `Unmanaged tool ${event.toolName} is disabled in ${runtime.mode}. Custom tools/subagents require an execution-enforcing adapter, not a claimed read-only name.` };
    }
    const owner = pi.getAllTools().find(tool => tool.name === event.toolName)?.sourceInfo;
    try {
      if (!owner || await realpath(owner.path) !== await realpath(ownPath)) throw new Error();
    } catch {
      return { block: true, reason: `Conflicting ${event.toolName} override: this extension cannot verify enforcement. Disable the conflicting extension and /reload.` };
    }
    // Managed wrappers perform the final checks and approval at execution, not preflight.
  });
  pi.on("user_bash", (_event, ctx) => ({ operations: {
    async exec(command, cwd, options) {
      if (!runtime) throw new Error("Permission runtime unavailable; refusing shell execution");
      try { return await runtime.manualBash(command, cwd, options, ctx); }
      finally { status(ctx); }
    }
  } }));
  pi.on("before_agent_start", event => ({ systemPrompt: `${event.systemPrompt}\n\n${policyPrompt(runtime?.mode ?? "default")}` }));
  pi.on("session_start", (event, ctx) => restore(ctx, event.reason === "startup"));
  pi.on("session_tree", (_event, ctx) => restore(ctx, false));
  pi.on("agent_settled", async (_event, ctx) => {
    if (!runtime || runtime.mode !== "plan" || !planChanged) return;
    planChanged = false;
    report(ctx, "Plan updated. Ready to apply? Switch to Build with /mode build.");
    // No natural-language inference or automatic application. This dialog changes mode only.
    if (ctx.hasUI) {
      const current = runtime;
      const choice = await ctx.ui.select("Apply the plan in Build mode?", ["Stay in Plan", "Switch to Build"]);
      if (choice === "Switch to Build" && runtime === current && runtime.mode === "plan" && ctx.isIdle() && !runtime.busy) selectMode("build", ctx);
    }
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    await runtime?.close();
    runtime = undefined;
    if (ctx.hasUI) ctx.ui.setStatus(STATE, undefined);
  });
}
