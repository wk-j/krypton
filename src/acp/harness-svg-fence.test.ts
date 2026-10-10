import { describe, expect, it } from 'vitest';

import { fenceSourceText, svgBaseSize, svgFrame, themeSvgSource, type SvgPalette } from './harness-svg-fence';
import { transcriptRenderSignature } from './harness-transcript-render';
import type { HarnessTranscriptItem, SvgFenceEntry } from './harness-view-types';

const PALETTE: SvgPalette = { fg: '#d8e8d8', accent: '#0cf', c1: '#f0f', success: 'rgb(0, 200, 80)' };
const FONT = "'Mononoki Nerd Font Mono', 'Fira Code', monospace";

describe('themeSvgSource', () => {
  it('resolves palette names, then the var() fallback, then fg', () => {
    const out = themeSvgSource(
      '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="var(--accent)" stroke="var(--c1, red)"/>'
        + '<path fill="var(--warning, #fa0)"/><text fill="var(--nope)"/></svg>',
      PALETTE,
      FONT,
    );
    expect(out).toContain('fill="#0cf"');
    expect(out).toContain('stroke="#f0f"'); // palette wins over the fallback
    expect(out).toContain('fill="#fa0"'); // missing palette key → fallback
    expect(out).toContain('<text fill="#d8e8d8"/>'); // unknown name, no fallback → fg
  });

  it('keeps a fallback that itself contains parentheses', () => {
    const out = themeSvgSource('<svg><rect fill="var(--muted, rgb(1, 2, 3))"/></svg>', PALETTE, FONT);
    expect(out).toContain('fill="rgb(1, 2, 3)"');
  });

  it('does not resolve inherited object keys as palette names', () => {
    const out = themeSvgSource('<svg><rect fill="var(--constructor)"/></svg>', PALETTE, FONT);
    expect(out).toContain('fill="#d8e8d8"');
  });

  it('adds xmlns, color and fill to a bare root — <img> SVG without xmlns does not render', () => {
    const out = themeSvgSource('<svg viewBox="0 0 10 10"><circle r="4"/></svg>', PALETTE, FONT);
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
      FONT,
    );
    const root = /<svg[^>]*>/.exec(out)?.[0] ?? '';
    expect(root.match(/xmlns="/g)).toHaveLength(1);
    expect(root).toContain('color="red"');
    expect(root).toContain('fill="none"');
    expect(root).not.toContain('fill="#d8e8d8"');
    expect(root).toContain('xmlns:xlink="http://www.w3.org/1999/xlink"');
  });

  it('forces the harness font over author font-family attributes and inline styles', () => {
    const out = themeSvgSource(
      '<svg font-family="serif"><text style="font-family: Arial">a</text></svg>',
      PALETTE,
      FONT,
    );
    expect(out).toContain(`<style>*{font-family:${FONT}!important}</style>`);
    // The rule must sit inside the root, or it never applies.
    expect(out.indexOf('<style>')).toBeGreaterThan(out.indexOf('<svg'));
  });

  it('escapes XML-special characters in the font so the SVG still parses', () => {
    const out = themeSvgSource('<svg><text>a</text></svg>', PALETTE, "'A&B <Mono>', monospace");
    expect(out).toContain("font-family:'A&amp;B &lt;Mono>', monospace!important");
  });

  it('injects no style into a self-closing root', () => {
    const out = themeSvgSource('<svg viewBox="0 0 1 1"/>', PALETTE, FONT);
    expect(out).not.toContain('<style>');
  });

  it('touches only the first <svg> tag, after a prolog', () => {
    const out = themeSvgSource('<?xml version="1.0"?>\n<svg><svg x="1"/></svg>', {}, FONT);
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

describe('svgBaseSize', () => {
  it('prefers explicit width/height, then fills a missing side from the viewBox', () => {
    expect(svgBaseSize('<svg viewBox="0 0 900 640" width="450" height="100">')).toEqual({ width: 450, height: 100 });
    expect(svgBaseSize('<svg viewBox="0 0 900 600" width="300">')).toEqual({ width: 300, height: 200 });
    expect(svgBaseSize('<svg viewBox="0 0 900 600" height="300">')).toEqual({ width: 450, height: 300 });
    expect(svgBaseSize('<svg viewBox="0 0 900 640">')).toEqual({ width: 900, height: 640 });
  });

  it('falls back to the 300×150 replaced-element default without a usable size', () => {
    expect(svgBaseSize('<svg width="100%" height="100%">')).toEqual({ width: 300, height: 150 });
    expect(svgBaseSize('<svg width="120">')).toEqual({ width: 120, height: 150 });
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
