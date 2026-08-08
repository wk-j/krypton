# Backend Link Indicator — Implementation Spec

> Status: Implemented
> Date: 2026-08-08
> Milestone: M-ACP — Harness convergence
> Builds on: 212 + ADR-0016 (Xenon publisher) · 128/138 (attention gauge) · 146 (review depth) ·
> 162 (priority depth) — the three existing workspace-footer indicators whose idioms this follows

## Problem

Krypton now talks to an off-machine backend (the Xenon resource server, spec 212), but nothing in
the workspace tells you whether that link is alive. Today the only way to find out is to run
`#push` and read the outcome, or `#xenon status` — which reports *configuration* (`token:
configured`), not *connectivity*. A server that is down, a revoked token, and a perfectly healthy
link are indistinguishable until a push fails.

## Solution

Add one **backend link segment** to the workspace footer's right-hand global cluster, driven by a
periodic authenticated probe in the Rust backend. It is always visible while `[xenon].enabled`,
dim and unobtrusive when the link is healthy, and coloured when it is not. A new Tauri command
`xenon_probe` performs a single authenticated `GET /v1/projects` — one request that distinguishes
*unreachable* (transport error), *unauthorized* (401/403), and *linked* (2xx), because a probe
that only pinged `/healthz` would report green while a revoked token silently blocked every push.

Chosen over two alternatives: polling the existing `xenon_status` (reports config, never touches
the network, and hits the OS keychain on every tick), and status-on-push-only (accurate but only
after a failure — exactly the situation this is meant to pre-empt).

## Research

- **`xenon_status` is not a connectivity check.** `commands.rs:1485` reads config and asks the
  keychain whether a token exists. It never issues a request. Its `configured: true` was reported
  in a session where the caller had no idea if the server was up.
- **One request answers both questions.** The Xenon server's `authenticate` (`~/Source/xenon/src/
  auth.rs:265`) returns `Ok(None)` for an *absent* credential but `Err(unauthorized)` for one that
  is present and bad — "so a typo never silently degrades into an anonymous request". So
  `GET /v1/projects` with our bearer returns 200 when the token is good and 401 when it is not,
  while a dead server fails at the transport layer. `/healthz` exists (`~/Source/xenon/src/
  lib.rs:26`) but cannot see the token, so it is not used.
- **The footer already has the exact idiom to copy.** `system:attention`, `review:quality`, and
  `review:priority` are all `sourceId`-keyed maps in `WorkspaceFooter`, rendered into the right
  zone by a small `render*()` method, with the publisher owning the data and the footer owning
  only presentation. This spec adds a fourth in the same shape rather than inventing a mechanism.
- **Colour policy is already split.** The attention gauge is coloured by reversibility tier
  (spec 138); the review and priority gauges are deliberately never coloured (ADR-0004, ADR-0009)
  because they are advisory depth, not demand. A link fault is demand, so it colours — recorded as
  ADR-0017 so the split stays legible.
- **Keychain churn is a real cost of polling.** `load_token` opens a `keyring::Entry` per call. A
  60-second probe would do that ~60×/hour for no benefit, so the probe path caches the token for
  the process lifetime, invalidated by `xenon_set_token` and by a `base_url` change.

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| VS Code | "Remote Indicator" pinned to the far left of the status bar: `><` glyph + host name, with dedicated theme colors `statusBarItem.remoteBackground` / `remoteForeground`, and `statusBarItem.offlineBackground` / `offlineForeground` when the workbench goes offline | Always present when remote, colour carries the state. The model this design follows most closely |
| Obsidian Sync | Status-bar icon with four states — **Synced** (green), **Syncing** (purple), **Paused** (purple), **Disconnected** (red) — plus a hover tooltip carrying the detail | Confirms a small fixed state set beats a free-text status; the tooltip is where the detail lives |
| Zed | Collaboration/connection state surfaced in the title bar with a reconnecting state | Ephemeral toast for transitions, persistent affordance for steady state |
| iTerm2 | Configurable status-bar components (Job, Network Utilization); no server-link component | No equivalent — iTerm2 has no backend to be linked to |
| tmux | `status-right` is user-scripted; no built-in link state | No equivalent |

**Krypton delta** — matches convention on *always visible, colour carries state, tooltip carries
detail*. Diverges on two points: (1) the segment is keyboard-actionable (`⌘P X` re-probes) rather
than click-to-open-a-menu, per the keyboard-first constraint; (2) it is hidden entirely — not
shown greyed — when `[xenon].enabled = false`, because the footer's established idiom is to stay
quiet about subsystems that are switched off rather than advertise them.

## Affected Files

| File | Change |
|------|--------|
| `src-tauri/src/xenon.rs` | New `probe()` + `LinkState`/`LinkReport`; process-lifetime `TOKEN_CACHE` and `PROJECT_CACHE` |
| `src-tauri/src/commands.rs` | New `xenon_probe` command |
| `src-tauri/src/config.rs` | New `[xenon].probe_interval_secs` (default 60); manual `Default` so the default is 60, not 0 |
| `src-tauri/src/lib.rs` | Register `xenon_probe` |
| `src/backend-link.ts` | **New** — probe scheduler; publishes `system:backend-link` to the ViewBus. Also exports `publishLinkFromPush()` |
| `src/view-bus-types.ts` | New `system:backend-link` signal + `BackendLinkState` |
| `src/workspace-footer.ts` | New `linkEl` segment + `renderLink()`, `linkByBackend` map |
| `src/styles/workspace-footer.css` | `--link` segment + `--link-offline` / `--link-unauthorized` states |
| `src/config.ts` | New `XenonConfig` on `KryptonConfig` — the scheduler reads `probe_interval_secs` |
| `src/main.ts` | Construct + start the probe scheduler; re-apply interval on config hot-reload |
| `src/input-router.ts` | `⌘P X` — probe now, toasting the resulting state |
| `src/which-key.ts` | Help entry for `X` |
| `src/acp/xenon-push.ts` | New `linkEvidenceFromPush()` — what a completed `#push` proves about the link |
| `src/acp/acp-harness-view.ts` | `runXenonPush` publishes the link signal from the `PushReport` |
| `docs/adr/0017-backend-link-is-coloured-by-fault.md` | **New** ADR |
| `docs/212-xenon-resource-server.md`, `04-architecture.md`, `06-configuration.md`, `PROGRESS.md` | Cross-references + config table row |

**Implementation notes (deltas from the design above):**

- `xenon_set_token` invalidates the cache indirectly: `xenon::store_token()` calls
  `clear_token_cache()` itself, so every writer of the vault — not just that one command —
  is covered.
- `derive_project` shells out to `git remote get-url`, which on a 60-second timer is a
  subprocess a minute for a value that changes when the remote does. It is cached the same
  way and for the same reason as the token (`PROJECT_CACHE`, keyed by cwd + configured
  override).
- The signal carries `baseUrl` and `project` in addition to the fields sketched below; the
  tooltip names the server that is broken, which it cannot do from `state` and `detail`
  alone.
- The push-derived update lives in `linkEvidenceFromPush()`, which returns `null` when the
  push proves nothing — an empty push never touched the network, and a `blocked` item was
  stopped by the local secret scan before any request. Reporting those as `linked` would
  paint a dead server green.

## Design

### Data Structures

```rust
// src-tauri/src/xenon.rs
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LinkState { Linked, Offline, Unauthorized, Off }

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkReport {
    pub state: LinkState,
    pub base_url: String,
    pub project: String,
    /// Human-readable cause for a non-linked state; `None` when linked.
    pub detail: Option<String>,
    pub latency_ms: Option<u64>,
    /// Unix seconds; when the probe ran.
    pub checked_at: i64,
}
```

```ts
// src/view-bus-types.ts
'system:backend-link': {
  backendId: string;            // 'xenon'
  label: string;                // short segment text, e.g. 'xenon'
  state: 'linked' | 'offline' | 'unauthorized' | 'off';  // 'off' removes the entry
  detail: string | null;
  latencyMs: number | null;
  checkedAt: number;
};
```

### API / Commands

```rust
#[tauri::command]
pub async fn xenon_probe(
    config: State<'_, Arc<RwLock<KryptonConfig>>>,
    cwd: String,
) -> Result<crate::xenon::LinkReport, String>;
```

Returns `state: Off` (never `Err`) when Xenon is disabled or `base_url` is empty — an unconfigured
backend is not an error condition. `Err` is reserved for a poisoned config lock.

Token caching lives in `xenon.rs` as `static TOKEN_CACHE: RwLock<Option<(String, String)>>`
(base_url → token). `load_token_cached(base_url)` reads through it; `store_token` clears it. The
push path keeps using the uncached `load_token`, so a push never acts on a stale credential.

### Data Flow

```
1. main.ts constructs BackendLinkProbe(bus, cwd) and calls .start()
2. .start() probes immediately, then on an interval of [xenon].probe_interval_secs
   (default 60; 0 disables the interval, leaving manual + push-driven updates)
3. The interval tick is skipped while document.visibilityState === 'hidden'
   (a hidden workspace has no one to inform), and fires once on the next
   'visibilitychange' back to visible
4. Each tick invokes xenon_probe → Rust issues GET {base_url}/v1/projects
   with the cached bearer, 5s timeout
5. Rust maps the outcome: transport error → Offline · 401/403 → Unauthorized ·
   2xx → Linked · other status → Offline with the status in `detail`
6. BackendLinkProbe publishes system:backend-link with the mapped state
7. WorkspaceFooter.renderLink() sets the segment text, state class, and title
8. After any #push, runXenonPush publishes the same signal derived from the
   PushReport — a real interaction is better evidence than a probe, and it
   updates the segment with no extra request
```

### Keybindings

| Key | Context | Action |
|-----|---------|--------|
| `X` (Shift+x) | Compositor mode (`⌘P` leader) | Probe the backend link now; flash the resulting state as a chip |

`x` (lowercase) is already close-window; no uppercase letter is bound in Compositor mode today.

### UI Changes

The segment is prepended to `rightEl`, ahead of `priorityEl`, so it sits at the outer edge of the
global cluster (VS Code's remote-indicator placement).

```html
<span class="krypton-workspace-footer__segment krypton-workspace-footer__segment--link
             krypton-workspace-footer__segment--link-offline">
  <span class="krypton-workspace-footer__link-glyph">⇄</span><span>xenon offline</span>
</span>
```

| State | Text (detail density) | Text (compact) | Colour |
|-------|----------------------|----------------|--------|
| `linked` | `⇄ xenon 24ms` | `⇄ xenon` | dim/neutral (footer foreground, reduced opacity) |
| `unauthorized` | `⇄ xenon auth` | `⇄ xenon auth` | warning |
| `offline` | `⇄ xenon offline` | `⇄ xenon offline` | fault |
| `off` | *(segment hidden)* | *(hidden)* | — |

Tooltip (all states) carries `base_url`, project slug, last-checked time, and — for the fault
states — the concrete fix (`server unreachable at <url>` / `token rejected — store a new one with
#xenon token <token>`). Static: no pulse, no animation, consistent with the attention gauge.

### Configuration

| Section | Key | Type | Default | Notes |
|---------|-----|------|---------|-------|
| `[xenon]` | `probe_interval_secs` | integer | `60` | Background link-probe cadence. `0` disables the interval; the segment then updates only on `⌘P X` and after a `#push`. Hot-reloaded with the rest of `[xenon]` |

## Edge Cases

- **Xenon disabled or `base_url` empty** → `Off`, segment hidden, no request, no keychain read.
- **`enabled = true` but no token stored** → `Unauthorized` with detail `no token stored`, without
  issuing a request. Distinguishing "never set up" from "rejected" in the tooltip matters.
- **Config hot-reload changes `base_url`** → the token cache is keyed by URL, so a mismatch falls
  through to the keychain; the next tick reports against the new server.
- **Probe overlaps a long `#push`** → independent requests; the push's own signal publication wins
  because it lands later and carries stronger evidence.
- **Window hidden / workspace not visible** → interval skipped, one probe on re-show.
- **Server reachable but returns 5xx** → `Offline`, status text in `detail` (a server that cannot
  answer is not a link you can push over).
- **Footer hidden (`toggleVisible`)** → probing continues; the segment is simply not rendered. The
  scheduler is stopped only on app teardown.
- **`live-assist` auxiliary window** → does not render the workspace footer and gets no probe;
  explicitly out of scope per the spec-208 constraint.

## Out of Scope

- Any backend other than Xenon. The signal is `backendId`-keyed so a second publisher needs no
  footer change, but none is added here.
- Retrying or auto-draining the Xenon push queue on reconnect (a separate concern; see the
  finding in the spec-212 Review Board about the queue never being drained).
- A click target on the segment. Krypton is keyboard-first; `⌘P X` is the affordance.
- Surfacing the link state in the ACP Harness view, Raycast extension, or Telegram controller.
- Changing what `#xenon status` prints.

## Resources

- [VS Code Theme Color reference](https://code.visualstudio.com/api/references/theme-color) —
  `statusBarItem.remoteBackground` / `offlineBackground`; confirmed colour-carries-state for the
  remote indicator
- [VS Code Status Bar UX guidelines](https://code.visualstudio.com/api/ux-guidelines/status-bar) —
  primary (left) / secondary (right) item grouping, which informed placing the segment at the
  outer edge of the right cluster
- [Obsidian Sync — Status icon and messages](https://obsidian.md/help/sync/messages) — the
  four-state model (Synced / Syncing / Paused / Disconnected) and tooltip-carries-detail pattern
- `~/Source/xenon/src/auth.rs`, `src/api.rs`, `src/lib.rs` — local server source; established that
  one authenticated `GET /v1/projects` distinguishes unreachable / unauthorized / linked
