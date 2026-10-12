import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { piInvocation } from "../lib/subagent-runner.ts";

async function fixture(work) {
  const root = await mkdtemp(join(tmpdir(), "piexis-parallel-subagents-"));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await mkdir(agentDir);
  await writeFile(join(agentDir, "agent.json"), JSON.stringify({ model: "parallel-test/main", subagent_model: "parallel-test/main" }));
  try { await work({ cwd, agentDir }); }
  finally { await rm(root, { recursive: true, force: true }); }
}

function activeCount(events) {
  let active = 0, maximum = 0;
  for (const event of events) {
    active += event.event === "start" ? 1 : -1;
    maximum = Math.max(maximum, active);
  }
  return maximum;
}

async function runScenario(f, agent, scenario) {
  const invocation = piInvocation();
  const args = [...invocation.args,
    "--offline", "--no-session", "--mode", "json", "--no-extensions", "--no-skills", "--no-context-files", "--no-prompt-templates",
    "-e", fileURLToPath(new URL("../extensions/agents.ts", import.meta.url)),
    "-e", fileURLToPath(new URL("./fixtures/parallel-subagents-provider.ts", import.meta.url)),
    "--model", "parallel-test/main", "--agent", agent, "--tools", "subagent,read", "--", `scenario:${scenario}`,
  ];
  const execution = promisify(execFile)(invocation.command, args, {
    cwd: f.cwd,
    env: { ...process.env, PI_CODING_AGENT_DIR: f.agentDir, PIEXIS_SUBAGENT_DEPTH: "0", PIEXIS_SUBAGENT_SCOPE: "", PI_OFFLINE: "1" },
    timeout: 25_000, maxBuffer: 4 * 1024 * 1024,
  });
  execution.child.stdin.end();
  const { stdout } = await execution;
  const events = stdout.trim().split("\n").filter(Boolean).map(JSON.parse);
  let instrumented;
  try { instrumented = (await readFile(join(f.cwd, ".parallel-subagents-events.jsonl"), "utf8")).trim().split("\n").map(JSON.parse); }
  catch { assert.fail(`provider child instrumentation missing:\n${stdout}`); }
  return { events, instrumented, stdout };
}

function executions(events) {
  return events.filter((event) => event.type === "tool_execution_end" && event.toolName === "subagent");
}

function expectedScopes(scenario) {
  const paths = scenario === "independent" ? [["a.ts"], ["b.ts"], ["c.ts"]]
    : scenario === "same" ? [["same.ts"], ["same.ts"], ["same.ts"]]
      : scenario === "ancestor" ? [["src"], ["src/a.ts"], ["src/b.ts"]]
        : scenario === "broad" ? [[], [], []]
          : [["package.json"], ["tsconfig.json"], [".pi/agent.json"]];
  return paths;
}

test("real offline CLI schedules sibling subagents by declared scope", { timeout: 120_000 }, async () => {
  await fixture(async (f) => {
    for (const [agent, scenario, maximum] of [
      ["orchestrator", "independent", 2],
      ["orchestrator", "same", 1],
      ["orchestrator", "ancestor", 1],
      ["orchestrator", "broad", 1],
      ["orchestrator", "shared", 1],
      ["code", "independent", 1],
    ]) {
      const { events, instrumented, stdout } = await runScenario(f, agent, scenario);
      const children = executions(events);
      assert.equal(children.length, 3, stdout);
      assert.ok(children.every((event) => !event.isError && event.result.details.status === "completed"), stdout);
      assert.deepEqual(children.map((event) => event.result.details.paths).sort(), expectedScopes(scenario).sort());
      assert.ok(children.every((event) => event.result.details.mode === "write" && event.result.details.model === "parallel-test/main" && event.result.details.reason === "default subagent"));
      assert.equal(activeCount(instrumented), maximum, `${agent}/${scenario}: ${JSON.stringify(instrumented)}`);
      assert.equal(instrumented.filter((event) => event.event === "start").length, 3);
      if (agent === "orchestrator" && scenario === "independent") {
        const starts = instrumented.map((event, index) => event.event === "start" ? index : -1).filter((index) => index >= 0);
        const firstEnd = instrumented.findIndex((event) => event.event === "end");
        assert.ok(starts[1] < firstEnd && starts[2] > firstEnd, JSON.stringify(instrumented));
      }
      const updates = events.filter((event) => event.type === "tool_execution_update" && event.toolName === "subagent");
      assert.ok(updates.some((event) => event.partialResult?.details?.status === "queued"), stdout);
      assert.ok(updates.some((event) => event.partialResult?.details?.status === "running"), stdout);
      assert.ok(updates.some((event) => event.partialResult?.details?.status === "completed"), stdout);
      assert.ok(children.every((event) => event.result.usage.input === 1 && event.result.usage.output === 1), stdout);
      assert.ok(events.some((event) => event.type === "message_end" && event.message.content?.some((part) => part.text === "parent completed")), stdout);
      // The depth-1 child echoes its inherited, normalized ownership environment.
      for (const event of children) {
        const scope = JSON.stringify({ mode: "write", paths: event.result.details.paths, broad: event.result.details.broad });
        assert.match(event.result.details.output, new RegExp(`scope:${scope.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
      }
      await rm(join(f.cwd, ".parallel-subagents-events.jsonl"), { force: true });
    }
  });
});
