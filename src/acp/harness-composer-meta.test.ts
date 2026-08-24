import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  buildBusySegments,
  renderStatusSegments,
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

describe('renderStatusSegments', () => {
  it('tags each segment so CSS can size it', () => {
    expect(
      renderStatusSegments(buildBusySegments(busy({ verb: 'reviewing' }))),
    ).toBe(
      '<span class="acp-harness__meta-seg" data-seg="verb">reviewing</span>' +
        '<span class="acp-harness__meta-seg" data-seg="elapsed">5:12</span>',
    );
  });

  it('emits no divider characters — dividers are CSS', () => {
    expect(renderStatusSegments(buildBusySegments(busy({ queued: 3 })))).not.toContain('·');
  });

  it('escapes segment text', () => {
    expect(renderStatusSegments(textSegments('<img src=x>'))).toContain('&lt;img src=x&gt;');
  });

  it('renders nothing for no segments', () => {
    expect(renderStatusSegments([])).toBe('');
  });
});

describe('composer prompt geometry', () => {
  it('keeps the prompt command-line square, not an 8px card', () => {
    const css = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../styles/acp-harness.css'),
      'utf8',
    );
    const block = css.match(/\.acp-harness__composer\s*\{[^}]*\}/)?.[0] ?? '';
    expect(block).toMatch(/border-radius:\s*0/);
    expect(block).not.toMatch(/--krypton-border-radius/);
  });
});
