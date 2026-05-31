# Krypton Brand Glyph — Implementation Spec

> Status: Implemented
> Date: 2026-05-30
> Milestone: M-post — polish / visual identity
>
> Decided (prototype 132): candidate **C · Stem-bar**, opacity **0.85**, no divider,
> color via `--krypton-window-accent-rgb` (the footer's existing accent var, not
> `--krypton-color-primary`), 16px.

## Problem

Krypton has no app-level brand mark anywhere in the running UI. Per-backend agent
logos exist (spec 125), but the product itself is never represented visually. The
app renders its own identity in pure text only, where a single restrained vector
mark would read as *signal of identity*, not decoration.

## Solution

Add one inline-SVG Krypton mark (the "K" cursor-and-chevron from
[docs/131](./131-visual-asset-generation-brief.md)) as a persistent **identity anchor
at the left of the global workspace footer** (`krypton-workspace-footer`) — the
fixed, always-visible HUD bar present across every view and workspace. The mark is a
permanent leading child of the footer, never re-rendered, themeable via
`currentColor` / `--krypton-color-primary`. No raster.

## Research

- **Per-backend marks already exist (spec 125).** `BACKEND_LOGO_SVG_DEFS`
  (`acp-harness-view.ts:655`) defines nine `<symbol>` marks drawn via
  `<use href>` in the rail + directive logos, all `currentColor`. The new app mark is
  a sibling in that visual family but lives at app level, not inside the harness.
- **No Krypton app glyph exists** — a repo-wide search finds only the backend symbols.
- **The harness empty state is a dead surface (rejected v1 target).** `renderDashboard()`
  has a `lanes.length === 0` branch, but the harness auto-adds a default Claude lane on
  start (`acp-harness-view.ts:2718`), so users effectively never see it. An app mark
  there would almost never render.
- **The workspace footer is the always-visible app surface.** `WorkspaceFooter`
  (`src/workspace-footer.ts`, CSS `src/styles/workspace-footer.css`) is a
  `position: fixed; bottom: 0; height: 28px; z-index: 9000` bar instantiated once in
  `main.ts`, shown regardless of focused view. Structure: `root > leftEl, centerEl,
  rightEl`. `renderLeft()` (line 332) fills `leftEl` with mode + role/title segments;
  center has project/git/counts; right has attention badge + hint + music. It already
  hosts the spec-128 global attention badge — the documented home for app-global HUD.
- **Opacity / DESIGN.md.** Because the footer is chrome (not an empty state), the
  earlier "empty: no illustrations" tension does **not** apply. The mark sits at normal
  chrome salience (≈ the mode segment), as a functional identity element.

## Prior Art

| App | Brand anchor in persistent chrome |
|-----|-----------------------------------|
| macOS | Apple mark pinned at the far left of the menu bar — pure identity anchor. |
| VS Code | Product/account marks at the ends of the activity bar / status bar. |
| Warp | Small brand mark in the window chrome. |
| Zed | Minimal; project/branch in a bottom status bar, no logo. |
| tmux / terminals | Status line carries session/window state, conventionally no logo. |

**Krypton delta** — follow the macOS menu-bar convention (identity anchor at the
status bar's leading edge) but render a vector cyberpunk glyph that recolors with the
theme via `currentColor`. Diverges from bare terminal status lines by claiming a small
identity slot, consistent with Krypton being "fictional hardware," not a stock shell.

## Affected Files

| File | Change |
|------|--------|
| `src/workspace-footer.ts` | Add `KRYPTON_LOGO_SVG` constant; create `this.brandEl` (a `<span>` with the inline SVG) once in the constructor; prepend it to `this.root` before `leftEl`. Never cleared by `renderLeft()`. |
| `src/styles/workspace-footer.css` | Add `.krypton-workspace-footer__brand` (size, accent color, glow stack); responsive rules hide data segments by class and leave the brand untouched. |
| `docs/PROGRESS.md` | Note the brand-glyph addition. |

## Design

### Data Structures

No new types. One module constant + one element field:

```ts
// Krypton app mark — "K" = cursor stem + command-prompt chevron. Singleton in the
// footer, so the SVG is inlined directly (no <symbol>/<use> indirection needed).
const KRYPTON_LOGO_SVG =
  '<svg viewBox="0 0 32 32" aria-hidden="true">' +
  /* final candidate geometry from prototype 132 — chosen by user */ '</svg>';

private brandEl!: HTMLElement;   // permanent leading child of root
```

### Render

In the constructor, after building `leftEl/centerEl/rightEl`:

```ts
this.brandEl = document.createElement('span');
this.brandEl.className = 'krypton-workspace-footer__brand';
this.brandEl.setAttribute('aria-label', 'Krypton');
this.brandEl.innerHTML = KRYPTON_LOGO_SVG;
this.root.append(this.brandEl, this.leftEl, this.centerEl, this.rightEl);
```

`renderLeft/Center/Right` are unchanged — they only `replaceChildren` on their own
cells, so the brand anchor is never touched on refresh (off the hot path).

### Data Flow

```
1. main.ts constructs WorkspaceFooter once → brandEl inserted as root's first child
2. Footer is position:fixed bottom; visible in every view/workspace
3. CSS tints the glyph via rgba(var(--krypton-window-accent-rgb), 0.85) + tight+bloom
   drop-shadow glow stack (same accent var the footer's other chrome already uses)
4. Theme change → the accent var updates, currentColor + glow follow automatically
```

> **Deviation from draft:** color uses `--krypton-window-accent-rgb` (the footer's
> existing accent variable), not `--krypton-color-primary`. Chosen for consistency
> with the footer's other chrome (border, mode segment) and correct theming.

### UI Changes

- New leftmost footer element: `~16px` glyph, then the existing mode segment (no
  divider — the footer's `gap` provides separation).
- `.krypton-workspace-footer__brand`: `color: var(--krypton-color-primary)`,
  `opacity` ~`0.85` (tunable — final value from prototype), glow
  `drop-shadow(0 0 4px primary@0.6) drop-shadow(0 0 10px primary@0.18)`. Static.
- Responsive: the footer's compact media query hides several segments; the brand
  anchor must **stay visible** (it is identity, not data). Add it to the keep-list.

### Keybindings / Configuration

None.

## Edge Cases

- **Compact width** — keep the brand anchor; let data segments drop first (they
  already do). Never let the mark be the first thing hidden.
- **Theme with non-cyan primary** — glyph follows `--krypton-color-primary`, recolors
  for free.
- **Reduced motion** — glyph is static; nothing to disable.
- **Music-player active** — music occupies the right cell; brand is on the left, no
  collision.
- **aria** — `aria-label="Krypton"` on the span; inner SVG `aria-hidden`. Footer is
  `role=status aria-live=polite`; a static label won't spam announcements.

## Open Questions

Resolved at approval via prototype 132:
1. **Candidate** → **C · Stem-bar** (solid cursor bar + monoline chevron; clearest at 16px).
2. **Opacity & divider** → opacity **0.85**, no divider (the footer `gap` separates it).

## Out of Scope

- The per-backend agent marks (shipped in spec 125 — untouched).
- Raster/PNG assets, key art, and the "Operator" character/sprite work from docs/131
  (those are external-surface assets: README, app icon, About).
- A wordmark, splash screen, About dialog, or a harness masthead.
- Putting the mark anywhere besides the workspace footer (the harness empty state was
  evaluated and rejected — see Research).

## Resources

- [docs/131-visual-asset-generation-brief.md](./131-visual-asset-generation-brief.md) — the glyph concept this vectorizes inline.
- [docs/prototypes/132-krypton-brand-glyph.html](./prototypes/132-krypton-brand-glyph.html) — interactive prototype: candidates, live footer, before/after, family check.
- [DESIGN.md](../DESIGN.md) — glow stack, `--krypton-*` token mapping, `currentColor` theming.
- `src/workspace-footer.ts` + `src/styles/workspace-footer.css` — the surface this targets.
- `docs/125-lane-rail-disambiguation.md` + `src/acp/acp-harness-view.ts:655` — the backend-logo family the mark visually joins.
