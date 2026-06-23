# Artifact Gallery — Disk Rehydration on Startup — Implementation Spec

> Status: Implemented (rev 2)
> Date: 2026-06-23
> Milestone: ACP Harness — observability
> Builds on / amends: `docs/170-artifact-gallery-endpoint.md` (reverses its "registry NOT disk" decision), `docs/133-harness-html-artifacts.md` (artifact registry + the `acp-harness-artifact` mirror event), `docs/149-artifact-inline-feedback.md` (per-artifact feedback token + the frontend feedback guards)

## Problem

After an app restart the artifact gallery is empty even though the HTML files are still on disk. Spec 170 deliberately made the gallery reflect only the in-memory registry, which starts empty every run. The user wants **every artifact under the active project's `.krypton/artifacts/` folder to re-load and stay fully interactive (openable + able to receive inline feedback) after a restart — regardless of which `harnessId` subfolder it lives in.**

## Solution

When a harness registers, **rehydrate the in-memory artifact store from the entire on-disk tree** under that project's `.krypton/artifacts/` — every `*/<lane>/<id>.html`, ignoring the `harnessId` subfolder name. Each file becomes an `ArtifactEntry` **re-homed under the currently-live harness id**, with its feedback token (parsed back out of the file) registered active. Then the frontend, after attaching its listeners, **fetches those entries and replays them through the existing `handleArtifactEvent` mirror path** — so its `this.artifacts` map (the gate the feedback handler checks) knows them and raises cards under any matching live lane.

Re-homing to the live harness id is what makes feedback work without a second code path: the feedback POST emits `harnessId + laneLabel`, and both the Rust token record and the frontend mirror now carry the *live* harness id, so the existing routing (`acp-harness-view.ts:2092/2103/2114`) accepts it exactly as it does a same-session artifact. One uniform pattern; rehydrated and freshly-created artifacts are indistinguishable. No retention/GC, no separate "archived/read-only" mode.

## Research

- **Everything a gallery row + a mirror record needs is recoverable from the file:**
  - `id` ← filename stem; `laneLabel` ← parent dir name; `tail`/`path` ← the real on-disk path.
  - `title` ← parsed from `<title>…</title>` (seeded from `{{title}}` at `hook_server.rs:811`).
  - `feedback_token` ← parsed from `window.__KRYPTON_FEEDBACK__ = { token: "…" }` baked into the scaffold (`artifact-scaffold.html:118`; confirmed present in a live on-disk file).
  - `size` ← `metadata().len()`; `hash` ← re-hash bytes (same routine `artifact_register` uses).
- **The token MUST come from the file, not be re-minted** — the served HTML POSTs with the token baked into *that file* (`artifact-scaffold.html:311`); a mismatched registry token would 404.
- **Feedback has three frontend guards (all must pass):** `harnessId === this.harnessMemoryId` (`:2092`); a live lane with `displayName === laneLabel && status !== 'stopped'` (`:2103`); and `this.artifacts.get(artifactId)` present with matching `laneLabel` (`:2114`). The third is why a Rust-only change is insufficient — the **frontend mirror must be populated**, which today only happens via the `acp-harness-artifact` event emitted from `artifact_tool_new`/`artifact_tool_register` (`hook_server.rs:2679/2707`).
- **Event timing forces a fetch, not an emit-on-init.** `init_harness_artifacts` runs inside `create_harness_memory` *before* the frontend attaches its `acp-harness-artifact` listener (`acp-harness-view.ts:4321`) and sets `harnessMemoryId`. Events emitted during init are lost. So the frontend must **pull** rehydrated entries after listener-attach — mirroring `refreshMemory()` / `refreshMcpStats()`, which sit right there in `initializeHarnessMemory` (`:4324`).
- **Established precedent:** `register_harness` already rebuilds the in-memory `lanes` map by reading persisted memory JSON off disk (`hook_server.rs:370-385`). This applies the same pattern to artifacts.
- **Reverses spec 170 §"Gallery = active set, NOT disk" + Caveat 2.** Caveat 1 (unbounded growth, no GC) becomes an accepted property — the user chose **no retention**.

## Prior Art

No terminal-emulator equivalent — this is an internal observability registry, not a user-facing terminal feature. Closest general pattern: **rebuilding an in-memory index from an on-disk source of truth on startup** (a server reconstructing a session index by scanning its data dir). Krypton already does this for harness memory (above). N/A for market comparison.

## Affected Files

| File | Change |
|------|--------|
| `src-tauri/src/hook_server.rs` | `init_harness_artifacts` rehydrates: new helper `rehydrate_artifacts_from_disk(live_harness_id, artifacts_root)` walks **every** `*/<lane>/<id>.html` under the project's artifacts root, parses title + token, stats/hashes, and builds entries keyed in the live harness store + token records under the live harness id. Bump `next_artifact_seq` past the max rehydrated seq. New parse helpers `parse_artifact_title` / `parse_feedback_token`. New `pub fn list_harness_artifacts(harness_id) -> Vec<Value>` returning `acp-harness-artifact`-shaped rows (state `registered`) for one harness. |
| `src-tauri/src/commands.rs` + `lib.rs` | New command `acp_list_harness_artifacts(harness_id) -> Result<Vec<Value>, String>` exposing `list_harness_artifacts`; register in `generate_handler!`. |
| `src/acp/acp-harness-view.ts` | New `refreshArtifacts()` (mirror of `refreshMemory`): invoke `acp_list_harness_artifacts`, feed each row through the existing `handleArtifactEvent`. Call it at the end of `initializeHarnessMemory` after the artifact listener is attached. No changes to the feedback handler or `handleArtifactEvent`. |
| `docs/170-artifact-gallery-endpoint.md` | Amend §"Gallery = active set, NOT disk" + Caveat 2 to reference this spec (behaviour reversed); note Caveat 1's no-GC growth is now accepted. |
| `docs/PROGRESS.md`, `CLAUDE.md` reference list | Note the gallery rehydrates from disk on startup. |

## Design

### Rehydration (Rust)

```rust
// init_harness_artifacts(live_harness_id, project_dir):
//   root = artifacts_root(project_dir);            // <project>/.krypton/artifacts
//   entries, tokens = rehydrate_artifacts_from_disk(live_harness_id, &root);
//   self.artifacts.insert(live_harness_id, HarnessArtifactStore { project_dir, entries });
//   self.feedback_tokens.extend(tokens);
//   bump next_artifact_seq past max rehydrated seq.

fn rehydrate_artifacts_from_disk(
    live_harness_id: &str,
    root: &StdPath,                 // .krypton/artifacts (scan ALL <harnessId>/ subdirs)
) -> (HashMap<String, ArtifactEntry>, Vec<(String, FeedbackToken)>)
```

Per file `<root>/<anyHarnessDir>/<laneDir>/<id>.html`:
1. `id` = filename stem; skip files whose stem isn't `art-<n>-<hex>` (ignore strays, the `.gitignore`).
2. Read file → `parse_artifact_title` (`<title>`, fallback `id`), `parse_feedback_token`.
3. If no token parses → **skip** (an artifact that can't carry feedback would break the uniform contract; unreachable at runtime since every `artifact_new` bakes one). `debug`-logged.
4. `size` = len; `hash` = re-hash; `path` = the real file path; `tail` = its project-relative tail (kept as the **real** on-disk path, under its original harness dir).
5. Build `ArtifactEntry { id, lane_label: <laneDir>, title, path, tail, state: RegisteredLive, size, hash, feedback_token }` and `FeedbackToken { harness_id: live_harness_id, lane_label: <laneDir>, artifact_id: id, revoked: false }`.

`harnessId` in the **token** is the live harness (routing key); the file's **path** stays where it physically is. The two diverge intentionally — serving reads `path`; feedback routes on the token's live `harness_id`.

### Data flow

```
1. App start; harness opens → create_harness_memory (Rust register_harness)
2.   init_harness_artifacts(hm-1, project_dir):
        scan ALL of .krypton/artifacts/**, build entries + tokens under hm-1
3. Frontend sets harnessMemoryId, attaches acp-harness-artifact listener (:4321)
4. Frontend refreshArtifacts(): invoke acp_list_harness_artifacts(hm-1)
5.   for each row → handleArtifactEvent({ state:'registered', harnessId:hm-1, ... })
        → this.artifacts.set(id, record)            (mirror populated → guard :2114 ok)
        → raiseArtifactCard: appends a card IF a live lane matches laneLabel
6. GET /artifacts (browser gallery) lists every rehydrated row (unchanged handler)
7. Browser opens /artifact/<token>; POST feedback → emit harnessId=hm-1 + laneLabel
        → guards :2092/:2103/:2114 pass when laneLabel is a live lane → prompt queue
```

### State

All rehydrated entries are `RegisteredLive` (a persisted file is finished history; a never-registered scaffold also restores as live — opens to the styled placeholder). `Pending` is a within-turn transient, not reconstructed.

## Edge Cases

| Case | Handling |
|------|----------|
| No `.krypton/artifacts/` dir | Empty store (today's behaviour). |
| File without a parseable token | Skipped + `debug`-logged. |
| Same `art-N` seq across old sessions | Distinct full ids via random suffix → distinct keys; both list. |
| Artifact's lane label is **not** a live lane this run | Lists in the gallery + serves; feedback POST returns `no_live_lane` (409) — identical to a same-session artifact whose lane stopped. Inherent: feedback can only inject into a live lane. Not a separate pattern. |
| Two live harnesses share one `project_dir` | Both scan the same tree → gallery shows the set under each harness group; the token map's `harness_id` is last-writer-wins. Documented; uncommon. |
| Harness close | Unchanged: registry + tokens dropped, files preserved; a re-open re-rehydrates. |
| Large history (no GC) | Startup scan + hash cost grows with disk size — accepted (no retention). |

## Open Questions

None blocking. Acknowledged, non-fork limitation: feedback only *lands* when the artifact's lane label matches a currently-live lane — architectural, since feedback is injected into a live lane's prompt queue. Listing + opening always work; submitting feedback to a lane that no longer exists this session cannot, and inventing a sink for it would be the forbidden second pattern.

## Out of Scope

- Retention / GC / size bounds (explicitly none).
- A second "archived, read-only, no-feedback" mode (ruled out).
- Reconstructing `Pending` state across restarts.
- Any change to the gallery page, `/artifacts` JSON shape, feedback endpoints, or `handleArtifactEvent` itself — all unchanged; rehydration reuses them.

## Resources

N/A — purely internal change. Findings came from `src-tauri/src/hook_server.rs`, `src-tauri/src/commands.rs`, `src-tauri/resources/artifact-scaffold.html`, `src/acp/acp-harness-view.ts`, an on-disk artifact file, and prior specs 133 / 149 / 170.
