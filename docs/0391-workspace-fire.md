# Workspace Fire — Implementation Spec

> Status: Implemented
> Date: 2026-11-12
> Milestone: Window chrome — program status presentation (moves [0362](./0362-program-status-fire.md); keeps [0363](./0363-program-status-fire-look.md) looks and the [0365](./0365-harness-tool-error-fire.md) trigger)

## Problem

The program-status fire burns inside each window, along the bottom of its content. There it sits under the prompt, the status lines and the window foot, and every burning window runs its own WebGL context. The user wants one fire for the whole workspace, burning along its bottom edge, rising from the workspace footer.

## Solution

Fire becomes a single workspace band. One WebGL2 canvas sits along the bottom of `#krypton-workspace`, right above the workspace footer, under every window. The triggers stay the same. Each window still computes its burn state exactly as in 0362/0365 (`winTop` plus the content-view trigger, filtered by `[fire] on`). The workspace burns while any window has a burn state, and it uses the look of the highest-priority one. Windows no longer get a canvas. The 0363 looks, the ease between looks, the heat envelope, reduced motion and context-loss handling all stay as they are. Only the host and the aggregation change.

## Research

- **One driver stays.** `paintProgramStatus(win)` (`compositor.ts:1471-1489`) is the only caller of `fire.sync`. `removeWindow` calls `fire.remove(win.id)` (`:5579`), `fitAll` calls `fire.resize()` (`:8742`), and `applyConfig` calls `fire.configure` and then repaints every window (`:780-781`). Keeping these four call sites lets the controller own the aggregation, and the compositor barely changes.
- **The host.** There is one workspace element, `#krypton-workspace` (`index.html:10`). It is `position: fixed`, full viewport, transparent and flat, with no `preserve-3d` (`window.css:2-9`; the 3D tilt lives inside each window's `__perspective`). Windows are its children. Their inline `z-index` is empty in Grid and set to 1–110 in Focus, Stage and Wheel (`compositor.ts:8001`, `:8204`, `:8396`). A positioned canvas at `z-index: 0`, inserted as the **first** child, is painted before every window, so no window is ever covered. No code walks `workspace.children` (only `main.ts:47` clears it before the compositor exists).
- **The floor.** Every layout reserves `Compositor.FOOTER_HEIGHT = 28` (`:7686`) whether or not the footer shows. `WorkspaceFooter.setVisible` hides the 28 px plate (`workspace-footer.ts:208-213`), and the compositor already hears about it through `setKeyboardOverlayFooterVisible` (`:5476`, wired at `main.ts:149-150`). The band's bottom edge follows that: 28 px while the footer shows, 0 when it is hidden.
- **Geometry.** `fireBand(w, h, height)` sizes the flame from the host height (22%, clamped to 40–120 px), so any workspace taller than about 545 px gets the 120 px built-in flame and a 264 px band. The shader's host is a rounded rect under the band (`fire-shader.ts:193-199`). `sdRRect` clamps the radius and `sdGrad` guards the divide (`:117-128`), so radius 0 is safe: the flames then run to both screen edges, which matches the square footer seam.
- **What a window hides.** `.krypton-window` paints `--mat-screen`, the theme backdrop at `[visual] opacity` (`window.css:19-36`). The flames therefore show through a window's screen at that opacity, fully in gaps and empty workspace, and not at all behind opaque plates (titlebar, tab bar, window foot, the Harness command centre).
- **0365 surface thinning.** `data-fire-lit` on the window and the rule `.krypton-window[data-fire-lit] .acp-harness__command-center { background: none }` (`harness-shared.css:1244-1250`) existed only because that fire burned under the command centre. With no window fire it has no job, and keeping it would mean a window-wide style change driven by a workspace signal.
- **Cost.** There is one context instead of one per burning window, so WebKit's 16-context limit (0362 Research) can no longer be reached. On a 1728 px wide screen the band holds about 456k px per frame, close to two burning 900 px windows today. An unlit workspace costs nothing, as before.
- **Alternatives ruled out:**
  - **The band above the windows** (under the footer, over the window bottoms): the flames would cover terminal text and the window foot. 0362 kept the fire behind text on purpose.
  - **Following only the focused window:** the footer's program-status counts (`programStatusCounts`, `:1438`) already aggregate every window. A workspace signal that changes when focus moves would tell the user nothing new.
  - **Keeping the window fire as an option** (`[fire] where = …`): the request is to move it, and two hosts would double the lifecycle code.

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| tmux | `monitor-activity` marks a background window; `window-status-activity-style` styles its entry in the one shared status line; `#{window_activity_flag}` exposes it | Per-window state shown on a workspace-level bar |
| Ghostty | `custom-shader` runs one GLSL pass over the whole terminal surface | One whole-surface effect, not tied to state |
| Rex | OSC 7501 states as spinners/symbols on unfocused tab headers | Same trigger, quiet presentation |

**Krypton delta:** like tmux, the per-window state rises to a workspace-level surface, so a busy window that is off focus, behind another window or in a hidden Stage slot still shows. Unlike tmux, the surface is the ambient fire along the footer, not a glyph. The look still follows the most urgent state.

## Affected Files

| File | Change |
|------|--------|
| `src/fire.ts` | `FireAnimation(host, onFailure)`: no window element. It measures the host minus a floor, uses radius 0, adds `setFloor(px)` and drops `data-fire-lit`. `FireController(host)` keeps `Map<WindowId, FireState>` and drives one lazy `FireAnimation`. `sync(windowId, state, trigger)`. New pure `workspaceFireState(states)`. Header comment |
| `src/fire.test.ts` | `workspaceFireState` priority and empty-map tests |
| `src/compositor.ts` | Construct `FireController(this.workspace)` in the constructor; `sync(win.id, …)`; rename `setKeyboardOverlayFooterVisible` → `setWorkspaceFooterVisible`, which also calls `fire.setFloor` |
| `src/main.ts` | The two calls to the renamed method (`:149-150`) |
| `src/styles/window.css` | `.krypton-fire-canvas` moves to the Workspace section; `bottom` is set inline |
| `src/styles/harness-shared.css` | Remove the `[data-fire-lit]` command-centre rule and its comment |
| `src/types.ts`, `src/acp/acp-harness-view.ts` | Comments only: the trigger sets the workspace, not the window, on fire |
| `docs/0006-configuration.md` | `[fire]` example comment and the `on` / `height` rows: workspace, not window |
| `docs/0362-…`, `0363-…`, `0365-…`, `0072-acp-harness-view.md`, `0284-program-status-osc7501.md` | "Moved to the workspace by 0391" notes; drop the `data-fire-lit` description from 0072 |
| `docs/README.md` | Index row 391 |

## Design

### Data Structures

```ts
// src/fire.ts
/** Highest-priority burn state among windows (programStatePriority); null when none burns. */
export function workspaceFireState(states: Iterable<FireState>): FireState | null;

export class FireController {
  constructor(host: HTMLElement);                    // #krypton-workspace
  configure(cfg: FireConfig | null | undefined): void;  // unchanged
  sync(windowId: WindowId, state: ProgramState | null, trigger: FireTrigger | null): void;
  remove(windowId: WindowId): void;                  // drop the entry, recompute
  resize(): void;                                    // re-measure the band
  setFloor(px: number): void;                        // footer shown → 28, hidden → 0
}
// private: burning = new Map<WindowId, FireState>(); fire: FireAnimation | null; floor = 28
```

### Data Flow

```
1. A pane writes OSC 7501 (or a Harness lane reports tool_error) → paintProgramStatus(win)
2. fire.sync(win.id, winTop?.state ?? null, trigger)
   look = fireLookState(state, trigger, on)          (0365, unchanged)
   look ? burning.set(win.id, look) : burning.delete(win.id)
3. top = workspaceFireState(burning.values())
   top === null → fire?.stop()                        (heat falls, loop ends, canvas hides)
   otherwise   → first time: new FireAnimation(host), canvas = host's first child;
                 fire.setLook(looks[top]); fire.start()   (eases between looks, 0363)
4. Window closes → fire.remove(win.id) → step 3 for the remaining windows
5. Footer toggled → setWorkspaceFooterVisible(v) → fire.setFloor(v ? 28 : 0)
   → canvas.style.bottom and resize()
6. Relayout / viewport resize → fitAll → fire.resize()
```

`FireAnimation.resize()` measures `host.clientWidth` × `(host.clientHeight − floor)` and passes it to the existing `fireBand`. `radius = 0`, read once.

### UI Changes

```css
/* window.css, Workspace section */
.krypton-fire-canvas {
  position: absolute; left: 0; right: 0; bottom: 28px; /* inline: floor; height from fireBand */
  z-index: 0; pointer-events: none; display: none;
  transform: translateZ(0);
}
```

No window gets a canvas, and nothing on a window changes while the workspace burns. Keybindings: none. The fire follows state (`DESIGN.md` Motion: `[fire]` is a config effect).

### Configuration

No new keys. `[fire] on`, `[fire]` looks and `[fire.<state>]` tables keep their syntax and hot-reload. Two meanings change:

- `on`: a state in the list sets the **workspace** on fire while any window shows it.
- `height`: it now scales the workspace's built-in flame, which is 120 px on any screen taller than about 545 px.

## Edge Cases

- **Several windows in different burning states:** one fire, with the look of the most urgent state (`blocked` > `error` > `done` > `working`). When that window calms down, the fire eases to the next look (0363 ease).
- **Inside one window:** the 0362 rule is unchanged. With `on = ["working"]`, a `blocked` pane in that window still stops that window from counting.
- **Stage-hidden windows, background tabs, unfocused windows:** they count, as they do in the footer program-status counts.
- **Last burning window closes:** `remove` drops it and the fire puts out over about 2 s.
- **Grid layout:** the bottom-row windows end 6 px above the footer, so the flames show through their screens at `[visual] opacity` and are hidden behind their foot plates. With `opacity = 1` they show only in gaps and empty workspace. This is accepted, because the fire never covers text.
- **Harness window at the bottom:** its command centre stays opaque. The 0365 thinning is removed.
- **Footer hidden at startup:** `main.ts:149` already pushes the initial visibility, so the floor is right before the first ignite.
- **WebGL2 unavailable, shader failure, context loss, reduced motion:** unchanged from 0362. A failure disables fire for the session, with one warning.
- **Overlays** (dashboard, palette, Quick Terminal) draw above the fire.

## Open Questions

None.

## Implementation Notes

Deviations from the approved design:

- **`FireController(host, floor)`** takes the starting floor (`Compositor.FOOTER_HEIGHT`) instead of hard-coding 28, so the 28 lives in one place. `main.ts` then pushes the real footer visibility through `setWorkspaceFooterVisible` before the first ignite.
- **Comment-only edits** also touched `src/acp/harness-tool-error-fire.test.ts` (header line), which the Affected Files table did not list.

**Verified:**

- `npm run check` passes.
- `npx vitest run`: 309 files and 3772 tests pass, including 3 new `workspaceFireState` tests in `fire.test.ts` (20 in the file).
- Smoke in the user's Chromium through the `browse` MCP, on a throwaway Vite page (deleted afterwards) with the real `FireController`, `index.css`, two mock `.krypton-window`s and a footer, 1200×700, `on = ["working", "blocked"]` and a violet `[fire.blocked]` with `height = 1.4`:
  - window 1 `working`: one `.krypton-fire-canvas`, the workspace's first child, 1200×264 at `bottom: 28px` (band top at y 408, bottom on the footer seam at 672). Neither window gets a canvas or `data-fire-lit`. The flames run to both screen edges, show through the window screens behind the text and are hidden by the foot plates, and the bottom prompt lines stay readable;
  - window 2 `blocked` as well: the workspace eases to the violet look and the band grows to 370 px;
  - `remove(2)`: back to the orange `working` look, and the band shrinks to 264 px;
  - `setFloor(0)`: `bottom: 0px`, band top at y 436;
  - window 1 `done` (not in `on`): the canvas hides (`display: none`);
  - viewport 900×500 then `resize()`: 900×229, which is `ceil(0.22·472·2.2)`.

**Not yet verified:**

- The native WKWebView app. The running Krypton hosts this session, so it was not rebuilt or reinstalled.
- WebKit compositing of the band under translucent windows. The smoke ran in Chromium.
- The rAF count after put-out. The browser driver evaluates in an isolated world, so the page's `requestAnimationFrame` could not be wrapped. The loop-stop path is the unchanged 0362 code.

## Out of Scope

- Keeping a per-window fire or a `[fire] where` switch.
- Raising the fire above windows, or thinning any window or Harness surface while it burns.
- New triggers, new look keys, or more embers for the wider band (the 24-ember table stays).
- Fire on any edge other than the bottom.

## Resources

- [tmux(1) manual](https://man.netbsd.org/tmux.1): `monitor-activity`, `window-status-activity-style`, `window_activity_flag`, a per-window flag shown on the shared status line.
- [The Tao of tmux — Status bar](https://leanpub.com/read/the-tao-of-tmux/status-bar): how the activity style marks a window in the status bar.
- [Ghostty `custom-shader`](https://ghostty.org/docs/config/reference#custom-shader): a whole-surface shader effect (consulted for 0362/0363).
- [0362](./0362-program-status-fire.md), [0363](./0363-program-status-fire-look.md), [0365](./0365-harness-tool-error-fire.md): the shader, lifecycle, looks and trigger this spec moves.
