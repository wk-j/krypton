# ACP Backend Update Check — Implementation Spec

> Status: Implemented
> Date: 2026-10-22
> Milestone: M6 — ACP Harness

## Problem

Krypton spawns Claude, Codex, Grok and OMP lanes from whatever copy is on the
machine and never says when that copy is behind. On 2026-10-22 this machine's
Codex lane ran `codex-acp` 1.13.0 while 2.2.2 was published — and Zed, on the
same machine, was already running 2.2.2.

## Solution

Each backend is updated through the path that changes what its lane actually
runs:

- **Claude and Codex** spawn through `npx -y <adapter>@latest`. Every new lane
  resolves the newest adapter, together with the Claude/Codex CLI it bundles.
  Nothing is left to check and no button is needed.
- **Grok and OMP** run the user's installed CLI, which has its own updater.
  Once per launch, a Rust command asks both whether they are behind. If either
  is, every local Harness window shows one warning-coloured download button in
  its titlebar (spec 320 hook).
- **The button** (or its palette entry) opens a terminal tab running `grok
  update` / `omp update`, and checks again when that tab's process exits.

There is no toast, and the user never runs an npm command.

## Research

- **The adapters run their own bundled CLI, not the user's.**
  - claude-agent-acp `claudeCliPath()` uses `CLAUDE_CODE_EXECUTABLE` if set,
    else the `@anthropic-ai/claude-agent-sdk-<platform>` binary. On this
    machine that binary is `2.1.303 (Claude Code)`; `claude --version` is
    `2.1.307`.
  - codex-acp `startAcpServer()` reads `CODEX_PATH`, else uses the bundled
    `@openai/codex`. The bundled copy is `codex-cli 0.155.1`; the Homebrew
    `codex` is `0.163.0`.
  - Krypton sets neither variable. So `claude update` and `codex update` never
    change a lane.
- **Pointing the adapters at the user's CLIs was ruled out.** Each adapter is
  built and tested against the CLI it pins (SDK `0.3.303` ↔ 2.1.303,
  codex-acp 1.13.0 ↔ `@openai/codex ^0.155.1`). Mixing versions risks protocol
  drift on every lane, for every user.
- **npx and global copies** (`libnpmexec/lib/index.js`):
  - A name-only spec checks the registry only inside the npx cache (`:44-46`,
    `preferOnline: true` at `:31`).
  - A global copy wins with no check: `:217-230` runs the global bin when the
    global tree has the package, and `:56` accepts any version for a bare
    name. A copy in the project's `node_modules` wins the same way.
  - A tag spec (`@latest`) takes the `:71-86` branch instead. It fetches the
    `latest` manifest and accepts a tree copy only when `_resolved` matches,
    so a stale global or project copy is skipped.
- **codex-acp has no updater.** Its only subcommands are `login` and `cli`;
  anything else starts the ACP server. `codex-acp --help` does not print help.
- **codex-acp 2.2.2 is initialize-compatible.** It was probed with Zed's
  installed copy:
  - Same `sessionCapabilities` (`resume, list, close, delete, fork,
    additionalDirectories, subagents`).
  - Same `authMethods` (`api-key, chat-gpt`).
  - Still advertises `_meta.steering.supported: true` (spec 278).
  - It drops `_meta.goal` and `_meta.jetbrains`, which Krypton does not read.
- **npx cost:** time to the `initialize` reply was ~1.0–1.2 s via npx vs
  0.25 s running the cached bin directly. That is the registry revalidation;
  Claude lanes already pay it. A new adapter release is downloaded once, on the
  first spawn after it. Offline was checked with an unreachable proxy:
  `npm view` failed with `ECONNREFUSED`, yet `npx -y
  @agentclientprotocol/claude-agent-acp` still answered `initialize` from the
  cache in 0.8 s. `@latest` goes through the same `getManifest`.
- **Grok:** `grok update --check --json` prints
  `{"currentVersion":"1.0.67","latestVersion":"1.0.67","updateAvailable":false,"installer":"internal","channel":"stable","autoUpdate":true,...}`.
  It respects the user's release channel.
- **OMP:** `omp --version` prints `omp/18.12.6`. Its package is npm
  `@oh-my-pi/pi-coding-agent`, whose `GET https://registry.npmjs.org/<pkg>/latest`
  returns `{"version":"18.12.6",…}` (~5 KB). `omp update` is the self-updater.
  A Tern-managed copy answers `… is installed and kept up to date by Tern;
  update it from Tern.`
- **Titlebar:** `TitlebarToggle.pressed` is required and always written as
  `aria-pressed`. The 480px container rule hides every button except `all`.
- **Terminal:** `Compositor.createTab({ title, shell, shellArgs, cwd })` opens a
  tab in the focused window, and `handlePtyExit` closes it when the process
  exits, so the script must wait before exiting. `pty-exit` carries only the
  session id. Closing a tab does not kill its PTY (`disposePaneTree` only drops
  the session from `sessionMap`).

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| Zed (agent servers) | Installs registry agents into its own dir and refetches `registry.json` at most hourly. A new version is installed for the next connection; open threads get a "New Version Available — Update to vX" callout that reconnects. | Updates are automatic. The button only exists to restart a running thread. Custom PATH agents get no check. |
| Zed (itself) | `title_bar/update_version.rs` renders an `UpdateButton` in the title bar only while an update is pending or failed; idle renders nothing. | Closest match to the requested button. |
| VS Code | Badge on the Manage gear; the menu offers Download/Install/Restart to Update. | One indicator, action behind it. |
| Grok, OMP | Self-updaters: `grok update` (auto-update on by default), `omp update`. | Krypton delegates, never competes. |

**Krypton delta** — Claude and Codex match Zed: the newest adapter is used at
the next spawn, with no install code in Krypton (npx owns the cache). Grok and
OMP match Zed's title bar button: nothing when current, one button when not.
The button delegates to each CLI's own updater in a visible terminal.

## Affected Files

| File | Change |
|------|--------|
| `src-tauri/src/acp.rs` | `builtin_backends`: claude args → `@agentclientprotocol/claude-agent-acp@latest`; codex → `npx -y @agentclientprotocol/codex-acp@latest`. `initialize_timeout`: 300 s for claude/codex, 30 s otherwise. Header comment. |
| `src-tauri/src/acp_updates.rs` (new) | `BackendUpdate`, `acp_backend_updates`, grok + omp probes, `is_newer`, unit tests. |
| `src-tauri/src/lib.rs` | `mod acp_updates`; register `acp_updates::acp_backend_updates`. |
| `src/acp/backend-updates.ts` (new) | Snapshot store, `checkBackendUpdates`, `buildUpdateScript`, `runBackendUpdates`. |
| `src/main.ts` | `void checkBackendUpdates()` after `startWorkspacePersistence()`. |
| `src/types.ts` | `TitlebarToggle.pressed` becomes optional; add `attention?: boolean`. |
| `src/titlebar-toggles.ts` | No `aria-pressed` when `pressed` is absent; `--attention` class; key covers `attention`. |
| `src/styles/window.css` | Attention colour; 480px rule keeps `backend-update`. |
| `src/acp/harness-icons.ts` | `krypton-icon-backend-update` symbol. |
| `src/acp/acp-harness-view.ts` | Constructor `openTerminalTab` callback; subscribe to the store; append the button; `activateTitlebarToggle` branch; palette entry; unsubscribe in `dispose()`. |
| `src/compositor.ts` | Pass `(o) => this.createTab(o)` to local Harness views, `null` to remote ones. |
| Tests | `acp_updates.rs` (grok JSON, omp parse, `is_newer`); `titlebar-toggles.test.ts` (action button, attention); `backend-updates.test.ts` (script quoting). |
| Docs | `0006-configuration.md` and `0069-acp-agent-support.md` spawn tables; `0320-…` (optional `pressed`, `attention`, 480px rule); `0072-acp-harness-view.md`; `README.md` index. |

## Design

### Spawn change

```rust
("claude", npx -y @agentclientprotocol/claude-agent-acp@latest)
("codex",  npx -y @agentclientprotocol/codex-acp@latest)   // was: codex-acp on PATH
```

- `backend_id` stays `codex`, and all backend-specific handling keys on the id,
  not the command.
- A global `codex-acp` install becomes unused; Krypton does not remove it.
- Remote Harness hosts spawn the same command, so they need `npx`. codex-acp is
  a Node package, so any host that ran it has Node.

**Initialize budget.** `acp_initialize` waits 300 s instead of 30 s for
`claude` and `codex` (`initialize_timeout`). This was added during
implementation. The first `npx -y @agentclientprotocol/codex-acp@latest` spawn
on this machine downloaded ~336 MB (the adapter plus its bundled
`@openai/codex`) and answered `initialize` after 183.6 s; the next spawn took
1.0 s. With the old 30 s budget, the first lane after each adapter release
would fail, and because npx was killed mid-install, the retry would start the
download again. Other backends keep 30 s.

### Data Structures

```rust
// src-tauri/src/acp_updates.rs
#[derive(Debug, Clone, Serialize)]
pub struct BackendUpdate {
    pub backend_id: String,     // "grok" | "omp"
    pub display_name: String,   // matches builtin_backends
    pub installed: String,
    pub latest: String,
    pub update_command: String, // "grok update" | "omp update"
}
```

```ts
// src/types.ts — TitlebarToggle changes
readonly pressed?: boolean;   // absent → one-shot action, no aria-pressed
readonly attention?: boolean; // warning colour

// src/acp/backend-updates.ts
export interface BackendUpdate { backend_id: string; display_name: string;
  installed: string; latest: string; update_command: string; }
export type OpenTerminalTab = (o: { title: string; shell: string; shellArgs: string[] })
  => Promise<number | null>;
export function backendUpdates(): readonly BackendUpdate[];
export function onBackendUpdatesChange(cb: () => void): () => void;
export function checkBackendUpdates(): Promise<void>;   // single-flight
export function buildUpdateScript(updates: readonly BackendUpdate[]): string;
export function runBackendUpdates(openTab: OpenTerminalTab): Promise<void>;
```

### API / Commands

`acp_backend_updates() -> Result<Vec<BackendUpdate>, String>` returns only the
backends that are behind. A failed probe (binary missing, timeout, bad output,
offline) is logged with `log::warn!` and left out; the command returns `Ok`.

Both probes run in one `tokio::join!`. Each uses
`Command::new(..).envs(cached_login_env())`, null stdin, `kill_on_drop(true)`
and a 20 s `tokio::time::timeout`. The OMP fetch uses a `reqwest::Client` with a
15 s timeout.

| Backend | Installed | Latest | Reported when |
|---------|-----------|--------|---------------|
| grok | `grok update --check --json` `currentVersion` | same JSON `latestVersion` | `updateAvailable == true` |
| omp | `omp --version`, text after `omp/` | npm `/latest` of `@oh-my-pi/pi-coding-agent` | `is_newer(latest, installed)` |

`is_newer(latest, installed)`:

- Drop `+build`. Split off `-prerelease`.
- Compare the dot-separated numeric cores; a missing segment counts as 0.
- Equal cores → newer only when `installed` has a prerelease and `latest` does not.
- Any unparseable segment → `false`.

Before any comparison, Rust drops a version that does not match
`^[0-9A-Za-z.+-]{1,64}$`.

### Data Flow

```
1. main.ts, after startWorkspacePersistence(): void checkBackendUpdates().
2. invoke('acp_backend_updates') → e.g. [{ omp, 18.12.6 → 18.13.0 }].
3. Store sets the snapshot and notifies. Each Harness view's listener runs
   notifyTitlebarTogglesChanged().
4. getTitlebarToggles() appends the backend-update button; the compositor
   re-renders the cluster.
5. Click (or palette) → activateTitlebarToggle('backend-update') →
   runBackendUpdates(openTerminalTab).
6. It registers listen('pty-exit'), then calls openTab({ title: 'ACP // update',
   shell: '/bin/sh', shellArgs: ['-c', buildUpdateScript(updates)] }). The PTY
   gets the cached login PATH.
7. The script prints and runs each command, then waits for Enter.
8. The PTY exits → the compositor closes the tab → the matching pty-exit
   unlistens and calls checkBackendUpdates() → the button goes away when
   nothing is left.
```

`buildUpdateScript` joins one block per update with `;`, so one failure does
not stop the others:

```
printf '%s\n' '' '[krypton] OMP 18.12.6 -> 18.13.0' '$ omp update'; omp update
```

- It ends with a line telling the user that running lanes keep the old version
  until restarted (palette: Restart Lane Session), then `Press Enter to
  close.` and `read _`.
- Printed fields are single-quoted `printf '%s\n'` arguments (`'` → `'\''`),
  never the format string. `update_command` is a fixed string from Rust.

### Keybindings

There is no new chord. The keyboard path is a Harness context palette entry:

`{ id: 'acp.backends.update', label: 'Update ACP Backends (OMP 18.12.6 → 18.13.0)', category: 'ACP Harness' }`

It is present only while the list is non-empty and the view has a terminal
callback.

### UI Changes

- The button is appended after `all` with `separatorBefore: true`:
  `{ id: 'backend-update', icon: 'krypton-icon-backend-update', label:
  'Backend updates: OMP 18.12.6 → 18.13.0', attention: true }`, with no
  `pressed`. Two updates are joined with `, `.
- `.krypton-window__view-toggle--attention { color: rgb(var(--krypton-warning-rgb, 232, 197, 71)); }`
  Hover uses the same colour with a 10% fill. There is no animation.
- 480px rule: `:not([data-toggle-id='all']):not([data-toggle-id='backend-update'])`.
- Icon: 16×16 stroke `currentColor`, a down arrow into a tray.

### Configuration

None.

## Edge Cases

- **New Claude/Codex release while a lane runs:** that lane keeps its version.
  The next spawn, or Restart Lane Session, picks up the new one.
- **First Claude/Codex spawn after a release:** npx downloads the adapter and
  its bundled CLI before `initialize`, so that one lane starts slower. For
  Codex this was 183.6 s on this machine, inside the 300 s budget.
- **Claude/Codex offline:** an installed version starts from the npx cache.
  The very first spawn on a machine fails, as Claude does today.
- **Codex major bump** (1.x → 2.x today): picked up automatically, as Claude
  already is. The 2.2.2 probe above found no initialize-level change Krypton
  depends on. Session-level behaviour is covered by the implementation smoke
  test.
- **Grok/OMP probe fails or offline:** that backend is omitted; with nothing
  left, no button. No retry until the next launch or update tab.
- **Grok auto-update:** `updateAvailable` is usually `false`, so Grok rarely
  appears.
- **Tern-managed OMP:** `omp update` prints Tern's message in the tab, and the
  button stays until Tern updates OMP.
- **No Harness window open:** no button; the snapshot is kept for the next
  Harness window.
- **Remote Harness:** local versions do not apply. The callback is `null`, so
  there is no button and no palette entry.
- **Update tab closed without Enter:** the PTY is not killed (current
  compositor behaviour), so there is no re-check and the button stays until the
  next launch. A second click opens a second tab; there is no lock, because a
  lock tied to `pty-exit` would stick in this case.
- **`createTab` returns `null`** (no focused window): the listener is removed
  and nothing else happens.
- **Window reload:** the module state is gone, so the check runs again.

## Open Questions

None.

## Out of Scope

- Backends other than Claude, Codex, Grok and OMP.
- Pointing the adapters at the user's own `claude` / `codex` CLIs
  (`CLAUDE_CODE_EXECUTABLE`, `CODEX_PATH`).
- Pinning or rolling back an adapter version, or a Krypton-managed install
  cache.
- Periodic re-checks during a session, or a manual "check now" command.
- A toast, banner, or any surface other than the Harness titlebar and its
  palette entry.
- Detecting or restarting running lanes that are behind (Zed's reconnect
  callout).
- Killing a PTY when its tab closes.

## Resources

- `/Users/wk/Source/zed/crates/project/src/agent_server_store.rs`, `agent_registry_store.rs` — registry refresh throttle, managed installs, `NewVersionAvailable`.
- `/Users/wk/Source/zed/crates/agent_ui/src/conversation_view/thread_view.rs` `render_new_version_callout` — reconnect callout.
- `/Users/wk/Source/zed/crates/title_bar/src/update_version.rs` — title bar update button, idle renders nothing.
- `/opt/homebrew/lib/node_modules/npm/node_modules/libnpmexec/lib/index.js` — name-only vs tag resolution, global-tree shortcut.
- claude-agent-acp `dist/acp-agent.js` `claudeCliPath()`; codex-acp `dist/index.js` `startAcpServer()` / `startCodexConnection()` — bundled CLI selection.
- [npm registry API](https://github.com/npm/registry/blob/main/docs/REGISTRY-API.md) — package metadata and `dist-tags.latest`.
- [VS Code — Manage updates](https://code.visualstudio.com/docs/enterprise/updates) — update actions behind one indicator.
- `docs/0320-harness-titlebar-panel-toggles.md`, `docs/0287-acp-antigravity-lane.md`, `docs/0084-acp-pi-lane.md` (PATH-vs-npx latency rationale) — Krypton precedents.
