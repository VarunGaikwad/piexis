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
import { agentNames, childResourceArgs, detectProfileIntent, initializeAgentConfig, isSmallTask, loadAgentConfig, parseAgentConfig, routeSubagent, subagentTools } from "../lib/agents.ts";
import { agentConfigCapabilities, agentConfigSchemaUrl } from "../lib/agent-config.ts";
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
  const argv = process.argv, dir = process.env.PI_CODING_AGENT_DIR, depth = process.env.PIEXIS_SUBAGENT_DEPTH, scope = process.env.PIEXIS_SUBAGENT_SCOPE;
  process.argv = [process.execPath, f.cli];
  process.env.PI_CODING_AGENT_DIR = f.agentDir;
  delete process.env.PIEXIS_SUBAGENT_DEPTH;
  delete process.env.PIEXIS_SUBAGENT_SCOPE;
  try { await work(); }
  finally {
    process.argv = argv;
    for (const [key, value] of [["PI_CODING_AGENT_DIR", dir], ["PIEXIS_SUBAGENT_DEPTH", depth], ["PIEXIS_SUBAGENT_SCOPE", scope]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

function harness(f, flag) {
  const handlers = new Map(), commands = new Map(), shortcuts = new Map(), statuses = new Map(), notifications = [], states = [];
  let tool, active = ["read", "bash", "edit", "write", "grep", "find", "ls", "AskQuestion", "subagent"], mainModel, effort;
  const pi = {
    on(name, handler) { handlers.set(name, handler); }, registerFlag() {}, getFlag: () => flag,
    registerCommand(name, command) { commands.set(name, command); }, registerTool(value) { tool = value; },
    registerShortcut(key, shortcut) { shortcuts.set(key, shortcut); },
    getActiveTools: () => active, setActiveTools(value) { active = value; },
    getThinkingLevel: () => effort ?? "high", appendEntry(type, data) { states.push({ type: "custom", customType: type, data }); },
    async setModel(model) {
      if (model.id === "unauthenticated") return false;
      mainModel = model; ctx.model = model; return true;
    },
    setThinkingLevel(value) { effort = value; ctx.thinkingLevel = value; },
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
  return { pi, ctx, handlers, commands, shortcuts, statuses, notifications, states, get tool() { return tool; },
    get active() { return active; }, get mainModel() { return mainModel; }, get effort() { return effort; },
    start: (reason = "startup") => handlers.get("session_start")({ reason }, ctx),
    input: (text, extra = {}) => handlers.get("input")({ source: "interactive", text, images: [{ type: "image", data: "kept" }], ...extra }, ctx),
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
  assert.equal(parseAgentConfig({ subagent_model: "provider/org/model", delegate_exploration: true, auto_profile: false }).auto_profile, false);
  for (const value of ["true", 1, [], null]) assert.throws(() => parseAgentConfig({ auto_profile: value }));
  assert.throws(() => parseAgentConfig({ delegate_exploration: "true" }));
  assert.match(agentConfigCapabilities.auto_profile, /automatically select/i);
});

test("schema exposes the boolean opt-in with strict configuration keys", async () => {
  const schema = JSON.parse(await readFile(new URL("../schemas/agent.schema.json", import.meta.url), "utf8"));
  assert.equal(schema.properties.auto_profile.type, "boolean");
  assert.equal(schema.additionalProperties, false);
});

test("trusted project config merges fields within overrides without writing settings", async () => {
  await fixture(async (f) => {
    const global = { model: "test/main", small_model: "test/small", auto_profile: true, subagent_variant_overrides: { code: { model: "test/code", effort: "high" }, debug: { effort: "high" } } };
    const local = { subagent_model: "test/worker", auto_profile: false, subagent_variant_overrides: { code: { effort: "low" } } };
    await writeFile(join(f.agentDir, "agents.json"), JSON.stringify(global));
    await writeFile(join(f.cwd, ".pi", "agents.json"), JSON.stringify(local));
    const config = await loadAgentConfig(f.cwd, f.agentDir, true);
    assert.deepEqual(config.subagent_variant_overrides.code, { model: "test/code", effort: "low" });
    assert.deepEqual(config.subagent_variant_overrides.debug, { effort: "high" });
    assert.equal(config.small_model, "test/small");
    assert.equal(config.subagent_model, "test/worker");
    assert.equal(config.auto_profile, false);
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
      $schema: agentConfigSchemaUrl, model: "test/current", small_model: "test/current", subagent_model: "test/current", delegate_exploration: false, auto_profile: false,
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

test("setup-agents command fills only missing project settings", async () => {
  await fixture(async (f) => environment(f, async () => {
    await writeFile(join(f.agentDir, "agent.json"), '{"auto_profile":true}');
    await writeFile(join(f.cwd, ".pi", "agent.json"), JSON.stringify({ model: "test/custom", delegate_exploration: true, auto_profile: false }));
    const h = harness(f);
    await h.commands.get("setup-agents").handler("", h.ctx);
    const config = JSON.parse(await readFile(join(f.cwd, ".pi", "agent.json"), "utf8"));
    assert.equal(config.$schema, agentConfigSchemaUrl);
    assert.equal(config.model, "test/custom");
    assert.equal(config.delegate_exploration, true);
    assert.equal(config.auto_profile, false);
    assert.equal(config.small_model, "test/custom");
    assert.equal(config.subagent_model, "test/custom");
    assert.equal(config.subagent_variant_overrides.code.model, "test/custom");
    assert.match(h.notifications.at(-1)[0], /Added missing/);
    await h.commands.get("setup-agents").handler("", h.ctx);
    assert.match(h.notifications.at(-1)[0], /already complete/);
  }));
});

test("agent scaffold preserves inherited user configuration", async () => {
  await fixture(async (f) => {
    const inherited = { model: "test/main", small_model: "test/small", subagent_model: "test/worker", delegate_exploration: true, auto_profile: true, subagent_variant_overrides: {
      debug: { effort: "off" }, ask: { model: "test/answer" }, code: { model: "test/code", effort: "max" }
    } };
    const path = join(f.agentDir, "agent.json");
    const original = JSON.stringify(inherited);
    await writeFile(path, original);
    assert.equal(await initializeAgentConfig(f.cwd, f.agentDir, "test/current"), true);
    assert.deepEqual(JSON.parse(await readFile(join(f.cwd, ".pi", "agent.json"), "utf8")), {
      $schema: agentConfigSchemaUrl,
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

test("detectProfileIntent recognizes only clear leading requests", () => {
  const cases = [
    [" Let's plan this ", "plan"], ["Please, make a plan for login", "plan"], ["Help me plan a migration", "plan"],
    ["DEBUG this error", "debug"], ["Could you please investigate this failure", "debug"], ["Fix this bug", "debug"],
    ["Explain this function", "ask"], ["Answer this question", "ask"], ["What does this code do?", "ask"], ["How does authentication work?", "ask"],
    ["Orchestrate this work", "orchestrator"], ["Coordinate these tasks", "orchestrator"], ["Delegate these tasks to subagents", "orchestrator"],
    ["Implement this feature", "code"], ["Build the login form", "code"], ["Write this function", "code"], ["Execute this plan", "code"], ["Execute", "code"],
    ["Let’s plan this", "plan"], ["Please\nexecute", "code"],
    ["Explain how to implement login", "ask"], ["Make a plan to debug this", "plan"], ["Coordinate implementation and debugging tasks", "orchestrator"],
    ["Explain this and implement a fix", undefined], ["Implement this and debug the crash", undefined],
    ["Don't execute this", undefined], ["'debug this'", undefined], ["```debug this```", undefined], ["/profile debug", undefined],
    ["The README says 'debug this'", undefined], ["What does 'Execute' mean?", "ask"], ["reexecute", undefined], ["yes", undefined], ["", undefined],
    ["Please don't execute this", undefined], ["Could you please help me debug", "debug"], ["Let's\tplan", "plan"],
    ["Explain how to debug and implement login", "ask"], ["Make a plan to debug and implement login", "plan"],
    ["Explain 'debug this and implement that'", "ask"], ["Explain `code and execute commands`", "ask"],
    ["Execute this and please debug the crash", undefined], ["Plan this. Execute it.", undefined],
    ["Implement login and build a form", "code"], ["Execute is a keyword", undefined], ["> Execute this plan", undefined],
    ["~~~\nExecute\n~~~", undefined], ["execute_plan", undefined], ["lets plan", "plan"], ["Explain this\nDebug the error", undefined],
  ];
  for (const [text, expected] of cases) assert.equal(detectProfileIntent(text), expected, text);
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
  assert.deepEqual(routeSubagent(overrides, "ask", "Explore the configuration", current, "high", true), {
    model: "test/small", effort: "low", reason: "configured exploration small model",
  });
  assert.throws(() => routeSubagent({}, "ask", "Explore", current, "high", true), /requires small_model/);
});

test("child tools never add inactive tools and resource flags preserve explicit extensions", () => {
  const active = ["read", "bash", "write", "AskQuestion", "subagent", "custom"];
  assert.deepEqual(subagentTools("ask", active, 1), ["read"]);
  assert.deepEqual(subagentTools("plan", active, 1), ["read"]);
  assert.deepEqual(subagentTools("plan", active, 1, true), ["read", "subagent"]);
  assert.deepEqual(subagentTools("ask", active, 2, true), ["read"]);
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
    assert.equal(h.tool.executionMode, "parallel");
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

test("configured exploration always uses the small model and stays read-only", async () => {
  await fixture(async (f) => environment(f, async () => {
    await writeFile(join(f.agentDir, "agent.json"), JSON.stringify({
      small_model: "test/small", delegate_exploration: true,
      subagent_variant_overrides: { ask: { model: "test/ask", effort: "max" } },
    }));
    const h = harness(f);
    await h.start();
    assert.match(h.handlers.get("before_agent_start")({ systemPrompt: "base" }).systemPrompt, /purpose: explore/);
    const result = await h.execute({ agent: "ask", purpose: "explore", task: "Locate configuration loading" });
    assert.equal(result.details.model, "test/small");
    assert.equal(result.details.effort, "low");
    assert.equal(result.details.reason, "configured exploration small model");
    assert.deepEqual(h.ctx.model, { provider: "test", id: "current" });
    const output = JSON.parse(result.details.output);
    const tools = output.args[output.args.indexOf("--tools") + 1].split(",");
    assert.ok(!tools.includes("subagent") && !tools.includes("bash"));
    await assert.rejects(h.execute({ agent: "plan", purpose: "explore", task: "Locate configuration loading" }), /requires agent: ask/);
    await writeFile(join(f.agentDir, "agent.json"), JSON.stringify({ small_model: "test/small", delegate_exploration: false }));
    await assert.rejects(h.execute({ agent: "ask", purpose: "explore", task: "Locate configuration loading" }), /Enable delegate_exploration/);
    await writeFile(join(f.agentDir, "agent.json"), JSON.stringify({ delegate_exploration: true }));
    await assert.rejects(h.execute({ agent: "ask", purpose: "explore", task: "Locate configuration loading" }), /requires small_model/);
  }));
});

test("profile command without UI and unknown choices advertise auto", async () => {
  await fixture(async (f) => environment(f, async () => {
    const h = harness(f);
    const choices = [...agentNames, "auto"];
    h.ctx.hasUI = false;
    await h.commands.get("profile").handler("", h.ctx);
    assert.equal(h.notifications.at(-1)[0], `Current agent: code. Use /profile <${choices.join("|")}>.`);
    await h.commands.get("profile").handler("unknown", h.ctx);
    assert.equal(h.notifications.at(-1)[0], `Unknown agent: unknown. Choose ${choices.join(", ")}.`);
    assert.equal(h.states.length, 0);
  }));
});

test("profile picker and completions discover auto without changing its opt-in behavior", async () => {
  await fixture(async (f) => environment(f, async () => {
    const configPath = join(f.agentDir, "agent.json");
    await writeFile(configPath, JSON.stringify({ auto_profile: false, model: "test/main",
      subagent_variant_overrides: { plan: { model: "test/planner", effort: "low" } } }));
    const h = harness(f);
    await h.start();
    const command = h.commands.get("profile");
    const choices = [...agentNames, "auto"];
    assert.deepEqual(command.getArgumentCompletions(""), choices.map((value) => ({ value, label: value })));
    assert.deepEqual(command.getArgumentCompletions("a"), ["ask", "auto"].map((value) => ({ value, label: value })));
    assert.deepEqual(command.getArgumentCompletions("au"), [{ value: "auto", label: "auto" }]);
    assert.deepEqual(command.getArgumentCompletions("or"), [{ value: "orchestrator", label: "orchestrator" }]);
    assert.equal(command.getArgumentCompletions("unmatched"), null);

    await command.handler("plan", h.ctx);
    const disabledStateCount = h.states.length;
    const disabledModel = structuredClone(h.ctx.model);
    const disabledEffort = h.ctx.thinkingLevel;
    let pickerChoices;
    h.ctx.ui.select = async (_title, items) => { pickerChoices = items; return "auto"; };
    await command.handler("", h.ctx);
    assert.deepEqual(pickerChoices, choices);
    assert.equal(h.states.length, disabledStateCount);
    assert.equal(h.states.at(-1).data.pinned, true);
    assert.deepEqual(h.ctx.model, disabledModel);
    assert.equal(h.ctx.thinkingLevel, disabledEffort);
    assert.match(h.notifications.at(-1)[0], /Enable auto_profile/);

    await writeFile(configPath, JSON.stringify({ auto_profile: true, model: "test/main",
      subagent_variant_overrides: { plan: { model: "test/planner", effort: "low" } } }));
    const configured = await readFile(configPath, "utf8");
    await command.handler("", h.ctx);
    assert.deepEqual(pickerChoices, choices);
    assert.equal(h.states.length, disabledStateCount + 1);
    assert.deepEqual(h.states.at(-1).data, { agent: "plan", origin: "manual", pinned: false });
    assert.equal(h.statuses.get("piexis-agent"), "agent:plan");
    assert.deepEqual(h.ctx.model, disabledModel);
    assert.equal(h.ctx.thinkingLevel, disabledEffort);
    assert.equal(await readFile(configPath, "utf8"), configured);

    const stateCount = h.states.length;
    const notifications = h.notifications.length;
    h.ctx.ui.select = async () => undefined;
    await command.handler("", h.ctx);
    assert.equal(h.states.length, stateCount);
    assert.equal(h.notifications.length, notifications);
  }));
});

test("profile commands cancel cleanly, inject instructions, persist and restore branch state", async () => {
  await fixture(async (f) => environment(f, async () => {
    const h = harness(f);
    await h.start();
    const command = h.commands.get("profile");
    assert.deepEqual([...h.commands.keys()].sort(), ["profile", "setup-agents"]);
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
    await h.commands.get("profile").handler("debug", h.ctx);
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

test("commands, picker and cycling apply merged profile models and effort", async () => {
  await fixture(async (f) => environment(f, async () => {
    await writeFile(join(f.agentDir, "agent.json"), JSON.stringify({
      model: "test/main", small_model: "test/small", subagent_model: "test/worker",
      subagent_variant_overrides: { plan: { model: "test/planner", effort: "high" }, debug: { effort: "max" } },
    }));
    await writeFile(join(f.cwd, ".pi", "agent.json"), JSON.stringify({
      subagent_variant_overrides: { plan: { effort: "low" }, ask: { model: "test/answer", effort: "off" } },
    }));
    const h = harness(f);
    h.ctx.mode = "tui";
    await h.start();
    await h.shortcuts.get("alt+a").handler(h.ctx);
    assert.equal(h.mainModel.id, "planner");
    assert.equal(h.effort, "low");
    assert.equal(h.statuses.get("piexis-agent"), "agent:plan");
    await h.commands.get("profile").handler("debug", h.ctx);
    assert.equal(h.mainModel.id, "main");
    assert.equal(h.effort, "max");
    h.ctx.ui.select = async () => "ask";
    await h.commands.get("profile").handler("", h.ctx);
    assert.equal(h.mainModel.id, "answer");
    assert.equal(h.effort, "off");
    h.ctx.isProjectTrusted = () => false;
    await h.commands.get("profile").handler("plan", h.ctx);
    assert.equal(h.mainModel.id, "planner");
    assert.equal(h.effort, "high");
  }));
});

test("unconfigured profile fields leave current settings alone", async () => {
  await fixture(async (f) => environment(f, async () => {
    const h = harness(f);
    await h.commands.get("profile").handler("plan", h.ctx);
    assert.equal(h.mainModel, undefined);
    assert.equal(h.effort, undefined);
    await writeFile(join(f.agentDir, "agent.json"), JSON.stringify({
      small_model: "test/small", subagent_model: "test/worker",
      subagent_variant_overrides: { ask: { effort: "low" }, code: { model: "test/coder" } },
    }));
    await h.commands.get("profile").handler("ask", h.ctx);
    assert.equal(h.mainModel, undefined);
    assert.equal(h.effort, "low");
    await h.commands.get("profile").handler("code", h.ctx);
    assert.equal(h.mainModel.id, "coder");
    assert.equal(h.effort, "low");
  }));
});

test("failed profile switches preserve model, effort and profile and release the switch guard", async () => {
  await fixture(async (f) => environment(f, async () => {
    const h = harness(f);
    h.ctx.mode = "tui";
    await h.start();
    await writeFile(join(f.agentDir, "agent.json"), JSON.stringify({
      subagent_variant_overrides: { code: { model: "test/coder", effort: "medium" } },
    }));
    await h.commands.get("profile").handler("code", h.ctx);
    const count = h.states.length;
    for (const value of ["{bad", ...["missing", "unauthenticated"].map((id) => JSON.stringify({
      subagent_variant_overrides: { plan: { model: `test/${id}`, effort: "max" } },
    }))]) {
      await writeFile(join(f.agentDir, "agent.json"), value);
      await h.shortcuts.get("alt+a").handler(h.ctx);
      assert.equal(h.mainModel.id, "coder");
      assert.equal(h.effort, "medium");
      assert.equal(h.statuses.get("piexis-agent"), "agent:code");
      assert.equal(h.states.length, count);
      assert.equal(h.notifications.at(-1)[1], "warning");
    }
    await writeFile(join(f.agentDir, "agent.json"), "{}");
    await Promise.all([h.shortcuts.get("alt+a").handler(h.ctx), h.commands.get("profile").handler("ask", h.ctx)]);
    assert.equal(h.states.length, count + 1);
    assert.equal(h.statuses.get("piexis-agent"), "agent:plan");
    await h.commands.get("profile").handler("ask", h.ctx);
    assert.equal(h.statuses.get("piexis-agent"), "agent:ask");
  }));
});

test("automatic profiles route eligible input, preserve branch pins, and block failed activation", async () => {
  await fixture(async (f) => environment(f, async () => {
    await writeFile(join(f.agentDir, "agent.json"), JSON.stringify({ auto_profile: true, model: "test/main",
      subagent_variant_overrides: { plan: { model: "test/plan", effort: "low" }, debug: { effort: "max" }, ask: { model: "test/ask", effort: "off" } },
    }));
    const h = harness(f);
    await h.start();
    assert.equal(h.statuses.get("piexis-agent-mode"), "auto");
    for (const [text, agent, model, effort] of [["Make a plan", "plan", "plan", "low"], ["Debug this error", "debug", "main", "max"], ["Explain this", "ask", "ask", "off"], ["Execute", "code", "main", "off"], ["Coordinate these tasks", "orchestrator", "main", "off"]]) {
      const before = h.states.length;
      assert.deepEqual(await h.input(text), { action: "continue" });
      assert.equal(h.statuses.get("piexis-agent"), `agent:${agent}`);
      assert.equal(h.mainModel.id, model);
      assert.equal(h.effort, effort);
      assert.equal(h.states.length, before + 1);
      assert.equal(h.states.at(-1).data.pinned, false);
    }
    const unchanged = h.states.length;
    await h.input("Coordinate this work");
    await h.input("/profile debug");
    await h.input("Explain this", { source: "extension" });
    h.ctx.isIdle = () => false;
    await h.input("Debug this error");
    assert.equal(h.states.length, unchanged);
    h.ctx.isIdle = () => true;
    await h.commands.get("profile").handler("ask", h.ctx);
    assert.equal(h.statuses.get("piexis-agent-mode"), "manual");
    await h.input("Debug this error");
    assert.equal(h.statuses.get("piexis-agent"), "agent:ask");
    await h.commands.get("profile").handler("auto", h.ctx);
    assert.equal(h.statuses.get("piexis-agent-mode"), "auto");
    await h.input("Debug this error");
    assert.equal(h.statuses.get("piexis-agent"), "agent:debug");
    await writeFile(join(f.agentDir, "agent.json"), JSON.stringify({ auto_profile: true, subagent_variant_overrides: { plan: { model: "test/missing" } } }));
    const count = h.states.length;
    assert.deepEqual(await h.input("Make a plan"), { action: "handled" });
    assert.equal(h.states.length, count);
    assert.equal(h.statuses.get("piexis-agent"), "agent:debug");
  }));
});

test("first Execute applies code settings once without a misleading switch notification", async () => {
  await fixture(async (f) => environment(f, async () => {
    await writeFile(join(f.agentDir, "agent.json"), JSON.stringify({ auto_profile: true,
      small_model: "test/small", subagent_model: "test/worker", subagent_variant_overrides: { code: { model: "test/coder", effort: "medium" } } }));
    const h = harness(f);
    await h.start();
    assert.deepEqual(await h.input("Execute"), { action: "continue" });
    assert.equal(h.mainModel.id, "coder");
    assert.equal(h.effort, "medium");
    assert.deepEqual(h.states.at(-1).data, { agent: "code", origin: "automatic", pinned: false });
    assert.equal(h.notifications.length, 0);
    await h.input("Execute");
    await h.input("yes");
    assert.equal(h.states.length, 1);
  }));
});

test("routing skips disabled, unmatched, queued, delegated and non-user input without mutation", async () => {
  await fixture(async (f) => environment(f, async () => {
    const h = harness(f);
    await h.start();
    await h.input("Make a plan");
    assert.equal(h.states.length, 0);
    await writeFile(join(f.agentDir, "agent.json"), '{"auto_profile":true}');
    for (const extra of [{ source: "extension" }, { streamingBehavior: "steer" }, { streamingBehavior: "followUp" }]) {
      assert.deepEqual(await h.input("Make a plan", extra), { action: "continue" });
    }
    for (const text of ["", "looks good", "Explain this and implement it", "/init", "'Make a plan'"]) await h.input(text);
    const event = { source: "rpc", text: "Explain this function", images: [{ type: "image", data: "original" }] };
    const before = structuredClone(event);
    assert.deepEqual(await h.handlers.get("input")(event, h.ctx), { action: "continue" });
    assert.deepEqual(event, before);
    assert.equal(h.statuses.get("piexis-agent"), "agent:ask");
    process.env.PIEXIS_SUBAGENT_DEPTH = "1";
    const child = harness(f, "debug");
    await child.start();
    await child.input("Make a plan");
    assert.equal(child.statuses.get("piexis-agent"), "agent:debug");
    assert.equal(child.states.length, 0);
  }));
});

test("branch state restores automatic origins, manual pins, releases, legacy entries and fresh sessions", async () => {
  await fixture(async (f) => environment(f, async () => {
    await writeFile(join(f.agentDir, "agent.json"), '{"auto_profile":true}');
    const h = harness(f);
    await h.start();
    await h.input("Make a plan");
    const automatic = structuredClone(h.states);
    await h.commands.get("profile").handler("plan", h.ctx);
    assert.equal(h.states.at(-1).data.pinned, true);
    const manual = structuredClone(h.states);
    await h.input("Execute");
    assert.equal(h.states.length, 2);
    await h.commands.get("profile").handler("auto", h.ctx);
    assert.deepEqual(h.states.at(-1).data, { agent: "plan", origin: "manual", pinned: false });
    const released = structuredClone(h.states);
    for (const [state, mode] of [[automatic, "auto"], [manual, "manual"], [released, "auto"]]) {
      h.states.splice(0, h.states.length, ...structuredClone(state));
      h.handlers.get("session_tree")({}, h.ctx);
      assert.equal(h.statuses.get("piexis-agent"), "agent:plan");
      assert.equal(h.statuses.get("piexis-agent-mode"), mode);
      const restored = harness(f);
      restored.states.push(...structuredClone(state), { type: "message" });
      await restored.start("resume");
      assert.equal(restored.statuses.get("piexis-agent-mode"), mode);
      await restored.start("fork");
      assert.equal(restored.statuses.get("piexis-agent"), "agent:plan");
    }
    h.states.splice(0, h.states.length, { type: "custom", customType: "piexis-agent", data: { agent: "debug" } });
    await h.start("reload");
    await h.input("Execute");
    assert.equal(h.states.length, 1);
    assert.equal(h.statuses.get("piexis-agent-mode"), "manual");
    h.states.length = 0;
    await h.start("new");
    assert.equal(h.statuses.get("piexis-agent"), "agent:code");
    assert.equal(h.statuses.get("piexis-agent-mode"), "auto");
  }));
});

test("CLI pins persist, explicit startup flags win, and replacement runtimes don't reapply them", async () => {
  await fixture(async (f) => environment(f, async () => {
    await writeFile(join(f.agentDir, "agent.json"), '{"auto_profile":true}');
    const h = harness(f, "ask");
    h.states.push({ type: "custom", customType: "piexis-agent", data: { agent: "plan", origin: "automatic", pinned: false } });
    await h.start();
    assert.equal(h.statuses.get("piexis-agent"), "agent:ask");
    assert.equal(h.states.at(-1).data.pinned, true);
    await h.input("Execute");
    assert.equal(h.statuses.get("piexis-agent"), "agent:ask");
    const reload = harness(f, "ask");
    reload.states.push({ type: "custom", customType: "piexis-agent", data: { agent: "debug", origin: "automatic", pinned: false } });
    await reload.start("reload");
    assert.equal(reload.statuses.get("piexis-agent"), "agent:debug");
    const fresh = harness(f, "ask");
    await fresh.start("new");
    assert.equal(fresh.statuses.get("piexis-agent"), "agent:code");
    await fresh.input("Make a plan");
    assert.equal(fresh.statuses.get("piexis-agent"), "agent:plan");
    const invalid = harness(f, "question");
    await invalid.start();
    await invalid.input("Make a plan");
    assert.equal(invalid.states.at(-1).data.pinned, false);
  }));
});

test("activation failures restore live runtime settings, don't pin, and stop automatic requests", async () => {
  await fixture(async (f) => environment(f, async () => {
    await writeFile(join(f.agentDir, "agent.json"), JSON.stringify({ auto_profile: true,
      subagent_variant_overrides: { plan: { model: "test/planner", effort: "max" } } }));
    const h = harness(f);
    await h.start();
    h.ctx.model = { provider: "test", id: "externally-selected" };
    h.ctx.thinkingLevel = "low";
    const setEffort = h.pi.setThinkingLevel;
    h.pi.setThinkingLevel = (value) => { setEffort(value); if (value === "max") throw new Error("effort failure"); };
    assert.deepEqual(await h.input("Make a plan"), { action: "handled" });
    assert.equal(h.mainModel.id, "externally-selected");
    assert.equal(h.effort, "low");
    assert.equal(h.states.length, 0);
    assert.equal(h.statuses.get("piexis-agent"), "agent:code");
    h.pi.setThinkingLevel = setEffort;
    await h.input("Make a plan");
    assert.equal(h.states.at(-1).data.pinned, false);
    await writeFile(join(f.agentDir, "agent.json"), '{"auto_profile":true,"subagent_variant_overrides":{"ask":{"model":"test/unauthenticated"}}}');
    assert.deepEqual(await h.input("Explain this"), { action: "handled" });
    assert.equal(h.states.length, 1);
    await h.commands.get("profile").handler("ask", h.ctx);
    assert.equal(h.states.length, 1);
    await writeFile(join(f.agentDir, "agent.json"), "{bad");
    assert.deepEqual(await h.input("Explain this"), { action: "handled" });
    await writeFile(join(f.agentDir, "agent.json"), '{"auto_profile":false}');
    await h.commands.get("profile").handler("auto", h.ctx);
    assert.equal(h.states.length, 1);
  }));
});

test("profile release and automatic routing don't race in-flight switches", async () => {
  await fixture(async (f) => environment(f, async () => {
    await writeFile(join(f.agentDir, "agent.json"), '{"auto_profile":true,"model":"test/main"}');
    const h = harness(f);
    await h.start();
    await h.commands.get("profile").handler("code", h.ctx);
    let resume, entered;
    const barrier = new Promise((resolve) => { entered = resolve; });
    const setModel = h.pi.setModel;
    h.pi.setModel = async (model) => { entered(); await new Promise((resolve) => { resume = resolve; }); return setModel(model); };
    const pending = h.commands.get("profile").handler("debug", h.ctx);
    await barrier;
    await h.commands.get("profile").handler("auto", h.ctx);
    assert.equal(h.states.at(-1).data.pinned, true);
    assert.deepEqual(await h.input("Make a plan"), { action: "continue" });
    resume();
    await pending;
    assert.equal(h.statuses.get("piexis-agent"), "agent:debug");
    assert.equal(h.states.at(-1).data.pinned, true);
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
      await h.commands.get("profile").handler("debug", h.ctx);
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

test("real Pi CLI delegates to automatic and explicit small models without network or credentials", { timeout: 30_000 }, async () => {
  await fixture(async (f) => {
    for (const mode of ["lookup", "orchestrator", "exploration"]) {
      const orchestrate = mode === "orchestrator";
      const exploration = mode === "exploration";
      await writeFile(join(f.agentDir, "agents.json"), JSON.stringify({ small_model: "piexis-test/small", delegate_exploration: true }));
      const invocation = piInvocation();
      const args = [...invocation.args, "--offline", "--no-session", "--mode", "json", "--no-extensions", "--no-skills", "--no-context-files", "--no-prompt-templates",
        "-e", fileURLToPath(new URL("../extensions/agents.ts", import.meta.url)),
        "-e", fileURLToPath(new URL("./fixtures/agents-provider.ts", import.meta.url)),
        "--model", "piexis-test/main", "--tools", "subagent,read", "--", orchestrate ? "Use orchestrator for a lookup" : exploration ? "Delegate exploration" : "Delegate a lookup"];
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
      assert.equal(execution.result.details.reason, orchestrate ? "default subagent" : exploration ? "configured exploration small model" : "automatic small task");
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
    await writeFile(join(f.agentDir, "agent.json"), '{"auto_profile":true}');
    const h = harness(f);
    await h.start();
    const pre = new AbortController(); pre.abort();
    await assert.rejects(h.execute({ agent: "code", task: "task" }, pre.signal), { name: "AbortError" });
    for (const shutdown of [false, true]) {
      const controller = new AbortController();
      let ready;
      const started = new Promise((resolve) => { ready = resolve; });
      const pending = h.execute({ agent: "code", task: "task" }, controller.signal, (value) => {
        if (value.content[0].text.includes("Running read")) ready();
      });
      const rejected = assert.rejects(pending, /aborted/);
      await started;
      const count = h.states.length;
      assert.deepEqual(await h.input("Make a plan"), { action: "continue" });
      await h.commands.get("profile").handler("auto", h.ctx);
      assert.equal(h.states.length, count);
      assert.equal(h.statuses.get("piexis-agent"), "agent:code");
      assert.match(h.notifications.at(-1)[0], /Wait for the current agent/);
      if (shutdown) await h.handlers.get("session_shutdown")(); else controller.abort();
      await rejected;
    }
  }));
});

test("scope metadata validates requests and read mode selects only read tools", async () => {
  await fixture(async (f) => environment(f, async () => {
    const h = harness(f, "orchestrator");
    await h.start();
    for (const params of [{ mode: "other" }, { paths: ["../outside"] }, { paths: ["/absolute"] }, { paths: [""] }]) {
      await assert.rejects(h.execute({ agent: "code", task: "task", ...params }));
    }
    await assert.rejects(h.execute({ agent: "ask", mode: "write", task: "task" }), /read-only/);
    const result = await h.execute({ agent: "code", mode: "read", paths: ["src/./a.ts"], task: "Read the source" });
    assert.equal(result.details.status, "completed");
    assert.equal(result.details.mode, "read");
    assert.deepEqual(result.details.paths, ["src/a.ts"]);
    const output = JSON.parse(result.details.output);
    assert.deepEqual(output.args[output.args.indexOf("--tools") + 1].split(","), ["read", "grep", "find", "ls"]);
    assert.ok(output.args.includes("mcp__*"));
    await writeFile(f.cli, `console.log(JSON.stringify({type:"message_end",message:{role:"assistant",content:[],stopReason:"error",errorMessage:"provider failed"}}));`);
    const updates = [];
    const failed = await h.execute({ agent: "code", paths: ["src/a.ts"], task: "task" }, undefined, (value) => updates.push(value));
    assert.equal(failed.isError, true);
    assert.equal(failed.details.status, "failed");
    assert.equal(updates.at(-1).details.status, "failed");
  }));
});

test("nested writes inherit ownership and cannot escape a scoped or read-only parent", async () => {
  await fixture(async (f) => environment(f, async () => {
    process.env.PIEXIS_SUBAGENT_DEPTH = "1";
    process.env.PIEXIS_SUBAGENT_SCOPE = JSON.stringify({ mode: "write", paths: ["src"], broad: false });
    const h = harness(f, "orchestrator");
    await h.start();
    assert.match(h.handlers.get("before_agent_start")({ systemPrompt: "base" }).systemPrompt, /Declared ownership: write/);
    const inherited = await h.execute({ agent: "code", task: "Make scoped changes" });
    assert.deepEqual(inherited.details.paths, ["src"]);
    const narrower = await h.execute({ agent: "code", paths: ["src/a.ts"], task: "task" });
    assert.deepEqual(narrower.details.paths, ["src/a.ts"]);
    for (const paths of [[], ["other/a.ts"], ["."]]) {
      await assert.rejects(h.execute({ agent: "code", paths, task: "task" }), /parent's declared ownership/);
    }
    process.env.PIEXIS_SUBAGENT_SCOPE = JSON.stringify({ mode: "read", paths: [], broad: false });
    const read = harness(f, "orchestrator");
    await read.start();
    await assert.rejects(read.execute({ agent: "code", task: "Write" }), /parent's declared ownership/);
    assert.equal((await read.execute({ agent: "ask", task: "Read" })).details.mode, "read");
  }));
});

test("subagent footer status counts concurrent profiles, queues conflicts and clears on cancellation", { timeout: 15_000 }, async () => {
  await fixture(async (f) => environment(f, async () => {
    await writeFile(f.cli, `
      console.log(JSON.stringify({type:"tool_execution_start",toolName:"ready"}));
      setInterval(() => {}, 1000);
    `);
    const h = harness(f, "orchestrator");
    await h.start();
    const controllers = [];
    const pending = [];
    async function launch(agent, paths, expected) {
      const controller = new AbortController();
      controllers.push(controller);
      let ready;
      const started = new Promise((resolve) => { ready = resolve; });
      const job = h.execute({ agent, paths, task: "task" }, controller.signal, (value) => {
        if (expected === "queued" ? value.details.status === "queued" : value.content[0].text.includes("Running ready")) ready();
      });
      pending.push(assert.rejects(job));
      await started;
    }
    try {
      await launch("code", ["src/a.ts"], "running");
      assert.equal(h.statuses.get("piexis-subagents"), "subagents · 1 running: code");
      await launch("debug", ["src/b.ts"], "running");
      assert.equal(h.statuses.get("piexis-subagents"), "subagents · 2 running: code, debug");
      await launch("code", ["src/a.ts"], "queued");
      assert.equal(h.statuses.get("piexis-subagents"), "subagents · 2 running: code, debug · 1 queued: code");
      controllers[2].abort();
      await pending[2];
      assert.equal(h.statuses.get("piexis-subagents"), "subagents · 2 running: code, debug");
    } finally {
      for (const controller of controllers) controller.abort();
      await Promise.all(pending);
    }
    assert.equal(h.statuses.get("piexis-subagents"), undefined);
    await assert.rejects(h.execute({ agent: "code", paths: ["../outside"], task: "task" }));
    assert.equal(h.statuses.get("piexis-subagents"), undefined);
  }));
});

test("queued cancellation and shutdown never spawn blocked children and release profile guards", { timeout: 15_000 }, async () => {
  await fixture(async (f) => environment(f, async () => {
    await writeFile(f.cli, `
      import { appendFileSync } from "node:fs";
      let task = ""; for await (const chunk of process.stdin) task += chunk;
      appendFileSync("starts.jsonl", JSON.stringify(task) + "\\n");
      console.log(JSON.stringify({type:"tool_execution_start",toolName:"ready"}));
      setInterval(() => {}, 1000);
    `);
    for (const shutdown of [false, true]) {
      const h = harness(f, "orchestrator");
      await h.start();
      const controller = new AbortController();
      let ready;
      const started = new Promise((resolve) => { ready = resolve; });
      const active = h.execute({ agent: "code", paths: ["src"], task: "active" }, controller.signal, (value) => {
        if (value.content[0].text.includes("Running ready")) ready();
      });
      const activeRejected = assert.rejects(active, /aborted/);
      await started;
      let waiting;
      const isQueued = new Promise((resolve) => { waiting = resolve; });
      const queuedController = new AbortController();
      const queued = h.execute({ agent: "code", paths: ["src/a.ts"], task: "queued" }, queuedController.signal, (value) => {
        if (value.details.status === "queued") waiting();
      });
      const queuedRejected = assert.rejects(queued);
      await isQueued;
      assert.equal((await readFile(join(f.cwd, "starts.jsonl"), "utf8")).trim().split("\n").length, 1);
      await h.commands.get("profile").handler("debug", h.ctx);
      assert.equal(h.statuses.get("piexis-agent"), "agent:orchestrator");
      if (shutdown) await h.handlers.get("session_shutdown")();
      else { queuedController.abort(); controller.abort(); }
      await Promise.all([activeRejected, queuedRejected]);
      assert.equal((await readFile(join(f.cwd, "starts.jsonl"), "utf8")).trim().split("\n").length, 1);
      await h.commands.get("profile").handler("debug", h.ctx);
      assert.equal(h.statuses.get("piexis-agent"), "agent:debug");
      await rm(join(f.cwd, "starts.jsonl"));
      if (shutdown) {
        await h.start("new");
        await writeFile(f.cli, `console.log(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:"restarted"}],stopReason:"stop"}}));`);
        assert.equal((await h.execute({ agent: "code", task: "restart" })).details.status, "completed");
      }
    }
  }));
});
