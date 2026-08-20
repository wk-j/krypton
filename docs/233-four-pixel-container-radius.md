# 4px Container Radius — Implementation Spec

> Status: Implemented
> Date: 2026-08-20
> Milestone: visual chrome

## Problem

Krypton Dark used 0px corners as the identity, with 2px only on toasts and
badges. That left a mixed field of hardcoded 0/1/2/3px radii across views.
The user picked a uniform 4px manufactured bevel for every rectangular
container after a live preview.

## Solution

One token, `--krypton-border-radius`, default `4px` from
`theme.chrome.border.radius`. Every Krypton Dark rectangular container
(windows, overlays, chips, buttons, inputs, tabs, scroll thumbs) uses that
token. True circles stay `50%`. NASA Vault and Amber Agent keep their sibling
geometry (vault frame 3px / diamond dots; agent window 0px).

Windows stay `overflow: visible` so the 2.9× title tail and dock-zoomed lane
logo can hang off the rail. Titlebar and footer inherit the top/bottom radii
so square children do not poke through the 4px curve.

## Research

- Windows already read `--krypton-border-radius`; overlays and most views
  hardcoded 0–3px, so a theme-only change would have rounded shells and left
  the HUD mixed.
- A first pass that only rewrote existing `0–3px` `border-radius` values left
  every control that had never declared a radius square. The follow-up pass
  tokens those too: rail cards, composer, tabs, chips, badges, question and
  provider-error cards, mention/slash palettes, review-board panels, telegram
  cards, and agent-view inner controls. The agent *window frame* stays `0px`.
- 4px is the bevel that still reads as hardware. 8–12px started to look like
  Warp / Ghostty. Circles at 50% are indicators, not containers.
- Tab chamfers (clip-path, per-role) stay. They are a silhouette signal, not a
  container edge. Tabs also pick up the 4px top radius.

## Prior Art

| App | Implementation | Notes |
|-----|----------------|-------|
| Ghostty | Native rounded window | OS chrome, not DOM tiles |
| Warp | Soft 8–12px cards | Consumer app; Krypton stays a 4px bevel |
| iTerm2 | Square or OS-rounded | Not a tiled DOM compositor |

**Krypton delta** — one 4px token on DOM chrome, not macOS window rounding.
Keyboard-first HUD, glow still carries focus.

## Affected Files

| File | Change |
|------|--------|
| `src-tauri/src/theme.rs` | `ChromeBorder` default radius 4 |
| `src-tauri/themes/*.toml` | `chrome.border.radius = 4` |
| `src/styles/*.css` | Hardcoded 0–3px *and* radius-less bordered controls → `var(--krypton-border-radius, 4px)` |
| `DESIGN.md` | 1.2.0 — 4px default, forbidden list updated |
| `docs/10-theme-specification.md` | Default 4 |

## Design

No new types. The existing `chrome.border.radius` u32 maps to
`--krypton-border-radius`. CSS fallback is `4px` so a missing theme still
bevels.

## Edge Cases

- `overflow: visible` on `.krypton-window` is load-bearing (specs 218/226).
  Do not clip the window to hide corner poke; inherit inner radii instead.
- 6px status squares stay square. 4px on a 6px box would read as a disc.
- Cursor-trail teardrop shape is not a container.
- Loopback artifact pages stay on DESIGN.binance.md radii.
- Markdown `th`/`td` stay square so collapsed table borders do not double-bevel.
- Stacked picker chrome (head / list / empty) uses split top/bottom radii on
  the end pieces; the middle directive list stays square so the seam joins.

## Out of Scope

Changing NASA Vault or Amber Agent window frames. Changing Binance loopback
pages. Removing tab chamfers.

## Resources

- N/A — internal token sweep after the 4px preview.
