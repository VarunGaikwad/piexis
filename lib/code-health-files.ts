import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { devNull } from "node:os";
import { isAbsolute, matchesGlob, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { deniedPath } from "./access-policy.ts";
import type { HealthSource } from "./code-health-analysis.ts";

const execute = promisify(execFile);
const MAX_BYTES = 512 * 1024;
const MAX_LINES = 20_000;
const EXCLUDED = /(?:^|\/)(?:\.git|\.pi|\.kilo|node_modules|vendor|bower_components|\.yarn|\.pnpm-store|dist|build|target|out|obj|coverage|\.cache|\.next|\.nuxt|\.svelte-kit|\.venv|venv|__pycache__|generated|migrations?|fixtures?|__fixtures__|\.ssh|\.aws|\.azure|\.gnupg|\.docker|\.kube|secrets?|credentials?)(?:\/|$)|(?:^|\/)(?:\.env(?:\.[^/]*)?|\.envrc|id_rsa|id_ed25519|\.npmrc|\.pypirc|\.netrc|\.git-credentials|\.dockercfg|credentials[^/]*|secrets?\.[^/]*)(?:$)|\.(?:pem|key|p12|pfx|keystore|jks|tfstate(?:\.backup)?|lock|min\.[cm]?js|map)$|(?:^|\/)(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$|(?:\.generated|\.g)\.[^/]+$/i;

/** Lexical prefilter only; reading also checks symlinks, ignore rules and file bounds. */
export function isHealthPath(path: string, exclude: string[] = []): boolean {
  const normalized = path.replaceAll("\\", "/");
  if (!normalized || normalized.includes("\0") || isAbsolute(path) || /^[A-Za-z]:/.test(normalized) || normalized.split("/").some((part) => part === ".." || !part) || EXCLUDED.test(normalized)) return false;
  try {
    return !exclude.some((pattern) => matchesGlob(normalized, pattern) || matchesGlob(normalized, `${pattern.replace(/\/$/, "")}/**`));
  } catch { return false; }
}

async function safePath(cwd: string, path: string, exclude: string[], signal?: AbortSignal): Promise<string | undefined> {
  signal?.throwIfAborted();
  if (!isHealthPath(path, exclude)) return undefined;
  const root = await realpath(cwd);
  const absolute = resolve(root, path);
  const local = relative(root, absolute);
  if (!local || local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local)) return undefined;
  let current = root;
  for (const part of local.split(sep)) {
    signal?.throwIfAborted();
    current = resolve(current, part);
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || (current === absolute && !stat.isFile())) return undefined;
  }
  if (await deniedPath(root, local, "read")) return undefined;
  try {
    // --no-index also excludes tracked files covered by Git ignore rules.
    await git(root, ["check-ignore", "--no-index", "--quiet", "--", local], signal);
    return undefined;
  } catch (error) {
    signal?.throwIfAborted();
    const code = (error as { code?: unknown }).code;
    // No match, no repository, or no Git executable: deniedPath still applies.
    if (code !== 1 && code !== 128 && code !== "ENOENT") return undefined;
    if (code === 128 && !/not a git repository/i.test(String((error as { stderr?: unknown }).stderr))) return undefined;
  }
  return absolute;
}

export async function readHealthSource(cwd: string, path: string, exclude: string[], signal?: AbortSignal): Promise<HealthSource | undefined> {
  try {
    const absolute = await safePath(cwd, path, exclude, signal);
    if (!absolute) return undefined;
    const handle = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_BYTES) return undefined;
      // Bounded read even if a file grows after stat. This is best-effort, not a sandbox.
      const data = Buffer.alloc(MAX_BYTES + 1);
      let total = 0;
      while (total < data.length) {
        signal?.throwIfAborted();
        const { bytesRead } = await handle.read(data, total, data.length - total, total);
        if (!bytesRead) break;
        total += bytesRead;
      }
      signal?.throwIfAborted();
      if (total > MAX_BYTES) return undefined;
      const bytes = data.subarray(0, total);
      if (bytes.includes(0)) return undefined;
      let text: string;
      try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return undefined; }
      if (text.split("\n").length > MAX_LINES || /@generated|automatically generated|do not edit/i.test(text.slice(0, 2048))) return undefined;
      return { path: path.replaceAll("\\", "/").replace(/^\.\//, ""), text, hash: createHash("sha256").update(bytes).digest("hex") };
    } finally { await handle.close(); }
  } catch (error) {
    signal?.throwIfAborted();
    return undefined;
  }
}

async function git(cwd: string, args: string[], signal?: AbortSignal): Promise<string> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  const options = {
    cwd, env: { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: devNull, GIT_TERMINAL_PROMPT: "0" },
    encoding: "utf8" as const, timeout: 5000, maxBuffer: 4 * 1024 * 1024, signal,
  };
  const prefix = [...(["diff", "status", "ls-files"].includes(args[0] ?? "") ? ["--literal-pathspecs"] : []), "--no-pager", "--no-optional-locks", "-c", `core.hooksPath=${devNull}`, "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false"];
  if (["diff", "status"].includes(args[0] ?? "")) {
    // Status/diff may invoke clean/process filters even without external diffs or textconv.
    let keys: string;
    try { keys = (await execute("git", [...prefix, "config", "--null", "--name-only", "--get-regexp", "^filter\\..*\\.(clean|smudge|process|required)$"], options)).stdout; }
    catch (error) { if ((error as { code?: unknown }).code !== 1) throw error; keys = ""; }
    const names = new Set(keys.split("\0").map((key) => /^filter\.(.+)\.(?:clean|smudge|process|required)$/i.exec(key)?.[1]).filter((name): name is string => Boolean(name)));
    for (const name of names) {
      for (const operation of ["clean", "smudge", "process"]) prefix.push("-c", `filter.${name}.${operation}=`);
      prefix.push("-c", `filter.${name}.required=false`);
    }
  }
  const result = await execute("git", [...prefix, ...args], options);
  return result.stdout;
}

/** Path-local status check before edits; prevents claiming later user changes as agent-owned. */
export async function isCleanHealthPath(cwd: string, path: string, signal?: AbortSignal): Promise<boolean> {
  if (!isHealthPath(path)) return false;
  try {
    return (await git(cwd, ["status", "--porcelain=v1", "-z", "--ignore-submodules=all", "--untracked-files=all", "--", path], signal)).length === 0;
  } catch { signal?.throwIfAborted(); return false; }
}

export async function discoverHealthFiles(cwd: string, options: { all?: boolean; paths?: string[]; exclude: string[]; maxFiles: number; signal?: AbortSignal }): Promise<{ paths: string[]; git: boolean; truncated: boolean; notes: string[] }> {
  const result = { paths: [] as string[], git: false, truncated: false, notes: [] as string[] };
  options.signal?.throwIfAborted();
  try { result.git = (await git(cwd, ["rev-parse", "--is-inside-work-tree"], options.signal)).trim() === "true"; }
  catch { options.signal?.throwIfAborted(); }
  let candidates = options.paths ?? [];
  if (!result.git) {
    result.notes.push(options.all ? "Full scans require Git; no directory walk was performed." : "Git unavailable; only explicit paths can be inspected.");
    if (options.all) return result;
  } else if (!options.paths?.length) {
    try {
      if (options.all) {
        candidates = (await git(cwd, ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", "."], options.signal)).split("\0");
      } else {
        const base = ["diff", "--no-ext-diff", "--no-textconv", "--relative", "--ignore-submodules=all", "--name-only", "--diff-filter=ACMRT", "-z"];
        let changed: string;
        try { changed = await git(cwd, [...base, "HEAD", "--", "."], options.signal); }
        catch {
          options.signal?.throwIfAborted();
          result.notes.push("HEAD unavailable; using staged and working changes.");
          changed = await git(cwd, [...base, "--cached", "--", "."], options.signal) + await git(cwd, [...base, "--", "."], options.signal);
        }
        candidates = (changed + await git(cwd, ["ls-files", "--others", "--exclude-standard", "-z", "--", "."], options.signal)).split("\0");
      }
    } catch {
      options.signal?.throwIfAborted();
      result.truncated = true;
      result.notes.push("Git discovery failed or exceeded its time/output bound; results are incomplete.");
      return result;
    }
  }
  const unique = [...new Set(candidates.filter(Boolean))].sort();
  const maxFiles = Number.isFinite(options.maxFiles) ? Math.max(0, Math.min(1000, Math.floor(options.maxFiles))) : 0;
  const bound = 5000;
  if (unique.length > bound) { result.truncated = true; result.notes.push("Candidate inspection stopped at 5000 paths."); }
  let skipped = 0;
  for (const path of unique.slice(0, bound)) {
    options.signal?.throwIfAborted();
    if (!isHealthPath(path, options.exclude)) { skipped++; continue; }
    if (result.paths.length >= maxFiles) { result.truncated = true; break; }
    if (await readHealthSource(cwd, path, options.exclude, options.signal)) result.paths.push(path.replaceAll("\\", "/"));
    else skipped++;
  }
  if (skipped) result.notes.push(`${skipped} protected, ignored, missing, non-text, generated or oversized paths were skipped.`);
  if (result.truncated) result.notes.push("File selection is bounded; findings cover only the selected files.");
  return result;
}
