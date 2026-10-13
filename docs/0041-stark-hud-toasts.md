# Stark HUD Toast Redesign — Implementation Spec

> Status: Implemented
> Date: 2026-03-26
> Milestone: N/A — Visual enhancement

## Problem

The hook toast items are functional but visually flat — just a left border stripe, label, and text. They look like generic notifications, not like the futuristic AI HUD they're part of. The user wants them to feel like Tony Stark's JARVIS/F.R.I.D.A.Y. holographic display panels.

## Solution

Redesign the toast visual treatment to evoke Iron Man HUD panels: corner targeting brackets, holographic data micro-readouts (hex address + timestamp), animated border-draw entrance, subtle dot-grid overlay texture, and a glowing geometric accent line. All changes are CSS + minor HTML/TS additions — no architectural changes.

## Affected Files

| File | Change |
|------|--------|
| `src/claude-hooks.ts` | Add timestamp readout + hex address + corner brackets to toast DOM |
| `src/styles.css` | Redesign toast CSS with HUD panel aesthetics |

## Design

### Toast DOM Structure (current → new)

**Current:**
```html
<div class="krypton-claude-toast krypton-claude-toast--tool">
  <span class="krypton-claude-toast__label">TOOL</span>
  <span class="krypton-claude-toast__text">Edit ← main.ts</span>
</div>
```

**New:**
```html
<div class="krypton-claude-toast krypton-claude-toast--tool">
  <span class="krypton-claude-toast__bracket krypton-claude-toast__bracket--tl">┌</span>
  <span class="krypton-claude-toast__bracket krypton-claude-toast__bracket--tr">┐</span>
  <span class="krypton-claude-toast__bracket krypton-claude-toast__bracket--bl">└</span>
  <span class="krypton-claude-toast__bracket krypton-claude-toast__bracket--br">┘</span>
  <span class="krypton-claude-toast__label">TOOL</span>
  <span class="krypton-claude-toast__text">Edit ← main.ts</span>
  <span class="krypton-claude-toast__telemetry">0x3A7F · 14:32:08</span>
</div>
```

Four corner bracket glyphs (`┌ ┐ └ ┘`) positioned absolute at corners — they animate in during entrance (draw from center outward). A telemetry readout shows a short pseudo-hex address + timestamp for that sci-fi data-stream feel.

### CSS Changes

**1. Corner Targeting Brackets**
- Four `__bracket` elements positioned absolute at corners using `top/bottom/left/right: -1px`
- 8px font, accent-colored at 40% opacity, transitions to 70% on hover
- On entrance: brackets start offset inward by 4px and fade in with a 50ms stagger (TL→TR→BL→BR)
- Thin 1px lines extend from each bracket along the edges using `::before`/`::after` (8px long, accent at 15%)

**2. Holographic Dot-Grid Overlay**
- `::before` on the toast body: `radial-gradient(circle, accent 0.5px, transparent 0.5px)` at `4px 4px` repeat
- Very subtle: accent at 3-4% opacity, `pointer-events: none`
- Gives the "holographic projection surface" texture

**3. Telemetry Readout**
- Right-aligned, tiny monospace text (8px), accent at 25% opacity
- Format: `0xNNNN · HH:MM:SS` where NNNN is random hex per toast (like a memory address), time is creation timestamp
- On hover: brightens to 45%

**4. Animated Border-Draw Entrance**
- Replace the instant `translateX` slide with a two-phase entrance:
  - Phase 1 (0-150ms): Brackets draw in from edges, toast outline appears as thin lines extending from corners
  - Phase 2 (150-350ms): Background fills in, content fades up, telemetry flickers briefly
- Uses CSS `@keyframes` with `clip-path` or `max-width`/`max-height` on bracket line pseudo-elements

**5. Enhanced Glow Treatment**
- Top edge gets a thin 1px accent gradient line (fades at both ends) — like a HUD separator
- Active/newest toast has a subtle outer glow ring (box-shadow with larger spread)
- Permission prompt toast gets a pulsing diamond indicator `◆` before the label

**6. Label Redesign**
- Wrap label text in bracket chars: `[ TOOL ]` style with letter-spacing
- Thin underline rule beneath label, accent at 20%

### Data Flow

No data flow changes — purely visual. The `showToast()` method in `claude-hooks.ts` creates additional DOM elements, CSS handles all animation.

### Steps in `showToast()` (TS changes)

```
1. Create toast div (unchanged)
2. Create 4 bracket spans, position with BEM classes
3. Create label span — prepend/append bracket chars [ ]
4. Create text span (unchanged)
5. Create telemetry span with hex + time string
6. Append all to toast, prepend to container
7. requestAnimationFrame → add --visible class (CSS handles the rest)
```

## Edge Cases

1. **Very long toast text** — telemetry readout is absolutely positioned, won't push layout. Text still truncates with ellipsis.
2. **Many toasts stacked** — brackets are within each toast's bounds, no overflow issues. Depth staggering still works.
3. **Permission prompt toast** — gets enhanced treatment on top of base HUD style (pulsing glow is additive).
4. **Toast dismiss click** — click target includes brackets (they're inside the toast div), no interaction change.

## Open Questions

None.

## Out of Scope

- Sigil badge redesign (separate effort)
- Neural uplink bar changes
- Activity trace changes
- Sound effects on toast appearance
- Interactive toast actions (approval buttons etc. — that's phase 2)
