# PieXis

PieXis is a Pi package with interactive questions, coding skills, prompts, and terminal UI resources. It requires Node.js 22.19+ and a current Pi release.

## Installation

```sh
pi install npm:@preapexis/piexis
```

Restart Pi or run `/reload` after installation. The package loads AskQuestion, agent profiles/subagents, the custom header/footer, automatic recommended-tool setup, prompts, skills, and the theme.

## Resources

- **AskQuestion** provides keyboard-driven single/multi selection and text questions in the interactive TUI, with validation, answer review, and cancellation. It requires terminal input and output.
- **UI** shows project information, agent activity, Git branch, model, and context usage. The startup header shows three random, category-labelled tips from `lib/ui-tips.json`, preferring different categories and staying stable across redraws. Tips cycle without repeats until the list is exhausted within the extension runtime; `/reload` starts a new cycle. Each JSON entry has `category` and `text` fields; edit them to change the recommendations.
- **Recommended tools** offers to enable native `grep`, `find`, and `ls` for the project at startup; no slash command is needed.
- **Agents** provides `plan`, `orchestrator`, `debug`, `ask`, and `code` profiles, all callable through the `subagent` tool. Small delegated tasks can automatically use a cheaper model.
- **Skills** cover implementation, debugging, review, design, refactoring, validation, and document workflows. Bundled **caveman** adds concise chat style; **ponytail** guides the smallest complete coding change. Only their core instructions are included, not upstream hooks or companion skills. Source revisions and licenses live beside each skill.
- **Prompts** include `/init`, `/commit`, and `/summary`. `/init` adds workflow guidance to `AGENTS.md`: caveman for responses, grilling for clarification questions, and ponytail for building. These are agent instructions, not runtime enforcement.

- **Theme** provides the bundled orange palette.

Caveman and ponytail ship with this package; no separate installation is needed. Their upstream standalone installation commands are:

```sh
npx skills add https://github.com/juliusbrussee/caveman --skill caveman
npx skills add https://github.com/dietrichgebert/ponytail --skill ponytail
```

Avoid loading standalone copies alongside the bundled skills, which can cause name collisions. In Pi, explicitly invoke the bundled skills with `/skill:caveman` and `/skill:ponytail`.

## Automatic tool setup

On startup in a trusted project with terminal input/output, Piexis offers any pending setup: available, inactive `grep`, `find`, and `ls` tools, or a missing project agent configuration when the agent extension is loaded. Earlier tool approval does not hide the new agent setup; if tools are already configured, the prompt offers only `.pi/agent.json` creation and leaves tool settings unchanged:

- **Enable** saves the project choice and tool additions in `.pi/settings.json`, then activates them in the current session without removing active tools or extensions. It also creates `.pi/agent.json` if neither that file nor legacy `.pi/agents.json` exists. The scaffold uses the current model for `model`, `small_model`, and `subagent_model`, preserves user-level agent overrides, and populates all five `subagent_variant_overrides` with `model` and `effort`. Default effort is `high` for plan/orchestrator/debug, `low` for ask, and `medium` for code. Existing agent configuration is never overwritten. If creation fails or no model is selected, tools remain enabled and a warning explains how to configure agents manually.
- **Not now** (the default) or Esc changes nothing. The prompt is shown at most once per project per extension runtime; a subsequent startup or reload may offer it again.
- **Don't ask again** records `"disabled"` only for features offered in that prompt: `piexis.recommendedTools` for tool setup and `piexis.agentSetup` for agent setup. It changes neither tools nor agent files. Approval records `"enabled"`. An existing `agent.json` or legacy `agents.json` completes agent setup; if creation failed or the file was removed, startup offers it again unless `agentSetup` is `"disabled"`. Remove the corresponding disabled preference to allow another offer.

User-level settings are never written. Other project settings and existing `piexis` keys are preserved. Modern Pi uses additive `defaultTools` entries such as `["+grep", "+find", "+ls"]`. Older Pi releases without additive support use a plain list of the four default tools plus the approved additions, only when no tool selection is configured.

Setup skips non-TUI/non-TTY runs, untrusted projects, and runs with CLI tool-selection overrides (`--tools`, `--exclude-tools`, `--no-tools`, or `--no-builtin-tools`, including their short forms). Explicit `defaultTools` allowlists, including an empty list, are left alone; they can still receive an agent-only setup offer. Additive `-tool` exclusions remain respected. Only Pi's available built-in tools are offered. Malformed or non-regular settings files and settings changed during the prompt are not overwritten; a warning explains why setup was skipped.

The setup extension is `extensions/recommended-tools.ts`; package resource filtering can omit it. Native `find` provides file discovery by glob pattern; no wrapper extension is needed.

## Agents and subagents

Use `/agent` to select a profile, `/agent plan` to switch directly, or `pi --agent orchestrator` at startup. **Alt+A** cycles `plan → orchestrator → debug → ask → code` while idle; cycling is blocked while an agent is running. The footer shows the active profile (`agent:code`) and, on wider terminals, the shortcut hint. `/hotkeys` lists the shortcut. `code` is the default. Profile choices follow the active session branch. Profiles add instructions rather than replacing repository guidance or changing the main session's tools:

| Profile | Purpose |
| --- | --- |
| `plan` | Explore and return a plan; no implementation |
| `orchestrator` | Delegate focused tasks and combine verified results |
| `debug` | Establish evidence, diagnose, fix, and verify |
| `ask` | Answer questions from code/documentation; no changes |
| `code` | Implement scoped changes and run checks |

All five are callable with `subagent({ "agent": "ask", "task": "Locate the configuration loader" })`. The orchestrator chooses when to delegate; delegation is not an automatic pipeline. Each child receives its task, normal Pi resources, and profile instructions, **not** the parent's conversation. Supply necessary context explicitly. Children share the workspace, so calls are sequential; delegation stops at two child levels. A delegated orchestrator can call other subagents at the second level.

Optional configuration lives in `~/.pi/agent/agent.json` (or `$PI_CODING_AGENT_DIR/agent.json`) and trusted-project `.pi/agent.json`. Legacy `agents.json` is still read when `agent.json` is absent in that scope; no files are renamed or deleted. Project fields override user fields; per-variant overrides merge by field. Accepting **Enable** during project setup creates the project scaffold only when no project agent configuration exists; user-level files are never written. Defaults use the current model unless user-level configuration specifies another model. Edit the scaffold directly to select a cheaper `small_model` or customize effort; routing reloads configuration on each delegation. Use exact `provider/model-id` strings from `/model`, not fuzzy aliases:

```json
{
  "model": "provider/default-model",
  "small_model": "provider/default-model",
  "subagent_model": "provider/default-model",
  "subagent_variant_overrides": {
    "plan": { "model": "provider/default-model", "effort": "high" },
    "orchestrator": { "model": "provider/default-model", "effort": "high" },
    "debug": { "model": "provider/default-model", "effort": "high" },
    "ask": { "model": "provider/default-model", "effort": "low" },
    "code": { "model": "provider/default-model", "effort": "medium" }
  }
}
```

Replace the example model IDs with available, authenticated models. `model` initializes a new main session; explicit CLI model selections and resumed sessions win. `subagent_model` defaults to the current main-session model. A per-variant `model` wins over all automatic routing. New scaffolds explicitly pin each variant to the default subagent model; remove the `model` field from a variant's override to let it follow automatic routing or later `subagent_model` changes. Otherwise, short lookups/summaries in `ask` and clearly mechanical typo/comment/label/symbol edits in `code` use `small_model` when configured. Ambiguous, longer, or complex tasks, including planning, debugging, and orchestration, keep the normal subagent model. This is a conservative text heuristic, not a classifier or a guarantee of task difficulty. Omit `small_model` to disable automatic small-task routing.

Effort accepts `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. Variant effort overrides win; small tasks otherwise request `low`, and other tasks inherit the parent's thinking level. Pi clamps effort to the chosen model's capabilities. Results/progress show the selected model, **requested** effort, routing reason, output, and usage. Invalid configuration or unavailable child models fail explicitly rather than silently switching providers.

Child agents run in separate Pi processes with ephemeral sessions and the same OS permissions. Their tool selection is a subset of the parent's active tools; `plan`/`ask` children select only `read`, `grep`, `find`, and `ls`, and disable native MCP access. `plan`/`ask` parents may delegate only to those two profiles. Other children omit `AskQuestion` and return questions to the parent. Main profile instructions and child tool selection are **not sandboxing**. Normal configured extensions and explicitly supplied CLI extensions load in children, with the parent's project-trust decision. Runtime-only provider/tool registrations, CLI `--api-key` overrides, credentials supplied only to an embedded SDK session, and in-memory state in other extensions are not copied to child processes. Use Pi's stored or environment-based authentication for delegation. Other extensions remain responsible for their own restrictions; verify their subprocess behavior before using delegation in a restricted host.

Abort and shutdown terminate active children (including their process group on Unix). Windows termination is best-effort for descendants. Model-facing output is capped at 50,000 characters; tool details retain up to 1 MB. JSON/print mode supports subagents but has no profile picker or child terminal interaction. Avoid loading another extension that registers `subagent`, `/agent`, or `--agent` alongside this one.

## AskQuestion

Existing `{ questions: [{ question, options, multiSelect?, allowOther? }] }` calls remain supported. New optional fields:

- Question `id`, `type` (`single`, `multi`, `text`), and `required` (defaults to true). Explicit text questions may omit `options`; legacy optionless questions require `allowOther: true`.
- Option `id`, `label`, and optional `description`. Missing IDs become `question-1` / `option-1`, etc.; IDs must be unique within their scope. Labels need not be unique.
- `defaultSelection`: option ID or array of IDs. `minSelections` / `maxSelections` apply to multi-select answers. Required questions always need an answer.
- `maxLength`: maximum text length in Unicode code points. Text is not trimmed; whitespace-only required answers are rejected. Text input is single-line, using Pi's native Input component.

Use ↑↓ to navigate, Space to toggle multiple choices, Enter to confirm, and Esc/Ctrl+C to cancel the interaction. For related questions, Tab/Shift+Tab revisits questions without losing drafts; all questions must be confirmed before the final review can be submitted. “Type something else” is available only with `allowOther`; its answer replaces, rather than mixes with, selected options. Selection-count limits do not apply to custom text.

Results have `status`: `answered`, `cancelled`, `aborted`, `requires_interaction`, or `error`. Both model-facing JSON and tool `details` contain the same result. Legacy `answers` and `cancelled` fields remain; each confirmed answer retains `question` and label-based `answer`, with added question `id`, `optionIds`, and `custom`. Optional empty answers are `""` or `[]`, never cancellation. Cancellation returns only already-confirmed answers. `cancelled` remains true for every non-answered outcome; use `status` to distinguish them.

Pi owns stdin, raw mode, cursor state, and focus restoration. Agent abort and session shutdown dismiss the screen; input closure/errors also settle it. Concurrent AskQuestion calls are explicitly rejected with `status: "error"`, in addition to Pi's sequential execution. Other extensions must respect Pi's UI ownership; this extension does not coordinate unrelated prompts. Non-TUI/non-TTY runs return `requires_interaction` without reading input.

## Removed features

PieXis no longer provides permission modes, tool approvals, classifier review, plan-to-execution handoffs, filtered search, or background worktree tasks. Their commands, shortcuts, flags, and configuration initialization have been removed. Tool execution follows Pi and any other installed extensions; PieXis does not provide sandboxing or access restrictions.

Existing `piexis` settings, legacy configuration files, session records, and retained task worktrees are not deleted automatically. Old classifier, execution-model, and background-model settings are no longer read. Remove obsolete configuration manually if desired, preserving unrelated settings and any work you need. Remove explicit references to deleted extensions from your Pi resource settings or launch arguments.

## Select package resources

Use Pi's native resource filtering with `pi config` (or `pi config --local` for a trusted project), or narrow resources in settings:

```json
{
  "packages": [
    {
      "source": "npm:@preapexis/piexis",
      "extensions": ["extensions/ask-question.ts"],
      "skills": ["skills/code-review", "skills/diagnosing-bugs", "skills/safe-refactor"],
      "themes": []
    }
  ]
}
```

Omit a resource type to load all declared resources of that type; use `[]` to load none. Glob exclusions such as `"!skills/docx/**"` can omit document workflows.

## Development

```sh
npm ci --ignore-scripts
npm run check
npm test
```

Tests cover retained extension/resource contracts, agent configuration/routing/profile state, child-process protocol/cancellation, AskQuestion validation/lifecycle, recommended-tool setup/settings preservation, and skill routing. On Unix with Python 3, automated PTY tests drive the real Pi TUI renderer and native selector, checking keyboard interactions, startup choices, cancellation, cursor/raw-mode restoration, and listener cleanup. They use UI adapters rather than a live agent session; unsupported hosts explicitly skip these tests. Tests do not establish OS containment or live-model behavior. The permission evaluation, sandbox, and background-task runtime suites have been removed with those features.
