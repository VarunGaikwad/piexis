import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import modeExtension from "../extensions/mode.ts";
import { classifierAction } from "../lib/permission-classifier.ts";
import { evaluateAutoPolicy } from "../lib/mode-policy.ts";
import { evaluatePathPolicy, resolveWorkspaceRoot } from "../lib/path-policy.ts";
import { readProjectPermissionConfig } from "../lib/permission-config.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "piexis-policy-"));
  const project = join(root, "project");
  const outside = join(root, "outside");
  await Promise.all([mkdir(join(project, "nested"), { recursive: true }), mkdir(outside)]);
  await writeFile(join(project, ".git"), "fixture");
  await writeFile(join(project, "file with spaces.txt"), "ok");
  await writeFile(join(project, "üñïçødé.txt"), "ok");
  await writeFile(join(outside, "secret"), "no");
  await symlink(outside, join(project, "outside-link"));
  await symlink(join(outside, "missing"), join(project, "broken-link"));
  return { project, outside, nested: join(project, "nested") };
}

test("path policy canonicalizes nested project cwd and rejects lexical boundary escapes", async () => {
  const { project, outside, nested } = await fixture();
  const root = await resolveWorkspaceRoot(nested);
  assert.equal(root, project);
  for (const path of ["file with spaces.txt", "üñïçødé.txt", "nested/../file with spaces.txt", "./file with spaces.txt"]) {
    assert.equal((await evaluatePathPolicy("read", { path }, root))?.decision, "allow", path);
  }
  for (const path of ["../outside/secret", "../../", outside, "outside-link/secret"]) {
    const result = await evaluatePathPolicy("read", { path }, root);
    assert.equal(result?.decision, "review", path);
    assert.equal(result?.reason, "outside-project");
  }
  assert.deepEqual(await evaluatePathPolicy("read", { path: "broken-link" }, root), {
    decision: "deny", reason: "unresolvable-path"
  });
});

test("sensitive paths require review even when lexically project-local", async () => {
  const { project } = await fixture();
  await writeFile(join(project, ".env"), "TOKEN=not-for-policy");
  const result = await evaluatePathPolicy("read", { path: ".env" }, project);
  assert.equal(result?.decision, "review");
  assert.equal(result?.reason, "sensitive-path");
  assert.equal((await evaluatePathPolicy("read", { path: "~/.ssh/id_ed25519" }, project))?.decision, "review");
});

test("Auto deterministic policy allows ordinary local reads/edits and denies malformed or unsupported requests", async () => {
  const { project } = await fixture();
  assert.equal((await evaluateAutoPolicy("read", { path: "README.md" }, project)).decision, "allow");
  assert.equal((await evaluateAutoPolicy("write", { path: "new.ts", content: "fixture" }, project)).decision, "allow");
  assert.equal((await evaluateAutoPolicy("edit", { path: "new.ts", edits: [{ oldText: "a", newText: "b" }] }, project)).decision, "allow");
  assert.equal((await evaluateAutoPolicy("write", { path: "../outside/new.ts", content: "fixture" }, project)).decision, "review");
  assert.deepEqual(await evaluateAutoPolicy("read", { path: "../outside" }, project), {
    decision: "review", source: "policy", reason: "outside-project",
    pathPolicy: await evaluatePathPolicy("read", { path: "../outside" }, project)
  });
  assert.equal((await evaluateAutoPolicy("read", { path: ".env" }, project)).decision, "deny");
  assert.equal((await evaluateAutoPolicy("bash", { command: "pwd" }, project)).decision, "allow");
  assert.equal((await evaluateAutoPolicy("bash", { command: "git diff --stat" }, project)).decision, "review");
  assert.equal((await evaluateAutoPolicy("bash", null, project)).decision, "deny");
  assert.equal((await evaluateAutoPolicy("unknown", {}, project)).decision, "deny");
  assert.equal((await evaluateAutoPolicy("read", { path: 12 }, project)).reason, "malformed-path");
});

test("Auto does not send deterministic sensitive-path denials to the classifier", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "piexis-auto-"));
  await mkdir(join(cwd, ".pi"));
  await writeFile(join(cwd, ".pi", "permission-modes.json"), JSON.stringify({
    version: 1, initialized: true,
    classifier: { provider: "test", model: "classifier", timeoutMs: 1000 }
  }));
  const handlers = new Map();
  let classifierCalls = 0;
  modeExtension({
    registerFlag() {}, registerTool() {}, registerCommand() {}, registerShortcut() {},
    on(name, handler) { handlers.set(name, handler); }, appendEntry() {},
    getFlag(name) { return name === "permission-mode" ? "auto" : false; }, events: { emit() {} }
  });
  const ctx = {
    cwd, hasUI: false, mode: "json", model: undefined,
    modelRegistry: {
      find() { return { provider: "test", id: "classifier" }; },
      hasConfiguredAuth() { return true; },
      async complete() { classifierCalls++; throw new Error("must not run"); }
    },
    sessionManager: { getBranch() { return []; } }
  };
  await handlers.get("session_start")({ reason: "startup" }, ctx);
  const outcome = await handlers.get("tool_call")({ toolName: "read", input: { path: ".env" } }, ctx);
  assert.match(outcome.reason, /sensitive-path/);
  assert.equal(classifierCalls, 0);
});

test("classifier payload excludes file contents and conversation data", () => {
  assert.deepEqual(classifierAction("write", { path: ".env", content: "API_KEY=secret", environment: { TOKEN: "secret" } }), {
    tool: "write", input: { path: ".env" }
  });
  assert.deepEqual(classifierAction("edit", { path: "src/a.ts", oldText: "secret", newText: "other secret" }), {
    tool: "edit", input: { path: "src/a.ts" }
  });
  assert.deepEqual(classifierAction("bash", { command: "git status", env: { TOKEN: "secret" } }), {
    tool: "bash", input: { command: "git status" }
  });
});

test("missing project configuration uses defaults without creating .pi", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "piexis-config-"));
  assert.deepEqual(await readProjectPermissionConfig(cwd), { version: 1, initialized: true });
  await assert.rejects(readdir(join(cwd, ".pi")));
});

test("session approval labels make whole-tool Bash access explicit", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "piexis-mode-"));
  const handlers = new Map();
  modeExtension({
    registerFlag() {}, registerTool() {}, registerCommand() {}, registerShortcut() {},
    on(name, handler) { handlers.set(name, handler); }, appendEntry() {}, getFlag() {}, events: { emit() {} }
  });
  let options = [];
  const outcome = await handlers.get("tool_call")({ toolName: "bash", input: { command: "git status" } }, {
    cwd, hasUI: true,
    ui: { select: async (_title, nextOptions) => { options = nextOptions; return "Deny"; } }
  });
  assert.deepEqual(options, [
    "Allow once: bash",
    "Allow ALL bash actions for this session",
    "Deny"
  ]);
  assert.equal(outcome.block, true);
  assert.match(outcome.reason, /Blocked by user/);
});

test("Bash metacharacters, command substitution, and assignments do not receive reusable grants", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "piexis-mode-"));
  const handlers = new Map();
  modeExtension({
    registerFlag() {}, registerTool() {}, registerCommand() {}, registerShortcut() {},
    on(name, handler) { handlers.set(name, handler); }, appendEntry() {}, getFlag() {}, events: { emit() {} }
  });
  for (const command of [
    "git status && rm -rf something", "git status; another-command", "sh -c \"echo x\"",
    "bash -c \"echo x\"", "$(whoami)", "`whoami`", "VAR=value command", "command > file", "command | other-command"
  ]) {
    let options = [];
    await handlers.get("tool_call")({ toolName: "bash", input: { command } }, {
      cwd, hasUI: true,
      ui: { select: async (_title, nextOptions) => { options = nextOptions; return "Allow once: bash"; } }
    });
    assert.equal(options.some((option) => option.startsWith("Allow executable")), false, command);
    assert.equal(options.some((option) => option.includes("in this directory")), false, command);
  }
});
