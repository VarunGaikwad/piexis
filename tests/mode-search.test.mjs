import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createProtectedGrep } from "../lib/mode-grep.ts";
import { fixture, harness } from "./mode-fixtures.mjs";
const exec = promisify(execFile);

test("protected grep excludes credentials/symlinks; YOLO uses native grep without exclusions", async t => {
  try { await exec("rg", ["--version"]); } catch { return t.skip("rg unavailable"); }
  const { root } = await fixture(t);
  await writeFile(join(root, "source.ts"), "MATCH public-source\n");
  const grep = createProtectedGrep(root);
  const result = await grep.execute("test", { pattern: "MATCH", path: root, glob: "*", context: 1 });
  assert.match(result.content[0].text, /public-source/);
  assert.doesNotMatch(result.content[0].text, /SECRET-CONTENT|outside/);
  const app = harness(root, "yolo");
  const native = await app.run("grep", { path: ".env", pattern: "MATCH" });
  assert.match(native.content[0].text, /SECRET-CONTENT/);
  assert.deepEqual(app.sandbox.calls, []);
  await app.runtime.close();
});

test("protected grep truncates output without losing result shape", async t => {
  try { await exec("rg", ["--version"]); } catch { return t.skip("rg unavailable"); }
  const { root } = await fixture(t);
  await writeFile(join(root, "large.txt"), Array.from({ length: 3000 }, () => `MATCH ${"x".repeat(100)}`).join("\n"));
  const result = await createProtectedGrep(root).execute("test", { pattern: "MATCH", path: root, limit: 3000 });
  assert.ok(result.details.truncation);
  assert.ok(Buffer.byteLength(result.content[0].text) < 52_000);
});
