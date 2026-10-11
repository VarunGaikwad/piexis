import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import recommendedToolsExtension from "../extensions/recommended-tools.ts";
import { agentConfigSchemaUrl } from "../lib/agent-config.ts";
import { hasToolOverrides, readSetupSettings, saveSetupChoice, supportsAdditiveTools, toolsToOffer } from "../lib/recommended-tools.ts";

const base = ["read", "bash", "edit", "write", "AskQuestion"];
const recommended = ["grep", "find", "ls"];

async function fixture(work) {
  const root = await mkdtemp(join(tmpdir(), "piexis-setup-"));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  await mkdir(cwd);
  await mkdir(agentDir);
  const projectPath = join(cwd, ".pi", "settings.json");
  const globalPath = join(agentDir, "settings.json");
  async function project(value) {
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await writeFile(projectPath, typeof value === "string" ? value : JSON.stringify(value), { mode: 0o640 });
  }
  async function global(value) { await writeFile(globalPath, JSON.stringify(value)); }
  try { await work({ cwd, agentDir, projectPath, globalPath, project, global }); }
  finally { await rm(root, { recursive: true, force: true }); }
}

function policy(project = {}, global = {}) {
  return { project: { settings: project }, global: { settings: global } };
}

test("offers only available inactive recommendations, not active tools or prior choices", () => {
  assert.deepEqual(toolsToOffer(policy(), recommended, base, true), recommended);
  assert.deepEqual(toolsToOffer(policy(), ["grep", "find"], [...base, "grep"], true), ["find"]);
  assert.deepEqual(toolsToOffer(policy(), recommended, [...base, ...recommended], true), []);
  for (const choice of ["enabled", "disabled"]) {
    assert.deepEqual(toolsToOffer(policy({ piexis: { recommendedTools: choice } }), recommended, base, true), []);
  }
});

test("preserves global/project allowlists, empty lists and ordered exclusions", () => {
  for (const list of [[], ["read"], ["read", "+find"], ["grep", "find", "ls"]]) {
    assert.deepEqual(toolsToOffer(policy({ defaultTools: list }), recommended, base, true), []);
    assert.deepEqual(toolsToOffer(policy({}, { defaultTools: list }), recommended, base, true), []);
  }
  assert.deepEqual(toolsToOffer(policy({ defaultTools: ["-find"] }), recommended, base, true), ["grep", "ls"]);
  assert.deepEqual(toolsToOffer(policy({}, { defaultTools: ["-grep"] }), recommended, base, true), ["find", "ls"]);
  assert.deepEqual(toolsToOffer(policy({ defaultTools: ["+find"] }, { defaultTools: ["-find"] }), recommended, base, true), recommended);
  assert.deepEqual(toolsToOffer(policy({ defaultTools: ["+find", "-find"] }), recommended, base, true), ["grep", "ls"]);
  assert.deepEqual(toolsToOffer(policy({ defaultTools: ["+find"] }), recommended, base, false), []);
});

test("CLI overrides skip setup and -- terminates option detection", () => {
  for (const flag of ["--tools", "--tools=read", "-t", "--exclude-tools", "--exclude-tools=find", "-xt", "--no-builtin-tools", "-nbt", "--no-tools", "-nt"]) {
    assert.equal(hasToolOverrides([flag]), true);
  }
  assert.equal(hasToolOverrides(["--", "--tools"]), false);
  assert.equal(hasToolOverrides(["--model", "sonnet", "--extension", "./extension.ts"]), false);
});

test("enable safely merges additive entries, unknown settings, namespace and file mode", async () => {
  await fixture(async (f) => {
    await f.global({ defaultTools: ["-write", "+codemode"], theme: "dark" });
    await f.project({ defaultTools: ["-find", "+custom"], packages: ["npm:example"], piexis: { existing: 42 }, custom: { nested: true } });
    const settings = await readSetupSettings(f.cwd, f.agentDir);
    const originalGlobal = await readFile(f.globalPath, "utf8");
    const mode = (await stat(f.projectPath)).mode & 0o777;
    await saveSetupChoice(settings, "enabled", ["grep", "ls"], true);
    const saved = JSON.parse(await readFile(f.projectPath, "utf8"));
    assert.deepEqual(saved.defaultTools, ["-find", "+custom", "+grep", "+ls"]);
    assert.deepEqual(saved.piexis, { existing: 42, recommendedTools: "enabled" });
    assert.deepEqual(saved.custom, { nested: true });
    assert.deepEqual(saved.packages, ["npm:example"]);
    assert.equal(await readFile(f.globalPath, "utf8"), originalGlobal);
    assert.equal((await stat(f.projectPath)).mode & 0o777, mode);
    assert.deepEqual(await readdir(join(f.cwd, ".pi")), ["settings.json"]);
  });
});

test("fresh projects use additive configuration, with a valid plain-list fallback for older Pi", async () => {
  for (const additive of [true, false]) {
    await fixture(async (f) => {
      await saveSetupChoice(await readSetupSettings(f.cwd, f.agentDir), "enabled", recommended, additive);
      const saved = JSON.parse(await readFile(f.projectPath, "utf8"));
      assert.deepEqual(saved.defaultTools, additive ? ["+grep", "+find", "+ls"] : [...base.slice(0, 4), ...recommended]);
      assert.equal((await stat(f.projectPath)).mode & 0o777, 0o600);
    });
  }
});

test("Don't ask again records only a project preference and leaves defaultTools untouched", async () => {
  await fixture(async (f) => {
    await f.project({ defaultTools: ["-find"], theme: "orange" });
    await saveSetupChoice(await readSetupSettings(f.cwd, f.agentDir), "disabled", recommended, true);
    const saved = JSON.parse(await readFile(f.projectPath, "utf8"));
    assert.deepEqual(saved.defaultTools, ["-find"]);
    assert.equal(saved.theme, "orange");
    assert.equal(saved.piexis.recommendedTools, "disabled");
    assert.deepEqual(toolsToOffer(await readSetupSettings(f.cwd, f.agentDir), recommended, base, true), []);
  });
});

test("malformed settings and non-regular files are never replaced", async () => {
  for (const invalid of ["{ broken", "[]", "null", '{"defaultTools":"read"}', '{"defaultTools":[3]}', '{"piexis":false}']) {
    await fixture(async (f) => {
      await f.project(invalid);
      await assert.rejects(readSetupSettings(f.cwd, f.agentDir));
      assert.equal(await readFile(f.projectPath, "utf8"), invalid);
    });
  }
  await fixture(async (f) => {
    await f.global({ theme: "dark" });
    await mkdir(join(f.cwd, ".pi"));
    await symlink(f.globalPath, f.projectPath);
    await assert.rejects(readSetupSettings(f.cwd, f.agentDir), /Not a regular/);
    assert.deepEqual(JSON.parse(await readFile(f.globalPath, "utf8")), { theme: "dark" });
  });
});

test("project settings cannot alias the user settings directory", async () => {
  await fixture(async (f) => {
    await f.global({ theme: "dark" });
    await assert.rejects(readSetupSettings(f.cwd, join(f.cwd, ".pi")), /share a path/);
    await symlink(f.agentDir, join(f.cwd, ".pi"), "dir");
    await assert.rejects(readSetupSettings(f.cwd, f.agentDir), /share a path/);
    assert.deepEqual(JSON.parse(await readFile(f.globalPath, "utf8")), { theme: "dark" });
  });
});

test("settings changes during the prompt and another writer's lock prevent overwrites", async () => {
  for (const scope of ["project", "global"]) {
    await fixture(async (f) => {
      await f.project({ theme: "dark" });
      const settings = await readSetupSettings(f.cwd, f.agentDir);
      await f[scope]({ theme: "orange" });
      const latest = await readFile(f.projectPath, "utf8");
      await assert.rejects(saveSetupChoice(settings, "enabled", recommended, true), /Settings changed/);
      assert.equal(await readFile(f.projectPath, "utf8"), latest);
      assert.deepEqual(await readdir(join(f.cwd, ".pi")), ["settings.json"]);
    });
  }
  await fixture(async (f) => {
    await f.project({ theme: "dark" });
    const settings = await readSetupSettings(f.cwd, f.agentDir);
    await mkdir(`${f.projectPath}.lock`);
    await assert.rejects(saveSetupChoice(settings, "enabled", recommended, true), { code: "EEXIST" });
    assert.equal((await stat(`${f.projectPath}.lock`)).isDirectory(), true);
    assert.deepEqual(JSON.parse(await readFile(f.projectPath, "utf8")), { theme: "dark" });
  });
});

test("an aborted save does not create project settings", async () => {
  await fixture(async (f) => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(saveSetupChoice(await readSetupSettings(f.cwd, f.agentDir), "enabled", recommended, true, controller.signal), { name: "AbortError" });
    await assert.rejects(stat(join(f.cwd, ".pi")), { code: "ENOENT" });
  });
});

async function environment(f, work) {
  const oldDir = process.env.PI_CODING_AGENT_DIR;
  const oldArgv = process.argv;
  const streams = [process.stdin, process.stdout];
  const saved = streams.map((stream) => Object.getOwnPropertyDescriptor(stream, "isTTY"));
  process.env.PI_CODING_AGENT_DIR = f.agentDir;
  process.argv = [process.execPath, "pi"];
  streams.forEach((stream) => Object.defineProperty(stream, "isTTY", { configurable: true, value: true }));
  try { await work(); } finally {
    process.argv = oldArgv;
    if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldDir;
    streams.forEach((stream, i) => saved[i] ? Object.defineProperty(stream, "isTTY", saved[i]) : delete stream.isTTY);
  }
}

function harness(f, select = async () => "Enable") {
  const handlers = new Map();
  const notifications = [];
  let active = [...base], prompts = 0, activations = 0;
  let available = [...base.slice(0, 4), ...recommended].map((name) => ({ name, sourceInfo: { source: "builtin" } }));
  available.push({ name: "subagent", sourceInfo: { source: "extension" } });
  const pi = { on(name, handler) { handlers.set(name, handler); }, getActiveTools() { return active; }, getAllTools() { return available; }, setActiveTools(next) { active = next; activations++; } };
  recommendedToolsExtension(pi);
  const ctx = { cwd: f.cwd, mode: "tui", hasUI: true, model: { provider: "test", id: "default" }, isProjectTrusted: () => true, ui: {
    async select(...args) { prompts++; return select(...args); },
    notify(...args) { notifications.push(args); }
  } };
  return { ctx, notifications, start: () => handlers.get("session_start")({}, ctx), shutdown: () => handlers.get("session_shutdown")(),
    set available(value) { available = value; }, get active() { return active; }, get prompts() { return prompts; }, get activations() { return activations; } };
}

test("automatic startup approval enables immediately, preserves active extensions and remembers choice", async () => {
  await fixture(async (f) => environment(f, async () => {
    const h = harness(f, async (title, options) => {
      assert.match(title, /grep · find · ls/);
      assert.deepEqual(options, ["Not now", "Enable", "Don't ask again"]);
      return "Enable";
    });
    await h.start();
    assert.deepEqual(h.active, [...base, ...recommended]);
    assert.equal(h.activations, 1);
    assert.equal(h.notifications[0][1], "info");
    const saved = JSON.parse(await readFile(f.projectPath, "utf8"));
    assert.equal(saved.piexis.recommendedTools, "enabled");
    assert.deepEqual(JSON.parse(await readFile(join(f.cwd, ".pi", "agent.json"), "utf8")), {
      $schema: agentConfigSchemaUrl, model: "test/default", small_model: "test/default", subagent_model: "test/default", delegate_exploration: false,
      subagent_variant_overrides: {
        plan: { model: "test/default", effort: "high" },
        orchestrator: { model: "test/default", effort: "high" },
        debug: { model: "test/default", effort: "high" },
        ask: { model: "test/default", effort: "low" },
        code: { model: "test/default", effort: "medium" },
      }
    });
    assert.deepEqual(saved.defaultTools, supportsAdditiveTools ? recommended.map((name) => `+${name}`) : [...base.slice(0, 4), ...recommended]);
    await h.start();
    assert.equal(h.prompts, 1);
    const restarted = harness(f);
    await restarted.start();
    assert.equal(restarted.prompts, 0);
  }));
});

test("previously enabled projects are offered missing agent setup without changing tool policy", async () => {
  await fixture(async (f) => environment(f, async () => {
    const existing = { defaultTools: [...base.slice(0, 4), ...recommended], piexis: { recommendedTools: "enabled", custom: 42 }, theme: "orange" };
    await f.project(existing);
    const h = harness(f, async (title, options) => {
      assert.match(title, /agent/i);
      assert.deepEqual(options, ["Not now", "Enable", "Don't ask again"]);
      return "Enable";
    });
    await h.start();
    assert.equal(h.prompts, 1);
    assert.equal(h.activations, 0);
    const saved = JSON.parse(await readFile(f.projectPath, "utf8"));
    assert.deepEqual(saved.defaultTools, existing.defaultTools);
    assert.equal(saved.piexis.recommendedTools, "enabled");
    assert.equal(saved.piexis.custom, 42);
    assert.equal(saved.theme, "orange");
    assert.equal(JSON.parse(await readFile(join(f.cwd, ".pi", "agent.json"), "utf8")).model, "test/default");
    const restarted = harness(f);
    await restarted.start();
    assert.equal(restarted.prompts, 0);
  }));
});

test("agent-only setup cancellation and dismissal preserve the earlier tool choice", async () => {
  for (const choice of ["Not now", undefined, "Don't ask again"]) {
    await fixture(async (f) => environment(f, async () => {
      await f.project({ defaultTools: [], piexis: { recommendedTools: "enabled" }, custom: 42 });
      const before = await readFile(f.projectPath, "utf8");
      const h = harness(f, async () => choice);
      await h.start();
      assert.equal(h.prompts, 1);
      assert.equal(h.activations, 0);
      await assert.rejects(stat(join(f.cwd, ".pi", "agent.json")), { code: "ENOENT" });
      if (choice === "Don't ask again") {
        assert.deepEqual(JSON.parse(await readFile(f.projectPath, "utf8")), {
          defaultTools: [], piexis: { recommendedTools: "enabled", agentSetup: "disabled" }, custom: 42
        });
        const restarted = harness(f);
        await restarted.start();
        assert.equal(restarted.prompts, 0);
      } else assert.equal(await readFile(f.projectPath, "utf8"), before);
    }));
  }
});

test("agent-only approval preserves restrictive and older tool policies, including a prior tool decline", async () => {
  for (const additive of [true, false]) {
    await fixture(async (f) => {
      const original = { defaultTools: [], piexis: { recommendedTools: "disabled" }, other: 42 };
      await f.project(original);
      await saveSetupChoice(await readSetupSettings(f.cwd, f.agentDir), "enabled", [], additive, undefined, "enabled");
      assert.deepEqual(JSON.parse(await readFile(f.projectPath, "utf8")), { ...original, piexis: { ...original.piexis, agentSetup: "enabled" } });
    });
  }
  await fixture(async (f) => environment(f, async () => {
    await f.project({ defaultTools: [], piexis: { recommendedTools: "disabled" } });
    const h = harness(f);
    await h.start();
    assert.equal(h.prompts, 1);
    assert.equal(h.activations, 0);
    assert.deepEqual(JSON.parse(await readFile(f.projectPath, "utf8")), {
      defaultTools: [], piexis: { recommendedTools: "disabled", agentSetup: "enabled" }
    });
    assert.equal(JSON.parse(await readFile(join(f.cwd, ".pi", "agent.json"), "utf8")).model, "test/default");
  }));
});

test("completed, unavailable or explicitly declined agent setup does not offer another prompt", async () => {
  for (const name of ["agent.json", "agents.json", "unavailable", "declined"]) {
    await fixture(async (f) => environment(f, async () => {
      await f.project({ piexis: { recommendedTools: "enabled", ...(name === "declined" ? { agentSetup: "disabled" } : {}) } });
      if (name.endsWith(".json")) await writeFile(join(f.cwd, ".pi", name), '{"model":"test/default"}');
      const h = harness(f);
      if (name === "unavailable") h.available = [...recommended].map((name) => ({ name, sourceInfo: { source: "builtin" } }));
      await h.start();
      assert.equal(h.prompts, 0);
    }));
  }
});

test("Enable preserves existing agent configuration and warns on initialization failures without undoing tools", async () => {
  for (const name of ["agent.json", "agents.json"]) {
    await fixture(async (f) => environment(f, async () => {
      await mkdir(join(f.cwd, ".pi"));
      const path = join(f.cwd, ".pi", name);
      await writeFile(path, "{existing malformed configuration}");
      const h = harness(f);
      await h.start();
      assert.equal(await readFile(path, "utf8"), "{existing malformed configuration}");
      assert.deepEqual(h.active, [...base, ...recommended]);
      assert.equal(h.notifications.some((notice) => notice[1] === "warning"), false);
      if (name === "agents.json") await assert.rejects(stat(join(f.cwd, ".pi", "agent.json")), { code: "ENOENT" });
    }));
  }
  for (const missingModel of [true, false]) {
    await fixture(async (f) => environment(f, async () => {
      const h = harness(f);
      if (missingModel) h.ctx.model = undefined;
      else await writeFile(join(f.agentDir, "agent.json"), "{bad");
      await h.start();
      assert.deepEqual(h.active, [...base, ...recommended]);
      assert.equal(JSON.parse(await readFile(f.projectPath, "utf8")).piexis.recommendedTools, "enabled");
      await assert.rejects(stat(join(f.cwd, ".pi", "agent.json")), { code: "ENOENT" });
      assert.match(h.notifications.find((notice) => notice[1] === "warning")[0], /Agent configuration was not created/);
    }));
  }
});

test("Not now/Esc makes no writes; Don't ask again persists without activating tools", async () => {
  for (const choice of ["Not now", undefined, "Don't ask again"]) {
    await fixture(async (f) => environment(f, async () => {
      const h = harness(f, async () => choice);
      await h.start();
      assert.equal(h.activations, 0);
      await h.start();
      assert.equal(h.prompts, 1);
      await assert.rejects(stat(join(f.cwd, ".pi", "agent.json")), { code: "ENOENT" });
      if (choice === "Don't ask again") {
        const saved = JSON.parse(await readFile(f.projectPath, "utf8"));
        assert.deepEqual(saved, { piexis: { recommendedTools: "disabled", agentSetup: "disabled" } });
        const restarted = harness(f);
        await restarted.start();
        assert.equal(restarted.prompts, 0);
      } else await assert.rejects(stat(join(f.cwd, ".pi")), { code: "ENOENT" });
    }));
  }
});

test("headless, non-TTY, untrusted, CLI-restricted and unavailable tools skip startup setup", async () => {
  await fixture(async (f) => environment(f, async () => {
    for (const patch of [{ mode: "print" }, { mode: "json" }, { mode: "rpc" }, { hasUI: false }, { isProjectTrusted: () => false }]) {
      const h = harness(f);
      Object.assign(h.ctx, patch);
      await h.start();
      assert.equal(h.prompts, 0);
    }
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: false });
    const noTTY = harness(f);
    await noTTY.start();
    assert.equal(noTTY.prompts, 0);
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
    process.argv.push("--no-builtin-tools");
    const cli = harness(f);
    await cli.start();
    assert.equal(cli.prompts, 0);
    process.argv.pop();
    const unavailable = harness(f);
    unavailable.available = [];
    await unavailable.start();
    assert.equal(unavailable.prompts, 0);
    await assert.rejects(stat(join(f.cwd, ".pi")), { code: "ENOENT" });
  }));
});

test("startup shutdown cancels pending dialog without activation or writes", async () => {
  await fixture(async (f) => environment(f, async () => {
    let shown;
    const ready = new Promise((resolve) => { shown = resolve; });
    const h = harness(f, (_title, _options, { signal }) => new Promise((resolve) => {
      signal.addEventListener("abort", () => resolve(undefined), { once: true });
      shown();
    }));
    const waiting = h.start();
    await ready;
    await h.start();
    assert.equal(h.prompts, 1);
    await h.shutdown();
    await waiting;
    assert.equal(h.activations, 0);
    await assert.rejects(stat(join(f.cwd, ".pi")), { code: "ENOENT" });
  }));
});

test("startup errors or changed tool availability warn without changing runtime tools", async () => {
  await fixture(async (f) => environment(f, async () => {
    await f.project("{ broken");
    const invalid = harness(f);
    await invalid.start();
    assert.equal(invalid.prompts, 0);
    assert.equal(invalid.notifications[0][1], "warning");
    assert.equal(await readFile(f.projectPath, "utf8"), "{ broken");
    await f.project({});
    const changed = harness(f, async () => { changed.available = []; return "Enable"; });
    await changed.start();
    assert.equal(changed.activations, 0);
    assert.deepEqual(JSON.parse(await readFile(f.projectPath, "utf8")), {});
    assert.equal(changed.notifications[0][1], "warning");
    await mkdir(`${f.projectPath}.lock`);
    const locked = harness(f);
    await locked.start();
    assert.equal(locked.activations, 0);
    assert.equal(locked.notifications[0][1], "warning");
    assert.deepEqual(JSON.parse(await readFile(f.projectPath, "utf8")), {});
    assert.equal((await stat(`${f.projectPath}.lock`)).isDirectory(), true);
  }));
});
