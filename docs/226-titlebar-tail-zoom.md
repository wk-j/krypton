# Titlebar Session Mark — Implementation Spec

> Status: Implemented
> Date: 2026-08-17
> Milestone: M9 — chrome scanability

## Problem

Tiled windows share the same chrome weight. The titlebar label is 11px uppercase
and the only focus cue is a 1px border stepping from 0.5 to 0.8, so it is hard
to tell which tile is focused from across the workspace.

A first cut magnified the **last two characters** of whatever the title string
currently was, at full brightness on every tile. Real titles are OSC cwd paths
(`~/S/KRYPTON`), so every window shouted a meaningless `ON`. That hid focus
instead of marking it.

## Solution

The right-edge mark is the **session identity** (`01` from `session_01`), not a
slice of the current title. The left-hand label carries the live title (cwd
path, SSH host, content name) in full. The mark stays put when OSC 0/2 replaces
the title.

Only the **focused** window zooms the mark to 2.9× (same dock zoom as the
footer lane logo, spec 218). Unfocused tiles keep a quiet 11px `01` so the
digits stay scannable without four giant glyphs competing.

Windows with no session identity (agent, vault, Quick Terminal, content views)
have no tail.

## Research

- Specs 218/219 already proved the zoom language: lane logo uses `transform:
  scale(2.9)` (fixed 1em square); project badge uses scaled `font-size` because
  text has no CSS expression for "reserve 1.9 × my width". The session mark is
  text, so it uses `font-size`.
- `.krypton-window__titlebar` was `overflow: hidden` for the ack wipe, and
  `progress.css` (loaded after `window.css`) re-asserted `overflow: hidden`
  for the OSC 9;4 scanline. That clipped the 2.9× digits to the 28px rail.
  The titlebar is now `overflow-x: clip; overflow-y: visible` so the sweep
  stays in the rail horizontally while the mark hangs into the header-accent
  band and, at a large chrome size, the pane.
- `.krypton-window__titlebar-end` is `height: 100%` + `min-height: 0`. Without
  that lock the zoomed tail grew the cluster, the titlebar's `align-items:
  center` split the extra above *and* below the rail, and the digits poked
  out the top of the window. Top-align the tail (`align-self: flex-start`) so
  every overflowing pixel drops into the window, never out the frame.
- Titlebar is *before* the pane in DOM. `z-index` on the titlebar alone is
  trapped in the chrome flex item's layer, so the hang still painted *under*
  the later content/pane sibling (and the header-accent `<canvas>` compositor
  layer could slice the digits). `.krypton-window__chrome` is `z-index: 2` so
  the whole head — overflow included — paints above the pane; the titlebar is
  `z-index: 1` inside that; the band is `z-index: -1`; the mark itself is a
  positioned compositor layer (`z-index: 2` + `translateZ(0)`) so the canvas
  cannot cover the hanging ink.
- Last-two-characters of the live title — rejected after seeing cwd paths:
  `KRYPTON` → `ON` on every tile.
- First two characters, left-aligned (spec 219). Rejected: default titles are
  `session_NN`; the distinctive digits are at the end, and the user asked for
  the right edge to match the lane-icon position.

## Prior Art

| App | Implementation | Notes |
|-----|----------------|-------|
| Krypton footer (218/219) | 2.9× lane logo + 2-char project drop cap | The zoom being reused |
| iTerm2 badge | Oversized session label in the pane | Rejected: would cover terminal output |
| tmux `window-status-current-format` | Restyle the current window name | Same "make the current id louder" idea |

**Krypton delta** — the glance mark is the session number, pinned to the
titlebar's right edge, zoomed only while that window is focused.

## Affected Files

| File | Change |
|------|--------|
| `src/window-title-label.ts` | `session_NN` split; OSC titles keep the current mark |
| `src/window-title-label.test.ts` | Session split, path titles, mark persistence |
| `src/compositor.ts` | Titlebar-end cluster; all title writes go through `paintWindowLabel` |
| `src/styles/window.css` | Quiet unfocused mark; 2.9× on `.krypton-window--focused`; chrome `z-index: 2`; titlebar `overflow-x: clip` / `overflow-y: visible`; mark layer above the header-accent canvas |
| `src/styles/progress.css` | Must not set `overflow: hidden` on the titlebar (clips the mark) |
| `src/styles/agent.css` / `vault-view.css` | Sibling aesthetics keep their palette on the tail |
| `docs/04-architecture.md` | Titlebar DOM |
| `DESIGN.md` | Window anatomy |

## Design

### Data Structures

```ts
export const TITLE_TAIL_LEN = 2;
export function splitTitleLabel(text: string): { rest: string; tail: string };
export function nextTitleLabel(text: string, currentTail: string): { rest: string; tail: string };
```

`splitTitleLabel` matches `session_NN` only. `nextTitleLabel` lets an OSC cwd
title replace the left-hand label without erasing the mark already on the tile.

### Data Flow

```
1. createWindow paints session_NN — rest `session_`, tail `01`
2. OSC 0/2 title sync calls paintWindowLabel with the cwd path —
   left label becomes the path, tail stays `01`
3. spawn / SSH may write a new session_NN, which replaces the mark
4. Content windows and Quick Terminal never match session_NN, so they
   have no tail
```

### UI Changes

```
[● ~/S/KRYPTON          ]     [pty // active  01]
                              └ titlebar-end ─┘
```

- `.krypton-window__chrome` — `z-index: 2` so overflow paints above the pane
- `.krypton-window__titlebar` — `overflow-x: clip; overflow-y: visible` (not `hidden`)
- `.krypton-window__header-accent` — `z-index: -1` so the canvas sits behind the hanging mark
- `.krypton-window__titlebar-end` — flex cluster, right side; `height: 100%` so the zoomed tail cannot grow it
- `.krypton-window__label-tail` — 11px, 0.45 opacity when unfocused; positioned layer
- `.krypton-window--focused .krypton-window__label-tail` — 2.9×, full accent, `align-self: flex-start` so extra hangs down into the window; `translateZ(0)` so the canvas cannot cover it
- Titles that are not `session_NN` never produce a tail of their own

## Edge Cases

- Blank title — tail hidden if the window has no session mark
- OSC title replace — left label updates; a two-digit session mark stays
- Leftover last-two-character tails (`ON` from `KRYPTON`) are dropped on the next paint
- Pinned-window list reads `data-title`, not the split `textContent`
- Agent / vault / Quick Terminal — no session mark, no tail
- SSH clone writes `ssh_<host>` as the left label and keeps the mark

## Out of Scope

- Changing what the title string *is* (still OSC / `session_NN` / content title)
- Inventing window numbers for content views
- Config knob for the zoom factor (themeable via `--krypton-title-tail-zoom`)

## Resources

- `docs/218-window-lane-strip.md` — dock zoom factor and overflow direction
- `docs/219-window-project-badge.md` — why text uses `font-size`, not `transform`
- `DESIGN.md` — window anatomy, no side-stripe accents
