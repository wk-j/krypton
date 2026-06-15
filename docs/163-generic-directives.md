# Generic Directives — Implementation Spec

> Status: Implemented
> Date: 2026-06-15
> Milestone: ACP Harness — directive management (follows spec 124 / 161 / 162)

## Problem

A harness directive carries a `backend` field that **locks** it: a directive with
`backend = "claude"` can only be assigned to Claude lanes (`directiveCompatible`
gates assignment to `backend === '' || backend === lane.backendId`). The user
wants directives to be **fully generic** — a reusable system-prompt persona (e.g.
"ponytail minimalism", "reviewer") is just leading-context text that works on any
backend, so it should be assignable to *any* lane with no backend coupling at all.

## Solution

**Remove the `backend` field from directives entirely** (TS + Rust + config). A
directive is purely an id/title/icon/task/system_prompt persona, assignable to any
enabled lane.

The one job `backend` used to do for spawning is replaced by a UI step: pressing
**Shift+Enter** in the directive picker (spawn-a-new-lane-from-directive) no longer
guesses a backend — it opens the **existing lane backend picker**, and the backend
the user selects there spawns the new lane with the chosen directive applied.

## Research

Backend coupling sites, all to be cut or repurposed:

| Site | File:line | Disposition |
|------|-----------|-------------|
| `HarnessDirective.backend` (TS + Rust struct) | `config.ts:201`, `acp_harness_config.rs:55` | **remove field** |
| `directiveCompatible()` backend check | `acp-harness-view.ts:3914` | → `directiveAssignable()` = enabled only |
| `lane.directive` control op gate | `acp-harness-view.ts:1641` | uses `directiveAssignable` (any enabled) |
| `addLaneFromDirective()` (uses `directive.backend`) | `acp-harness-view.ts:5142` | **remove**; replaced by backend-picker flow |
| `harnessDirectives()` gemini filter (`directive.backend`) | `acp-harness-view.ts:840` | **remove** (field gone) |
| picker scope `'all backends'` + backend logo | `acp-harness-view.ts:6911,6919-6926` | drop backend; keep directive `icon` glyph |
| `directivePrompt` author schema | `acp-harness-view.ts:587` | remove backend field guidance |
| Rust `BUILTIN_BACKEND_IDS` + validate + 2 tests | `acp_harness_config.rs:23,240,324,331` | **remove** (dead once field is gone) |
| `fallback_icon` uses `d.backend` | `acp_harness_config.rs:202` | drop backend from sources |

A ready-made **lane backend picker** already exists — `openLanePicker()` lists
`AcpClient.listBackends()` and on `Enter` calls `addLane(entry.id)`
(`acp-harness-view.ts:5343-5392`). The spawn flow reuses it unchanged; we only
thread an optional directive id through.

**Migration:** none. The Rust struct does not use `deny_unknown_fields`, so an
existing `acp-harness.toml` with `backend = "claude"` deserializes fine — the
field is silently ignored. No version bump.

## Prior Art

Persona/instruction presets in adjacent agent tools are backend-agnostic: Zed
**agent profiles** and Cursor **rules** attach instruction context independent of
the model/agent; Claude Code's `CLAUDE.md` applies regardless of model. None lock
a persona to a specific agent binary. **Krypton delta:** Krypton matches that
convention; the backend choice moves entirely to spawn time (an explicit picker),
which the others lack because they have no multi-backend lane spawner.

## Affected Files

| File | Change |
|------|--------|
| `src/config.ts` | remove `backend` from `HarnessDirective` |
| `src-tauri/src/acp_harness_config.rs` | remove `backend` field, `BUILTIN_BACKEND_IDS`, its validate branch, backend tests; drop backend from `fallback_icon`/`normalize` |
| `src/acp/acp-harness-view.ts` | remove `harnessDirectives` + `addLaneFromDirective`; `directiveCompatible`→`directiveAssignable`; add `pendingSpawnDirectiveId` + Shift+Enter→backend-picker flow; `addLane(backendId, directiveId?)`; drop backend from directive-row render; backend-picker header hint; reword `directivePrompt` |
| `docs/124-acp-harness-directive-management.md` | generic assignment + spawn-picks-backend |
| `docs/163-generic-directives.md` | this spec |
| `src/acp/acp-harness-view.test.ts` | drop the `harnessDirectives` Gemini-filter test + import |
| `docs/PROGRESS.md` | landing entry |

> Implementation note: `CLAUDE.md` was **not** changed — it does not reference the
> directive feature, so there was nothing to update there.

## Design

### Data Structures

`HarnessDirective` loses `backend` (TS + Rust). New view state:

```ts
/** Directive whose lane the backend picker is about to spawn (Shift+Enter from
 *  the directive picker). null = the picker is the plain "+ new lane" flow. */
private pendingSpawnDirectiveId: string | null = null;
```

`addLane` gains an optional directive:

```ts
private async addLane(backendId: string, directiveId?: string | null): Promise<void>
// when directiveId is set: lane.activeDirectiveId = directiveId before spawnLane
```

### Data Flow — Shift+Enter spawn

```
1. Directive picker open on focused lane; user cursors a directive, presses Shift+Enter
2. handleDirectivePickerKey: if enabled → pendingSpawnDirectiveId = directive.id;
   closeDirectivePicker(); openLanePicker()
3. Backend picker lists installed backends; header shows "spawn with <directive>"
4. User selects a backend, Enter → handlePickerKey:
   addLane(entry.id, pendingSpawnDirectiveId); pendingSpawnDirectiveId = null
5. addLane creates the lane, sets activeDirectiveId, spawns it
   (Esc/q in either picker clears pendingSpawnDirectiveId)
```

### Data Flow — Enter switch (unchanged behaviour, now never blocked)

```
1. Enter on a directive → assignDirectiveToLane(focusedLane, id)
   directiveAssignable(directive) === directive.enabled — no backend rejection
```

### UI Changes

- Directive row: drop the backend logo `<span>` and the `'all backends'` scope
  token. Keep the `icon` glyph + `task` (when set) in the meta line.
- Backend (lane) picker header: when `pendingSpawnDirectiveId` is set, append
  `· directive: <title>` so the user knows the spawn carries a directive.
- Directive picker header already reads `enter switch · shift+enter new lane`.

### Configuration

`backend` key removed from `[[directives]]`. Stale `backend = "..."` lines in an
existing file are ignored (no error, no migration).

## Edge Cases

- **Old TOML with `backend` set** → field ignored on load; directive still works.
- **No backends installed** → `openLanePicker` already flashes "no ACP backends"
  and returns; `pendingSpawnDirectiveId` is cleared on the picker close path.
- **Shift+Enter on a disabled directive** → flash "directive disabled", no picker.
- **Esc in the backend picker after Shift+Enter** → spawn cancelled, pending cleared.
- **`#directive` authoring a `backend` field** → schema no longer mentions it; a
  hand-written `backend` line is harmlessly ignored by the loader.

## Open Questions

None — resolved: backend removed entirely; Shift+Enter shows the backend picker.

## Out of Scope

- Multi-directive stacking on one lane (still exactly one active directive).
- The `task` field semantics.
- Changing how the directive prompt is injected.
- A per-harness "default backend" setting (the picker is always shown).

## Resources

- `/Users/wk/Source/zed` — agent profiles are backend-agnostic instruction presets (prior art).
- `docs/124-acp-harness-directive-management.md` — original backend-locked model being removed.
