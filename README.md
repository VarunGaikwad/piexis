# PieXis

PieXis is a Pi package with permission/approval controls, background Git-worktree tasks, prompts, skills, and UI resources. It requires Node.js 22.19+ and a current Pi release (local runtime checks passed with Pi 0.85.1 and 0.87.1 on Linux).

> [!WARNING]
> **PieXis permission controls are not a security boundary.** They help prevent accidental or unapproved agent tool actions; they do **not** provide OS-level sandboxing, filesystem isolation, workspace-only filesystem enforcement, protected-path enforcement, network isolation, or network allowlisting. Run Pi in an appropriate container, VM, sandbox, or restricted user account when executing untrusted code or allowing unattended/high-autonomy agents.

## Install and use

```sh
pi install npm:@preapexis/piexis
```

Installing the package loads its declared extensions, prompts, skills, and theme. Loading only `extensions/mode.ts` loads only the permission extension. Restart Pi or run `/reload` after installation.

Use `Alt+M` while the agent is idle to cycle Manual → Accept Edits → Plan → Auto (when configured). `/plan [task]` enters Plan mode. Start `dontAsk` and `bypassPermissions` only with `--permission-mode`; `--dangerously-skip-permissions` selects `bypassPermissions`.

## Permission modes

| Mode | Behavior |
| --- | --- |
| **Manual** (`default`) | Project-local ordinary reads/searches, a tiny harmless Bash-builtin set, and `AskQuestion` are pre-approved; other actions need approval. **Allow once** applies only to the current call. |
| **Accept Edits** (`acceptEdits`) | Also pre-approves ordinary project-local `edit` and `write` calls. Bash outside the harmless-builtin set, external paths, and sensitive paths still require approval. |
| **Plan** (`plan`) | Allows project-local ordinary reads, task status/diff inspection/cancellation, and `AskQuestion`; Bash, external/sensitive path-tool reads, task creation/apply/cleanup, and file mutations are blocked. |
| **Auto** (`auto`) | Directly permits ordinary project-local reads, `edit`, and `write`. Sensitive paths, protected configuration edits, uncertain recursive searches, and malformed or unsupported paths/tools remain denied. Bash outside the harmless-builtin set and eligible narrow session grants, plus remaining known external actions, receive intent-aware model review. Missing authorization, timeout, error, or invalid review denies the action. |
| **Don't Ask** (`dontAsk`) | Permits only pre-approved reads/questions and harmless Bash builtins; denies other calls without a dialog. Launch-only. |
| **Bypass Permissions** (`bypassPermissions`) | Skips **PieXis extension-level permission checks**. It does not enter or escape a sandbox, and does not override OS permissions or other extensions. Task scope/confirmation safeguards remain. Launch-only. |

Approval UI is fail-closed: calls requiring approval are denied when no permission UI is available. Relative paths resolve against the tool's current working directory, independently of the repository boundary. Both requested and resolved paths are checked; a symlink that resolves outside the project is treated as external, and malformed or unresolvable paths are denied. This is a permission policy, not filesystem sandboxing.

`grep`, `find`, and `glob` receive a bounded, metadata-only subtree preflight. Sensitive descendants, symlinks, external trees, inspection errors, or exhaustion of the 2,000-entry/directory budget require fresh one-time approval in Manual/Accept Edits and are denied in Auto/Plan/Don't Ask. No file contents are read by this preflight. It deliberately does not assume ignore rules exclude sensitive files; large repositories (including their `.git` contents) may require narrowing the search directory. It does not filter tool results or prevent filesystem races.

Credential categories include environment files, common credential files, SSH/cloud/key directories, and Pi authentication files. Path-tool mutations (`edit`/`write`) beneath `.git` and Pi's configuration directory (`CONFIG_DIR_NAME`, normally `.pi`) require explicit approval, including settings, permission configuration, and extensions. Ordinary non-secret configuration reads remain permitted. `.env.example` is not automatically assumed secret-free: explicitly approve that exact file in Manual/Accept Edits without granting access to other environment files.

Session approvals are in-memory and never persisted. Filesystem approvals remain scoped to the file/directory and exact tool operation (`read`, `write`, `edit`, etc.). Broad grants do not authorize credential paths or protected path-tool configuration edits. Recursive-boundary requests offer only one-time approval or denial. Auto now honors eligible exact-file/directory grants and fingerprinted Bash grants after non-overridable checks, but only for the same verified current request. Whole-tool/project and legacy executable grants never bypass Auto review. Session approvals are cleared on branch navigation and session replacement.

The advanced Manual/Accept Edits option remains **Allow ALL bash actions for this session**. This is deliberately broad: it can still modify configuration or access host resources. The bounded Bash checks do not constrain arbitrary program or extension internals. `AskQuestion` remains available in every mode, including after a denial stop.

### Permission decision order

`lib/mode-policy.ts` exposes the shared, UI-independent `evaluatePermission` function. Foreground mode handling and the parent task broker supply the mode, tool arguments, current directory, workspace boundary, and authorization context; actor identity itself grants no authority. Worker calls also require a live delegated authorization and pass capability/path-scope checks. Foreground grants are never inherited by workers. The host still validates tool schemas.

1. `AskQuestion` retains its exception. Worker capability/path-scope checks precede the parent mode's Bypass exception.
2. Reject malformed inputs and unresolvable paths.
3. Apply Plan restrictions, bounded Bash analysis, and Auto non-overridable checks.
4. Match eligible scoped approvals and mode defaults. Auto rejects broad/stale grants; unsupported shell forms cannot match a reusable narrow Bash grant.
5. Return `require-approval`, or deny in Don't Ask. Model review and approval UI are handled by the extension and fail closed.

Repository configuration currently selects models only; there are no repository-provided allow rules or trusted-environment grants. Future permission-widening settings must require user confirmation rather than trusting repository declarations. Background tools are classified individually. Their handlers authorize task creation with the complete brief and require explicit confirmation for actual patch application and validated cleanup; this is not a blanket allow for custom tools.

## Configuration

Launching PieXis does not create `.pi/` or project configuration. It uses in-memory defaults when `.pi/permission-modes.json` is absent. Run `/piexis-init` to explicitly create `.pi/settings.json` and `.pi/permission-modes.json`; existing files are never overwritten.

`permission-modes.json` can select Auto's authenticated classifier and permitted background models:

```json
{
  "version": 1,
  "initialized": true,
  "classifier": {
    "provider": "anthropic",
    "model": "claude-haiku-4-5",
    "timeoutMs": 15000
  },
  "background": { "models": ["anthropic/claude-haiku-4-5"] }
}
```

`PI_PERMISSION_CLASSIFIER=provider/model` overrides the configured classifier. Configuration contains no credentials; Pi authentication is reused.

## Auto review policy and privacy

Auto uses **deterministic policy → one model reviewer**, not a multi-model pipeline. Ordinary local reads/edits do not call the reviewer. Review compares the proposed action against the current user request and earlier user constraints, rather than treating ordinary-looking command names as sufficient authorization.

| Review category | Rule |
| --- | --- |
| Ordinary development | Must serve the current requested task |
| External filesystem | Intent must cover the external target and operation |
| Destructive changes | Specific authorization for operation, target, and scope |
| Credential exploration/exposure | Denied; normal use of an authenticated CLI is distinct |
| Data egress | Authorization must cover destination, payload, and purpose |
| Production/shared systems | Explicit target and operation required |
| Privilege/security weakening | Denied in unattended Auto |
| Safeguard bypasses | Explicit authorization for the particular bypass |
| Opaque execution or ambiguity | Denied when effects/authorization cannot be established |

The taxonomy lives in `lib/permission-taxonomy.ts`. Shell syntax is boundedly parsed; full program semantics remain model-assessed. These are permission-review policies, not guarantees that every shell effect will be detected. Every model allow must cite the current user message and any supporting user messages using valid IDs. Unknown categories, missing/currently invalid evidence, malformed output, abnormal completion, and provider failure fail closed. The host rejects allows in prohibited categories even if the model returns them. Auto does not add approval dialogs or change modes on denial. Repeated denials stop the run under the limits below.

### What is sent

For reviewed actions, the configured provider receives:
- Tool name and Bash command or requested filesystem path.
- Working directory, workspace boundary, and deterministic path-policy findings.
- Bounded, provenance-labelled user messages from the active branch.
- Eligible file/directory approval scopes from that same current request when review is still needed. Invalid or stale Bash grants are not forwarded as authorization.
- Bounded shell parsing results and risk findings; no script or Git configuration contents.
- For task creation and worker review, the proposed task/brief, selected model, and delegated path/Bash scope, explicitly marked as untrusted action data—not user authorization.

Other than the proposed delegation brief described above, it does **not** receive assistant prose/reasoning, raw tool-output history, worker result summaries, compaction summaries, file contents, edit/write replacement text, environment-variable objects, or Pi authentication credentials. The reviewer has no tool access. User prose, paths, commands, and approval strings can themselves contain secrets: recognition/redaction is best-effort, not a secret-detection guarantee. Do not use Auto when those details must not be disclosed to the selected provider. Recognizably secret-bearing or oversized review payloads are denied locally, without contacting the provider. PieXis does not log review payloads; Pi's normal user-message/session storage still applies.

### Provenance and context limits

`lib/permission-intent.ts` observes Pi's `input` source and exactly matches delivered user text. It stores only a content digest, timestamp, and source in non-model session metadata, not another prompt copy. Only matched `interactive` (including normal CLI input) and `rpc` inputs count as user authorization. This is observational provenance inside a trusted extension runtime, not cryptographic proof of human identity or protection against malicious extensions.

Raw active-branch user entries preserve constraints across resume and compaction. Abandoned branches and generated summaries cannot supply authorization. Unknown/extension-injected messages are excluded; if the current request has no verified provenance, reviewed actions are denied. Older sessions without provenance need a new direct, self-contained request. Expanded/transformed prompts that do not match the observed input are conservatively unverified; submit the request directly instead. Changes to historical user entries invalidate completeness rather than silently dropping constraints. Undelivered queued input pauses reviewed actions; authorization is rechecked after model review so a changed request, branch, or session cannot reuse an in-flight allow.

The context budget is 16 verified messages, 6,000 characters per message, and 24,000 characters total. Omitted history, oversized messages, recognizable secret redaction, or unsupported non-text input marks the context incomplete. Reviewed actions then fail closed rather than allowing on a truncated authorization record; start a fresh session with the necessary constraints when history exceeds the budget. Direct local reads/edits remain available. Unit tests cover these contracts with mocked reviewers; they do not establish live-model classification accuracy.

## Bash analysis and permission management

`lib/bash-policy.ts` implements a bounded literal-shell lexer/parser (16,000 characters, 256 tokens, 32 commands). It recognizes quoted words, command chains, pipelines, simple redirections, assignments, working-directory changes, wrappers/interpreters, and advisory destructive/network/shared-system/safeguard-bypass findings. Literal filesystem targets of supported commands/redirections receive path checks. This is not exhaustive command-effect analysis: it does not execute substitutions, inspect script bodies, or resolve arbitrary wrappers. Unsupported expansions, compound syntax, heredocs, descriptor redirections, and exhausted budgets require review/approval, never a narrow reusable grant.

Only standalone `pwd`, `pwd -L`, `pwd -P`, `true`, and `false` are automatic Bash fast paths outside Plan, and shell startup/function overrides disable that fast path. Chains, redirections, scripts, package commands, and Git commands are not automatically considered safe. Plan still blocks all Bash. A trusted shell/tool installation is assumed; this is not containment.

### Reusable grants

For this first bounded implementation, reusable Bash grants cover only **Git status queries** with a fixed option vocabulary: `--short`/`-s`, `--branch`/`-b`, `--porcelain[=v1|=v2]`, and `--untracked-files=no|normal|all`. Choose either the exact command or that narrow query family. Both are bound to the canonical working directory and a fingerprint of the resolved Git executable's metadata, relevant environment, Git configuration, and PieXis settings/permission configuration. A changed fingerprint requires fresh approval/review. A status query can update Git's optional index caches; it is not part of the automatic read-only builtin set.

Configuration is inspected locally with bounded reads and never sent to the classifier. Unknown Git configuration keys, includes, aliases, hooks/fsmonitor/pager settings, shell startup overrides, script wrappers named Git, and linked worktrees decline reusable grants. Only a small set of inert core/user/remote/branch Git configuration keys is supported. Reuse is currently unavailable on Windows. Ordinary one-time approval or Auto review remains available when reuse is declined. Scripts (`npm test`, `make`, Python, shell scripts, etc.) do **not** receive reusable narrow grants; arbitrary dependency changes cannot therefore silently reuse such a grant. Full script-dependency analysis is not implemented.

Use:
- `/permissions` or `/permissions list` — inspect grants, IDs, mode, and denial count.
- `/permissions revoke <id>` — revoke one grant.
- `/permissions clear` — remove all grants.

Revocation/clearing requires an idle agent. These commands never widen permissions or change modes. Grant IDs are session-local; there are no persisted allow rules.

### Denial limits

Denials include a reason and suggest a genuinely narrower action, clarification, or explicit authorization—not changing tools to perform the same denied effect. By default, **3 identical denials or 6 total denials per user request** stop the run via Pi's abort API. Successful intervening calls do not erase the budget. Configure limits at launch with `--permission-repeat-limit 3` and `--permission-denial-limit 6` (integers 1–50); repository configuration cannot silently raise them.

Once stopped, subsequent tool calls remain blocked except `AskQuestion` (and the deliberately launch-only Bypass mode). A newly delivered provenance-verified user request resets the budget; extension-injected messages and automatic retries do not. Pending sibling approvals cannot grant or execute after the stop. Already executing processes are subject to Pi's normal cancellation, not OS isolation.

Without permission UI, approval-required actions are immediately denied. At the threshold PieXis emits a `permission_blocked` diagnostic on **stderr**, records a count-only session stop entry, and aborts the run without waiting for input or forcing the whole host process to exit. Pi JSON/RPC consumers must inspect the blocked/aborted outcome; this extension does not promise a nonzero JSON-mode exit status.

## Background tasks

`/task <work>` (or `background_task`) starts a worker from `HEAD` in a disposable **Git worktree**, with at most two running workers. The permission extension must be active. Worktrees isolate Git changes, **not host filesystem, process, credential, or network access**. Foreground uncommitted changes and the full conversation are not copied; a dirty foreground checkout produces a warning.

### Delegation and approvals

- Status, cancellation, and diff inspection are recognized operations, including in Plan. Creation, application, and cleanup are denied in Plan/Don't Ask. Unknown custom tools remain unknown.
- Manual/Accept Edits require one-time approval for agent-requested task creation. A direct `/task <work>` command supplies explicit user authorization. Auto reviews creation against verified user intent; direct task commands receive their own in-memory user-request identifier.
- The proposed brief is untrusted action data. Optional `brief` fields include goal, context, constraints, files, acceptance criteria (`acceptanceCriteria`), decisions, and verification. Task plus brief is limited to 20,000 characters and is never silently truncated. Keep secrets out of descriptions: briefs go to the worker, may go to the classifier, and are stored in local task metadata.
- Optional `paths` narrows file-tool scope to relative files/directories (default `["."]`, maximum 32 entries). Traversal, external symlink targets, credentials/protected path-tool writes, uncertain recursive searches, and tools outside the worker capability set are denied. There are no recursive task-delegation tools.
- Every worker tool call goes through the parent broker and shared evaluator. Workers inherit no foreground session grants. Auto additionally reviews worker mutations against both the original user intent and the delegated brief. Manual approvals are one-time; missing UI, unavailable/expired brokers, and classifier failures deny rather than escalate.
- New user input, mode changes, grant revocation, branch navigation, session replacement, and shutdown invalidate outstanding task authorizations and cancel queued/running workers. Existing worktrees are retained. Worker denial limits inherit the parent's launch settings and stop that worker, not unrelated tasks.

### Opt-in command execution

Start Pi with `--background-bash` to expose worker Bash for tests/builds/debugging. This is **permission-controlled command execution**, not sandboxing. It uses the same parent approval/classifier pipeline. Bash requires whole-worktree scope; narrower `paths` cannot be combined with this flag. Known literal external/protected targets are rejected, but parsing/model review cannot constrain arbitrary script effects or descendants. Cancellation revokes future approvals and terminates the worker process; it does not promise that all spawned descendants have stopped.

Workers load only their explicit guard extension and worker-only tool wrappers, with built-ins disabled, so a missing guard cannot fall back to unguarded tools. Project trust-gated resources and automatic context-file discovery are disabled; needed repository instructions can be read through the broker. Task text is passed as literal prompt data, not CLI options or `@file` arguments. Pi's trusted user-level runtime and authentication are still used.

### Inspect, apply, and clean

Use `/task status`, `/task review <id>`, `/task diff <id>`, `/task cancel <id>`, `/task apply <id>`, `/task clean <id>`, and `/task interrupted` (or their corresponding tools where available).

`task_diff` snapshots actual tracked/untracked/deleted files using a **temporary index and object store**; it does not stage into the real index or write repository objects. Checkout and inspection use raw bytes rather than executing Git hooks or clean/smudge filters; this skips LFS hydration and normal checkout conversions. Submodules/special files and exhausted inspection budgets fail closed: 10,000 files, 4 MiB per file, 128 MiB total file bytes, and 8 MiB Git output. Active workers must stop before inspection. Diff display is bounded to 50,000 characters, and sensitive/configuration/symlink patch bodies are withheld rather than leaked through the inspection tool.

Apply always requires a user dialog showing the **actual changed paths**, sensitive/configuration warnings, and observed command results—even in Auto/Bypass. The patch digest and destination findings are checked again after confirmation, followed by Git apply validation. Worker prose cannot establish successful verification: observations come from post-execution tool records, not claimed test results or blocked tool-start events. Successful command completion is not proof of test coverage; verify again in the parent workspace after application. Repeatedly declined or headless agent-requested apply/cleanup actions use the foreground denial budget.

Cleanup confirms deletion and validates the PieXis ownership marker, temporary directory, Git worktree, and repository before removal. Completed unapplied changes are retained rather than discarded. Headless apply/cleanup is denied. Trusted Pi/Git executables are assumed. These checks are not protection against arbitrary host code or filesystem races.

Metadata lives at `<agent-dir>/piexis/tasks/<project-hash>.json`, not in the repository. Legacy `.pi/piexis-tasks.json` is imported if user-level state is absent; the source is retained. Interrupted worktrees can be reviewed/cleaned, but authorization, process handles, broker tokens, and user-intent snapshots are never restored from metadata. Fast tests use Git fixtures, mocked worker processes, and mocked reviewers. A separate [runtime suite](tests/runtime/README.md) checks actual Pi RPC/JSON flows, worker processes, and TUI permissions through a pseudo-terminal on Linux, using a deterministic local provider. Live-model accuracy, other platforms, and full visual/terminal compatibility remain unvalidated.

## Select package resources

PieXis uses Pi's native package resource filtering; it does not add its own plugin manager. Run `pi config` (or `pi config --local` for a trusted project) to enable or disable discovered resources. In settings, the package object can narrow resources declared by this package:

```json
{
  "packages": [
    {
      "source": "npm:@preapexis/piexis",
      "extensions": ["extensions/mode.ts", "extensions/ask-question.ts"],
      "skills": ["skills/code-review", "skills/diagnosing-bugs", "skills/safe-refactor"],
      "themes": []
    }
  ]
}
```

Omit a resource type to load all resources of that type; use `[]` to load none; and use Pi glob exclusions such as `"!skills/docx/**"` to omit document workflows. This lets users keep permission controls while disabling the custom UI/theme, or retain coding skills while excluding DOCX/PDF/PPTX/XLSX skills. See Pi's package configuration documentation for the complete filtering syntax.

## Development

```sh
npm run check
npm test
npm run test:runtime
npm run eval:permissions -- --validate
```

### Local runtime checks

`npm run test:runtime` launches the resolved peer dependency's packaged Pi CLI with all manifest extensions, disposable repositories and agent directories, and a deterministic loopback provider. It uses no real credentials or paid model calls. Tests cover permission dialogs, six-mode behavior, reviewer failures/timeouts, worker Bash opt-in, patch confirmation, stale approvals, cancellation, and shutdown. The Linux PTY check exercises the bundled UI and mode shortcuts; it requires `script` and `stty` and is explicitly skipped elsewhere. See [runtime validation results and limits](tests/runtime/README.md).

### Classifier evaluation

[`eval/permission-cases.json`](eval/permission-cases.json) contains 26 synthetic, labeled cases covering all policy categories, paired authorization changes, injection attempts, and worker scope. The offline runner validates the corpus, exports unlabeled requests using the production reviewer prompt, and scores externally collected model responses. It never executes fixture commands or automatically contacts a provider.

See [`eval/README.md`](eval/README.md) for the opt-in live-evaluation procedure, response format, coverage map, and remaining manual release checks. Raw false allows, host policy overrides, false denials, invalid responses, and missing cases are reported separately. Scorer unit tests are not evidence of live model accuracy; no live-model result is claimed.

There is currently no `tests/mode-sandbox.test.mjs`; consequently `npm run test:sandbox` cannot establish sandbox coverage. Unit tests do not establish containment or protection of host paths/network.
