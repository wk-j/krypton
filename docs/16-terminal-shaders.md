# Terminal Post-Processing Shaders — Implementation Spec

> Status: Implemented
> Date: 2026-03-11
> Milestone: M8 — Polish

## Problem

Krypton's cyberpunk aesthetic stops at the window chrome — the terminal content itself renders as plain text on a flat canvas. Post-processing shaders on the terminal surface would complete the visual identity (CRT scanlines, hologram glow, chromatic aberration, etc.) and differentiate Krypton from every other terminal emulator.

## Solution

Add a WebGL post-processing pipeline that reads the xterm.js canvas as a texture and renders it through fragment shaders onto a second canvas layered on top. Each window can have a different shader. Shaders are configurable per-window or globally via TOML config, hot-reloadable, and togglable at runtime via keyboard shortcut.

## Affected Files

| File | Change |
|------|--------|
| `src/shaders.ts` | **New** — shader engine: WebGL context, shader compilation, render loop, built-in presets |
| `src/compositor.ts` | Attach shader canvas to each pane after `terminal.open()`, wire resize/dispose |
| `src/input-router.ts` | Add `Leader g` to cycle shader preset on focused window |
| `src/config.ts` | Add `ShaderConfig` interface |
| `src/types.ts` | Add shader-related types to `Pane` |
| `src-tauri/src/config.rs` | Add `[shader]` TOML section |
| `src/styles.css` | Style for shader overlay canvas |
| `docs/06-configuration.md` | Document `[shader]` config keys |

## Design

### Data Structures

```typescript
// src/shaders.ts

type ShaderPreset = 'none' | 'crt' | 'hologram' | 'glitch' | 'bloom' | 'matrix';

interface ShaderConfig {
  enabled: boolean;          // master toggle (default: false)
  preset: ShaderPreset;      // global default preset (default: 'none')
  intensity: number;         // 0.0–1.0, controls effect strength (default: 0.5)
  animate: boolean;          // enable time-based animation (default: true)
  fps_cap: number;           // max render loop FPS (default: 30)
}

interface ShaderInstance {
  canvas: HTMLCanvasElement;
  gl: WebGLRenderingContext;
  program: WebGLProgram;
  sourceTexture: WebGLTexture;
  preset: ShaderPreset;
  animationId: number;       // requestAnimationFrame handle
}
```

```rust
// src-tauri/src/config.rs

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShaderConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_shader_preset")]
    pub preset: String,
    #[serde(default = "default_shader_intensity")]
    pub intensity: f64,
    #[serde(default = "default_true")]
    pub animate: bool,
    #[serde(default = "default_shader_fps")]
    pub fps_cap: u32,
}
```

### Shader Pipeline

Each pane gets its own shader pipeline, attached after `terminal.open()`:

```
xterm.js canvas (.xterm-screen canvas)
  ↓ readPixels / texImage2D (each frame)
Shader canvas (overlay, position: absolute, pointer-events: none)
  ↓ fragment shader (CRT, hologram, etc.)
Composited output (user sees shader canvas on top)
```

The original xterm.js canvas is hidden (`visibility: hidden`) when a shader is active. The shader canvas takes its place visually but passes all pointer events through.

### Fragment Shader Presets

**CRT** (`crt`)
- Scanlines: horizontal lines at every other row, darkened 15-30%
- Vignette: radial darkening from center (smooth falloff)
- Barrel distortion: slight curvature toward edges
- Phosphor glow: bloom on bright pixels
- Screen flicker: subtle brightness oscillation (~0.5Hz)

**Hologram** (`hologram`)
- Chromatic aberration: RGB channel offset (2-4px)
- Horizontal scan line sweeping downward
- Alpha flicker: random opacity pulses
- Blue-cyan tint shift

**Glitch** (`glitch`)
- RGB split: offset red/blue channels by random amounts
- Block displacement: random horizontal stripe offsets (triggered periodically)
- Noise overlay: occasional static bursts

**Bloom** (`bloom`)
- Bright pixel extraction (threshold)
- Gaussian blur on bright pixels
- Additive blend back onto original
- Enhances the cyberpunk glow aesthetic

**Matrix** (`matrix`)
- Green channel boost, red/blue reduction
- Subtle digital rain overlay (column-based falling characters)
- CRT scanlines (light)

### Render Loop

```
1. Check if source canvas has been updated (compare frame counter or use dirty flag)
2. If dirty:
   a. gl.texImage2D() — upload xterm canvas as texture
   b. Set uniforms: u_time, u_resolution, u_intensity, u_mouse (optional)
   c. gl.drawArrays() — render fullscreen quad through fragment shader
3. requestAnimationFrame() — capped to fps_cap (default 30)
```

Frame rate is capped to reduce GPU load. The loop pauses when the tab/pane is not visible (via `document.hidden` or IntersectionObserver).

### API

```typescript
// src/shaders.ts

class ShaderEngine {
  /** Attach shader pipeline to a pane's terminal canvas */
  attach(pane: HTMLElement, preset: ShaderPreset, intensity: number): ShaderInstance | null;

  /** Detach and dispose shader pipeline */
  detach(instance: ShaderInstance): void;

  /** Switch preset on a live instance (recompiles fragment shader) */
  setPreset(instance: ShaderInstance, preset: ShaderPreset): void;

  /** Update intensity uniform */
  setIntensity(instance: ShaderInstance, intensity: number): void;

  /** Pause/resume render loop */
  pause(instance: ShaderInstance): void;
  resume(instance: ShaderInstance): void;

  /** Check WebGL availability */
  static isSupported(): boolean;
}
```

### Data Flow

```
1. App starts → loadConfig() returns ShaderConfig
2. compositor.applyConfig() stores shader settings
3. createPane() calls terminal.open(el), then:
   a. If shaders enabled: shaderEngine.attach(el, preset, intensity)
   b. Shader canvas inserted as sibling of .xterm-screen, xterm canvas hidden
4. Render loop starts (RAF-capped), reads xterm canvas each frame
5. On resize: fitAddon.fit() fires → shader canvas resized to match
6. On preset cycle (Leader g): shaderEngine.setPreset() swaps fragment shader
7. On config hot-reload: compositor re-applies shader settings to all panes
8. On pane dispose: shaderEngine.detach() cleans up GL resources
```

### Keybindings

| Key | Context | Action |
|-----|---------|--------|
| `Leader g` | Compositor mode | Cycle shader preset on focused pane (none → crt → hologram → glitch → bloom → matrix → none) |
| `Leader G` | Compositor mode | Toggle shaders on/off globally |

### UI Changes

A shader overlay canvas is added as a sibling to `.xterm-screen` inside each `.krypton-pane`:

```html
<div class="krypton-pane">
  <div class="xterm">
    <div class="xterm-screen">
      <canvas class="xterm-link-layer" />   <!-- xterm internal -->
      <canvas />                              <!-- xterm render canvas (hidden when shader active) -->
    </div>
  </div>
  <canvas class="krypton-shader-canvas" />   <!-- NEW: shader output -->
</div>
```

CSS for the shader canvas:
```css
.krypton-shader-canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  z-index: 1;  /* above xterm canvas */
}
```

### Configuration

```toml
[shader]
enabled = false          # Master toggle
preset = "none"          # Default preset: none, crt, hologram, glitch, bloom, matrix
intensity = 0.5          # Effect strength 0.0–1.0
animate = true           # Enable time-based animation
fps_cap = 30             # Max shader render FPS
```

## Edge Cases

- **WebGL unavailable**: `ShaderEngine.isSupported()` returns false → skip shader attachment entirely, no error. Log once.
- **Multiple panes in split**: each pane gets its own shader instance independently.
- **Quick Terminal**: receives the same shader treatment as regular panes.
- **Canvas not ready**: `terminal.open()` may not create the canvas synchronously. Use MutationObserver on `.xterm-screen` to detect canvas insertion, then attach shader.
- **Window/pane resize**: shader canvas and GL viewport must resize when `fitAddon.fit()` fires. Listen to ResizeObserver on the pane element.
- **Tab switch**: pause shader render loop for hidden panes, resume on focus.
- **Performance**: if frame time exceeds budget (33ms at 30fps), reduce fps_cap or disable animation. Consider a performance budget check on first attach.
- **Shader compilation failure**: fall back to `none` preset, log error.
- **Hot-reload**: changing `[shader]` in TOML should apply immediately to all active panes.

## Open Questions

None — all design decisions are resolved.

## Out of Scope

- Custom user-authored GLSL shaders loaded from disk (future: `~/.config/krypton/shaders/*.glsl`)
- Per-window shader assignment via config (future: `[[windows]]` table)
- Mouse interaction with shader effects (e.g., ripple at cursor position)
- Compute shaders or WebGPU (stick to WebGL 1 for compatibility)
