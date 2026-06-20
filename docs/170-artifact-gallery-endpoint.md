# Artifact Gallery (Loopback Web Endpoint) — Implementation Spec

> Status: Implemented (rev 1)
> Date: 2026-06-21
> Milestone: ACP Harness — observability
> Builds on: `docs/168-harness-lane-monitor.md` (the loopback dashboard pattern), `docs/133-harness-html-artifacts.md` (the artifact registry), `docs/149-artifact-inline-feedback.md` (the per-artifact feedback token)

## Architecture

The artifact gallery is a **second fixed page served by the built-in loopback HTTP server**, opened in an external browser — a direct sibling of the lane-monitor dashboard (spec 168). It surfaces every live HTML artifact across every open harness in one glanceable grid, grouped by harness, with one-click open.

- `GET /gallery` — serves a standalone HTML page (`src/acp/artifact-gallery.html`, embedded via `include_str!`). No token, no auth, loopback-only. Same response headers as `/dashboard` (`text/html`, `nosniff`, `no-referrer`, `no-store`).
- `GET /artifacts` — token-free JSON the page polls ~1 s:
  ```json
  { "harnesses": [ { "harnessId": "hm-1", "artifacts": [
    { "id": "art-3-...", "laneLabel": "Cursor-1", "title": "...",
      "state": "live" | "pending", "size": 12345, "hash": "<sha256hex>",
      "tail": ".krypton/artifacts/hm-1/cursor-1/art-3-....html",
      "token": "<feedbackToken>" } ] } ] }
  ```
  Deterministic ordering: harnesses by id asc; artifacts within a harness by `laneLabel` then `id`. Includes both `pending` and `live` artifacts. Backed by `HookServer::list_all_artifacts_for_gallery()` — a read-only iteration over the in-memory `artifacts` registry.
- **Open commands** (mirror the dashboard wiring exactly): command palette `Open Artifact Gallery` (`gallery.open`) → `compositor.openGallery()`; the harness **`#gallery`** composer command. Both build the URL from `get_hook_server_port` + `open_url`. No dedicated keybinding (the dashboard's `Leader Shift+L` slot is taken; palette + `#gallery` are sufficient).
- **The gallery page** (`src/acp/artifact-gallery.html`) reuses the dashboard's exact Binance-dark shell (`:root` vars, `.top` brand bar, `.dot.live` beacon, `.stats`, `.state` banner, mono fonts, `@media (max-width: 780px)`) and adds a `.cards` grid of artifact cards. Each card shows title (2-line clamp), lane, a `live`/`pending` state pill, human-readable size, the hash prefix + tail, and an **Open** link — same-origin relative `href="/artifact/<encodeURIComponent(token)>"` with `target="_blank" rel="noopener"`. Pending cards render a disabled chip (no open) + "writing..." size. A 1 s `setInterval` poll with a JSON-signature stale check avoids DOM thrash; bad fetches fall back to a `reconnecting...` banner and retain the last good render. The Open link derives the origin from `window.location`, so the page is build-time-port-free.

## Gallery = active set (registry), NOT disk

The gallery reads **only the in-memory artifact registry** (`HookServer.artifacts: HashMap<String, HarnessArtifactStore>`). A disposed/closed harness is removed from that registry, so it delists automatically — the gallery shows only artifacts belonging to harnesses whose lanes are currently live. This is by design: **disk is append-only history; the registry is the active set.** There is intentionally no disk rehydration on startup, so a prior session's registered artifacts persist on disk yet do not reappear in the gallery after a restart (see "Caveats" below).

## Append-only artifact files (Slice 4 — resolved fork)

The human directed: **do not delete artifact files.** All four file-deletion paths in `hook_server.rs` were removed; only the in-memory cleanup is preserved:

| Path | Before | After |
|------|--------|-------|
| `dispose_harness_artifacts` (harness close) | `remove_dir_all(artifacts/<harnessId>/)` + registry/token/telemetry drop | registry/token/telemetry drop **only** — files preserved |
| `sweep_stale_artifacts` (init) | reclaimed any `hm-*` dir not in the live registry | **function + call + test deleted**; `init_harness_artifacts` lost its `live_harness_ids` param |
| `artifact_cancel` (lane cancels a pending artifact) | `remove_file(<id>.html)` + entry/token drop | entry/token drop **only** — file preserved |
| `cancel_pending_artifacts` (turn-end/teardown bulk cancel) | collected `paths` + `remove_file` loop | entry/token cleanup **only** — `paths` Vec removed |

The model is now: **disk = append-only history; registry = active set.** Closing a harness delists it (gallery) and revokes its feedback tokens (`/artifact/<token>` → 410) but leaves the files on disk as a historical record.

## Security posture (the token-enumeration trade-off — flagged, Option A shipped)

Spec 149 made the feedback token the **sole, deliberately non-enumerable** capability for `/artifact/<token>` (read), `/artifact/state/<token>` (poll), and `/artifact/feedback/<token>` (comment submission). The `/artifacts` JSON returns every artifact's `token`, which makes artifacts **enumerable over loopback**.

Shipped as-is (Option A) because:
1. Loopback-only (`127.0.0.1`) — same trust boundary as `/telemetry`, which already exposes lane metadata token-free.
2. The gallery structurally cannot open artifacts without handing tokens to the page — enumerate-then-open *is* the feature.
3. The human's directive was "same way as dashboard."

**Sharpest edge (conscious sign-off):** the token is not only a read-capability — `POST /artifact/feedback/<token>` is a **turn-injection capability** (it queues a comment batch into the owning lane's prompt queue). So `/artifacts` widens the loopback surface from "read an artifact you have the token for" to "harvest every token, then inject feedback into any lane." Consistent with the existing `/telemetry` posture, but a deliberate, recorded acceptance rather than an accident. No Host-header/rebinding guard (pre-existing for `/telemetry`, out of scope here). Tightening to Option B (drop the token, route opens through a one-time view-token redirect) remains a future option if the loopback threat model changes.

## Caveats (from cross-review, documented by design)

1. **Unbounded on-disk growth.** With `sweep_stale_artifacts` gone, `.krypton/artifacts/<harnessId>/<lane>/*.html` accumulates forever across restarts. There is no in-app GC, retention policy, or bound. Reclaiming disk is a manual `rm -rf .krypton/artifacts/`. The `.gitignore` is still auto-managed (so no git pollution). A future age/size-based GC is the natural follow-up if growth becomes a problem.
2. **Persisted files are not browsable after restart.** `init_harness_artifacts` builds an empty `entries` map on every start; there is no disk rehydration. A prior session's registered artifacts persist on disk but vanish from the gallery the moment their harness closes — exactly the "gallery lists only active lanes' folders" requirement. This is correct by design but subtle: someone reading "files persist" may later expect them to re-list.
3. **Token enumerable over loopback** — see Security posture above.

## Affected Files

| File | Change |
|------|--------|
| `src-tauri/src/hook_server.rs` | `list_all_artifacts_for_gallery()` pub method (read-only iteration of the registry); `handle_gallery()` + `handle_artifacts()` handlers; `GET /gallery` + `GET /artifacts` routes (+ the route-existence probe); `GALLERY_HTML` const (`include_str!` of the gallery page). Slice 4: removed all four file-deletion paths; `sweep_stale_artifacts` fully deleted; `init_harness_artifacts` lost its `live_harness_ids` param. |
| `src/acp/artifact-gallery.html` | **New.** Standalone gallery page; polls `/artifacts` ~1 s, renders the harness-grouped card grid, reuses the dashboard's Binance-dark shell. |
| `src/compositor.ts` | `openGallery()` — mirror of `openDashboard()` pointed at `/gallery`. |
| `src/command-palette.ts` | `gallery.open` entry — "Open Artifact Gallery". |
| `src/acp/acp-harness-view.ts` | `#gallery` composer command — mirror of `#dashboard`. |
| `docs/PROGRESS.md`, `CLAUDE.md` | Document the gallery endpoint + the append-only file model. |

## Tests

`cargo test hook_server` — 31 tests, 0 failures. Gallery-specific:
- `gallery_lists_pending_and_live_across_two_harnesses` — JSON shape, states, tokens, tails, sort across harnesses.
- `gallery_includes_empty_live_harness` — `{ harnessId, artifacts: [] }` for a zero-artifact live harness.
- `gallery_and_artifacts_routes_return_expected_shapes` — `GET /gallery` → 200 + `text/html`; `GET /artifacts` → 200 + `{ harnesses: [...] }` + `no-store`.
- `gallery_sorts_artifacts_within_harness_by_lane_then_id` — locks down the within-harness ordering.
- `gallery_omits_cancelled_artifact` — cancelled id absent from the listing (security-model guarantee).
- `cancel_preserves_pending_artifact_file` — cancel drops the entry but the file remains on disk.
- `dispose_preserves_artifact_files_on_close` — dispose drops registry + token + telemetry, but the file remains on disk AND the harness delists from the gallery.

Frontend: `npm run check` (tsc --noEmit) clean; `cargo clippy` zero warnings; `cargo fmt -- --check` clean.

## Cross-review

Built `#polly`-style: three implementation slices (Rust endpoints / gallery page / open-wiring) dispatched as parallel implementers with disjoint file scopes, then a follow-up deletion-stop slice. Each slice cross-reviewed by a different worker than its implementer (diff + contract only). Outcomes: Slice 1 (Rust) — 0 blockers, 3 warnings; Slices 2+3 (Frontend) — 0 blockers, 4 warnings; Slice 4 (deletion-stop) — 0 blockers, 2 warnings. All approved. See the review-quality matrix.
