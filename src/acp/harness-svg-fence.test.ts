import { describe, expect, it } from 'vitest';

import { fenceSourceText, svgFrame, themeSvgSource, type SvgPalette } from './harness-svg-fence';
import { transcriptRenderSignature } from './harness-transcript-render';
import type { HarnessTranscriptItem, SvgFenceEntry } from './harness-view-types';

const PALETTE: SvgPalette = { fg: '#d8e8d8', accent: '#0cf', c1: '#f0f', success: 'rgb(0, 200, 80)' };

describe('themeSvgSource', () => {
  it('resolves palette names, then the var() fallback, then fg', () => {
    const out = themeSvgSource(
      '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="var(--accent)" stroke="var(--c1, red)"/>'
        + '<path fill="var(--warning, #fa0)"/><text fill="var(--nope)"/></svg>',
      PALETTE,
    );
    expect(out).toContain('fill="#0cf"');
    expect(out).toContain('stroke="#f0f"'); // palette wins over the fallback
    expect(out).toContain('fill="#fa0"'); // missing palette key → fallback
    expect(out).toContain('<text fill="#d8e8d8"/>'); // unknown name, no fallback → fg
  });

  it('keeps a fallback that itself contains parentheses', () => {
    const out = themeSvgSource('<svg><rect fill="var(--muted, rgb(1, 2, 3))"/></svg>', PALETTE);
    expect(out).toContain('fill="rgb(1, 2, 3)"');
  });

  it('does not resolve inherited object keys as palette names', () => {
    const out = themeSvgSource('<svg><rect fill="var(--constructor)"/></svg>', PALETTE);
    expect(out).toContain('fill="#d8e8d8"');
  });

  it('adds xmlns, color, fill and font-family to a bare root — <img> SVG without xmlns does not render', () => {
    const out = themeSvgSource('<svg viewBox="0 0 10 10"><circle r="4"/></svg>', PALETTE);
    const root = /<svg[^>]*>/.exec(out)?.[0] ?? '';
    expect(root).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(root).toContain('color="#d8e8d8"');
    expect(root).toContain('fill="#d8e8d8"'); // SVG's initial fill is black — invisible on dark themes
    expect(root).not.toContain('xmlns:xlink');
  });

  it('never overrides root attributes the author set, and adds xlink only when used', () => {
    const out = themeSvgSource(
      '<svg xmlns="http://www.w3.org/2000/svg" color="red" fill="none" font-family="serif"><use xlink:href="#a"/></svg>',
      PALETTE,
    );
    const root = /<svg[^>]*>/.exec(out)?.[0] ?? '';
    expect(root.match(/xmlns="/g)).toHaveLength(1);
    expect(root).toContain('color="red"');
    expect(root).toContain('fill="none"');
    expect(root).not.toContain('fill="#d8e8d8"');
    expect(root).toContain('xmlns:xlink="http://www.w3.org/1999/xlink"');
  });

  it('touches only the first <svg> tag, after a prolog', () => {
    const out = themeSvgSource('<?xml version="1.0"?>\n<svg><svg x="1"/></svg>', {});
    expect(out.match(/xmlns=/g)).toHaveLength(1);
    expect(out).toContain('color="currentColor"'); // empty palette: fg → currentColor
  });
});

describe('svgFrame', () => {
  it('reads the aspect ratio from viewBox and the intrinsic width when declared', () => {
    expect(svgFrame('<svg viewBox="0 0 640 200" width="320px">')).toEqual({ ratio: '640 / 200', width: 320 });
    expect(svgFrame('<svg viewBox="0,0,4,3">')).toEqual({ ratio: '4 / 3', width: null });
  });

  it('falls back to numeric width/height and ignores a degenerate viewBox', () => {
    expect(svgFrame('<svg viewBox="0 0 0 0" width="100" height="50">')).toEqual({ ratio: '100 / 50', width: 100 });
    expect(svgFrame('<svg width="100%" height="50">')).toEqual({ ratio: null, width: null });
    expect(svgFrame('<div>')).toEqual({ ratio: null, width: null });
  });
});

describe('fenceSourceText', () => {
  it('strips exactly one trailing newline (marked-highlight appends one)', () => {
    expect(fenceSourceText('<svg/>\n')).toBe('<svg/>');
    expect(fenceSourceText('<svg/>\n\n')).toBe('<svg/>\n');
    expect(fenceSourceText('<svg/>')).toBe('<svg/>');
  });
});

describe('transcriptRenderSignature — SVG cards', () => {
  const entry = (): SvgFenceEntry => ({ index: 0, hintLabel: null, showSource: false, source: '<svg/>' });

  it('keeps the signature when decoration adds default-state cards', () => {
    const item: HarnessTranscriptItem = { id: 'a1', kind: 'assistant', text: '```svg\n<svg/>\n```' };
    const before = transcriptRenderSignature(item, false);
    item.svgFences = [entry()];
    expect(transcriptRenderSignature(item, false)).toBe(before);
  });

  it('rebuilds the row when a card is labelled or toggled to source', () => {
    const fence = entry();
    const item: HarnessTranscriptItem = { id: 'a1', kind: 'assistant', text: 'x', svgFences: [fence] };
    const plain = transcriptRenderSignature(item, false);
    fence.hintLabel = 'a';
    const labelled = transcriptRenderSignature(item, false);
    expect(labelled).not.toBe(plain);
    fence.hintLabel = null;
    fence.showSource = true;
    expect(transcriptRenderSignature(item, false)).not.toBe(plain);
    expect(transcriptRenderSignature(item, false)).not.toBe(labelled);
  });
});
