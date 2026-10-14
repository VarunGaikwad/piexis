import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import test from "node:test";
import askQuestion from "../extensions/ask-question.ts";
import ui from "../extensions/ui.ts";

const root = new URL("../", import.meta.url);

test("manifest loads only retained extensions and resources", async () => {
  const manifest = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
  assert.deepEqual(manifest.pi.extensions, ["./extensions/ask-question.ts", "./extensions/ui.ts", "./extensions/recommended-tools.ts", "./extensions/access-guard.ts", "./extensions/agents.ts", "./extensions/webui.ts"]);
  for (const paths of Object.values(manifest.pi)) {
    for (const path of paths) await access(new URL(path, root));
  }
  assert.deepEqual((await readdir(new URL("extensions/", root))).sort(), ["access-guard.ts", "agents.ts", "ask-question.ts", "recommended-tools.ts", "ui.ts", "webui.ts"]);
  assert.equal(manifest.dependencies?.["@anthropic-ai/sandbox-runtime"], undefined);
  for (const removed of ["test:runtime", "test:sandbox", "eval:permissions"]) {
    assert.equal(manifest.scripts[removed], undefined);
  }
});

test("AskQuestion works independently and retains non-TUI handling", async () => {
  let tool;
  askQuestion({ on() {}, registerTool(value) { tool = value; } });
  assert.equal(tool.name, "AskQuestion");
  assert.doesNotMatch(tool.description, /permission|mode commands/i);
  const params = { questions: [{ question: "Which?", options: [{ label: "A" }] }] };
  const headless = await tool.execute("id", params, undefined, undefined, { mode: "json" });
  assert.equal(headless.details.status, "requires_interaction");
  assert.deepEqual(headless.details.answers, []);
  assert.equal(headless.details.cancelled, true);
});

test("UI renders without mode controls or permission status dependencies", async () => {
  const handlers = new Map();
  ui({ on(name, handler) { handlers.set(name, handler); }, getThinkingLevel: () => "off" });
  let header, footer;
  const theme = { fg: (_color, text) => text, bold: (text) => text };
  const ctx = {
    mode: "tui", cwd: "/tmp/project", model: { id: "test-model" },
    sessionManager: { getBranch: () => [], getEntries: () => [] },
    getContextUsage: () => ({ percent: 12, tokens: 24_000, contextWindow: 200_000 }),
    ui: {
      setTitle() {},
      setHeader(factory) { header = factory({}, theme); },
      setFooter(factory) {
        footer = factory({ requestRender() {} }, theme, {
          onBranchChange: () => () => {}, getGitBranch: () => "main"
        });
      }
    }
  };
  await handlers.get("session_start")({}, ctx);
  for (const width of [60, 120]) {
    assert.doesNotMatch(header.render(width).join("\n"), /Alt\+M|\/plan|permission/i);
    const rows = footer.render(width);
    assert.equal(rows.length, 2);
    const dashboard = rows.join("\n");
    for (const value of [/ready/, /main/, /test-model/, /ctx .*12%/]) {
      assert.match(dashboard, value);
    }
  }
  assert.match(footer.render(120).join("\n"), /think off/);
  await handlers.get("tool_call")({ toolName: "read" });
  assert.match(footer.render(120)[1], /read/);
  await handlers.get("agent_end")();
  assert.match(footer.render(120)[1], /ready/);
  footer.dispose();
});
