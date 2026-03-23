# Matrix 3D Background Animation — Implementation Spec

> Status: Implemented
> Date: 2026-03-23
> Milestone: Post-M5 — Visual Polish

## Problem

The two existing background animations (flame, brainwave) lack a classic cyberpunk option. A Matrix-style falling character rain — rendered with 3D perspective depth — would fit Krypton's aesthetic and give users a third distinct visual for Claude processing.

## Solution

Add a new `MatrixAnimation` class that renders falling columns of glowing characters on a canvas with simulated 3D depth (columns in the "back" are smaller, dimmer, and slower). Characters cycle through katakana, Latin, and digit glyphs. Columns fade via a vertical gradient tail. Register it as `"matrix"` alongside the existing `"flame"` and `"brainwave"` options.

## Affected Files

| File | Change |
|------|--------|
| `src/matrix.ts` | **New** — `MatrixAnimation` implementing `BackgroundAnimation` |
| `src/claude-hooks.ts` | Import `MatrixAnimation`, add `"matrix"` to `setAnimationType` normalizer and `createAnimationInstance` factory |
| `src/styles.css` | Add `.krypton-matrix-canvas` to the animation canvas selector |
| `src-tauri/src/config.rs` | Update `animation` field doc comment to list `"matrix"` |

## Design

### Data Structures

```typescript
interface MatrixColumn {
  x: number;           // pixel x position
  y: number;           // current head y position (pixels)
  speed: number;       // pixels per frame
  length: number;      // number of visible chars in tail
  depth: number;       // 0.0 (front) to 1.0 (back) — drives size/opacity
  chars: string[];     // ring buffer of glyphs
  charTimer: number;   // frames until next glyph swap
  charInterval: number; // frames between glyph swaps
}
```

### Rendering Approach

- **Columns**: ~40-80 columns depending on canvas width, randomly distributed across X with varying depth values.
- **Depth simulation**: Each column has a `depth` value (0–1). Deeper columns have smaller font size (range 14px–8px), lower opacity (0.9–0.3), and slower speed — creating a parallax 3D feel without actual WebGL.
- **Character set**: Katakana (U+30A0–U+30FF), digits 0–9, select Latin uppercase. Head character glows bright (white-green), tail fades to transparent over `length` characters.
- **Glyph cycling**: Each column periodically swaps random characters in its tail to create the "decoding" flicker effect.
- **Color palette**: Bright green (`#00ff41`) for head, fading through cyan-green to transparent. Matches Krypton's cyberpunk theme.

### Data Flow

1. `start()` called → canvas fades in (600ms), `requestAnimationFrame` loop begins
2. Each frame: clear canvas, advance all columns downward by their speed
3. For each column: draw characters from head position upward, applying depth-scaled font size and fading opacity per character
4. When a column's head passes the bottom edge, reset to top with new random properties
5. `stop()` called → canvas fades out (600ms), animation loop cancelled

### Configuration

Existing `hooks.animation` field in `krypton.toml` — add `"matrix"` as a valid value:

```toml
[hooks]
animation = "matrix"   # "flame" | "brainwave" | "matrix" | "none"
```

## Edge Cases

- **Narrow windows**: Reduce column count proportionally; minimum 8 columns.
- **Resize**: Recalculate column positions and canvas dimensions. Existing columns keep their depth/speed but get redistributed across new width.
- **Very tall windows**: Increase tail length proportionally so columns don't look sparse.

## Open Questions

None.

## Out of Scope

- WebGL / actual 3D rendering — this uses 2D canvas with simulated depth
- Interactive elements (mouse parallax, click effects)
- Custom character sets via config
