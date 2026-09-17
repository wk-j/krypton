import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { pretextRowMatchesLines } from './harness-transcript-render';

describe('pretextRowMatchesLines', () => {
  it('matches when class and text already equal the layout cache', () => {
    const row = {
      children: [
        { className: 'acp-harness__pretext-line', textContent: 'one' },
        { className: 'acp-harness__pretext-line', textContent: 'two' },
      ],
    };
    expect(pretextRowMatchesLines(row, ['one', 'two'])).toBe(true);
  });

  it('misses when a line changed or the row is still a plain text node', () => {
    expect(pretextRowMatchesLines(
      { children: [{ className: 'acp-harness__pretext-line', textContent: 'one' }] },
      ['one', 'two'],
    )).toBe(false);
    expect(pretextRowMatchesLines(
      { children: [{ className: 'acp-harness__pretext-line', textContent: 'old' }] },
      ['one'],
    )).toBe(false);
    expect(pretextRowMatchesLines({ children: [] }, ['one'])).toBe(false);
  });
});

describe('#usage structured transcript row', () => {
  it('keeps a text fallback while rendering semantic, non-animated telemetry DOM', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const render = readFileSync(join(here, 'harness-transcript-render.ts'), 'utf8');
    const view = readFileSync(join(here, 'acp-harness-view.ts'), 'utf8');
    const css = readFileSync(join(here, '../styles/acp-harness.css'), 'utf8');

    expect(view).toMatch(
      /appendTranscript\(lane, 'system', `\[usage\] \$\{describeUsage\(rollup\)\}`\)[\s\S]{0,120}?item\.usage = rollup/,
    );
    expect(render).toMatch(/item\.kind === 'system' && item\.usage/);
    expect(render).toMatch(/card\.setAttribute\('aria-label', `Usage for \$\{summary\.date\}`\)/);
    expect(render).toMatch(/track\.setAttribute\('aria-hidden', 'true'\)/);
    expect(render).toMatch(/body\.replaceChildren\(card\)/);

    const cardRule = css.match(/\.acp-harness__usage-card\s*\{([\s\S]*?)\n\}/)?.[1];
    expect(cardRule).toContain('contain: content');
    expect(cardRule).toContain('border: 1px solid');
    expect(cardRule).not.toContain('border-left');
    expect(css).toContain('@container (max-width: 680px)');
    expect(css).toContain('@container (max-width: 420px)');
    expect(css).not.toMatch(/\.acp-harness__usage[^\{]*\{[^\}]*animation:/s);
  });
});
