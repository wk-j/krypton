# Harness Lane Stats Toggle — Implementation Spec

> Status: Implemented (approved 2026-11-08: "ทำตามแบบนี้เลย ลงมือ implement spec docs/0374-harness-lane-stats-toggle.md ตามที่ร่างไว้ โดยใช้ค่าเดียวทุก lane และคีย์ลัด ⌥⌘.")
> Date: 2026-11-08
> Milestone: ACP Harness — chrome
> Builds on: 0157 (concise mode toggle precedent) · 0302 §4.2/§4.4 (`LaneHead`, `LaneStats`) · 0366 (head strip as one plate)

## Problem

The shown lane's head strip is two rows: the head (`LaneHead`) and the stats row under it
(`LaneStats`: `sess · project · context · cache · in/out · cost · tools · rows`). The user wants to
hide the stats row to give the transcript the space, and bring it back, by clicking the lane name.

## Solution

One view-wide flag, `laneStatsHidden`, persisted per project like Zen and Concise mode. The view
puts `acp-harness--lane-stats-hidden` on its root, and CSS hides `.acp-harness__lane-stats` and moves
the strip's seam under the head. Clicking the **shown** lane's name toggles it; `⌥⌘.` toggles it from
the keyboard (constraint 1), next to `⌘.` (Zen) and `⇧⌘.` (Concise). The row stays in the DOM and
keeps updating, so showing it again is instant and nothing re-renders.

## Research

- Only the shown lane has a stats row: `LaneShell` builds `LaneStats` when `props.active`
  (`lane-shell/index.ts:77-85`); a stacked lane's band is a head alone. A per-lane flag would hide or
  show the row as the user switches lanes, so the flag is view-wide.
- Precedent: Concise mode (spec 157) is a boolean field, a `localStorage` key
  `krypton:acp-harness:concise:${projectDir}`, a root class set in `syncRootClasses()`
  (`acp-harness-view.ts:12865`) and a `render()` on toggle (`:16269`).
- The head and stats rows are one plate: the head paints `plate-hi → plate-mid` with no bottom
  border and the stats row paints `plate-mid → plate-lo` plus the seam (`lane-head.css:28-38`,
  `lane-stats.css:10-21`). Hidden stats therefore need the head to paint the whole gradient and the
  seam; the Zen-rail and dock variants keep their own background (they hold the top stop) and only
  gain the seam.
- `⌥⌘.` is unbound: no `Period` + `altKey` chord exists in `src/` (`input-router.ts` binds only
  `⇧⌘,` / `⇧⌘.`). With Option held macOS reports `≥` as `e.key`, so the handler matches `e.code`.
- The lane name has no click behaviour today; the view's root click delegation
  (`acp-harness-view.ts:6601`) handles transcript elements only.

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| VS Code | View → Appearance → Status Bar (`workbench.action.toggleStatusbarVisibility`), no default key | Window-wide, persisted |
| tmux | `set-option status off` / `on`, usually bound by the user | Per session; whole line, no partial hide |

**Krypton delta:** same "whole row on/off, remembered" model; the click target is the lane name
because it is the label of the strip the row belongs to, and the keyboard chord sits with the other
two harness view toggles.

## Affected Files

| File | Change |
|------|--------|
| `src/acp/acp-harness-view.ts` | `laneStatsHidden` field + read/write preference helpers, `⌥⌘.` branch beside Concise, root class in `syncRootClasses()`, `toggleLaneStats()`, `onToggleStats` in `laneShellProps()` |
| `src/acp/components/lane-shell/index.ts` | `onToggleStats` prop; the shown shell listens for a click on the head's name |
| `src/acp/components/lane-head/index.ts` | `nameEl` readable by the shell; the shown lane's name carries `title="Show / hide lane stats (⌥⌘.)"` |
| `src/acp/components/lane-head/lane-head.css` | Pointer cursor on the shown name; full gradient + seam on the head when stats are hidden |
| `src/acp/components/lane-stats/lane-stats.css` | `.acp-harness--lane-stats-hidden .acp-harness__lane-stats { display: none; }`, sharing the rule with concise mode (spec 157) |
| `src/acp/components/lane-shell/lane-shell.test.ts` | Click on the shown lane's name toggles; a chip click or a stacked lane's name does not |
| `src/acp/components/help-overlay/index.ts` | `⌥⌘.` entry under Lane Control |
| `docs/0072-acp-harness-view.md`, `docs/README.md` | Keybinding row; index entry |

## Design

### Data Flow

```
1. Click on .acp-harness__lane-name inside the shown lane's head, or ⌥⌘. anywhere in the view
2. toggleLaneStats(): laneStatsHidden = !laneStatsHidden; write localStorage; render()
3. syncRootClasses() toggles acp-harness--lane-stats-hidden on the view root
4. CSS hides the stats row and draws the seam under the head; the lane body takes the height
```

Storage key: `krypton:acp-harness:lane-stats-hidden:${projectDir ?? ''}` (`'1'` or absent).

### Keybindings

| Key | Context | Action |
|-----|---------|--------|
| `⌥⌘.` (`Ctrl+Alt+.`) | Anywhere in the harness view | Show / hide the shown lane's stats row |

### UI Changes

- Shown lane's name: `cursor: pointer`, the title above. Stacked lane bands are unchanged.
- Hidden: the strip is the 28px head alone, painting `plate-hi → plate-lo` with the
  `--mat-key-edge` seam. Beside the Zen rail or dock column the head keeps its held top stop and
  gains only the seam; those columns still hold the top stop for 56px, which now runs 28px past
  the seam beside the screen — accepted, the stops are adjacent shades.

## Edge Cases

- Stats-only cells (`perm`, `ask`, `err: …`, `accept-all`, `polly-bypass`) are hidden with the row;
  the head's status lamp and the transcript rows still show permission, question and error state.
- The click handler ignores clicks on chips, status and activity; only the name toggles.
- No project dir: the key is `…:lane-stats-hidden:` like Zen and Concise.
- Lane switch, Zen on/off and a rebuilt shell keep the state: it lives on the view root, not a shell.
- Concise mode (spec 157) hides the row too, with the same head treatment. While it is on, the
  toggle still flips and stores `laneStatsHidden`, but the row stays hidden until concise mode is off;
  the two flags are independent and neither writes the other.

## Out of Scope

- Hiding individual stats cells, or moving them into the head.
- A titlebar toggle or palette command.
- Per-lane state.

## Resources

- [tmux(1) — `status` option](https://man7.org/linux/man-pages/man1/tmux.1.html) — whole status line on/off
- [Stack Overflow — hide the status bar in VS Code](https://stackoverflow.com/questions/37117555/how-can-i-hide-the-status-bar-in-vs-code) — View → Appearance → Status Bar toggle
