---
name: pretext-reference
description: Reference for @chenglou/pretext text layout & measurement library. Load when creating text layouts, text animations, measuring text height without DOM, rendering text to canvas/SVG, or working with multiline text measurement.
---

# Pretext Reference

Local repo: `/Users/wk/Source/pretext`

Use this skill whenever doing text layout, text animation, measuring text dimensions without DOM reflow, rendering text to canvas/SVG, or anything touching `@chenglou/pretext`.

**Always read the local source — it is the ground truth. npm dist types can lag.**

---

## Overview

Pure JS/TS library for multiline text measurement & layout. Avoids DOM measurements (`getBoundingClientRect`, `offsetHeight`) that trigger layout reflow. Implements its own text measurement using the browser's font engine as ground truth.

```sh
npm install @chenglou/pretext
```

---

## Key files

- `src/layout.ts` — core library; `layout()` hot path, allocation-light
- `src/analysis.ts` — normalization, segmentation, glue rules, text-analysis phase for `prepare()`
- `src/measurement.ts` — canvas measurement runtime, segment metrics cache, emoji correction
- `src/line-break.ts` — internal line-walking core shared by rich layout APIs and line counter
- `src/bidi.ts` — simplified bidi metadata helper for the rich `prepareWithSegments()` path
- `pages/demos/bubbles.ts` — bubble shrinkwrap demo using rich non-materializing line-range walker
- `pages/demos/dynamic-layout.ts` — editorial spread with two-column flow, obstacle-aware title routing, live logo-driven reflow

---

## API — Use Case 1: Measure paragraph height without DOM

```ts
import { prepare, layout } from '@chenglou/pretext'

const prepared = prepare('AGI 春天到了. بدأت الرحلة 🚀‎', '16px Inter')
const { height, lineCount } = layout(prepared, maxWidth, 20)
```

- `prepare()` — one-time text analysis + measurement. Returns opaque handle. Don't rerun for same text/font.
- `layout()` — cheap hot path: pure arithmetic over cached widths. Rerun on resize.
- `{ whiteSpace: 'pre-wrap' }` option preserves spaces, `\t` tabs, `\n` hard breaks.

```ts
prepare(text: string, font: string, options?: { whiteSpace?: 'normal' | 'pre-wrap' }): PreparedText
layout(prepared: PreparedText, maxWidth: number, lineHeight: number): { height: number, lineCount: number }
```

---

## API — Use Case 2: Manual line layout

Use `prepareWithSegments` instead of `prepare`, then choose an API:

### layoutWithLines — all lines at fixed width

```ts
import { prepareWithSegments, layoutWithLines } from '@chenglou/pretext'

const prepared = prepareWithSegments('AGI 春天到了', '18px "Helvetica Neue"')
const { lines } = layoutWithLines(prepared, 320, 26)
for (let i = 0; i < lines.length; i++) ctx.fillText(lines[i].text, 0, i * 26)
```

### walkLineRanges — line widths/cursors without building strings

```ts
let maxW = 0
walkLineRanges(prepared, 320, line => { if (line.width > maxW) maxW = line.width })
// maxW = tightest container width (multiline shrink-wrap)
```

### layoutNextLine — variable width per line (text around obstacles)

```ts
let cursor = { segmentIndex: 0, graphemeIndex: 0 }
let y = 0
while (true) {
  const width = y < image.bottom ? columnWidth - image.width : columnWidth
  const line = layoutNextLine(prepared, cursor, width)
  if (line === null) break
  ctx.fillText(line.text, 0, y)
  cursor = line.end
  y += 26
}
```

### measureNaturalWidth — intrinsic width helper

```ts
measureNaturalWidth(prepared: PreparedTextWithSegments): number
```

---

## API — Inline Flow (experimental sidecar)

For mixed inline runs, atomic pills, and browser-like boundary whitespace collapse:

```ts
import { prepareInlineFlow, walkInlineFlowLines } from '@chenglou/pretext/inline-flow'

const prepared = prepareInlineFlow([
  { text: 'Ship ', font: '500 17px Inter' },
  { text: '@maya', font: '700 12px Inter', break: 'never', extraWidth: 22 },
  { text: "'s rich-note", font: '500 17px Inter' },
])

walkInlineFlowLines(prepared, 320, line => {
  // each fragment keeps its source item index, text slice, gapBefore, and cursors
})
```

Also: `layoutNextInlineFlowLine()`, `measureInlineFlow()`.

---

## Types

```ts
type LayoutLine = {
  text: string
  width: number
  start: LayoutCursor
  end: LayoutCursor
}

type LayoutLineRange = {
  width: number
  start: LayoutCursor
  end: LayoutCursor
}

type LayoutCursor = {
  segmentIndex: number
  graphemeIndex: number
}

type InlineFlowItem = {
  text: string
  font: string
  break?: 'normal' | 'never'
  extraWidth?: number
}

type InlineFlowFragment = {
  itemIndex: number
  text: string
  gapBefore: number
  occupiedWidth: number
  start: LayoutCursor
  end: LayoutCursor
}

type InlineFlowLine = {
  fragments: InlineFlowFragment[]
  width: number
  end: InlineFlowCursor
}
```

---

## Helpers

```ts
clearCache(): void  // release accumulated font/segment caches
setLocale(locale?: string): void  // retarget word segmenter, clears caches
```

---

## Caveats

- Targets: `white-space: normal`, `word-break: normal`, `overflow-wrap: break-word`, `line-break: auto`
- `system-ui` is unsafe for accuracy on macOS — use a named font
- Narrow widths can break inside words at grapheme boundaries
- `font` param uses canvas font shorthand format (e.g. `'16px Inter'`, `'bold 14px "Helvetica Neue"'`)
- Make sure `font` and `lineHeight` match your actual CSS declarations

---

## Common patterns for Krypton

### Measure text height for virtualization
```ts
const prepared = prepare(text, '14px "JetBrains Mono"')
const { height } = layout(prepared, containerWidth, 20)
```

### Shrink-wrap text to tightest width
```ts
const prepared = prepareWithSegments(text, font)
let maxW = 0
walkLineRanges(prepared, startWidth, line => { if (line.width > maxW) maxW = line.width })
```

### Text animation: lay out lines then animate individually
```ts
const prepared = prepareWithSegments(text, font)
const { lines } = layoutWithLines(prepared, width, lineHeight)
lines.forEach((line, i) => {
  // animate each line with delay, position at y = i * lineHeight
})
```

### Flow text around an obstacle
```ts
let cursor = { segmentIndex: 0, graphemeIndex: 0 }
let y = 0
while (true) {
  const w = getAvailableWidth(y, obstacles)
  const line = layoutNextLine(prepared, cursor, w)
  if (!line) break
  renderLine(line, y)
  cursor = line.end
  y += lineHeight
}
```
