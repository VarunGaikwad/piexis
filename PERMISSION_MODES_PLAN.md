# Piexis Permission Modes Improvement Plan

## Recommended direction

**Make Piexis similar in permission workflow—not a replica of Claude Code’s security architecture.**

Focus on:
- Fewer interruptions during ordinary coding.
- Auto decisions grounded in what the user actually requested.
- Clear approval boundaries for consequential actions.
- Consistent behavior between foreground and background agents.
- Understandable denials and permission controls.

**Exclude containers, OS sandboxing, network proxies, and claims of filesystem/network containment.**

This plan records the original baseline and proposed work; the comparison and future-tense descriptions below are historical, not a current behavior reference. Phases 1–4 have been implemented. Phase 5 adds documentation alignment, mode-restoration regression coverage, and a labeled offline classifier evaluation harness. Controlled Linux runtime checks now cover real Pi RPC/JSON flows, worker lifecycle, and TUI permission interactions through a pseudo-terminal (`tests/runtime/README.md`). Live-model evaluation, full visual/terminal compatibility, and cross-platform validation remain open. See `README.md` and `eval/README.md` for current behavior and validation limits.

## Corrections to the comparison

The comparison table is useful as inspiration, but not an implementation specification:

- **Headless denial already exists:** approval-required calls are blocked without permission UI.
- **Deny-and-continue partly exists:** blocked tool calls already receive reasons. Missing pieces are retry limits and better guidance.
- **Sensitive-path checks exist**, but they inspect the requested path—not every file a recursive search or shell command might access.
- **Auto currently ignores all session approvals**, rather than carrying narrow ones forward.
- **Persistent allow/deny rules and trusted-environment configuration do not exist yet.**
- **Workers already exist**, with worktrees and an approval broker, but use a separate permission flow and have no Bash.
- Claude Code also has a `dontAsk` mode; that is not a Piexis-only advantage.
- Exact claims about Claude’s classifier stages and injection screening need current authoritative verification. We should not make those prerequisites.

## Phase 1 — Make the existing permission foundation consistent

**Do this before expanding Auto.**

### 1. Extract one permission evaluator

Move decision-making out of `extensions/mode.ts` into shared library code.

Inputs should include:
- Mode.
- Tool and validated arguments.
- Actual working directory and workspace boundary.
- User authorization context.
- Applicable approvals.
- Foreground or worker identity.

Return a structured result: **allow, deny, require approval, or require model review**, with a reason/category.

The extension should handle UI and lifecycle; the library should decide policy.

### 2. Fix path-policy limitations

In `lib/path-policy.ts`:

- Resolve relative paths against the **tool’s actual working directory**, then compare against the repository boundary. Currently those two concepts are conflated.
- Check both requested and resolved paths for sensitive locations.
- Distinguish reading credentials from modifying execution/security configuration.
- Cover recursive searches: approving `grep` on the repository root must not imply that every descendant is ordinary.
- Add categories for credentials, Git internals/hooks, and Pi permission/extension configuration.
- Avoid treating every example environment file as a real secret; support narrow, explicit exceptions.

If recursive filtering requires wrapping built-in tools, do that explicitly rather than claiming the path check already provides it.

### 3. Protect policy configuration

Ordinary edit permissions should not silently authorize changes to the configuration controlling those permissions.

Repository-provided trust settings must not automatically grant themselves additional authority. Widening permissions needs user confirmation.

**Deliverable:** one documented decision order and consistent path handling, with regression tests.

## Phase 2 — Make Auto genuinely useful for ordinary development

### 1. Pre-approve ordinary local edits

Auto should directly allow:
- Ordinary project-local reads/searches.
- Ordinary project-local `edit` and `write`.
- `AskQuestion`.

Exceptions remain for sensitive paths, policy/configuration changes, malformed requests, and external targets.

This is the highest-value usability improvement.

### 2. Add user-intent context to the classifier

Extend `lib/permission-classifier.ts` beyond tool/path/command.

Include:
- Current user request.
- Relevant earlier user constraints from the active branch.
- Explicit approvals and their scopes.
- Working directory/workspace.
- Proposed action and deterministic risk findings.

Exclude:
- Assistant explanations and reasoning.
- Raw tool-output history.
- Worker summaries presented as authorization.
- Unnecessary file contents and secrets.

**Important:** a message with a `user` role is not automatically proof of human authorization. Pi extensions can inject user messages. Preserve provenance where available and treat ambiguous origins conservatively.

Handle session resume, branching, compaction, and changed instructions without carrying stale authorization forward.

### 3. Introduce a small policy taxonomy

| Category | Proposed Auto behavior |
|---|---|
| Ordinary local development | Allow |
| External filesystem access | Review scope and intent |
| Destructive changes | Require specific authorization; deny ambiguity |
| Credential discovery/exposure | Deny automated exploration |
| Uploads/data egress | Review destination, payload, and intent |
| Production/shared-system changes | Require explicit target and authorization |
| Privilege/security changes | Deny unattended escalation |
| Safeguard bypasses | Require explicit authorization; never infer from “fix it” |
| Download-and-execute or opaque execution | Conservative review/denial |

Distinguish **using an existing authenticated CLI** from **reading/exporting its credentials**.

### 4. Keep one model reviewer initially

Use:

**Deterministic checks → model review only when needed.**

That already provides a fast path. Do not add a second model until evaluation shows a measurable benefit.

**Deliverable:** Auto feels substantially less intrusive while making better authorization judgments.

## Phase 3 — Improve Bash decisions and permission UX

### Bash analysis

Add a bounded shell analyzer that identifies:
- Command chains and pipelines.
- Redirections.
- Command substitutions.
- Working-directory changes.
- Environment assignments and wrappers.
- Interpreter/script execution.
- Destructive Git operations.
- Uploads, deployments, and safeguard-bypass flags.

Use parsing, not only regular expressions. Unsupported syntax should lead to review—not automatic approval.

**Do not equate `npm test`, `make`, or `python script.py` with safety.** Those execute project-controlled code. A command’s name is not its complete effect.

Initially, allow only a small, carefully tested set of simple read-only commands without review. Everything else retains approval/classification.

### Scoped approvals

Add:
- Exact command + working-directory grants.
- File/directory grants scoped to operation.
- Narrow command/subcommand rules.
- A user-facing `/permissions` command to inspect and revoke grants.

For Auto:
- Honor eligible narrow approvals after non-overridable checks.
- Ignore whole-Bash and blanket interpreter/executable grants.
- Do not reuse an execution approval blindly after the relevant script or policy changes.

Persistent rules can follow later; start with session rules to limit complexity.

### Denial behavior

Provide concise reasons and a legitimate next step:
- Use a narrower action.
- Request clarification.
- Wait for explicit authorization.

Do not suggest switching tools to achieve the same denied effect.

Add configurable repeated-denial limits. Stop the agent’s run when it is stuck; do not automatically switch modes or broaden permissions. Headless runs should report a clear blocked outcome without waiting for dialogs.

**Deliverable:** fewer confusing prompts and no endless denial loops.

## Phase 4 — Bring background tasks into the same permission system

Update `extensions/background-tasks.ts` and `extensions/background-worker.ts`.

### 1. Recognize task tools individually

Auto should understand:
- Status and cancellation.
- Diff inspection.
- Task creation.
- Applying changes.
- Destructive cleanup.

Do not allow every custom tool simply because it exists.

Note that `task_diff` currently runs `git add -N` for untracked files: it needs adjustment before being treated as genuinely read-only.

### 2. Give workers bounded delegated authority

Worker authorization should be the intersection of:
- The user’s authorized task.
- Parent permission policy.
- The worker’s delegated scope.

An assistant-written task brief must not expand user authorization.

Use the existing parent broker to evaluate worker actions through the shared policy. Handle mode changes, cancellation, session replacement, and broker failure explicitly.

### 3. Add worker Bash only as an opt-in

Workers can then test/build/debug through the same approval/classifier pipeline.

But call this **permission-controlled command execution**, not sandboxed execution. Worktrees isolate Git changes, not host access.

Keep:
- No recursive delegation initially.
- Explicit approval before applying patches.
- Validated, confirmed cleanup.

### 4. Review returned changes, not just worker prose

Treat worker output as untrusted task data. Inspect the actual patch for sensitive/configuration changes before applying it. Record what verification actually ran.

**Deliverable:** useful workers without building a new orchestration or sandbox platform.

## Phase 5 — Polish, documentation, and evaluation

Preserve the six modes:

| Mode | Target behavior |
|---|---|
| Manual | Safe operations directly; approval otherwise |
| Accept Edits | Also allow ordinary local edits |
| Plan | Read-only exploration; no implicit transition to execution |
| Auto | Local coding directly; consequential actions reviewed against intent |
| Don’t Ask | Only pre-approved actions; no permission dialogs |
| Bypass | Skip Piexis permission checks, with clear warnings |

Keep mode changes user-controlled and idle-only.

Add tests covering:
- Nested working directories, symlinks, and recursive searches.
- Local edits versus sensitive/configuration edits.
- Shell chains, wrappers, scripts, and uploads.
- Intent changes, branching, and injected messages.
- Classifier timeout, cancellation, malformed responses, and unavailable models.
- Approval revocation and unsafe broad grants.
- Worker/foreground consistency.
- Headless denial limits.

Run `npm run check` and relevant tests during implementation. Build a labeled classifier evaluation set as well: mocked unit tests alone cannot measure model decision quality.

## Deliberately deferred

- OS/container/network sandboxing.
- Network allowlisting presented as enforcement.
- Full shell/program semantic analysis.
- Two-model classification.
- A generic prompt-injection detector marketed as protection.
- Automatic acceptance of worker changes.
- Broad domain/org trust configuration before concrete use cases exist.

For injection resistance, prioritize provenance and keeping tool/worker text out of authorization decisions. Optional screening can come later.

## Recommended first release

**Ship Phases 1–3 first.** They provide the biggest Claude-like improvement without ballooning the project. Integrate workers afterward.

## Three decisions before implementation

These recommendations are pending user confirmation.

1. **Auto escalation:** should uncertain/high-impact actions remain denied, or may Auto ask for explicit one-time approval?  
   **Recommendation:** deny the action first; allow a clear user-controlled approval path in interactive sessions.

2. **Classifier privacy:** are you comfortable sending relevant user requests to the configured classifier provider?  
   **Recommendation:** yes, with bounded context, clear disclosure, and no raw tool history.

3. **Worker Bash:** should workers eventually run tests/builds without containment?  
   **Recommendation:** opt-in only, after the shared permission pipeline is implemented.
