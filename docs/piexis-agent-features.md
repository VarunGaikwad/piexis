# Piexis Agent Features Reference

Use this document when answering questions about the Piexis package. Piexis extends the Pi coding agent with interactive questions, agent profiles and subagents, startup setup, terminal UI information, skills, prompts, themes, and an optional local WebUI.

## Installation and reload

Install the package, then restart Pi or run `/reload`:

```sh
pi install npm:@preapexis/piexis
```

Piexis requires Node.js 22.19+ and a current Pi release.

## Agent profiles and subagents

Piexis provides five profiles. Profiles add task-specific instructions; they do not replace repository instructions such as `AGENTS.md`.

| Profile | Use it for |
| --- | --- |
| `plan` | Explore and propose a plan; do not implement. |
| `orchestrator` | Break down and coordinate focused delegated work. |
| `debug` | Diagnose a bug, make a focused fix, and verify it. |
| `ask` | Answer questions using the codebase or documentation; do not edit. |
| `code` | Implement a scoped change and run relevant checks. |

Use `/profile`, for example `/profile debug`, or `/profile auto` to re-enable automatic routing. `Alt+A` cycles profiles while idle. `pi --agent orchestrator` chooses a profile at startup.

The `subagent` tool can start a child agent. Give each child a self-contained task because it does not inherit the parent conversation. Children share the workspace and OS permissions with the parent.

```ts
subagent({
  agent: "code",
  mode: "write",
  paths: ["lib/example.ts", "tests/example.test.mjs"],
  task: "Implement the requested behavior and add focused coverage."
});
```

Use `mode: "read"` for discovery-only tasks. Only an `orchestrator` parent can run up to two independent subagent jobs concurrently. Paths are cooperative ownership declarations, not a security sandbox.

### Agent configuration

Optional configuration is read from `~/.pi/agent/agent.json` and trusted-project `.pi/agent.json`; legacy `agents.json` is accepted when the modern file is absent. Use model IDs exactly as they appear in `/model`.

```json
{
  "model": "provider/default-model",
  "small_model": "provider/default-model",
  "subagent_model": "provider/default-model",
  "delegate_exploration": true,
  "auto_profile": false,
  "subagent_variant_overrides": {
    "plan": { "model": "provider/default-model", "effort": "high" },
    "ask": { "model": "provider/default-model", "effort": "low" },
    "code": { "model": "provider/default-model", "effort": "medium" }
  }
}
```

Run `/setup-agents` to create missing project configuration without overwriting configured values. Set `auto_profile` to `true` to route clear new requests automatically. Set `delegate_exploration` to `true` to allow bounded read-only discovery with `subagent({ agent: "ask", purpose: "explore", ... })`.

## Interactive questions

The `AskQuestion` tool provides TUI forms for single-select, multi-select, and text questions. It requires an interactive terminal; non-TUI runs return `requires_interaction` rather than reading stdin.

Keyboard controls:

- Arrow keys: move selection.
- Space: toggle a multi-select option.
- Enter: confirm.
- Tab / Shift+Tab: move between related questions.
- Esc or Ctrl+C: cancel.

Questions can define IDs, validation, defaults, selection limits, optional answers, and text length limits. Tool results use a `status` such as `answered`, `cancelled`, `aborted`, `requires_interaction`, or `error`.

## Startup setup and native tools

In a trusted interactive project, Piexis can offer to enable Pi's native `grep`, `find`, and `ls` tools. Choosing **Enable** stores the project choice in `.pi/settings.json` and can create a missing `.pi/agent.json` scaffold. Existing settings and agent configuration are preserved.

Choose **Not now** to leave settings unchanged, or **Don't ask again** to suppress that offered setup feature. Setup is skipped for untrusted projects, non-interactive sessions, and explicit CLI tool-selection overrides.

## Terminal UI and themes

The UI extension adds a project header and activity footer showing useful context such as the Git branch, active model, profile, and context use. The header also displays rotating tips.

Included themes are **orange** and **midnight**. Run `/reload`, then choose one through `/settings` → **Theme**.

## Skills and prompts

Piexis bundles task-specific skills. Invoke an installed skill explicitly with `/skill:<name>` when needed. Examples include:

- `code-review`, `diagnosing-bugs`, `safe-refactor`, and `tdd` for engineering work.
- `lean-build`, `migration`, and `verify-and-stop` for scoped delivery.
- `docx`, `pdf`, `pptx`, and `xlsx` when those file types are involved.
- `caveman` for terse answers and `ponytail` for the smallest complete solution.

Bundled slash prompts are `/init`, `/commit`, and `/summary`. `/init` adds workflow guidance to `AGENTS.md`; it does not enforce behavior at runtime.

## Local WebUI preview

Run `/webui` from Pi to start the local WebUI and receive a per-launch URL. The terminal UI remains usable. Alternatively start it outside Pi:

```sh
piexis-web --workspace /path/to/project
```

The preview supports streamed chat, tool lifecycle cards, aborting, forwarded extension dialogs, and read-only Git status. It binds locally and uses a per-launch access token. It does not yet provide a full file editor, terminal panel, or historical-session browser.

## Endpoint configuration

For hosted, self-hosted, and proxy model endpoints, see:

- [OpenAI-compatible endpoints](openai-compatible-endpoints.md)
- [Microsoft Foundry Anthropic endpoints](microsoft-foundry-anthropic.md)

A standard OpenAI-compatible `/v1` endpoint can usually be configured in Pi `models.json`. A gateway that only accepts a final Azure deployment URL with a required query string may require a custom Pi provider extension.

## Important limitations

Piexis does not enforce permissions, sandboxing, tool-access restrictions, plan-execution handoffs, classifier approval, or background worktrees. Subagent scopes and profile instructions are coordination mechanisms, not security boundaries.
