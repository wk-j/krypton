import { describe, expect, it } from 'vitest';

import { closeSvgPrefix, fenceSourceText, svgBaseSize, svgFrame, themeSvgSource, type SvgPalette } from './harness-svg-fence';

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
  it('sizes the preview from an explicit width, else from viewBox units as px', () => {
    expect(svgFrame('<svg viewBox="0 0 640 200" width="320px">')).toEqual({ ratio: '640 / 200', width: 320 });
    expect(svgFrame('<svg viewBox="0 0 640 240">')).toEqual({ ratio: '640 / 240', width: 640 });
  });

  it('fits larger figures inside Full HD, keeping their aspect ratio', () => {
    expect(svgFrame('<svg viewBox="0 0 3840 2160">').width).toBe(1920);
    expect(svgFrame('<svg viewBox="0 0 1000 2160">').width).toBe(500); // height-bound
    expect(svgFrame('<svg viewBox="0 0 1920 1080">').width).toBe(1920);
  });

  it('measures the Full HD cap in device pixels', () => {
    expect(svgFrame('<svg viewBox="0 0 1920 1080">', 2).width).toBe(960);
    expect(svgFrame('<svg viewBox="0 0 640 240">', 2).width).toBe(640); // under the cap: own size
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

describe('closeSvgPrefix', () => {
  it('is null until the <svg> start tag is complete', () => {
    expect(closeSvgPrefix('')).toBeNull();
    expect(closeSvgPrefix('<?xml version="1.0"?>\n<!-- fig -->\n')).toBeNull();
    expect(closeSvgPrefix('<svg viewBox="0 0 10')).toBeNull();
    expect(closeSvgPrefix('<svg viewBox="0 0 10 10">')).toBe('<svg viewBox="0 0 10 10"></svg>');
  });

  it('cuts an unfinished tag and closes open elements innermost first', () => {
    expect(closeSvgPrefix('<svg><g fill="red"><rect width="2"/><circle cx="5'))
      .toBe('<svg><g fill="red"><rect width="2"/></g></svg>');
    expect(closeSvgPrefix('<svg><g><text x="1">Hel')).toBe('<svg><g><text x="1">Hel</text></g></svg>');
    expect(closeSvgPrefix('<svg><g></g><g></')).toBe('<svg><g></g><g></g></svg>');
  });

  it('drops a dangling entity but keeps a finished one', () => {
    expect(closeSvgPrefix('<svg><text>a &am')).toBe('<svg><text>a </text></svg>');
    expect(closeSvgPrefix('<svg><text>a &amp; b')).toBe('<svg><text>a &amp; b</text></svg>');
  });

  it('does not end a tag on a quoted > or inside comments and CDATA', () => {
    expect(closeSvgPrefix('<svg><text data-x="a>b')).toBe('<svg></svg>');
    expect(closeSvgPrefix('<svg><!-- <g> --><rect/>')).toBe('<svg><!-- <g> --><rect/></svg>');
    expect(closeSvgPrefix('<svg><style><![CDATA[ a > b')).toBe('<svg><style></style></svg>');
    expect(closeSvgPrefix('<svg><!-- open <g>')).toBe('<svg></svg>');
  });

  it('accepts a namespaced root and returns a complete document unchanged', () => {
    expect(closeSvgPrefix('<s:svg xmlns:s="http://www.w3.org/2000/svg"><s:g>'))
      .toBe('<s:svg xmlns:s="http://www.w3.org/2000/svg"><s:g></s:g></s:svg>');
    const done = '<svg viewBox="0 0 4 4"><g><rect width="1"/></g><text>x &lt; y</text></svg>\n';
    expect(closeSvgPrefix(done)).toBe(done);
  });
});
