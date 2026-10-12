import assert from "node:assert/strict";
import test from "node:test";
import { access, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import uiExtension from "../extensions/ui.ts";
import tipList from "../lib/ui-tips.json" with { type: "json" };

const displayTip = (tip) => `[${tip.category}] ${tip.text}`;

function fixture(mode = "tui", theme = { fg: (_color, text) => text, bold: (text) => text }) {
  const handlers = new Map();
  let thinking = "high";
  let renders = 0;
  let unsubscribed = false;
  let branchChanged;
  let footer;
  let header;
  let title;
  let entries = [];
  let sessionEntries;
  let branch = "main";
  const statuses = new Map();
  let context = { percent: 25, tokens: 50_000, contextWindow: 200_000 };
  const ctx = {
    mode,
    cwd: "/projects/demo",
    isProjectTrusted: () => true,
    model: { id: "gpt-5.4" },
    sessionManager: { getBranch: () => entries, getEntries: () => sessionEntries ?? entries },
    getContextUsage: () => context,
    ui: {
      setTitle: (value) => { title = value; },
      setHeader: (factory) => { header = factory({}, theme); },
      setFooter: (factory) => {
        footer = factory({ requestRender: () => { renders++; } }, theme, {
          getGitBranch: () => branch,
          getExtensionStatuses: () => statuses,
          onBranchChange: (callback) => {
            branchChanged = callback;
            return () => { unsubscribed = true; };
          }
        });
      }
    }
  };
  uiExtension({
    on: (name, handler) => { handlers.set(name, handler); },
    getThinkingLevel: () => thinking
  });
  return {
    ctx,
    emit: (name, event = {}) => handlers.get(name)(event, ctx),
    render: (width = 160) => footer.render(width),
    header: (width) => header.render(width),
    title: () => title,
    setEntries: (value) => { entries = value; },
    setSessionEntries: (value) => { sessionEntries = value; },
    setContext: (value) => { context = value; },
    setBranch: (value) => { branch = value; },
    setAgent: (value) => { statuses.set("piexis-agent", value); },
    setAgentMode: (value) => {
      if (value) statuses.set("piexis-agent-mode", value);
      else statuses.delete("piexis-agent-mode");
    },
    setChildren: (value) => {
      if (value) statuses.set("piexis-subagents", value);
      else statuses.delete("piexis-subagents");
    },
    setThinking: (value) => { thinking = value; },
    renders: () => renders,
    branchChanged: () => branchChanged(),
    dispose: () => footer.dispose(),
    unsubscribed: () => unsubscribed,
    hasFooter: () => Boolean(footer)
  };
}

function assistant(input, output, cacheRead, cacheWrite, cost) {
  return { type: "message", message: { role: "assistant", usage: { input, output, cacheRead, cacheWrite, cost: { total: cost } } } };
}

test("startup header keeps the wordmark left and full usage tips right", async (t) => {
  t.mock.method(Math, "random", () => 0);
  const wordmark = [
    "██████╗ ██╗███████╗██╗  ██╗██╗███████╗",
    "██╔══██╗██║██╔════╝╚██╗██╔╝██║██╔════╝",
    "██████╔╝██║█████╗   ╚███╔╝ ██║███████╗",
    "██╔═══╝ ██║██╔══╝   ██╔██╗ ██║╚════██║",
    "██║     ██║███████╗██╔╝ ██╗██║███████║",
    "╚═╝     ╚═╝╚══════╝╚═╝  ╚═╝╚═╝╚══════╝"
  ];
  const tips = [
    "Get started with PieXis",
    "Questions, skills, prompts & stats.",
    ...tipList.slice(0, 3).map(displayTip),
    "/help · /summary · /commit"
  ];
  const f = fixture();
  await f.emit("session_start");
  try {
    const artWidth = Math.max(...wordmark.map((line) => visibleWidth(line)));
    const column = artWidth + 3;
    for (const width of [80, 120]) {
      const header = f.header(width);
      for (const [index, line] of wordmark.entries()) {
        assert.equal(header[index].slice(0, column), line.padEnd(column));
      }
      assert.doesNotMatch(header.join("\n"), /demo/);
      assert.equal(f.title(), "π demo");
      for (const line of header.slice(wordmark.length)) {
        assert.equal(line.slice(0, artWidth).trim(), "");
      }
      const right = tips.flatMap((line) => wrapTextWithAnsi(line, width - column));
      assert.deepEqual(header.map((line) => line.slice(column)),
        Array.from({ length: Math.max(wordmark.length, right.length) }, (_, index) => right[index] ?? ""));
      assert.doesNotMatch(header.join("\n"), /[\u2800-\u28ff]/);
    }
    const wrapped = f.header(column + 32).map((line) => line.slice(column)).join(" ").replace(/\s+/g, " ");
    for (const tip of tips) assert.ok(wrapped.includes(tip), tip);
    assert.deepEqual(f.header(artWidth), [...wordmark, "", ...tips.flatMap((line) => wrapTextWithAnsi(line, artWidth))]);
    const fallback = f.header(artWidth - 1).join("\n");
    assert.match(fallback, /PieXis/);
    assert.ok(!fallback.includes(wordmark[0]));
  } finally {
    f.dispose();
  }
});

test("startup header stacks tips on narrow terminals and fits all resize widths", async (t) => {
  t.mock.method(Math, "random", () => 0);
  const f = fixture();
  f.ctx.cwd = `/projects/${"長いproject".repeat(30)}`;
  await f.emit("session_start");
  try {
    const compact = f.header(20);
    assert.match(compact[0], /PieXis/);
    assert.equal(compact[1], "");
    assert.match(compact.join("\n"), /\/help/);
    assert.match(f.header(60).join("\n"), /For ponytail/);
    for (let width = 0; width <= 160; width++) {
      for (const line of f.header(width)) {
        assert.ok(visibleWidth(line) <= width, `${width}: ${line}`);
        assert.doesNotMatch(line, /[\u2800-\u28ff]/);
      }
    }
    assert.ok(f.header(80).length >= 7);
    assert.ok(f.header(20).length > 7);
  } finally {
    f.dispose();
  }
});

test("startup header measures styled text without displaying the project name", async () => {
  const f = fixture("tui", {
    fg: (_color, text) => `\x1b[36m${text}\x1b[39m`,
    bold: (text) => `\x1b[1m${text}\x1b[22m`
  });
  f.ctx.cwd = `/projects/${"研究🚀".repeat(20)}`;
  await f.emit("session_start");
  try {
    for (const width of [1, 20, 38, 60, 73, 80, 120]) {
      for (const line of f.header(width)) assert.ok(visibleWidth(line) <= width);
    }
    assert.match(f.header(80)[0], /\x1b\[36m/);
    assert.doesNotMatch(f.header(80).join("\n"), /研究/);
  } finally {
    f.dispose();
  }
});

test("startup header explains missing project agent configuration", async () => {
  const root = await mkdtemp(join(tmpdir(), "piexis-ui-agent-config-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  try {
    const agentDir = join(root, "agent");
    await mkdir(agentDir);
    await mkdir(join(root, ".pi"));
    await writeFile(join(root, ".pi", "agent.json"), JSON.stringify({ model: "test/main" }));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const f = fixture();
    f.ctx.cwd = root;
    await f.emit("session_start");
    try {
      const text = f.header(200).join("\n");
      assert.match(text, /Agent config: add small_model to use a cheaper model for eligible small tasks\./);
      assert.match(text, /Agent config: add delegate_exploration to opt in to cheap, read-only codebase exploration\./);
      assert.match(text, /Agent config: add auto_profile to automatically select a profile for clear requests\./);
      assert.doesNotMatch(text, /Agent config: add model/);
      for (let width = 1; width <= 200; width++) {
        for (const line of f.header(width)) assert.ok(visibleWidth(line) <= width);
      }
    } finally { f.dispose(); }
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("startup tips stay stable across redraws and cycle without repeats", async (t) => {
  const random = t.mock.method(Math, "random", () => 0);
  const f = fixture();
  const seen = new Set();
  const shown = () => {
    const lines = f.header(200).map((line) => line.slice(41));
    return tipList.filter((tip) => lines.includes(displayTip(tip)));
  };
  try {
    for (let i = 0; i < tipList.length; i += 3) {
      await f.emit("session_start");
      const selected = shown();
      assert.equal(selected.length, 3);
      for (const tip of selected) {
        assert.ok(!seen.has(tip), `repeated before exhaustion: ${tip}`);
        seen.add(tip);
      }
      const stable = f.header(80);
      const calls = random.mock.callCount();
      f.header(20);
      await f.emit("model_select");
      assert.deepEqual(f.header(80), stable);
      assert.equal(random.mock.callCount(), calls);
      f.dispose();
    }
    assert.equal(seen.size, tipList.length);
    await f.emit("session_start");
    assert.deepEqual(shown(), tipList.slice(0, 3));
  } finally {
    f.dispose();
  }
});

test("startup tips use random choices and mix three different categories", async (t) => {
  t.mock.method(Math, "random", () => 0.999);
  const f = fixture();
  await f.emit("session_start");
  try {
    const text = f.header(200).join("\n");
    const selected = tipList.filter((tip) => text.includes(displayTip(tip)));
    assert.equal(selected.length, 3);
    assert.equal(new Set(selected.map((tip) => tip.category)).size, 3);
    assert.ok(selected.includes(tipList.at(-1)));
    assert.ok(!text.includes(displayTip(tipList[0])));
  } finally {
    f.dispose();
  }
});

test("tip JSON contains unique text and references bundled skills and prompts", async () => {
  assert.ok(tipList.length > 3);
  assert.equal(new Set(tipList.map((tip) => tip.text)).size, tipList.length);
  assert.ok(new Set(tipList.map((tip) => tip.category)).size >= 3);
  for (const tip of tipList) {
    assert.deepEqual(Object.keys(tip).sort(), ["category", "text"]);
    for (const value of [tip.category, tip.text]) {
      assert.equal(typeof value, "string");
      assert.ok(value.trim().length > 0);
      assert.doesNotMatch(value, /\x1b/);
    }
    assert.doesNotMatch(tip.text, /\/skill:/);
    for (const match of tip.text.matchAll(/^For ([a-z-]+),/g)) {
      await access(new URL(`../skills/${match[1]}/SKILL.md`, import.meta.url));
    }
    for (const match of tip.text.matchAll(/\/(init|commit|summary)\b/g)) {
      await access(new URL(`../prompts/${match[1]}.md`, import.meta.url));
    }
  }
});

test("natural-language skill tips cover bundled skills without explicit-only flags", async () => {
  const examples = new Set(tipList.flatMap((tip) =>
    [...tip.text.matchAll(/^For ([a-z-]+),/g)].map((match) => match[1])
  ));
  const entries = await readdir(new URL("../skills/", import.meta.url), { withFileTypes: true });
  const names = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  assert.deepEqual([...examples].sort(), names.sort());
  for (const name of names) {
    const source = await readFile(new URL(`../skills/${name}/SKILL.md`, import.meta.url), "utf8");
    const frontmatter = source.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1];
    assert.ok(frontmatter, name);
    assert.doesNotMatch(frontmatter, /^disable-model-invocation:\s*true\b/m, name);
  }
  const instructions = tipList.map((tip) => tip.text).join("\n");
  assert.match(instructions, /selection is not guaranteed/);
  assert.match(instructions, /disable-model-invocation: true/);
});

test("dashboard shows branch totals, full model, thinking, context and cost", async (t) => {
  const f = fixture();
  f.setEntries([
    { type: "message", message: { role: "user" } },
    assistant(1000, 200, 3000, 400, 0.01),
    assistant(500, 100, 1000, 100, 0.02)
  ]);
  await f.emit("session_start");
  t.after(() => f.dispose());
  assert.equal(f.title(), "π demo");
  const text = f.render().join("\n");
  for (const expected of ["● ready", "gpt-5.4", "think high", "⎇ main", "25%", "50.0k/200.0k", "↑1.5k ↓300", "cache 67%", "$0.03"]) {
    assert.ok(text.includes(expected), expected);
  }
  assert.match(text, /ctx ━{3}─{9}/);
  assert.match(f.render()[1], /\$0\.03$/);
  f.setEntries([assistant(20, 10, 0, 0, 0)]);
  assert.match(f.render().join("\n"), /↑20 ↓10/);
  assert.doesNotMatch(f.render().join("\n"), /↑1.5k|cache 67%/);
});

test("footer includes tool-result usage once and follows the active branch", async (t) => {
  const f = fixture();
  const main = assistant(100, 20, 0, 0, 0.01);
  const child = assistant(50, 10, 0, 0, 0.02);
  child.message.role = "toolResult";
  child.message.toolName = "subagent";
  child.message.details = { usage: child.message.usage };
  f.setEntries([main, child, { type: "message", message: { role: "toolResult" } }]);
  await f.emit("session_start");
  t.after(() => f.dispose());
  assert.match(f.render()[1], /↑150 ↓30.*\$0\.03$/);
  assert.deepEqual(f.render(), f.render());
  f.setEntries([main]);
  assert.match(f.render()[1], /↑100 ↓20.*\$0\.01$/);
});

test("footer shows live running and queued subagents without exceeding terminal width", async (t) => {
  const f = fixture();
  await f.emit("session_start");
  t.after(() => f.dispose());
  f.setChildren("subagents · 2 running: code, ask · 1 queued: debug");
  assert.equal(f.render().length, 3);
  assert.equal(f.render()[2], "subagents · 2 running: code, ask · 1 queued: debug");
  for (let width = 0; width <= 160; width++) {
    for (const row of f.render(width)) assert.ok(visibleWidth(row) <= width);
  }
  f.setChildren("subagents · 1 running: ask");
  assert.match(f.render()[2], /1 running: ask/);
  f.setChildren(undefined);
  assert.equal(f.render().length, 2);
});

test("two-row layouts fit every width and preserve core fields at 40 columns", async (t) => {
  const f = fixture();
  f.setAgent("agent:orchestrator");
  await f.emit("session_start");
  t.after(() => f.dispose());
  assert.deepEqual(f.render(0), []);
  for (let width = 1; width <= 160; width++) {
    assert.equal(f.render(width).length, 2);
    for (const line of [...f.render(width), ...f.header(width)]) {
      assert.ok(visibleWidth(line) <= width, `${width}: ${line}`);
    }
  }
  const narrow = f.render(40).join("\n");
  for (const label of ["agent:orchestrator", "● ready", "gpt-5.4", "ctx", "25%", "$0.0000"]) {
    assert.ok(narrow.includes(label), label);
  }
  assert.doesNotMatch(narrow, /Alt\+A|prompts|cache|think high|main/);
  assert.match(f.render(160)[0], /gpt-5\.4.*think high.*main.*0 prompts.*Alt\+A/);
});

test("agent routing mode is live on wide layouts and yields to the profile when narrow", async (t) => {
  const f = fixture();
  f.setAgent("agent:orchestrator");
  f.setAgentMode("auto");
  await f.emit("session_start");
  t.after(() => f.dispose());
  assert.match(f.render(160)[0], /agent:orchestrator \(auto\)/);
  assert.match(f.render(40)[0], /agent:orchestrator/);
  assert.doesNotMatch(f.render(40)[0], /\(auto\)/);
  f.setAgentMode("manual");
  assert.match(f.render(160)[0], /agent:orchestrator \(manual\)/);
  f.setAgentMode(undefined);
  assert.doesNotMatch(f.render(160)[0], /agent:orchestrator \(/);
  for (let width = 0; width <= 160; width++) {
    for (const line of f.render(width)) assert.ok(visibleWidth(line) <= width, `${width}: ${line}`);
  }
});

test("long styled Unicode fields shrink independently without hiding core status", async (t) => {
  const f = fixture("tui", {
    fg: (_color, text) => `\x1b[36m${text}\x1b[39m`,
    bold: (text) => `\x1b[1m${text}\x1b[22m`
  });
  f.setAgent("agent:orchestrator");
  f.setAgentMode("manual");
  f.setBranch("研究🚀".repeat(80));
  f.ctx.model = { id: "研究🚀".repeat(80) };
  await f.emit("session_start");
  t.after(() => f.dispose());
  await f.emit("tool_call", { toolName: "道具🚀".repeat(80) });
  for (let width = 0; width <= 160; width++) {
    for (const line of f.render(width)) assert.ok(visibleWidth(line) <= width, `${width}: ${line}`);
  }
  const narrow = f.render(40).join("\n");
  assert.match(narrow, /agent:orchestrator/);
  assert.match(narrow, /道具/);
  assert.match(narrow, /研究/);
  assert.match(narrow, /…/);
  assert.match(narrow, /25%.*\$0\.0000/);
  f.ctx.model = { id: "gpt-5.4" };
  await f.emit("agent_end");
  assert.match(f.render(160)[0], /gpt-5\.4.*⎇ 研究.*…/);
  f.ctx.model = undefined;
  f.setBranch(undefined);
  assert.match(f.render(160)[0], /ready.*—/);
  assert.doesNotMatch(f.render(160)[0], /⎇/);
});

test("unknown and oversized context values produce a bounded bar and warning tones", async (t) => {
  const colors = [];
  const f = fixture("tui", {
    fg: (color, text) => { colors.push([color, text]); return text; }, bold: (text) => text
  });
  await f.emit("session_start");
  t.after(() => f.dispose());
  f.setContext({ percent: null, tokens: null, contextWindow: 200_000 });
  assert.match(f.render().join("\n"), /ctx ─{12} —.*—\/200.0k/);
  assert.ok(colors.some(([color, value]) => color === "dim" && value === "—"));
  f.setContext(undefined);
  assert.match(f.render().join("\n"), /—\/—/);
  for (const [percent, tone] of [[25, "success"], [70, "warning"], [90, "error"], [120, "error"], [-5, "success"]]) {
    f.setContext({ percent, tokens: 240_000, contextWindow: 200_000 });
    colors.length = 0;
    const text = f.render().join("\n");
    assert.ok(colors.some(([color, value]) => color === tone && value === `${percent}%`));
    if (percent === 120) assert.match(text, /━{12} 120%/);
    if (percent === -5) assert.match(text, /─{12} -5%/);
  }
});

test("events refresh activity, model, thinking and usage; disposal releases branch listener", async () => {
  const f = fixture();
  await f.emit("session_start");
  await f.emit("agent_start");
  assert.match(f.render().join("\n"), /[\u2800-\u28ff] thinking/);
  await f.emit("tool_call", { toolName: "read" });
  assert.match(f.render().join("\n"), /[\u2800-\u28ff] read/);
  await f.emit("turn_start");
  assert.match(f.render().join("\n"), /[\u2800-\u28ff] thinking/);
  await f.emit("agent_end");
  assert.match(f.render().join("\n"), /● ready/);
  f.ctx.model = { id: "claude-sonnet-4-6" };
  f.setThinking("off");
  const before = f.renders();
  for (const event of ["model_select", "thinking_level_select", "message_end", "session_compact"]) await f.emit(event);
  f.branchChanged();
  assert.equal(f.renders(), before + 5);
  assert.match(f.render().join("\n"), /claude-sonnet-4-6.*think off/);
  f.dispose();
  assert.equal(f.unsubscribed(), true);
  const disposed = f.renders();
  await f.emit("agent_start");
  assert.equal(f.renders(), disposed);
});

test("prompt count includes restored session history, not tools or assistant turns", async () => {
  const f = fixture();
  const user = { type: "message", message: { role: "user", content: "Hello" } };
  f.setEntries([user]);
  f.setSessionEntries([
    user, user,
    assistant(10, 20, 0, 0, 0),
    { type: "message", message: { role: "toolResult" } },
    { type: "custom", data: {} }
  ]);
  await f.emit("session_start");
  try {
    assert.match(f.render().join("\n"), /2 prompts/);
    assert.doesNotMatch(f.render(40).join("\n"), /prompts/);
    f.setSessionEntries([user, user, user]);
    await f.emit("message_end");
    assert.match(f.render().join("\n"), /3 prompts/);
    f.setSessionEntries([]);
    assert.match(f.render().join("\n"), /0 prompts/);
  } finally {
    f.dispose();
  }
});

test("spinner redraws only while busy and disposal clears its timer", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 0 });
  const f = fixture();
  await f.emit("session_start");
  t.after(() => f.dispose());
  const ready = f.renders();
  t.mock.timers.tick(300);
  assert.equal(f.renders(), ready);
  await f.emit("agent_start");
  const first = f.render()[0];
  const busy = f.renders();
  t.mock.timers.tick(100);
  assert.equal(f.renders(), busy + 1);
  assert.notEqual(f.render()[0], first);
  f.dispose();
  const disposed = f.renders();
  t.mock.timers.tick(300);
  assert.equal(f.renders(), disposed);
});

test("non-TUI modes do not install terminal components", async () => {
  for (const mode of ["rpc", "print", "json"]) {
    const f = fixture(mode);
    await f.emit("session_start");
    await f.emit("agent_start");
    assert.equal(f.hasFooter(), false);
    assert.equal(f.title(), undefined);
  }
});
