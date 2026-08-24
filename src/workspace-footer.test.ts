import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { parseHint } from './workspace-footer';

const css = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'styles/workspace-footer.css'),
  'utf8',
);

describe('parseHint', () => {
  it('wraps leading keys on the harness hint', () => {
    expect(parseHint('Cmd+P lanes · #cancel running')).toEqual([
      { key: 'Cmd+P', rest: 'lanes' },
      { key: '#cancel', rest: 'running' },
    ]);
  });

  it('wraps compositor, overlay, and default hints', () => {
    expect(parseHint('n new · h/j/k/l focus · ? details')).toEqual([
      { key: 'n', rest: 'new' },
      { key: 'h/j/k/l', rest: 'focus' },
      { key: '?', rest: 'details' },
    ]);
    expect(parseHint('arrows adjust · Esc cancel')).toEqual([
      { key: 'arrows', rest: 'adjust' },
      { key: 'Esc', rest: 'cancel' },
    ]);
    expect(parseHint('Esc close')).toEqual([{ key: 'Esc', rest: 'close' }]);
    expect(parseHint('Cmd+Shift+M music')).toEqual([{ key: 'Cmd+Shift+M', rest: 'music' }]);
    expect(parseHint('Leader v select · Cmd+O files · Cmd+Shift+G git')).toEqual([
      { key: 'Leader', rest: 'v select' },
      { key: 'Cmd+O', rest: 'files' },
      { key: 'Cmd+Shift+G', rest: 'git' },
    ]);
  });

  it('leaves a part without a leading key as plain text', () => {
    expect(parseHint('no skills match')).toEqual([{ key: null, rest: 'no skills match' }]);
  });
});

describe('workspace footer kind palette CSS', () => {
  it('paints default type as phosphor and git as success', () => {
    expect(css).toMatch(
      /\.krypton-workspace-footer__segment\s*\{[\s\S]*?color:\s*rgba\(var\(--krypton-fg-rgb/,
    );
    expect(css).toMatch(
      /\.krypton-workspace-footer__segment--git\s*\{[\s\S]*?color:\s*rgba\(var\(--krypton-success-rgb/,
    );
    expect(css).not.toMatch(
      /\.krypton-workspace-footer__segment--git\s*\{[\s\S]*?text-shadow/,
    );
    expect(css).toMatch(
      /\.krypton-workspace-footer__segment--throughput\s*\{[\s\S]*?--krypton-window-accent-rgb/,
    );
    expect(css).toMatch(/\.krypton-workspace-footer__hint kbd\s*\{/);
  });
});
