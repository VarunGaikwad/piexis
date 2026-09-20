# Agents Guide

## Project

Piexis is a TypeScript Pi package providing permission-mode extensions, skills, prompts, and themes. It requires Node.js 24+.

## Layout

- `extensions/mode.ts`: Pi command registration, permission-mode lifecycle, and UI integration.
- `lib/`: permission policy, tool guards, search filtering, sandbox backend, and isolated worker/broker processes.
- `skills/`: bundled agent skills.
- `prompts/`: bundled slash-command prompt templates, including `/init`.
- `tests/`: Node.js test-runner suites and disposable fixtures.
- `package.json`: Pi resource manifest and npm scripts; `tsconfig.json`: strict TypeScript configuration.

## Development

Install dependencies and run checks with:

```sh
npm ci --ignore-scripts
npm run check
npm test
```

Run the sandbox-specific tests when the required host sandbox dependencies are available:

```sh
npm run test:sandbox
```

`npm run check` runs `tsc --noEmit`; there is no separate build script. Tests use `node --test` with `.test.mjs` files.

Real sandbox tests require Linux (`bwrap`, `socat`, `rg`, and working namespaces/seccomp) or macOS (`sandbox-exec`, `rg`). The strict sandbox script uses POSIX environment-assignment syntax. Test fixtures create symlinks, which may fail with `EPERM` on Windows without symlink privileges. Skipped containment tests do not establish sandbox security.

## Conventions

- Use ESM and TypeScript conventions already present in the repository.
- Keep changes focused and preserve the existing permission and security boundaries.
- Add or update tests for behavior changes.
- Do not commit generated output, local configuration, secrets, or dependency directories.

## Security and workflow

- Default, Plan, and Build must fail closed when sandbox prerequisites or configuration are invalid; never add an unsandboxed fallback.
- Plan permits file mutations only through guarded tools for direct-child Markdown files in `.pi/plans/` (respect Pi's configured project-directory name). Shell commands remain read-only.
- Permission-mode changes belong to the user. Do not bypass denied operations; YOLO explicitly removes extension-level protections.
- Only user-level `permission-modes.json` may configure extra read roots and allowed domains; project-local configuration must not relax policy.
- Preserve protected-path checks, approval/cancellation behavior, and headless operation when changing tools or lifecycle code. Use disposable test fixtures, not real credentials.

## Validation

Before submitting changes, run `npm run check` and `npm test`. Review the diff and confirm that no credentials or unrelated files are included.
