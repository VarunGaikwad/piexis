import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { truncateToWidth } from "@earendil-works/pi-tui";

import { basename } from "node:path";

export default function (pi: ExtensionAPI) {
  let state = "ready";
  let activeTool = "";
  let redraw = () => {};

  function update() {
    redraw();
  }

  pi.on("session_start", async (_event, ctx) => {
    const project = basename(ctx.cwd);

    // Put project info in the terminal tab instead of wasting TUI rows.
    ctx.ui.setTitle(`π ${project}`);

    // Headers are rendered once at the top of the startup view. A widget would
    // stay attached to the editor forever, making the onboarding copy noisy.
    ctx.ui.setHeader((_tui, theme) => ({
      render(width: number) {
        const rule = theme.fg(
          "dim",
          "─".repeat(Math.max(0, Math.min(width, 72)))
        );
        const lines =
          width < 72
            ? [
                `${theme.fg("accent", "✦")} ${theme.bold("PieXis")}  ${theme.fg("dim", project)}`,
                `${theme.fg("muted", "Try:")} explain code · find bugs · review diffs · run tests`,
                `${theme.fg("dim", "/plan <task> · Alt+M modes · /help for commands")}`
              ]
            : [
                `${theme.fg("accent", "✦")} ${theme.bold("PieXis")}  ${theme.fg("dim", "permission-aware coding workspace")}  ${theme.fg("muted", project)}`,
                rule,
                `${theme.fg("muted", "Try:")} explain code · find bugs · review diffs · trace behavior     ${theme.fg("muted", "Build:")} edit · refactor · test`,
                `${theme.fg("muted", "Run:")} tests · lint · typecheck · Git     ${theme.fg("muted", "Plan:")} /plan <task> · Alt+M modes     ${theme.fg("dim", "Mention files, constraints, and expected behavior.")}`
              ];
        return lines.map((line) => truncateToWidth(line, width, ""));
      },
      invalidate() {}
    }));

    ctx.ui.setFooter((tui, theme, footerData) => {
      redraw = () => tui.requestRender();

      const unsubscribe = footerData.onBranchChange(() => {
        tui.requestRender();
      });

      return {
        invalidate() {},

        render(width: number) {
          const branch = footerData.getGitBranch() ?? "—";

          const model = ctx.model?.id?.replace(/^gpt-/, "") ?? "—";
          const effort = ctx.thinkingLevel ?? "off";

          const usage = ctx.getContextUsage();

          const context =
            usage?.percent != null
              ? `ctx ${Math.round(usage.percent)}%`
              : "ctx —";

          let activity: string;

          if (state === "tool") {
            activity = theme.fg("accent", `◆ ${activeTool}`);
          } else if (state === "thinking") {
            activity = theme.fg("accent", "◆ thinking");
          } else {
            activity = theme.fg("success", "● ready");
          }

          const statuses = [...footerData.getExtensionStatuses().values()];
          // Keep this tolerant of theme/icon changes in the permission extension.
          const modeStatus =
            statuses.find((status) =>
              /(?:manual|accept edits|plan|auto|don't ask|bypass permissions).*on/i.test(
                status
              )
            ) ?? "";
          const line =
            `${activity}` +
            (modeStatus ? theme.fg("accent", ` │ ${modeStatus}`) : "") +
            theme.fg(
              "dim",
              ` │ ${branch}` + ` │ ${model}` + ` │ ${context}`
            );

          return [truncateToWidth(line, width, "")];
        },

        dispose() {
          unsubscribe();
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
