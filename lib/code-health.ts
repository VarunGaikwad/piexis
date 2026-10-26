import { createHash, randomUUID } from "node:crypto";
import { lstat, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, posix, resolve } from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { analyzeSources, deduplicateFindings, type HealthFinding, type HealthSource } from "./code-health-analysis.ts";
import type { CodeHealthConfig } from "./code-health-config.ts";
import { discoverHealthFiles, isCleanHealthPath, readHealthSource } from "./code-health-files.ts";
import { runRuff } from "./code-health-ruff.ts";

export interface HealthReport {
  findings: HealthFinding[];
  sources: HealthSource[];
  notes: string[];
  applied: string[];
  validation: string;
  truncated: boolean;
}

/** Session-local state only; never stores source contents on disk. */
export class CodeHealthGuardian {
  readonly touched = new Set<string>();
  readonly owned = new Map<string, string>();
  readonly baseline = new Set<string>();
  baselineComplete = false;
  automaticFixes = 0;
  aiReviews = 0;
  busy = false;
  lastReview = 0;
  report: HealthReport = { findings: [], sources: [], notes: [], applied: [], validation: "Not run (analysis only).", truncated: false };
  private cache = new Map<string, HealthFinding[]>();
  private before = new Map<string, { path: string; hash?: string }>();

  readonly cwd: string;
  constructor(cwd: string) { this.cwd = cwd; }

  async startTask(config: CodeHealthConfig, signal?: AbortSignal): Promise<void> {
    this.touched.clear();
    this.owned.clear();
    this.before.clear();
    this.baseline.clear();
    this.automaticFixes = 0;
    this.aiReviews = 0;
    this.baselineComplete = false;
    const selection = await discoverHealthFiles(this.cwd, { exclude: config.exclude, maxFiles: 100, signal });
    for (const path of selection.paths) this.baseline.add(path);
    // Without a complete Git baseline we cannot distinguish pre-existing user work.
    this.baselineComplete = selection.git && !selection.truncated;
  }

  async beforeEdit(id: string, path: string, config: CodeHealthConfig, signal?: AbortSignal): Promise<void> {
    const source = await readHealthSource(this.cwd, path, config.exclude, signal);
    this.before.set(id, { path, hash: source?.hash });
    if (!this.owned.has(path) && !await isCleanHealthPath(this.cwd, path, signal)) this.baseline.add(path);
    if (this.owned.has(path) && this.owned.get(path) !== source?.hash) {
      this.baseline.add(path);
      this.owned.delete(path);
    }
  }

  async afterEdit(id: string, failed: boolean, config: CodeHealthConfig, signal?: AbortSignal): Promise<void> {
    const before = this.before.get(id);
    this.before.delete(id);
    if (!before) return;
    this.touched.add(before.path);
    const after = await readHealthSource(this.cwd, before.path, config.exclude, signal);
    if (failed || !after || this.baseline.has(before.path)) { this.owned.delete(before.path); return; }
    // A file must have existed cleanly before the tool, or be newly created by it.
    if (after.hash !== before.hash) this.owned.set(before.path, after.hash);
  }

  async review(config: CodeHealthConfig, options: { all?: boolean; incremental?: boolean; fix?: boolean; canWrite?: () => boolean; signal?: AbortSignal } = {}): Promise<HealthReport> {
    if (this.busy) return this.report;
    this.busy = true;
    const signal = options.signal;
    try {
      signal?.throwIfAborted();
      const explicit = options.incremental ? [...this.touched] : undefined;
      if (options.incremental && !explicit?.length) return this.report;
      let selection = await discoverHealthFiles(this.cwd, { all: options.all, paths: explicit, exclude: config.exclude, maxFiles: config.maxFilesPerReview, signal });
      if (!selection.git && !options.all && !options.incremental && this.touched.size) {
        selection = await discoverHealthFiles(this.cwd, { paths: [...this.touched], exclude: config.exclude, maxFiles: config.maxFilesPerReview, signal });
      }
      const sources: HealthSource[] = [];
      const notes = [...selection.notes];
      for (const path of selection.paths) {
        const source = await readHealthSource(this.cwd, path, config.exclude, signal);
        if (source) sources.push(source);
      }
      // Relevant neighbors only, within the same total budget. No alias/config execution.
      if (config.enableArchitectureChecks) {
        for (const source of [...sources]) {
          const imports = source.text.matchAll(/^\s*import\s+(?:[^;\n]*?\s+from\s+)?["'](\.{1,2}\/[^"'\n]+)["']/gm);
          for (const match of imports) {
            if (sources.length >= config.maxFilesPerReview) break;
            const path = posix.normalize(posix.join(posix.dirname(source.path), match[1]!));
            if (sources.some((item) => item.path === path)) continue;
            const neighbor = await readHealthSource(this.cwd, path, config.exclude, signal);
            if (neighbor) sources.push(neighbor);
          }
        }
      }
      const key = createHash("sha256").update(JSON.stringify([config, sources.map(({ path, hash }) => [path, hash])])).digest("hex");
      let findings = this.cache.get(key);
      if (!findings) {
        findings = analyzeSources(sources, config);
        if (config.enableRuff) {
          for (const source of sources.filter((item) => item.path.endsWith(".py"))) {
            signal?.throwIfAborted();
            const result = await runRuff(this.cwd, source, "check", signal);
            findings.push(...result.findings);
            if (result.error) notes.push(result.error);
            if (!result.available) break;
          }
        }
        if (notes.length === selection.notes.length) this.cache.set(key, findings);
        if (this.cache.size > 16) this.cache.delete(this.cache.keys().next().value!);
      }
      const report: HealthReport = { findings: deduplicateFindings(findings), sources, notes: [...new Set(notes)], applied: [], validation: "Not run (analysis only).", truncated: selection.truncated };
      // Publish partial results before writes so cancellation cannot hide completed changes.
      this.report = report;
      if (options.fix && config.mode !== "observe" && config.enableRuff && this.baselineComplete && options.canWrite?.()) {
        for (const source of sources) {
          signal?.throwIfAborted();
          if (this.automaticFixes >= config.maxAutomaticFixesPerTask || !options.canWrite()) break;
          if (!source.path.endsWith(".py") || this.baseline.has(source.path) || this.owned.get(source.path) !== source.hash) continue;
          const formatted = await runRuff(this.cwd, source, "format", signal);
          if (formatted.error || formatted.text === undefined) {
            report.validation = formatted.error ?? "Formatter unavailable; no change applied.";
            break;
          }
          if (formatted.text === source.text) continue;
          const changed = await this.replaceOwned(source, formatted.text, config, signal, options.canWrite);
          if (!changed) { report.notes.push(`${source.path}: changed externally or no longer idle; fix skipped.`); break; }
          this.automaticFixes++;
          this.owned.set(source.path, createHash("sha256").update(formatted.text).digest("hex"));
          report.applied.push(source.path);
          report.findings.push({ id: `format-${source.path}-${source.hash}`, file: source.path, line: 1, category: "formatting", severity: "info", confidence: "high", evidence: "Opt-in Ruff formatter applied to an unchanged agent-owned snapshot.", suggestion: "Review the formatting diff; structural behavior was not rewritten.", applied: true });
          report.notes.push("Locations above describe the pre-format snapshot; rerun /health for current locations.");
          report.validation = "Ruff formatting and syntax diagnostics passed before write; project tests were not run.";
        }
      } else if (options.fix) {
        report.notes.push("No permitted fixes: observe mode, Ruff disabled, incomplete baseline, or repository not idle. Structural refactors are proposal-only.");
      }
      this.report = report;
      this.lastReview = Date.now();
      return report;
    } finally { this.busy = false; }
  }

  private async replaceOwned(source: HealthSource, text: string, config: CodeHealthConfig, signal: AbortSignal | undefined, canWrite: () => boolean): Promise<boolean> {
    const absolute = resolve(this.cwd, source.path);
    return withFileMutationQueue(absolute, async () => {
      signal?.throwIfAborted();
      const current = await readHealthSource(this.cwd, source.path, config.exclude, signal);
      if (current?.hash !== source.hash || !canWrite()) return false;
      const stat = await lstat(absolute);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) return false;
      const temporary = join(dirname(absolute), `.piexis-health-${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, text, { flag: "wx", mode: stat.mode & 0o777 });
        signal?.throwIfAborted();
        if (!canWrite() || (await readHealthSource(this.cwd, source.path, config.exclude, signal))?.hash !== source.hash) return false;
        // Cooperative Pi writers are queued; external editor races remain best-effort.
        await rename(temporary, absolute);
        return true;
      } finally { await rm(temporary, { force: true }); }
    });
  }
}

/** Targeted excerpts only. Neither repository instructions nor analyzer text are trusted. */
export function healthReviewContext(report: HealthReport): string {
  const files = report.sources.filter((source) => report.findings.some((item) => item.file === source.path && item.category !== "large-file")).slice(0, 6);
  const data = files.map((source) => {
    const lines = source.text.split(/\r?\n/);
    const findings = report.findings.filter((item) => item.file === source.path).slice(0, 4);
    const selected = new Set<number>();
    for (let index = 0; index < Math.min(15, lines.length); index++) selected.add(index);
    for (const finding of findings) for (let index = Math.max(0, finding.line - 8); index < Math.min(lines.length, finding.line + 22); index++) selected.add(index);
    const excerpt = [...selected].sort((a, b) => a - b).map((index) => {
      const line = lines[index]!;
      return `${index + 1}: ${/(?:secret|password|api[_-]?key|token|-----BEGIN|bearer\s|https?:\/\/[^\s/]+:[^\s@]+@)/i.test(line) ? "[redacted sensitive-looking line]" : line}`;
    }).join("\n").slice(0, 3500);
    return { file: source.path, findings, excerpt };
  });
  return JSON.stringify(data).slice(0, 24_000);
}

export function formatHealthReport(report: HealthReport, detailed = false): string {
  const header = `Code health: ${report.findings.length} findings, ${report.sources.length} files${report.truncated ? " (bounded/incomplete)" : ""}; ${report.applied.length} fixes applied. Validation: ${report.validation}`;
  const findings = report.findings.slice(0, detailed ? 100 : 5).map((item) => `${item.file}:${item.line} [${item.severity}/${item.confidence}] ${item.category}: ${item.evidence}${detailed ? `\n  ${item.suggestion} Applied: ${item.applied ? "yes" : "no"}.` : ""}`);
  return [header, ...findings, ...report.notes, ...(report.applied.length ? [`Formatted: ${report.applied.join(", ")}`] : []), ...(!detailed && report.findings.length > 5 ? ["Use /health explain for details."] : [])].join("\n");
}
