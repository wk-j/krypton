# 10. Theme Specification

This document defines the Krypton theme file format for external theme developers. A theme is a single TOML file that controls all visual aspects of the application: terminal colors, window chrome, workspace background, and UI elements.

## File Location

Place custom theme files at:

```
~/.config/krypton/themes/<name>.toml
```

The filename (minus `.toml`) becomes the theme name used in configuration. For example:

```
~/.config/krypton/themes/nord.toml     -> name = "nord"
~/.config/krypton/themes/dracula.toml  -> name = "dracula"
```

Activate a theme in `~/.config/krypton/krypton.toml`:

```toml
[theme]
name = "nord"
```

## Design Principles

1. **Every field is optional.** Omitted fields inherit from the built-in `krypton-dark` base theme. This means a minimal theme file with only `[colors]` and two overrides is valid.
2. **Colors are CSS-compatible strings.** Use hex (`#rrggbb`, `#rrggbbaa`), `rgb()`, `rgba()`, or named CSS colors.
3. **Lengths are integers in pixels** unless otherwise noted.
4. **The file is standard TOML.** See [toml.io](https://toml.io) for syntax.

## Precedence

Themes are resolved in this order (later wins):

1. Built-in `krypton-dark` defaults (always present)
2. Named theme file (`~/.config/krypton/themes/<name>.toml`)
3. Inline `[theme.colors]` overrides in `krypton.toml`

This means a user can pick your theme and still override individual colors in their config.

---

## Complete Schema

### `[meta]` — Theme Metadata

Optional metadata about the theme. Not used by the engine at runtime but displayed in the command palette and useful for theme distribution.

```toml
[meta]
display_name = "Nord Aurora"       # Human-readable name (defaults to filename)
author = "Jane Doe"                # Author name
version = "1.0.0"                  # Theme version (semver recommended)
description = "Arctic, north-bluish color palette"
url = "https://github.com/jane/krypton-nord"
license = "MIT"
```

| Key | Type | Required | Description |
|-----|------|----------|-------------|
| `display_name` | string | No | Human-readable name shown in command palette |
| `author` | string | No | Theme author |
| `version` | string | No | Theme version (semver recommended) |
| `description` | string | No | Short description |
| `url` | string | No | Homepage or repository URL |
| `license` | string | No | License identifier (e.g., `"MIT"`, `"Apache-2.0"`) |

---

### `[colors]` — Terminal Colors

The core terminal palette. These map directly to xterm.js theme properties.

```toml
[colors]
foreground = "#d8dee9"
background = "#2e3440"
cursor = "#d8dee9"
selection = "#434c5e"

# ANSI normal (0-7)
black = "#3b4252"
red = "#bf616a"
green = "#a3be8c"
yellow = "#ebcb8b"
blue = "#81a1c1"
magenta = "#b48ead"
cyan = "#88c0d0"
white = "#e5e9f0"

# ANSI bright (8-15)
bright_black = "#4c566a"
bright_red = "#bf616a"
bright_green = "#a3be8c"
bright_yellow = "#ebcb8b"
bright_blue = "#81a1c1"
bright_magenta = "#b48ead"
bright_cyan = "#8fbcbb"
bright_white = "#eceff4"
```

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `foreground` | color | `"#c0c5ce"` | Default text color |
| `background` | color | `"rgba(6, 10, 18, 0.85)"` | Terminal background (supports alpha for transparency) |
| `cursor` | color | `"#c0c5ce"` | Cursor color |
| `selection` | color | `"#4f5b66"` | Selection highlight background |
| `black` | color | — | ANSI color 0 |
| `red` | color | — | ANSI color 1 |
| `green` | color | — | ANSI color 2 |
| `yellow` | color | — | ANSI color 3 |
| `blue` | color | — | ANSI color 4 |
| `magenta` | color | — | ANSI color 5 |
| `cyan` | color | — | ANSI color 6 |
| `white` | color | — | ANSI color 7 |
| `bright_black` | color | — | ANSI color 8 |
| `bright_red` | color | — | ANSI color 9 |
| `bright_green` | color | — | ANSI color 10 |
| `bright_yellow` | color | — | ANSI color 11 |
| `bright_blue` | color | — | ANSI color 12 |
| `bright_magenta` | color | — | ANSI color 13 |
| `bright_cyan` | color | — | ANSI color 14 |
| `bright_white` | color | — | ANSI color 15 |

#### Extended 256-Color Palette (Optional)

Override individual entries from the 256-color palette (colors 16-255). Keys are indices as strings:

```toml
[colors.palette]
"16" = "#000000"
"17" = "#00005f"
# ... up to "255"
```

Most themes do not need this. The default 256-color palette is computed from the 16 ANSI colors.

---

### `[chrome]` — Window Chrome

Controls the decorative frame around each terminal window.

#### `[chrome.border]`

```toml
[chrome.border]
width = 1                          # Border width in pixels
color = "rgba(0, 200, 255, 0.3)"   # Border color (unfocused)
radius = 8                         # Border radius in pixels
```

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `width` | int | `1` | Border width (px) |
| `color` | color | `"rgba(0, 200, 255, 0.3)"` | Border color for unfocused windows |
| `radius` | int | `8` | Border corner radius (px). Default is the 8px radius on every Krypton Console part (DESIGN.md). Maps to `--krypton-border-radius`. |

#### `[chrome.backdrop]`

Background fill and blur behind the terminal content.

```toml
[chrome.backdrop]
color = "rgba(6, 10, 18, 0.5)"     # Window background color
blur = 12                           # Backdrop blur in pixels (0 = none)
```

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `color` | color | `"rgba(6, 10, 18, 0.5)"` | Window background fill (use alpha for transparency) |
| `blur` | int | `12` | CSS `backdrop-filter: blur()` value (px). `0` = no blur. |

#### `[chrome.titlebar]`

The title bar at the top of each window.

```toml
[chrome.titlebar]
height = 36                         # Title bar height in pixels
font_size = 11                      # Font size in pixels
font_weight = 600                   # CSS font-weight (100-900)
letter_spacing = 0.08               # Letter spacing in em
text_transform = "uppercase"        # "none", "uppercase", "lowercase", "capitalize"
alignment = "left"                  # "left", "center", "right"
```

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `height` | int | `36` | Title bar height (px) |
| `font_size` | int | `11` | Font size (px) |
| `font_weight` | int | `600` | CSS font weight |
| `letter_spacing` | float | `0.08` | Letter spacing (em) |
| `text_transform` | string | `"uppercase"` | CSS text-transform value |
| `alignment` | string | `"left"` | Title text alignment |

#### `[chrome.status_dot]`

The small indicator dot next to the window label.

```toml
[chrome.status_dot]
size = 6                            # Dot size in pixels (square)
shape = "square"                    # "square" or "circle"
```

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `size` | int | `6` | Dot dimensions (px) |
| `shape` | string | `"square"` | `"square"` or `"circle"` |

#### `[chrome.header_accent]`

The signal band below the title bar.

```toml
[chrome.header_accent]
enabled = true
height = 6                          # Bar height in pixels
color = "rgba(0, 200, 255, 0.15)"   # Stripe color (unfocused; ticks style only)
margin_horizontal = 20              # Left/right margin in pixels
style = "oscilloscope"              # "oscilloscope" (live trace) | "ticks" (static)
```

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `enabled` | bool | `true` | Show/hide the accent bar |
| `height` | int | `6` | Accent bar height (px) |
| `color` | color | `"rgba(0, 200, 255, 0.15)"` | Stripe color (unfocused; `ticks` style only) |
| `margin_horizontal` | int | `20` | Horizontal margin (px) |
| `style` | string | `"oscilloscope"` | `"oscilloscope"` — live canvas trace fed by PTY output throughput (rAF stops at idle → 0% idle CPU; `prefers-reduced-motion` → static hairline; trace color follows the per-lane window accent). `"ticks"` — the classic static striped gradient. Terminal + Quick Terminal windows only; content-view windows keep the static band. See `docs/0188-oscilloscope-header-band.md`. |

#### `[chrome.corner_accents]`

**Not rendered.** Theme tokens still parse (`enabled` / `size` / `thickness` / `color`) and map to unused `--krypton-corner-*` CSS variables. Window L-brackets were removed; do not reintroduce them on windows, vault, agent, harness, or toasts. `DESIGN.md` forbids L-shaped corner ornament on every surface.

```toml
[chrome.corner_accents]
enabled = true
size = 14                           # Accent arm length in pixels
thickness = 2                       # Accent arm thickness in pixels
color = "rgba(0, 200, 255, 0.4)"    # Accent color (unfocused)
```

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `enabled` | bool | `true` | Show/hide corner accents |
| `size` | int | `14` | Arm length (px) |
| `thickness` | int | `2` | Arm thickness (px) |
| `color` | color | `"rgba(0, 200, 255, 0.4)"` | Corner color (unfocused) |

#### `[chrome.tabs]`

Tab strip styling (when tabs are enabled within a window). The strip lives inside the titlebar row. Tab labels (index and title) have no theme font size: they use `--krypton-font-size`, the unscaled `[font].size`, unlike other chrome labels which use the scaled `--krypton-chrome-font-size` (`round(size × 0.786)`).

```toml
[chrome.tabs]
height = 36                         # Tab row height; channel = min(height, titlebar height) − 4px
background = "transparent"          # Tab bar background
active_color = "#0cf"               # Active tab text/indicator color
inactive_color = "rgba(0, 200, 255, 0.3)"
```

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `height` | int | `36` | Tab row height (px); the selector-key channel is `min(height, titlebar height) − 4px`, its keys 6px shorter |
| `background` | color | `"transparent"` | Tab bar background |
| `active_color` | color | `"#0cf"` | Active tab text/indicator |
| `inactive_color` | color | `"rgba(0, 200, 255, 0.3)"` | Inactive tab text |

---

### `[focused]` — Focused Window Overrides

When a window receives focus, these values override the corresponding `[chrome]` properties. Only specify the properties you want to change on focus. Omitted properties remain unchanged.

```toml
[focused]
titlebar_text_color = "#0cf"
status_dot_color = "#0cf"
header_accent_color = "rgba(0, 200, 255, 0.35)"
corner_accent_color = "#0cf"
corner_accent_glow = "rgba(0, 204, 255, 0.6)"   # Box-shadow glow on corners
label_color = "#0cf"
```

| Key | Type | Description |
|-----|------|-------------|
| `titlebar_text_color` | color | Title label color when focused |
| `status_dot_color` | color | Status dot color when focused |
| `header_accent_color` | color | Accent bar stripe color when focused |
| `corner_accent_color` | color | Corner accent fill when focused |
| `corner_accent_glow` | color | Corner accent glow (box-shadow) when focused |
| `label_color` | color | Window label text when focused |

---

### `[workspace]` — Workspace Background

Controls the workspace surface behind all terminal windows. The workspace is a fullscreen transparent layer — the OS desktop is visible beneath.

```toml
[workspace]
background = "transparent"           # Overlay color (use alpha for tinting)
blur = 0                             # Workspace-level vibrancy blur (px)
# image = "~/.config/krypton/wallpaper.png"   # Optional background image
# image_opacity = 0.1                          # Image opacity (0.0-1.0)
```

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `background` | color | `"transparent"` | Workspace background overlay color |
| `blur` | int | `0` | Vibrancy/frosted-glass blur applied to the desktop beneath (px) |
| `image` | string | — | Path to a background image (absolute or `~/`-relative) |
| `image_opacity` | float | `0.1` | Background image opacity (`0.0`-`1.0`) |

---

### `[ui]` — UI Element Styles

Styles for overlay UI elements: search bar, mode indicator, and the Quick Terminal. The command palette, which-key popup and hint labels are Krypton Console plates and key caps (`DESIGN.md`); since spec 366 they take no theme keys, and `[ui.command_palette]`, `[ui.which_key]` and `[ui.hints]` in an older theme file are ignored.

#### `[ui.search]`

```toml
[ui.search]
background = "rgba(6, 10, 18, 0.85)"
text_color = "#c0c5ce"
match_color = "#ebcb8b"              # Highlighted match color
border = "rgba(0, 200, 255, 0.4)"
```

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `background` | color | `"rgba(6, 10, 18, 0.85)"` | Search overlay background |
| `text_color` | color | `"#c0c5ce"` | Search input text |
| `match_color` | color | `"#ebcb8b"` | Match highlight color in terminal |
| `border` | color | `"rgba(0, 200, 255, 0.4)"` | Search overlay border |

#### `[ui.mode_indicator]`

```toml
[ui.mode_indicator]
background = "rgba(0, 200, 255, 0.15)"
text_color = "#0cf"
font_size = 11
position = "bottom-center"           # "top-left", "top-center", "top-right",
                                     # "bottom-left", "bottom-center", "bottom-right"
```

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `background` | color | `"rgba(0, 200, 255, 0.15)"` | Badge background |
| `text_color` | color | `"#0cf"` | Badge text color |
| `font_size` | int | `11` | Font size (px) |
| `position` | string | `"bottom-center"` | Screen position for the indicator |

#### `[ui.quick_terminal]`

Overrides specific to the Quick Terminal overlay. These are applied on top of the regular `[chrome]` styles.

```toml
[ui.quick_terminal]
backdrop_blur = 20
background = "rgba(6, 10, 18, 0.6)"
```

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `backdrop_blur` | int | `20` | Stronger blur for the overlay feel |
| `background` | color | `"rgba(6, 10, 18, 0.6)"` | Background fill |

---

### `[tokens]` — Component Tokens

Optional free-form table. Each entry becomes a `--<key>` CSS custom property on `document.documentElement`, which lets a theme restyle a single component (the `--acp-*` harness hooks, the `--mat-*` material stops, …) without shipping CSS or selectors.

```toml
[tokens]
"acp-tool-head-fg"      = "#ffd27f"   # one component's head color
"acp-tool-output-max-h" = "420px"
"acp-peek-accent"       = "var(--agent-cyan)"
```

| Rule | Value |
|------|-------|
| Key charset | `^[a-z][a-z0-9-]{0,63}$`, rendered as `--<key>` |
| Value length | 256 characters max |
| Value functions | Allowlist, checked after CSS-unescaping and lowercasing the value: `var rgb rgba hsl hsla color-mix color oklch lab calc clamp min max env`. Everything else — `url()`, `image()`, `image-set()`, `-webkit-image-set()`, `cross-fade()`, `element()`, `expression()`, `attr()` — is rejected, so a theme can never trigger a fetch. |
| Unknown key | Applied and inert. A theme written for a newer Krypton still loads on an older one. |
| Namespace convention | `acp-*` harness components, `vault-*` vault, `krypton-*` global. Documented, not enforced. |
| Precedence | Applied after all built-in properties — a token named after one (`"agent-text"`) overrides the derived value — and before per-element `style.setProperty`, which still wins. |

Entries that fail validation are dropped one by one with a `theme token rejected: <key>` warning; the rest of the theme loads. Switching to a theme that omits a token the previous one set removes that property. A value naming a property that does not exist falls through to the component's `var()` fallback.

---

## Built-in Themes

Krypton ships with four built-in themes:

| Name | Description |
|------|-------------|
| `krypton-dark` | Default cyberpunk dark theme with cyan accents on transparent black |
| `krypton-light` | Light variant of Krypton Dark: slate ink on cool frost, cyan chrome, layered rail/canvas surfaces |
| `solarized` | Ethan Schoonover's Solarized Dark adapted for Krypton chrome |
| `legacy-radiance` | CRT phosphor emission on void black — three frequencies (P1 green, cobalt blue, ionized cyan) |

Built-in themes can be extended with inline overrides in `krypton.toml` just like custom themes.

---

## Chrome Styles

Krypton ships with three built-in chrome styles that control the window decoration aesthetic. Chrome styles are orthogonal to color themes — you can combine any chrome style with any color theme.

| Style | Description |
|-------|-------------|
| `cyberpunk` | Default. Corner accents, header accent bar, status dot, glowing borders. |
| `minimal` | Clean frame: thin border, simple titlebar, no corner accents or accent bars. |
| `none` | Borderless. No chrome at all — terminal content fills the entire window area. |

Set the chrome style in the theme file:

```toml
[chrome]
style = "cyberpunk"    # "cyberpunk", "minimal", "none"
```

When `style` is set, it applies a preset and individual `[chrome.*]` values override on top of it.

---

## Minimal Example

A valid theme with just terminal colors:

```toml
# ~/.config/krypton/themes/ocean.toml

[colors]
foreground = "#c0c5ce"
background = "#1b2b34"
cursor = "#c0c5ce"
selection = "#4f5b66"
black = "#1b2b34"
red = "#ec5f67"
green = "#99c794"
yellow = "#fac863"
blue = "#6699cc"
magenta = "#c594c5"
cyan = "#5fb3b3"
white = "#c0c5ce"
bright_black = "#65737e"
bright_red = "#ec5f67"
bright_green = "#99c794"
bright_yellow = "#fac863"
bright_blue = "#6699cc"
bright_magenta = "#c594c5"
bright_cyan = "#5fb3b3"
bright_white = "#ffffff"
```

Everything else inherits from `krypton-dark`. Activate with:

```toml
[theme]
name = "ocean"
```

## Full Example

A complete theme showcasing every section:

```toml
# ~/.config/krypton/themes/neon-noir.toml

[meta]
display_name = "Neon Noir"
author = "Krypton Labs"
version = "1.0.0"
description = "High-contrast cyberpunk with magenta accents"
license = "MIT"

[colors]
foreground = "#e0e0e0"
background = "rgba(10, 8, 18, 0.9)"
cursor = "#ff44cc"
selection = "#44225e"
black = "#1a1a2e"
red = "#ff3366"
green = "#33ff99"
yellow = "#ffcc33"
blue = "#3399ff"
magenta = "#ff44cc"
cyan = "#33ccff"
white = "#e0e0e0"
bright_black = "#4a4a6e"
bright_red = "#ff6699"
bright_green = "#66ffbb"
bright_yellow = "#ffdd66"
bright_blue = "#66bbff"
bright_magenta = "#ff77dd"
bright_cyan = "#66ddff"
bright_white = "#ffffff"

[chrome]
style = "cyberpunk"

[chrome.border]
width = 1
color = "rgba(255, 68, 204, 0.3)"
radius = 8

[chrome.backdrop]
color = "rgba(10, 8, 18, 0.5)"
blur = 12

[chrome.titlebar]
height = 28
font_size = 11
font_weight = 600
letter_spacing = 0.08
text_transform = "uppercase"
alignment = "left"

[chrome.status_dot]
size = 6
shape = "square"

[chrome.header_accent]
enabled = true
height = 6
color = "rgba(255, 68, 204, 0.15)"
margin_horizontal = 20

[chrome.corner_accents]
enabled = true
size = 14
thickness = 2
color = "rgba(255, 68, 204, 0.4)"

[chrome.tabs]
height = 28
background = "transparent"
active_color = "#ff44cc"
inactive_color = "rgba(255, 68, 204, 0.3)"

[focused]
titlebar_text_color = "#ff44cc"
status_dot_color = "#ff44cc"
header_accent_color = "rgba(255, 68, 204, 0.35)"
corner_accent_color = "#ff44cc"
corner_accent_glow = "rgba(255, 68, 204, 0.6)"
label_color = "#ff44cc"

[workspace]
background = "transparent"
blur = 0

[ui.search]
background = "rgba(10, 8, 18, 0.9)"
text_color = "#e0e0e0"
match_color = "#ffcc33"
border = "rgba(255, 68, 204, 0.4)"

[ui.mode_indicator]
background = "rgba(255, 68, 204, 0.15)"
text_color = "#ff44cc"
font_size = 11
position = "bottom-center"

[ui.quick_terminal]
backdrop_blur = 20
background = "rgba(10, 8, 18, 0.65)"
```

---

## Validation Rules

The theme engine validates theme files on load. Invalid themes are rejected with a warning and the previous theme is retained.

| Rule | Details |
|------|---------|
| **Color format** | Must be a valid CSS color: `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb()`, `rgba()`, or a named CSS color. |
| **Integer range** | Pixel values must be non-negative integers. |
| **Float range** | Opacity and ratio values must be in `0.0`-`1.0`. |
| **Font weight** | Must be a multiple of 100 in the range `100`-`900`. |
| **Position** | Must be one of the valid position keywords. |
| **Shape** | Must be `"square"` or `"circle"`. |
| **Text transform** | Must be `"none"`, `"uppercase"`, `"lowercase"`, or `"capitalize"`. |
| **Chrome style** | Must be `"cyberpunk"`, `"minimal"`, or `"none"`. |
| **Unknown keys** | Ignored with a warning (forward-compatible). |
| **Token key** (`[tokens]`) | Must match `^[a-z][a-z0-9-]{0,63}$`; other keys are dropped with a warning. |
| **Token value** (`[tokens]`) | 256 characters max, and every CSS function in the unescaped, lowercased value must be one of `var rgb rgba hsl hsla color-mix color oklch lab calc clamp min max env`. Fetching functions (`url()`, `image-set()`, …) are dropped with a warning. |

---

## Applying a theme

There is no filesystem watcher on `krypton.toml` or `themes/*.toml`. File edits apply on command-palette **Reload Config** or the next launch.

The command palette lists every built-in and custom theme under **Color Theme**. Picking one calls `set_theme`, which writes `theme.name` and emits `theme-changed` so the UI updates without a restart. Inline `[theme.colors]` overrides are re-applied on **Reload Config**.

At apply time the frontend also derives `--agent-*` from the color theme (accent, foreground, ANSI, chrome). Every surface — window chrome, Agent, ACP Harness, Vault — is built from the Krypton Console material set (`--mat-*`, `src/styles/materials.css`, [spec 366](./0366-console-faceplate-ui.md)); the theme supplies the colours on and around that material, so switching `krypton-dark` → `legacy-radiance` is visible everywhere. A theme's `[tokens]` may recolour any `--mat-*` colour stop or shadow.

Harness interiors consume those tokens (`--agent-text`, `--agent-surface-*`, `--krypton-fg-rgb`, `--krypton-accent-rgb`) rather than hardcoded krypton-dark navy/phosphor, so `krypton-light` keeps dark slate ink on frost instead of painting black slabs and `#eaf3ea` body text over a pale titlebar. `--agent-surface-solid` is opaque paper on light themes (never ANSI `colors.black` — light themes use a dark black for terminal output), because rail cards float over the transcript ([spec 321](./0321-light-scheme-legibility.md)).

Light vs dark is not inverted paint. The frontend computes relative luminance of `chrome.backdrop` and sets `html[data-theme-scheme="light"|"dark"]` plus `--krypton-scheme`. Light scheme:

- **Surfaces separate by luminance.** The zen rail is an aluminium plate column (`--mat-*`) and `--agent-surface-canvas` is paper-white, so the rail and the transcript no longer share one frost.
- **Secondary text is an opaque ink tier, not ink at an alpha** ([spec 321](./0321-light-scheme-legibility.md)). The engine solves `--krypton-ink-2` / `-3` / `-4` per light theme to 7 / 4.5 / 3:1 against the rail. A stylesheet writes `var(--krypton-ink-3, rgba(var(--krypton-fg-rgb), 0.42))`: the tiers exist only under a light scheme, so a dark theme keeps its alpha ladder through the fallback.
- **An accent used as text is OKLCH-capped, never raw neon.** `oklch(from <accent> min(l, var(--krypton-accent-l-max)) c h)` with the cap at 0.44 keeps hue and chroma and clears 4.5:1 for every palette accent. It is declared once on the element that carries the accent — `--acp-lane-ink` on each lane, rail entry, composer and queue-card root — because a `var()` inside a custom property resolves where it is declared. WebKit clips out-of-gamut channels, so warm hues land on rust and brown rather than amber.
- **Surfaces stay near-opaque.** Blur is banned, so a translucent light surface takes the wallpaper's hue. Under a light scheme the window backdrop alpha is `max([visual] opacity, 0.94)`.
- **Identity chips darken.** Backend and role palettes (spec 125) swap to ink-weight variants of the same hues so Codex `#d7e7f0` does not vanish on white.
- **No glow type.** `text-shadow` blooms that read as phosphor on navy become mud on frost and are dropped.
- **Materials swap to aluminium.** `materials.css` redeclares the `--mat-*` set under `html[data-theme-scheme='light']`: plates at 0.94 alpha, amber labels capped to `#6e4700`, engraving as a white highlight.

The dark scheme uses the graphite material set. Custom light themes (backdrop luminance ≥ 0.45) get the same scheme without opting in by name.

---

## CSS Custom Properties

Internally, the theme engine maps theme values to CSS custom properties prefixed with `--krypton-`. Theme authors do not need to know these — they exist for Krypton's internal rendering. Documented here for completeness:

```
--krypton-fg, --krypton-bg, --krypton-cursor, --krypton-selection
--krypton-scheme                  # "light" or "dark" (from chrome-backdrop luminance)
--krypton-ink-2, --krypton-ink-3, --krypton-ink-4   # light scheme only (spec 321)
--krypton-ink, --krypton-accent-l-max               # light scheme only, theme-scheme.css
--agent-surface-solid, --agent-surface-canvas
--krypton-ansi-0 through --krypton-ansi-15
--krypton-border-color, --krypton-border-width, --krypton-border-radius
--mat-*                           # Krypton Console materials (src/styles/materials.css), not theme-derived
--krypton-titlebar-height
--krypton-backdrop-color, --krypton-backdrop-blur
--krypton-accent-color, --krypton-corner-color
--krypton-focused-accent
--krypton-search-bg, --krypton-search-match
--krypton-mode-bg, --krypton-mode-text
```
