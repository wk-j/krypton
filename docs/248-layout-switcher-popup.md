# Layout Switcher Popup — Implementation Spec

> Status: Draft
> Date: 2026-09-14
> Milestone: Post-M-current polish

## Problem

`Leader f` currently advances through five layouts without showing the choices. Reaching a specific layout can require several disruptive relayouts, and the user must remember the cycle order.

## Solution

Make `Leader f` open the existing Command Palette as a layout-scoped popup. It lists only `Grid`, `Focus`, `Depth`, `Scroll`, and `Stage`, gives every row a schematic icon of its geometry, highlights and labels the current layout, and applies the selected layout only after `Enter`, `Alt+1`–`Alt+5`, or a pointer click. `Escape` closes the popup without changing layout.

This reuses Krypton's established overlay, focus, sound, and keyboard-routing behavior instead of adding another dialog class or input mode. The unbound `Cycle Layout` action remains available in the full Command Palette for users who still want one-step cycling.

## Research

- Krypton already registers five direct `Layout: …` actions and one cycle action in `CommandPalette`; each direct action calls `Compositor.applyLayoutMode()`.
- `CommandPalette.openWithQuery()` cannot provide the intended picker by itself: filtering against `Layout:` matches every action in the `Layout` category, including `Cycle Layout`. A scoped open path is required.
- `InputRouter` already owns `Mode.CommandPalette`, suspends native child webviews while an overlay is active, and hides which-key when leaving Compositor mode. No new mode is needed.
- `Compositor.applyLayoutMode()` is already a guarded no-op for the active layout and owns all Scroll/Stage entry and exit behavior, terminal fitting, sound, and animation.
- Pointer execution currently closes the palette without synchronizing `InputRouter` back to Normal mode. The switcher must close through a shared lifecycle callback so mouse selection does not strand keyboard routing in `CommandPalette` mode.
- Live preview was rejected. Arrowing across choices could trigger several terminal fits and layout animations, while `Escape` would then need rollback semantics. Commit-on-select is predictable and cheap.
- A new dedicated popup component was rejected because it would duplicate palette DOM, keyboard navigation, pointer behavior, theming, native-webview suspension, and accessibility state.

## Prior Art

| App | Implementation | Relevance |
|-----|----------------|-----------|
| WezTerm | `ShowLauncherArgs` scopes its launcher by flags; entries support vi navigation, numeric quick-select, filtering, `Enter`, and `Esc`. | Closest interaction model: one reusable launcher narrowed to a known set. |
| Zed | The Theme Selector is a dedicated selector opened from the Command Palette; the general palette narrows actions as the user types. | Supports a focused selector built on the app's established command UI. |
| VS Code | Editor layouts are available through `View > Editor Layout` and the Command Palette. | Confirms named direct choices are more discoverable than cycle-only switching. |
| Zellij | `override-layout` applies a named layout to a running session. | Confirms direct runtime layout selection; its file-based layout model is broader than Krypton's five modes. |

**Krypton delta** — follow the scoped-launcher convention and retain `Alt+1`–`Alt+5` quick-select, but keep Krypton's existing `Leader f` entry point and cyberpunk Command Palette surface. Unlike Zed's theme selector, selection does not preview because a compositor layout change can resize terminal PTYs.

## Affected Files

| File | Change |
|------|--------|
| `src/command-palette.ts` | Add a layout-scoped open path, fixed layout order, schematic icon DOM, current-layout marker/selection, and reset scoped state on ordinary opens. |
| `src/input-router.ts` | Route `Leader f` into the scoped palette and synchronize palette pointer-close back to Normal mode. |
| `src/which-key.ts` | Rename the `f` hint from `Cycle Layout` to `Switch Layout`. |
| `src/styles/overlays.css` | Add the five compact schematic layout icons and scoped row geometry. |
| `docs/04-architecture.md` | Document popup-based layout switching and the retained cycle action. |
| `docs/05-data-flow.md` | Record open, navigate, commit, and cancel flow. |
| `docs/06-configuration.md` | Replace wording that says `Leader f` cycles layouts. |
| `docs/241-scroll-tiling-layout.md` | Update the Scroll entry path. |
| `docs/245-stage-layout.md` | Update the Stage entry path and keybinding table. |
| `docs/README.md` | Index this spec. |

No Rust, Tauri IPC, layout-engine geometry, configuration schema, or sound event changes are needed. CSS changes are limited to the scoped schematic icons and row column.

## Design

### Command Palette Scope

`CommandPalette` gains one public entry point:

```typescript
openLayoutPicker(current: LayoutMode): void;
```

Internally it opens the normal palette with a temporary layout scope. The scope includes only these action IDs, in this order:

```text
layout.grid → layout.focus → layout.depth → layout.scroll → layout.stage
```

The input placeholder becomes `Select a layout…`. The current action starts selected, receives `aria-current="true"`, and shows `CURRENT · Alt+N` in the existing key-hint column. Other rows show `Alt+N`. Typing fuzzy-filters only this five-action set. An ordinary `open()` or a close followed by the next open resets the scope and placeholder so `Cmd+Shift+P` still shows the full palette.

The existing `layout.toggle` action remains in the full palette, loses the `Leader f` keybinding label, and is excluded from the scoped picker. Direct layout actions are reordered to match the canonical compositor cycle.

### Input and Mode Flow

1. User presses `Cmd+P`, then `f`.
2. `InputRouter` calls `commandPalette.openLayoutPicker(compositor.currentLayoutMode)` and changes from `Mode.Compositor` to `Mode.CommandPalette`.
3. Which-key hides; native child webviews stay suspended because the router remains in a non-Normal mode.
4. Arrow keys, `Ctrl+N`/`Ctrl+P`, or `Tab` move the selection. Typing filters within the five layouts.
5. `Enter` or `Alt+1`–`Alt+5` closes the popup and invokes the existing direct layout action. A pointer press does the same.
6. Palette close returns the router to Normal mode. The selected action calls `applyLayoutMode()`; selecting the current layout is a no-op.
7. `Escape`, clicking the backdrop, `Cmd+Shift+P`, or the leader key closes without applying a layout and restores terminal focus.

`InputRouter.setCommandPalette()` subscribes once to the palette close callback. The callback defers one microtask and returns to Normal only if the palette is still closed, preserving any action that intentionally reopens it. Existing keyboard close paths remain idempotent.

### Keybindings

| Key | Context | Action |
|-----|---------|--------|
| `f` | Compositor | Open Layout Switcher |
| `↑` / `↓`, `Ctrl+P` / `Ctrl+N`, `Shift+Tab` / `Tab` | Layout Switcher | Move selection |
| `Alt+1`–`Alt+5` | Layout Switcher | Choose Grid, Focus, Depth, Scroll, or Stage |
| `Enter` | Layout Switcher | Apply selected layout |
| `Escape` | Layout Switcher | Close without changing layout |

### UI and Accessibility

- Reuse `.krypton-palette` and its full-border themed surface; add no new color tokens.
- Insert a 30×20px `aria-hidden` schematic icon between the category chip and label. Icons use only full 1px borders and the existing palette accent:
  - **Grid** — four equal cells in a 2×2 matrix.
  - **Focus** — one large left cell with three small right-stack cells.
  - **Depth** — three overlapping cards, with the front card emphasized.
  - **Scroll** — a clipped horizontal strip of three columns, with the center column emphasized.
  - **Stage** — one large right card with three small shelf cards on the left.
- Icons are fixed geometry, not live DOM thumbnails. They do not inspect windows, animate independently, or change based on window count.
- The selected row brightens the icon and applies the standard tight glow; the current marker remains textual so meaning is not color-only.
- The current layout is both initially selected and exposed through `aria-current`, so state is not conveyed by color alone.
- Keep pointer support secondary but complete: hover moves selection, click commits, and backdrop click cancels.
- Do not add blur or L-shaped corner brackets.

## Edge Cases

| Case | Handling |
|------|----------|
| Current layout selected | Close normally; `applyLayoutMode()` makes no geometry or sound change. |
| Zero or one workspace window | All five choices remain available; existing layout engines handle the count. |
| Picker opened while a native webview is focused | Existing non-Normal-mode suspension exposes the DOM popup and releases first responder. |
| Picker closed by pointer | Deferred close callback restores Normal mode and terminal focus. |
| Full palette opened afterward | Scope, placeholder, current marker, and preferred selection are cleared. |
| Layout action rejects | Existing palette error logging remains responsible; router is already back in Normal mode. |

## Verification

- Run `npm test`, `npm run check`, `npm run build`, and `git diff --check`.
- Live Tauri smoke: verify `Leader f`, all navigation aliases, `Alt+1`–`Alt+5`, typing, `Enter`, `Escape`, backdrop click, pointer selection, current marker, and a subsequent unscoped `Cmd+Shift+P` open.
- Repeat the live smoke with terminal, ACP Harness, and native webview content focused to verify overlay visibility and focus restoration.

## Open Questions

None. Approval accepts replacing `Leader f` cycle behavior with the scoped popup while retaining cycle as an unbound full-palette action.

## Out of Scope

- Live window thumbnails or per-row animated previews
- User-defined layouts or layout ordering
- New global shortcuts or configuration keys
- Changes to layout geometry, animation, persistence, or PTY resize behavior

## Resources

- [WezTerm `ShowLauncherArgs`](https://wezterm.org/config/lua/keyassignment/ShowLauncherArgs.html) — scoped launcher, navigation, filtering, quick-select, and cancel behavior.
- [Zed Command Palette](https://zed.dev/docs/command-palette) — established action discovery and filtered selection.
- [Zed Appearance](https://zed.dev/docs/appearance) — dedicated Theme Selector precedent.
- [VS Code Custom Layout](https://code.visualstudio.com/docs/configure/custom-layout) — named editor-layout commands in menu and Command Palette.
- [Zellij Layouts](https://zellij.dev/documentation/layouts.html) — runtime application of named layouts.
