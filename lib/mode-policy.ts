import { lstat, realpath, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

export type Mode = "default" | "plan" | "build" | "yolo";
export type ManagedTool = "read" | "grep" | "find" | "ls" | "bash" | "edit" | "write" | "delete_plan";
export const MODES = [
  { id: "default", label: "Default", description: "Confirm each bash/edit/write; reads free" },
  { id: "plan", label: "Plan Mode", description: "Read-only; only plan Markdown may change" },
  { id: "build", label: "Build", description: "Automatic project operations; sandboxed" },
  { id: "yolo", label: "YOLO", description: "No permission checks or sandbox" }
] as const;
export const MANAGED_TOOLS: readonly ManagedTool[] = ["read", "grep", "find", "ls", "bash", "edit", "write", "delete_plan"];
export const PLAN_DENIAL = "Plan Mode is read-only. Switch with /mode build to apply changes.";
export const STATE_VERSION = 2;
export interface ModeSettings { readRoots: string[]; allowedDomains: string[] }
export const DEFAULT_SETTINGS: ModeSettings = { readRoots: [], allowedDomains: [] };

export function parseMode(value: unknown): Mode | undefined {
  return typeof value === "string" ? MODES.find(m => m.id === value.trim().toLowerCase())?.id : undefined;
}
export function parseSettings(value: unknown, cwd: string): ModeSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Permission settings must be an object");
  const data = value as Record<string, unknown>;
  if (Object.keys(data).some(k => !["readRoots", "allowedDomains"].includes(k))) throw new Error("Unknown permission setting (sandbox bypass options are not supported)");
  for (const key of ["readRoots", "allowedDomains"]) {
    if (data[key] !== undefined && (!Array.isArray(data[key]) || data[key].some(v => typeof v !== "string" || !v.trim() || v.includes("\0")))) {
      throw new Error(`${key} must be an array of nonempty strings`);
    }
  }
  return {
    readRoots: ((data.readRoots ?? []) as string[]).map(p => resolveToolPath(p, cwd)),
    allowedDomains: [...((data.allowedDomains ?? []) as string[])]
  };
}
export function policyPrompt(mode: Mode): string {
  const common = "Only the user can change permission modes with /mode. Never use another tool or subagent to bypass a denial. ";
  const text: Record<Mode, string> = {
    default: "Every bash, edit, write, or plan deletion needs explicit per-call dialog approval. Reads/searches do not prompt. All operations obey the sandbox and protected paths.",
    plan: `${PLAN_DENIAL} Use write/edit only for ${CONFIG_DIR_NAME}/plans/*.md (direct children). Use delete_plan for plan deletion; bash cannot modify even plan files. Present the finished plan and ask the user to switch to Build. Shell networking is disabled.`,
    build: "Project operations run without approval dialogs. Bash stays sandboxed. Outside-project writes and protected targets are denied, not offered for approval.",
    yolo: "Permission dialogs, sandboxing, and this extension's protected-path backstop are disabled. Normal OS permissions and tool errors still apply."
  };
  return `## Permission mode: ${MODES.find(m => m.id === mode)!.label}\n${common}${text[mode]}`;
}
export function permission(mode: Mode, tool: ManagedTool, planFile = false): "allow" | "confirm" | "deny" {
  if (mode === "yolo") return "allow";
  const mutation = ["write", "edit", "delete_plan"].includes(tool);
  if (mode === "plan" && mutation && !planFile) return "deny";
  return mode === "default" && (mutation || tool === "bash") ? "confirm" : "allow";
}

export const SECRET_GLOBS = [
  ".env", ".env.*", "*.env", "*.pem", "*.key", "*.p12", "*.pfx", "*.jks", "id_rsa*", "id_ed25519*",
  "id_ecdsa*", "id_dsa*", ".npmrc", ".netrc", ".pypirc", "credentials", "credentials.*", "secrets", "secrets.*", ".ssh", ".aws", ".gnupg"
];
const secretPatterns = SECRET_GLOBS.map(glob => new RegExp(`^${glob.split("*").map(p => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "i"));
export function isSecretPath(path: string): boolean {
  const parts = path.split(/[\\/]/);
  return parts.some(p => secretPatterns.some(re => re.test(p))) ||
    within(resolve(path), join(getAgentDir(), "sessions")) || resolve(path) === join(getAgentDir(), "auth.json");
}
// These files are executed by the trusted host launcher on every invocation.
// Letting sandboxed code replace them would turn the next invocation into an escape.
const implementationRoot = dirname(dirname(fileURLToPath(import.meta.url)));
export const IMPLEMENTATION_WRITE_DENIES = [
  join(implementationRoot, "lib"), join(implementationRoot, "extensions", "mode.ts"),
  join(implementationRoot, "node_modules"), join(implementationRoot, "package.json"), join(implementationRoot, "package-lock.json")
];
const dangerousNames = new Set([".bashrc", ".bash_profile", ".zshrc", ".zprofile", ".profile", ".gitconfig", ".gitmodules", ".ripgreprc", ".mcp.json", ".vscode", ".idea"]);
export function protectedWrite(path: string): boolean {
  const parts = path.toLowerCase().split(/[\\/]/);
  return IMPLEMENTATION_WRITE_DENIES.some(p => within(resolve(path), p)) || isSecretPath(path) || parts.some(p => dangerousNames.has(p) || p === CONFIG_DIR_NAME.toLowerCase()) ||
    parts.some((p, i) => p === ".git" && ["hooks", "config", "config.lock"].includes(parts[i + 1]));
}
export function within(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
export function resolveToolPath(path: string, cwd: string): string {
  let value = path.replace(/^@/, "");
  if (value.startsWith("file:")) value = fileURLToPath(value);
  if (value === "~" || value.startsWith("~/")) value = homedir() + value.slice(1);
  if (!value || value.includes("\0")) throw new Error("Invalid path");
  return resolve(cwd, value);
}
export async function canonical(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    // A dangling symlink must not be treated as a new file.
    try { if ((await lstat(path)).isSymbolicLink()) throw new Error("Unresolvable symlink"); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(await canonical(parent), basename(path));
  }
}
export function plansDirectory(root: string): string { return join(root, CONFIG_DIR_NAME, "plans"); }
export function isPlanFile(path: string, root: string): boolean {
  return dirname(path) === plansDirectory(root) && /^[^./][^/]*\.md$/.test(basename(path));
}
export async function validateTarget(mode: Mode, tool: ManagedTool, input: Record<string, unknown>, root: string, settings: ModeSettings): Promise<string | undefined> {
  if (tool === "bash") {
    if (typeof input.command !== "string" || !input.command.trim()) throw new Error("Missing bash command");
    return;
  }
  const raw = input.path ?? (["grep", "find", "ls"].includes(tool) ? "." : undefined);
  if (typeof raw !== "string") throw new Error("Missing path");
  const absolute = resolveToolPath(raw, root);
  const actual = await canonical(absolute);
  const mutation = ["write", "edit", "delete_plan"].includes(tool);
  const planFile = isPlanFile(absolute, root) && isPlanFile(actual, root);
  if (tool === "delete_plan" && !planFile) throw new Error("delete_plan only deletes designated plan Markdown files");
  if (permission(mode, tool, planFile) === "deny") throw new Error(PLAN_DENIAL);
  const roots = mutation ? [root] : [root, ...await Promise.all(settings.readRoots.map(canonical))];
  if (!roots.some(r => within(actual, r))) throw new Error(`Outside allowed ${mutation ? "write" : "read"} roots: ${raw}`);
  if (isSecretPath(absolute) || isSecretPath(actual)) throw new Error(`Protected read path: ${raw}`);
  if (mutation && !planFile && (protectedWrite(absolute) || protectedWrite(actual))) throw new Error(`Protected write path: ${raw}`);
  if (mutation && absolute !== actual) throw new Error("Mutation through symlinks is not allowed");
  try {
    const info = await lstat(actual);
    if (info.isSymbolicLink() || (!info.isFile() && !(["ls", "find", "grep"].includes(tool) && info.isDirectory()))) throw new Error("Target must be a regular file or search directory");
    if (info.isFile() && info.nlink > 1) throw new Error("Multiply-linked files are protected");
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return actual;
}

/** Concrete paths, not Linux write-deny globs. Never follow directory symlinks. */
export async function protectedProjectPaths(root: string): Promise<{ read: string[]; write: string[] }> {
  const read: string[] = [];
  const write = [join(root, CONFIG_DIR_NAME), join(root, ".env"), join(root, ".git", "hooks"), join(root, ".git", "config"), ...IMPLEMENTATION_WRITE_DENIES];
  let visited = 0;
  async function walk(directory: string, protectedAncestor = false): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (++visited > 250_000) throw new Error("Project too large to safely enumerate protected paths");
      const path = join(directory, entry.name);
      const info = await lstat(path);
      if (isSecretPath(path) || (info.isFile() && info.nlink > 1)) {
        read.push(path);
        if (!protectedAncestor) write.push(path);
        continue;
      }
      const deniedWrite = protectedWrite(path);
      if (deniedWrite && !protectedAncestor) write.push(path);
      if (info.isDirectory()) await walk(path, protectedAncestor || deniedWrite);
    }
  }
  await walk(root);
  return { read, write: [...new Set(write)] };
}
