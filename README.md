# Piexis

A Pi package with four permission modes. Requires Node.js 24+ and a current Pi release (tested with 0.85.1).

## Usage

```sh
pi install /absolute/path/to/piexis
# Or try without installing:
pi -e ./extensions/mode.ts
```

Use `/mode` for the picker, or select explicitly:

```text
/mode default
/mode plan
/mode build
/mode yolo
```

For startup/headless use, pass `--permission-mode plan` (or another mode). Pi's own `--mode` flag still selects RPC/JSON mode; it is not a permission setting.

| Mode | Behavior |
| --- | --- |
| **Default** | Every eligible agent bash/edit/write/plan-delete call requires a separate approval. Even `pwd` and `git status` need approval through bash. Reads/searches have no approval dialog. Operations remain sandboxed. |
| **Plan Mode** | Read-only bash, with shell networking disabled. Guarded `write`/`edit`/`delete_plan` may change only direct-child `.md` documents in `.pi/plans/`. Applying a plan requires a user switch to Build. |
| **Build** | No approval dialogs for permitted project operations, including scripts, tests, builds, and deletes through bash. Sandbox and protected-path restrictions still apply. |
| **YOLO** | Native tools with no permission dialogs, sandbox, custom-tool blocking, or extension-specific protected-path/search filters. |

New sessions start in Default. Mode changes require an idle agent with no tool calls in flight. Versioned mode state follows the active session branch on reload, resume, fork, and tree navigation. An explicit startup flag overrides saved state once, not later `/mode` selections. Legacy five-mode state resets to Default.

YOLO selection/restoration displays a warning but does not ask for confirmation. **YOLO is genuinely unrestricted by this extension.** OS permissions, Pi project trust, and independent extensions' policies still apply.

### Initialize project guidance

Use `/init` to inspect the current project and create `AGENTS.md`, or improve an existing file while preserving valid instructions. Optional guidance can follow the command, for example `/init focus on testing conventions`.

This is a bundled prompt template, so it uses the agent's normal tools and current permissions. Install the package to load it, then run `/reload` in an existing session. Loading only `extensions/mode.ts` does not load bundled prompts. To try it directly, use `pi --prompt-template ./prompts/init.md`.

### Plans

Plan documents belong in `.pi/plans/*.md`, using Pi's configured project-directory name if it differs from `.pi`. Arbitrary Markdown elsewhere is not writable in Plan. Symlinks, multiply-linked files, nested plan directories, and non-Markdown targets are rejected.

Use `delete_plan` to delete a plan. Bash is completely read-only with respect to project files in Plan, including the plans directory. The exception is implemented by trusted file tools, not a writable directory handed to arbitrary shell commands.

After a plan is updated, the extension asks whether to stay in Plan or switch to Build. Switching **does not automatically execute the plan or replay blocked calls**. In headless mode, it reports `/mode build` as the next step.

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

Only the user-level file is read:

```text
~/.pi/agent/permission-modes.json
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
