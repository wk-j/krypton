# ACP Wire Profiler — Implementation Spec

> Status: Implemented
> Date: 2026-10-13
> Milestone: ACP Harness: observability

> **Revision — spec 341 loopback app.** The page is no longer the
> self-contained `src/acp/artifact-acpwire.html` (deleted). Both
> `/acp-wire/{token}` and `/acp-wire/{token}/message/{seq}` return an
> `AppPage` for entry `src/loopback/entries/acp-wire.ts`; the surface lives in
> `src/loopback/surfaces/acp-wire/` (`index.ts` view, `model.ts` held ring /
> grouping / stats, `waterfall.ts` SVG, `json-tree.ts` readable payload,
> `acp-wire.css`, `acp-wire.test.ts`). Kit usage: `poll()` (1 s, paused while
> hidden or on Space), `fetchJson`, `StatBar` tiles, `Banner` (capture-off
> notice, copy status), `SearchFilter` (`/`), `DataTable` (By method),
> `keyValue`, `card`, `kbdHints`, toggle `button`s for lane/dir/readable-raw,
> and every key through `keymap()` gated per mode (dashboard vs message).
> The message table is a surface-local `reconcile` list (gap and group rows).
> Visual normalisation: the shell replaces the brand bar and READ ONLY badge,
> one `dot('live')` beacon, lowercase labels, token colors only. References
> below to the old HTML file describe the original implementation.

## Problem

Krypton has no way to see or measure what flows between the UI, the Rust ACP
client, and each agent subprocess. Debugging a slow turn, a chatty adapter, or a
heavy Rust→UI event stream means guessing: `acp.rs` logs only stderr and dropped
lines at `debug!`, and the log plugin is pinned to `Info` (`lib.rs:408`), so even
those never land.

## Solution

Add an opt-in **wire tap** in Rust at the three choke points every ACP message
already passes through, record into a bounded in-memory ring buffer with
request↔response correlation, and serve a read-only **capability-token loopback
page** (`/acp-wire/{token}`) that shows live stats, a per-lane waterfall, a
message table with payload detail, and a per-method breakdown. Capture mode
(`off` / `meta` / `full`) is switched from the command palette; the page never
mutates capture state.

## Research

- **Choke points (verified).** All outbound traffic — requests, notifications,
  replies — serializes in `AcpClient::write_line` (`acp.rs:637`). All inbound
  lines, local *and* remote lanes, enter `dispatch_output_line` (`acp.rs:741`,
  called from `run_reader` and `run_remote_reader`). All Rust→UI traffic is
  `AcpClient::emit_event` (`acp.rs:669`, event `acp-event-{session}`, payload
  discriminated by `type` and, for `session_update`, `kind`). New backends and
  transports inherit capture with no extra code.
- **Shim/devtools ruled out.** A PATH shim cannot see Antigravity (absolute path
  from `acp_install::resolve`, `acp.rs:1862`), needs per-host setup for remote
  lanes, and misses the UI hop; release builds ship without the `devtools`
  feature.
- **Loopback conventions.** Pages are `include_str!`-embedded and served by
  `hook_server.rs` (`html_response`, router in `start()` plus the test router
  copy). Read-only *metadata* pages are tokenless (ADR-0010); pages exposing
  *content* use a process-lifetime capability token in the path with a
  constant-time compare (`/termctrl/{token}`, spec 198). Prompts, file contents
  and tool output put this surface in the second tier. Pages are opened by
  `get_*_url` → `open_url` from a palette entry (`compositor.ts:3982`,
  `command-palette.ts:910`).
- **Hot path.** `write_line` holds the transport mutex while writing; inbound
  dispatch is on the reader task. Recording must be O(1), allocation-light, and
  never await. A `std::sync::Mutex<VecDeque>` push is sub-microsecond; no disk
  I/O on the hot path means no channel/writer task is needed.
- **Idle cost.** With capture `off` the cost is one `AtomicU8` load per message.
  The page polls only while visible (same pattern as spec 198).

### Alternatives rejected

- **Always-on capture (Zed style).** Violates the idle-cost constraint and keeps
  prompt content in memory without the user asking.
- **Continuous JSONL disk sink in v1.** Persists sensitive payloads by default
  and adds rotation/retention policy; on-demand export covers the need.
- **In-app profiler view.** Thousands of repainting rows compete with the
  terminal's 16 ms render budget and perturb the measurement itself.
- **Tokenless page.** Payload detail exposes prompts and file contents.

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| Zed `dev: open acp logs` | Taps stdio lines in `agent_servers/src/acp/transport.rs`; per-connection `VecDeque` capped at 2000; direction `Incoming/Outgoing/Stderr`; UI correlates method by `(direction, id)` | Always on; no timestamps, latency, filter, or search |
| Zed LSP log | `on_io` hook; RPC storage opt-in per server; `PendingRequestKey{kind,id}` → `"Receive (took 12ms)"` | Correlation + latency model we copy |
| MCP Inspector | **Protocol** tab: requests paired with responses, notifications inline, clear/export; **Console** tab = stderr; per-launch token in URL | Token-gated loopback page we mirror |
| Chrome DevTools Protocol monitor | Record toggle, method/request/response table, detail pane, clear, download JSON | Table + detail layout |

**Krypton delta:** matches the convention (paired request/response table,
detail pane, export, token URL). Diverges with: per-message latency and bytes,
per-method p50/p95, a waterfall of request spans, a third direction (Rust→UI
IPC), a privacy-tiered capture mode, and keyboard-only navigation. Mockup:
artifact `ACP Wire Profiler — UI mockup` (art-103).

## Affected Files

| File | Change |
|------|--------|
| `src-tauri/src/acp_wire.rs` | **New.** `AcpWire` tap: mode, ring buffer, correlation, summary, token, JSONL export |
| `src-tauri/src/acp.rs` | Call `wire.record_*` in `write_line`, `dispatch_output_line`, `emit_event`; drop pending on dispose |
| `src-tauri/src/hook_server.rs` | `/acp-wire/{token}` page + JSON routes (both routers); state access |
| `src-tauri/src/lib.rs` | `.manage(Arc<AcpWire>)`; register commands |
| `src-tauri/src/commands.rs` | `acp_wire_set_mode`, `acp_wire_clear`, `get_acp_wire_url`; `reload_config` re-applies mode |
| `src-tauri/src/config.rs` | `[acp_wire]` section + parse test |
| `src-tauri/src/termctrl_monitor.rs` | `capability_token()` made `pub(crate)` so the wire page reuses the same 128-bit token generator |
| `src/acp/artifact-acpwire.html` | **New.** Fixed-dark Binance page (inline CSS/JS) |
| `src/command-palette.ts`, `src/compositor.ts` | Palette entries + `openAcpWire()` |
| `src/acp/acp-wire.ts` | **New.** `openAcpWireProfiler()` shared by the palette and `#profiler` |
| `src/acp/hash-commands.ts`, `src/acp/acp-harness-view.ts` | `#profiler` surface command (manifest + dispatch) |
| `docs/0006-configuration.md`, `docs/0069-acp-agent-support.md`, `docs/0004-architecture.md`, `DESIGN.binance.md`, `docs/README.md` | Document config, tap, surface row, index |

## Design

### Data Structures

```rust
// config.rs — shared by [acp_wire].capture and the tap
#[serde(rename_all = "lowercase")] pub enum AcpWireCapture { Off, Meta, Full }
#[serde(rename_all = "snake_case")] pub enum WireDir { ToAgent, FromAgent, ToUi }
#[serde(rename_all = "snake_case")] pub enum WireKind { Request, Response, Notification, Event, Invalid }

#[serde(rename_all = "camelCase")]  // schema v1 on the wire
pub struct WireEvent {
    seq: u64,                       // monotonic, never reused (survives clear)
    ts_ms: u64,                     // wall clock (epoch ms)
    mono_us: u64,                   // since tap creation; latency source
    session: u64, lane: Arc<str>, backend: Arc<str>,   // lane = "<display_name> #<session>"
    remote: bool,
    dir: WireDir, kind: WireKind,
    method: Option<Arc<str>>,       // responses inherit the request's method
    id: Option<String>,             // JSON-RPC id as compact JSON (`7`, `"abc"`)
    bytes: u64,                     // line bytes without newline (to_ui: serialized payload)
    latency_us: Option<u64>,        // on responses, back-filled on the request
    pair_seq: Option<u64>,          // response → request seq; request → response seq
    error: bool,                    // response carried `error` (back-filled on request)
    truncated: bool,                // payload cut at 1 MiB
    has_payload: bool,
    #[serde(skip)] payload: Option<Box<str>>,         // Full mode only
}

pub struct AcpWire {
    mode: AtomicU8,
    token: String,                  // 128-bit, process lifetime
    origin: Instant,
    inner: std::sync::Mutex<WireInner>,
}
struct WireInner {
    ring: VecDeque<WireEvent>, cap: usize, evicted: u64,
    payload_bytes: usize, payload_cap: usize,
    payload_seqs: VecDeque<u64>,    // events still holding a body, oldest first
    pending: HashMap<(u64, WireDir, String), PendingRequest>, // cap 4096, evict oldest
    next_seq: u64,
}
```

`to_ui` method = payload `type`, plus `·kind` for `session_update`
(e.g. `session_update·agent_message_chunk`). Agent `session/update`
notifications likewise carry `·{params.update.sessionUpdate}` (e.g.
`session/update·tool_call_update`); without that field the method stays
`session/update`. The update kind is a protocol discriminator, not content, so
it is recorded in Meta too, and the per-method table splits by it.

### Capture semantics

- `record_*` returns immediately when mode is `Off`. Otherwise it takes the
  mutex once, assigns `seq`, correlates, pushes, and evicts (oldest event first;
  Full payloads also evicted oldest-first until `payload_bytes ≤ payload_cap`).
- Outbound (`write_line`): records after serialization using the existing `text`
  (bytes = `text.len()`), classified from the `Value` already in hand.
- Inbound (`dispatch_output_line`): records after the existing parse; a
  non-JSON line is recorded as `Invalid` with its byte count before being
  dropped (today it is silently dropped at `debug!`).
- UI (`emit_event`): records only after the `disposed` early-return, so it
  reflects events actually emitted. Bytes require a second `serde_json`
  serialization, paid only when mode ≠ `Off`.
- Correlation: a request inserts `(session, dir, id)`; a response looks up
  `(session, opposite dir, id)`, fills `method` and `latency_us`, and back-fills
  `latency_us`/`error` on the request event if still in the ring. Unmatched
  responses keep `method = None`. Dispose (`acp_dispose`) drops that session's
  pending entries.
- Switching `Full → Meta/Off` stops capturing payloads; already-captured events
  stay until evicted or cleared. `Off` keeps the ring for review.

### API / Commands

Tauri commands (palette-driven; the page has no write routes):

```rust
#[tauri::command] fn acp_wire_set_mode(mode: String) -> Result<String, String>;   // returns new mode
#[tauri::command] fn acp_wire_clear();
#[tauri::command] fn get_acp_wire_url() -> Result<{ url, mode }, String>;        // http://127.0.0.1:{port}/acp-wire/{token}
```

Loopback routes (token checked in constant time; `Cache-Control: no-store`;
404 on mismatch):

| Route | Returns |
|-------|---------|
| `GET /acp-wire/{token}` | HTML page |
| `GET /acp-wire/{token}/message/{seq}` | same HTML page in full-page message mode (seq read client-side; non-numeric seq → 400) |
| `GET /acp-wire/{token}/summary` | `{ v, mode, events, evicted, oldestSeq, nextSeq, nowMs, nowMonoUs, payloadBytes, payloadCapBytes, inFlight, lanes:[{session,lane,backend,remote}], dirs:{to_agent,from_agent,to_ui:{count,bytes}}, methods:[{method,count,bytes,p50Us,p95Us,maxUs,errors}] }` — computed by scanning the ring on request; methods sorted by bytes, unmatched responses under `(unmatched response)`, non-JSON lines under `(invalid)` |
| `GET /acp-wire/{token}/events?since=<seq>&limit=<n≤2000>` | `{ events:[WireEvent without payload], nextSeq, oldestSeq, gap }`; `since` inclusive; more than `limit` available → newest `limit`; `gap=true` only when `since > 0` and events were evicted or skipped |
| `GET /acp-wire/{token}/event/{seq}` | one `WireEvent` with `payload` (404 if evicted) |
| `GET /acp-wire/{token}/export.jsonl` | whole ring as schema-v1 JSONL, header line `{"v":1,"kind":"header",...}`; payloads included only if captured |

### Data Flow

```
1. User: palette → "ACP Wire: Open Profiler", or `#profiler` in a harness composer
2. openAcpWireProfiler(): invoke get_acp_wire_url → {url, mode}; if mode is off
   → invoke acp_wire_set_mode('meta') (toast/chip "ACP wire capture: META"); open_url
3. Lane sends session/prompt → write_line → wire.record_out(...) → ring
4. Agent streams session/update → dispatch_output_line → wire.record_in(...)
   → handle_notification → emit_event → wire.record_ui(...)
5. Agent replies to prompt → record_in correlates id → latency on both rows
6. Page (visible tab only) polls summary + events?since every 1 s, fetches
   event/{seq} on selection, renders waterfall/table/methods
```

### Keybindings

| Key | Context | Action |
|-----|---------|--------|
| palette `ACP Wire: Open Profiler` | Command palette | enable `meta` if off, open page |
| `#profiler` | ACP Harness composer | same as `ACP Wire: Open Profiler`; works in remote harnesses (capture is local) |
| palette `ACP Wire: Capture Off / Meta / Full` | Command palette | set mode (Full shows a privacy toast) |
| palette `ACP Wire: Clear` | Command palette | empty ring + pending |
| `j` / `k` | Page | next / previous row (group rows count as one) |
| `Enter` | Page | jump to paired request/response; on a group row, expand / collapse |
| `g` | Page | group consecutive runs on / off |
| `/` | Page | focus filter (method, id, lane); `Esc` leaves |
| `Space` | Page | pause / resume polling (view only) |
| `1` `2` `3` | Page | toggle `→ agent` / `← agent` / `⇢ ui` |
| `l` | Page | cycle lane filter |
| `e` | Page | download `export.jsonl` |
| `v` | Page | toggle detail payload: readable / raw JSON |
| `o` | Page | open the selected message in a full page (new tab); also the **open full page ↗** link in the Detail header |
| `[` / `]` | Message page | previous / next seq in wire order |
| `Enter` | Message page | open the paired request/response |
| `j` / `k` | Message page | scroll |
| `v` | Message page | readable / raw JSON |
| `y` | Message page | copy payload as pretty JSON (metadata JSON when no payload was captured) |
| `Esc` | Message page | back to the profiler |

### UI Changes

New page `src/acp/artifact-acpwire.html`, fixed dark, per `DESIGN.binance.md`
(stat tiles, chips, pills, cards, mono data, one accent, no left rails). Panels
as in the art-103 mockup: status bar (live/paused pill, capture-mode pill —
`FULL` in red), stat tiles (msg/s, bytes per direction, RPC p50/p95, in-flight,
evicted), lane + direction chips, 60 s SVG waterfall (request spans by latency,
notification ticks, error spans red), message table (last 400 rendered) +
detail pane, per-method table. Client keeps at most the ring's worth of rows.

Consecutive `notification` / `event` rows with the same lane, direction and
method (so one `sessionUpdate` kind) collapse into one group row, on by
default: `▸ notification ×N`, total bytes, and first→last span in the latency
column. Click or `Enter` expands members in place (indented); selecting a
member via the waterfall or `g` reveals its group. Groups are keyed by first
member seq, so a live run growing at the tail keeps its selection and expansion.
A selected group's detail shows count, time range, span, total/avg bytes and
seq range.

Detail pane (Full capture): default **readable** view drops the JSON-RPC
envelope (already in the key/value list), shows a one-line digest of
`sessionUpdate` / `title` / `kind` / `status` / `stopReason` / `toolCallId` /
`error`, and renders the payload as a foldable tree (objects tagged with their
`type`). Multi-line or long strings render as real text blocks with `\n`
unescaped; blocks over 14 lines / 1400 chars are clipped behind **show all**.
`v` switches to pretty-printed raw JSON; payloads that fail to parse
(truncated) always show raw. Meta capture shows an explicit "not captured"
notice. The pane rebuilds only when the selection, its pairing/latency, the
payload load state, or the view changes, so polling never resets scroll, fold
state, or text selection.

**Message page** (`/acp-wire/{token}/message/{seq}`): the detail pane has no
room for large prompts, tool results or file contents, so `o` (or the Detail
header link) opens the selected message full width in a new tab. The page is the
same document switched on its path: it hides the dashboard, fetches
`event/{seq}` (+ `summary` once, for the capture-mode notice), and renders the
same key/value list and readable/raw payload views with no height cap and no
**show all** clipping. It does not poll. `[` / `]` and the paired link swap the
message in place via `history.pushState`, so browser back/forward walks the
visited seqs. An evicted, cleared or not-yet-captured seq shows a 404 notice.

### Configuration

```toml
[acp_wire]
capture = "off"          # off | meta | full — applied at launch and on Reload Config
ring_events = 20000      # clamped 1000–200000
full_payload_mb = 64     # Full-mode payload memory cap, clamped 8–512
```

Runtime palette changes are not written back; Reload Config re-applies
`capture`.

## Edge Cases

- **Remote lanes:** same choke points; `remote: true`. SSH framing overhead is
  not counted (bytes = JSON-RPC line).
- **Non-string / reused ids:** id rendered as compact JSON; key includes session
  and direction, so `id 1` on two lanes or in both directions never collides.
- **Unmatched response / request never answered:** response shows `method: —`;
  request stays in pending (counted as in-flight) until answered, disposed, or
  evicted at 4096.
- **Large payloads:** per-event payload truncated at 1 MiB (`truncated: true`);
  aggregate bounded by `full_payload_mb`.
- **Ring overflow:** oldest evicted; `evicted` counter; page shows a gap marker
  when `since < oldestSeq`.
- **Lane restart:** new session id → new lane row; old rows remain until evicted.
- **Mutex poisoning:** recover with `into_inner()` (existing pattern), never panic.
- **Hook server down / port 0 fallback:** `get_acp_wire_url` returns `Err`; toast.

## Out of Scope

- UI→Rust `invoke` payload capture (prompt submission already appears as the
  outbound `session/prompt`).
- Continuous disk sink / retention, replay, editing or resending messages.
- Harness lane labels (`OMP-1`) — page shows `<display_name> #<session>`.
- Stderr capture in the page (unchanged `stderr_buf`).
- Raising the global log level.

## Resources

- [Zed `acp_tools` / `agent_servers` ACP debug log](file:///Users/wk/Source/zed/crates/agent_servers/src/acp/debug_log.rs) — capture at stdio line boundary, 2000-entry deque, direction model
- [Zed LSP log store](file:///Users/wk/Source/zed/crates/project/src/lsp_store/log_store.rs) — `(kind, id)` pending map and latency headers
- [MCP Inspector web client](https://modelcontextprotocol.io/docs/2026-07-28/tools/inspector/web.md) — Protocol tab pairing, export, per-launch token URL
- [Chrome DevTools Protocol monitor](https://developer.chrome.com/docs/devtools/protocol-monitor) — record toggle, table + detail, download
- `docs/0198-termctrl-session-monitor.md`, `docs/adr/0010-docs-browser-serves-repo-markdown-over-tokenless-loopback.md` — loopback token tiers
