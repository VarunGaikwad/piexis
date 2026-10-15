import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

type IgnoreRule = { pattern: string; ignored: boolean; directory: boolean; anchored: boolean; base: string };

function glob(pattern: string): RegExp {
  let text = "^";
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index];
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        index++;
        if (pattern[index + 1] === "/") { index++; text += "(?:.*/)?"; }
        else text += ".*";
      } else text += "[^/]*";
    } else if (character === "?") text += "[^/]";
    else text += character.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  }
  return new RegExp(`${text}$`);
}

function parse(text: string, base: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (let line of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("\\#") || line.startsWith("\\!")) line = line.slice(1);
    let ignored = true;
    if (line.startsWith("!")) { ignored = false; line = line.slice(1); }
    const directory = line.endsWith("/");
    if (directory) line = line.slice(0, -1);
    const anchored = line.startsWith("/");
    if (anchored) line = line.slice(1);
    if (line) rules.push({ pattern: line, ignored, directory, anchored, base });
  }
  return rules;
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function matches(rule: IgnoreRule, root: string, path: string, directory: boolean): boolean {
  if (!isWithin(rule.base, path)) return false;
  const relativePath = relative(rule.base, path).split(sep).join("/");
  const targets = rule.directory ? relativePath.split("/").map((_, index, parts) => parts.slice(0, index + 1).join("/")) : [relativePath];
  return targets.some((target) => {
    if (rule.directory && !directory && target === relativePath) return false;
    const candidate = rule.anchored || rule.pattern.includes("/") ? target : basename(target);
    return glob(rule.pattern).test(candidate);
  });
}

async function ignoreRules(root: string, target: string, name: ".gitignore" | ".claudeignore"): Promise<IgnoreRule[]> {
  const rules: IgnoreRule[] = [];
  let directory = root;
  const last = dirname(target);
  while (isWithin(root, directory)) {
    try { rules.push(...parse(await readFile(resolve(directory, name), "utf8"), directory)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (directory === last) break;
    const next = resolve(directory, relative(directory, last).split(sep)[0] ?? "");
    if (next === directory) break;
    directory = next;
  }
  return rules;
}

async function directoryAt(path: string): Promise<boolean> {
  try { return (await lstat(path)).isDirectory(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

/** Best-effort project access policy for Pi file tools. It is not a sandbox. */
export async function deniedPath(cwd: string, requested: string, mode: "read" | "write" = "write"): Promise<string | undefined> {
  const root = await realpath(cwd);
  const absolute = resolve(root, requested);
  if (mode === "write" && !isWithin(root, absolute)) return "outside the project";
  let canonical = absolute;
  try {
    canonical = await realpath(absolute);
    if (mode === "write" && !isWithin(root, canonical)) return "symlink escapes the project";
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if ([absolute, canonical].some((path) => path.split(sep).some((part) => part === ".env" || part.startsWith(".env.")))) return "environment files are protected";
  // External documentation and installed Pi resources must remain readable.
  if (!isWithin(root, absolute)) return undefined;
  const directory = await directoryAt(absolute);
  for (const name of [".gitignore", ".claudeignore"] as const) {
    let ignored = false;
    for (const rule of await ignoreRules(root, absolute, name)) {
      if (matches(rule, root, absolute, directory)) ignored = rule.ignored;
    }
    if (ignored) return `matched ${name}`;
  }
  return undefined;
}

/** Reject obvious environment-inspection commands. Arbitrary shell execution remains bypassable. */
export function blockedBashReason(command: string): string | undefined {
  return /(?:\b(?:printenv|env|set)\b|\/(?:proc|sys)\/[^\s]*environ\b|\bprocess\.env\b|\bos\.environ\b|\$\{?[A-Za-z_][A-Za-z0-9_]*\}?)/.test(command)
    ? "environment inspection is disabled" : undefined;
}
