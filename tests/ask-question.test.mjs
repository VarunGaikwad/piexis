import assert from "node:assert/strict";
import { EventEmitter, getEventListeners } from "node:events";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import askQuestion from "../extensions/ask-question.ts";
import { normalizeQuestions, initialDraft, validateAnswer } from "../lib/question-model.ts";
import { QuestionScreen } from "../lib/question-ui.ts";

const theme = { fg: (_color, text) => text };
const keys = { up: "\x1b[A", down: "\x1b[B", enter: "\r", escape: "\x1b", tab: "\t", backtab: "\x1b[Z", space: " ", ctrlC: "\x03" };
const question = (patch = {}) => normalizeQuestions({ questions: [{ question: "Which?", options: [{ id: "a", label: "A", description: "First choice" }, { id: "b", label: "B" }], ...patch }] })[0];
const draft = (indices, patch = {}) => ({ indices, text: "", custom: false, ...patch });

function screen(questions = [question()], signal) {
  const stream = new EventEmitter();
  let completions = 0, result;
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  const component = new QuestionScreen(questions, { requestRender() {}, terminal: { rows: 24 } }, theme, (value) => {
    completions++;
    result = value;
    resolve(value);
  }, signal, stream);
  component.focused = true;
  return { component, stream, promise, get result() { return result; }, get completions() { return completions; } };
}

function send(ui, ...inputs) { inputs.forEach((key) => ui.component.handleInput(keys[key] ?? key)); }

for (const [name, indices] of [["invalid", [999]], ["mixed valid/invalid", [0, 999]], ["malformed", ["1"]], ["fractional", [0.5]], ["negative", [-1]]]) {
  test(`rejects ${name} selections without discarding values`, () => {
    assert.throws(() => validateAnswer(question({ type: "multi" }), draft(indices)), /listed options/);
  });
}

test("single and multi validation, deterministic duplicate removal, min/max limits", () => {
  assert.equal(validateAnswer(question(), draft([1])).answer, "B");
  const multi = question({ type: "multi" });
  assert.deepEqual(validateAnswer(multi, draft([1, 0, 1])).optionIds, ["a", "b"]);
  assert.deepEqual(validateAnswer(multi, draft([1, 0, 1])).answer, ["A", "B"]);
  assert.throws(() => validateAnswer(question(), draft([])), /at least 1/);
  assert.throws(() => validateAnswer(question({ type: "multi", minSelections: 0 }), draft([])), /at least 1/);
  assert.throws(() => validateAnswer(question({ type: "multi", minSelections: 2 }), draft([0])), /at least 2/);
  assert.throws(() => validateAnswer(question({ type: "multi", maxSelections: 1 }), draft([0, 1])), /at most 1/);
  assert.equal(validateAnswer(question({ required: false }), draft([])).answer, "");
});

test("custom text is explicit, untrimmed, Unicode-aware and never parsed as numbers", () => {
  const q = question({ allowOther: true, maxLength: 20 });
  for (const text of ["1, 999", "1, hello", "  café 🦊 & <>  "]) {
    assert.equal(validateAnswer(q, draft([], { custom: true, text })).answer, text);
  }
  assert.throws(() => validateAnswer(q, draft([], { custom: true, text: "  " })), /required/);
  assert.throws(() => validateAnswer(question(), draft([], { custom: true, text: "A" })), /not enabled/);
  assert.throws(() => validateAnswer(q, draft([], { custom: true, text: "x".repeat(21) })), /at most 20/);
  assert.equal(validateAnswer(question({ type: "text", options: [], required: false }), draft([], { custom: true, text: "" })).answer, "");
  assert.equal(validateAnswer(question({ allowOther: true, maxLength: 1 }), draft([], { custom: true, text: "🦊" })).answer, "🦊");
});

test("normalization preserves legacy calls and rejects unusable contracts", () => {
  assert.equal(question({ multiSelect: true }).type, "multi");
  assert.equal(question({ options: [], allowOther: true }).type, "text");
  assert.equal(question({ options: [], multiSelect: true, allowOther: true }).type, "text");
  assert.deepEqual(initialDraft(question({ defaultSelection: "b" })).indices, [1]);
  for (const patch of [
    { options: [] }, { type: "single", options: [] }, { type: "text" },
    { defaultSelection: "unknown" }, { defaultSelection: ["a", "b"] },
    { type: "multi", minSelections: 2, maxSelections: 1 },
    { type: "multi", maxSelections: 3 }, { type: "single", multiSelect: true },
    { options: [{ id: "a", label: "A" }, { id: "a", label: "B" }] }
  ]) assert.throws(() => question(patch));
  assert.throws(() => normalizeQuestions({ questions: [] }));
  assert.throws(() => normalizeQuestions({ questions: [{ ...question(), id: "same" }, { ...question(), id: "same" }] }));
});

test("arrow navigation, description rendering, default focus and Enter", async () => {
  const ui = screen([question({ defaultSelection: "b" })]);
  assert.match(ui.component.render(80).join("\n"), /❯ 2\. B/);
  send(ui, "up");
  assert.match(ui.component.render(80).join("\n"), /❯ 1\. A\n     First choice/);
  send(ui, "down", "enter");
  assert.equal((await ui.promise).answers[0].answer, "B");
  assert.equal(ui.stream.listenerCount("end"), 0);
  assert.equal(ui.stream.listenerCount("close"), 0);
});

test("Space toggles multi selections; errors retain screen and allow retry", async () => {
  const ui = screen([question({ type: "multi", minSelections: 2 })]);
  send(ui, "space", "enter");
  assert.equal(ui.result, undefined);
  assert.match(ui.component.render(80).join("\n"), /at least 2/);
  assert.match(ui.component.render(80).join("\n"), /❯ \[x\] 1\. A/);
  send(ui, "space", "space", "down", "space", "enter");
  assert.deepEqual((await ui.promise).answers[0].optionIds, ["a", "b"]);
  const max = screen([question({ type: "multi", maxSelections: 1 })]);
  send(max, "space", "down", "space", "enter");
  assert.match(max.component.render(80).join("\n"), /at most 1/);
  send(max, "space", "enter");
  assert.deepEqual((await max.promise).answers[0].optionIds, ["a"]);
});

test("Other label collisions cannot activate text; Other is enabled only explicitly", async () => {
  for (const allowOther of [false, true]) {
    const ui = screen([question({ allowOther, options: [{ id: "other", label: "Other — type your own answer" }, { id: "__other__", label: "Type something else" }] })]);
    send(ui, "enter");
    assert.equal((await ui.promise).answers[0].custom, false);
    assert.equal(ui.result.answers[0].answer, "Other — type your own answer");
  }
  const ui = screen([question({ allowOther: true })]);
  send(ui, "down", "down", "enter", "enter");
  assert.match(ui.component.render(80).join("\n"), /An answer is required/);
  send(ui, "1, 999 café 🦊", "enter");
  assert.equal((await ui.promise).answers[0].answer, "1, 999 café 🦊");
  assert.equal(ui.result.answers[0].custom, true);
});

test("text required/optional, optional single skip, and maximum text length", async () => {
  const ui = screen([question({ type: "text", options: [], maxLength: 3 })]);
  send(ui, "  ", "enter");
  assert.equal(ui.result, undefined);
  send(ui, "abcd", "enter");
  assert.match(ui.component.render(80).join("\n"), /at most 3/);
  send(ui, "escape");
  assert.equal((await ui.promise).status, "cancelled");
  const optional = screen([question({ type: "text", options: [], required: false })]);
  send(optional, "enter");
  assert.equal((await optional.promise).answers[0].answer, "");
  assert.equal(optional.result.status, "answered");
  const skip = screen([question({ required: false })]);
  send(skip, "up", "enter");
  assert.equal((await skip.promise).answers[0].answer, "");
});

test("Tab navigation preserves text and selections; review requires every confirmation", async () => {
  const ui = screen([question(), { ...question({ type: "text", options: [] }), id: "second" }]);
  send(ui, "down", "enter", "hello", "backtab");
  assert.match(ui.component.render(80).join("\n"), /Question 1\/2/);
  send(ui, "tab");
  assert.match(ui.component.render(80).join("\n"), /hello/);
  send(ui, "tab", "enter");
  assert.match(ui.component.render(80).join("\n"), /Confirm this question/);
  send(ui, "enter");
  assert.match(ui.component.render(80).join("\n"), /Review answers/);
  send(ui, "enter");
  assert.deepEqual((await ui.promise).answers.map((a) => a.answer), ["B", "hello"]);
});

test("abort before render, pending abort, both submit/abort races, listener cleanup", async () => {
  for (const order of ["before", "pending", "submit-first", "abort-first"]) {
    const controller = new AbortController();
    if (order === "before") controller.abort();
    const ui = screen(undefined, controller.signal);
    if (order === "submit-first") send(ui, "enter");
    controller.abort();
    send(ui, "enter");
    const result = await ui.promise;
    assert.equal(result.status, order === "submit-first" ? "answered" : "aborted");
    assert.equal(ui.completions, 1);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    assert.equal(ui.stream.listenerCount("end"), 0);
    assert.deepEqual(ui.component.render(80), []);
  }
});

test("Esc/Ctrl+C cancellation and unexpected input closure always settle", async () => {
  for (const key of ["escape", "ctrlC"]) {
    const ui = screen();
    send(ui, key);
    assert.equal((await ui.promise).status, "cancelled");
  }
  for (const event of ["end", "close", "error"]) {
    const ui = screen();
    ui.stream.emit(event, new Error("broken input"));
    assert.equal((await ui.promise).status, "error");
    assert.equal(ui.stream.listenerCount(event), 0);
  }
});

test("narrow terminals, long menus and untrusted labels render safely", () => {
  const ui = screen([question({ question: "Very long question 🦊", options: Array.from({ length: 50 }, (_, i) => ({ label: `Choice ${i}\x1b[2J` })) })]);
  for (const width of [1, 8, 20, 80]) {
    const lines = ui.component.render(width);
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
    assert.ok(lines.length < 24);
    assert.ok(lines.every((line) => !line.includes("\x1b[2J")));
  }
  send(ui, "up");
  assert.match(ui.component.render(80).join("\n"), /❯ 50\. Choice 49/);
  send(ui, "escape");
});

test("render/input failures settle rather than leaving an active question", async () => {
  let result;
  const stream = new EventEmitter();
  const ui = new QuestionScreen([question()], { requestRender() { throw new Error("render unavailable"); }, terminal: { rows: 24 } }, theme, (value) => { result = value; }, undefined, stream);
  ui.handleInput(keys.down);
  assert.equal(result.status, "error");
  assert.equal(stream.listenerCount("end"), 0);
  const badTheme = new QuestionScreen([question()], { requestRender() {}, terminal: { rows: 24 } }, { fg() { throw new Error("bad theme"); } }, (value) => { result = value; }, undefined, stream);
  badTheme.render(80);
  assert.equal(result.status, "error");
});

async function tty(work) {
  const streams = [process.stdin, process.stdout];
  const saved = streams.map((stream) => Object.getOwnPropertyDescriptor(stream, "isTTY"));
  streams.forEach((stream) => Object.defineProperty(stream, "isTTY", { configurable: true, value: true }));
  try { await work(); } finally {
    streams.forEach((stream, i) => saved[i] ? Object.defineProperty(stream, "isTTY", saved[i]) : delete stream.isTTY);
  }
}

function toolHarness() {
  let tool, component, restorations = 0;
  const handlers = new Map();
  askQuestion({ registerTool(value) { tool = value; }, on(name, handler) { handlers.set(name, handler); } });
  const ctx = { mode: "tui", hasUI: true, ui: { custom(factory) {
    return new Promise((resolve) => {
      component = factory({ requestRender() {}, terminal: { rows: 24 } }, theme, {}, (value) => { restorations++; resolve(value); });
    });
  } } };
  const params = { questions: [{ question: "Which?", options: [{ label: "A" }] }] };
  return { tool, ctx, params, handlers, get component() { return component; }, get restorations() { return restorations; } };
}

test("result renderer supports retained legacy sessions and missing details", () => {
  const { tool } = toolHarness();
  const old = { content: [], details: { answers: [{ question: "Which?", answer: "A" }], cancelled: false } };
  assert.match(tool.renderResult(old, {}, theme).render(80).join("\n"), /✓ Which\?: A/);
  assert.match(tool.renderResult({ content: [{ type: "text", text: "Original result" }] }, {}, theme).render(80).join("\n"), /Original result/);
});

test("tool protects non-TTY, legacy calls, concurrency, shutdown and failures", async () => {
  const h = toolHarness();
  assert.equal((await h.tool.execute("id", h.params, undefined, undefined, h.ctx)).details.status, "requires_interaction");
  await tty(async () => {
    for (const patch of [{ hasUI: false }, { mode: "json" }, { mode: "rpc" }]) {
      assert.equal((await h.tool.execute("unavailable", h.params, undefined, undefined, { ...h.ctx, ...patch })).details.status, "requires_interaction");
    }
    const first = h.tool.execute("id", h.params, undefined, undefined, h.ctx);
    const conflict = await h.tool.execute("second", h.params, undefined, undefined, h.ctx);
    assert.equal(conflict.details.status, "error");
    assert.match(conflict.details.error, /already active/);
    h.component.handleInput(keys.enter);
    const result = await first;
    assert.equal(result.details.status, "answered");
    assert.equal(result.details.answers[0].answer, "A");
    assert.deepEqual(JSON.parse(result.content[0].text), result.details);
    assert.equal(h.restorations, 1);
    const pending = h.tool.execute("next", h.params, undefined, undefined, h.ctx);
    await h.handlers.get("session_shutdown")();
    assert.equal((await pending).details.status, "aborted");
    const invalid = await h.tool.execute("bad", { questions: [] }, undefined, undefined, h.ctx);
    assert.equal(invalid.details.status, "error");
    const failed = await h.tool.execute("bad", h.params, undefined, undefined, { ...h.ctx, ui: { custom() { throw new Error("UI unavailable"); } } });
    assert.equal(failed.details.status, "error");
    const controller = new AbortController();
    controller.abort();
    const aborted = await h.tool.execute("aborted", h.params, controller.signal, undefined, h.ctx);
    assert.equal(aborted.details.status, "aborted");
    const runningController = new AbortController();
    const running = h.tool.execute("agent-abort", h.params, runningController.signal, undefined, h.ctx);
    runningController.abort();
    assert.equal((await running).details.status, "aborted");
    const waiting = h.tool.execute("waiting", h.params, undefined, undefined, h.ctx);
    h.component.handleInput(keys.escape);
    assert.equal((await waiting).details.status, "cancelled");
  });
});
