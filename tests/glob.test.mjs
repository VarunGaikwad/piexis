import assert from "node:assert/strict";
import test from "node:test";

import glob from "../extensions/glob.ts";
import { READ_TOOLS } from "../lib/mode-policy.ts";

test("glob is registered as a read-only, gitignore-aware file-discovery tool", () => {
  let tool;
  glob({
    registerTool(definition) {
      tool = definition;
    }
  });

  assert.ok(tool);
  assert.equal(tool.name, "glob");
  assert.equal(tool.label, "glob");
  assert.match(tool.description, /\.gitignore/);
  assert.equal(tool.promptSnippet, "Find files by glob pattern (respects .gitignore)");
  assert.deepEqual(tool.promptGuidelines, [
    "Use glob to discover files by pathname pattern before reading or editing them."
  ]);
  assert.equal(tool.parameters.properties.pattern.type, "string");
  assert.equal(tool.parameters.properties.path.type, "string");
  assert.equal(tool.parameters.properties.limit.type, "number");
  assert.equal(typeof tool.execute, "function");
});

test("glob is pre-approved wherever Piexis permits read-only tools", () => {
  assert.equal(READ_TOOLS.has("glob"), true);
});
