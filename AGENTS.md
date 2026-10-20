# Agents Guide

## Agent workflow

Read the matching `SKILL.md` before following a skill; the host provides installed skill locations. These defaults respect higher-priority guidance and explicit user overrides. They are instructions, not runtime enforcement or tool permissions. If a required skill is unavailable, report the limitation; do not install anything during `/init`.

- **caveman:** Use the bundled skill for concise chat responses, preserving technical facts and exact code, commands, paths, and errors. Use full sentences for questions and safety warnings, and normal prose in persisted documentation and code. Honor requests to stop caveman or use normal mode.
- **grilling:** Use the bundled skill before asking clarification questions about requirements, preferences, or decisions. Choose its lightest suitable mode; do not turn a clear task into a ritual interview. Use `AskQuestion` when available in an interactive TUI; otherwise ask in chat. Cancellation is not consent.
- **ponytail:** Use the bundled skill when building or changing code. Make the smallest complete change and reuse existing patterns while retaining validation, error handling, security, accessibility, and required tests. Combine it with the task-specific skill rather than replacing debugging, migration, or test-first guidance.

## Project and layout

Piexis (`@preapexis/piexis`) is a TypeScript Pi package providing interactive questions, UI extensions, skills, prompts, and themes. Node.js 22.19+ and a current Pi release are required.

- `extensions/ask-question.ts`: sequential interactive `AskQuestion` tool; requires the TUI.
- `extensions/agents.ts`: five agent profiles and subprocess subagents; only orchestrator parents can run two non-conflicting jobs concurrently. `lib/agents.ts` owns configuration/routing, `lib/subagent-scheduler.ts` owns scope validation/scheduling, and `lib/subagent-runner.ts` owns protocol/cancellation. User/project `agent.json` files configure models and effort, with legacy `agents.json` fallback. Accepted project setup creates a missing `.pi/agent.json` scaffold without overwriting existing configuration.
- `extensions/ui.ts`: project header, activity footer, Git branch, model, and context usage.
- `extensions/recommended-tools.ts`: automatic opt-in project setup for Pi's native `grep`, `find`, and `ls` tools.
- `extensions/access-guard.ts` and `lib/access-policy.ts`: best-effort file/tool access guard, not a sandbox.
- `apps/server/`: local Fastify server owning Pi RPC sessions; `apps/web/`: React/Vite browser UI. `packages/pi-integration/` provides the RPC client; `packages/shared/` provides shared protocol types.
- `skills/`: task-specific `SKILL.md` guidance.
- `prompts/`: bundled `/init`, `/commit`, and `/summary` prompts.
- `themes/orange.json`: bundled theme.
- `package.json`: resource manifest and npm scripts; `tsconfig.json`: strict TypeScript configuration.

## Development

Use npm from the repository root (`package-lock.json` is checked in). Pi peer dependencies must be available for extension development; WebUI runtime also requires an authenticated `pi` executable.

| Command | Purpose |
| --- | --- |
| `npm ci --ignore-scripts` | Install locked dependencies without lifecycle scripts. |
| `npm run check` | Type-check extensions and libraries with `tsc --noEmit`. |
| `npm run check:server` | Type-check the server and shared packages. |
| `npm run check:web` | Type-check the browser app and Vite config. |
| `npm test` | Run `node --test tests/*.test.mjs`. |
| `npm run test:webui` | Run `node --import tsx --test tests/webui/*.test.ts`. |
| `npm run build` | Build the browser app with Vite; also runs via `prepack`. |
| `npm run dev` | Start the local server and Vite development client. |
| `pi -e ./extensions/ask-question.ts` | Preview only the question extension. |

There are no lint or format scripts. `.github/workflows/publish.yml` runs install, `check`, and `test` on Node.js 24 for version tags before publishing; it does not explicitly run the WebUI tests or separate server/browser type-checks.

## Conventions and safety

- Use ESM and strict TypeScript targeting ES2022. Extensions, libraries, and the server use NodeNext resolution; the browser app uses Bundler resolution and React JSX. Local TypeScript imports use explicit `.ts` extensions.
- Match nearby source style: two-space indentation, double-quoted strings, and semicolons. Extensions export a default registration function receiving `ExtensionAPI`.
- Preserve interactive cancellation and non-TUI handling. Add or update `node:test`/`node:assert/strict` tests for behavior changes, using disposable fixtures rather than credentials.
- Preserve unrelated working-tree changes and intentional deletions. Do not commit generated output, secrets, dependency directories, or local configuration. `.pi/` and `.kilo/` are ignored local state, not package resources.
- Permission modes, approval/classifier logic, plan execution handoffs, and background workers have been removed. The access guard blocks protected file paths and obvious shell environment inspection, but does not contain arbitrary shell commands or fully filter recursive searches. Respect host restrictions and other installed extensions; do not treat the guard or subagent scopes as sandboxing.
- Do not delete existing user settings, session records, or retained task worktrees as part of routine package changes.

## Validation

Run `npm run check` and relevant tests for implementation changes. For WebUI changes, also use the applicable `check:server`, `check:web`, and `test:webui` scripts; the root check/test commands do not cover those targets. PTY tests require Unix and Python 3 and skip unsupported hosts. Report unexecuted checks explicitly; skipped or empty runs do not establish coverage. Review the diff for credentials and unrelated changes before finishing.
