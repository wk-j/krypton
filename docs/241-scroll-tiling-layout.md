# Scroll Tiling Layout (niri-style) — Implementation Spec

> Status: Implemented
> Date: 2026-09-03
> Milestone: M3 — Compositor & Windows

## Problem

Krypton's Grid and Focus modes **reflow** every window when one is created or closed. That is the classic tiling annoyance: a new shell shrinks the editor you were reading. niri's rule is the opposite — windows live in columns on an infinite horizontal strip, and opening a window never changes existing sizes. Krypton has no layout that behaves this way.

## Solution

Add a fourth compositor mode, **`Scroll`**, modeled on niri's scrollable tiling (not niri's workspaces, overview, or tabbed columns).

Windows sit in **columns** on a horizontal strip. A column is one or more Krypton windows stacked full-height. New windows become a new column to the right of focus at a default width; other columns keep their widths. A **camera** (`scrollCameraX`) pans so the focused column stays in the horizontal center of the screen. Off-strip neighbors peek in leftover viewport space.

**Why not replace Grid:** Grid/Focus/Depth stay. Scroll is opt-in via `Leader f` cycle and `[workspaces].default_layout = "scroll"`.

**Why stack windows in a column (not 1:1):** that is the niri primitive (consume/expel). Intra-window pane splits (`Leader \ / -`) stay a different grain — same chrome, same PTY tree — while a column stack is two windows with independent tabs, titles, and views.

## Research

niri ([niri-wm/niri](https://github.com/niri-wm/niri)) is a scrollable-tiling Wayland compositor inspired by PaperWM:

- Columns on an infinite strip to the right. New windows do not resize existing ones.
- A column holds one or more windows stacked vertically; widths are independent (`proportion` or `fixed`).
- Default presets: ⅓, ½, ⅔ of the output. Default new-column width: ½.
- Camera: `center-focused-column` = `never` (default: snap the focused column to the near edge), `always`, or `on-overflow`. `always-center-single-column` centers a lone column.
- Consume/expel moves a window into or out of a neighbor column; `Mod+H/L` focus columns, `Mod+J/K` focus within a column.
- Separate from that: GNOME-style **vertical dynamic workspaces**, an Overview, floating windows, tabbed columns, gestures.

Krypton already has named workspaces (`Cmd+1/2/3`), tabs, and pane splits. Mapping: niri column → Krypton window column; niri in-column stack → stacked Krypton windows; niri workspaces → **keep Krypton's named workspaces** (one strip per workspace). Do not port Overview, floating, or tabbed columns.

Layout math belongs in a new module (`src/scroll-layout.ts`) with unit tests. `compositor.ts` is already ~6.7k lines (spec 56); do not bury the algorithm there.

Windows keep `position: absolute` bounds (`applyBounds`). The camera is applied as `screenX = stripX - cameraX` (plus workspace gap). `html/body` already `overflow: hidden`, so off-screen windows clip.

## Prior Art

| App | Implementation | Notes |
|-----|----------------|-------|
| **niri** | Infinite column strip; consume/expel; preset widths; camera snap | Ground truth for this spec |
| **PaperWM** | GNOME extension; horizontal strip; usually one window full-height | Ancestor; weaker in-column stacking |
| **Hyprland scrolling** | Built-in scrolling layout | Same idea bolted onto a traditional compositor |
| **OmniWM** | macOS niri-like columns | Consume/expel on move left/right |
| **i3 / Sway / Zellij / tmux** | Tree or auto-tile; new pane **reflows** siblings | Opposite of niri; matches Krypton Grid today |
| **Krypton Grid/Focus** | Auto-tile / 65–35 main+stack; every add/close relayouts all | What Scroll must not do |

**Krypton delta** — match niri's two rules: *new window does not resize others*; *focused window does not jump when something changes to its left*. Diverge: shipped camera is `center_focused_column = "always"` (niri ships `never`) so the active window stays in the center of the screen; no niri workspaces/overview/floating/tabbed-columns; keys stay on the Leader map (`h/j/k/l`, `,` `.`, `=`) instead of Super; mouse wheel is secondary.

## Affected Files

| File | Change |
|------|--------|
| `src/types.ts` | `LayoutMode.Scroll`; `ScrollColumn`, `ColumnWidth` |
| `src/scroll-layout.ts` | **New** — pack, camera, consume/expel, insert/close. Pure functions + tests |
| `src/scroll-layout.test.ts` | **New** — camera, insert-does-not-resize, consume/expel, close, viewport resize |
| `src/compositor.ts` | `scrollColumns`, `scrollCameraX`; `relayoutScroll()`; create/close/focus hooks; enter/leave conversion; `toggleFocusLayout` cycle; `focusCycle` Scroll branch (strip order + camera) |
| `src/input-router.ts` | Scroll branches for `h/j/k/l`, `,` `.`, `=`; Resize/Move/Swap in Scroll |
| `src/which-key.ts` | Scroll-specific labels for hjkl / `,` `.` / `=` |
| `src/command-palette.ts` | Cycle label; "Layout: Scroll" action |
| `src/config.ts`, `src-tauri/src/config.rs` | `[workspaces.scroll]` + `default_layout = "scroll"` |
| `src/styles/window.css` | `.krypton-window--scroll` if a peek/clip class is needed |
| `docs/02-functional-requirements.md` | FR-INP-037 cycle; new FR-WS-040… |
| `docs/04-architecture.md` | Layout engine bullet: four modes |
| `docs/06-configuration.md` | `default_layout` + `[workspaces.scroll]` |

## Design

### Data Structures

```typescript
export enum LayoutMode {
  Grid = 'Grid',
  Focus = 'Focus',
  Depth = 'Depth',
  Scroll = 'Scroll',
}

/** Width of a column. v1 is proportion-only (of the usable viewport width). */
export interface ColumnWidth {
  kind: 'proportion';
  value: number; // 0..1, clamped
}

export interface ScrollColumn {
  windowIds: WindowId[]; // top → bottom, length ≥ 1
  width: ColumnWidth;
  heights?: number[]; // proportion of usableH, parallel to windowIds; omitted = 1
}

export interface ScrollState {
  columns: ScrollColumn[];
  cameraX: number; // strip-space origin of the left viewport edge
}

export type CenterFocusedColumn = 'never' | 'always' | 'on-overflow';
```

Compositor owns one `ScrollState` per live window set (reset on workspace switch, same as depth order today).

### Layout algorithm (`src/scroll-layout.ts`)

Usable viewport: `vw - 2*gap` wide, `vh - FOOTER_HEIGHT - 2*gap` tall (same inset as Grid). `gap` is the user's `[workspaces] gap` (`Compositor.windowGap`, clamped 0–64) — Scroll spends it three ways: the workspace edge inset, the space between columns, and the space between stacked windows inside a column. Changing it and running **Reload Config** re-tiles the strip immediately (`relayoutAfterConfig()`); no Scroll-specific gap knob in v1.

**Pack.** Left-to-right: `pixelW = clamp(proportion * usableW, MIN_COL_PX, usableW)`; `stripX` accumulates `pixelW + gap`. Each window stores a height proportion of usableH (default `default_window_height`, shipped `1` = fill). Requested `px = proportion * usableH`. The stack is **vertically centered** in the column: if it plus gaps fits, leftover space is split evenly above and below; if it overflows, scale all heights in that column so they fit (leftover 0, so centering is a no-op). A column of all-`1` windows therefore still splits equally — same as v1.

**Camera (`always`, default).** Center the focused column: `cameraX = colMid - usableW/2` (may be negative so a first, last, or narrow column sits in the middle of the screen). Neighbors peek in leftover space.

- `never`: keep the focused column fully visible — if it starts left of `cameraX`, snap left; if it ends right of `cameraX + usableW`, snap right. Clamp to `[0, max(0, stripW - usableW)]`.
- `on-overflow`: center only when focused + previously focused do not both fit.
- `always-center-single-column` (default **true**): one column is always centered, even if the user sets `center_focused_column = "never"`.

**Stationary focus.** Inserting/closing a column **to the left** of the focused column shifts `cameraX` by the same delta so the focused column's screen X does not jump. Inserting to the right does not move `cameraX` except to bring a newly focused column on screen.

**Insert.** New window → new column immediately **right of the focused column**, width = `default_column_width` (0.5), height = `default_window_height` (1). Other columns' proportions unchanged. Focus the new window; camera follows.

**Close.** Remove the window from its column; drop empty columns. Focus: next in column, else neighbor column, else none. Camera keeps the new focus stationary.

**Consume-or-expel left/right.** If the focused window is alone in its column, merge it into the neighbor (append bottom). If it shares a column, expel it into a **new** column on that side at `default_column_width`. Neighbor widths unchanged. Each window keeps its stored height.

### Mode enter / leave

**Enter Scroll** from Grid/Focus/Depth: sort current windows by `(bounds.x, bounds.y)`; each becomes its own column at `default_column_width` × `default_window_height`; camera shows the focused window. Do not try to preserve Focus stacking.

**Leave Scroll:** flatten columns left-to-right, top-to-bottom into compositor window order so Grid/Focus/Depth get a stable sequence. Clear any Scroll-only inline styles.

`toggleFocusLayout()` cycle:

```
Grid → Focus → Depth → Scroll → Grid
```

### Create / close / maximize / pin

- `createWindow` while `layoutMode === Scroll` uses insert-to-the-right, not `relayoutGrid`.
- Maximize (`Leader z`) unchanged: fill workspace, hide others; restore returns to Scroll pack + camera.
- Pin has **no effect** in Scroll (same as Grid).
- Quick Terminal still not in the strip.
- **`focusCycle` (global `Cmd+Shift+<` / `Cmd+Shift+>`)** works in Scroll on the same keys as Grid/Focus/Depth, but walks strip order (left-to-right, top-to-bottom in a column) and **does not wrap** — at either end of the strip it is a no-op. Circular scrolling is deliberately out: wrapping would fling the camera across the whole strip, breaking niri's "the focused window does not jump" rule. Grid/Focus/Depth keep their existing wrap. `nextInStripOrder()` returns `null` at the ends; the camera follows normal focus. Do not use creation order. Pin is ignored (Scroll has no pin). The existing input-router binding stays; only `Compositor.focusCycle` grows a Scroll branch.

### Keybindings

Existing `h/j/k/l` already mean "focus in that direction". In Scroll they mean column/window, matching niri `Mod+hjkl`. `[` `]` stay **tabs**.

| Key | Context | Action |
|-----|---------|--------|
| `f` | Compositor | Cycle Grid → Focus → Depth → Scroll → Grid |
| `h` / `l` | Compositor + Scroll | Focus column left / right (camera follows) |
| `j` / `k` | Compositor + Scroll | Focus window down / up in the column |
| `,` | Compositor + Scroll | Consume-or-expel left. Not globally reserved: a focused view that owns `,` (ACP Harness model picker) keeps it. |
| `.` | Compositor + Scroll | Consume-or-expel right. Same: Harness directives keep `.` when that pane is focused. |
| `=` | Compositor + Scroll | Cycle preset column widths (⅓ → ½ → ⅔). Harness lane metrics keep `=` when focused. |
| `1–9` | Compositor + Scroll | Focus window N in strip order (left-to-right, top-to-bottom) |
| `Cmd+Shift+<` / `Cmd+Shift+>` | Global (all layouts) | Cycle focus next / previous. In Scroll: strip order, camera follows, **no wrap** (stops at the strip ends). Same keys as Grid/Focus/Depth. |
| Resize arrows | Resize + Scroll | Left/right: column width ± `resize_step` as proportion. Up/down: focused window height ± `resize_step` as proportion of usableH (`↓` grows, `↑` shrinks, same as Grid) |
| Move arrows | Move + Scroll | Left/right: move **column**. Up/down: reorder window in column |
| Swap `h/l/j/k` | Swap + Scroll | Swap with neighbor column or window in column |
| Wheel | Scroll, over workspace | Secondary: pan camera (keyboard still primary) |

Which-key in Scroll replaces the generic "Focus Left" labels with "Column Left/Right", "Window Up/Down", and shows `,` `.` `=`.

### UI Changes

No new chrome. Off-screen windows remain in the DOM (PTY must keep running) at strip coordinates minus camera; the workspace clips them. Animate pack + camera with the existing morph (`animateRelayout`) — do not add a CSS `transform` on a strip wrapper in v1 (would fight `applyBounds` and Depth cleanup).

### Configuration

```toml
[workspaces]
default_layout = "focus"   # now also: "scroll"

[workspaces.scroll]
default_column_width = 0.5
default_window_height = 1.0              # 0.15–1.0 of usable height; 1.0 = fill
preset_column_widths = [0.33333, 0.5, 0.66667]
center_focused_column = "always"         # never | always | on-overflow
always_center_single_column = true
```

Shipped default stays `"focus"`. Set `"scroll"` to start in this mode.

## Edge Cases

| Case | Handling |
|------|----------|
| One window | Centered horizontally at default width (½) and vertically in the column, height = `default_window_height` (full unless configured shorter). Maximize still fills. |
| Column wider than viewport | Clamp pixel width to `usableW`; camera shows it alone. |
| Close last window in column | Column removed; focus neighbor. |
| Focus cycle at a strip end | No-op — Scroll has no circular scroll (`h`/`l`/`j`/`k` at an edge are likewise no-ops). |
| Consume with no neighbor | No-op. |
| Workspace switch | New strip; do not persist camera across workspaces in v1. |
| Enter Scroll while maximized | Exit maximize, then convert. |
| App/viewport resize | Recompute pixel widths and heights from stored proportions; keep focused column visible. |
| Depth styles leftover | `clearDepthStyles()` still runs when leaving Depth, including into Scroll. |

## Open Questions

None — defaults above are the v1 contract. Tabbed columns remain out of scope.

## Out of Scope

- niri dynamic workspaces, Overview, floating windows, tabbed columns
- Trackpad swipe workspaces; touchscreen gestures
- Fixed-pixel column widths or window heights (`kind = 'fixed'`)
- Preset window-height cycling (niri `switch-preset-window-height`)
- Sticky/pinned columns
- Circular (wrapping) scroll or focus cycling on the strip
- Replacing Grid
- Changing the shipped `default_layout`

## Resources

- [niri README](https://github.com/niri-wm/niri) — strip + "opening a new window never causes existing windows to resize"
- [niri Design Principles](https://niri-wm.github.io/niri/Development%3A-Design-Principles.html) — no auto-resize; focused window does not move on its own
- [niri Layout config](https://niri-wm.github.io/niri/Configuration%3A-Layout.html) — presets, `center-focused-column`, `always-center-single-column`
- [niri default binds](https://github.com/niri-wm/niri/blob/main/resources/default-config.kdl) — hjkl, consume/expel, preset width
- [PaperWM](https://github.com/paperwm/PaperWM) — ancestral horizontal strip
- Krypton `src/layout.ts`, `src/compositor.ts` (`relayout*`, `toggleFocusLayout`), `docs/58-depth-zstack-layout.md` (fourth-mode pattern)
