# Local WebUI Redesign Plan

## Decision

Keep Piexis as a local application. Each user runs `/webui` within their own project; the browser UI, backend, Pi runtime, project files, credentials, and compute stay on that user's machine.

No Vercel deployment, hosted backend, separate repository, or Svelte migration is in scope.

## Technical direction

- Keep the existing React + Vite client in `apps/web/`.
- Keep the existing local server in `apps/server/` and its Pi RPC/WebSocket protocol.
- Add a minimal set of shadcn/ui components for consistent, accessible controls.
- Preserve all current backend and WebSocket behavior.

## First redesign scope

Create a dark IDE-style workspace:

- Left sidebar: session list and new-session action.
- Center pane: chat transcript, streamed output, and composer.
- Right sidebar: Git changes and agent/tool activity, organized into usable panels or tabs.
- Responsive/collapsible side panels for narrower screens.

Improve:

- Markdown and code-block rendering.
- Tool lifecycle/status cards and expandable results.
- Dialogs, connection state, errors, focus states, and keyboard navigation.
- Clear inactive/read-only states for unimplemented file or Git actions.

## Explicit non-goals

- Cloud hosting or Vercel deployment.
- Public remote access to the local Pi runtime.
- New backend features or changes to the Pi RPC protocol.
- Monaco editor, terminal panel, file editing, Git write actions, or a Svelte rewrite.

## Acceptance criteria

- Existing session creation and switching work.
- Assistant streaming, abort/stop, extension dialogs, and Git refresh work unchanged.
- The UI is usable with keyboard navigation and on narrower browser widths.
- `npm run check:web`, `npm run test:webui`, and `npm run build` pass.

## Future remote-hosting note

A hosted version would be a separate project: it requires authentication, HTTPS, workspace isolation, and a security review. The current localhost-only design should not be exposed publicly as-is.

## Implementation status

Implemented in `apps/web/` with React, Tailwind 4, source-owned shadcn-style Radix controls, and safe GFM Markdown. The local backend and protocol are unchanged.

Delivered:

- Responsive session/chat/Git/activity layout, desktop panel collapse, and keyboard-accessible narrow-screen panel dialogs.
- Per-session messages, streaming text, tools, Git state, pending dialog ownership, and composer drafts.
- Ready/connected Send guards, duplicate-submit prevention, IME handling, Stop, dismissible errors, and focus restoration.
- Markdown headings/lists/tables/links and inline/fenced code; raw HTML is not executed and remote images are not automatically fetched.

Verification:

- `npm run check`, `npm run check:server`, `npm run check:web`: passed.
- `npm test`: 103 passed.
- `npm run test:webui`: 12 passed; 1 Windows-only test skipped on Linux.
- `npm run build`: passed.
- `tests/webui/browser-smoke.py`: passed with Chromium against both development and production clients using a mocked WebSocket/Pi runtime. Covers sessions, streaming/tools, abort, Git refresh, dialogs, IME, errors, ready/disconnected guards, panel collapse, and responsive keyboard focus.
- `git diff --check`: passed.

Remaining limitations:

- No authenticated live-model browser session was exercised; browser behavior was proved with disposable protocol fixtures.
- Screenshot files were generated in `/tmp`; image inspection was unavailable in the harness, so visual checks were limited to browser DOM/layout/focus assertions.
- Existing Pi dependency audit advisories remain (1 moderate, 1 high); no new advisories from the UI dependencies remain.

For optional browser-test setup and invocation, see the docstring in `tests/webui/browser-smoke.py`.

### Visual refinement

Following feedback that the layout was good but lacked a modern finish:

- Kept the layout and behavior, with graphite surfaces, restrained cyan accents, subtle borders, clearer sidebar selection, and refined chat/composer/dialog styling.
- Replaced interface glyphs with consistent inline SVG icons.
- Bundled Geist Variable for UI text and JetBrains Mono Variable for code via Fontsource, with local WOFF2 assets and distributed OFL licenses. No runtime Google Fonts/CDN requests are needed.
- Increased muted-label contrast and improved text sizing.
- Production browser smoke additionally verifies that both font families load and are applied, font licenses are served, and no external requests occur.

Type checks, WebUI tests, production build, and the production Chromium smoke passed for this refinement. Screenshot inspection remains unavailable; live-model execution is unchanged and was not exercised.
