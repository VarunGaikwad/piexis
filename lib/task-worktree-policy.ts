import { taskGit, disabledTaskFilters } from "./task-git.ts";
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

export type RecordedWorktree = { id: string; repository?: string; worktree?: string };

type Marker = { version: 1; id: string; repository: string; worktree: string };

function isWithin(child: string, parent: string) {
  const value = relative(parent, child);
  return value === "" || (!value.startsWith("..") && !isAbsolute(value));
}

async function git(args: string[], cwd: string): Promise<string> {
  return (await taskGit(args, cwd)).trim();
}

async function commonGitDir(cwd: string) {
  const value = await git(["rev-parse", "--git-common-dir"], cwd);
  return realpath(isAbsolute(value) ? value : resolve(cwd, value));
}

export async function createWorktreeMarker(parent: string, task: Required<RecordedWorktree>) {
  const marker: Marker = { version: 1, id: task.id, repository: await realpath(task.repository), worktree: task.worktree };
  await writeFile(`${parent}/.piexis-task.json`, `${JSON.stringify(marker)}\n`, { mode: 0o600, flag: "wx" });
}

/** Reject corrupt metadata before any destructive worktree cleanup. */
export async function validateTaskWorktree(task: RecordedWorktree): Promise<{ worktree: string; parent: string; dirty: boolean }> {
  if (!task.worktree || !task.repository) throw new Error("Task has no recorded repository worktree.");
  const parent = dirname(task.worktree);
  if (basename(task.worktree) !== "worktree" || !basename(parent).startsWith("piexis-task-"))
    throw new Error("Refusing to clean a worktree not created by Piexis.");
  const [canonicalTmp, canonicalParent, canonicalRepository] = await Promise.all([realpath(tmpdir()), realpath(parent), realpath(task.repository)]);
  if (!isWithin(canonicalParent, canonicalTmp)) throw new Error("Refusing to clean a worktree outside the system temporary directory.");
  const markerPath = `${canonicalParent}/.piexis-task.json`;
  let marker: Marker;
  try { marker = JSON.parse(await readFile(markerPath, "utf8")); }
  catch { throw new Error("Refusing to clean a worktree without a valid Piexis marker."); }
  if (marker.version !== 1 || marker.id !== task.id || marker.worktree !== task.worktree || marker.repository !== canonicalRepository)
    throw new Error("Refusing to clean a worktree whose Piexis marker does not match task metadata.");
  const stat = await lstat(task.worktree);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Recorded worktree is not a normal directory.");
  const worktree = await realpath(task.worktree);
  if (worktree !== resolve(canonicalParent, "worktree")) throw new Error("Recorded worktree path does not match its Piexis task directory.");
  const [topLevel, taskGitDir, repositoryGitDir] = await Promise.all([
    git(["rev-parse", "--show-toplevel"], worktree).then(realpath),
    commonGitDir(worktree),
    commonGitDir(canonicalRepository)
  ]);
  if (topLevel !== worktree || taskGitDir !== repositoryGitDir)
    throw new Error("Recorded path is not a Git worktree associated with the expected repository.");
  const dirty = Boolean(await git([...await disabledTaskFilters(worktree), "status", "--porcelain"], worktree));
  return { worktree, parent: canonicalParent, dirty };
}
