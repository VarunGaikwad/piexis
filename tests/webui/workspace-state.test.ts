import assert from "node:assert/strict";
import test from "node:test";
import { initialWorkspaceState, reduceWorkspace } from "../../apps/web/src/lib/workspace-state.ts";

const session = (id: string, status: "ready" | "running" = "ready") => ({ id, name: id, status });
const snapshot = (id: string, messages: unknown[] = []) => ({ type: "snapshot", sessions: [session("one"), session("two")], sessionId: id, state: {}, messages });

test("session snapshots isolate transcript, stream, tools, and dialogs", () => {
  let state = reduceWorkspace(initialWorkspaceState, snapshot("one", [{ role: "user", content: "first" }]));
  state = reduceWorkspace(state, { type: "pi_event", sessionId: "one", event: { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hello" } } });
  state = reduceWorkspace(state, { type: "pi_event", sessionId: "one", event: { type: "tool_execution_start", toolCallId: "tool-1", toolName: "read" } });
  state = reduceWorkspace(state, { type: "extension_ui", sessionId: "one", request: { id: "dialog-1", method: "confirm" } });
  state = reduceWorkspace(state, snapshot("two", [{ role: "assistant", content: "second" }]));
  assert.equal(state.activeId, "two");
  assert.equal(state.views.two.stream, "");
  assert.equal(state.views.two.tools.length, 0);
  assert.equal(state.views.two.messages[0].content, "second");
  assert.equal(state.dialogs.two, undefined);
  assert.equal(state.dialogs.one.id, "dialog-1");
  assert.equal(state.views.one.stream, "hello");
  assert.equal(state.views.one.tools.length, 1);
});

test("streaming, tool lifecycle, and session statuses are applied in event order", () => {
  let state = reduceWorkspace(initialWorkspaceState, snapshot("one"));
  state = reduceWorkspace(state, { type: "pi_event", sessionId: "one", event: { type: "agent_start" } });
  state = reduceWorkspace(state, { type: "pi_event", sessionId: "one", event: { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "a" } } });
  state = reduceWorkspace(state, { type: "pi_event", sessionId: "one", event: { type: "tool_execution_start", toolCallId: "call", toolName: "grep", args: { q: "x" } } });
  state = reduceWorkspace(state, { type: "pi_event", sessionId: "one", event: { type: "tool_execution_end", toolCallId: "call", result: "ok", isError: false } });
  state = reduceWorkspace(state, { type: "pi_event", sessionId: "one", event: { type: "message_end", message: { role: "assistant", content: "answer" } } });
  state = reduceWorkspace(state, { type: "pi_event", sessionId: "one", event: { type: "agent_settled" } });
  assert.equal(state.sessions.find((item) => item.id === "one")?.status, "ready");
  assert.equal(state.views.one.stream, "");
  assert.equal(state.views.one.messages.length, 1);
  assert.deepEqual(state.views.one.tools[0], { id: "call", name: "grep", args: { q: "x" }, result: "ok", error: false, running: false });
});

test("extension requests retain their owning session while unrelated events arrive", () => {
  let state = reduceWorkspace(initialWorkspaceState, snapshot("one"));
  state = reduceWorkspace(state, { type: "extension_ui", sessionId: "two", request: { id: "pick", method: "select", options: ["yes"] } });
  state = reduceWorkspace(state, { type: "workspace", sessionId: "one", action: "git_status", data: { branch: "main", files: [] } });
  assert.equal(state.dialogs.two.id, "pick");
  assert.equal(state.dialogs.one, undefined);
  assert.equal(state.views.one.git?.branch, "main");
  state = reduceWorkspace(state, snapshot("two"));
  assert.equal(state.dialogs.two.id, "pick");
  state = reduceWorkspace(state, { type: "dialog_clear", sessionId: "two" });
  assert.equal(state.dialogs.two, undefined);
});

test("revisiting a running session preserves its streamed text, tools, and Git state", () => {
  let state = reduceWorkspace(initialWorkspaceState, snapshot("one"));
  state = reduceWorkspace(state, { type: "pi_event", sessionId: "one", event: { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "partial" } } });
  state = reduceWorkspace(state, { type: "pi_event", sessionId: "one", event: { type: "tool_execution_start", toolCallId: "call", toolName: "read" } });
  state = reduceWorkspace(state, { type: "workspace", sessionId: "one", action: "git_status", data: { branch: "main", files: [] } });
  state = reduceWorkspace(state, snapshot("two"));
  state = reduceWorkspace(state, { ...snapshot("one"), sessions: [session("one", "running"), session("two")] });
  assert.equal(state.views.one.stream, "partial");
  assert.equal(state.views.one.tools[0].running, true);
  assert.equal(state.views.one.git?.branch, "main");
});

test("prompt submission, rejection and error dismissal update usable controls", () => {
  let state = reduceWorkspace(initialWorkspaceState, snapshot("one"));
  state = reduceWorkspace(state, { type: "prompt_sent", sessionId: "one" });
  assert.equal(state.sessions[0].status, "running");
  state = reduceWorkspace(state, { type: "prompt_rejected", sessionId: "one" });
  state = reduceWorkspace(state, { type: "error", message: "Prompt rejected" });
  assert.equal(state.sessions[0].status, "ready");
  assert.equal(state.error, "Prompt rejected");
  state = reduceWorkspace(state, { type: "error_clear" });
  assert.equal(state.error, "");
});

test("settling and runtime failure clear pending requests without leaving running tools", () => {
  let state = reduceWorkspace(initialWorkspaceState, snapshot("one"));
  state = reduceWorkspace(state, { type: "extension_ui", sessionId: "one", request: { id: "input", method: "input" } });
  state = reduceWorkspace(state, { type: "pi_event", sessionId: "one", event: { type: "tool_execution_start", toolCallId: "call", toolName: "read" } });
  state = reduceWorkspace(state, { type: "pi_event", sessionId: "one", event: { type: "agent_settled", aborted: true } });
  assert.equal(state.dialogs.one, undefined);
  assert.equal(state.views.one.tools[0].running, false);
  state = reduceWorkspace(state, { type: "pi_event", sessionId: "one", event: { type: "runtime_error", message: "Process exited" } });
  assert.equal(state.sessions[0].status, "failed");
  assert.equal(state.error, "Process exited");
});

test("session updates keep navigation order and unsupported UI requests are ignored", () => {
  let state = reduceWorkspace(initialWorkspaceState, snapshot("one"));
  state = reduceWorkspace(state, { type: "session", session: session("one", "running") });
  assert.deepEqual(state.sessions.map((entry) => entry.id), ["one", "two"]);
  state = reduceWorkspace(state, { type: "extension_ui", sessionId: "one", request: { id: "notice", method: "notify" } });
  assert.deepEqual(state.dialogs, {});
  assert.equal(reduceWorkspace(state, null), state);
});
