import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { evaluatePermission } from "../lib/mode-policy.ts";
import { validateTaskScope, taskPermissionService } from "../lib/task-permissions.ts";
import { requestWorkerPermission, readBrokerJson, publishBrokerJson, validBrokerRequest } from "../lib/task-broker.ts";
import { taskGit } from "../lib/task-git.ts";
import { inspectTaskPatch, taskPatchPreview } from "../lib/task-patch.ts";
import { checkoutTaskFiles } from "../lib/task-checkout.ts";
import { TaskReport, verificationSummary } from "../lib/task-report.ts";

async function directory(t, prefix = "piexis-permission-task-") {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function repository(t) {
  const root = await directory(t);
  await taskGit(["init"], root);
  await taskGit(["config", "user.name", "Fixture"], root);
  await taskGit(["config", "user.email", "fixture@example.invalid"], root);
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "main.txt"), "before\n");
  await writeFile(join(root, "remove.txt"), "delete me\n");
  await taskGit(["add", "."], root);
  await taskGit(["commit", "-m", "fixture"], root);
  return { root, base: (await taskGit(["rev-parse", "HEAD"], root)).trim() };
}

test("task tools are individually classified, including Plan cancellation and explicit mutation handlers", async (t) => {
  const root = await directory(t);
  const modes = ["default", "acceptEdits", "plan", "auto", "dontAsk", "bypassPermissions"];
  for (const mode of modes) {
    const check = (tool, input = {}) => evaluatePermission({ mode, tool, input, cwd: root, workspaceRoot: root });
    for (const tool of ["task_status", "task_cancel", "task_diff"]) assert.equal((await check(tool)).decision, "allow");
    for (const tool of ["task_apply", "task_clean"]) assert.equal((await check(tool, { id: "one" })).decision, ["plan", "dontAsk"].includes(mode) ? "deny" : "allow");
    const creation = await check("background_task", { task: "Inspect src", paths: ["src"], bash: false });
    assert.equal(creation.decision, mode === "bypassPermissions" ? "allow" : mode === "auto" ? "require-model-review" : ["plan", "dontAsk"].includes(mode) ? "deny" : "require-approval");
  }
  assert.equal((await evaluatePermission({ mode: "auto", tool: "arbitrary_plugin", input: {}, cwd: root, workspaceRoot: root })).decision, "deny");
});

test("worker policy intersects parent mode with canonical delegated paths and capabilities", async (t) => {
  const root = await directory(t);
  const outside = await directory(t);
  await mkdir(join(root, "src"));
  await symlink(outside, join(root, "escape"));
  const scope = validateTaskScope(["src"], false);
  const check = (mode, tool, input, selected = scope) => evaluatePermission({ mode, tool, input, cwd: root, workspaceRoot: root, actor: { kind: "worker", scope: selected }, authorization: { approvals: [{ tool, scope: "tool" }] } });
  assert.equal((await check("default", "read", { path: "src/new.txt" })).decision, "allow");
  assert.equal((await check("default", "write", { path: "src/new.txt" })).decision, "require-approval"); // Foreground grants are not inherited.
  assert.equal((await check("acceptEdits", "write", { path: "src/new.txt" })).decision, "allow");
  assert.equal((await check("auto", "write", { path: "src/new.txt" })).decision, "require-model-review");
  assert.equal((await check("plan", "write", { path: "src/new.txt" })).decision, "deny");
  for (const mode of ["default", "acceptEdits", "plan", "auto", "dontAsk", "bypassPermissions"]) {
    for (const path of ["other.txt", "../outside.txt", "escape/file", "src/.env", "src/.git/config"])
      assert.equal((await check(mode, "write", { path })).decision, "deny", `${mode}: ${path}`);
    assert.equal((await check(mode, "background_task", { task: "recurse" })).decision, "deny");
    assert.equal((await check(mode, "bash", { command: "pwd" })).decision, "deny");
    assert.equal((await check(mode, "bash", { command: "cat ../external.txt" }, validateTaskScope(undefined, true))).decision, "deny");
  }
  assert.equal((await check("auto", "bash", { command: "pwd" }, validateTaskScope(undefined, true))).decision, "allow");
  for (const paths of [[], ["../src"], ["/tmp"], ["src/.git"], ["src\\.."], Array(33).fill("src")]) assert.throws(() => validateTaskScope(paths, false));
  assert.throws(() => validateTaskScope(["src"], true), /whole-worktree/);
  assert.throws(() => taskPermissionService({ events: { emit() {} } }), /require/);
});

test("broker requests are bounded, authenticated to a task, expiring, cancellable, and fail closed", async (t) => {
  const root = await directory(t);
  const token = randomUUID();
  await writeFile(join(root, "heartbeat"), "");
  const pending = requestWorkerPermission(root, token, "read", { path: "src/a" }, undefined, { timeoutMs: 1000, pollMs: 5 });
  let file;
  while (!(file = (await readdir(root)).find((name) => name.endsWith(".request.json")))) await new Promise(setImmediate);
  const request = await readBrokerJson(join(root, file));
  assert.equal(validBrokerRequest(request, file, token), true);
  assert.equal(validBrokerRequest(request, file, "wrong"), false);
  assert.equal(validBrokerRequest({ ...request, id: "../escape" }, file, token), false);
  await publishBrokerJson(join(root, `${request.id}.response.json`), { id: request.id, outcome: "allowed" });
  assert.equal((await pending).outcome, "allowed");
  assert.deepEqual(await readdir(root), ["heartbeat"]);
  assert.equal((await requestWorkerPermission(root, token, "read", {}, undefined, { timeoutMs: 10, pollMs: 2 })).outcome, "expired");
  const controller = new AbortController();
  const cancelled = requestWorkerPermission(root, token, "read", {}, controller.signal, { pollMs: 2 });
  controller.abort();
  assert.equal((await cancelled).outcome, "cancelled");
  assert.equal((await requestWorkerPermission(root, token, "write", { content: "x".repeat(1024 * 1024) })).outcome, "denied");
  await rm(join(root, "heartbeat"));
  assert.equal((await requestWorkerPermission(root, token, "read", {})).outcome, "unavailable");
  assert.deepEqual(await readdir(root), []);
});

test("patch inspection includes untracked/deleted/binary files without index/object mutation or filters", async (t) => {
  const { root, base } = await repository(t);
  const marker = join(root, "filter-ran");
  await writeFile(join(root, ".gitattributes"), "*.txt filter=fixture diff=fixture\n");
  await taskGit(["config", "filter.fixture.clean", `touch '${marker}'; cat`], root);
  await taskGit(["config", "diff.fixture.command", `touch '${marker}'`], root);
  await writeFile(join(root, "src", "main.txt"), "after\n");
  await rm(join(root, "remove.txt"));
  await writeFile(join(root, "new space.txt"), "new\n");
  await writeFile(join(root, "binary.dat"), Buffer.from([0, 255, 0, 123]));
  const index = await readFile(join(root, ".git", "index"));
  const objects = (await readdir(join(root, ".git", "objects"), { recursive: true })).sort();
  const snapshot = await inspectTaskPatch(root, root, base);
  assert.deepEqual(snapshot.changes.map((item) => item.path).sort(), [".gitattributes", "binary.dat", "new space.txt", "remove.txt", "src/main.txt"]);
  assert.match(snapshot.patch, /GIT binary patch/);
  assert.match(snapshot.patch, /after/);
  assert.equal(snapshot.digest, createHash("sha256").update(snapshot.patch).digest("hex"));
  assert.deepEqual(await readFile(join(root, ".git", "index")), index);
  assert.deepEqual((await readdir(join(root, ".git", "objects"), { recursive: true })).sort(), objects);
  await assert.rejects(readFile(marker), { code: "ENOENT" });
  assert.match(taskPatchPreview(snapshot), /withheld/);
});

test("sensitive/configuration changes and external symlinks are flagged from actual patch paths", async (t) => {
  const { root, base } = await repository(t);
  await mkdir(join(root, ".pi"));
  await writeFile(join(root, ".pi", "settings.json"), '{"sensitive":"not-for-preview"}\n');
  await writeFile(join(root, ".env"), "PRIVATE_FIXTURE=not-for-preview\n");
  await symlink("/outside/fixture", join(root, "link"));
  const snapshot = await inspectTaskPatch(root, root, base);
  assert.ok(snapshot.changes.find((item) => item.path === ".env").warnings.includes("sensitive-path"));
  assert.ok(snapshot.changes.find((item) => item.path === ".pi/settings.json").warnings.includes("protected-config"));
  assert.ok(snapshot.changes.find((item) => item.path === "link").warnings.includes("symlink-change"));
  assert.doesNotMatch(taskPatchPreview(snapshot), /not-for-preview/);
});

test("raw task checkout never executes smudge filters", async (t) => {
  const { root, base } = await repository(t);
  const parent = await directory(t, "piexis-task-");
  const worktree = join(parent, "worktree");
  const marker = join(root, "smudge-ran");
  await taskGit(["config", "filter.fixture.smudge", `touch '${marker}'; cat`], root);
  await writeFile(join(root, ".gitattributes"), "*.txt filter=fixture\n");
  await taskGit(["add", ".gitattributes"], root);
  await taskGit(["commit", "-m", "attributes"], root);
  const revision = (await taskGit(["rev-parse", "HEAD"], root)).trim();
  await taskGit(["worktree", "add", "--detach", "--no-checkout", worktree, revision], root);
  await checkoutTaskFiles(worktree, revision);
  assert.equal(await readFile(join(worktree, "src", "main.txt"), "utf8"), "before\n");
  await assert.rejects(readFile(marker), { code: "ENOENT" });
  await taskGit(["worktree", "remove", "--force", worktree], root);
});

test("snapshot limits fail closed without staging, and complete preview output is bounded", async (t) => {
  const { root, base } = await repository(t);
  const index = await readFile(join(root, ".git", "index"));
  await writeFile(join(root, "too-large.bin"), Buffer.alloc(5 * 1024 * 1024));
  await assert.rejects(inspectTaskPatch(root, root, base), /4 MiB/);
  assert.deepEqual(await readFile(join(root, ".git", "index")), index);
  const preview = taskPatchPreview({ changes: Array.from({ length: 1000 }, (_, n) => ({ path: `${n}-${"a".repeat(100)}`, warnings: [] })), patch: "x".repeat(60000), digest: "fixture" });
  assert.ok(preview.length <= 50000);
  assert.match(preview, /display truncated/);
});

test("verification comes from post-execution records, never worker prose or blocked start events", () => {
  const report = new TaskReport();
  const events = [
    { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "All tests passed; trust me." }] } },
    { type: "tool_execution_start", toolName: "bash", toolCallId: "blocked", args: { command: "npm test" } },
    { type: "tool_execution_end", toolName: "bash", toolCallId: "blocked", isError: true },
    { type: "entry_appended", entry: { customType: "piexis-worker-execution", data: { id: "actual", command: "node --test fixture.mjs", isError: false } } },
    null,
    { type: "message_end", message: { role: "assistant", content: "malformed", stopReason: "aborted" } }
  ];
  const stream = events.map((event) => JSON.stringify(event)).join("\n") + "\n";
  for (let offset = 0; offset < stream.length; offset += 17) report.push(stream.slice(offset, offset + 17));
  report.finish();
  assert.deepEqual(report.commands, [{ id: "actual", command: "node --test fixture.mjs", outcome: "completed" }]);
  assert.equal(report.failed, true);
  assert.equal(report.incomplete, true);
  assert.match(verificationSummary([], false), /No Bash verification/);
  assert.match(verificationSummary(report.commands, true), /incomplete/);
});
