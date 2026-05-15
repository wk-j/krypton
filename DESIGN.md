---
name: Krypton Dark
version: 1.1.0
description: Cyberpunk sci-fi terminal aesthetic — cyan neon on transparent blue-black, hard geometry, monospace typography, multi-layer glows
colors:
  primary: "#0cf"
  foreground: "#b0c4d8"
  background: "#060a12"
  cursor: "#0cf"
  danger: "#ff3a5c"
  warning: "#e8c547"
  success: "#39ff7f"
  info: "#4a9eff"
  special: "#c77dff"
  selection: "#1a3a5c"
  link: "#33ddff"
backgroundAlpha: 0.5         # backdrop opacity over desktop
selectionAlpha: 0.6
ansi:
  black: "#0a0a0f"
  red: "#ff3a5c"
  green: "#0cf"
  yellow: "#e8c547"
  blue: "#4a9eff"
  magenta: "#c77dff"
  cyan: "#0cf"
  white: "#b0c4d8"
  brightBlack: "#2a4a6c"
  brightRed: "#ff5c7a"
  brightGreen: "#33ddff"
  brightYellow: "#ffd866"
  brightBlue: "#6ab4ff"
  brightMagenta: "#d9a0ff"
  brightCyan: "#33ddff"
  brightWhite: "#ffffff"
accentOpacity:
  ghost: 0.04        # background texture, gauge tracks, disabled fill
  inactive: 0.15     # tab separators, idle borders, disabled text
  hover: 0.4         # secondary borders, whichkey
  active: 0.7        # active tab edge, primary borders
  neon: 1.0          # status dots, full text accent
typography:
  family: "Mononoki, JetBrains Mono, ui-monospace, monospace"
  label:
    size: "11px"
    weight: 600
    letterSpacing: "0.08em"
    transform: "uppercase"
  body:
    size: "13px"
    weight: 400
    letterSpacing: "0em"
  display:
    size: "28px"
    weight: 400
    letterSpacing: "0.2em"
    transform: "uppercase"
  numeric:
    fontVariant: "tabular-nums"   # mandatory for gauges, timers, counters
rounded:
  none: "0px"        # default — hard geometry
  subtle: "2px"      # toast cards, badges only
spacing:
  hairline: "1px"
  xs: "4px"
  sm: "8px"
  md: "14px"
  lg: "20px"
  xl: "28px"
chrome:
  borderWidth: "1px"
  cornerAccentSize: "14px"
  cornerAccentThickness: "2px"
  titlebarHeight: "28px"
  headerAccentHeight: "6px"
  statusDotSize: "6px"
  minWindowWidth: "320px"     # below this, chrome degrades to titlebar-only
  minWindowHeight: "120px"
focus:
  ringWidth: "1px"            # for non-window controls (inputs, buttons, rows)
  ringOffset: "0px"
  ringColor: "primary @ active (0.7)"
  ringGlow: "0 0 6px primary @ 0.6, 0 0 12px primary @ 0.2"
  outlineStyle: "solid"        # never dashed/dotted
form:
  controlHeight: "26px"
  controlPaddingX: "10px"
  buttonPrimary:
    background: "primary @ hover (0.4)"
    border: "1px solid primary @ active (0.7)"
    text: "background"            # dark on neon
  buttonSecondary:
    background: "transparent"
    border: "1px solid primary @ inactive (0.15)"
    text: "foreground"
  buttonGhost:
    background: "transparent"
    border: "none"
    text: "primary @ active (0.7)"
  input:
    background: "rgba(6, 10, 18, 0.6)"
    border: "1px solid primary @ inactive (0.15)"
    borderFocus: "1px solid primary @ active (0.7)"
    caret: "primary"
  checkbox:
    size: "12px"
    border: "1px solid primary @ active (0.7)"
    checkedFill: "primary @ neon"
scrollbar:
  width: "8px"
  trackBackground: "transparent"
  thumbBackground: "primary @ inactive (0.15)"
  thumbHoverBackground: "primary @ hover (0.4)"
  thumbBorderRadius: "0px"
cursor:
  terminal: "block"             # xterm.js cursor style
  text: "text"
  draggable: "grab"
  resizable: "ew-resize / ns-resize"
  disabled: "not-allowed"
zIndex:
  base: 0                       # workspace surface
  window: 100                   # terminal windows
  windowFocused: 110
  edgeGlow: 200                 # top/bottom edge overlays
  overlay: 1000                 # quick terminal, palette, whichkey
  modal: 2000                   # dialogs, confirms
  toast: 3000                   # transient notifications
  hint: 4000                    # leader-key hints, debug overlays
overlay:
  palette:
    width: "min(640px, 80vw)"
    maxHeight: "60vh"
    background: "rgba(6, 10, 18, 0.85)"
    padding: "md"
  whichkey:
    background: "rgba(6, 10, 18, 0.85)"
    padding: "sm"
    keyChipBorder: "1px solid primary @ hover (0.4)"
  toast:
    width: "320px"
    background: "rgba(6, 10, 18, 0.9)"
    rounded: "subtle"
    slideFrom: "right"
gauge:
  trackHeight: "4px"
  trackBackground: "primary @ ghost (0.04)"
  fillBackground: "primary @ active (0.7)"
  fillGlow: "glowTight"
  labelPosition: "above"
edgeGlow:
  topHeight: "5em"              # ~5 terminal rows; em so it scales with font
  bottomHeight: "5em"
  fadeDirection: "to interior"
  intensity: 0.8
effects:
  glowTight:
    blur: "6px"
    opacity: 0.6
  glowBloom:
    blur: "20px"
    opacity: 0.15
  textGlowTight:
    blur: "8px"
    opacity: 0.4
  textGlowBloom:
    blur: "14px"
    opacity: 0.15
  rimLight: "inset 0 1px 0 rgba(255, 255, 255, 0.03)"
  scanlineOpacity: 0.03
  gridDotOpacity: 0.03
  edgeGlowIntensity: 0.8
motion:
  breathingPulse: "3s ease-in-out infinite"
  ambientPulse: "1.2s ease-in-out infinite"
  dataStream: "1.8s linear infinite"
  scanWipe: "4s linear infinite"
  radarPing: "2.5s ease-in-out infinite"
  easeOut: "cubic-bezier(0, 0, 0.2, 1)"
  spring: "cubic-bezier(0.34, 1.56, 0.64, 1)"
  entrance: "cubic-bezier(0.22, 0.61, 0.36, 1)"
  reducedMotionPolicy: "drop all ambient infinite animations; keep entrance only, capped at 120ms"
accessibility:
  minContrastBodyOnBackdrop: 7.0    # foreground #b0c4d8 over rgba(6,10,18,0.5) on dark wallpaper
  minContrastLabelOnBackdrop: 4.5
  semanticColorOnDarkOnly: true     # red/amber/green/magenta tested only on dark wallpaper
  focusVisibleRequired: true
  hairlineOnHiDPI: "use box-shadow inset 0 0 0 1px when 1px border vanishes at @2x+"
forbidden:
  - "backdrop-filter: blur()"    # causes WKWebView freeze on macOS
  - "fully opaque backgrounds"   # break the transparency hierarchy
  - "rounded corners > 2px"      # violates hard geometry
  - "single-layer shadow"        # glows must be tight + bloom
  - "hard-coded hex in components" # all colors flow through CSS variables
  - "dashed or dotted outlines"   # focus must be solid + glow
  - "proportional (non-mono) fonts"
  - "any animation longer than entrance under prefers-reduced-motion"
---

## Overview

Krypton is a keyboard-driven terminal emulator dressed as a piece of fictional cyberpunk hardware — a thin neon HUD layered over deep blue-black void. The interface should feel like operating a salvaged military terminal: precise, instrumented, slightly luminous, and absolutely silent until you address it. Every visible element earns its presence; ornament is replaced with *signal*.

The aesthetic is built on three tensions:

1. **Hard geometry vs. soft light** — sharp 0px corners, 1px borders, and L-shaped corner accents are softened only by multi-layer glows that bleed into the surrounding void.
2. **Transparency vs. legibility** — backgrounds are never fully opaque (they sit between 40% and 92%), so the underlying desktop bleeds through, but text remains crisp via heavy contrast and selective glow.
3. **Stillness vs. life** — most of the UI is motionless. The few elements that animate (active tabs, status dots, progress gauges) breathe on slow 1–3s cycles. Motion is reserved for *state*, never decoration.

## Colors

The palette is monochromatic by intent. A single accent — **cyan `#0cf`** — drives every focus state, glow, border, and indicator. Other colors appear only as ANSI terminal output or semantic state (error, warning, special).

- **Primary cyan `#0cf`** — focus, glow, active state. Used at every opacity from 0.02 (ghost grid) to 1.0 (status dot at full neon). Never replace with another hue without breaking brand.
- **Foreground `#b0c4d8`** — cool slate text. Reads as "phosphor white" against the void without being aggressive.
- **Background `rgba(6, 10, 18, 0.5)`** — translucent ink. The 50% alpha is load-bearing; full opacity flattens the depth hierarchy.
- **Semantic state colors** (red `#ff3a5c`, amber `#e8c547`, green `#39ff7f`, magenta `#c77dff`) appear only on toast cards, error gauges, and AI/special indicators. They must not be used decoratively.
- **Link cyan `#33ddff`** — used only for inline anchors in toast bodies and dialog text. Always underlined; never bolded.

### The Opacity Scale

A single accent color stretches across the entire UI via opacity layering. Use the named tier (ghost / inactive / hover / active / neon) rather than reaching for a new color. Higher opacity = more salience; the scale is the brightness ladder of the whole interface.

| Tier | α | Where it shows up |
|---|---|---|
| ghost | 0.04 | Background grid dots, gauge tracks, disabled fills |
| inactive | 0.15 | Idle borders, tab separators, disabled text, scrollbar thumb |
| hover | 0.4 | Hovered borders, whichkey chips, secondary button border |
| active | 0.7 | Focused borders, active tab edge, primary indicators |
| neon | 1.0 | Status dots, gauge fill at full, text glow center |

## Typography

Monospace everywhere. The terminal nature of the product is the brand — proportional fonts would betray it. Default to **Mononoki** or **JetBrains Mono**.

- **Labels** (titlebar, tab text, badges) are uppercase with `0.08em` letter-spacing. This is the "panel labeling" voice — feels engraved into the chrome.
- **Body** is mixed case, normal spacing — reserved for content that the user actually reads (terminal output, prompts, dialog text).
- **Display** (large numerics, mode indicators) is uppercase with `0.2em` letter-spacing — wide, instrumented, console-readout feel.
- **Numerics in HUD** (gauges, timers, counters, byte sizes) **must** use `font-variant-numeric: tabular-nums`. Without it, digits jitter as values tick and the instrumented feel collapses.
- **Inline code inside body text** (dialog descriptions, toast messages) sits inside `rgba(0, 200, 255, 0.08)` with 1px hairline border at `inactive` tier and 2px horizontal padding. No background change on hover.

## Geometry

**0px corner radius is the default.** Hard angles are non-negotiable for windows, panels, palettes, dialogs. A 2px radius is permitted only on toast cards and small badges where the curve reads as a manufactured bevel rather than a soft pillow.

**Angled clip-paths** appear on active tabs (chamfered top corners), giving an industrial "machined" silhouette. Diagonals also appear in tab separators (12° rotation) — a subtle "this is not a spreadsheet" cue.

Every window has **four L-shaped corner accents** (14px × 2px brackets) drawn just inside the border. They glow at the focused-window opacity tier and serve as the primary focus indicator — more readable than a border color change alone.

### Window Anatomy

```
┌─[14px×2px corner accent]─────────────────[corner accent]─┐
│ ▌ TITLEBAR · 28px · uppercase label · status dot 6px    │  ← header accent strip 6px
├──────────────────────────────────────────────────────────┤
│ ░░░ edge glow ░░░ (5em tall, fades into pane)            │
│                                                          │
│         terminal content (xterm.js viewport)             │
│                                                          │
│ ░░░ edge glow ░░░                                        │
└─[corner accent]──────────────────────────[corner accent]─┘
   ↑ 1px border @ tier (inactive→active depending on focus)
```

## Glows

Glow is the signature visual mechanic. **Never use a single shadow.** Stack a tight inner glow with a wide outer bloom — this is what gives the accent its phosphor/neon character rather than a generic CSS drop-shadow.

- **Border glows** combine `0 0 6px @ 0.6` (tight) with `0 0 20px @ 0.15` (bloom).
- **Text glows** combine `0 0 8px @ 0.4` with `0 0 14px @ 0.15`.
- **Inset rim lights** (`inset 0 1px 0 rgba(255,255,255,0.03)`) add a "top edge catches the light" highlight on panels — a subtle hint of 3D extrusion.

Edge glow overlays (5em tall — sized in `em` so they scale with terminal font size — fading to transparent toward the pane interior) sit at the top and bottom of every terminal pane. They imply that the content is *emitting* light rather than being drawn on a screen.

## Focus States

The interface is keyboard-first. **Every focusable element must show a visible focus state** — `outline: none` without a replacement is forbidden.

- **Windows** use the four L-corner accents stepping from `inactive` to `active` tier; no border color change is needed.
- **Inputs, buttons, list rows, palette items** use a 1px solid outline at `active` tier with the standard tight-bloom glow stack. Never dashed or dotted.
- **Focus is keyboard-only** — use `:focus-visible`, not `:focus`. Mouse clicks should not draw rings on already-focused elements.
- **Active row in a list** (palette suggestion, file picker entry) gets a 2px left bar at `active` tier rather than a full outline — it reads as a cursor mark, not a button.

## Form Controls

Form controls are rare in Krypton (the product is a terminal, not an admin panel) but must exist for config dialogs, palette inputs, and ACP harness prompts.

- **Buttons** come in three flavors — primary (filled neon), secondary (bordered), ghost (text only). Use ghost for everything inside dense overlays; reserve primary for the single confirming action of a dialog.
- **Text inputs** sit on `rgba(6, 10, 18, 0.6)` with an `inactive`-tier border that snaps to `active` on focus. The caret is primary cyan. No animation on focus — the border change must be instant.
- **Checkboxes** are 12px squares with an `active`-tier border. When checked, fill with `primary @ neon` and a 1px inset rim light. There is no animation between states.
- **Selects / dropdowns** open downward as palette-style overlays (`zIndex: overlay`) with the same chrome as the command palette — never as native OS menus.
- **Disabled controls** drop to `inactive` tier text, `ghost` tier fill, and `cursor: not-allowed`. They keep their geometry — no greying out via desaturation.

## Scrollbars

Scrollbars must be visible but quiet. Terminal-style: thin, square, only the thumb is visible against transparent surfaces.

- 8px wide on the vertical axis, 8px tall on the horizontal.
- Track is fully transparent (the underlying surface shows through).
- Thumb is `primary @ inactive (0.15)` with no border or radius. On hover, step up to `hover (0.4)`.
- No buttons, no corners, no smooth scrolling beyond the OS default.
- Use the WebKit pseudo-elements (`::-webkit-scrollbar-*`) — there are no other engines to support.

## Selection & Cursor

- **Text selection** uses `rgba(0, 200, 255, 0.6)` (the `selection` token at `selectionAlpha`). Selected foreground remains the same color — readability comes from the saturated wash, not a fg swap.
- **Terminal cursor** is `block` style by default, primary cyan, no blink (the breathing motion of the chrome is enough liveness).
- **Mouse cursors** follow the affordance: `text` over selectable content, `grab` over draggable titlebars (`grabbing` while dragging), `ew-resize` / `ns-resize` / `nwse-resize` on window edges, `not-allowed` on disabled controls. Default `cursor: default` everywhere else — never `pointer` on chrome; the keyboard is the pointer.

## Numerics

Any digit that *changes* (timers, counts, gauges, byte sizes, percentage readouts) lives in `font-variant-numeric: tabular-nums`. Any digit that is static (a label like "v1.1.0") is fine in proportional figures. The instrumented feel comes from columns of digits that don't dance — this rule is load-bearing for HUD-style panels.

## Gauges & Progress

- Track: 4px tall, full width of its container, `primary @ ghost (0.04)`.
- Fill: from `0%` to current value, `primary @ active (0.7)` with the tight glow stack applied.
- Label sits *above* the gauge in label typography (11px / uppercase / 0.08em). Numeric readout sits at the right end of the label row, tabular-nums.
- For semantic state (error / warning), swap the fill color to the matching state token; the track stays cyan-tier.
- Indeterminate progress uses the `dataStream` animation sweeping across the fill (not the track) at `1.8s linear infinite`.

## States: Disabled / Loading / Empty

- **Disabled** — text drops to `inactive` (0.15), fills to `ghost` (0.04), cursor becomes `not-allowed`. Geometry is preserved; never collapse the element.
- **Loading** — replace content with a 1-line label at body typography saying what's loading, and a single indeterminate gauge below it. No spinners — they're decorative motion.
- **Empty** — display typography (28px uppercase) for the short headline, body typography for the secondary line. Center vertically in the container. No illustrations.

## Links & Inline Code

- **Links** in body text (toast messages, dialog descriptions, agent output) use the `link` token (`#33ddff`) with `text-decoration: underline` and `text-underline-offset: 2px`. No bold, no glow. Hover increases opacity to 1.0 but does not change color.
- **Inline code** (`` `foo` ``) in body sits in a 2px-padded chip with hairline border at `inactive` tier and `rgba(0, 200, 255, 0.08)` background. Same monospace family as everything else.

## Textures

Three repeating patterns add machine-grade detail without becoming busy:

- **Horizontal scanlines** (`rgba(0,0,0,0.03)` every 2px) on cards and panels — CRT artifact.
- **Vertical stripes** (`rgba(0,200,255,0.02)` every 4px) on tab bars — tech-grid feel.
- **Micro-dot grid** (radial gradient, 6px spacing, 3% opacity) on large background surfaces — instrumented field.

All three sit at 2–3% opacity. If the user *notices* them, they're too strong.

## Motion

Almost everything is still. The interface is a *terminal*, not a website — it should not draw attention to itself. Motion is allocated by importance:

- **Breathing pulses** (3s ease-in-out) on active tabs and primary indicators — slow enough to feel like a heartbeat, fast enough to confirm the element is live.
- **Data stream sweeps** (1.8s linear) on uplink bars and progress gradients — implies throughput.
- **Scan wipes** (4s linear) horizontal highlight pass across active tabs — implies sensor scanning.
- **Radar pings** (2.5s) on icon scale-pulses — implies acquisition.
- **Entrance animations** use `cubic-bezier(0.22, 0.61, 0.36, 1)` — a deliberate "hardware deploying" curve, not a bouncy spring. Toasts slide in from the right; windows scale up from 0.96.

All ambient animation must be `infinite` and `ease-in-out`. Linear is reserved for sweep effects where the constant velocity is the point.

### Reduced Motion

Under `@media (prefers-reduced-motion: reduce)`:

- **Drop** all ambient `infinite` animations (breathing, scan wipe, data stream, radar ping). The status dot stays lit at neon; the active tab stays at its peak state.
- **Keep** entrance animations but cap them at 120ms total — windows still appear with a brief scale, but no curve overshoot.
- **Keep** hover/focus transitions (they're informational, not decorative), capped at 80ms.

## Elevation / Z-Index

The interface has a fixed elevation ladder. New components must pick from this scale rather than inventing numbers:

| Layer | z-index | What lives there |
|---|---|---|
| base | 0 | Workspace surface, background textures |
| window | 100 | Terminal windows (unfocused) |
| windowFocused | 110 | The focused window |
| edgeGlow | 200 | Top/bottom emission overlays on panes |
| overlay | 1000 | Quick Terminal, command palette, whichkey |
| modal | 2000 | Confirmation dialogs, blocking forms |
| toast | 3000 | Transient notifications |
| hint | 4000 | Leader-key hints, hint-mode labels, debug overlays |

Breaking the ladder (e.g. a toast at `z-index: 999`) is a bug class — it lets focused windows occlude their own status messages.

## Transparency Hierarchy

The interface is a stack of translucent surfaces over the user's desktop wallpaper. Maintain the order:

1. **Workspace surface** — fully transparent (the user's desktop shows through).
2. **Window backdrop** — `rgba(6, 10, 18, 0.5)` — 50% deep ink.
3. **Overlays** (palette, whichkey, toasts) — `rgba(6, 10, 18, 0.85)` — denser ink that still shows depth.
4. **Modal foreground** (input fields, active cells) — up to `0.92` — never fully `1.0`.

Breaking this order — for example, an opaque modal over a translucent palette — collapses the depth model and the interface looks "broken."

## Overlay Specs

- **Command palette** — `min(640px, 80vw)` wide, `max-height: 60vh`, centered horizontally, anchored 15vh from the top. Background `rgba(6, 10, 18, 0.85)`. Internal padding `md`. Each row is `controlHeight` tall; active row gets the 2px left bar focus mark.
- **Whichkey** — bottom-anchored strip, `rgba(6, 10, 18, 0.85)`, padding `sm`. Key chips have an `inactive`-tier hairline border and `hover`-tier text. Chord-in-progress chip gets `active`-tier border.
- **Toast** — 320px wide, stacks bottom-right of workspace, slides in from right using `entrance` curve over 220ms. Auto-dismiss at 4s for info, 8s for warning, never for error (manual dismiss only).
- **Quick Terminal** — slides down from top edge; same backdrop as windows (`0.5`), not the overlay tier. It *is* a window in costume.

## Accessibility

- **Contrast** — Foreground `#b0c4d8` over the 50% backdrop maintains ≥7:1 against typical dark wallpapers. Label text at the 0.7 tier maintains ≥4.5:1. Semantic colors are validated only on dark wallpapers; users on light wallpapers should switch to a higher backdrop alpha theme.
- **Focus** — `:focus-visible` rings are mandatory on every focusable element. The keyboard-only product makes this non-negotiable.
- **Reduced motion** — see Motion § Reduced Motion. The infinite ambient pulses *will* trigger vestibular sensitivity if left on; this is not optional.
- **Hi-DPI hairlines** — pure 1px borders can vanish at @2x. Where a 1px border is critical (window chrome, palette edges), pair it with `box-shadow: inset 0 0 0 1px <color>` so it survives subpixel rounding.

## CSS Variable Mapping

Every token in this file's frontmatter maps to a `--krypton-*` CSS custom property on `:root`. The mapping rule is `kebab-case(path)`:

| Token path | CSS variable |
|---|---|
| `colors.primary` | `--krypton-color-primary` |
| `colors.foreground` | `--krypton-color-foreground` |
| `accentOpacity.hover` | `--krypton-opacity-hover` |
| `typography.label.size` | `--krypton-type-label-size` |
| `chrome.titlebarHeight` | `--krypton-chrome-titlebar-height` |
| `focus.ringColor` | `--krypton-focus-ring-color` |
| `zIndex.overlay` | `--krypton-z-overlay` |
| `motion.breathingPulse` | `--krypton-motion-breathing` |

Hard-coded hex, px, or duration values in component CSS are a smell — themes won't reach them and `prefers-reduced-motion` overrides won't apply.

## Theming

A theme TOML at `~/.config/krypton/themes/<name>.toml` may override:

- The full `colors` palette (including semantic and link).
- The full `ansi` table.
- `backgroundAlpha` and `selectionAlpha`.
- The `accentOpacity` scale (rare — only do this for a deliberately calmer/louder theme).

A theme **may not** override geometry, motion, typography, or focus tokens — those are part of the Krypton Dark identity. If you need to change those, you are defining a new aesthetic, not a Krypton Dark theme (see below).

## Platform Constraints

- **`backdrop-filter: blur()` is banned.** On macOS WKWebView with transparent windows, it freezes rendering. Translucency must be achieved through plain alpha-blended backgrounds, not native blur. This shaped the entire aesthetic — what looks like a blurred panel is actually a stack of low-alpha layers and scanline textures.
- **No CSS frameworks, no UI libraries.** All styling is vanilla CSS with BEM naming (`.krypton-window__titlebar--focused`). New components should match this convention.
- **All colors flow through `--krypton-*` CSS custom properties.** Hard-coded hex in component CSS is a smell — themes won't reach it. The token table at the top of this file is the source of truth.
- **Min window size** — below `320 × 120 px` the chrome collapses to titlebar-only (no corner accents, no edge glow). Below `200px` wide, the window snaps closed.

## When to Break the Rules

The rules above describe the *core* Krypton Dark identity. They are intentionally tight because the product's brand depends on consistency across a long-running, always-on, full-screen surface that the user lives inside.

If you are building something fundamentally different in character, do not bend Krypton Dark — define a new aesthetic in its own scoped per-view CSS file (e.g. `src/styles/vault-view.css`) and document it as a sibling `DESIGN.{name}.md` at the repo root. The codebase currently ships two alternatives:

- **`DESIGN.nasa.md`** — NASA Mission Control retro-futurism (Vault Viewer, `.krypton-vault`)
- **`DESIGN.amber.md`** — Warm amber phosphor / cassette futurism (Agent view, `.krypton-agent`)

### Sibling DESIGN Contract

Each sibling `DESIGN.<name>.md` must:

1. Use the same frontmatter shape as this file (`name`, `version`, `description`, `colors`, `typography`, `motion`, `forbidden`).
2. Declare a single root scoping selector (e.g. `.krypton-vault`) and confine *all* styles to descendants of that selector. The selector is part of the contract — global styles bleeding out of a sibling aesthetic is a bug.
3. Bump its own `version` independently. The base `DESIGN.md` version does not gate siblings.

What must *not* happen is partial drift inside Krypton Dark surfaces: a rounded corner here, an opaque modal there, a single-layer shadow somewhere else. That reads as bugs, not style.

## Changelog

- **1.1.0** — Added focus, form, scrollbar, cursor, zIndex, overlay, gauge, edgeGlow, accessibility, and CSS-variable-mapping specs. Added link color, tabular-nums policy, reduced-motion policy, sibling DESIGN contract, window anatomy diagram, hi-DPI hairline rule.
- **1.0.0** — Initial Krypton Dark spec: colors, typography, geometry, glows, textures, motion, transparency hierarchy, platform constraints.
