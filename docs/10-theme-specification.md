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
radius = 0                         # Border radius in pixels
```

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `width` | int | `1` | Border width (px) |
| `color` | color | `"rgba(0, 200, 255, 0.3)"` | Border color for unfocused windows |
| `radius` | int | `0` | Border corner radius (px). `0` = sharp corners. |

#### `[chrome.shadow]`

Window drop shadow. Shadows are cast on the transparent desktop surface.

```toml
[chrome.shadow]
color = "rgba(0, 200, 255, 0.07)"
blur = 15                          # Blur radius in pixels
spread = 0                         # Spread radius in pixels
offset_x = 0                       # Horizontal offset in pixels
offset_y = 0                       # Vertical offset in pixels
```

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `color` | color | `"rgba(0, 200, 255, 0.07)"` | Shadow color |
| `blur` | int | `15` | Blur radius (px) |
| `spread` | int | `0` | Spread distance (px) |
| `offset_x` | int | `0` | Horizontal offset (px) |
| `offset_y` | int | `0` | Vertical offset (px) |

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
height = 28                         # Title bar height in pixels
background = "transparent"          # Title bar background
text_color = "rgba(0, 200, 255, 0.3)"
font_size = 11                      # Font size in pixels
font_weight = 600                   # CSS font-weight (100-900)
letter_spacing = 0.08               # Letter spacing in em
text_transform = "uppercase"        # "none", "uppercase", "lowercase", "capitalize"
alignment = "left"                  # "left", "center", "right"
```

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `height` | int | `28` | Title bar height (px) |
| `background` | color | `"transparent"` | Title bar background color/gradient |
| `text_color` | color | `"rgba(0, 200, 255, 0.3)"` | Label text color (unfocused) |
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
color = "rgba(0, 200, 255, 0.25)"   # Dot color (unfocused)
shape = "square"                    # "square" or "circle"
```

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `size` | int | `6` | Dot dimensions (px) |
| `color` | color | `"rgba(0, 200, 255, 0.25)"` | Dot color (unfocused) |
| `shape` | string | `"square"` | `"square"` or `"circle"` |

#### `[chrome.header_accent]`

The decorative striped bar below the title bar.

```toml
[chrome.header_accent]
enabled = true
height = 6                          # Bar height in pixels
color = "rgba(0, 200, 255, 0.15)"   # Stripe color (unfocused)
margin_horizontal = 20              # Left/right margin in pixels
```

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `enabled` | bool | `true` | Show/hide the accent bar |
| `height` | int | `6` | Accent bar height (px) |
| `color` | color | `"rgba(0, 200, 255, 0.15)"` | Stripe color (unfocused) |
| `margin_horizontal` | int | `20` | Horizontal margin (px) |

#### `[chrome.corner_accents]`

Decorative L-shaped glowing accents at each window corner.

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

Tab bar styling (when tabs are enabled within a window).

```toml
[chrome.tabs]
height = 28                         # Tab bar height in pixels
background = "transparent"          # Tab bar background
active_color = "#0cf"               # Active tab text/indicator color
inactive_color = "rgba(0, 200, 255, 0.3)"
font_size = 11                      # Tab font size in pixels
```

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `height` | int | `28` | Tab bar height (px) |
| `background` | color | `"transparent"` | Tab bar background |
| `active_color` | color | `"#0cf"` | Active tab text/indicator |
| `inactive_color` | color | `"rgba(0, 200, 255, 0.3)"` | Inactive tab text |
| `font_size` | int | `11` | Tab label font size (px) |

---

### `[focused]` — Focused Window Overrides

When a window receives focus, these values override the corresponding `[chrome]` properties. Only specify the properties you want to change on focus. Omitted properties remain unchanged.

```toml
[focused]
border_color = "rgba(0, 200, 255, 0.5)"
shadow_color = "rgba(0, 200, 255, 0.12)"
shadow_blur = 20
titlebar_text_color = "#0cf"
status_dot_color = "#0cf"
header_accent_color = "rgba(0, 200, 255, 0.35)"
corner_accent_color = "#0cf"
corner_accent_glow = "rgba(0, 204, 255, 0.6)"   # Box-shadow glow on corners
label_color = "#0cf"
```

| Key | Type | Description |
|-----|------|-------------|
| `border_color` | color | Border color when focused |
| `shadow_color` | color | Shadow color when focused |
| `shadow_blur` | int | Shadow blur when focused |
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

Styles for overlay UI elements: command palette, search bar, mode indicator, and which-key popup.

#### `[ui.command_palette]`

```toml
[ui.command_palette]
background = "rgba(6, 10, 18, 0.85)"
border = "rgba(0, 200, 255, 0.4)"
text_color = "#c0c5ce"
highlight_color = "#0cf"             # Selected item highlight
input_background = "transparent"
input_text_color = "#c0c5ce"
backdrop_blur = 16                   # Blur behind the palette
```

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `background` | color | `"rgba(6, 10, 18, 0.85)"` | Palette background |
| `border` | color | `"rgba(0, 200, 255, 0.4)"` | Palette border |
| `text_color` | color | `"#c0c5ce"` | Item text color |
| `highlight_color` | color | `"#0cf"` | Selected/matched item color |
| `input_background` | color | `"transparent"` | Search input background |
| `input_text_color` | color | `"#c0c5ce"` | Search input text color |
| `backdrop_blur` | int | `16` | Backdrop blur (px) |

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

#### `[ui.which_key]`

```toml
[ui.which_key]
background = "rgba(6, 10, 18, 0.85)"
border = "rgba(0, 200, 255, 0.4)"
title_color = "#0cf"
key_color = "#0cf"
label_color = "rgba(0, 200, 255, 0.4)"
separator_color = "rgba(0, 200, 255, 0.2)"
backdrop_blur = 16
```

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `background` | color | `"rgba(6, 10, 18, 0.85)"` | Popup background |
| `border` | color | `"rgba(0, 200, 255, 0.4)"` | Popup border |
| `title_color` | color | `"#0cf"` | Section title color |
| `key_color` | color | `"#0cf"` | Keybinding text color |
| `label_color` | color | `"rgba(0, 200, 255, 0.4)"` | Action label color |
| `separator_color` | color | `"rgba(0, 200, 255, 0.2)"` | Divider line color |
| `backdrop_blur` | int | `16` | Backdrop blur (px) |

#### `[ui.quick_terminal]`

Overrides specific to the Quick Terminal overlay. These are applied on top of the regular `[chrome]` styles.

```toml
[ui.quick_terminal]
backdrop_blur = 20
background = "rgba(6, 10, 18, 0.6)"
shadow_color = "rgba(0, 200, 255, 0.1)"
shadow_blur = 30
```

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `backdrop_blur` | int | `20` | Stronger blur for the overlay feel |
| `background` | color | `"rgba(6, 10, 18, 0.6)"` | Background fill |
| `shadow_color` | color | `"rgba(0, 200, 255, 0.1)"` | Box shadow color |
| `shadow_blur` | int | `30` | Box shadow blur (px) |

---

## Built-in Themes

Krypton ships with four built-in themes:

| Name | Description |
|------|-------------|
| `krypton-dark` | Default cyberpunk dark theme with cyan accents on transparent black |
| `krypton-light` | Light variant with dark text on frosted white |
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
radius = 0

[chrome.shadow]
color = "rgba(255, 68, 204, 0.07)"
blur = 15
spread = 0
offset_x = 0
offset_y = 0

[chrome.backdrop]
color = "rgba(10, 8, 18, 0.5)"
blur = 12

[chrome.titlebar]
height = 28
background = "transparent"
text_color = "rgba(255, 68, 204, 0.3)"
font_size = 11
font_weight = 600
letter_spacing = 0.08
text_transform = "uppercase"
alignment = "left"

[chrome.status_dot]
size = 6
color = "rgba(255, 68, 204, 0.25)"
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
font_size = 11

[focused]
border_color = "rgba(255, 68, 204, 0.5)"
shadow_color = "rgba(255, 68, 204, 0.12)"
shadow_blur = 20
titlebar_text_color = "#ff44cc"
status_dot_color = "#ff44cc"
header_accent_color = "rgba(255, 68, 204, 0.35)"
corner_accent_color = "#ff44cc"
corner_accent_glow = "rgba(255, 68, 204, 0.6)"
label_color = "#ff44cc"

[workspace]
background = "transparent"
blur = 0

[ui.command_palette]
background = "rgba(10, 8, 18, 0.9)"
border = "rgba(255, 68, 204, 0.4)"
text_color = "#e0e0e0"
highlight_color = "#ff44cc"
backdrop_blur = 16

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

[ui.which_key]
background = "rgba(10, 8, 18, 0.9)"
border = "rgba(255, 68, 204, 0.4)"
title_color = "#ff44cc"
key_color = "#ff44cc"
label_color = "rgba(255, 68, 204, 0.4)"
separator_color = "rgba(255, 68, 204, 0.2)"
backdrop_blur = 16

[ui.quick_terminal]
backdrop_blur = 20
background = "rgba(10, 8, 18, 0.65)"
shadow_color = "rgba(255, 68, 204, 0.1)"
shadow_blur = 30
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

---

## Hot Reload

When Krypton detects changes to a theme file (via filesystem watcher), the theme is re-parsed and applied immediately without restart. The apply latency target is < 100ms.

Changes to `krypton.toml` inline `[theme.colors]` overrides also trigger hot reload.

---

## CSS Custom Properties

Internally, the theme engine maps theme values to CSS custom properties prefixed with `--krypton-`. Theme authors do not need to know these — they exist for Krypton's internal rendering. Documented here for completeness:

```
--krypton-fg, --krypton-bg, --krypton-cursor, --krypton-selection
--krypton-ansi-0 through --krypton-ansi-15
--krypton-border-color, --krypton-border-width, --krypton-border-radius
--krypton-shadow-color, --krypton-shadow-blur
--krypton-titlebar-bg, --krypton-titlebar-height, --krypton-titlebar-text
--krypton-backdrop-color, --krypton-backdrop-blur
--krypton-accent-color, --krypton-corner-color
--krypton-focused-border, --krypton-focused-shadow, --krypton-focused-accent
--krypton-palette-bg, --krypton-palette-border, --krypton-palette-highlight
--krypton-search-bg, --krypton-search-match
--krypton-mode-bg, --krypton-mode-text
```
