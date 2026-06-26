# Harness Web Control API — Implementation Spec

> Status: Implemented
> Date: 2026-06-26
> Milestone: M-ACP — Harness convergence

## Problem

Krypton's ACP Harness can be controlled headlessly today only through the
request/response control API (`/control/v1`, see doc 154), driven by the
`kryptonctl` CLI. There is no way for a **separate web application** to drive a
running Krypton harness with *full* feature coverage, because (a) the control
API exposes a curated operation subset, and (b) it has **no live event stream** —
agent output, status changes, permission prompts, and attention flags never
leave the running TypeScript frontend. A web UI that mirrors the harness needs
both: every domain operation, and a live feed.

## Solution

Extend the **existing authenticated control server** (`control.rs`) — do not add
a third server — into a complete remote-control surface for a same-machine web
app (Option A: the web app remotes into a *running* Krypton; the TypeScript
frontend stays the authority per ADR-0007). Three additions:

1. **Event stream** — a `GET /control/v1/events` Server-Sent Events (SSE)
   endpoint. The frontend (still the sole authority) pushes the harness events it
   already processes to Rust via a new `acp_control_publish` command; Rust fans
   them out to subscribers. No harness state is mirrored in Rust.
2. **Full operation coverage** — add the read/observe operations a web UI needs
   (attention queue, artifacts, lane status snapshot, available commands, lane
   metrics) to the existing typed operation set.
3. **Browser reachability** — opt-in CORS (`[acp_controller].cors_origins`) so a
   browser app can call the control API directly, with the bearer token supplied
   by the web app's own server-side proxy (default, token stays off the browser)
   or pasted by the user (direct mode).

This reuses 100% of the harness brain and matches the SSE capability already
named as "deferred" in doc 154 — it is the planned next step, not a new axis.

## Research

- **Authority split (ADR-0007).** The harness state machine — lane lifecycle,
  transcript model, permission queue, triage/attention, peering, artifacts,
  memory, MCP bridge — lives entirely in `src/acp/acp-harness-view.ts`. Rust
  `control.rs` only authenticates, parses, and forwards typed operations to the
  frontend over a Tauri round-trip (`acp-control-request` → `acp_control_reply`).
  The spec must keep this: events are **pushed by the frontend**, never derived
  in Rust.
- **Existing operation dispatch.** `control-bridge.ts:route()` resolves a target
  harness, then calls `entry.control(op, params)` →
  `acp-harness-view.ts:handleControlOperation()` (~line 1605). Current ops:
  `harness.list/create`, `lane.list/spawn/send/cancel/close/restart/new/model/
  directive/goal/permission_mode/transcript`, `permission.list/resolve`,
  `memory.list/get/clear`, `peer.list`, `diff.review-targets/priority/send`.
- **Existing event sink.** `acp-harness-view.ts` (~line 4746) already has a
  central switch over normalized harness events (`message_chunk`,
  `thought_chunk`, `tool_call`, `tool_call_update`, `plan`, `permission_request`,
  `usage`, `mode_update`, `fs_activity`, `stop`, `error`, …). This is the exact
  set the SSE stream must forward — one publish call alongside the existing UI
  mutation, no new event plumbing in Rust.
- **Two-server topology.** `hook_server.rs` (unauthenticated, known port via
  `get_hook_server_port`) serves the browser loopback surfaces; `control.rs`
  (authenticated, random port, 0600 token descriptor) serves control. Doc 154
  deliberately keeps them separate. This spec extends `control.rs` only.
- **`tower-http` `cors` feature is already a dependency** (`Cargo.toml:44`), so
  `CorsLayer` is available with no new crate.
- **SSE vs WebSocket.** Commands already flow over `POST /operations`; the only
  missing direction is server→client streaming. SSE (one-way, plain HTTP, auto
  re-connect, no upgrade handshake) covers that with the smallest surface and is
  the capability doc 154 already earmarked. WebSocket would add a bidirectional
  channel we do not need (commands stay on POST). Chosen: SSE.

## Prior Art

| Tool | Implementation | Notes |
|------|---------------|-------|
| Chrome DevTools Protocol | Local HTTP (`/json` discovery) + per-target **WebSocket** for streaming commands+events | Canonical "remote-control a running app over loopback" pattern; full feature parity with the GUI |
| tmux control mode (`tmux -CC`, iTerm2) | Line protocol over the tmux socket: client issues commands, server emits `%output`/`%window-*` notifications | Streaming notifications + commands; iTerm2 renders a native UI over it |
| VS Code Server / Remote | HTTP + WebSocket; browser UI drives a headless backend over a token-authenticated channel | Browser is the frontend, server is authority — closer to Option C |
| ttyd / gotty | Serve a single terminal over WebSocket to the browser | Streams raw PTY only; no structured domain operations |
| Zed ACP | JSON-RPC over stdio to agent servers; UI is the client | Same ACP substrate Krypton wraps, but in-process, not over HTTP |

**Krypton delta** — Like CDP and tmux control mode, we expose a *running*
instance over loopback with both commands and a live stream. Unlike CDP we use
**SSE for events + POST for commands** (not one WebSocket) because commands
already have a typed POST endpoint and the frontend, not Rust, owns state —
keeping the stream one-way avoids a second authority path. Unlike VS Code
Server, the browser does **not** replace the frontend (that is Option C); the
Tauri frontend stays the authority and the web app is a remote mirror.

## Affected Files

| File | Change |
|------|--------|
| `src-tauri/src/control.rs` | Add `GET /control/v1/events` SSE handler; broadcast channel in `ControlServer`; `publish()` method; CORS layer from config; auth for SSE via `?token=`/header |
| `src-tauri/src/commands.rs` | New command `acp_control_publish(event)` → `ControlServer::publish` |
| `src-tauri/src/config.rs` | `AcpControllerConfig`: add `cors_origins: Vec<String>` (default empty) |
| `src-tauri/src/lib.rs` | Register `acp_control_publish`; pass `ControlServer` handle where needed |
| `src/acp/control-bridge.ts` | (no change to routing) — events are published from the view, not the bridge |
| `src/acp/acp-harness-view.ts` | In the event sink (~4746) and status/attention/permission/transcript update points, call `publishControlEvent(...)` alongside existing UI updates; add new read operations to `handleControlOperation` |
| `src/acp/control-publish.ts` | New thin module: debounced `invoke('acp_control_publish', …)` wrapper, no-op when controller disabled |
| `docs/154-harness-controller-cli.md` | Cross-reference: SSE no longer deferred |
| `docs/PROGRESS.md`, `docs/04-architecture.md`, `docs/05-data-flow.md` | Document the stream + new ops |

## Design

### Data Structures

```rust
// control.rs — added to ControlServer
broadcast: tokio::sync::broadcast::Sender<String>, // pre-serialized SSE `data:` JSON

// Wire envelope pushed by the frontend (camelCase via serde)
struct ControlStreamEvent {
    harness_id: String,
    lane: Option<String>,      // display name; None = harness-scoped
    kind: String,              // "message_chunk" | "status" | "permission" | "attention" | "transcript" | ...
    seq: u64,                  // monotonic per server; for client gap detection
    payload: Value,            // the already-normalized harness event the view holds
}
```

```ts
// control-publish.ts
export function publishControlEvent(e: {
  harnessId: string; lane?: string; kind: ControlEventKind; payload: unknown;
}): void; // fire-and-forget; swallows errors; gated on controller-enabled
```

### API / Commands

- **`GET /control/v1/events`** (SSE) — query `?harness=<id>&lane=<name>` optional
  filters; auth via `Authorization: Bearer` header **or** `?token=` (EventSource
  cannot set headers). Emits `event: <kind>\ndata: <ControlStreamEvent JSON>\n\n`.
  Sends a `ready` event on connect and a comment heartbeat (`:ka`) every 15s.
- **`POST /control/v1/operations`** — unchanged shape; gains new `operation`
  values (below).
- **New operations** (handled in `handleControlOperation`):
  `attention.list`, `attention.resolve`, `artifact.list`, `lane.status`
  (rich per-lane snapshot: id/backend/session/model/goal/permissionMode/directive/
  status/queue/activity), `lane.commands` (available slash commands),
  `lane.metrics`, `lane.models` (available + current model), `directive.list`,
  `review.outcomes` (review quality matrix rows), and the previously-handled
  `diff.review-targets`/`diff.review-priority`/`diff.review-send` (now advertised
  in `capabilities`). All read-only except `attention.resolve`/`diff.review-send`.
  `artifact.list` deliberately omits the feedback token — exposing it would let
  any authenticated control client inject a turn via the artifact-feedback
  endpoint; a mirror gets `state`/`size`/`hash` instead.

### Streaming semantics (client contract)

- **Ordering** — `seq` is monotonic in send order (publish serializes seq +
  send under one lock; the frontend serializes its `acp_control_publish` calls
  through a single promise chain). A client may rely on `seq` for gap detection.
- **`gap` events** — a single global broadcast is filtered per subscriber, so a
  busy *unrelated* lane can still make a filtered client lag and receive a `gap`
  with no matching events dropped. Treat `gap` as "re-snapshot defensively"
  (re-pull `lane.transcript`/`lane.status`), not proof that *your* lane lost data.
- **Chunk payload** — coalesced `message_chunk`/`thought_chunk` deltas carry
  `{ type, text }`, the same shape as a forwarded `AcpEvent`.

### Deliberately NOT exposed (v1)

`peer.send` (inter-lane peering is a lane↔lane MCP capability; an external
client must not impersonate a lane), `backend.list`, `mcp.stats`, and session
resume/load — out of scope until a concrete consumer needs them.
- **New Tauri command** — `acp_control_publish(event: ControlStreamEvent)` →
  `ControlServer::publish` (best-effort; drops if no subscribers).
- **`GET /control/v1/capabilities`** — extended `operations` list + new
  `"streaming": { "sse": "/control/v1/events" }` field.

### Data Flow

Command (web app → harness), unchanged path:
```
1. Web app (or its proxy) POSTs /control/v1/operations with Bearer token
2. control.rs authenticates, emits `acp-control-request` to frontend
3. control-bridge.ts routes → acp-harness-view handleControlOperation
4. View mutates real harness state, returns typed result
5. invoke('acp_control_reply') → control.rs returns JSON to caller
```

Event (harness → web app), new path:
```
1. Agent event arrives in acp-harness-view event sink (~4746)
2. View updates its own UI (unchanged) AND calls publishControlEvent(...)
3. invoke('acp_control_publish', envelope) → ControlServer::publish
4. Rust broadcasts the serialized event to all SSE subscribers
5. Web app's EventSource receives it, updates the web mirror
```

### Configuration

```toml
[acp_controller]
enabled = true            # existing
port = 8766               # new: fixed loopback port (stable URL for external
                          # clients e.g. a browser extension). Ephemeral
                          # fallback on conflict; 0 = auto-assign.
cors_origins = []         # new: exact origins allowed to call the API from a
                          # browser, e.g. ["http://localhost:5173"]. Empty =
                          # no CORS headers (proxy-only mode, the secure default).
```

### Security

- SSE endpoint requires the same bearer token; `?token=` is accepted only on the
  loopback listener (already `127.0.0.1`-bound).
- CORS is **opt-in and exact-origin** — never `*`. Empty list = browser direct
  calls blocked; the web app must proxy server-side (token never reaches the
  browser). This is the recommended default.

## Edge Cases

- **No subscribers** — `broadcast::send` returns `Err(NoReceivers)`; ignored.
- **Slow client** — bounded broadcast channel (cap 1024); a lagging receiver gets
  a `Lagged(n)` it surfaces to the client as a `gap` event so it can re-snapshot
  via `lane.transcript`.
- **Controller disabled** — `publishControlEvent` is a no-op; no perf cost.
- **Frontend not ready / closed** — operations time out as today (ADR-0007); SSE
  stays open and simply emits nothing.
- **Multiple harnesses** — events carry `harnessId`; stream filters apply.
- **Reconnect** — client reconnects and re-snapshots; `seq` lets it detect gaps.
  No server-side replay buffer in v1.

## Open Questions

_All resolved at approval (2026-06-26):_

1. **Browser reachability model** — RESOLVED: ship **both**, default
   **proxy-only** (`cors_origins = []`; the web app's server reads the 0600
   descriptor and proxies, token stays off-browser). Direct CORS is opt-in.
2. **Event coverage depth** — RESOLVED: stream **all** sink events, but
   **debounce `message_chunk`/`thought_chunk` deltas to ~30ms** in
   `control-publish.ts` before publishing.
3. **Agent process location** — RESOLVED: agents run on the **local backend**
   (same machine as the control server); loopback only, unchanged from today.

## Out of Scope

- Replacing the Tauri frontend / headless backend (Options B & C) — separate
  effort.
- Remote/multi-machine access, TLS, multi-user auth — loopback single-instance
  only, matching doc 154.
- WebSocket / bidirectional channel — commands stay on POST.
- Non-harness surfaces (PTY/terminal, compositor, layout, config/theme) — this
  spec is harness-only per the stated priority.
- `kryptonctl` gaining a `watch`/stream subcommand — can follow once SSE lands.

## Resources

- `docs/154-harness-controller-cli.md` — existing control API; names SSE as the deferred capability this spec implements.
- `docs/adr/0007-frontend-remains-authority-for-harness-control.md` — constraint that events must be pushed by the frontend, not mirrored in Rust.
- Chrome DevTools Protocol — https://chromedevtools.github.io/devtools-protocol/ — prior art for loopback discovery + streaming remote control of a running app.
- tmux control mode — https://github.com/tmux/tmux/wiki/Control-Mode — prior art for command + server-notification streaming consumed by an external UI (iTerm2).
- MDN Server-Sent Events — https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events — chosen stream transport; EventSource header limitation drove the `?token=` decision.
- `tower-http` CORS — https://docs.rs/tower-http/latest/tower_http/cors/ — already a dependency; provides `CorsLayer` for the opt-in browser-direct mode.
