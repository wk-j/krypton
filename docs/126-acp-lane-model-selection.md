# ACP Lane Model Selection — Implementation Spec

> Status: Implemented
> Date: 2026-05-29
> Milestone: M-ACP — Harness convergence

## Problem

A user can already write `acp_harness.lane_models.claude.active = "opus"` in `krypton.toml`, but
for Claude (and Codex/Cursor/Junie/OMP/Pi) the value is **accepted but ignored** — it only paints
the lane's model chip; the agent still runs its own default model. There is no way to actually make
a harness lane run a chosen model unless the backend is Gemini/Droid (spawn CLI flag) or OpenCode
(post-session config). The user wants "set model name in a harness lane" to take effect on the
agent, starting with the Claude lane.

## Solution

Generalize the post-`session/new` model-selection that already exists for OpenCode into a
capability-gated path for **ACP-native backends that advertise models**. After `session/new`, read
the `models` object from the response; if the backend advertised one and a model is configured,
send `session/set_model { sessionId, modelId }` (ACP unstable method, already used as Krypton's
OpenCode fallback). The configured `active` value is sent as-is (so aliases like `opus`/`sonnet`
work), and a failure is **non-fatal** — the lane keeps running on the agent default. No new config
schema: this just makes the existing `lane_models.<backend>.active` real for more backends.

## Research

- **Existing infra (verified in source).** `acp_session_new` (`src-tauri/src/acp.rs:1078`) already
  holds the full `session/new` response `Value` but parses only `sessionId`, dropping `models`. It
  special-cases `if backend_id == "opencode"` → `set_opencode_default_model` (`acp.rs:1186`), which
  tries `session/set_config_option {configId:"model"}` then falls back to `session/set_model
  {sessionId, modelId}`. `acp_spawn` (`acp.rs:868`) reads `cfg.acp_harness.lane_models.<backend>.active`
  into `client.model_override`, and applies it as a CLI flag only for `gemini` (`--model`) and
  `droid` (`-m`). Config types: `LaneModelConfig { active, models }` + `AcpHarnessConfig.lane_models`
  (`src-tauri/src/config.rs:474-492`). The comment there states Claude/Codex/Cursor/Junie are
  "accepted but ignored at spawn — the entry only drives the model chip." This spec closes that gap.
- **claude-agent-acp v0.39.0 supports it (ground truth, read from the npx-cached adapter).** Its
  `session/new` response includes `models: { availableModels: [{ modelId, name, description }],
  currentModelId }` (`getAvailableModels`, `dist/acp-agent.js:2120`). It implements
  `unstable_setSessionModel` (`acp-agent.js:1016`), which resolves aliases via
  `resolveModelPreference` (so `"opus"`, `"opus[1m]"`, `"sonnet"`, `"haiku"`, `"default"`, or a full
  id like `"claude-opus-4-6"` all work), calls `session.query.setModel`, and updates the `model`
  config option. Caveat (per Codex-1 review): if alias resolution returns null the adapter passes the
  id through verbatim to `setModel`; the graceful fall-back-to-`"default"` lives in the
  session-creation/settings path and is **not** guaranteed for post-session `set_model`, so an
  unknown id may error depending on Claude SDK behavior. Krypton therefore sends the configured value
  verbatim and treats any `set_model` error as **non-fatal**. Strict client-side gating against
  `availableModels` is still avoided because it would wrongly reject valid aliases.
- **ACP wire method (from `@agentclientprotocol/sdk` schema).** `SetSessionModelRequest` →
  `x-method: "session/set_model"`, marked **UNSTABLE**; params `{ sessionId, modelId }`. This is the
  exact request Krypton already sends OpenCode as its fallback, so no new IPC primitive is needed.
- **Why gate on session-model-state presence, not on the id list.** Sending `session/set_model` to a
  backend that doesn't implement it produces a JSON-RPC error and log noise. The cleanest capability
  signal is "did the `session/new` response carry a valid session model state?" — i.e. `models` is an
  object carrying an `availableModels` array or a `currentModelId` string. Present ⇒ apply; absent or
  malformed ⇒ skip silently. (Per Codex-1: check the object shape, not merely the key, so a backend
  echoing an empty/garbage `models` value doesn't trigger a doomed request.) This avoids spamming
  Cursor/Junie/OMP/Pi (which don't advertise models today) while auto-enabling any backend that gains
  ACP model support later; non-fatal handling covers the residual case where a backend advertises
  model state but doesn't actually implement `session/set_model`.

## Prior Art

| App | Implementation |
|-----|---------------|
| **Zed** (`agent_servers/src/acp.rs`) | Reads the `session/new` response `SessionModelState { available_models, current_model_id }`; if the settings default is in `available_models`, sends `acp::SetSessionModelRequest(session_id, model_id)` post-init (and on every UI model switch via `AcpModelSelector::select_model`). Optimistic local update, revert on RPC error. Model is **never** a `session/new` field and **never** reaches MCP servers. See `.claude/skills/external-source-reference/zed.md`. |
| **OpenCode (Krypton today)** | `session/set_config_option {model}` with `session/set_model` fallback, OpenCode-only branch in `acp_session_new`. |
| **Gemini / Droid (Krypton today)** | Model passed as a spawn CLI flag (`--model` / `-m`); no post-session RPC. |

**Krypton delta** — Krypton is **config-driven** (TOML `lane_models.<backend>.active`), not a
runtime picker, so unlike Zed it does not gate on the advertised id list (that would reject the
alias forms the adapter accepts). It mirrors Zed's "set model as a post-`session/new` RPC, never in
`session/new`, non-fatal on failure" shape, gated on whether the agent advertised a `models` object.

## Affected Files

| File | Change |
|------|--------|
| `src-tauri/src/acp.rs` | In `acp_session_new`, capture `new_session["models"]` and `.await` `apply_session_model(...)` inline; that fn keeps the OpenCode path and adds the generic gated `session/set_model` path. Add `model_apply_failed: bool` to `AgentSessionInfo`, set from the generic path's result. No `current_model_id` field (canonical display deferred — see Out of Scope). |
| `src/acp/types.ts` | Add `model_apply_failed?: boolean` to `AgentSessionInfo`/`AgentInfo`; thread to lane state as `modelApplyFailed`. |
| `src/acp/acp-harness-view.ts` | Set `lane.modelApplyFailed` from `sessionNew()`; render the existing model chip with a warning style/`title` when true (do NOT change the chip text to a guessed model). |
| `docs/06-configuration.md` | Flip Claude from "accepted but ignored" to "applied via `session/set_model` after `session/new`, for adapters that advertise ACP model state". |
| `docs/69-acp-agent-support.md` | Note Claude lane model selection alongside the OpenCode row. |
| `src-tauri/src/config.rs` | Update the `lane_models` doc comment (Claude no longer "ignored"). |
| `docs/PROGRESS.md` | New row under M-ACP. |

## Design

### Data Structures

No new config types. `AgentSessionInfo` gains one nonfatal apply-status flag (no `current_model_id`
— canonical display is deferred; see Out of Scope):

```rust
pub struct AgentSessionInfo {
    pub session_id: String,
    /// True ONLY when a model was configured, the agent advertised model state,
    /// and the `session/set_model` request errored/timed out. False on success,
    /// skip, no-config, or no-capability. Drives a "requested model not applied"
    /// chip warning — it never claims to know the real running model.
    pub model_apply_failed: bool,
}
```

The flag is forward-compatible: a later canonical-model-state follow-up can replace this boolean
with a richer `intent | applied | current | error` model-state object.

### API / Commands

No new Tauri commands. Reuses the existing `client.request("session/set_model", { sessionId, modelId })`.

```rust
// Replaces the `if client.backend_id == "opencode"` block in acp_session_new.
// MUST be `.await`ed inline in acp_session_new (NOT detached): the frontend's
// initialize() does not prompt until sessionNew() returns, so awaiting here
// guarantees the model is switched before the first user turn. Detaching would
// let the first prompt race the model switch.
// Returns Ok(model_apply_failed). OpenCode keeps its existing FATAL behavior via `?`.
async fn apply_session_model(
    client: &AcpClient,
    acp_session_id: &str,
    models: Option<&Value>, // new_session["models"]
) -> Result<bool, String> {
    // Keep OpenCode on its dedicated config_option-first path, BEFORE the gate,
    // so it isn't accidentally skipped just because it may not advertise `models`.
    if client.backend_id == "opencode" {
        set_opencode_default_model(client, acp_session_id).await?; // unchanged (fatal)
        return Ok(false);
    }
    // Capability gate: a valid session model state must be present.
    let advertises_models = models
        .and_then(|v| v.as_object())
        .map(|m| m.get("availableModels").map(|a| a.is_array()).unwrap_or(false)
              || m.get("currentModelId").map(|c| c.is_string()).unwrap_or(false))
        .unwrap_or(false);
    if !advertises_models { return Ok(false); }
    let Some(model) = client.model_override.read().ok().and_then(|g| g.clone()) else {
        return Ok(false);                                        // nothing configured
    };
    let res = tokio::time::timeout(
        Duration::from_secs(10),
        client.request("session/set_model",
            json!({ "sessionId": acp_session_id, "modelId": model })),
    ).await;
    match res {
        Ok(Ok(_)) => Ok(false),
        // Non-fatal: a misspelled/unsupported model must not stop the lane starting,
        // but we DO report the failure so the chip can warn (model_apply_failed=true).
        Ok(Err(e)) => { log::warn!("session/set_model modelId={model} failed for backend {}: {e}", client.backend_id); Ok(true) }
        Err(_)     => { log::warn!("session/set_model modelId={model} timed out for backend {}", client.backend_id); Ok(true) }
    }
}
```

### Data Flow

```
1. krypton.toml: [acp_harness.lane_models.claude] active = "opus"
2. acp_spawn(claude) → reads active → client.model_override = Some("opus")
   (claude is NOT gemini/droid, so no CLI flag is added)
3. acp_initialize → capabilities (unchanged)
4. acp_session_new → session/new → response { sessionId, models: { availableModels, currentModelId } }
5. apply_session_model (AWAITED inline, before acp_session_new returns):
   valid models state present + model_override set
   → send session/set_model { sessionId, modelId: "opus" }   (non-fatal)
6. claude-agent-acp resolves "opus" → claude-opus-4-* , switches the session model
7. acp_session_new returns → frontend initialize() resolves → only now can the
   first user prompt be sent, so it always runs on the switched model
```

### Configuration

No new keys. `acp_harness.lane_models.<backend>.active` (existing) now takes effect for any backend
whose adapter advertises `models` in `session/new` (verified: `claude`; `gemini`/`droid` keep the
spawn-flag path; `opencode` keeps its dedicated path).

**The user does NOT maintain a model catalog.** The set of available models is the *agent's* — it is
advertised in the `session/new` response (`models.availableModels`), which Krypton already reads for
the capability gate. The only thing a user sets is `active` (one model id/alias) — or nothing, to
use the agent's default. The pre-existing `models` array is **optional curation** (a user-chosen
subset/ordering to seed a future picker), **not** a required list and **not** the discovery source;
leaving it empty changes nothing. The future picker (out of scope) sources its options from the
agent-advertised `availableModels`, so it stays zero-maintenance and never drifts.

**Respawn-to-apply contract.** `acp_spawn` snapshots `active` into `client.model_override` once, at
spawn. Editing `krypton.toml` updates the stored config (and chip inference) but does **not**
re-apply to a live lane — the agent model changes only on the next spawn/`#new`/`#new!`/lane
restart. This matches the existing Gemini/Droid "change model ⇒ respawn" wording and docs/83's
"lane respawn is the trigger" precedent. No live re-apply in v1 (that would be mid-session switching
across every live lane of the backend, reopening the deferred mode/effort/context resync problem).
docs/06 and the `config.rs` `lane_models` comment must state this explicitly.

### UI Changes

Prototype: [`docs/prototypes/126-acp-lane-model-selection.html`](prototypes/126-acp-lane-model-selection.html).

- **Model chip (v1, ships).** Existing `.acp-harness__lane-model` chip, unchanged for the success
  case (shows configured intent). New `--warn` modifier (amber border/text, reusing the sandbox-chip
  palette + a `⚠` prefix and explanatory `title`) when `lane.modelApplyFailed` is true. Chip text is
  never replaced with a guessed model. No chip when nothing is configured / backend advertises no
  model state.
- **Picker overlay (future, deferred).** The prototype sketches the deferred keyboard-driven model
  picker (agent-advertised `availableModels` ∪ config allow-list, `j/k`/`↵`/`esc`) only to visualize
  the end-state configure UX — it is explicitly out of scope for v1 (see Out of Scope).
- **v1 configure surface is `krypton.toml`** (no in-app editor); the prototype's panel B shows the
  exact config shape and the respawn-to-apply caption.

## Edge Cases

- **Backend doesn't advertise `models`** (Cursor/Junie/OMP/Pi today): generic path is skipped; chip
  still shows the configured value (unchanged display behavior).
- **`active` empty / key absent**: `model_override` is `None` → skip; agent default is used.
- **Unknown / misspelled model id**: sent as-is; the adapter may resolve it, reject it, or handle it
  per Claude SDK behavior (post-session `set_model` does not guarantee a default fall-back). Either
  way our `session/set_model` failure is logged (backend id + requested modelId) and non-fatal — the
  lane never fails to start because of a bad model id.
- **Alias vs canonical id** (`opus` vs `claude-opus-4-6`): sent verbatim; the adapter resolves
  aliases. This is why we do not strict-match against `availableModels`.
- **Empty / malformed `models`**: gate checks `models` is an object with an `availableModels` array
  or `currentModelId` string; a bare/garbage `models` value does not trigger a doomed request.
  `{ availableModels: [] }` (empty list) is treated as **capability-present** — the response *shape*
  is the capability signal, not the list contents — so the request is sent (bounded by timeout,
  non-fatal, marker on failure). Skipping it would create a confusing "backend says it has model
  state but Krypton refused to apply intent" edge. Stricter full-schema validation is a future option.
- **Edited config on a live lane**: no effect until respawn (`#new`/`#new!`/restart); `acp_spawn`
  re-reads the live config each spawn. Documented as the respawn-to-apply contract above.
- **Ordering / race**: `apply_session_model` is `.await`ed inside `acp_session_new` (not detached),
  so the model switch completes before `sessionNew()` returns and therefore before the frontend can
  send the first prompt. Detaching would race the switch against the first turn.
- **Session resume/load** (`acp_session_restore`): out of scope for v1. Resumed/loaded sessions keep
  whatever model they were saved with and are **not** forced to the current config — documented so
  users aren't surprised. `model_apply_failed` is `false` for them (no apply attempted). Could call
  `apply_session_model` there later if requested.
- **`set_model` failure is surfaced, not silent**: on error/timeout `model_apply_failed=true` flows
  to `lane.modelApplyFailed`, and the chip renders a warning style/`title` ("requested model X not
  applied; agent using its default or prior model"). The chip text is NOT changed to a guessed model
  — it still shows configured intent, now flagged as unconfirmed/failed.
- **OpenCode**: behavior unchanged (dedicated branch retained, evaluated before the gate), so no
  regression and no chance of it skipping its `set_config_option` primary path.
- **Model switch triggers adapter-side mode/effort/context recompute.** Verified in the Claude
  adapter (`applyConfigOptionValue`, `acp-agent.js:1328`): a model change resets the context-window
  heuristic, rebuilds effort options, and **clamps the current mode to "default"** if the new model
  doesn't offer it (e.g. `auto` is gone on Haiku). Krypton never sets a session mode before
  `session/new`, but the Claude adapter can start a fresh session non-default by reading its own
  `permissions.defaultMode` from Claude settings — so the clamp can be real, not a strict no-op. v1
  does **not** reassert modes (reasserting an unsupported mode is wrong and would error; the adapter
  owns that invariant). When the adapter clamps, it emits `current_mode_update`, which Krypton
  already consumes (`mode_update` → `lane.currentMode`). Because `apply_session_model` is awaited
  inline before the first user turn, there is no prompt-on-stale-mode race. (Adjacent, not a blocker:
  Krypton ignores the `session/new` `modes` state today, so the initial mode chip relies on later
  `current_mode_update` notifications — a reason *not* to attempt local mode repair here.)

## Open Questions

Both questions from the draft were resolved during Codex-1 review:

1. **Per-backend vs per-lane keying — resolved: per-backend for v1.** Config stays keyed by backend
   id, matching the existing `lane_models` shape and avoiding inventing lane-identity/persistence
   semantics. Consequence (documented for users): two concurrent `claude` lanes intentionally share
   the same configured model until a future per-lane config exists. True per-lane override is below.
2. **Surface the agent's `currentModelId` on the chip — resolved: deferred from v1.** `models.
   currentModelId` in the `session/new` response is captured **before** the post-session
   `session/set_model`, so returning it would show the *pre-switch* default even when the switch
   succeeds. `session/set_model` returns `{}` and the agent canonicalizes aliases internally, so
   Krypton cannot reliably know the final canonical id without another agent signal. v1 keeps today's
   chip behavior ("configured `active` wins; else capabilities/opencode fallback"). True canonical
   display needs a separate follow-up (query/subscribe to final model state).

## Out of Scope

- ~~Interactive in-harness model **picker** UI / mid-session switching~~ — **implemented in
  spec 127** (`docs/127-acp-lane-model-picker.md`). It uses the leader → `,` trigger recommended
  here, sources options from the agent-advertised `availableModels`, switches the live lane via
  `session/set_model`, and surfaces the mode downgrade the adapter performs on an unsupported mode.
- **Accurate post-switch chip display** via the agent's canonical `currentModelId` — deferred per
  Open Question 2; needs a follow-up design to query/subscribe to final model state.
- True **per-lane** model override (distinct model for two lanes of the same backend).
- Applying a model on **session resume/load** (resumed sessions keep their saved model in v1).
- Enabling Cursor/Junie/OMP/Pi model selection (they don't advertise model state yet; this spec
  auto-enables them if/when they do, with no further code — but docs promise application only "for
  adapters that advertise ACP model state", not alias support for every backend).
- Touching the Gemini/Droid spawn-flag path or the OpenCode dedicated path.

## Resources

- `docs/prototypes/126-acp-lane-model-selection.html` — configure-UI prototype: lane-rail chip states (v1), TOML config source (v1), and the deferred picker overlay (future).
- `.claude/skills/external-source-reference/zed.md` — verified Zed model-injection pattern (post-`session/new` `SetSessionModelRequest`, never in `session/new`, never to MCP).
- `@agentclientprotocol/claude-agent-acp` v0.39.0 (npx-cached `dist/acp-agent.js`) — `getAvailableModels` (session/new `models`), `unstable_setSessionModel` + `resolveModelPreference` (alias handling).
- `@agentclientprotocol/sdk` `schema/schema.json` — `SetSessionModelRequest` `x-method: "session/set_model"` (UNSTABLE), params `{sessionId, modelId}`.
- Internal: `src-tauri/src/acp.rs` (`acp_session_new:1078`, `set_opencode_default_model:1186`, `acp_spawn:868`), `src-tauri/src/config.rs:474-492`, `docs/06-configuration.md` (lane model selection), `docs/69-acp-agent-support.md`.
