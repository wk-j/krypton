# Ticket Panel Hides via the Titlebar Toggle — Implementation Spec

> Status: Implemented
> Date: 2026-10-24
> Milestone: M6 — ACP Harness
> Amended (rev 2): the < 960px overlay gets a solid background, because without
> the collapsed state a narrow harness now shows it until the user hides it.
> Amended by spec 337 (2026-10-27): the dock now shares the right column with the Rails dock as a
> second tab. `harness-dock.ts` owns placement, `hidden` and the width-reserving root class, renamed
> `acp-harness--dock-active`; this spec's hide paths (`›`, Escape, `#ticket panel`) are unchanged.

## Problem

The Active Ticket dock (spec 238) has three states: shown (352px), collapsed (a
46px column that holds only `‹`) and hidden (spec 320's titlebar toggle /
`#panels ticket`). The collapsed column keeps 46px of dashboard width for one
glyph, and it does the same job as the titlebar `Ticket dock` toggle, which is
how every other panel is hidden.

## Solution

Remove the collapsed state. The dock is either shown at 352px or hidden by spec
320's per-panel `ticket` flag. Every control that used to collapse it — the
header `›` button, Escape inside the dock, `#ticket panel` — now sets that flag
through the same path as the titlebar button. The titlebar `Ticket dock` icon
becomes the one show/hide button, like plan, peek, thought, grammar and queue.
The width-based auto-collapse on the first ticket is removed.

## Research

- **State today.** `HarnessTicketController.ticketPanelCollapsed` (in memory,
  per view) plus `ticketPanelSeen`; root classes
  `acp-harness--ticket-active|collapsed|expanded`; the `TicketDock` prop
  `collapsed` replaces the whole dock with one `.acp-ticket-dock__collapsed`
  button. `harness-shared.css` keeps `margin-right: 46px` on
  `.acp-harness__dashboard` and `.acp-harness__anno-overlay` for it.
- **Collapse entry points.** Header `›` (`data-ticket-dock-action="toggle"`),
  the `‹` column, Escape on the dock, `#ticket panel`, and `activateTicket`,
  which collapses when the harness is narrower than 960px on the view's first
  ticket. Startup restore goes through `activateTicket`, so a narrow harness
  opens with the column.
- **Spec 320 already covers hiding.** `HARNESS_TOGGLE_PANELS` has `ticket`
  (`Ticket dock`, `krypton-icon-panel-ticket`); a hidden dock drops every
  `--ticket-*` class, so the dashboard gets its full width back with no extra
  CSS. The view's `applyPanelsCommand` is the shared path for `#panels` and
  titlebar clicks: persist, `render()`, notify titlebar listeners, flash the chip.
- With the collapsed state removed, `--ticket-expanded` means the same as
  `--ticket-active`. Keeping both would give one state two class names.
- **Rejected:** a narrower column, or moving `‹` into the composer-meta row.
  Either would still be a second show/hide control beside the titlebar toggle,
  and the composer row is reserved for input state.

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| VS Code | A hidden Secondary Side Bar leaves nothing on screen; the title-bar layout control (or `View: Toggle Secondary Side Bar`) brings it back. | The model this spec adopts. |
| JetBrains IDEs | Hidden tool windows keep an icon in the side "tool window bars"; View › Appearance can turn those bars off. | The 46px column is Krypton's tool-window bar; users who want the space turn it off. |
| Zed | Panels toggle from status-bar buttons; a closed panel leaves no strip (spec 320 Prior Art). | — |

**Krypton delta:** matches VS Code and Zed. A hidden dock leaves nothing behind,
and its toggle sits with the other panel toggles in the window titlebar. The
keyboard path stays `#panels ticket` / `#ticket panel`.

## Affected Files

| File | Change |
|------|--------|
| `src/acp/components/ticket-dock/index.ts` | Drop the `collapsed` prop, `collapsedBtn` and root `aria-expanded`; header button becomes `aria-label="Hide ticket panel"`, `data-ticket-dock-action="hide"`. |
| `src/acp/components/ticket-dock/ticket-dock.css` | Delete the `.acp-ticket-dock__collapsed` rules. |
| `src/acp/harness-ticket-controller.ts` | Delete `ticketPanelCollapsed`, `ticketPanelSeen` and the auto-collapse; header click and Escape call `host.applyPanelsCommand({ kind: 'panel', panel: 'ticket', action: 'hide' })`; `#ticket panel` does the same with `toggle`; `renderTicketDock` toggles only `acp-harness--ticket-active`. |
| `src/acp/harness-view-host.ts`, `src/acp/acp-harness-view.ts` | `HarnessTicketHost.applyPanelsCommand`; the host adapter forwards to the view's existing method. |
| `src/styles/harness-shared.css` | Delete the three `--ticket-collapsed` rules; the `--ticket-expanded` selectors in the 959px container blocks become `--ticket-active`; the overlay rule there gains `background: var(--agent-surface-solid, …)` (rev 2); update comments. |
| Tests | `ticket-dock.test.ts`: remove the collapsed case, assert the head button contract. `acp-harness-view.test.ts`: dock-width case without collapse. `harness-ticket-controller.test.ts` (new, happy-dom — the `acp-harness-view` suite runs in `node`): header, Escape and `#ticket panel` all set the `ticket` flag. |
| Docs | `0238` (Ticket Panel UI bullets, `#ticket panel` row), `0320` (ticket row, research note), `0251` (retained state), `0194` (retired-bar note), `0004` (352px/46px), `README.md` index. |

## Design

### Behaviour

| Input | Before | After |
|-------|--------|-------|
| Header `›` click | Collapse to the 46px column | Hide (`ticket` flag on); chip `ticket hidden · #panels show ticket` |
| `‹` column click | Expand | — (column removed) |
| Escape inside the dock | Collapse, focus the harness | Hide, focus the harness |
| `#ticket panel` | Toggle collapse (needs an active ticket) | Toggle the `ticket` flag (still needs an active ticket); same chip as `#panels ticket` |
| Titlebar `Ticket dock` | Toggle hidden | Unchanged |
| First ticket in a view narrower than 960px, including startup restore | Starts collapsed | Shown as the existing 959px overlay; one hide is then remembered for the project |

The hidden flag is spec 320's: persisted per project. A hidden dock stays hidden
across restarts and new ticket activations until the toggle or a command shows it.

### Data Flow (header button)

```
1. Click `›` → the delegated handleTicketDockClick sees data-ticket-dock-action="hide".
2. host.applyPanelsCommand({ kind: 'panel', panel: 'ticket', action: 'hide' })
   → view setPanelHidden('ticket', true): writeHiddenPanels, notify titlebar
     listeners, render(); flash the chip.
3. renderTicketDock: shown = false → ticketDockEl.hidden = true and
   --ticket-active off → dashboard and annotation overlay get the 352px back.
4. The titlebar re-renders its cluster: Ticket dock aria-pressed="false".
```

### UI Changes

The shown dock is unchanged except for the head button:
`<button type="button" aria-label="Hide ticket panel" data-ticket-dock-action="hide">›</button>`.
The root `.acp-harness__ticket-dock` no longer carries `aria-expanded`. The only
root class left is `acp-harness--ticket-active`.

**Narrow overlay (rev 2).** Below 960px the dock overlays the transcript rather
than sitting beside it, and it was `background: transparent` like the docked
pane, so transcript text showed through its head (seen in a 700px smoke page:
lane text over `ACTIVE TICKET`). The 959px container rule now sets
`background: var(--agent-surface-solid, rgba(2, 5, 10, 0.96))`, the surface the
annotation overlay already uses; it follows the theme's chrome backdrop. The
docked pane at 960px and above stays transparent (spec 238).

No IPC, config or backend change.

## Edge Cases

- **Narrow titlebar (< 480px):** spec 320 hides every per-panel toggle except
  `all` (since spec 347: except `left` / `right`), so `#panels ticket` or
  `#ticket panel` shows the dock. The rule is unchanged; it is now the only way
  back at that size.
- **Right panel hidden (spec 347; formerly the `#panels hide` master switch):**
  dock hidden; the `ticket` flag is untouched. The header and Escape cannot
  fire because the dock is not shown. `#ticket panel` records the flag, and the
  chip adds ` · right panel hidden`.
- **Ticket removed or cleared:** the dock is hidden by `ticket === null`; the
  flag is untouched.
- **Showing repaints from memory.** The old expand path re-read the ticket from
  disk; showing now repaints from the in-memory `activeTicket`.
  `acp-ticket-progress` and `#ticket refresh` keep that current.
- **Upgrade:** the collapsed state was never persisted. A user who relied on
  the auto-collapse sees the dock once and hides it once.

## Open Questions

None.

## Out of Scope

- Showing the ticket toggle in titlebars narrower than 480px, a badge or count
  on the toggle, or moving the ticket summary into another row.
- Changing `#panels`, the titlebar cluster, or the shown dock's sections.
- Removing `#ticket panel`.

## Resources

- [VS Code — Custom Layout](https://code.visualstudio.com/docs/configure/custom-layout) — a hidden Secondary Side Bar comes back through the title-bar layout controls.
- [IntelliJ IDEA — Tool windows](https://www.jetbrains.com/help/idea/tool-windows.html) — tool window bars, and the option to hide them.
- `docs/0238-local-ticket-bundles.md`, `docs/0320-harness-titlebar-panel-toggles.md`, `docs/0251-harness-panel-visibility-command.md` — the dock and visibility rules this spec simplifies.
