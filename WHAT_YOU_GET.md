# What you get with Piexis

Piexis (`@preapexis/piexis`) is a package for the **Pi coding agent**, not a standalone application. It adds control over agent actions, background coding tasks, reusable workflows, and a compact terminal interface.

Installing the full package makes these resources available:

| Included | What it gives you |
| --- | --- |
| **5 extensions** | Permission modes, interactive questions, background tasks, file discovery, and a custom terminal UI. |
| **18 skills** | Task-specific guidance for coding, debugging, reviews, architecture, integrations, and document work. |
| **3 prompt templates** | `/init`, `/commit`, and `/summary`. |
| **1 theme** | An optional warm, dark `orange` theme. |

## Permission controls you choose

A new session starts in **Manual** mode unless you select a launch mode or restore a saved session mode. Use **Alt+M** while the agent is idle to cycle through Manual → Accept Edits → Plan → Auto. Auto is skipped when no authenticated classifier is configured.

| Mode | What to expect |
| --- | --- |
| **Manual** (`default`) | Ordinary project-local reads and searches are pre-approved. Edits, most Bash commands, and external or sensitive paths require approval. |
| **Accept Edits** (`acceptEdits`) | Also pre-approves ordinary project-local `edit` and `write` calls. Most Bash commands and external or sensitive paths still require approval. |
| **Plan** (`plan`) | Read-only exploration and task status/diff inspection/cancellation. Blocks Bash, file changes, task creation/apply/cleanup, and external or sensitive path-tool reads. |
| **Auto** (`auto`) | Allows ordinary project-local reads and edits, rejects sensitive or unsupported actions, and reviews consequential supported actions against verified user intent. Failed or invalid reviews deny the action. |
| **Don't Ask** (`dontAsk`) | Allows pre-approved reads/questions, task inspection/cancellation, and tiny harmless Bash builtins; denies other calls without prompting. Launch-only. |
| **Bypass Permissions** (`bypassPermissions`) | Skips Piexis permission checks. Launch-only; it does not override OS permissions or other extensions. |

Start planning with `/plan <task>`. To select a mode at launch, use `pi --permission-mode <mode>`.

Approval dialogs let you **allow once**, deny, or approve a narrower session scope: a file, directory, ordinary project files for one tool, an eligible exact Git status command, or its narrow query family, bound to the directory and configuration. A clearly labelled whole-tool session approval is also available. Session approvals stay in memory; they are not saved for future sessions. Actions requiring approval are denied when permission UI is unavailable.

**These controls are not a sandbox.** They do not provide OS containment, filesystem isolation, or network restrictions. Use an appropriate container, VM, or restricted account for untrusted or unattended work.

### Optional Auto setup

Run `/piexis-init` to create missing `.pi/settings.json` and `.pi/permission-modes.json` without overwriting existing files. When an authenticated text model is available, initialization selects one for the classifier and background tasks. Simply launching Piexis does not create project configuration.

You can change the classifier in `permission-modes.json` or override it with `PI_PERMISSION_CLASSIFIER=provider/model`. Pi's existing authentication is reused; no credentials are stored in this configuration.

Auto reviews make additional model requests. The classifier receives action details, bounded verified user requests/constraints, and eligible narrow approval scopes. Delegation reviews also include the proposed task brief as untrusted action data. File contents, replacement text, raw tool history, and worker result summaries are excluded. These selected inputs can still contain sensitive information. See [the README](README.md#auto-review-policy-and-privacy) for limits and disclosure details.

## Background tasks without mixing edits into your checkout

Use `/task <work>` to delegate a task to another Pi process. Use task commands to inspect progress; a new ordinary user prompt revokes outstanding worker authorization and cancels active/queued tasks. Up to **two workers** run concurrently; additional tasks queue.

Each worker starts from committed **HEAD** in a separate Git worktree. It receives your task description and any supplied task brief, not the full foreground conversation or your uncommitted changes. Include relevant files, constraints, and acceptance criteria in the task.

| Command | Purpose |
| --- | --- |
| `/task <work>` | Start a background task. |
| `/task status` | List tasks and their states. |
| `/task review <id>` | Read the worker's result. |
| `/task diff <id>` | Inspect its actual file changes. |
| `/task cancel <id>` | Cancel queued or running work. |
| `/task apply <id>` | Apply a completed task's diff after confirmation. |
| `/task clean <id>` | Remove a validated task worktree after confirmation; refuses completed, unapplied work. |
| `/task interrupted` | Find interrupted tasks whose saved work needs inspection. |

The agent also gets `background_task`, `task_status`, `task_diff`, `task_cancel`, `task_apply`, and `task_clean` tools, subject to the active permission policy. Each task tool has its own policy. Auto reviews creation and worker mutations against user intent; apply/cleanup always require explicit confirmation. Plan blocks creation, application, and cleanup.

**Important limits:**

- Git and a repository with a commit are required. Worktrees separate Git changes, **not host filesystem access**.
- Workers have bounded read/search and edit/write capabilities. Launch with `--background-bash` to opt into permission-controlled command execution, not sandboxing; Bash requires whole-worktree scope.
- Every worker call uses the parent permission broker; foreground grants are not inherited. Auto reviews worker mutations; Manual prompts for non-pre-approved actions. Missing, denied, or expired authorization blocks the action.
- Workers do not load your usual skills, prompt templates, or context files. Put essential project guidance in the task brief.
- Background models use Pi authentication and incur their own model usage. They default to the active model when no background model list is configured; a nonempty `background.models` list restricts model selection; an absent or empty list falls back to the active parent model.
- Results are not automatically applied or committed. Diff inspection uses temporary Git storage, without staging into the real index. Sensitive/configuration patch bodies are withheld. Apply checks actual paths and reconfirms patch identity; verification observations come from executed tools, not worker claims. Verify again in your checkout.
- Task metadata and results are saved under Pi's user agent directory. Interrupted worktrees can be inspected or cleaned, but dead worker processes cannot resume.

## Better questions and file discovery

- **`AskQuestion`** lets the agent pause for structured clarification: single-choice, multiple-choice, or free-form answers. Questions are asked sequentially, and you can cancel. It remains permitted in every permission mode but requires the interactive terminal UI.
- **`glob`** finds files by patterns such as `src/**/*.ts`, respects `.gitignore`, and returns paths relative to the search directory. It wraps Pi's file-finding tool under a familiar name.

## 18 task-focused skills

Skills are instructions, references, and—in some cases—helper scripts, not always-running agents. Pi advertises their descriptions and loads the detailed guidance when relevant. You can explicitly select one with `/skill:<name> <request>`.

### Coding and engineering

| Skill | Use it for |
| --- | --- |
| `lean-build` | Implementing a focused feature or ticket with clear scope and acceptance criteria. |
| `diagnosing-bugs` | Investigating failures and regressions, then making a narrow fix with evidence. |
| `tdd` | Test-first work using a red–green–refactor workflow. |
| `safe-refactor` | Restructuring code while preserving behavior. |
| `migration` | Compatibility-safe schema, data, API, configuration, or dependency transitions. |
| `code-review` | Reviewing diffs, branches, pull requests, or repositories for actionable issues. |
| `verify-and-stop` | Checking completed work against acceptance conditions without expanding scope. |
| `codebase-design` | Designing or auditing architecture, interfaces, ownership, and module boundaries. |
| `grilling` | Clarifying requirements, pressure-testing plans, and turning ideas into specifications. |
| `writing-for-agents` | Writing useful skills, `AGENTS.md`, and other agent instructions. |

### Interfaces and integrations

| Skill | Use it for |
| --- | --- |
| `frontend-design` | Product web interfaces, visual hierarchy, responsive behavior, and accessibility. |
| `webapp-testing` | Testing local web apps with Playwright, screenshots, and browser logs. |
| `mcp-builder` | Building MCP servers in Python or TypeScript to expose external services as tools. |
| `claude-api` | Anthropic API and SDK integrations, streaming, tools, agents, and troubleshooting. |

### Documents and data

| Skill | Use it for |
| --- | --- |
| `docx` | Creating, reading, and editing Word documents and templates. |
| `pdf` | PDF extraction, creation, merging, splitting, OCR, and forms. |
| `pptx` | Creating and editing presentations, slides, and templates. |
| `xlsx` | Spreadsheets, formulas, formatting, charts, and tabular-data cleanup. |

Document and browser workflows may require additional software such as Python packages, Playwright browsers, or LibreOffice. Installing Piexis does **not** provision every skill's external dependencies. Skills also do not bypass permission checks.

## Three reusable prompts

| Prompt | What it asks the agent to do |
| --- | --- |
| `/init [focus or constraints]` | Inspect the repository and create or improve concise, evidence-backed `AGENTS.md` guidance. |
| `/commit` | Review Git changes and return a concise commit message. **It does not create a Git commit.** |
| `/summary` | Summarize completed work, decisions, open items, next steps, and the user-message count. |

`/init` writes agent guidance; `/piexis-init` initializes Piexis configuration. They are different commands. Prompt templates guide the model and remain subject to your current permission mode.

## A compact terminal workspace

The UI extension adds a Piexis startup header, a project-specific terminal title, and a compact footer showing activity, permission mode, Git branch, model, and context usage.

The bundled **`orange`** theme provides warm accents on dark backgrounds. Select it through **`/settings` → Theme**; installation makes it available but does not automatically change your chosen theme.

## Install and try it

Use a current Pi release; the project README records local runtime checks with Pi **0.85.1 and 0.87.1 on Linux**. The package declares **Node.js 22.19+**; also satisfy your installed Pi version's requirements.

From a local checkout:

```sh
npm ci --ignore-scripts
pi install /absolute/path/to/piexis
```

Restart Pi or run `/reload`. Installing the package loads its declared resources; loading only `extensions/mode.ts` does not give you the rest of the bundle.

Try these in Pi:

```text
/plan Explain the authentication flow and propose improvements
/skill:code-review Review the current changes
/summary
```

Use **Alt+M** when idle to leave Plan before requesting edits.

**Keep only what you want:** run `pi config` (or `pi config --local`) to enable or disable package resources. You can keep permission controls without the custom UI, or keep coding skills without document workflows. See [the README](README.md#select-package-resources) for resource-filtering examples and configuration details.
