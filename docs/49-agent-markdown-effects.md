# 49. Agent Markdown Visual Effects

Futuristic visual effects applied to AI agent markdown responses, giving the agent view a cyberpunk HUD aesthetic that goes beyond plain rendered markdown.

## Overview

All effects are pure CSS — no JavaScript changes required. They use GPU-friendly properties (`transform`, `opacity`, `filter`) and subtle opacity values to enhance readability rather than overwhelm it. Effects respect the `--krypton-window-accent-rgb` CSS variable so they adapt to the active theme.

## Effects

### Assistant Message Container

| Effect | Implementation | Details |
|--------|---------------|---------|
| Scanline overlay | `repeating-linear-gradient` on `.agent-view__msg--assistant` | Horizontal lines every 4px at 1.2% accent opacity — CRT/HUD feel |
| Materialize animation | `agent-msg-materialize` keyframes | 0.3s fade-in with 4px upward slide + 2px blur dissolve on creation |
| Label flicker | `agent-label-flicker` keyframes on `.agent-view__msg-label` | 4s cycle with micro-opacity dips at 93%/95% — digital interference |

### Headings (h1–h4)

| Effect | Implementation | Details |
|--------|---------------|---------|
| Neon glow pulse | `heading-glow-pulse` keyframes | 3s breathing cycle between two `text-shadow` glow intensities |
| H1 gradient wash | `linear-gradient` background on `h1` | Subtle accent-colored background fading right, with bottom border |

### Code Blocks (`pre`)

| Effect | Implementation | Details |
|--------|---------------|---------|
| Animated edge sweep | `code-edge-sweep` keyframes on `pre::before` | 1px gradient line (cyan → magenta → cyan) sweeps across the top edge in 4s loop |
| Inner glow | `box-shadow` on `pre` | Inset 30px soft glow + outer 15px ambient glow |
| Accent left border | `border-left: 2px` on `pre` | Stronger left edge line in accent color |

### Inline Code

| Effect | Implementation | Details |
|--------|---------------|---------|
| Neon text-shadow | `text-shadow` on `code` | 6px accent glow at 15% opacity |

### Blockquotes

| Effect | Implementation | Details |
|--------|---------------|---------|
| Holographic shimmer | `blockquote-shimmer` keyframes on `blockquote::after` | Translucent highlight sweeps across the surface on a 6s loop |
| Gradient background | `linear-gradient(135deg)` | Diagonal cyan → magenta → cyan at very low opacity |

### Horizontal Rules

| Effect | Implementation | Details |
|--------|---------------|---------|
| Traveling pulse | `hr-pulse-travel` keyframes on `hr::before` | 30px glowing dot slides left-to-right across the line in 3s |

### Tables

| Effect | Implementation | Details |
|--------|---------------|---------|
| Row hover highlight | `tr:hover td` | Rows light up with accent color on hover |
| Header glow | `text-shadow` on `th` | Neon glow on header text with stronger bottom border |

### Lists

| Effect | Implementation | Details |
|--------|---------------|---------|
| Custom bullets | `ul > li::before` | Replaces default dots with glowing cyan `▸` arrow markers |

### Links

| Effect | Implementation | Details |
|--------|---------------|---------|
| Hover glow | `a:hover` | Text-shadow intensifies, color brightens, border-bottom strengthens |

### Bold / Italic

| Effect | Implementation | Details |
|--------|---------------|---------|
| Bold glow | `text-shadow` on `strong` | Subtle 4px foreground-color glow |
| Accent italic | `color` on `em` | Italic text uses accent color at 70% opacity |

## Files Modified

| File | Change |
|------|--------|
| `src/styles/agent.css` | All CSS effects (animations, pseudo-elements, gradients, shadows) |

## Performance Notes

- All animations use `transform`, `opacity`, or `background-position` — composited on GPU
- No layout-triggering properties are animated
- Pseudo-element overlays use `pointer-events: none` so they don't interfere with text selection
- Scanline repeating-gradient is static (no animation), very cheap to render
- Shimmer/sweep animations use `background-size` + `background-position` — no repaints
