import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("init writes skill workflow guidance without installing or granting permissions", async () => {
  const prompt = await readFile(new URL("prompts/init.md", root), "utf8");
  assert.match(prompt, /Include an \*\*Agent workflow\*\* section/);
  for (const name of ["caveman", "grilling", "ponytail"]) {
    assert.match(prompt, new RegExp(`\\*\\*${name}:\\*\\*`));
    await access(new URL(`skills/${name}/SKILL.md`, root));
  }
  assert.match(prompt, /Read the matching `SKILL\.md`/);
  assert.match(prompt, /otherwise ask in chat/);
  assert.match(prompt, /Cancellation is not consent/);
  assert.match(prompt, /not runtime enforcement or tool permissions/);
  assert.match(prompt, /do not install anything during `\/init`/);
  assert.match(prompt, /Only create or edit `AGENTS\.md`/);
});

test("init skips ignored or unavailable optional evidence without bypassing restrictions", async () => {
  const prompt = await readFile(new URL("prompts/init.md", root), "utf8");
  assert.match(prompt, /skip it and continue with accessible evidence/);
  assert.match(prompt, /do not retry through another tool or bypass restrictions/);
  assert.match(prompt, /Stop only if required guidance cannot be read or `AGENTS\.md` cannot be safely created or updated/);
  assert.match(prompt, /Use discovery that respects ignore rules/);
  assert.match(prompt, /do not read excluded files merely because they exist or a reference mentions them/);
  assert.match(prompt, /Missing, ignored, or denied optional evidence is not a reason to stop/);
  assert.doesNotMatch(prompt, /If access is denied, explain the limitation and stop/);
});

test("bundled third-party skills retain provenance and licenses", async () => {
  for (const name of ["agent-browser", "caveman", "ponytail", "ui-ux-pro-max"]) {
    await access(new URL(`skills/${name}/LICENSE`, root));
    const notice = await readFile(new URL(`skills/${name}/NOTICE`, root), "utf8");
    assert.match(notice, /https:\/\/github\.com\//);
    assert.match(notice, /Commit: [a-f0-9]{40}/);
  }
  const caveman = await readFile(new URL("skills/caveman/SKILL.md", root), "utf8");
  assert.doesNotMatch(caveman, /`(?:ultracave|megacave|\/caveman-compress)`/);
});
