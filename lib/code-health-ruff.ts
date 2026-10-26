import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import type { HealthFinding, HealthSource } from "./code-health-analysis.ts";
import { isHealthPath } from "./code-health-files.ts";

const RULES = "C901,PLR0911,PLR0912,PLR0913,PLR0915,F401,F841";
interface RuffResult { findings: HealthFinding[]; text?: string; available: boolean; error?: string }
interface Execution { stdout: string; code: number; unavailable?: boolean; error?: string }

function execute(cwd: string, args: string[], text: string, signal?: AbortSignal): Promise<Execution> {
  if (signal?.aborted) return Promise.resolve({ stdout: "", code: -1, error: "Ruff operation cancelled." });
  return new Promise((resolve) => {
    const child = execFile("ruff", args, { cwd, encoding: "utf8", timeout: 10_000, maxBuffer: 2 * 1024 * 1024, signal }, (error, stdout) => {
      if (!error) resolve({ stdout, code: 0 });
      else if (signal?.aborted) resolve({ stdout: "", code: -1, error: "Ruff operation cancelled." });
      else if ((error as NodeJS.ErrnoException).code === "ENOENT") resolve({ stdout: "", code: -1, unavailable: true, error: "Optional Ruff executable is unavailable." });
      else if ((error as unknown as { code: unknown }).code === 1) resolve({ stdout, code: 1 });
      else resolve({ stdout: "", code: -1, error: "Ruff failed or exceeded its time/output bound." });
    });
    child.stdin?.on("error", () => { /* Process exit is handled by execFile's callback. */ });
    child.stdin?.end(text);
  });
}

/** Optional process adapter: fixed arguments, stdin only, no project config or writes. */
export async function runRuff(cwd: string, source: HealthSource, operation: "check" | "format", signal?: AbortSignal): Promise<RuffResult> {
  if (!isHealthPath(source.path) || !source.path.endsWith(".py") || Buffer.byteLength(source.text) > 512 * 1024) {
    return { findings: [], available: true, error: "Ruff requires a bounded Python source with a safe relative path." };
  }
  const args = operation === "check"
    ? ["check", "--isolated", "--no-cache", "--output-format", "json", "--select", RULES, "--stdin-filename", source.path, "-"]
    : ["format", "--isolated", "--no-cache", "--stdin-filename", source.path, "-"];
  const result = await execute(cwd, args, source.text, signal);
  if (result.error) return { findings: [], available: !result.unavailable, error: result.error };
  if (operation === "format") {
    if (result.code !== 0 || Buffer.byteLength(result.stdout) > 512 * 1024) return { findings: [], available: true, error: "Ruff formatting failed or returned oversized output." };
    const validation = await execute(cwd, ["check", "--isolated", "--no-cache", "--output-format", "json", "--select", "E9,F63,F7,F82", "--stdin-filename", source.path, "-"], result.stdout, signal);
    if (validation.error || validation.code !== 0) return { findings: [], available: !validation.unavailable, error: validation.error ?? "Formatted output failed Ruff syntax validation." };
    try {
      const diagnostics: unknown = JSON.parse(validation.stdout);
      if (!Array.isArray(diagnostics) || diagnostics.length) throw new Error("diagnostics");
    } catch { return { findings: [], available: true, error: "Ruff syntax validation returned invalid diagnostics." }; }
    return { findings: [], text: result.stdout, available: true };
  }
  try {
    const diagnostics: unknown = JSON.parse(result.stdout);
    if (!Array.isArray(diagnostics)) throw new Error("diagnostics");
    const findings: HealthFinding[] = [];
    const lineCount = source.text.split("\n").length;
    for (const item of diagnostics.slice(0, 100)) {
      if (!item || typeof item !== "object") continue;
      const { code, message, location } = item as { code?: unknown; message?: unknown; location?: { row?: unknown } };
      if (typeof code !== "string" || !RULES.split(",").includes(code) || typeof message !== "string" || !Number.isInteger(location?.row) || (location!.row as number) < 1 || (location!.row as number) > lineCount) continue;
      const line = location!.row as number;
      const evidence = `${code}: ${message.replace(/[\r\n\x00-\x1f\x7f]/g, " ")}`.slice(0, 200);
      findings.push({
        id: createHash("sha256").update(`${source.path}\0${line}\0ruff\0${code}`).digest("hex").slice(0, 20),
        file: source.path, line, category: `ruff-${code}`, severity: "warning", confidence: "high", evidence,
        suggestion: "Review this Ruff diagnostic in context. Preserve Python decorators, generators and context-manager behavior; no automatic structural change is applied.",
      });
      if (findings.length >= 12) break;
    }
    return { findings, available: true };
  } catch { return { findings: [], available: true, error: "Ruff returned invalid JSON diagnostics." }; }
}
