import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("sound HTTP route requires a token and serves only mapped local WAV files", { timeout: 15000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "piexis-audio-http-"));
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const address = reservation.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  await mkdir(join(root, "sounds"));
  const wav = Buffer.from("RIFF-test-local-audio");
  await writeFile(join(root, "sounds", "attention.wav"), wav);
  await writeFile(join(root, "private.txt"), "never serve this");
  const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("../../apps/server/src/index.ts", import.meta.url))], {
    env: { ...process.env, PIXIS_PORT: String(port), PIXIS_TOKEN: "fixture-token", PIXIS_WORKSPACE: root, PI_CODING_AGENT_DIR: root },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let diagnostic = "";
  child.stderr.on("data", (data) => { diagnostic += data; });
  const exited = once(child, "exit");
  try {
    const base = `http://127.0.0.1:${port}`;
    for (let attempt = 0; ; attempt++) {
      try { if ((await fetch(`${base}/health`)).ok) break; } catch { /* Startup is asynchronous. */ }
      if (child.exitCode !== null || attempt > 100) throw new Error(`Server did not start: ${diagnostic}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal((await fetch(`${base}/sounds/attention.wav`)).status, 401);
    assert.equal((await fetch(`${base}/sounds/attention.wav?token=wrong`)).status, 401);
    assert.equal((await fetch(`${base}/sounds/private.wav?token=fixture-token`)).status, 404);
    const response = await fetch(`${base}/sounds/attention.wav?token=fixture-token`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type")!, /audio\/wav/);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), wav);
  } finally {
    child.kill("SIGTERM");
    await exited;
    await rm(root, { recursive: true, force: true });
  }
});
