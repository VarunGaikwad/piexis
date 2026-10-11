import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { workspacePath } from "../../apps/server/src/workspace.ts";

test("workspacePath rejects traversal outside the workspace", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pixis-workspace-"));
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "ok.ts"), "export {};");
  assert.equal(await workspacePath(root, "src/ok.ts"), path.join(root, "src", "ok.ts"));
  await assert.rejects(() => workspacePath(root, "../outside"), /Invalid workspace path|Path escapes workspace/);
});
