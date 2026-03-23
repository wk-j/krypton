# Configurable Background Animations — Implementation Spec

> Status: Implemented
> Date: 2026-03-23
> Milestone: N/A — Visual enhancement

## Problem

The flame wave animation is hardcoded as the only background animation when Claude Code is processing. The user wants multiple animation styles (starting with a "brainwave" EEG-style animation) and the ability to choose which one runs via the TOML config file.

## Solution

Introduce a `BackgroundAnimation` interface that both `FlameAnimation` and the new `BrainwaveAnimation` implement. Add an `animation` field to `[hooks]` in the TOML config. The `ClaudeHookManager` reads the config value and instantiates the correct animation class. The existing lifecycle (start/stop/resize/dispose) stays unchanged — only the factory switches.

## Affected Files

| File | Change |
|------|--------|
| `src/flame.ts` | Extract `BackgroundAnimation` interface, `FlameAnimation` implements it |
| `src/brainwave.ts` | **New** — `BrainwaveAnimation` class implementing `BackgroundAnimation` |
| `src/claude-hooks.ts` | Read config `animation` field, instantiate correct class in `createFlameCanvas()` |
| `src-tauri/src/config.rs` | Add `animation: String` field to `HooksConfig` |
| `src/styles.css` | Add `.krypton-brainwave-canvas` class (same positioning as flame) |

## Design

### Data Structures

**`src/flame.ts` — shared interface:**

```typescript
/** Common interface for all background animations */
export interface BackgroundAnimation {
  getElement(): HTMLCanvasElement;
  start(): void;
  stop(): void;
  resize(): void;
  dispose(): void;
  isRunning(): boolean;
}
```

`FlameAnimation` already satisfies this shape — just add `implements BackgroundAnimation`.

**`src/brainwave.ts` — new class:**

```typescript
export class BrainwaveAnimation implements BackgroundAnimation {
  // Same public API as FlameAnimation
  // Renders 4-5 horizontal EEG-like waveforms with varying frequencies
  // Color palette: cyan/teal/blue (neural/electric feel)
  // Waves drift left-to-right with organic noise modulation
}
```

**Brainwave visual design:**
- 5 horizontal wave channels evenly spaced vertically (like an EEG readout)
- Each channel: base sine wave + higher-frequency noise bursts (simulating alpha/beta/gamma brain rhythms)
- Color palette: `rgba(0,255,200,...)` (cyan), `rgba(0,180,255,...)` (blue), `rgba(120,80,255,...)` (purple)
- Subtle glow pass on each wave (same technique as flame waves)
- Occasional "spike" events — random amplitude bursts that travel along the wave
- Canvas opacity when active: `0.20` (slightly more subtle than flame since waves are brighter colors)
- No particles — waves only

### Configuration

New field in `[hooks]` section of `krypton.toml`:

```toml
[hooks]
animation = "flame"   # "flame" | "brainwave" | "none"
```

**Rust struct change:**

```rust
pub struct HooksConfig {
    pub enabled: bool,
    pub port: u16,
    pub show_toasts: bool,
    pub max_toasts: usize,
    pub animation: String,  // NEW — "flame", "brainwave", or "none"
}
// Default: "flame" (preserves current behavior)
```

### Data Flow

```
1. App starts → Rust loads config → frontend calls get_config()
2. ClaudeHookManager reads config.hooks.animation value
3. On createFlameCanvas(): match animation value →
   - "flame" → new FlameAnimation()
   - "brainwave" → new BrainwaveAnimation()
   - "none" → returns null (no canvas inserted)
4. Start/stop/resize iterate the Set<BackgroundAnimation> as before
5. On config hot-reload: if animation value changed →
   dispose all current animations, re-create with new type
```

### Hot-Reload

When `config-changed` fires and the `animation` field differs from current:
1. Stop and dispose all existing animation instances
2. Clear the `flames` set (rename to `animations`)
3. For each window, create a new animation canvas and insert it
4. If Claude is currently active, immediately start the new animations

## Edge Cases

- **`animation = "none"`**: No canvas created, `createFlameCanvas()` returns `null`. Compositor checks for null before `appendChild`.
- **Invalid value**: Treat any unrecognized string as `"flame"` (backward compatible default).
- **Hot-reload during active animation**: Stop old animation, dispose, create new type, start immediately if Claude session is active.
- **Config missing `animation` field**: Serde default `"flame"` — zero breakage for existing users.

## Out of Scope

- Animation-specific config tuning (speed, color, intensity per animation type) — can be added later as sub-tables.
- Custom user-written animations or plugin system.
- Per-window animation selection.
