import assert from "node:assert/strict";
import { once } from "node:events";
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
