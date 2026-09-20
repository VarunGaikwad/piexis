import assert from "node:assert/strict";
import test from "node:test";
import { readFile, access } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { createSandboxBackend } from "../lib/mode-sandbox.ts";
import { fixture, harness } from "./mode-fixtures.mjs";

const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const node = code => `${quote(process.execPath)} -e ${quote(code)}`;

test("real sandbox: containment, native tools, profiles, network and cancellation", { timeout: 180_000 }, async t => {
  const { root, parent } = await fixture(t);
  const sandbox = createSandboxBackend();
  t.after(() => sandbox.close());
  try { await sandbox.check(root, { readRoots: [], allowedDomains: [] }); }
  catch (error) {
    if (process.env.PIEXIS_REQUIRE_SANDBOX === "1") throw error;
    return t.skip(`OS containment NOT verified: ${error.message}`);
  }
  const app = harness(root, "plan", { sandbox });
  t.after(() => app.runtime.close());
  await t.test("read-only commands and managed reads/searches work", async () => {
    assert.match((await app.run("read", { path: "source.ts" })).content[0].text, /42/);
    assert.match((await app.run("bash", { command: "cat source.ts" })).content[0].text, /42/);
    assert.match((await app.run("grep", { pattern: "answer" })).content[0].text, /answer/);
    assert.match((await app.run("find", { pattern: "*.ts" })).content[0].text, /source.ts/);
    assert.match((await app.run("ls", {})).content[0].text, /source.ts/);
  });
  await t.test("arbitrary shell mutations and subprocesses fail in Plan", async () => {
    for (const command of [
      "printf bad > source.ts", "rm source.ts", "cat <<'EOF' > source.ts\nbad\nEOF",
      "bash -c 'echo bad > source.ts'",
      node("require('fs').writeFileSync('source.ts','bad')"),
      `printf bad > ${quote(join(parent, "outside.txt"))}`,
      "printf bad > .pi/plans/from-bash.md"
    ]) await assert.rejects(app.run("bash", { command }), undefined, command);
    assert.match(await readFile(join(root, "source.ts"), "utf8"), /42/);
    assert.equal(await readFile(join(parent, "outside.txt"), "utf8"), "outside\n");
  });
  await t.test("only guarded plan Markdown operations may mutate", async () => {
    const path = ".pi/plans/real.md";
    await app.run("write", { path, content: "Plan αβ🙂" });
    await app.run("edit", { path, edits: [{ oldText: "Plan", newText: "Revised plan" }] });
    assert.equal(await readFile(join(root, path), "utf8"), "Revised plan αβ🙂");
    await app.run("delete_plan", { path });
    await assert.rejects(access(join(root, path)));
    await assert.rejects(app.run("write", { path: ".pi/plans/no.js", content: "bad" }));
  });
  await t.test("Build permits scripts but not outside, protected or implicit cache writes", async () => {
    app.runtime.setMode("build");
    await app.run("bash", { command: node("require('fs').writeFileSync('artifact.txt','built')") });
    await app.run("write", { path: "nested/new.ts", content: "new" });
    assert.equal(await readFile(join(root, "artifact.txt"), "utf8"), "built");
    for (const path of [join(parent, "outside.txt"), join(root, ".env"), join(root, ".pi/settings.json"), "/tmp/claude/piexis-test-no-write"]) {
      await assert.rejects(app.run("bash", { command: node(`require('fs').writeFileSync(${JSON.stringify(path)},'bad')`) }));
    }
    assert.equal(await readFile(join(parent, "outside.txt"), "utf8"), "outside\n");
    assert.match(await readFile(join(root, ".env"), "utf8"), /SECRET-CONTENT/);
    assert.equal(app.confirmations.length, 0);
  });
  await t.test("Plan cannot connect to a host service", async () => {
    app.runtime.setMode("plan");
    let connected = false;
    const server = createServer(socket => { connected = true; socket.destroy(); });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = server.address().port;
      await app.run("bash", { command: node(`const s=require('net').connect(${port},'127.0.0.1'); s.on('connect',()=>process.exit(2)); s.on('error',()=>process.exit(0)); setTimeout(()=>process.exit(0),1500);`) });
      assert.equal(connected, false);
    } finally { await new Promise(resolve => server.close(resolve)); }
  });
  await t.test("Default approvals and process cancellation remain functional", async () => {
    app.runtime.setMode("default");
    app.approve(true);
    await app.run("bash", { command: "pwd" });
    assert.equal(app.confirmations.length, 1);
    const signal = AbortSignal.timeout(1000);
    await assert.rejects(app.run("bash", { command: "sleep 60" }, signal), /cancel|abort/i);
    // Cancellation must not leave a sandbox command or shared manager active.
    await app.run("bash", { command: "printf done" });
  });
});

test("real backend fails closed on an invalid required read root", async t => {
  const { root } = await fixture(t);
  const backend = createSandboxBackend();
  t.after(() => backend.close());
  await assert.rejects(backend.check(root, { readRoots: [join(root, "does-not-exist")], allowedDomains: [] }), /unavailable|ENOENT/);
});
