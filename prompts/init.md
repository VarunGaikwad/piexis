---
description: Create or improve concise, repository-backed AGENTS.md guidance
argument-hint: "[focus or constraints]"
---

Initialize agent guidance in `./AGENTS.md` for the current project. Inspect first, then make the smallest justified change. The result should help a future agent work correctly without repeating your investigation.

## Optional user guidance

$ARGUMENTS

## 1. Establish scope and safety

- Target the current directory. Do not silently switch to a Git ancestor, nested package, or another worktree.
- Check the working-tree status when Git is available. Preserve unrelated changes, staged work, and intentional deletions; do not reset, clean, stage, or commit anything. If `AGENTS.md` is marked deleted and the user's intent is unclear, ask before recreating it.
- Only create or edit `AGENTS.md`. Do not repair source, tests, manifests, or other documentation as part of this task.
- Respect host access restrictions. If a read is denied or a file is unavailable, skip it and continue with accessible evidence; do not retry through another tool or bypass restrictions. Stop only if required guidance cannot be read or `AGENTS.md` cannot be safely created or updated; explain the blocker.

## 2. Inspect selectively

Read the minimum evidence needed to produce reliable guidance:

- Existing `AGENTS.md` in the current directory and applicable parent directories.
- Other applicable project guidance, such as `CLAUDE.md`, `GEMINI.md`, `.github/copilot-instructions.md`, scoped instruction files, and repository rule files. Honor instruction priority and scope; do not copy another agent's tool-specific instructions or treat bundled examples and skills as universal repository rules.
- The project README, package/build manifests, relevant tool configuration, and CI workflows when present.
- A small representative sample of source files and tests that demonstrates architecture, conventions, and validation workflows. Follow relevant references rather than reading every file.

Exclude files covered by applicable ignore rules, secrets, credential files, dependency/vendor directories, generated output, build artifacts, caches, unrelated worktrees, and unrelated large files. Use discovery that respects ignore rules; do not read excluded files merely because they exist or a reference mentions them. Missing, ignored, or denied optional evidence is not a reason to stop; omit unsupported claims and report consequential gaps. Do not dump environment variables or broad configuration directories. Git history may clarify missing guidance, but historical files are not evidence that a command or implementation still exists.

## 3. Distill useful project guidance

Include an **Agent workflow** section with these requested Piexis defaults. Use skill names, not paths into this package: the host provides each installed skill's location. Read the matching `SKILL.md` before following it.

- **caveman:** use the bundled skill for concise chat responses. Preserve technical facts and exact code, commands, paths, and errors. Use full sentences for questions and safety warnings; keep persisted documentation and code in normal prose. Honor requests to stop caveman or use normal mode.
- **grilling:** use the bundled skill before asking the user clarification questions about requirements, preferences, or decisions. Choose its lightest suitable mode; do not turn a clear task into a ritual interview. Use `AskQuestion` when available in an interactive TUI; otherwise ask in chat. Cancellation is not consent.
- **ponytail:** use the bundled skill when building or changing code. Make the smallest complete change, reuse existing patterns, and retain validation, error handling, security, accessibility, and required tests. Combine it with the task-specific skill rather than replacing debugging, migration, or test-first guidance.

These are instruction defaults, not runtime enforcement or tool permissions. Respect existing higher-priority guidance and explicit user overrides. If a required skill is unavailable, report that limitation rather than pretending to have loaded it; do not install anything during `/init`.

Include other sections only when supported and useful:

- **Overview and layout:** what the project does, major modules, and the few paths an agent needs to navigate it.
- **Commands:** exact setup, build, lint, type-check, format, and test commands found in repository configuration or documentation. Include required working directories or prerequisites when documented. Identify the package manager from repository evidence, not preference.
- **Conventions:** language/tooling choices and non-obvious patterns demonstrated by source or explicit standards.
- **Constraints:** important architecture, security, generated-code, dependency, CI, and contribution rules.

Prefer short bullets and copyable commands over an exhaustive file inventory, generic coding advice, or copied README content. Do not duplicate applicable parent guidance unless a local clarification is necessary. Omit unsupported sections instead of filling them with guesses.

## 4. Reconcile evidence and preserve intent

- Preserve valid instructions and user-authored content. Make targeted additions or corrections; replace the whole file only when it is clearly obsolete or invalid. Leave an already sufficient file unchanged.
- Distinguish intended rules from implemented behavior. If documentation and code disagree, do not silently weaken a security or contribution requirement, or present an unimplemented guarantee as fact. Record consequential discrepancies and flag unresolved conflicts.
- Check that referenced paths, scripts, and test targets exist. A declared script is not proof that its dependencies or tests are available; an absent CI workflow is not evidence of CI coverage.
- Never invent commands, conventions, directory roles, security guarantees, or workflow requirements. Do not describe deleted files or historical test coverage as current.
- Keep transient checkout details and this run's inspection log in the final report, unless a caveat is needed in `AGENTS.md` to prevent an incorrect command or unsafe assumption.

## 5. Review without unnecessary execution

This is documentation work. Inspect commands without executing them by default. Do not install dependencies or run deployment, publishing, migration, destructive, or other side-effecting commands merely to verify guidance.

Before finishing:

- Review the resulting file and diff for accuracy, contradictions, unnecessary duplication, and accidental disclosure.
- Confirm that your edits are limited to `AGENTS.md` and unrelated working-tree changes remain untouched.
- Distinguish commands discovered from checks actually executed. Never claim a check passed unless you ran it successfully; skipped or empty test runs do not establish coverage or security.

## 6. Report briefly

State:

- Whether `AGENTS.md` was created, updated, left unchanged, or blocked.
- The main guidance added or corrected.
- Which existing guidance files were considered.
- Important uncertainties, stale or missing tooling, and checks run or explicitly not run.
