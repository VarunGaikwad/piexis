import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { analyzeSources, deduplicateFindings, detectLanguage } from "../lib/code-health-analysis.ts";
import { discoverHealthFiles, isHealthPath, readHealthSource } from "../lib/code-health-files.ts";
import { runRuff } from "../lib/code-health-ruff.ts";

const options = { largeFileThresholdLines: 300, enableComplexityChecks: true, enableDuplicationChecks: true, enableArchitectureChecks: true };
const source = (path, text) => ({ path, text, hash: createHash("sha256").update(text).digest("hex") });
async function fixture(work) {
  const cwd = await mkdtemp(join(tmpdir(), "piexis-health-"));
  try { await work(cwd); } finally { await rm(cwd, { recursive: true, force: true }); }
}
function git(cwd, ...args) {
  return execFileSync("git", ["-c", "user.name=Health Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
const discover = (cwd, extra = {}) => discoverHealthFiles(cwd, { exclude: [], maxFiles: 30, ...extra });

test("detects languages and framework hints without treating healthy examples as problems", async () => {
  for (const [file, language, framework] of [["Card.tsx", "typescript", "React"], ["service.py", "python", undefined], ["AccountService.java", "java", "Spring"]]) {
    const text = await readFile(new URL(`./fixtures/code-health/${file}`, import.meta.url), "utf8");
    assert.deepEqual(detectLanguage(file, text), framework ? { language, framework } : { language });
    assert.deepEqual(analyzeSources([source(file, text)], options), []);
  }
  assert.equal(detectLanguage("style.css", "").language, "css");
  for (const [file, text, framework] of [["page.tsx", 'import Link from "next/link";', "Next.js"], ["view.vue", "", "Vue"], ["view.svelte", "", "Svelte"], ["views.py", "from django.http import HttpResponse", "Django"], ["api.py", "from fastapi import FastAPI", "FastAPI"]]) assert.equal(detectLanguage(file, text).framework, framework);
  assert.equal(detectLanguage("script", "#!/usr/bin/python3\n").language, "python");
});

test("reports bounded lexical function length, parameters and nesting, without source evidence", () => {
  const text = `import React from "react";\nexport function Component(a,b,c,d,e,f,g) {\n${Array.from({ length: 65 }, (_, i) => `  operation${i}(a);`).join("\n")}\nif (a) { if (b) { if (c) { if (d) { if (e) { run(); } } } } }\n}\n`;
  const findings = analyzeSources([source("Component.tsx", text)], options);
  assert.deepEqual(new Set(findings.map((item) => item.category)), new Set(["parameters", "function-length", "nesting"]));
  for (const item of findings) {
    assert.equal(item.confidence, "heuristic");
    assert.match(item.suggestion, /React hook order/);
    assert.doesNotMatch(item.evidence, /operation\d|run\(/);
  }
  assert.deepEqual(deduplicateFindings([...findings, ...findings]), findings);
  assert.deepEqual(analyzeSources([source("Component.tsx", text)], { ...options, enableComplexityChecks: false }), []);
});

test("handles Python boundaries and decorators, while comments, strings and declarative files stay quiet", () => {
  const body = Array.from({ length: 65 }, (_, i) => `    step${i}(value)`).join("\n");
  const findings = analyzeSources([source("service.py", `@decorator\ndef work(a,b,c,d,e,f,g,h):\n${body}\n\ndef other():\n    pass\n`)], options);
  assert.ok(findings.some((item) => item.category === "parameters"));
  assert.ok(findings.some((item) => item.category === "function-length" && /Python decorators/.test(item.suggestion)));
  const fake = `/*\nfunction fake(a,b,c,d,e,f,g) {\n${body}\n}\n*/\nconst quoted = \`function fake(a,b,c,d,e,f,g) { fake(); }\`;`;
  assert.deepEqual(analyzeSources([source("quiet.js", fake)], options), []);
  const css = analyzeSources([source("style.css", "a { color: red; }\n".repeat(310))], options);
  assert.equal(css.length, 1);
  assert.equal(css[0].severity, "info");
  assert.match(css[0].suggestion, /CSS cascade/);
  for (const path of ["migrations/old.py", "fixtures/copy.js", "generated/api.ts"]) assert.deepEqual(analyzeSources([source(path, body.repeat(10))], options), []);
  assert.deepEqual(analyzeSources([source("generated.ts", "// @generated\n" + body.repeat(10))], options), []);
});

test("detects substantial duplication, not boilerplate, with bounded findings and stable ids", () => {
  const block = Array.from({ length: 12 }, (_, i) => `const measurement${i} = calculateReading${i}(input, calibration);`).join("\n");
  const inputs = [source("a.ts", block), source("b.ts", block)];
  const findings = analyzeSources(inputs, options);
  assert.equal(findings.filter((item) => item.category === "duplication").length, 1);
  assert.deepEqual(analyzeSources(inputs, options), findings);
  assert.deepEqual(analyzeSources(inputs, { ...options, enableDuplicationChecks: false }), []);
  const noisy = Array.from({ length: 100 }, (_, i) => `function f${i}(a,b,c,d,e,f,g) { return a; }`).join("\n");
  assert.ok(analyzeSources([source("bounded.js", noisy)], options).length <= 12);
  assert.deepEqual(analyzeSources([source("huge.js", "x\n".repeat(20001))], options), []);
});

test("large class-bearing modules receive a qualified cohesion signal, not a semantic god-class claim", () => {
  const methods = Array.from({ length: 16 }, (_, i) => `  public void method${i}() {\n${"    work();\n".repeat(15)}  }`).join("\n");
  const text = `import org.springframework.stereotype.Service;\npublic class Service {\n${methods}\n}`;
  const findings = analyzeSources([source("Service.java", text)], options);
  const cohesion = findings.find((finding) => finding.category === "class-cohesion");
  assert.equal(cohesion.confidence, "heuristic");
  assert.match(cohesion.suggestion, /not proof of a god class/);
  assert.match(cohesion.suggestion, /Spring annotations/);
  assert.ok(!analyzeSources([source("Service.java", text)], { ...options, enableArchitectureChecks: false }).some((finding) => finding.category === "class-cohesion"));
});

test("reports only exact-path static import cycles with partial-graph caveat", () => {
  const inputs = [source("a.js", 'import { b } from "./b.js";\nexport const a = 1;'), source("b.js", 'import { a } from "./a.js";\nexport const b = 1;')];
  const findings = analyzeSources(inputs, options);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].confidence, "high");
  assert.match(findings[0].suggestion, /partial graph/);
  assert.deepEqual(analyzeSources(inputs, { ...options, enableArchitectureChecks: false }), []);
  assert.deepEqual(analyzeSources([inputs[0]], options), []);
  assert.deepEqual(analyzeSources([source("a.js", 'import b from "./b";'), source("b.js", 'import a from "./a";')], options), []);
});

test("path prefilter rejects secrets, generated/dependency paths, escape and configured native globs", () => {
  for (const path of [".env", ".env.example", "secret.pem", "credentials.json", "src/../x.ts", "a\0.py", "../x", "/tmp/x", "C:\\outside.py", "node_modules/a.js", "dist/a.js", "db/migrations/a.py", "tests/fixtures/a.ts", "src/generated/x.ts", "x.generated.ts", "package-lock.json"]) assert.equal(isHealthPath(path, []), false, path);
  assert.equal(isHealthPath("src/a.test.ts", ["**/*.{test,spec}.ts"]), false);
  assert.equal(isHealthPath("src/a.ts", ["src"]), false);
  assert.equal(isHealthPath("src/a.ts", []), true);
});

test("safe reader rejects symlinks including parents, ignored tracked files, binary and bounded content", async () => {
  await fixture(async (cwd) => {
    await mkdir(join(cwd, "src"));
    await writeFile(join(cwd, "src", "a.ts"), "export const a = 1;\n");
    await writeFile(join(cwd, ".gitignore"), "ignored.ts\n");
    await writeFile(join(cwd, ".claudeignore"), "private.ts\n");
    for (const path of ["ignored.ts", "private.ts", ".env", "big.ts", "lines.ts", "binary.ts", "invalid.ts", "auto.ts"]) {
      const data = path === "big.ts" ? "x".repeat(512 * 1024 + 1) : path === "lines.ts" ? "\n".repeat(20001) : path === "binary.ts" ? Buffer.from([0, 1, 2]) : path === "invalid.ts" ? Buffer.from([255, 254]) : path === "auto.ts" ? "// automatically generated\n" : "private";
      await writeFile(join(cwd, path), data);
      assert.equal(await readHealthSource(cwd, path, []), undefined, path);
    }
    await symlink(join(cwd, "src"), join(cwd, "linked"));
    await symlink(join(cwd, "src", "a.ts"), join(cwd, "link.ts"));
    for (const path of ["linked/a.ts", "link.ts", "src", "../outside.ts", "missing.ts"]) assert.equal(await readHealthSource(cwd, path, []), undefined, path);
    const read = await readHealthSource(cwd, "src/a.ts", []);
    assert.equal(read.path, "src/a.ts");
    assert.equal(read.hash, source("src/a.ts", read.text).hash);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(readHealthSource(cwd, "src/a.ts", [], controller.signal), /abort/i);
  });
});

test("non-Git discovery never walks, requires explicit changed paths, and refuses all", async () => {
  await fixture(async (cwd) => {
    await writeFile(join(cwd, "a.ts"), "export const a = 1;");
    assert.deepEqual((await discover(cwd)).paths, []);
    assert.deepEqual((await discover(cwd, { paths: ["a.ts"] })).paths, ["a.ts"]);
    const all = await discover(cwd, { all: true, paths: ["a.ts"] });
    assert.equal(all.git, false);
    assert.deepEqual(all.paths, []);
    assert.match(all.notes.join(" "), /require Git/);
  });
});

test("Git discovery handles unborn HEAD, untracked, modified, staged rename, deletion, ignores and NUL names", async () => {
  await fixture(async (cwd) => {
    git(cwd, "init", "-q");
    await writeFile(join(cwd, "a.ts"), "export const a = 1;");
    git(cwd, "add", "a.ts");
    const unborn = await discover(cwd);
    assert.deepEqual(unborn.paths, ["a.ts"]);
    assert.match(unborn.notes.join(" "), /HEAD unavailable/);
    await writeFile(join(cwd, "delete.ts"), "export const d = 1;");
    await writeFile(join(cwd, "ignored.ts"), "export const i = 1;");
    await writeFile(join(cwd, "infoignored.ts"), "export const hidden = 1;");
    git(cwd, "add", "."); git(cwd, "commit", "-qm", "initial");
    await rename(join(cwd, "a.ts"), join(cwd, "renamed.ts"));
    git(cwd, "add", "-A");
    await rm(join(cwd, "delete.ts"));
    await writeFile(join(cwd, ".gitignore"), "ignored.ts\n");
    await writeFile(join(cwd, "ignored.ts"), "export const i = 2;");
    await writeFile(join(cwd, ".git", "info", "exclude"), "infoignored.ts\n");
    await writeFile(join(cwd, "infoignored.ts"), "export const hidden = 2;");
    assert.equal(await readHealthSource(cwd, "infoignored.ts", []), undefined);
    await writeFile(join(cwd, "line\nbreak.ts"), "export const newline = 1;");
    const changed = await discover(cwd, { exclude: [".gitignore"] });
    assert.equal(changed.git, true);
    assert.deepEqual(changed.paths, ["line\nbreak.ts", "renamed.ts"]);
    const all = await discover(cwd, { all: true, exclude: [".gitignore"] });
    assert.deepEqual(all.paths, changed.paths);
    const capped = await discover(cwd, { all: true, maxFiles: 1 });
    assert.equal(capped.paths.length, 1);
    assert.equal(capped.truncated, true);
  });
});

test("Git discovery from nested cwd never returns parent files", async () => {
  await fixture(async (cwd) => {
    git(cwd, "init", "-q");
    await mkdir(join(cwd, "nested"));
    await writeFile(join(cwd, "parent.ts"), "export const parent = 1;");
    await writeFile(join(cwd, "nested", "child.ts"), "export const child = 1;");
    git(cwd, "add", "."); git(cwd, "commit", "-qm", "initial");
    await writeFile(join(cwd, "parent.ts"), "export const parent = 2;");
    await writeFile(join(cwd, "nested", "child.ts"), "export const child = 2;");
    for (const all of [false, true]) assert.deepEqual((await discover(join(cwd, "nested"), { all })).paths, ["child.ts"]);
  });
});

test("isolated optional Ruff adapter uses fixed stdin CLI, filters diagnostics, validates formatting and handles failure", async () => {
  await fixture(async (cwd) => {
    const bin = join(cwd, "bin"); await mkdir(bin);
    const program = join(bin, "ruff");
    const oldPath = process.env.PATH;
    process.env.PATH = bin;
    try {
      assert.equal((await runRuff(cwd, source("a.py", "x=1\n"), "check")).available, false);
      const fake = `#!${process.execPath}\nlet input = ''; for await (const part of process.stdin) input += part;\nconst args = process.argv.slice(2);\nif (!args.includes('--isolated') || !args.includes('--no-cache') || args.at(-1) !== '-' || !args.includes('--stdin-filename')) process.exit(2);\nif (args[0] === 'format') { process.stdout.write(input.replace('x=1', 'x = 1')); }\nelse if (args.includes('E9,F63,F7,F82')) { process.stdout.write('[]'); }\nelse { process.stdout.write(JSON.stringify([{code:'F841', message:'Unused local variable', location:{row:1}}, {code:'UNSELECTED', message:'ignored',location:{row:1}}, {code:'F401',message:'bad row',location:{row:999}}])); process.exitCode=1; }\n`;
      await writeFile(program, fake); await chmod(program, 0o755);
      const checked = await runRuff(cwd, source("a.py", "x=1\n"), "check");
      assert.equal(checked.available, true);
      assert.equal(checked.findings.length, 1);
      assert.equal(checked.findings[0].category, "ruff-F841");
      assert.equal(checked.findings[0].file, "a.py");
      assert.equal((await runRuff(cwd, source("a.py", "x=1\n"), "format")).text, "x = 1\n");
      await writeFile(program, `#!${process.execPath}\nprocess.stdout.write('invalid');\n`);
      assert.match((await runRuff(cwd, source("a.py", "x=1"), "check")).error, /invalid JSON/);
      assert.equal((await runRuff(cwd, source("a.py", "x=1"), "format")).text, undefined);
      await writeFile(program, `#!${process.execPath}\nprocess.exit(2);\n`);
      assert.match((await runRuff(cwd, source("a.py", "x=1"), "check")).error, /failed/);
      await writeFile(program, `#!${process.execPath}\nsetInterval(() => {}, 1000);\n`);
      assert.match((await runRuff(cwd, source("a.py", "x=1"), "check", AbortSignal.timeout(50))).error, /cancelled/);
      const controller = new AbortController(); controller.abort();
      assert.match((await runRuff(cwd, source("a.py", "x=1"), "check", controller.signal)).error, /cancelled/);
      assert.match((await runRuff(cwd, source("../a.py", "x=1"), "check")).error, /safe relative/);
    } finally {
      if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    }
  });
});
