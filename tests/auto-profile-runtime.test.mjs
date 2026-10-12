import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { piInvocation } from "../lib/subagent-runner.ts";

const agentsExtension = fileURLToPath(new URL("../extensions/agents.ts", import.meta.url));
const providerExtension = fileURLToPath(new URL("./fixtures/auto-profile-provider.ts", import.meta.url));
const profiles = {
  plan: { prompt: "Make a plan for this change", effort: "low" },
  orchestrator: { prompt: "Coordinate these tasks", effort: "medium" },
  debug: { prompt: "Debug this failure", effort: "high" },
  ask: { prompt: "Explain this function", effort: "off" },
  code: { prompt: "Execute", effort: "max" },
};

async function fixture(work) {
  const root = await mkdtemp(join(tmpdir(), "piexis-auto-profile-"));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await mkdir(agentDir);
  try { await work({ cwd, agentDir }); }
  finally { await rm(root, { recursive: true, force: true }); }
}

async function configure(f, overrides = {}) {
  await writeFile(join(f.agentDir, "agent.json"), JSON.stringify({
    auto_profile: true,
    model: "piexis-auto/main",
    subagent_variant_overrides: Object.fromEntries(Object.entries(profiles).map(([name, value]) => [name, {
      model: `piexis-auto/${name}`,
      effort: value.effort,
    }])),
    ...overrides,
  }));
}

function args(mode) {
  const invocation = piInvocation();
  return [invocation.command, [...invocation.args, "--offline", "--no-session", "--mode", mode,
    "--no-extensions", "--no-skills", "--no-context-files", "--no-prompt-templates",
    "--extension", agentsExtension, "--extension", providerExtension, "--model", "piexis-auto/main", "--no-tools"]];
}

function reportFrom(record) {
  const message = record.type === "message_end" ? record.message : undefined;
  const text = message?.role === "assistant" ? message.content?.find((part) => part.type === "text")?.text : undefined;
  return typeof text === "string" && text.startsWith("{") ? JSON.parse(text) : undefined;
}

function startRpc(f) {
  const [command, childArgs] = args("rpc");
  const child = spawn(command, childArgs, {
    cwd: f.cwd,
    env: { ...process.env, PI_CODING_AGENT_DIR: f.agentDir, PI_OFFLINE: "1", PIEXIS_SUBAGENT_DEPTH: "0" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const records = [];
  let stdout = "", stderr = "", exited;
  const exit = new Promise((resolve) => { exited = resolve; });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    for (;;) {
      const end = stdout.indexOf("\n");
      if (end < 0) break;
      const line = stdout.slice(0, end); stdout = stdout.slice(end + 1);
      if (line) records.push(JSON.parse(line));
    }
  });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.on("exit", (code, signal) => exited({ code, signal }));
  let sequence = 0;
  async function prompt(message) {
    const id = `prompt-${++sequence}`;
    const start = records.length;
    child.stdin.write(`${JSON.stringify({ id, type: "prompt", message })}\n`);
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const response = records.slice(start).find((record) => record.type === "response" && record.id === id);
      if (response?.success === false) throw new Error(`RPC rejected ${message}: ${response.error}`);
      const handled = response?.data?.disposition === "handled" || message.startsWith("/") ||
        records.slice(start).some((record) => record.type === "extension_ui_request" && record.method === "notify" && record.message?.includes("not submitted"));
      if (response?.success && handled) return { response, records: records.slice(start) };
      if (response?.success && records.slice(start).some((record) => record.type === "agent_settled")) return { response, records: records.slice(start) };
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Timed out waiting for ${message}; stderr: ${stderr}`);
  }
  async function close() {
    child.stdin.end();
    const result = await Promise.race([exit, new Promise((resolve) => setTimeout(() => resolve(undefined), 2_000))]);
    if (!result) { child.kill("SIGTERM"); await Promise.race([exit, new Promise((resolve) => setTimeout(resolve, 1_000))]); }
  }
  return { prompt, close, records: () => records, stderr: () => stderr };
}

function assertReport(report, name) {
  // Generic reasoning models clamp max to high; report the effective request setting.
  assert.deepEqual(report, { profile: name, model: `piexis-auto/${name}`, effort: name === "code" ? "high" : profiles[name].effort });
}

test("offline real Pi CLI applies each automatic profile before its first provider request", { timeout: 60_000 }, async () => {
  await fixture(async (f) => {
    await configure(f);
    for (const [name, expected] of Object.entries(profiles)) {
      const [command, childArgs] = args("json");
      const child = spawn(command, [...childArgs, "--print", "--", expected.prompt], {
        cwd: f.cwd, env: { ...process.env, PI_CODING_AGENT_DIR: f.agentDir, PI_OFFLINE: "1", PIEXIS_SUBAGENT_DEPTH: "0" }, stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "", stderr = "";
      child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; });
      const result = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error(`CLI timeout for ${name}: ${stderr}`)); }, 10_000);
        child.once("error", (error) => { clearTimeout(timer); reject(error); });
        child.once("exit", (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
      });
      assert.deepEqual(result, { code: 0, signal: null }, stderr);
      const reports = stdout.trim().split("\n").map(JSON.parse).map(reportFrom).filter(Boolean);
      assert.equal(reports.length, 1, stdout);
      assertReport(reports[0], name);
    }
  });
});

test("offline real Pi RPC switches automatic profiles in one session and releases a manual pin", { timeout: 30_000 }, async () => {
  await fixture(async (f) => {
    await configure(f);
    const rpc = startRpc(f);
    try {
      for (const name of ["plan", "code", "debug", "ask", "orchestrator"]) {
        const result = await rpc.prompt(profiles[name].prompt);
        assertReport(result.records.map(reportFrom).find(Boolean), name);
      }
      assert.equal((await rpc.prompt("/profile ask")).response.success, true);
      assertReport((await rpc.prompt(profiles.debug.prompt)).records.map(reportFrom).find(Boolean), "ask");
      assert.equal((await rpc.prompt("/profile auto")).response.success, true);
      assertReport((await rpc.prompt(profiles.debug.prompt)).records.map(reportFrom).find(Boolean), "debug");
    } finally { await rpc.close(); }
  });
});

test("offline automatic activation with an unavailable model submits no provider request", { timeout: 20_000 }, async () => {
  await fixture(async (f) => {
    await configure(f, { subagent_variant_overrides: { plan: { model: "piexis-auto/missing", effort: "low" } } });
    const rpc = startRpc(f);
    try {
      const result = await rpc.prompt(profiles.plan.prompt);
      assert.equal(result.records.map(reportFrom).filter(Boolean).length, 0, "unavailable activation must not reach the provider");
    } finally { await rpc.close(); }
  });
});
