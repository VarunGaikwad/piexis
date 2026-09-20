import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { promisify } from "node:util";
import { createGrepToolDefinition, createFindToolDefinition, truncateHead } from "@earendil-works/pi-coding-agent";
import { SECRET_GLOBS } from "./mode-policy.ts";

const exec = promisify(execFile);

/** Reuse required ripgrep instead of letting Pi download fd inside a read-only worker. */
export function createProtectedFind(root: string): ReturnType<typeof createFindToolDefinition> {
  return createFindToolDefinition(root, { operations: {
    exists: async path => { try { await stat(path); return true; } catch { return false; } },
    glob: async (pattern, cwd, options) => {
      const args = ["--files", "--hidden", "--no-config", "--no-follow", "--glob", pattern];
      for (const glob of [...options.ignore, ...SECRET_GLOBS]) args.push("--iglob", `!${glob}`);
      args.push("--", cwd);
      try {
        const { stdout } = await exec("rg", args, { timeout: 30_000, maxBuffer: 5 * 1024 * 1024 });
        return stdout.split("\n").filter(Boolean).slice(0, Math.max(1, options.limit));
      } catch (error) {
        if ((error as { code?: number }).code === 1) return [];
        throw error;
      }
    }
  } });
}
/** Used only inside the sandbox worker. YOLO uses Pi's native grep instead. */
export function createProtectedGrep(root: string): ReturnType<typeof createGrepToolDefinition> {
  const base = createGrepToolDefinition(root);
  return {
    ...base,
    description: `${base.description} Protected searches exclude credential filenames and do not follow symlinks.`,
    async execute(_id, input, signal) {
      const path = input.path ?? root;
      const directory = (await stat(path)).isDirectory();
      const limit = Math.max(1, Math.floor(input.limit ?? 100));
      const args = ["--no-config", "--no-follow", "--json", "--color=never", "--hidden", "--max-count", String(limit)];
      if (input.ignoreCase) args.push("--ignore-case");
      if (input.literal) args.push("--fixed-strings");
      if (input.context && input.context > 0) args.push("--context", String(Math.min(input.context, 100)));
      if (input.glob) args.push("--glob", input.glob);
      // Last glob wins, so the caller cannot re-include credential files.
      if (directory) for (const glob of SECRET_GLOBS) args.push("--iglob", `!${glob}`);
      args.push("--", input.pattern, path);
      let stdout: string;
      let capped = false;
      try { ({ stdout } = await exec("rg", args, { signal, timeout: 30_000, maxBuffer: 5 * 1024 * 1024 })); }
      catch (error) {
        const e = error as Error & { code?: number | string; stdout?: string; stderr?: string };
        if (e.code === 1) stdout = e.stdout ?? "";
        else if (e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") { stdout = e.stdout ?? ""; capped = true; }
        else throw new Error(e.stderr || e.message);
      }
      const lines: string[] = [];
      let matches = 0;
      const records = stdout.split("\n");
      if (capped) records.pop(); // A buffer cap may split the final JSON record.
      for (const line of records) {
        if (!line) continue;
        const event = JSON.parse(line);
        if (event.type !== "match" && event.type !== "context") continue;
        if (event.type === "match" && ++matches > limit) { capped = true; break; }
        const data = event.data;
        const separator = event.type === "match" ? ":" : "-";
        lines.push(`${data.path.text ?? "(non-UTF8 path)"}${separator}${data.line_number}${separator}${(data.lines.text ?? "(binary)").replace(/\r?\n$/, "")}`);
      }
      const truncation = truncateHead(lines.join("\n") || "No matches found");
      return {
        content: [{ type: "text", text: truncation.content + (capped || truncation.truncated ? "\n[Output limited; narrow the search.]" : "") }],
        details: { ...(truncation.truncated ? { truncation } : {}), ...(matches > limit ? { matchLimitReached: limit } : {}) }
      };
    }
  };
}
