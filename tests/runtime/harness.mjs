import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { taskGit } from "../../lib/task-git.ts";
import { validateTaskWorktree } from "../../lib/task-worktree-policy.ts";

const sdkRoot = new URL("../", import.meta.resolve("@earendil-works/pi-coding-agent"));
const sdkManifest = JSON.parse(await readFile(new URL("package.json", sdkRoot), "utf8"));
const declaredBin = typeof sdkManifest.bin === "string" ? sdkManifest.bin : sdkManifest.bin.pi;
export const cli = await realpath(process.env.PIEXIS_TEST_PI_CLI ?? fileURLToPath(new URL(declaredBin, sdkRoot)));
const project = fileURLToPath(new URL("../../", import.meta.url));
const text = (content) => typeof content === "string" ? content : (content ?? []).map((part) => part.text ?? "").join("\n");
export async function waitFor(check, diagnostic = () => "", timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((done) => setTimeout(done, 20));
  }
  throw new Error(`Runtime fixture timed out: ${diagnostic()}`);
}

export async function fixture(t, mode = "default", extra = []) {
  const root = await mkdtemp(join(tmpdir(), "piexis-runtime-"));
  const cwd = join(root, "repo");
  const agent = join(root, "agent");
  const children = [];
  let server;
  t.after(cleanup);
  await mkdir(cwd);
  await mkdir(agent);
  await mkdir(join(root, "home"));
  await taskGit(["init"], cwd);
  await taskGit(["config", "user.name", "Runtime fixture"], cwd);
  await taskGit(["config", "user.email", "runtime@example.invalid"], cwd);
  await writeFile(join(cwd, "base.txt"), "fixture\n");
  await taskGit(["add", "."], cwd);
  await taskGit(["commit", "-m", "fixture"], cwd);
  await mkdir(join(cwd, ".pi"));
  await writeFile(join(cwd, ".pi", "permission-modes.json"), JSON.stringify({ version: 1, initialized: true, classifier: { provider: "runtime-fixture", model: "reviewer", timeoutMs: 1000 } }));
  const requests = [];
  const errors = [];
  let reviewBehavior = "allow";
  server = createServer(async (req, res) => {
    try {
      if (req.url !== "/v1/chat/completions" || req.headers.authorization !== "Bearer fixture-not-a-real-key") throw new Error("Unexpected local provider request.");
      let body = "";
      for await (const chunk of req) { body += chunk; if (body.length > 2_000_000) throw new Error("Oversized fixture request"); }
      const input = JSON.parse(body);
      requests.push(input);
      if (requests.length > 80) throw new Error("Fixture request budget exceeded.");
      const lastUser = [...input.messages].reverse().find((message) => message.role === "user");
      const prompt = text(lastUser?.content);
      const last = input.messages.at(-1);
      let content = "Fixture complete.";
      let call;
      if (input.model === "reviewer") {
        if (reviewBehavior === "hold") return;
        if (reviewBehavior === "malformed") content = "not JSON";
        else {
          const payload = JSON.parse(prompt);
          content = JSON.stringify({ decision: "allow", category: "ordinary-development", reason: "Deterministic local transport fixture, not model judgment.", authorizedBy: [payload.context.intent.currentRequestId] });
        }
      } else if (prompt.includes("RUNTIME_HOLD")) return;
      else if ((last?.role !== "tool" || prompt.includes("RUNTIME_REPEAT")) && prompt.includes("RUNTIME_WRITE")) call = { name: "write", arguments: { path: prompt.includes("PLAN_MUST_BLOCK") ? "plan-only.txt" : "made.txt", content: "actual tool executed\n" } };
      else if (last?.role !== "tool" && prompt.includes("RUNTIME_BASH")) call = { name: "bash", arguments: { command: "printf 'runtime-bash-check\\n'" } };
      else if (prompt.includes("RUNTIME_WORKER")) {
        const toolResults = input.messages.filter((message) => message.role === "tool").length;
        if (toolResults === 0) call = { name: "worker_write", arguments: { path: "worker.txt", content: "actual worker edit\n" } };
        else if (toolResults === 1) call = { name: "worker_bash", arguments: { command: "printf 'runtime-worker-check\\n'" } };
        else content = "Fixture complete. I ran npm test and all tests passed."; // Deliberately unverified worker prose.
      }
      const toolCalls = call ? [{ id: `fixture-${requests.length}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] : undefined;
      const message = { role: "assistant", content: toolCalls ? null : content, ...(toolCalls ? { tool_calls: toolCalls } : {}) };
      if (!input.stream) {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ id: "fixture", object: "chat.completion", model: input.model, choices: [{ index: 0, message, finish_reason: toolCalls ? "tool_calls" : "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
      } else {
        res.setHeader("Content-Type", "text/event-stream");
        const delta = toolCalls ? { role: "assistant", tool_calls: toolCalls.map((value, index) => ({ index, ...value })) } : { role: "assistant", content };
        for (const choice of [{ index: 0, delta, finish_reason: null }, { index: 0, delta: {}, finish_reason: toolCalls ? "tool_calls" : "stop" }])
          res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: input.model, choices: [choice] })}\n\n`);
        res.end("data: [DONE]\n\n");
      }
    } catch (error) { errors.push(error.message); res.writeHead(400); res.end("Local fixture rejected request."); }
  });
  await new Promise((done, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", done);
  });
  await writeFile(join(agent, "models.json"), JSON.stringify({ providers: { "runtime-fixture": {
    api: "openai-completions", baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: "fixture-not-a-real-key",
    models: ["agent", "reviewer"].map((id) => ({ id, reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 1024 }))
  } } }));
  await writeFile(join(agent, "settings.json"), JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false }, quietStartup: true }));
  const env = { PATH: process.env.PATH, HOME: join(root, "home"), USERPROFILE: join(root, "home"),
    PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", TERM: "xterm-256color", LANG: "C.UTF-8",
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) };
  const manifest = JSON.parse(await readFile(join(project, "package.json"), "utf8"));
  const extensions = manifest.pi.extensions.flatMap((path) => ["-e", resolve(project, path)]);
  const args = [cli, "--offline", "--no-session", "--no-approve", "--no-context-files", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes",
    "--model", "runtime-fixture/agent", "--permission-mode", mode,
    ...extensions, ...extra];
  async function metadata() {
    const directory = join(agent, "piexis", "tasks");
    const files = await readdir(directory).catch(() => []);
    if (!files.some((name) => name.endsWith(".json"))) return [];
    const saved = JSON.parse(await readFile(join(directory, files.find((name) => name.endsWith(".json"))), "utf8"));
    return saved.tasks;
  }
  function start(command = process.execPath, childArgs = [...args, "--mode", "rpc"]) {
    const child = spawn(command, childArgs, { cwd, env, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
    children.push(child);
    child.on("error", (error) => errors.push(error.message));
    child.stdin.on("error", () => {});
    return child;
  }
  async function cleanup() {
    for (const child of children) {
      child.stdin.end();
      await waitFor(() => child.exitCode !== null || child.signalCode !== null, () => "shutdown", 5000).catch(() => {});
      try { if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch { /* Owned process group already exited. */ }
    }
    if (server?.listening) {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    }
    // Remove only fixture-owned worktrees with matching ownership markers/Git roots.
    for (const task of await metadata()) {
      if (task.repository === cwd && task.worktree) {
        const validated = await validateTaskWorktree(task);
        await rm(validated.parent, { recursive: true, force: true });
      }
    }
    await rm(root, { recursive: true, force: true });
  }
  return { root, cwd, agent, args, env, requests, errors, metadata, start,
    set reviewBehavior(value) { reviewBehavior = value; } };
}

export async function jsonRun(h, message) {
  const child = h.start(process.execPath, [...h.args, "--mode", "json", "--", message]);
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout = (stdout + chunk).slice(-1_000_000); });
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-20000); });
  child.stdin.end();
  await waitFor(() => child.exitCode !== null || child.signalCode !== null, () => `${stderr}\n${stdout.slice(-5000)}`);
  return { events: stdout.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line)), stderr, exitCode: child.exitCode };
}

export async function rpc(h) {
  const child = h.start();
  const events = [];
  let stderr = "";
  let buffer = "";
  let next = 0;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (text) => { stderr = (stderr + text).slice(-20000); });
  child.stdout.on("data", (text) => {
    buffer += text;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      try { events.push(JSON.parse(line)); } catch { events.push({ type: "invalid-json", line }); }
    }
  });
  const send = (value) => child.stdin.write(`${JSON.stringify(value)}\n`);
  const diagnostic = () => JSON.stringify({ stderr, events: events.slice(-8), serverErrors: h.errors });
  async function command(type, values = {}) {
    const id = `rpc-${next++}`;
    send({ id, type, ...values });
    const response = await waitFor(() => events.find((event) => event.type === "response" && event.id === id), diagnostic);
    if (!response.success) throw new Error(response.error);
    return response.data;
  }
  await command("get_state");
  await command("set_auto_retry", { enabled: false });
  return { child, events, send, command, diagnostic,
    wait: (predicate, start = 0) => waitFor(() => events.slice(start).find(predicate), diagnostic),
    async prompt(message) { const start = events.length; await command("prompt", { message }); return start; },
    async settled(start) { return waitFor(() => events.slice(start).find((event) => event.type === "agent_settled"), diagnostic); }
  };
}
