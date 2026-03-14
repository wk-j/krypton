# 3D Perspective Depth — Implementation Spec

> Status: Implemented
> Date: 2026-03-15
> Milestone: M8 — Polish

## Problem

When a terminal window has multiple layers stacked on the content area (panes, shader overlays, progress gauge, selection cursor), they all render flat on top of each other. There is no visual sense of depth — layers feel like paint on glass rather than physical sheets at different distances.

## Solution

Apply CSS `perspective` on the `.krypton-window__content` container and use `translateZ()` on internal layers to push them to different depths along the Z axis. This creates a subtle 3D parallax where the terminal text sits at the back, overlays float slightly above it, and interactive elements like the selection cursor feel nearest to the viewer. The effect is cosmetic — it does not change layout, hit-testing, or functionality.

A new `[visual]` config section controls the effect. When `perspective_depth` is `0` or `false`, all `translateZ` values collapse to zero (flat rendering, current behavior).

## Affected Files

| File | Change |
|------|--------|
| `src/styles.css` | Add `perspective`, `transform-style: preserve-3d` to content container; add `translateZ()` to layered elements |
| `src/compositor.ts` | Read `visual.perspective_depth` from config; apply `--krypton-perspective` custom property to workspace |
| `src/config.ts` | Add `VisualConfig` interface |
| `src-tauri/src/config.rs` | Add `VisualConfig` struct with `perspective_depth` field |
| `docs/06-configuration.md` | Document new `[visual]` TOML section |

## Design

### Data Structures

**Rust (`config.rs`):**

```rust
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct VisualConfig {
    pub perspective_depth: u16,  // px, 0 = disabled
    pub perspective_tilt: f64,   // degrees, 0 = no tilt
}

impl Default for VisualConfig {
    fn default() -> Self {
        Self {
            perspective_depth: 800,
            perspective_tilt: 2.0,
        }
    }
}
```

**TypeScript (`config.ts`):**

```typescript
export interface VisualConfig {
  perspective_depth: number; // px, 0 = disabled
  perspective_tilt: number;  // degrees, 0 = no tilt
}
```

### API / Commands

No new commands. The value flows through the existing `get_config` command and config hot-reload event.

### Data Flow

```
1. Config loads with visual.perspective_depth = 800, perspective_tilt = 2.0
2. Compositor reads values, sets CSS custom properties on workspace:
   --krypton-perspective: 800px
   --krypton-perspective-tilt: 2deg
3. .krypton-window__content uses perspective: var(--krypton-perspective),
   transform-style: preserve-3d, and transform: rotateX(var(--krypton-perspective-tilt))
4. The rotateX tilt angles the content plane so Z-axis offsets become visible
5. Child layers use translateZ() at fixed offsets:
   - Terminal text (xterm):    translateZ(0)      — back layer
   - Progress gauge:           translateZ(10px)   — mid layer
   - Shader overlay:           translateZ(20px)   — effect layer
   - Selection cursor:         translateZ(30px)   — front layer
6. The perspective + tilt creates visible depth separation between layers
7. If perspective_depth = 0, CSS properties collapse to "none" / "0deg",
   and all translateZ values have no visual effect (flat)
```

### Z-Layer Map

| Layer | Element | translateZ | Purpose |
|-------|---------|-----------|---------|
| 0 (back) | `.xterm-screen` | `0` | Terminal text — deepest layer |
| 1 | `.krypton-progress-gauge` | `10px` | HUD gauge floats above text |
| 2 | `.krypton-shader-overlay` | `20px` | CRT/scanline effects above gauge |
| 3 (front) | `.krypton-selection-cursor` | `30px` | Selection cursor nearest to viewer |
| 3 (front) | `.krypton-split__divider` | `30px` | Split dividers at front plane |

### Configuration

```toml
[visual]
# 3D perspective depth in pixels. Higher values = subtler depth effect.
# Set to 0 to disable (flat rendering). Default: 800
perspective_depth = 800
# Tilt angle in degrees for visible layer separation.
# 0 = no tilt. Default: 2.0. Recommended range: 1–6
perspective_tilt = 2.0
```

### UI Changes

**CSS additions on `.krypton-window__content`:**

```css
.krypton-window__content {
  /* existing styles unchanged */
  perspective: var(--krypton-perspective, none);
  transform-style: preserve-3d;
  transform: rotateX(var(--krypton-perspective-tilt, 0deg));
}
```

**CSS additions on child layers:**

```css
.krypton-pane .xterm-screen {
  transform: translateZ(0);
}

.krypton-progress-gauge {
  /* existing transform updated */
  transform: translate(-50%, -50%) translateZ(10px);
}

.krypton-shader-overlay {
  transform: translateZ(20px);
}

.krypton-selection-cursor {
  transform: translateZ(30px);
}

.krypton-split__divider {
  transform: translateZ(30px);
}
```

**Quick Terminal:** Same treatment — `.krypton-window__body` also gets `perspective`, `transform-style: preserve-3d`, and `rotateX` tilt.

**Compositor change:** On config load and hot-reload, set the custom properties:

```typescript
this.workspace.style.setProperty(
  '--krypton-perspective',
  depth > 0 ? `${depth}px` : 'none'
);
this.workspace.style.setProperty(
  '--krypton-perspective-tilt',
  depth > 0 && tilt > 0 ? `${tilt}deg` : '0deg'
);
```

## Edge Cases

1. **`perspective_depth = 0`**: CSS `perspective: none` and tilt `0deg` disables all depth — `translateZ` values are ignored, rendering is flat. Zero performance cost.
2. **WebGL addon**: xterm.js uses a canvas element. `translateZ` on the canvas's parent (`.xterm-screen`) works in all browsers with hardware acceleration.
3. **Pane splits**: Split containers don't need `translateZ` — only their leaf children (panes, dividers) do. `preserve-3d` propagates through the flex tree.
4. **Performance**: CSS `perspective` and `translateZ` are GPU-composited. No repaints, no layout thrashing. The layers already have `will-change` or `position: absolute`.
5. **Overflow clipping**: `overflow: hidden` on `.krypton-window__content` still clips in the XY plane. Z-axis elements that extend toward the viewer are not clipped, which is the desired behavior (overlays appear "above" the terminal).
6. **Hot-reload**: Changing `perspective_depth` in TOML instantly updates `--krypton-perspective` via the existing config watcher. The visual change is immediate — no restart needed.
7. **Very small perspective values** (e.g., 50): Creates extreme foreshortening. Values below 200 produce unreasonable distortion. Document 400-1200 as the recommended range.
8. **Interactions with window animations**: Window morph/entrance/exit animations use `transform` on `.krypton-window` (the parent). Since perspective is on the content container (a child), there is no conflict.

## Out of Scope

- Parallax on mouse movement (tilting the terminal on hover — possible future enhancement)
- Per-window perspective overrides
- Z-axis animations (layers sliding in/out on focus change)
- 3D window stacking (windows at different Z depths in the workspace)
