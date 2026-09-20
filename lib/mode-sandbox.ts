import { spawn } from "node:child_process";
import { access, mkdtemp, open, realpath, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";
import { getAgentDir, type BashOperations } from "@earendil-works/pi-coding-agent";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { isPlanFile, plansDirectory, protectedProjectPaths, within, type Mode, type ManagedTool, type ModeSettings } from "./mode-policy.ts";

const brokerPath = fileURLToPath(new URL("./mode-sandbox-broker.mjs", import.meta.url));
const packageRoot = dirname(dirname(brokerPath));
export type ShellOptions = Parameters<BashOperations["exec"]>[2];
export interface SandboxBackend {
  readonly status: string;
  check(root: string, settings: ModeSettings, signal?: AbortSignal): Promise<void>;
  bash(mode: Mode, root: string, settings: ModeSettings, command: string, options: ShellOptions): Promise<{ exitCode: number | null }>;
  tool(mode: Mode, root: string, settings: ModeSettings, tool: ManagedTool, input: Record<string, unknown>, signal?: AbortSignal): Promise<any>;
  close(): Promise<void>;
}

/** No shell startup hooks, Node loaders, proxies, API keys, or arbitrary inherited secrets in the host launcher. */
export function sandboxEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const names = ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TERM", "TZ", "PI_CODING_AGENT_DIR", "PI_SESSION_ID", "PI_SESSION_FILE", "PI_PROVIDER", "PI_MODEL", "PI_REASONING_LEVEL"];
  return Object.fromEntries(names.filter(k => source[k] !== undefined).map(k => [k, source[k]]));
}

export async function launcherEnvironment(root: string, source: NodeJS.ProcessEnv = process.env): Promise<NodeJS.ProcessEnv> {
  const environment = sandboxEnvironment(source);
  const directories: string[] = [];
  for (const directory of (environment.PATH ?? "").split(delimiter)) {
    if (!isAbsolute(directory)) continue; // No cwd-dependent host executables.
    try {
      const actual = await realpath(directory);
      if (!within(actual, root)) directories.push(actual);
    } catch { /* Nonexistent PATH entries cannot provide a dependency. */ }
  }
  environment.PATH = [...new Set(directories)].join(delimiter);
  async function verify(path: string, systemWhich = false) {
    const actual = await realpath(path);
    if (within(actual, root)) throw new Error(`Host launcher executable is inside the writable project: ${actual}`);
    // Debian's system `which` is a fixed OS shell script; user shims are not accepted.
    if (systemWhich && ["/usr/bin/which", "/usr/bin/which.debianutils"].includes(actual)) return;
    const file = await open(actual, "r");
    try {
      const header = Buffer.alloc(4);
      await file.read(header, 0, 4, 0);
      const nativeMagic = [0x7f454c46, 0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca];
      if (!nativeMagic.includes(header.readUInt32BE())) throw new Error(`Host sandbox dependency must be a native executable, not a project-aware shim/script: ${actual}`);
    } finally { await file.close(); }
  }
  await verify(process.execPath);
  await verify("/bin/bash");
  for (const name of ["bwrap", "socat", "rg", "sandbox-exec", "which"]) {
    for (const directory of directories) {
      const path = join(directory, name);
      try { await access(path, constants.X_OK); } catch { continue; }
      await verify(path, name === "which");
      break;
    }
  }
  return environment;
}

export async function sandboxProfile(mode: Mode, root: string, settings: ModeSettings, tool: ManagedTool = "bash", target?: string): Promise<SandboxRuntimeConfig> {
  if (mode === "yolo") throw new Error("YOLO must never construct a sandbox profile");
  if (root === dirname(root) || root === homedir()) throw new Error("Choose a project directory, not the filesystem root or home directory");
  const configuredReadRoots = await Promise.all(settings.readRoots.map(path => realpath(path)));
  const readRoots = [...new Set([root, packageRoot, ...configuredReadRoots])];
  // Always scan the project as its own root so its reserved (possibly absent)
  // configuration paths remain protected even if an extra read root contains it.
  const scanRoots = [root, ...readRoots.filter(p => p !== root && !within(p, root) &&
    !readRoots.some(other => other !== root && other !== p && within(p, other)))];
  const scans = await Promise.all(scanRoots.map(protectedProjectPaths));
  const protectedPaths = { read: scans.flatMap(s => s.read), write: scans.flatMap(s => s.write) };
  // SRT interprets glob metacharacters even in otherwise literal paths. Refuse
  // ambiguous literals instead of silently skipping a deny mount on Linux.
  for (const path of [...readRoots, ...protectedPaths.read, ...protectedPaths.write]) {
    if (/[*?\[\]]/.test(path)) throw new Error(`Unsupported glob metacharacter in sandbox path: ${path}`);
  }
  const planMutation = ["write", "edit", "delete_plan"].includes(tool) && !!target && isPlanFile(target, root);
  const mutation = ["bash", "write", "edit"].includes(tool);
  const plans = plansDirectory(root);
  const allowWrite = planMutation ? [plans] : mode !== "plan" && mutation ? [root] : [];
  const defaults = ["/tmp/claude", "/private/tmp/claude", join(homedir(), ".npm", "_logs"), join(homedir(), ".claude", "debug")];
  const writeDenies = protectedPaths.write.filter(p => !planMutation || (!within(plans, p) && !within(p, plans)));
  return {
    filesystem: {
      // Explicit read roots: system runtime files, this extension and its deps,
      // the project, and user-configured additional read roots. Never allow HOME wholesale.
      denyRead: ["/", ...protectedPaths.read, join(getAgentDir(), "auth.json"), join(getAgentDir(), "sessions")],
      allowRead: ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc", "/System", "/Library", "/opt/homebrew", "/opt/local", "/nix/store", root,
        packageRoot, dirname(dirname(await realpath(process.execPath))), join(getAgentDir(), "bin"), ...configuredReadRoots],
      allowWrite,
      denyWrite: [...defaults, ...writeDenies]
    },
    network: { allowedDomains: mode === "plan" || tool !== "bash" ? [] : settings.allowedDomains, deniedDomains: [], allowLocalBinding: false, allowAllUnixSockets: false },
    enableWeakerNestedSandbox: false,
    enableWeakerNetworkIsolation: false,
    allowAppleEvents: false,
    mandatoryDenySearchDepth: 10
  };
}

/** Each broker owns its own SandboxManager. No process-global profile races or interference with other extensions. */
export function createSandboxBackend(): SandboxBackend {
  let status = "unchecked";
  let closed = false;
  const lifetime = new AbortController();
  const jobs = new Set<Promise<unknown>>();
  const checks = new Map<string, Promise<void>>();
  async function broker(request: Record<string, unknown>, root: string, signal?: AbortSignal, onData?: (data: Buffer) => void, timeout?: number, env?: NodeJS.ProcessEnv) {
    if (closed) throw new Error("Sandbox session closed");
    const combined = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
    combined.throwIfAborted();
    const hostEnvironment = await launcherEnvironment(root, env);
    const commandPath = (env ?? process.env).PATH;
    const scratch = await mkdtemp(join(tmpdir(), "piexis-sandbox-"));
    try {
      return await new Promise<{ exitCode: number | null; output: string }>((resolve, reject) => {
        const child = spawn(process.execPath, [brokerPath], {
          cwd: root, detached: true, stdio: ["pipe", "pipe", "pipe", "ipc"],
          env: { ...hostEnvironment, TMPDIR: scratch }
        });
        let output = "";
        let bytes = 0;
        const decoder = new StringDecoder("utf8");
        let errorOutput = "";
        let message: { error?: string; exitCode?: number | null } | undefined;
        let failure: Error | undefined;
        const kill = (error: Error) => {
          failure ??= error;
          try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
        };
        const abort = () => kill(new Error("Operation cancelled"));
        const timer = timeout !== undefined && timeout > 0
          ? setTimeout(() => kill(new Error(`Sandbox operation timed out after ${timeout}s`)), timeout * 1000) : undefined;
        combined.addEventListener("abort", abort, { once: true });
        if (combined.aborted) abort();
        child.on("message", value => { message = value as typeof message; });
        child.stdout!.on("data", (data: Buffer) => {
          if (onData) onData(data);
          else {
            output += decoder.write(data);
            bytes += data.length;
            if (bytes > 32 * 1024 * 1024) kill(new Error("Sandbox tool result exceeds 32 MiB"));
          }
        });
        child.stderr!.on("data", data => { errorOutput = (errorOutput + data.toString()).slice(-8192); });
        child.on("error", error => { failure = error; });
        child.on("exit", () => {
          // A completed shell must not leave ordinary background jobs in its
          // launcher process group running under a previous mode's profile.
          try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch { /* Group already gone. */ }
        });
        child.stdin!.on("error", () => { /* Early broker exit is reported on close. */ });
        child.on("close", code => {
          clearTimeout(timer);
          output += decoder.end();
          combined.removeEventListener("abort", abort);
          if (failure) reject(failure);
          else if (message?.error) reject(new Error(message.error));
          else if (message?.exitCode === undefined) reject(new Error(`Sandbox launcher failed (${code}): ${errorOutput}`));
          else resolve({ exitCode: message.exitCode, output });
        });
        child.stdin!.end(JSON.stringify({ ...request, scratch, root, commandPath }));
      });
    } finally { await rm(scratch, { recursive: true, force: true }); }
  }
  function track<T>(job: Promise<T>): Promise<T> {
    jobs.add(job);
    void job.finally(() => jobs.delete(job)).catch(() => {});
    return job;
  }
  const backend: SandboxBackend = {
    get status() { return status; },
    async check(root, settings, signal) {
      if (closed) throw new Error("Sandbox session closed");
      signal?.throwIfAborted();
      const key = JSON.stringify([root, settings]);
      let check = checks.get(key);
      if (!check) {
        check = track((async () => {
          try {
            if (!["linux", "darwin"].includes(process.platform)) throw new Error(`Unsupported sandbox platform: ${process.platform}`);
            const profile = await sandboxProfile("plan", root, settings);
            const result = await broker({ profile, command: "true" }, root, signal, undefined, 15);
            if (result.exitCode !== 0) throw new Error(`Sandbox probe failed: ${result.output.trim()}`);
            status = "ready";
          } catch (error) {
            if (signal?.aborted) { checks.delete(key); status = "unchecked"; throw error; }
            status = `unavailable: ${(error as Error).message}`;
            throw new Error(`Sandbox ${status}. No unsandboxed fallback. Install/check prerequisites, then /reload.`);
          }
        })());
        checks.set(key, check);
      }
      return check;
    },
    async bash(mode, root, settings, command, options) {
      await backend.check(root, settings, options.signal);
      const profile = await sandboxProfile(mode, root, settings);
      return track(broker({ profile, command }, root, options.signal, options.onData, options.timeout, options.env));
    },
    async tool(mode, root, settings, tool, input, signal) {
      await backend.check(root, settings, signal);
      const profile = await sandboxProfile(mode, root, settings, tool, input.path as string | undefined);
      const result = await track(broker({ profile, toolRequest: { mode, tool, input, settings } }, root, signal, undefined, 120));
      if (result.exitCode !== 0) throw new Error(result.output.trim() || "Sandboxed file operation failed");
      const response = JSON.parse(result.output);
      if (response.error) throw new Error(response.error);
      return response.result;
    },
    async close() {
      closed = true;
      lifetime.abort();
      await Promise.allSettled([...jobs]);
    }
  };
  return backend;
}
