# Matrix Glyph Atlas — Permanent Fix for `fillText` CPU Burn

> Status: Spec — pending approval
> Date: 2026-04-24
> Supersedes mitigation in: [64-matrix-animation-cpu-burn.md](64-matrix-animation-cpu-burn.md)

## Goal

Eliminate the root cause of the matrix animation CPU burn by replacing every per-frame `fillText` call with a pre-rasterized `ImageBitmap` blit (`ctx.drawImage`). The 30 fps cap and idle-timeout from phase 1 stay in place; this change makes matrix cheap enough that those mitigations become unnecessary for correctness (they remain as defense-in-depth).

Expected outcome per `docs/64`: ~10× per-frame cost reduction — matrix moves from ~25–30% CPU (post-phase-1) into the single-digit range alongside `flame` and `circuit-trace`. Can then be restored to 60 fps without regression.

## Non-goals

- No changes to `claude-hooks.ts` (per-window scoping #2 and visibility pause #4 stay deferred).
- No changes to `brainwave.ts`. Its `fillText` usage is ~8–12 calls/frame (labels + readouts), not pathological. Revisit only if profiling shows it still matters after this change.
- No new worker-protocol messages. Atlas is built lazily inside the renderer on first `init`.

## Design

### The atlas

An offscreen bitmap holding one tile per `(char, fontSize)` pair, pre-rasterized once when the renderer is initialized.

- **Chars:** the existing `CHAR_POOL` (96 katakana + 10 digits + 26 Latin = 132).
- **Sizes:** `FONT_MIN..FONT_MAX` is 8..15px → 8 discrete integer sizes. Columns already pick from this range; quantize `fontSize` to `Math.round(...)` on column spawn so every column maps to one of the 8 tiers.
- **Color:** the atlas is rasterized in **white** (`#ffffff`) only. Tinting is applied at draw time (see below).
- **DPR:** atlas is rasterized at the current `devicePixelRatio` so blits are 1:1 pixel. Rebuild on DPR change (rare — same place we'd resize today).

Tile layout: rows = chars, columns = sizes. Each tile is padded to the largest size (15 px × 1.4 line height × DPR). Total atlas size at DPR=2: 132 rows × 8 cols × ~42 px × ~21 px ≈ **~1 MB RGBA**. Acceptable — built once, kept alive for the life of the renderer.

Stored as an `OffscreenCanvas` (works in both the worker and main-thread paths). `ctx.drawImage(offscreenCanvas, ...)` is supported everywhere we use it.

### Tinting without re-rasterizing

The atlas is white. To draw a colored glyph:

1. `ctx.save()`
2. `ctx.globalCompositeOperation = 'source-over'` (default)
3. `ctx.globalAlpha = alpha`
4. `ctx.drawImage(atlas, sx, sy, sw, sh, dx, dy, sw/dpr, sh/dpr)` — this paints the white glyph with `globalAlpha`.

That covers **trail** characters: the original code varies only `alpha` and a tiny `(g,b)` shift along the fade. We collapse the trail to a single green tint (`#00ff41`) with fading alpha — visually indistinguishable from the current output, per the informal tests already referenced in `docs/64`.

**How we get green from a white atlas:** one small pre-tinted **tint layer** per distinct color we need. Two layers suffice:

- `tintWhite` — the raw white atlas. Used for heads (`#e0ffe0` is ~white, acceptable to treat as white).
- `tintGreen` — a second offscreen canvas of the same dimensions, produced once by drawing `tintWhite` onto it and then filling `#00ff41` on top with `globalCompositeOperation = 'source-in'`. Used for trails.

Both layers are ~1 MB each. Built once. Zero per-frame CoreText calls after that.

### Head glow

The current head draws the glyph twice: once solid white, once with `shadowBlur`. `shadowBlur` on every `drawImage` would reintroduce per-frame IPC cost. Instead:

- Bake the glow into a third layer `tintGreenGlow`: draw `tintGreen` onto an offscreen canvas with a green `shadowBlur` applied once.
- At draw time: `drawImage(tintGreenGlow, ...)` then `drawImage(tintWhite, ...)` on top at full alpha.

Two blits per head character. Zero shadow state churn per frame.

### New per-frame loop

Replaces `src/matrix.ts:117-151`. For each visible character:

```ts
const tileSrc = atlasRect(char, col.fontSize); // {sx, sy, sw, sh}
if (i === 0) {
  ctx.globalAlpha = col.opacity * 0.5;
  ctx.drawImage(glowAtlas, tileSrc.sx, tileSrc.sy, tileSrc.sw, tileSrc.sh, dx, dy, w, h);
  ctx.globalAlpha = col.opacity;
  ctx.drawImage(whiteAtlas, tileSrc.sx, tileSrc.sy, tileSrc.sw, tileSrc.sh, dx, dy, w, h);
} else {
  const alpha = col.opacity * fadeRatio * fadeRatio;
  if (alpha < 0.02) continue;
  ctx.globalAlpha = alpha;
  ctx.drawImage(greenAtlas, tileSrc.sx, tileSrc.sy, tileSrc.sw, tileSrc.sh, dx, dy, w, h);
}
```

No `ctx.font`, no `ctx.fillText`, no `ctx.fillStyle`, no `ctx.shadowBlur` inside the hot loop.

### Atlas construction

New private method `MatrixRenderer.buildAtlas(dpr: number)`:

1. Compute tile dimensions: `tileW = Math.ceil(FONT_MAX * 1.2 * dpr)`, `tileH = Math.ceil(FONT_MAX * 1.4 * dpr)`.
2. Create `OffscreenCanvas(tileW * SIZE_COUNT, tileH * CHAR_POOL.length)`.
3. For each `(char, size)`: set `font = "${size}px monospace"`, `textAlign = 'center'`, `textBaseline = 'alphabetic'`, `fillStyle = '#ffffff'`, `fillText(...)` into its tile once.
4. Derive `greenAtlas` via `source-in` composite with `#00ff41`.
5. Derive `glowAtlas` via a green `shadowBlur` pass over `greenAtlas`.

Called from `init(W, H)` if not already built, or if DPR changed.

### Size quantization in `spawnColumn`

One-line change: `fontSize = Math.round(FONT_MAX - (FONT_MAX - FONT_MIN) * depth)` so columns always hit an integer size in `[FONT_MIN, FONT_MAX]`. The visible change is imperceptible (current code uses floats that are already sub-pixel).

## Files touched

- `src/matrix.ts` — add atlas builder, tile-lookup, swap `fillText` calls for `drawImage`. ~80 lines added, ~25 lines removed.
- `src/animation-worker.ts` — restore `matrix: 60` in `TARGET_FPS_BY_TYPE` (optional, after validation).
- `docs/64-matrix-animation-cpu-burn.md` — add "Phase 2" section noting atlas landed and closing item.
- `docs/PROGRESS.md` — add entry per `/feature-implementation`.

No IPC surface changes. No new commands. No worker protocol changes.

## Risks / open questions

- **DPR changes at runtime:** if the user moves the window between a retina and non-retina display, the atlas becomes wrong-sized. Handle by rebuilding in `applySize` / `resize` when `dpr` differs from the one the atlas was built at.
- **Memory:** 3 × ~1 MB atlases per renderer instance. Acceptable for 1–2 windows; if we ever scale to many windows, atlases could be shared across instances via a module-level cache keyed by DPR. Deferring until it matters.
- **`OffscreenCanvas` availability in main-thread fallback:** `MatrixAnimation` (DOM path) uses a regular canvas. `OffscreenCanvas` is available in all WebKit versions Tauri ships, so the atlas can be an `OffscreenCanvas` in both paths.
- **Font fallback:** `monospace` resolves per-platform. The atlas is tied to whatever glyph the platform returned at build time. Fine as long as the font doesn't change mid-session; it doesn't.

## Validation plan

1. `npm run check` must pass.
2. Visual diff: run `matrix` animation before/after side-by-side on a 1200 px window. Motion, color, glow should look identical.
3. CPU measurement: `sample` the WebContent process while animation is running. Worker threads should drop from pinned to low single digits. Hot stack should no longer contain `CTFontDrawGlyphs` / `DrawGlyphsAtPositions`.
4. After validation, restore `matrix: 60` in `TARGET_FPS_BY_TYPE` and re-measure — should still be below phase-1's 30 fps cost.

## Rollout

Single PR. Phase-1 safety net (idle timeout) stays in place permanently.
