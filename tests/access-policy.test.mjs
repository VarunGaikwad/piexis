import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { blockedBashReason, deniedPath } from "../lib/access-policy.ts";
import { subagentEnvironment } from "../lib/subagent-runner.ts";
import accessGuard from "../extensions/access-guard.ts";

async function fixture(work) {
  const cwd = await mkdtemp(join(tmpdir(), "piexis-access-policy-"));
  try { await work(cwd); }
  finally { await rm(cwd, { recursive: true, force: true }); }
}

test("protects environment files regardless of ignore exceptions", async () => {
  await fixture(async (cwd) => {
    await writeFile(join(cwd, ".gitignore"), "!.env.example\n");
    assert.match(await deniedPath(cwd, ".env"), /environment files/);
    assert.match(await deniedPath(cwd, ".env.production"), /environment files/);
    assert.match(await deniedPath(cwd, ".env.example"), /environment files/);
  });
});

test("honors gitignore and claudeignore patterns, including nested negation", async () => {
  await fixture(async (cwd) => {
    await mkdir(join(cwd, "src", "generated"), { recursive: true });
    await writeFile(join(cwd, ".gitignore"), "*.secret\nbuild/\n");
    await writeFile(join(cwd, ".claudeignore"), "private/\n");
    await writeFile(join(cwd, "src", ".claudeignore"), "generated/\n!generated/keep.ts\n");
    assert.match(await deniedPath(cwd, "token.secret"), /.gitignore/);
    assert.match(await deniedPath(cwd, "build/output.js"), /.gitignore/);
    assert.match(await deniedPath(cwd, "private/notes.md"), /.claudeignore/);
    assert.match(await deniedPath(cwd, "src/generated/drop.ts"), /.claudeignore/);
    assert.equal(await deniedPath(cwd, "src/generated/keep.ts"), undefined);
  });
});

test("denies paths outside the project and symlinks which escape it", async () => {
  await fixture(async (cwd) => {
    const outside = await mkdtemp(join(tmpdir(), "piexis-access-outside-"));
    try {
      await writeFile(join(outside, "secret.txt"), "secret");
      await symlink(join(outside, "secret.txt"), join(cwd, "linked.txt"));
      assert.match(await deniedPath(cwd, "../outside.txt"), /outside/);
      assert.match(await deniedPath(cwd, "linked.txt"), /symlink escapes/);
    } finally { await rm(outside, { recursive: true, force: true }); }
  });
});

test("allows external resource reads but still blocks external writes through the guard", async () => {
  await fixture(async (cwd) => {
    await fixture(async (outside) => {
      const skill = join(outside, "skills", "grilling", "SKILL.md");
      const extension = join(outside, "extensions", "example.ts");
      await mkdir(join(outside, "skills", "grilling"), { recursive: true });
      await mkdir(join(outside, "extensions"));
      await writeFile(skill, "# Skill");
      await writeFile(extension, "export default () => {};");
      let handler;
      accessGuard({ on(event, callback) { assert.equal(event, "tool_call"); handler = callback; } });
      for (const toolName of ["read", "grep", "find", "ls"]) {
        for (const path of [skill, extension, outside]) {
          assert.equal(await handler({ toolName, input: { path } }, { cwd }), undefined);
        }
      }
      for (const toolName of ["edit", "write"]) {
        for (const path of [skill, extension, join(outside, "new.ts")]) {
          assert.match((await handler({ toolName, input: { path } }, { cwd })).reason, /outside the project/);
        }
      }
      assert.equal(await deniedPath(cwd, "../missing-resource.md", "read"), undefined);
      await writeFile(join(cwd, ".claudeignore"), "private/\n");
      assert.match(await deniedPath(cwd, "private/notes.md", "read"), /claudeignore/);
      assert.match(await deniedPath(cwd, join(outside, ".env"), "read"), /environment files/);
      assert.match(await deniedPath(cwd, join(outside, ".env.production"), "read"), /environment files/);
    });
  });
});

test("allows reading linked external resources without allowing linked environment files", async () => {
  await fixture(async (cwd) => {
    await fixture(async (outside) => {
      await writeFile(join(outside, "SKILL.md"), "# Skill");
      await writeFile(join(outside, ".env"), "SECRET=example");
      await symlink(join(outside, "SKILL.md"), join(cwd, "SKILL.md"));
      await symlink(join(outside, ".env"), join(cwd, "config.txt"));
      assert.equal(await deniedPath(cwd, "SKILL.md", "read"), undefined);
      assert.match(await deniedPath(cwd, "SKILL.md", "write"), /symlink escapes/);
      assert.match(await deniedPath(cwd, "config.txt", "read"), /environment files/);
    });
  });
});

test("flags direct environment inspection and does not inherit arbitrary parent variables", () => {
  assert.match(blockedBashReason("printenv"), /environment/);
  assert.match(blockedBashReason("node -e 'console.log(process.env)'"), /environment/);
  assert.equal(blockedBashReason("npm test"), undefined);
  process.env.PIEIXIS_TEST_SECRET = "not-for-child";
  try {
    const environment = subagentEnvironment(1, { mode: "read", paths: [], broad: false });
    assert.equal(environment.PIEIXIS_TEST_SECRET, undefined);
    assert.equal(environment.PIEXIS_SUBAGENT_DEPTH, "1");
  } finally { delete process.env.PIEIXIS_TEST_SECRET; }
});
