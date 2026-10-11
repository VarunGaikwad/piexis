import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";

const execFileAsync = promisify(execFile);

export async function workspacePath(root: string, candidate: string): Promise<string> {
  if (!candidate || path.isAbsolute(candidate) || candidate.includes("\0")) throw new Error("Invalid workspace path");
  const base = await realpath(root);
  const resolved = path.resolve(base, candidate);
  if (resolved !== base && !resolved.startsWith(`${base}${path.sep}`)) throw new Error("Path escapes workspace");
  const actual = await realpath(resolved);
  if (actual !== base && !actual.startsWith(`${base}${path.sep}`)) throw new Error("Path escapes workspace");
  return actual;
}

export async function git(root: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", root, ...args], { windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
    return stdout;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Git command failed";
    throw new Error(message.includes("not a git repository") ? "This workspace is not a Git repository." : message);
  }
}

export async function gitStatus(root: string) {
  const [branch, porcelain] = await Promise.all([git(root, ["branch", "--show-current"]), git(root, ["status", "--porcelain=v1"])]);
  return {
    branch: branch.trim() || "detached HEAD",
    files: porcelain.split("\n").filter(Boolean).map((line) => ({ status: line.slice(0, 2).trim() || "?", path: line.slice(3) }))
  };
}

export async function gitDiff(root: string, relativePath: string) {
  await workspacePath(root, relativePath);
  return git(root, ["diff", "--no-ext-diff", "--", relativePath]);
}
