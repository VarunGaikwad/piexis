import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { PiRpcClient } from "../../packages/pi-integration/src/rpc-client.ts";

test("correlates JSONL responses and forwards streaming records", async () => {
  const client = new PiRpcClient(process.cwd(), process.execPath, [path.join(process.cwd(), "tests/webui/fake-pi.mjs")]);
  const streamed = once(client, "record");
  const response = await client.command({ type: "get_state" });
  assert.equal(response.command, "get_state");
  assert.equal(response.success, true);
  const [record] = await streamed;
  assert.equal((record as { type: string }).type, "message_update");
  client.dispose();
});

test("starts Pi through a Windows cmd launcher", { skip: process.platform !== "win32" }, async (t) => {
  const fixture = await mkdtemp(path.join(tmpdir(), "piexis-rpc-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const launcher = path.join(fixture, "fake-pi.cmd");
  const fakePi = path.join(process.cwd(), "tests/webui/fake-pi.mjs");
  await writeFile(launcher, `@echo off\r\n"%~1" "%~2"\r\n`);
  const client = new PiRpcClient(fixture, launcher, [process.execPath, fakePi]);
  const exited = once(client, "exit");
  const response = await client.command({ type: "get_state" });
  assert.equal(response.success, true);
  await exited;
});
