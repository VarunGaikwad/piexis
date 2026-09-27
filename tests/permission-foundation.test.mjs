import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import modeExtension from "../extensions/mode.ts";
import { evaluatePermission } from "../lib/mode-policy.ts";
import { evaluatePathPolicy } from "../lib/path-policy.ts";

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "piexis-foundation-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = join(dir, "repo");
  const cwd = join(root, "src");
  await mkdir(cwd, { recursive: true });
  await mkdir(join(dir, "outside"));
  await writeFile(join(root, ".git"), "fixture");
  await writeFile(join(cwd, "a.ts"), "export const a = 1;");
  const decide = (mode, tool, input, approvals = []) => evaluatePermission({
    mode, tool, input, cwd, workspaceRoot: root,
    authorization: { approvals }, actor: { kind: "foreground" }
  });
  return { dir, root, cwd, decide };
}

test("policy resolves relative and omitted paths against actual cwd, not repository root", async (t) => {
  const { root, cwd } = await fixture(t);
  assert.equal((await evaluatePathPolicy("read", { path: "a.ts" }, root, cwd)).path, join(cwd, "a.ts"));
  assert.equal((await evaluatePathPolicy("write", { path: "new/file.ts" }, root, cwd)).path, join(cwd, "new/file.ts"));
  for (const tool of ["grep", "find", "glob", "ls"]) {
    const result = await evaluatePathPolicy(tool, {}, root, cwd);
    assert.equal(result.path, cwd);
    assert.equal(result.decision, "allow");
  }
});

test("requested and resolved sensitive names are both checked, including Pi path spellings", async (t) => {
  const { root, cwd } = await fixture(t);
  await symlink(join(cwd, "a.ts"), join(cwd, ".env"));
  for (const path of [".env", "@.env", pathToFileURL(join(cwd, ".env")).href]) {
    const result = await evaluatePathPolicy("read", { path }, root, cwd);
    assert.equal(result.reason, "sensitive-path", path);
  }
  await writeFile(join(cwd, ".env.secret"), "fixture");
  await symlink(join(cwd, ".env.secret"), join(cwd, "alias"));
  assert.equal((await evaluatePathPolicy("read", { path: "alias" }, root, cwd)).reason, "sensitive-path");
  await mkdir(join(root, ".pi"));
  await symlink(join(cwd, "a.ts"), join(root, ".pi", "settings.json"));
  assert.equal((await evaluatePathPolicy("write", { path: "../.pi/settings.json" }, root, cwd)).reason, "protected-config");
});

test("read fallback spellings are canonicalized before approval", async (t) => {
  const { root, cwd, dir } = await fixture(t);
  await writeFile(join(dir, "outside", "file"), "fixture");
  await symlink(join(dir, "outside", "file"), join(cwd, "capture\u2019s.png"));
  assert.equal((await evaluatePathPolicy("read", { path: "capture's.png" }, root, cwd)).reason, "outside-project");
});

test("recursive reads require approval for sensitive descendants, symlinks, and external trees", async (t) => {
  const { root, cwd, decide } = await fixture(t);
  await mkdir(join(cwd, "nested"));
  await writeFile(join(cwd, "nested", ".env"), "fixture");
  for (const tool of ["grep", "find", "glob"]) {
    const args = { path: ".", pattern: "anything" };
    assert.equal((await decide("default", tool, args)).reason, "recursive-boundary");
    assert.equal((await decide("auto", tool, args)).decision, "deny");
    assert.equal((await decide("plan", tool, args)).decision, "deny");
    assert.equal((await decide("default", tool, { path: "nested/.env" }, [
      { tool, scope: "file", path: join(cwd, "nested", ".env") }
    ])).decision, "require-approval");
    for (const approval of [{ tool, scope: "tool" }, { tool, scope: "file", path: cwd }, { tool, scope: "project" }]) {
      assert.equal((await decide("default", tool, args, [approval])).decision, "require-approval");
    }
  }
  await rm(join(cwd, "nested", ".env"));
  assert.equal((await decide("auto", "grep", { path: "." })).decision, "allow");
  await symlink(root, join(cwd, "nested", "loop"));
  assert.equal((await decide("auto", "grep", { path: "." })).reason, "recursive-boundary");
  assert.equal((await decide("auto", "grep", { path: "../../outside" })).decision, "deny");
});

test("recursive budget exhaustion fails closed", async (t) => {
  const { cwd, decide } = await fixture(t);
  await Promise.all(Array.from({ length: 2001 }, (_, i) => writeFile(join(cwd, `file-${i}`), "")));
  assert.equal((await decide("auto", "find", { path: ".", pattern: "*" })).reason, "recursive-boundary");
});

test("mode matrix includes Auto local edits and preserves other mode defaults", async (t) => {
  const { decide } = await fixture(t);
  const expected = {
    default: ["allow", "require-approval", "require-approval"],
    acceptEdits: ["allow", "allow", "require-approval"],
    plan: ["allow", "deny", "deny"],
    auto: ["allow", "allow", "require-model-review"],
    dontAsk: ["allow", "deny", "deny"],
    bypassPermissions: ["allow", "allow", "allow"]
  };
  for (const [mode, decisions] of Object.entries(expected)) {
    for (const [i, [tool, input]] of [["read", { path: "a.ts" }], ["edit", { path: "a.ts" }], ["bash", { command: "git diff --stat" }]].entries()) {
      assert.equal((await decide(mode, tool, input)).decision, decisions[i], `${mode}/${tool}`);
    }
    assert.equal((await decide(mode, "AskQuestion", {})).decision, "allow");
  }
  assert.equal((await decide("default", "bash", {})).reason, "malformed-input");
  assert.equal((await decide("auto", "unknown", {})).reason, "unsupported-tool");
  assert.equal((await decide("acceptEdits", "write", { path: 42 })).decision, "deny");
});

test("configuration writes and credentials cannot inherit broad session grants", async (t) => {
  const { root, cwd, decide } = await fixture(t);
  await rm(join(root, ".git"));
  await mkdir(join(root, ".git"));
  for (const path of ["../.pi/permission-modes.json", "../.pi/settings.json", "../.pi/extensions/new.ts", "../.git/config", ".env.example"]) {
    for (const scope of ["project", "tool", "directory"]) {
      const result = await decide("acceptEdits", "write", { path }, [{ tool: "write", scope, path: root }]);
      assert.equal(result.decision, "require-approval", `${scope}/${path}`);
    }
  }
  assert.equal((await decide("acceptEdits", "write", { path: "../.git/config" })).pathPolicy.category, "git-internals");
  assert.equal((await decide("auto", "write", { path: "../.pi/settings.json" })).decision, "deny");
  const exact = [{ tool: "read", scope: "file", path: join(cwd, ".env.example") }];
  assert.equal((await decide("default", "read", { path: ".env.example" }, exact)).decision, "allow");
  assert.equal((await decide("default", "read", { path: ".env.production" }, exact)).decision, "require-approval");
});

function harness(mode, cwd, select) {
  const handlers = new Map();
  modeExtension({
    registerFlag() {}, registerCommand() {}, registerShortcut() {}, appendEntry() {},
    events: { emit() {} }, getFlag(name) { return name === "permission-mode" ? mode : false; },
    on(name, handler) { handlers.set(name, handler); }
  });
  const ctx = {
    cwd, hasUI: Boolean(select), mode: "json",
    modelRegistry: {}, sessionManager: { getBranch() { return []; } },
    ui: { select, setStatus() {} }
  };
  return { handlers, ctx };
}

test("extension keeps ordinary edits automatic but requires scoped config approval", async (t) => {
  const { cwd } = await fixture(t);
  const prompts = [];
  const { handlers, ctx } = harness("acceptEdits", cwd, async (title, choices) => {
    prompts.push({ title, choices });
    return "Allow this file for this session";
  });
  await handlers.get("session_start")({ reason: "startup" }, ctx);
  const call = (path) => handlers.get("tool_call")({ toolName: "write", input: { path, content: "fixture" } }, ctx);
  assert.equal(await call("new.ts"), undefined);
  assert.equal(prompts.length, 0);
  assert.equal(await call("../.pi/permission-modes.json"), undefined);
  assert.match(prompts[0].title, /protected-config/);
  assert.deepEqual(prompts[0].choices, ["Allow once: write", "Allow this file for this session", "Deny"]);
  assert.equal(await call("../.pi/permission-modes.json"), undefined);
  assert.equal(prompts.length, 1);
  assert.equal(await call("../.pi/settings.json"), undefined);
  assert.equal(prompts.length, 2);
});

test("Auto never sends protected configuration or uncertain recursive searches to the classifier", async (t) => {
  const { root, cwd } = await fixture(t);
  await mkdir(join(cwd, ".pi"));
  await writeFile(join(cwd, ".pi", "permission-modes.json"), JSON.stringify({
    version: 1, initialized: true,
    classifier: { provider: "test", model: "classifier", timeoutMs: 1000 }
  }));
  await writeFile(join(cwd, ".env"), "fixture");
  const { handlers, ctx } = harness("auto", cwd);
  let calls = 0;
  ctx.modelRegistry = {
    find() { return { provider: "test", id: "classifier" }; },
    hasConfiguredAuth() { return true; },
    async complete() { calls++; throw new Error("must not run"); }
  };
  await handlers.get("session_start")({ reason: "startup" }, ctx);
  for (const event of [
    { toolName: "write", input: { path: join(root, ".pi", "settings.json"), content: "fixture" } },
    { toolName: "grep", input: { path: ".", pattern: "fixture" } }
  ]) {
    assert.equal((await handlers.get("tool_call")(event, ctx)).block, true);
  }
  assert.equal(calls, 0);
});

test("headless approval requirements fail closed", async (t) => {
  const { cwd } = await fixture(t);
  const { handlers, ctx } = harness("acceptEdits", cwd);
  await handlers.get("session_start")({ reason: "startup" }, ctx);
  const result = await handlers.get("tool_call")({ toolName: "write", input: { path: "../.pi/settings.json", content: "fixture" } }, ctx);
  assert.equal(result.block, true);
  assert.match(result.reason, /no permission UI/);
});
