import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("WebUI launcher resolves tsx from its installation, not the workspace", async (t) => {
  const fixture = await mkdtemp(path.join(tmpdir(), "piexis-webui-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const installed = path.join(fixture, "installed package");
  const workspace = path.join(fixture, "unrelated workspace");
  const launcher = path.join(installed, "bin", "piexis-web.mjs");
  await mkdir(path.dirname(launcher), { recursive: true });
  await mkdir(path.join(installed, "apps", "server", "src"), { recursive: true });
  await mkdir(workspace);
  await copyFile(new URL("bin/piexis-web.mjs", root), launcher);
  await writeFile(path.join(installed, "package.json"), JSON.stringify({ type: "module" }));
  await symlink(fileURLToPath(new URL("node_modules", root)), path.join(installed, "node_modules"), "junction");
  // A finite TypeScript entry point exercises the real launcher without leaving a server running.
  await writeFile(path.join(installed, "apps", "server", "src", "index.ts"), `
    const cwd: string = process.cwd();
    console.log(JSON.stringify({ cwd, workspace: process.env.PIXIS_WORKSPACE, port: process.env.PIXIS_PORT, token: process.env.PIXIS_TOKEN, origin: process.env.PIXIS_ORIGIN }));
  `);

  const result = spawnSync(process.execPath, [launcher, "--workspace", workspace, "--port", "4321", "--token", "test-only-token"], {
    cwd: workspace,
    encoding: "utf8",
    timeout: 15_000,
    windowsHide: true
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    cwd: workspace,
    workspace,
    port: "4321",
    token: "test-only-token",
    origin: "http://127.0.0.1:4321"
  });
});
