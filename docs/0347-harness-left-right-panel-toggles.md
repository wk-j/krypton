# Harness Left / Right Panel Toggles — Implementation Spec

> Status: Implemented (rev 2, approved 2026-10-30)
> Date: 2026-10-30
> Milestone: M6 — ACP Harness
> Replaces the spec 251 master switch; amends spec 320's titlebar cluster.

## Problem

The Harness has one global visibility switch — bare `#panels` (spec 251) and the
titlebar `All panels` button (spec 320). It hides the Zen lane rail on the left,
the floating rail cards and the dock column on the right, all together. Neither
side panel has a control of its own.

## Solution

Remove the master switch: its state, storage key, root class, `all` button and
the bare `#panels` / `#panels hide|show|toggle` forms. Add two buttons that
each do one thing:

- **`left`** shows or hides the left panel: the Zen lane-navigation rail.
- **`right`** shows or hides the right panel: the dock column (Ticket / Rails tabs).

Neither button changes any other panel, flag or button. The five per-panel
toggles for the floating rail cards (plan, peek, thought, grammar, queue) are
unchanged and are the only controls for those cards.

## Research

- **Master switch today.** `panelsHidden` (`acp-harness-view.ts:1428`),
  persisted as `krypton:acp-harness:panels-hidden:<dir>` (`:16688-16706`),
  applied as `acp-harness--panels-hidden` (`:12595`). Every panel asks
  `isPanelHidden(id) = panelsHidden || hiddenPanels.has(id)` (`:15940`). While
  it is on, all seven per-panel buttons are disabled
  (`harness-panel-visibility.ts:104`).
- **Left panel** is `.acp-harness__rail` (`LaneRail`). `ensureDashboardStructure`
  (`:13288`) creates it only in Zen Mode. Only CSS hides it:
  `harness-shared.css:1421-1430` hides the rail and makes the Zen grid one
  column. The spec 325 corner rules (`:1385`, `:1400`) are scoped
  `:not(.acp-harness--panels-hidden)`.
- **Right panel** is `.acp-harness__dock` (`harness-dock.ts`), a 352px split
  pane that reserves dashboard width through `acp-harness--dock-active`. It shows
  while a tab is AVAILABLE. The ticket and rails controllers report availability
  as `content && !isPanelHidden(tab)` (`harness-ticket-controller.ts:694`,
  `harness-rails-controller.ts:331`). When no tab is available, the column hides
  and the width comes back. So the right flag only has to make both dock tabs
  read as hidden. The dock needs no new API and no CSS.
- **The floating rail cards** (`.acp-harness__lane-rail`, a 320px overlay with
  `pointer-events: none`) reserve no width and are not a side panel. Each card
  already empties or unmounts its own slot (spec 320).
- **Rejected (rev 1): `right` hides cards + dock and disables the seven panel
  buttons.** That gave one button several jobs. The user asked that left does
  left, right does right, and nothing else.

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| VS Code | Title-bar layout controls: Toggle Primary Side Bar (`⌘B`), Toggle Panel (`⌘J`), Toggle Secondary Side Bar (`⌥⌘B`). Each button toggles one region. | No "hide all" button; Zen Mode is a separate command. |
| Zed | `workspace::ToggleLeftDock` (`cmd-b`), `ToggleRightDock` (`cmd-r`, `cmd-alt-b`), `ToggleBottomDock` (`cmd-j`). | One action per dock. |

**Krypton delta** — matches both: one button per side region, persisted, left
before right. The keyboard path is `#panels left|right` in the composer, not a
new global chord (spec 320 rule). The left panel exists only in Zen Mode.

## Affected Files

| File | Change |
|------|--------|
| `src/acp/harness-panel-visibility.ts` | `HarnessSide`; `PanelsCommand` `all` → `side`; parser; usage; `panelFlash` suffix; `harnessTitlebarToggles(hidden, sides)`; `readSideHidden` / `writeSideHidden`; drop `ALL_PANELS_TOGGLE_ID` and the disabled reason. |
| `src/acp/acp-harness-view.ts` | `panelsHidden` → `leftPanelHidden` + `rightPanelHidden`; `setSideHidden`; `isPanelHidden`; `applyPanelsCommand`; `activateTitlebarToggle`; `showRailsDock` chip; root class; delete `readPanelsHiddenPreference` / `writePanelsHiddenPreference`. |
| `src/acp/harness-view-host.ts`, `src/acp/harness-layout.ts`, `src/acp/harness-dock.ts`, `components/ticket-dock/index.ts` | Comments: the master switch → the right panel flag. |
| `src/acp/harness-icons.ts` | `panel-all` → `panel-right` (same drawing: frame + right column); new `panel-left` (its mirror). |
| `src/styles/harness-shared.css` | `--panels-hidden` → `--left-panel-hidden` (rail + Zen grid + spec 325 scopes); delete the lane-rail rule. |
| `src/styles/window.css` | Narrow-tile rule keeps `left`, `right`, `backend-update`. |
| `src/acp/hash-commands.ts`, `components/help-overlay/index.ts` | `#panels` args and description. |
| Tests | `harness-panel-visibility.test.ts`, `#panels` cases in `acp-harness-view.test.ts`, fixture ids in `titlebar-toggles.test.ts`. |
| Docs | `0072`, `0004` §20 and §25, `0005` titlebar flow, `0251` / `0320` status notes, `0301` / `0306` / `0322` / `0325` / `0331` / `0337` mentions of `#panels hide` and `all`, `README.md` index. |

## Design

### Data Structures

```ts
// src/acp/harness-panel-visibility.ts
export type HarnessSide = 'left' | 'right';
export type PanelsCommand =
  | { kind: 'side'; side: HarnessSide; action: PanelsAction }
  | { kind: 'panel'; panel: HarnessPanelId; action: PanelsAction }
  | { kind: 'usage' };
export function readSideHidden(projectDir: string | null, side: HarnessSide): boolean;
export function writeSideHidden(projectDir: string | null, side: HarnessSide, hidden: boolean): void;
export function harnessTitlebarToggles(
  hidden: ReadonlySet<HarnessPanelId>,
  sides: { readonly left: boolean; readonly right: boolean },
): TitlebarToggle[];
```

Storage: `krypton:acp-harness:left-panel-hidden:<dir>` and
`…:right-panel-hidden:<dir>`. The value is `'1'`, or the key is removed —
the spec 251 pattern. Storage failures read as "shown". The old
`panels-hidden` key is no longer read and gets no migration: a project that had
it set shows its panels after the upgrade.

### State

```ts
private leftPanelHidden: boolean;   // the Zen lane rail
private rightPanelHidden: boolean;  // the dock column
isPanelHidden(id) {
  return this.hiddenPanels.has(id) || (this.rightPanelHidden && (id === 'ticket' || id === 'rails'));
}
```

`setSideHidden(side, hidden)` persists, notifies titlebar listeners and calls
`render()`. It writes only its own flag. A per-panel change writes only its own
flag. No button is ever disabled by another button's state.

### Command

| Input | Effect |
|-------|--------|
| `#panels left` / `#panels right` | Toggle that side |
| `#panels hide\|show\|toggle left\|right` | Set that side |
| `#panels <panel>`, `#panels <action> <panel>` | Unchanged (spec 320) |
| `#panels`, `#panels hide\|show\|toggle` | Usage — the master switch is gone |

`usage: #panels [hide | show | toggle] <left | right | plan | peek | thought | grammar | queue | ticket | rails>`

Chips: `left panel hidden · #panels show left` / `left panel shown`, and the
same for `right`. The `ticket` and `rails` chips append ` · right panel hidden`
while the right panel is hidden (was ` · all panels hidden`); the other five
panels no longer get a suffix. Bare `#rails` while the right panel is hidden
flashes `right panel hidden · #panels show right`.

### Titlebar

Order: `plan peek thought grammar queue ticket rails` · divider · `left right`,
then the spec 322 `backend-update` action when present.

| Button | Icon | Label | Pressed | Disabled |
|--------|------|-------|---------|----------|
| `left` | `krypton-icon-panel-left` | `Left panel` | `!leftPanelHidden` | never |
| `right` | `krypton-icon-panel-right` | `Right panel` | `!rightPanelHidden` | never |
| seven panels | unchanged | unchanged | `!hiddenPanels.has(id)` | never (the spec 320 reason is deleted) |

`activateTitlebarToggle('left' | 'right')` runs
`applyPanelsCommand({ kind: 'side', side, action: 'toggle' })`. Below 480px the
cluster keeps `left`, `right` and `backend-update`.

### CSS

- `this.element.classList.toggle('acp-harness--left-panel-hidden', this.leftPanelHidden)`
  replaces `--panels-hidden`. Rules: `.acp-harness--left-panel-hidden
  .acp-harness__rail { display: none }` and the one-column Zen grid. The spec
  325 corner rules become `:not(.acp-harness--left-panel-hidden)`.
- Delete `.acp-harness--panels-hidden .acp-harness__lane-rail`: no switch hides
  the floating cards as a group any more.
- The right panel needs no CSS. It follows the existing dock availability path.

### Data Flow

```
1. User clicks `right` in the window titlebar.
2. mousedown preventDefault keeps focus in the composer (spec 320).
3. activateTitlebarToggle('right') → applyPanelsCommand({ kind: 'side', side: 'right', action: 'toggle' }).
4. setSideHidden('right', true): write the key, notify listeners, render(), flash.
5. The ticket and rails controllers report their tabs unavailable, so the dock
   column hides, `--dock-active` drops and the dashboard takes the width back.
   The floating rail cards are untouched.
6. The titlebar re-syncs: `right` aria-pressed="false"; no other button changes.
```

For `left`, steps 4–6: write the key, the root class hides the rail, the active
body fills the Zen grid, and `left` re-syncs.

## Edge Cases

- **Zen off:** there is no left panel. `left` still toggles and stores its flag,
  which takes effect on entering Zen.
- **No dock content** (no active ticket, no `.krypton/rails.toml`): there is
  nothing to show on the right. `right` still toggles and stores its flag.
- **Left hidden in Zen:** `Tab` / `Shift+Tab` still switch lanes. Another lane
  that needs permission is still signalled by the footer lane strip (spec 251).
- **Right hidden, then a ticket activates:** its state updates and the column
  stays hidden until `right` is shown.
- **`ticket` / `rails` toggled while the right panel is hidden:** the flag is
  stored, nothing appears, and the chip says ` · right panel hidden`. The
  buttons stay enabled.
- **`#ticket panel`, dock `›`, Escape:** these set the `ticket` flag as today
  (spec 331). They stay separate from `right`.
- **Hiding every floating card now takes the five per-panel toggles.** No
  single control does it any more.
- **Below 960px:** the dock overlay rules are unchanged.
- **Two views on one project:** the last write wins in storage, as today.
- **Remote Harness:** local presentation state, so it works unchanged.

## Open Questions

None.

## Out of Scope

- New global or leader chords (`Cmd+B`-style) or palette entries.
- A left panel outside Zen Mode; changing Zen or Concise semantics.
- Any control that hides several regions at once.
- Changing the dock's own `›` / Escape hide (spec 331) or the ticket/rails tabs.
- Migrating the old `panels-hidden` key.

## Verification

- `npm run check` clean; full `vitest` suite passes (271 files, 3285 tests).
- Real `AcpHarnessView` under happy-dom (throwaway script, Zen mode, an active
  ticket): clicking `right` hid the dock column, dropped `--dock-active` and
  stored `right-panel-hidden`; every other toggle stayed enabled and pressed.
  Toggling `ticket` then only changed its own flag, with the chip
  `ticket hidden · #panels show ticket · right panel hidden`. Clicking `left`
  added `--left-panel-hidden`. Bare `#panels` and `#panels hide` flashed usage;
  `#panels show right` / `#panels toggle left` restored both. A new view on the
  same project read the stored flags back.
- Chromium against the real stylesheets (throwaway page on the Vite dev
  server): with `--left-panel-hidden` the Zen rail computed `display: none` and
  the dashboard grid went from `180px 720px` to one `900px` column. A 900px
  titlebar showed all nine toggles, and a 400px one showed only `left` and
  `right`. Both icons resolve to their `<symbol>` with non-empty geometry.
- Not exercised: WKWebView and the in-app path. The installed app picks up the
  change only after a rebuild / `make install`.

## Resources

- [VS Code — Custom Layout](https://code.visualstudio.com/docs/configure/custom-layout) — one title-bar toggle per side region.
- Zed `assets/keymaps/default-macos.json:733-736` (local checkout) — `ToggleLeftDock` / `ToggleRightDock` bindings.
- `docs/0251-…`, `docs/0320-…`, `docs/0325-…`, `docs/0331-…`, `docs/0337-…` — the Krypton contracts this spec amends.
