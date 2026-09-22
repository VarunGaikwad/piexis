# Piexis

## Open TUI

This checkout uses [pi-open-tui](https://github.com/OldSuns/pi-open-tui) **0.3.7** for its Pi header, framed editor, responsive Git/runtime/context footer, and per-turn token/timing statistics. `.pi/settings.json` loads it alongside this package and selects Pi's built-in `dark` theme. It replaces the previous local Claude-style TUI configuration; no custom theme or Nerd Font is required.

Run `/reload` in this project (or restart Pi), then `/open-tui` to configure the layout. Trust the project if Pi prompts. The extension defaults to English, a block cursor, automatic icons, and enabled footer/turn statistics. If icons appear as boxes, choose **Appearance → Icon mode → ASCII**. Enable **Hide thinking** in Pi's `/settings` to use the one-line thinking preview.

Appearance preferences are saved by the extension in `~/.pi/agent/open-tui.json` (or the directory selected by `PI_CODING_AGENT_DIR`). Those preferences are user-wide, but the extension installation here is project-local. `/open-tui` → **General → Enabled** restores or replaces Pi's stock layout; `/settings` controls the color theme.

To install the same version in another project:

```sh
pi install npm:pi-open-tui@0.3.7 -l
```

Or preview without saving an installation:

```sh
pi -e npm:pi-open-tui@0.3.7
```

Installing PieXis alone elsewhere does not install Open TUI. To upgrade this checkout, run `pi install npm:pi-open-tui@<version> -l`; the pinned version is not advanced by `pi update --extensions`.

A Pi package with six permission modes. Requires Node.js 24+ and a current Pi release (tested with 0.85.1).

## Usage

```sh
pi install /absolute/path/to/piexis
# Or try without installing:
pi -e ./extensions/mode.ts
```

Use `/plan` to enter read-only Plan mode, optionally starting work immediately:

```text
/plan
/plan investigate authentication and propose improvements
```

Use `Alt+M` to cycle Manual → Accept Edits → Plan → Auto (when available) → Manual.

On first trusted startup, PieXis creates `.pi/permission-modes.json` and `.pi/settings.json` when missing. It selects the current authenticated model as Auto's classifier, or the first authenticated text model. It never writes credentials or changes existing PieXis configuration. To configure Auto manually, edit `.pi/permission-modes.json`:

```json
{
  "classifier": {
    "provider": "anthropic",
    "model": "claude-haiku-4-5",
    "timeoutMs": 15000
  }
}
```

Alternatively set `PI_PERMISSION_CLASSIFIER=provider/model`. The classifier reuses PI authentication, receives only the current task and proposed action, and fails closed. Select `bypassPermissions` at launch with `--permission-mode bypassPermissions` or `--dangerously-skip-permissions`.

At launch, select a mode with `--permission-mode default`, `acceptEdits`, `plan`, `auto`, `dontAsk`, or `bypassPermissions`. `dontAsk` and `bypassPermissions` are launch-only; bypass can also be selected with `--dangerously-skip-permissions`. Pi's own `--mode` flag still selects RPC/JSON mode; it is not a permission setting.

| Mode                   | Behavior                                                                                                                                                                                                         |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Default**            | Every eligible agent bash/edit/write/plan-delete call requires approval. The dialog offers one-time approval, approval for that tool for the session, or deny. Even `pwd` and `git status` need approval through bash. Reads/searches have no approval dialog. Operations remain sandboxed. |
| **Plan Mode**          | Read-only bash, with shell networking disabled. Guarded `write`/`edit`/`delete_plan` may change only direct-child `.md` documents in `.pi/plans/`. Applying a plan requires a user switch to Build.              |
| **Accept Edits**       | Auto-approves edits and a fixed filesystem-command whitelist inside the workspace.                                                                                                                               |
| **Auto**               | Classifier-reviewed actions; risky actions are blocked.                                                                                                                                                          |
| **Don't Ask**          | Runs only pre-approved actions and silently denies the rest.                                                                                                                                                     |
| **Bypass Permissions** | No extension permission checks; launch-only and unsafe outside isolation.                                                                                                                                        |

New sessions start in Default. Mode changes require an idle agent with no tool calls in flight. Versioned mode state follows the active session branch on reload, resume, fork, and tree navigation. An explicit startup flag overrides saved state once, not later `/plan` selections. Legacy mode state resets to Default.

YOLO selection/restoration displays a warning but does not ask for confirmation. **YOLO is genuinely unrestricted by this extension.** OS permissions, Pi project trust, and independent extensions' policies still apply.

### File globbing

PieXis adds `glob`, a read-only file-discovery tool. It accepts `pattern`, optional `path`, and optional `limit` arguments; for example, use `glob` with `**/*.ts` or `src/**/*.spec.ts`. It uses Pi's gitignore-aware matcher, returns paths relative to the search directory, and is available in every permission mode.

### Initialize project guidance

Use `/init` to inspect the current project and create `AGENTS.md`, or improve an existing file while preserving valid instructions. Optional guidance can follow the command, for example `/init focus on testing conventions`.

This is a bundled prompt template, so it uses the agent's normal tools and current permissions. Install the package to load it, then run `/reload` in an existing session. Loading only `extensions/mode.ts` does not load bundled prompts. To try it directly, use `pi --prompt-template ./prompts/init.md`.

### Plans

Plan documents belong in `.pi/plans/*.md`, using Pi's configured project-directory name if it differs from `.pi`. Arbitrary Markdown elsewhere is not writable in Plan. Symlinks, multiply-linked files, nested plan directories, and non-Markdown targets are rejected.

Use `delete_plan` to delete a plan. Bash is completely read-only with respect to project files in Plan, including the plans directory. The exception is implemented by trusted file tools, not a writable directory handed to arbitrary shell commands.

`/plan <task>` enters Plan mode and starts the supplied research task immediately. Plan mode never executes a proposal or replays blocked calls; restart with the desired launch mode when ready to make changes.

### Manual shell and headless operation

`!` and `!!` use the active sandbox profile. Typing a manual command already authorizes it, so Default does not show a second approval dialog. Manual bash still cannot mutate project files in Plan.

In print/JSON mode, Default rejects agent operations that require approval; it never assumes yes. RPC clients must implement Pi's confirmation UI protocol. Build and Plan need no permission-dialog UI.

## Sandbox prerequisites

The extension uses the pinned `@anthropic-ai/sandbox-runtime` research-preview runtime:

- **Linux:** `bubblewrap` (`bwrap`), `socat`, and `ripgrep` (`rg`), plus working user/mount/PID/network namespaces and the runtime's seccomp isolation.
- **macOS:** `sandbox-exec` and `ripgrep`.
- Other platforms: non-YOLO execution is rejected in this version.

Example Linux installation, performed by the user:

```sh
sudo apt-get install bubblewrap socat ripgrep
```

A container or host security policy may refuse Bubblewrap even when it is installed. The extension does not enable weaker sandbox modes or modify host security settings.

**All managed non-YOLO tools use the sandbox, including file tools.** A missing dependency, unavailable namespace, incomplete security prerequisite, malformed configuration, or failed probe rejects execution. There is no unsandboxed fallback. Fix the problem and `/reload`; the footer shows `unchecked`, `ready`, or the failure reason. Reads are prompt-free, not exempt from containment prerequisites.

The first operation probes isolation. Each invocation then gets an isolated host launcher with its own SandboxManager, so profiles and network proxies cannot race across modes or extensions. Calls are serialized; file mutations also participate in Pi's mutation queue.

Native Pi tool schemas, renderers, edit semantics, output limits, and bash streaming are retained. Sandboxed file workers have a 120-second execution ceiling; bash honors its requested timeout. Cancellation and shutdown terminate the launcher process group. Private per-invocation scratch space is removed afterward. The runtime's implicit shared `/tmp/claude` and home-cache write grants are explicitly denied.

## Configuration

PieXis reads the project-level file:

```text
.pi/permission-modes.json
```

Pi's agent-directory override is respected. Example:

```json
{
  "readRoots": ["/absolute/path/to/shared-docs"],
  "allowedDomains": ["registry.npmjs.org", "github.com"]
}
```

Defaults are empty arrays:

- `readRoots` adds existing readable directories, never writable ones. Relative roots resolve against the agent directory. The fixed project root is the session's canonical startup cwd, not wherever a shell later executes `cd`.
- `allowedDomains` applies only to Default/Build bash. Plan bash and file workers have empty network allowlists. An allowed domain can receive **any** permitted request, including remote mutations; domain filtering is not an HTTP-method permission system.
- Unknown keys, invalid values, and unreadable/malformed settings fail closed outside YOLO. Project-local files cannot relax these rules. There is no `enabled: false` or `no-sandbox` escape hatch.

System/runtime directories and this extension's installed code/dependencies are readable inside the sandbox so tools can start. Managed file tools additionally validate requested paths against the project and configured read roots. Environment inheritance is intentionally narrow: standard PATH/home/locale settings and Pi session metadata, not arbitrary API keys, shell startup hooks, loader flags, or proxy overrides. Host launchers reject project PATH entries, symlinks into the project, and project-aware dependency shims; install native sandbox executables outside the project. The command's original PATH is restored only inside containment.

Start in a project directory, not `/` or your home directory. Glob metacharacters in sandbox roots or concrete protected paths are rejected because the backend cannot reliably represent those names as literal deny mounts.

## Protected paths and security scope

Outside-project writes are denied in Default, Plan, and Build. Approving a call does not bypass that restriction.

The backstop protects existing credential-like filenames, credential directories, multiply-linked files, shell startup/config files, project `.pi` configuration, Git hooks/config, and **this extension's own host-launcher code and dependencies**. Normal Git index/object/ref operations are not blanket-blocked. Developing this extension's protected implementation files requires YOLO or a separate, non-loaded checkout; otherwise a shell could replace the host launcher and escape on its next invocation.

Read and write protection are distinct. Directory grep/find exclude credential names before reading, do not follow symlinks, and use a bounded output buffer. YOLO delegates to Pi's native search instead, without those extra exclusions.

Important limitations:

- This governs this extension's managed tools and manual bash, **not malicious Pi extensions, arbitrary trusted host hooks, external terminals, or processes already running outside containment**. Do not install untrusted extensions. Conflicting managed-tool overrides are rejected outside YOLO.
- Unknown custom tools, PowerShell, web tools, and subagent tools are blocked outside YOLO in this version. No third-party execution adapters ship yet; a claimed read-only tool name or inherited prompt is not sufficient authorization.
- Protection is path/filename-based, not a secret-content detector. Secrets committed to Git history, copied into ordinary source files, or placed in undeclared locations are not guaranteed hidden.
- Linux mounts protect concrete existing paths, not arbitrary future filename globs. The extension scans before each profile and reserves key project configuration paths. Files introduced during an already-running command are not retroactively added to its profile. Concurrent malicious host-side filesystem changes are outside this threat model.
- Projects/read roots with more than 250,000 scanned entries are refused rather than incompletely scanned. This conservative scan can add latency in large dependency trees.
- Background/daemonized commands are not a supported workflow. Ordinary remaining launcher-group jobs are killed on completion, but processes that deliberately detach into independent process groups are not guaranteed reaped on macOS. Such descendants retain their original sandbox profile; switching modes does not retroactively change it.
- The sandbox runtime is a research preview. Its platform limitations still apply, including macOS system-mediated DNS behavior. An empty network allowlist is not a claim of a formally verified air gap.

## Development and verification

```sh
npm ci --ignore-scripts
npm run check
npm test
npm run test:sandbox
```

`npm test` covers policy decisions, approval races/cancellation, native YOLO execution, worker file operations, search filtering, and extension lifecycle/UI wiring. It explicitly skips real containment tests when the host cannot run a sandbox.

`npm run test:sandbox` sets `PIEXIS_REQUIRE_SANDBOX=1`: missing prerequisites or an unusable sandbox are **failures**, never skips. CI runs that command on Linux and macOS. Tests use disposable fixtures, not real credentials.

The implementation environment refused Bubblewrap's required mount operation. Local policy/worker tests and RPC smoke checks are not evidence that successful OS containment has been verified; run the strict suite on a supported host before relying on it.
