import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import soundExtension from "../extensions/sound.ts";
import { audioCommands, readSoundSettings, resolveSoundFile, saveSoundSettings, SoundPlayer, soundFiles } from "../lib/sound.ts";
import { defaultSoundPreferences, SoundNotifications, validateSoundPreferences } from "../packages/shared/src/sound.ts";

async function fixture(work) {
  const root = await mkdtemp(join(tmpdir(), "piexis-sound-"));
  try { await work(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test("notification lifecycle: settle only, duration threshold, retries and deduplication", () => {
  const n = new SoundNotifications();
  assert.equal(n.accept({ type: "agent_settled" }, 5000, 10000), undefined);
  n.accept({ type: "agent_start" }, 5000, 0);
  assert.equal(n.accept({ type: "agent_end" }, 5000, 6000), undefined);
  n.accept({ type: "message_end", message: { role: "assistant", stopReason: "error" } });
  n.accept({ type: "agent_start" }, 5000, 6500);
  n.accept({ type: "message_end", message: { role: "assistant", stopReason: "stop" } });
  assert.equal(n.accept({ type: "agent_settled" }, 5000, 7000), "finished");
  assert.equal(n.accept({ type: "agent_settled" }, 5000, 7001), undefined);
  n.accept({ type: "agent_start" }, 5000, 10000);
  assert.equal(n.accept({ type: "agent_settled" }, 5000, 14999), undefined);
});

test("attention once per open dialog, no startup/config/tool noise", () => {
  const n = new SoundNotifications();
  assert.equal(n.accept({ type: "ui_prompt_start" }), undefined);
  n.accept({ type: "agent_start" });
  assert.equal(n.accept({ type: "ui_prompt_start" }), "attention");
  assert.equal(n.accept({ type: "ui_prompt_start" }), undefined);
  n.accept({ type: "ui_prompt_end" });
  assert.equal(n.accept({ type: "ui_prompt_start" }), "attention");
  assert.equal(n.accept({ type: "tool_execution_end", isError: true }), undefined);
});

test("unrecovered model errors notify, successful recovery and cancellation stay distinct", () => {
  const n = new SoundNotifications();
  n.accept({ type: "agent_start" }, 5000, 0);
  n.accept({ type: "message_end", message: { role: "assistant", stopReason: "error" } });
  assert.equal(n.accept({ type: "agent_settled" }, 5000, 1), "failure");
  for (const event of [{ type: "agent_settled", aborted: true }, { type: "agent_settled" }]) {
    n.accept({ type: "agent_start" }, 5000, 0);
    n.accept({ type: "message_end", message: { role: "assistant", stopReason: "aborted" } });
    assert.equal(n.accept(event, 5000, 10000), undefined);
  }
  assert.equal(n.accept({ type: "runtime_error" }), "failure");
  assert.equal(n.accept({ type: "runtime_error" }), undefined);
  n.reset();
  assert.equal(n.accept({ type: "ui_prompt_start" }), undefined);
});

test("preferences default to unconfigured/off; save either choice without touching Pi config", async () => fixture(async (root) => {
  const path = join(root, "piexis-sound.json");
  await writeFile(join(root, "settings.json"), "do not change");
  let previous = await readSoundSettings(root);
  assert.equal(previous.text, undefined);
  assert.equal(previous.preferences.enabled, false);
  previous = await saveSoundSettings(root, previous, { ...previous.preferences, enabled: false });
  assert.notEqual(previous.text, undefined);
  const prefs = { ...previous.preferences, enabled: true, events: { attention: false, finished: true, failure: true }, minimumDurationMs: 15000 };
  await saveSoundSettings(root, previous, prefs);
  assert.deepEqual((await readSoundSettings(root)).preferences, prefs);
  assert.equal(await readFile(join(root, "settings.json"), "utf8"), "do not change");
  assert.deepEqual((await readdir(root)).sort(), ["piexis-sound.json", "settings.json"]);
  if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600);
}));

test("invalid, changed, symlinked and locked preferences are never overwritten", async () => fixture(async (root) => {
  const path = join(root, "piexis-sound.json");
  for (const text of ["{bad", "null", "[]", '{"enabled":true}', JSON.stringify({ ...defaultSoundPreferences(), minimumDurationMs: -1 })]) {
    await writeFile(path, text);
    await assert.rejects(readSoundSettings(root));
    assert.equal(await readFile(path, "utf8"), text);
  }
  const prefs = defaultSoundPreferences();
  await writeFile(path, JSON.stringify({ ...prefs, custom: 42 }));
  const previous = await readSoundSettings(root);
  await writeFile(path, JSON.stringify({ ...prefs, custom: 43 }));
  await assert.rejects(saveSoundSettings(root, previous, prefs), /changed/);
  const current = await readSoundSettings(root);
  await mkdir(`${path}.lock`);
  await assert.rejects(saveSoundSettings(root, current, prefs), { code: "EEXIST" });
  assert.equal((await stat(`${path}.lock`)).isDirectory(), true);
  await rm(`${path}.lock`, { recursive: true });
  await saveSoundSettings(root, current, prefs);
  assert.equal(JSON.parse(await readFile(path, "utf8")).custom, 43);
  if (process.platform !== "win32") {
    await rm(path);
    await writeFile(join(root, "target"), "untouched");
    await symlink(join(root, "target"), path);
    await assert.rejects(readSoundSettings(root), /regular/);
    assert.equal(await readFile(join(root, "target"), "utf8"), "untouched");
  }
}));

test("aborted preference saves do not create files", async () => fixture(async (root) => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(saveSoundSettings(root, await readSoundSettings(root), defaultSoundPreferences(), controller.signal), { name: "AbortError" });
  assert.deepEqual(await readdir(root), []);
  assert.throws(() => validateSoundPreferences({ ...defaultSoundPreferences(), enabled: "yes" }));
}));

test("asset mapping matches the user selection and personal WAVs take precedence", async () => fixture(async (root) => {
  assert.equal(soundFiles.attention, "mixkit-dry-pop-up-notification-alert-2356.wav");
  assert.equal(soundFiles.finished, "mixkit-bubble-pop-up-alert-notification-2357.wav");
  assert.equal(soundFiles.failure, "mixkit-gaming-lock-2848.wav");
  await mkdir(join(root, "sounds"));
  await writeFile(join(root, "sounds", "attention.wav"), "user file");
  assert.equal(await resolveSoundFile(root, "attention"), join(root, "sounds", "attention.wav"));
}));

test("platform commands quote paths safely and never use the terminal bell", () => {
  assert.deepEqual(audioCommands("darwin", false, "/some file.wav"), [{ command: "afplay", args: ["/some file.wav"] }]);
  assert.deepEqual(audioCommands("linux", false, "/file.wav").map((entry) => entry.command), ["pw-play", "paplay", "aplay"]);
  const [windows] = audioCommands("win32", false, "C:\\a'b;$(evil).wav");
  const decoded = Buffer.from(windows.args.at(-1), "base64").toString("utf16le");
  assert.match(decoded, /SoundLocation = 'C:\\a''b;\$\(evil\).wav'/);
  assert.match(decoded, /PlaySync/);
  assert.equal(windows.command, "powershell.exe");
  assert.deepEqual(audioCommands("other", false, "file"), []);
});

test("Linux fallback, unavailable player failures, cooldown, and WSL path conversion", async () => {
  const calls = [];
  const player = new SoundPlayer("unused", { platform: "linux", wsl: false, resolveFile: async () => "/file.wav", now: () => 1000,
    run: async (command) => { calls.push(command); if (command !== "aplay") throw new Error("unavailable"); return ""; } });
  assert.equal(await player.play("attention"), true);
  assert.deepEqual(calls, ["pw-play", "paplay", "aplay"]);
  assert.equal(await player.play("failure"), false);
  assert.equal(await player.play("failure", true), true);
  const wslCalls = [];
  const wsl = new SoundPlayer("unused", { platform: "linux", wsl: true, resolveFile: async () => "/mnt/c/file.wav",
    run: async (command, args) => { wslCalls.push([command, args]); return "C:\\file.wav"; } });
  assert.equal(await wsl.play("attention"), true);
  assert.deepEqual(wslCalls[0], ["wslpath", ["-w", "/mnt/c/file.wav"]]);
  assert.equal(wslCalls[1][0], "powershell.exe");
  assert.match(Buffer.from(wslCalls[1][1].at(-1), "base64").toString("utf16le"), /C:\\file.wav/);
  const failing = new SoundPlayer("unused", { platform: "darwin", resolveFile: async () => { throw new Error("missing WAV"); } });
  assert.equal(await failing.play("attention"), false);
  assert.match(failing.lastError, /missing WAV/);
});

test("overlap and shutdown stop active playback without leaking rejected promises", async () => {
  let ready;
  const started = new Promise((resolve) => { ready = resolve; });
  const player = new SoundPlayer("unused", { platform: "darwin", resolveFile: async () => "/file.wav",
    run: async (_command, _args, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }); ready();
    }) });
  const playing = player.play("attention");
  await started;
  assert.equal(await player.play("failure", true), false);
  player.stop();
  assert.equal(await playing, false);
  assert.equal(player.lastError, undefined);
});

function harness(root, choices = ["Yes"], options = {}) {
  const handlers = new Map(), commands = new Map(), played = [], notices = [];
  let now = 0, stops = 0, prompts = 0;
  const player = { async play(...args) { played.push(args); return true; }, stop() { stops++; }, async status() { return "mock player"; } };
  soundExtension({ on(name, handler) { handlers.set(name, handler); }, registerCommand(name, command) { commands.set(name, command); } },
    { agentDir: root, terminal: () => true, player, now: () => now, ...options });
  const ctx = { mode: "tui", hasUI: true, hasPendingMessages: () => false, ui: {
    async select() { prompts++; return choices.shift(); }, notify(...args) { notices.push(args); }
  } };
  return { ctx, played, notices, get prompts() { return prompts; }, get stops() { return stops; },
    set time(value) { now = value; }, emit: (type, extra = {}) => handlers.get(type)?.({ type, ...extra }, ctx),
    command: (args = "") => commands.get("sound").handler(args, ctx) };
}

test("startup Yes/No is persisted once, dismissal makes no writes", async () => {
  for (const choice of ["Yes", "No", undefined]) await fixture(async (root) => {
    const h = harness(root, [choice]);
    await h.emit("session_start");
    await h.emit("session_start");
    assert.equal(h.prompts, 1);
    assert.equal((await readSoundSettings(root)).text === undefined, choice === undefined);
    assert.equal((await readSoundSettings(root)).preferences.enabled, choice === "Yes");
    if (choice !== undefined) {
      const restart = harness(root);
      await restart.emit("session_start");
      assert.equal(restart.prompts, 0);
    }
  });
});

test("noninteractive modes and non-TTY sessions never prompt or play", async () => fixture(async (root) => {
  for (const mode of ["rpc", "print", "json"]) {
    const h = harness(root); h.ctx.mode = mode;
    await h.emit("session_start"); await h.emit("agent_start"); await h.emit("ui_prompt_start");
    h.time = 10000; await h.emit("agent_settled");
    assert.equal(h.prompts, 0); assert.deepEqual(h.played, []);
  }
  const h = harness(root, ["Yes"], { terminal: () => false });
  await h.emit("session_start"); assert.equal(h.prompts, 0);
}));

test("extension routes final/attention/error events and supports on/off/test/status and event toggles", async () => fixture(async (root) => {
  const h = harness(root);
  await h.emit("session_start");
  await h.emit("agent_start");
  await h.emit("ui_prompt_start"); await h.emit("ui_prompt_start"); await h.emit("ui_prompt_end");
  h.time = 6000; await h.emit("agent_settled"); await h.emit("agent_settled");
  assert.deepEqual(h.played, [["attention"], ["finished"]]);
  await h.command("off");
  await h.emit("agent_start"); await h.emit("ui_prompt_start");
  assert.equal(h.played.length, 2);
  await h.command("test failure"); assert.deepEqual(h.played.at(-1), ["failure", true]);
  await h.command("status"); assert.match(h.notices.at(-1)[0], /mock player/);
  await h.command("on");
  await h.emit("message_end", { message: { role: "assistant", stopReason: "error" } });
  await h.emit("agent_settled"); assert.deepEqual(h.played.at(-1), ["failure"]);
  await h.emit("session_shutdown"); assert.ok(h.stops >= 2);
  const settings = await readSoundSettings(root);
  await saveSoundSettings(root, settings, { ...settings.preferences, events: { attention: false, finished: true, failure: true } });
  const restart = harness(root);
  await restart.emit("session_start"); await restart.emit("agent_start"); await restart.emit("ui_prompt_start");
  assert.deepEqual(restart.played, []);
}));

test("settings menu saves per-event toggles and duration, and can preview while muted", async () => fixture(async (root) => {
  const h = harness(root, ["No", "Sounds: off", "attention: on", "Completion minimum: 5s", "15 seconds", "Preview finished", "Done"]);
  await h.emit("session_start");
  await h.command();
  const { preferences } = await readSoundSettings(root);
  assert.equal(preferences.enabled, true);
  assert.equal(preferences.events.attention, false);
  assert.equal(preferences.minimumDurationMs, 15000);
  assert.deepEqual(h.played, [["finished", true]]);
  await h.command("test unknown");
  assert.match(h.notices.at(-1)[0], /Use \/sound test/);
}));

test("queued continuations do not produce a premature completion sound", async () => fixture(async (root) => {
  const h = harness(root);
  await h.emit("session_start"); await h.emit("agent_start");
  h.time = 10000;
  h.ctx.hasPendingMessages = () => true;
  await h.emit("agent_settled");
  assert.deepEqual(h.played, []);
  await h.emit("agent_start");
  h.ctx.hasPendingMessages = () => false;
  await h.emit("agent_settled");
  assert.deepEqual(h.played, [["finished"]]);
}));

test("shutdown aborts startup without persisting a preference", async () => fixture(async (root) => {
  const h = harness(root);
  let shown;
  const ready = new Promise((resolve) => { shown = resolve; });
  h.ctx.ui.select = (_title, _choices, { signal }) => new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(undefined), { once: true }); shown();
  });
  const starting = h.emit("session_start");
  await ready; await h.emit("session_shutdown"); await starting;
  assert.equal((await readSoundSettings(root)).text, undefined);
}));

test("manifest loads sound after setup, tips advertise /sound, restricted audio stays unpublished", async () => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.ok(manifest.pi.extensions.indexOf("./extensions/sound.ts") > manifest.pi.extensions.indexOf("./extensions/recommended-tools.ts"));
  assert.ok(!manifest.files.includes("audio/"));
  const tips = JSON.parse(await readFile(new URL("../lib/ui-tips.json", import.meta.url), "utf8"));
  assert.ok(tips.some((tip) => tip.text.includes("/sound")));
});
