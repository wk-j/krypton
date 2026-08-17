# Hurl Web Client — Implementation Spec

> Status: Implemented
> Date: 2026-08-17
> Milestone: N/A — new surface
> Builds on: `docs/65-hurl-client-window.md` (runner), `docs/198-termctrl-session-monitor.md` (capability-gated loopback page)

## Problem

The built-in Hurl client (spec 65) is a compositor pane: two-pane cyberpunk chrome, raw `hurl --color` ANSI, files as the only source of truth. That is the right *model*, but the wrong *surface* when the user wants a wide, browser-native runner (Bruno / Hoppscotch shape: file tree, highlighted source, pretty response, env switch) they can leave open beside Krypton. Rebuilding that inside `HurlContentView` fights the compositor density and the Binance loopback family already used for gallery / docs / termctrl.

## Solution

Add a **token-gated loopback page** at `GET /hurl/{token}`, opened in the OS browser. The page is a new UI only: same `.hurl` files, same `hurl.rs` child-process runner, same `*.env` `--variables-file` rule, same on-disk cache. The in-app `HurlContentView` (`Leader q`) stays. The web client does **not** become a request editor.

Auth copies termctrl (spec 198), not the tokenless gallery: running a `.hurl` file can hit real APIs and read env secrets, so a tokenless `/hurl` is out.

## Research

- **Runner already exists.** `src-tauri/src/hurl.rs` lists `*.hurl` + `*.env` (gitignore, no dotfiles), spawns `hurl --color --pretty --include`, streams `hurl-output` / `hurl-finished` Tauri events, caches last run per canonical path. Variables are `--variables-file` only (spec 65 Q12/Q13). The web page must call these functions, not reimplement HTTP.
- **Loopback split.** `hook_server.rs` serves OS-browser pages; `control.rs` is the authenticated harness controller (ADR-0005/0007). Hurl is not a harness operation. Follow termctrl: hook_server routes + a capability token, calling a Rust adapter. Do not add `hurl.*` control ops and do not route runs through the TypeScript frontend.
- **Termctrl is the template — and the warning.** `/termctrl/{token}` is process-lifetime, 128-bit, `no-store`/`nosniff`/`no-referrer`, 404 on bad token. It is **read-only** on purpose (spec 198: browser must not become a second keyboard). `/hurl` is a **run** surface. Same token shape, plus cwd binding and path confinement, recorded as a deliberate step up in capability.
- **In-app webview (spec 102) rejected.** Child WKWebViews paint above all DOM on macOS and must hide for every overlay. ADR-0002 already sent rich HTML to the OS browser. The user asked for a web UI, not another compositor pane.
- **Streaming.** Tauri events do not reach the browser. Fan `HurlState` output through a `tokio::sync::broadcast` so the in-app view can keep its existing events and the page can subscribe via SSE. Polling a growing buffer is worse for `--very-verbose`.
- **Highlight lives in TS** (`src/hurl-highlight.ts`). The loopback page is a single HTML file with inline JS (no Vite). Port the highlighter into the page script; do not add a Rust highlighter.

### Alternatives rejected

- **Tokenless `/hurl` like `/docs`.** Any local process could list env files and fire production requests.
- **Control API + pasted bearer.** Correct auth, hostile UX for a page Krypton itself opens.
- **Replace `HurlContentView`.** Keyboard-in-the-app workflow stays useful; retiring it is a separate spec.
- **In-page request editor / `.http` builder.** Breaks the spec 65 contract (files are the source of truth, `$EDITOR` edits).
- **Hoppscotch-style cloud collection.** Wrong storage model; we already have git-friendly `.hurl` files.

## Prior Art

| App | Implementation | Notes |
|-----|----------------|-------|
| Bruno | Sidebar collections + request + response; collections are `.bru` files on disk | Closest UX; we keep `.hurl` instead of `.bru` and do not add a form builder |
| Hoppscotch | Browser-first API client; collections live in a DB / workspace, not the repo | Surface inspiration only — web, wide, pretty JSON. Reject the storage model |
| Insomnia / Postman | GUI request editor, proprietary store | Explicitly not the target |
| VS Code REST Client | `.http` files, response in a side tab | File-as-spec matches; mouse-centric |
| posting (TUI) | Tree + editor + response, keyboard-first | Same job, different surface |
| Krypton spec 65 | In-app runner, no editor | Domain model we reuse |
| Krypton spec 198 | Capability URL + Binance-dark page | Transport and visual contract we reuse |

**Krypton delta** — Bruno's file-first runner rendered as a Hoppscotch-shaped browser page, served like termctrl, executing the existing `hurl` binary. No collection format, no cloud, no request builder. Green/red are exit-code semantics only (DESIGN.binance.md).

## Affected Files

| File | Change |
|------|--------|
| `src-tauri/src/hurl.rs` | Extract list/run/cancel/cache/env from Tauri-only wrappers; add `broadcast` fan-out; add `HurlWebSessions` (token → cwd) |
| `src-tauri/src/hook_server.rs` | Embed page; add `/hurl/{token}` + JSON/SSE API; route-existence + token tests |
| `src-tauri/src/commands.rs` | `get_hurl_web_url(cwd)` |
| `src-tauri/src/lib.rs` | Forward broadcast → existing Tauri `hurl-output` / `hurl-finished` so spec 65 does not break |
| `src/acp/artifact-hurl.html` | New Binance-dark page |
| `src/compositor.ts` | `openHurlWebClient()` — focused cwd, `open_url` |
| `src/command-palette.ts` | "Open Hurl Web Client" |
| `src/acp/hash-commands.ts` | `#hurl` opens the web client (in-app window stays `Leader q`) |
| `DESIGN.binance.md` | Add the Hurl web client to `appliesTo` + surface table |
| `docs/04-architecture.md`, `docs/05-data-flow.md` | Record the surface and run flow |
| `docs/06-configuration.md` | Point `[hurl]` at both surfaces; no new keys |

## Design

### Data structures

```rust
pub struct HurlWebSession {
    pub token: String,   // 128-bit hex, CSPRNG
    pub cwd: String,     // canonical at issue time
    pub created_at: u64,
}

pub struct HurlWebSessions {
    // one session per canonical cwd; reopen returns the same URL
    by_cwd: Mutex<HashMap<String, HurlWebSession>>,
    by_token: Mutex<HashMap<String, HurlWebSession>>,
}

pub enum HurlEvent {
    Output { run_id: u64, stream: &'static str, chunk: String },
    Finished { run_id: u64, exit_code: i32, duration_ms: u64 },
}
```

`HurlState` gains `events: broadcast::Sender<HurlEvent>` (capacity 64). `stream_reader` and the wait task publish here. A lib.rs subscriber re-emits the current Tauri events unchanged.

### API / commands

```rust
#[tauri::command]
pub fn get_hurl_web_url(
    hook_server: State<'_, Arc<HookServer>>,
    cwd: String,
) -> Result<String, String>;
// -> http://127.0.0.1:<port>/hurl/<token>
```

`cwd` is `getFocusedCwd() ?? app cwd` (same as `openHurlClient`). Canonicalize; reject if not a directory.

Loopback routes (all `no-store` / `nosniff` / `no-referrer`; bad token → non-reflective `404`):

```
GET  /hurl/{token}                         HTML page
GET  /hurl/api/{token}/listing             HurlListing for session.cwd
GET  /hurl/api/{token}/source?path=        raw UTF-8 of a confined .hurl file
GET  /hurl/api/{token}/env?path=           parsed KEY=VALUE map (confined *.env)
GET  /hurl/api/{token}/cache?path=         Option<HurlCachedRun>
POST /hurl/api/{token}/run                 { path, verbose, veryVerbose, variablesFile? } -> { runId }
GET  /hurl/api/{token}/events/{runId}      SSE: event=output | event=finished
POST /hurl/api/{token}/cancel              { runId }
GET  /hurl/api/{token}/state               persisted sidebar state for cwd
PUT  /hurl/api/{token}/state               same shape as HurlSidebarState
                                       (spec 65 file:
                                       <app_cache_dir>/hurl/state/<sha256(cwd)>.json)
```

**Path confinement.** Every `path` / `variablesFile` is `canonicalize`d and must be a prefix of `session.cwd` (cwd + `MAIN_SEPARATOR`). Source must end in `.hurl`; env in `.env`; no dotfiles. One run at a time per session; `POST /run` while running cancels and restarts (spec 65 Q8).

The page never sees a filesystem root. `listing` is the only enumeration.

**Sidebar state.** The web client reads and writes the same
`HurlSidebarState` file as `HurlContentView` (spec 65):
`<app_cache_dir>/hurl/state/<sha256(cwd)>.json`. `expanded` is the set of
open folder relPaths — a folder not in the list is collapsed. The page
loads `/listing` first (no paint), then `/state`, then renders. No state
file uses the in-app first-run default (each file's parent dir open).
Click, `h`, and `l` persist on the same 300ms debounce. A first paint
must not default missing folders to open — that was clobbering collapses
saved by either surface.

### Data flow

```
1. Palette / #hurl → compositor.openHurlWebClient()
2. invoke get_hurl_web_url({ cwd }) → capability URL
3. open_url(url) — user-triggered, never auto-open
4. Browser GET /hurl/{token} → page; GET /listing then GET /state
   (apply `expanded` before the first tree paint; missing folder = collapsed)
5. j/k select a file → GET /source + GET /cache (show last run if any)
6. Enter/r → POST /run; EventSource /events/{runId} appends chunks
7. finished → render Pretty/Raw/Headers; PUT cache via existing hurl_save_cache
   (hook_server calls the same function the in-app view uses)
8. Hidden tab: EventSource stays open for the active run; no listing poll
   while document.hidden (termctrl demand-signal rule)
```

### Keybindings

Browser page (when not typing in the filter):

| Key | Action |
|-----|--------|
| `j` / `k` | Move file selection |
| `h` / `l` / `Enter` | Collapse / expand / run (dir vs file, same as spec 65) |
| `r` | Run selected |
| `x` | Cancel |
| `o` | Focus source ↔ response |
| `1` / `2` / `3` | Pretty / Raw / Headers |
| `v` / `V` | Verbose / very-verbose |
| `E` | Cycle env file (none → each `*.env`) |
| `/` | Focus filter |
| `Escape` | Clear filter |
| `y` | Copy Pretty (or Raw if Pretty empty) |

`Leader q` is unchanged (in-app). No new compositor chord.

### UI

Single Binance-dark page (`src/acp/artifact-hurl.html`), same tokens as `artifact-termctrl.html`. One bordered workspace, not nested cards. The page is an app shell (`html/body` at `100%` height, `body`/`main` column flex): `.workspace` fills the remaining viewport so the file tree, source, and response scroll *inside* their panes. Do not use `min-height` alone on `.workspace` — without a definite height, CSS grid `fr` rows grow with content and a repo with hundreds of `.hurl` files stretches the page tens of thousands of pixels.

```
header.topbar     brand "Hurl" · cwd basename · env <select> · v/VV chips · Run
div.workspace     (one card)
  aside.roster    filter + folder tree (FILES) / last-20 runs (HISTORY)
  section.main
    pre.source    highlightHurl port
    div.response  tabs Pretty | Raw | Headers + viewport
footer.status     EXIT · duration · bytes · env name · ring-free tabular nums
```

**Pretty:** split `hurl --include` into stacked exchanges (status line, header table, body). If body parses as JSON, pretty-print in a `<pre>`; otherwise escaped text. Status `2xx` uses `--add`, other uses `--del`. **Raw:** ANSI→HTML (port `hurl-ansi.ts`). **Headers:** name/value table only.

Empty: "No `.hurl` files under `<cwd>`. Add one and press `.` to refresh." Missing binary: the listing endpoint returns `{ available: false, error: "hurl binary not found" }` and the page shows the install URL, no Run.

No left accent rails. No second accent hue. No `backdrop-filter`.

### Configuration

No new TOML. `[hurl].binary_path` already feeds `get_binary`. Extra args from config are **not** honored on the web path in v1 (smaller attack surface; in-app keeps them).

## Edge Cases

- **Unknown / revoked token:** 404, empty body. Tokens live for the Krypton process; there is no revoke-on-close in v1 (matches termctrl).
- **cwd deleted after issue:** listing returns 400 with a stable error; page shows it and disables Run.
- **File changed on disk during a run:** run continues; next select reloads source.
- **Non-UTF-8 source:** `source` returns 415; page shows "binary or invalid UTF-8".
- **Output cap:** reuse 1 MiB combined; SSE sends a final `truncated` field on finish.
- **Two tabs, same token:** both may EventSource the same `runId`; broadcast makes that free. Two tabs posting Run serialize per session.
- **CORS:** none. Same-origin only. No `cors_origins` for this surface.
- **Host rebinding:** pre-existing hook_server posture; out of scope.

## Open Questions

None — the surface (OS browser), auth (capability token), and editor-or-not (not) forks are resolved above. Changing any of them is a spec revision, not an implementation surprise.

## Out of Scope

- Retiring or restyling `HurlContentView`
- In-app webview host
- Visual request builder, GraphQL, WebSocket
- Writing `.hurl` / `.env` from the page (still `$EDITOR` / in-app `e`)
- Sharing the URL off-machine
- History persisted beyond the existing per-file cache + in-page last-20

## Resources

- [Hurl manual](https://hurl.dev/docs/manual.html) — `--include`, `--variables-file`, `--verbose`, exit codes
- [Bruno](https://www.usebruno.com) — file-first sidebar + response layout
- [Hoppscotch](https://hoppscotch.io) — browser-native API client; rejected storage model
- `docs/65-hurl-client-window.md` — runner contract kept intact
- `docs/198-termctrl-session-monitor.md` — capability URL, demand-signal polling, Binance page
- `docs/adr/0002-html-artifacts-open-in-os-browser.md` — OS browser, not webview
- `DESIGN.binance.md` — visual contract for hook_server pages
