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

test("bundled third-party skills retain provenance and licenses", async () => {
  for (const name of ["caveman", "ponytail"]) {
    await access(new URL(`skills/${name}/LICENSE`, root));
    const notice = await readFile(new URL(`skills/${name}/NOTICE`, root), "utf8");
    assert.match(notice, /https:\/\/github\.com\//);
    assert.match(notice, /Commit: [a-f0-9]{40}/);
  }
  const caveman = await readFile(new URL("skills/caveman/SKILL.md", root), "utf8");
  assert.doesNotMatch(caveman, /`(?:ultracave|megacave|\/caveman-compress)`/);
});
