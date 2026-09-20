import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("package exposes the init prompt with a description and optional guidance", async () => {
  const manifest = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
  assert.ok(manifest.pi.prompts.includes("./prompts"));
  const prompt = await readFile(new URL("prompts/init.md", root), "utf8");
  assert.match(prompt, /^---\r?\ndescription: .+\r?\n---\r?\n/);
  assert.match(prompt, /AGENTS\.md/);
  assert.match(prompt, /\$ARGUMENTS/);
});

test("init guidance preserves existing instructions and permission boundaries", async () => {
  const prompt = await readFile(new URL("prompts/init.md", root), "utf8");
  assert.match(prompt, /preserve its valid instructions and user-authored content/);
  assert.match(prompt, /do not invent commands or claim checks were run/);
  assert.match(prompt, /do not change modes or bypass restrictions/);
});
