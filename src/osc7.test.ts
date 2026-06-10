import { describe, expect, it } from 'vitest';

import { parseOsc7Sequences, trailingEscStart } from './osc7';

/** Build a raw byte chunk containing an OSC 7 cwd report. */
const osc7 = (path: string, hostname = '', terminator: 'bel' | 'st' = 'bel'): number[] => {
  const uri = `file://${hostname}${path}`;
  const bytes = [0x1b, 0x5d, 0x37, 0x3b, ...new TextEncoder().encode(uri)];
  if (terminator === 'bel') bytes.push(0x07);
  else bytes.push(0x1b, 0x5c); // ESC \
  return bytes;
};

describe('parseOsc7Sequences', () => {
  it('returns nothing for plain output', () => {
    expect(parseOsc7Sequences([...new TextEncoder().encode('hello world')])).toEqual([]);
  });

  it('parses a local cwd (empty hostname) terminated by BEL', () => {
    expect(parseOsc7Sequences(osc7('/Users/wk/Source/krypton'))).toEqual([
      { hostname: '', path: '/Users/wk/Source/krypton' },
    ]);
  });

  it('parses a remote cwd (hostname) terminated by ST', () => {
    expect(parseOsc7Sequences(osc7('/var/log', 'host', 'st'))).toEqual([
      { hostname: 'host', path: '/var/log' },
    ]);
  });

  it('percent-decodes the path', () => {
    expect(parseOsc7Sequences(osc7('/a%20b/c'))).toEqual([{ hostname: '', path: '/a b/c' }]);
  });

  it('returns every report in order for a multi-prompt chunk', () => {
    const chunk = [...osc7('/a'), ...new TextEncoder().encode(' noise '), ...osc7('/b')];
    expect(parseOsc7Sequences(chunk)).toEqual([
      { hostname: '', path: '/a' },
      { hostname: '', path: '/b' },
    ]);
  });

  it('ignores an unterminated sequence', () => {
    expect(parseOsc7Sequences([0x1b, 0x5d, 0x37, 0x3b, 0x66, 0x69])).toEqual([]);
  });

  it('ignores a malformed percent-escape instead of throwing', () => {
    // "%ZZ" is not valid percent-encoding — decodeURIComponent would throw.
    const bytes = [0x1b, 0x5d, 0x37, 0x3b, ...new TextEncoder().encode('file:///a%ZZ'), 0x07];
    expect(() => parseOsc7Sequences(bytes)).not.toThrow();
    expect(parseOsc7Sequences(bytes)).toEqual([]);
  });
});

describe('trailingEscStart', () => {
  const osc7 = (path: string): number[] => [
    0x1b, 0x5d, 0x37, 0x3b, ...new TextEncoder().encode(`file://${path}`), 0x07,
  ];

  it('returns -1 for a chunk with no escape', () => {
    expect(trailingEscStart([...new TextEncoder().encode('plain')])).toBe(-1);
  });

  it('returns -1 when the trailing sequence is terminated', () => {
    expect(trailingEscStart(osc7('/done'))).toBe(-1);
  });

  it('returns the index of an unterminated trailing OSC 7 start', () => {
    const chunk = [...new TextEncoder().encode('out'), 0x1b, 0x5d, 0x37, 0x3b, 0x66];
    expect(trailingEscStart(chunk)).toBe(3);
  });

  it('anchors on a bare trailing ESC (split mid-prefix)', () => {
    const chunk = [0x61, 0x1b];
    expect(trailingEscStart(chunk)).toBe(1);
  });
});
