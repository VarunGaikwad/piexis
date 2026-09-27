import assert from "node:assert/strict";
import test from "node:test";

import backgroundTasks from "../extensions/background-tasks.ts";
import backgroundWorker from "../extensions/background-worker.ts";

test("background tasks expose launch, status, cancellation, and explicit apply tools", () => {
  const tools = new Map();
  const commands = new Map();
  backgroundTasks({
    registerFlag() {},
    registerTool(tool) { tools.set(tool.name, tool); },
    registerCommand(name, command) { commands.set(name, command); },
    on() {},
    events: { on() {} }
  });

  assert.deepEqual([...tools.keys()].sort(), ["background_task", "task_status", "task_cancel", "task_diff", "task_clean", "task_apply"].sort());
  assert.ok(commands.has("task"));
  assert.equal(tools.get("background_task").executionMode, "sequential");
});

test("background worker does not install a foreground permission guard without a broker", () => {
  let handler;
  backgroundWorker({ on(name, callback) { if (name === "tool_call") handler = callback; } });
  assert.equal(handler, undefined);
});
