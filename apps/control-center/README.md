# Codex Router

The control center is an Electron interface over the existing Codex Router
control plane. It does not duplicate router state, provider
credentials, or service logic in the renderer.

## Sections

- Usage: ChatGPT plan windows, provider quota or balance, and all-retained
  local-router token and request accounting, with daily, provider, and model
  charts. OpenAI account-reported history is shown separately and is never
  added to the router total.
- Status: running chats and agents, live requests, model speed, cached-context
  savings, and upcoming quota resets.
- Models: one provider directory combining enablement, API credential entry,
  CLI sign-in, plan notes, account metrics, and each provider's catalog
  visibility and native v2 subagent controls.
- Local: Ollama runtime controls, installable and installed models, downloads,
  enablement, removal, benchmarks, and local image readers.
- Harness: launch Codex in its app or a terminal, and install or launch the
  third-party Deep Code terminal harness. Future harness adapters can share
  the same router ledger and be broken down by client without mixing provider
  billing with account-reported history.
- Context Manager: one metadata-only session index across Codex and Deep Code,
  with search, filters, context use, and resume actions in the owning harness.
- Settings: signed routing, presence, safe service start/status,
  tray, language,
  appearance, old tool-result compaction, vision, and read-only maintenance
  guidance. Updates and repairs remain interactive-terminal workflows.

The existing macOS tray remains the owner of its notch overlay and desktop
widget. This application controls that companion through the router's supported
tray commands.

## Platform support

The Electron window and the router control surface are designed for macOS,
Windows, and Linux. They use the same installed router state and fixed
`control.mjs` commands on every platform; provider selection, API credentials,
models, local runtime controls, health, usage, and settings are the cross-platform
contract for this beta.

Service stop and restart remain intentional terminal operations during the
beta because either can interrupt active turns or downloads. The Control Center
can inspect service health and start an offline service without exposing those
destructive shortcuts.

Login-free mode is also terminal-only in this beta. Its catalog and Codex
transport change must become one rollback-safe backend transaction before the
desktop app exposes it as a one-click mutation.

Install the Control Center and router from the same beta build. The app keeps
read-only status and documentation available when it detects version skew, but
refuses router mutations until the installed checkout exposes the matching
control protocol. This prevents a newer UI from sending changed command
arguments to an older installation.

Convenience actions that must open another native application are deliberately
narrower. This beta opens Codex.app, provider OAuth CLIs, Codex/Deep Code CLI
sessions, and the Deep Code installer in macOS Terminal only. On Windows and
Linux, run those interactive CLI sign-in, install, or resume commands in your
own terminal, then refresh the Control Center. The UI disables actions it cannot
launch instead of guessing a terminal or constructing a platform shell command.

The main window keeps the operating system's native window controls. On macOS,
the frameless window uses a hidden-inset title bar so native traffic lights sit
over the content while the sidebar controls and page toolbar share the same top
row as Codex; the renderer marks that row draggable without recreating the
controls. Other platforms retain their standard native frame. Close, minimize,
maximize, keyboard shortcuts, accessibility behavior, and platform-specific
placement remain native. The router artwork is used consistently for the
window, Dock, application bundle, and installer.

## Development

```sh
npm ci
npm run electron:dev
```

The application resolves the router from `CODEX_ROUTER_SOURCE_ROOT` (or the
compatible `MODEL_ROUTER_SOURCE_ROOT` override), the source checkout containing
it, the install manifest, or the stable user checkout: `%LOCALAPPDATA%\codex-router`
on Windows and `${XDG_DATA_HOME:-~/.local/share}/codex-router` on macOS/Linux.
The resolved root must pass ownership and write-permission checks.

## Verification and packaging

```sh
npm run check
npm test
npm run build
npm run electron:build
```

`electron:build` creates the current host platform's artifacts in `release/`:
DMG/ZIP on macOS, NSIS on Windows, and AppImage on Linux. Beta CI artifacts are
unsigned unless signing credentials are explicitly configured. macOS public
distribution additionally requires Developer ID signing and notarization;
Windows public distribution needs an Authenticode certificate. Treat unsigned
artifacts as tester builds, not production installers.

## Security boundary

- `contextIsolation`, renderer sandboxing, and web security stay enabled.
- The preload exposes named, positional operations that construct fixed IPC
  payloads. There is no generic command, arbitrary payload, or shell bridge.
- Commands run through a trusted `src/control.mjs` with `shell: false`, bounded
  output, timeouts, and whole-process-tree termination on either bound.
- Harness actions accept fixed harness and surface identifiers. Session resume
  accepts validated session IDs and opens only known app or terminal commands.
- API credentials are delivered once over IPC and then through child stdin.
  They never enter argv, browser storage, or returned snapshots.
- Context Manager reads bounded session metadata and never reads Deep Code
  settings or message files into the renderer.
- Navigation and new renderer windows are denied. External links are HTTPS-only
  and open through the operating system.
- Packaged builds ignore development-server environment variables, IPC accepts
  only the top-level bundled renderer, permissions are denied by default, and a
  single-instance lock prevents duplicate pollers and mutation races.
- Router mutations run through one main-process queue. Reads remain concurrent,
  and a failed mutation releases the queue for the next action. Normal app quit
  waits for the queue (including timeout cleanup) to drain.
