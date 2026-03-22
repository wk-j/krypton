# Configurable Glow Intensity — Implementation Spec

> Status: Implemented
> Date: 2026-03-22

## Problem

The terminal top-line glow overlay has a hardcoded brightness value (`1.8`). Users who want a subtler or stronger glow effect must edit CSS source code. This should be a simple TOML config knob under `[visual]`.

## Solution

Add a `glow_intensity` field to `VisualConfig` (Rust + TypeScript), expose it as a CSS custom property `--krypton-glow-intensity`, and use it in the existing `.krypton-glow-overlay` rule. A value of `0.0` disables the glow entirely.

## Affected Files

| File | Change |
|------|--------|
| `src-tauri/src/config.rs` | Add `glow_intensity: f64` to `VisualConfig` with default `0.8` |
| `src/config.ts` | Add `glow_intensity: number` to `VisualConfig` interface |
| `src/compositor.ts` | Set `--krypton-glow-intensity` CSS custom property in `applyConfig()` |
| `src/styles.css` | Replace hardcoded `brightness(1.8)` with `brightness(calc(1 + var(--krypton-glow-intensity, 0.8)))` |
| `docs/06-configuration.md` | Document the new field |
| `docs/29-terminal-glow-overlay.md` | Update status to note configurability |

## Design

### Config Field

**Rust** (`VisualConfig`):
```rust
/// Top-line glow brightness boost. 0.0 = off, 0.8 = default, higher = stronger.
pub glow_intensity: f64,
```
Default: `0.8` (preserves current `brightness(1.8)` = `1 + 0.8`).

**TypeScript** (`VisualConfig`):
```typescript
glow_intensity: number;
```

### Data Flow

1. User sets `glow_intensity = 0.4` in `~/.config/krypton/krypton.toml` under `[visual]`
2. Rust deserializes into `VisualConfig.glow_intensity`
3. Frontend receives config via `get_config` IPC
4. `applyConfig()` clamps value to `[0.0, 3.0]` and sets `--krypton-glow-intensity` on document root
5. CSS `brightness(calc(1 + var(--krypton-glow-intensity, 0.8)))` updates the glow
6. If `glow_intensity == 0`, set overlay `display: none` via a class or direct property to avoid unnecessary compositing

### CSS Change

```css
.krypton-glow-overlay {
  /* ... existing rules ... */
  -webkit-backdrop-filter: blur(3px) brightness(calc(1 + var(--krypton-glow-intensity, 0.8)));
  backdrop-filter: blur(3px) brightness(calc(1 + var(--krypton-glow-intensity, 0.8)));
}
```

### Configuration

```toml
[visual]
glow_intensity = 0.8   # Top-line glow brightness boost (0.0 = off, 3.0 = max).
                        # Default: 0.8. Recommended range: 0.3–1.5
```

### Hot-Reload

Already handled — the config watcher triggers `config-changed` event, compositor calls `applyConfig()`, CSS custom property updates, and the overlay re-renders automatically.

## Edge Cases

- **`glow_intensity = 0`**: Hide the overlay entirely to avoid a pointless compositing layer.
- **Negative values**: Clamp to `0.0`.
- **Very high values**: Clamp to `3.0` (brightness 4.0 is already blown out).
- **Missing field**: `serde(default)` provides `0.8`, matching current hardcoded behavior.

## Out of Scope

- Glow color configuration (separate feature, would need per-window override)
- Glow height / number of rows configuration
- Per-window glow intensity
