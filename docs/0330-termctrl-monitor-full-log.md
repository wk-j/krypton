# Terminal Control Monitor Full Log View — Implementation Spec

> Status: Implemented (approved by the user, 2026-10-24: "OK, let implmeent, also fix ascii ui issue")
> Implemented: 2026-10-24
> Date: 2026-10-24
> Milestone: ACP Harness: observability
> Builds on: `docs/0198-termctrl-session-monitor.md`

## Problem

The Terminal Control monitor (`#termctrl`) shows only `termctrl show NAME`, the
visible viewport (80×24 for a default session). A user watching a server log
inside a named session, such as `docker logs` over `ssh`, cannot scroll back,
follow new lines, or search the retained output in the browser.

## Solution

Add a **Log** view next to the existing **Screen** view. Krypton serves the
session's raw retained PTY bytes (`termctrl logs NAME --ansi`) through a new
token-gated route that returns only the bytes the page has not seen. The page
turns ANSI into plain text with a small stateful decoder, appends it to a
scrollable `<pre>`, and follows the tail like `less +F`. Raw bytes were chosen
because readable `logs` keeps only one or two emulator pages; the decoder lives
in the page because Krypton's backend does no VT parsing.

## Research

- **Readable `logs` is not the full log.** It is Ghostty's rendered history
  (`terminal_core.rs:148-158`). termctrl passes `SCROLLBACK_ROWS = 10_000`
  (`terminal_core.rs:16`), but Ghostty reads that field as bytes
  (`Screen.zig:282`) and raises it to its minimum of about two pages.
  - Measured on 1.2.1 with `seq 1 20000`: readable `logs` kept 1,088 lines at 80
    columns and 246 lines at 200 columns. `logs --ansi` kept all 128,895 bytes.
  - Readable text is hard-wrapped at the session width and reflows on resize.
- **`logs --ansi` is the complete retained output.** It is a raw PTY-output
  ring capped at the launch `max_bytes` (default 16 MiB). When the ring is full
  it drops the oldest bytes and sets `logs_truncated`, which never resets
  (`session.rs:788-809`).
  - Measured: a 600,000-line session returned exactly 16,777,216 bytes in
    289–294 ms. The ring started mid-line.
  - `saraban` (the user's ssh session): 27,442 raw bytes against 26,655 readable
    bytes, fetched in 7 ms.
- **No incremental read exists.** The CLI, socket protocol, `driver`, and the
  nine MCP tools have no offset, cursor, tail, or follow mode, and no output
  counter. Every `logs` call re-serializes the whole buffer as a JSON number
  array on the single-threaded session daemon. `idle_for_ms` (time since the
  last PTY output) is the only cheap "anything new?" signal.
- **Krypton constraints.**
  - The backend does no VT parsing (architecture constraint 3).
  - Spec 198: the page uses text only, through `textContent`; Krypton keeps no
    terminal text; the browser polls only while the tab is visible.
  - `run_bounded` caps output at 1 MiB and 2 s, too small for a 16 MiB ring.
  - There is no `memchr` dependency; a plain slice search is enough here.

### Alternatives rejected

- **Readable `logs`:** bounded to 1–2 pages, width-dependent, and reflows on resize.
- **xterm.js in the page:** faithful colour, but the hook server would have to
  serve the xterm bundle and the page would stop being self-contained. Colour
  stays out of scope, as in spec 198.
- **ANSI stripping in Rust:** violates constraint 3.
- **Tailing a `--record` JSONL:** the recording must be chosen at start, and it
  records input bytes, including typed secrets.
- **Krypton-side cache or background sampler:** breaks spec 198's no-cache
  promise and the idle-cost rule.

## Prior Art

| App | Implementation | Design consequence |
| --- | --- | --- |
| Dozzle | Browser log viewer for containers: live stream, regex search, split view, no stored logs | Live tail in the browser with no Krypton-side store |
| less | `F` scrolls forward and keeps reading at end of file; `G`/`g` jump to end/start | `G` follows, `g` goes to the top; scrolling up pauses follow |
| tmux | `capture-pane -p -S -` prints the whole history, bounded by `history-limit` | Full retained history is one read; the bound belongs to the producer |
| kitty | `kitten @ get-text --extent all` returns screen plus scrollback | Same "screen vs all" split as Screen vs Log |
| WezTerm | `wezterm cli get-text --start-line N` (negative = scrollback) | Line ranges are emulator-dependent; Krypton uses the raw stream instead |

**Krypton delta:** unlike tmux, kitty, and WezTerm, the history source is the
raw byte ring, not an emulator grid, because Terminal Control's grid history is
about two pages. Unlike Dozzle, there is no server-side stream or index: the
page pulls deltas only while it is visible and the session has new output.
Search is the browser's native find (`Cmd/Ctrl+F`), so the page adds no search UI.

## Affected Files

| File | Change |
| --- | --- |
| `src-tauri/src/termctrl_monitor.rs` | `log()` adapter, `log_delta()`, per-call output limit/timeout, `logs_truncated` in status and summary, tests |
| `src-tauri/src/hook_server.rs` | `GET /termctrl/api/{token}/log/{name}` handler, router entry, route-table test |
| `src/acp/artifact-termctrl.html` | Screen/Log toggle, log `<pre>`, follow state, delta polling, second inline script with the ANSI text decoder, Screen view on the cell grid |
| `src/acp/artifact-termctrl.test.ts` | Decoder behaviour tests; page behaviour tests (happy-dom, mocked API) |
| `src/acp/loopback-cell-grid.ts` | **New.** Exposes `gridifyText` (specs 324/326) to the loopback page as `window.KryptonCellGrid` |
| `vite.loopback.config.ts`, `package.json` | **New** library build of that entry into `dist/loopback/`; `npm run build` runs it |
| `src-tauri/src/hook_server.rs` (assets) | `GET /termctrl/assets/{cell-grid.js,cell-grid.css}`; `genui_gallery_asset` renamed `frontend_dist_asset` |
| `e2e/cases/loopback-api-authorization.ts` | Forged token on the log route → `404`, empty body |
| `docs/0198-termctrl-session-monitor.md` | Mark the "no `logs` route" and "scrollback out of scope" lines as superseded by 330 |
| `docs/0326-cell-grid-for-all-output.md` | "Extended by 330" note |
| `docs/0004-architecture.md`, `docs/0005-data-flow.md` | Log route, asset route and log flow |
| `DESIGN.binance.md` | Monitor row: Screen and Log views |
| `docs/README.md` | Index entry 330 |

## Design

### Data Structures

```rust
const LOG_OUTPUT_LIMIT: usize = 32 * 1024 * 1024; // above the 16 MiB default ring
const LOG_TIMEOUT: Duration = Duration::from_secs(5);
pub const LOG_ANCHOR_MAX: usize = 64;

pub struct TermctrlLogCursor { pub length: usize, pub anchor: Vec<u8> } // anchor ends at `length`
pub enum TermctrlLogMode { Append, Reset }
pub struct TermctrlLogChunk {
    pub mode: TermctrlLogMode,
    pub length: usize,     // retained ring length at this read
    pub truncated: bool,   // termctrl logs_truncated
    pub bytes: Vec<u8>,    // suffix (Append) or the whole ring (Reset)
}
// RawStatus gains #[serde(default)] logs_truncated: bool;
// TermctrlSessionSummary gains logs_truncated (JSON `logsTruncated`).
```

`run_bounded` takes the limit and timeout as arguments. `list`, `show`, and
`--version` keep 1 MiB and 2 s.

### API

```text
GET /termctrl/api/{token}/log/{name}?length=<usize>&anchor=<hex, ≤128 chars>
  200 application/octet-stream, no-store, nosniff, no-referrer
      X-Termctrl-Log-Mode: append | reset
      X-Termctrl-Log-Length: <ring length>
      X-Termctrl-Log-Truncated: true | false
  404 bad token or invalid session name (non-reflective, as in spec 198)
  503 {"error":"session log unavailable"} | {"error":"session log exceeds 32 MiB"}
```

A missing or malformed cursor means Reset. `TermctrlMonitor::log(name, cursor)`
runs `logs NAME --ansi` and then `status NAME --json` with the same validated
argv rules as `show`. Running `status` second matters: `logs_truncated` only
ever turns on, so "not truncated" after the read also holds at the read.

`log_delta(buffer, truncated, cursor)` is a pure function:

1. No cursor, or an empty anchor → Reset.
2. Not truncated: the ring has only grown. If `length ≤ buffer.len()` and the
   anchor equals `buffer[length-anchor.len()..length]` → Append from `length`.
   Otherwise → Reset.
3. Truncated: the anchor must occur exactly once in `buffer`. If it does →
   Append after that occurrence. If it is absent or ambiguous → Reset.

Krypton keeps nothing between requests; the page owns the cursor.

### Data Flow

```text
1. User presses `v` (or clicks Log). The page shows the Log view for the
   selected session.
2. The first fetch has no cursor → Reset → the whole ring. The page decodes it
   and records length plus the last ≤64 bytes as its cursor.
3. A 1 s tick fetches again only when all of these hold:
   - Log view active, tab visible, no log request in flight.
   - The session has new output: the list's fetchedAt − idleForMs is later
     than the previous log fetch (minus 1 s slack).
   - At least max(2 s, 10 × the previous read's fetch time) has passed; a ring
     that decoded to no line output (step 4) waits at least 30 s.
4. Append → decode only the new bytes into new lines. Reset → clear the view
   and decode the whole ring. If truncated, drop the partial first line.
5. If following, scroll to the end. Otherwise count the unseen lines.
6. An exited session is fetched once and kept until the selection changes.
   Stale and incompatible sessions are never fetched.
7. Hidden tab, switching to Screen, or changing selection stops log fetches.
   Changing selection discards the log state.
```

### ANSI Text Decoder (page, second inline `<script>`)

`createAnsiText()` returns `{ push(bytes) → { lines: string[], open: string } }`.
It keeps state across chunks: `TextDecoder('utf-8', { stream: true })`, the
escape-parser state, the open line, and the cursor column.

- Printable characters overwrite at the column. `\n` commits the line. `\r`
  moves to column 0. `\b` moves back one column. `\t` moves to the next
  multiple of 8.
- CSI `K` (0/1/2), `C`, `D`, `G`, `P`, `X`, and `@` edit the open line. Every
  other CSI is ignored, including SGR colour and `H`/`J` (clear never erases
  history).
- OSC, DCS, APC, PM, and SOS strings are skipped through BEL or ST. Other ESC
  sequences and C0/C1 controls are dropped.
- Alternate screen: CSI `?1049h`, `?1047h`, and `?47h` commit the open line,
  add one marker line `⟨full-screen app output hidden⟩`, and suppress output
  until the matching `l`.
- `{ dropFirstLine: true }` (a reset after termctrl dropped the ring's head)
  discards everything up to the first `\n`, so the view never starts mid-line.
- Columns count code points; combining marks (`\p{M}`, ZWJ, variation
  selectors) join the column before them, so Thai survives a `\r` overwrite.
  Wide characters still count as one column.

### Screen view on the cell grid (added at approval)

The approval also asked to fix the Screen view: btop's borders landed on
different columns (row right edges measured 578–622 px for 80-column rows),
because box, block and braille glyphs fell back to fonts with other advances.
The Screen view now uses the harness cell grid (specs 324/326) instead of a
second implementation:

- `src/acp/loopback-cell-grid.ts` imports `gridifyText` from `cell-grid.ts` and
  sets `window.KryptonCellGrid`, then fires `krypton-cell-grid-ready`.
  `vite.loopback.config.ts` builds it as an ES library into
  `dist/loopback/cell-grid.{js,css}`, the same way spec 313 ships the GenUI
  renderer to a browser page.
- `GET /termctrl/assets/{cell-grid.js,cell-grid.css}` is tokenless (static code,
  no session data). Release builds serve the embedded `dist` asset; debug builds
  redirect to the Vite dev server at `http://localhost:1420/` (Vite binds
  `localhost`, which can be IPv6-only).
- The page sets the screen with `textContent`, then calls `gridifyText` if the
  module is loaded, and once more on `krypton-cell-grid-ready`. Unchanged text
  is not repainted, so a selection survives the one-second poll. Without the
  module the screen stays plain text.
- The Log view stays plain text: gridding up to 200,000 lines is too costly, and
  full-screen apps belong to the Screen view.

### Keybindings

| Key | Context | Action |
| --- | --- | --- |
| `v` | page | Toggle Screen / Log |
| `G` | Log view | Jump to the end and follow |
| `g` | Log view | Jump to the top (follow pauses) |
| `w` | Log view | Toggle line wrap |
| `r` | page | Refresh now (existing). In Log, forces one fetch past the gates |
| `Cmd/Ctrl+F` | page | Browser find (the handler already ignores modified keys) |

### UI Changes

- The preview head gets a two-button segmented control, `Screen` and `Log`
  (`aria-pressed`, full 1px borders, accent when active).
- The Log view is `<pre class="log" tabindex="0">` with the same surface as
  `.screen`, `white-space: pre-wrap` (toggled to `pre` by `w`), and native
  keyboard scrolling when focused.
- DOM: one text node per appended chunk plus one trailing text node for the
  open line. Nothing is written with `innerHTML`. The view keeps at most 200,000
  lines and drops the oldest chunks past that.
- Corner badge: `FULL LOG · 12,345 lines · 1.2 MiB · following`. While paused
  it reads `paused · 37 new · G`. When truncated or trimmed it adds
  `older output dropped`.
- The footer adds `v screen/log · g G top/end · w wrap · log on new output`.
- A ring that decodes to no lines at all (a full-screen app whose start was
  dropped) adds `no line output · full-screen app? v for Screen` to the badge.

### Configuration

None.

## Edge Cases

- **Full-screen apps (btop, vim):** the Log view shows the marker line for
  their output; the Screen view stays the way to watch them.
- **Full-screen app whose alt-screen start was dropped from the ring:** its
  redraws carry no `\n`, so the reset decodes to nothing. The badge says so and
  the ring is re-read every 30 s instead of every few seconds.
- **`termctrl restart`, or a new session with the same name:** the anchor
  fails → Reset.
- **Ring larger than 32 MiB** (started with a large `--max-bytes`): 503, and
  the badge shows `session log exceeds 32 MiB`.
- **Repetitive output with no timestamps after the ring wraps:** an ambiguous
  anchor → Reset each time. The result is correct but costs more; the
  adaptive interval bounds it.
- **A failed `list` poll:** the page keeps the last roster and selection, so a
  hiccup cannot switch the Log view to another session's 16 MiB ring.
- **Session daemon stall:** each 16 MiB read blocks the daemon for about
  0.3 s. The 10× duration gap keeps this below 10% of wall time.
- **Older termctrl without `logs --ansi`:** 503 "session log unavailable".
  The Screen view still works.
- **Secrets:** raw bytes can carry OSC 52 clipboard payloads and hyperlinks.
  They are stripped from display but reach browser memory, under the same token
  tier as the screen. Krypton does not cache, log, or persist them.
- **Multiple tabs:** each keeps its own cursor and polls independently.

## Open Questions

None.

## Out of Scope

- Colour, termctrl's structured cell JSON, the cell grid in the Log view,
  download or export, and server-side search or filter.
- An upstream incremental-read API, and the upstream `SCROLLBACK_ROWS` unit
  bug (report to Terminal Control separately).
- Listing exited and stale sessions: since Terminal Control 1.1.0,
  `list --json` returns running sessions only. Krypton needs `list --all --json`
  for spec 198's exited and stale states, and that is a separate fix. Until
  then, the exited-log path in step 6 is reachable only after the fix.
- A stale version label after an in-place `termctrl` upgrade (separate fix).
- Any input, lifecycle, or resize control. The route stays read-only.

## Tests and Verification

- Rust (`termctrl_monitor`): `log_delta` resets without a cursor, appends by
  length while the ring only grew (even with a repeated anchor), resets on a
  mismatch or a length past the end, appends after a unique anchor once the
  ring dropped bytes, and resets on a missing or repeated anchor. Cursor
  parsing accepts only ≤128 hex characters; `logs_truncated` defaults to false.
- Hook server: route-table entries for the log and asset routes. The e2e case
  `loopback-api-authorization` checks a forged token on the log route.
- Page (`artifact-termctrl.test.ts`, happy-dom, real page scripts against a
  mocked API):
  - decoder: `\r`, `\b`, `\t`, EL, CUB; colours, titles and OSC 8 links; an
    escape and UTF-8 split at every byte; the alt-screen marker; `dropFirstLine`;
  - the Log view renders terminal text as text, sends the cursor
    (`length`, hex `anchor` of the last 64 bytes) and appends;
  - a truncated reset starts at the first whole line;
  - a failed list keeps the selection;
  - the screen is gridded when the module arrives late;
  - every request is a GET of a read route.

## Implementation Notes

- Smoke against the real adapter (a throwaway axum example serving the page and
  `TermctrlMonitor`, since deleted) in headless Chromium:
  - btop Screen: all 24 rows end at the same x (560.2 px), cells 7 px, rows
    19 px, and box lines join between rows.
  - `saraban` (ssh): one `reset` of 27,442 bytes, then no reads while the
    session was idle; the log starts at the SSH banner.
  - A ticking session: one `reset`, then `append`s of 90–108 bytes; scrolling up
    showed `paused · 12 new · G`, and `G` resumed following. `w` and `g` work.
  - 600,000 lines past the 16 MiB ring: first paint in 1.8 s with
    `200,000 lines · 16.0 MiB · older output dropped`, then `append`s of
    384–744 bytes on the wrapped ring (≈650 ms each in a debug build, mostly
    the anchor search).
  - The debug asset path: the Vite dev module loads cross-origin from
    `localhost:1420` and grids a block.
- termctrl itself: one `termctrl wait` issued during a 600,000-line flood got
  `read session response: EOF` and the session daemon was gone afterwards. The
  same flood with the monitor polling `list` every 2 s survived. Not a Krypton
  path; worth reporting upstream.
- Separate finding: the GenUI gallery's debug redirect still targets
  `127.0.0.1:1420`, which fails when Vite listens on `[::1]` only. Left
  unchanged here.

## Revision — spec 341 loopback app

- The page is now the `termctrl` entry of the loopback app:
  `src/loopback/entries/termctrl.ts` mounts `TermctrlView`
  (`src/loopback/surfaces/termctrl/index.ts`, `termctrl.css`). Rust returns
  `AppPage::new("termctrl", …)`; token and `/termctrl/api/<token>/…` routes are
  unchanged.
- The inline ANSI decoder is `src/loopback/surfaces/termctrl/ansi-text.ts`
  (`createAnsiText`). The Screen view imports `gridifyText` and
  `cell-grid.css` directly, so `src/acp/loopback-cell-grid.ts`,
  `window.KryptonCellGrid`, the `krypton-cell-grid-ready` event,
  `handle_termctrl_asset` and `/termctrl/assets/{name}` are gone.
- Kit: `RosterList` (own wrap-around `j`/`k`/↑/↓ bindings), `SearchFilter`,
  `StatBar` (version, sessions, last refresh), toggle `button`s for
  Screen/Log, `kbdHints`, `keymap()` for `/ Esc r v g G w`, and three `poll()`
  loops (list 2 s, screen 1 s, log 1 s with the `length`/`anchor` cursor), all
  paused while hidden.
- Visual: the page header is the app shell; one `dot('live')` for the
  connection (no scale beacon, no skeleton shimmer); the selected session has
  a full accent border; labels are sentence case (`Visible screen`,
  `Full log`).
- Tests: `src/loopback/surfaces/termctrl/termctrl.test.ts` (decoder cases,
  retained log + reset, selection kept across a failed poll, screen as text)
  replaces `src/acp/artifact-termctrl.test.ts`; the CSS-literal assertion was
  dropped.

## Resources

- [Dozzle README](https://github.com/amir20/dozzle) — live browser log viewer, regex search, no stored logs.
- [less(1)](https://man7.org/linux/man-pages/man1/less.1.html) — `F` follow-at-end semantics and `g`/`G`.
- [tmux(1) capture-pane](https://manpages.debian.org/testing/tmux/tmux.1.en.html) — `-S`/`-E` history ranges bounded by `history-limit`.
- [kitty `@ get-text`](https://manpages.debian.org/testing/kitty/kitten-@-get-text.1.en.html) — `--extent screen|all`.
- [WezTerm `cli get-text`](https://wezterm.org/cli/cli/get-text.html) — negative start lines address scrollback.
- terminal-control 1.2.1 crate source (`session.rs`, `terminal_core.rs`, `main.rs`, `mcp.rs`, `driver.rs`) and Ghostty `a887df42` (`Screen.zig`, `PageList.zig`, `formatter.zig`) — retention, formats, and the absence of incremental reads.
- `docs/0198-termctrl-session-monitor.md`, `src-tauri/src/termctrl_monitor.rs`, `src/loopback/surfaces/termctrl/` — current monitor contract.
