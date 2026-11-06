# Harness Tool-Error Fire — Implementation Spec

> Status: Implemented
> Date: 2026-11-06
> Milestone: Window chrome — program status presentation (extends [0362](./0362-program-status-fire.md), [0363](./0363-program-status-fire-look.md))

## Problem

Fire (specs 0362/0363) burns only on OSC 7501 program status, so an ACP Harness window never burns: harness lanes report no OSC 7501. When an agent's tool call fails in a lane, the only sign is a red tool card inside the transcript, easy to miss when the lane is not on screen or the user looks elsewhere.

## Solution

Add one fire trigger, `tool_error`, listed in the existing `[fire] on`. When a top-level tool call in any Harness lane ends `failed`, that lane is marked; while any lane of a Harness is marked, its window burns with the `[fire.error]` look. A mark clears when the user presses a key in that Harness while the marked lane is active (the same "typing acknowledges" rule terminals use for `error`), or when the lane closes or restarts. The Harness reports through a new optional `ContentView` hook, and `paintProgramStatus` stays the only place that calls `fire.sync`, so the fire still has one driver. While a window's fire is lit, the Harness command centre takes the lane body's translucent surface instead of its solid one, so the flames under it show (see Implementation Notes).

## Research

- **Failure edge.** `renderTool` (`acp-harness-view.ts:14897`) computes `justEnded = isTerminalToolStatus(status) && target.toolEndedAt === undefined` (`:14917`). `justEnded && status === 'failed'` fires once per top-level tool call. `ToolStatus` is `pending | in_progress | completed | failed` (`acp/types.ts:53`); `canceled` is terminal but not a failure. `!` shell rows (`runShellCommand`, `:12522`) and subagent child updates (`absorbSubagentChild`, `:8299`) do not pass through this edge. No sound, attention or chrome signal exists for a failed tool today, and a failed tool does not set the lane to `error`.
- **Fire input.** `FireController.sync(win, state)` (`fire.ts:689`) is last-writer-wins per window and is called only from `paintProgramStatus` (`compositor.ts:1478`), which walks every tab and pane of the window. A second caller would let a terminal's `sync(win, null)` put out a Harness fire, so the Harness signal must enter that walk.
- **Reaching the window.** Both content mount paths (`mountContentPane`, `compositor.ts:6283`; content windows, `:3289`) set `contentView.onOutputPump` with a captured `winId`, which goes stale after `moveTabToWindow` (`:6448`). `findPaneInfoByViewId(viewId)` (`:1290`) resolves the current window at call time, and `rebuildTabBar` already repaints both windows on a move (`:1711`).
- **Chrome hooks.** `getTitlebarStatus` / `onTitlebarStatusChange` (`types.ts:306-308`) follow only the focused view (`compositor.ts:1925-1940`); fire needs every pane in every tab, so the new hook is a plain callback property set at mount, like `onOutputPump`.
- **Visibility.** The fire canvas sits at `z-index: 0` under the panes (`window.css:970-981`). `.acp-harness` is transparent (`harness-shared.css:44`) but the lane body paints `--acp-lane-canvas` = `rgba(6, 10, 18, 0.48–0.55)` (`:91`, `:334`), so in the dark scheme the flames show at roughly half strength; light-scheme surfaces are near opaque (`lane-rail.css:18`). The smoke check found the command centre (`rgba(8, 12, 22, 0.96)`) and the composer gradient (`agent-surface-solid`) cover the bottom band where the fire burns; see Implementation Notes.
- **Alternatives ruled out.** Writing the failure into `ProgramStatusStore` under the pane's `viewId`: it would also drive the title chip, footer counts and `Leader !`, and a routine failed `grep` would turn the window "error". A direct `FireController.signal(winId, …)` with timers: a second driver beside `paintProgramStatus`, plus the stale-`winId` defect.

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| Zed agent panel | A failed, rejected or canceled tool call changes only its own card (`thread_view.rs:8831`) | No window-level signal |
| Warp | A block that exits non-zero gets a red background and red sidebar | Persistent, per block |
| VS Code | `accessibility.signals.terminalCommandFailed` / `taskFailed` play a sound and/or announcement | Event signal, no lingering state |

**Krypton delta:** the failure lights the whole window, so it is seen even when the lane is collapsed, the tab is in the background, or the window is not focused. It lingers until the user acknowledges it in that lane, matching how a terminal `error` burns until typed into.

## Affected Files

| File | Change |
|------|--------|
| `src/types.ts` | `ContentView.getFireTrigger?()` and `onFireTriggerChange?` |
| `src/fire.ts` | `FireTrigger`, `on` accepts `tool_error`, pure `fireLookState()`, `sync(win, state, trigger)` |
| `src/fire.test.ts` | Precedence tests for `fireLookState` |
| `src/compositor.ts` | Set `onFireTriggerChange` at both content mounts; `paintProgramStatus` collects the content triggers |
| `src/acp/acp-harness-view.ts` | `toolErrorLanes`, mark on the failed edge, acknowledge in `onKeyDown`, clear on lane close/restart/dispose |
| `src/acp/harness-tool-error-fire.test.ts` (new) | Mark and acknowledge behaviour on a real `AcpHarnessView` |
| `src/fire.ts` (`FireAnimation`) | Sets `data-fire-lit` on the window element while the canvas shows, removes it when the fire is out or disposed |
| `src/styles/harness-shared.css`, `src/acp/components/composer/composer.css` | Under `.krypton-window[data-fire-lit]`: command centre takes `--acp-lane-canvas`, composer keeps only its accent tint |
| `docs/0006-configuration.md`, `docs/0362-program-status-fire.md`, `docs/0072-acp-harness-view.md`, `docs/README.md` | Document the trigger. `0004-architecture.md` and `0005-data-flow.md` carry no fire section (0362 added none), so they are unchanged |

## Design

### Data Structures

```ts
// src/fire.ts
export type FireTrigger = 'tool_error';
/** Look for the window: the highest-priority burning program state, with
 *  `tool_error` ranked as `error`; null when nothing listed in `on` applies. */
export function fireLookState(
  state: ProgramState | null,
  trigger: FireTrigger | null,
  on: ReadonlySet<FireState | FireTrigger>,
): FireState | null;
// FireController
sync(win: KryptonWindow, state: ProgramState | null, trigger: FireTrigger | null): void;

// src/types.ts — ContentView
getFireTrigger?(): FireTrigger | null;
/** Set by the compositor at mount; the view calls it when getFireTrigger() may have changed. */
onFireTriggerChange?: (() => void) | null;

// AcpHarnessView
private readonly toolErrorLanes = new Set<string>(); // lanes with an unacknowledged failed tool call
```

### Data Flow

```
1. A lane's tool_call_update ends `failed` → renderTool sees justEnded && status === 'failed'.
2. The Harness adds lane.id to toolErrorLanes; if it was new, it calls onFireTriggerChange().
3. The compositor callback resolves the pane's window with findPaneInfoByViewId(viewId)
   and calls paintProgramStatus(win).
4. paintProgramStatus walks tabs/panes as today, also reading
   pane.contentView?.getFireTrigger?.(), then calls fire.sync(win, winTop?.state ?? null, trigger).
5. fireLookState picks the look; with `on` containing "tool_error" the window burns with
   [fire.error] (a listed blocked state still wins, by program-status priority).
6. The user presses a key in that Harness while the marked lane is active → onKeyDown
   removes the lane before any other handling (never consumes the key) → callback → step 3
   → the fire puts out when no lane is marked and no program state burns.
7. closeLane, #new / restart and dispose remove the lane's mark the same way.
```

### Configuration

`[fire] on` accepts `"tool_error"` next to the program states, e.g. `on = ["working", "tool_error"]`. It uses the `[fire.error]` look (then `[fire]`, then built-in); there is no `[fire.tool_error]` table. Unknown values keep the existing warn-once. Rust keeps `on: Vec<String>` unvalidated, so no backend change. Hot-reload: `applyConfig` already repaints every window.

### UI Changes

`FireAnimation` marks the window element with `data-fire-lit` exactly while its canvas is shown (ignite, context restore) and removes it on put-out, context loss and dispose. Two rules key off it:

- `harness-shared.css` (`krypton.base`): `.krypton-window[data-fire-lit] .acp-harness__command-center` uses `--acp-lane-canvas` instead of `--agent-surface-solid`.
- `composer.css` (`krypton.component`): the default composer drops its solid gradient to the 5% accent tint over `transparent`; the `--permission` and `--command` variants already paint translucent backgrounds and are left alone.

The strip then reads like the lane body above it, and the flames show behind the input line as they do behind terminal text. Nothing changes while no fire burns.

## Edge Cases

- **Several failures, several lanes:** one fire per window; it stays lit until every marked lane is acknowledged.
- **Failure in a lane that is not active:** burns until the user switches to that lane and presses a key there, or closes/restarts it.
- **Failure while typing in that lane:** the next keystroke acknowledges it, so the fire may only flicker. Accepted: the user is already looking at the lane.
- **Rejected permission:** adapters that end a rejected tool as `failed` light the fire too. Accepted, not special-cased.
- **`canceled` tools, `!` shell rows, subagent children:** no fire; only the parent subagent card's own failed status counts.
- **Tab moved to another window:** the callback resolves the window at call time, and `rebuildTabBar` repaints both windows, so the fire moves with the tab.
- **`on` without `tool_error`:** marks are still kept (a set insert) but nothing burns.
- **WebGL2 unavailable:** fire stays disabled as in 0362, `data-fire-lit` is never set, and the composer keeps its solid surface.
- **Light scheme:** `--acp-lane-canvas` is near opaque there, so the flames stay mostly hidden. Accepted.

## Open Questions

None.

## Out of Scope

- Fire for Harness lane `busy` / `needs_permission` / lane `error` status, the Agent view, or the Quick Terminal.
- A separate look table for `tool_error`, a timed burst, sounds or notifications on tool failure.
- Raising the fire above Harness surfaces, or changing any Harness surface other than the command centre and composer while the fire is lit.

## Implementation Notes

- **Deviation from the approved design (UI Changes above).** The approved spec kept Harness backgrounds unchanged and named visibility as the first smoke check. That check, a throwaway Vite page with a real `AcpHarnessView` and `FireController` in a mock window (Chromium headless, WebGL2), showed the flames all but invisible with the user's `[fire] height = 0.5`: the band burns along the window content bottom, which is exactly the command centre (0.96 opaque) and the composer gradient (`agent-surface-solid`). The canvas and its WebGL output were fine (a run with the Harness hidden showed full flames). Thinning those two surfaces only while `data-fire-lit` is set fixes it without moving the fire or touching the terminal path.

## Results (2026-11-06)

- `npm run check` passes; `npx vitest run` passes 287 files / 3445 tests, including `src/acp/harness-tool-error-fire.test.ts` (failed vs completed/canceled marking; a key on another lane keeps the mark, a key on the marked lane clears it; several lanes stay lit until each is acknowledged) and the `fireLookState` precedence tests in `src/fire.test.ts`.
- Smoke (throwaway page, deleted afterwards), `on = ["working", "tool_error"]`, the user's `[fire]`/`[fire.error]` look:
  - a failed `execute` tool card gives `getFireTrigger() = 'tool_error'`, a `.krypton-fire-canvas` 1098×132 at the content bottom, and `data-fire-lit` on the window;
  - before the CSS change the flames were hidden behind the composer; after it, red flames show behind `HANDOFFS` / the input line with the text legible, and with `height = 1` the tips rise into the transcript area;
  - `trigger = null` leaves no canvas, no `data-fire-lit`, and the command centre back at `rgba(8, 12, 22, 0.96)`.
- **Not verified:** the native WKWebView app. The cached Playwright WebKit (2311) does not match the available `playwright-core` (1.64.1 expects 2370) and hung, so the smoke ran in Chromium; WebKit compositing of the same CSS is **[INFERENCE]**. The running Krypton hosts this session and was not rebuilt.

## Resources

- [Warp — Terminal Block Basics](https://docs.warp.dev/terminal/blocks/block-basics.md): failed blocks get a red background and sidebar.
- [VS Code — accessibility.signals.terminalCommandFailed](https://vsconfig.netlify.app/settings/accessibility/signals/terminalcommandfailed): failure as a sound/announcement signal.
- `/Users/wk/Source/zed/crates/agent_ui/src/conversation_view/thread_view.rs:8831`: Zed styles failed/rejected/canceled tool cards only.
