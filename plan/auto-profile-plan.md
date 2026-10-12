# Automatic profile switching

## Goal

When enabled, Piexis automatically selects the right profile for each new user request: `plan`, `debug`, `ask`, `orchestrator`, or `code`. It does not ask for confirmation. The UI shows the active profile before the request runs.

Unlike the original plan-only proposal, automatic selection is not sticky: the next clear request can select a different profile. Unclear requests keep the current profile.

## Requirements and assumptions

### Requested behavior

- Support all five existing profiles, not only `plan`.
- Switch automatically based on the user's request, without a profile-selection dialog.
- Keep the current profile visible in the UI after switching.
- Support “Execute” for coding.

### Proposed decisions

- Keep the original opt-in setting: `auto_profile: true` in user or trusted-project `agent.json`; absent means `false`.
- Preserve explicit manual choices. `/profile`, Alt+A, and a valid `--agent` selection pin the profile on the current session branch.
- Add `/profile auto` to release that pin when `auto_profile` is enabled. It keeps the current profile until the next clear request and does not edit configuration.
- Use conservative, deterministic intent rules, not a classifier, extra model call, or external service. “Smart” means recognizing clear instructions and common wording while avoiding misleading mentions; it does not mean understanding arbitrary natural language.
- **Assumption:** “keyboard Execute” means the **keyword** “Execute”, not a new keyboard shortcut. A new shortcut is out of scope until its key and behavior are specified.
- UI acceptance targets Pi's existing TUI footer. Supported non-TUI clients receive notifications/status through Pi's existing interfaces; adding a browser-specific profile badge is not part of this change.

## User-visible behavior

### Routing examples

Recognize requests case-insensitively, with leading whitespace, optional polite prefixes such as “please”, normal whitespace variations, and straight/curly apostrophes.

| Profile | Clear request examples |
| --- | --- |
| `plan` | “Let's plan this”, “Make a plan for login”, “Help me plan a migration”, “Plan this change” |
| `debug` | “Debug this error”, “Help me debug this crash”, “Investigate this failure”, “Fix this bug” |
| `ask` | “Explain this function”, “Answer this question”, “What does this code do?”, “How does authentication work?” |
| `orchestrator` | “Orchestrate this work”, “Coordinate these tasks”, “Delegate these tasks to subagents” |
| `code` | “Implement this feature”, “Build the login form”, “Write this function”, “Execute this plan”, “Execute” |

`ask` is the existing question/explanation profile. Do not introduce a sixth `question` profile or confuse it with the interactive `AskQuestion` tool.

### Intent and ambiguity rules

1. Inspect the user's own leading instruction or question, not arbitrary keywords anywhere in the message.
2. Honor the outer requested action: “Explain how to implement login” is `ask`; “Make a plan to debug this” is `plan`; “Coordinate implementation and debugging tasks” is `orchestrator`.
3. Negated, quoted, code-block, slash-command, and explanatory mentions must not trigger switching. Examples: “Don't execute this”, “The README says 'debug this'”, “What does 'Execute' mean?” (an `ask` question, not a coding instruction).
4. If independent requested actions conflict and there is no clear outer action, keep the current profile. Example: “Explain this and implement a fix”. Do not resolve ambiguity with an arbitrary profile priority or a user prompt.
5. Unknown wording, attachments without a clear text request, and short continuations such as “yes”, “continue”, or “looks good” keep the current profile.
6. “Execute” is an explicit `code` intent, including a standalone message. It uses the existing conversation as context; it does not launch shell commands directly, create a special plan handoff, or guarantee that a complete plan exists.

### Switching and visibility

- Re-evaluate every eligible new request, even after an earlier automatic switch.
- A sequence such as “Make a plan” → “Execute this plan” → “Debug this error” → “Explain the fix” runs as `plan` → `code` → `debug` → `ask`.
- Apply the selected profile's configured model and effort before processing that request.
- Keep the active profile visible, for example `agent:debug`, with an `auto` or `manual` mode indicator where space permits.
- Notify only on an actual automatic profile change, for example `Agent: debug (automatic)`; no confirmation dialog.
- Matching the already-active profile does not create duplicate state entries or notifications.
- Manual selections prevent automatic switching until `/profile auto` releases the pin. Show this manual mode so the user understands why routing is paused.
- Disabled configuration preserves existing profile commands, shortcuts, model-selection behavior, and UI presentation.

## Repository facts to reuse

- `lib/agent-config.ts` owns profile names, config types, scaffold defaults, inherited values, and configuration capability descriptions.
- `lib/agents.ts` owns strict config parsing/merging and existing routing helpers.
- `extensions/agents.ts` already has profile activation, model/effort application, branch restoration, manual controls, and a `piexis-agent` status.
- `extensions/ui.ts` already reads that status into the footer. Extend this path rather than adding a second widget or footer.
- Pi awaits the `input` event before skill/template expansion, idle model validation, and `before_agent_start`. Its input contract provides `source`, `streamingBehavior`, text, and images; `{ action: "handled" }` can stop a submission.
- `session_start` covers startup, reload, new sessions, resume, and fork; `session_tree` covers branch navigation.
- `tests/agents.test.mjs` has configuration fixtures, extension harnesses, branch/shortcut/model tests, and offline real-Pi integration. `tests/ui.test.mjs` covers footer layout and redraw behavior.

## Implementation plan

### 1. Add the opt-in configuration

Files: `lib/agent-config.ts`, `lib/agents.ts`, `schemas/agent.schema.json`.

- Add optional boolean `auto_profile` to `AgentConfig`, the parser's allowed keys, and the JSON schema.
- Reject non-boolean values.
- Add `false` to scaffold defaults and a capability description for automatic profile selection.
- Preserve inherited user values and explicit project values, including `false`. Trusted-project values override user values; untrusted project files remain ignored.
- Include the setting in new scaffolds and `/setup-agents` completion without replacing configured values or writing user configuration.

### 2. Add a pure intent helper

File: `lib/agents.ts`.

- Add a helper such as `detectProfileIntent(text): AgentName | undefined`.
- Keep normalization and intent rules together in one small, testable implementation.
- Recognize the examples and disambiguation rules above. Use word boundaries so substrings and identifiers do not count as directives.
- Return `undefined` for unknown or conflicting intent. Do not default unmatched messages to `code`.
- Do not inspect attachment contents, invoke tools, or make model calls during detection.

### 3. Make activation outcomes explicit

File: `extensions/agents.ts`.

- Reuse the existing activation path for automatic and manual switches; return a success/failure outcome rather than only swallowing errors into notifications.
- Allow the caller to record activation origin (`manual` or `automatic`) and choose the notification text.
- Preserve existing model rules: profile model override, then top-level `model`, otherwise current model. Missing effort keeps the current effort; Pi's normal capability clamping remains authoritative.
- Do not use `small_model` or `subagent_model` for main-session routing.
- Commit profile, state entry, pin, and UI updates only after successful activation. A cancelled picker, invalid profile, busy rejection, or failed switch must not create a pin.
- Ensure a failure does not leave partially changed model/effort/profile state; prevalidate where possible and restore previous runtime settings if a later step fails. Always release the switching guard.

### 4. Route eligible input before the request starts

File: `extensions/agents.ts`.

For each `input` event:

1. Require a main session (`depth === 0`), user-originated interactive/RPC input, idle runtime, no active child jobs, and no switch already in progress.
2. Skip extension-originated messages, steering/follow-up delivery, delegated sessions, slash commands, and other busy input. Leave queueing behavior unchanged; do not defer a switch until a queued message runs.
3. Load effective configuration using the existing trust rules; require `auto_profile === true` and an unpinned branch.
4. Detect intent. If unmatched or already active, continue without mutation.
5. Await automatic activation for a different matched profile, then continue with the exact original text and images.
6. If required activation fails, warn and return `{ action: "handled" }`. Do not silently process the request under the old profile. Tell the user the request was not submitted and should be retried after correcting the configuration/model issue.

Handle configuration errors explicitly rather than relying on Pi to abort thrown event handlers; Pi can report handler errors and continue. Do not guess a routing result from invalid configuration.

Do not call command-only `waitForIdle()` from the input handler or resubmit input through `sendUserMessage()`.

### 5. Persist branch-local state and manual precedence

File: `extensions/agents.ts`.

- Extend `piexis-agent` entries to capture the profile, activation origin, and manual-pin state.
- Keep activation origin distinct from the pin: `/profile auto` changes routing mode without changing the active profile or inventing a new activation.
- Restore from the active branch, not every entry in the session file. Treat legacy entries containing only `agent` as manual selections.
- Persist successful manual selections, including selecting the already-active profile, as a pin.
- Apply a valid startup `--agent` choice as a manual pin in main sessions and persist it so reload/resume preserves the choice. Do not reapply the process's startup flag to unrelated new sessions or branches.
- Invalid CLI choices warn but do not pin. Delegated children keep their explicitly supplied profile and never auto-route.
- Add `/profile auto`: when enabled and idle, release the pin, persist it, refresh status, and notify without applying another profile's model. When disabled, explain how to enable `auto_profile` and leave state unchanged.
- Restore profile/pin on startup, reload, resume, fork, and tree navigation. Fresh sessions without explicit selection start at `code`, unpinned.
- Retain existing resumed-session/CLI model precedence; restoration itself must not silently reapply current config over a restored model.

### 6. Keep the active profile visible

Files: `extensions/agents.ts`, `extensions/ui.ts`.

- Keep `piexis-agent` as the authoritative active-profile status; publish routing mode separately if that avoids complicating the existing footer contract.
- Update status only after a successful switch or routing-mode change, and immediately after branch/session restoration.
- On wider terminals, show automatic/manual mode beside the profile. On narrow terminals, drop optional mode/shortcut/branch information before the profile name.
- Preserve the full active profile at supported 40-column layouts, including `orchestrator`, without overflowing either footer row. At smaller widths, truncate safely rather than hiding the profile in favor of optional fields.
- Verify a profile-only change redraws the footer even if model and effort remain unchanged; use Pi's status rendering mechanism or a small extension event if needed, not polling.
- Keep notifications available through supported non-TUI interfaces and guard terminal-only components as today.

### 7. Document the behavior

File: `README.md`.

- Document `auto_profile`, default `false`, configuration inheritance, and examples for all five profiles.
- Explain per-request switching, unmatched-intent fallback, “Execute”, manual pins, and `/profile auto`.
- Show the UI indicator and explain failed-submission behavior.
- State the deliberate limits: conservative English intent rules, no classifier, no mid-run switching, no new keyboard shortcut, no automatic pipeline, and no sandbox/tool-access changes.

## Acceptance checks and tests

### Configuration

- Parser accepts `true`/`false` and rejects strings, numbers, arrays, and null.
- Schema, scaffold, inherited defaults, completion, and capability-tip tests include the new setting.
- Explicit project `false` overrides user `true`; untrusted projects cannot override user settings.
- Setup preserves existing files/values and never writes user configuration.

### Intent detection

- Table-driven tests cover every profile, “Execute” alone, polite prefixes, case, whitespace, punctuation, apostrophes, and word boundaries.
- Cover outer-action examples, mixed-intent ambiguity, negation, quotation, code, slash commands, explanatory mentions, empty input, and continuations.
- A bare mention of another profile or coding keyword never overrides a clear question/planning instruction.

### Input, activation, and state

- Enabled, unpinned sessions automatically switch before the first request's profile instructions/model/effort are used.
- A multi-message sequence switches through all five profiles without prompting.
- Disabled, pinned, unmatched, already-active, busy, delegated, extension-originated, and queued input does not auto-switch.
- Text and images remain unchanged; no duplicate requests or state entries.
- Model/config/activation failures explicitly prevent submission; previous state remains coherent and the next valid switch still works.
- Manual same-profile selection pins; cancelled/failed selection does not. `/profile auto` releases the pin without changing profile/model.
- Legacy entries, valid/invalid CLI flags, reload/resume, fork, tree navigation, and fresh-session reset restore the correct profile and pin.
- Main tool loadouts and existing subagent routing remain unchanged.

### UI and real runtime

- Footer shows the new profile immediately after automatic switching and branch restoration, including when model/effort do not change.
- Wider layouts expose auto/manual mode; 40-column layouts preserve the active profile; ANSI/Unicode and resize tests remain within width bounds.
- Extend or add a disposable offline provider fixture to report the profile, model, and effective effort observed by the real Pi request.
- Real-Pi integration proves each profile is selected before its first model call, including “Execute” → `code`, without network or real credentials.
- Include an offline multi-request session proving later intent can change an automatically selected profile, and a failure case proving no model call occurs after failed activation.
- Test non-TUI input without installing terminal components. Skipped platform-specific tests must be reported, not treated as coverage.

## Validation and completion

During implementation, run focused checks first:

```sh
node --test tests/agents.test.mjs tests/ui.test.mjs tests/recommended-tools.test.mjs
npm run check
npm test
```

Update any additional setup/resource fixtures affected by the new scaffold field. Review the diff for unrelated changes, local configuration, and credentials.

Completion means automatic routing, visible profile status, manual precedence/release, “Execute”, branch restoration, and activation-failure handling all have passing evidence. Stop there; do not add classifiers, background workers, permission modes, special plan-execution handoffs, or new profiles.

This document is an implementation plan only; creating it does not implement or validate the feature.
