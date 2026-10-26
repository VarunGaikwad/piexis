import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import extension from "../extensions/code-health.ts";
import { piInvocation } from "../lib/subagent-runner.ts";
import { loadAgentConfig, parseAgentConfig } from "../lib/agents.ts";
import { resolveCodeHealth } from "../lib/code-health-config.ts";
import { CodeHealthGuardian, healthReviewContext } from "../lib/code-health.ts";
import { discoverHealthFiles, isCleanHealthPath, readHealthSource } from "../lib/code-health-files.ts";

const config = (settings = {}) => resolveCodeHealth({ enableAiReview: false, ...settings });
function git(cwd, ...args) {
  return execFileSync("git", ["-c", "user.name=Health Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
}
async function fixture(work) {
  const cwd = await mkdtemp(join(tmpdir(), "piexis-guardian-"));
  const env = { PATH: process.env.PATH, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PIEXIS_SUBAGENT_DEPTH: process.env.PIEXIS_SUBAGENT_DEPTH };
  try {
    git(cwd, "init", "-q");
    await writeFile(join(cwd, "main.py"), "x = 0\n");
    await writeFile(join(cwd, "other.py"), "other = 0\n");
    git(cwd, "add", "."); git(cwd, "commit", "-qm", "initial");
    await mkdir(join(cwd, ".pi"));
    const agentDir = join(cwd, "agent-dir"); await mkdir(agentDir);
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.PIEXIS_SUBAGENT_DEPTH = "0";
    await work({ cwd, agentDir });
  } finally {
    for (const [key, value] of Object.entries(env)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(cwd, { recursive: true, force: true });
  }
}
async function fakeRuff(cwd, validationFails = false) {
  const bin = join(cwd, "bin"); await mkdir(bin, { recursive: true });
  const file = join(bin, "ruff");
  await writeFile(file, `#!${process.execPath}\nlet input=''; for await (const part of process.stdin) input+=part;\nconst args=process.argv.slice(2);\nif (!args.includes('--isolated') || !args.includes('--no-cache')) process.exit(2);\nif(args[0]==='format')process.stdout.write(input.replace(/x=1/g,'x = 1'));\nelse {process.stdout.write('[]');${validationFails ? "if(args.includes('E9,F63,F7,F82'))process.exitCode=1;" : ""}}\n`);
  await chmod(file, 0o755);
  process.env.PATH = `${bin}:${process.env.PATH}`;
}
async function own(guardian, cwd, settings, path = "main.py", text = "x=1\n") {
  await guardian.beforeEdit("edit", path, settings);
  await writeFile(join(cwd, path), text);
  await guardian.afterEdit("edit", false, settings);
}
function harness(cwd) {
  const handlers = new Map(); const commands = new Map(); const notifications = []; const entries = []; const requests = [];
  let idle = true;
  const ctx = {
    cwd, mode: "json", signal: undefined, model: { provider: "test", id: "user-model" },
    isIdle: () => idle, hasPendingMessages: () => false, isProjectTrusted: () => true,
    ui: { notify: (text) => notifications.push(text), setStatus() {} },
    modelRegistry: { complete: async (model, context, options) => {
      requests.push({ model, context, options });
      return { stopReason: "stop", content: [{ type: "text", text: "Proposal: review cohesion, then run focused tests." }], usage: { input: 100, output: 20 } };
    } },
  };
  extension({ on: (name, handler) => handlers.set(name, handler), registerCommand: (name, command) => commands.set(name, command), appendEntry: (type, data) => entries.push({ type, data }) });
  return { ctx, handlers, commands, notifications, entries, requests, setIdle(value) { idle = value; },
    emit: (name, event = {}) => handlers.get(name)?.(event, ctx), command: (args) => commands.get("health").handler(args, ctx) };
}

test("configuration defaults, strict validation, schema parity, trusted field overrides and legacy fallback", async () => {
  assert.equal(config().mode, "safe"); assert.equal(config().enableRuff, false);
  assert.throws(() => parseAgentConfig({ codeHealth: { mode: "dangerous" } }));
  assert.throws(() => parseAgentConfig({ codeHealth: { maxFilesPerReview: 10000 } }));
  assert.throws(() => parseAgentConfig({ codeHealth: { unknown: true } }));
  assert.deepEqual(parseAgentConfig({}), {});
  const schema = JSON.parse(await readFile(new URL("../schemas/agent.schema.json", import.meta.url), "utf8"));
  assert.deepEqual(Object.keys(schema.properties.codeHealth.properties).sort(), Object.keys(config()).sort());
  await fixture(async ({ cwd, agentDir }) => {
    await writeFile(join(agentDir, "agents.json"), JSON.stringify({ codeHealth: { mode: "observe", maxFilesPerReview: 12, exclude: ["private/**"] } }));
    await writeFile(join(cwd, ".pi", "agent.json"), JSON.stringify({ codeHealth: { mode: "safe", enableRuff: true } }));
    const loaded = (await loadAgentConfig(cwd, agentDir, true)).codeHealth;
    assert.equal(loaded.mode, "safe"); assert.equal(loaded.maxFilesPerReview, 12); assert.deepEqual(loaded.exclude, ["private/**"]);
    assert.equal((await loadAgentConfig(cwd, agentDir, false)).codeHealth.mode, "observe");
  });
});

test("observe never modifies; safe and autonomous only format validated agent-owned Python snapshots", async () => {
  for (const mode of ["observe", "safe", "autonomous"]) await fixture(async ({ cwd }) => {
    await fakeRuff(cwd);
    const settings = config({ mode, enableRuff: true }); const guardian = new CodeHealthGuardian(cwd);
    await guardian.startTask(settings); await own(guardian, cwd, settings);
    const report = await guardian.review(settings, { fix: true, canWrite: () => true });
    assert.equal(await readFile(join(cwd, "main.py"), "utf8"), mode === "observe" ? "x=1\n" : "x = 1\n");
    assert.equal(report.applied.length, mode === "observe" ? 0 : 1);
    if (mode !== "observe") { assert.match(report.validation, /syntax diagnostics passed/); assert.ok(report.findings.some((f) => f.applied)); }
    assert.equal(await readFile(join(cwd, "other.py"), "utf8"), "other = 0\n");
  });
});

test("pre-existing, later user changes, unobserved shell changes and outside paths are never fixed", async () => {
  await fixture(async ({ cwd }) => {
    await fakeRuff(cwd); const settings = config({ enableRuff: true });
    await writeFile(join(cwd, "other.py"), "user = 7\n");
    const guardian = new CodeHealthGuardian(cwd); await guardian.startTask(settings);
    await own(guardian, cwd, settings, "other.py");
    await writeFile(join(cwd, "main.py"), "x=1 # user\n");
    await own(guardian, cwd, settings); // A user edit after the baseline is also protected.
    await guardian.review(settings, { fix: true, canWrite: () => true });
    assert.equal(await readFile(join(cwd, "main.py"), "utf8"), "x=1\n");
    assert.equal(await readFile(join(cwd, "other.py"), "utf8"), "x=1\n");
    assert.equal(guardian.automaticFixes, 0);
    assert.equal(await readHealthSource(cwd, "../outside.py", []), undefined);
  });
});

test("snapshot mismatch, failed validation, missing analyzer, unavailable Git and write limits fail closed", async () => {
  await fixture(async ({ cwd }) => {
    const settings = config({ enableRuff: true, maxAutomaticFixesPerTask: 1 });
    const guardian = new CodeHealthGuardian(cwd); await guardian.startTask(settings); await own(guardian, cwd, settings);
    process.env.PATH = join(cwd, "missing");
    let report = await guardian.review(settings, { fix: true, canWrite: () => true });
    assert.equal(report.applied.length, 0);
    const withoutGit = new CodeHealthGuardian(cwd); await withoutGit.startTask(settings);
    assert.equal(withoutGit.baselineComplete, false);
    process.env.PATH = "/usr/bin:/bin";
    await fakeRuff(cwd, true);
    report = await guardian.review(settings, { fix: true, canWrite: () => true });
    assert.match(report.validation, /failed Ruff syntax/);
    assert.equal(await readFile(join(cwd, "main.py"), "utf8"), "x=1\n");
    await fakeRuff(cwd);
    await writeFile(join(cwd, "main.py"), "x=1 # editor\n");
    report = await guardian.review(settings, { fix: true, canWrite: () => true });
    assert.equal(report.applied.length, 0);
    git(cwd, "checkout", "--", "main.py"); // Fixture reset only; guardian never runs checkout.
    await guardian.startTask(settings); await own(guardian, cwd, settings);
    await own(guardian, cwd, settings, "other.py");
    report = await guardian.review(settings, { fix: true, canWrite: () => true });
    assert.equal(report.applied.length, 1);
    await guardian.review(settings, { fix: true, canWrite: () => true });
    assert.equal(guardian.automaticFixes, 1);
  });
});

test("without Git the checkpoint still analyzes observed paths but never permits fixes", async () => {
  await fixture(async ({ cwd }) => {
    await rm(join(cwd, ".git"), { recursive: true, force: true });
    const guardian = new CodeHealthGuardian(cwd); const settings = config();
    await guardian.startTask(settings);
    await own(guardian, cwd, settings, "main.py", "def work(a,b,c,d,e,f,g,h):\n    pass\n");
    const report = await guardian.review(settings, { fix: true, canWrite: () => true });
    assert.ok(report.findings.some((item) => item.category === "parameters"));
    assert.equal(report.sources[0].path, "main.py");
    assert.equal(guardian.baselineComplete, false); assert.equal(report.applied.length, 0);
  });
});

test("review re-entrancy and cancellation always release busy state", async () => {
  await fixture(async ({ cwd }) => {
    const guardian = new CodeHealthGuardian(cwd); const settings = config();
    await writeFile(join(cwd, "main.py"), "x=1\n");
    const promise = guardian.review(settings);
    assert.equal(guardian.busy, true);
    assert.equal(await guardian.review(settings), guardian.report);
    await promise; assert.equal(guardian.busy, false);
    await assert.rejects(guardian.review(settings, { signal: AbortSignal.abort() }), /abort/i);
    assert.equal(guardian.busy, false);
  });
});

test("extension observes edits but never fixes during tool batches or intermediate agent endings", async () => {
  await fixture(async ({ cwd }) => {
    await fakeRuff(cwd); await writeFile(join(cwd, ".pi", "agent.json"), JSON.stringify({ codeHealth: { enableRuff: true, enableAiReview: false } }));
    const h = harness(cwd); await h.emit("session_start"); await h.emit("before_agent_start");
    await h.emit("tool_execution_start", { toolCallId: "1", toolName: "edit" });
    await h.emit("tool_call", { toolCallId: "1", toolName: "edit", input: { path: join(cwd, "main.py") } });
    await writeFile(join(cwd, "main.py"), "x=1\n");
    await h.emit("tool_execution_end", { toolCallId: "1", toolName: "edit", isError: false });
    await h.emit("turn_end"); await h.emit("agent_end");
    assert.equal(await readFile(join(cwd, "main.py"), "utf8"), "x=1\n");
    await h.command("fix"); assert.match(h.notifications.at(-1), /idle task/);
    await h.emit("message_end", { message: { role: "assistant", stopReason: "stop" } });
    await h.emit("agent_settled", { aborted: false });
    assert.equal(await readFile(join(cwd, "main.py"), "utf8"), "x = 1\n");
    const count = h.notifications.length;
    await h.emit("agent_settled", { aborted: false });
    await h.emit("agent_settled", { aborted: false });
    assert.ok(h.notifications.length <= count + 1);
    await h.emit("session_shutdown");
  });
});

test("AI uses configured host model, bounded targeted context and one review per task without tools", async () => {
  await fixture(async ({ cwd }) => {
    await writeFile(join(cwd, ".pi", "agent.json"), JSON.stringify({ codeHealth: { enableAiReview: true } }));
    const h = harness(cwd); await h.emit("session_start"); await h.emit("before_agent_start");
    await writeFile(join(cwd, "main.py"), `api_key = 'not-a-real-secret'\ndef work(a,b,c,d,e,f,g,h):\n${"    work_step(a)\n".repeat(65)}`);
    await h.emit("agent_settled"); await h.emit("agent_settled");
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0].model.id, "user-model");
    assert.equal(h.requests[0].options.maxTokens, 1024);
    assert.equal(h.requests[0].context.tools, undefined);
    assert.ok(h.requests[0].context.messages[0].content[0].text.length <= 24000);
    assert.doesNotMatch(h.requests[0].context.messages[0].content[0].text, /not-a-real-secret/);
    assert.match(h.requests[0].context.systemPrompt, /UNTRUSTED DATA/);
    assert.equal(h.entries[0].type, "piexis-code-health-review");
    await h.command("explain"); assert.match(h.notifications.at(-1), /Proposal: review cohesion/);
    await h.command("status"); assert.match(h.notifications.at(-1), /proposal-only/);
    await h.emit("session_shutdown");
  });
});

test("abort, failed assistant, active tool batch and delegated child suppress completion work", async () => {
  await fixture(async ({ cwd }) => {
    const h = harness(cwd); await h.emit("session_start"); await h.emit("before_agent_start");
    await writeFile(join(cwd, "main.py"), `def work(a,b,c,d,e,f,g,h):\n${"    work_step(a)\n".repeat(65)}`);
    await h.emit("message_end", { message: { role: "assistant", stopReason: "error" } }); await h.emit("agent_settled");
    assert.equal(h.requests.length, 0);
    await h.emit("before_agent_start"); await h.emit("agent_settled", { aborted: true }); assert.equal(h.requests.length, 0);
    await h.emit("tool_execution_start", { toolCallId: "active" }); await h.emit("agent_settled"); assert.equal(h.requests.length, 0);
    await h.emit("session_shutdown");
    process.env.PIEXIS_SUBAGENT_DEPTH = "1";
    const child = harness(cwd); assert.equal(child.handlers.size, 0); assert.equal(child.commands.size, 0);
  });
});

test("manual cancellation stops AI and malformed config disables without leaking repository errors", async () => {
  await fixture(async ({ cwd }) => {
    const h = harness(cwd); await h.emit("session_start");
    await writeFile(join(cwd, "main.py"), "def work(a,b,c,d,e,f,g,h):\n    pass\n");
    let entered;
    const ready = new Promise((resolve) => { entered = resolve; });
    h.ctx.modelRegistry.complete = async (_model, _context, { signal }) => { entered(); return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true })); };
    const request = h.command("explain"); await ready; await h.command("cancel"); await request;
    assert.ok(h.notifications.some((text) => /cancelled/.test(text)));
    await writeFile(join(cwd, ".pi", "agent.json"), "secret invalid config"); await h.emit("session_start");
    assert.match(h.notifications.at(-1), /disabled/); assert.doesNotMatch(h.notifications.at(-1), /secret/);
    await h.emit("session_shutdown");
  });
});

test("Git discovery and ownership checks never invoke configured clean/process filters", async () => {
  await fixture(async ({ cwd }) => {
    const script = join(cwd, "filter.cjs");
    await writeFile(script, "require('node:fs').writeFileSync('filter-ran', 'unsafe'); process.stdin.pipe(process.stdout);");
    await writeFile(join(cwd, ".gitattributes"), "*.py filter=guardian-test\n");
    const command = `\"${process.execPath}\" \"${script}\"`;
    git(cwd, "config", "filter.guardian-test.clean", command);
    git(cwd, "config", "filter.guardian-test.process", command);
    git(cwd, "config", "filter.guardian-test.required", "true");
    await writeFile(join(cwd, "main.py"), "x=1\n");
    const selected = await discoverHealthFiles(cwd, { exclude: [], maxFiles: 30 });
    assert.ok(selected.paths.includes("main.py"));
    assert.equal(await isCleanHealthPath(cwd, "main.py"), false);
    await assert.rejects(readFile(join(cwd, "filter-ran")), { code: "ENOENT" });
  });
});

test("ownership status treats repository filenames as literal paths, never pathspec instructions", { skip: process.platform === "win32" }, async () => {
  await fixture(async ({ cwd }) => {
    const path = ":(exclude)*.py";
    await writeFile(join(cwd, path), "user = 1\n");
    assert.equal(await isCleanHealthPath(cwd, path), false);
  });
});

test("cancellation after a completed replacement retains its partial applied report", async () => {
  await fixture(async ({ cwd }) => {
    await fakeRuff(cwd); const settings = config({ enableRuff: true }); const guardian = new CodeHealthGuardian(cwd);
    await guardian.startTask(settings); await own(guardian, cwd, settings); await own(guardian, cwd, settings, "other.py");
    const controller = new AbortController();
    const replace = guardian.replaceOwned.bind(guardian);
    guardian.replaceOwned = async (...args) => { const changed = await replace(...args); if (changed) controller.abort(); return changed; };
    await assert.rejects(guardian.review(settings, { fix: true, canWrite: () => true, signal: controller.signal }), /abort/i);
    assert.deepEqual(guardian.report.applied, ["main.py"]);
    assert.equal(await readFile(join(cwd, "main.py"), "utf8"), "x = 1\n");
    assert.equal(guardian.busy, false);
  });
});

test("real offline Pi CLI loads guardian, observes native writes, formats only at settlement and reviews with the configured model", { timeout: 30000 }, async () => {
  await fixture(async ({ cwd, agentDir }) => {
    await fakeRuff(cwd);
    await writeFile(join(cwd, ".pi", "agent.json"), JSON.stringify({ codeHealth: { enableRuff: true, enableAiReview: true } }));
    const invocation = piInvocation();
    const args = [...invocation.args, "--offline", "--no-session", "--mode", "json", "--print", "--no-extensions", "--no-skills", "--no-context-files", "--no-prompt-templates", "--approve",
      "-e", fileURLToPath(new URL("../extensions/code-health.ts", import.meta.url)),
      "-e", fileURLToPath(new URL("./fixtures/code-health-provider.ts", import.meta.url)),
      "--model", "health-test/configured", "--tools", "write", "--", "Implement a bounded fixture"];
    const execution = promisify(execFile)(invocation.command, args, { cwd, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" }, timeout: 25000, maxBuffer: 4 * 1024 * 1024 });
    execution.child.stdin.end();
    const { stdout, stderr } = await execution;
    const events = stdout.trim().split("\n").map((line) => JSON.parse(line));
    assert.ok(events.some((event) => event.type === "tool_execution_end" && event.toolName === "write" && !event.isError), stdout);
    assert.match(await readFile(join(cwd, "main.py"), "utf8"), /^x = 1\n/);
    assert.equal(stderr.match(/guardian-review:configured/g)?.length, 1, stderr);
    assert.equal(await readFile(join(cwd, "other.py"), "utf8"), "other = 0\n");
  });
});

test("large file alone never enters AI review context", () => {
  assert.equal(healthReviewContext({ sources: [{ path: "style.css", text: "a{}\n".repeat(900) }], findings: [{ file: "style.css", category: "large-file" }] }), "[]");
});
