// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';

import { grepColumn, highlightRanges } from './quick-file-search';

function marked(nodes: Node[]): string[] {
  return nodes
    .filter((node) => node instanceof HTMLElement && node.tagName === 'MARK')
    .map((node) => node.textContent ?? '');
}

function joined(nodes: Node[]): string {
  return nodes.map((node) => node.textContent ?? '').join('');
}

// fff-search reports grep match spans as UTF-8 byte offsets into the line.
describe('highlightRanges', () => {
  it('marks the matched word after Thai text', () => {
    const line = 'ค้นหา palette'; // ค้นหา: 5 code points × 3 bytes, then a space → "palette" is bytes 16..23
    const nodes = highlightRanges(line, [[16, 23]]);
    expect(marked(nodes)).toEqual(['palette']);
    expect(joined(nodes)).toBe(line);
  });

  it('marks a Thai match inside ASCII', () => {
    const line = 'const q = "ค้นหา";'; // `const q = "` is 11 bytes; ค้นหา is 15
    const nodes = highlightRanges(line, [[11, 26]]);
    expect(marked(nodes)).toEqual(['ค้นหา']);
    expect(joined(nodes)).toBe(line);
  });

  it('counts a 4-byte emoji as one code point', () => {
    const line = '🚀 go go'; // 🚀 is 4 bytes, 2 UTF-16 units
    const nodes = highlightRanges(line, [[5, 7], [8, 10]]);
    expect(marked(nodes)).toEqual(['go', 'go']);
    expect(joined(nodes)).toBe(line);
  });

  it('clamps a span that runs past a truncated line', () => {
    const line = 'ค้นหา palette';
    const nodes = highlightRanges(line, [[16, 400]]);
    expect(marked(nodes)).toEqual(['palette']);
    expect(joined(nodes)).toBe(line);
  });
});

// `hx path:line:col` counts 1-based graphemes; fff-search reports a 0-based byte column.
describe('grepColumn', () => {
  it('counts a Thai consonant with its tone mark as one column', () => {
    // ค้ (consonant + tone mark), น, ห, า, space → "palette" starts at grapheme 6
    expect(grepColumn('ค้นหา palette', 16)).toBe(6);
  });

  it('keeps ASCII columns as byte + 1', () => {
    expect(grepColumn('let x = "q"', 9)).toBe(10);
  });

  it('adds the bytes past a truncated line one column each', () => {
    expect(grepColumn('abc', 10)).toBe(11);
  });
});
