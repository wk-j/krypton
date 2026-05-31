# 131. Visual Asset Generation Brief — Theme · Logo · Character · Sprite

> Status: Brief (for image-generation agents)
> Audience: an AI agent that can generate images (Nano Banana / DALL·E / Midjourney / Stable Diffusion / Flux, etc.)
> Source of truth for style: [`DESIGN.md`](../DESIGN.md) (Krypton Dark). This brief translates that spec into ready-to-paste prompts.

## How to use this document

Each asset below ships as a self-contained block:

- **Goal** — what the asset is for.
- **Spec** — size, aspect, count, background (transparent vs. filled).
- **Prompt** — paste this verbatim into the image model. Palette hex are locked inline so the model cannot drift off-brand.
- **Negative** — what to suppress (omit on models that ignore negative prompts; fold the key "no …" clauses into the main prompt instead).

Generate, then check every result against the **Brand Lock** below before accepting it. **Regenerate** for *concept* violations (rounded corners, opaque fill, single flat glow, proportional font, a literal cartoon face) — don't paint over a wrong concept. **Retouch / vectorize** only for *cleanup*: alpha edge cleanup, exact geometry, sprite-cell alignment, and the logo/wordmark vector rebuild (see Asset 2).

---

## Brand Lock (applies to every asset)

Krypton is a keyboard-driven terminal emulator dressed as **salvaged military terminal hardware** — a thin neon HUD floating over a deep blue-black void. Precise, instrumented, slightly luminous, silent until addressed.

**Locked palette**

| Role | Hex | Notes |
|---|---|---|
| Primary accent (cyan) | `#00ccff` | the brand. drives every glow, border, indicator |
| Foreground (phosphor slate) | `#b0c4d8` | "phosphor white", cool slate |
| Void background | `#060a12` | deep blue-black; near-black with blue bias |
| Danger | `#ff3a5c` | error state only |
| Warning | `#e8c547` | warning state only |
| Success | `#39ff7f` | success state only |
| Special | `#c77dff` | AI / special indicator only |

**Backend identity tints** — each agent backend's brand color, from `--krypton-backend-*` in `src/styles/acp-harness.css`. Used to recolor the character/sprite family per agent (see Character & Sprite).

> These are the **backend identity** colors (stable per agent product). They are *not* the runtime `lane.accent`, which is a positional cycle assigned by spawn order (`laneAccent(index)` in `acp-harness-view.ts`: cyan, green, amber, magenta, pink, teal, orange, purple, sky). The positional cycle is deliberately **not** used for these assets — a character should carry its agent's identity, not its spawn slot.

| Backend | Hex | Reads as |
|---|---|---|
| Claude | `#d97757` | terracotta / clay orange |
| Codex | `#d7e7f0` | pale ice white |
| Gemini | `#6f8fd9` | periwinkle blue |
| OpenCode | `#c186d9` | orchid violet |
| Pi | `#6fd9c0` | teal mint |
| Droid (Factory) | `#d9a86f` | warm sand |
| Cursor | `#c0c0c0` | brushed silver |
| Junie (JetBrains) | `#d96fb3` | magenta-pink |
| OMP (Oh My Pi) | `#d9c66f` | muted gold |

**Always**
- Monospace type only (Mononoki / JetBrains Mono feel). Uppercase + wide letter-spacing for labels.
- Hard geometry: 0px corners, 1px hairline borders, L-shaped corner brackets.
- **Multi-layer glow** — a tight inner glow (~6px) stacked with a wide soft bloom (~20px). Never one flat drop shadow.
- Background reads as translucent ink over void; light appears *emitted*, not painted.
- Scanlines / micro-dot grid at 2–3% opacity for machine-grade texture.

**Never** (regenerate if present)
- Rounded corners > 2px, pillowy bevels, glossy 3D buttons.
- Fully opaque flat fills that kill the depth/glow hierarchy.
- Proportional (non-mono) fonts, script fonts, serifs.
- Rainbow gradients, lens flares, chromatic-aberration overload, generic "sci-fi stock" clutter.
- Mascots with faces/eyes/limbs of a cute cartoon kind (the character is a *signal construct*, not a Saturday-morning mascot — see Character).

---

## Asset 1 — Theme / Key Art

**Goal** — hero/marketing key art and desktop wallpaper that captures the Krypton mood; also the README banner.

**Spec**
- Variants: (a) 16:9 landscape hero `2560×1440`, (b) 1:1 social `1500×1500`, (c) optional 21:9 ultrawide wallpaper.
- Filled background (this is the one asset that is *not* transparent).

**Prompt**
```
Cyberpunk military terminal HUD floating in a deep blue-black void, viewed
head-on. A salvaged sci-fi command interface: thin 1px cyan (#00ccff) hairline
borders, sharp 0px corners, L-shaped corner brackets glowing at the corners of
floating rectangular panels. Multiple translucent dark-ink panels (color #060a12
at ~50% opacity) layered at varying depths, each emitting a soft cyan glow — a
tight inner glow plus a wide outer bloom. Monospace console readouts in cool
phosphor slate (#b0c4d8): uppercase wide-tracked labels, columns of tabular
numerals, thin progress gauges with cyan fill. Faint horizontal scanlines and a
3% micro-dot grid texture across the void. A few status dots glow at full neon
cyan. Mood: precise, instrumented, luminous, silent. High contrast, mostly dark
negative space, light appears emitted not painted. Flat front-on composition,
no perspective clutter.
```
**Negative**
```
rounded corners, glossy buttons, 3D bevels, lens flare, rainbow gradient,
chromatic aberration, busy clutter, serif font, proportional font, photo
realism of people, faces, daylight, white background, opaque flat panels
```

---

## Asset 2 — Logo

Two deliverables: a **glyph/mark** (standalone icon) and a **wordmark** (with the name).

> **Image-gen is for exploration only here.** Models mangle text geometry and letterforms. Use these prompts to explore directions, then **rebuild the final glyph and wordmark as SVG/vector** — set "KRYPTON" in a real monospace font (Mononoki / JetBrains Mono) and convert to paths, and redraw the glyph as clean vector. The no-glow 1-bit silhouette requirement points the same way: the shippable logo is vector, not a raster generation.

### 2a — Glyph / app mark

**Goal** — app icon, favicon, tab/rail glyph. Must read at 16px and at 1024px.

**Spec** — transparent PNG, square, `1024×1024`. Keep a **12–16% safe-area margin** on all sides (the glow must stay inside the canvas, never clipped at the edge). Must read at 16px. Also request a separate **no-glow 1-bit silhouette** version for favicon / tiny sizes.

**Concept** — the letter **K** constructed from terminal primitives: a vertical "cursor bar" stem and two diagonal beams that read as a chevron/prompt (`>`), enclosed by L-shaped corner brackets. Monoline, geometric, glows.

**Prompt**
```
Minimalist geometric logo glyph of the letter "K" built from a thin monoline
cyan (#00ccff) stroke, constructed like a terminal cursor and command prompt:
a vertical bar stem with two diagonal beams forming a chevron. Enclosed by four
small L-shaped corner brackets like a HUD reticle. Sharp 0px corners, perfectly
geometric, single consistent stroke weight. Emits a tight cyan inner glow plus a
soft outer bloom against a fully transparent background. Flat vector style, no
gradient fill inside the strokes, no 3D, centered, generous padding.
```
**Negative**
```
text, words, letters other than K, rounded corners, gradient mesh, 3D extrude,
drop shadow blob, photo, mascot, glossy, busy detail, filled solid shape
```

### 2b — Wordmark

**Goal** — README header, splash, docs.

**Spec** — transparent PNG, wide `2400×600`. Provide on transparent + on `#060a12`.

**Prompt**
```
Logotype of the word "KRYPTON" in uppercase monospace type with wide 0.2em
letter-spacing, cool phosphor-slate color (#b0c4d8), each letter emitting a thin
cyan (#00ccff) edge glow (tight inner glow + soft bloom). To the left, a small
geometric "K" prompt glyph made of a cyan monoline cursor-and-chevron inside
L-shaped corner brackets. Thin 1px cyan baseline rule under the word with two
small corner ticks. Deep blue-black void or transparent background. Hard
geometry, no rounded corners, instrumented military-terminal feel.
```
**Negative**
```
serif, script, handwriting, proportional font, rounded, gradient rainbow,
3D, glossy, neon tube cliché, photo, mascot
```

---

## Asset 3 — Character

**Goal** — a brand character/mascot that represents the **agent lanes**. Krypton's headline feature is a harness that runs many AI coding agents in parallel; the character personifies "an agent inside the terminal." It is a **signal construct** — a holographic operator entity rendered in the terminal's own glow language, *not* a fleshed cartoon mascot.

**Core concept — "the Operator"**

A faceless humanoid bust/figure made of layered translucent scanline-holography and wireframe, framed inside (or emerging from) a floating terminal panel with L-corner brackets. Head suggested by a smooth visor/mask plane carrying a single thin status readout line instead of a face. Shoulders/torso dissolve into data-stream particles and monospace glyph fragments at the edges. Silent, poised, attentive.

**Spec**
- Master/base character: transparent PNG, portrait `1500×2000`, plus a head-and-shoulders crop `1000×1000`.
- Style must hold up as a flat front-on "console portrait", not a dynamic 3D render.

**Prompt (base / brand-cyan)**
```
A faceless holographic "operator" construct — head-and-shoulders bust of a
humanoid figure made of thin cyan (#00ccff) wireframe and translucent scanline
holography, glowing with a tight inner glow and soft outer bloom against a
transparent background. No facial features: the face is a smooth dark visor
plane (#060a12) carrying one thin horizontal cyan readout line and a single
glowing status dot. Shoulders and lower torso dissolve into a drifting stream of
data particles and tiny monospace glyph fragments. Framed by faint L-shaped HUD
corner brackets. Cool phosphor-slate (#b0c4d8) highlights on the wireframe
edges. Front-on symmetrical "console portrait" composition, instrumented and
calm. Hard-edged geometric, monospace HUD aesthetic, salvaged military terminal
mood.
```
**Negative**
```
cute cartoon mascot, eyes, mouth, smile, anime face, fleshy skin, limbs in
action pose, glossy 3D render, photorealistic human, rounded soft shapes,
rainbow colors, busy background, text logo
```

### 3a — Per-backend variants (the agent family)

Generate the **same base construct** once per backend (nine total), recoloring the construct's accent (wireframe + glow + readout line + status dot) to each backend identity tint while keeping the void face plane and overall silhouette identical. This yields one consistent family of agents.

For each backend, take the base prompt and replace every `#00ccff` with the backend hex, and append the descriptor:

| Backend | Replace accent with | Append to prompt |
|---|---|---|
| Claude | `#d97757` | "warm terracotta-orange construct" |
| Codex | `#d7e7f0` | "pale ice-white construct, faintest tint" |
| Gemini | `#6f8fd9` | "periwinkle-blue construct" |
| OpenCode | `#c186d9` | "orchid-violet construct" |
| Pi | `#6fd9c0` | "teal-mint construct" |
| Droid | `#d9a86f` | "warm sand construct" |
| Cursor | `#c0c0c0` | "brushed-silver monochrome construct" |
| Junie | `#d96fb3` | "magenta-pink construct" |
| OMP | `#d9c66f` | "muted-gold construct" |

> Keep the **face plane** `#060a12` and the **silhouette** identical across all nine — only the emissive accent changes. That sameness is what makes them read as one family of agents.

---

## Asset 4 — Sprite Sheet (lane status states)

**Goal** — small animated/iconographic sprites that show each lane's live status in the harness rail. These map 1:1 to the real status union in code (`HarnessLaneStatus`): `starting · idle · busy · needs_permission · awaiting_peer · error · stopped`.

This is the most app-grounded asset — the sprite *is* the status indicator.

**Spec**
- Sprite sheet: 7 frames in one row (or a 4×2 grid), each cell `256×256`, transparent background, uniform padding, consistent baseline so cells can be swapped in place.
- Subject: a simplified head-only / orb version of the Operator construct (chibi-free; keep it an abstract signal token, readable at 24px in the rail).
- Provide each state also as a standalone `256×256` transparent PNG for engineering convenience.
- Default accent: brand cyan `#00ccff`. **Runtime recoloring of PNGs is not automatic.** The existing rail status icons are inline SVG using `currentColor`, so they recolor for free; flat PNG sprites do not. Pick one delivery mode:
  - **(a) Preferred — monochrome alpha mask:** deliver each frame as a white-on-transparent silhouette intended for CSS `mask-image`; per-backend color then comes from `currentColor`/background, matching how the rail already tints icons.
  - **(b) Full per-backend set:** generate all nine recolors per state (9 × 7 frames).
  - **(c) Engineering task:** ship the cyan set and recolor bitmaps at runtime via canvas/CSS filter.

**State design table** — each frame must be visually distinguishable at a glance:

| State | Visual idea | Accent | Motion hint (if animated) |
|---|---|---|---|
| `starting` | construct half-materialised from scanlines, dim, assembling | cyan `#00ccff` @ ~40% | particles converging inward |
| `idle` | calm steady construct, single lit status dot, slow breathing | cyan `#00ccff` | 3s breathing pulse |
| `busy` | construct with a sweeping scan-line and a thin spinning data ring; "working" | cyan `#00ccff` | 1.8s data-stream sweep |
| `needs_permission` | construct paused, a small key/lock glyph floating beside it, alert posture | warning `#e8c547` | gentle ambient pulse |
| `awaiting_peer` | two faint linked nodes, the construct turned slightly toward a second ghost node (waiting on another lane) | special `#c77dff` | slow link-line shimmer |
| `error` | construct fragmented/glitched, broken scanlines, a cross/alert tick | danger `#ff3a5c` | brief glitch jitter |
| `stopped` | dim grey dormant outline, status dot dark, powered-down | inactive cyan @ ~15% | none (static) |

**Prompt (one cell — repeat per state, swap the bracketed parts)**
```
A single small HUD status sprite on a transparent background, 256x256, centered
with even padding. A simplified abstract "signal construct" token — a faceless
glowing orb/head made of thin [ACCENT_HEX] wireframe and scanline holography
with a tight inner glow and soft bloom, dark void core (#060a12). State:
[STATE_DESCRIPTION FROM TABLE]. Hard-edged geometric monospace-HUD style,
framed by faint L-shaped corner brackets, one glowing status dot. Flat front-on,
consistent baseline and scale, no text. Salvaged military terminal aesthetic.
```
**Negative**
```
cute mascot face, eyes, mouth, photo, 3D glossy, rounded soft blob, rainbow,
busy background, drop shadow, different scale per frame, cropped edges
```

**Glyph discipline** — `needs_permission` and `error` may carry a *symbol* (lock, alert tick) but **no letters, no words, no exclamation text**. Models tend to render literal words ("KEY", "ERROR", "!") — add "simple geometric glyph only, no letters, no words, no text characters" to those two prompts.

**Consistency requirement** — generate all 7 frames in **one** sheet request when the model supports it, so scale, lighting, and silhouette stay identical across states. If generating one at a time, lock the seed and only change the state clause.

---

## Naming & manifest

Use stable, lowercase, hyphenated names so integration relies on filenames, not on this doc's prose:

```
docs/images/brand/
  key-art-16x9.png
  key-art-1x1.png
  key-art-21x9.png            # optional
  wordmark.png
  wordmark-on-void.png
src/assets/brand/
  logo-glyph.svg              # final = vector
  logo-glyph-silhouette.svg   # no-glow 1-bit
  operator-base.png           # cyan master
  operator-backend-claude.png # …-codex, -gemini, -opencode, -pi, -droid, -cursor, -junie, -omp
  status-sheet-7x1.png
  status-starting.png         # …-idle, -busy, -needs-permission, -awaiting-peer, -error, -stopped
```

Ship a `manifest.json` alongside the sprites so engineering has machine-readable metadata:

```json
{
  "statusOrder": ["starting","idle","busy","needs_permission","awaiting_peer","error","stopped"],
  "cellSize": 256,
  "sheetLayout": "7x1",
  "background": "transparent",
  "deliveryMode": "alpha-mask",
  "backends": ["claude","codex","gemini","opencode","pi","droid","cursor","junie","omp"]
}
```

## Output & delivery checklist

For the generating agent to return:

- [ ] Theme key art — 16:9 + 1:1 (+ optional 21:9), filled background.
- [ ] Logo glyph — `1024×1024` transparent + 1-bit tiny-size silhouette.
- [ ] Wordmark — `2400×600` transparent + on `#060a12`.
- [ ] Character base (cyan) — portrait + head crop, transparent.
- [ ] Character family — 9 per-backend recolors, identical silhouette.
- [ ] Sprite sheet — 7 status states, `256×256` cells, transparent, + standalone PNGs + `manifest.json`.
- [ ] Every asset passes the **Brand Lock** check (geometry, glow stack, mono type, palette).

Use the names/paths in **Naming & manifest** above. Confirm with the maintainer before committing binaries to the repo.

---

## Model-specific tips

- **Midjourney** — append `--ar 16:9 --style raw --no text` etc.; negative prompts go in `--no`. Use `--seed` to lock the character/sprite family.
- **DALL·E / GPT image / Nano Banana** — no negative-prompt field; fold the "no …" clauses into the sentence ("…with no rounded corners, no faces, no text"). Strong at following the per-lane recolor instruction in plain language.
- **Stable Diffusion / Flux** — use the Negative block as the negative prompt; add quality tags ("clean vector, crisp edges, high detail glow"). For the sprite sheet, a tile/grid LoRA or `tiling`-style prompt helps keep cells aligned.
- For transparent output, ask explicitly for "transparent background (PNG alpha)"; if the model only fills, request `#060a12` flat fill and key it out afterward.
