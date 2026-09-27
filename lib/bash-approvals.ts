import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { parseBash } from "./bash-policy.ts";
import { resolveWorkspaceRoot } from "./path-policy.ts";

// Only configurations whose Git status effects we understand are reusable.
const CONFIG_KEYS: Record<string, Set<string>> = {
  core: new Set(["repositoryformatversion", "filemode", "bare", "logallrefupdates", "ignorecase", "precomposeunicode"]),
  user: new Set(["name", "email"]),
  remote: new Set(["url", "fetch"]),
  branch: new Set(["remote", "merge", "rebase"])
};
function inertGitConfig(text: string): boolean {
  let section = "";
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    if (line.includes("\\")) return false;
    const header = line.match(/^\[([A-Za-z]+)(?:\s+"[^"\n]*")?\]$/);
    if (header) { section = header[1]!.toLowerCase(); if (!CONFIG_KEYS[section]) return false; continue; }
    const field = line.match(/^([A-Za-z][A-Za-z0-9]*)\s*=/);
    if (!field || !CONFIG_KEYS[section]?.has(field[1]!.toLowerCase())) return false;
  }
  return true;
}

/** Fingerprint for the deliberately tiny reusable execution grammar (Git status).
 * Unknown configs, linked worktrees, shell startup overrides, scripts, or missing
 * dependencies decline reuse. No config contents are sent to a model or persisted.
 * Assumes a trusted shell/Git installation; this is not process containment.
 */
export async function bashApprovalFingerprint(
  command: string,
  cwd: string,
  workspaceRoot: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<string | undefined> {
  if (!parseBash(command).grantFamily || process.platform === "win32") return undefined;
  if (env.BASH_ENV || env.ENV || env.SHELLOPTS || env.BASHOPTS || env.PS4 || env.GIT_DIR || env.GIT_WORK_TREE || env.GIT_COMMON_DIR || env.GIT_CONFIG ||
    Object.keys(env).some((key) => key.startsWith("BASH_FUNC_") || key.startsWith("GIT_CONFIG_") &&
      !["GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM"].includes(key))) return undefined;
  try {
    const root = await realpath(workspaceRoot);
    const directory = await realpath(cwd);
    if (await resolveWorkspaceRoot(directory) !== root) return undefined;
    if (!(await lstat(join(root, ".git"))).isDirectory()) return undefined;
    try { await lstat(join(root, ".git", "commondir")); return undefined; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined; }
    const digest = createHash("sha256").update("piexis-shell-grant-v1\0").update(root).update(directory);
    // Bind executable lookup and relevant shell/Git environment without disclosure.
    digest.update(JSON.stringify(Object.entries(env).filter(([key]) =>
      /^(PATH|HOME|SHELL|SHELLOPTS|BASHOPTS|CDPATH|GIT_.*|XDG_CONFIG_HOME|PAGER|PI_PERMISSION_CLASSIFIER)$/.test(key)).sort()));
    let executableFound = false;
    for (const dir of (env.PATH ?? "").split(delimiter)) {
      if (!dir.startsWith("/")) return undefined;
      const candidate = join(dir, "git");
      try {
        const path = await realpath(candidate);
        const stat = await lstat(path, { bigint: true });
        if (!stat.isFile() || !(stat.mode & 0o111n)) return undefined;
        const file = await open(path, "r");
        try {
          const magic = Buffer.alloc(4);
          await file.read(magic, 0, 4, 0);
          // Reject shell-script wrappers named git. ELF and common Mach-O formats.
          if (!["7f454c46", "cffaedfe", "feedfacf", "cafebabe"].includes(magic.toString("hex"))) return undefined;
        } finally { await file.close(); }
        digest.update(`${path}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`);
        executableFound = true;
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
      }
    }
    if (!executableFound) return undefined;
    const home = env.HOME ?? homedir();
    const files: [string, boolean][] = [
      [join(root, ".git", "config"), true], [join(root, ".git", "config.worktree"), true],
      [join(root, CONFIG_DIR_NAME, "settings.json"), false],
      [join(root, CONFIG_DIR_NAME, "permission-modes.json"), false],
      [join(directory, CONFIG_DIR_NAME, "settings.json"), false],
      [join(directory, CONFIG_DIR_NAME, "permission-modes.json"), false]
    ];
    if (!["1", "true", "yes", "on"].includes(env.GIT_CONFIG_NOSYSTEM?.toLowerCase() ?? "")) files.push([env.GIT_CONFIG_SYSTEM ?? "/etc/gitconfig", true]);
    if (env.GIT_CONFIG_GLOBAL) files.push([env.GIT_CONFIG_GLOBAL, true]);
    else files.push([join(home, ".gitconfig"), true], [join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "git", "config"), true]);
    for (const [path, git] of files) {
      if (!isAbsolute(path)) return undefined;
      digest.update(path);
      try {
        const stat = await lstat(path);
        if (!stat.isFile() || stat.size > 64000) return undefined;
        const file = await open(path, "r");
        let text: string;
        try {
          const buffer = Buffer.alloc(64001);
          const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
          if (bytesRead > 64000) return undefined;
          text = buffer.subarray(0, bytesRead).toString("utf8");
        } finally { await file.close(); }
        if (git && !inertGitConfig(text)) return undefined;
        digest.update(text);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
        digest.update("<missing>");
      }
    }
    return digest.digest("hex");
  } catch { return undefined; }
}
