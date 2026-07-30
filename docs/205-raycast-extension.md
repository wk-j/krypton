# Krypton Raycast Extension — Implementation Spec

> Status: Implemented
> Date: 2026-07-31
> Milestone: M-ACP — Harness convergence
> Reviewed: Codex-4 (architecture & correctness), 2026-07-31 — 3 blockers,
> 4 warnings, 2 suggestions; all folded into this revision

## Problem

Checking harness state — which lanes are busy, which are blocked on a
permission prompt, which attention flags await a human decision — requires
switching to the Krypton window or opening the browser dashboard. There is no
way to glance at fleet state or take a quick action (answer a permission,
resolve an attention flag, dispatch a prompt) from anywhere on the desktop.

## Solution

A Raycast extension (`raycast/` in this repo, standalone TypeScript/React
project) that drives the **existing authenticated control API**
(`/control/v1`, docs 154/175) exactly the way `kryptonctl` does: read the
runtime descriptor at `~/.config/krypton/runtime/controller.json`, then POST
operations with the bearer token. Four commands: a lane browser with actions,
an attention queue, a pending-permission queue, and a menu-bar status badge
with background refresh. **Zero changes to Krypton itself** — the control API
already exposes every operation needed.

## Research

- **The control server is the right data plane.** `control.rs` binds
  `127.0.0.1:8766` (config `[acp_controller] port`, ephemeral fallback) and
  writes an atomic 0600 descriptor
  `{ pid, url, apiVersion: "1.0", appVersion, token }` to
  `~/.config/krypton/runtime/controller.json` on launch, deleting it on
  shutdown (`control.rs:75-83`, `:490-494`, `:628-655`). Discovery, liveness
  (`pid`), version negotiation, and auth are all solved. Reference client:
  `src-tauri/src/bin/kryptonctl.rs:185-247`.
- **The hook server (8765) is the wrong data plane** for an external client:
  no auth on `/telemetry` and the MCP endpoint, no on-disk port discovery
  (silent ephemeral fallback when 8765 is busy). It is used here only to
  build browser-surface URLs (`/dashboard`, `/gallery`, `/docs`) handed to
  `open`, matching how the in-app `#dashboard` command builds them.
- **Every needed operation already exists** in `ADVERTISED_OPERATIONS`
  (`control.rs:35-71`): `lane.list`, `lane.status`, `lane.send`,
  `lane.cancel`, `lane.restart`, `lane.permission_mode`, `lane.transcript`,
  `attention.list`, `attention.resolve`, `permission.list`,
  `permission.resolve` — with two caveats found in review (Codex-4):
  - **Fan-out is `lane.list`-only.** `control-bridge.ts` fans out across
    harnesses only for `lane.list` (and selected GitHub reads); everything
    else without a `lane`/`harnessId` param throws `ambiguous_harness`
    (`control-bridge.ts:163`) as soon as two harness views are open. The
    client therefore calls `harness.list` first and passes `harnessId`
    explicitly on `attention.list`/`attention.resolve`; lane-scoped ops are
    unaffected (`params.lane` resolves the harness server-side).
  - **401 retry is for reads only.** The token is minted per app launch and
    lane counters/display names reset with it, so a 401 may mean Krypton
    relaunched and "Codex-1" is now a different lane. On 401 the client
    re-reads the descriptor and retries **reads** once; mutations are never
    replayed — if the descriptor `pid` changed, caches are invalidated and
    the UI reloads instead.
- **Raycast runtime**: commands are short-lived Node processes (loaded on
  demand, unloaded after run). `useCachedPromise` is stale-while-revalidate,
  not periodic polling, so open views add an explicit revalidation timer
  (2 s) on top of it. The SSE stream (`/control/v1/events`) would work for a
  held-open view but not for background/menu-bar runs; v1 uses polling
  everywhere for one code path (SSE noted as a future option). Menu-bar
  commands support background refresh via a manifest `interval` (minimum
  `1m`).
- **Alternative ruled out — shelling to `kryptonctl`**: needs the binary on
  `PATH` and JSON-over-stdout parsing; direct HTTP with the same descriptor
  is fewer moving parts and gives typed errors.

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| Raycast Docker extension | List of containers with status icons; start/stop/logs as actions | Same list-with-actions shape as the lane browser |
| Raycast GitHub extension | Menu-bar command with unread-notification count, background refresh | Model for the status badge |
| Raycast tmux-sessioner | Lists tmux sessions by shelling out to `tmux` CLI | CLI-shelling approach we rejected in favor of the HTTP API |
| Raycast Warp/iTerm extensions | Only "open new window/tab" launchers | No control plane at all — Krypton goes further |

**Krypton delta** — the list/actions/menu-bar shapes follow Raycast
conventions exactly (familiarity). The difference is the transport: a
token-authenticated local control API with disk-descriptor discovery, which
no terminal-emulator extension in the store has. Keyboard-first matches
Raycast's own model, so nothing diverges there.

## Affected Files

All new; nothing in `src/` or `src-tauri/` changes.

| File | Change |
|------|--------|
| `raycast/package.json` | Manifest: 4 commands, preferences, deps (`@raycast/api`, `@raycast/utils`) |
| `raycast/src/krypton.ts` | Transport: descriptor read + liveness + version check, `op()` POST helper, 401 re-read retry, error mapping, hook-server URL builder |
| `raycast/src/shared.tsx` | Shared view helpers: 2 s polling hook, not-running/error empty state with Launch Krypton action |
| `raycast/tsconfig.json`, `raycast/assets/icon.png` | Project scaffold (icon is required by the manifest) |
| `raycast/src/lanes.tsx` | `view` command — lane browser |
| `raycast/src/attention.tsx` | `view` command — attention queue |
| `raycast/src/permissions.tsx` | `view` command — permission queue |
| `raycast/src/menubar.tsx` | `menu-bar` command, `interval: 1m` |
| `raycast/README.md` | Install/dev instructions (`npm run dev` = `ray develop`) |
| `docs/PROGRESS.md` | Landing entry |
| `CLAUDE.md` | One line noting `raycast/` exists and is standalone |

## Design

### Data Structures

```ts
// raycast/src/krypton.ts
interface RuntimeDescriptor {
  pid: number;
  url: string;          // "http://127.0.0.1:8766/control/v1"
  apiVersion: string;   // reject if major !== 1
  appVersion: string;
  token: string;
}

type KryptonError =
  | { kind: 'not-running' }                    // descriptor missing or pid dead
  | { kind: 'version-mismatch'; apiVersion: string }
  | { kind: 'api'; code: string; message: string; retryable: boolean }
  | { kind: 'network'; message: string };

// Every call sends a collision-resistant, non-empty operationId
// (crypto.randomUUID()) — the frontend idempotency cache is keyed by it, so
// concurrent fan-out calls must not collide. The same id is reused ONLY
// across the single safe 401 retry of a read; mutations get a fresh id and
// are never replayed (see Research).
async function op<T>(operation: string, params?: Record<string, unknown>,
                     opts?: { mutation?: boolean }): Promise<T>;   // harnessId travels in params

// harness.list → per-harness op with explicit harnessId, results merged and
// tagged { harnessId, cwd } — used by attention.list (no server-side fan-out).
async function opPerHarness<T>(operation: string): Promise<Array<{ harnessId: string; cwd: string; result: T }>>;
```

Lane/attention/permission row types mirror the control-API result shapes
verbatim (`acp-harness-view.ts:1477-1491`, `:1266-1280`, `permission.list`) —
no re-modeling.

### API / Commands

Raycast manifest commands:

| Command | Mode | Purpose |
|---------|------|---------|
| `lanes` | `view` | Lane browser (`lane.list`), sectioned by harness `cwd` |
| `attention` | `view` | Open attention flags (`opPerHarness('attention.list')` — no server-side fan-out; rows carry their `harnessId` for resolve) |
| `permissions` | `view` | Lanes awaiting permission + head request (`lane.list` filtered → `permission.list` per lane) |
| `menubar` | `menu-bar` + `interval: "1m"` | Badge: `busy / needs_permission / attention` counts |

Control operations used: reads `harness.list`, `lane.list`, `lane.status`,
`lane.transcript`, `attention.list`, `permission.list`; writes `lane.send`,
`lane.cancel`, `lane.restart`, `lane.permission_mode`, `attention.resolve`,
`permission.resolve`. Lane-scoped ops target `params.lane` = `displayName`
(globally unique, harness resolved server-side); harness-scoped ops
(`attention.*`) always pass the `harnessId` captured at list time. Open views
revalidate on a 2 s timer; every mutation triggers an immediate revalidate.

### Data Flow

Primary use case — answer a permission from anywhere:

```
1. Menu-bar badge (background-refreshed every 1m) shows "1 perm"
2. User opens `permissions` command (or clicks through from the menu bar)
3. Command reads controller.json → pid alive → POST lane.list, then
   permission.list for lanes with pendingPermissions > 0
4. List shows lane, tool name, options; Enter (accept — shown only when the
   request offers an allow option) or Cmd+R (reject)
5. POST permission.resolve { lane, requestId, action }, then revalidate:
   the success toast fires only once the requestId is gone from
   permission.list (the API returns { resolved: true } even when the
   respond failed and the request was requeued — acp-harness-view.ts:1462)
6. permission_not_found / conflict = expected stale-snapshot race (someone
   answered it in-app first): revalidate silently, no error toast
```

Failure path: descriptor missing/pid dead → every command renders an
"Krypton is not running" empty state with a "Launch Krypton" action
(`open -a Krypton`). 401 (token rotated by an app relaunch) → re-read
descriptor; if the `pid` is unchanged retry the **read** once with the same
`operationId`, otherwise (new pid = new process, lane names reset)
invalidate all caches and reload the view. Mutations are never retried —
the user re-invokes the action against the fresh lane list.

### Lane browser actions (`lanes` command)

| Action | Operation | Notes |
|--------|-----------|-------|
| Send Prompt | `lane.send { lane, text }` | Push a Form (textarea); toast shows `started` vs `queued (depth n)` |
| Cancel Turn | `lane.cancel` | Shown for `busy`/`needs_permission`/`awaiting_peer` lanes (all cancellable states) |
| View Transcript | `lane.transcript` | Push Detail, last 20 entries rendered as markdown |
| Cycle Permission Mode | `lane.permission_mode` | normal → acceptEdits → bypass, mirrors in-app Shift+Tab |
| Restart Lane | `lane.restart` | Shown **only** for `error`/`stopped` lanes — `restartLane()` silently no-ops on other states while the API still reports success; behind `confirmAlert` (destructive: fresh session) |
| Open Dashboard / Gallery / Docs | — | `open http://127.0.0.1:<hookPort>/dashboard` etc. |
| Copy Session ID | — | clipboard |

Status rendering: `idle` green dot, `busy` amber, `needs_permission` red
exclamation, `awaiting_peer` blue, `starting`/`stopped` gray, `error` red.
Accessories: model name, queue depth, goal (truncated).

### Configuration (Raycast preferences, not TOML)

| Preference | Type | Default | Purpose |
|------------|------|---------|---------|
| `hookPort` | textfield | `8765` | Browser-surface URLs only (`[hooks] port` if user changed it) |

No new Krypton config keys.

## Edge Cases

- **Descriptor exists but pid dead** (crash left stale file): treated as
  not-running; never POST.
- **Token rotation**: descriptor re-read on 401; same-pid → retry reads once
  (same `operationId`); new pid → invalidate + reload, never replay a
  mutation (see Data Flow).
- **Ephemeral control port** (8766 busy at launch): handled for free — the
  descriptor carries the real URL.
- **`lane_not_ready` / `queue_full` on `lane.send`**: toast with the API
  message; no retry.
- **30 s control timeout (504)**: toast "Krypton did not respond"; retryable.
- **Multiple harnesses**: `lane.list` fans out server-side; `attention.*`
  does not — enumerated per `harnessId` (see Research). UI sections by
  `cwd` (basename shown, full path as tooltip).
- **`permission.resolve` only accepts the oldest request**: UI only ever
  offers the head request per lane, matching the constraint. A head answered
  elsewhere first surfaces as `permission_not_found`/conflict → treated as a
  normal stale-snapshot race, immediate revalidate, no error toast.
- **Optimistic-success API replies**: `permission.resolve` (and
  `lane.restart` outside `error`/`stopped`) can report success without the
  effect happening — success UI is driven by post-mutation revalidation, not
  by the reply alone.
- **Menu-bar background run with Krypton closed or failing**: renders a
  dimmed/unavailable icon with a last-updated tooltip, no error toast
  (background runs must be silent). Error/not-running state **takes
  precedence over cached data** — a stale healthy badge must never mask a
  failed refresh (`useCachedPromise` keeps the last value across runs).

## Open Questions

None. The one review-surfaced fork — client-side per-harness enumeration vs
adding `attention.list` fan-out to `control-bridge.ts` — was resolved in
favor of client-side enumeration to keep the zero-Krypton-changes property
(routed to the attention queue 2026-07-31; revisit only if other control-API
clients need the same fan-out).

## Out of Scope

- **Artifact browsing/opening.** `artifact.list` deliberately omits the
  feedback token (doc 175), and fetching tokens from the unauthenticated
  hook-server `/artifacts` endpoint would bypass that decision. The "Open
  Artifact Gallery" action covers the need.
- **SSE live stream** (`/control/v1/events`) — incompatible with Raycast's
  short-lived command processes.
- **Store publication** — v1 is a local extension (`ray develop` /
  `ray build`); store metadata (screenshots, categories) later if wanted.
- **Spawning new lanes/harnesses, GitHub issue ops, memory/handoff ops** —
  all exist in the control API but are lower-value from a launcher; add on
  demand.
- **A `krypton://` OS URL scheme** for focusing the app (none exists today;
  `open -a Krypton` suffices).
- **Windows support** — descriptor path and `open -a` are macOS-first;
  manifest pins `platforms: ["macOS"]`.

## Resources

- [Raycast API — Manifest](https://developers.raycast.com/information/manifest) — command modes (`view`/`no-view`/`menu-bar`), `interval`, preference types, `platforms`
- [Raycast API — Background Refresh](https://developers.raycast.com/information/lifecycle/background-refresh) — menu-bar `interval` semantics (min 1m), `environment.launchType`
- [Raycast API — Menu Bar Commands](https://developers.raycast.com/api-reference/menu-bar-commands) — `MenuBarExtra` lifecycle (on-demand load/unload → no SSE)
- `docs/175-harness-web-control-api.md` + `src-tauri/src/control.rs` — operation roster, descriptor format, auth, error envelope
- `src-tauri/src/bin/kryptonctl.rs:185-247` — reference descriptor-reading client this transport copies
