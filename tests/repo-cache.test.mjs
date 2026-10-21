import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { RepoCache } from "../lib/repo-cache.ts";
import repoCacheExtension from "../extensions/repo-cache.ts";

async function fixture(t, git = true) {
  const base = await mkdtemp(path.join(tmpdir(), "piexis-repo-cache-"));
  const root = path.join(base, "repo");
  const cacheDir = path.join(base, "cache");
  await mkdir(root);
  const caches = [];
  t.after(async () => { for (const cache of caches) await cache.close(); await rm(base, { recursive: true, force: true }); });
  const runGit = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  if (git) {
    runGit("init", "-q");
    runGit("config", "user.email", "test@example.invalid");
    runGit("config", "user.name", "Fixture");
  }
  const write = async (name, contents) => { await mkdir(path.dirname(path.join(root, name)), { recursive: true }); await writeFile(path.join(root, name), contents); };
  const open = async (options = {}) => { const cache = await RepoCache.open(root, { cacheDir, watch: false, ...options }); caches.push(cache); return cache; };
  return { root, cacheDir, write, open, git: runGit };
}

test("unchanged Git repositories reuse hashes and processing, including after restart", async (t) => {
  const f = await fixture(t);
  await f.write("source.ts", "export const answer = 42;\n");
  f.git("add", "."); f.git("commit", "-qm", "initial");
  const cold = await f.open();
  assert.equal(cold.metrics.hashes, 1);
  const snapshot = cold.files.get("source.ts");
  await cold.changedFiles();
  const initialMisses = cold.metrics.chunkMisses;
  assert.deepEqual((await cold.changedFiles()).changes, []);
  assert.equal(cold.metrics.hashes, 1);
  assert.equal(cold.metrics.chunkMisses, initialMisses);
  const checks = cold.metrics.metadataChecks;
  for (let i = 0; i < 3; i++) await cold.sync({ budget: 100 });
  assert.equal(cold.metrics.metadataChecks, checks, "clean agent turns do not stat every indexed file");
  await cold.close();
  const warm = await f.open();
  assert.equal(warm.metrics.hashes, 0);
  assert.equal(warm.metrics.chunkMisses, 0);
  assert.deepEqual(warm.files.get("source.ts"), snapshot);
  assert.equal((await warm.summary("source.ts")).outline[0].text, "export const answer = 42;");
  assert.equal(warm.metrics.hashes, 0);
  assert.ok(warm.metrics.cacheBytes > 0);
  const [index] = await readdir(f.cacheDir);
  assert.equal(JSON.parse(await readFile(path.join(f.cacheDir, index), "utf8")).schema, 1);
});

test("modifications rehash only the affected file and reuse unchanged chunks", async (t) => {
  const f = await fixture(t);
  const lines = Array.from({ length: 128 }, (_, i) => `export const item${i} = ${i};`);
  await f.write("large.ts", lines.join("\n"));
  await f.write("stable.ts", "export class Stable {}\n");
  const cache = await f.open();
  await cache.changedFiles();
  const before = { ...cache.metrics };
  const previous = cache.files.get("large.ts").hash;
  lines[70] = "export const changed = true;";
  await f.write("large.ts", lines.join("\n"));
  const result = await cache.changedFiles();
  assert.deepEqual(result.changes, [{ path: "large.ts", kind: "modified" }]);
  assert.equal(cache.metrics.hashes - before.hashes, 1);
  assert.equal(cache.metrics.chunkMisses - before.chunkMisses, 1);
  assert.equal(cache.metrics.chunkHits - before.chunkHits, 1);
  const summary = await cache.summary("large.ts");
  assert.notEqual(summary.hash, previous);
  assert.deepEqual(summary.outline.find((item) => item.line === 71), { line: 71, text: "export const changed = true;" });
});

test("detects created and deleted files, including names with spaces and newlines", async (t) => {
  const f = await fixture(t);
  await f.write("old.ts", "const old = 1;");
  const cache = await f.open();
  await cache.changedFiles();
  await f.write("new file\nname.ts", "const fresh = 1;");
  await rm(path.join(f.root, "old.ts"));
  const result = await cache.changedFiles();
  assert.deepEqual(result.changes.sort((a, b) => a.path.localeCompare(b.path)), [
    { path: "new file\nname.ts", kind: "added" }, { path: "old.ts", kind: "deleted" }
  ]);
  await assert.rejects(cache.summary("old.ts"), /missing/);
});

test("uses working-tree contents for staged, unstaged and untracked files", async (t) => {
  const f = await fixture(t);
  await f.write("file.ts", "const initial = 1;");
  f.git("add", "."); f.git("commit", "-qm", "initial");
  const cache = await f.open();
  await cache.changedFiles();
  await f.write("file.ts", "const staged = 2;"); f.git("add", "file.ts");
  await f.write("file.ts", "const unstaged = 3;");
  await f.write("new.ts", "const untracked = 4;");
  const result = await cache.changedFiles();
  assert.deepEqual(result.workingTree, [{ path: "file.ts", status: "MM" }, { path: "new.ts", status: "??" }]);
  assert.equal((await cache.summary("file.ts")).outline[0].text, "const unstaged = 3;");
  assert.equal((await cache.summary("new.ts")).outline[0].text, "const untracked = 4;");
  f.git("add", "."); f.git("commit", "-qm", "changed");
  const committed = await cache.changedFiles();
  assert.equal(committed.head, f.git("rev-parse", "HEAD"));
  assert.deepEqual(committed.workingTree, []);
});

test("branch switches and committed deletions invalidate only affected entries", async (t) => {
  const f = await fixture(t);
  await f.write("branch.ts", "const original = true;");
  await f.write("stable.ts", "const stable = true;");
  f.git("add", "."); f.git("commit", "-qm", "initial");
  const originalBranch = f.git("branch", "--show-current");
  const cache = await f.open(); await cache.changedFiles();
  f.git("checkout", "-qb", "other");
  await f.write("branch.ts", "const other = true;");
  f.git("add", "."); f.git("commit", "-qm", "other");
  const before = cache.metrics.hashes;
  assert.deepEqual((await cache.changedFiles()).changes, [{ path: "branch.ts", kind: "modified" }]);
  assert.equal(cache.metrics.hashes - before, 1);
  f.git("checkout", "-q", originalBranch);
  assert.equal((await cache.summary("branch.ts")).outline[0].text, "const original = true;");
  f.git("rm", "branch.ts"); f.git("commit", "-qm", "delete");
  assert.ok((await cache.changedFiles()).changes.some((item) => item.path === "branch.ts" && item.kind === "deleted"));
});

test("excludes ignored, sensitive, binary, oversized, generated and configurable paths", async (t) => {
  const f = await fixture(t);
  await f.write(".gitignore", "ignored/\n*.log\n!keep.log\n");
  await f.write("ignored/private.ts", "const secret = 1;");
  await f.write("skip.log", "const secret = 1;");
  await f.write("keep.log", "const keep = 1;");
  await f.write(".env.test", "SECRET=never-index");
  await f.write("dist/output.ts", "const generated = 1;");
  await f.write("node_modules/dependency.ts", "const dependency = 1;");
  await f.write("custom/skip.ts", "const custom = 1;");
  await f.write("binary.dat", Buffer.from([0, 1, 2]));
  await f.write("invalid.dat", Buffer.from([0xff, 0xfe]));
  await f.write("huge.ts", "x".repeat(2048));
  const cache = await f.open({ exclude: ["custom"], maxFileBytes: 1024 });
  assert.equal(cache.files.has("keep.log"), true);
  for (const name of ["ignored/private.ts", "skip.log", ".env.test", "dist/output.ts", "node_modules/dependency.ts", "custom/skip.ts", "huge.ts"]) assert.equal(cache.files.has(name), false, name);
  for (const name of ["binary.dat", "invalid.dat"]) await assert.rejects(cache.summary(name), /binary/);
  await assert.rejects(cache.summary("../outside.ts"), /outside/);
  await assert.rejects(cache.summary(".env.test"), /excluded/);
});

test("new ignore rules invalidate previously indexed files without editing their contents", async (t) => {
  const f = await fixture(t);
  await f.write("file.ts", "const visible = true;");
  f.git("add", "."); f.git("commit", "-qm", "initial");
  const cache = await f.open(); await cache.changedFiles();
  await f.write(".gitignore", "file.ts\n");
  await cache.changedFiles();
  assert.equal(cache.files.has("file.ts"), false);
  await assert.rejects(cache.summary("file.ts"), /excluded/);
});

test("non-Git fallback and targeted validation catch missed notifications and preserved mtimes", async (t) => {
  const f = await fixture(t, false);
  await f.write("file.ts", "const before = 1;");
  const cache = await f.open(); await cache.changedFiles();
  assert.equal(cache.git, false);
  const old = cache.files.get("file.ts").metadata;
  await f.write("file.ts", "const after_ = 2;");
  await utimes(path.join(f.root, "file.ts"), new Date(old.mtimeMs), new Date(old.mtimeMs));
  const summary = await cache.summary("file.ts");
  assert.equal(summary.outline[0].text, "const after_ = 2;");
  await f.write("new.ts", "const added = true;");
  await rm(path.join(f.root, "file.ts"));
  assert.ok((await cache.changedFiles()).changes.some((item) => item.kind === "deleted"));
});

test("symlinks cannot expose files outside the repository", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, "..", "outside.ts"), "const secret = 1;");
  await symlink(path.join(f.root, "..", "outside.ts"), path.join(f.root, "link.ts"));
  const cache = await f.open();
  assert.equal(cache.files.has("link.ts"), false);
  await assert.rejects(cache.summary("link.ts"), /missing|excluded/);
});

test("startup hashing is bounded, tools finish pending work, and cancellation fails closed", async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 110; i++) await f.write(`${i}.ts`, `const value${i} = ${i};`);
  const cache = await f.open();
  assert.equal(cache.metrics.hashes, 100);
  assert.equal(cache.status().pending, 10);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(cache.changedFiles(abort.signal), /abort/i);
  await cache.changedFiles();
  assert.equal(cache.files.size, 110);
  assert.equal(cache.status().pending, 0);
  assert.equal(cache.metrics.hashes, 110);
});

test("background updates retain changes until the discovery tool consumes them", async (t) => {
  const f = await fixture(t);
  await f.write("file.ts", "const before = 1;");
  const cache = await f.open(); await cache.changedFiles();
  await f.write("file.ts", "const after = 2;");
  await cache.sync(); await cache.sync();
  assert.deepEqual((await cache.changedFiles()).changes, [{ path: "file.ts", kind: "modified" }]);
  assert.deepEqual((await cache.changedFiles()).changes, []);
});

test("filesystem/timer synchronization updates files automatically and shuts down cleanly", { timeout: 10000 }, async (t) => {
  const f = await fixture(t, false);
  await f.write("file.ts", "const before = 1;");
  const cache = await f.open({ watch: true });
  const hash = cache.files.get("file.ts").hash;
  await f.write("file.ts", "const after = 2;");
  const deadline = Date.now() + 7000;
  while (cache.files.get("file.ts").hash === hash && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.notEqual(cache.files.get("file.ts").hash, hash);
  await cache.close();
  await assert.rejects(cache.sync(), /closed/);
});

test("malformed persistent indexes rebuild safely and file limits fail explicitly", async (t) => {
  const f = await fixture(t);
  await f.write("file.ts", "const one = 1;");
  const cache = await f.open(); await cache.close();
  const [file] = await readdir(f.cacheDir);
  await writeFile(path.join(f.cacheDir, file), "{broken");
  const recovered = await f.open();
  assert.equal(recovered.metrics.hashes, 1);
  await f.write("second.ts", "const two = 2;");
  await assert.rejects(f.open({ maxFiles: 1 }), /limit exceeded/);
});

test("extension registers supported tools, lifecycle handlers and status without replacing reads", () => {
  const tools = [], handlers = new Map(), commands = new Map();
  repoCacheExtension({ registerFlag() {}, getFlag() {}, registerTool(tool) { tools.push(tool); }, on(name, handler) { handlers.set(name, handler); }, registerCommand(name, command) { commands.set(name, command); } });
  assert.deepEqual(tools.map((tool) => tool.name), ["get_changed_files", "get_file_summary"]);
  assert.match(tools[0].promptGuidelines.join("\n"), /Before broad repository exploration, call get_changed_files/);
  assert.match(tools[0].promptGuidelines.join("\n"), /cache is unavailable or results are truncated, use native discovery tools/);
  assert.match(tools[1].promptGuidelines.join("\n"), /Before rereading a previously explored file, call get_file_summary/);
  assert.match(tools[1].promptGuidelines.join("\n"), /hash matches the version already read, reuse that content from context/);
  assert.match(tools[1].promptGuidelines.join("\n"), /Read directly when exact code is needed/);
  assert.ok(commands.has("repo-cache-status"));
  assert.ok(handlers.has("session_start"));
  assert.ok(handlers.has("before_agent_start"));
  assert.ok(handlers.has("session_shutdown"));
  assert.equal(handlers.has("tool_call"), false);
});

test("registered tools return fresh results across lifecycle updates and report status", async (t) => {
  const f = await fixture(t);
  await f.write("source.ts", "export const original = true;");
  const tools = new Map(), handlers = new Map(), commands = new Map(), notices = [];
  repoCacheExtension({ registerFlag() {}, getFlag() {}, registerTool(tool) { tools.set(tool.name, tool); }, on(name, handler) { handlers.set(name, handler); }, registerCommand(name, command) { commands.set(name, command); } }, { cacheDir: f.cacheDir });
  const ctx = { cwd: f.root, ui: { notify(text) { notices.push(text); } } };
  t.after(() => handlers.get("session_shutdown")());
  await handlers.get("session_start")({}, ctx);
  const summary = await tools.get("get_file_summary").execute("one", { path: "source.ts" }, undefined, undefined, ctx);
  assert.equal(summary.details.outline[0].text, "export const original = true;");
  await f.write("source.ts", "export const updated = true;");
  await handlers.get("before_agent_start")({}, ctx);
  const updated = await tools.get("get_file_summary").execute("two", { path: "source.ts" }, undefined, undefined, ctx);
  assert.notEqual(updated.details.hash, summary.details.hash);
  const changes = await tools.get("get_changed_files").execute("three", {}, undefined, undefined, ctx);
  assert.ok(changes.details.changes.some((item) => item.path === "source.ts"));
  await commands.get("repo-cache-status").handler("", ctx);
  assert.match(notices.at(-1), /1 files indexed.*hits.*misses.*bytes on disk/);
});
