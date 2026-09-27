import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const cases = [
  ["This API sometimes returns 500 errors.", "diagnosing-bugs", /unknown bugs|server errors/i],
  ["The cause is already known. Patch this null check and add a regression test.", "diagnosing-bugs", /known-cause small fix|narrow patch/i],
  ["Implement the feature described in SPEC.md.", "lean-build", /new feature|ticket or spec/i],
  ["Review this PR for correctness.", "code-review", /correctness/i],
  ["Review this PR for unnecessary complexity.", "code-review", /simplicity/i],
  ["Audit this repository for architecture problems.", "codebase-design", /architecture audit/i],
  ["Help me design the architecture for this service.", "codebase-design", /module and service architecture/i],
  ["Turn these requirements into a spec.", "grilling", /turn requirements.*spec/i],
  ["I have an idea but the requirements are unclear.", "grilling", /clarify/i],
  ["Refactor this module without changing behavior.", "safe-refactor", /preserving behavior/i],
  ["Migrate this database schema with zero downtime.", "migration", /compatibility-safe transitions/i],
  ["Implement this test-first.", "tdd", /test-first/i],
  ["Verify whether this implementation meets the acceptance criteria. Do not modify it.", "verify-and-stop", /acceptance conditions/i],
  ["Build an MCP server.", "mcp-builder", /MCP .*servers/i],
  ["Create an Excel workbook.", "xlsx", /spreadsheet/i],
  ["Design the frontend for this dashboard.", "frontend-design", /product web interface/i],
];

async function skillText(name) {
  return readFile(new URL(`../skills/${name}/SKILL.md`, import.meta.url), "utf8");
}

test("routing contracts name one canonical skill for each core request", async () => {
  for (const [prompt, skill, expected] of cases) {
    const text = await skillText(skill);
    assert.match(text, expected, `${prompt} should route to ${skill}`);
  }
});

test("active canonical skills do not require removed setup workflows", async () => {
  const text = await skillText("code-review");
  assert.doesNotMatch(text, /issue-tracker\.md/i);
});

test("only the consolidated canonical skills remain active", async () => {
  const active = (await readdir(new URL("../skills/", import.meta.url), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(active, [
    "claude-api", "code-review", "codebase-design", "diagnosing-bugs", "docx",
    "frontend-design", "grilling", "lean-build", "mcp-builder", "migration", "pdf",
    "pptx", "safe-refactor", "tdd", "verify-and-stop", "webapp-testing",
    "writing-for-agents", "xlsx",
  ]);
});
