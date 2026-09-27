# Local Pi runtime validation

```sh
npm run test:runtime
```

This is separate from the fast `npm test` suite. By default it launches the **declared packaged Pi CLI entrypoint** from the resolved peer dependency, loads every extension declared in the package manifest, and exercises actual SDK tools and subprocess workers. Git and the installed Pi peer dependencies are required. The PTY test additionally requires Linux's `script` and `stty`; it is explicitly skipped on other operating systems.

To check a different installed Node-based Pi CLI, override its path (symlinks are resolved):

```sh
PIEXIS_TEST_PI_CLI="$(command -v pi)" npm run test:runtime
```

This POSIX-shell command tests the global CLI instead of assuming its version matches the project's peer dependency. The override is used only by this test harness.

## What runs

A deterministic, OpenAI-compatible HTTP fixture listens only on `127.0.0.1`. Both agent and reviewer requests use that endpoint and a dummy key. The fixture emits scripted tool calls and reviewer replies; **there is no real model inference, paid provider access, or measurement of classifier judgment**.

Children use a fresh agent directory, temporary home and Git repository, an environment allowlist rather than inherited credential/proxy variables, and `--offline`. User/project context discovery, project trust, skills, prompts, and themes are disabled. Package extensions are explicitly loaded from the manifest; automatic package installation/discovery is not tested. Existing credentials and project settings are not modified.

Actual operations include writing fixture files, harmless `printf` commands, creating worktrees, inspecting/applying patches, and deleting validated fixture worktrees. Child shutdown is bounded, and cleanup validates recorded worktree ownership before removing retained task directories. This is test-state isolation, not an OS security boundary.

## Covered contracts

- Manual RPC denial and one-time approval affect actual filesystem writes; Plan blocks writes.
- Accept Edits, Don't Ask, and Bypass preserve their launch-time behavior. A busy agent cannot enter Plan; RPC command acceptance alone does not mean the mode changed.
- Auto reaches the real model registry and HTTP transport; malformed replies and reviewer timeouts fail closed.
- Real worker processes use the parent broker, perform permitted edits/Bash, and produce actual execution observations. Replacement text is not forwarded in review requests.
- Without Bash opt-in, workers expose no Bash tool and record no command execution, even when the scripted worker falsely claims that tests passed.
- Missing worker wrappers do not silently enable unrestricted built-in tools.
- Actual diff inspection, confirmation, patch application, and cleanup work through RPC.
- Missing headless approval UI denies execution; repeated denials stop after the configured default threshold and emit the diagnostic/session entry.
- Session replacement invalidates pending worker approval, stops a real worker, and retains interrupted state. A stale approval response cannot write a file.
- Closing RPC stdin shuts down an active worker cleanly.
- A real pseudo-terminal exercises the bundled UI, Alt+M cycling, `/plan`, an approval dialog, and `/permissions`, checking that one-time approval leaves no session grant.

The PTY check uses actual terminal input/output but is not a full terminal emulator or a visual/accessibility audit. It answers cursor-position queries and inspects rendered strings plus filesystem effects. Windows/macOS behavior, other terminal families, all AskQuestion interactions, skills/prompts/themes, arbitrary descendant-process cancellation, and live-provider model accuracy remain unvalidated.

## Recorded local run

On **2026-09-27 UTC**:

- Linux; Node **24.17.0**; Git **2.47.3**.
- Project peer dependency's packaged CLI: **Pi 0.85.1**, **14/14 passed**.
- Global installed packaged CLI: **Pi 0.87.1**, **14/14 passed**.
- Both runs included the PTY check; none skipped. These are the same 14 contracts checked against two runtime versions, not 28 independent contracts.
- No production permission behavior was changed for these checks. Harness assumptions about ESM package resolution, CLI entrypoint/version selection, mode labels, RPC extension-command error delivery, and the initial approval-menu selection were corrected during test development.

These results apply to these installed runtimes and controlled fixtures, not all Pi versions or all workloads. Run the suite again after SDK or extension changes. See [the classifier evaluation guide](../../eval/README.md) for the separate, explicitly authorized live-classifier evaluation procedure.
