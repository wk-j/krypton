# Minimal Workspace Footer — Implementation Spec

> Status: Implemented
> Date: 2026-11-01
> Milestone: visual chrome
> Related: [121](./0121-workspace-status-bar.md), [236](./0236-workspace-footer-kind-palette.md), [213](./0213-backend-link-indicator.md), [337](./0337-rails-verifier.md), [146](./0146-review-quality-matrix.md), [162](./0162-review-priority-roll-up.md)

## Problem

The 28px workspace footer shows a full readout all the time. With an ACP Harness focused and everything healthy it reads `NORMAL  ACP Harness  ~/Source/krypton · master • · ⊞ 2/2/2      ⇄ xenon  RAILS ✓  Cmd+P lanes · #cancel running`. Most of it repeats another surface or reports "nothing is wrong", so the one field that ever needs the user does not stand out.

## Solution

Compact density (the default) becomes **branch + exceptions**: on the left, only the git ref; on the right, only what needs the user. Everything else moves to detail density, which `Leader ?` still toggles. The static key hint is removed in both densities. The same healthy state above becomes:

```text
master •
```

Decision (2026-11-01): the user asked for the most minimal of the drafted options, so the cwd moves to detail too.

## Research

Every compact field today, and where its information already lives:

| Field (today) | Already shown by | Compact after this spec |
|---------------|------------------|-------------------------|
| `NORMAL` mode chip | Normal is the default; the other modes open which-key (`which-key.ts`: Compositor, Resize, Move, Swap, Selection, Hint, TabMove) or their own overlay | Shown only when mode ≠ Normal |
| Role/title `ACP Harness` | The focused window's titlebar: a terminal's OSC 0/2 title label, a content view's kind in `pty-status` (`compositor.ts` content-window build) | Detail only |
| cwd `~/Source/krypton` | Partly: terminal titlebar `pty-status` (`updateWindowCwd`), content-view window footer project badge (spec 219, name only) | Detail only |
| git `master •` | Harness composer-meta only | **Kept** |
| Counts `⊞ 2/2/2` | The windows on screen | Detail only |
| Process, throughput | Process: a terminal's title when the shell sets one. Throughput: nowhere, but it is activity, not state you act on | Detail only |
| Link `⇄ xenon` (linked) | Nothing, but healthy carries no action | Detail only; `auth` / `offline` stay in compact |
| `RAILS ✓` / `RAILS …` / `RAILS paused` | The Harness Rails tab | Detail only; `RAILS N`, `RAILS error`, `RAILS ✗ <check>` stay in compact |
| `◷ N reviews`, `▤ N priority` | Review matrix (`⌘P '`), priority roll-up (`⌘P /`) | Detail only (they mean "inspect", ADR-0009) |
| `N attention`, `▲1 ✕1 ✓2` | Nothing else is global | **Kept** |
| Hint `Cmd+P lanes · #cancel running` | which-key per mode; the hint never changes while working | Removed |
| Music segment | — | **Kept** (only while a track exists) |

- The hint is the only footer content that is never state, and it is fixed per view kind, so after the first read it is noise. Removing it deletes `hintFor`, `parseHint`, `fillHint` and `HintChip` (their only consumers are the footer and its tests).
- ADR-0017 says a `linked` backend is "not coloured… ambient information and must not compete with the attention gauge". Hiding it in compact serves that purpose more fully; detail still renders it exactly as the ADR states.
- Alternative ruled out: per-segment config toggles under `[workspace.status_bar]` — a format language for 12 fields, and spec 121 explicitly avoided one. One density switch already exists.
- Alternative ruled out: deleting the detail-only fields. `Leader ?` keeps a full readout one key away at no cost.

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| Zellij | The default layout loads `status-bar` at height 2 (input modes and their status); the `compact` layout loads `compact-bar` at height 1 (input mode and tabs) | The compact bar keeps mode and drops the rest |
| VS Code | Status bar UX guideline: "Limit the number of items", warning/error background "only as a last resort" | Exceptions earn space; healthy state does not |

**Krypton delta** — matches Zellij's compact bar: one line, only the essentials. Diverges twice: the chip hides in Normal mode (the default needs no label), and exceptions (attention, program status, faults) stay, because they are global and appear nowhere else.

## Affected Files

| File | Change |
|------|--------|
| `src/workspace-footer-segments.ts` | `leftSegments` / `centerSegments` take `detail: boolean` and return only that density's segments, in the order below |
| `src/workspace-footer.ts` | Drop `hintEl`, the hint import/re-export and the now-unread `data-density` attribute; reorder the right zone; pass `detail` to every component `render` |
| `src/workspace-footer-format.ts` (+ test) | Delete `hintFor`, `parseHint`, `fillHint`, `HintChip`, `HINT_KEY_RE` and their tests |
| `src/workspace-footer-music.ts` | Delete the `active` getter (its only reader was `hintFor`) |
| `src/workspace-footer-link.ts` | `render(detail)`: `linked` hidden unless `detail` |
| `src/workspace-footer-rails.ts` | `RailsFooterView.quiet`; `render(detail)`: `clean`, `running`, `paused` hidden unless `detail` |
| `src/workspace-footer-review-gauges.ts` | `FooterReviews` / `FooterPriority` `render(detail)`: hidden unless `detail` |
| `src/workspace-footer.test.ts` | Deleted: it held only the `parseHint` cases and regex assertions over the stylesheet text |
| `src/styles/workspace-footer.css` | Delete `__hint`, `__hint kbd`, `[data-density="compact"] … --detail` and the hint lines in the 700/520px queries; `__left:empty { display: none }` so an empty zone does not indent the branch by the root's flex gap |
| `docs/0121`, `0236`, `0213`, `0337`, `0146`, `0162`, `0002`, `0004`, `0005`, `README.md` | Note the compact/detail split and the hint removal where they describe the old footer |

## Design

### Layout

```text
compact  [MODE if ≠ Normal]  git                              attention  ▲✕✓  RAILS fault/findings  ⇄ fault  ♪ music
detail   MODE  cwd · git · title · counts · process · io · % · state · program
                                                              attention  ▲✕✓  RAILS any  ⇄ any+latency  ◷ reviews  ▤ priority  ♪ music
```

- **Left zone**: the mode chip. **Center zone**: context segments separated by etched grooves — the git ref alone in compact; in detail cwd and git first, then the rest. DESIGN.md 2.3.6 makes git a neutral-ink recessed well; an 8px gap replaces its preceding separator so no groove sits inside the readout. Branch case, amber dirty dot and the 28px rail height are unchanged.
- **Right zone order**: attention, program-status, rails, link, reviews, priority, music — demand first, inspect-only last.
- Density gating is done in JS (builders return `null`, components set `hidden`), not CSS, so a hidden segment never leaves a stray separator. The `--detail` CSS rule is deleted.

### Data Flow

Unchanged apart from density: `toggleDensity()` already calls `refresh('config')`, and `render()` now passes `detail` to the segment builders and every right-zone `render`. Signal handlers that render one component (`system:rails`, `review:*`, `system:backend-link`) pass the current density too.

### Keybindings

| Key | Context | Action |
|-----|---------|--------|
| `?` | Compositor mode | Toggle compact/detail (unchanged) |

## Edge Cases

- **No focus, webview pane, or a cwd outside a repo** — compact shows the mode chip (if any) and the right zone only; an empty left is correct.
- **Music active** — unchanged; with no hint to hide, the `data-music` hint rule goes away.
- **Non-Normal mode** — the chip appears at the left edge and the branch shifts right by its width. No new animation.

## Out of Scope

- The per-window footer (quotas, lane strip, project badge, diff stat) and the titlebar.
- Persisting density in TOML; new segments; changing colours (spec 236 stands).
- Which-key content.

## Resources

- [Zellij — The status-bar alias](https://zellij.dev/documentation/status-bar-alias.html) — default layout: a height-2 bar for input modes and their status
- [Zellij — The compact-bar alias](https://zellij.dev/documentation/compact-bar-alias.html) — compact layout: a height-1 bar with input mode and tabs
- [VS Code UX Guidelines — Status Bar](https://code.visualstudio.com/api/ux-guidelines/status-bar) — limit items; colour only for exceptions
