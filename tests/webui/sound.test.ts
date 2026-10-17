import assert from "node:assert/strict";
import test from "node:test";
import { BrowserSoundPlayer, WebSoundNotifications } from "../../apps/web/src/lib/sound.ts";

test("web routes live dialog, settled completion, and terminal error without duplicate RPC prompt sounds", () => {
  const played: string[] = [];
  let now = 0;
  const sound = new WebSoundNotifications((event) => played.push(event), () => now);
  const event = (type: string, extra = {}, sessionId = "one") => sound.receive({ type: "pi_event", sessionId, event: { type, ...extra } });
  const dialog = (id: string) => sound.receive({ type: "extension_ui", sessionId: "one", request: { id, method: "confirm" } });
  sound.receive({ type: "snapshot", sessionId: "one", messages: [] });
  event("agent_settled");
  assert.deepEqual(played, []);
  event("agent_start");
  event("ui_prompt_start"); dialog("first"); dialog("first");
  assert.deepEqual(played, ["attention"]);
  sound.respond("one"); dialog("second");
  event("tool_execution_end", { isError: true });
  event("agent_end");
  now = 6000; event("agent_settled"); event("agent_settled");
  assert.deepEqual(played, ["attention", "attention", "finished"]);
  event("agent_start");
  event("message_end", { message: { role: "assistant", stopReason: "error" } });
  event("agent_settled");
  event("runtime_error"); event("runtime_error");
  assert.deepEqual(played.slice(-2), ["failure", "failure"]);
});

test("web keeps concurrent sessions and cancellations separate", () => {
  let now = 0;
  const played: string[] = [];
  const sound = new WebSoundNotifications((event) => played.push(event), () => now);
  const event = (sessionId: string, type: string, extra = {}) => sound.receive({ type: "pi_event", sessionId, event: { type, ...extra } });
  event("one", "agent_start"); event("two", "agent_start");
  now = 10000;
  event("one", "agent_settled", { aborted: true });
  event("two", "agent_settled");
  assert.deepEqual(played, ["finished"]);
});

test("browser requires explicit unlock, catches blocked audio, and mute prevents fetch/play", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "AudioContext");
  let resumes = 0, closes = 0;
  class FakeContext {
    state = "running";
    async resume() { resumes++; }
    async close() { closes++; }
  }
  Object.defineProperty(globalThis, "AudioContext", { configurable: true, value: FakeContext });
  try {
    const player = new BrowserSoundPlayer(() => "secret");
    await player.play("attention"); // no context created and no network request
    assert.equal(resumes, 0);
    assert.equal(await player.enable(), true);
    assert.equal(resumes, 1);
    player.disable();
    assert.equal(player.enabled, false);
    await player.play("finished");
    player.dispose();
    assert.equal(closes, 1);
    Object.defineProperty(globalThis, "AudioContext", { configurable: true, value: class { async resume() { throw new Error("blocked"); } } });
    const blocked = new BrowserSoundPlayer(() => "secret");
    assert.equal(await blocked.enable(), false);
    assert.match(blocked.lastError!, /blocked/);
  } finally {
    if (original) Object.defineProperty(globalThis, "AudioContext", original);
    else Reflect.deleteProperty(globalThis, "AudioContext");
  }
});
