import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readlink, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { evaluatePathPolicy, isProjectPath } from "./path-policy.ts";
import { taskGit } from "./task-git.ts";

export type TaskPatch = { patch: string; digest: string; changes: { path: string; warnings: string[] }[] };
function validPath(path: string): boolean {
  return Boolean(path) && !isAbsolute(path) && !path.includes("\\") && !path.includes("\ufffd") &&
    !path.split("/").some((part) => part === ".." || part.toLowerCase() === ".git");
}

async function boundedFile(path: string): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size > 4 * 1024 * 1024) throw new Error("Unsupported or oversized task file.");
    const buffer = Buffer.alloc(before.size + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await file.read(buffer, total, buffer.length - total, total);
      if (!bytesRead) break;
      total += bytesRead;
    }
    const after = await file.stat();
    if (total !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs)
      throw new Error("Task file changed during inspection; retry after writes have stopped.");
    return buffer.subarray(0, total);
  } finally { await file.close(); }
}

/** A raw-byte snapshot in temporary index/object storage. Never stage into the
 * real index or write Git objects into the repository, and never run clean filters.
 * Limits are fail-closed; unsupported submodules/special files are not omitted.
 */
export async function inspectTaskPatch(worktree: string, repository: string, base: string): Promise<TaskPatch> {
  if (!/^[a-f0-9]{40,64}$/i.test(base)) throw new Error("Invalid task base revision.");
  const root = await realpath(worktree);
  const tree = await taskGit(["ls-tree", "-rz", "--full-tree", base], root);
  const names = new Set<string>();
  for (const entry of tree.split("\0").filter(Boolean)) {
    const tab = entry.indexOf("\t");
    if (tab < 0 || entry.startsWith("160000 ")) throw new Error("Submodules or malformed tree entries require manual review.");
    names.add(entry.slice(tab + 1));
  }
  for (const args of [["ls-files", "--cached", "-z"], ["ls-files", "--others", "--exclude-standard", "-z"]]) {
    for (const name of (await taskGit(args, root)).split("\0").filter(Boolean)) names.add(name);
  }
  if (names.size > 10000 || [...names].some((name) => !validPath(name))) throw new Error("Task snapshot has too many files or unsafe paths.");
  const temp = await mkdtemp(join(tmpdir(), "piexis-inspect-"));
  try {
    const objects = join(temp, "objects");
    await mkdir(objects);
    const originalObjects = await realpath(resolve(root, (await taskGit(["rev-parse", "--git-path", "objects"], root)).trim()));
    const env = { GIT_INDEX_FILE: join(temp, "index"), GIT_OBJECT_DIRECTORY: objects, GIT_ALTERNATE_OBJECT_DIRECTORIES: originalObjects };
    await taskGit(["read-tree", "--empty"], root, { env });
    let total = 0;
    const entries: string[] = [];
    for (const path of [...names].sort()) {
      const target = join(root, path);
      let stat;
      try { stat = await lstat(target); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error(`Unsupported task file: ${path}`);
      if (stat.size > 4 * 1024 * 1024) throw new Error(`Task file exceeds the 4 MiB snapshot limit: ${path}`);
      // Do not follow a symlinked ancestor or a symlink file outside the worktree.
      if (!isProjectPath(await realpath(join(target, "..")), root)) throw new Error("Task snapshot traverses an external directory.");
      const bytes = stat.isSymbolicLink() ? Buffer.from(await readlink(target)) : await boundedFile(target);
      total += bytes.length;
      if (bytes.length > 4 * 1024 * 1024 || total > 128 * 1024 * 1024) throw new Error("Task snapshot exceeds its byte budget.");
      const oid = (await taskGit(["hash-object", "-w", "--no-filters", "--stdin"], root, { env, input: bytes })).trim();
      const mode = stat.isSymbolicLink() ? "120000" : stat.mode & 0o111 ? "100755" : "100644";
      entries.push(`${mode} ${oid}\t${path}\0`);
    }
    await taskGit(["update-index", "-z", "--index-info"], root, { env, input: entries.join("") });
    const args = ["diff", "--cached", "--no-ext-diff", "--no-textconv", "--no-renames", "--no-color", "--src-prefix=a/", "--dst-prefix=b/"];
    const changed = (await taskGit([...args, "--name-only", "-z", base, "--"], root, { env })).split("\0").filter(Boolean);
    const changes: TaskPatch["changes"] = [];
    for (const path of changed) {
      if (!validPath(path)) throw new Error("Unsafe changed path in task snapshot.");
      const warnings: string[] = [];
      for (const boundary of [root, repository]) {
        const policy = await evaluatePathPolicy("write", { path }, boundary, boundary);
        if (policy?.decision !== "allow") warnings.push(policy?.reason ?? "unknown-path");
      }
      const type = await lstat(join(root, path)).catch(() => undefined);
      if (type?.isSymbolicLink()) warnings.push("symlink-change");
      if (/(^|\/)(AGENTS\.md|CLAUDE\.md|package\.json|Makefile|\.gitattributes|\.gitmodules)$|^\.github\/workflows\//i.test(path))
        warnings.push("execution-or-instruction-configuration");
      changes.push({ path, warnings: [...new Set(warnings)] });
    }
    const patch = await taskGit([...args, "--binary", "--full-index", base, "--"], root, { env });
    return { patch, digest: createHash("sha256").update(patch).digest("hex"), changes };
  } finally { await rm(temp, { recursive: true, force: true }); }
}

export function taskPatchPreview(snapshot: TaskPatch): string {
  if (!snapshot.changes.length) return "No file changes.";
  const summary = snapshot.changes.map((change) => `${JSON.stringify(change.path)}${change.warnings.length ? ` [${change.warnings.join(", ")}]` : ""}`).join("\n");
  const text = snapshot.changes.some((change) => change.warnings.length)
    ? `Patch contents withheld because sensitive, symlink, or configuration changes require explicit review. Inspect these files before applying.\n\n${summary}`
    : `${summary}\n\n${snapshot.patch}`;
  return text.length > 50000 ? `${text.slice(0, 49880)}\n[Patch display truncated; application still requires confirmation of the full snapshot.]` : text;
}
