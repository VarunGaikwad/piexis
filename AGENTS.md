# Agents Guide

## Project and layout

Piexis (`@preapexis/piexis`) is a TypeScript Pi package providing interactive questions, UI extensions, skills, prompts, and themes. Node.js 22.19+ and a current Pi release are required.

- `extensions/ask-question.ts`: sequential interactive `AskQuestion` tool; requires the TUI.
- `extensions/agents.ts`: five agent profiles and subprocess subagents; only orchestrator parents can run two non-conflicting jobs concurrently. `lib/agents.ts` owns configuration/routing, `lib/subagent-scheduler.ts` owns scope validation/scheduling, and `lib/subagent-runner.ts` owns protocol/cancellation. User/project `agent.json` files configure models and effort, with legacy `agents.json` fallback. Accepted project setup creates a missing `.pi/agent.json` scaffold without overwriting existing configuration.
- `extensions/ui.ts`: project header, activity footer, Git branch, model, and context usage.
- `extensions/recommended-tools.ts`: automatic opt-in project setup for Pi's native `grep`, `find`, and `ls` tools.
- `skills/`: task-specific `SKILL.md` guidance.
- `prompts/`: bundled `/init`, `/commit`, and `/summary` prompts.
- `themes/orange.json`: bundled theme.
- `package.json`: resource manifest and npm scripts; `tsconfig.json`: strict TypeScript configuration.

## Development

| Command | Purpose |
| --- | --- |
| `npm ci --ignore-scripts` | Install locked dependencies without lifecycle scripts. |
| `npm run check` | Type-check with `tsc --noEmit`. |
| `npm test` | Run `node --test tests/*.test.mjs`. |
| `pi -e ./extensions/ask-question.ts` | Preview only the question extension. |

There are no separate build, lint, or format scripts, and no CI configuration in this checkout.

## Conventions and safety

- Use ESM and strict TypeScript with NodeNext module resolution and ES2022 targeting. Local imports use explicit `.ts` extensions.
- Match nearby source style: two-space indentation, double-quoted strings, and semicolons. Extensions export a default registration function receiving `ExtensionAPI`.
- Preserve interactive cancellation and non-TUI handling. Add or update `node:test`/`node:assert/strict` tests for behavior changes, using disposable fixtures rather than credentials.
- Preserve unrelated working-tree changes and intentional deletions. Do not commit generated output, secrets, dependency directories, or local configuration. `.pi/` and `.kilo/` are ignored local state, not package resources.
- Permission modes, approval/classifier logic, plan execution handoffs, and background workers have been removed. Piexis does not enforce tool-access restrictions or provide sandboxing; respect host restrictions and other installed extensions.
- Do not delete existing user settings, session records, or retained task worktrees as part of routine package changes.

## Validation

Run `npm run check` and relevant tests for implementation changes. Report unexecuted checks explicitly; skipped or empty runs do not establish coverage. Review the diff for credentials and unrelated changes before finishing.
