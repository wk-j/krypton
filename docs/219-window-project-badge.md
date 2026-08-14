# Window Project Badge — Implementation Spec

> Status: Implemented
> Date: 2026-08-14
> Milestone: M9 — harness observability

## Problem

With several windows tiled on one workspace, nothing in a window's chrome says *which project*
it is working on. The tab title of a harness is the hardcoded string `'ACP Harness'`
(`compositor.ts:3690`), the window titlebar label is only ever written by a terminal's OSC 0/2
title sync — so after the harness replaces its launching terminal tab the label is frozen at a
dead shell's title — and with one tab the tab bar is hidden entirely
(`updateTabBar`, `compositor.ts:1194`). The user has to focus a window and read its content to
know what it is.

## Solution

Render the focused view's **project name** into the window's own status bar, with its **first two
characters magnified** — a drop cap — using the same zoom factor as the lane strip's active-lane
logo, so a window announces its project at scanning distance without being read letter by letter
while the rest of the name stays readable at the rail's own size. Magnifying only the head also
bounds the cost: the glance target is a fixed width whether the project is `pi-mono` or
`tli-api-specification`. It **trails the rail**, immediately left of the dock-zoomed lane logo, so
"which project" and "which lane" form one glance target at the rail's right end rather than two at
opposite corners; it is derived from the focused pane's
`getWorkingDirectory()` — the same focused-pane contract the quotas (spec 153) and the lane
strip (spec 218) already use, so all three answer for the same pane and are driven from the one
`syncWindowFooter(win)`.

## Research

- **The plumbing already exists.** `ContentView.getWorkingDirectory?()` is in the interface
  (`types.ts:170`) and `AcpHarnessView` implements it (`acp-harness-view.ts:3236`).
  `syncWindowFooter(win)` (`compositor.ts:1282`) is already called from the four sync points
  (tab visibility, both window-create paths, pane-focus change) and already resolves "the active
  tab's focused pane's ContentView" twice. This is a third reader of that same value.
- **Constraint discovered — `transform: scale()` cannot be reused verbatim.** Spec 218 magnifies
  the lane logo with a transform, which is invisible to layout, and reserves the overgrowth with
  a hand-computed `margin-inline: 10px`. That works because the logo is a fixed `1em` square. A
  project name is 4–20 characters, so at 2.9× it overgrows by 2–4× the rail's own width and there
  is no CSS expression for "reserve 1.9 × my text width". Scaling `font-size` instead gives the
  element its true painted width, so it participates in layout and cannot land on top of the
  quotas to its left or the lane logo to its right — which is also what lets the badge and the
  strip sit side by side at the same end of the rail. The vertical overgrowth still escapes upward only, via the same
  mechanism spec 218 already proved: the rail has a fixed `--krypton-footer-height` and the item
  is `align-self: flex-end`.
- **Colour is already per-window and free.** `allocateAccentColor()` (`compositor.ts:1779`) hands
  every open window a distinct entry from `ACCENT_PALETTE`, so painting the badge in
  `--krypton-window-accent` makes it colour-coded per window at no cost — the shape-plus-colour
  pair that makes scanning work. (This is *not* the same as a stable per-project colour, which
  would need a hash and would give up the no-two-windows-alike guarantee — out of scope.)
- **Alternative considered — the window titlebar.** Rejected for v1: the titlebar's label is
  owned by the terminal title-sync path, and making it follow the active tab is a separate
  (worthwhile) fix. The footer is the rail this window-scoped, focused-pane-derived class of fact
  already lives on, and it is where the user asked for the zoom treatment.
- **Alternative considered — a watermark over the pane** (iTerm2's actual badge placement).
  Rejected: it would sit on top of terminal output and transcript text, and Krypton already has a
  chrome rail for window-scoped status.

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| iTerm2 | **Badge** — "a large text label that appears in the top right of a terminal session to provide dynamic status"; colour, position, typeface and max size are configurable; content is an interpolated string (`\(session.hostname)`, custom vars) settable by a proprietary escape sequence | The direct precedent: deliberately oversized text whose whole job is at-a-glance session identity. A popular use is showing the repo a coding agent is running in |
| Zed | Project folder name in the window toolbar | Same idea, normal type size. Its known failure — two windows whose folders share a basename are indistinguishable (zed#13192) — is exactly the edge case this spec documents as a known limit |
| VS Code | Folder name in the title bar; the community "Peacock" workflow colours each window's chrome per codebase | Confirms colour-per-window as the established second cue alongside the name |
| tmux | `status-left` carries the session name at the rail's left end, `status-right` the host/date | The convention Krypton **diverges** from: here identity trails the rail with the lane strip, and the quotas take the left end |
| Krypton — lane strip (spec 218) | Dock-style magnified logo for the active lane, far right of the same rail | The zoom language being reused, and the badge's immediate neighbour — the two magnified marks are one glance target |

**Krypton delta** — matches iTerm2's "oversize the identity" idea, but places identity at the
**trailing** end of the status line rather than tmux's leading `status-left`, next to the lane
strip's magnified logo so the window's two identity facts (project, active lane) are read in one
glance. It also oversizes only the name's **first two characters** rather than the
whole string (iTerm2's badge floats over the content area, where length costs nothing; a 28px
rail shared with two other readouts cannot afford a whole magnified word), and diverges on three
further points: it is **chrome, not content** (on the
status rail, never painted over the pane, so it cannot obscure output), it is **not
user-scriptable** (no escape sequence, no interpolated-string language — the value is derived
from the focused view's working directory, because in Krypton the harness *is* the thing that has
a project), and it is **static** — no pop, no pulse, per the footer's standing no-motion rule.

## Affected Files

| File | Change |
|------|--------|
| `src/window-footer-project.ts` | **New.** `projectBadge(dir, max)` → `{ label, title } \| null`: basename extraction, `~`/`/` special cases, truncation |
| `src/window-footer-project.test.ts` | **New.** Unit tests for the helper |
| `src/compositor.ts` | `syncWindowProjectBadge()` + `renderWindowProjectBadge()` called from `syncWindowFooter()`; per-window label cache dropped in `closeWindow()` |
| `src/styles/window.css` | `__project`, the `--krypton-window-project-zoom` var, the flex-end geometry, and the rail's right-pinning order (`order: 1` badge / `order: 2` strip, one auto margin) |
| `docs/218-window-lane-strip.md` | Note the rail's third occupant, now the strip's immediate left neighbour |
| `docs/153-window-ai-credit-status.md` | The quotas are now the middle of a three-part rail |
| `docs/04-architecture.md`, `docs/05-data-flow.md` | The rail's third readout and its flow |
| `docs/02-functional-requirements.md` | New FR for per-window project identity |
| `docs/README.md` | Index entry 219 (+ spec count) |

## Design

### Data Structures

```ts
// src/window-footer-project.ts

/** What the badge renders, plus the full path for the tooltip / a11y label. */
export interface ProjectBadge {
  /** Display text — the directory's own name, in its real case, truncated. */
  label: string;
  /** The magnified head of `label` — the drop cap. */
  initials: string;
  /** The remainder, at the rail's own size. Empty for a name ≤ INITIALS_LEN. */
  rest: string;
  /** Full working directory, `~`-abbreviated. Never truncated. */
  title: string;
}

/** Chars past which the label is ellipsized — a plain readability cap on the
 *  rail's own 11px type, since only the head is magnified. */
export const PROJECT_LABEL_MAX = 18;

/** How much of the name is magnified. Two characters separates the projects a
 *  person actually has open (`kr`ypton vs `tl`i-api-service) at a bounded width. */
export const INITIALS_LEN = 2;

/**
 * Derive the badge from a working directory. `null` for an absent or empty dir,
 * so the caller can drop the element entirely. `home` is a parameter rather than
 * a lookup to keep this module free of Tauri and the DOM — the compositor passes
 * the harness's cached `$HOME` (`getHomeLikePrefix()`).
 */
export function projectBadge(
  dir: string | null | undefined,
  home?: string | null,
  max?: number,
): ProjectBadge | null;
```

The split is by **code point**, not UTF-16 unit, so a directory whose name opens with an astral
character cannot be cut mid-surrogate-pair into a replacement glyph.

`ContentView` needs **no new method** — `getWorkingDirectory?()` already exists and the harness
already implements it.

### API / Commands

None. No Tauri command, no IPC, no `ViewBus` signal — like spec 153 and spec 218 this is window
chrome derived from the focused `ContentView`.

### Data Flow

```
1. A tab becomes visible / a window is created / pane focus moves
2. syncWindowFooter(win) runs (already the single entry point for the rail)
3. syncWindowProjectBadge(win) resolves the active tab's focused pane's
   ContentView and reads getWorkingDirectory?.()
4. projectBadge() turns the path into { label, title }; null → the element is
   removed and the window's cached label is dropped
5. renderWindowProjectBadge() compares the label against the window's cached one
   and returns early when unchanged, so a redundant sync repaints nothing
6. The badge renders at the rail's right end, just inside the lane strip,
   magnified by --krypton-window-project-zoom, growing upward out of the rail
```

There is no subscription to add: a view's project directory is fixed for its lifetime, so the
existing four sync points are exactly the moments the answer can change.

### Keybindings

None. The badge is a readout.

### UI Changes

```html
<!-- DOM order; painted order is by CSS `order`:
     usage-status → notif → project (1) → lane-strip (2) -->
<div class="krypton-window__footer">
  <span class="krypton-window__project" title="~/Source/krypton"
        aria-label="project krypton — ~/Source/krypton">
    <span class="krypton-window__project-initials">kr</span><!-- magnified -->
    <span class="krypton-window__project-rest">ypton</span><!-- rail size -->
  </span>
  <div class="krypton-window__usage-status">…</div>
  <div class="krypton-notif">…</div>
  <div class="krypton-window__lane-strip">…</div>
</div>
```

Painted left to right: `quotas … notification | krypton ⟨lane logo⟩ CLAUDE-1`.

| Concern | Rule | Why |
|---------|------|-----|
| Size | `font-size: calc(var(--krypton-chrome-font-size, 11px) * var(--krypton-window-project-zoom, 2.9))` **on the initials only** | Same factor as `--krypton-lane-zoom`, but applied to type rather than to a transform, so the element's own box is its painted width and the quotas beside it can never be overlapped. Confining it to two characters keeps the magnified width constant across projects. |
| Two halves, one word | `display: inline-flex` + `align-items: baseline` | The drop cap and the tail sit on one baseline, so they read as a single word rather than as a label plus a value. |
| Direction | `align-self: flex-end` + `line-height: 1` | The rail's height is fixed, so anchoring the box's floor sends every overflowing pixel *upward*, over the pane — never down through the window's bottom edge. Same escape route spec 218 uses. |
| Painting the escape | `position: relative` | Escaping upward is not enough on its own: `.krypton-pane` is `position: relative`, so it paints in the positioned phase, *after* the footer's ordinary inline text, and its opaque view background sliced the drop cap flat at the rail's top edge (measured in a WKWebView repro). Positioning the badge moves it into the same paint phase, where tree order — footer after pane — puts it on top. Spec 218's lane logo never showed this because its `transform` already promotes it the same way. |
| Which floor | `margin-bottom: calc((var(--krypton-footer-height, 28px) - var(--krypton-lane-chip-height, 18px)) / 2)` | The floor is the **lane chip's**, not the rail's. A floor-pinned box is positioned by its bottom edge, and the drop cap's box carries its own descent below the baseline: pinned to the rail floor the word's baseline landed 6px up while the rail's other type sits at 11–14px, so the whole word — descenders included — hung below the chip beside it. The chip's inset lifts the shared baseline onto the strip's text line (measured: drop cap, tail and lane name all at 11px), so badge and strip read as one line of rail type. Derived from the two heights rather than tuned, so a themed rail keeps it. |
| Placement | `order: 1` (lane strip moves to `order: 2`), `flex: none` | Trails the rail, immediately left of the lane strip, so project and active lane are one glance target instead of two at opposite corners. `flex: none` makes the quotas the compressible half, as spec 153 already intends. |
| Right-pinning | `margin-left: auto` on the badge; the strip's own auto margin becomes `margin-left: 10px` via `.krypton-window__footer:has(.krypton-window__project)` | Exactly one rail item may claim the free space — two auto margins split it and would leave the badge floating mid-rail. The leftmost of `notif → badge → strip` pushes; the rest trail it. The `:has()` is because the badge is absent whenever the focused pane has no project, and the strip must then take its auto margin back. |
| Colour | `color: rgba(var(--krypton-window-accent-rgb), 0.7)` | The window's own accent, which `allocateAccentColor` already guarantees is unique among open windows — so name and hue agree, and the badge matches the chrome it sits in. |
| Motion | none | The footer's standing no-motion rule. A project does not change under a window the way an active lane does, so there is nothing for a pop to announce. |
| Overflow | `max-width: 45%`, `overflow: hidden`, `text-overflow: ellipsis` on the tail, `white-space: nowrap` | A narrow window clips the tail rather than pushing the quotas off the rail — and the drop cap, which is the actual glance target, is `flex: none` and survives the squeeze. |

Flat: no border box, no underline, no left rail, no glow — colour, size and position do the work.

### Configuration

None. `--krypton-window-project-zoom` is a CSS custom property declared on
`.krypton-window__footer`, so a theme can tune it in one place (the right value depends on
`--krypton-footer-height`). `--krypton-lane-chip-height` (spec 218's chip height) is declared
on the same rule because both the chip and this badge sit on the line it defines — one
number, two users.

## Edge Cases

| Case | Behaviour |
|------|-----------|
| Focused pane is a terminal | No `ContentView` → no badge. Terminal cwd is out of scope for v1 (see below) |
| Content view without `getWorkingDirectory` | Same as above — element removed |
| `dir` is `/` | Label `/` |
| `dir` is the home directory | Label `~` |
| Trailing slash (`/a/b/`) | Ignored — label `b` |
| Name longer than `PROJECT_LABEL_MAX` | Truncated with `…` (the cut falls in the tail); the full `~`-abbreviated path stays in `title` / `aria-label` |
| Name of 1–2 characters | The whole name is the drop cap and `rest` is empty — no stray element, no layout change |
| Name opening with an astral character (emoji) | Split by code point, so the pair is never cut in half into a replacement glyph |
| Two windows on projects with the same folder name | Both show the same label — a known limit Zed shares (zed#13192). The per-window accent colour still separates them. Parent-segment disambiguation is deliberately deferred |
| Two harness panes in one window | Follows the *focused* pane, like the quotas and the lane strip beside it |
| Window has no footer (Quick Terminal path) | `renderWindowProjectBadge` no-ops on a missing `.krypton-window__footer`, as the other two readouts do |
| Repeated syncs with no change | The cached-label compare returns early; no DOM writes |

## Out of Scope

- **Terminal panes.** A terminal's cwd is live and already flows as the ViewBus `view:cwd` signal
  (see `pty-bridge.ts`) — a ready-made path if this should later cover terminal windows, but it
  is a subscription rather than a read, so it is its own change.
- **Disambiguating same-named projects** by adding a parent segment.
- **A stable per-project accent colour** (hash of the path). It would break
  `allocateAccentColor`'s "no two open windows alike" guarantee, and the lane strip's lane-1
  accent inherits the window accent — a change with reach well past this rail.
- Fixing the window **titlebar** label to follow the active tab (real bug, separate change).
- Making the badge interactive or keybound.
- Any project identity in the **workspace** footer, live-assist (spec 208), or the loopback
  lane-monitor surfaces.

## Resources

- [iTerm2 — Badges](https://iterm2.com/3.3/documentation-badges.html) — the "large text label for
  at-a-glance session identity" precedent, and its position/typeface/colour configuration model.
- [iTerm2 Badges for Claude Code: Know Which Repo You're In](https://dreamiurg.net/2026/02/08/iterm2-badges-for-claude-code-sessions.html)
  — confirms the exact use case (which repo is this agent window working in) this spec serves.
- [Zed discussion #13192 — How to distinguish projects with multiple windows open?](https://github.com/zed-industries/zed/discussions/13192)
  — the same-basename failure mode, documented here as a known limit rather than solved.
- [Quickly differentiate between code bases with VS Code window colors](https://dev.to/wearethreebears/quickly-differentiate-between-code-bases-with-vscode-window-colors-5h04)
  — colour-per-window as the established second cue alongside the name.
- Internal: `docs/218-window-lane-strip.md` (the zoom language and the rail's right end),
  `docs/153-window-ai-credit-status.md` (the focused-pane footer contract),
  `docs/40-notification-overlay.md` (the rail's transient occupant).
