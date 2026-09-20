import { mkdir, realpath, unlink } from "node:fs/promises";
import { Type } from "typebox";
import {
  createBashToolDefinition, createReadToolDefinition, createWriteToolDefinition, createEditToolDefinition,
  createGrepToolDefinition, createFindToolDefinition, createLsToolDefinition, createLocalBashOperations,
  withFileMutationQueue, type ExtensionContext, type ToolDefinition
} from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_SETTINGS, MANAGED_TOOLS, isPlanFile, permission, plansDirectory, resolveToolPath, validateTarget,
  type Mode, type ManagedTool, type ModeSettings
} from "./mode-policy.ts";
import { createSandboxBackend, type SandboxBackend, type ShellOptions } from "./mode-sandbox.ts";

// Heterogeneous built-in schemas retain their own validators/renderers at registration.
export function nativeTools(root: string): ToolDefinition<any, any, any>[] {
  return [createReadToolDefinition(root), createBashToolDefinition(root), createEditToolDefinition(root),
    createWriteToolDefinition(root), createGrepToolDefinition(root), createFindToolDefinition(root), createLsToolDefinition(root), {
      name: "delete_plan", label: "Delete plan", description: "Delete a direct-child Markdown plan in the project's plans directory. In YOLO, ordinary unrestricted file deletion.",
      parameters: Type.Object({ path: Type.String() }),
      async execute(_id, input) {
        const { path } = input as { path: string };
        await unlink(resolveToolPath(path, root));
        return { content: [{ type: "text", text: `Deleted ${path}` }], details: undefined };
      }
    }];
}

/** One seam for authorization AND execution. All managed work is serialized to
 * keep filesystem validation, approval, sandbox snapshots, and mutations local.
 * Unknown tools/subagents are deliberately not authorized by name or prompt. */
export function createModeRuntime(options: {
  root: string; mode?: Mode; settings?: ModeSettings; configurationError?: string; sandbox?: SandboxBackend;
}) {
  let mode: Mode = options.mode ?? "default";
  let revision = 0;
  let pending = 0;
  let queue: Promise<unknown> = Promise.resolve();
  let closed = false;
  const lifetime = new AbortController();
  const root = options.root;
  const settings = structuredClone(options.settings ?? DEFAULT_SETTINGS);
  const sandbox = options.sandbox ?? createSandboxBackend();
  const tools = nativeTools(root);
  const native = new Map(tools.map(tool => [tool.name, tool]));
  function guardCurrent(expected: number, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (closed || revision !== expected) throw new Error("Mode or session changed; retry the operation");
  }
  function schedule<T>(task: (capturedMode: Mode, expected: number, signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const capturedMode = mode;
    const expected = revision;
    const combined = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
    pending++;
    const job = queue.then(async () => {
      guardCurrent(expected, combined);
      return task(capturedMode, expected, combined);
    });
    queue = job.catch(() => {});
    return job.finally(() => { pending--; });
  }
  async function prepare(capturedMode: Mode, tool: ManagedTool, input: Record<string, unknown>, ctx: ExtensionContext, expected: number, signal: AbortSignal, manual = false) {
    if (await realpath(ctx.cwd) !== root) throw new Error("Project directory changed; start a new session");
    if (options.configurationError) throw new Error(options.configurationError);
    const original = JSON.stringify(input);
    const target = await validateTarget(capturedMode, tool, input, root, settings);
    await sandbox.check(root, settings, signal);
    guardCurrent(expected, signal);
    if (!manual && permission(capturedMode, tool, !!target && isPlanFile(target, root)) === "confirm") {
      if (!ctx.hasUI) throw new Error("Explicit approval required, but no confirmation UI is available");
      const approved = await ctx.ui.confirm(`Allow ${tool} in Default mode?`, `${original}\n\nApprove this call only?`, { signal });
      if (approved !== true) throw new Error("Permission declined or cancelled");
    }
    guardCurrent(expected, signal);
    if (JSON.stringify(input) !== original) throw new Error("Tool arguments changed while awaiting approval; retry");
    if (await realpath(ctx.cwd) !== root) throw new Error("Project directory changed while awaiting approval; retry");
    const rechecked = await validateTarget(capturedMode, tool, input, root, settings);
    if (target !== rechecked) throw new Error("Target changed while awaiting approval; retry");
    return target;
  }
  const runtime = {
    tools,
    get mode() { return mode; },
    get busy() { return pending > 0; },
    get sandboxStatus() { return mode === "yolo" ? "off" : options.configurationError ? "configuration error" : sandbox.status; },
    setMode(next: Mode) {
      if (closed || pending) throw new Error("Wait for the current task and tool calls to finish before switching modes");
      mode = next;
      revision++;
    },
    async execute(tool: ManagedTool, id: string, input: Record<string, unknown>, signal: AbortSignal | undefined, onUpdate: any, ctx: ExtensionContext) {
      if (!MANAGED_TOOLS.includes(tool)) throw new Error(`Unmanaged tool: ${tool}`);
      // Capture arguments now; detect mutations while queued/awaiting approval.
      const snapshot = JSON.stringify(input);
      return schedule(async (capturedMode, expected, combined) => {
        if (capturedMode === "yolo") return native.get(tool)!.execute(id, input, combined, onUpdate, ctx);
        if (JSON.stringify(input) !== snapshot) throw new Error("Tool arguments changed while queued; retry");
        const target = await prepare(capturedMode, tool, input, ctx, expected, combined);
        const args = structuredClone(input);
        if (target) args.path = target;
        if (tool === "bash") {
          const definition = createBashToolDefinition(root, { operations: {
            exec: (command, _cwd, execOptions) => sandbox.bash(capturedMode, root, settings, command, { ...execOptions, signal: combined })
          } });
          return definition.execute(id, args as any, combined, onUpdate, ctx);
        }
        const perform = async () => {
          guardCurrent(expected, combined);
          await validateTarget(capturedMode, tool, args, root, settings);
          if (["write", "edit", "delete_plan"].includes(tool) && target && isPlanFile(target, root)) {
            // Trusted provisioning only; no shell receives write access to this directory in Plan.
            await mkdir(plansDirectory(root), { recursive: true, mode: 0o700 });
            await validateTarget(capturedMode, tool, args, root, settings);
          }
          return sandbox.tool(capturedMode, root, settings, tool, args, combined);
        };
        return ["write", "edit", "delete_plan"].includes(tool)
          ? withFileMutationQueue(target!, perform) : perform();
      }, signal);
    },
    manualBash(command: string, cwd: string, execOptions: ShellOptions, ctx: ExtensionContext) {
      return schedule(async (capturedMode, expected, signal) => {
        if (capturedMode === "yolo") return createLocalBashOperations().exec(command, cwd, { ...execOptions, signal });
        await prepare(capturedMode, "bash", { command }, { ...ctx, cwd }, expected, signal, true);
        return sandbox.bash(capturedMode, root, settings, command, { ...execOptions, signal });
      }, execOptions.signal);
    },
    async close() {
      closed = true;
      revision++;
      lifetime.abort();
      await sandbox.close();
      await queue;
    }
  };
  return runtime;
}
export type ModeRuntime = ReturnType<typeof createModeRuntime>;
