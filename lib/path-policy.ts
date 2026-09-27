import { lstat, opendir, realpath } from "node:fs/promises";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const PATH_TOOLS = new Set(["read", "grep", "find", "glob", "ls", "edit", "write"]);
const REQUIRED_PATH_TOOLS = new Set(["read", "edit", "write"]);
const SENSITIVE_NAMES = new Set([".npmrc", ".netrc", ".pypirc", "credentials", "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519"]);
const SENSITIVE_DIRECTORIES = new Set([".ssh", ".aws", ".gnupg", ".azure", ".kube"]);
const RECURSIVE_TOOLS = new Set(["grep", "find", "glob"]);
const MUTATING_TOOLS = new Set(["edit", "write"]);
export type PathCategory = "credentials" | "git-internals" | "permission-config";

export type PathPolicyResult =
  | { decision: "allow"; reason: "project-local-ordinary-path"; path: string; directory: string; scope: "project" }
  | { decision: "review"; reason: "outside-project" | "sensitive-path" | "protected-config" | "recursive-boundary"; path: string; directory: string; scope: "external" | "sensitive"; category?: PathCategory }
  | { decision: "deny"; reason: "malformed-path" | "unresolvable-path" };

function isMissing(error: unknown) {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

// Match Pi's built-in path spelling conventions before applying policy.
function expandToolPath(value: string) {
  value = value.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ");
  if (value.startsWith("@")) value = value.slice(1);
  if (process.platform === "win32" && !value.includes("\\")) {
    const drive = value.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
    if (drive) value = `${drive[1]!.toUpperCase()}:\\${(drive[2] ?? "").replaceAll("/", "\\")}`;
  }
  if (value === "~") return homedir();
  if (value.startsWith("~/") || (sep === "\\" && value.startsWith("~\\")))
    return join(homedir(), value.slice(2));
  return value.startsWith("file://") ? fileURLToPath(value) : value;
}

async function readPathVariant(path: string): Promise<string> {
  const nfd = path.normalize("NFD");
  const candidates = [path, path.replace(/ (AM|PM)\./gi, "\u202F$1."), nfd,
    path.replace(/'/g, "\u2019"), nfd.replace(/'/g, "\u2019")];
  for (const candidate of candidates) {
    try { await lstat(candidate); return candidate; }
    catch (error) { if (!isMissing(error)) throw error; }
  }
  return path;
}

function isWithin(child: string, parent: string) {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

async function canonicalizePossiblyMissing(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }

  const missing: string[] = [];
  let candidate = path;
  while (true) {
    try {
      const stat = await lstat(candidate);
      if (stat.isSymbolicLink()) throw new Error("broken symlink");
      return join(await realpath(candidate), ...missing.reverse());
    } catch (error) {
      if (!isMissing(error)) throw error;
      const parent = dirname(candidate);
      if (parent === candidate) throw error;
      missing.push(basename(candidate));
      candidate = parent;
    }
  }
}

/** Return the canonical Git root when cwd is in a repository, otherwise cwd. */
export async function resolveWorkspaceRoot(cwd: string): Promise<string> {
  let current = await realpath(cwd);
  while (true) {
    try {
      await lstat(join(current, ".git"));
      return current;
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    const parent = dirname(current);
    if (parent === current) return await realpath(cwd);
    current = parent;
  }
}

function toolPath(tool: string, input: unknown, cwd: string): string | undefined {
  if (!PATH_TOOLS.has(tool)) return undefined;
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const value = (input as { path?: unknown }).path;
  if (value === undefined && !REQUIRED_PATH_TOOLS.has(tool)) return cwd;
  return typeof value === "string" && value.trim() ? value : undefined;
}

function pathCategory(path: string, mutating: boolean): PathCategory | undefined {
  const parts = normalize(path).split(sep).filter(Boolean).map((part) => part.toLowerCase());
  if (parts.some((part) =>
    SENSITIVE_DIRECTORIES.has(part) || SENSITIVE_NAMES.has(part) || part === ".env" || part.startsWith(".env.") ||
    /^(secrets?|credentials?)\.(json|ya?ml|toml)$/.test(part)
  ) || parts.includes(CONFIG_DIR_NAME.toLowerCase()) && parts.includes("auth.json") ||
    parts.includes(".docker") && parts.includes("config.json") ||
    parts.includes("gcloud") && parts.includes("application_default_credentials.json")) return "credentials";
  if (mutating && parts.includes(".git")) return "git-internals";
  if (mutating && parts.some((part) => part === CONFIG_DIR_NAME.toLowerCase())) return "permission-config";
  return undefined;
}

/** Conservative preflight, not containment. Never read file contents or follow links.
 * A boundary, unreadable directory, or exhausted budget requires explicit approval.
 * We intentionally do not assume tool-specific ignore rules exclude a descendant.
 */
async function hasRecursiveBoundary(path: string): Promise<boolean> {
  let remaining = 2000;
  async function visit(directory: string): Promise<boolean> {
    if (--remaining < 0) return true;
    const stat = await lstat(directory);
    if (stat.isSymbolicLink()) return true;
    if (!stat.isDirectory()) return false;
    for await (const entry of await opendir(directory)) {
      if (--remaining < 0) return true;
      const child = join(directory, entry.name);
      if (pathCategory(child, false) || entry.isSymbolicLink()) return true;
      if (entry.isDirectory() && await visit(child)) return true;
    }
    return false;
  }
  try { return await visit(path); }
  catch { return true; }
}

/**
 * Classify a path-based tool input without treating non-mutating reads as safe.
 * Existing paths and their existing ancestors are canonicalized so symlinks cannot
 * make a lexical project-relative path appear project-local.
 */
export async function evaluatePathPolicy(
  tool: string,
  input: unknown,
  workspaceRoot: string,
  cwd: string = workspaceRoot
): Promise<PathPolicyResult | undefined> {
  if (!PATH_TOOLS.has(tool)) return undefined;
  const requested = toolPath(tool, input, cwd);
  if (!requested) return { decision: "deny", reason: "malformed-path" };

  let lexicalPath: string;
  let path: string;
  try {
    lexicalPath = resolve(cwd, expandToolPath(requested));
    const target = tool === "read" ? await readPathVariant(lexicalPath) : lexicalPath;
    path = await canonicalizePossiblyMissing(target);
    workspaceRoot = await realpath(workspaceRoot);
  } catch {
    return { decision: "deny", reason: "unresolvable-path" };
  }

  const directory = dirname(path);
  const mutating = MUTATING_TOOLS.has(tool);
  const category = pathCategory(lexicalPath, mutating) ?? pathCategory(path, mutating);
  if (category) {
    const reason = RECURSIVE_TOOLS.has(tool) ? "recursive-boundary"
      : category === "credentials" ? "sensitive-path" : "protected-config";
    return { decision: "review", reason, path, directory, scope: "sensitive", category };
  }
  const external = !isWithin(path, workspaceRoot) || !isWithin(lexicalPath, workspaceRoot);
  if (RECURSIVE_TOOLS.has(tool) && (external || await hasRecursiveBoundary(path)))
    return { decision: "review", reason: "recursive-boundary", path, directory, scope: "sensitive" };
  if (external)
    return { decision: "review", reason: "outside-project", path, directory, scope: "external" };
  return { decision: "allow", reason: "project-local-ordinary-path", path, directory, scope: "project" };
}

export function isProjectPath(path: string, workspaceRoot: string) {
  return isWithin(path, workspaceRoot);
}
