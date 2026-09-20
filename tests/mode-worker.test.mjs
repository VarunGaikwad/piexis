import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { readFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fixture } from "./mode-fixtures.mjs";
const worker = fileURLToPath(new URL("../lib/mode-file-worker.mjs", import.meta.url));
// This tests the trusted worker's input handling, NOT OS containment.
function invoke(root, tool, input, mode = "plan") {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [worker], { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", d => { out += d; });
    child.stderr.on("data", d => { err += d; });
    child.on("error", reject);
    child.on("close", code => {
      try { if (code) throw new Error(err); resolve(JSON.parse(out)); } catch (e) { reject(e); }
    });
    child.stdin.end(JSON.stringify({ root, mode, tool, input, settings: { readRoots: [], allowedDomains: [] } }));
  });
}
test("worker maintains plan Markdown using Pi edit semantics and validates again at execution", async t => {
  const { root, parent } = await fixture(t);
  const path = ".pi/plans/test.md";
  let response = await invoke(root, "write", { path, content: "# Plan\n1. Test\n" });
  assert.ok(response.result);
  response = await invoke(root, "edit", { path, edits: [{ oldText: "1. Test", newText: "1. Verify" }] });
  assert.ok(response.result.details.diff);
  assert.match(await readFile(join(root, path), "utf8"), /Verify/);
  assert.match((await invoke(root, "write", { path: "source.ts", content: "bad" })).error, /\/mode build/);
  await symlink(join(parent, "outside.txt"), join(root, ".pi/plans/escape.md"));
  assert.ok((await invoke(root, "write", { path: ".pi/plans/escape.md", content: "bad" })).error);
  response = await invoke(root, "delete_plan", { path });
  assert.ok(response.result);
  await assert.rejects(readFile(join(root, path)), { code: "ENOENT" });
});
