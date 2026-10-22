# Harness Titlebar Panel Toggles — Implementation Spec

> Status: Implemented
> Date: 2026-10-21
> Milestone: M6 — ACP Harness

## Problem

The ACP Harness shows its plan, lane peek, live thought, grammar review, prompt
queue and Active Ticket dock automatically whenever they have content. The only
way to hide them is `#panels`, which hides all of them at once (spec 251), and
spec 251 explicitly left per-panel visibility out of scope. A user who wants
the grammar panel gone but the plan kept has no control, and nothing on screen
shows which panels are on.

## Solution

Add a row of icon toggle buttons to the titlebar of the window hosting a
Harness, one per persistent panel plus one "all panels" toggle, like VS Code's
title-bar layout controls. Each panel gets an independent, per-project,
persisted hidden flag; `#panels` keeps its meaning as the master switch and
gains an optional panel argument as the keyboard path. The titlebar is
compositor-owned chrome, so the view contributes the buttons through a new
optional `ContentView` hook, modelled on the spec 218 lane strip.

## Research

- **No Harness-owned header exists.** The Harness mounts as a tab in an
  ordinary window (`compositor.ts` `mountAcpHarnessView` → `createContentTab`);
  the visible bar is the generic `.krypton-window__titlebar` (label group, tab
  bar, `.krypton-window__titlebar-end` with program status, PTY status, spec 226
  session mark). It has no buttons, no click handlers and no drag region.
- **`ContentView` has no titlebar hook.** The closest precedent is spec 218:
  `getLaneMarks?()` + `onLaneMarksChange?()`, re-synced by `syncWindowFooter`
  on tab switch, window creation and pane focus, with per-window unsubscribe
  and a render key that skips no-op rebuilds.
- **The lane head was rejected as the host.** It is per lane, its 6-column grid
  is already full of chips, and column 6 holds Start Review. The window
  titlebar is per window, which matches view-level panel state.
- **Panels have no shared visibility registry.** Each renderer derives
  visibility from content: plan (`lane.plan`), peek (`bestLanePeekCandidate`),
  thought (`resolveLaneThoughtSnapshot`, 2 s hide timer, teletype RAF),
  grammar (`assistCtl.panelState`), queue (`lane.queuedPrompts`), ticket
  (`activeTicket`). Every one already short-circuits on `panelsHidden`, which
  is the seam this spec widens.
- **The right rail is an absolutely positioned 320px overlay**
  (`harness-shared.css` `.acp-harness__lane-rail`), so hiding single panels
  inside it reflows nothing. The ticket dock is the exception: the
  `acp-harness--ticket-active|collapsed|expanded` root classes reserve
  352px/46px of dashboard margin.
- **Icons:** `src/acp/harness-icons.ts` holds 16×16 `currentColor` `<symbol>`s,
  injected once at document level by `ensureHarnessSymbolDefs()` precisely so
  window chrome outside the view can `<use>` them (spec 218 footer strip).
- **Hidden grammar is still actionable today.** `Cmd+G` (accept correction) and
  `Cmd+0` (dismiss panel) act on the grammar state even when `#panels` has
  unmounted it, rewriting the draft from content the user cannot see.
- **Focus:** the Harness root is `tabIndex = 0`. A clicked `<button>` would take
  DOM focus away from the composer, so the buttons must not be focusable.

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| VS Code | Title-bar layout controls toggle Primary Side Bar, Panel and Secondary Side Bar; a **Customize Layout** button opens a dropdown. Each has a command (e.g. `workbench.action.toggleAuxiliaryBar`); state persists across sessions. | Direct model for the requested UI: icon-only, pressed reflects visibility, keyboard command behind every button. |
| Zed | Status-bar icon buttons per panel (project, outline, git, agent, …); each button can be removed with `"<panel>": { "button": false }`; panels toggle by action, e.g. `project panel: toggle focus` (`cmd-shift-e`). | Per-panel buttons with a keyboard action each; bottom bar instead of titlebar. |

**Krypton delta** — matches VS Code: icon-only buttons in the titlebar, pressed =
visible, a keyboard command behind each, persisted state. Diverges: buttons
belong to the *window* hosting the Harness and follow its focused pane (spec 218
rule), the keyboard path is the existing `#panels` composer command rather than
new global chords, and there is no customize dropdown or per-button removal.

## Affected Files

| File | Change |
|------|--------|
| `src/types.ts` | `TitlebarToggle`; `ContentView.getTitlebarToggles?`, `onTitlebarTogglesChange?`, `activateTitlebarToggle?`. |
| `src/titlebar-toggles.ts` (new) | Pure DOM builder/patcher for the toggle cluster. |
| `src/compositor.ts` | `syncWindowTitlebarToggles`; rename `syncWindowFooter` → `syncWindowChrome` (4 call sites) and call it there; cleanup on window close. |
| `src/styles/window.css` | `.krypton-window__view-toggles` cluster, button, separator; titlebar becomes an inline-size container for the narrow-tile rule. |
| `src/styles/theme-scheme.css` | Light-scheme off-state colour for the toggles. |
| `src/acp/harness-panel-visibility.ts` (new) | `HarnessPanelId`, panel table, `#panels` argument parser, storage read/write. |
| `src/acp/acp-harness-view.ts` | `hiddenPanels` state, `isPanelHidden`, `setPanelHidden`, renderer gates, grammar key guard, `#panels` dispatch, the three `ContentView` methods. |
| `src/acp/harness-view-host.ts` | Replace `readonly panelsHidden` with `isPanelHidden(id)`. |
| `src/acp/harness-ticket-controller.ts` | Gate dock and `--ticket-*` root classes on `isPanelHidden('ticket')`. |
| `src/styles/harness-shared.css` | Delete the now-dead `--panels-hidden` + `--ticket-*` margin reset. |
| `src/acp/harness-icons.ts` | Seven panel symbols. |
| `src/acp/hash-commands.ts`, `components/help-overlay` | `#panels` args/description. |
| `src/acp/harness-layout.ts`, `components/ticket-dock/index.ts` | Comments that describe `#panels` / `panelsHidden`. |
| Tests | `harness-panel-visibility.test.ts`, `titlebar-toggles.test.ts` (new); `#panels` and ticket cases in `acp-harness-view.test.ts`; `hash-commands.test.ts` roster. |
| Docs | `0072-acp-harness-view.md`, `0251-…` (pointer to this spec), `0004-architecture.md` (`ContentView` hook), `README.md` index. |

## Design

### Data Structures

```ts
// src/types.ts
export interface TitlebarToggle {
  readonly id: string;
  /** Full <symbol> id resolvable at document level, e.g. 'krypton-icon-panel-plan'. */
  readonly icon: string;
  /** Tooltip and accessible name. */
  readonly label: string;
  /** Absent → one-shot action button, no aria-pressed (spec 322). */
  readonly pressed?: boolean;
  /** Warning colour (spec 322 backend-update button). */
  readonly attention?: boolean;
  /** Present → button is disabled; the reason replaces the tooltip. */
  readonly disabledReason?: string;
  /** Draw a 1px divider before this button. */
  readonly separatorBefore?: boolean;
}

// src/acp/harness-panel-visibility.ts
export type HarnessPanelId = 'plan' | 'peek' | 'thought' | 'grammar' | 'queue' | 'ticket';
export const HARNESS_TOGGLE_PANELS: readonly { id: HarnessPanelId; label: string; icon: string }[];
export type PanelsCommand =
  | { kind: 'all'; action: 'hide' | 'show' | 'toggle' }
  | { kind: 'panel'; panel: HarnessPanelId; action: 'hide' | 'show' | 'toggle' }
  | { kind: 'usage' };
export function parsePanelsCommand(args: readonly string[]): PanelsCommand;
export function readHiddenPanels(projectDir: string | null): ReadonlySet<HarnessPanelId>;
export function writeHiddenPanels(projectDir: string | null, hidden: ReadonlySet<HarnessPanelId>): void;
```

Storage key `krypton:acp-harness:hidden-panels:<projectDir>`, value a JSON
array of ids; empty set removes the key. Unknown ids and corrupt JSON read as
"not hidden"; storage failures never block startup (spec 251 pattern).

### State and precedence

```ts
private hiddenPanels: ReadonlySet<HarnessPanelId>;           // read in the constructor
isPanelHidden(id: HarnessPanelId): boolean {                  // also on HarnessViewHost
  return this.panelsHidden || this.hiddenPanels.has(id);
}
```

`panelsHidden` (spec 251) stays the master switch and is never rewritten by a
per-panel change, nor the reverse. Both setters persist, call `render()`, and
notify titlebar listeners.

### Renderer gates

Every existing `this.panelsHidden` check becomes `isPanelHidden(<id>)`. Because
the rail stays visible when only one panel is off, a hidden panel must leave the
rail itself rather than rely on the root-class CSS:

| Panel | Hidden → |
|-------|----------|
| plan | `planSlot.hidden = true` |
| queue | `queueSlot.hidden = true` |
| peek | unmount, `peekCard = null`, `peekLaneId = null` (same as no candidate); `syncPeekToolRow` returns |
| thought | stop teletype RAF, cancel hide timer, unmount; `patchPeekThoughtIfLane` returns |
| grammar | unmount (existing path) |
| ticket | `ticketDockEl.hidden = true`; `--ticket-active/collapsed/expanded` toggled on `ticket !== null && !hidden`, so the dashboard margin returns with no extra CSS |

Panel *state* (plan entries/collapse, peek selection and lock, grammar result,
queued prompts, ticket expansion) is never touched. Showing re-renders from
live state. The same gates run under `#panels hide`, so peek and thought now
unmount there too instead of keeping stale DOM behind `display: none`; spec
251's guarantee — state retained, restored exactly on show — is unchanged.

`Cmd+G` and the grammar half of `Cmd+0` run only when
`!isPanelHidden('grammar')`; otherwise the key falls through. This also covers
`#panels hide`, which today lets both keys act on a grammar result the user
cannot see.

### API / Commands

```ts
// ContentView (src/types.ts)
getTitlebarToggles?(): readonly TitlebarToggle[];
onTitlebarTogglesChange?(cb: () => void): () => void;
activateTitlebarToggle?(id: string): void;
```

The Harness returns the six panels in table order (`pressed = !hiddenPanels.has(id)`,
`disabledReason = 'all panels hidden · #panels show'` while `panelsHidden`),
then `{ id: 'all', label: 'All panels', pressed: !panelsHidden, separatorBefore: true }`.
`activateTitlebarToggle` flips the matching flag and flashes the same chip as
the command.

No Tauri IPC, no config keys, no backend change.

### Data Flow

```
1. User clicks the grammar icon in the window titlebar.
2. Button mousedown: preventDefault — DOM focus stays in the composer; the
   window's own mousedown still focuses the window.
3. Cluster click handler resolves the active tab's focused pane view and calls
   view.activateTitlebarToggle('grammar').
4. Harness setPanelHidden('grammar', true): writeHiddenPanels, render(),
   notify listeners, flash 'grammar hidden · #panels show grammar'.
5. rightRail region: renderGrammarPanel sees isPanelHidden → unmounts.
6. Listener → compositor re-renders the cluster; aria-pressed="false".
```

`#panels hide grammar` enters at step 4.

### Keybindings

`#panels [hide | show | toggle] [plan | peek | thought | grammar | queue | ticket]`

| Input | Effect |
|-------|--------|
| `#panels`, `#panels hide/show/toggle` | All panels — unchanged from spec 251 |
| `#panels grammar` | Toggle grammar |
| `#panels hide grammar` / `show` / `toggle` | Set grammar |
| anything else | `usage: #panels [hide \| show \| toggle] [plan \| peek \| thought \| grammar \| queue \| ticket]` |

Flashes: `<panel> hidden · #panels show <panel>` / `<panel> shown`; while
`panelsHidden`, a per-panel change appends ` · all panels hidden`.

### UI Changes

```html
<div class="krypton-window__titlebar-end">
  <div class="krypton-window__view-toggles" role="toolbar" aria-label="Panels">
    <button type="button" tabindex="-1" class="krypton-window__view-toggle"
            data-toggle-id="plan" aria-pressed="true" aria-label="Plan panel" title="Plan panel">
      <svg class="krypton-window__view-toggle-icon" aria-hidden="true"><use href="#krypton-icon-panel-plan"/></svg>
    </button>
    … <span class="krypton-window__view-toggle-sep" aria-hidden="true"></span> …
  </div>
  …program-status, pty-status, label-tail (unchanged)
</div>
```

- Cluster is the first child of `-end`; removed when the focused view returns no
  toggles. Re-rendered only when the `id|pressed|disabled` key changes.
- Button 22×20px, icon 14px, no border, transparent background,
  `color: var(--krypton-titlebar-text)`; pressed → `var(--krypton-window-accent)`;
  hover → accent plus a 10% accent fill; disabled → opacity 0.35. Separator 1px ×
  14px, `rgba(var(--krypton-window-accent-rgb), 0.25)`. No brackets, no
  animation, no backdrop-filter.
  `.krypton-window__view-toggles[hidden] { display: none; }`.
- Light scheme: Krypton Light's slate titlebar text (`#3a5568`) is too close to
  its teal accent (`#006688`) for on/off to read, so `theme-scheme.css` mutes the
  off state: `html[data-theme-scheme='light'] .krypton-window__view-toggle[aria-pressed='false']
  { color: color-mix(in srgb, var(--krypton-titlebar-text) 40%, transparent); }`.
- Narrow tile: `.krypton-window__titlebar` gets `container-type: inline-size`;
  `@container (max-width: 480px)` hides every toggle except `all` (and, since
  spec 322, the `backend-update` action), plus the
  separator. Measured in the mockup: with all seven buttons a 380px titlebar
  squeezes the label to 0px; at 480px it keeps ~86px. No existing
  `@container` rule targets titlebar descendants, so the new container changes
  nothing else.
- New symbols (16×16, stroke `currentColor`): `panel-plan` (checklist),
  `panel-peek` (eye), `panel-thought` (speech bubble), `panel-grammar` (`A` +
  check), `panel-queue` (stacked bars), `panel-ticket` (notched ticket),
  `panel-all` (frame with right sidebar).

## Edge Cases

- **Focused pane is not a Harness** (terminal tab, split terminal pane): cluster
  removed; re-appears on refocus (same rule as the spec 218 lane strip).
- **Two Harness views on one project**: each keeps in-memory state; the last
  write wins in storage, as with Zen/Concise/`#panels`.
- **No active lane**: buttons still work (state is view-level); `#panels` needs
  a lane, as today.
- **Peek hidden, thought shown**: thought falls back to the active lane's
  thought, because `resolveLaneThoughtSnapshot` no longer sees a peeked lane.
- **Palette peek commands** (`acp.peek.show/next/prev`) still update peek state
  while peek is hidden; the card appears when peek is shown again.
- **Ticket becomes active while hidden**: state updates, dock stays hidden, no
  margin reserved.
- **Narrow tile**: below 480px only the `all` button (and the spec 322
  `backend-update` action, when present) remains; per-panel control
  stays available through `#panels <panel>`.
- **Tab strip visible**: `-end` is `display: contents`, so the cluster flows
  after the tabs and the tab pills shrink by the cluster's ~177px.
- **Stage layout shelf window**: the workspace capture-phase mousedown handles
  shelf windows first; a click there selects the window, not the toggle.
- **Remote Harness**: local presentation state; works unchanged.

## Open Questions

None.

## Out of Scope

- Toggles for Zen lane rail (a layout mode, `Cmd+.`), composer strips (peer,
  assist, live voice, staging — pinned with the composer), transcript content
  (annotation and resource rails, GenUI) and summoned overlays (memory, metrics,
  help, pickers).
- Contributing titlebar buttons from any view other than the Harness.
- User-configurable hiding or reordering of buttons, a customize dropdown,
  config TOML (the narrow-tile collapse is automatic, not a setting).
- New global or leader keybindings, or command-palette entries.
- Changing what `#panels` without a panel argument does.

## Resources

- [VS Code — Custom Layout](https://code.visualstudio.com/docs/configure/custom-layout) — title-bar layout controls, keyboard command per toggle, persistence.
- [Zed — Visual Customization](https://zed.dev/docs/visual-customization) — per-panel status-bar buttons and per-button hiding.
- `docs/0251-harness-panel-visibility-command.md`, `docs/0218-window-lane-strip.md`, `docs/0226-titlebar-tail-zoom.md`, `docs/0301-harness-ui-components.md` — Krypton precedents this design extends.
