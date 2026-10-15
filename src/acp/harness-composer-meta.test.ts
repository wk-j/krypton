import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  buildBusySegments,
  textSegments,
  type BusyStatusInput,
} from './harness-composer-meta';

const busy = (over: Partial<BusyStatusInput> = {}): BusyStatusInput => ({
  verb: null,
  elapsed: '5:12',
  queued: 0,
  ...over,
});

describe('buildBusySegments', () => {
  it('orders verb, elapsed, queued', () => {
    const ids = buildBusySegments(busy({ verb: 'reviewing', queued: 2 })).map((s) => s.id);
    expect(ids).toEqual(['verb', 'elapsed', 'queued']);
  });

  // spec 221: an ordinary turn has no verb — the spinner, the accented chip and
  // the ticking clock beside it already say "busy".
  it('emits no verb segment for an ordinary turn', () => {
    expect(buildBusySegments(busy()).some((s) => s.id === 'verb')).toBe(false);
  });

  it('carries a custom command verb, which names the operation', () => {
    const [first] = buildBusySegments(busy({ verb: 'saving to wiki' }));
    expect(first).toEqual({ id: 'verb', text: 'saving to wiki' });
  });

  it('falls back to "running" rather than painting an empty chip', () => {
    expect(buildBusySegments(busy({ elapsed: null }))).toEqual([
      { id: 'verb', text: 'running' },
    ]);
  });

  it('omits absent segments entirely rather than rendering them empty', () => {
    const ids = buildBusySegments(busy({ verb: 'reviewing', elapsed: null, queued: 0 })).map(
      (s) => s.id,
    );
    expect(ids).toEqual(['verb']);
  });

  it('renders no queued segment at zero and a counted one above it', () => {
    expect(buildBusySegments(busy({ queued: 0 })).some((s) => s.id === 'queued')).toBe(false);
    expect(buildBusySegments(busy({ queued: 1 }))).toContainEqual({ id: 'queued', text: '1 queued' });
  });

  it('never emits an activity segment — that readout lives on the rail HUD', () => {
    const ids = buildBusySegments(busy({ verb: 'reviewing', queued: 2 })).map((s) => s.id);
    expect(ids).not.toContain('activity');
  });

  // spec 221: these lived in the chip until the lane head, the input line and the
  // window footer were found to print them already.
  it('never emits the lane name or a cancel hint', () => {
    const text = buildBusySegments(busy({ queued: 2 }))
      .map((s) => s.text)
      .join(' ');
    expect(text).not.toMatch(/cancel/i);
    expect(text).not.toMatch(/Claude/);
  });
});

describe('textSegments', () => {
  it('wraps a whole-chip message as one text segment', () => {
    expect(textSegments('memory: 3/3')).toEqual([{ id: 'text', text: 'memory: 3/3' }]);
  });
});

// Spec 301 phase 6 split `src/styles/acp-harness.css` into the component
// directories. Each read below follows the rule it asserts to the sheet that
// now declares it; `harnessSheets()` is for the negative assertions, which
// only hold if NO harness sheet carries the rule.
const here = dirname(fileURLToPath(import.meta.url));

function harnessSheets(): string {
  const dir = join(here, 'components');
  const parts = [readFileSync(join(here, '../styles/harness-shared.css'), 'utf8')];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    for (const file of readdirSync(join(dir, entry.name))) {
      if (file.endsWith('.css')) parts.push(readFileSync(join(dir, entry.name, file), 'utf8'));
    }
  }
  return parts.join('\n');
}

describe('composer prompt geometry', () => {
  it('keeps the prompt command-line square, not an 8px card', () => {
    const css = readFileSync(join(here, 'components/composer/composer.css'), 'utf8');
    const block = css.match(/\.acp-harness__composer\s*\{[^}]*\}/)?.[0] ?? '';
    expect(block).toMatch(/border-radius:\s*0/);
    expect(block).not.toMatch(/--krypton-border-radius/);
  });

  it('does not square the host window chrome while the harness tab is showing', () => {
    const css = harnessSheets();
    expect(css).not.toMatch(
      /\.krypton-window\[data-content-type=['"]acp_harness['"]\]\s*\{[^}]*border-radius:\s*0/,
    );
    expect(css).not.toMatch(
      /\.krypton-window:has\([^)]*acp-harness\)[^{]*\{[^}]*border-radius:\s*0/,
    );
  });
});

describe('composer input bloom', () => {
  // The bloom layer is shell chrome with no component owner — spec 301 keeps
  // it in the named shared sheet.
  const css = readFileSync(join(here, '../styles/harness-shared.css'), 'utf8');

  it('paints overlay letter copies, not a caret pseudo-element or ellipse boom', () => {
    expect(css).toContain('.acp-harness__composer-blooms');
    expect(css).toContain('.acp-harness__composer-bloom');
    expect(css).not.toContain('.acp-harness__caret--bloom');
    const particle = css.match(/\.acp-harness__composer-bloom\s*\{[^}]*\}/)?.[0] ?? '';
    expect(particle).toContain('pointer-events: none');
    expect(particle).toContain('font: inherit');
    expect(particle).toContain('text-shadow');
    expect(particle).toContain('rgba(110, 231, 231');
    expect(particle).not.toContain('26px');
    expect(particle).not.toContain('22px');
    expect(particle).not.toContain('radial-gradient');
    expect(particle).not.toContain('--acp-lane-accent');
  });

  it('ignites, drifts, and dissolves the letter without a scale boom or blur', () => {
    const keyframes = css.match(
      /@keyframes acp-harness-composer-bloom\s*\{([\s\S]*?)\n\}/,
    )?.[1] ?? '';
    expect(keyframes).toContain('opacity:');
    expect(keyframes).toContain('translate3d(0, -3px, 0)');
    expect(keyframes).not.toContain('scale(');
    expect(keyframes).not.toMatch(/filter|blur/);
    expect(css).toContain('will-change: opacity, transform');
  });

  it('drops afterimages under reduced motion and when the setting is off', () => {
    expect(css).toContain('html[data-acp-composer-bloom="off"] .acp-harness__composer-bloom');
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.acp-harness__composer-bloom/,
    );
  });
});

describe('lane picker chrome', () => {
  const css = readFileSync(join(here, 'components/lane-picker/lane-picker.css'), 'utf8');

  it('stacks the overlay as a column and paints one 8px panel', () => {
    const overlay = css.match(/\.acp-harness__picker\s*\{[^}]*\}/)?.[0] ?? '';
    const panel = css.match(/\.acp-harness__picker-panel\s*\{[^}]*\}/)?.[0] ?? '';
    expect(overlay).toMatch(/flex-direction:\s*column/);
    expect(panel).toMatch(/border-radius:\s*var\(--krypton-border-radius/);
    expect(panel).toMatch(/overflow:\s*hidden/);
  });

  it('does not round or stroke the header and list as separate capsules', () => {
    const head = css.match(/\.acp-harness__picker-head\s*\{[^}]*\}/)?.[0] ?? '';
    const list = css.match(/\.acp-harness__picker-list\s*\{[^}]*\}/)?.[0] ?? '';
    expect(head).not.toMatch(/border-radius/);
    expect(list).not.toMatch(/border-radius/);
    expect(head).not.toMatch(/^\s*border:/m);
    expect(list).not.toMatch(/^\s*border:/m);
  });
});
