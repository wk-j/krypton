# 3D Perspective Depth — Implementation Spec

> Status: Implemented
> Date: 2026-03-15 (direction support added 2026-03-16)
> Milestone: M8 — Polish

## Problem

When a terminal window has multiple layers stacked on the content area (panes, shader overlays, progress gauge, selection cursor), they all render flat on top of each other. There is no visual sense of depth — layers feel like paint on glass rather than physical sheets at different distances.

## Solution

Apply CSS `perspective` on the `.krypton-window__perspective` wrapper and use `translateZ()` on internal layers to push them to different depths along the Z axis. This creates a subtle 3D parallax where the terminal text sits at the back, overlays float slightly above it, and interactive elements like the selection cursor feel nearest to the viewer. The effect is cosmetic — it does not change layout, hit-testing, or functionality.

Two independent tilt angles (`perspective_tilt_x` and `perspective_tilt_y`) control rotation around the X and Y axes respectively, allowing top/bottom lean, left/right lean, or diagonal tilt. Negative values reverse the direction on either axis.

A `[visual]` config section controls the effect. When `perspective_depth` is `0`, all `translateZ` values collapse to zero (flat rendering).

## Affected Files

| File | Change |
|------|--------|
| `src/styles.css` | `perspective` on wrapper, `transform-style: preserve-3d` + `rotateX`/`rotateY` on content, `translateZ()` on layered elements |
| `src/compositor.ts` | Read `visual.perspective_depth`, `perspective_tilt_x`, `perspective_tilt_y` from config; set CSS custom properties |
| `src/config.ts` | `VisualConfig` interface with `perspective_depth`, `perspective_tilt_x`, `perspective_tilt_y` |
| `src-tauri/src/config.rs` | `VisualConfig` struct with same fields; `#[serde(alias = "perspective_tilt")]` on `tilt_x` for backward compat |
| `docs/06-configuration.md` | `[visual]` TOML reference |

## Design

### Data Structures

**Rust (`config.rs`):**

```rust
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct VisualConfig {
    pub perspective_depth: u16,    // px, 0 = disabled
    #[serde(alias = "perspective_tilt")]
    pub perspective_tilt_x: f64,   // degrees, X-axis rotation (top/bottom)
    pub perspective_tilt_y: f64,   // degrees, Y-axis rotation (left/right)
    pub opacity: f64,
    pub blur: u32,
}

impl Default for VisualConfig {
    fn default() -> Self {
        Self {
            perspective_depth: 800,
            perspective_tilt_x: 2.0,
            perspective_tilt_y: 0.0,
            opacity: 0.5,
            blur: 12,
        }
    }
}
```

**TypeScript (`config.ts`):**

```typescript
export interface VisualConfig {
  perspective_depth: number;  // px, 0 = disabled
  perspective_tilt_x: number; // degrees, X-axis rotation (top/bottom)
  perspective_tilt_y: number; // degrees, Y-axis rotation (left/right)
  opacity: number;
  blur: number;
}
```

### API / Commands

No new commands. Values flow through the existing `get_config` command and config hot-reload event.

### Data Flow

```
1. Config loads with visual.perspective_depth = 800,
   perspective_tilt_x = 2.0, perspective_tilt_y = 0.0
2. Compositor reads values, sets CSS custom properties on workspace:
   --krypton-perspective: 800px
   --krypton-perspective-tilt-x: 2deg
   --krypton-perspective-tilt-y: 0deg
3. .krypton-window__perspective provides the perspective origin
4. .krypton-window__content uses transform-style: preserve-3d and
   transform: rotateX(var(--tilt-x)) rotateY(var(--tilt-y))
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
# Recommended range: 400–1200
perspective_depth = 800

# X-axis tilt (top/bottom lean). Default: 2.0
# Recommended range: 1–6. Negative reverses direction.
perspective_tilt_x = 2.0

# Y-axis tilt (left/right lean). Default: 0.0
# Recommended range: 1–6. Negative reverses direction.
perspective_tilt_y = 0.0

# Negative values reverse direction:
#   perspective_tilt_x = -2.0  → bottom recedes, top comes forward
#   perspective_tilt_y = -1.5  → right recedes, left comes forward
```

### UI Changes

**CSS — perspective wrapper (isolates 3D context from backdrop-filter):**

```css
.krypton-window__perspective {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  perspective: var(--krypton-perspective, none);
}
```

**CSS — content container with dual-axis tilt:**

```css
.krypton-window__content {
  transform-style: preserve-3d;
  transform: rotateX(var(--krypton-perspective-tilt-x, 0deg))
             rotateY(var(--krypton-perspective-tilt-y, 0deg));
}
```

**CSS — child layers at fixed Z offsets:**

```css
.krypton-pane .xterm-screen {
  transform: translateZ(0);
}

.krypton-progress-gauge {
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

**Quick Terminal:** Same treatment — perspective wrapper isolates the 3D context, content area gets `preserve-3d` and dual-axis tilt.

**Compositor — setting custom properties on config load and hot-reload:**

```typescript
const tiltX = config.visual.perspective_tilt_x ?? 0;
const tiltY = config.visual.perspective_tilt_y ?? 0;
this.workspace.style.setProperty(
  '--krypton-perspective',
  depth > 0 ? `${depth}px` : 'none'
);
this.workspace.style.setProperty(
  '--krypton-perspective-tilt-x',
  depth > 0 && tiltX !== 0 ? `${tiltX}deg` : '0deg'
);
this.workspace.style.setProperty(
  '--krypton-perspective-tilt-y',
  depth > 0 && tiltY !== 0 ? `${tiltY}deg` : '0deg'
);
```

## Edge Cases

1. **`perspective_depth = 0`**: CSS `perspective: none` and both tilts `0deg` — `translateZ` values are ignored, rendering is flat. Zero performance cost.
2. **Both tilts = 0**: Equivalent to flat rendering. `rotateX(0deg) rotateY(0deg)` is an identity transform.
3. **Old config with `perspective_tilt`**: The `#[serde(alias)]` on the Rust side maps it to `perspective_tilt_x`. The old key continues to work.
4. **Negative values**: Both axes support negative values to reverse direction. CSS `rotateX(-2deg)` works natively.
5. **WebGL addon**: xterm.js uses a canvas element. `translateZ` on the canvas's parent (`.xterm-screen`) works in all browsers with hardware acceleration.
6. **Pane splits**: Split containers don't need `translateZ` — only their leaf children (panes, dividers) do. `preserve-3d` propagates through the flex tree.
7. **Performance**: CSS `perspective` and `translateZ` are GPU-composited. No repaints, no layout thrashing. The layers already have `will-change` or `position: absolute`.
8. **Overflow clipping**: `overflow: hidden` on `.krypton-window__content` still clips in the XY plane. Z-axis elements extending toward the viewer are not clipped, which is the desired behavior.
9. **Hot-reload**: Changing any perspective value in TOML instantly updates the CSS custom properties via the existing config watcher. No restart needed.
10. **Very small perspective values** (e.g., 50): Creates extreme foreshortening. Values below 200 produce unreasonable distortion. Recommended range: 400-1200.
11. **Extreme Y tilt**: Large `rotateY` values (>10) can make text unreadable. Same recommended range as X: 1-6 degrees.
12. **Interactions with window animations**: Window morph/entrance/exit animations use `transform` on `.krypton-window` (the parent). Since perspective is on the content container (a child), there is no conflict.

## Out of Scope

- Parallax on mouse movement (tilting the terminal on hover)
- Per-window perspective/tilt overrides
- Z-axis animations (layers sliding in/out on focus change)
- 3D window stacking (windows at different Z depths in the workspace)
- Animated tilt transitions on config change
