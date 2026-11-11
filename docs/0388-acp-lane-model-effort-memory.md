# ACP Lane Model and Effort Memory — Implementation Spec

> Status: Implemented (2026-11-11)
> Date: 2026-11-11
> Milestone: ACP Harness — lane model selection

## Problem

The harness model picker (spec 127, `Cmd+P` then `,`) only switches the live session. When the lane
respawns (`#new`, `#new!`, closing and re-adding the lane, restarting Krypton), the model goes back to
`lane_models.<backend>.active` from `krypton.toml`. If that key is missing, it goes back to the agent's
own default. Krypton also has no way to set the reasoning effort at all, either live or as a default.

## Solution

The model picker gains an **effort** strip. `h`/`l` move along it, and Enter applies the model and
the effort together. Krypton remembers the last confirmed model and effort **per backend** in a new
Krypton-managed file, `~/.config/krypton/acp-lane-models.toml`. Every fresh harness lane applies
them at spawn, model first, then effort. `krypton.toml` stays hand-edited and is never rewritten.

## Research

**Live probe** (2026-11-11). Each installed adapter was started, sent `initialize` and `session/new`
in an empty temp directory with no prompt, and its answer read:

| Backend (version) | Model state | Effort option (`category: "thought_level"`) |
|---|---|---|
| claude-agent-acp 0.106.0 | `configOptions` `model` select only (no `models` object) | id `effort`: `default, low, medium, high, xhigh, max` |
| codex-acp 1.13.0 (`@agentclientprotocol`) | `models` object, 34 ids like `gpt-6-sol[high]` (name "6 Sol (high)"), plus a `configOptions` `model` select | id `reasoning_effort`: `low … max, ultra` |
| omp 18.18.8 | `configOptions` `model` select only | id `thinking`: `off, auto, low, medium, high, xhigh, max` |
| cline 3.0.74 | `models` object, 9 ids, plus a `configOptions` `model` select | none |

What the probe shows:
- **The id is different in every adapter; the category is not.** Krypton must find the effort
  option by `category == "thought_level"` and `type == "select"`, never by id. The values also
  differ per adapter, so a stored value is only valid for its own backend.
- **A model switch can change the effort.** On Claude, switching to `haiku` moved effort from
  `xhigh` to `high` without the client asking. Every `session/set_config_option` reply returns the
  full `configOptions` with current values, so Krypton can read the effort that holds after a switch.
  Effort must therefore be applied after the model, at spawn and in the picker.
- **Codex already puts effort in its model list.** Krypton prefers the `models` object
  (`parse_session_model_state`, spec 126/127), so the Codex picker already lists `6 Sol (high)` and
  the other combinations. The probe changed `reasoning_effort` and Codex sent no model update. A
  separate effort strip there would leave the picker's `✓` on the wrong id. The strip is therefore
  offered only when the lane's model is driven through the `configOptions` `model` select, where
  model and effort sit in one option set. Codex effort is remembered through its model id instead.
- **ACP** defines `thought_level` as a reserved config-option category, set through the stable
  `session/set_config_option {sessionId, configId, value}`.

**Codebase.**
- `switchLaneModel` (`src/acp/acp-harness-view.ts`) calls `client.setLaneModel()` and persists
  nothing. Spec 127 left persistence out of scope.
- `acp_spawn` puts `lane_models.<backend>.active` in `client.model_override`. `apply_session_model`
  then sends it after `session/new`. The remembered model can use the same slot.
- `parse_config_model_option` reads only `category: "model"`. `config_option_update` notifications
  only refresh model state. Nothing in Krypton reads `thought_level`.
- `setLaneModel` has other callers (control API `lane.model`, Inline AI, Commit Explainer, Assist),
  and `acp_spawn` serves non-harness roles. Persistence therefore lives in its own command that
  only the picker calls, and spawn reads the file only for `AcpInstanceRole::HarnessLane`.
- `acp-harness.toml` was rejected as the storage. Its `save()` rewrites the whole file from a
  lenient parse, which silently drops malformed `[[directives]]` entries, and agents also edit it
  through `#directive` (spec 161).
- `inferLaneModelName` returns `lane_models.<backend>.active` before anything else. If it stays that
  way, the chip shows the config model while the remembered model runs.

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| Zed (external agents) | Model and effort are both session config options. Picking one calls `set_default_config_option`, which writes `agent_servers.<agent_id>.default_config_options` into `settings.json`. A `thought_level` option can also be cycled from the keyboard (`cycle_category_option`). | Stored per agent, last pick wins. Writes the user's own settings file. |
| Codex (codex-acp) | Effort is part of the model id (`gpt-6-sol[high]`), so choosing a model also chooses its effort. | Seen in the probe. |
| Claude Code CLI | `/model` Enter writes `model` into `~/.claude/settings.json`. | Users filed many reports that this write damaged hand-edited settings. |

**Krypton delta** — Like Zed, picks are remembered per backend and the last pick wins, and effort is
found by the ACP category. Unlike Zed and Claude Code, picks go to a separate Krypton-managed file and
never into the hand-edited config. Model and effort share one picker and one Enter instead of two
selectors.

## Affected Files

| File | Change |
|------|--------|
| `src-tauri/src/acp_lane_models.rs` (new) | File path, lenient load, `remember(backend, model, effort)` under a process `Mutex`, atomic `tmp`+`rename` save, unit tests. |
| `src-tauri/src/acp.rs` | `EffortState` parse (`thought_level` select, ConfigOption lanes only), kept on the client and refreshed from `session/new`/restore, every `set_config_option` reply and `config_option_update`. Spawn applies the remembered model and then the effort for `HarnessLane`. `AgentSessionInfo` gains `requested_model_id` and `effort`. New commands `acp_lane_effort`, `acp_set_lane_effort`, `acp_remember_lane_choice`. |
| `src-tauri/src/lib.rs` | `mod acp_lane_models;`, register the three commands. |
| `src/acp/types.ts` | `EffortOption`, `EffortState`. |
| `src/acp/client.ts` | `laneEffort()`, `setLaneEffort(value)`, `static rememberLaneChoice(backendId, choice)`. |
| `src/acp/adapters/types.ts`, `src/acp/adapters/generic.ts` | `LaneSession.requestedModelId`, `LaneSession.effort`. |
| `src/acp/harness-lane-chrome.ts` | `inferLaneModelName` prefers the session's requested model (as its advertised name). |
| `src/acp/acp-harness-view.ts` | `HarnessLane.effort`, effort cursor, `h`/`l`, the Enter flow below, remember call, effort re-read after a model switch. |
| `src/acp/components/model-picker/{index.ts,model-picker.css,model-picker.test.ts}` | Effort strip with its own `h`/`l` caps. |
| `src/acp/components/lane-head/{index.ts,lane-head.css,lane-head.test.ts}` | `effort <name>` chip after the model chip. |
| `docs/0006-configuration.md`, `docs/0127-acp-lane-model-picker.md`, `docs/0126-acp-lane-model-selection.md`, `docs/0069-acp-agent-support.md`, `docs/README.md` | File, precedence, picker keys, which backends have effort. |

## Design

### Data Structures

```toml
# ~/.config/krypton/acp-lane-models.toml
# Managed by Krypton (spec 388): the model and effort last picked per ACP
# backend in the harness model picker (Cmd+P then ,). Delete a line to fall
# back to krypton.toml / the agent's default. Effort values are the agent's own.
version = 1

[model]
cline = "gpt-5.6-terra"
claude = "opus"

[effort]
claude = "xhigh"
omp = "high"
```

```rust
#[serde(default)] pub struct LaneModelMemory {
    pub version: u32,                      // 1
    pub model: BTreeMap<String, String>,   // backend_id -> advertised model id
    pub effort: BTreeMap<String, String>,  // backend_id -> thought_level value
}
pub struct EffortOption { pub value: String, pub name: String }
pub struct EffortState {
    pub config_id: String,                 // "effort" | "reasoning_effort" | "thinking" | …
    pub options: Vec<EffortOption>,        // grouped options flattened, as for models
    pub current: Option<String>,
}
```

Lane labels such as `Cline-2` are renumbered on respawn, so the key is the backend id. A lane has an
`EffortState` only when its model control is `ModelControl::ConfigOption` and its `configOptions`
include a `thought_level` select. Krypton writes the header comment on every save, because `toml`
cannot round-trip comments.

### API / Commands

```rust
#[tauri::command] fn acp_lane_effort(session: u64) -> Result<Option<EffortState>, String>;
#[tauri::command] async fn acp_set_lane_effort(session: u64, value: String) -> Result<EffortState, String>;
#[tauri::command] fn acp_remember_lane_choice(backend_id: String, model_id: Option<String>, effort: Option<String>) -> Result<(), String>;
```

`acp_set_lane_effort` sends `session/set_config_option {configId: state.config_id, value}` with
a 10 s timeout and returns the state parsed from the reply. Both a rejection and a timeout return
`Err`. `AgentSessionInfo` gains `requested_model_id: Option<String>` and
`effort: Option<EffortState>`.

### Data Flow

```
Picker (Cmd+P then ,):
1. Open: the model cursor goes to the current model. effort = await laneEffort().
   The effort cursor goes to effort.current; effortAtOpen remembers it.
2. j/k move the model cursor. h/l move the effort cursor and stop at both ends.
   Neither key sends anything.
3. Enter: modelChanged = model != current, effortMoved = effort cursor != effortAtOpen.
   If neither is true, the picker closes and nothing is sent.
4. If modelChanged: run switchLaneModel (spec 127: optimistic, revert, epoch).
   Anything other than 'ok' stops here.
5. If the lane has effort: read state = await laneEffort() (after the model switch).
   - If the chosen value is not in state.options: flash `effort <name> not offered by <model>`
     and skip the effort step.
   - If the chosen value != state.current: await setLaneEffort(value). On Err: flash and skip
     the effort step.
   So the effort shown on the strip is the effort the lane ends with, even when the model
   switch moved it.
6. Remember only what succeeded:
   rememberLaneChoice(backendId, { model: model switched ok ? id : undefined,
                                    effort: effortMoved && effort step ok ? value : undefined })
   If both are undefined, nothing is sent. If saving fails, flash
   `switched; not remembered: <reason>`. The switch stays.

Spawn (fresh HarnessLane only):
1. acp_spawn sets model_override = lane_models.<backend>.active (unchanged, incl. MiMo default)
2. acp_session_new parses model state and effort state
3. If memory.model[backend] is advertised, model_override is set to it
4. apply_session_model sends model_override and refreshes effort from the reply
5. If memory.effort[backend] is in effort.options and != effort.current, send it (non-fatal: log)
6. AgentSessionInfo carries requested_model_id and the final effort, and the chip shows
   the advertised name of requestedModelId.
```

Precedence: **remembered model > `lane_models.<backend>.active` > agent default**; **remembered
effort > agent default**. `krypton.toml` gets no effort key. The file is read on every harness
spawn, so neither Reload Config nor a restart is needed. `krypton.toml` loading is unchanged
(no hot reload).

### Keybindings

| Key | Context | Action |
|-----|---------|--------|
| `h` / `l` | Model picker, lane has effort | Effort cursor down / up (clamped, no RPC) |
| `Enter` | Model picker | Apply the model and effort (Data Flow above) and remember them |

The `h`/`l` caps appear on the effort strip, after its label, only when the lane has effort. With no
effort, `h` and `l` do nothing. `←`/`→` do the same as `h`/`l`.

### UI Changes

The `OverlayShell` body becomes the list followed by one strip, `.acp-harness__model-effort` (an
`extras` node, grid row 3 of the picker; the plate now spans three rows). The strip is a second
well on the same plate, beside the list and not inside it, because DESIGN.md keeps a `--mat-select`
tint inside a well. It shows the `effort` label, the recessed `h`/`l` caps, and then each option's
name, spelled as the agent spells it, in one line sized to its content. When the plate is narrow it
scrolls sideways, and the cursor option is scrolled into view. The option under the effort cursor
takes the list cursor's `--mat-select` tint (6px radius inside the 8px well). The agent's current
value carries the amber `✓` like the current model row. Only existing tokens are used and nothing
animates.

**Deviations found during implementation.**
- The draft put the strip on the bare plate. It became a sibling well so the selection tint stays
  inside a well (DESIGN.md "Selection").
- The draft put `h/l effort` in the head hints. A screenshot at the real 580px plate showed the
  extra hint wrapping the title (`CLINE-` / `2`), so the caps moved onto the strip and the head is
  unchanged. Checked in a browser at 1400px (one-line head, whole strip visible) and 700px (360px
  plate; the strip scrolls sideways, and the head wraps exactly as it did before this spec).

**Lane effort chip** (added 2026-11-11 at the user's request). The lane head shows the lane's
current effort as `effort <name>` in its own chip, `.acp-harness__lane-effort`, right after the
model chip and in the same unlit capsule. `<name>` is the option name the agent advertises, or
the raw value when the current value is not among the options. Its title is
`reasoning effort <name> — ⌘P , to change`. There is no chip when the lane has no effort control or
the agent reports no current value. The chip reads `HarnessLane.effort`, so the frontend keeps that
field current:
- at spawn and restore, from `LaneSession.effort`;
- when the picker opens (`laneEffort()`);
- after a picker effort step, which re-renders whether it succeeded or failed;
- after a picker model switch on a lane that had no strip, and after a control-API `lane.model`
  switch, because a model switch can move the effort, or add or drop the control.

The agent can also change effort by itself (`config_option_update`). Rust records that, but no
event reaches the frontend, so the chip catches up the next time one of the paths above runs.

## Edge Cases

- **Remembered model is not advertised any more**: Krypton logs it and falls back to config
  `active`. The entry stays until the next pick overwrites it.
- **Remembered effort is not in the options** (another model or a new adapter version): Krypton
  logs it and the agent default stays.
- **Backends without effort** (Cline, and Codex where effort lives in the model list): no strip,
  and `effort` entries for them are ignored. A Codex pick such as `gpt-6-sol[high]` is remembered
  as its model.
- **Only the effort changed**: no model RPC is sent. The picker no longer treats "same model" as a
  no-op when the effort cursor moved.
- **Picker opened while a model or effort switch is in flight**: refused with a flash, extending
  spec 127's `pendingModelSwitch` guard to effort.
- **Resumed or loaded sessions** (spec 97): no model or effort is forced. The strip still works
  live, because restore parses the effort state too.
- **Non-harness roles and other `setLaneModel` callers**: they never read or write the file.
- **Unparseable file**: spawn logs a warning and ignores it. `remember` returns `Err` and never
  overwrites a file it could not parse, so hand edits are not destroyed.
- **Two lanes saving at once**: a process mutex serializes load, modify and save.
- **Windows**: `std::fs::rename` replaces the target. The directory is not opened to fsync it
  (POSIX-only).

## Open Questions

None. Settled:
1. Per backend (lane labels are not stable; matches spec 126 and Zed). Chosen by the user.
2. The remembered model takes precedence over `krypton.toml`. Delete the line to restore the
   config default.
3. A dedicated file, not `acp-harness.toml` (data-loss risk). Chosen by the user.
4. Effort is in this spec, edited with `h`/`l` in the model picker. Chosen by the user.
5. No effort strip on `models`-object lanes. Codex effort stays in its model list.

## Out of Scope

- A picker key that clears remembered values (edit the file).
- Remembering per project or per lane, or effort per model.
- An effort key in `krypton.toml`.
- Switching Codex or Cline from the `models` object to `configOptions`.
- Other config options (`fast`, `mode`, `provider`, `auto_approve`).
- Persisting switches made by the control API, Inline AI, Commit Explainer or Assist.

## Resources

- [ACP — Session Config Options](https://agentclientprotocol.com/protocol/session-config-options):
  the reserved `thought_level` category, `session/set_config_option`, and that the reply carries
  every option's current value.
- [ACP — Session config options stabilized](https://agentclientprotocol.com/announcements/session-config-options-stabilized):
  the method is stable (Feb 2026), unlike `session/set_model`.
- Zed source, `crates/agent_servers/src/custom.rs` (`set_default_config_option`) and
  `crates/agent_ui/src/config_options.rs` (`cycle_category_option`, `ThoughtLevel`): stores
  per-agent defaults and finds effort by its category.
- [Bug: /model command overwrites settings.json, wiping statusLine and hooks config](https://claudeissues.com/issue/46921-bug-model-command-overwrites-settings-json-wiping-statusline-and-hooks-config)
  and [model toggle corrupts settings.json](https://claudeissues.com/issue/79403-vs-code-extension-model-toggle-intermittently-corrupts-settings-json-malformed-j):
  why the picks get a separate file, an atomic save, and a refusal to overwrite unparseable files.
- Local probe of claude-agent-acp 0.106.0, codex-acp 1.13.0, omp 18.18.8 and cline 3.0.74 (the
  Research table): option ids, values, and effort moving after a model switch.
