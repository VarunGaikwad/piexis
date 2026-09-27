import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { createWorktreeMarker, validateTaskWorktree } from "../lib/task-worktree-policy.ts";

const exec = promisify(execFile);

async function git(cwd, ...args) {
  await exec("git", args, { cwd });
}

test("cleanup validation accepts only the recorded Piexis Git worktree", async () => {
  const repository = await mkdtemp(join(tmpdir(), "piexis-repository-"));
  const parent = await mkdtemp(join(tmpdir(), "piexis-task-"));
  const worktree = join(parent, "worktree");
  try {
    await git(repository, "init");
    await git(repository, "config", "user.email", "piexis-test@example.invalid");
    await git(repository, "config", "user.name", "Piexis Test");
    await writeFile(join(repository, "README.md"), "fixture\n");
    await git(repository, "add", "README.md");
    await git(repository, "commit", "-m", "fixture");
    await createWorktreeMarker(parent, { id: "1", repository, worktree });
    await git(repository, "worktree", "add", "--detach", worktree, "HEAD");
    const result = await validateTaskWorktree({ id: "1", repository, worktree });
    assert.equal(result.worktree, worktree);
    assert.equal(result.parent, parent);
    assert.equal(result.dirty, false);
  } finally {
    await git(repository, "worktree", "remove", "--force", worktree).catch(() => undefined);
    await Promise.all([rm(parent, { recursive: true, force: true }), rm(repository, { recursive: true, force: true })]);
  }
});

test("cleanup validation rejects traversal and arbitrary recorded worktree paths", async () => {
  const repository = await mkdtemp(join(tmpdir(), "piexis-repository-"));
  for (const worktree of ["/", "..", "/home/user", repository, join(repository, "worktree")]) {
    await assert.rejects(validateTaskWorktree({ id: "1", repository, worktree }), /Refusing|Task has/);
  }
});

test("cleanup validation rejects a Piexis-looking directory without a marker", async () => {
  const parent = await mkdtemp(join(tmpdir(), "piexis-task-corrupt-"));
  await assert.rejects(
    validateTaskWorktree({ id: "1", repository: parent, worktree: join(parent, "worktree") }),
    /valid Piexis marker|ENOENT/
  );
});
