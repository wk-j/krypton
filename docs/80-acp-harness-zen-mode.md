# ACP Harness Zen Mode — Implementation Spec

> Status: Draft (awaiting approval)
> Date: 2026-05-03
> Milestone: M8 — Polish

## Problem

The ACP harness dashboard currently renders four lanes (Codex, Claude, Gemini, OpenCode) one above another, each with full transcript, lane head, and lane stats. When the user is working with one lane — typing a prompt, reading the reply — the other three lanes' heads, stats, and transcripts compete for attention. The user reports the working area does not feel "zen" enough for single-lane focus work.

The fix is not to delete the dashboard. Multi-lane oversight is the harness's reason to exist. The fix is a **toggleable Zen Mode** that shrinks the three inactive lanes into a thin left-side rail while keeping enough cross-lane signal that nothing important goes silent.

## Solution

Add `zenMode: boolean` to `AcpHarnessView`. Persist per-project in `localStorage`. Toggle with `Cmd+.`. When on:

1. The dashboard becomes a 2-column grid: a **rail** on the left (fixed width) listing all four lanes compactly, and the **active lane body** filling the rest.
2. The topbar hides only its title `ACP Harness`. Cwd and global counts remain.
3. Inactive lanes (3 of them) render as compact rail entries — status dot + lane name + permission badge if pending — instead of their full lane head + stats + transcript body.
4. The active lane is rendered exactly as today (lane head, stats, transcript body) inside the right-hand grid cell. It is also reflected as a highlighted entry in the rail so rail position stays stable across `Tab` cycles.
5. Composer, tool transcript rows, memory peek overlay, and help overlay are unchanged.

Zen Mode is purely a presentation layer over existing state. It does not change PTY routing, ACP wire protocol, the memory MCP server, lane spawning, or any input semantic outside the single new accelerator.

## Research

- Codex-1's original draft suggested `Esc z` chord, `Ctrl+M` peek, `1-9` direct switch, slim composer, and tool-row auto-collapse. Several were rejected in the Claude-1 review at `memory_get('Claude-1')` 2026-05-03 — see *Decisions* below.
- The harness already toggles a root-level class for transcript focus (`acp-harness--transcript-focus`, line 997). Zen follows the same pattern with `acp-harness--zen`.
- macOS WebView gotcha: `backdrop-filter: blur()` is forbidden (CLAUDE.md). Zen never uses blur.
- `Cmd+.` is verified unbound across the codebase (`src/input-router.ts`, all view onKeyDown handlers). `Cmd+Shift+.` is used at `input-router.ts:67` but plain `Cmd+.` is free.
- Existing rail-style precedent: VS Code activity bar, Slack sidebar — narrow vertical strip with status-only entries for items not currently focused. Concept is well-understood by users.

## Decisions

The following decisions were locked in via design review with the user (2026-05-03). Each is the resolution of a branch in the design tree.

| Decision | Choice | Why |
|---|---|---|
| Persistence | Per-project, via `localStorage` key `krypton:acp-harness:zen:<projectDir>` | User who works zen on a project will want it sticky for that project; other projects can default to dashboard. |
| Rail position | Left of active lane body | Memory peek already lives on the right (line 320). Putting rail on the left keeps both reachable simultaneously. Reading flow: rail (who) → body (what) → memory peek (shared knowledge). |
| Rail content | All 4 lanes (active highlighted), stable order | Tab cycling does not reorder rail. Eyes/muscle memory stay locked. Active is also visible in body, but rail entry is the navigation landmark. |
| Accelerator | `Cmd+.` | Single press, no chord; macOS-conventional "cancel/dismiss" matching mood; verified unbound. |
| Tool-row collapse rules | **Not touching** | Tool transcript rendering stays as today in both modes. Out of scope. |
| Composer slim | **Not touching** | Composer is already minimal (chip line, optional staging, single input line). Hiding any part risks losing functional state (e.g., warning chip from spec 79). |
| Topbar | Hide title `ACP Harness` only | Cwd and global counts (`X idle · Y busy · Z perm · W error`) stay — they are the *only* aggregate signal of cross-lane state and must remain. |
| Active lane body | **Not touching** | Lane head + stats + transcript rendered as today. Rail does not duplicate stats. |
| Memory unread indicator | **Dropped from v1** | Adds in-memory state and rendering complexity for marginal benefit; can be revisited if peek-write asymmetry becomes painful. |
| Rail entry content | Status dot + lane name only | Minimal surface. No permission badge element. Attention is signaled via dot animation instead (next row). |
| Attention signal | Dot pulse animation when `lane.status === 'needs_permission'` or `'error'` | Single keyframe on the existing dot — no new DOM, no layered pseudo-elements. Pulse keeps rail "quiet" except when the user must act. |
| Rail entry interaction | **Keyboard only** (Tab / Shift+Tab) | Krypton is keyboard-driven. No click handler on rail entries. |

## Affected Files

| File | Change |
|------|--------|
| `src/acp/acp-harness-view.ts` | Add `zenMode: boolean` field (default false; init from `localStorage`); add `toggleZenMode()` and `Cmd+.` handler near top of `onKeyDown`; in `render()`, toggle `acp-harness--zen` on root and switch inactive-lane rendering between full lane body and compact rail entry. |
| `src/styles/acp-harness.css` | New `.acp-harness--zen` block: dashboard grid layout (rail column + body column), inactive-lane rail-entry styles, hide `.acp-harness__title`, active-lane rail highlight. |
| `docs/72-acp-harness-view.md` | Add Zen Mode subsection under Design; update Help Overlay key table. |
| `docs/PROGRESS.md` | Add spec 80 entry. |

No Rust changes. No IPC changes. No new dependencies. No changes to `src/compositor.ts`, `src/input-router.ts`, `src/command-palette.ts`, or `src/which-key.ts`.

## Design

### Data structures

```ts
class AcpHarnessView {
  // ...existing fields...
  private zenMode: boolean = false;
}
```

In the constructor, after `this.projectDir` is set:

```ts
const key = `krypton:acp-harness:zen:${this.projectDir ?? ''}`;
this.zenMode = localStorage.getItem(key) === '1';
```

`toggleZenMode()` flips the flag, writes to `localStorage`, and calls `render()`. No other state is added; the rail derives entirely from `this.lanes` plus `this.activeLaneId`.

### Key handler

Top of `onKeyDown`, before the help/memory short-circuits, so toggling Zen works even when overlays are open:

```ts
if (e.key === '.' && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
  e.preventDefault();
  this.toggleZenMode();
  return true;
}
```

`Tab` / `Shift+Tab` lane cycling is unchanged. `Cmd+M` memory peek is unchanged. `?` help is unchanged. No new bindings beyond `Cmd+.`.

### DOM / CSS deltas

The class `acp-harness--zen` is toggled on `this.element`. All structural elements stay in the DOM; visibility and layout are CSS-driven.

| Element | Normal | Zen |
|---|---|---|
| `.acp-harness__topbar` | full topbar (title + cwd + counts) | title hidden via CSS; cwd + counts unchanged |
| `.acp-harness__dashboard` | flex column of all lanes | CSS grid: `grid-template-columns: clamp(180px, 14vw, 240px) 1fr` (rail \| body) |
| `.acp-harness__lane--active` | full lane head + stats + transcript body | unchanged in body cell; **also** reflected as a `.acp-harness__rail-entry--active` highlight in the rail cell |
| `.acp-harness__lane--collapsed` (inactive lanes) | full transcript collapsed | rendered as `.acp-harness__rail-entry` (status dot + lane name only) instead of full lane element; placed in rail column |
| `.acp-harness__memory-overlay` | unchanged | unchanged (still right-hand peek) |
| `.acp-harness__help-overlay` | unchanged | unchanged; copy gains `Cmd+.` line |
| `.acp-harness__composer` | unchanged | unchanged |

Rail rendering replaces the full lane element for inactive lanes. The active lane keeps its full element rendered into the body column. The rail also includes a highlighted entry mirroring the active lane so the rail's order and length stay stable across lane switches.

Each rail entry has exactly two visual parts: a status dot and the lane name. No permission badge, no MCP/token stats, no busy spinner. When `lane.status` is `needs_permission` or `error`, a single CSS keyframe animation pulses the dot:

```css
@keyframes acp-harness-zen-attention {
  0%, 100% { transform: scale(1);   opacity: 1;   }
  50%      { transform: scale(1.4); opacity: 0.6; }
}
.acp-harness--zen .acp-harness__rail-entry--needs_permission .acp-harness__rail-dot,
.acp-harness--zen .acp-harness__rail-entry--error            .acp-harness__rail-dot {
  animation: acp-harness-zen-attention 1.2s ease-in-out infinite;
}
```

The CLAUDE.md memory rule against layered pseudo-element effects is respected: rail entry styling is a single flat row with `color`, `border-left`, and `background`. The pulse animates `transform` + `opacity` on the dot itself — no stacked `::before`/`::after` glow layers.

Rail entries have no `click` handler. Lane switching is keyboard-only (`Tab` / `Shift+Tab`), consistent with Krypton's keyboard-first design.

### Render path

`render()` already runs on every state change. Add:

1. Root class toggle near the existing transcript-focus toggle:
   ```ts
   this.element.classList.toggle('acp-harness--zen', this.zenMode);
   ```
2. In the lanes-iteration block: when `this.zenMode`, render each lane through a new `renderRailEntry(lane)` helper instead of the full lane DOM, **except** the active lane which uses both — full lane DOM in the body column, plus a highlighted rail entry in the rail column.
3. The dashboard is wrapped in two child containers: `.acp-harness__rail` and `.acp-harness__body-cell`. CSS grid places them side-by-side in Zen, and reverts to a single column in Normal (where rail is hidden via `display: none`).

### Help overlay

Add one line under "Lane Control":
```
Cmd+.            Toggle Zen Mode
```

## Edge cases

- **Toggle while help is open**: help stays open; dashboard re-skins behind it. On help close, user sees Zen.
- **Toggle while memory peek is open**: peek stays open; rail and body re-arrange in the background. Peek still occupies the right column.
- **Toggle while a permission is pending on inactive lane**: rail entry shows the pending state (per rail-content decision); user Tabs to that lane, composer permission banner appears as today.
- **Toggle while transcript-focused**: `acp-harness--transcript-focus` and `acp-harness--zen` coexist on the same root; transcript navigation keys are unaffected.
- **Backend missing (lane never spawned)**: lanes that did not spawn never enter `this.lanes`, so they don't appear in the rail. System rows (e.g. `"X backend not installed - skipped"`) still render in the active lane's empty state when relevant.
- **Window resize**: rail width is `clamp()`-bounded; body uses `1fr`. No JS resize handler change.
- **First time entering Zen on a project**: `localStorage.getItem` returns `null`, `zenMode` initializes to `false`. First `Cmd+.` writes `'1'`. Re-opening the harness for that project from then on starts in Zen.
- **Project dir is `null`** (untitled harness): localStorage key becomes `krypton:acp-harness:zen:` — single shared bucket for null-project instances; acceptable.
- **Drag-over highlight**: existing `.acp-harness--drag-over` coexists with `.acp-harness--zen` on the same root.

## Non-goals

- Do **not** redesign the composer.
- Do **not** change tool-row rendering or auto-collapse.
- Do **not** change the layout engine, compositor, or input-router (Zen lives entirely inside `AcpHarnessView`).
- Do **not** touch the ACP wire protocol, memory MCP server, or any Rust file.
- Do **not** add a memory unread indicator in v1.
- Do **not** implement `Esc z` chord, `Ctrl+M`, or `1-9` direct lane switch.
- Do **not** auto-enter Zen on idle. Toggle is user-initiated only.
- Do **not** add a per-lane Zen flag — Zen is a single global flag per harness instance.
- Do **not** change scroll position when toggling.

## Open Questions

1. **Command palette entry** — add a "Toggle ACP Harness Zen Mode" action for discoverability. Low cost. Out of v1 unless requested.
2. **`localStorage` cleanup** — entries accumulate as user opens many project dirs over time. Acceptable for v1; consider TTL or LRU later.

## Implementation Phases

1. **Phase 1 — Skeleton.** Add `zenMode` field with `localStorage` init/persist, `Cmd+.` handler, root class toggle. CSS: grid swap (rail \| body), hide title, rail entry styles (dot + name only), active-lane rail highlight.
2. **Phase 2 — Attention pulse.** Add `acp-harness-zen-attention` keyframe + selectors for `needs_permission`/`error` lane statuses on rail entry dots. Verify no flicker when status transitions.
3. **Phase 3 — Polish.** Help overlay copy (`Cmd+. Toggle Zen Mode`), edge case verification, doc updates (`docs/72-acp-harness-view.md`, `docs/PROGRESS.md`).
