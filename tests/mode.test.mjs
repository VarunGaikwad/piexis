import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import modeExtension from "../extensions/mode.ts";

test("permission mode changes remain user-controlled rather than model-callable", () => {
  const tools = new Map();
  const handlers = new Map();
  modeExtension({
    registerFlag() {},
    registerTool(definition) { tools.set(definition.name, definition); },
    registerCommand() {},
    registerShortcut() {},
    on(name, handler) { handlers.set(name, handler); },
    appendEntry() {},
    getFlag() {},
    events: { emit() {} }
  });

  assert.equal(tools.has("switch_permission_mode"), false);
  assert.equal(typeof handlers.get("tool_call"), "function");
});

test("mode cycling is idle-only, skips unavailable Auto, and rejects corrupt restored modes", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "piexis-mode-polish-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const handlers = new Map();
  const shortcuts = new Map();
  const commands = new Map();
  let branch = [];
  let current;
  let idle = true;
  modeExtension({
    registerFlag() {}, getFlag() {},
    registerCommand(name, command) { commands.set(name, command); },
    registerShortcut(name, shortcut) { shortcuts.set(name, shortcut.handler); },
    on(name, callback) { handlers.set(name, callback); },
    appendEntry(customType, data) { branch.push({ type: "custom", customType, data }); },
    events: { emit(name, value) { if (name === "piexis:permission-mode") current = value; } }
  });
  const ctx = { cwd, hasUI: false, mode: "json", isIdle: () => idle,
    sessionManager: { getBranch: () => branch }, ui: {}, modelRegistry: { find: () => undefined, hasConfiguredAuth: () => false } };
  await handlers.get("session_start")({ reason: "startup" }, ctx);
  assert.equal(current, "default");
  idle = false;
  await assert.rejects(shortcuts.get("alt+m")(ctx), /idle/);
  await assert.rejects(commands.get("plan").handler("", ctx), /idle/);
  assert.equal(current, "default");
  idle = true;
  for (const expected of ["acceptEdits", "plan", "default"]) {
    await shortcuts.get("alt+m")(ctx);
    assert.equal(current, expected);
  }
  for (const restored of ["bypassPermissions", "dontAsk", "auto", "made-up-mode", "__proto__"]) {
    branch = [{ type: "custom", customType: "piexis-permission-mode", data: { mode: restored } }];
    await handlers.get("session_tree")({}, ctx);
    assert.equal(current, "default", restored);
  }
});
