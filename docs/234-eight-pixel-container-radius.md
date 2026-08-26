# 8px Container Radius — Implementation Spec

> Status: Implemented
> Date: 2026-08-23
> Milestone: visual chrome
> Supersedes: [233](./233-four-pixel-container-radius.md)

## Problem

The Krypton Dark bevel was 4px (`--krypton-border-radius` /
`chrome.border.radius`). The user asked to increase container rounding from
4 to 8 so chrome reads a step softer without changing geometry elsewhere.

## Solution

Bump the existing token default from `4` to `8`. CSS fallbacks match
(`var(--krypton-border-radius, 8px)`). One bevel on every Krypton Dark
rectangular container. True circles stay `50%`. NASA Vault uses the same
token (`--vault-radius`); diamond status dots stay 0. Amber Agent frames,
Binance loopback pages, and tab clip-path chamfers are unchanged.

## Research

- Spec 233 already tokens every Krypton Dark container through
  `--krypton-border-radius`. A theme-default change plus CSS fallback
  rewrite is sufficient; no new selectors.
- 233 noted that 8–12px started to look like Warp / Ghostty. That was a
  taste call against a mixed 0/2/3px field. The user now wants 8px on a
  field that is already uniform, so the mixed-radius problem does not
  return.
- User config `~/.config/krypton/krypton.toml` selects `krypton-dark` with
  no `chrome.border.radius` override, so the bundled theme is the live
  value.

## Prior Art

| App | Implementation | Notes |
|-----|----------------|-------|
| Warp | Soft 8–12px cards | Consumer rounding; Krypton now sits at the low end of that band |
| Ghostty | Native rounded window | OS chrome, not DOM tiles |
| iTerm2 | Square or OS-rounded | Not a tiled DOM compositor |

**Krypton delta** — still one token on DOM chrome, not macOS window
rounding. 8px is the manufactured bevel; glow still carries focus.

## Affected Files

| File | Change |
|------|--------|
| `src-tauri/src/theme.rs` | `ChromeBorder` default radius 8 |
| `src-tauri/themes/*.toml` | `chrome.border.radius = 8` |
| `src/styles/*.css` | Fallback `4px` → `8px` on `--krypton-border-radius` |
| `src/styles/vault-view.css` | `--vault-radius` aliases the 8px token; diamond dots stay 0 |
| `DESIGN.md` | 1.2.3 — vault uses the token; 1.2.2 was the 8px default |
| `PRODUCT.md` | Brand personality 8px bevel |
| `docs/10-theme-specification.md` | Default 8 |

## Design

No new types. `chrome.border.radius` still maps to `--krypton-border-radius`.
CSS fallback is `8px` so a missing theme still bevels.

## Edge Cases

- Same load-bearing rules as 233: `overflow: visible` on `.krypton-window`;
  6px status squares stay square; cursor-trail teardrop is not a container;
  markdown `th`/`td` stay square (the `table` is the 8px container,
  including vault `.krypton-vault__table` with `border-collapse: separate`);
  stacked picker chrome uses split
  top/bottom radii (lane picker is one `.acp-harness__picker-panel` with the
  container radius).
- Harness composer stays `0px` (command line, not a card). The host window,
  titlebar, and footer keep the 8px token — squaring them with the prompt
  made the main window lose its bevel. See spec 233 edge cases.
- NASA Vault windows, frontmatter, picker, inputs, chips, thumbs, and
  markdown tables use `--vault-radius` → `--krypton-border-radius`. The
  rotated 4px status diamond stays `border-radius: 0`.
- 8px-wide scrollbar thumbs become fully rounded ends. That is the same
  token, not a second radius.

## Out of Scope

Changing Amber Agent window frames. Changing Binance loopback pages.
Removing tab chamfers.

## Resources

- N/A — token bump of spec 233.
