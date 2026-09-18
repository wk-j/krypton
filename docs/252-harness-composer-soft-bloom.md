# ACP Harness Composer Soft Bloom — Implementation Spec

> Status: Implemented
> Date: 2026-09-17
> Milestone: ACP Harness polish
> Prototype: `art-78-211cbee0` (`Harness Prompt Layer Animation`) — timing and
> controls only; the expanding ellipse boom is **not** shipped.

## Problem

The ACP Harness composer renders every draft edit immediately, but the input has no
small visual acknowledgement that a character was inserted. Catch-up delayed text
made the prompt appear to lag. The art-78 expanding cyan ellipse read as a boom
around the caret rather than as the letter itself.

## Solution

Keep the draft text and existing inline block caret completely immediate. On a
direct text insertion only, spawn overlay **copies of the inserted graphemes** —
a cyan phosphor letter afterimage that ignites, drifts upward 3px, and dissolves. The overlay survives composer
`innerHTML` rebuilds, so fast typing leaves a fading trail of letters instead of
cancelling the previous flash. There is no ellipse, no `scale` boom, and no
cursor movement.

`krypton.toml` keeps the prototype's three evaluation controls: enable, duration
(180–700ms, default 320), and trail length (1–12 visible graphemes, default 5).
System `prefers-reduced-motion: reduce` still drops the effect entirely.
Catch-up delayed text is not shipped.

## Research

- `AcpHarnessView` owns the draft and cursor; printable keys, `Shift+Enter`, plain
  text paste, and `Ctrl+Y` converge on `insertDraft()`, which calls `setDraft()`.
- `setDraft()` calls `renderComposer()` synchronously. `renderComposer()` replaces
  the composer's full `innerHTML`. A class on the caret therefore dies on the next
  key and cannot stack the prototype trail. The bloom overlay is a detached DOM
  node re-appended after each rebuild so in-flight glyphs keep animating.
- The current cursor is already correct: `renderComposer()` inserts an inline
  `.acp-harness__caret` containing `█`. Production must not change its glyph,
  line-height, position, blink, or lane-accent styling. The prototype's custom
  caret is rejected.
- Glyph positions come from a `Range` that covers the inserted grapheme in the
  real input text before the caret, without a second caret. Each overlay node’s
  `textContent` is that grapheme so the flash sits on the letter, not a 26×22
  ellipse.
- Fast typing must stack afterimages, not replace them. VS Code's optional
  smooth-caret treatment has a reported failure mode where a moving caret trails
  immediate text. This design never animates cursor position.
- WebKit recommends declarative CSS animation of `transform` and `opacity`. The
  letter copy uses a compositor-friendly 3px upward drift while it dissolves.
  The prototype `translate3d` + `scale(0.45→1.7)` boom is still rejected.
- W3C Media Queries and WCAG technique C39 require honoring Reduce Motion.
  Because this feedback is non-essential, reduced motion drops it entirely.
- `DESIGN.md` text glows stack `0 0 8px` + `0 0 14px`. Motion is reserved for
  state. This is finite insertion feedback, not a loop. Idle cost is zero after
  `animationend` removes the glyph.

### Prototype findings

- Rejected: catch-up delayed text, expanding ellipse boom, vertical bounce,
  blur, deletion `×` markers, and an independently positioned cursor.
- Accepted: real text first, overlay copies of inserted graphemes as a fading
  phosphor afterimage with a subtle one-way upward drift, existing Krypton cursor untouched, prototype
  enable/speed/trail controls. Whitespace and newlines do not spawn a flash.

## Prior Art

| App / surface | Implementation | Consequence for Krypton |
|---|---|---|
| VS Code / Monaco | Optional smooth-caret class. Fast-typing reports show a moving caret can trail immediate text. | Do not animate the caret's position, shape, or size. |
| CodeMirror 6 | Direct input and paste are explicit user-edit transactions. | Arm motion from the known insertion path, not by diffing arbitrary rerenders. |
| Krypton Thought Teletype (spec 232) | Display cursor catch-up for streamed **output**. | Do not reuse it for user input. |
| `art-78-211cbee0` | Immediate + ellipse bloom (recommended in the prototype) vs catch-up; enable/speed/trail sliders. | Keep Immediate timing and the three controls. Replace the ellipse boom with letter afterimages. |

**Krypton delta** — Preserve editor-grade immediate input. Acknowledge typing
with the letters themselves (cyan phosphor afterimage) rather than a boom
around the caret. No change to text timing, cursor timing, keyboard behavior,
or ACP data flow.

## Affected Files

| File | Change |
|---|---|
| `src/acp/harness-composer-bloom.ts` | Clamp settings, overlay layer, visible-grapheme trail spawn, `Range` placement, glyph `textContent`. |
| `src/acp/acp-harness-view.ts` | Arm `{ laneId, inserted }` in `insertDraft()`, reattach the overlay after `renderComposer()`. |
| `src/styles/acp-harness.css` | Overlay + inherited-font glyph paint, opacity fade, reduced-motion and setting-off gates. |
| `src/config.ts`, `src-tauri/src/config.rs` | `[acp_harness] composer_bloom`, `composer_bloom_ms`, `composer_bloom_trail`. |
| `src/compositor.ts` | Apply those keys as live CSS variables / `data-acp-composer-bloom` on Reload Config. |
| Tests | Arming, overlay reattach, trail cap, reduced-motion skip, CSS contract, TOML defaults. |
| `docs/04-architecture.md`, `docs/05-data-flow.md`, `docs/72-acp-harness-view.md`, `docs/06-configuration.md` | User-facing contract and config keys. |

No ACP protocol, PTY, or persistence change.

## Design

### Data Structure

```ts
interface PendingComposerBloom {
  laneId: string;
  inserted: string;
}

private pendingComposerBloom: PendingComposerBloom | null = null;
private composerBloomLayer: HTMLElement | null = null;
```

The marker is not stored on `HarnessLane`. The overlay node is view-local and is
re-appended onto `.acp-harness__input` after each composer rebuild so in-flight
letter afterimages keep fading.

### Configuration

```toml
[acp_harness]
composer_bloom = true          # prototype "เปิด animation"
composer_bloom_ms = 320        # 180–700
composer_bloom_trail = 5       # 1–12 visible graphemes per insertion
```

Omitted keys use those defaults. Values outside the prototype ranges clamp.
`Reload Config` updates `--acp-composer-bloom-duration`,
`--acp-composer-bloom-trail`, and `html[data-acp-composer-bloom]`.

### Insertion Contract

`insertDraft()` is the only arming point. It records the inserted string, calls
`setDraft()`, and clears the marker in `finally`. `renderComposer()` then
reattaches the overlay and spawns letter afterimages for that insertion only.

| Mutation | Bloom | Reason |
|---|---:|---|
| Printable key | Yes | Direct insertion acknowledgement. |
| `Shift+Enter` newline | Yes | Uses `insertDraft()`. |
| Plain-text paste | Yes, last N graphemes | Prototype trail slider. |
| `Ctrl+Y` yank | Yes, last N graphemes | Existing direct insertion path. |
| Backspace / Delete / `Ctrl+H` / `Ctrl+D` | No | Prototype showed no deletion marker in the recommended mode. |
| Kill / transpose / history recall | No | Rewrite or navigation. |
| Mention, slash, hash, or verb completion | No | Programmatic replacement. |
| Dictation interim/final text | No | Separate live/final contract. |
| Queue edit, session restore, lane switch, status tick | No | Overlay is reattached without spawning; lane switch clears in-flight glyphs. |

### Rendered Markup

The caret stays exactly:

```html
<span class="acp-harness__caret">█</span>
```

Glyph copies are siblings in `.acp-harness__composer-blooms` (`aria-hidden`,
`pointer-events: none`). Each node’s `textContent` is one inserted grapheme.
They do not affect line layout.

### Motion and Paint

- Duration: `--acp-composer-bloom-duration` (default `320ms`).
- Curve: `cubic-bezier(0.22, 1, 0.36, 1)`.
- Paint: inherited composer font/line-height; phosphor cyan
  `rgba(110, 231, 231, 0.92)` with DESIGN.md text glow
  (`0 0 8px` + `0 0 14px`). No ellipse, no radial-gradient, no `26px×22px`.
- Keyframes: a quick `0 → 1` ignition followed by opacity decay and a one-way
  `translate3d(0, 1px, 0) → translate3d(0, -3px, 0)` drift. No `scale`.
- Stagger: `18ms` per trailing visible grapheme.
- Fast typing stacks afterimages; `animationend` removes each node.
- Animated properties: compositor-friendly `opacity` and `transform` only.

Under `@media (prefers-reduced-motion: reduce)` or
`html[data-acp-composer-bloom="off"]`, glyphs do not paint. The draft and
caret are unchanged.

### Data Flow

1. Printable key / paste / `Shift+Enter` / `Ctrl+Y` → `insertDraft()`.
2. Marker `{ laneId, inserted }` wraps synchronous `setDraft()` → `renderComposer()`.
3. Composer HTML rebuilds immediately, including the real caret.
4. `syncComposerBloomLayer()` reappends the overlay and spawns at most `trail`
   letter afterimages at the inserted visible graphemes.
5. `finally` clears the marker so a later status tick cannot spawn again.
6. `pinStickyAfterComposerKey()` is unchanged.

### Performance Contract

- One overlay node plus at most 12 glyph copies per insertion.
- No `requestAnimationFrame`, no mirrored textarea, no custom caret.
- `Range.getBoundingClientRect` only for the spawned graphemes of that insertion.
- Keypress-to-render remains within the repository's `<16ms` target for ordinary
  typing (one glyph). A 12-grapheme paste is still O(trail).

### Verification

1. Vitest: clamp/defaults, trail cap, whitespace skip, glyph `textContent`,
   reduced-motion skip, insertion-only arming, CSS letter paint (no ellipse boom).
2. `cargo test acp_harness_bloom_defaults_when_omitted`.
3. `npm run check`, targeted tests, `npm run build`.
4. Live smoke: type English/Thai, mid-string insert, long paste trail, Backspace
   stays still, Reduce Motion off, `composer_bloom = false` off, duration/trail
   change after Reload Config.

## Edge Cases

- Empty insertion is a no-op.
- Render failure still clears the marker through `finally`.
- Permission / question composer modes clear in-flight glyphs.
- Large paste stays visually bounded by `composer_bloom_trail`.
- Remote Harness profiles use the same frontend view.

## Open Questions

None. Follow `art-78-211cbee0` Immediate timing and its three controls. Ship
letter afterimages instead of the prototype ellipse boom. Catch-up remains a
prototype-only comparison mode.

## Out of Scope

- Catch-up or delayed visible input.
- Expanding ellipse boom, vertical bounce, scale burst, blur, or deletion markers.
- Cursor travel, cursor geometry, cursor blink, or baseline changes.
- Dictation, palette-completion, or history animation.
- Live Assist's separate local composer.
- Transcript line reveal (spec 93) and thought teletype (spec 232).

## Resources

- `.krypton/artifacts/hm-7/Codex-6/art-78-211cbee0.html` — approved Immediate + Soft Bloom example and controls.
- [W3C Media Queries Level 5 — prefers-reduced-motion](https://www.w3.org/TR/mediaqueries-5/#prefers-reduced-motion)
- [W3C WCAG Technique C39](https://www.w3.org/WAI/WCAG21/Techniques/css/C39.html)
- [WebKit: How Web Content Can Affect Power Usage](https://webkit.org/blog/8970/how-web-content-can-affect-power-usage/)
- [VS Code issue #295648](https://github.com/microsoft/vscode/issues/295648)
- `DESIGN.md` — motion, glow, caret, reduced-motion, and performance constraints.
- `docs/72-acp-harness-view.md`
- `docs/232-thought-teletype-hud.md`
