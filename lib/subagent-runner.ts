import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { basename, dirname, join } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

type Usage = NonNullable<Awaited<ReturnType<ToolDefinition["execute"]>>["usage"]>;

export function emptyUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

export function addUsage(total: Usage, value?: Partial<Usage>): void {
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) {
    if (typeof value?.[key] === "number" && Number.isFinite(value[key])) total[key] += value[key];
  }
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) {
    if (typeof value?.cost?.[key] === "number" && Number.isFinite(value.cost[key])) total.cost[key] += value.cost[key];
  }
}

export function piInvocation(): { command: string; args: string[] } {
  const script = process.argv[1];
  if (script && /(?:^|[\\/])(?:cli|pi)\.(?:m?js|ts)$/.test(script) && existsSync(script)) {
    return { command: process.execPath, args: [script] };
  }
  if (!/^(node|bun)(\.exe)?$/i.test(basename(process.execPath))) return { command: process.execPath, args: [] };
  const entry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
  const cli = join(dirname(entry), "bundle", "cli.js");
  return existsSync(cli) ? { command: process.execPath, args: [cli] } : { command: "pi", args: [] };
}

export interface ChildResult {
  output: string;
  exitCode: number;
  stopReason?: string;
  error?: string;
  stderr: string;
  usage: Usage;
}

export function limitOutput(text: string, limit = 50_000): string {
  return text.length > limit ? `${text.slice(0, limit)}\n[Output truncated; full output is in subagent tool details (up to 1 MB).]` : text;
}

export async function runSubagent(options: {
  invocation: { command: string; args: string[] };
  args: string[];
  cwd: string;
  depth: number;
  task: string;
  signal: AbortSignal;
  onProgress?: (text: string) => void;
}): Promise<ChildResult> {
  options.signal.throwIfAborted();
  const result: ChildResult = { output: "", exitCode: -1, stderr: "", usage: emptyUsage() };
  return new Promise((resolve, reject) => {
    const grouped = process.platform !== "win32" && options.depth === 1;
    const child = spawn(options.invocation.command, [...options.invocation.args, ...options.args], {
      cwd: options.cwd, shell: false, detached: grouped,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PIEXIS_SUBAGENT_DEPTH: String(options.depth) },
    });
    let buffer = "", bytes = 0, timer: NodeJS.Timeout | undefined, failure: Error | undefined;
    let closed = false;
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (grouped && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") failure ??= error as Error;
      }
    };
    const stop = () => {
      kill("SIGTERM");
      timer ??= setTimeout(() => kill("SIGKILL"), 1000);
    };
    const abort = () => stop();
    options.signal.addEventListener("abort", abort, { once: true });
    if (options.signal.aborted) abort();

    const line = (text: string) => {
      if (!text.trim()) return;
      let event;
      try { event = JSON.parse(text); }
      catch { failure ??= new Error("Invalid JSON from subagent stdout"); stop(); return; }
      if (event.type === "message_end" && event.message) {
        const message = event.message;
        if (message.role === "assistant" || message.role === "toolResult") addUsage(result.usage, message.usage);
        if (message.role === "assistant") {
          result.output = (Array.isArray(message.content) ? message.content : [])
            .filter((part: { type: string }) => part.type === "text")
            .map((part: { text: string }) => part.text).join("\n");
          if (result.output.length > 1_000_000) result.output = `${result.output.slice(0, 1_000_000)}\n[Output exceeded the 1 MB retention limit.]`;
          result.stopReason = message.stopReason;
          result.error = message.errorMessage;
          options.onProgress?.(limitOutput(result.output, 2000) || "Working…");
        }
      } else if (event.type === "tool_execution_start") {
        options.onProgress?.(`Running ${event.toolName}…`);
      } else if (event.type === "agent_settled" && event.aborted) {
        result.stopReason = "aborted";
      }
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (data: string) => {
      if (failure) return;
      bytes += Buffer.byteLength(data);
      buffer += data;
      if (bytes > 64 * 1024 * 1024 || buffer.length > 8 * 1024 * 1024) {
        failure = new Error("Subagent event stream exceeded its limit"); stop(); return;
      }
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        line(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        if (failure) break;
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (text: string) => { result.stderr = (result.stderr + text).slice(-32_000); });
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") { failure = error; stop(); }
    });
    child.on("error", (error) => { failure = error; });
    child.on("close", (code, signal) => {
      closed = true;
      options.signal.removeEventListener("abort", abort);
      if (!failure && buffer.trim()) line(buffer);
      if (timer) clearTimeout(timer);
      // A root cancellation must also terminate descendants that outlive the Pi process.
      if (grouped && (options.signal.aborted || failure || code !== 0 || signal)) kill("SIGKILL");
      if (options.signal.aborted) reject(new Error("Subagent aborted", { cause: options.signal.reason }));
      else if (failure) reject(failure);
      else {
        result.exitCode = code ?? 1;
        if (signal) result.error ??= `Subagent terminated by ${signal}`;
        if (!result.output && !result.error) result.error = result.stderr || "Subagent exited without a final text response";
        resolve(result);
      }
    });
    // stdin avoids command-line size limits and keeps delegated context out of process arguments.
    if (!closed) child.stdin.end(`Task:\n${options.task}\n`);
  });
}
