import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile, mkdir, symlink, link, rm, chmod } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { fixture, harness, fakeSandbox } from "./mode-fixtures.mjs";
import { DEFAULT_SETTINGS, MODES, parseMode, parseSettings, permission, validateTarget, isSecretPath, protectedProjectPaths, IMPLEMENTATION_WRITE_DENIES } from "../lib/mode-policy.ts";
import { sandboxProfile, sandboxEnvironment, launcherEnvironment } from "../lib/mode-sandbox.ts";

// Independent expected policy, not derived from the implementation table.
const cases = [
  ["read", { path: "source.ts" }, ["allow", "allow", "allow"]],
  ["grep", { pattern: "answer" }, ["allow", "allow", "allow"]],
  ["find", { pattern: "*.ts" }, ["allow", "allow", "allow"]],
  ["ls", {}, ["allow", "allow", "allow"]],
  ["bash", { command: "pwd" }, ["confirm", "allow", "allow"]],
  ["bash", { command: "git status" }, ["confirm", "allow", "allow"]],
  ["bash", { command: "node -e 'require(\"fs\").writeFileSync(\"x\",\"x\")'" }, ["confirm", "allow", "allow"]],
  ["write", { path: "new.ts", content: "new" }, ["confirm", "deny", "allow"]],
  ["edit", { path: "source.ts", edits: [{ oldText: "42", newText: "43" }] }, ["confirm", "deny", "allow"]],
  ["write", { path: ".pi/plans/task.md", content: "Plan" }, ["confirm", "allow", "allow"]],
  ["delete_plan", { path: ".pi/plans/task.md" }, ["confirm", "allow", "allow"]]
];
for (const [column, mode] of ["default", "plan", "build"].entries()) {
  test(`${mode}: complete permission matrix`, async t => {
    const { root } = await fixture(t);
    const app = harness(root, mode);
    t.after(() => app.runtime.close());
    for (const [tool, input, permissions] of cases) {
      const expected = permissions[column];
      app.confirmations.length = 0;
      app.approve(false);
      if (expected === "allow") await app.run(tool, structuredClone(input));
      else await assert.rejects(app.run(tool, structuredClone(input)), expected === "confirm" ? /declined/ : /Switch with \/mode build/);
      assert.equal(app.confirmations.length, expected === "confirm" ? 1 : 0, `${mode}/${tool}`);
      if (expected === "confirm") {
        app.approve(true);
        await app.run(tool, structuredClone(input));
        await app.run(tool, structuredClone(input));
        assert.equal(app.confirmations.length, 3, "approval must not be cached");
      }
    }
  });
}

test("mode names and strict user settings", () => {
  assert.deepEqual(MODES.map(m => m.id), ["default", "plan", "build", "yolo"]);
  assert.equal(parseMode(" BUILD "), "build");
  for (const value of ["code", "architect", "debug", "ask", "orchestrator", "toString", null]) assert.equal(parseMode(value), undefined);
  assert.equal(permission("yolo", "write"), "allow");
  assert.deepEqual(parseSettings({}, "/tmp"), DEFAULT_SETTINGS);
  for (const value of [null, [], { enabled: false }, { readRoots: "x" }, { allowedDomains: [3] }]) assert.throws(() => parseSettings(value, "/tmp"));
});

test("outside, protected, symlink and hardlink targets fail before approval", async t => {
  const { root, parent } = await fixture(t);
  await symlink(parent, join(root, "outside-dir"));
  await symlink(join(parent, "missing"), join(root, "dangling"));
  await link(join(parent, "outside.txt"), join(root, "hardlink"));
  for (const mode of ["default", "plan", "build"]) {
    const app = harness(root, mode);
    app.approve(true);
    for (const path of ["../outside.txt", "outside-link", "secret-link", ".env", "@.env", pathToFileURL(join(parent, "outside.txt")).href, "dangling", "hardlink"]) {
      await assert.rejects(app.run("read", { path }), undefined, `${mode} read ${path}`);
    }
    for (const path of ["../outside.txt", "outside-dir/new.md", ".env", ".pi/settings.json", ".git/hooks/run", ".git/config", ".bashrc"]) {
      await assert.rejects(app.run("write", { path, content: "bad" }), undefined, `${mode} write ${path}`);
    }
    assert.equal(app.confirmations.length, 0);
    await app.runtime.close();
  }
});

test("Plan exception is narrow, canonical, and does not include arbitrary Markdown", async t => {
  const { root, parent } = await fixture(t);
  const app = harness(root, "plan");
  await symlink(join(parent, "outside.txt"), join(root, ".pi/plans/escape.md"));
  for (const path of ["README.md", ".pi/plans/code.ts", ".pi/plans/nested/task.md", ".pi/plans/../settings.md", ".pi/plans/escape.md", ".pi/plans/.env.md"]) {
    await assert.rejects(app.run("write", { path, content: "bad" }));
  }
  await app.run("write", { path: ".pi/plans/task.md", content: "safe" });
  await assert.rejects(app.run("delete_plan", { path: "source.ts" }));
  await app.runtime.close();
});

test("headless, failed UI, cancellation and argument/target changes fail closed", async t => {
  const { root, parent } = await fixture(t);
  const app = harness(root);
  app.ctx.hasUI = false;
  await assert.rejects(app.run("write", { path: "source.ts", content: "bad" }), /no confirmation UI/);
  app.ctx.hasUI = true;
  app.ctx.ui.confirm = async () => { throw new Error("UI disconnected"); };
  await assert.rejects(app.run("write", { path: "source.ts", content: "bad" }), /disconnected/);
  await assert.rejects(app.run("read", { path: "source.ts" }, AbortSignal.abort()));
  const input = { path: "source.ts", content: "bad" };
  app.ctx.ui.confirm = async () => { input.content = "changed"; return true; };
  await assert.rejects(app.run("write", input), /arguments changed/);
  app.ctx.ui.confirm = async () => {
    assert.throws(() => app.runtime.setMode("yolo"), /Wait for/);
    await rm(join(root, "source.ts"));
    await symlink(join(parent, "outside.txt"), join(root, "source.ts"));
    return true;
  };
  await assert.rejects(app.run("write", { path: "source.ts", content: "bad" }), /Outside|symlink/);
  assert.equal(app.sandbox.calls.filter(c => c[0] === "write").length, 0);
  await app.runtime.close();
});

test("shutdown aborts a pending approval and prevents queued sibling execution", async t => {
  const { root } = await fixture(t);
  const app = harness(root);
  let entered;
  const confirming = new Promise(resolve => { entered = resolve; });
  app.ctx.ui.confirm = (_title, _message, { signal }) => new Promise(resolve => {
    signal.addEventListener("abort", () => resolve(false), { once: true });
    entered();
  });
  const first = assert.rejects(app.run("write", { path: "a.ts", content: "a" }));
  const second = assert.rejects(app.run("write", { path: "b.ts", content: "b" }));
  await confirming;
  await app.runtime.close();
  await Promise.all([first, second]);
  assert.equal(app.sandbox.calls.filter(call => call[0] === "write").length, 0);
});

test("sandbox failure blocks before approval and never runs a native fallback", async t => {
  const { root } = await fixture(t);
  const sandbox = fakeSandbox();
  sandbox.check = async () => { throw new Error("sandbox unavailable"); };
  const app = harness(root, "default", { sandbox });
  app.approve(true);
  await assert.rejects(app.run("write", { path: "source.ts", content: "bad" }), /sandbox unavailable/);
  assert.equal(app.confirmations.length, 0);
  assert.match(await readFile(join(root, "source.ts"), "utf8"), /42/);
  await app.runtime.close();
});

test("YOLO bypasses sandbox, secret/outside protections, and malformed mode config", async t => {
  const { root, parent } = await fixture(t);
  const sandbox = fakeSandbox();
  sandbox.check = async () => { throw new Error("must not be called"); };
  const app = harness(root, "yolo", { sandbox, configurationError: "bad config" });
  app.ctx.hasUI = false;
  app.ctx.ui = new Proxy({}, { get() { throw new Error("No UI in YOLO"); } });
  await app.run("write", { path: "../outside.txt", content: "YOLO" });
  await app.run("write", { path: ".env", content: "YOLO credential fixture" });
  const read = await app.run("read", { path: ".env" });
  assert.match(read.content[0].text, /YOLO credential/);
  await app.run("bash", { command: "printf native" });
  assert.equal(await readFile(join(parent, "outside.txt"), "utf8"), "YOLO");
  assert.equal(app.confirmations.length, 0);
  assert.deepEqual(sandbox.calls, []);
  await app.runtime.close();
});

test("manual shell is authorized by typing but retains the mode's sandbox", async t => {
  const { root } = await fixture(t);
  const app = harness(root);
  await app.runtime.manualBash("pwd", root, { onData() {} }, app.ctx);
  assert.equal(app.confirmations.length, 0);
  assert.ok(app.sandbox.calls.some(c => c[0] === "bash" && c[1] === "default"));
  app.runtime.setMode("plan");
  await app.runtime.manualBash("touch forbidden", root, { onData() {} }, app.ctx);
  assert.ok(app.sandbox.calls.some(c => c[0] === "bash" && c[1] === "plan"));
  await app.runtime.close();
  await assert.rejects(app.run("read", { path: "source.ts" }));
});

test("sandbox profiles revoke implicit write grants, protect host code, and separate plan files from bash", async t => {
  const { root } = await fixture(t);
  const settings = { readRoots: [], allowedDomains: ["example.com"] };
  const plan = await sandboxProfile("plan", root, settings);
  assert.deepEqual(plan.filesystem.allowWrite, []);
  assert.deepEqual(plan.network.allowedDomains, []);
  const build = await sandboxProfile("build", root, settings);
  assert.deepEqual(build.filesystem.allowWrite, [root]);
  assert.deepEqual(build.network.allowedDomains, ["example.com"]);
  assert.ok(build.filesystem.denyWrite.includes("/tmp/claude"));
  assert.ok(build.filesystem.denyWrite.includes(join(root, ".pi")));
  for (const path of IMPLEMENTATION_WRITE_DENIES) assert.ok(build.filesystem.denyWrite.includes(path));
  const doc = await sandboxProfile("plan", root, settings, "write", join(root, ".pi/plans/task.md"));
  assert.deepEqual(doc.filesystem.allowWrite, [join(root, ".pi/plans")]);
  assert.ok(!doc.filesystem.denyWrite.includes(join(root, ".pi")));
  await assert.rejects(sandboxProfile("yolo", root, settings));
  assert.deepEqual(sandboxEnvironment({ PATH: "/bin", BASH_ENV: "/evil", NODE_OPTIONS: "--import evil", API_KEY: "secret", PI_SESSION_ID: "session" }), { PATH: "/bin", PI_SESSION_ID: "session" });
});

test("host launchers never resolve project PATH programs or symlinked project binaries", async t => {
  const { root, parent } = await fixture(t);
  const bin = join(root, "bin");
  await mkdir(bin);
  await writeFile(join(bin, "rg"), "#!/bin/sh\nexit 0\n");
  await chmod(join(bin, "rg"), 0o755);
  const env = await launcherEnvironment(root, { PATH: `${bin}:/usr/bin:/bin` });
  assert.ok(!env.PATH.includes(bin));
  const outsideBin = join(parent, "bin");
  await mkdir(outsideBin);
  await symlink(join(bin, "rg"), join(outsideBin, "rg"));
  await assert.rejects(launcherEnvironment(root, { PATH: `${outsideBin}:/usr/bin:/bin` }), /inside the writable project/);
  await rm(join(outsideBin, "rg"));
  await writeFile(join(outsideBin, "rg"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await assert.rejects(launcherEnvironment(root, { PATH: `${outsideBin}:/usr/bin:/bin` }), /shim\/script/);
});

test("protected scan covers nested credentials and hardlinks without treating all Git files as secrets", async t => {
  const { root, parent } = await fixture(t);
  await mkdir(join(root, "nested"));
  await writeFile(join(root, "nested/private.key"), "secret");
  await link(join(parent, "outside.txt"), join(root, "alias"));
  const paths = await protectedProjectPaths(root);
  assert.ok(paths.read.includes(join(root, "nested/private.key")));
  assert.ok(paths.write.includes(join(root, "alias")));
  assert.equal(isSecretPath(join(root, ".git/objects/a")), false);
  await rm(join(root, "alias"));
  await validateTarget("build", "read", { path: "../outside.txt" }, root, { readRoots: [parent], allowedDomains: [] });
});
