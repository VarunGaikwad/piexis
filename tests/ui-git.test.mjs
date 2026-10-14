import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createFooterGitTracker } from "../lib/ui-git.ts";

function git(cwd, ...args) {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd }, (error, stdout) => error ? reject(error) : resolve(stdout));
  });
}

async function repository(t) {
  const cwd = await mkdtemp(join(tmpdir(), "piexis-ui-git-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await git(cwd, "init", "-q");
  await git(cwd, "config", "user.email", "test@example.invalid");
  await git(cwd, "config", "user.name", "Test");
  await writeFile(join(cwd, "base.txt"), "one\ntwo\n");
  await git(cwd, "add", "base.txt");
  await git(cwd, "commit", "-qm", "base");
  return cwd;
}

async function eventually(predicate, message = "condition was not met") {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(message);
}

function tracker(cwd) {
  let changes = 0;
  const value = createFooterGitTracker(cwd, () => { changes++; });
  return { value, changes: () => changes };
}

test("Git footer tracker reports combined tracked changes and untracked dirtiness", async (t) => {
  const cwd = await repository(t);
  await writeFile(join(cwd, "base.txt"), "one\nchanged\nthree\n");
  await git(cwd, "add", "base.txt");
  await writeFile(join(cwd, "base.txt"), "one\nchanged\nthree\nfour\n");
  await writeFile(join(cwd, "untracked.txt"), "not counted\n");
  const tracked = tracker(cwd);
  t.after(() => tracked.value.dispose());
  tracked.value.refresh();
  await eventually(() => tracked.value.getStats()?.dirty === true);
  const stats = tracked.value.getStats();
  assert.equal(stats.branch, await git(cwd, "branch", "--show-current").then((value) => value.trim()));
  assert.deepEqual(stats, { branch: stats.branch, dirty: true, added: 3, removed: 1 });
  assert.equal(tracked.changes(), 1);
});

test("Git footer tracker excludes binary changes from line totals", async (t) => {
  const cwd = await repository(t);
  await writeFile(join(cwd, "binary.bin"), Buffer.from([0, 1, 2]));
  await git(cwd, "add", "binary.bin");
  await git(cwd, "commit", "-qm", "binary");
  await writeFile(join(cwd, "base.txt"), "one\nupdated\n");
  await writeFile(join(cwd, "binary.bin"), Buffer.from([3, 4, 5]));
  const tracked = tracker(cwd);
  t.after(() => tracked.value.dispose());
  tracked.value.refresh();
  await eventually(() => tracked.value.getStats()?.dirty === true);
  assert.deepEqual(tracked.value.getStats(), {
    branch: (await git(cwd, "branch", "--show-current")).trim(), dirty: true, added: 1, removed: 1
  });
});

test("Git footer tracker handles an unborn branch with staged tracked totals", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "piexis-ui-git-unborn-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await git(cwd, "init", "-q");
  await writeFile(join(cwd, "new.txt"), "one\ntwo\n");
  await git(cwd, "add", "new.txt");
  const tracked = tracker(cwd);
  t.after(() => tracked.value.dispose());
  tracked.value.refresh();
  await eventually(() => tracked.value.getStats()?.added === 2);
  assert.deepEqual(tracked.value.getStats(), {
    branch: (await git(cwd, "branch", "--show-current")).trim(), dirty: true, added: 2, removed: 0
  });
});

test("Git footer tracker recovers when its notification throws", async (t) => {
  const cwd = await repository(t);
  let notifications = 0;
  const value = createFooterGitTracker(cwd, () => {
    notifications++;
    throw new Error("notification failed");
  });
  t.after(() => value.dispose());
  value.refresh();
  await eventually(() => value.getStats()?.dirty === false);
  await writeFile(join(cwd, "base.txt"), "changed\n");
  value.refresh();
  await eventually(() => value.getStats()?.dirty === true);
  assert.equal(notifications, 2);
});

test("Git footer tracker stops collection after disposal", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "piexis-ui-git-dispose-"));
  const count = join(root, "count");
  const started = join(root, "started");
  const exited = join(root, "exited");
  const unexpected = join(root, "unexpected");
  await writeFile(join(root, "git"), `#!${process.execPath}\n
const fs = require("node:fs");
const countPath = process.env.PIE_XIS_GIT_COUNT;
const invocation = Number(fs.existsSync(countPath) ? fs.readFileSync(countPath, "utf8") : 0) + 1;
fs.writeFileSync(countPath, String(invocation));
if (invocation === 1) process.exit(0);
if (invocation === 2) {
  fs.writeFileSync(process.env.PIE_XIS_GIT_STARTED, "");
  process.on("SIGTERM", () => {
    fs.writeFileSync(process.env.PIE_XIS_GIT_EXITED, "");
    process.exit(0);
  });
  setInterval(() => {}, 1_000);
} else {
  fs.writeFileSync(process.env.PIE_XIS_GIT_UNEXPECTED, "");
}
`);
  await chmod(join(root, "git"), 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${root}:${oldPath ?? ""}`;
  process.env.PIE_XIS_GIT_COUNT = count;
  process.env.PIE_XIS_GIT_STARTED = started;
  process.env.PIE_XIS_GIT_EXITED = exited;
  process.env.PIE_XIS_GIT_UNEXPECTED = unexpected;
  t.after(async () => {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    delete process.env.PIE_XIS_GIT_COUNT;
    delete process.env.PIE_XIS_GIT_STARTED;
    delete process.env.PIE_XIS_GIT_EXITED;
    delete process.env.PIE_XIS_GIT_UNEXPECTED;
    await rm(root, { recursive: true, force: true });
  });

  const value = createFooterGitTracker(root, () => assert.fail("disposed collection notified"));
  value.refresh();
  await eventually(() => existsSync(started), "fake Git never reached its second command");
  value.dispose();
  await eventually(() => existsSync(exited), "fake Git was not terminated");
  assert.equal(existsSync(unexpected), false);
});

test("Git footer tracker handles clean, detached, unavailable, throttled, and disposed states", async (t) => {
  const cwd = await repository(t);
  const tracked = tracker(cwd);
  t.after(() => tracked.value.dispose());
  tracked.value.refresh();
  await eventually(() => tracked.value.getStats()?.dirty === false);
  assert.deepEqual(tracked.value.getStats(), {
    branch: (await git(cwd, "branch", "--show-current")).trim(), dirty: false, added: 0, removed: 0
  });

  await git(cwd, "checkout", "--detach", "-q");
  tracked.value.refresh();
  await eventually(() => tracked.value.getStats()?.branch?.length === 7);
  assert.equal(tracked.value.getStats()?.dirty, false);

  await writeFile(join(cwd, "base.txt"), "new\n");
  tracked.value.refresh();
  tracked.value.refresh();
  await eventually(() => tracked.value.getStats()?.added === 1 && tracked.value.getStats()?.removed === 2,
    "coalesced refresh did not collect the newest worktree");

  await git(cwd, "checkout", "--", "base.txt");
  tracked.value.refresh();
  await eventually(() => tracked.value.getStats()?.dirty === false && tracked.value.getStats()?.added === 0 &&
    tracked.value.getStats()?.removed === 0, "clean refresh did not clear tracked totals");

  const nonRepository = await mkdtemp(join(tmpdir(), "piexis-ui-git-non-repository-"));
  t.after(() => rm(nonRepository, { recursive: true, force: true }));
  const unavailable = tracker(nonRepository);
  t.after(() => unavailable.value.dispose());
  unavailable.value.refresh();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(unavailable.value.getStats(), undefined);
  assert.equal(unavailable.changes(), 0);

  const disposed = tracker(cwd);
  disposed.value.refresh();
  disposed.value.dispose();
  assert.equal(disposed.changes(), 0);
  assert.equal(disposed.value.getStats(), undefined);
});
