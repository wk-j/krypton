import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

import {
  cachedSvgFontFaces,
  clearSvgFontFacesCache,
  embedSvgFontFaces,
  fontStackFamilies,
  loadSvgFontFaces,
} from './harness-svg-fonts';

beforeEach(() => {
  clearSvgFontFacesCache();
  invokeMock.mockReset();
});

describe('fontStackFamilies', () => {
  it('reads quoted and bare names in order, dropping bare generic keywords and repeats', () => {
    expect(fontStackFamilies(`'Share Tech Mono', "Bai Jamjuree", Fira  Code, 'Share Tech Mono', ui-monospace, monospace`))
      .toEqual(['Share Tech Mono', 'Bai Jamjuree', 'Fira Code']);
  });

  it('keeps commas and escaped quotes inside a quoted name, and a quoted generic as a real family', () => {
    expect(fontStackFamilies(`"Odd, \\"Name\\"", 'monospace'`)).toEqual(['Odd, "Name"', 'monospace']);
  });
});

describe('embedSvgFontFaces', () => {
  it('puts the rules first inside the root, XML-escaped', () => {
    const out = embedSvgFontFaces('<?xml version="1.0"?><svg viewBox="0 0 1 1"><text>x</text></svg>', '@font-face{font-family:"A&B<C"}');
    expect(out).toBe('<?xml version="1.0"?><svg viewBox="0 0 1 1"><style>@font-face{font-family:"A&amp;B&lt;C"}</style><text>x</text></svg>');
  });

  it('leaves a self-closing root alone', () => {
    expect(embedSvgFontFaces('<svg/>', '@font-face{}')).toBe('<svg/>');
  });
});

describe('loadSvgFontFaces', () => {
  it('asks once per stack and non-ASCII character set, then serves the cache', async () => {
    invokeMock.mockResolvedValue([{ family: 'Share "Tech"', data: 'AAAA' }]);
    const stack = `'Share "Tech"', monospace`;
    const css = await loadSvgFontFaces('<svg><text>ก ข</text></svg>', stack);
    expect(css).toBe('@font-face{font-family:"Share \\"Tech\\"";src:url(data:font/ttf;base64,AAAA)}');
    expect(invokeMock).toHaveBeenCalledWith('svg_font_faces', { families: ['Share "Tech"'], text: 'กข' });
    // Same characters in another figure (ASCII differs): cache hit.
    expect(cachedSvgFontFaces('<svg><text>ข hello ก</text></svg>', stack)).toBe(css);
    // A new non-ASCII character is a new request.
    expect(cachedSvgFontFaces('<svg><text>ค</text></svg>', stack)).toBeUndefined();
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it('never calls the backend for a stack of generic families only', async () => {
    expect(await loadSvgFontFaces('<svg/>', 'ui-monospace, monospace')).toBe('');
    expect(cachedSvgFontFaces('<svg/>', 'ui-monospace, monospace')).toBe('');
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('degrades to no embedded faces when the backend fails', async () => {
    invokeMock.mockRejectedValue(new Error('boom'));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await loadSvgFontFaces('<svg/>', `'X'`)).toBe('');
  });
});
