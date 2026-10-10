import assert from "node:assert/strict";
import { Input, ProcessTerminal, TuiMainScreen } from "@earendil-works/pi-tui";
import askQuestion from "../../extensions/ask-question.ts";

const scenario = process.argv[2];
const controller = new AbortController();
let tool;
askQuestion({ on() {}, registerTool(value) { tool = value; } });
const terminal = new ProcessTerminal();
const tui = new TuiMainScreen(terminal, true);
const editor = new Input();
const originalRaw = !!process.stdin.isRaw;
const originalDataListeners = process.stdin.listenerCount("data");
const originalEndListeners = process.stdin.listenerCount("end");
const theme = { fg: (_color, text) => text };
let restored = 0;

// Exercise the production component with Pi's real renderer/input transport.
// This adapter mirrors ctx.ui.custom's editor restoration/completion contract.
const ctx = { mode: "tui", hasUI: true, ui: { custom(factory) {
  return new Promise((resolve) => {
    let component;
    let closed = false;
    const done = (value) => {
      if (closed) return;
      closed = true;
      tui.clear();
      tui.addChild(editor);
      tui.setFocus(editor);
      tui.requestRender();
      component?.dispose();
      restored++;
      resolve(value);
    };
    component = factory(tui, theme, {}, done);
    if (!closed) {
      tui.clear();
      tui.addChild(component);
      tui.setFocus(component);
      tui.requestRender();
    }
  });
} } };
const options = [{ id: "a", label: "JWT Authentication", description: "Stateless tokens" }, { id: "b", label: "OAuth 2.0" }];
let questions = [{ question: "Authentication method?", options }];
if (scenario === "multi") questions[0] = { ...questions[0], multiSelect: true, minSelections: 2 };
if (scenario === "text") questions = [{ question: "Your response?", type: "text", required: true }];
if (scenario === "other") questions[0].allowOther = true;
if (scenario === "navigation") questions.push({ question: "Your response?", type: "text" });
const removeListener = tui.addInputListener((data) => {
  if (data === "!") { controller.abort(); return { consume: true }; }
});
tui.addChild(editor);
tui.setFocus(editor);
tui.start();
let details;
try {
  details = (await tool.execute("pty", { questions }, controller.signal, undefined, ctx)).details;
  assert.equal(restored, 1);
  assert.equal(tui.getFocusedComponent(), editor);
  assert.equal(editor.focused, true);
  assert.equal(process.stdin.listenerCount("end"), originalEndListeners);
} finally {
  removeListener();
  tui.stop();
}
assert.equal(!!process.stdin.isRaw, originalRaw);
assert.equal(process.stdin.listenerCount("data"), originalDataListeners);
process.stdout.write(`\nRESULT:${JSON.stringify({ ...details, restored, rawRestored: true, listenersRestored: true })}\n`);
