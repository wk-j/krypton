# Quick Terminal Animation Styles — Implementation Spec

> Status: Implemented
> Date: 2026-03-23
> Milestone: Polish

## Problem

The Quick Terminal has a single hardcoded 3D float animation for show/hide. The config already has an `animation` field (defaulting to `"slide"`) but it's ignored. Users should be able to choose from multiple animation styles.

## Solution

Implement 5 animation styles for the Quick Terminal show/hide transition, selectable via `[quick_terminal] animation` in the TOML config. Each style uses WAAPI keyframes with the existing `animationDuration` timing.

## Affected Files

| File | Change |
|------|--------|
| `src/compositor.ts` | Replace hardcoded animation with style-dispatching logic in `showQuickTerminal()` / `hideQuickTerminal()` |
| `src/types.ts` | Add `QuickTerminalAnimation` enum and `animation` field to `QuickTerminalConfig` |
| `src-tauri/src/config.rs` | Already has `animation: String` — no change needed |

## Design

### Animation Styles

| Value | Show | Hide |
|-------|------|------|
| `"slide"` (default) | Slides down from top of screen | Slides up off-screen |
| `"float"` | Current 3D perspective float-in (rotateX + translateZ) | 3D float-out (current behavior) |
| `"fade"` | Fade in with slight scale-up (0.96 → 1.0) | Fade out with slight scale-down |
| `"glitch"` | Rapid clip-path slices revealing the terminal | Clip-path slices collapsing |
| `"none"` | Instant show (no animation) | Instant hide |

### Data Structures

```typescript
// types.ts
type QuickTerminalAnimation = 'slide' | 'float' | 'fade' | 'glitch' | 'none';

interface QuickTerminalConfig {
  widthRatio: number;
  heightRatio: number;
  backdropBlur: number;
  animationDuration: number;
  animation: QuickTerminalAnimation;  // new field
}
```

### Data Flow

1. User sets `animation = "glitch"` in `[quick_terminal]` config
2. Rust backend loads string, sends to frontend via `get_config`
3. `Compositor.applyConfig()` maps the string to `qtConfig.animation`
4. `showQuickTerminal()` / `hideQuickTerminal()` dispatch on `qtConfig.animation` to pick WAAPI keyframes
5. Each style returns `Keyframe[]` pairs — compositor calls `element.animate()` with them

### Animation Details

**slide**: Classic Quake-style drop-down.
- Show: `translateY(-100%) → translateY(0)` with `cubic-bezier(0.22, 0.61, 0.36, 1)`
- Hide: `translateY(0) → translateY(-100%)` with `cubic-bezier(0.4, 0, 1, 1)`

**float**: Current 3D behavior (preserved as-is).
- Show: `perspective(800px) rotateX(16deg) translateZ(-60px) translateY(-40px) opacity:0` → resting
- Hide: reverse

**fade**: Subtle scale + opacity.
- Show: `opacity:0 scale(0.96)` → `opacity:1 scale(1)` with ease-out
- Hide: reverse with ease-in

**glitch**: Cyberpunk reveal using `clip-path` slices.
- Show: 4-step keyframes cycling through horizontal clip-path bands, ending at `inset(0)`
- Hide: reverse — full → sliced → gone

**none**: No animation, instant toggle.

### Configuration

Existing TOML key — no config changes needed:

```toml
[quick_terminal]
animation = "slide"   # slide | float | fade | glitch | none
```

## Edge Cases

- **Invalid config value**: Fall back to `"slide"` (same pattern as background animation normalization)
- **Animation cancelled mid-flight** (rapid toggle): Existing try/catch on `anim.finished` handles this
- **`none` style**: Skip `element.animate()` entirely, just toggle visibility class

## Out of Scope

- Per-show/per-hide independent styles (e.g., slide in, fade out)
- Custom user-defined keyframes
- Sound changes per animation style
