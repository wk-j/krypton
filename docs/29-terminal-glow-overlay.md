# Terminal Glow Overlays — Implementation Spec

> Status: Implemented
> Date: 2026-03-20 (updated 2026-03-22)

## Problem

Krypton's cyberpunk aesthetic benefits from subtle glow effects on terminal edges. Without them all terminal rows look identical — there is no visual depth or atmosphere near the edges of each pane.

## Solution

Add `.krypton-glow-overlay` elements inside each terminal wrapper — one at the top edge, one at the bottom — that create accent-tinted gradient glows over the first and last few rows. Both overlays use the per-window accent color, are purely cosmetic (no pointer events), and share a single `glow_intensity` config knob.

## Affected Files

| File | Change |
|------|--------|
| `src/styles.css` | `.krypton-glow-overlay` base + `--bottom` modifier rules |
| `src/compositor.ts` | Create top + bottom overlay elements in `createPane()` and Quick Terminal; set `--krypton-terminal-cell-height` and `--krypton-glow-intensity` CSS custom properties in `applyConfig()` |
| `src-tauri/src/config.rs` | `glow_intensity: f64` in `VisualConfig` (default `0.8`) |
| `src/config.ts` | `glow_intensity: number` in `VisualConfig` interface |

## Design

### CSS Custom Properties

```
--krypton-terminal-cell-height: <fontSize * lineHeight>px   (document root)
--krypton-glow-intensity: <0.0–3.0>                         (document root)
--krypton-window-accent-rgb: <r, g, b>                      (per window)
```

### Glow Overlays

Base class handles shared properties. The bottom modifier flips the gradient direction.

```css
.krypton-glow-overlay {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: calc(var(--krypton-terminal-cell-height, 17px) * 5 + 4px);
  background: linear-gradient(
    to bottom,
    rgba(var(--krypton-window-accent-rgb, 0, 200, 255), 0.35),
    transparent 100%
  );
  opacity: var(--krypton-glow-intensity, 0.8);
  mask-image: linear-gradient(to bottom, black 0%, transparent 100%);
  -webkit-mask-image: linear-gradient(to bottom, black 0%, transparent 100%);
  pointer-events: none;
  z-index: 12;
}

.krypton-glow-overlay--bottom {
  top: auto;
  bottom: 0;
  background: linear-gradient(
    to top,
    rgba(var(--krypton-window-accent-rgb, 0, 200, 255), 0.35),
    transparent 100%
  );
  mask-image: linear-gradient(to top, black 0%, transparent 100%);
  -webkit-mask-image: linear-gradient(to top, black 0%, transparent 100%);
}
```

### DOM Structure

Each terminal wrapper gets two overlay children:

```
.krypton-pane__terminal
  ├── .krypton-glow-overlay              (top)
  ├── .krypton-glow-overlay--bottom      (bottom)
  └── .xterm (terminal canvas)
```

Same structure for Quick Terminal's `.krypton-window__body`.

### Configurable Intensity

**Rust** (`VisualConfig`):
```rust
/// Glow brightness. 0.0 = off, 0.8 = default, higher = stronger.
pub glow_intensity: f64,
```

**TypeScript** (`VisualConfig`):
```typescript
glow_intensity: number;
```

**TOML:**
```toml
[visual]
glow_intensity = 0.8   # 0.0 = off, 3.0 = max. Default: 0.8
```

### Data Flow

1. Compositor `applyConfig()` reads `fontSize`, `lineHeight`, and `glow_intensity` from config
2. Sets `--krypton-terminal-cell-height` and `--krypton-glow-intensity` on document root
3. CSS uses `calc()` and `var()` to derive overlay height and opacity
4. Both top and bottom overlays render, matching the window's accent color
5. If `glow_intensity == 0`, overlays are hidden to avoid unnecessary compositing

### Hot-Reload

Config watcher triggers `config-changed` event → compositor calls `applyConfig()` → CSS custom properties update → overlays re-render automatically.

## Edge Cases

- **Font size change:** `--krypton-terminal-cell-height` updates in `applyConfig()`, overlay height adjusts via CSS `calc()`.
- **`glow_intensity = 0`:** Both overlays hidden entirely.
- **Negative values:** Clamped to `0.0`.
- **Very high values:** Clamped to `3.0`.
- **Missing field:** `serde(default)` provides `0.8`.
- **Short terminals (< 10 rows):** Top and bottom glows overlap in the middle. The blended gradient looks natural — no special handling needed.
- **Quick Terminal:** Gets the same pair of overlays.
- **Split panes:** Each pane gets its own independent pair.
- **Shader interaction:** Overlays are inside `.krypton-pane__terminal`, below the shader canvas. Layers correctly via z-index.

## Out of Scope

- Per-line glow tracking buffer content (decoration API)
- Glow color configuration (separate from accent)
- Glow height / row count configuration
- Per-window glow intensity
- Side (left/right) glow overlays
