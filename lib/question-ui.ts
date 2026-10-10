import type { Theme } from "@earendil-works/pi-coding-agent";
import { Input, Key, matchesKey, truncateToWidth, type TUI } from "@earendil-works/pi-tui";
import { initialDraft, outcome, validateAnswer, type Answer, type Draft, type Outcome, type Question, type Result } from "./question-model.ts";

// Model-provided labels are plain text, not terminal escape sequences.
const plain = (text: string) => text.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export class QuestionScreen {
  private current = 0;
  private review = false;
  private error = "";
  private settled = false;
  private hasFocus = false;
  private readonly drafts: Draft[];
  private readonly inputs: Input[];
  private readonly focus: number[];
  private readonly confirmed = new Set<number>();
  private readonly abort = () => this.finish("aborted");
  private readonly eof = () => this.finish("error", "Terminal input closed before submission.");
  private readonly inputError = (error: Error) => this.finish("error", `Terminal input failed: ${message(error)}`);

  private readonly questions: Question[];
  private readonly tui: Pick<TUI, "requestRender" | "terminal">;
  private readonly theme: Pick<Theme, "fg">;
  private readonly done: (result: Result) => void;
  private readonly signal?: AbortSignal;
  private readonly stream: Pick<NodeJS.ReadStream, "on" | "off">;

  constructor(
    questions: Question[],
    tui: Pick<TUI, "requestRender" | "terminal">,
    theme: Pick<Theme, "fg">,
    done: (result: Result) => void,
    signal?: AbortSignal,
    stream: Pick<NodeJS.ReadStream, "on" | "off"> = process.stdin
  ) {
    this.questions = questions;
    this.tui = tui;
    this.theme = theme;
    this.done = done;
    this.signal = signal;
    this.stream = stream;
    this.drafts = questions.map(initialDraft);
    this.focus = this.drafts.map((draft) => draft.indices[0] ?? 0);
    this.inputs = questions.map(() => new Input({ prompt: "> " }));
    signal?.addEventListener("abort", this.abort, { once: true });
    stream.on("end", this.eof);
    stream.on("close", this.eof);
    stream.on("error", this.inputError);
    if (signal?.aborted) this.abort();
  }

  get focused() { return this.hasFocus; }
  set focused(value: boolean) {
    this.hasFocus = value;
    this.inputs.forEach((input, i) => { input.focused = value && !this.review && i === this.current && this.drafts[i]!.custom; });
  }

  dispose() {
    this.signal?.removeEventListener("abort", this.abort);
    this.stream.off("end", this.eof);
    this.stream.off("close", this.eof);
    this.stream.off("error", this.inputError);
    this.inputs.forEach((input) => { input.focused = false; });
  }

  private answers(): Answer[] {
    return this.questions.flatMap((q, i) => this.confirmed.has(i) ? [validateAnswer(q, this.drafts[i]!)] : []);
  }

  private finish(status: Outcome, error?: string) {
    if (this.settled) return;
    this.settled = true;
    this.dispose();
    this.done(outcome(status, this.answers(), error));
  }

  private refresh() {
    this.focused = this.hasFocus;
    this.tui.requestRender();
  }

  private save() {
    try {
      validateAnswer(this.questions[this.current]!, this.drafts[this.current]!);
      this.confirmed.add(this.current);
      this.error = "";
      if (this.questions.length === 1) this.finish("answered");
      else if (this.current + 1 < this.questions.length) this.current++;
      else this.review = true;
    } catch (error) {
      this.error = message(error);
    }
  }

  handleInput(data: string) {
    if (this.settled) return;
    try {
      if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
        this.finish("cancelled");
        return;
      }
      if (this.questions.length > 1 && (matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab")))) {
        const position = this.review ? this.questions.length : this.current;
        const direction = matchesKey(data, Key.tab) ? 1 : -1;
        const next = (position + direction + this.questions.length + 1) % (this.questions.length + 1);
        this.review = next === this.questions.length;
        if (!this.review) this.current = next;
        this.error = "";
      } else if (this.review) {
        if (matchesKey(data, Key.enter)) {
          const missing = this.questions.findIndex((_, i) => !this.confirmed.has(i));
          if (missing !== -1) {
            this.current = missing;
            this.review = false;
            this.error = "Confirm this question before submitting.";
          } else {
            this.questions.forEach((q, i) => validateAnswer(q, this.drafts[i]!));
            this.finish("answered");
          }
        }
      } else {
        const q = this.questions[this.current]!;
        const draft = this.drafts[this.current]!;
        const input = this.inputs[this.current]!;
        if (draft.custom) {
          if (q.type !== "text" && matchesKey(data, Key.up)) {
            draft.custom = false;
            this.confirmed.delete(this.current);
          } else if (matchesKey(data, Key.enter)) {
            this.save();
          } else {
            input.handleInput(data);
            draft.text = input.getValue();
            this.confirmed.delete(this.current);
            this.error = "";
          }
        } else {
          // The synthetic action lives at a separate index, never a label or option ID.
          const count = q.options.length + (q.allowOther ? 1 : 0) + (!q.required && q.type === "single" ? 1 : 0);
          let focus = this.focus[this.current]!;
          if (matchesKey(data, Key.up)) this.focus[this.current] = (focus - 1 + count) % count;
          else if (matchesKey(data, Key.down)) this.focus[this.current] = (focus + 1) % count;
          else if (q.type === "multi" && matchesKey(data, Key.space) && focus < q.options.length) {
            draft.indices = draft.indices.includes(focus) ? draft.indices.filter((i) => i !== focus) : [...draft.indices, focus];
            this.confirmed.delete(this.current);
            this.error = "";
          } else if (matchesKey(data, Key.enter) || (q.type === "multi" && matchesKey(data, Key.space))) {
            if (q.allowOther && focus === q.options.length) {
              draft.custom = true;
              this.confirmed.delete(this.current);
            } else {
              if (q.type === "single") draft.indices = focus < q.options.length ? [focus] : [];
              this.save();
            }
          }
        }
      }
      this.refresh();
    } catch (error) {
      this.finish("error", message(error));
    }
  }

  invalidate() { this.inputs.forEach((input) => input.invalidate()); }

  render(width: number): string[] {
    if (this.settled) return [];
    try {
      width = Math.max(1, width);
      const lines: string[] = [];
      const add = (text: string, color: Parameters<Theme["fg"]>[0] = "text") => lines.push(truncateToWidth(this.theme.fg(color, plain(text)), width));
      add(this.review ? "✓ Review answers · Enter to submit" : `? Question ${this.current + 1}/${this.questions.length}`, "accent");
      if (this.review) {
        this.questions.forEach((q, i) => {
          const value = this.confirmed.has(i) ? validateAnswer(q, this.drafts[i]!).answer : "(not confirmed)";
          add(`${q.question}: ${Array.isArray(value) ? value.join(", ") : value}`);
        });
      } else {
        const q = this.questions[this.current]!;
        const draft = this.drafts[this.current]!;
        add(q.question);
        if (draft.custom) {
          add(q.type === "text" ? "Your answer:" : "Your answer · ↑ returns to options", "muted");
          lines.push(...this.inputs[this.current]!.render(width));
        } else {
          const choices = q.options.map((option, i) => ({ label: option.label, description: option.description, selected: draft.indices.includes(i) }));
          if (q.allowOther) choices.push({ label: "Type something else", description: undefined, selected: false });
          if (!q.required && q.type === "single") choices.push({ label: "Skip (no answer)", description: undefined, selected: false });
          // Bound menu height to the terminal and keep the focused choice visible.
          const capacity = Math.max(1, Math.floor((this.tui.terminal.rows - 9) / 2));
          const start = Math.max(0, Math.min(this.focus[this.current]! - Math.floor(capacity / 2), choices.length - capacity));
          choices.slice(start, start + capacity).forEach((choice, offset) => {
            const i = start + offset;
            const focused = i === this.focus[this.current];
            add(`${focused ? "❯" : " "} ${q.type === "multi" ? choice.selected ? "[x] " : "[ ] " : ""}${i + 1}. ${choice.label}`, focused ? "accent" : "text");
            if (choice.description) add(`     ${choice.description}`, "muted");
          });
          if (choices.length > capacity) add(`${start + 1}–${Math.min(start + capacity, choices.length)} of ${choices.length}`, "dim");
        }
      }
      if (this.error) add(this.error, "error");
      const multi = !this.review && this.questions[this.current]!.type === "multi" && !this.drafts[this.current]!.custom;
      const textMode = !this.review && this.drafts[this.current]!.custom;
      add(`${this.review || textMode ? "" : multi ? "↑↓ Navigate · Space Toggle · " : "↑↓ Navigate · "}Enter Confirm · Esc/Ctrl+C Cancel`, "dim");
      if (this.questions.length > 1) add("Tab/Shift+Tab Questions · Answers preserved", "dim");
      return lines;
    } catch (error) {
      this.finish("error", message(error));
      return [];
    }
  }
}
