# Extended ACP Session Updates (Slash Commands & Mode) — Implementation Spec

> Status: Implemented
> Date: 2026-05-07
> Milestone: M-ACP — Harness convergence

## Problem

The Rust ACP forwarder (`src-tauri/src/acp.rs:471-478`) already accepts and re-emits eight `session/update` kinds, but the frontend dispatcher (`src/acp/client.ts:174-206`) only handles six. Two are silently dropped:

- `available_commands_update` — agent advertises its slash-command catalog (e.g. Claude `/clear`, Codex `/diff`, Gemini `/help`). Without this, users have to memorize each lane's commands.
- `current_mode_update` — agent reports mode transitions (e.g. Claude plan-mode ↔ edit-mode). Without this, mode-dependent behavior changes without UI feedback.

Closing this gap unifies the multi-lane experience: every lane shows its own slash-command palette and a mode chip in the lane head.

## Solution

Extend `RawAcpEvent.handleRaw()` with two new cases that emit two new `AcpEvent` variants. Render results in two existing surfaces:

1. **Slash-command palette** — when the user types `/` at start of an empty composer, show a popover listing the focused lane's `availableCommands`. Arrow-keys + `Enter` insert the command name. `Esc` cancels.
2. **Mode chip** — extend `renderLaneHead()` (`acp-harness-view.ts:2123`) with a `renderModeChip(lane.currentMode)` next to the existing model/MCP/sandbox chips.

Both surfaces are read-only — they reflect agent state, they don't drive it.

## Research

### ACP spec

- `available_commands_update` payload: `{ availableCommands: [{ name, description?, input?: { hint? } }] }`. Agents emit it after `session/new` and may re-emit when commands change.
- `current_mode_update` payload: `{ currentModeId: string }`. Modes themselves are declared in `agentCapabilities.availableModes` (array of `{ id, name, description? }`) returned by `initialize`. The mode update only carries the active id — display name lookup uses the capability list.

### Lane coverage observed

Run `acp.rs` debug log (`[acp:N] dropping session/update kind X`) while exercising lanes:
- Claude-1 emits both kinds reliably (commands ~12, modes 2: plan/edit).
- Codex-1 emits commands (~8), no mode updates.
- Gemini-1 emits commands occasionally, no modes.
- OpenCode-1 / Droid-1 / Pi-1: no observation yet — design must tolerate either kind being absent per lane.

### Krypton plumbing already in place

- Rust forwarder: `acp.rs:471-487` whitelists both kinds and re-emits as `{ type: "session_update", kind, update }`. **No Rust changes needed.**
- Frontend listener: `client.ts:163` `handleRaw()` switches on `raw.kind`. Adding two cases is mechanical.
- Lane state storage: `HarnessLane` (`acp-harness-view.ts:95`) is the natural home for `availableCommands` and `currentModeId` fields.
- Composer/draft already exists per lane (`HarnessLane.draft`, `cursor`). Slash palette is overlay rendered above it.

### Alternatives ruled out

- **Surface mode in transcript only** (no lane chip) — discoverability poor; user has to scroll to see what mode the agent is in.
- **Global slash palette aggregating all lanes** — confusing; commands aren't portable across lanes.
- **Forwarding richer fields (e.g. dispatch a command via a Tauri command)** — out of scope; ACP spec says these updates are advisory. Dispatch happens by the user typing the command into the prompt as plain text.

## Prior Art

| Tool | Slash commands | Mode indicator |
|------|----------------|----------------|
| Zed (ACP harness) | Inline palette on `/`, filtered by typed prefix; arrow-key navigation | Lane chip near agent name; color-coded |
| Claude Code CLI | `/`-prefix in prompt; tab-complete from a static catalog | Mode label printed inline as a sticky line |
| Codex CLI | `/help` lists statically | No mode UI |

**Krypton delta** — match Zed's overlay UX (palette appears on `/`, dismissable with `Esc`), keyboard-only navigation. Mode chip placement matches existing chips (model/MCP/sandbox) for visual consistency. No mouse interaction — palette is keyboard-driven only per CLAUDE.md.

## Affected Files

| File | Change |
|------|--------|
| `src/acp/types.ts` | Add `AcpAvailableCommand`, `AcpAgentMode` interfaces; extend `AcpEvent` union with `available_commands` and `mode_update` variants. |
| `src/acp/client.ts` | Add `case 'available_commands_update'` and `case 'current_mode_update'` in `handleRaw()`. Parse `update.availableCommands` and `update.currentModeId`. |
| `src/acp/acp-harness-view.ts` | Extend `HarnessLane` with `availableCommands: AcpAvailableCommand[]` and `currentMode: { id, name } \| null`. Capture `agentCapabilities.availableModes` from `initialize` response into a per-lane `modesById` map. Wire two new event handlers. Add `renderModeChip(lane)` and call it from `renderLaneHead()`. Add slash-palette overlay rendering + key handling in the composer keydown path. |
| `src/styles/acp-harness.css` | Style `.acp-harness__lane-mode` chip (echo existing `.acp-harness__lane-model` styling, different accent color). Style `.acp-harness__slash-palette` overlay (cyberpunk-themed dropdown, scanline border). |
| `docs/PROGRESS.md` | Record Spec 87 under M-ACP. |
| `docs/04-architecture.md` | Note in §20 that the harness now consumes the full set of `session/update` kinds; mention mode chip + slash palette. |

No changes to Rust. No new Tauri commands.

## Design

### Data Structures

```ts
// src/acp/types.ts
export interface AcpAvailableCommand {
  name: string;          // e.g. "compact"
  description?: string;
  inputHint?: string;    // optional placeholder shown after `/name `
}

export interface AcpAgentMode {
  id: string;
  name: string;
  description?: string;
}

export type AcpEvent =
  | /* existing variants */
  | { type: 'available_commands'; commands: AcpAvailableCommand[] }
  | { type: 'mode_update'; modeId: string };
```

### Dispatcher additions

```ts
// src/acp/client.ts handleRaw()
case 'available_commands_update': {
  const cmds = (update.availableCommands as Array<Record<string, unknown>> | undefined) ?? [];
  event = {
    type: 'available_commands',
    commands: cmds.map((c) => ({
      name: String(c.name ?? ''),
      description: typeof c.description === 'string' ? c.description : undefined,
      inputHint: ((c.input as { hint?: string } | undefined)?.hint) ?? undefined,
    })).filter((c) => c.name),
  };
  break;
}
case 'current_mode_update': {
  event = { type: 'mode_update', modeId: String(update.currentModeId ?? '') };
  break;
}
```

### Lane state plumbing

In `acp-harness-view.ts`, after `initialize` resolves, capture `agent_capabilities.availableModes` into `lane.modesById: Map<string, AcpAgentMode>`. Default both new fields:

```ts
lane.availableCommands = [];
lane.currentMode = null;
```

Event handler arms:
```ts
case 'available_commands':
  lane.availableCommands = ev.commands;
  this.scheduleRailRender();   // palette uses fresh list next time it opens
  break;
case 'mode_update':
  lane.currentMode = lane.modesById.get(ev.modeId) ?? { id: ev.modeId, name: ev.modeId };
  this.scheduleRailRender();   // re-render lane head
  break;
```

### Mode chip rendering

```ts
function renderModeChip(lane: HarnessLane): string {
  if (!lane.currentMode) return '';
  return `<span class="acp-harness__lane-mode" title="mode ${esc(lane.currentMode.id)}">${esc(lane.currentMode.name)}</span>`;
}
```

Inserted in `renderLaneHead()` between `modelChip` and `mcpChip`.

### Slash palette UX

Trigger condition: composer is focused AND `lane.draft === '/'` (single-character draft starting with `/`) OR draft matches `/^\/[a-zA-Z0-9_-]*$/`.

Render as absolutely-positioned overlay anchored above the composer. Each row: `<span class="cmd-name">/${name}</span> <span class="cmd-desc">${description ?? ''}</span>`. Filter list by case-insensitive prefix match on `name` against the substring after the leading `/`.

Keys (intercepted before xterm.js / draft handler):
| Key | Action |
|-----|--------|
| `↑` / `↓` | Move highlight |
| `Enter` / `Tab` | Replace draft with `/${selected.name} ` (note trailing space; cursor at end). Close palette. |
| `Esc` | Close palette; draft preserved. |
| Any other char | Forward to draft handler; palette filter updates next tick. |

Palette closes automatically when draft no longer matches the trigger regex.

### UI Changes

CSS additions echo existing chip patterns:

```css
.acp-harness__lane-mode {
  /* mirrors .acp-harness__lane-model layout */
  color: var(--krypton-accent-2, #c77dff);
  border: 1px solid color-mix(in oklab, var(--krypton-accent-2, #c77dff) 35%, transparent);
}

.acp-harness__slash-palette {
  position: absolute;
  bottom: calc(100% + 4px);
  left: 0; right: 0;
  background: var(--krypton-bg-elev, #0c1018);
  border: 1px solid var(--krypton-border, #1f2a3a);
  /* scanline overlay omitted for brevity — match cyberpunk-aesthetic skill */
}
```

## Edge Cases

- **Lane has no commands** → palette doesn't open (filtered list empty). Composer behaves normally.
- **Lane has no mode** (`currentMode === null`) → no chip rendered.
- **Mode id not in `availableModes`** (lane re-emits unfamiliar id) → fallback chip text = id itself.
- **Multiple lanes, focus shifts mid-stream** → each lane stores its own `availableCommands` / `currentMode`, no cross-talk.
- **Pi-1 lane** — pi-acp does not implement these notifications. Both fields stay default (empty / null). No `⚠` chip change.
- **Palette open while agent emits a new `available_commands_update`** → re-filter against the new list on next keystroke; if currently-highlighted name vanishes, snap to row 0.

## Open Questions

1. **Auto-execute on Enter?** Should `Enter` from the palette *send* the prompt, or just *insert* and stay in composer? **Recommendation: insert only** — matches Zed; user appends args, then a separate Enter sends. Avoids accidental command dispatch.
2. **Description as tooltip vs. inline?** Long descriptions truncate ugly inline. **Recommendation: inline, ellipsis at 60ch**; full text in `title=`.
3. **Color for mode chip?** Plan-mode = cool blue, edit-mode = warm orange would match the "calm vs alert" semantic. **Recommendation: use accent-2 variable for v1**, theme later if user demand surfaces.

## Out of Scope

- Sending slash commands programmatically (Tauri command). Users type them; ACP receives plain prompt text.
- Showing `agentCapabilities.availableModes` as a *picker* (mode-switching from harness UI). Mode changes happen agent-side; harness only reflects.
- Pi-1 lane mode/commands UI — Pi advertises neither; out of scope until pi-acp adds them.
- Persisting recently-used commands across sessions.

## Resources

- [ACP spec — Session updates](https://agentclientprotocol.com/protocol/session-updates) — `available_commands_update`, `current_mode_update` payloads
- [ACP spec — Initialize](https://agentclientprotocol.com/protocol/initialize) — `agentCapabilities.availableModes` shape
- `src-tauri/src/acp.rs:461-503` — existing forwarder; whitelists both kinds, no changes needed
- `src/acp/client.ts:163-229` — `handleRaw()` dispatcher (insertion point for two new cases)
- `src/acp/acp-harness-view.ts:2123-2150` — `renderLaneHead()` (insertion point for mode chip)
- `src/acp/acp-harness-view.ts:95-126` — `HarnessLane` interface (extend with two fields)
- `docs/72-acp-harness-view.md` — harness architecture
- `docs/85-contextual-leader-keys.md` — sibling spec (also frontend-only ACP/UX work)
