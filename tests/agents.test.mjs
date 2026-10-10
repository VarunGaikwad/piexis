import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import agentsExtension from "../extensions/agents.ts";
import uiExtension from "../extensions/ui.ts";
import { matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import { agentNames, childResourceArgs, initializeAgentConfig, isSmallTask, loadAgentConfig, parseAgentConfig, routeSubagent, subagentTools } from "../lib/agents.ts";
import { emptyUsage, limitOutput, piInvocation, runSubagent } from "../lib/subagent-runner.ts";

async function fixture(work) {
  const root = await mkdtemp(join(tmpdir(), "piexis-agents-"));
  const cwd = join(root, "project"), agentDir = join(root, "agent");
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await mkdir(agentDir);
  const cli = join(root, "cli.mjs");
  await writeFile(cli, `
    let task = "";
    for await (const chunk of process.stdin) task += chunk;
    const usage = { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, totalTokens: 18,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 } };
    const message = { role: "assistant", content: [{ type: "text", text: JSON.stringify({ task, args: process.argv.slice(2), depth: process.env.PIEXIS_SUBAGENT_DEPTH }) }], usage, stopReason: "stop" };
    process.stdout.write(JSON.stringify({ type: "message_end", message }) + "\\n");
  `);
  try { await work({ root, cwd, agentDir, cli }); }
  finally { await rm(root, { recursive: true, force: true }); }
}

async function environment(f, work) {
  const argv = process.argv, dir = process.env.PI_CODING_AGENT_DIR, depth = process.env.PIEXIS_SUBAGENT_DEPTH;
  process.argv = [process.execPath, f.cli];
  process.env.PI_CODING_AGENT_DIR = f.agentDir;
  delete process.env.PIEXIS_SUBAGENT_DEPTH;
  try { await work(); }
  finally {
    process.argv = argv;
    for (const [key, value] of [["PI_CODING_AGENT_DIR", dir], ["PIEXIS_SUBAGENT_DEPTH", depth]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

function harness(f, flag) {
  const handlers = new Map(), commands = new Map(), shortcuts = new Map(), statuses = new Map(), notifications = [], states = [];
  let tool, active = ["read", "bash", "edit", "write", "grep", "find", "ls", "AskQuestion", "subagent"], mainModel;
  const pi = {
    on(name, handler) { handlers.set(name, handler); }, registerFlag() {}, getFlag: () => flag,
    registerCommand(name, command) { commands.set(name, command); }, registerTool(value) { tool = value; },
    registerShortcut(key, shortcut) { shortcuts.set(key, shortcut); },
    getActiveTools: () => active, setActiveTools(value) { active = value; },
    getThinkingLevel: () => "high", appendEntry(type, data) { states.push({ type: "custom", customType: type, data }); },
    async setModel(model) { mainModel = model; return true; },
  };
  agentsExtension(pi);
  const ctx = {
    cwd: f.cwd, hasUI: true, mode: "json", model: { provider: "test", id: "current" }, thinkingLevel: "high",
    isProjectTrusted: () => true, isIdle: () => true, waitForIdle: async () => {},
    sessionManager: { getBranch: () => states, getEntries: () => states },
    modelRegistry: { find: (provider, id) => provider === "test" && id !== "missing" ? { provider, id } : undefined,
      hasConfiguredAuth: (model) => model.id !== "unauthenticated" },
    ui: { setStatus(key, value) { statuses.set(key, value); }, notify(...args) { notifications.push(args); }, select: async () => undefined },
  };
  return { ctx, handlers, commands, shortcuts, statuses, notifications, states, get tool() { return tool; },
    get active() { return active; }, get mainModel() { return mainModel; },
    start: () => handlers.get("session_start")({}, ctx),
    execute: (params, signal, update) => tool.execute("call", params, signal, update, ctx),
  };
}

const current = "test/current";
test("validates configuration and rejects typos, bad models and efforts", () => {
  assert.deepEqual(parseAgentConfig({}), {});
  for (const bad of [null, [], { model: "bare-id" }, { model: "test/has space" }, { smallModel: "test/model" },
    { subagent_variant_overrides: [] }, { subagent_variant_overrides: { worker: {} } },
    { subagent_variant_overrides: { code: { effort: "huge" } } }, { subagent_variant_overrides: { code: { tools: [] } } }]) {
    assert.throws(() => parseAgentConfig(bad));
  }
  assert.equal(parseAgentConfig({ subagent_model: "provider/org/model" }).subagent_model, "provider/org/model");
});

test("trusted project config merges fields within overrides without writing settings", async () => {
  await fixture(async (f) => {
    const global = { model: "test/main", small_model: "test/small", subagent_variant_overrides: { code: { model: "test/code", effort: "high" }, debug: { effort: "high" } } };
    const local = { subagent_model: "test/worker", subagent_variant_overrides: { code: { effort: "low" } } };
    await writeFile(join(f.agentDir, "agents.json"), JSON.stringify(global));
    await writeFile(join(f.cwd, ".pi", "agents.json"), JSON.stringify(local));
    const config = await loadAgentConfig(f.cwd, f.agentDir, true);
    assert.deepEqual(config.subagent_variant_overrides.code, { model: "test/code", effort: "low" });
    assert.deepEqual(config.subagent_variant_overrides.debug, { effort: "high" });
    assert.equal(config.small_model, "test/small");
    assert.equal(config.subagent_model, "test/worker");
    assert.deepEqual(await loadAgentConfig(f.cwd, f.agentDir, false), global);
    await writeFile(join(f.cwd, ".pi", "agents.json"), "{bad");
    await assert.rejects(loadAgentConfig(f.cwd, f.agentDir, true), /agents.json/);
    assert.deepEqual(await loadAgentConfig(f.cwd, f.agentDir, false), global);
    await assert.rejects(readFile(join(f.cwd, ".pi", "settings.json")), { code: "ENOENT" });
  });
});

test("singular agent.json is preferred per scope, with legacy agents.json fallback", async () => {
  await fixture(async (f) => {
    await writeFile(join(f.agentDir, "agents.json"), '{"model":"test/legacy"}');
    await writeFile(join(f.agentDir, "agent.json"), '{"model":"test/main"}');
    await writeFile(join(f.cwd, ".pi", "agents.json"), '{"subagent_model":"test/worker"}');
    assert.equal((await loadAgentConfig(f.cwd, f.agentDir, true)).model, "test/main");
    assert.equal((await loadAgentConfig(f.cwd, f.agentDir, true)).subagent_model, "test/worker");
    await writeFile(join(f.cwd, ".pi", "agent.json"), '{"subagent_model":"test/local"}');
    assert.equal((await loadAgentConfig(f.cwd, f.agentDir, true)).subagent_model, "test/local");
    assert.equal((await loadAgentConfig(f.cwd, f.agentDir, false)).subagent_model, undefined);
    await writeFile(join(f.cwd, ".pi", "agent.json"), "{bad");
    await assert.rejects(loadAgentConfig(f.cwd, f.agentDir, true), /agent.json/);
  });
});

test("opt-in agent scaffold uses the active model, restrictive permissions and atomic create-only writes", async () => {
  await fixture(async (f) => {
    const created = await Promise.all([initializeAgentConfig(f.cwd, f.agentDir, "test/current"), initializeAgentConfig(f.cwd, f.agentDir, "test/other")]);
    assert.deepEqual(created, [true, false]);
    const path = join(f.cwd, ".pi", "agent.json");
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
      model: "test/current", small_model: "test/current", subagent_model: "test/current",
      subagent_variant_overrides: {
        plan: { model: "test/current", effort: "high" },
        orchestrator: { model: "test/current", effort: "high" },
        debug: { model: "test/current", effort: "high" },
        ask: { model: "test/current", effort: "low" },
        code: { model: "test/current", effort: "medium" },
      }
    });
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.deepEqual(await readdir(join(f.cwd, ".pi")), ["agent.json"]);
    assert.equal((await loadAgentConfig(f.cwd, f.agentDir, true)).model, "test/current");
  });
});

test("agent scaffold preserves inherited user configuration", async () => {
  await fixture(async (f) => {
    const inherited = { model: "test/main", small_model: "test/small", subagent_model: "test/worker", subagent_variant_overrides: {
      debug: { effort: "off" }, ask: { model: "test/answer" }, code: { model: "test/code", effort: "max" }
    } };
    const path = join(f.agentDir, "agent.json");
    const original = JSON.stringify(inherited);
    await writeFile(path, original);
    assert.equal(await initializeAgentConfig(f.cwd, f.agentDir, "test/current"), true);
    assert.deepEqual(JSON.parse(await readFile(join(f.cwd, ".pi", "agent.json"), "utf8")), {
      ...inherited,
      subagent_variant_overrides: {
        plan: { model: "test/worker", effort: "high" },
        orchestrator: { model: "test/worker", effort: "high" },
        debug: { model: "test/worker", effort: "off" },
        ask: { model: "test/answer", effort: "low" },
        code: { model: "test/code", effort: "max" },
      },
    });
    assert.equal(await readFile(path, "utf8"), original);
  });
});

test("agent scaffold never replaces existing, malformed, legacy or non-regular files", async () => {
  for (const name of ["agent.json", "agents.json"]) {
    for (const value of ['{"model":"test/custom"}', "{bad", "directory", "symlink"]) {
      await fixture(async (f) => {
        const path = join(f.cwd, ".pi", name);
        const target = join(f.root, "target.json");
        if (value === "directory") await mkdir(path);
        else if (value === "symlink") { await writeFile(target, "do not change"); await symlink(target, path); }
        else await writeFile(path, value);
        assert.equal(await initializeAgentConfig(f.cwd, f.agentDir, "test/current"), false);
        if (value === "symlink") assert.equal(await readFile(target, "utf8"), "do not change");
        else if (value !== "directory") assert.equal(await readFile(path, "utf8"), value);
        assert.deepEqual(await readdir(join(f.cwd, ".pi")), [name]);
      });
    }
  }
});

test("missing models, invalid inherited configuration and cancellation do not create an agent file", async () => {
  await fixture(async (f) => {
    await assert.rejects(initializeAgentConfig(f.cwd, f.agentDir, undefined), /No active model/);
    await assert.rejects(initializeAgentConfig(f.cwd, f.agentDir, "bare-id"), /provider\/model/);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(initializeAgentConfig(f.cwd, f.agentDir, "test/current", controller.signal), { name: "AbortError" });
    await writeFile(join(f.agentDir, "agent.json"), "{bad");
    await assert.rejects(initializeAgentConfig(f.cwd, f.agentDir, "test/current"), /agent.json/);
    assert.deepEqual(await readdir(join(f.cwd, ".pi")), []);
  });
});

test("automatic small routing is conservative and variant overrides take precedence", () => {
  const config = { model: "test/main", small_model: "test/small", subagent_model: "test/worker" };
  for (const task of ["Locate the auth entry point", "What does parseConfig do?", "Summarize README.md"]) {
    const route = routeSubagent(config, "ask", task, current, "high");
    assert.deepEqual(route, { model: "test/small", effort: "low", reason: "automatic small task" });
  }
  assert.equal(isSmallTask("code", "Fix a typo in README.md"), true);
  for (const [agent, task] of [["ask", "Explain the security architecture"], ["ask", "Summarize the entire repo"], ["code", "Implement login"], ["debug", "Fix typo"], ["plan", "List files"], ["orchestrator", "Find config"], ["ask", "List " + "x".repeat(401)]]) {
    assert.equal(routeSubagent(config, agent, task, current, "high").model, "test/worker");
  }
  assert.equal(routeSubagent({}, "code", "task", current, "high").model, current);
  assert.equal(routeSubagent({ model: "test/main" }, "code", "task", current, "high").model, current);
  const overrides = { ...config, subagent_variant_overrides: { ask: { model: "test/ask", effort: "max" }, code: { effort: "high" } } };
  assert.deepEqual(routeSubagent(overrides, "ask", "Locate config", current, "off"), { model: "test/ask", effort: "max", reason: "variant override" });
  assert.equal(routeSubagent(overrides, "code", "Fix a typo", current, "off").effort, "high");
});

test("child tools never add inactive tools and resource flags preserve explicit extensions", () => {
  const active = ["read", "bash", "write", "AskQuestion", "subagent", "custom"];
  assert.deepEqual(subagentTools("ask", active, 1), ["read"]);
  assert.deepEqual(subagentTools("plan", active, 1), ["read"]);
  assert.deepEqual(subagentTools("orchestrator", active, 1), ["read", "bash", "write", "subagent", "custom"]);
  assert.deepEqual(subagentTools("code", active, 2), ["read", "bash", "write", "custom"]);
  assert.deepEqual(childResourceArgs(["--model", "test/main", "--no-extensions", "-e", "gate.ts", "--no-mcp", "--api-key", "private", "--", "-e", "bad.ts"]), ["--no-extensions", "-e", "gate.ts", "--no-mcp"]);
});

test("all five profiles execute as child agents with visible routing and preserved loadout", async () => {
  await fixture(async (f) => environment(f, async () => {
    await writeFile(join(f.agentDir, "agents.json"), JSON.stringify({ small_model: "test/small", subagent_model: "test/worker", subagent_variant_overrides: { plan: { model: "test/planner", effort: "max" } } }));
    process.argv.push("--no-extensions", "-e", "gate.ts");
    const h = harness(f);
    await h.start();
    assert.equal(h.tool.executionMode, "sequential");
    for (const agent of agentNames) {
      const updates = [];
      const result = await h.execute({ agent, task: agent === "ask" ? "Locate the config" : "Complete this task" }, undefined, (value) => updates.push(value));
      assert.equal(result.isError, false);
      const output = JSON.parse(result.details.output);
      assert.equal(output.depth, "1");
      assert.match(output.task, /^Task:/);
      assert.ok(output.args.includes("--approve"));
      assert.ok(output.args.includes("gate.ts"));
      assert.equal(output.args[output.args.indexOf("--agent") + 1], agent);
      const tools = output.args[output.args.indexOf("--tools") + 1].split(",");
      assert.ok(!tools.includes("AskQuestion"));
      if (["plan", "ask"].includes(agent)) {
        assert.ok(!tools.includes("bash") && !tools.includes("subagent"));
        assert.ok(output.args.includes("mcp__*"));
      }
      assert.equal(result.details.model, agent === "ask" ? "test/small" : agent === "plan" ? "test/planner" : "test/worker");
      assert.equal(result.details.effort, agent === "ask" ? "low" : agent === "plan" ? "max" : "high");
      assert.equal(result.usage.input, 10);
      assert.match(result.content[0].text, new RegExp(result.details.reason));
      assert.ok(updates.length > 0);
    }
  }));
});

test("profile commands cancel cleanly, inject instructions, persist and restore branch state", async () => {
  await fixture(async (f) => environment(f, async () => {
    const h = harness(f);
    await h.start();
    const command = h.commands.get("agent");
    const prompt = () => h.handlers.get("before_agent_start")({ systemPrompt: "base" }, h.ctx).systemPrompt;
    await command.handler("", h.ctx);
    assert.equal(h.states.length, 0);
    await command.handler("plan", h.ctx);
    assert.match(prompt(), /base[\s\S]*profile: plan/);
    await assert.rejects(h.execute({ agent: "code", task: "Make changes" }), /only to plan or ask/);
    await command.handler("nonsense", h.ctx);
    assert.match(prompt(), /profile: plan/);
    await command.handler("debug", h.ctx);
    assert.match(prompt(), /trace its cause/);
    h.states.pop();
    h.handlers.get("session_tree")({}, h.ctx);
    assert.match(prompt(), /profile: plan/);
    h.states.length = 0;
    h.handlers.get("session_tree")({}, h.ctx);
    assert.match(prompt(), /profile: code/);
  }));
});

test("Alt+A cycles all profiles, persists the selection and respects busy/non-TUI sessions", async () => {
  await fixture(async (f) => environment(f, async () => {
    const h = harness(f);
    h.ctx.mode = "tui";
    await h.start();
    assert.equal(h.shortcuts.size, 1);
    const shortcut = h.shortcuts.get("alt+a");
    assert.ok(shortcut);
    assert.ok(matchesKey("\u001ba", "alt+a"));
    assert.equal(h.statuses.get("piexis-agent"), "agent:code");
    for (const name of agentNames) {
      await shortcut.handler(h.ctx);
      assert.equal(h.statuses.get("piexis-agent"), `agent:${name}`);
      assert.equal(h.states.at(-1).data.agent, name);
      assert.match(h.handlers.get("before_agent_start")({ systemPrompt: "base" }).systemPrompt, new RegExp(`profile: ${name}`));
    }
    const count = h.states.length;
    h.ctx.isIdle = () => false;
    await shortcut.handler(h.ctx);
    assert.equal(h.states.length, count);
    assert.equal(h.notifications.at(-1)[1], "warning");
    h.ctx.isIdle = () => true;
    for (const mode of ["json", "rpc", "print"]) {
      h.ctx.mode = mode;
      await shortcut.handler(h.ctx);
      assert.equal(h.states.length, count);
    }
    h.ctx.mode = "tui";
    await h.commands.get("agent").handler("debug", h.ctx);
    await shortcut.handler(h.ctx);
    assert.equal(h.statuses.get("piexis-agent"), "agent:ask");
    h.states.pop();
    h.handlers.get("session_tree")({}, h.ctx);
    assert.equal(h.statuses.get("piexis-agent"), "agent:debug");
    const resumed = harness(f);
    resumed.states.push(...h.states);
    await resumed.start();
    assert.equal(resumed.statuses.get("piexis-agent"), "agent:debug");
  }));
});

test("footer reads live agent status after commands, cycling and tree restoration without losing width bounds", async () => {
  await fixture(async (f) => environment(f, async () => {
    const h = harness(f);
    h.ctx.mode = "tui";
    h.ctx.getContextUsage = () => undefined;
    const uiHandlers = new Map();
    const theme = { fg: (_color, text) => `\u001b[36m${text}\u001b[39m`, bold: (text) => `\u001b[1m${text}\u001b[22m` };
    let footer;
    Object.assign(h.ctx.ui, {
      setTitle() {}, setHeader() {},
      setFooter(make) { footer = make({ requestRender() {} }, theme, {
        getGitBranch: () => "main", getExtensionStatuses: () => h.statuses, onBranchChange: () => () => {},
      }); },
    });
    uiExtension({ on(name, handler) { uiHandlers.set(name, handler); }, getThinkingLevel: () => "high" });
    await uiHandlers.get("session_start")({}, h.ctx);
    try {
      assert.doesNotMatch(footer.render(160).join("\n"), /agent:/);
      await h.start();
      assert.match(footer.render(160).join("\n"), /agent:code/);
      assert.match(footer.render(160).join("\n"), /Alt\+A/);
      for (const name of agentNames) {
        await h.shortcuts.get("alt+a").handler(h.ctx);
        for (const width of [40, 60, 80, 160]) {
          const rows = footer.render(width);
          assert.match(rows.join("\n"), new RegExp(`agent:${name}`));
          for (const row of rows) assert.ok(visibleWidth(row) <= width);
        }
      }
      await h.commands.get("agent").handler("debug", h.ctx);
      assert.match(footer.render(160).join("\n"), /agent:debug/);
      h.states.pop();
      h.handlers.get("session_tree")({}, h.ctx);
      assert.match(footer.render(160).join("\n"), /agent:code/);
      h.ctx.model = { id: "研究🚀".repeat(100) };
      for (let width = 0; width <= 160; width++) {
        for (const row of footer.render(width)) assert.ok(visibleWidth(row) <= width);
      }
      assert.match(footer.render(40).join("\n"), /agent:code/);
      h.statuses.clear();
      assert.doesNotMatch(footer.render(160).join("\n"), /agent:|Alt\+A/);
    } finally { footer.dispose(); }
  }));
});

test("configured main model initializes only new sessions, not CLI overrides or resumes", async () => {
  await fixture(async (f) => environment(f, async () => {
    await writeFile(join(f.agentDir, "agents.json"), '{"model":"test/main"}');
    const h = harness(f, "ask");
    await h.start();
    assert.equal(h.mainModel.id, "main");
    assert.match(h.handlers.get("before_agent_start")({ systemPrompt: "base" }).systemPrompt, /profile: ask/);
    process.argv.push("--model", "test/explicit");
    const explicit = harness(f);
    await explicit.start();
    assert.equal(explicit.mainModel, undefined);
    process.argv.length -= 2;
    const resumed = harness(f);
    resumed.states.push({ type: "message" });
    await resumed.start();
    assert.equal(resumed.mainModel, undefined);
  }));
});

test("invalid requests, unavailable models and depth limits fail without spawning", async () => {
  await fixture(async (f) => environment(f, async () => {
    const h = harness(f);
    for (const params of [{ agent: "worker", task: "task" }, { agent: "code", task: " " }]) await assert.rejects(h.execute(params));
    for (const id of ["missing", "unauthenticated"]) {
      await writeFile(join(f.agentDir, "agents.json"), JSON.stringify({ subagent_model: `test/${id}` }));
      await assert.rejects(h.execute({ agent: "code", task: "task" }), /unavailable/);
    }
    process.env.PIEXIS_SUBAGENT_DEPTH = "2";
    const nested = harness(f);
    await nested.start();
    assert.ok(!nested.active.includes("subagent"));
    await assert.rejects(nested.execute({ agent: "orchestrator", task: "task" }), /depth limit/);
  }));
});

test("runner handles UTF-8 framing, multiple text blocks, tool usage, retries and failed responses", async () => {
  await fixture(async (f) => {
    const usage = emptyUsage(); usage.input = 4; usage.totalTokens = 4;
    const events = [
      { type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "temporary", usage } },
      { type: "message_end", message: { role: "toolResult", usage } },
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "你好\u2028🌍" }, { type: "text", text: "done" }], stopReason: "stop", usage } },
    ];
    await writeFile(f.cli, `const data = Buffer.from(${JSON.stringify(events.map((event) => JSON.stringify(event)).join("\n"))}); for (const byte of data) process.stdout.write(Buffer.from([byte]));`);
    const run = () => runSubagent({ invocation: { command: process.execPath, args: [f.cli] }, args: [], cwd: f.cwd, depth: 1, task: "task", signal: new AbortController().signal });
    const result = await run();
    assert.equal(result.output, "你好\u2028🌍\ndone");
    assert.equal(result.error, undefined);
    assert.equal(result.usage.input, 12);
    await writeFile(f.cli, `console.log(${JSON.stringify(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "provider failed" } }))});`);
    const failed = await run();
    assert.equal(failed.exitCode, 0);
    assert.equal(failed.error, "provider failed");
    await writeFile(f.cli, 'process.stderr.write("startup failed"); process.exitCode = 3;');
    assert.equal((await run()).exitCode, 3);
    await writeFile(f.cli, 'console.log("not json");');
    await assert.rejects(run(), /Invalid JSON/);
    assert.match(limitOutput("x".repeat(60_000)), /truncated/);
  });
});

test("real Pi CLI delegates to the automatic small model without network or credentials", { timeout: 30_000 }, async () => {
  await fixture(async (f) => {
    for (const orchestrate of [false, true]) {
      await writeFile(join(f.agentDir, "agents.json"), JSON.stringify({ small_model: "piexis-test/small" }));
      const invocation = piInvocation();
      const args = [...invocation.args, "--offline", "--no-session", "--mode", "json", "--no-extensions", "--no-skills", "--no-context-files", "--no-prompt-templates",
        "-e", fileURLToPath(new URL("../extensions/agents.ts", import.meta.url)),
        "-e", fileURLToPath(new URL("./fixtures/agents-provider.ts", import.meta.url)),
        "--model", "piexis-test/main", "--tools", "subagent,read", "--", orchestrate ? "Use orchestrator for a lookup" : "Delegate a lookup"];
      const executionPromise = promisify(execFile)(invocation.command, args, {
        cwd: f.cwd, env: { ...process.env, PI_CODING_AGENT_DIR: f.agentDir, PIEXIS_SUBAGENT_DEPTH: "0", PI_OFFLINE: "1" },
        timeout: 25_000, maxBuffer: 4 * 1024 * 1024,
      });
      executionPromise.child.stdin.end();
      const { stdout } = await executionPromise;
      const events = stdout.trim().split("\n").map((line) => JSON.parse(line));
      const execution = events.find((event) => event.type === "tool_execution_end" && event.toolName === "subagent");
      assert.ok(execution, stdout);
      assert.equal(execution.isError, false, JSON.stringify(execution));
      assert.equal(execution.result.details.model, orchestrate ? "piexis-test/main" : "piexis-test/small");
      assert.equal(execution.result.details.reason, orchestrate ? "default subagent" : "automatic small task");
      if (orchestrate) assert.match(execution.result.details.output, /child:small;depth:2/);
      else assert.equal(execution.result.details.output, "child:small;depth:1");
      assert.equal(execution.result.usage.input, orchestrate ? 30 : 10);
      assert.ok(events.some((event) => event.type === "message_end" && event.message.content?.some((part) => part.text === "parent completed")));
    }
  });
});

test("abort and shutdown terminate running children; pre-aborted calls never start", { timeout: 10_000 }, async () => {
  await fixture(async (f) => environment(f, async () => {
    await writeFile(f.cli, 'process.on("SIGTERM", () => {}); console.log(JSON.stringify({type:"tool_execution_start",toolName:"read"})); setInterval(() => {}, 1000);');
    const h = harness(f);
    const pre = new AbortController(); pre.abort();
    await assert.rejects(h.execute({ agent: "code", task: "task" }, pre.signal), { name: "AbortError" });
    for (const shutdown of [false, true]) {
      const controller = new AbortController();
      let ready;
      const started = new Promise((resolve) => { ready = resolve; });
      const pending = h.execute({ agent: "code", task: "task" }, controller.signal, ready);
      const rejected = assert.rejects(pending, /aborted/);
      await started;
      if (shutdown) await h.handlers.get("session_shutdown")(); else controller.abort();
      await rejected;
    }
  }));
});
