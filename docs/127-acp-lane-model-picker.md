# ACP Lane Model Picker — Implementation Spec

> Status: Implemented
> Date: 2026-05-29
> Milestone: M-ACP — Harness convergence

## Problem

Spec 126 made `lane_models.<backend>.active` actually apply at session start, but the only way to
change a harness lane's model is to edit `krypton.toml` and respawn the lane. There is no in-app,
keyboard-driven way to switch a running lane's model. This is the deferred follow-up spec 126
explicitly called out (Out of Scope → "Interactive in-harness model **picker** UI / mid-session
switching"). The user wants to pick a model from a list inside the harness and have the live lane
switch to it.

## Solution

Add a keyboard-driven model picker overlay to the harness, opened with **leader → `,`** (`⌘P` then
`,`; verified free in spec 126 and re-confirmed here). The picker lists the **agent-advertised**
`availableModels` from the lane's `session/new` response (no hand-maintained catalog), marks the
current model, and on `↵` performs a **live** `session/set_model` on the running session via a new
`acp_set_lane_model` Tauri command. We mirror Zed's proven shape: optimistic local update, revert on
RPC error, guarded by a **per-lane in-flight epoch** so a slow/failed switch A can never clobber a
later switch B. The Claude adapter already recomputes context-window / effort / available-modes on a
model switch and emits `current_mode_update` when it must clamp the mode — Krypton already consumes
that, so resync is handled adapter-side; this spec only makes the resulting **mode downgrade visible**
to the user (a transcript notice) rather than re-asserting modes itself (which would be wrong and
could error).

> Codex-1 review (2026-05-29) folded in: richer `apply_session_model` return to fix the stale
> `currentModelId` marker; resume/load now parses & surfaces `models`; per-lane switch epoch for
> concurrent switches; mode-downgrade detection moved into the `mode_update` handler (token + timeout)
> instead of a blind 3s window; explicit lane-header re-render on `mode_update`; timeout treated as
> "uncertain", not a hard failure.

## Research

- **Spec 126 dropped the model list.** `acp_session_new` (`src-tauri/src/acp.rs:1117`) passes
  `new_session["models"]` to `apply_session_model` purely as a capability gate, then discards it.
  `AgentSessionInfo`/`AgentInfo` carry only `model_apply_failed` (no `availableModels`/`currentModelId`).
  To populate a picker we must **surface** that already-present list, not invent one.
- **The model list is the agent's, advertised in `session/new`.** claude-agent-acp v0.39.0
  `getAvailableModels` (`dist/acp-agent.js:2120`) returns
  `models: { availableModels: [{ modelId, name, description }], currentModelId }`. IDs come from the
  Claude SDK init result, not hardcoded — so the picker stays zero-maintenance and never drifts.
- **Live switch is one UNSTABLE RPC.** `session/set_model { sessionId, modelId }`
  (`@agentclientprotocol/sdk` `SetSessionModelRequest`, x-method `session/set_model`, returns `{}`).
  The adapter's `unstable_setSessionModel` (`acp-agent.js:1016`) resolves aliases via
  `resolveModelPreference`; unknown ids are passed verbatim and may error — so the switch must be
  **non-fatal / revertible**, never canonicalized client-side.
- **Adapter owns the resync.** `applyConfigOptionValue` model branch (`acp-agent.js:1323-1393`) resets
  the context-window heuristic, rebuilds effort options, recomputes `availableModes`, and **clamps the
  current mode to `default`** if the new model lacks it (e.g. `auto` on Haiku) — emitting
  `current_mode_update` **before** the `config_option_update`. Krypton already consumes
  `current_mode_update` → `lane.currentMode` (`acp-harness-view.ts:2597`). So Krypton must NOT
  reassert modes; it only needs to (a) consume the update (already done) and (b) surface the downgrade.
- **Zed prior art (`crates/agent_servers/src/acp.rs:3981-4005`).** `AcpModelSelector::select_model`
  saves `old_model_id`, optimistically sets `current_model_id`, sends `SetSessionModelRequest` on the
  live session, and **reverts on RPC error**. Mode and model are orthogonal — selecting a model does
  not re-fetch modes. Model is never a `session/new` field and never reaches MCP servers.
- **Harness infra reuse (re-confirmed in source).** Leader bindings live in `getLeaderKeyBindings()`
  (`acp-harness-view.ts:1538-1580`); `,` is unbound. Overlays are `<aside hidden>` siblings whose keys
  route through the single `onKeyDown()` dispatcher (priority-ordered early returns,
  `acp-harness-view.ts:1582-1721`); j/k/↵/esc is the established picker idiom (lane picker
  `handlePickerKey:3243`, directive picker `handleDirectivePickerKey:3042`). Transient feedback uses
  `flashChip(msg)`; per-lane transcript notices use `appendSystemNotice(id, text)`.

## Prior Art

| App | Implementation |
|-----|---------------|
| **Zed** (`agent_servers/src/acp.rs`, `agent_ui/src/model_selector.rs`) | Fuzzy-searchable `Picker` listing `available_models` from `session/new`; `select_model` does optimistic local update + `SetSessionModelRequest` on the live session + revert on error. Mode/model orthogonal; model never in `session/new`, never to MCP. |
| **Claude Code / claude-agent-acp** | Adapter advertises `availableModels`+`currentModelId`; `unstable_setSessionModel` resolves aliases, then internally recomputes modes/effort/context and clamps mode, emitting `current_mode_update`. |
| **Krypton today** | Config-only (`lane_models.<backend>.active`), applied once at `session/new` (spec 126). No runtime picker. |

**Krypton delta** — Keyboard-only overlay (no mouse, no fuzzy-search input box in v1: j/k/↵/esc over a
short agent-advertised list, matching the existing lane/directive pickers and the cyberpunk chrome).
Like Zed: optimistic + revert, agent-sourced list, never strict-gate against ids (aliases resolve
adapter-side — but here the picker only offers ids the agent advertised, so mismatches are rare).
Unlike Zed: the switch is **session-scoped only** in v1 — it does not rewrite `krypton.toml`, so the
config still governs the *spawn* default (documented below).

## Affected Files

| File | Change |
|------|--------|
| `src-tauri/src/acp.rs` | Add `ModelInfo { model_id, name, description }`; add `available_models: Vec<ModelInfo>` + `current_model_id: Option<String>` to `AgentSessionInfo`, parsing them in `acp_session_new` (camelCase→snake_case, filter malformed entries). Make `apply_session_model` return richer state so a successful exact-id apply can overwrite `current_model_id` (fix stale pre-switch marker). Parse `response.models` in `acp_session_restore` (currently discards the response) so resumed/loaded lanes also get a model list. New command `acp_set_lane_model(session, model_id) -> Result<SetModelOutcome, String>` (Ok / Timeout-uncertain) that looks up the client via the registry and sends `session/set_model` on the live session (10s timeout). |
| `src-tauri/src/lib.rs` | Register `acp::acp_set_lane_model` in `generate_handler!`. |
| `src/acp/types.ts` | Add `ModelInfo`; add `available_models?` + `current_model_id?` to `AgentSessionInfo`/`AgentInfo`. |
| `src/acp/client.ts` | Add `setLaneModel(modelId)` wrapper for the new command. |
| `src/acp/acp-harness-view.ts` | Thread `availableModels`/`currentModelId` into `HarnessLane` (from BOTH `sessionNew()` and the restore path — `configureLaneFromInfo` currently keeps only `session_id`); add `pendingModelSwitch`/`modelSwitchEpoch` lane fields; add leader `,` binding; build the model-picker overlay (`renderModelPicker`, `handleModelPickerKey`, `openModelPicker`/`closeModelPicker`) following the directive-picker pattern; epoch-guarded optimistic switch + revert; detect mode downgrade **inside the `mode_update` handler** when a pending switch matches; **make `mode_update` re-render the lane header** (today it sets `needsRender = false` and only calls `refreshMetricsRender()`, so the mode chip would not refresh). |
| `src/styles/acp-harness.css` | `.acp-harness__model-picker` styles (clone of `.acp-harness__directive-picker`). |
| `docs/06-configuration.md`, `docs/69-acp-agent-support.md`, `docs/PROGRESS.md` | Document the picker, leader `,`, and the session-scoped (non-persisted) semantics. |
| `docs/126-acp-lane-model-selection.md` | Flip the Out-of-Scope picker line to "implemented in spec 127". |

## Design

### Data Structures

```rust
// src-tauri/src/acp.rs — agent-advertised model entry
#[derive(Debug, Clone, Serialize)]
pub struct ModelInfo {
    pub model_id: String,
    pub name: String,
    pub description: Option<String>,
}

pub struct AgentSessionInfo {
    pub session_id: String,
    pub model_apply_failed: bool,              // spec 126, unchanged
    pub available_models: Vec<ModelInfo>,      // NEW — parsed from session/new `models.availableModels`
    pub current_model_id: Option<String>,      // NEW — `models.currentModelId` (pre-switch default)
}
```

`AgentInfo` (init path) gains the same two optional fields. When the backend advertises no model
state both are empty/None and the picker is disabled for that lane.

**Fix the stale marker (Codex-1 #1).** `models.currentModelId` is captured *before* spec 126's
spawn-time `set_model`, so returning it raw makes the picker mark the *pre-switch* default even when
the config apply succeeded. `apply_session_model` therefore returns the applied id, and
`acp_session_new` overwrites `current_model_id` with it **only when the configured value exactly
matches an advertised `modelId`** (an unambiguous canonical id). For an alias (e.g. `"opus"`) the
match is non-canonical, so we leave `current_model_id` as the agent default but do **not** assert it
as confirmed — the picker shows no `✓` rather than a wrong one. This also keeps the picker's
"already-current ⇒ no-op" check honest.

```rust
// apply_session_model now returns intent + applied id instead of a bare bool
struct ModelApplyResult { failed: bool, applied_model_id: Option<String> }
```

```typescript
// src/acp/acp-harness-view.ts — HarnessLane additions
availableModels: ModelInfo[];        // [] when backend advertises none
currentModelId: string | null;       // confirmed current id, or null when unverified
// epoch guard for concurrent switches (Codex-1 #3/#4):
modelSwitchEpoch: number;            // bumped on every dispatch
pendingModelSwitch:                  // set on dispatch, cleared on settle/timeout
  { epoch: number; prevModelName: string | null; prevModelId: string | null;
    prevModeId: string | null; pickedName: string; deadline: number } | null;
```

### API / Commands

```rust
// Live, user-initiated switch on a running lane. Distinguishes three outcomes so the
// frontend can revert on rejection but NOT hard-revert on a timeout (the agent may still
// switch — Codex-1 #6). Serialize JSON-RPC failure as Err; timeout as Ok(TimedOutUncertain).
#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SetModelOutcome { Ok, TimedOutUncertain }

#[tauri::command]
pub async fn acp_set_lane_model(
    session: u64,
    model_id: String,
    registry: State<'_, Arc<AcpRegistry>>,
) -> Result<SetModelOutcome, String> {
    let client = registry.get(session).ok_or("unknown ACP session")?;
    let sid = client.acp_session_id.read().ok().and_then(|g| g.clone())
        .ok_or("lane has no active session")?;
    match tokio::time::timeout(
        Duration::from_secs(10),
        client.request("session/set_model", json!({ "sessionId": sid, "modelId": model_id })),
    ).await {
        Ok(Ok(_))  => Ok(SetModelOutcome::Ok),
        Ok(Err(e)) => Err(format!("session/set_model failed: {e}")),  // rejected id → frontend reverts
        Err(_)     => Ok(SetModelOutcome::TimedOutUncertain),         // may still apply → no hard revert
    }
}
```

```typescript
// src/acp/client.ts
async setLaneModel(modelId: string): Promise<'ok' | 'timed_out_uncertain'> {
  return invoke('acp_set_lane_model', { session: this.sessionId, modelId });
}
```

### Data Flow

```
1. session/new returns { sessionId, models: { availableModels, currentModelId } }
   → acp_session_new parses the gate (spec 126) AND availableModels/currentModelId (new),
     overwriting current_model_id with the applied id when config matched an exact advertised id.
   (resume/load: acp_session_restore parses response.models the same way.)
2. AgentSessionInfo → frontend → lane.availableModels / lane.currentModelId
3. User: ⌘P then ','  → openModelPicker(focusedLane)
   - no client / no availableModels → flashChip('model picker: backend advertises no models'), abort
   - lane.pendingModelSwitch set (a switch is in flight) → flashChip('model switch already in flight'), abort
4. Overlay lists availableModels; cursor starts on lane.currentModelId (else 0); j/k move, ↵ select, esc cancel
5. On ↵ for a DIFFERENT model (same id ⇒ no-op close):
   a. epoch = ++lane.modelSwitchEpoch
   b. lane.pendingModelSwitch = { epoch, prevModelName, prevModelId, prevModeId: currentMode?.id,
        pickedName: picked.name, deadline: <set by a 12s timer> }
   c. optimistic: lane.modelName = picked.name; lane.currentModelId = picked.modelId;
      lane.modelApplyFailed = false; close picker; render lane; flashChip('→ '+picked.name)
   d. const outcome = await client.setLaneModel(picked.modelId)   // throws on rejected id
6. mode_update handler (adapter clamped the mode): updates lane.currentMode AND now re-renders the
   lane header. If lane.pendingModelSwitch is set and modeId !== pendingModelSwitch.prevModeId →
   appendSystemNotice(lane, 'model switch: mode downgraded to "<new>" — "<pickedName>" does not
   support "<prev mode>"'). Detection is gated by the live token, not a blind wall-clock window.
7. Resolution (only if epoch still === lane.modelSwitchEpoch — a newer switch wins):
   - outcome 'ok'               → clear pendingModelSwitch (keep optimistic state)
   - outcome 'timed_out_uncertain' → keep optimistic state, modelApplyFailed=true,
                                     flashChip('model switch timed out; state uncertain'); leave the
                                     token live until the deadline so a late mode_update still attributes.
   - throw (rejected id)        → revert modelName/currentModelId to prev, modelApplyFailed=true,
                                   flashChip('model switch failed: <reason>'), render.
   A deadline timer clears any still-pending token (covers a switch that neither errors nor emits a
   mode update), so the lane never gets stuck "in flight".
```

### Keybindings

| Key | Context | Action |
|-----|---------|--------|
| `,` | Harness leader (after `⌘P`) | Open model picker for the focused lane |
| `j` / `↓` | Model picker open | Move cursor down (wrap) |
| `k` / `↑` | Model picker open | Move cursor up (wrap) |
| `↵` | Model picker open | Switch focused lane to selected model |
| `esc` / `q` | Model picker open | Cancel |

Registered in `getLeaderKeyBindings()` with `{ key: ',', label: 'Switch Model', group: 'Lane' }` and
`isEnabled: () => focusedLane?.availableModels.length > 0`, `disabledReason: () => 'backend advertises
no models'`. Routed in `onKeyDown()` alongside the other picker overlays.

### UI Changes

New overlay `<aside class="acp-harness__model-picker" hidden>` (z-index between picker and directive
picker), cloning `.acp-harness__directive-picker`:

```html
<aside class="acp-harness__model-picker">
  <header class="acp-harness__picker-head">
    <span>// model · Claude-1</span>
    <span>j/k move · enter switch · esc cancel</span>
  </header>
  <ul class="acp-harness__picker-list">
    <li class="acp-harness__picker-row acp-harness__picker-row--cursor" data-current="true">
      <span class="acp-harness__picker-name">claude-opus-4-6 ✓</span>
      <span class="acp-harness__picker-desc">Most capable</span>
    </li>
    <!-- … one row per availableModels entry; ✓ marks current_model_id … -->
  </ul>
</aside>
```

No mouse handlers (keyboard-only, per architecture constraint). The current model is marked with `✓`
and `data-current`; the lane name comes from the focused lane. Reuses existing picker CSS variables —
no new color tokens (DESIGN.md compliance).

### Configuration

No new config keys. The picker is a **session-scoped** runtime switch and does **not** write
`krypton.toml`. `lane_models.<backend>.active` continues to govern the **spawn default** (spec 126).
Consequence documented for users: a picker choice lives until the lane respawns (`#new`/`#new!`/restart),
after which the config default returns. (Persisting a picker choice back to config is Out of Scope —
it reopens the per-backend-shared-vs-per-lane question spec 126 resolved as per-backend.)

## Edge Cases

- **Backend advertises no models** (Cursor/Junie/OMP/Pi/Codex today): `availableModels` empty → leader
  `,` disabled (`disabledReason`), or if invoked, `flashChip` explains. No overlay.
- **Lane not yet started / no session**: no client or no `acp_session_id` → picker disabled / command
  errors cleanly ("lane has no active session"); optimistic update is reverted.
- **Selecting the already-current model**: no-op (skip the RPC), just close.
- **Rejected / unknown id** (RPC `Err`): revert optimistic update to `prev`, `modelApplyFailed = true`,
  chip shows the amber `⚠` (spec 126's warn style), `flashChip` with the reason. Lane keeps running.
- **Timeout (Codex-1 #6)**: treated as **uncertain**, NOT a hard failure — the agent may still apply
  the switch after the 10s client timeout. Keep the optimistic chip, mark `modelApplyFailed = true`
  (amber, "state uncertain"), and keep the pending token live to its deadline so a late
  `current_mode_update` still attributes correctly. We do **not** revert.
- **Concurrent switches (Codex-1 #3)**: opening the picker while `pendingModelSwitch` is set is
  blocked (`flashChip`). Every dispatch bumps `modelSwitchEpoch`; a resolution only mutates lane state
  if its captured epoch still equals the current one, so a slow/failed switch A can never overwrite a
  newer switch B's state, and B's `mode_update` is never attributed to A.
- **Mode downgrade** (e.g. switch to Haiku while in `auto`): adapter clamps + emits
  `current_mode_update`; the handler updates `lane.currentMode`, **re-renders the lane header**
  (today it does not — Codex-1 #5), and if a matching `pendingModelSwitch` token is live, adds an
  `appendSystemNotice` so the downgrade is **visible**, not silent. Krypton never re-asserts a mode.
- **Downgrade detection gating (Codex-1 #4)**: detection lives in the `mode_update` handler keyed on
  the live token (cleared by the deadline timer), not a blind 3s wall-clock window — so it still fires
  when the RPC takes longer than a few seconds, and a token bumped by a newer switch prevents
  misattribution. Residual cosmetic risk (an unrelated mode change while a token is live) is accepted.
- **Stale `currentModelId` (Codex-1 #1)**: `models.currentModelId` is captured before spec-126's
  spawn apply. `acp_session_new` overwrites it with the applied id only on an exact advertised-id
  match (canonical); for an alias it stays the agent default but renders **no** `✓` (unverified)
  rather than marking the wrong model. After a picker switch the `✓` follows the locally chosen id.
- **Resumed/loaded sessions (Codex-1 #2)**: `acp_session_restore` now parses `response.models` (it
  previously discarded the whole response), and the frontend merges the restore `AgentSessionInfo`
  (not just `session_id`) so resumed lanes get a working picker. If the backend omits `models` on
  restore, `availableModels` is empty and the picker is disabled (spec 126's "resume keeps saved
  model" stance). No model is force-applied on restore.
- **MCP isolation**: model is sent only via `session/set_model`; it is never added to `session/new`
  and never forwarded to MCP servers (matches Zed; preserves the docs/83 / spec 126 invariants).

## Open Questions

None — both candidate questions resolved into the design:
1. Persist picker choice to config? → No (session-scoped v1; avoids reopening per-backend-vs-per-lane).
2. Re-assert mode after a model-induced clamp? → No (adapter owns it; we only surface the downgrade).

## Out of Scope

- Writing the picked model back to `krypton.toml` (session-scoped only in v1).
- Fuzzy-search text input in the picker (j/k over a short advertised list is enough; lists are small).
- True per-lane config persistence (spec 126 resolved config as per-backend).
- Enabling model selection for backends that don't advertise `models` (auto-enables if/when they do).
- Canonical post-switch model display beyond the locally chosen id (no extra agent query in v1).
- Applying a model on session resume/load when the load response omits `models`.

## Resources

- `docs/126-acp-lane-model-selection.md` — the parent spec; this is its deferred picker follow-up.
- `.claude/skills/external-source-reference/zed.md` + `crates/agent_servers/src/acp.rs:3981-4005`,
  `crates/agent_ui/src/model_selector.rs` — Zed's optimistic-update + revert model picker.
- `@agentclientprotocol/claude-agent-acp` v0.39.0 `dist/acp-agent.js`: `getAvailableModels:2120`,
  `unstable_setSessionModel:1016`, `applyConfigOptionValue` model branch `1323-1393` (mode clamp +
  `current_mode_update`), `resolveModelPreference:1989`.
- `@agentclientprotocol/sdk` `types.gen.d.ts`: `SetSessionModelRequest:4853`, `SessionModelState:4596`,
  `ModelInfo:2648` (UNSTABLE).
- Internal: `src-tauri/src/acp.rs` (`acp_session_new:1083`, `apply_session_model:1200`,
  `AcpRegistry:790`, `AgentSessionInfo:159`), `src/acp/acp-harness-view.ts`
  (`getLeaderKeyBindings:1538`, `onKeyDown:1582`, `handleDirectivePickerKey:3042`,
  `renderModelChip:7531`, `mode_update` handler `:2597`), `src/acp/types.ts:68-93`.
