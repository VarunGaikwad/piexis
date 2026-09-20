import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fixture } from "./mode-fixtures.mjs";
const cli = fileURLToPath(new URL("cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
const extension = fileURLToPath(new URL("../extensions/mode.ts", import.meta.url));

test("real Pi RPC loads the extension, executes native YOLO, and switches without an LLM", { timeout: 30_000 }, async t => {
  const { root, parent } = await fixture(t);
  const agent = join(parent, "agent");
  await mkdir(agent);
  const child = spawn(process.execPath, [cli, "--mode", "rpc", "--no-session", "--no-context-files", "--no-skills", "--no-prompt-templates", "--no-extensions", "-e", extension, "--permission-mode", "yolo"], {
    cwd: root, env: { ...process.env, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", PI_TELEMETRY: "0" }, stdio: ["pipe", "pipe", "pipe"]
  });
  let buffer = "", stderr = "", id = 0;
  const pending = new Map();
  const notices = [], errors = [];
  const exited = new Promise(resolve => child.once("close", resolve));
  t.after(async () => {
    child.kill("SIGTERM");
    const kill = setTimeout(() => child.kill("SIGKILL"), 2000);
    await exited;
    clearTimeout(kill);
  });
  child.stderr.on("data", data => { stderr += data; });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", data => {
    buffer += data;
    for (;;) {
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      try {
        const event = JSON.parse(line);
        if (event.type === "response") pending.get(event.id)?.(event);
        if (event.type === "extension_error") errors.push(event);
        if (event.type === "extension_ui_request") notices.push(event);
      } catch { errors.push(line); }
    }
  });
  const send = command => new Promise((resolve, reject) => {
    const key = String(++id);
    const timer = setTimeout(() => { pending.delete(key); reject(new Error(`RPC timeout: ${stderr}`)); }, 15_000);
    pending.set(key, response => { clearTimeout(timer); pending.delete(key); resolve(response); });
    child.stdin.write(JSON.stringify({ id: key, ...command }) + "\n");
  });
  const commands = await send({ type: "get_commands" });
  assert.equal(commands.data.commands.filter(c => c.name === "mode").length, 1);
  const bash = await send({ type: "bash", command: "printf rpc-mode-smoke" });
  assert.equal(bash.success, true);
  assert.equal(bash.data.output, "rpc-mode-smoke");
  assert.equal((await send({ type: "prompt", message: "/mode plan" })).success, true);
  assert.ok(notices.some(e => e.method === "setStatus" && /Mode: Plan Mode/.test(e.statusText)));
  assert.equal((await send({ type: "prompt", message: "/mode default" })).success, true);
  assert.ok(notices.some(e => e.method === "setStatus" && /Mode: Default/.test(e.statusText)));
  assert.deepEqual(errors, []);
});
