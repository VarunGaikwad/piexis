# Parallel, conflict-safe subagents

## Goal

Allow the `orchestrator` profile to run independent subagent work concurrently without allowing concurrent workspace edits to collide. Preserve the current sequential behavior whenever safety cannot be established.

## Current behavior

- `extensions/agents.ts` registers `subagent` with `executionMode: "sequential"`.
- Each call starts one isolated Pi subprocess through `runSubagent()` in `lib/subagent-runner.ts`.
- Active jobs are retained for cancellation and profile switching, but are not scheduled by scope or concurrency.
- The tool description explicitly promises sequential calls to avoid concurrent workspace edits.

## Design

### 1. Declare work scope

Extend the `subagent` tool parameters with scope metadata:

- `mode`: `"read"` or `"write"` (default conservatively to `"write"` except known exploration work).
- `paths`: optional repository-relative file or directory paths the task may modify.

Rules:

- `purpose: "explore"` is read-only and may run concurrently with all jobs.
- A write task without paths is an unknown/broad write and conflicts with all other write tasks.
- Directory paths conflict with paths nested below them.
- Identical files conflict.
- Paths must be normalized, repository-relative, and must not escape the workspace.
- Read tasks do not reserve paths; write tasks reserve their declared paths until completion.

Initially retain a conservative shared-file list. Any task that may alter `package.json`, lockfiles, `tsconfig.json`, `.pi/`, or other project-wide configuration must be serialized with all writes unless a later design adds more precise dependency handling.

### 2. Scheduler

Create a scheduler module, for example `lib/subagent-scheduler.ts`, responsible for:

- accepting a job with its scope and abort controller;
- starting immediately only when capacity exists and no active write scope conflicts;
- queueing conflicting or over-capacity jobs;
- starting newly eligible queued jobs when an active job settles;
- releasing reservations after success, failure, spawn error, or cancellation;
- aborting both queued and active work during session shutdown.

Use a small default concurrency limit of **2**. Make it configurable in `agent.json` only if the configuration surface is justified; otherwise begin with a constant to keep the first release simple.

The scheduler must not assume jobs finish in submission order.

### 3. Profile and tool policy

- Permit parallel scheduling only when the active parent profile is `orchestrator`.
- Preserve sequential behavior for all other parent profiles.
- Continue to enforce the existing depth limit and plan/ask delegation restrictions.
- Update the orchestrator profile prompt to require precise scopes and to divide work by non-overlapping ownership.
- Update the tool description to state that orchestrator jobs can run concurrently only for non-conflicting work.

This policy prevents a code agent from accidentally creating concurrent writes merely by issuing multiple calls, while making parallelism an explicit orchestration feature.

### 4. Results and visibility

Keep the current per-call model, effort, progress, output, usage, error, and cancellation reporting.

Add scheduler status to progress/details where supported:

- `queued` with the blocking reason (capacity or conflicting path);
- `running`;
- declared mode and paths;
- final completion status.

The parent orchestrator remains responsible for interpreting results, reconciling any integration issues, and running final verification. Do not automatically merge, revert, or modify another agent’s output.

### 5. Cancellation and lifecycle

- Cancelling a queued request removes it from the queue without spawning a child.
- Cancelling a running request uses the existing process-tree cancellation path.
- Session shutdown aborts queued and running jobs, then waits for active jobs to settle.
- Profile switching remains blocked while queued or active work exists.
- Every exit path releases reservations and triggers queue draining exactly once.

## Implementation steps

1. Inspect Pi tool execution semantics to confirm whether changing `executionMode` permits overlapping `execute()` calls; choose the required mode/API shape.
2. Add validated scope parameter types in `extensions/agents.ts` and document their semantics.
3. Implement normalized path validation and overlap detection in a focused, testable library module.
4. Implement the scheduler independently of spawning so its queueing and cleanup behavior can be unit tested with deferred promises.
5. Integrate the scheduler around `runSubagent()` in `extensions/agents.ts`; preserve existing routing, tool selection, usage, and error semantics.
6. Apply orchestrator-only parallel policy and preserve sequential fallback for all unscoped, broad, or non-orchestrator write work.
7. Update prompt/tool text and any user-facing configuration documentation.
8. Add focused tests and run repository checks.

## Tests

Add `node:test` coverage for:

- two independent write scopes begin concurrently when capacity permits;
- same-file and parent-directory/child-file write scopes serialize;
- read-only exploration is not blocked by write reservations;
- unknown/broad write scope serializes with every write;
- the concurrency limit is never exceeded;
- a completed, failed, or aborted job releases scopes and allows the next eligible job to run;
- a cancelled queued job never starts;
- shutdown cancels active work and clears queued work;
- invalid, absolute, and workspace-escaping paths are rejected;
- non-orchestrator invocations preserve sequential behavior.

## Acceptance criteria

- The orchestrator can run up to two independent scoped subagent jobs at once.
- Concurrent writes with overlapping or uncertain ownership never run at the same time.
- Current sequential behavior remains the safe fallback.
- Cancellation, session shutdown, and failures do not leave blocked work or stale path reservations.
- Existing routing, depth limits, and read-only exploration restrictions remain intact.
- `npm run check` and `npm test` pass.
