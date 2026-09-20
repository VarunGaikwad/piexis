# Four permission modes

Status: implementation delivered; successful OS containment verification remains pending on a supported host.

Implementation notes:
- The four modes, commands, active-branch persistence, guarded plan handoff, native YOLO execution, and fail-closed sandbox execution are implemented.
- All managed non-YOLO file tools also run inside the sandbox, using a private broker/worker, rather than relying on host-side path preflight alone.
- The host-launcher implementation and its dependencies are protected against self-modification outside YOLO.
- Third-party execution adapters do not ship in this version; custom tools and subagent tools are denied outside YOLO.
- Typechecking, policy/lifecycle/search/worker tests, and a real Pi RPC smoke test run locally. The strict sandbox suite fails on missing prerequisites; a temporary Bubblewrap probe also encountered a host mount-permission refusal. CI is configured to require the real containment suite on Linux/macOS, but those CI results are not available here.

## Goal

Replace the older Ask/Architect/Debug/Code/Orchestrator permission model with four permission modes. These control authorization and execution, not the model, thinking level, or a role/personality prompt.

| Pi label | Internal ID | Claude Code equivalent | Required behavior |
| --- | --- | --- | --- |
| Default | `default` | `default` (Manual) | Confirm every agent `bash`, `edit`, and `write` call, including read-only bash commands. Reads/searches need no approval. |
| Plan Mode | `plan` | `plan` | Read-only execution; mutations fail except designated plan Markdown files. Ask the user to switch to Build before applying a plan. |
| Build | `build` | `acceptEdits` | In-project reads, writes, and bash run without approval dialogs. Bash remains sandboxed; sandbox denials are not approval requests. |
| YOLO | `yolo` | `bypassPermissions` | No extension permission dialogs, sandbox, command filtering, or protected-path backstop. |

These are the requested behavioral equivalents, not a claim to reproduce every Claude Code permission rule.

## Planning baseline

- `lib/mode-policy.ts` defines the five old modes and a capability matrix.
- `lib/mode-guard.ts` already provides queued per-call confirmation, cancellation, revision checks, canonical-path validation, and trusted-adapter handling worth preserving.
- `lib/mode-shell.ts` classifies shell text and rewrites Git commands. This is not an OS sandbox; approved scripts can perform effects the classifier cannot see.
- `lib/mode-grep.ts` applies unconditional secret exclusions. YOLO must not retain that hidden restriction.
- `extensions/` is empty. The new `extensions/mode.ts` must be created, not merely updated.
- Baseline `npm test`: 17 tests pass; `tests/mode.test.mjs` fails to load because `extensions/mode.ts` is missing.
- This machine is Linux with `rg`, but neither `bwrap` nor `socat` was found on PATH.

## Proposed defaults to confirm

The request leaves these details open. Use these defaults unless changed before implementation:

1. **Default also uses Build's sandbox.** Approval authorizes one operation within the profile; it does not disable sandbox restrictions.
2. **Plan documents live in `<project>/.pi/plans/*.md`.** Use Pi's exported `CONFIG_DIR_NAME` rather than hardcoding `.pi`. The exception does not cover arbitrary Markdown elsewhere, nested executable content, or the rest of `.pi`.
3. **Outside-project mutations are denied in every non-YOLO mode.** Additional read roots for documentation/toolchains can be explicitly configured. Prompt-free reads still obey deny-read rules; they never become secret-access confirmation dialogs.
4. **Manual `!`/`!!` commands use the current sandbox profile too.** Typing the command is already user authorization, so Default does not ask a second approval for manual commands. Plan still cannot mutate host files through manual bash.
5. **Plan shell networking is disabled.** Read-only filesystems alone cannot stop remote mutations such as HTTP POST or Git push. Trusted read-only web tools can be considered separately. Default/Build use an explicit network allowlist, not unrestricted networking.
6. **Protected paths remain hard denials outside YOLO.** Approval does not bypass them. Define read protection separately from write protection; do not transplant the existing blanket `.git` secret classification into the OS profile and accidentally disable ordinary Git use.

## Enforcement design

### One authorization-and-execution module

Put the main seam at managed tool execution, not merely at `tool_call`. Callers should ask the module to execute an operation under the current mode; they should not coordinate path checks, approvals, and sandbox selection themselves.

Its implementation owns:

- The current mode, canonical project root, and session/policy revision.
- Path normalization, protected-path rules, and plan-file exceptions.
- Serialized, one-call approval dialogs and cancellation.
- Final validation immediately before execution.
- Selection of native versus sandboxed operations.
- Trusted adapters for additional tools and inherited child execution.

Retain `tool_call` for early denials and unmanaged-tool enforcement. Managed tool wrappers must enforce at execution too: later handlers can mutate arguments, and parallel siblings can change filesystem state after preflight. Avoid double prompting.

Execution order:

1. Capture the mode, revision, current cwd, and actual arguments.
2. In YOLO, delegate directly to native operations without path classification, policy adapters, protected search filtering, or sandbox initialization. Keep ordinary tool validation, errors, timeout, and cancellation behavior.
3. Otherwise classify the managed operation and resolve its targets.
4. Reject forbidden targets/actions or an unavailable required sandbox before requesting approval.
5. In Default, obtain explicit approval for each eligible bash/edit/write call. Never cache approval or infer it from conversation text. Known additional mutation tools follow the same approval rule.
6. Revalidate arguments, paths, mode, revision, and cancellation before execution. Execute through the selected operations adapter.

Unknown/custom tools are denied outside YOLO unless a trusted adapter defines and enforces their effects. Tool names such as `read_file` are not proof that an arbitrary extension tool is read-only. Subagents must inherit actual execution restrictions, not just prompt instructions.

### Sandbox profiles

Use `@anthropic-ai/sandbox-runtime` as the first candidate, following Pi's sandbox operations example, but verify its guarantees before adopting it. In particular, do not copy the example's unsandboxed fallback after initialization failure.

| Profile | Host filesystem writes | Network | Approval |
| --- | --- | --- | --- |
| Default | Canonical project scope minus protected targets | Configured allowlist | Every agent bash/edit/write |
| Plan | None through bash; narrow plan-file operations described below | Disabled for bash | None for permitted operations |
| Build | Canonical project scope minus protected targets | Configured allowlist | None |
| YOLO | Native OS access | Native OS access | None |

- First prove Linux and macOS support, including subprocesses, shell startup configuration, filesystem restrictions, and network restrictions.
- If the runtime cannot enforce a required profile, reject affected operations. Do not silently weaken the profile or fall back to local execution.
- Do not make shared host `/tmp` broadly writable. Any necessary scratch space must be private, disposable, and unable to mutate unrelated host files.
- Protect credentials and mode/sandbox configuration from mutation. Review Git hooks/config separately from ordinary index/object/ref writes so Build's Git behavior is deliberate.
- Snapshot the profile for each execution. Do not mutate shared sandbox-manager configuration while commands are running.
- Preserve Pi's streaming, output truncation, current cwd, permitted environment/session metadata, timeouts, and process-tree cancellation through documented tool operations.
- Initialize session-scoped resources lazily or at `session_start`; clean them up on `session_shutdown`, including reload and session replacement.
- Configuration must not let a project file turn Plan or Build into unsandboxed execution. Only YOLO selects the native execution profile.

### Plan Markdown exception

Keep bash fully read-only instead of granting write access to the entire plans directory and hoping commands only create `.md` files.

- Guarded file operations may create, edit, or delete direct-child `.md` plan documents in the designated plans directory.
- `write` and `edit` remain available so the model can maintain a plan; reject their non-plan targets with an actionable error.
- Pi has no built-in delete tool. If plan deletion is required, expose a narrow plan-delete tool or trusted adapter using the same guarded file operations. Bash `rm` remains read-only in Plan.
- The extension may provision the plans directory itself; that does not authorize general agent directory creation.
- Validate the canonical directory and target, including existing ancestors for new files. Reject symlink escapes, dangling links, unsafe hardlinks, traversal, and non-regular-file targets.
- Reuse Pi's per-file mutation queue for read-modify-write operations. A preflight `realpath()` check alone is not sufficient protection against a target changing before the actual write; prove safe mutation semantics at the execution seam.
- Keep trusted harness bookkeeping, such as session persistence, distinct from agent-authorized file mutations.

### Scope of the guarantee

This extension governs managed agent tools and manual bash routed through it. Pi extensions themselves execute with host privileges; it cannot contain malicious extension initialization, arbitrary trusted extension hooks, or an external terminal. Detect conflicting tool overrides rather than assume a tool name guarantees enforcement.

YOLO removes this extension's restrictions. It does not override OS permissions, Pi project trust, or independently installed extensions' policies.

## File-level changes

| File | Planned change |
| --- | --- |
| `extensions/mode.ts` | Create thin Pi integration: commands, flag, status, lifecycle, prompt guidance, and managed tool registration. |
| `lib/mode-policy.ts` | Replace five-mode positional capability columns with explicit four-mode policy definitions. Keep useful path normalization; separate read/write protections and plan exceptions. |
| `lib/mode-guard.ts` | Evolve the existing guard into the shared authorization-and-execution module. Preserve queued confirmations, cancellation, and revision invalidation. |
| `lib/mode-sandbox.ts` | Add sandbox lifecycle/profile construction and execution operations. Native and sandboxed execution are the two real adapters at this seam. |
| `lib/mode-shell.ts` | Retire command classification/Git rewriting as permission enforcement. Remove unused implementation rather than maintaining two competing policies. |
| `lib/mode-grep.ts` | Apply configured read protections outside YOLO; use ordinary native grep behavior in YOLO. No unconditional secret-exclusion backstop. |
| `package.json`, `package-lock.json` | Add and lock the verified sandbox runtime as a runtime dependency. Document required OS programs. |
| `tests/mode*.test.mjs` | Replace obsolete five-mode expectations with the four-mode contract; retain relevant path, cancellation, adapter, and lifecycle regressions. |
| `tests/mode-sandbox.test.mjs` | Add real-process sandbox acceptance tests, not only mocked permission decisions. |
| `README.md` | Add commands, behavior matrix, prerequisites, trust scope, plan-file exception, and failure behavior. |

## Commands and lifecycle

- `/mode` opens a picker or reports usage when no UI exists.
- `/mode default|plan|build|yolo` selects a mode explicitly.
- Add `--permission-mode <value>` for noninteractive startup. Do not use `--mode`, which Pi reserves for its own execution modes.
- New sessions start in Default unless explicitly overridden.
- Show both mode and sandbox status; YOLO gets a conspicuous nonblocking warning, not a permission dialog.
- Append concise guidance through `before_agent_start`, preserving the existing system prompt and thinking/model choices.
- Reject mode changes while operations are in flight. Invalidate pending approvals and child policies when the session or policy revision changes.
- Persist versioned state using `appendEntry`; restore from `getBranch()` so reload, resume, fork, and tree navigation use the active branch rather than unrelated history.
- Unknown/legacy five-mode state falls back to Default with a notice; do not silently map `code` into Build or YOLO.
- If a saved YOLO mode is restored, display the same prominent warning. A new session does not inherit it implicitly.
- Headless Default denies operations requiring approval. Build and Plan work headlessly when their profiles are available; explicitly selected YOLO requires no UI.

### Plan-to-Build handoff

- Plan guidance instructs the model to present the plan and ask the user to switch to Build before applying it.
- Every blocked mutation explains: `Plan Mode is read-only. Switch with /mode build to apply changes.`
- A plan-completion UI may offer `Stay in Plan` and `Switch to Build`; only a direct user choice changes mode.
- Do not infer permission from assistant text, automatically elevate after writing a plan, or automatically replay a blocked operation.
- If an explicit `Switch to Build and apply` action is added, name that action clearly and schedule execution only after the mode change and sandbox initialization succeed.
- No todo-extraction or progress-tracking subsystem is needed for the first version.

## Delivery sequence

1. **Prove the sandbox:** dependency/platform checks and a small real-process test fixture for read-only and project-write profiles. Stop if the guarantees cannot be met.
2. **Define policy and path rules:** implement the four-mode matrix, plan-file scope, protected targets, and independent expected-policy tests.
3. **Implement managed execution:** approvals, native/sandboxed adapters, file mutation protection, and custom-tool/child restrictions.
4. **Add Pi integration:** restore the missing entry point, commands, startup flag, mode guidance, status, and branch-aware persistence.
5. **Remove old restrictions:** delete obsolete five-mode/shell-classifier behavior and verify YOLO bypasses all extension-specific backstops.
6. **Run acceptance tests and document:** real Linux/macOS sandbox CI plus TUI, RPC, and headless smoke tests.

## Acceptance tests

### Default

- `bash: pwd`, `bash: git status`, `edit`, and `write` each request approval.
- Two identical calls require two approvals; reads/searches request none.
- Denial, cancellation, UI failure, and missing UI never execute the operation.
- Approval does not grant outside-project or protected-path writes.

### Plan

- Ordinary reads/searches and read-only bash work without dialogs.
- Redirects, heredocs, Python/Node scripts, subprocesses, deletes, and build scripts cannot modify project or outside-project files.
- Plan `.md` creation, editing, and guarded deletion work; `README.md` elsewhere and non-Markdown files in the plans directory do not.
- Symlinks/hardlinks cannot turn a permitted plan document into another mutation target.
- Shell networking cannot mutate remote systems.
- Blocked application requests a user switch to Build and never changes modes itself.

### Build

- In-project edits, writes, tests/builds, and bash run without permission dialogs, including operations formerly classified as opaque or destructive.
- Tests/builds may generate normal in-project artifacts.
- Outside-project mutations and protected-path access remain blocked by the relevant profile.
- Sandbox startup failure or unsupported platforms do not execute a fallback command.

### YOLO

- Fixtures outside the project and fixtures matching protected filenames can be read/written without permission dialogs.
- Bash uses native execution without classifier rewrites or sandbox calls, even if sandbox prerequisites are missing.
- Grep does not retain extension-specific secret exclusions.
- Unknown tools are not blocked by the mode guard.
- Normal cancellation, timeout, and tool errors still function.

### Cross-cutting

- Cover `..`, absolute paths, file URIs, `@` prefixes, new-file ancestors, symlink retargeting, and parallel calls.
- Verify mode/session changes invalidate pending approvals and inherited child policies.
- Verify manual `!` and `!!` use the selected profile.
- Verify reload, resume, fork, tree navigation, legacy state, and headless selection.
- Use disposable fixtures only; tests must never touch real credentials or unrelated user files.
- Require real sandbox tests in supported-platform CI. A locally skipped test due to missing prerequisites is not evidence that containment works.
