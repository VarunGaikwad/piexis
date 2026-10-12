import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { agentConfigCapabilities } from "../lib/agent-config.ts";
import { hasProjectAgentConfig, loadAgentConfig } from "../lib/agents.ts";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const WORDMARK = [
  "██████╗ ██╗███████╗██╗  ██╗██╗███████╗",
  "██╔══██╗██║██╔════╝╚██╗██╔╝██║██╔════╝",
  "██████╔╝██║█████╗   ╚███╔╝ ██║███████╗",
  "██╔═══╝ ██║██╔══╝   ██╔██╗ ██║╚════██║",
  "██║     ██║███████╗██╔╝ ██╗██║███████║",
  "╚═╝     ╚═╝╚══════╝╚═╝  ╚═╝╚═╝╚══════╝"
];
const WORDMARK_WIDTH = Math.max(...WORDMARK.map((line) => visibleWidth(line)));

const fmt = (n: number) => {
  if (n < 1_000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}m`;
};

type Seg = { text: string; priority: number };

// Drop optional fields before shortening the last (highest-priority) field.
function justify(left: string, right: Seg[], sep: string, width: number): string {
  const segs = [...right];
  while (segs.length) {
    const r = segs.map((s) => s.text).join(sep);
    const gap = width - visibleWidth(left) - visibleWidth(r);
    if (gap >= 2) return left + " ".repeat(gap) + r;
    let weakest = 0;
    segs.forEach((s, i) => {
      if (s.priority < segs[weakest].priority) weakest = i;
    });
    if (segs.length === 1) {
      const available = width - visibleWidth(left) - 2;
      if (available > 0) {
        const text = truncateToWidth(r, available, "…");
        return left + " ".repeat(width - visibleWidth(left) - visibleWidth(text)) + text;
      }
      break;
    }
    segs.splice(weakest, 1);
  }
  return truncateToWidth(left, width, "…");
}

export default function (pi: ExtensionAPI) {
  // Jiti can retain imported JSON across reloads; read it once per extension runtime.
  const tipList: { category: string; text: string }[] = JSON.parse(
    readFileSync(new URL("../lib/ui-tips.json", import.meta.url), "utf8")
  );
  if (!Array.isArray(tipList) || tipList.some((tip) =>
    typeof tip?.category !== "string" || !tip.category.trim() ||
    typeof tip?.text !== "string" || !tip.text.trim()
  )) {
    throw new Error("Invalid ui-tips.json: expected tips with non-empty category and text strings.");
  }

  let state = "ready";
  let activeTool = "";
  let redraw = () => {};
  let remainingTips: typeof tipList = [];
  let agentSetupTips: string[] = [];

  function update() {
    redraw();
  }

  pi.on("session_start", async (_event, ctx) => {
    state = "ready";
    activeTool = "";
    redraw = () => {};
    if (ctx.mode !== "tui") return;

    const project = basename(ctx.cwd);
    agentSetupTips = [];
    try {
      if (ctx.isProjectTrusted() && await hasProjectAgentConfig(ctx.cwd)) {
        const config = await loadAgentConfig(ctx.cwd, getAgentDir(), true);
        for (const key of Object.keys(agentConfigCapabilities) as (keyof typeof agentConfigCapabilities)[]) {
          if (config[key] === undefined) agentSetupTips.push(`Agent config: add ${key} to ${agentConfigCapabilities[key]}.`);
        }
      }
    } catch {
      agentSetupTips = ["Agent config: fix agent.json so PieXis can apply your agent settings."];
    }
    const selectedTips: typeof tipList = [];
    for (let i = 0; i < Math.min(3, tipList.length); i++) {
      if (remainingTips.length === 0) {
        remainingTips = tipList.filter((tip) => !selectedTips.includes(tip));
      }
      const differentCategories = remainingTips.filter(
        (tip) => !selectedTips.some((selected) => selected.category === tip.category)
      );
      const candidates = differentCategories.length > 0 ? differentCategories : remainingTips;
      const tip = candidates[Math.floor(Math.random() * candidates.length)];
      selectedTips.push(remainingTips.splice(remainingTips.indexOf(tip), 1)[0]);
    }

    // Put project info in the terminal tab instead of wasting TUI rows.
    ctx.ui.setTitle(`π ${project}`);

    // Headers are rendered once at the top of the startup view. A widget would
    // stay attached to the editor forever, making the onboarding copy noisy.
    ctx.ui.setHeader((_tui, theme) => ({
      render(width: number) {
        if (width <= 0) return [];

        const left = width < WORDMARK_WIDTH
          ? [`${theme.fg("accent", "✦")} ${theme.bold("PieXis")}`]
          : WORDMARK.map((line) => theme.fg("accent", line));

        const tips = [
          theme.fg("accent", theme.bold("Get started with PieXis")),
          theme.fg("muted", "Questions, skills, prompts & stats."),
          ...agentSetupTips.map((tip) => theme.fg("warning", tip)),
          ...selectedTips.map((tip) =>
            `${theme.fg("accent", `[${tip.category}]`)} ${theme.fg("muted", tip.text)}`
          ),
          theme.fg("dim", "/help · /summary · /commit")
        ];
        const tipWidth = width - WORDMARK_WIDTH - 3;
        if (tipWidth >= 32) {
          const right = tips.flatMap((line) => wrapTextWithAnsi(line, tipWidth));
          return Array.from({ length: Math.max(left.length, right.length) }, (_, index) => {
            const line = truncateToWidth(left[index] ?? "", WORDMARK_WIDTH, "");
            const padding = " ".repeat(WORDMARK_WIDTH - visibleWidth(line) + 3);
            return line + padding + (right[index] ?? "");
          });
        }

        return [
          ...left.map((line) => truncateToWidth(line, width, "")),
          "",
          ...tips.flatMap((line) => wrapTextWithAnsi(line, width))
        ];
      },
      invalidate() {}
    }));

    ctx.ui.setFooter((tui, theme, footerData) => {
      redraw = () => tui.requestRender();
      const unsubscribe = footerData.onBranchChange(() => tui.requestRender());

      // Spinner animation, only while busy.
      const timer = setInterval(() => {
        if (state !== "ready") tui.requestRender();
      }, 100);
      timer.unref?.();

      return {
        invalidate() {},

        render(width: number) {
          if (width <= 0) return [];
          const dim = (s: string) => theme.fg("dim", s);
          const muted = (s: string) => theme.fg("muted", s);
          const sep = dim(" · ");
          const prompts = ctx.sessionManager.getEntries().filter(
            (entry) => entry.type === "message" && entry.message.role === "user"
          ).length;

          let input = 0, output = 0, cacheRead = 0, cacheWrite = 0, cost = 0;
          for (const entry of ctx.sessionManager.getBranch()) {
            if (entry.type !== "message" || (entry.message.role !== "assistant" && entry.message.role !== "toolResult")) continue;
            const u = entry.message.usage;
            if (!u) continue;
            input += u.input;
            output += u.output;
            cacheRead += u.cacheRead;
            cacheWrite += u.cacheWrite;
            cost += u.cost?.total ?? 0;
          }

          const frame = SPINNER[Math.floor(Date.now() / 100) % SPINNER.length];
          const activity = state === "tool" ? `${frame} ${activeTool}`
            : state === "thinking" ? `${frame} thinking` : "● ready";
          const agent = footerData.getExtensionStatuses?.().get("piexis-agent");
          const agentMode = footerData.getExtensionStatuses?.().get("piexis-agent-mode");
          const branch = footerData.getGitBranch();
          // Reserve a small model slot; long tool names must not displace the profile.
          const modelReserve = width >= 32 ? 9 : 0;
          const fullProfile = agent && agentMode ? `${agent} (${agentMode})` : agent ?? "";
          // Mode is optional; the profile itself remains ahead of activity and right-side fields.
          const profileText = agent && width >= 48 && visibleWidth(fullProfile) + 6 + modelReserve <= width
            ? fullProfile
            : agent ?? "";
          const profileLimit = Math.max(0, width - 1);
          const profile = profileText
            ? theme.fg("accent", truncateToWidth(profileText, profileLimit, "…")) + (profileLimit > 0 ? sep : "")
            : "";
          const activityWidth = Math.max(0, Math.min(24, width - visibleWidth(profile) - modelReserve));
          const left1 = profile + (activityWidth ? theme.fg(state === "ready" ? "success" : "accent",
            truncateToWidth(activity, activityWidth, "…")) : "");
          const row1 = justify(left1, [
            { text: ctx.model?.id ?? "—", priority: 5 },
            { text: muted(`think ${pi.getThinkingLevel()}`), priority: 4 },
            ...(branch ? [{ text: dim(`⎇ ${truncateToWidth(branch, Math.max(8, Math.floor(width / 4)), "…")}`), priority: 3 }] : []),
            { text: dim(`${prompts} prompts`), priority: 2 },
            ...(agent ? [{ text: dim("[Alt+A]"), priority: 1 }] : [])
          ], sep, width);

          const usage = ctx.getContextUsage();
          const pct = usage?.percent ?? null;
          const tone = pct == null ? "dim" : pct >= 90 ? "error" : pct >= 70 ? "warning" : "success";
          const pctText = pct == null ? "—" : `${Math.round(pct)}%`;
          const costText = `$${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(2)}`;
          const barWidth = Math.min(12, Math.max(0,
            width - visibleWidth(`ctx  ${pctText}`) - visibleWidth(costText) - 2));
          const filled = pct == null ? 0 : Math.round((Math.min(100, Math.max(0, pct)) / 100) * barWidth);
          const bar = theme.fg(tone, "━".repeat(filled)) + dim("─".repeat(barWidth - filled));
          const cap = usage
            ? `${usage.tokens == null ? "—" : fmt(usage.tokens)}/${fmt(usage.contextWindow)}`
            : "—/—";
          const context = `${muted("ctx")} ${barWidth ? bar + " " : ""}${theme.fg(tone, pctText)}`;
          const tokens = muted(`↑${fmt(input)} ↓${fmt(output)}`);
          const promptTotal = input + cacheRead + cacheWrite;
          const hit = promptTotal > 0 ? Math.round((cacheRead / promptTotal) * 100) : null;
          // Add capacity only when it leaves room for the basic token totals and cost.
          const showCapacity = visibleWidth(context + " " + cap + tokens + costText) + 7 <= width;
          const left2 = context + (showCapacity ? " " + dim(cap) : "");
          const row2 = justify(left2, [
            { text: tokens, priority: 2 },
            ...(hit == null ? [] : [{ text: dim(`cache ${hit}%`), priority: 1 }]),
            { text: muted(costText), priority: 3 }
          ], sep, width);

          const children = footerData.getExtensionStatuses?.().get("piexis-subagents");
          return children
            ? [row1, row2, theme.fg("accent", truncateToWidth(children, width, "…"))]
            : [row1, row2];
        },

        dispose() {
          clearInterval(timer);
          unsubscribe();
          redraw = () => {};
        }
      };
    });

    update();
  });

  pi.on("agent_start", async () => {
    state = "thinking";
    activeTool = "";
    update();
  });

  pi.on("turn_start", async () => {
    state = "thinking";
    activeTool = "";
    update();
  });

  pi.on("message_end", async () => {
    update();
  });

  pi.on("session_compact", async () => {
    update();
  });

  pi.on("tool_call", async (event) => {
    state = "tool";
    activeTool = event.toolName;
    update();
  });

  pi.on("agent_end", async () => {
    state = "ready";
    activeTool = "";
    update();
  });

  pi.on("model_select", async () => {
    update();
  });

  pi.on("thinking_level_select", async () => {
    update();
  });
}
