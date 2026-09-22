# Agents Guide

## Project

Piexis (`@preapexis/piexis`) is a TypeScript Pi package providing permission-mode extensions, skills, prompts, and themes. It requires Node.js 24+ and a current Pi release; `README.md` names Pi 0.85.1 as tested.

## Layout

- `extensions/mode.ts`: permission approvals, mode commands/flags, session restoration, and mode-specific agent instructions.
- `extensions/ask-question.ts`: sequential, interactive `AskQuestion` tool; requires the TUI to collect answers.
- `extensions/ui.ts`: local Pi header, footer, and activity/status integration.
- `lib/mode-policy.ts`: mode names, tool allowlists, and Accept Edits bash-command classification.
- `lib/permission-classifier.ts`: Auto-mode model review, response validation, timeout, and cancellation.
- `lib/permission-config.ts`: project configuration initialization and classifier model selection.
- `skills/`: bundled skills with task-specific `SKILL.md` guidance; `prompts/init.md`: bundled `/init` prompt; `themes/orange.json`: bundled theme.
- `package.json`: Pi resource manifest and npm scripts; `tsconfig.json`: strict TypeScript configuration.

## Development

Commands supported by the manifest or README:

| Command | Purpose / caveat |
| --- | --- |
| `npm ci --ignore-scripts` | Install locked dependencies without lifecycle scripts. |
| `npm run check` | Type-check with `tsc --noEmit`. |
| `npm test` | Runs `node --test tests/*.test.mjs`; test files are currently absent. |
| `npm run test:sandbox` | Runs `PIEXIS_REQUIRE_SANDBOX=1 node --test tests/mode-sandbox.test.mjs`; target is currently absent, and the script uses POSIX environment-assignment syntax. |
| `pi -e ./extensions/mode.ts` | Preview the permission extension only, not the bundled prompts, skills, themes, or other extensions. |

There are no separate build, lint, or format scripts. No CI configuration is present in this checkout; do not infer CI coverage from the README.

## Current-checkout caveats

- Parts of `README.md` and `MODE.md` describe older or intended behavior. Check `extensions/` and `lib/` before relying on security or lifecycle claims.
- The sandbox workers, broker, guards, and test suites from the previous implementation are absent. Although `@anthropic-ai/sandbox-runtime` remains pinned in `package.json`, the current permission implementation does not invoke it. Do not claim OS containment, protected-path enforcement, or workspace-only writes.
- Plan currently blocks all tools except the read-tool allowlist and `AskQuestion`, including all bash calls and file edits. The README's writable `.pi/plans/*.md` exception and `delete_plan` tool are not implemented in the current source.
- The current default is Manual (`default`), not Auto. Old Build/YOLO mode names and user-level `readRoots`/`allowedDomains` configuration do not describe the current implementation.

## Conventions

- Use ESM and strict TypeScript with NodeNext module resolution and ES2022 targeting. Local imports use explicit `.ts` extensions.
- Match nearby source style: two-space indentation, double-quoted strings, and semicolons. Extensions export a default registration function receiving `ExtensionAPI`; shared permission logic belongs in `lib/`.
- Keep changes focused and preserve existing permission checks, approval/cancellation behavior, and headless handling.
- Add or update tests for behavior changes. Historical tests used `node:test`, `node:assert/strict`, and `.test.mjs` files; use disposable fixtures, not real credentials.
- Do not commit generated output, secrets, dependency directories, or local configuration. `.pi/` and `.kilo/` are ignored local state, not package resources.

## Security and workflow

- Permission-mode changes belong to the user. Do not bypass denied operations or change modes to evade restrictions.
- The six modes are `default`, `acceptEdits`, `plan`, `auto`, `dontAsk`, and `bypassPermissions`. `Alt+M` cycles the first four, omitting Auto when unavailable; `/plan` enters Plan. `dontAsk` and `bypassPermissions` are launch-only. Mode changes require an idle agent.
- Preserve Auto's fail-closed behavior on classifier failure or invalid responses. The classifier treats task/action contents as untrusted data and uses Pi's existing authentication; never persist credentials in project settings.
- Configuration lives under Pi's `CONFIG_DIR_NAME` (normally `.pi/`). Initialization creates missing `settings.json` and `permission-modes.json` without overwriting existing files. `PI_PERMISSION_CLASSIFIER=provider/model` overrides the configured classifier model.
- Session approvals are in-memory and scoped to a tool. Without permission UI, actions requiring approval are denied; `dontAsk` denies non-pre-approved actions. Bypass skips extension-level permission checks and is not isolation.
- Keep `AskQuestion` available in every permission mode.

## Validation

For implementation changes, run `npm run check` and relevant tests when their files are available. Report missing suites and unexecuted checks explicitly; an empty or skipped run does not establish coverage or security. Review the diff and confirm that no credentials or unrelated files are included.
