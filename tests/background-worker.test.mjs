import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import workerExtension from "../extensions/background-worker.ts";
import { readBrokerJson, publishBrokerJson } from "../lib/task-broker.ts";

async function worker(t, bash = false) {
  const broker = await mkdtemp(join(tmpdir(), "piexis-worker-guard-"));
  const settings = { PIEXIS_TASK_BROKER: broker, PIEXIS_TASK_TOKEN: randomUUID(), PIEXIS_TASK_BASH: bash ? "1" : "0", PIEXIS_TASK_REPEAT_LIMIT: "3", PIEXIS_TASK_DENIAL_LIMIT: "6" };
  const saved = Object.fromEntries(Object.keys(settings).map((key) => [key, process.env[key]]));
  Object.assign(process.env, settings);
  const hooks = new Map();
  const tools = new Map();
  const records = [];
  let aborts = 0;
  const controller = new AbortController();
  const ctx = { signal: controller.signal, abort() { aborts++; } };
  workerExtension({ on(name, callback) { hooks.set(name, callback); }, registerTool(tool) { tools.set(tool.name, tool); }, appendEntry(customType, data) { records.push({ customType, data }); } });
  for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  t.after(async () => { controller.abort(); await rm(broker, { recursive: true, force: true }); });
  await writeFile(join(broker, "heartbeat"), "");
  return { broker, hooks, tools, records, ctx, settings, get aborts() { return aborts; } };
}

test("worker-only wrappers cannot fall back to built-ins and even reads need the parent broker", { timeout: 5000 }, async (t) => {
  const h = await worker(t);
  assert.deepEqual([...h.tools.keys()], ["worker_read", "worker_edit", "worker_write", "worker_grep", "worker_find", "worker_ls"]);
  const call = (toolName, input) => h.hooks.get("tool_call")({ toolName, input, toolCallId: "fixture" }, h.ctx);
  assert.equal((await call("read", { path: "README.md" })).block, true);
  assert.equal((await call("worker_bash", { command: "pwd" })).block, true);
  const pending = call("worker_read", { path: "src/main.txt" });
  let file;
  while (!(file = (await readdir(h.broker)).find((name) => name.endsWith(".request.json")))) await new Promise(setImmediate);
  const request = await readBrokerJson(join(h.broker, file));
  assert.equal(request.tool, "read");
  assert.equal(request.token, h.settings.PIEXIS_TASK_TOKEN);
  await publishBrokerJson(join(h.broker, `${request.id}.response.json`), { id: request.id, outcome: "allowed" });
  assert.equal(await pending, undefined);
  assert.equal(h.aborts, 0);
  await rm(join(h.broker, "heartbeat"));
  assert.equal((await call("worker_read", { path: "src/main.txt" })).block, true);
  assert.equal(h.aborts, 1);
});

test("worker command observations use post-execution callbacks and redact recognizable secrets", async (t) => {
  const h = await worker(t, true);
  assert.ok(h.tools.has("worker_bash"));
  assert.equal(h.hooks.has("tool_execution_start"), false);
  h.hooks.get("tool_result")({ toolName: "worker_bash", toolCallId: "actual", input: { command: "node --test fixture.mjs" }, isError: false });
  h.hooks.get("tool_result")({ toolName: "worker_read", toolCallId: "read", input: {}, isError: false });
  assert.deepEqual(h.records, [{ customType: "piexis-worker-execution", data: { id: "actual", command: "node --test fixture.mjs", isError: false } }]);
  h.hooks.get("tool_result")({ toolName: "worker_bash", toolCallId: "redacted", input: { command: 'printf "Bearer fixture_test_token_123"' }, isError: true });
  assert.doesNotMatch(h.records[1].data.command, /fixture_test_token_123/);
  assert.match(h.records[1].data.command, /REDACTED/);
  h.hooks.get("tool_result")({ toolName: "worker_bash", toolCallId: "long", input: { command: "x".repeat(3000) }, isError: true });
  assert.equal(h.records[2].data.truncated, true);
});
