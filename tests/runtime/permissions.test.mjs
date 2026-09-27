import assert from "node:assert/strict";
import test from "node:test";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { fixture, rpc, jsonRun, waitFor } from "./harness.mjs";

const toolEnd = (name) => (event) => event.type === "tool_execution_end" && event.toolName === name;

test("installed Pi RPC: Manual denial/approval and Plan restriction affect actual writes", { timeout: 45000 }, async (t) => {
  const h = await fixture(t);
  const client = await rpc(h);
  let start = await client.prompt("RUNTIME_WRITE create made.txt");
  let dialog = await client.wait((event) => event.type === "extension_ui_request" && event.method === "select", start);
  client.send({ type: "extension_ui_response", id: dialog.id, value: "Deny" });
  assert.equal((await client.wait(toolEnd("write"), start)).isError, true);
  await client.settled(start);
  await assert.rejects(stat(join(h.cwd, "made.txt")), { code: "ENOENT" });
  start = await client.prompt("RUNTIME_WRITE create made.txt with approval");
  dialog = await client.wait((event) => event.type === "extension_ui_request" && event.method === "select", start);
  client.send({ type: "extension_ui_response", id: dialog.id, value: dialog.options.find((option) => option.startsWith("Allow once:")) });
  assert.equal((await client.wait(toolEnd("write"), start)).isError, false);
  await client.settled(start);
  assert.equal(await readFile(join(h.cwd, "made.txt"), "utf8"), "actual tool executed\n");
  await client.prompt("/plan");
  start = await client.prompt("RUNTIME_WRITE PLAN_MUST_BLOCK do not create plan-only.txt");
  assert.equal((await client.wait(toolEnd("write"), start)).isError, true);
  await client.settled(start);
  await assert.rejects(stat(join(h.cwd, "plan-only.txt")), { code: "ENOENT" });
  assert.equal(client.events.some((event) => event.type === "extension_error" || event.type === "invalid-json"), false, client.diagnostic());
});

test("installed Pi RPC: /plan cannot change modes while the agent is busy", { timeout: 30000 }, async (t) => {
  const h = await fixture(t);
  const client = await rpc(h);
  await client.prompt("RUNTIME_HOLD keep the agent busy");
  await waitFor(() => h.requests.some((request) => request.model === "agent"), client.diagnostic);
  assert.equal((await client.command("get_state")).isStreaming, true);
  const changing = await client.prompt("/plan");
  // RPC acknowledges command handling; extension command errors arrive as events.
  await client.wait((event) => /idle/.test(String(event.error ?? event.message ?? "")), changing);
  await client.command("abort");
  const start = await client.prompt("RUNTIME_WRITE confirm Manual mode was retained");
  const dialog = await client.wait((event) => event.method === "select", start);
  client.send({ type: "extension_ui_response", id: dialog.id, value: "Deny" });
  await client.settled(start);
  await assert.rejects(stat(join(h.cwd, "made.txt")), { code: "ENOENT" });
});

for (const mode of ["acceptEdits", "bypassPermissions", "dontAsk"]) {
  test(`installed Pi JSON: ${mode} retains its launch-time policy`, { timeout: 30000 }, async (t) => {
    const h = await fixture(t, mode);
    const tool = mode === "bypassPermissions" ? "bash" : "write";
    const result = await jsonRun(h, tool === "bash" ? "RUNTIME_BASH print the runtime check" : "RUNTIME_WRITE create made.txt");
    const completed = result.events.find(toolEnd(tool));
    assert.ok(completed, JSON.stringify(result));
    assert.equal(completed.isError, mode === "dontAsk");
    if (mode === "dontAsk") {
      assert.match(JSON.stringify(completed.result), /not-pre-approved/);
      await assert.rejects(stat(join(h.cwd, "made.txt")), { code: "ENOENT" });
    } else if (mode === "acceptEdits") assert.equal(await readFile(join(h.cwd, "made.txt"), "utf8"), "actual tool executed\n");
    else assert.match(JSON.stringify(completed.result), /runtime-bash-check/);
    assert.equal(result.events.some((event) => event.method === "select"), false);
    assert.equal(h.requests.some((request) => request.model === "reviewer"), false);
  });
}

test("installed Pi RPC: Auto reviewer uses real registry/transport and malformed responses fail closed", { timeout: 45000 }, async (t) => {
  const h = await fixture(t, "auto");
  const client = await rpc(h);
  let start = await client.prompt("RUNTIME_BASH print the requested runtime check");
  const allowed = await client.wait(toolEnd("bash"), start);
  assert.equal(allowed.isError, false, JSON.stringify(allowed));
  await client.settled(start);
  assert.ok(h.requests.some((request) => request.model === "reviewer"));
  assert.equal(client.events.slice(start).some((event) => event.method === "select"), false);
  h.reviewBehavior = "malformed";
  start = await client.prompt("RUNTIME_BASH malformed reviewer must block this");
  assert.equal((await client.wait(toolEnd("bash"), start)).isError, true);
  await client.settled(start);
  h.reviewBehavior = "hold";
  start = await client.prompt("RUNTIME_BASH reviewer timeout must block this");
  const timeout = await client.wait(toolEnd("bash"), start);
  assert.equal(timeout.isError, true);
  assert.match(JSON.stringify(timeout.result), /timed out/);
  await client.settled(start);
});

test("installed Pi RPC and real worker: broker approvals, Bash observations, diff/apply/cleanup", { timeout: 60000 }, async (t) => {
  const h = await fixture(t, "auto", ["--background-bash"]);
  const client = await rpc(h);
  await client.prompt("/task RUNTIME_WORKER write worker.txt then print the runtime worker check");
  const task = await waitFor(async () => (await h.metadata()).find((task) => ["completed", "failed", "cancelled"].includes(task.status)), client.diagnostic, 25000);
  assert.equal(task.status, "completed", JSON.stringify(task));
  assert.equal(await readFile(join(task.worktree, "worker.txt"), "utf8"), "actual worker edit\n");
  assert.equal(task.commands.length, 1, JSON.stringify(task));
  assert.equal(task.commands[0].outcome, "completed");
  const reviews = h.requests.filter((request) => request.model === "reviewer");
  assert.ok(reviews.length >= 3); // Task creation, delegated write, delegated Bash.
  assert.ok(reviews.every((request) => !JSON.stringify(request).includes("actual worker edit")));
  assert.match(task.commands[0].command, /runtime-worker-check/);
  await assert.rejects(stat(join(h.cwd, "worker.txt")), { code: "ENOENT" });
  let start = await client.prompt(`/task diff ${task.id}`);
  await client.wait((event) => event.method === "notify" && event.message?.includes("actual worker edit"), start);
  start = client.events.length;
  const applying = client.prompt(`/task apply ${task.id}`);
  const confirmation = await client.wait((event) => event.method === "confirm", start);
  assert.match(confirmation.message, /worker.txt/);
  client.send({ type: "extension_ui_response", id: confirmation.id, confirmed: true });
  await applying;
  assert.equal(await readFile(join(h.cwd, "worker.txt"), "utf8"), "actual worker edit\n");
  start = client.events.length;
  const cleaning = client.prompt(`/task clean ${task.id}`);
  const cleanup = await client.wait((event) => event.method === "confirm", start);
  client.send({ type: "extension_ui_response", id: cleanup.id, confirmed: true });
  await cleaning;
  await assert.rejects(stat(task.worktree), { code: "ENOENT" });
  assert.equal(h.errors.length, 0);
});

test("installed Pi worker without Bash opt-in cannot run a command or claim observed verification", { timeout: 45000 }, async (t) => {
  const h = await fixture(t, "auto");
  const client = await rpc(h);
  await client.prompt("/task RUNTIME_WORKER write worker.txt; Bash is not enabled");
  const task = await waitFor(async () => (await h.metadata()).find((task) => ["completed", "failed", "cancelled"].includes(task.status)), client.diagnostic, 25000);
  assert.equal(task.status, "completed", JSON.stringify(task));
  assert.equal(await readFile(join(task.worktree, "worker.txt"), "utf8"), "actual worker edit\n");
  assert.deepEqual(task.commands, []);
  assert.match(task.output, /I ran npm test and all tests passed/);
  const workerRequests = h.requests.filter((request) => request.model === "agent");
  assert.ok(workerRequests.length >= 2);
  assert.ok(workerRequests.every((request) => !request.tools.some((tool) => ["bash", "worker_bash"].includes(tool.function.name))));
});

test("installed Pi missing worker wrappers never fall back to unrestricted built-in writes", { timeout: 30000 }, async (t) => {
  const h = await fixture(t, "bypassPermissions", ["--no-builtin-tools", "--tools", "worker_write"]);
  const result = await jsonRun(h, "RUNTIME_WRITE attempt a built-in write with the worker guard absent");
  await assert.rejects(stat(join(h.cwd, "made.txt")), { code: "ENOENT" });
  assert.ok(result.exitCode !== 0 || result.events.some((event) => toolEnd("write")(event) && event.isError), JSON.stringify(result));
  assert.ok(h.requests.every((request) => !(request.tools ?? []).some((tool) => tool.function.name === "write")));
});

test("installed Pi JSON: missing approval UI denies and repeated denials abort without writing", { timeout: 30000 }, async (t) => {
  const h = await fixture(t);
  const result = await jsonRun(h, "RUNTIME_WRITE RUNTIME_REPEAT try the same write repeatedly");
  await assert.rejects(stat(join(h.cwd, "made.txt")), { code: "ENOENT" });
  const writes = result.events.filter(toolEnd("write"));
  assert.equal(writes.length, 3);
  assert.ok(writes.every((event) => event.isError));
  assert.match(result.stderr, /permission_blocked: denial limit reached/);
  assert.ok(result.events.some((event) => event.type === "entry_appended" && event.entry?.customType === "piexis-permission-stop"));
  assert.equal(result.events.some((event) => event.method === "select"), false);
});

test("installed Pi RPC: a stale worker approval cannot survive session replacement", { timeout: 45000 }, async (t) => {
  const h = await fixture(t);
  const client = await rpc(h);
  const start = await client.prompt("/task RUNTIME_WORKER write worker.txt");
  const dialog = await client.wait((event) => event.method === "select", start);
  const task = (await h.metadata()).find((task) => task.status === "running");
  assert.ok(task?.pid);
  await client.command("new_session");
  client.send({ type: "extension_ui_response", id: dialog.id, value: dialog.options.find((option) => option.startsWith("Allow once:")) });
  await assert.rejects(stat(join(task.worktree, "worker.txt")), { code: "ENOENT" });
  assert.equal((await h.metadata()).find((item) => item.id === task.id).status, "interrupted");
  assert.throws(() => process.kill(task.pid, 0), { code: "ESRCH" });
});

test("installed Pi RPC: orderly stdin EOF shuts down a real active worker", { timeout: 45000 }, async (t) => {
  const h = await fixture(t);
  const client = await rpc(h);
  await client.prompt("/task RUNTIME_HOLD wait without executing tools");
  const task = await waitFor(async () => (await h.metadata()).find((task) => task.status === "running" && task.pid), client.diagnostic);
  await waitFor(() => h.requests.some((request) => request.model === "agent"), client.diagnostic);
  client.child.stdin.end();
  await waitFor(() => client.child.exitCode !== null, client.diagnostic);
  assert.equal(client.child.exitCode, 0, client.diagnostic());
  assert.throws(() => process.kill(task.pid, 0), { code: "ESRCH" });
  assert.equal((await h.metadata()).find((item) => item.id === task.id).status, "interrupted");
});

test("installed Pi: session replacement stops a real waiting worker and retains interrupted state", { timeout: 45000 }, async (t) => {
  const h = await fixture(t);
  const client = await rpc(h);
  await client.prompt("/task RUNTIME_HOLD wait without executing tools");
  const task = await waitFor(async () => (await h.metadata()).find((task) => task.status === "running" && task.pid), client.diagnostic);
  assert.doesNotThrow(() => process.kill(task.pid, 0));
  await waitFor(() => h.requests.some((request) => request.model === "agent" && JSON.stringify(request.messages).includes("RUNTIME_HOLD")), client.diagnostic);
  await client.command("new_session");
  await waitFor(() => { try { process.kill(task.pid, 0); return false; } catch (error) { return error.code === "ESRCH"; } }, client.diagnostic);
  assert.equal((await h.metadata()).find((item) => item.id === task.id).status, "interrupted");
  assert.ok(await stat(task.worktree));
});
