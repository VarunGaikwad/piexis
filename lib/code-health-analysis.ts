import { createHash } from "node:crypto";
import { posix } from "node:path";

export interface HealthFinding {
  id: string;
  file: string;
  line: number;
  category: string;
  severity: "info" | "warning" | "error";
  confidence: "heuristic" | "high";
  evidence: string;
  suggestion: string;
  applied?: boolean;
}
export interface HealthSource { path: string; text: string; hash: string }
export interface AnalysisOptions {
  largeFileThresholdLines: number;
  enableComplexityChecks: boolean;
  enableDuplicationChecks: boolean;
  enableArchitectureChecks: boolean;
}

const MAX_FINDINGS = 12;
const MAX_LINES = 20_000;
const CODE = new Set(["javascript", "typescript", "python", "java", "go", "rust", "c", "cpp", "csharp", "php", "ruby", "kotlin", "swift"]);

export function detectLanguage(path: string, text: string): { language: string; framework?: string } {
  const extension = posix.extname(path.toLowerCase());
  const language = ({ ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript", ".ts": "typescript", ".tsx": "typescript", ".py": "python", ".java": "java", ".css": "css", ".scss": "css", ".go": "go", ".rs": "rust", ".c": "c", ".h": "c", ".cpp": "cpp", ".cs": "csharp", ".php": "php", ".rb": "ruby", ".kt": "kotlin", ".swift": "swift", ".json": "json", ".yaml": "yaml", ".yml": "yaml", ".md": "markdown", ".html": "html", ".vue": "html", ".svelte": "html", ".sql": "sql" } as Record<string, string>)[extension] ?? (/^#!.*\bpython/m.test(text.slice(0, 200)) ? "python" : "unknown");
  const sample = text.slice(0, 32_768);
  const framework = extension === ".vue" ? "Vue" : extension === ".svelte" ? "Svelte"
    : language === "python" && /\b(?:from|import)\s+django\b/.test(sample) ? "Django"
    : language === "python" && /\b(?:from|import)\s+fastapi\b/.test(sample) ? "FastAPI"
    : ["javascript", "typescript"].includes(language) && /\bfrom\s+["']next(?:[/'"])/.test(sample) ? "Next.js"
    : ["javascript", "typescript"].includes(language) && (/\bfrom\s+["']react(?:[/'"])/.test(sample) || [".jsx", ".tsx"].includes(extension)) ? "React"
    : language === "java" && /org\.springframework\.|@SpringBootApplication\b/.test(sample) ? "Spring" : undefined;
  return framework ? { language, framework } : { language };
}

function finding(file: string, line: number, category: string, evidence: string, suggestion: string, severity: HealthFinding["severity"] = "warning", confidence: HealthFinding["confidence"] = "heuristic"): HealthFinding {
  const id = createHash("sha256").update(`${file}\0${line}\0${category}\0${evidence}`).digest("hex").slice(0, 20);
  return { id, file, line, category, severity, confidence, evidence, suggestion };
}

export function deduplicateFindings(findings: HealthFinding[]): HealthFinding[] {
  const seen = new Set<string>();
  return findings.filter((item) => {
    const key = `${item.file}\0${item.line}\0${item.category}\0${item.evidence}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Mask comments and quoted text while preserving offsets and line numbers. Not a parser. */
function mask(text: string, python: boolean): string {
  return text.replace(python ? /("""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$)|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|#[^\n]*)/g : /\/\*[\s\S]*?(?:\*\/|$)|\/\/[^\n]*|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`/g, (value) => value.replace(/[^\n\r]/g, " "));
}

function caution(language: string, framework?: string): string {
  if (framework === "React" || framework === "Next.js") return " Preserve React hook order, component state and rendering behavior; JSX size alone is not complexity.";
  if (framework === "Spring") return " Preserve Spring annotations, proxy boundaries and transaction behavior.";
  if (language === "python") return " Preserve Python decorators, indentation, generator and context-manager behavior.";
  if (language === "css") return " Preserve CSS cascade, specificity and responsive rules; declarative size is not complexity.";
  return " Verify behavior with focused tests before restructuring.";
}

function parameterCount(parameters: string): number {
  if (!parameters.trim()) return 0;
  let depth = 0;
  let count = 1;
  for (const character of parameters) {
    if ("([{<".includes(character)) depth++;
    else if (")]}>".includes(character)) depth = Math.max(0, depth - 1);
    else if (character === "," && depth === 0) count++;
  }
  return count;
}

function structural(source: HealthSource, lines: string[], language: string, hint: string): HealthFinding[] {
  const output: HealthFinding[] = [];
  let inspectedUntil = -1;
  for (let index = 0; index < lines.length && output.length < MAX_FINDINGS; index++) {
    const line = lines[index]!;
    const python = language === "python";
    // shortcut: single-line signatures only; use an opt-in analyzer for full syntax coverage.
    const match = python ? /^([ \t]*)(?:async\s+)?def\s+\w+\s*\((.*)\)\s*(?:->[^:]+)?\s*:/.exec(line)
      : /^\s*(?:(?:export|default|public|private|protected|static|async|final|override|suspend)\s+)*(?:(?:function|func|fn)\s+\w+|(?:const|let|var)\s+\w+\s*=|(?:[\w<>[\].?]+\s+)?\w+)\s*\((.*)\)\s*(?:=>\s*|(?::\s*[^={]+)?\s*)\{/.exec(line);
    if (!match || (!python && /^\s*(?:if|for|while|switch|catch|with|synchronized)\s*\(/.test(line))) continue;
    const parameters = python ? match[2]! : match[1]!;
    const count = parameterCount(parameters);
    if (count >= (python ? 8 : 7)) output.push(finding(source.path, index + 1, "parameters", `Lexical signature has approximately ${count} parameters.`, `Consider a cohesive input object or smaller responsibility; this is a lexical estimate.${hint}`));
    if (index <= inspectedUntil) continue;
    let end = index;
    let nesting = 0;
    if (python) {
      const indent = match[1]!.replaceAll("\t", "    ").length;
      const levels: number[] = [];
      for (let next = index + 1; next < lines.length; next++) {
        const current = lines[next]!;
        if (!current.trim()) continue;
        const spaces = /^\s*/.exec(current)![0].replaceAll("\t", "    ").length;
        if (spaces <= indent) break;
        end = next;
        while (levels.length && spaces <= levels[levels.length - 1]!) levels.pop();
        if (/^\s*(?:if|elif|for|while|try|with|match)\b.*:\s*$/.test(current)) levels.push(spaces);
        nesting = Math.max(nesting, levels.length);
      }
    } else {
      let depth = 0;
      let started = false;
      outer: for (let next = index; next < lines.length; next++) {
        const current = next === index ? lines[next]!.slice(lines[next]!.indexOf("{")) : lines[next]!;
        for (const character of current) {
          if (character === "{") { started = true; depth++; nesting = Math.max(nesting, depth - 1); }
          if (character === "}") depth--;
          if (started && depth === 0) { end = next; break outer; }
        }
        end = next;
      }
      if (depth !== 0) continue;
    }
    inspectedUntil = end;
    const length = lines.slice(index, end + 1).filter((value) => value.trim()).length;
    if (length > 60) output.push(finding(source.path, index + 1, "function-length", `Lexically delimited function spans ${end - index + 1} lines (${length} nonblank code lines).`, `Consider extracting a cohesive operation after checking the actual function boundaries.${hint}`));
    if (nesting >= 5) output.push(finding(source.path, index + 1, "nesting", `Lexical nesting reaches approximately ${nesting} levels; braces may include data literals.`, `Review control flow for guard clauses or smaller operations; this is not a semantic complexity score.${hint}`));
  }
  return output;
}

export function analyzeSources(sources: HealthSource[], options: AnalysisOptions): HealthFinding[] {
  const output: HealthFinding[] = [];
  const blocks = new Map<string, { file: string; line: number }>();
  const analyzed: HealthSource[] = [];
  let windows = 0;
  for (const source of sources.slice(0, 1000)) {
    if (source.text.length > 512 * 1024 || /(?:^|\/)(?:generated|migrations?|fixtures?|__fixtures__)(?:\/|$)|\.generated\./i.test(source.path) || /@generated|automatically generated|do not edit/i.test(source.text.slice(0, 2048))) continue;
    const raw = source.text.split(/\r?\n/);
    if (raw.length > MAX_LINES) continue;
    analyzed.push(source);
    const { language, framework } = detectLanguage(source.path, source.text);
    const hint = caution(language, framework);
    const perFile: HealthFinding[] = [];
    if (Number.isFinite(options.largeFileThresholdLines) && options.largeFileThresholdLines > 0 && raw.length > options.largeFileThresholdLines) {
      perFile.push(finding(source.path, 1, "large-file", `File contains ${raw.length} lines; size alone does not establish a design problem.`, `Review navigation and responsibility boundaries only if maintenance is difficult.${hint}`, "info"));
    }
    const lines = mask(source.text, language === "python").split(/\r?\n/);
    if (CODE.has(language) && options.enableComplexityChecks) perFile.push(...structural(source, lines, language, hint));
    if (CODE.has(language) && options.enableArchitectureChecks && lines.length > 250) {
      for (let index = 0; index < lines.length && perFile.length < MAX_FINDINGS; index++) {
        if (!/^\s*(?:(?:export|public|private|abstract|final|data|open)\s+)*class\s+\w+/.test(lines[index]!)) continue;
        // shortcut: file-level method count is only a cohesion review signal, not a class parser.
        const methods = lines.filter((line) => /^\s+(?:(?:public|private|protected|static|async|final|override)\s+)*(?:def\s+\w+|(?:[\w<>[\].?]+\s+)?\w+)\s*\(/.test(line) && !/^\s*(?:if|for|while|switch|catch)\b/.test(line)).length;
        if (methods >= 15) perFile.push(finding(source.path, index + 1, "class-cohesion", `Class-bearing module spans ${lines.length} lines with approximately ${methods} method-like signatures; boundaries and responsibilities require review.`, `Check cohesion before extracting responsibilities; this is not proof of a god class.${hint}`));
        break;
      }
    }
    if (CODE.has(language) && options.enableDuplicationChecks) {
      const meaningful = lines.map((text, index) => ({ text: text.trim().replace(/\s+/g, " "), line: index + 1 })).filter((item) => /[A-Za-z_]/.test(item.text));
      for (let index = 0; index + 8 <= meaningful.length && windows < 20_000 && perFile.length < MAX_FINDINGS; index += 4, windows++) {
        const window = meaningful.slice(index, index + 8);
        const value = window.map((item) => item.text).join("\n");
        if (value.length < 240 || new Set(window.map((item) => item.text)).size < 5) continue;
        const key = createHash("sha256").update(value).digest("hex");
        const previous = blocks.get(key);
        const line = window[0]!.line;
        if (previous && (previous.file !== source.path || Math.abs(previous.line - line) >= 8)) {
          perFile.push(finding(source.path, line, "duplication", `Eight substantial normalized code lines repeat at another location (line ${previous.line}${previous.file === source.path ? " in this file" : " in another analyzed file"}).`, `Compare intent before sharing code; similar text may represent independent behavior.${hint}`));
          break;
        }
        if (!previous) blocks.set(key, { file: source.path, line });
      }
    }
    output.push(...perFile.slice(0, MAX_FINDINGS));
  }
  if (options.enableArchitectureChecks) output.push(...importCycles(analyzed));
  const counts = new Map<string, number>();
  return deduplicateFindings(output).filter((item) => {
    const count = counts.get(item.file) ?? 0;
    counts.set(item.file, count + 1);
    return count < MAX_FINDINGS;
  });
}

function importCycles(sources: HealthSource[]): HealthFinding[] {
  const files = new Set(sources.map((source) => source.path));
  const edges = new Map<string, { target: string; line: number }[]>();
  for (const source of sources) {
    if (!/\.[cm]?[jt]sx?$/.test(source.path)) continue;
    const list: { target: string; line: number }[] = [];
    // shortcut: only standalone static relative imports; aliases, exports and dynamic imports are not resolved.
    const code = mask(source.text, false).split(/\r?\n/);
    const raw = source.text.split(/\r?\n/);
    for (let index = 0; index < raw.length && list.length < 100; index++) {
      if (!/^\s*import\b/.test(code[index]!)) continue;
      const match = /^\s*import\s+(?!type\b)(?:(?:[^;"']+)\s+from\s+)?["'](\.{1,2}\/[^"'\n]+)["']\s*;?\s*$/.exec(raw[index]!);
      if (!match) continue;
      const base = posix.normalize(posix.join(posix.dirname(source.path), match[1]!));
      // Only exact paths resolve confidently without reading project module-resolution settings.
      if (files.has(base) && /\.[cm]?[jt]sx?$/.test(base)) list.push({ target: base, line: index + 1 });
    }
    edges.set(source.path, list);
  }
  const output: HealthFinding[] = [];
  const active = new Set<string>();
  const visited = new Set<string>();
  const visit = (file: string): void => {
    if (visited.has(file)) return;
    visited.add(file);
    active.add(file);
    for (const edge of edges.get(file) ?? []) {
      if (active.has(edge.target)) output.push(finding(file, edge.line, "import-cycle", "A cycle exists among exact-path static relative imports in the analyzed batch.", "Inspect module initialization and dependency direction. This is a partial graph, not proof of a runtime failure; no automatic architecture changes are safe.", "warning", "high"));
      else visit(edge.target);
    }
    active.delete(file);
  };
  for (const file of edges.keys()) visit(file);
  return output;
}
