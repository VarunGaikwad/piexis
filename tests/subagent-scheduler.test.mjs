import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SubagentScheduler, normalizeSubagentScope, scopesConflict } from "../lib/subagent-scheduler.ts";

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const write = (paths) => ({ mode: "write", paths, broad: !paths.length });
const read = (paths = []) => ({ mode: "read", paths, broad: false });

async function fixture(work) {
  const cwd = await mkdtemp(join(tmpdir(), "piexis-scheduler-"));
  try { await work(cwd); } finally { await rm(cwd, { recursive: true, force: true }); }
}

test("normalizes scopes and rejects invalid paths", async () => fixture(async (cwd) => {
  assert.deepEqual(await normalizeSubagentScope(cwd, {}), write([]));
  assert.deepEqual(await normalizeSubagentScope(cwd, {}, true), read([]));
  assert.deepEqual(await normalizeSubagentScope(cwd, { mode: "write", paths: ["src/../src/a.ts", "src/a.ts"] }), write(["src/a.ts"]));
  for (const path of [".", "./", "src/.."]) {
    assert.equal((await normalizeSubagentScope(cwd, { paths: [path] })).broad, true);
  }
  assert.equal((await normalizeSubagentScope(cwd, { paths: ["package.json"] })).broad, true);
  for (const path of [".pi/agent.json", "apps/server/package.json", "tsconfig.web.json", "pnpm-lock.yaml", ".github/workflows/check.yml", "vite.config.ts"]) {
    assert.equal((await normalizeSubagentScope(cwd, { paths: [path] })).broad, true, path);
  }
  for (const input of [{ mode: null }, { mode: "other" }, { paths: "src/a" }, { paths: [""] }, { paths: ["../a"] }, { paths: ["/a"] }, { paths: ["C:foo"] }, { paths: ["C:/foo"] }, { paths: ["a\\b"] }, { paths: ["a\0b"] }]) {
    await assert.rejects(normalizeSubagentScope(cwd, input));
  }
  await assert.rejects(normalizeSubagentScope(cwd, { mode: "write" }, true));
}));

test("write normalization rejects symlink aliases but permits missing paths", async () => fixture(async (cwd) => {
  await mkdir(join(cwd, "real"));
  await symlink(join(cwd, "real"), join(cwd, "alias"));
  await assert.rejects(normalizeSubagentScope(cwd, { paths: ["alias/file.ts"] }), /symbolic-link/);
  assert.deepEqual(await normalizeSubagentScope(cwd, { paths: ["missing/file.ts"] }), write(["missing/file.ts"]));
}));

test("scope conflicts cover paths, ancestors, broad writes, and never reads", () => {
  assert.equal(scopesConflict(write(["a.ts"]), write(["a.ts"])), true);
  assert.equal(scopesConflict(write(["src"]), write(["src/a.ts"])), true);
  assert.equal(scopesConflict(write(["a.ts"]), write(["b.ts"])), false);
  assert.equal(scopesConflict(write(["src"]), write(["src-other/a.ts"])), false);
  assert.equal(scopesConflict(write([]), write(["b.ts"])), true);
  assert.equal(scopesConflict(read(["src"]), write(["src/a.ts"])), false);
});

test("independent writes run concurrently and do not assume completion order", async () => {
  const scheduler = new SubagentScheduler();
  const first = deferred(), second = deferred(), started = [];
  const a = scheduler.schedule({ scope: write(["a.ts"]), controller: new AbortController(), run: () => { started.push("a"); return first.promise; } });
  const b = scheduler.schedule({ scope: write(["b.ts"]), controller: new AbortController(), run: () => { started.push("b"); return second.promise; } });
  assert.deepEqual(started, ["a", "b"]);
  second.resolve("second"); assert.equal(await b, "second"); assert.equal(scheduler.size, 1);
  first.resolve("first"); assert.equal(await a, "first"); assert.equal(scheduler.size, 0);
});

test("conflicting writes serialize while reads run beside writes", async () => {
  const scheduler = new SubagentScheduler();
  const hold = deferred(), started = [];
  const first = scheduler.schedule({ scope: write(["src"]), controller: new AbortController(), run: () => { started.push("write"); return hold.promise; } });
  const second = scheduler.schedule({ scope: write(["src/a.ts"]), controller: new AbortController(), run: async () => { started.push("conflict"); } });
  const exploration = scheduler.schedule({ scope: read(["src/a.ts"]), controller: new AbortController(), run: async () => { started.push("read"); } });
  await exploration;
  assert.deepEqual(started, ["write", "read"]);
  hold.resolve(); await first; await second;
  assert.deepEqual(started, ["write", "read", "conflict"]);
});

test("capacity scans past blocked jobs and reports capacity versus path conflicts", async () => {
  const scheduler = new SubagentScheduler(2);
  const a = deferred(), b = deferred(), events = [], started = [];
  const one = scheduler.schedule({ scope: write(["a"]), controller: new AbortController(), run: () => { started.push("a"); return a.promise; } });
  const two = scheduler.schedule({ scope: write(["b"]), controller: new AbortController(), run: () => { started.push("b"); return b.promise; } });
  const blocked = scheduler.schedule({ scope: write(["a/x"]), controller: new AbortController(), onStatus: (s) => events.push(s), run: async () => started.push("blocked") });
  assert.equal(events.at(-1).reason, "capacity");
  b.resolve(); await two;
  assert.equal(events.at(-1).reason, "conflicting path: a/x");
  a.resolve(); await one; await blocked;
  assert.deepEqual(started, ["a", "b", "blocked"]);
});

test("serial work excludes all other active work", async () => {
  const scheduler = new SubagentScheduler(2);
  const hold = deferred(), started = [];
  const normal = scheduler.schedule({ scope: write(["a"]), controller: new AbortController(), run: () => { started.push("normal"); return hold.promise; } });
  const serial = scheduler.schedule({ scope: read(), controller: new AbortController(), serial: true, run: async () => started.push("serial") });
  const later = scheduler.schedule({ scope: read(), controller: new AbortController(), run: async () => started.push("later") });
  assert.deepEqual(started, ["normal", "later"]);
  hold.resolve(); await normal; await serial;
  assert.deepEqual(started, ["normal", "later", "serial"]);
});

test("failure, synchronous throw, and queued cancellation release reservations", async () => {
  const scheduler = new SubagentScheduler(1);
  const controller = new AbortController(), started = [];
  const failed = scheduler.schedule({ scope: write(["a"]), controller: new AbortController(), run: () => { throw new Error("boom"); } });
  const queued = scheduler.schedule({ scope: write(["b"]), controller, run: async () => started.push("never") });
  controller.abort();
  await assert.rejects(failed, /boom/);
  await assert.rejects(queued, { name: "AbortError" });
  const after = scheduler.schedule({ scope: write(["c"]), controller: new AbortController(), run: async () => started.push("after") });
  await after;
  assert.deepEqual(started, ["after"]);
});

test("shutdown aborts queued and active jobs, waits for settlement, and is idempotent", async () => {
  const scheduler = new SubagentScheduler(1);
  const activeController = new AbortController(), gate = deferred(), started = [];
  const active = scheduler.schedule({ scope: write(["a"]), controller: activeController, run: () => {
    started.push("active");
    return gate.promise;
  } });
  const queued = scheduler.schedule({ scope: write(["b"]), controller: new AbortController(), run: async () => started.push("queued") });
  const closing = scheduler.shutdown("session ended");
  assert.equal(activeController.signal.aborted, true);
  await assert.rejects(queued);
  gate.reject(activeController.signal.reason);
  await assert.rejects(active);
  await Promise.all([closing, scheduler.shutdown()]);
  assert.equal(scheduler.size, 0);
  assert.deepEqual(started, ["active"]);
});

test("broad writes block scoped writes but not reads", async () => {
  const scheduler = new SubagentScheduler();
  const hold = deferred(), started = [];
  const broad = scheduler.schedule({ scope: write([]), controller: new AbortController(), run: () => hold.promise });
  const scoped = scheduler.schedule({ scope: write(["src/a.ts"]), controller: new AbortController(), run: async () => started.push("write") });
  const exploration = scheduler.schedule({ scope: read(), controller: new AbortController(), run: async () => started.push("read") });
  await exploration;
  assert.deepEqual(started, ["read"]);
  hold.resolve(); await broad; await scoped;
  assert.deepEqual(started, ["read", "write"]);
});

test("failed and aborted active jobs retain ownership until settlement then drain", async () => {
  for (const aborted of [false, true]) {
    const scheduler = new SubagentScheduler();
    const hold = deferred(), controller = new AbortController(), started = [];
    const first = scheduler.schedule({ scope: write(["src/a.ts"]), controller, run: () => hold.promise });
    const rejected = assert.rejects(first, /failed/);
    const second = scheduler.schedule({ scope: write(["src/a.ts"]), controller: new AbortController(), run: async () => started.push("next") });
    if (aborted) controller.abort();
    assert.deepEqual(started, []);
    hold.reject(new Error("failed"));
    await rejected; await second;
    assert.deepEqual(started, ["next"]);
    assert.equal(scheduler.size, 0);
  }
});

test("capacity never exceeds two even with many out-of-order completions", async () => {
  const scheduler = new SubagentScheduler();
  const gates = Array.from({ length: 8 }, deferred);
  let active = 0, maximum = 0;
  const jobs = gates.map((gate, i) => scheduler.schedule({
    scope: write([`${i}.ts`]), controller: new AbortController(),
    run: async () => {
      active++; maximum = Math.max(maximum, active);
      await gate.promise;
      active--;
    },
  }));
  assert.equal(active, 2);
  for (const i of [1, 0, 3, 2, 5, 4, 7, 6]) {
    gates[i].resolve(); await jobs[i];
    assert.ok(active <= 2);
  }
  assert.equal(maximum, 2);
  assert.equal(scheduler.size, 0);
});

test("observer exceptions and reentrant cancellation/shutdown cannot retain or start cancelled jobs", async () => {
  const scheduler = new SubagentScheduler(1);
  const hold = deferred(), a = new AbortController(), b = new AbortController();
  let called = false;
  const active = scheduler.schedule({ scope: read(), controller: new AbortController(), run: () => hold.promise });
  const first = scheduler.schedule({ scope: read(), controller: a, onStatus: (state) => {
    if (state.status === "running") b.abort();
    throw new Error("observer failed");
  }, run: async () => {} });
  const second = scheduler.schedule({ scope: read(), controller: b, run: async () => { called = true; } });
  const rejected = assert.rejects(second, { name: "AbortError" });
  hold.resolve(); await active; await first; await rejected;
  assert.equal(called, false);
  assert.equal(scheduler.size, 0);

  const stopping = new SubagentScheduler();
  let closing;
  const cancelled = stopping.schedule({ scope: read(), controller: new AbortController(),
    onStatus: (state) => { if (state.status === "running") closing = stopping.shutdown(); },
    run: async () => { called = true; },
  });
  await assert.rejects(cancelled, { name: "AbortError" });
  await closing;
  assert.equal(called, false);
  assert.equal(stopping.size, 0);
});

test("cancelled active work that resolves is still reported as aborted", async () => {
  const scheduler = new SubagentScheduler();
  const hold = deferred(), controller = new AbortController(), states = [];
  const job = scheduler.schedule({ scope: write(["a.ts"]), controller, run: () => hold.promise, onStatus: (state) => states.push(state.status) });
  const rejected = assert.rejects(job, { name: "AbortError" });
  controller.abort();
  hold.resolve("ignored cancellation");
  await rejected;
  assert.equal(states.at(-1), "aborted");
  assert.equal(scheduler.size, 0);
});
