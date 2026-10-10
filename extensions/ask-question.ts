import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { AskQuestionParams, normalizeQuestions, outcome, type Result } from "../lib/question-model.ts";
import { QuestionScreen } from "../lib/question-ui.ts";

/** Pi owns terminal input, rendering, raw mode and editor restoration. */
export default function askQuestion(pi: ExtensionAPI) {
  let active: AbortController | undefined;
  pi.on("session_shutdown", async () => { active?.abort(); });

  pi.registerTool({
    name: "AskQuestion",
    label: "Ask Question",
    description:
      "Ask the user related clarification questions in the terminal and wait for validated answers. Options may have stable IDs. Supports single, multi, and text questions, custom answers, defaults (option IDs), selection limits, and required/optional answers. Legacy options/multiSelect/allowOther calls remain supported.",
    parameters: AskQuestionParams,
    executionMode: "sequential",

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const result = (details: Result) => ({
        content: [{ type: "text" as const, text: JSON.stringify(details) }],
        details
      });
      if (signal?.aborted) return result(outcome("aborted"));
      if (ctx.mode !== "tui" || !process.stdin.isTTY || !process.stdout.isTTY || !ctx.hasUI ||
          process.stdin.destroyed || process.stdin.readableEnded || process.stdout.destroyed) {
        return result(outcome("requires_interaction", [], "AskQuestion requires an interactive TUI and terminal input/output."));
      }
      // sequential protects model batches; this guard also protects direct overlapping calls.
      if (active) return result(outcome("error", [], "Another AskQuestion interaction is already active."));
      const controller = new AbortController();
      active = controller;
      const interactionSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      let screen: QuestionScreen | undefined;
      try {
        const questions = normalizeQuestions(params);
        const details = await ctx.ui.custom<Result>((tui, theme, _keybindings, done) => {
          screen = new QuestionScreen(questions, tui, theme, done, interactionSignal);
          return screen;
        });
        return result(details);
      } catch (error) {
        return result(outcome("error", [], error instanceof Error ? error.message : String(error)));
      } finally {
        screen?.dispose();
        active = undefined;
      }
    },

    renderResult(result, _options, theme) {
      const details = result.details as Result | undefined;
      if (!details) {
        const text = result.content.find((entry) => entry.type === "text");
        return new Text(text?.type === "text" ? text.text : "AskQuestion", 0, 0);
      }
      // Resumed sessions may contain results from the original label-only tool.
      const status = details.status ?? (details.cancelled ? "cancelled" : "answered");
      if (status !== "answered") {
        const text = (details.error ?? `AskQuestion: ${status}`).replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
        return new Text(theme.fg(status === "error" ? "error" : "warning", text), 0, 0);
      }
      const lines = details.answers.map((entry) => {
        const answer = Array.isArray(entry.answer) ? entry.answer.join(", ") : entry.answer;
        const text = `${entry.question}: ${answer}`.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
        return theme.fg("success", "✓ ") + text;
      });
      return new Text(lines.join("\n"), 0, 0);
    }
  });
}
