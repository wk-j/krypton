# Terminal Top-Line Glow Overlay — Implementation Spec

> Status: Implemented
> Date: 2026-03-20

## Problem

Krypton's cyberpunk aesthetic would benefit from a subtle glow effect on the top rows of each terminal. Currently all terminal rows look identical — there is no visual depth or atmosphere near the top edge of each pane.

## Solution

Add a CSS `::before` pseudo-element on `.krypton-pane__terminal` (and `.krypton-window__body` for Quick Terminal) that creates a fixed glow overlay covering the first 3 lines. The overlay uses the window's accent color, stays fixed at the top regardless of scroll, and is purely cosmetic (no pointer events). Height is computed from font size, line height, and xterm padding via CSS custom properties set by the compositor.

## Affected Files

| File | Change |
|------|--------|
| `src/styles.css` | Add `::before` pseudo-element on `.krypton-pane__terminal` and `.krypton-window__body` |
| `src/compositor.ts` | Set `--krypton-terminal-cell-height` CSS custom property when font config is applied |

## Design

### CSS Custom Properties

The compositor already sets `--krypton-window-accent-rgb` per window. We add one new property on the document root:

```
--krypton-terminal-cell-height: <fontSize * lineHeight>px
```

Set in `applyConfig()` whenever `fontSize` or `lineHeight` changes.

### Glow Overlay

A `::before` pseudo-element on `.krypton-pane__terminal`:

```css
.krypton-pane__terminal::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: calc(var(--krypton-terminal-cell-height, 17px) * 3 + 4px);
  background: linear-gradient(
    180deg,
    rgba(var(--krypton-window-accent-rgb, 0, 200, 255), 0.07) 0%,
    rgba(var(--krypton-window-accent-rgb, 0, 200, 255), 0.02) 60%,
    transparent 100%
  );
  pointer-events: none;
  z-index: 1;
}
```

- Height = 3 rows (`cell-height * 3`) + xterm top padding (4px from `.xterm { padding: 4px 6px }`)
- Uses the per-window accent color via `--krypton-window-accent-rgb` so each window's glow matches its border/accent
- Gradient fades from ~7% opacity at top to transparent, giving a soft glow rather than a hard band
- `pointer-events: none` and `z-index: 1` ensure it doesn't interfere with terminal interaction
- The same rule is duplicated for `.krypton-window__body::before` (Quick Terminal)

### Data Flow

1. Compositor `applyConfig()` reads `fontSize` and `lineHeight` from config
2. Sets `--krypton-terminal-cell-height` on document root: `fontSize * lineHeight` px
3. CSS `::before` uses `calc()` to derive overlay height from that property
4. Overlay renders on top of terminal canvas, fades over first 3 lines

## Edge Cases

- **Font size change (hot-reload):** `--krypton-terminal-cell-height` is updated in `applyConfig()`, so the overlay height adjusts automatically via CSS `calc()`.
- **Shader interaction:** The overlay is inside `.krypton-pane__terminal` which is below the shader canvas. If the shader obscures it, `z-index` may need adjustment — but shaders apply to the pane parent, so this should layer correctly.
- **Quick Terminal:** `.krypton-window__body` gets the same `::before` rule so the glow appears there too.
- **Split panes:** Each pane has its own `.krypton-pane__terminal`, so each gets its own glow overlay independently.

## Out of Scope

- Per-line glow that tracks specific buffer content (decoration API approach)
- User-configurable glow color, intensity, or line count (can be added later via `[visual]` config)
- Glow on other edges (bottom, sides)
