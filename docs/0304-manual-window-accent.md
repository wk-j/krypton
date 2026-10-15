# 304. Manual Window Accent Color

> Status: Implemented
> Date: 2026-10-15
> Scope: frontend only — one public Compositor API, one palette command group, one CSS rule, one optional snapshot field.
> Depends on: [142 — Active-Lane → Window Accent](./0142-active-lane-window-accent.md), whose O4 reserved this
> follow-up with the rule "auto by default, an explicit pick wins".

## Problem

A window's accent colour (title text, status dot, border, glow, header band) is handed out by
`allocateAccentColor()` (`src/compositor.ts:2292`) purely by **creation order**: first window takes the
theme colour, second magenta, third amber. The user cannot say "this window is the red one". Close and
reopen a window and its colour changes, so colour cannot be used as a memory aid for "the window where
the server runs".

## Solution

A `Window Color` group in the command palette: ten entries (one per `ACCENT_PALETTE` colour, each with a
swatch) plus `Window Color: Auto`. Picking one paints the **focused window** immediately and rides the
workspace snapshot, so it survives a WebContent reload; `Auto` returns it to the compositor-allocated
colour.

The pick is applied through a dedicated attribute + custom property (`data-accent-pick` /
`--krypton-accent-pick`) so it beats both layers that already write the accent — the compositor's normal
inline vars and the harness's `!important` lane rule — without removing either. Dropping the attribute is
the whole revert path.

No new keybinding: the palette is already `Cmd+P` → type `color`. No titlebar button in this spec.

## Research

Codebase findings:

- **One funnel paints the chrome.** `applyAccentColor()` (`compositor.ts:2323`) writes
  `--krypton-window-accent` + `-rgb` as inline style; every surface reads those two vars
  (`window.css:32-38`, `:144`, `:238`, `:247`). Re-calling it re-tints in one frame — no re-render.
- **Two writers already compete.** The harness lane rule (`window.css:123-126`) is `!important`, so it
  dominates the compositor's inline vars on harness windows. A third writer must therefore either lose on
  harness windows or declare after the lane rule at equal specificity. Equal-specificity-later is what
  spec 142 itself used against the compositor, so the pattern is established.
- **Theme reload re-paints some windows.** `compositor.ts:2064-2069` re-applies the theme accent to every
  window whose palette index is 0. A picked window must be skipped there or `Reload Config` silently
  erases the pick.
- **Workspace state is in-memory, not on disk.** `createWorkspaceSnapshot()` (`compositor.ts:2695`) →
  `save_workspace_state` stores the JSON in a `Mutex<Option<Value>>` on the Rust side
  (`src-tauri/src/workspace_state.rs:7`), replayed by `restoreWindow()` (`compositor.ts:2826`) when the
  webview reloads or recovers. So a picked colour survives a reload but **not** quitting the app —
  persisting across launches would need a new on-disk store and stays out of scope.
  `WorkspaceWindowSnapshot` (`workspace-recovery.ts:25-29`) carried `tabs` / `activeTabIndex` / `pinned`
  only. `parseWorkspaceSnapshot` requires `version === WORKSPACE_SNAPSHOT_VERSION` exactly
  (`workspace-recovery.ts:130`), so an **optional** field is additive but a version bump would discard
  every user's current layout.
- **Palette precedent.** `Color Theme:` entries are built per item in `rebuildActions()`
  (`command-palette.ts:1133-1146`) and the palette holds the `Compositor` directly (`:83`), so the command
  needs one public method, no new plumbing.
- **Chrome has no buttons.** The only pointer affordance on a window is `mousedown` → focus
  (`compositor.ts:2558`, `:3115`); a titlebar button would be the first, and would have to fight that
  handler. Deferred (Out of Scope).

**Alternatives ruled out:**
- *Free hex input* — needs contrast validation against both schemes and loses fuzzy search by colour name;
  the ten-colour palette is already the app's visual vocabulary.
- *Colour keyed by project/cwd hash* — different feature with a different trade-off: it gives up the
  "no two open windows share a colour" guarantee (`docs/0219-window-project-badge.md:45-49`).
- *Writing `--krypton-window-accent` inline from the command* — loses to the harness lane rule, i.e. the
  command would do nothing on exactly the windows users stare at most.
- *Freeing the auto-allocated palette index when a pick is made* — extra bookkeeping in
  `allocateAccentColor` / `freeAccentColor` for no user-visible gain; keeping the reservation is what makes
  `Auto` an instant, stateless revert.

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| VS Code + Peacock | `Peacock: Change to a favorite color` in the command palette; a short list of named, pre-defined colours; writes `workbench.colorCustomizations` into the workspace file | Palette-driven, named presets, persisted per workspace — the closest match to this design |
| iTerm2 | `View > Tab Color` menu with a macOS colour well; also settable from the shell via the `1337;SetColors` escape | Menu + free colour, no palette command; per tab, not per window |
| tmux | `select-pane -P 'bg=colour196'`, `pane-border-style` | Command-line, arbitrary colour, no UI affordance |
| WezTerm | Tab bar colours in `wezterm.lua` config only | Static config, not a runtime per-window choice |

**Krypton delta** — matches Peacock's shape (palette command, named presets, persisted) because that is the
keyboard-first form; diverges from iTerm2/tmux by refusing free colour entry, keeping every window on the
ten-colour cyberpunk palette; and layers under the existing per-lane accent so an unpicked harness window
still tracks its active lane.

## Affected Files

| File | Change |
|------|--------|
| `src/compositor.ts` | `accentPicks: Map<WindowId, string>`; public `accentOptions()`, `pickedAccentName(windowId)`, `setWindowAccentPick(windowId, name \| null)`; apply/clear `data-accent-pick` + `--krypton-accent-pick` / `-rgb`; skip picked windows in the theme-reload loop (`:2064-2069`); emit `accent` in `createWorkspaceSnapshot()`; re-apply it in `restoreWindow()`; drop the map entry in the window-close path next to `freeAccentColor()` |
| `src/command-palette.ts` | In `rebuildActions()`, after the `Color Theme` block: one entry per `accentOptions()` plus `Window Color: Auto`, category `Window Color`, id `window.accent.<name>` / `window.accent.auto`, swatch element on each row, `(current)` suffix on the active one |
| `src/styles/overlays.css` | `.krypton-palette__item-swatch` — 10×10, `flex: none`, colour from an inline var |
| `src/styles/window.css` | `.krypton-window[data-accent-pick]` rule mapping `--krypton-accent-pick` / `-rgb` onto the two window-accent vars with `!important`, declared **after** the `data-lane-accent` rule (`:123-126`) |
| `src/workspace-recovery.ts` | `WorkspaceWindowSnapshot.accent?: string`; in `parseWorkspaceSnapshot` accept it when absent or a string, reject other types; **no version bump** |
| `src/workspace-recovery.test.ts` | Snapshot round-trip keeps a valid `accent`; a non-string `accent` rejects the snapshot; an unknown colour name still restores (as auto) |
| `docs/README.md`, `docs/0142-active-lane-window-accent.md` | Index row; note in 142 that O4 is now implemented here |

## Design

### Data structures

```ts
// compositor.ts — ACCENT_PALETTE entries are already { name, hex, rgb }
private accentPicks: Map<WindowId, string> = new Map();   // windowId → AccentColor.name

accentOptions(): ReadonlyArray<AccentColor>;              // ACCENT_PALETTE, index 0 resolved via paletteColor(0)
pickedAccentName(windowId: WindowId): string | null;
setWindowAccentPick(windowId: WindowId, name: string | null): void;
```

```ts
// workspace-recovery.ts
export interface WorkspaceWindowSnapshot {
  tabs: WorkspaceTabSnapshot[];
  activeTabIndex: number;
  pinned: boolean;
  /** Palette colour name chosen by the user; absent = compositor-allocated. */
  accent?: string;
}
```

### CSS

```css
/* After the data-lane-accent rule — equal specificity, later declaration wins,
   so an explicit pick also overrides the active-lane colour (spec 142 O4). */
.krypton-window[data-accent-pick] {
  --krypton-window-accent: var(--krypton-accent-pick, #00ccff) !important;
  --krypton-window-accent-rgb: var(--krypton-accent-pick-rgb, 0, 204, 255) !important;
}
```

### Data flow

```
1. Cmd+P → "color" → palette lists `Window Color: Amber`, … , `Window Color: Auto`
2. Enter → execute() → compositor.setWindowAccentPick(focusedWindowId, 'amber')
3. Compositor stores the name, sets --krypton-accent-pick(+-rgb) inline and
   data-accent-pick on the window element
4. CSS maps them onto --krypton-window-accent(+-rgb); title, dot, border, glow,
   header band and progress gauge re-tint in the same frame
5. The debounced workspace save writes `accent: 'amber'` into the snapshot
6. After a WebContent reload restoreWindow() replays step 3 once the window is
   rebuilt (workspace state is in memory, so quitting the app clears it)
7. `Auto` → setWindowAccentPick(id, null) → attribute + vars removed → the
   compositor's untouched inline base (or the lane rule) shows through again
```

### Keybindings

None added. Reached through the existing command palette (`Cmd+P`), which satisfies the keyboard-first
constraint; there is no pointer-only path to this feature.

### UI

Palette rows gain a `<span class="krypton-palette__item-swatch">` before the label, filled with the
entry's hex. The window itself gains no new DOM.

### Configuration

None. The choice is workspace state, not config — it is per window, not per user.

## Edge Cases

| Case | Behaviour |
|------|-----------|
| Harness window with an active lane | The pick wins (declared after the lane rule). `Auto` hands the window back to the lane colour. |
| Lane switched after a pick | Window keeps the picked colour; lane identity still shows inside the harness (`--acp-lane-accent`) |
| `Reload Config` / `set_theme` | Picked windows are skipped in the theme loop (`:2064-2069`); `Window Color: Cyan` keeps following the theme because entry 0 resolves through `paletteColor(0)` |
| Pick a colour another window holds | Allowed — the user asked for it. The auto-allocation guarantee only covers unpicked windows |
| Window closed | `accentPicks.delete(id)` beside `freeAccentColor()`; the auto index was never released, so nothing leaks |
| Pane disposed, window survives | Unaffected — the pick lives on the window element, not the pane |
| Snapshot with an unknown colour name | Type is validated structurally (`accent` must be a string if present); an unrecognised *name* is dropped at apply time and the window restores auto — a cosmetic field must never cost the user their whole layout. Older snapshots without `accent` restore unchanged |
| `data-program-status` blocked/error/done | Still recolours border/glow/dot through its own var (`window.css:48-61`) — status beats identity, as today |
| No focused window | The command is a no-op with a `console.warn`; it cannot crash the palette |
| Quick Terminal | Not covered — it has no `WindowId` in `this.windows` |

## Out of Scope

- Titlebar swatch button (mock C in the discussion) — first pointer affordance in window chrome; revisit after the command ships.
- Free hex / colour-well input.
- A colour keyed to project or cwd.
- Changing `ACCENT_PALETTE` or the allocation algorithm.
- Quick Terminal and the `live-assist` auxiliary webview.
- Persisting a pick across an app quit — workspace state lives in memory (`workspace_state.rs:7`); an on-disk store is a separate change.

## Testing

Verified 2026-10-15 against real browser computed styles, not assertions about the source:

- **Cascade** — `window.css` loaded in Chromium with three `.krypton-window` elements (compositor inline base only / `+ data-lane-accent` / `+ data-accent-pick`). Computed `--krypton-window-accent`, label colour and border colour: `#e8c547` → `#8effb0` → `#ff3a5c`; removing `data-accent-pick` returned the third element to the lane colour, proving the revert needs no stored base.
- **End to end** — the real frontend booted in Chromium against a throwaway stand-in for `@tauri-apps/api/core|event` (Rust backend only). `Cmd+Shift+P` → `window color` listed 10 swatched entries + `Auto (current)`; executing `Window Color: Red` moved label/dot/border to `rgb(255, 58, 92)` and set `data-accent-pick="red"`.
- **Snapshot round trip** — picking `Gold` wrote `windows[0].accent: "gold"` into the saved snapshot; a page reload restored the window with `data-accent-pick="gold"` and `rgb(251, 191, 36)` chrome.
- **Isolation + revert** — a second window auto-allocated magenta while the first stayed gold; `Window Color: Auto` on the focused window removed the attribute, returned it to its allocated magenta and dropped `accent` from the snapshot, leaving the gold window untouched.
- `npm run check` clean; `npx vitest run` 172 files / 2213 tests pass, including three new `workspace-recovery` cases (valid `accent` round-trips, absent `accent` stays undefined, non-string `accent` rejects the snapshot).
- **Not covered:** driving the real macOS app window — this machine denies `osascript` keystroke access (Accessibility), so the GUI build was never keyboard-driven. Everything above ran the same frontend code in Chromium.

## Resources

- [Peacock — user guide](https://github.com/johnpapa/vscode-peacock/blob/main/docs/guide/README.md) — confirmed the shape: `F1` → `Peacock: Change to a favorite color` → pick from pre-defined colours; persisted in workspace settings.
- [iTerm2 — Menu Items (`View > Tab Color`)](https://iterm2.com/documentation/2.1/documentation-menu-items.html) — per-tab tint via menu + colour well, the free-colour alternative this spec rejects.
- [iTerm2 — Colors profile preferences (Tab Color)](https://iterm2.com/3.5/documentation-preferences-profiles-colors.html) — how a session-level colour propagates to the tab control.
