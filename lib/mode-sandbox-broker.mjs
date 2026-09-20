// Trusted host launcher. One process / SandboxManager per invocation; never load project configuration.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";

const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
let reply;
try {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const request = JSON.parse(Buffer.concat(chunks).toString());
  if (process.platform === "linux") {
    if (!["x64", "arm64"].includes(process.arch)) throw new Error("Required seccomp isolation is unavailable for this architecture");
    const packageRoot = dirname(dirname(fileURLToPath(import.meta.resolve("@anthropic-ai/sandbox-runtime"))));
    // Refuse rather than let the runtime search via a project-aware `npm root` fallback.
    await access(join(packageRoot, "vendor", "seccomp", process.arch, "apply-seccomp"), constants.X_OK);
  }
  const check = await SandboxManager.checkDependenciesAsync();
  if (check.errors.length || check.warnings.length) throw new Error([...check.errors, ...check.warnings].join("; "));
  const profile = structuredClone(request.profile);
  profile.filesystem.allowRead.push(request.scratch);
  profile.filesystem.allowWrite.push(request.scratch);
  await SandboxManager.initialize(profile, undefined, false);
  if (!SandboxManager.isSandboxingEnabled()) throw new Error("Sandbox runtime did not enable isolation");
  const worker = fileURLToPath(new URL("./mode-file-worker.mjs", import.meta.url));
  const command = request.toolRequest
    ? `exec ${quote(process.execPath)} ${quote(worker)}`
    : `exec /bin/bash --noprofile --norc -c ${quote(request.command)}`;
  // Project PATH entries are allowed only after crossing into the sandbox.
  const commandPath = request.commandPath === undefined ? "" : `export PATH=${quote(request.commandPath)}; `;
  const wrapped = await SandboxManager.wrapWithSandbox(`${commandPath}export TMPDIR=${quote(request.scratch)}; ${command}`, "/bin/bash");
  let stderr = "";
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn("/bin/bash", ["--noprofile", "--norc", "-c", wrapped], {
      cwd: request.root, stdio: ["pipe", "pipe", "pipe"], env: process.env
    });
    child.stdout.pipe(process.stdout);
    child.stderr.on("data", data => {
      stderr = (stderr + data.toString()).slice(-8192);
      (request.toolRequest ? process.stderr : process.stdout).write(data);
    });
    child.on("error", reject);
    child.on("close", resolve);
    child.stdin.on("error", () => {});
    child.stdin.end(request.toolRequest ? JSON.stringify({ ...request.toolRequest, root: request.root }) : undefined);
  });
  reply = request.toolRequest && exitCode !== 0 ? { error: `Sandboxed file worker failed: ${stderr}` } : { exitCode };
} catch (error) {
  reply = { error: error instanceof Error ? error.message : String(error) };
} finally {
  await SandboxManager.reset().catch(() => {});
}
if (process.send) {
  await new Promise(resolve => process.send(reply, resolve));
  process.disconnect();
} else {
  console.error("Sandbox broker requires a parent IPC channel");
  process.exitCode = 1;
}
