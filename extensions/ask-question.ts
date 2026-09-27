import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const Option = Type.Object({
  label: Type.String({ description: "The option shown to the user" }),
  description: Type.Optional(Type.String({ description: "Why this option may be useful" }))
});

const Question = Type.Object({
  question: Type.String({ description: "The question to ask" }),
  options: Type.Array(Option, { description: "Options the user can choose from" }),
  multiSelect: Type.Optional(
    Type.Boolean({ description: "Allow the user to choose multiple options" })
  ),
  allowOther: Type.Optional(
    Type.Boolean({ description: "Allow free-form text instead of an option" })
  )
});

const AskQuestionParams = Type.Object({
  questions: Type.Array(Question, {
    description: "Questions to ask; ask related questions together when possible"
  })
});

type Answer = {
  question: string;
  answer: string | string[] | null;
};

/** AskQuestion gives the model a real, interactive way to clarify requirements. */
export default function askQuestion(pi: ExtensionAPI) {
  pi.registerTool({
    name: "AskQuestion",
    label: "Ask Question",
    description:
      "Ask the user one or more questions and wait for their answers. Use this when requirements, preferences, or a decision need clarification before proceeding. Permission-mode changes remain user-controlled through Pi's mode commands or shortcuts.",
    parameters: AskQuestionParams,
    executionMode: "sequential",

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (ctx.mode !== "tui") {
        return {
          content: [{ type: "text", text: "AskQuestion requires an interactive TUI." }],
          details: { answers: [], cancelled: true }
        };
      }

      const answers: Answer[] = [];
      for (const item of params.questions) {
        if (item.options.length === 0 && item.allowOther !== true) {
          return {
            content: [{ type: "text", text: "AskQuestion requires options or allowOther=true." }],
            details: { answers, cancelled: true }
          };
        }

        let answer: string | string[] | null;
        if (item.multiSelect) {
          const choices = item.options.map((option, index) => `${index + 1}. ${option.label}`);
          const entered = await ctx.ui.input(
            `${item.question}\n${choices.join("\n")}\nEnter option numbers separated by commas:`,
            item.allowOther ? "or type a free-form answer" : "e.g. 1, 3"
          );
          if (entered == null) answer = null;
          else {
            const selected = entered
              .split(",")
              .map((value) => Number(value.trim()) - 1)
              .filter((index) => Number.isInteger(index) && index >= 0 && index < item.options.length)
              .map((index) => item.options[index]!.label);
            if (selected.length > 0) answer = selected;
            else if (item.allowOther) answer = entered.trim();
            else {
              return {
                content: [{ type: "text", text: "Choose one or more listed option numbers." }],
                details: { answers, cancelled: true }
              };
            }
          }
        } else if (item.options.length > 0) {
          const otherLabel = "Other — type your own answer";
          const choices = item.options.map((option) =>
            option.description ? `${option.label} — ${option.description}` : option.label
          );
          if (item.allowOther) choices.push(otherLabel);
          const selected = await ctx.ui.select(item.question, choices);
          answer = selected ?? null;
          if (selected === otherLabel) {
            answer = (await ctx.ui.input(item.question, "Type your answer")) ?? null;
          } else if (answer != null) {
            answer = item.options.find((option) =>
              (option.description ? `${option.label} — ${option.description}` : option.label) === answer
            )?.label ?? answer;
          }
        } else {
          answer = (await ctx.ui.input(item.question, "Type your answer")) ?? null;
        }

        answers.push({ question: item.question, answer });
        if (answer == null) break;
      }

      const cancelled = answers.some((entry) => entry.answer == null);
      return {
        content: [{ type: "text", text: JSON.stringify({ answers, cancelled }) }],
        details: { answers, cancelled }
      };
    }
  });
}
