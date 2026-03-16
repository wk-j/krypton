# Backdrop-Filter Removal — macOS Transparency Fix

> Status: Implemented
> Date: 2026-03-16
> Milestone: M8 — Polish (bug fix)

## Problem

Terminal windows show a frozen/stale snapshot of the desktop wallpaper (including video wallpapers) when Krypton is focused. The transparency works correctly in the **workspace area** (gaps between windows) and when the app is **unfocused**, but the terminal window areas freeze on focus — the video wallpaper stops updating behind them.

## Root Cause

CSS `backdrop-filter: blur()` on macOS transparent WKWebView windows causes the native compositor to **snapshot** the content behind the blurred element rather than continuously compositing it live. When the Tauri window gains focus, macOS optimizes rendering by freezing this snapshot, which means dynamic desktop content (video wallpapers, animations) behind the terminal windows stops updating.

The issue is specific to the interaction between:
1. Tauri's `transparent: true` native window (WKWebView with transparent backing layer)
2. CSS `backdrop-filter: blur(Npx)` applied to DOM elements within that transparent webview
3. macOS window server focus optimization

The workspace area (`.krypton-workspace`) was unaffected because it only uses `background: transparent` with **no** `backdrop-filter`.

### Secondary Issue: xterm.js Inline Background Color

Additionally, xterm.js's internal color parser (`z.toColor`) rejects any color with alpha < 255. When the terminal theme background is set to `rgba(0, 0, 0, 0)`:
1. The parser draws it on a canvas and reads back via `getImageData()`
2. Sees alpha = 0, throws `"toColor: Unsupported css format"`
3. Falls back to `#000000` (opaque black)
4. Sets `style.backgroundColor = '#000000'` as an **inline style** on the `.xterm-scrollable-element` DOM node

Our existing CSS `!important` rules targeted `.xterm`, `.xterm-viewport`, and `.xterm-screen` but missed `.xterm-scrollable-element`.

## Solution

### 1. Remove `backdrop-filter` from all elements

Removed all `backdrop-filter` and `-webkit-backdrop-filter` declarations from `src/styles.css`. The semi-transparent `background` color (rgba with alpha) remains, providing a tinted overlay without triggering the macOS compositor snapshot behavior.

Affected elements:

| Element | Previous | After |
|---------|----------|-------|
| `.krypton-window` | `backdrop-filter: blur(12px)` | Removed — semi-transparent background only |
| `.krypton-quick-terminal` | `backdrop-filter: blur(20px)` | Removed |
| `.krypton-whichkey__popup` | `backdrop-filter: blur(16px)` | Removed |
| `.krypton-hint-toast` | `backdrop-filter: blur(16px)` | Removed |
| `.krypton-palette__container` | `backdrop-filter: blur(16px)` | Removed |
| `.krypton-dashboard__backdrop` | `backdrop-filter: blur(8px)` | Removed |

### 2. Add `.xterm-scrollable-element` CSS override

Added `background-color: transparent !important` rule for `.xterm-scrollable-element` to override the inline style that xterm.js sets at runtime:

```css
.krypton-window__body .xterm-scrollable-element,
.krypton-pane__terminal .xterm-scrollable-element {
  background-color: transparent !important;
}
```

## Affected Files

| File | Change |
|------|--------|
| `src/styles.css` | Removed all `backdrop-filter` / `-webkit-backdrop-filter` declarations; added `.xterm-scrollable-element` transparency override |

## Visual Impact

- Terminal windows retain their semi-transparent colored tint (e.g., `rgba(6, 10, 18, 0.5)`) controlled by `[visual] opacity` config
- The frosted-glass blur effect behind windows is no longer applied
- Video wallpapers and dynamic desktop content now render live through terminal windows at all times, regardless of focus state
- The `[visual] blur` and theme `chrome.backdrop.blur` config values are still parsed but have no visible effect (the CSS property they controlled has been removed)

## Configuration Impact

The following config/theme keys remain in the schema but are currently **inert** (no visible effect):

| Source | Key | Note |
|--------|-----|------|
| `[visual]` | `blur` | Was applied as `--krypton-window-blur`. CSS property removed. |
| Theme `[chrome.backdrop]` | `blur` | Was applied as `--krypton-backdrop-blur`. CSS property removed. |
| Theme `[ui.which_key]` | `backdrop_blur` | Was applied as `--krypton-whichkey-blur`. CSS property removed. |
| Theme `[ui.quick_terminal]` | `backdrop_blur` | Was applied as `--krypton-qt-blur`. CSS property removed. |
| Theme `[ui.command_palette]` | `backdrop_blur` | Was applied as `--krypton-palette-blur`. CSS property removed. |

These keys are kept in the config/theme parsers for forward compatibility — if a cross-platform blur solution is found in the future, they can be re-enabled without breaking existing config files.

## Why Not Alternative Approaches

| Approach | Reason rejected |
|----------|----------------|
| `filter: blur()` on pseudo-element | Blurs the element's own content, not the desktop behind it. Would blur terminal text. |
| Default blur to 0, allow opt-in | Users who enable it would still hit the freeze bug on macOS. |
| Platform-detect and only disable on macOS | Adds complexity; Tauri's WKWebView is the primary target platform. |
| `NSVisualEffectView` via native code | Would require `objc` crate, platform-specific window manipulation, and may still have the same focus-snapshot behavior. |

## Related

- macOS WKWebView transparent window compositing behavior
- Tauri `transparent: true` + `macOSPrivateApi: true` configuration
- xterm.js `allowTransparency: true` and internal color parser limitations
