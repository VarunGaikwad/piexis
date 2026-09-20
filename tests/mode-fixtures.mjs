import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModeRuntime } from "../lib/mode-guard.ts";

export async function fixture(t) {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "piexis-modes-test-")));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, "project");
  await mkdir(join(root, ".pi", "plans"), { recursive: true });
  await writeFile(join(root, "source.ts"), "export const answer = 42;\n");
  await writeFile(join(root, ".env"), "MATCH SECRET-CONTENT\n");
  await writeFile(join(parent, "outside.txt"), "outside\n");
  await symlink(join(parent, "outside.txt"), join(root, "outside-link"));
  await symlink(join(root, ".env"), join(root, "secret-link"));
  return { root, parent };
}
export function fakeSandbox() {
  const calls = [];
  return {
    calls, status: "ready",
    async check() { calls.push(["check"]); },
    async bash(mode, root, settings, command, options) {
      calls.push(["bash", mode, command]);
      options.onData?.(Buffer.from("sandbox output\n"));
      return { exitCode: 0 };
    },
    async tool(mode, root, settings, name, input) {
      calls.push([name, mode, structuredClone(input)]);
      return { content: [{ type: "text", text: "sandbox output" }], details: undefined };
    },
    async close() { calls.push(["close"]); }
  };
}
export function harness(root, mode = "default", options = {}) {
  const sandbox = options.sandbox ?? fakeSandbox();
  const confirmations = [];
  let approve = false;
  const ctx = {
    cwd: root, hasUI: true, isIdle: () => true,
    sessionManager: { getSessionId: () => "test-session", getSessionFile: () => undefined },
    ui: { confirm: async (...args) => { confirmations.push(args); return approve; } }
  };
  const runtime = createModeRuntime({ root, mode, sandbox, ...options });
  return {
    runtime, sandbox, confirmations, ctx,
    approve: value => { approve = value; },
    run: (tool, input, signal) => runtime.execute(tool, "test", input, signal, undefined, ctx)
  };
}
