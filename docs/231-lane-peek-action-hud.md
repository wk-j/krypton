# Lane Peek Action HUD — Implementation Spec

> Status: Implemented
> Date: 2026-08-18
> Milestone: ACP Harness polish
> Related: `docs/109-acp-contextual-lane-peek.md`, `docs/111-harness-right-rail.md`, `docs/156-lane-activity-ticker.md`, `docs/216-workspace-thought-field.md`, `docs/221-harness-status-line-density.md`

## Problem

The live action (`EDIT TLI-API/…`, `thinking…`, `⚒ read src/…`) still lives on the composer meta row. That row is already the wrong home: it competes with the named verb, the elapsed clock, and the input caret, and it ellipsizes the one signal the user pointed at. The right-rail peek cluster is the instrument panel; the composer should stay an input.

The peeked lane already has a flat `tool` text row. It has no kind-specific motion, so a long edit, a grep, and a shell look identical.

## Solution

Move live action off the composer and into a compact **action HUD** stack in the peek rail (`[data-slot="action"]`, stacked immediately above the 109 peek card). One card per busy lane in the same harness tab — not only the active lane. Each action kind plays a distinct CSS instrument animation — liveness, not decoration. Reuse the same HUD inside the peek card when the peeked lane is itself busy; that lane is then omitted from the rail stack so it is not painted twice.

Composer keeps verb / elapsed / queued. The activity segment is deleted.

## Research

- Spec 156 put the live action on the composer because it was the only always-visible surface. Spec 111 then created the rail; spec 216 proved a **sibling slot** is the right way to add a new instrument without widening peek.
- `lane.activity` is already written on the hot path (`noteToolActivity`, thought/message chunks) and painted by the 1 s composer tick. No new events.
- `deriveActiveToolForPeek` already extracts `{name, subject}` from the oldest in-progress tool. `inferToolLabel` already maps titles onto `ToolKind`.
- Peek is **non-active only** (spec 109). The screenshot's `EDIT` is the **active** lane (Claude-2) while peek shows idle Codex-1. Stuffing the action into the 109 card would hide it on single-lane harnesses and whenever the peeked lane is idle. A sibling slot is the only placement that still shows the thing the user circled.
- Thought slot already shows thinking *content*. A second "thinking…" HUD above a live thought card is noise — omit the HUD in that one case.
- DESIGN.md: motion is reserved for *state*; infinite ambient must die under `prefers-reduced-motion`; no `backdrop-filter`; hard geometry (≤2px radius); transform/opacity only.

**Alternatives ruled out**

- *Inside the 109 peek card only* — vanishes when peek is hidden or showing an idle peer.
- *Always show peeked-if-busy else active* (thought-slot rule) — would steal the active lane's action the moment a busy peer is peeked. The stack shows every busy lane; a peeked busy peer stays on the peek card and is skipped in the stack.
- *Canvas / OffscreenCanvas well* — idle-CPU budget; CSS wells are enough at 28px.
- *Keep a duplicate activity segment on the composer* — the user asked to move it.

## Prior Art

| App | Implementation | Notes |
|-----|----------------|-------|
| Claude Code CLI | Spinner + gerund + token counter on the status line | Tool name stays in the transcript |
| Codex CLI | "Working" + elapsed; tools inline in the thread | No kind-specific HUD |
| Zed Agent Panel | In-progress tool rows with a spinner inside the thread | Activity lives in the transcript |
| Cursor | Step cards in chat | No persistent instrument |
| Krypton peek today | Flat `tool  Edit · Foo.java` row | No motion, peeked lane only |

**Krypton delta** — the rail is the instrument cluster. Each kind is a different *instrument*, readable at a glance without reading the path. Composer goes back to being an input.

## Affected Files

| File | Change |
|------|--------|
| `src/acp/harness-action-hud.ts` | Pure `ActionHudKind` mapping, `deriveLiveAction()`, `deriveRailLiveActions()`, `renderActionHud()`, `syncActionHudSlot()`. |
| `src/acp/harness-action-hud.test.ts` | **New.** Kind mapping, derive, omit-when-thought, render signature. |
| `src/acp/acp-harness-view.ts` | New `actionSlotEl`; `renderLaneAction()`; drop activity from `composerStatusChip`; 1 s tick patches the HUD. |
| `src/acp/lane-peek.ts` | Peek `tool` row replaced by the same HUD. |
| `src/acp/harness-composer-meta.ts` | Drop `activity` from `BusyStatusInput` / `buildBusySegments`. |
| `src/acp/harness-composer-meta.test.ts` | Segments no longer include `activity`. |
| `src/acp/harness-format.ts` | `formatLaneActivity` stays for tests / Live Assist; unused by composer. |
| `src/acp/harness-icons.ts` | Nine 16px action-well `<symbol>`s (`krypton-action-*`). |
| `src/styles/acp-harness.css` | Slot + HUD + per-kind wells; reduced-motion. |
| `docs/72-acp-harness-view.md` | Composer chip no longer carries activity; rail slot documented. |
| `docs/109-acp-contextual-lane-peek.md` | Peek `tool` row is now the HUD. |
| `docs/111-harness-right-rail.md` | Slot order. |
| `docs/156-lane-activity-ticker.md` | Activity paints the rail HUD, not the chip. |
| `docs/221-harness-status-line-density.md` | Activity is no longer the composer's spring. |
| `docs/README.md` | Index. |
| `docs/prototypes/231-lane-action-hud.html` | Static mock of every kind. |

## Design

### Data

```ts
type ActionHudKind =
  | 'edit' | 'read' | 'search' | 'execute'
  | 'delete' | 'move' | 'fetch'
  | 'thinking' | 'writing' | 'other';

interface LiveAction {
  kind: ActionHudKind;
  title: string;          // "edit" / "read" / tool title fallback
  subject: string | null; // basename or abbreviated path
  sig: string;            // `${kind}|${title}|${subject}` — remount key
}
```

`deriveLiveAction(lane)`:

1. `lane.activity.kind === 'thinking'` → `{kind:'thinking', title:'thinking', subject:null}`
2. `lane.activity.kind === 'writing'` → `{kind:'writing', title:'writing', subject:null}`
3. Else oldest in-progress/pending `toolCalls` entry (same walk as `deriveActiveToolForPeek`):
   - `kind` = map `inferToolLabel(call)` / `call.kind` through the table below
   - `title` = that kind label (`edit`, `read`, …)
   - `subject` = first `locations[].path` (abbreviated) or basename from the title
4. Else `lane.activity.kind === 'tool'` with only a label → `{kind:'other', title:label, subject:null}`
5. Else `null`

| Source | HUD kind |
|--------|----------|
| `edit` / write / create / patch | `edit` |
| `read` / open / cat | `read` |
| `search` / grep / rg / find | `search` |
| `execute` / bash / shell | `execute` |
| `delete` | `delete` |
| `move` | `move` |
| `fetch` / http / web | `fetch` |
| activity `thinking` | `thinking` |
| activity `writing` | `writing` |
| anything else | `other` |

### Slot occupancy

```
.acp-harness__lane-rail          320px
  [data-slot="pins"]
  [data-slot="plan"]
  [data-slot="action"]           NEW — one compact HUD per busy lane
  [data-slot="peek"]             109 card; busy peeked lane embeds the same HUD
  [data-slot="thought"]
  [data-slot="queue"]
```

Show the action slot when `deriveRailLiveActions(lanes)` is non-empty. A lane is listed when `deriveLiveAction(lane)` is non-null **and not** (`kind === 'thinking'` AND the thought slot is already showing that lane's live thought) **and not** (the 109 peek card is visible and already embedding that lane's HUD). Hide the slot when the list is empty. Independent of peek `Esc` dismiss. No new keybinding. Clicking a non-active card activates that lane.

### UI

```
┌──────────────────────────────────────────┐
│ [well]  EDIT                             │
│         tli-api/…/OnlineService.java     │
└──────────────────────────────────────────┘
```

- 320px, hard corners (0), 1px full border in the kind accent (no left rail).
- Left well: 28×28, no border and no fill, `contain: strict`, one `<svg><use href="#krypton-action-{kind}"/></svg>` plus a CSS overlay that is the animation. The glyph sits on the card; the well is only a clip for the instrument.
- Kind label: 11px, weight 600, tracked uppercase, kind accent.
- When the harness has more than one lane, a dim tracked lane name sits on the same row as the kind (`EXECUTE · Claude-2`). Single-lane harnesses stay unlabeled.
- Subject: one ellipsized line; omitted for thinking/writing.
- `role="status"`, `aria-live="polite"`. `title` carries the untruncated path.
- Slot `max-height: min(240px, 42%)`; extra cards scroll.

Peek card: if `snapshot.activeTool` and status is `busy`, render the HUD in place of `renderLanePeekRow('tool', …)`. Same component, `data-owner="peek"`.

### Per-kind instruments

All infinite motion uses DESIGN.md tokens (`--krypton-motion-data-stream` 1.8s linear, `--krypton-motion-radar-ping` 2.5s, `--krypton-motion-ambient` 1.2s, `--krypton-motion-breathing` 3s). Transform and opacity only. Kind change remounts so the 180ms `entrance` (scale 0.96 → 1, hardware-deploy curve) retriggers. Same `sig` → `patchActionHud` (text only, animation stays up).

| Kind | Accent | Well |
|------|--------|------|
| `edit` | `--krypton-warning` | Horizontal write-head: 2px caret sweeps the well L→R, trailing fade. Laser etcher. |
| `read` | `--krypton-accent` | Three 1px scanlines wipe T→B (read head). |
| `search` | `--krypton-success` | Reticle `+` with a radar ping ring. |
| `execute` | `--krypton-accent` | Hex nibble (`A7`/`3C`/…) cycling behind a prompt chevron. |
| `delete` | `--krypton-danger` | Subject gets a strikethrough that pulses; well is an X that breathes. |
| `move` | `--krypton-special` | Three chevrons translate L→R inside a clip. |
| `fetch` | `--krypton-info` | Two incoming dashes enter from the right. |
| `thinking` | `--krypton-special` | Three veil bars breathe out of phase (same language as the thought veil). |
| `writing` | `--krypton-accent` | Block caret blinks on a streaming underscore. |
| `other` | lane accent | Ambient pulse on the kind tag only. |

`prefers-reduced-motion: reduce` — drop every infinite animation; well and accent stay at neon; entrance capped at 120ms.

### Data flow

```
1. tool_call / thought_chunk / message_chunk → field write on lane.activity (unchanged)
2. 1 s composer tick + existing render paths + background `scheduleLaneRender` call renderLaneAction()
3. deriveRailLiveActions(lanes) → empty? hide slot
4. same lane+sig? patchActionHud (kind label + subject + name only)
5. new lane or new sig? remount that card — entrance plays
6. finishTurn / error → activity null → that card drops; slot hides when none remain
```

No new timer. No per-chunk DOM work.

### Composer

`buildBusySegments` loses `activity`. Remaining: `verb`, `elapsed`, `queued`, plus the empty-chip `running` fallback. The meta row no longer needs an activity spring; every leftover segment is short.

## Edge Cases

- **Single lane, no 109 peek** — action slot still shows, unlabeled. This is the common Grok-only case.
- **Several lanes in the same tab** — one labeled card per busy lane, harness order. An idle peer is omitted. Click a foreign card to activate that lane.
- **Peek showing idle peer** — action slot still lists every busy lane (usually the active one).
- **Peek showing a busy peer** — peek card HUD = peeked; action stack lists the other busy lanes. Dismissing peek returns that peer to the stack.
- **Thinking + thought slot on the same lane** — action HUD omitted.
- **Writing + thought slot** — HUD stays (`writing`); thought is a different signal.
- **Multiple in-flight tools** — oldest pending/in_progress, same as peek today.
- **Live Assist** — untouched (spec 209).
- **Zen / view-split / narrow rail** — slot uses the existing `max-width: calc(100% - 24px)` rail rule; subject ellipsizes.
- **Long / multiline command title** — Grok often puts the whole `cd …; actionlint …` line in `title` with `kind: other` and no `rawInput.command` yet. Kind stays the short verb (`execute`); subject is that command collapsed to one line and CSS-ellipsized. The untruncated command stays on the tooltip. Never dump the command into the uppercase kind label — that wraps inside the 72px slot.
- **Reduced motion** — static well + label + subject.

## Open Questions

None. Placement (sibling slot, active-lane-bound) and the omit-thinking-when-thought-is-showing rule are the two forks; both are resolved above.

## Out of Scope

- Live Assist compact activity (spec 209).
- Animating collapsed lane-head activity or the zen rail.
- Persisting HUD state.
- Sound.
- New keybindings or TOML.

## Resources

- [DESIGN.md motion](../DESIGN.md) — breathing / data-stream / radar-ping tokens, reduced-motion policy, no `backdrop-filter`.
- Visual Studio Peek Definition — inspect-without-switching, which the rail already follows.
- `docs/prototypes/231-lane-action-hud.html` — static mock of every kind, before/after composer.
- N/A external APIs — purely a frontend relocation of existing `lane.activity`.
