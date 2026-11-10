# Workspace Footer Kind Palette — Implementation Spec

> Status: Implemented
> Date: 2026-08-24
> Milestone: visual chrome
> Related: [121](./0121-workspace-status-bar.md), [235](./0235-harness-tool-output-palette.md)
> Spec 350 (2026-11-01): the footer hint is removed, with its `<kbd>` markup, `parseHint` / `fillHint` and the `__hint` CSS.
> Styling superseded by [spec 0366](./0366-console-faceplate-ui.md) and DESIGN.md (Krypton Console): footer is a plate strip; segment glows removed. DESIGN.md 2.3.6 replaces the footer's green Git text with a neutral-ink recessed readout. Composer-meta styling is unchanged by this footer-only amendment.

## Problem

The workspace footer paints almost every field with `--krypton-window-accent`
(cyan) at different opacities. Mode, view title, cwd, git, and the keyboard
hint read as one boring blue run. Semantic tokens already exist for
success / warning / danger / special; only dirty-git, attention, and link
faults use them. Cyan is the default type color instead of the rare instrument
color.

## Solution

Keep chrome receding. Stop using cyan as body text.

1. **Default type is phosphor** (`--krypton-fg` / `--krypton-fg-rgb`).
   Priority still uses opacity (P0 0.88, P1 0.72, P2 0.52, P3 0.40).
2. **Hue is kind, not priority.** Cyan is reserved for non-normal mode and
   live throughput. The footer Git ref uses neutral ink; dirty stays the warning dot.
   Music flags stay warning. Hint keys were removed by spec 350.
3. **Material carries role.** The footer branch is data in a small well, not a success lamp.
   Composer-meta is a separate surface; this footer amendment does not change it.

No new tokens. The branch uses one `--mat-well` / `--mat-well-shadow` readout with 8px radius
and 2px × 6px padding. CWD stays flat. No side-stripe or extra slab behind the rail.

## Research

- `workspace-footer.css`: default segment, role, project, git, p2, p3, hint,
  and music icon/time are all `rgba(--krypton-window-accent-rgb, N)`. Git even
  glows cyan. That is opacity hierarchy inside one hue.
- Dirty git already uses `--krypton-warning-rgb`. State/attention/link already
  use semantic rgb. The palette is in the file; idle type is not on it.
- Spec 235 just did the same move for harness dumps: cyan is chrome, body is
  foreground. The footer is the leftover cyan wall.
- `--krypton-cyan` in the footer is a hardcoded fallback, not a theme token.
  Use `--krypton-accent` / `--krypton-window-accent-rgb`.
- Hint is a flat `textContent` string (`Cmd+P lanes · #cancel running`).
  Structure needs a small DOM wrap, not more hue.
- Composer `.acp-harness__project-branch` is hardcoded
  `rgba(109, 208, 255, 0.92)` plus cyan glow, matching today's footer git.

**Alternatives ruled out**

- *Keep cyan, only bump opacity contrast* — still one hue; does not answer
  "boring blue."
- *A different neon per segment* — spectacle; PRODUCT.md chrome recedes;
  colorize product register is Restrained.
- *Nested chips around cwd/git* — cwd stays flat; git gets one well, not another wrapper or status chip.

## Prior Art

| App | Implementation | Notes |
|-----|----------------|-------|
| Starship / p10k | Cwd is path color; git is green when clean, yellow/red when dirty | Kind hue, not one accent |
| iTerm2 status bar | Per-component color; git is not the default text color | Configurable, but the convention is typed fields |
| Zellij status-bar | Mode is the loud field; session/cwd recede | Mode as the instrument |
| tmux | `status-style` default + per-widget `fg=` | Widgets are typed |
| Spec 235 harness dumps | Body phosphor; kind chip + git path use semantic tokens | Same Krypton move, inner surface |

**Krypton delta** — match the shell-prompt convention (cwd ≠ git ≠ mode) but
stay on DESIGN.md tokens, 28px, no powerline wedges, no opaque slabs. Cyan
stays the mode instrument, not the alphabet.

## Affected Files

| File | Change |
|------|--------|
| `src/styles/workspace-footer.css` | Kind colors; drop cyan glow on git; kbd on hint |
| `src/styles/theme-scheme.css` | Light scheme: drop accent-mix default; inherit kind tokens |
| `src/styles/acp-harness.css` | `.acp-harness__project-branch` → success rgb |
| `src/workspace-footer.ts` | Render hint as kbd + label parts; `parseHint` / `fillHint` |
| `src/workspace-footer.test.ts` | Hint parse cases + CSS kind-map assertions |
| `docs/0121-workspace-status-bar.md` | Type/color contract |
| `docs/README.md` | Index |

## Design

### Kind map

| Segment | Color | Notes |
|---------|-------|-------|
| Mode NORMAL | fg 0.88 | No chip, no cyan |
| Mode other | accent | Existing chip; the one cyan instrument |
| Role / title | fg 0.88 | Identity, not status |
| CWD | fg 0.72 | Location |
| Git ref | `--krypton-ink-2` | Recessed well; original ref case, not a success state |
| Git dirty dot | warning rgb | Unchanged |
| Counts / process | fg 0.52 | P2 |
| Throughput | accent 0.70 | Live data; cyan earned |
| Progress | fg 0.40 | P3 |
| Music track | fg 0.88 | |
| Music flags | warning | Unchanged |
| Music icon / time | fg 0.52 | Recede |
| Music progress fill | accent | Unchanged |
| Attention / link / reviews | existing semantic | Unchanged |
| Center middot | fg 0.28 | Not accent |

### Hint markup

Removed by spec 350.

### CSS (shape)

```css
.krypton-workspace-footer__segment {
  color: rgba(var(--krypton-fg-rgb), 0.72);
}
.krypton-workspace-footer__segment--p0,
.krypton-workspace-footer__segment--role {
  color: rgba(var(--krypton-fg-rgb), 0.88);
}
.krypton-workspace-footer__segment--git {
  color: var(--krypton-ink-2);
  padding: 2px 6px;
  border-radius: var(--krypton-border-radius, 8px);
  background: var(--mat-well);
  box-shadow: var(--mat-well-shadow);
  line-height: 1.4;
}
```

Light and dark schemes use the same readout recipe through shared ink and material tokens.
In detail density an 8px gap replaces the separator before git, keeping grooves outside the well.

## Edge Cases

- Git uses shared ink and well tokens on krypton-light, krypton-dark and custom themes;
  do not hardcode a green branch colour.
- Reduced motion: none. This is static color.
- Dirty git: neutral ref + amber dot. Color is not the only signal (glyph +
  `aria-label` already say uncommitted).
- Compact density / music-on: same colors; hiding rules unchanged.

## Out of Scope

Window titlebars, tab chrome, NASA Vault, Amber Agent frames. New footer
fields. Powerline / Nerd Font separators. Changing attention or Xenon-link
semantics.

## Resources

- [iTerm2 Status Bar](https://iterm2.com/documentation-status-bar.html) —
  per-component color, git is not default text
- Starship / Powerlevel10k git modules — green clean, yellow/red dirty
- `DESIGN.md` colors.success / warning / primary; PRODUCT.md chrome recedes
- Spec 235 — cyan is chrome, dump body is phosphor
