# Light Scheme Legibility — Implementation Spec

> Status: Implemented — 2026-10-21 (WKWebView fixture smoke; check in the installed app is pending a rebuild, see Verification)
> Date: 2026-10-21
> Milestone: Themes — light scheme
> Amends: [010](./0010-theme-specification.md) §Applying a theme (light-scheme rules) · [006](./0006-configuration.md) `[visual] opacity`

## Problem

On `krypton-light`, most secondary text and every lane-identity label fall below WCAG AA. The measurements below come from a screenshot of the running Harness and a static audit at `498a4e7`. Thought text is 2.45:1, meta labels are 2.4–3.8:1, and lane names are 1.23–2.72:1. The desktop wallpaper also shows through the translucent chrome. Three things are wrong in the base design: text is dimmed by alpha, the identity accents are neon values designed for a dark background, and surfaces are translucent while blur is banned.

## Solution

All three changes are scoped to `html[data-theme-scheme='light']`. The dark scheme renders exactly as before. Every new token is undefined in dark, and every converted declaration keeps its current value as the `var()` fallback.

1. **Opaque ink tiers.** `theme.ts` solves `--krypton-ink-2/3/4` for each light theme to fixed contrast targets (7 / 4.5 / 3:1) against the darkest neutral surface. Each of the 319 alpha-dimmed base text declarations is mapped to a tier, and its current value stays as the fallback. The 27 light-rule sites take the tier directly.
2. **Accent ink.** In light, an accent used as text passes through one OKLCH lightness cap: `oklch(from <accent> min(l, var(--krypton-accent-l-max)) c h)`, with the cap at 0.44. Hue and chroma are kept, and all 25 palette accents reach at least 4.65:1. The capped colour is declared once on each element that carries an accent, as `--acp-lane-ink` or `--krypton-window-ink`.
3. **Near-opaque light surfaces.** The window backdrop alpha has a floor of 0.94 over `[visual] opacity`. `--agent-surface-solid` becomes opaque. The `krypton-light` backdrop moves to 0.96. The lane-head wash drops from 18% to 8%.

## Research

**Measured.** Screen values come from a screenshot. Computed values use the CSS value composited on white.

| Element | Source | Contrast |
|---|---|---|
| Thought body | `thought-card.css:102` `rgba(var(--krypton-fg-rgb), 0.42)` | 2.45 computed, 2.52 on screen |
| Message label, rail hint | light rules `color-mix(ink 58%, transparent)` | 3.77 |
| Lane meta line | `lane-head` ink-alpha on the 18% cream wash | 2.39 on screen |
| Composer `OMP-1` | `draft-line.css:39` raw `--acp-lane-accent` `#ff9f1c` | 2.05 computed, 2.01 on screen |
| `LANE_ACCENT_PALETTE` (`harness-lane-identity.ts:180`) | 13 fixed hexes on white | 1.23–2.72 |
| Titlebar | transparent over the window body at `[visual] opacity` 0.7 | wallpaper hue visible, effective coverage about 0.6 |
| Rail cards | `--agent-surface-solid` = `#fff` at 0.94, absolutely positioned over the transcript (`harness-shared.css:362-376`) | transcript glyphs show through at 6% |

- **Census.** 414 text declarations (`color`, `fill`, `caret-color`) take their colour from alpha-dimmed fg: `rgba(var(--krypton-fg-rgb…), α)` or `color-mix(in srgb, var(--krypton-ink|fg) N%, transparent)`.
  - 387 sit in base rules across 58 sheets: 61 at α ≥ 0.85, 70 at 0.62–0.85, and 256 below 0.62. Of the 68 below 0.42, almost all carry information (dates, counts, empty states, labels). Only separators, placeholders and disabled states are decorative.
  - The other 27 sit in light-scheme rules.
  - α takes 40 distinct values between 0.22 and 0.98.
- **Why alpha works in dark only.** In dark, `#d8e8d8` at α 0.42 on the void gives 3.44:1, and at 0.58 gives 5.58:1. In light, `#1c2c3c` at the same alphas gives 2.45:1 and 3.77:1. The dark recipe is house style (DESIGN.md "The Opacity Scale"), so it stays.
- **Existing light machinery.** `themeScheme()` (`theme.ts:300`) classifies the theme by backdrop luminance. `theme-scheme.css` and the per-component `@layer krypton.scheme` blocks hold the overrides. `--krypton-ink` is already a light-only property (`theme-scheme.css:14-16`), which is the precedent for "light token, dark fallback".
- **Accent flow** (traced end to end):
  - **Lane accent.** It is picked at random per lane, kept in memory and never persisted. It is set inline on four roots: `.acp-harness__lane`, `.acp-harness__rail-entry`, `.acp-harness__composer` and `.acp-harness__lane-queue`. It also reaches the host window through `--acp-host-lane-accent`, which `window.css:123-126` maps to `--krypton-window-accent` with `!important`.
  - **Other window accents.** The manual pick uses a second palette (`compositor.ts:328`). The footer lane marks set `--krypton-lane-accent` inline (`compositor.ts:1839`).
  - **Consumers.** 17 rules use the lane accent raw as text, and 13 of them have no light override. Five light rules mix the accent 38–48% with ink, but a fixed 40% share bottoms out at 3.33:1 on the lightest hues.
- **Mixing method.** Mixing toward ink in sRGB muddies the hue: `#ff9f1c` becomes `#7a5c2f`. Capping OKLCH lightness keeps the chroma instead: `#ff9f1c` becomes `#854f00`, `#8effb0` becomes `#007138`, and `#ffd166` becomes `#765900`.
- **Gamut.** A capped colour can fall outside sRGB. The worst case over all 25 accents (13 lane, 10 manual, theme `#007799`, OMP `#d9c66f`), against the rail and against white, is 4.65:1 with per-channel clipping and 5.34:1 with chroma-reduction mapping.
- **Where `var()` resolves.** A `var()` inside a custom property resolves on the element that declares it, so the derived ink must be declared on the element that carries the inline accent. This is the same reason given in the comment at `theme-scheme.css:18-20`.
- **WebKit probe** (WKWebView, macOS 27.0.1): `CSS.supports('color', 'oklch(from red min(l, 0.44) c h)')` is `true`. `#8effb0` computes to `oklch(0.44 0.150964 152.119217)`, both directly and through a custom property.
- **Surfaces.**
  - The window body is `--krypton-backdrop-color`, whose alpha `compositor.ts:752-770` replaces with `[visual] opacity` (default 0.5; this user runs 0.7). The titlebar is transparent.
  - xterm is forced transparent (`compositor.ts:293`).
  - Blur is banned (`docs/0004-architecture.md:708-712`).
  - **Floor derivation.** Contrast of ink-3 against the window body composited over a black wallpaper is 4.44 at α 0.92, 4.54 at 0.93 and 4.64 at 0.94.
- **Rejected alternatives.**
  - One tier set for both schemes: it would collapse dark's 40-value alpha ladder, which is a visible change to dark.
  - `light-dark()` with `color-scheme`: it changes the UA canvas, scrollbars and form defaults in a transparent window, and nothing in the repo uses it yet.
  - Hand-picked light hexes per palette entry: three palettes would need them, in-memory lane colours would need rewiring on every scheme switch, and the theme-accent entries are `var()` strings.
  - A fixed CSS mix share: any share that passes every hue muddies the dark hues.
  - Accent inks computed in TS: this needs the same root rules plus new setters at 7 sites.

## Prior Art

| App | Implementation | Notes |
|---|---|---|
| GitHub Primer | Opaque semantic `fgColor.default` / `muted` / `disabled`, with values per theme. Light `fgColor.muted` is `#59636e` (6.1:1 on white). Muted is "for secondary text like timestamps, metadata". | Tiers are opaque and defined per scheme. |
| Zed | Theme JSON `text`, `text.muted`, `text.placeholder`, `text.disabled`, opaque in each theme. One Light has `#242529` (14.7:1), `#58585a` (6.8:1) and `#7e8086` (3.8:1). The collaborator colours (`players`) are separate per theme: light `#5c78e2`, dark `#74ade8`. | Four text tiers; identity colours are re-derived for light. |
| Radix Colors | Separate light and dark 12-step scales. Steps 11 and 12 are text and are "guaranteed to Lc 60 and Lc 90 APCA contrast ratio" on step 2. | Text steps are solid colours, solved per scheme. |
| macOS AppKit | Label colours are alpha-based: Aqua `secondaryLabelColor` is black at 50% and Dark is white at 55%. | Alpha works for AppKit because its base is pure black on opaque or vibrant (blurred) surfaces. Krypton has slate ink, translucent surfaces and no blur. |

**Krypton delta.** In light, Krypton follows Primer, Zed and Radix: opaque tiers solved per theme, and identity colours re-derived for the scheme. Dark keeps its alpha ladder, which is closer to AppKit. Light identity colours are derived through an OKLCH lightness cap rather than hand-picked tables, so live lane colours and user picks are covered without new state.

## Affected Files

| File | Change |
|---|---|
| `src/theme.ts` | Add `mixToContrast()`, `effectiveBackdropAlpha()` and `LIGHT_BACKDROP_ALPHA_FLOOR`. Emit light-only `--krypton-ink-2/3/4`. Make `--agent-surface-solid` opaque in light. `setCssProperties` removes every property the previous apply set that the new record lacks. |
| `src/theme.test.ts` | Tests listed under Verification. Remove the pinned `0.94` surface assertion (`:243`). |
| `src/compositor.ts` | The opacity block (`:752-770`) uses `effectiveBackdropAlpha()` for the backdrop, the quick terminal and the dashboard panel. |
| `src-tauri/themes/krypton-light.toml` | `[chrome.backdrop] color` alpha goes from 0.90 to 0.96; `version` becomes 1.2.0. |
| `src/styles/theme-scheme.css` | Add `--krypton-accent-l-max: 0.44` and `.krypton-window { --krypton-window-ink }`. Chrome accent text uses the window ink. Drop `opacity: 0.78` from `.krypton-window__label`. Convert 10 light text sites to tiers. |
| 57 sheets under `src/styles/` and `src/acp/components/` | Convert alpha-dimmed text to tiers using the mapping below (319 declarations; whole-value matches only). |
| `lane-shell.css`, `rail-entry.css`, `composer.css`, `queue-card.css` | Declare `--acp-lane-ink` on the block root in light. |
| `assist-strip`, `caret`, `dictation-control`, `draft-line`, `grammar-panel`, `live-voice-strip`, `peek-card`, `thought-card`, `usage-row`, `queue-card` sheets | Raw lane-accent text becomes `var(--acp-lane-ink, <current>)`. |
| `lane-head.css`, `lane-stats.css`, `rail-entry.css`, `transcript-row.css` | The light rules that mix lane accent with ink use `var(--acp-lane-ink)` instead. Lane-head and lane-stats wash drops from 18% to 8%. |
| `heat-panel.css`, `memory-drawer.css` | Light rule applying the accent-ink recipe to the heat tags and the memory source. |
| `docs/0010`, `docs/0006`, `docs/0004:526`, `docs/README.md` | Light-scheme rules, opacity floor, architecture line, index row 321. |

## Design

### Data Structures

```ts
// src/theme.ts
/** Opaque mix of `light` into `dark` with the largest `light` share whose
 *  serialized (rounded) colour still reaches `target` contrast on `surface`.
 *  Returns `dark` when even `dark` misses the target. */
export function mixToContrast(dark: string, light: string, surface: string, target: number): string;

/** Window backdrop alpha after the light-scheme floor. */
export const LIGHT_BACKDROP_ALPHA_FLOOR = 0.94;
export function effectiveBackdropAlpha(theme: FullTheme, opacity: number): number;
//   light → Math.max(opacity, LIGHT_BACKDROP_ALPHA_FLOOR); dark → opacity
```

Light branch of `themeCssProperties()`:

```ts
const backdropOpaque = withAlpha(backdrop, 1);
const rail = mixColors(c.foreground, backdropOpaque, 0.09); // surfaceRail without alpha
'--krypton-ink-2': mixToContrast(c.foreground, backdropOpaque, rail, 7),
'--krypton-ink-3': mixToContrast(c.foreground, backdropOpaque, rail, 4.5),
'--krypton-ink-4': mixToContrast(c.foreground, backdropOpaque, rail, 3),
'--agent-surface-solid': 'rgba(255, 255, 255, 1)',
```

For `krypton-light` this gives approximately `#374655`, `#556370` and `#717f8b`: 7.0 / 4.5 / 3.0:1 on the rail and 9.7 / 6.2 / 4.1:1 on white. `--krypton-ink` (tier 1) stays in `theme-scheme.css` as `var(--krypton-fg)`, so a `[tokens]` override of `--krypton-fg` still flows through.

### Tier mapping

This applies to base-rule `color`, `fill` and `caret-color` values matching the census patterns:

| Current α | New value |
|---|---|
| ≥ 0.85 | unchanged (already ≥ 8:1) |
| 0.62–0.84 | `var(--krypton-ink-2, <current>)` |
| < 0.62 | `var(--krypton-ink-3, <current>)` |
| < 0.62, and the selector is `::placeholder`, `:disabled` or `--disabled`, or a `::before`/`::after` whose content is a separator glyph | `var(--krypton-ink-4, <current>)` |

- **Light-rule sites (27).** The same mapping applies, written without a fallback. These rules are converted, not deleted. A `@layer krypton.scheme` rule beats every component-layer rule whatever its specificity, so deleting one would let variants such as `.acp-harness__msg--assistant .acp-harness__msg-label` take over in light.
- **Not converted.** `remote-picker.css` keeps its fixed dark panel (`#0a1118`) in both schemes. Diff, live-assist and the triage and review overlays have no fg-alpha text.
- **No opacity dimming.** No light rule may dim text with `opacity` below 1.

### Accent ink

```css
/* theme-scheme.css */
html[data-theme-scheme='light'] { --krypton-accent-l-max: 0.44; }
html[data-theme-scheme='light'] .krypton-window {
  --krypton-window-ink: oklch(from var(--krypton-window-accent) min(l, var(--krypton-accent-l-max)) c h);
}
/* lane-shell / rail-entry / composer / queue-card, each in its @layer krypton.scheme */
html[data-theme-scheme='light'] .acp-harness__lane {
  --acp-lane-ink: oklch(from var(--acp-lane-accent) min(l, var(--krypton-accent-l-max)) c h);
}
```

- **Lane text consumers.** `color: var(--acp-lane-accent…)` becomes `color: var(--acp-lane-ink, var(--acp-lane-accent…))`. The queue card's `--acp-queue-accent` is the origin of its own root's ink.
- **Window chrome light rules.** Rules with an accent share of 40% or more become `var(--krypton-window-ink)`: label (48%), focused label (62%), usage name, project, and project initials (88%). Shares of 30% or less (pty status, usage provider, both 28%) already reach 4.6:1 and stay as they are.
- **Elements that carry the accent on themselves.** The footer `.krypton-window__lane` mark, the heat tags (`heat-panel.css:85,89`, currently 85% with white) and the memory source take the recipe inline in their light rule.

### Data Flow

```
1. theme-changed → FrontendThemeEngine.apply → themeCssProperties
   light: --krypton-ink-2/3/4 + opaque --agent-surface-solid; dark: neither
2. setCssProperties writes the record, removes keys the previous apply set
   that this record lacks, and sets html[data-theme-scheme]
3. theme-scheme.css (light) defines --krypton-ink and --krypton-accent-l-max
4. A root with an inline accent (lane, rail entry, composer, queue card,
   window) computes its ink in its own light rule; descendants inherit it
5. Converted declarations: light → token; dark → the unchanged fallback
6. applyConfig → effectiveBackdropAlpha(theme, [visual] opacity) →
   --krypton-backdrop-color, --krypton-qt-bg, --krypton-dashboard-panel-bg
```

### Configuration

No new keys. The `[visual] opacity` docs gain one line: under a light-scheme theme the effective value is at least 0.94, because a light translucent surface takes on the wallpaper's hue when it cannot be blurred.

## Edge Cases

- **Dark scheme.** The tokens and `--krypton-accent-l-max` are undefined and every light rule is gated, so dark keeps its current values. This holds by construction, and the Verification step diffs it.
- **Live switch from light to dark.** The engine removes the stale `--krypton-ink-*` properties. The root rules stop matching when the attribute changes.
- **Custom light themes.** Tiers are solved against the theme's own rail. `[tokens]` may override `--krypton-ink-*` or `--krypton-accent-l-max`. If a light theme's fg cannot reach a target, `mixToContrast` returns the fg itself.
- **WebKit without relative colours or numeric channel keywords.** The custom property still holds the token stream, so a consumer's `color` becomes invalid at computed-value time and inherits its parent's ink. The text stays readable but loses its hue. The `var()` fallback does not apply in this case.
- **The user's `~/.config/krypton/themes/krypton-light.toml`.** It shadows the bundled theme and still has backdrop alpha 0.90, so the 0.96 change does not reach the user until that file is updated or removed. The CSS and TS changes apply regardless.
- **Palette theme switch.** Today's behaviour is unchanged: `set_theme` writes the theme's own backdrop alpha, and `[visual] opacity` plus the floor are applied again only on Reload Config or at launch. `krypton-light`'s own alpha (0.96) is already above the floor.
- **Sealed transcript rows (AGENTS constraint 10).** The changes are stylesheet and root-variable only. No row DOM is written, and a theme switch restyles through the cascade, as it does today.
- **GenUI gallery** (loopback page, spec 313). It sets the scheme and properties through the same `themeCssProperties` and `themeScheme`, so it receives the tiers too.

## Open Questions

None.

## Out of Scope

- The 265 hard-coded neon or light text literals (for example `rgba(216, 232, 216, 0.5)` ×18) and the 42 dark literal backgrounds: triage, review-matrix and review-priority overlays, remote picker, ticket-dock amber pills, Telegram settings and the markdown view. These need a follow-up spec.
- Non-text alpha (borders, tints, backgrounds), apart from the lane-head and lane-stats wash.
- Any dark-scheme visual change; DESIGN.md (dark identity); the terminal ANSI palette; Vault and Agent views; loopback HTML pages (they use their own `prefers-color-scheme`); the live-assist window.
- A repo-wide contrast lint, and reapplying `[visual] opacity` on a palette theme switch.

## Verification

- **Unit tests** (`src/theme.test.ts`):
  - For `krypton-light` and for a synthetic warm light theme, the light tiers meet 7 / 4.5 / 3:1 on the opaque rail, and ink-2 < ink-3 < ink-4 in luminance.
  - A dark record has no `--krypton-ink-*` key.
  - Applying light and then dark removes `--krypton-ink-3` from `documentElement.style`.
  - `mixToContrast` returns `dark` when the target is unreachable.
  - `effectiveBackdropAlpha` gives light 0.7 → 0.94, light 0.98 → 0.98, and dark 0.7 → 0.7.
  - The light `--agent-surface-solid` alpha is 1.
- **Checks.** `npm run check`, the full `npx vitest run` (including `styles-ownership.test.ts`), and `cargo test` for the TOML test.
- **Dark unchanged.** A throwaway script diffs every converted declaration and asserts that its `var()` fallback equals the pre-change value byte for byte.
- **Smoke (done).** A second `tauri dev` instance would share config, workspace state and hook ports with the running app, so the smoke used this machine's WKWebView instead (macOS 27.0.1). One fixture page with the real class names was built with `vite build` twice: once from `HEAD` and once from the working tree. Root properties come from `themeCssProperties` on each side, with `[visual] opacity` 0.7. Contrast was measured after compositing every ancestor background over black and over white; the table shows the worse of the two.

  | Probe | Before | After |
  |---|---|---|
  | Titlebar path | 1.69 | 6.08 |
  | Lane name | 4.42 | 7.06 |
  | Lane stats meta | 2.36 | 5.48 |
  | `TOOL` label | 3.55 | 5.87 |
  | `CONTENT` label | 2.63 | 5.87 |
  | Assistant label | 4.56 | 7.57 |
  | Thought name | 2.04 | 8.06 |
  | Thought body | 2.46 | 6.25 |
  | Composer `OMP-1` | 1.17 | 6.08 |
  | Rail entry name | 3.98 | 6.32 |
  | Footer `KR` / lane `OM` | 1.62 | 6.32 |

  For Krypton Dark, the same fixture on both builds gives identical computed colors and a pixel-identical snapshot. The installed app needs a rebuild (`make install` or `npx tauri dev`) before the change shows there.
- **Implementation notes.**
  - `tool-row.css` also routes the content and output section colour (`--acp-tool-section-color`) through `--krypton-ink-3`, because the `CONTENT` label mixes that colour rather than declaring an alpha.
  - The default section uses `--acp-lane-ink`.
  - WebKit clips the out-of-gamut capped colours rather than gamut-mapping them: `#ff9f1c` renders as `#8c3400`.

## Resources

- [Primer `fgColor` tokens](https://raw.githubusercontent.com/primer/primitives/main/src/tokens/functional/color/fgColor.json5): opaque default / muted / disabled tiers per theme, with usage rules.
- Zed `assets/themes/one/one.json` (local `/Users/wk/Source/zed`): One Light and One Dark `text*` tiers and per-theme `players` colours.
- [Radix Colors — Understanding the scale](https://www.radix-ui.com/colors/docs/palette-composition/understanding-the-scale): separate light and dark scales, and contrast guarantees for the text steps.
- [macOS semantic colour values (iccir gist)](https://gist.github.com/iccir/b2601d4c9b1ae3a31651b3a25124f9e8/7cbf39c9977747e58782fc2e8b09af61bc54c322): alpha-based AppKit label colours in Aqua and Dark.
- [WCAG 2.2 Understanding SC 1.4.3](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html): the 4.5:1 and 3:1 thresholds, and the exemption for incidental text.
- [MDN — Using relative colors](https://developer.mozilla.org/en-US/docs/Web/CSS/Guides/Colors/Using_relative_colors): `oklch(from …)` syntax and custom-property origins.
