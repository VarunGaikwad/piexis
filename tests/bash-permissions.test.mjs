import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { analyzeBash, parseBash } from "../lib/bash-policy.ts";
import { bashApprovalFingerprint } from "../lib/bash-approvals.ts";
import { evaluatePermission } from "../lib/mode-policy.ts";
import { DenialTracker, denialLimit } from "../lib/permission-denials.ts";
import modeExtension from "../extensions/mode.ts";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "piexis-bash-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const dir of [".git", ".pi", "bin", "nested", "home"]) await mkdir(join(root, dir));
  await writeFile(join(root, ".git", "config"), "[core]\n bare = false\n");
  await writeFile(join(root, "global.gitconfig"), "[user]\n name = Fixture\n");
  // Synthetic executable header for fingerprint tests. Never execute this file.
  await writeFile(join(root, "bin", "git"), Buffer.from("7f454c4666697874757265", "hex"), { mode: 0o755 });
  const env = { PATH: join(root, "bin"), HOME: join(root, "home"), GIT_CONFIG_GLOBAL: join(root, "global.gitconfig"), GIT_CONFIG_NOSYSTEM: "1" };
  return { root, env };
}

function isolatedEnvironment(t, env) {
  const keys = new Set([...Object.keys(process.env).filter((key) => /^(BASH|GIT_|ENV$|SHELLOPTS$|PS4$)/.test(key)), ...Object.keys(env)]);
  const saved = new Map([...keys].map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  Object.assign(process.env, env);
  t.after(() => { for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}

test("literal shell parser recognizes quotes, chains, pipes, redirects, assignments, and risk findings", () => {
  const parsed = parseBash("MODE=test env node 'script with spaces.js' && cd nested; cat a.txt | tee result.txt >> log.txt");
  assert.equal(parsed.status, "parsed");
  assert.deepEqual(parsed.operators, ["&&", ";", "|"]);
  assert.deepEqual(parsed.commands[0].argv, ["env", "node", "script with spaces.js"]);
  assert.deepEqual(parsed.commands[0].assignments, ["MODE=test"]);
  assert.deepEqual(parsed.commands.at(-1).redirects, [{ operator: ">>", target: "log.txt" }]);
  for (const finding of ["environment-assignment", "execution-wrapper", "working-directory-change", "pipeline", "redirection"]) assert.ok(parsed.findings.includes(finding));
  assert.equal(parsed.safe, false);
  assert.equal(parsed.grantFamily, undefined);
  for (const [command, finding] of [
    ["git reset --hard HEAD", "destructive-action"], ["git push --force", "shared-system-change"],
    ["git commit --no-verify", "safeguard-bypass"], ["curl --insecure https://example.invalid", "network-or-data-egress"],
    ["npm test", "script-or-interpreter"], ["python script.py", "script-or-interpreter"],
    ["sudo command", "privilege-change"]
  ]) assert.ok(parseBash(command).findings.includes(finding), command);
});

test("only tiny literal builtins are automatic; expansions and unsupported syntax never widen grants", () => {
  for (const command of ["pwd", "pwd -P", "pwd -L", "true", "false", "'pwd'", "pwd # harmless comment"]) assert.equal(parseBash(command).safe, true, command);
  for (const command of [
    "pwd; rm -rf x", "pwd && true", "pwd > file", "pwd $(touch file)", "pwd `touch file`", "pwd $VAR",
    "pwd *", "pwd ${VAR}", "(pwd)", "{ pwd; }", "if true; then pwd; fi", "pwd &", "pwd 2> file",
    "pwd <<< text", "pwd <<EOF\ntext\nEOF", "pwd |& cat", "pwd &&", "pwd \\", "pwd 'unfinished",
    "pwd\0", "pwd\r", "pwd\r; true", "pwd; A=B", "A=B pwd", "bash -c 'pwd'", "npm test", "make", "git -c core.fsmonitor=evil status",
    "git status; pwd", "env git status", "git status --unknown", "git status --short path", "git $SUBCOMMAND"
  ]) {
    const parsed = parseBash(command);
    assert.equal(parsed.safe, false, command);
    assert.equal(parsed.grantFamily, undefined, command);
  }
  assert.equal(parseBash("echo $(touch file)").status, "unsupported");
  assert.equal(parseBash("echo '$(touch file)'").status, "parsed");
  assert.equal(parseBash("pwd ".repeat(4000)).status, "unsupported");
  assert.equal(parseBash(Array(34).fill("pwd").join(";")).status, "unsupported");
  assert.equal(parseBash("git status --short").grantFamily, "git-status");
});

test("literal filesystem targets are checked, including aliases and protected output redirection", async (t) => {
  const { root } = await fixture(t);
  await writeFile(join(root, ".env"), "disposable fixture");
  await symlink(join(root, ".env"), join(root, "alias"));
  for (const command of ["cat .env", "cat alias", "touch .pi/settings.json", "echo text > .git/config"]) {
    const analysis = await analyzeBash(command, root, root);
    assert.ok(analysis.blockedReason, command);
    const outcome = await evaluatePermission({ mode: "auto", tool: "bash", input: { command }, cwd: root, workspaceRoot: root,
      authorization: { approvals: [{ tool: "bash", scope: "tool" }] } });
    assert.equal(outcome.decision, "deny", command);
  }
  assert.equal((await analyzeBash("echo '.env'", root, root)).blockedReason, undefined);
  assert.ok((await analyzeBash("cat ../ordinary.txt", root, root)).findings.includes("external-filesystem-target"));
  assert.equal((await evaluatePermission({ mode: "plan", tool: "bash", input: { command: "pwd" }, cwd: root, workspaceRoot: root })).decision, "deny");
});

test("execution fingerprints bind cwd, executable, configuration, and environment, without executing anything", async (t) => {
  const { root, env } = await fixture(t);
  const fingerprint = () => bashApprovalFingerprint("git status", root, root, env);
  const initial = await fingerprint();
  assert.match(initial, /^[a-f0-9]{64}$/);
  assert.equal(await bashApprovalFingerprint("git status --short", root, root, env), initial);
  assert.notEqual(await bashApprovalFingerprint("git status", join(root, "nested"), root, env), initial);
  await writeFile(join(root, ".pi", "permission-modes.json"), "{}");
  assert.notEqual(await fingerprint(), initial);
  const beforeExecutable = await fingerprint();
  await writeFile(join(root, "bin", "git"), Buffer.from("7f454c466368616e676564", "hex"), { mode: 0o755 });
  assert.notEqual(await fingerprint(), beforeExecutable);
  await writeFile(join(root, ".git", "config"), "[core]\n fsmonitor = run-a-script\n");
  assert.equal(await fingerprint(), undefined);
  await writeFile(join(root, ".git", "config"), "[include]\n path = other-config\n");
  assert.equal(await fingerprint(), undefined);
  await writeFile(join(root, ".git", "config"), "[core]\n bare = false\n");
  assert.equal(await bashApprovalFingerprint("npm test", root, root, env), undefined);
  assert.equal(await bashApprovalFingerprint("git status", root, root, { ...env, BASH_ENV: "startup.sh" }), undefined);
  assert.equal(await bashApprovalFingerprint("git status", root, root, { ...env, GIT_CONFIG_COUNT: "1" }), undefined);
  assert.equal(await bashApprovalFingerprint("git status", root, root, { ...env, GIT_CONFIG_GLOBAL: "relative" }), undefined);
  await writeFile(join(root, ".git", "commondir"), "../../other");
  assert.equal(await fingerprint(), undefined);
  await rm(join(root, ".git", "commondir"));
  await mkdir(join(root, "nested", ".git"));
  assert.equal(await bashApprovalFingerprint("git status", join(root, "nested"), root, env), undefined);
});

test("Auto honors fresh exact/subcommand grants, not broad grants, edited configs, or a different cwd", async (t) => {
  const { root, env } = await fixture(t);
  isolatedEnvironment(t, env);
  const fingerprint = await bashApprovalFingerprint("git status", root, root);
  assert.ok(fingerprint);
  const exact = { tool: "bash", scope: "command", command: "git status", cwd: root, fingerprint };
  const query = { tool: "bash", scope: "subcommand", family: "git-status", cwd: root, fingerprint };
  const decide = (command, approvals, cwd = root) => evaluatePermission({ mode: "auto", tool: "bash", input: { command }, cwd, workspaceRoot: root, authorization: { approvals } });
  assert.equal((await decide("git status", [exact])).decision, "allow");
  assert.equal((await decide("git status --short", [exact])).decision, "require-model-review");
  assert.equal((await decide("git status --short", [query])).decision, "allow");
  assert.equal((await decide("git status", [exact], join(root, "nested"))).decision, "require-model-review");
  for (const grant of [{ tool: "bash", scope: "tool" }, { tool: "bash", scope: "executable", executable: "git" }])
    assert.equal((await decide("git status", [grant])).decision, "require-model-review");
  await writeFile(join(root, "global.gitconfig"), "[user]\n name = Changed\n");
  assert.equal((await decide("git status", [exact])).decision, "require-model-review");
  assert.equal((await decide("git status && touch x", [query])).decision, "require-model-review");
  const fileGrant = { tool: "write", scope: "file", path: join(root, "..", "outside.txt") };
  assert.equal((await evaluatePermission({ mode: "auto", tool: "write", input: { path: "../outside.txt", content: "fixture" }, cwd: root, workspaceRoot: root, authorization: { approvals: [fileGrant] } })).decision, "allow");
});

test("shell startup overrides disable even the builtin fast path", async (t) => {
  const { root, env } = await fixture(t);
  isolatedEnvironment(t, { ...env, BASH_ENV: join(root, "not-executed.sh") });
  assert.equal((await analyzeBash("pwd", root, root)).safe, false);
});

test("denial budgets count repeated and varied actions, remain latched, and validate launch limits", () => {
  for (const value of ["0", "51", "NaN", "1.2", "-1"]) assert.throws(() => denialLimit(value, 6));
  assert.equal(denialLimit("4", 6), 4);
  assert.equal(denialLimit(undefined, 6), 6);
  const tracker = new DenialTracker({ repeated: 2, total: 3 });
  assert.equal(tracker.deny("bash", { command: "a" }).stopped, false);
  assert.equal(tracker.deny("bash", { command: "a" }).stopped, true);
  tracker.reset();
  for (const command of ["a", "b", "c"]) tracker.deny("bash", { command });
  assert.equal(tracker.stopped, true);
  assert.equal(tracker.total, 3);
  tracker.deny("write", { path: "different" });
  assert.equal(tracker.total, 3);
});

async function harness(t, hasUI = true) {
  const { root, env } = await fixture(t);
  isolatedEnvironment(t, env);
  await writeFile(join(root, ".pi", "permission-modes.json"), JSON.stringify({ version: 1, initialized: true, classifier: { provider: "test", model: "reviewer", timeoutMs: 1000 } }));
  const events = new Map();
  const commands = new Map();
  const shortcuts = new Map();
  const entries = [];
  let choice = "Deny";
  let aborts = 0;
  let modelCalls = 0;
  let options = [];
  let notification = "";
  const flags = { "permission-mode": "default", "permission-repeat-limit": "2", "permission-denial-limit": "3" };
  modeExtension({
    registerFlag() {}, getFlag: (name) => flags[name],
    registerCommand(name, command) { commands.set(name, command); },
    registerShortcut(name, shortcut) { shortcuts.set(name, shortcut.handler); },
    on(name, handler) { events.set(name, handler); }, events: { emit() {} },
    appendEntry(customType, data) { entries.push({ type: "custom", id: `e${entries.length}`, customType, data }); }
  });
  const ctx = { cwd: root, hasUI, mode: "json", isIdle: () => true,
    abort() { aborts++; },
    ui: { setStatus() {}, notify(text) { notification = text; }, async select(_title, choices) { options = choices; return choice; } },
    sessionManager: { getBranch: () => entries },
    modelRegistry: { find: () => ({ provider: "test", id: "reviewer" }), hasConfiguredAuth: () => true,
      async complete() { modelCalls++; throw new Error("mock model unavailable"); } }
  };
  await events.get("session_start")({ reason: "startup" }, ctx);
  const input = async (text = "Inspect status.", source = "interactive") => {
    await events.get("input")({ text, source }, ctx);
    const message = { role: "user", content: text, timestamp: entries.length + 1 };
    await events.get("message_end")({ message }, ctx);
    entries.push({ type: "message", id: `u${entries.length}`, message });
  };
  await input();
  return { root, ctx, input, entries, events, commands,
    call: (toolName, input) => events.get("tool_call")({ toolName, input }, ctx),
    cycle: () => shortcuts.get("alt+m")(ctx),
    set choice(value) { choice = value; }, get aborts() { return aborts; }, get modelCalls() { return modelCalls; },
    get options() { return options; }, get notification() { return notification; }
  };
}

test("permission UI creates cwd-bound grants, /permissions lists and revokes them, and Auto respects revocation", async (t) => {
  const h = await harness(t);
  h.choice = "Allow this exact Bash command in this directory for this session";
  assert.equal(await h.call("bash", { command: "git status" }), undefined);
  assert.ok(h.options.includes("Allow Git status queries in this directory for this session"));
  await h.commands.get("permissions").handler("list", h.ctx);
  assert.match(h.notification, /"id":"1"/);
  assert.match(h.notification, /"cwd":/);
  assert.doesNotMatch(h.notification, /fingerprint/);
  for (let i = 0; i < 3; i++) await h.cycle();
  assert.equal(await h.call("bash", { command: "git status" }), undefined);
  assert.equal(h.modelCalls, 0);
  await h.commands.get("permissions").handler("revoke 1", h.ctx);
  assert.equal((await h.call("bash", { command: "git status" })).block, true);
  assert.equal(h.modelCalls, 1);
  await assert.rejects(h.commands.get("permissions").handler("revoke 1", h.ctx), /Unknown/);
  await assert.rejects(h.commands.get("permissions").handler("clear", { ...h.ctx, isIdle: () => false }), /idle/);
  await h.commands.get("permissions").handler("clear", h.ctx);
  assert.match(h.notification, /No session grants/);
});

test("opaque scripts offer no reusable narrow grant; one-time approval never survives another call", async (t) => {
  const h = await harness(t);
  h.choice = "Allow once: bash";
  assert.equal(await h.call("bash", { command: "npm test" }), undefined);
  assert.equal(h.options.some((option) => option.includes("in this directory")), false);
  h.choice = "Deny";
  assert.equal((await h.call("bash", { command: "npm test" })).block, true);
  await h.commands.get("permissions").handler("list", h.ctx);
  assert.match(h.notification, /No session grants/);
});

test("denial thresholds stop the run, block later and parallel-safe calls, preserve AskQuestion, and reset only for user input", async (t) => {
  const h = await harness(t);
  const call = () => h.call("bash", { command: "npm test" });
  assert.match((await call()).reason, /genuinely narrower/);
  assert.match((await call()).reason, /run is stopped/);
  assert.ok(h.aborts > 0);
  assert.equal((await h.call("write", { path: "new.ts", content: "fixture" })).block, true);
  assert.equal(await h.call("AskQuestion", {}), undefined);
  await h.input("Keep trying", "extension");
  assert.equal((await h.call("bash", { command: "pwd" })).block, true);
  await h.input("Inspect cwd only.");
  assert.equal(await h.call("bash", { command: "pwd" }), undefined);
  assert.equal(h.entries.filter((entry) => entry.customType === "piexis-permission-stop").length, 1);
});

test("an in-flight sibling approval cannot execute or create a grant after the run stops", { timeout: 5000 }, async (t) => {
  const h = await harness(t);
  let release;
  h.ctx.ui.select = async (title) => {
    if (title.includes("git status")) return new Promise((resolve) => { release = resolve; });
    return "Deny";
  };
  const pending = h.call("bash", { command: "git status" });
  while (!release) await new Promise(setImmediate);
  await h.call("bash", { command: "npm test" });
  await h.call("bash", { command: "npm test" });
  release("Allow this exact Bash command in this directory for this session");
  assert.equal((await pending).block, true);
  await h.commands.get("permissions").handler("list", h.ctx);
  assert.match(h.notification, /No session grants/);
});

test("headless denials never prompt and emit a machine-identifiable stop on stderr", async (t) => {
  const h = await harness(t, false);
  const output = [];
  const original = process.stderr.write;
  process.stderr.write = (chunk) => { output.push(String(chunk)); return true; };
  try {
    assert.match((await h.call("bash", { command: "npm test" })).reason, /no permission UI/);
    assert.match((await h.call("bash", { command: "npm test" })).reason, /run is stopped/);
  } finally { process.stderr.write = original; }
  assert.match(output.join(""), /permission_blocked/);
  assert.equal(h.options.length, 0);
  assert.ok(h.aborts > 0);
});
