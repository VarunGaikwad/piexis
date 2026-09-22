import type {
  ExtensionAPI,
  ExtensionContext
} from "@earendil-works/pi-coding-agent";
import {
  ALT_M_CYCLE,
  EDIT_TOOLS,
  FLAG_ONLY_MODES,
  MODE_LABELS,
  READ_TOOLS,
  isAcceptEditsCommand,
  type Mode
} from "../lib/mode-policy.ts";
import {
  createClassifier,
  type Classifier
} from "../lib/permission-classifier.ts";
import { ensureProjectPermissionConfig } from "../lib/permission-config.ts";

const STATE = "piexis-permission-mode";
const modes = Object.keys(MODE_LABELS) as Mode[];
const MODE_INSTRUCTIONS: Record<Mode, string> = {
  default:
    "You are in Manual mode. Follow the user's request normally; permission prompts are handled by the host.",
  acceptEdits:
    "You are in Accept Edits mode. Make requested file edits directly; do not behave as if you are in Plan mode.",
  plan:
    "You are in Plan mode. Explore and propose a concrete implementation plan. Do not make edits or run mutating commands; explain what you would change and why.",
  auto:
    "You are in Auto mode. Execute the user's requested work directly; do not behave as if you are in Plan mode.",
  dontAsk:
    "You are in Don't Ask mode. Execute pre-approved actions directly; do not behave as if you are in Plan mode.",
  bypassPermissions:
    "You are in Bypass Permissions mode. Execute the user's requested work directly; do not behave as if you are in Plan mode."
};

export default function (pi: ExtensionAPI) {
  let mode: Mode = "default";
  // These approvals are intentionally in-memory: they last for the current
  // session only and are scoped to the tool the user approved.
  const sessionAllowedTools = new Set<string>();
  let classifier: Classifier = {
    available: false,
    review: async () => ({
      decision: "deny",
      category: "unavailable",
      reason: "Classifier is unavailable."
    })
  };

  pi.registerFlag("permission-mode", {
    description: "Start in a permission mode",
    type: "string"
  });
  pi.registerFlag("dangerously-skip-permissions", {
    description: "Enable bypassPermissions mode",
    type: "boolean",
    default: false
  });

  function setStatus(ctx: ExtensionContext) {
    if (ctx.hasUI) ctx.ui.setStatus(STATE, MODE_LABELS[mode]);
  }
  async function choose(next: Mode, ctx: ExtensionContext) {
    if (FLAG_ONLY_MODES.has(next) && next !== mode)
      throw new Error(
        `${next} can only be selected at launch with --permission-mode.`
      );
    if (!ctx.isIdle())
      throw new Error(
        "Wait until the agent is idle before changing permission modes"
      );
    mode = next;
    pi.appendEntry(STATE, { version: 2, mode });
    setStatus(ctx);
    if (ctx.hasUI)
      ctx.ui.notify(
        `Permission mode: ${MODE_LABELS[mode]}`,
        mode === "bypassPermissions" ? "warning" : "info"
      );
  }

  pi.registerCommand("plan", {
    description:
      "Enter read-only Plan mode and optionally start a planning task",
    handler: async (args, ctx) => {
      if (!ctx.isIdle())
        throw new Error(
          "Wait until the agent is idle before entering Plan mode"
        );
      if (mode !== "plan") await choose("plan", ctx);
      const task = args.trim();
      if (task) pi.sendUserMessage(task);
    }
  });

  async function cycleMode(ctx: ExtensionContext) {
    const available = ALT_M_CYCLE.filter(
      (candidate) => candidate !== "auto" || classifier.available
    );
    const index = available.indexOf(mode);
    await choose(
      available[index < 0 ? 0 : (index + 1) % available.length]!,
      ctx
    );
  }

  pi.registerShortcut("alt+m", {
    description: "Cycle permission mode",
    handler: cycleMode
  });

  pi.on("session_start", async (event, ctx) => {
    sessionAllowedTools.clear();
    // CLI flags are startup options, not global overrides.  Applying them on
    // every session_start makes /resume ignore the mode saved in the target
    // session (and makes the mode appear stuck on the previous session).
    const isStartup = event.reason === "startup";
    const bypassRequested =
      isStartup && pi.getFlag("dangerously-skip-permissions") === true;
    try {
      await ensureProjectPermissionConfig(
        ctx.cwd,
        ctx.modelRegistry,
        ctx.model
      );
    } catch (error) {
      if (ctx.hasUI)
        ctx.ui.notify(
          `PieXis setup failed: ${error instanceof Error ? error.message : String(error)}`,
          "warning"
        );
    }
    classifier = await createClassifier(ctx.cwd, ctx.modelRegistry);
    const requested = pi.getFlag("permission-mode");
    if (
      isStartup &&
      typeof requested === "string" &&
      !modes.includes(requested as Mode)
    )
      throw new Error(`Unknown permission mode: ${requested}`);
    if (
      isStartup &&
      bypassRequested &&
      requested &&
      requested !== "bypassPermissions"
    )
      throw new Error(
        "--dangerously-skip-permissions conflicts with --permission-mode."
      );

    // Always start resolution from the target session, rather than retaining
    // the old closure value during a reload/session replacement.
    mode = "default";
    const saved = [...ctx.sessionManager.getBranch()]
      .reverse()
      .find((e: any) => e.type === "custom" && e.customType === STATE) as any;
    const restored = saved?.data?.mode as Mode | undefined;
    if (
      restored &&
      !FLAG_ONLY_MODES.has(restored) &&
      (restored !== "auto" || classifier.available)
    )
      mode = restored;

    // Explicit launch flags win only for the initial session.
    const selected = bypassRequested
      ? "bypassPermissions"
      : isStartup && typeof requested === "string"
        ? (requested as Mode)
        : undefined;
    if (selected === "auto" && !classifier.available)
      throw new Error("Auto mode requires a configured classifier model.");
    if (selected) mode = selected;
    setStatus(ctx);
    // Some terminals send Alt+M as ESC + m even after PI enables Kitty keyboard
    // protocol. PI's normal matcher correctly avoids treating that legacy sequence
    // as an Alt key while Kitty is active, so accept this one explicit fallback.
    if (ctx.mode === "tui") {
      ctx.ui.onTerminalInput((data) => {
        if (data !== "\u001bm") return;
        void cycleMode(ctx).catch((error) =>
          ctx.ui.notify(
            error instanceof Error ? error.message : String(error),
            "warning"
          )
        );
        return { consume: true };
      });
    }
  });

  // /tree changes the active branch without creating a new extension
  // instance. Restore the mode from that branch as well.
  pi.on("session_tree", async (_event, ctx) => {
    mode = "default";
    const saved = [...ctx.sessionManager.getBranch()]
      .reverse()
      .find((e: any) => e.type === "custom" && e.customType === STATE) as any;
    const restored = saved?.data?.mode as Mode | undefined;
    if (
      restored &&
      !FLAG_ONLY_MODES.has(restored) &&
      (restored !== "auto" || classifier.available)
    )
      mode = restored;
    setStatus(ctx);
  });

  pi.on("before_agent_start", async (event) => ({
    // Always replace the mode instruction. Merely omitting the Plan prompt
    // after switching modes can leave the model following the previous turn's
    // read-only framing.
    systemPrompt: `${event.systemPrompt}\n\n${MODE_INSTRUCTIONS[mode]}`
  }));

  pi.on("tool_call", async (event, ctx) => {
    if (mode === "bypassPermissions") return;
    // Asking the user is always safe and must remain available in every mode.
    if (event.toolName === "AskQuestion") return;
    if (mode === "plan" && !READ_TOOLS.has(event.toolName))
      return {
        block: true,
        reason:
          "Plan mode is read-only; approve the plan and switch modes before making changes."
      };

    let allowed = READ_TOOLS.has(event.toolName);
    if (mode === "acceptEdits") {
      allowed =
        allowed ||
        EDIT_TOOLS.has(event.toolName) ||
        (event.toolName === "bash" &&
          isAcceptEditsCommand(String((event.input as any).command ?? "")));
    }
    if (mode === "auto") {
      if (!classifier.available)
        return {
          block: true,
          reason: "Auto mode is unavailable: configure a classifier model."
        };
      const branch = ctx.sessionManager.getBranch() as any[];
      const task = [...branch]
        .reverse()
        .find(
          (entry) => entry.type === "message" && entry.message?.role === "user"
        )?.message?.content;
      const taskText =
        typeof task === "string"
          ? task
          : Array.isArray(task)
            ? task
                .filter((part: any) => part.type === "text")
                .map((part: any) => part.text)
                .join("\\n")
            : "";
      try {
        const verdict = await classifier.review(
          { tool: event.toolName, input: event.input, cwd: ctx.cwd },
          taskText,
          ctx.signal
        );
        if (verdict.decision === "deny")
          return {
            block: true,
            reason: `Auto classifier denied action (${verdict.category}): ${verdict.reason}`
          };
        return;
      } catch (error) {
        return {
          block: true,
          reason: `Auto classifier failed closed: ${error instanceof Error ? error.message : String(error)}`
        };
      }
    }
    if (mode === "dontAsk" && !allowed)
      return {
        block: true,
        reason: "Action is not pre-approved in dontAsk mode."
      };
    if (sessionAllowedTools.has(event.toolName)) return;
    if (allowed) return;
    if (!ctx.hasUI)
      return {
        block: true,
        reason: "Approval required but no permission UI is available."
      };

    const allowOnce = `Allow ${event.toolName}`;
    const allowForSession = `Allow ${event.toolName} for this session`;
    const choice = await ctx.ui.select("Permission required", [
      allowOnce,
      allowForSession,
      "Deny"
    ]);
    if (choice === allowForSession) {
      sessionAllowedTools.add(event.toolName);
      return;
    }
    if (choice !== allowOnce) return { block: true, reason: "Blocked by user" };
  });
}
