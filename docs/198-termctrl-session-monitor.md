# Terminal Control Session Monitor: Implementation Spec

> Status: Implemented
> Date: 2026-07-19
> Implemented: 2026-07-20
> Milestone: ACP Harness: observability

## Problem

Krypton can launch and share `termctrl` sessions, but the human must use shell
commands such as `termctrl list`, `status`, and `show` to know what is alive.
There is no browser view that inventories those sessions and previews the
current visible terminal screen.

## Solution

Add a fixed, read-only loopback WebUI at a capability URL issued by Krypton.
The page lists every local `termctrl` session, shows normalized status and
launch metadata, and polls the selected session's visible text screen. Krypton
invokes the installed `termctrl` CLI through its structured JSON boundary and
never reads Terminal Control's private socket protocol directly.

The first release deliberately excludes terminal input and lifecycle controls.
An SSH session, especially `root@host`, is a privileged execution surface; a
monitor may observe it, but browser controls must not silently become a second
remote keyboard.

## Research

- Terminal Control 0.4.1 exposes stable machine-readable commands:
  `termctrl list --json`, `termctrl status NAME --json`, and
  `termctrl show NAME`. Persistent sessions use owner-only local Unix sockets,
  and exited sessions retain their final visible screen until stopped.
- `termctrl show NAME` returns the visible viewport, which is the correct source
  for a TUI. `logs` is scrollback-oriented and does not represent an
  alternate-screen TUI faithfully.
- Terminal Control also exposes MCP and a Rust crate. MCP would require Krypton
  to supervise a second protocol process, while the crate's named-session
  functions are not its intended stable external boundary. The CLI JSON surface
  is smaller and version-tolerant.
- Krypton's hook server already serves fixed browser surfaces such as
  `/dashboard`, `/gallery`, `/commands`, and `/tools`. These pages use inline
  HTML/CSS/JS, relative JSON polling, `Cache-Control: no-store`, and the
  Binance-dark visual contract.
- A tokenless screen endpoint would widen Krypton's loopback exposure from
  harness metadata to arbitrary terminal contents. The existing artifact
  subsystem already has a 128-bit capability-token pattern, so the monitor uses
  a process-lifetime token in every page and API route.
- macOS GUI bundles do not reliably inherit the user's shell `PATH`. Binary
  discovery must check `TERMCTRL_BINARY`, process `PATH`, login-shell `PATH`,
  `~/.cargo/bin`, `/opt/homebrew/bin`, and `/usr/local/bin`, then invoke an
  absolute executable path without a shell.
- Spawning `termctrl` continuously while no page is open would violate
  Krypton's idle-cost constraint. The browser is the demand signal: polling
  exists only while the monitor page is visible and pauses on a hidden tab.

### Alternatives rejected

- **Writable xterm.js:** duplicates ttyd/Cockpit and crosses the privileged-input boundary.
- **Read sockets directly:** couples Krypton to Terminal Control's private protocol.
- **Embed the Rust crate:** increases compile and API-version coupling.
- **Run `termctrl mcp`:** useful for agents, unnecessary for list and screen reads.
- **Tokenless URL:** terminal contents deserve a narrower capability boundary.

## Prior Art

| App | Implementation | Design consequence |
| --- | --- | --- |
| Terminal Control | Named PTY sessions; `list`, `status`, and visible-screen `show`; owner-only Unix sockets | Treat it as the source of truth and preserve its session vocabulary |
| tmux | Background server plus named sessions; `choose-tree` shows a session hierarchy with a selected preview | Use a compact session roster with one selected screen preview |
| ttyd | Serves a terminal through the browser; clients are read-only unless `--writable` is explicitly enabled; supports origin checking | Keep WebUI observation-only by default and avoid a WebSocket in v1 |
| Cockpit | Authenticated browser terminal backed by a per-user bridge | Terminal access is a privileged user-session capability, not an anonymous dashboard |
| Krypton lane monitor | Fixed Binance-dark loopback page polling JSON only while open | Reuse the status-wall shell, relative polling, empty states, and no-store responses |

**Krypton delta:** unlike ttyd and Cockpit, this page does not create or attach a
browser terminal client. It inventories agent-controllable sessions and shows a
safe text preview. Unlike tmux tree mode, it lives in the OS browser and can
remain visible beside Krypton as an observability wall.

## Affected Files

| File | Change |
| --- | --- |
| `src-tauri/src/termctrl_monitor.rs` | New binary resolver, bounded CLI runner, JSON normalization, capability state, and unit tests |
| `src-tauri/src/hook_server.rs` | Embed the page; add capability-checked page, session-list, and screen routes plus route tests |
| `src-tauri/src/commands.rs` | Add `get_termctrl_monitor_url` Tauri command |
| `src-tauri/src/lib.rs` | Register the module and Tauri command |
| `src/acp/artifact-termctrl.html` | New fixed Binance-dark monitor page |
| `src/acp/artifact-termctrl.test.ts` | Page smoke tests for rendering, escaping, polling, visibility pause, and keyboard selection |
| `src/compositor.ts` | Add `openTermctrlMonitor()` using the capability URL command |
| `src/command-palette.ts` | Add `Open Terminal Control Monitor` action |
| `src/acp/hash-commands.ts` | Add discoverable `#termctrl` surface command and manifest metadata |
| `src/acp/hash-commands.test.ts` | Extend command-manifest coverage |
| `src/acp/acp-harness-view.ts` | Dispatch `#termctrl` through the same URL command |
| `DESIGN.binance.md` | Add the monitor to the loopback-surface visual contract |
| `docs/04-architecture.md` | Record the external CLI adapter and capability-gated routes |
| `docs/05-data-flow.md` | Add monitor-open, list-poll, and selected-screen flows |
| `docs/PROGRESS.md` | Record the implemented feature after verification |

## Design

### Data structures

```rust
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TermctrlSessionSummary {
    pub name: String,
    pub state: TermctrlSessionState,
    pub command: Vec<String>,
    pub cwd: Option<String>,
    pub cols: Option<u16>,
    pub rows: Option<u16>,
    pub recording: bool,
    pub idle_for_ms: Option<u64>,
    pub has_visible_content: bool,
    pub error: Option<String>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TermctrlSessionState { Running, Exited, Stale, Incompatible, Unknown }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TermctrlSessionList {
    pub schema_version: u8,          // 1
    pub available: bool,
    pub terminal_control_version: Option<String>,
    pub fetched_at: u64,
    pub sessions: Vec<TermctrlSessionSummary>,
    pub error: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TermctrlScreen {
    pub schema_version: u8,          // 1
    pub name: String,
    pub text: String,
    pub fetched_at: u64,
}
```

`TermctrlMonitor` owns one CSPRNG-generated 128-bit token for the Krypton
process lifetime, plus a cached successful binary resolution and version.
Failed discovery is retried, so installing `termctrl` does not require
restarting Krypton.

### API and commands

```rust
#[tauri::command]
pub fn get_termctrl_monitor_url(
    hook_server: State<'_, Arc<HookServer>>,
) -> Result<String, String>;
```

The command returns:

```text
http://127.0.0.1:<bound-port>/termctrl/<capability-token>
```

Loopback routes:

```text
GET /termctrl/{token}
    -> fixed HTML page

GET /termctrl/api/{token}/sessions
    -> TermctrlSessionList

GET /termctrl/api/{token}/screen/{name}
    -> TermctrlScreen
```

All responses use `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`,
and `Referrer-Policy: no-referrer`. An invalid token or invalid session name
returns a non-reflective `404`. Session names must match Terminal Control's
grammar: ASCII letters, digits, `.`, `-`, and `_` only.

The adapter runs the absolute binary directly with `tokio::process::Command`:

```text
termctrl list --json
termctrl show <validated-name>
termctrl --version                 # once per successful resolution
```

It never invokes a shell. Each command has a 2-second timeout,
`kill_on_drop(true)`, a 1 MiB combined-output cap, and sanitized error output.
The JSON parser tolerates unknown fields but rejects incompatible top-level
shapes. `TERMCTRL_RUNTIME_DIR`, when discovered from the process or login-shell
environment, is forwarded explicitly.

### Data flow

```text
1. Human selects "Open Terminal Control Monitor" or enters #termctrl.
2. Frontend invokes get_termctrl_monitor_url.
3. Rust returns the bound loopback URL containing the process-lifetime token.
4. Frontend opens the URL through the existing open_url command.
5. The page polls /sessions every 2 seconds while document.visibilityState is visible.
6. Rust resolves termctrl if needed, runs list --json, normalizes the response,
   and returns no-store JSON.
7. The page retains selection by session name and renders the roster.
8. When a running session is selected, the page polls its `/screen` route every
   second. An exited session is fetched once and its final screen is cached.
9. Rust validates the name, rejects leading dashes, runs `show NAME`, and
   returns plain text. A session name cannot become a CLI flag.
10. The page assigns the text through textContent into a <pre>; it never injects
    terminal output through innerHTML.
11. When the tab becomes hidden, both timers stop. On visibility return, one
    immediate list and screen refresh runs before timers resume.
```

Only one request of each kind may be in flight per page. A slow poll is skipped,
not queued.

### UI changes

The page follows `DESIGN.binance.md` as a fixed-dark status surface:

- A compact top band shows connection state, Terminal Control version, total
  sessions, running count, and last refresh time using tabular numerals.
- The body is a two-column master-detail layout. The left roster is 300 px wide;
  the right preview consumes the remaining width.
- Each roster row shows session name, normalized state, command basename,
  viewport, and recording indicator. Full command and cwd appear in a flat
  metadata strip above the selected preview.
- The selected row uses a full accent border plus tinted background, never a
  side-stripe rail. Green means running, red means error or incompatible,
  yellow means recording or reconnecting, and muted means exited or stale.
- The preview is a single `<pre>` on `--code-bg` with preserved whitespace,
  horizontal scrolling, and the shared mono font. It is visible text only: no
  ANSI, SVG injection, scrollback, cursor simulation, or secret persistence.
- Responsive layout becomes one column below 760 px. The roster remains first,
  and selection scrolls the preview heading into view.
- Empty states are actionable: `termctrl not found` includes the installation
  command; no sessions explains `termctrl start NAME -- COMMAND`; a vanished
  selection returns to the roster without an error modal.
- No page-load choreography. State changes use color and text; only the existing
  live status beacon animates, and it is disabled under reduced motion.

Keyboard behavior in the browser:

| Key | Action |
| --- | --- |
| `/` | Focus session filter |
| `j` / `k` or arrows | Select next or previous visible session |
| `r` | Refresh list and selected screen immediately |
| `Escape` | Clear filter, then blur it if already empty |

Mouse selection remains available but is secondary.

### Configuration

No TOML keys. Optional environment overrides:

| Variable | Purpose |
| --- | --- |
| `TERMCTRL_BINARY` | Absolute path or bare executable name for `termctrl` |
| `TERMCTRL_RUNTIME_DIR` | Existing Terminal Control runtime-directory override, forwarded unchanged |

## Security and privacy

- The WebUI is read-only. There are no HTTP routes for `send`, `stop`,
  `restart`, `resize`, `logs`, recording download, or artifact capture.
- The page and JSON endpoints require the unguessable token. The token is never
  exposed by a tokenless discovery route and expires when Krypton exits.
- Screen text is fetched only for the selected session and remains in browser
  memory. Krypton does not cache, log, or persist it.
- Command and cwd metadata are sensitive but necessary for identification; they
  are protected by the same token as screen text.
- The adapter passes argument arrays directly to the executable. Session names
  never enter a shell command, and names beginning with `-` are rejected before
  CLI execution. (`termctrl show -- NAME` means “run a disposable command,” so
  that separator cannot safely address a named session.)
- The capability comparison reads every byte for equal-length tokens. Tokens
  have a fixed 128-bit hex representation; a wrong token returns the same
  non-reflective `404` as an unknown route.
- The loopback server remains bound to localhost. DNS-rebinding and Host-header
  hardening for all existing loopback surfaces is a separate cross-cutting task.

## Edge cases

- **`termctrl` absent:** page stays usable and shows install guidance; discovery
  retries on later polls.
- **GUI PATH missing Cargo or Homebrew paths:** resolver checks login-shell PATH
  and standard install directories before reporting unavailable.
- **No sessions:** render the instructional empty state without polling screen.
- **Stale or incompatible socket:** keep the row visible with muted or red state;
  selecting it shows the non-sensitive error instead of repeatedly calling
  `show`.
- **Session exits while selected:** fetch and retain its final screen once,
  matching Terminal Control semantics, and stop the one-second screen poll.
- **Session disappears:** clear the selection and choose the first remaining
  session; show empty state if none remain.
- **Name contains route metacharacters:** reject before command execution.
- **Command hangs:** kill after 2 seconds and return a transient unavailable
  response; later polls retry.
- **Large screen output:** reject above 1 MiB rather than truncate invisibly.
- **Multiple browser tabs:** each tab polls independently; no shared background
  sampler is created. Server execution remains bounded by timeout and output cap.
- **Hidden browser tab:** polling stops completely.
- **Windows:** show that persistent Terminal Control sessions require macOS or
  Linux; do not present the install command as a fix for unsupported sockets.

## Tests and verification

- Rust parser fixtures cover running and stale normalization, unknown fields,
  malformed top-level JSON, and the defensive one-MiB cap. Separate tests cover
  session-name validation and argument construction, compatible version
  labels, and lossy decoding of non-UTF-8 visible text.
- Resolver and process tests cover an absolute executable override, rejection
  of relative multi-component overrides, combined-output overflow, non-zero
  exits without diagnostic leakage, a short timeout with child termination,
  and cached-path invalidation after a spawn failure.
- Hook-server tests cover route-table compatibility, capability URL/token shape,
  full-token comparison, and no-store/nosniff/no-referrer JSON headers. They do
  not claim end-to-end HTTP fixture coverage for every route response.
- Browser page source tests parse the production inline JavaScript and assert
  capability-relative requests, the `textContent` boundary, one-in-flight and
  visibility guards, modifier-safe keyboard controls, row-focus restoration,
  exited-screen caching, stable unavailable guidance, and the absence of
  writable session routes.
- Required checks after implementation:

```text
npm run check
npx vitest run src/acp/artifact-termctrl.test.ts src/acp/hash-commands.test.ts
cargo fmt -- --check
cargo clippy -- -D warnings
cargo test termctrl_monitor
cargo test hook_server
```

### Implementation notes

- The page smoke test is intentionally source-level: this repo has no
  browser-DOM test dependency. It validates the production script's parseability
  and its safety/interaction invariants without claiming fixture-driven DOM
  execution.
- A persistent live-session smoke test cannot survive the command harness,
  which reaps detached descendants after each command. The installed Terminal
  Control 0.4.1 source and actual CLI stale-session JSON were inspected; all
  temporary fixture sockets and lock files were removed.
- Final verification: `npm run check`, `npm run build`, 505 Vitest tests, 172
  Rust tests, `cargo fmt -- --check`, and `cargo clippy -- -D warnings` pass.

## Open questions

None. Writable WebUI control is intentionally deferred rather than left as an
approval ambiguity in this spec.

## Out of scope

- Sending keys or text from the browser.
- Starting, stopping, restarting, or resizing sessions.
- Converting an existing background session into a human-attached foreground
  session.
- Full ANSI color, structured cell rendering, SVG injection, cursor animation,
  scrollback, recordings, and video export.
- Remote access to the monitor outside the local machine.
- Replacing Terminal Control's MCP server for agent tools.
- Managing native Krypton PTY sessions through this page.

## Resources

- [Terminal Control README](https://github.com/anomalyco/terminal-control) - named sessions, list/status/show behavior, human sharing, sensitive recording notes, and owner-only sockets.
- [tmux Getting Started](https://github.com/tmux/tmux/wiki/Getting-Started) - server/client session model and choose-tree preview interaction.
- [tmux Control Mode](https://github.com/tmux/tmux/wiki/Control-Mode) - structured external inspection through list and show commands.
- [ttyd README](https://github.com/tsl0922/ttyd) - browser terminal prior art, read-only default, writable opt-in, origin checking, and client limits.
- [Cockpit terminal component](https://cockpit-project.org/guide/latest/api-terminal-html.html) - authenticated per-user browser terminal and bridge boundary.
- `docs/168-harness-lane-monitor.md` and `docs/169-dashboard-resource-status.md` - fixed loopback status surface, polling, idle-cost, and browser-page patterns.
- `DESIGN.binance.md` - visual contract for all loopback browser surfaces.
- `src-tauri/src/hook_server.rs` - router, no-store responses, capability tokens, and embedded-page patterns.
