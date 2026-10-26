# Universal Code Health Guardian

The bundled `extensions/code-health.ts` monitors code health without taking over the user's task. It uses the installed Pi extension lifecycle, the existing agent configuration loader and access policy, Pi's file mutation queue, and Pi's authenticated model registry. It adds no dependencies, services, persistent source index, competing agent runtime, commits, or Git mutations.

## Enable and configure

The guardian is enabled in **safe** mode by default. In either `~/.pi/agent/agent.json` (or `$PI_CODING_AGENT_DIR/agent.json`) or a trusted project's `.pi/agent.json`, add:

```json
{
  "codeHealth": {
    "enabled": true,
    "mode": "safe",
    "analyzeChangedFiles": true,
    "reviewAtTaskCompletion": true,
    "largeFileThresholdLines": 800,
    "enableComplexityChecks": true,
    "enableDuplicationChecks": true,
    "enableArchitectureChecks": true,
    "enableAiReview": true,
    "enableRuff": false,
    "exclude": ["node_modules/**", "dist/**", "build/**", "target/**", ".venv/**", "**/generated/**"],
    "maxFilesPerReview": 30,
    "maxAutomaticFixesPerTask": 5,
    "requireValidation": true,
    "cooldownMs": 15000,
    "maxReviewMs": 30000,
    "maxAiOutputTokens": 1024
  }
}
```

These are defaults, not required fields. Project settings merge by field over user settings; `exclude` replaces the inherited list. Legacy `agents.json` remains supported when `agent.json` is absent in the same scope. Unknown keys, invalid modes, and out-of-range limits are rejected. Configuration reloads before each task and command. Invalid configuration disables automatic guardian work rather than interrupting the task. The editor schema is `schemas/agent.schema.json`.

Set `enabled: false` to disable the guardian, or exclude `extensions/code-health.ts` with Pi's package resource filters. Set `enableAiReview: false` to prevent guardian source excerpts being sent to your configured model. Set `mode: "observe"` to prevent **all** guardian writes. Disabling Ruff also prevents all currently implemented automatic fixes.

| Mode | Behavior |
| --- | --- |
| `observe` | Detection and optional read-only AI proposals; never writes. |
| `safe` (default) | Detection, optional AI proposals, and opt-in validated Python formatting on agent-owned files. |
| `autonomous` (opt-in) | Currently the same conservative execution policy as safe mode. AI-assisted structural changes remain proposal-only. |

**Structural automation is deliberately not implemented yet.** Piexis has no transactional structural-edit/validation boundary that can reliably protect arbitrary concurrent user changes across languages. No mode authorizes an AI rewrite, API/configuration/dependency change, or file split based on size. Autonomous mode is accepted and reported, but does not pretend this missing infrastructure exists. `requireValidation: false` does not waive the formatter's mandatory validation; no unvalidated write path exists.

## Monitoring and commands

- `before_agent_start` establishes the pre-task Git dirty-file baseline.
- Native `edit` and `write` tool events record touched paths and before/after hashes. Observation failures never block those tools. Nested tool events are supported.
- `turn_end` performs bounded, read-only analysis of touched files at most once per cooldown (15 seconds by default). No analyzer runs inside an unfinished tool batch; no AI call or fix runs during intermediate turns.
- `agent_settled`, not `agent_end`, reviews current Git changes and directly relevant exact-path imports. Failed/aborted tasks and active tool batches are skipped. Queued work suppresses AI review and fixes.
- Shell and subagent changes are recovered through Git at settlement. They are analyzed but not automatically formatted because ownership was not established by a native file-tool event.
- Guardian work is disabled in delegated subprocesses. Reviews do not send continuation messages or expose tools to the reviewer, so they cannot recursively delegate or trigger another refactor.

Commands require an idle task:

| Command | Purpose |
| --- | --- |
| `/health` | Analyze current staged, unstaged, and untracked changes. |
| `/health all` | Analyze the Git project within the configured file budget. Reports incomplete selection when capped. |
| `/health status` | Show resolved settings, activity, fix count, and structural-automation limitation. |
| `/health fix` | Request only permitted fixes; does not grant ownership of existing user changes. |
| `/health explain` | Show detailed findings and an available bounded AI architecture proposal. |
| `/health cancel` | Cancel an active review, analyzer, or AI request. |

Reports include file and line, category, severity, confidence, evidence, suggestion, applied changes, and validation outcome. Automatic summaries are deduplicated and show at most five findings; explanations show up to 100. Formatting reports identify pre-format locations; rerun `/health` for current locations. JSON/print clients do not receive terminal dialogs; extension status/notifications use Pi's normal UI interface rather than injecting conversation turns.

## Checks and confidence

| Check | Coverage and limitations |
| --- | --- |
| Language/framework hints | JS/TS/React/Next.js, Python/Django/FastAPI, Java/Spring, Kotlin, Go, Rust, C/C++/C#, PHP, Ruby, Swift, HTML/CSS/SCSS, Vue/Svelte, JSON/YAML/Markdown/SQL; unknown UTF-8 text remains inspectable. Hints are not semantic framework analysis. |
| Large files | Informational navigation signal above the line threshold. Never proof of bad design, an AI-review trigger by itself, or a reason to rewrite. |
| Functions/components/methods | Comment/string-masked, single-line lexical signatures estimate function length, nesting and parameter counts in supported imperative languages. React and Spring suggestions explicitly preserve framework boundaries. Multiline signatures and unusual syntax can be missed. |
| Class cohesion | Large class-bearing modules with many method-like signatures receive a low-certainty review signal, not a god-class diagnosis. |
| Duplication | Bounded substantial eight-line windows normalized for whitespace/comments/quoted text. Reports possible duplication, not equivalent behavior or a mandatory shared abstraction. |
| Dependencies | Partial cycles among exact-path relative static JS/TS imports within the selected files and direct neighbors. Type-only imports, aliases, extension inference, re-exports, dynamic imports, package resolution, and whole-project cycles are not resolved. |
| Reliable Python diagnostics | Optional isolated Ruff checks for complexity, branches, returns, statements, parameters, unused imports and unused locals (`C901`, `PLR0911/12/13/15`, `F401`, `F841`). |
| Architecture | Bounded AI proposals can evaluate cohesion, coupling, duplication, misplaced responsibilities, testing evidence, compatibility and benefit/cost. They are not verified architectural violations. The reviewer must acknowledge missing context. |

No invented cyclomatic/cognitive scores, reliable cross-language dead-code detection, semantic responsibility classifier, convention engine, or universal parser is claimed. CSS/SCSS, Vue/Svelte templates and declarative files currently receive size/navigation signals, not semantic refactoring. CSS advice preserves cascade/specificity; no stylesheet is rewritten. Reliable non-Python diagnostics should continue to come from your existing linters and validation tools. New adapters can consume `HealthSource` and return `HealthFinding` using the existing bounded analysis pipeline; there is no separate plugin/runtime installation system.

## Optional Ruff and safe fixes

Install Ruff yourself and ensure a trusted executable is on `PATH`; the guardian never installs it or runs `npx`, package scripts, project hooks, ESLint configs, build scripts, or repository-specified commands to inspect code. Set `enableRuff: true` explicitly. Missing Ruff produces a bounded note and leaves generic analysis available.

Ruff receives source on stdin with fixed arguments, `--isolated` and `--no-cache`. It does **not** load project configuration. Diagnostics do not use `--fix`, and unused imports/locals are never removed automatically. The only write adapter runs `ruff format` on stdin, then checks the proposed text with `E9,F63,F7,F82` before writing. This validates formatter output for selected syntax/error diagnostics, **not** project tests or full behavioral compatibility. Isolated formatting uses Ruff defaults, not repository style settings.

Fixes require a complete Git baseline, a trusted idle project, no pending task/tool batch, a native-file-tool ownership hash, and remaining task budget. Files dirty before the task, changed by the user before an edit, changed externally after the observed edit, ignored, symlinked, or hardlinked are not fixed. The mutation queue rechecks hashes before atomic replacement and preserves mode bits. Validation failure stops remaining fixes. Files without an eligible baseline stay read-only even with `/health fix`. The default five-fix limit applies across commands and completion reviews in a task.

These checks cooperate with Pi writers; they are not filesystem sandboxing or a lock on external editors. An external process can race the final check/rename. Avoid editing the same file concurrently if you enable formatting. No unrelated file is intentionally written, and no checkout, reset, stash, clean, commit, or automatic rollback is performed.

## AI review, privacy and budgets

Review uses the **current user's selected model** through Pi's existing `ModelRegistry.complete`, including host authentication/custom providers. It does not create a second agent runtime, spawn a competing reviewer, or assume a provider. This avoids CLI token-limit and runtime-only credential incompatibilities. It supplies no tools and never executes AI output.

Only files with non-size findings are eligible: at most six files, four findings per file, targeted import/header and finding-adjacent excerpts, at most 3,500 excerpt characters per file and 24,000 characters total. No session transcript or whole-repository prompt is sent. Common secret paths are excluded; sensitive-looking lines are redacted. This is best-effort, not secret detection: source can contain undiscoverable secrets. Disable AI review for sensitive repositories. Repository snippets and analyzer messages are explicitly untrusted data in the review instructions.

At most one AI request is allowed per task, with a cross-task cooldown, configured output-token cap, and total review timeout. Structural changes are never executed, including in autonomous mode. A non-context session entry records model/usage; guardian nested usage is not added to the existing subagent tool totals. `/health explain` reuses the completed proposal until a new task. Size-only files incur no AI cost.

## Performance and exclusions

Discovery uses bounded, NUL-delimited Git commands with external diff/text conversion, configured clean/process filters, fsmonitor and hooks disabled. The working directory is the project boundary, including when it is below a Git root. There is no recursive filesystem scan per edit. Without Git, only explicitly observed paths can be analyzed; full scans and automatic fixes are disabled.

The file budget defaults to 30 (maximum 100), including direct dependency neighbors. Each file is capped at 512 KiB and 20,000 lines. UTF-8 decoding rejects binary/unreadable/oversized files. Built-in exclusions cover dependencies, build output, secrets, generated paths/headers, migrations, fixtures, minified files and lockfiles. `.gitignore`, Git's standard ignore sources (including ignored tracked paths), `.claudeignore`, project boundaries and explicit Node-style glob exclusions are respected. Built-in safety exclusions cannot be removed by configuration.

Analysis is sequential (concurrency one), with a 16-entry content/config-hash result cache, bounded duplicate windows and findings, per-process analyzer time/output bounds, cooldowns and cancellation. There is no persistent source cache. `/health all` is comprehensive only within its stated budget; it does not silently claim whole-project coverage when truncated. Lexical checks can produce false positives and miss syntax. Review findings before acting and use existing project tests for substantial refactors.
