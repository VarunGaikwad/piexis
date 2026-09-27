import { chmod, mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { isProjectPath } from "./path-policy.ts";
import { taskGit, taskGitBytes } from "./task-git.ts";

/** Materialize raw Git blobs after worktree add --no-checkout. This intentionally
 * skips repository hooks and smudge/process filters (including Git LFS hydration).
 */
export async function checkoutTaskFiles(root: string, base: string): Promise<void> {
  const tree = (await taskGit(["ls-tree", "-rz", "--full-tree", base], root)).split("\0").filter(Boolean);
  if (tree.length > 10000) throw new Error("Task checkout exceeds the file budget.");
  let total = 0;
  for (const entry of tree) {
    const tab = entry.indexOf("\t");
    const [mode, type, oid] = entry.slice(0, tab).split(" ");
    const path = entry.slice(tab + 1);
    if (tab < 0 || type !== "blob" || !["100644", "100755", "120000"].includes(mode) || isAbsolute(path) ||
      path.includes("\\") || path.includes("\ufffd") || path.split("/").some((part) => !part || part === ".." || part.toLowerCase() === ".git"))
      throw new Error("Task checkout contains unsupported submodules or unsafe paths.");
    const target = join(root, path);
    let ancestor = dirname(target);
    while (true) {
      try {
        if (!isProjectPath(await realpath(ancestor), root)) throw new Error("Task checkout escapes its worktree.");
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(ancestor) === ancestor) throw error;
        ancestor = dirname(ancestor);
      }
    }
    await mkdir(dirname(target), { recursive: true });
    const bytes = await taskGitBytes(["cat-file", "blob", oid], root, { maxBytes: 4 * 1024 * 1024 });
    total += bytes.length;
    if (total > 128 * 1024 * 1024) throw new Error("Task checkout exceeds its byte budget.");
    if (mode === "120000") await symlink(bytes.toString("utf8"), target);
    else { await writeFile(target, bytes, { flag: "wx" }); if (mode === "100755") await chmod(target, 0o755); }
  }
  await taskGit(["read-tree", base], root);
}
