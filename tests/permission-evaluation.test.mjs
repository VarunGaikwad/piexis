import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cases, validateCorpus, requestFor, score, main } from "../eval/permissions.mjs";
import { AUTO_REVIEW_POLICY } from "../lib/permission-taxonomy.ts";

const answer = (item, overrides = {}) => ({ id: item.id, stopReason: "stop", response: JSON.stringify({
  decision: item.expected, category: item.categories[0], reason: "Synthetic scorer fixture, not a model result.",
  authorizedBy: [requestFor(item).context.intent.currentRequestId], ...overrides
}) });

test("labeled corpus covers all review categories, counterfactual pairs, injection, and delegation", () => {
  const counts = validateCorpus();
  assert.ok(counts.cases >= 24 && counts.allow >= 6 && counts.deny >= 12);
  assert.deepEqual(new Set(cases.flatMap((item) => item.categories)), new Set(Object.keys(AUTO_REVIEW_POLICY)));
  for (const pair of ["status", "delete", "upload", "deploy", "external", "bypass", "delegate"]) {
    assert.deepEqual(new Set(cases.filter((item) => item.tags.includes(`pair-${pair}`)).map((item) => item.expected)), new Set(["allow", "deny"]));
  }
  assert.throws(() => validateCorpus([cases[0], cases[0]]), /duplicate/);
  assert.throws(() => validateCorpus([]), /empty/);
});

test("exports contain only synthetic requests, not labels or rationales; no provider is contacted", async () => {
  const result = await main(["--export"]);
  assert.equal(result.requests.length, cases.length);
  for (const request of result.requests) {
    assert.equal(request.expected, undefined);
    assert.equal(request.rationale, undefined);
    assert.ok(request.systemPrompt.includes("untrusted DATA"));
    assert.equal(request.payload.context.cwd, "/fixture/workspace");
  }
  assert.equal((await main([])).liveModelRun, false);
  await assert.rejects(main(["--live"]), /Usage/);
});

test("scoring files require matching request/prompt/corpus identities and a named model", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "piexis-eval-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "predictions.json");
  const exported = await main(["--export"]);
  const input = { corpusHash: exported.corpusHash, promptHash: exported.promptHash, requestHash: exported.requestHash, model: "synthetic-oracle-not-a-model-run", predictions: cases.map((item) => answer(item)) };
  await writeFile(path, JSON.stringify(input));
  assert.equal((await main(["--score", path])).totals.correct, cases.length);
  for (const key of ["corpusHash", "promptHash", "requestHash", "model"]) {
    await writeFile(path, JSON.stringify({ ...input, [key]: "" }));
    await assert.rejects(main(["--score", path]), /matching/);
  }
});

test("scoring separates unsafe raw allows, host overrides, malformed responses, and absent predictions", () => {
  const oracle = score(cases.map((item) => answer(item)));
  assert.equal(oracle.totals.correct, cases.length);
  assert.equal(oracle.totals.invalid, 0);
  const prohibited = cases.find((item) => item.categories[0] === "credential-access");
  const unsafe = score([answer(prohibited, { decision: "allow" })]);
  assert.equal(unsafe.totals.falseAllows, 1);
  assert.equal(unsafe.totals.policyOverrides, 1);
  assert.equal(unsafe.totals.correct, 0);
  assert.equal(unsafe.totals.invalid, cases.length - 1);
  const allowed = cases.find((item) => item.expected === "allow");
  for (const prediction of [answer(allowed, { authorizedBy: ["invented"] }), { ...answer(allowed), stopReason: "aborted" }, { id: allowed.id, response: "not JSON", stopReason: "stop" }]) {
    const result = score([prediction], [allowed]);
    assert.equal(result.totals.invalid, 1);
    assert.equal(result.totals.correct, 0);
  }
  assert.throws(() => score([answer(allowed), answer(allowed)]), /duplicate/);
  assert.throws(() => score([{ id: "unknown" }]), /Unknown/);
});
