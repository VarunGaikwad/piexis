import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import modeExtension from "../extensions/mode.ts";
import { createModeRuntime } from "../lib/mode-guard.ts";
import { STATE_VERSION } from "../lib/mode-policy.ts";
import { fixture, fakeSandbox } from "./mode-fixtures.mjs";

async function setup(t, { entries = [], hasUI = true, flag } = {}) {
  const { root } = await fixture(t);
  const handlers = new Map(), commands = new Map(), tools = new Map(), statuses = new Map();
  const notifications = [], messages = [], sandboxes = [];
  let branch = [...entries], choice, idle = true, owner = fileURLToPath(new URL("../extensions/mode.ts", import.meta.url));
  const ctx = {
    cwd: root, hasUI, isIdle: () => idle,
    sessionManager: { getBranch: () => branch },
    ui: { setStatus: (k, v) => statuses.set(k, v), notify: (...args) => notifications.push(args), confirm: async () => false,
      select: async (_title, options) => choice === undefined ? undefined : options[choice] }
  };
  const pi = {
    registerTool: tool => tools.set(tool.name, tool),
    registerFlag() {}, getFlag: () => flag,
    registerCommand: (name, command) => commands.set(name, command),
    getAllTools: () => [...tools.values()].map(tool => ({ name: tool.name, sourceInfo: { path: owner, source: "extension" } })),
    on: (name, handler) => handlers.set(name, handler),
    appendEntry: (customType, data) => branch.push({ type: "custom", customType, data }),
    sendMessage: message => messages.push(message)
  };
  modeExtension(pi, options => {
    const sandbox = fakeSandbox();
    sandboxes.push(sandbox);
    return createModeRuntime({ ...options, sandbox });
  });
  const emit = (name, event = {}) => handlers.get(name)?.(event, ctx);
  await emit("session_start", { reason: "startup" });
  t.after(() => emit("session_shutdown"));
  return {
    root, ctx, tools, commands, statuses, notifications, messages, sandboxes, emit,
    run: (args = "") => commands.get("mode").handler(args, ctx),
    prompt: () => emit("before_agent_start", { systemPrompt: "Original prompt" }).systemPrompt,
    entries: () => branch, branch: value => { branch = value; }, choice: value => { choice = value; },
    idle: value => { idle = value; }, owner: value => { owner = value; },
    execute: (tool, input) => tools.get(tool).execute("test", input, undefined, undefined, ctx)
  };
}
const saved = mode => ({ type: "custom", customType: "piexis-mode", data: { version: STATE_VERSION, mode } });

test("Default startup, four modes, base prompt and explicit versioned state", async t => {
  const app = await setup(t);
  assert.match(app.statuses.get("piexis-mode"), /^Mode: Default/);
  assert.match(app.prompt(), /^Original prompt\n\n## Permission mode: Default/);
  for (const mode of ["plan", "build", "yolo", "default"]) {
    await app.run(mode.toUpperCase());
    assert.deepEqual(app.entries().at(-1).data, { version: STATE_VERSION, mode });
  }
  assert.ok(app.notifications.some(([message]) => /YOLO: no permission/.test(message)));
});

test("picker, cancellation, invalid names, completions and busy changes", async t => {
  const app = await setup(t);
  await app.run();
  assert.equal(app.entries().length, 0);
  app.choice(1);
  await app.run();
  assert.equal(app.entries().at(-1).data.mode, "plan");
  const count = app.entries().length;
  await app.run("plan");
  await app.run("architect");
  assert.equal(app.entries().length, count);
  assert.match(app.notifications.at(-1)[0], /Unknown mode/);
  app.idle(false);
  await app.run("yolo");
  assert.match(app.notifications.at(-1)[0], /Wait for/);
  assert.equal(app.entries().length, count);
  assert.deepEqual(app.commands.get("mode").getArgumentCompletions("B").map(i => i.value), ["build"]);
});

test("active-branch restore, reload, resume, fork, tree and legacy fallback", async t => {
  const app = await setup(t, { entries: [saved("build")] });
  assert.match(app.prompt(), /Permission mode: Build/);
  for (const reason of ["reload", "resume", "fork"]) {
    await app.emit("session_start", { reason });
    assert.match(app.prompt(), /Permission mode: Build/);
  }
  app.branch([saved("plan")]);
  await app.emit("session_tree");
  assert.match(app.prompt(), /Permission mode: Plan Mode/);
  app.branch([{ type: "custom", customType: "piexis-mode", data: { mode: "code" } }]);
  await app.emit("session_tree");
  assert.match(app.prompt(), /Permission mode: Default/);
  assert.match(app.notifications.at(-1)[0], /Legacy or invalid/);
  app.branch([]);
  await app.emit("session_start", { reason: "new" });
  assert.match(app.prompt(), /Permission mode: Default/);
});

test("CLI startup selection survives reload but doesn't override later selection or new sessions", async t => {
  const app = await setup(t, { entries: [saved("plan")], flag: "build" });
  assert.match(app.prompt(), /Permission mode: Build/);
  await app.run("plan");
  await app.emit("session_start", { reason: "reload" });
  assert.match(app.prompt(), /Permission mode: Plan Mode/);
  app.branch([]);
  await app.emit("session_start", { reason: "new" });
  assert.match(app.prompt(), /Permission mode: Default/);
});

test("headless commands never access UI", async t => {
  const app = await setup(t, { hasUI: false });
  app.ctx.ui = new Proxy({}, { get() { throw new Error("Unexpected UI access"); } });
  await app.run();
  assert.match(app.messages.at(-1).content, /Usage: \/mode/);
  await app.run("build");
  await app.execute("write", { path: "x.ts", content: "x" });
  await app.run("default");
  await assert.rejects(app.execute("write", { path: "x.ts", content: "x" }), /no confirmation UI/);
});

test("unknown tools, delegation, and conflicting overrides are blocked except YOLO", async t => {
  const app = await setup(t);
  for (const toolName of ["read_file", "custom_shell", "subagent", "powershell", "web_fetch"]) {
    assert.equal((await app.emit("tool_call", { toolName, input: {} })).block, true);
  }
  assert.equal(await app.emit("tool_call", { toolName: "read", input: { path: "source.ts" } }), undefined);
  app.owner("<builtin:read>");
  assert.match((await app.emit("tool_call", { toolName: "read", input: {} })).reason, /Conflicting/);
  await app.run("yolo");
  assert.equal(await app.emit("tool_call", { toolName: "custom_shell", input: {} }), undefined);
  assert.equal(await app.emit("tool_call", { toolName: "read", input: {} }), undefined);
});

test("plan handoff requires user selection and doesn't run the plan", async t => {
  const app = await setup(t, { entries: [saved("plan")] });
  await assert.rejects(app.execute("write", { path: "source.ts", content: "bad" }), /\/mode build/);
  assert.match(app.prompt(), /Permission mode: Plan Mode/);
  await app.execute("write", { path: ".pi/plans/task.md", content: "Plan" });
  app.choice(0);
  await app.emit("agent_settled");
  assert.match(app.prompt(), /Permission mode: Plan Mode/);
  await app.execute("write", { path: ".pi/plans/task.md", content: "Revised plan" });
  app.choice(1);
  await app.emit("agent_settled");
  assert.match(app.prompt(), /Permission mode: Build/);
  assert.equal(app.sandboxes.at(-1).calls.filter(c => c[0] === "bash").length, 0);
  assert.ok(app.notifications.some(([message]) => /Ready to apply/.test(message)));
});

test("user_bash is managed and shutdown fails closed", async t => {
  const app = await setup(t, { entries: [saved("plan")] });
  const hook = await app.emit("user_bash", { command: "pwd", cwd: app.root });
  await hook.operations.exec("pwd", app.root, { onData() {} });
  assert.ok(app.sandboxes.at(-1).calls.some(c => c[0] === "bash" && c[1] === "plan"));
  await app.emit("session_shutdown");
  assert.equal(app.statuses.get("piexis-mode"), undefined);
  assert.equal((await app.emit("tool_call", { toolName: "bash", input: {} })).block, true);
});
