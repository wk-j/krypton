# Stacked Lane Visual Hierarchy — Implementation Spec

> Status: Implemented
> Date: 2026-08-10
> Milestone: M8 — Polish

## Problem

In the default stacked dashboard, the user cannot tell at a glance which lane is active or which lanes exist. The active-lane treatment (a 3.5% accent tint fading out over the first 64px, plus inset shadows at 2.5–14% opacity) is below perceptual threshold on the transparent backdrop, and collapsed lanes have their accent color deliberately stripped to gray while sharing the exact row height, font, and separator weight of transcript rows — so a collapsed lane head reads as another log line, not a switchable lane.

## Solution

Three coordinated presentation-only changes. (1) Collapsed lanes keep their lane accent, dimmed by mixing toward the base text color instead of being replaced by gray — the hue-preserving dim iTerm2 and WezTerm use for inactive panes, so identity survives de-focus. (2) Collapsed lane heads become full-width accent-tinted bands with the backend logo, visually distinct from transcript rows. (3) The active-lane signal moves to its head: a stronger accent band with a full-accent name, replacing the invisible body wash. The band covers both head rows — the head grid *and* the stats row beneath it — as one two-line header block whose tint alone parts ways with the transcript (the closing hairline under the stats was dropped in polish, matching the borderless collapsed bands), so the stats read as head metadata rather than a stray line floating over the transcript; the stats row's own backend logo/id cell is dropped (the name span one line up now carries the logo). No layout, state, keybinding, or Rust changes.

Prototype: [`docs/prototypes/215-stacked-lane-hierarchy.html`](prototypes/215-stacked-lane-hierarchy.html) — current vs proposed, 4 lanes including a `needs_permission` gold row.

## Research

- `renderDashboard()` (`src/acp/acp-harness-view.ts:10883-10922`) builds the stack; line 10889 sets `--acp-lane-accent` to `lane.accent` only for the active lane and to `rgba(216,232,216,0.42)` (gray) for collapsed lanes. This gray override is the single reason collapsed lanes lose identity.
- `.acp-harness__lane--active` (`src/styles/acp-harness.css:83-99`) carries the 3.5% fading gradient + three inset shadows; `.acp-harness__lane--collapsed` (`:77-81`) is a 28px row with a 5.5%-opacity white border-bottom.
- All head markup flows through `renderLaneHead()` (`src/acp/harness-lane-chrome.ts:89-145`, active + collapsed branches). Every refresh path — initial `renderDashboard`, `renderActiveLaneChrome` (`acp-harness-view.ts:10134`), and the 2s metrics poll `refreshMetricsRender` (`:11395`) — re-renders via this one function, so a markup change lands everywhere with no extra wiring.
- Backend-logo infrastructure already exists from spec 125: `backendLogoId()` (`harness-lane-identity.ts`) + SVG `<symbol>` table (`harness-icons.ts`); the zen rail and the active lane's stats row already draw it. Collapsed heads in stacked mode do not.
- Status tints that must keep precedence: busy cyan head (`acp-harness.css:549`), permission gold head + pulsing collapsed row (`:556-575`, `:3048-3063`, with reduced-motion fallback), error red (`:577`), awaiting-peer purple (`:584-593`).
- Lane accents come from the fixed 13-color `laneAccent()` palette (`harness-lane-identity.ts:122-139`), assigned by lane index; `color-mix(in srgb, …)` over these vars is already used throughout this stylesheet, so no new platform risk on WKWebView.
- Prior art in-repo: `.acp-harness__tab-strip` CSS exists (`acp-harness.css:2420-2443`) but no TS renders it — evidence a persistent roster strip was once planned and dropped.
- Alternatives ruled out:
  - **Persistent bottom tab strip** — adds a second roster surface duplicating what the collapsed rows already are; zen mode (⌘.) already provides a dedicated roster rail. Fixing the in-place legibility is cheaper and doesn't spend vertical space.
  - **Active marker glyph (`▸` / `*` tmux-style)** — adds vocabulary the head band already carries; rejected to keep the head grid untouched.
  - **Dimming the active lane's siblings' content** — collapsed lanes have no visible body to dim; the head *is* the lane, so identity must live there.

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| iTerm2 | "Dim inactive split panes" — inactive panes render at reduced brightness, hue preserved; amount adjustable. | Origin of the hue-preserving dim convention. |
| WezTerm | `inactive_pane_hsb = { saturation, brightness }` multipliers dim + slightly desaturate inactive panes; hue kept. | Same convention, explicit HSB knobs. |
| tmux | Active window in the status-bar roster gets its own bg/fg via `window-status-current-style` plus a `*` marker; active pane border via `pane-active-border-style`. | Roster + active slot are visually distinct classes, not just brightness. |
| Zellij | Focused pane frame recolored in theme accent; tab bar renders the active tab as a solid accent block. | Accent block = strongest active signal in the terminal space. |
| VS Code | Sidebar accordion section headers are full-width distinct bands; the active list item is a background-tint block. | The "header band ≠ content row" split this spec adopts. |

**Krypton delta** — adopts the hue-preserving dim (iTerm2/WezTerm) and the banded-header split (VS Code/Zellij), but stays flat per the design language: no frames or borders around the active lane (bands only — no hairlines, never a left rail), no mouse affordances added (lane switching stays ⌃N/⌃P + lane picker + ⌘. zen), and collapsed lanes remain 28px head-bars rather than dimmed previews.

## Affected Files

| File | Change |
|------|--------|
| `src/acp/acp-harness-view.ts` | `renderDashboard` line 10889: always set `--acp-lane-accent` to `lane.accent`; delete the gray branch. |
| `src/acp/harness-lane-chrome.ts` | `renderLaneHead`: prepend the backend logo SVG inside `.acp-harness__lane-name` in both the active and collapsed branches. `renderLaneStats`: drop the leading backend logo/id cell — with the logo in the name span it duplicated the head and made the stats row read as a second head. |
| `src/styles/acp-harness.css` | Rework `.acp-harness__lane--collapsed` (identity band) and `.acp-harness__lane--active` (head band, drop body gradient + inset shadows); dim rule for collapsed name; keep status-tint precedence. |
| `src/acp/acp-harness-view.test.ts` | Extend existing head-markup assertions to cover the logo `<use>` and the removed gray override. |

## Design

### UI Changes

No new DOM elements except one inline SVG per lane head. No grid-template change: the logo rides inside the existing `.acp-harness__lane-name` span (the pattern the stats row pioneered — its own copy is dropped now that the name carries it), sized `1em` with a small right gap.

```ts
// harness-lane-chrome.ts — both branches of renderLaneHead()
const logo =
  `<svg class="acp-harness__icon acp-harness__icon--accent" aria-hidden="true">` +
  `<use href="#${backendLogoId(lane.backendId)}"/></svg>`;
`<span class="acp-harness__lane-name">${logo}${esc(lane.displayName)}</span>`
```

CSS deltas (exact values; all `color-mix` in srgb over `var(--acp-lane-accent)`):

```css
/* collapsed lane = identity band, not a log line; no separator line —
   adjacent bands part ways by their own tints (border-top dropped in polish:
   a hairline per row read as visual noise once the bands carried the hue) */
.acp-harness__lane--collapsed {
  flex: 0 0 28px;
  background: color-mix(in srgb, var(--acp-lane-accent) 6%, rgba(6, 10, 18, 0.55));
  /* border-bottom (white 5.5%) removed */
}
.acp-harness__lane--collapsed .acp-harness__lane-name {
  color: color-mix(in srgb, var(--acp-lane-accent) 70%, rgba(216, 232, 216, 0.55));
}

/* active lane announces itself at the head, not with a body wash */
.acp-harness__lane--active {
  flex: 1 1 0;
  min-height: 120px;
  display: flex;
  flex-direction: column;
  background: rgba(6, 10, 18, 0.48);   /* gradient + 3 inset shadows removed */
}
/* the band spans the head grid + the stats row = one two-line header block;
   no closing hairline — the band's tint parts ways with the transcript below,
   matching the borderless collapsed bands (inset hairline dropped in polish) */
.acp-harness__lane--active > .acp-harness__lane-head,
.acp-harness__lane--active > .acp-harness__lane-stats {
  background: color-mix(in srgb, var(--acp-lane-accent) 13%, rgba(6, 10, 18, 0.6));
}
.acp-harness__lane--active .acp-harness__lane-name {
  color: var(--acp-lane-accent);
  text-shadow: 0 0 8px color-mix(in srgb, var(--acp-lane-accent) 24%, transparent);
}
```

- `.acp-harness__lane-name` `max-width` 18ch → 20ch (logo occupies ~1.3em of the cell).
- Collapsed status/activity text keeps its current grays — only the name + logo carry the hue, so a many-lane stack doesn't turn into a rainbow.
- The 6% / 13% strengths are the tunable constants of this spec; they are chosen to sit clearly above the old 3.5% threshold while staying inside the flat-chrome language. (An initial 22% `border-top` separator on collapsed bands and a 30% inset hairline closing the active head band were both dropped in polish — every hairline read as visual noise once the bands carried the hue.)

### Status-tint precedence

Alert states outrank identity. The `needs_permission` collapsed gold band (`background: rgba(255,209,102,0.1)` + pulse) must be declared **after** the new identity band so it replaces it. Busy cyan / error red / awaiting-peer purple only recolor head text + symbol and render on top of the identity band unchanged. Reduced-motion permission fallback is untouched.

### Data Flow

Unchanged. All three head-refresh paths already funnel through `renderLaneHead()`; the accent variable is set at the two existing `setProperty` sites (`renderDashboard`, `renderActiveLaneChrome`).

### Keybindings

None added or changed (⌃N/⌃P cycle, lane picker, ⌘. zen mode as today). Collapsed heads stay non-clickable — keyboard-first.

## Edge Cases

- **Accent fallback** — lanes whose accent is `var(--krypton-window-accent, #0cf)` (index-1 lanes, unmatched labels): `color-mix` over the nested var resolves normally; themes overriding `--krypton-window-accent` flow through.
- **`needs_permission` collapsed** — gold replaces the identity band entirely (alert > identity); pulse + reduced-motion fallback preserved.
- **Error/stopped lanes** — red head text over a dim identity band; contrast verified in the prototype.
- **Many lanes (8+)** — 6% band tint per lane keeps the stack calm; identity is carried mostly by name hue + logo, which don't accumulate visually.
- **Zen mode** — untouched: collapsed lanes aren't rendered there and the rail has its own spec-125 treatment. Concise mode is orthogonal (transcript-only).
- **Custom themes** — all tints derive from existing accent custom properties; no new hard-coded hues beyond the mix percentages.
- **WKWebView** — `color-mix` already ships in this stylesheet; no `backdrop-filter`, no new compositing risk.

## Open Questions

None.

## Out of Scope

- A persistent bottom tab-strip roster (the dead `.acp-harness__tab-strip` CSS at `acp-harness.css:2420` stays as-is; removing it is separate cleanup).
- Zen-rail, lane-peek, or lane-picker changes.
- Mouse/click affordances on collapsed heads.
- Changing lane accent assignment (spec 125 palette) or status vocabulary.

## Resources

- [WezTerm — Colors & Appearance](https://wezterm.org/config/appearance.html) — `inactive_pane_hsb` dims + desaturates inactive panes via HSB multipliers, hue preserved.
- [wezterm discussion #1382 — Dim the deselected panes](https://github.com/wezterm/wezterm/discussions/1382) — real-world configs (`saturation 0.9, brightness 0.7`) confirming brightness-first dimming.
- [Warp issue #2205 — Inactive pane dimming](https://github.com/warpdotdev/Warp/issues/2205) — users citing iTerm2's dim-inactive-split-panes as the expected convention.
- tmux `window-status-current-style` / Zellij focused-pane frame / VS Code accordion headers — from working knowledge of those tools; no single doc consulted.
