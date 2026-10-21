import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { RepoCache } from "../lib/repo-cache.ts";

// Disposable cache only. An optional path benchmarks an existing working tree without modifying it.
const temporary = await mkdtemp(path.join(tmpdir(), "piexis-index-benchmark-"));
const root = process.argv[2] ? path.resolve(process.argv[2]) : path.join(temporary, "repo");
let cache;
try {
  if (!process.argv[2]) {
    await mkdir(root);
    execFileSync("git", ["-C", root, "init", "-q"]);
    for (let file = 0; file < 500; file++) {
      await writeFile(path.join(root, `${file}.ts`), Array.from({ length: 128 }, (_, line) => `export const value${file}_${line} = ${line};`).join("\n"));
    }
    execFileSync("git", ["-C", root, "add", "."]);
    execFileSync("git", ["-C", root, "-c", "user.name=Benchmark", "-c", "user.email=benchmark@example.invalid", "commit", "-qm", "fixture"]);
  }
  const results = [];
  for (const name of ["cold", "warm restart"]) {
    const start = performance.now();
    cache = await RepoCache.open(root, { cacheDir: path.join(temporary, "cache"), watch: false });
    await cache.sync();
    results.push({ phase: name, elapsedMs: +(performance.now() - start).toFixed(2), ...cache.status() });
    if (name === "warm restart") {
      const before = { ...cache.metrics };
      const repeat = performance.now();
      for (let i = 0; i < 5; i++) await cache.sync({ audit: true });
      results.push({ phase: "five no-change discovery audits", elapsedMs: +(performance.now() - repeat).toFixed(2), hashes: cache.metrics.hashes - before.hashes, chunkMisses: cache.metrics.chunkMisses - before.chunkMisses });
      const turnMetrics = { ...cache.metrics };
      const turns = performance.now();
      for (let i = 0; i < 5; i++) await cache.sync({ budget: 100 });
      results.push({ phase: "five no-change agent reconciliations", elapsedMs: +(performance.now() - turns).toFixed(2), metadataChecks: cache.metrics.metadataChecks - turnMetrics.metadataChecks, hashes: cache.metrics.hashes - turnMetrics.hashes, chunkMisses: cache.metrics.chunkMisses - turnMetrics.chunkMisses });
      if (!process.argv[2]) {
        const edited = Array.from({ length: 128 }, (_, line) => `export const value0_${line} = ${line};`);
        edited[70] = "export const edited = true;";
        await writeFile(path.join(root, "0.ts"), edited.join("\n"));
        const beforeEdit = { ...cache.metrics };
        const edit = performance.now();
        await cache.summary("0.ts");
        results.push({ phase: "one-line edit", elapsedMs: +(performance.now() - edit).toFixed(2), hashes: cache.metrics.hashes - beforeEdit.hashes, chunkHits: cache.metrics.chunkHits - beforeEdit.chunkHits, chunkMisses: cache.metrics.chunkMisses - beforeEdit.chunkMisses });
      }
    }
    await cache.close();
    cache = undefined;
  }
  console.log(JSON.stringify({ root, results }, null, 2));
} finally {
  await cache?.close();
  await rm(temporary, { recursive: true, force: true });
}
