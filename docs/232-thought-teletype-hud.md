# Thought Teletype HUD — Implementation Spec

> Status: Implemented
> Date: 2026-08-18
> Milestone: ACP Harness polish
> Related: `docs/216-workspace-thought-field.md`, `docs/93-acp-harness-text-animation.md`, `docs/231-lane-peek-action-hud.md`

## Problem

The right-rail thought card (spec 216) is a ghost markdown dump. Live reasoning appears as a block that grows in chunks. It does not read as a live instrument: no caret, no phosphor settle, no sense that glyphs are arriving. The user asked for a sci-fi teleprinter on this card only.

## Solution

Keep the 216 slot, source, and occupancy rules. During `delta`, paint the body as a **catch-up teletype**: a display cursor chases `thought.text`, newest glyphs sit brighter then settle to ghost, a block caret marks the print head. On `seal`, snap the remainder and restore GFM. Veil is unchanged.

No scan wipe, no corner brackets, no grid, no wallpaper, no decrypt scramble.

## Research

- Spec 216 already streams `thought.phase` (`veil` | `delta` | `seal`) into `.acp-harness__lane-thought`. Same-lane refresh patches the body. Occupancy (peeked-if-it-has-thought, else active) stays.
- Live thought today calls `renderPeekThoughtMarkdown` on every chunk. Replacing `innerHTML` from `marked` would reset any per-glyph animation and strobe. Live markdown is the wrong substrate for a teleprinter.
- Transcript thought already streams as plain text (`updateStreamingTextBody`); markdown waits for seal on assistant rows. The rail should match that split.
- Spec 93's per-line stagger is for pretext transcript rows. Thought is a 10-line clamped card, not pretext. Do not reuse `--i` line-in here.
- Spec 34/64/67: canvas rain is a known CPU burn. This card is 320×~10em. CSS + one rAF while `delta` is enough.
- DESIGN.md: motion is state; infinite ambient dies under `prefers-reduced-motion`; no `backdrop-filter`; hard geometry; no left-rail accents. Window chrome may use corner ticks; **this card may not** (user lock: no bracket borders).
- Artifact `art-54-1f633f70` is the visual lock: Teletype vs current, scan and brackets removed.

**Alternatives ruled out**

- *Decrypt lock / holodisplay* — user picked Teletype.
- *Scan wipe / CRT cross-line* — user rejected.
- *L-corner / bracket chrome* — banned in this app for this surface.
- *Throttle the real stream* — thought would lag the model. Catch-up never trails more than `FRESH` glyphs.
- *Live GFM typewriter* — cannot type through half-parsed markdown without reflow flicker.
- *Canvas / OffscreenCanvas* — idle-CPU budget; 10 lines of spans are enough.

## Prior Art

| Surface | Behavior | Notes |
|---------|----------|-------|
| Alien MU/TH/UR, WarGames, 2001 | Teleprinter + block caret | Anchors for this pick |
| Claude.app / Codex | Token stream in the thread | No dedicated thought instrument |
| Spec 93 transcript | New pretext lines fade+rise | Different surface; leave it |
| Spec 216 thought today | Ghost GFM, veil dots | Baseline this spec replaces while live |

**Krypton delta** — the rail thought card is the only teleprinter. The transcript stays 93. Sealed thought stays 216 GFM.

## Affected Files

| File | Change |
|------|--------|
| `src/acp/harness-thought-teletype.ts` | **New.** Catch-up step, paint, reduced-motion snap. |
| `src/acp/harness-thought-teletype.test.ts` | **New.** Catch-up cap, shrink, seal snap, code-point advance. |
| `src/acp/lane-peek.ts` | `delta` body goes through the teletype painter; veil/seal unchanged. |
| `src/acp/acp-harness-view.ts` | rAF armed only while the showing thought card is `delta`. |
| `src/styles/acp-harness.css` | Fresh glyphs, block caret; reduced-motion. |
| `docs/216-workspace-thought-field.md` | Amend "no caret"; live body is plain teletype, GFM on seal. |
| `docs/72-acp-harness-view.md` | One line under the thought slot. |
| `docs/README.md` | Index. |
| `docs/prototypes/232-thought-teletype-hud.html` | Static/replay mock matching the artifact. |

## Design

### Data

```ts
const FRESH = 10;          // trailing glyphs painted as phosphor
const MAX_BEHIND = 16;     // catch-up never trails more than this
const TICK_MS = 16;        // one code point per rAF when close

interface ThoughtTeletypeState {
  source: string;
  shown: number;           // code-unit index into source, on a code-point boundary
}
```

`source` is `thought.text`. `shown` is how far the print head has reached. Advance by Unicode code point (do not split surrogates).

### Catch-up

On each rAF, and once immediately on every `thought_chunk` that patches this card:

```
if reduced-motion or phase !== 'delta': shown = source.length
else if source.length < shown:          shown = source.length        // rewrite
else if source.length - shown > MAX_BEHIND:
  shown = source.length - FRESH         // burst; never lag a big chunk
else:
  shown = nextCodePoint(source, shown)  // one glyph
```

Stop the rAF when `phase !== 'delta'` or the slot is hidden or `shown === source.length` after a seal snap.

### Paint (delta)

Body is plain `pre-wrap` text, not GFM:

```
[0, shown - FRESH)     ghost (inherit body color)
[shown - FRESH, shown) .acp-harness__thought-fresh   (cyan, then settles by aging out of the window)
caret                  .acp-harness__thought-caret   after `shown`
```

Pin to the latest line (`schedulePeekThoughtPin`). Same-lane patch must not `replaceChildren` the card.

### Phases

| Phase | Body | Label | Caret | rAF |
|-------|------|-------|-------|-----|
| `veil` | `installThoughtVeil` (unchanged) | `thinking` | no | off |
| `delta` | teletype plain text | `thinking` | yes | on until caught up, then on each new chunk |
| `seal` | snap, then `renderPeekThoughtMarkdown` | `thought` | no | off |
| empty seal | hide slot (216) | — | — | off |

### UI

- Full 1px border, existing 216 panel fill. No L-corner ticks, no scan wipe, no CRT grid, no extra glow layer.
- Caret: 7×1.05em block, `--krypton-color-primary`, steps blink 1.05s. Hidden when sealed / veiled / reduced-motion.
- Fresh glyphs: primary at ~0.85. They become ghost by leaving the last-`FRESH` window, not by a color animation on every character.
- Labels stay `thinking` / `thought`. Lane name still carries the accent.

### Data flow

```
1. thought_chunk appends lane.transcript / lane.currentThoughtId (unchanged)
2. renderLaneThought() / patchLaneThoughtCard() as today
3. If phase === 'delta': write source into ThoughtTeletypeState; step catch-up; paint
4. View arms a rAF while this card is delta and shown < source
5. On seal: shown = source.length, drop caret, renderPeekThoughtMarkdown, cancel rAF
6. prefers-reduced-motion: skip 3–4, paint full source (plain) then GFM on seal
```

### Keybindings

None.

### Configuration

None.

## Edge Cases

- Solo lane thinking → teletype on the thought slot; peek stays hidden (216).
- Peeked lane with thought → teletype follows that lane; switching peek target resets `shown` to 0 then catch-up (snap if reduced-motion).
- Huge chunk (hundreds of chars) → one burst to `source.length - FRESH`, then tick the tail. No multi-second backlog.
- Source shrink / rewrite → `shown = source.length`.
- Empty live deltas → veil, not an empty teletype.
- Concise mode → transcript thought still hidden; this slot still types.
- Spec 231's action HUD is gone; this slot is the only thinking instrument.
- Native webview / Live Assist → unchanged.

## Open Questions

None. Visual locks: Teletype HUD, no scan, no brackets, instrument, live only.

## Out of Scope

- Transcript thought rows (93 / 114).
- Wallpaper thought field, ViewBus, `[thought_field]` TOML.
- Decrypt, holodisplay, Matrix rain, scan wipe, bracket chrome.
- Changing 216 occupancy or the 320px rail.

## Resources

- [docs/216-workspace-thought-field.md](216-workspace-thought-field.md) — slot, phases, occupancy
- [docs/93-acp-harness-text-animation.md](93-acp-harness-text-animation.md) — why not pretext stagger
- [docs/231-lane-peek-action-hud.md](231-lane-peek-action-hud.md) — action HUD removed; thought slot is the thinking instrument
- [docs/34-background-animations.md](34-background-animations.md) / [64](64-matrix-animation-cpu-burn.md) — do not canvas this
- [DESIGN.md](../DESIGN.md) — motion as state, reduced-motion, no `backdrop-filter`
- Artifact `art-54-1f633f70` — chosen mock
