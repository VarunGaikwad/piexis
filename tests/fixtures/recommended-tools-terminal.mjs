import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getEventListeners } from "node:events";
import { ExtensionSelectorComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { Input, ProcessTerminal, TuiMainScreen } from "@earendil-works/pi-tui";
import recommendedTools from "../../extensions/recommended-tools.ts";

const scenario = process.argv[2];
const root = await mkdtemp(join(tmpdir(), "piexis-setup-pty-"));
const cwd = join(root, "project");
await mkdir(cwd);
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
initTheme("dark", false);
const handlers = new Map();
let active = ["read", "bash", "edit", "write", "AskQuestion"];
if (scenario === "setup-agent-upgrade") {
  active.push("grep", "find", "ls");
  await mkdir(join(cwd, ".pi"));
  await writeFile(join(cwd, ".pi", "settings.json"), JSON.stringify({
    defaultTools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
    piexis: { recommendedTools: "enabled" }
  }));
}
const available = ["read", "bash", "edit", "write", "grep", "find", "ls"].map((name) => ({ name, sourceInfo: { source: "builtin" } }));
available.push({ name: "subagent", sourceInfo: { source: "extension" } });
recommendedTools({
  on(name, handler) { handlers.set(name, handler); },
  getActiveTools: () => active,
  getAllTools: () => available,
  setActiveTools: (tools) => { active = tools; }
});
const originalRaw = !!process.stdin.isRaw;
const originalListeners = process.stdin.listenerCount("data");
const tui = new TuiMainScreen(new ProcessTerminal(), true);
const editor = new Input();
let restored = 0;
const ctx = { cwd, mode: "tui", hasUI: true, model: { provider: "test", id: "default" }, isProjectTrusted: () => true, ui: {
  notify() {},
  select(title, options, { signal }) {
    return new Promise((resolve) => {
      let closed = false;
      const finish = (value) => {
        if (closed) return;
        closed = true;
        signal.removeEventListener("abort", abort);
        selector.dispose();
        tui.clear();
        tui.addChild(editor);
        tui.setFocus(editor);
        tui.requestRender();
        restored++;
        resolve(value);
      };
      const abort = () => finish(undefined);
      const selector = new ExtensionSelectorComponent(title, options, finish, () => finish(undefined));
      signal.addEventListener("abort", abort, { once: true });
      tui.clear();
      tui.addChild(selector);
      tui.setFocus(selector);
      tui.requestRender();
      if (signal.aborted) abort();
    }).then((value) => {
      assert.equal(getEventListeners(signal, "abort").length, 0);
      return value;
    });
  }
} };
tui.addChild(editor);
tui.setFocus(editor);
tui.start();
let saved;
try {
  await handlers.get("session_start")({}, ctx);
  assert.equal(restored, 1);
  assert.equal(tui.getFocusedComponent(), editor);
  try { saved = JSON.parse(await readFile(join(cwd, ".pi", "settings.json"), "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (scenario === "setup-enable" || scenario === "setup-agent-upgrade") {
    assert.equal(saved.piexis.recommendedTools, "enabled");
    assert.deepEqual(active, ["read", "bash", "edit", "write", "AskQuestion", "grep", "find", "ls"]);
    const agentConfig = JSON.parse(await readFile(join(cwd, ".pi", "agent.json"), "utf8"));
    assert.equal(agentConfig.model, "test/default");
    assert.deepEqual(agentConfig.subagent_variant_overrides, {
      plan: { model: "test/default", effort: "high" },
      orchestrator: { model: "test/default", effort: "high" },
      debug: { model: "test/default", effort: "high" },
      ask: { model: "test/default", effort: "low" },
      code: { model: "test/default", effort: "medium" },
    });
    if (scenario === "setup-agent-upgrade") assert.deepEqual(saved.defaultTools, ["read", "bash", "edit", "write", "grep", "find", "ls"]);
  } else if (scenario === "setup-disabled") {
    assert.deepEqual(saved, { piexis: { recommendedTools: "disabled", agentSetup: "disabled" } });
  } else assert.equal(saved, undefined);
  if (scenario !== "setup-enable" && scenario !== "setup-agent-upgrade") await assert.rejects(readFile(join(cwd, ".pi", "agent.json")), { code: "ENOENT" });
} finally {
  tui.stop();
  await rm(root, { recursive: true, force: true });
}
assert.equal(!!process.stdin.isRaw, originalRaw);
assert.equal(process.stdin.listenerCount("data"), originalListeners);
process.stdout.write(`\nRESULT:${JSON.stringify({ status: "answered", restored, rawRestored: true, listenersRestored: true, scenario })}\n`);
