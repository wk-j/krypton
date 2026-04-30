# 70. Variable Font & OpenType Feature Support — Implementation Spec

> Status: Approved
> Date: 2025-07-11
> Milestone: N/A — Feature Enhancement

## Problem

Krypton's font configuration (`[font]` in `krypton.toml`) supports only `family`, `size`, `line_height`, and `ligatures`. Modern variable fonts like [Recursive](https://github.com/arrowtype/recursive), [Fira Code](https://github.com/tonsky/Fira-Code), [JetBrains Mono](https://www.jetbrains.com/lp/mono/), and [Monaspace](https://monaspace.githubnext.com/) expose OpenType features (stylistic sets, character variants, tabular figures) and variable axes (weight, width, slant, custom axes like Recursive's `MONO` and `CRSV`). Users cannot control any of these, so variable fonts are restricted to their default instances.

## Solution

Add two new config fields under `[font]`:

1. **`features`** — an array of OpenType feature tags with optional sign prefix (e.g., `["ss01", "cv02", "-liga"]`). Bare tags enable the feature (`"tag" 1`), `-` prefix disables it (`"tag" 0`). Applied via `font-feature-settings` CSS.
2. **`axes`** — a map of variable font axis tags to numeric values (e.g., `{ MONO = 1.0, wght = 450, CRSV = 0 }`). Applied via `font-variation-settings` CSS.

Both are read from config at startup, built into CSS custom properties set on `document.documentElement`, and consumed by all chrome elements and xterm.js's WebGL texture atlas via CSS inheritance. The `ligatures` field is deprecated in favor of the `features` system.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Config structure | Flat under `[font]` | `features` as array, `axes` as map — no nesting needed |
| Feature enable/disable | Sign-prefixed: bare `ss01` = enable, `-liga` = disable | Full control without changing data structure |
| `ligatures` field | Soft deprecated | Still parsed; if `false`, caller prepends `-liga -calt` to features |
| Chrome application | Yes — chrome inherits terminal font settings | One delivery mechanism for everything |
| Axis value validation | None — browser clamps automatically | No duplicate work |
| Hot reload | No — restart required | Simplest, matches Kitty/Alacritty behavior |
| Empty defaults on flush | Serialize all fields (existing pattern) | Consistency with rest of config |
| Tag validation | Warn-only in Rust for non-4-char tags (after stripping prefix) | Helps debugging, doesn't block |
| CSS delivery | Custom properties on `:root` only, no inline styles | One mechanism, inherited via cascade |
| `acp.css` hardcoded `tnum` | Keep as-is, no composition | Only affects two numeric elements |
| Ordering | Preserve user ordering, no dedup | Pass-through to CSS |
| TOML axes syntax | Both inline and nested supported | TOML parses identically, show both in docs |
| Rust `axes` type | `BTreeMap<String, f64>` | Deterministic serialization |
| Rust `features` type | `Vec<String>` | Parse in frontend |
| TS types | Plain `string[]` / `Record<string, number>` | No branded types |
| Utility extraction | `src/font-settings.ts` with pure functions | Testable, caller handles ligatures migration |
| Float precision | Round to 4 decimal places | Removes float artifacts |
| Debug output | Console log resolved CSS values on startup | Zero UI overhead |
| Case normalization | None — user must match font's exact tags | Any normalization breaks something |
| Error handling | Fail fast on bad TOML (existing behavior) | No special-case logic |
| Theme overrides | Document convention: themes should not override `--krypton-font-*` | Social contract, not `!important` |
| Quick Terminal | No special handling | Inherits via DOM cascade |
| Empty return values | Return empty string, caller skips setting property | Browser defaults apply implicitly |

## Research

### How Variable Fonts Work (CSS)

- `font-variation-settings`: accepts one or more 4-character axis tags + float value, e.g. `'wght' 450, 'MONO' 1.0`.
- `font-feature-settings`: accepts one or more 4-character feature tags + integer (0 or 1), e.g. `"ss01" 1, "tnum" 1`.
- The browser applies these when rasterizing text. Variable axes interpolate glyph shapes; feature tags toggle alternate glyphs.

### xterm.js Compatibility

- **xterm.js WebGL renderer** (`@xterm/addon-webgl`) draws glyphs to an offscreen canvas (`TextureAtlas.ts`). The canvas is **appended to the DOM** specifically to inherit `font-feature-settings` from parent elements (line 439: *"Attach the canvas to the DOM in order to inherit font-feature-settings from the parent elements. This is necessary for ligatures and variants to work."*).
- This means setting `font-variation-settings` and `font-feature-settings` on the terminal container element will propagate to the WebGL glyph rasterizer.
- xterm.js does **not** expose native API for font features or variation axes — CSS inheritance is the only mechanism.
- `fontWeight` and `fontWeightBold` options in xterm.js map to CSS `font-weight`, which for variable fonts resolves through `font-variation-settings` if the `wght` axis is present.

### Recursive Font Axes (Reference Implementation)

| Axis | Tag | Range | Description |
|------|-----|-------|-------------|
| Weight | `wght` | 300–1000 | Standard CSS weight axis |
| Width | `wdth` | 75–125 | Normalized percentage |
| Monospace | `MONO` | 0–1 | 0 = proportional, 1 = monospaced |
| Cursive | `CRSV` | 0–1 | 0 = normal, 0.5 = handwritten, 1 = cursive |
| Slant | `slnt` | 0 to -15 | Automatic italic angle |

Recursive also exposes OpenType features: `ss01`–`ss07` (stylistic sets), `cv01`–`cv06` (character variants).

### Market Comparison

| Terminal | Font Features | Variable Axes | Config Format |
|----------|--------------|---------------|---------------|
| **Kitty** | `font_features` (HarfBuzz) | Limited via `modify_font` | `font_features FamilyName +ss01 -liga` |
| **WezTerm** | `harfbuzz_features` | Per-weight `font` objects | `{ harfbuzz_features = { "calt=1", "ss01=1" } }` |
| **Alacritty** | None (style-based only) | Named instances only (`style = "Light"`) | `[font.normal] style = "Light"` |
| **iTerm2** | Checkbox UI per feature | Slider UI for axes | GUI preferences |
| **VS Code** | `"editor.fontLigatures"` | `"editor.fontVariations"` | JSON settings |

**Krypton's approach**: TOML-based declarative config, matching Kitty/WezTerm's power with a simpler syntax. No GUI needed — keyboard-first.

### Existing Codebase Integration Points

1. **Rust `FontConfig`** (`src-tauri/src/config.rs`): Add `features: Vec<String>` and `axes: BTreeMap<String, f64>`.
2. **TypeScript `FontConfig`** (`src/config.ts`): Mirror the Rust types.
3. **Font settings utility** (`src/font-settings.ts`): New file with `buildFeatureSettings()` and `buildVariationSettings()`.
4. **Compositor `applyConfig()`** (`src/compositor.ts`): Handle ligatures migration, call utilities, set CSS custom properties on `document.documentElement`, console log on startup.
5. **CSS** (`src/styles/base.css`): Use `var(--krypton-font-feature-settings)` and `var(--krypton-font-variation-settings)` on root element.
6. **Config docs** (`docs/06-configuration.md`): Document new fields.

## Implementation Plan

### Phase 1: Config Schema (Rust + TypeScript)

**Files changed**: `src-tauri/src/config.rs`, `src/config.ts`

Add two fields to `FontConfig`:

```rust
// Rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct FontConfig {
    #[serde(deserialize_with = "deserialize_font_family")]
    pub family: Vec<String>,
    pub size: f64,
    pub line_height: f64,
    pub ligatures: bool,
    /// OpenType feature tags with optional sign prefix, e.g. ["ss01", "cv02", "-liga"].
    /// Bare tag = enable ("tag" 1), - prefix = disable ("tag" 0).
    /// Each tag is a 4-character string (after stripping optional prefix).
    pub features: Vec<String>,
    /// Variable font axes, e.g. { MONO = 1.0, wght = 450, CRSV = 0.5 }.
    /// Keys are 4-character axis tags. Rendered as `font-variation-settings: 'MONO' 1.0, 'wght' 450, ...`.
    pub axes: BTreeMap<String, f64>,
}
```

Defaults: `features: vec![]`, `axes: BTreeMap::new()`.

Warn-only validation on parse — check each feature tag (after stripping optional `-`/`+` prefix) and each axis key is exactly 4 characters:

```rust
impl FontConfig {
    pub fn validate(&self) {
        for f in &self.features {
            let tag = if f.starts_with('-') || f.starts_with('+') { &f[1..] } else { f };
            if tag.len() != 4 {
                log::warn!("Font feature tag '{}' is not 4 characters (got {})", tag, tag.len());
            }
        }
        for key in self.axes.keys() {
            if key.len() != 4 {
                log::warn!("Font axis tag '{}' is not 4 characters (got {})", key, key.len());
            }
        }
    }
}
```

```typescript
// TypeScript
export interface FontConfig {
  family: string[];
  size: number;
  line_height: number;
  ligatures: boolean;
  features: string[];           // e.g. ["ss01", "cv02", "-liga"]
  axes: Record<string, number>; // e.g. { "MONO": 1.0, "wght": 450 }
}
```

### Phase 2: Font Settings Utility (TypeScript)

**New file**: `src/font-settings.ts`

Pure functions for building CSS values from config:

```typescript
/**
 * Build a `font-feature-settings` CSS value from an array of feature tags.
 * Bare tags are enabled ("tag" 1), -prefixed tags are disabled ("tag" 0).
 * Returns empty string when no features are specified.
 */
export function buildFeatureSettings(features: string[]): string {
  if (features.length === 0) return '';

  const parts: string[] = [];
  for (const raw of features) {
    if (raw.startsWith('-')) {
      const tag = raw.slice(1);
      parts.push(`"${tag}" 0`);
    } else {
      const tag = raw.startsWith('+') ? raw.slice(1) : raw;
      parts.push(`"${tag}" 1`);
    }
  }
  return parts.join(', ');
}

/**
 * Build a `font-variation-settings` CSS value from an axes map.
 * Float values are rounded to 4 decimal places to remove artifacts.
 * Returns empty string when no axes are specified.
 */
export function buildVariationSettings(axes: Record<string, number>): string {
  const entries = Object.entries(axes);
  if (entries.length === 0) return '';

  return entries
    .map(([tag, value]) => `'${tag}' ${parseFloat(value.toFixed(4))}`)
    .join(', ');
}
```

### Phase 3: CSS Custom Properties (Frontend)

**Files changed**: `src/compositor.ts`

In `applyConfig()`, handle ligatures migration, call utilities, and set CSS custom properties:

```typescript
import { buildFeatureSettings, buildVariationSettings } from './font-settings';

// In applyConfig():

// Build effective features array, handling deprecated ligatures field
let effectiveFeatures = [...config.font.features];
if (config.font.ligatures === false) {
  effectiveFeatures = ['-liga', '-calt', ...effectiveFeatures];
}

const featureSettings = buildFeatureSettings(effectiveFeatures);
const variationSettings = buildVariationSettings(config.font.axes);

// Set CSS custom properties on :root
if (featureSettings) {
  document.documentElement.style.setProperty(
    '--krypton-font-feature-settings',
    featureSettings
  );
} else {
  document.documentElement.style.removeProperty('--krypton-font-feature-settings');
}

if (variationSettings) {
  document.documentElement.style.setProperty(
    '--krypton-font-variation-settings',
    variationSettings
  );
} else {
  document.documentElement.style.removeProperty('--krypton-font-variation-settings');
}

// Debug log
console.log(
  'Font settings:',
  featureSettings ? `font-feature-settings: ${featureSettings}` : '(defaults)',
  variationSettings ? `font-variation-settings: ${variationSettings}` : '(defaults)'
);
```

### Phase 4: CSS Application

**Files changed**: `src/styles/base.css`

Add font settings to the root element so all children inherit:

```css
/* Variable font and OpenType feature support — inherited by all chrome and terminals */
:root {
  font-variation-settings: var(--krypton-font-variation-settings, normal);
  font-feature-settings: var(--krypton-font-feature-settings, normal);
}
```

This is the only CSS change needed. All elements using `--krypton-font-family` (15 CSS files) inherit these settings automatically through the DOM cascade. The `acp.css` hardcoded `font-feature-settings: "tnum" 1` on `.acp-view__tool-counts` and `.acp-view__session-id` remains unchanged — those two numeric elements use tnum regardless of user config.

### Phase 5: Documentation

**Files changed**: `docs/06-configuration.md`

Add to `[font]` section reference:

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `[font]` `features` | string[] | `[]` | OpenType feature tags. Bare tags enable (`"ss01"`), `-` prefix disables (`"-liga"`). Each tag is 4 characters. Applied as `font-feature-settings`. Example: `["ss01", "cv02", "-liga"]` |
| `[font]` `axes` | table | `{}` | Variable font axes. Keys are 4-character axis tags, values are floats. Applied as `font-variation-settings`. Example: `{ MONO = 1.0, wght = 450 }` |
| `[font]` `ligatures` | bool | `true` | **Deprecated** — use `features = ["-liga", "-calt"]` instead. Still works, will be prepended to `features` when `false`. |

Add a "Variable Font Examples" subsection:

```toml
# Recursive — monospace with casual handwriting
[font]
family = "Recursive Mono"
size = 14.0
features = ["ss01", "cv02"]
axes = { MONO = 1.0, CRSV = 0.5, wght = 450 }

# Recursive — axes as nested table (equivalent)
[font]
family = "Recursive Mono"
size = 14.0
features = ["ss01", "cv02"]

[font.axes]
MONO = 1.0
CRSV = 0.5
wght = 450

# JetBrains Mono — enable stylistic alternates
[font]
family = "JetBrains Mono"
features = ["cv02", "cv16", "ss01"]

# Fira Code — stylistic set for arrows, disable ligatures
[font]
family = "Fira Code"
features = ["ss02", "ss03", "-liga", "-calt"]
```

Add a note to the theme specification (`docs/10-theme-specification.md`):

> Themes should not override `--krypton-font-feature-settings` or `--krypton-font-variation-settings` custom properties. These are controlled by user config and applied globally.

## Files Changed

| File | Change |
|------|--------|
| `src-tauri/src/config.rs` | Add `features: Vec<String>` and `axes: BTreeMap<String, f64>` to `FontConfig`, add warn-only validation for 4-char tags |
| `src/config.ts` | Add `features: string[]` and `axes: Record<string, number>` to `FontConfig` interface |
| `src/font-settings.ts` | **New file** — `buildFeatureSettings()` and `buildVariationSettings()` pure utility functions |
| `src/compositor.ts` | Handle ligatures migration, call utilities, set/remove CSS custom properties, console log on startup |
| `src/styles/base.css` | Add `font-variation-settings` and `font-feature-settings` with CSS vars on `:root` |
| `docs/06-configuration.md` | Document `features`, `axes`, deprecated `ligatures`, examples |
| `docs/10-theme-specification.md` | Add note: themes should not override font settings custom properties |

## Edge Cases

1. **Non-variable font with features/axes set**: `font-variation-settings` with unrecognized axes is ignored by the browser — no visual effect, no error. Same for unknown feature tags. Safe no-op.
2. **Empty config**: `features = []` and `axes = {}` produce empty CSS strings, custom properties are removed, browser defaults apply. No behavior change for existing users.
3. **Ligatures interaction**: When `ligatures = false`, the caller prepends `-liga -calt` to the features array. When `ligatures = true` (default), no implicit features are added. The `features` array has full control.
4. **Config flush**: New fields serialize as `features = []` and `axes = {}` (empty table), matching the existing pattern of serializing all fields.
5. **WebGL glyph atlas**: The atlas canvas inherits from DOM. CSS custom properties on `:root` cascade to the terminal container, then to the atlas canvas. No per-pane logic needed.
6. **Quick Terminal**: Inherits via normal DOM cascade from `:root`. No special handling.
7. **Sign-prefixed features**: `"-liga"` → `"liga" 0`, `"ss01"` → `"ss01" 1`, `"+cv02"` → `"cv02" 1`. The `+` prefix is accepted but optional.
8. **Duplicate/conflicting features**: Preserved as-is, pass-through to CSS. Last value wins per CSS spec.

## Risks

| Risk | Mitigation |
|------|-----------|
| xterm.js WebGL atlas doesn't respect `font-variation-settings` | The atlas inherits from DOM — verified in source (TextureAtlas.ts L439). If it fails, the DomRenderer fallback works. |
| Unknown axis tags cause warnings in console | Browsers silently ignore unknown tags. No issue. |
| Performance impact of variation settings on atlas rasterization | Variable fonts are resolved at rasterize time — same cost as static fonts. No measurable impact. |
| Config flush adds `features` and `axes` to every user's file | Both default to empty values. Matches existing pattern. Minimal noise. |
| Chrome elements look wrong with user's axes | By design — user controls their font. If it looks bad, they adjust their config. |

## Resources

- [Recursive Font — GitHub](https://github.com/arrowtype/recursive) — Variable font with 5 axes and 13+ OpenType features
- [MDN: font-variation-settings](https://developer.mozilla.org/en-US/docs/Web/CSS/font-variation-settings)
- [MDN: font-feature-settings](https://developer.mozilla.org/en-US/docs/Web/CSS/font-feature-settings)
- [OpenType Feature Tags Registry](https://learn.microsoft.com/en-us/typography/opentype/spec/featurelist)
- [xterm.js WebGL TextureAtlas source](https://github.com/xtermjs/xterm.js/blob/master/addons/addon-webgl/src/TextureAtlas.ts) — DOM inheritance for font-feature-settings
- [Kitty terminal font_features](https://sw.kovidgoyal.net/kitty/conf/#opt-kitty.font_features)
- [WezTerm harfbuzz_features](https://wezfurlong.org/wezterm/config/fonts.html#harfbuzz-features)
