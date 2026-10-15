// Spec 302 §1.3 — `Meter`.
//
// The four proportion readouts the harness paints: the process-table CPU/RSS
// cell, the thought-effort glyph strip, the `#usage` cache-hit track, and the
// `git diff --stat` bar. Four builders with three different percentage
// conventions become one component with one convention: `fraction()` below
// clamps `value / max` into `0..1`, and each mode formats it the way its
// surface already renders it — `toFixed(0)` + `%` for the track, a raw ratio
// for `flex-grow`, an unrounded `%` for the two diffstat custom properties.
// Every emitted value stays byte-identical to the builder it replaces.
//
// **Owns no block.** Each of the four class prefixes belongs to the surface
// that will own it (process table, thought row, usage card, tool row), so
// `blocks` is empty and this directory ships no stylesheet. Unlike `Chip`, the
// prefix is NOT a caller-supplied `block` prop: it is a constant per mode,
// because the mode also decides the root tag, the child structure and the
// style channel. The mode is therefore fixed at construction — `new
// Meter('track')` — and `MeterProps.mode` is the discriminant that types the
// rest of the payload. Updating a meter with a different mode throws rather
// than silently repainting a cache track as a CPU cell.

import { Component } from '../../../ui/component';
import { classes, el } from '../../../ui/dom';
import type { ComponentDef } from '../types';

export type MeterMode = 'track' | 'glyph' | 'segments' | 'diffstat';

/** Process-table CPU/RSS cell. `valueText` is the formatted readout (`12.4%`,
 *  `843M`); `value`/`max` drive the fill width only. */
export interface MeterTrackProps {
  readonly mode: 'track';
  readonly tone: 'cpu' | 'rss';
  readonly value: number;
  readonly max: number;
  readonly valueText: string;
}

/** Thought-effort strip. `value` is the thought's character length; the
 *  log-scaled floor/ceiling and the five tier words are the component's own
 *  scale, the way `Spinner` owns its frames. */
export interface MeterGlyphProps {
  readonly mode: 'glyph';
  readonly value: number;
}

export interface MeterSegment {
  /** Appends `acp-harness__usage-cache-segment--<tone>`. */
  readonly tone: string;
  readonly value: number;
}

/** `#usage` cache track. The denominator is the sum of the segments, so a
 *  caller never computes a total; non-positive segments are dropped. */
export interface MeterSegmentsProps {
  readonly mode: 'segments';
  readonly segments: readonly MeterSegment[];
}

/** `git diff --stat` bar. `value` is the `+` mark count, `minus` the `-` mark
 *  count, `max` the widest change count in the row set. */
export interface MeterDiffstatProps {
  readonly mode: 'diffstat';
  readonly value: number;
  readonly minus: number;
  readonly max: number;
}

export type MeterProps =
  | MeterTrackProps
  | MeterGlyphProps
  | MeterSegmentsProps
  | MeterDiffstatProps;

const BLOCK: Readonly<Record<MeterMode, string>> = {
  track: 'acp-harness__metrics-meter',
  glyph: 'acp-harness__thought-effort',
  segments: 'acp-harness__usage-cache-track',
  diffstat: 'acp-harness__tool-stat-bar',
};

/** Child of the cache track; its own class stem, not a suffix of the track's. */
const SEGMENT_CLASS = 'acp-harness__usage-cache-segment';

// Thought effort is length-derived: log-scaled between a floor (~one short
// line) and a ceiling (~a long deliberation), bucketed to 5.
const EFFORT_MIN_CHARS = 40;
const EFFORT_MAX_CHARS = 4000;
const EFFORT_CELLS = 5;

/** The one percentage convention: `value / max`, clamped to `0..1`, `0` for a
 *  non-finite input or a non-positive `max` (`metricPercent`'s contract). */
function fraction(value: number, max: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return 0;
  return Math.max(0, Math.min(1, value / max));
}

function effortLevel(len: number): { filled: number; tier: string } {
  let ratio = 0;
  if (len > EFFORT_MIN_CHARS) {
    ratio = Math.log(len / EFFORT_MIN_CHARS) / Math.log(EFFORT_MAX_CHARS / EFFORT_MIN_CHARS);
    ratio = Math.max(0, Math.min(1, ratio));
  }
  const filled = Math.max(1, Math.round(ratio * EFFORT_CELLS));
  const tier =
    ratio < 0.2
      ? 'brief'
      : ratio < 0.45
        ? 'considered'
        : ratio < 0.7
          ? 'deep'
          : ratio < 0.9
            ? 'extended'
            : 'exhaustive';
  return { filled, tier };
}

function modeError(built: MeterMode, got: MeterMode): Error {
  return new Error(
    `[ui] Meter was constructed for mode '${built}' and cannot repaint as '${got}' — ` +
      'the root tag, class prefix and child structure differ per mode. Construct a new Meter.',
  );
}

function createRoot(mode: MeterMode): HTMLElement {
  if (mode === 'segments') {
    // `aria-hidden` after `class`, as the builder emits it.
    return el('div', { class: BLOCK.segments, attrs: { 'aria-hidden': 'true' } });
  }
  return el('span', { class: BLOCK[mode] });
}

type Painter = (next: MeterProps) => void;

/** Build `mode`'s stable children into `root` and return the painter that owns
 *  them. The closure is how a child node keeps its identity across paints
 *  without a nullable field per mode. */
function createPainter(mode: MeterMode, root: HTMLElement): Painter {
  switch (mode) {
    case 'track': {
      const valueEl = el('span', { class: `${BLOCK.track}-value` });
      const fillEl = el('span', { class: `${BLOCK.track}-fill` });
      root.append(valueEl, el('span', { class: `${BLOCK.track}-track` }, fillEl));
      return (next: MeterProps): void => {
        if (next.mode !== 'track') throw modeError(mode, next.mode);
        valueEl.textContent = next.valueText;
        // The builder writes the attribute, not the CSSOM property, so the
        // serialised form stays `width:12%`.
        fillEl.setAttribute('style', `width:${(fraction(next.value, next.max) * 100).toFixed(0)}%`);
      };
    }
    case 'glyph': {
      const glyphEl = el('span', { class: `${BLOCK.glyph}-glyph` });
      const tierEl = el('span', { class: `${BLOCK.glyph}-tier` });
      root.append(glyphEl, tierEl);
      return (next: MeterProps): void => {
        if (next.mode !== 'glyph') throw modeError(mode, next.mode);
        const { filled, tier } = effortLevel(next.value);
        glyphEl.textContent = '▰'.repeat(filled) + '▱'.repeat(EFFORT_CELLS - filled);
        tierEl.textContent = tier;
      };
    }
    case 'segments':
      return (next: MeterProps): void => {
        if (next.mode !== 'segments') throw modeError(mode, next.mode);
        const total = next.segments.reduce((sum, segment) => sum + segment.value, 0);
        root.replaceChildren();
        for (const segment of next.segments) {
          if (segment.value <= 0 || total <= 0) continue;
          const node = el('span', {
            class: `${SEGMENT_CLASS} ${SEGMENT_CLASS}--${segment.tone}`,
          });
          node.style.flexGrow = String(fraction(segment.value, total));
          root.appendChild(node);
        }
      };
    case 'diffstat':
      return (next: MeterProps): void => {
        if (next.mode !== 'diffstat') throw modeError(mode, next.mode);
        root.style.setProperty('--stat-plus-width', `${fraction(next.value, next.max) * 100}%`);
        root.style.setProperty('--stat-minus-width', `${fraction(next.minus, next.max) * 100}%`);
      };
  }
}

export class Meter extends Component<MeterProps> {
  private readonly mode: MeterMode;
  private readonly painter: Painter;

  constructor(mode: MeterMode) {
    const root = createRoot(mode);
    super(root);
    this.mode = mode;
    this.painter = createPainter(mode, root);
  }

  protected readDeps(next: MeterProps): readonly unknown[] {
    switch (next.mode) {
      case 'track':
        // The rounded width, not the raw value: a CPU sample that moves inside
        // the same whole percent must not rewrite the cell.
        return ['track', next.tone, next.valueText, (fraction(next.value, next.max) * 100).toFixed(0)];
      case 'glyph': {
        const { filled, tier } = effortLevel(next.value);
        return ['glyph', filled, tier];
      }
      case 'segments':
        return ['segments', segmentSignature(next.segments)];
      case 'diffstat':
        return ['diffstat', fraction(next.value, next.max), fraction(next.minus, next.max)];
    }
  }

  /** Class is mode + tone only; the mode is an instance constant. */
  protected syncClasses(next: MeterProps): void {
    this.el.className = classes(
      BLOCK[this.mode],
      next.mode === 'track' ? `${BLOCK.track}--${next.tone}` : null,
    );
  }

  protected paint(next: MeterProps): void {
    this.syncClasses(next);
    this.painter(next);
  }
}

function segmentSignature(segments: readonly MeterSegment[]): string {
  const total = segments.reduce((sum, segment) => sum + segment.value, 0);
  return segments.map((segment) => `${segment.tone}:${fraction(segment.value, total)}`).join('|');
}

export const def: ComponentDef = { id: 'meter', blocks: [] };
