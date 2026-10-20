import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import test from "node:test";

const skillRoot = new URL("../skills/ui-ux-pro-max/", import.meta.url);
const script = fileURLToPath(new URL("scripts/search.py", skillRoot));

test("UI/UX skill uses portable paths and bundles its referenced runtime", async () => {
  const text = await readFile(new URL("SKILL.md", skillRoot), "utf8");
  assert.doesNotMatch(text, /CLAUDE_PLUGIN_ROOT|\.claude\/skills/);
  assert.match(text, /host before running a command/);
  for (const path of [
    "references/quick-reference.md", "references/pro-rules.md",
    "scripts/search.py", "scripts/core.py", "scripts/design_system.py", "scripts/reasoning_contract.py",
    "data/ux-guidelines.csv", "data/ui-reasoning.csv", "data/stacks/nextjs.csv",
  ]) {
    await access(new URL(path, skillRoot));
  }
});

test("bundled UI/UX search and design generation work outside the project directory", (t) => {
  const version = spawnSync("python3", ["--version"], { encoding: "utf8" });
  if (version.error?.code === "ENOENT") {
    t.skip("python3 is unavailable; runtime smoke test requires Python 3");
    return;
  }
  assert.equal(version.status, 0, version.stderr);

  const run = (...args) => {
    const result = spawnSync("python3", ["-B", script, ...args, "--json"], {
      cwd: tmpdir(), encoding: "utf8", timeout: 30_000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };

  const domain = run("keyboard focus modal", "--domain", "ux");
  assert.equal(domain.domain, "ux");
  assert.ok(domain.count > 0);
  const stack = run("suspense streaming", "--stack", "nextjs");
  assert.equal(stack.stack, "nextjs");
  assert.ok(stack.count > 0);
  const design = run("analytics dashboard", "--design-system");
  assert.ok(design.design_system.style.name);
  assert.ok(design.design_system.colors.primary);
  assert.equal(design.persistence, null);
});
