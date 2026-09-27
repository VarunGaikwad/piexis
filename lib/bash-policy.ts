import { evaluatePathPolicy } from "./path-policy.ts";

export type ShellCommand = { argv: string[]; assignments: string[]; redirects: { operator: string; target: string }[] };
export type BashAnalysis = {
  status: "parsed" | "unsupported";
  commands: ShellCommand[];
  operators: string[];
  findings: string[];
  safe: boolean;
  grantFamily?: "git-status";
  blockedReason?: string;
};
type Token = { kind: "word" | "operator"; value: string; quoted?: boolean };
const OPERATORS = ["&&", "||", ">>", "<<", "|&", ">&", "<&", ";;", ";", "|", "&", ">", "<", "\n"];
const RESERVED = new Set(["if", "then", "else", "fi", "for", "while", "until", "do", "done", "case", "esac", "function", "select", "!", "time", "coproc", "[[", "]]"]);
const WRAPPERS = new Set(["env", "command", "exec", "sudo", "nohup", "timeout", "nice", "stdbuf", "xargs"]);
const INTERPRETERS = new Set(["sh", "bash", "zsh", "dash", "fish", "python", "python3", "node", "ruby", "perl", "eval", "source", ".", "npm", "npx", "pnpm", "yarn", "bun", "make"]);
const STATUS_FLAGS = new Set(["--short", "-s", "--branch", "-b", "--porcelain", "--porcelain=v1", "--porcelain=v2", "--untracked-files=no", "--untracked-files=normal", "--untracked-files=all"]);

/** A bounded literal-shell lexer/parser, NOT a full Bash interpreter. Unsupported
 * expansions/compound syntax never enter the fast path or reusable grant path.
 * No commands are executed and substitutions are never evaluated.
 */
export function parseBash(command: string): BashAnalysis {
  const result: BashAnalysis = { status: "parsed", commands: [], operators: [], findings: [], safe: false };
  const findings = new Set<string>();
  const unsupported = (reason: string) => {
    result.status = "unsupported";
    findings.add(reason);
    result.findings = [...findings];
    return result;
  };
  if (!command.trim() || command.length > 16000) return unsupported("shell-size-limit");
  // Bash does not treat carriage returns as ordinary token-separating space.
  if (command.includes("\r")) return unsupported("carriage-return-syntax");
  const tokens: Token[] = [];
  let i = 0;
  while (i < command.length) {
    if (tokens.length >= 256) return unsupported("shell-token-limit");
    const ch = command[i]!;
    if (ch === " " || ch === "\t" || ch === "\r") { i++; continue; }
    if (ch === "#") { while (i < command.length && command[i] !== "\n") i++; continue; }
    const operator = OPERATORS.find((op) => command.startsWith(op, i));
    if (operator) { tokens.push({ kind: "operator", value: operator }); i += operator.length; continue; }
    let value = "";
    let quoted = false;
    let quote: "'" | '"' | undefined;
    while (i < command.length) {
      const c = command[i]!;
      if (!quote && (/[ \t\r\n]/.test(c) || OPERATORS.some((op) => command.startsWith(op, i)))) break;
      if (c === "'" && quote !== '"' || c === '"' && quote !== "'") {
        quoted = true;
        quote = quote ? undefined : c as "'" | '"';
        i++;
        continue;
      }
      if (c === "\\" && quote !== "'") {
        i++;
        if (i === command.length) return unsupported("unfinished-escape");
        const next = command[i++]!;
        if (next === "\n") continue;
        // In double quotes only these escapes lose their backslash.
        value += quote === '"' && !['$', '`', '"', '\\'].includes(next) ? `\\${next}` : next;
        continue;
      }
      if (quote !== "'" && (c === "$" || c === "`"))
        return unsupported(c === "`" || command[i + 1] === "(" ? "command-substitution" : "shell-expansion");
      if (!quote && "()*?[]{}~".includes(c)) return unsupported("unsupported-shell-syntax");
      if (c === "\0") return unsupported("invalid-shell-character");
      value += c;
      i++;
    }
    if (quote) return unsupported("unfinished-quote");
    tokens.push({ kind: "word", value, quoted });
  }
  let current: ShellCommand = { argv: [], assignments: [], redirects: [] };
  const finish = () => {
    if (!current.argv.length || result.commands.length >= 32) return false;
    result.commands.push(current);
    current = { argv: [], assignments: [], redirects: [] };
    return true;
  };
  for (let n = 0; n < tokens.length; n++) {
    const token = tokens[n]!;
    if (token.kind === "operator") {
      if (["<", ">", ">>"].includes(token.value)) {
        const target = tokens[++n];
        if (!target || target.kind !== "word") return unsupported("invalid-redirection");
        current.redirects.push({ operator: token.value, target: target.value });
        findings.add("redirection");
      } else if (["&&", "||", ";", "|", "\n"].includes(token.value)) {
        if (!finish()) return unsupported("invalid-command-list");
        result.operators.push(token.value);
        findings.add(token.value === "|" ? "pipeline" : "command-chain");
      } else return unsupported(token.value === "<<" ? "heredoc" : "unsupported-shell-operator");
    } else if (!current.argv.length && !token.quoted && /^[A-Za-z_][A-Za-z0-9_]*=/.test(token.value)) {
      current.assignments.push(token.value);
      findings.add("environment-assignment");
    } else {
      // Numeric file descriptors require grammar we deliberately do not infer.
      if (/^\d+$/.test(token.value) && tokens[n + 1]?.kind === "operator" && /[<>]/.test(tokens[n + 1]!.value))
        return unsupported("file-descriptor-redirection");
      current.argv.push(token.value);
    }
  }
  if (current.argv.length) {
    if (!finish()) return unsupported("shell-command-limit");
  } else if (current.assignments.length || current.redirects.length) return unsupported("assignment-only-command");
  else if (result.operators.length && ![";", "\n"].includes(result.operators.at(-1)!)) return unsupported("unfinished-command-list");
  if (!result.commands.length) return unsupported("missing-command");
  for (const part of result.commands) {
    const [executable, subcommand] = part.argv;
    if (RESERVED.has(executable!)) return unsupported("compound-shell-command");
    const name = executable!.split("/").at(-1)!;
    if (name === "cd" || name === "pushd" || name === "popd") findings.add("working-directory-change");
    if (WRAPPERS.has(name)) findings.add("execution-wrapper");
    if (INTERPRETERS.has(name) || executable!.includes("/")) findings.add("script-or-interpreter");
    if (["rm", "rmdir", "shred", "truncate"].includes(name) || name === "git" &&
      (["reset", "clean", "rebase"].includes(subcommand ?? "") || part.argv.some((arg) => ["--force", "--force-with-lease", "--hard"].includes(arg)))) findings.add("destructive-action");
    if (["curl", "wget", "scp", "rsync"].includes(name)) findings.add("network-or-data-egress");
    if (["kubectl", "terraform", "pulumi", "aws", "gcloud", "az"].includes(name) || part.argv.some((arg) => ["deploy", "publish", "push"].includes(arg))) findings.add("shared-system-change");
    if (part.argv.some((arg) => ["--no-verify", "--insecure", "--skip-checks"].includes(arg)) ||
      name === "git" && subcommand === "commit" && part.argv.includes("-n")) findings.add("safeguard-bypass");
    if (["sudo", "su", "chmod", "chown"].includes(name)) findings.add("privilege-change");
  }
  result.findings = [...findings];
  const single = result.commands.length === 1 && !result.operators.length && !findings.size;
  const argv = result.commands[0]!.argv;
  result.safe = single && (argv.length === 1 && ["pwd", "true", "false"].includes(argv[0]!) ||
    argv[0] === "pwd" && argv.length === 2 && ["-L", "-P"].includes(argv[1]!));
  if (single && argv[0] === "git" && argv[1] === "status" && argv.slice(2).every((arg) => STATUS_FLAGS.has(arg))) result.grantFamily = "git-status";
  return result;
}

/** Inspect literal targets only where the command's file-operation role is known.
 * Unknown command semantics stay with the reviewer, never with an allow rule.
 */
export async function analyzeBash(command: string, cwd: string, workspaceRoot: string): Promise<BashAnalysis> {
  const analysis = parseBash(command);
  if (process.env.BASH_ENV || process.env.ENV || process.env.SHELLOPTS || process.env.BASHOPTS || process.env.PS4 ||
    Object.keys(process.env).some((key) => key.startsWith("BASH_FUNC_"))) {
    analysis.safe = false;
    analysis.findings.push("shell-startup-overrides");
  }
  if (analysis.status !== "parsed") return analysis;
  for (const part of analysis.commands) {
    const name = part.argv[0]!.split("/").at(-1)!;
    const reads = ["cat", "head", "tail", "grep", "rg", "find", "ls"].includes(name);
    const writes = ["cp", "mv", "rm", "rmdir", "mkdir", "touch", "tee", "install", "truncate"].includes(name);
    const targets = part.redirects.map((r) => ({ path: r.target, write: r.operator !== "<" }));
    if (reads || writes) for (const arg of part.argv.slice(1)) {
      if (!arg.startsWith("-")) targets.push({ path: arg, write: writes });
    }
    for (const target of targets) {
      const checked = await evaluatePathPolicy(target.write ? "write" : "read", { path: target.path }, workspaceRoot, cwd);
      if (checked?.decision === "deny" || checked?.decision === "review" && checked.scope === "sensitive") {
        analysis.blockedReason = checked.reason;
        analysis.findings.push("protected-filesystem-target");
      } else if (checked?.decision === "review") analysis.findings.push("external-filesystem-target");
    }
  }
  analysis.findings = [...new Set(analysis.findings)];
  return analysis;
}
