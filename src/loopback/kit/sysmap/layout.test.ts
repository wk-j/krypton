import { describe, expect, it } from 'vitest';

import e2e from './fixtures/layout-e2e.json';
import empty from './fixtures/layout-empty.json';
import focus from './fixtures/layout-focus.json';
import tb from './fixtures/layout-tb.json';
import tliOnline from './fixtures/layout-tli-online.json';
import { cells, layoutMap, pinKeyCellPath } from './layout';
import type { SystemMap, LayoutPin, MapDrawing } from './layout';

// The goldens were produced by valence's original Go `report.Layout` (copied
// unchanged into a scratch module and built for amd64, where Go never fuses
// a*b+c into one FMA, so its arithmetic is plain IEEE like JavaScript's).
// Each fixture holds the input in the TS shape, the drawing Go made for it,
// and Go's `pinKeyCell` path for each pin.

interface Fixture {
  readonly input: {
    readonly map: SystemMap;
    readonly pins: readonly LayoutPin[];
    readonly lit: readonly string[];
  };
  readonly expected: MapDrawing;
  readonly keyCells: readonly string[];
}

const fixtures: readonly (readonly [string, Fixture])[] = [
  ['tli-online (26 nodes, 3 groups, LR)', tliOnline as unknown as Fixture],
  ['focus (6 nodes of tli-online)', focus as unknown as Fixture],
  ['TB with back edges, refused edges, labels and every shape', tb as unknown as Fixture],
  ['empty map', empty as unknown as Fixture],
  ['e2e pins: group label, problems, key-only and truncated', e2e as unknown as Fixture],
];

function draw(f: Fixture): MapDrawing {
  return layoutMap(f.input.map, f.input.pins, new Set(f.input.lit));
}

describe('layoutMap matches the Go original', () => {
  for (const [name, f] of fixtures) {
    it(name, () => {
      const drawing = draw(f);
      expect(drawing).toStrictEqual(f.expected);
      expect(drawing.pins.map(pinKeyCellPath)).toEqual(f.keyCells);
    });
  }

  it('the goldens cover what they claim', () => {
    const t = tliOnline as unknown as Fixture;
    expect(t.expected.nodes).toHaveLength(26);
    expect(t.expected.groups.map((g) => g.id).sort()).toEqual(['core', 'dim', 'tli-api']);
    expect(t.expected.edges.some((e) => e.idle)).toBe(true);
    expect((focus as unknown as Fixture).expected.groups.map((g) => g.id).sort()).toEqual(['dim', 'tli-api']);

    const small = (tb as unknown as Fixture).expected;
    const kinds = new Set(small.edges.map((e) => e.kind));
    expect([...kinds].sort()).toEqual(['flow', 'refused', 'reply']);
    expect(new Set(small.nodes.map((n) => n.shape))).toEqual(new Set(['actor', 'gate', 'box', 'store']));
    // Replies close loops: they are routed around the nodes (a polyline), not as an S-curve.
    for (const e of small.edges.filter((x) => x.kind === 'reply')) expect(e.d).toContain(' Q');
    expect(small.edges.some((e) => e.labelBox !== null)).toBe(true);
    // A key-only pin (empty label) has its cell span the whole stadium.
    const keyOnly = small.pins.find((p) => p.texts.length === 1);
    expect(keyOnly?.keyW).toBe(keyOnly?.box.w);
    // A long label is cut to 28 runes ending in "…".
    const long = small.pins.find((p) => p.key === '3');
    expect([...(long?.texts[1].text ?? '')]).toHaveLength(28);
    expect(long?.texts[1].text.endsWith('…')).toBe(true);
  });
});

describe('layoutMap is deterministic', () => {
  it('gives the same drawing for the same input twice, and leaves the input alone', () => {
    for (const [, f] of fixtures) {
      const before = JSON.stringify(f.input);
      const a = draw(f);
      const b = draw(f);
      expect(b).toStrictEqual(a);
      expect(JSON.stringify(b)).toBe(JSON.stringify(a));
      expect(JSON.stringify(f.input)).toBe(before);
    }
  });
});

describe('text is measured in monospace cells, as Go cells() does', () => {
  // Every expected count here is what Go's cells() printed for the same string.
  it('counts wide scripts as two cells and combining marks as none', () => {
    expect(cells('ascii')).toBe(5);
    // Thai: the vowel and tone marks above and below a consonant are Mn.
    expect(cells('บันทึก')).toBe(4);
    expect(cells('ที่นี่')).toBe(2);
    // ー (U+30FC) is script Common, not Katakana, so Go counts it as one cell.
    expect(cells('注文キュー')).toBe(9);
    expect(cells('한글')).toBe(4);
    expect(cells('ひらがな')).toBe(8);
    expect(cells('ＡＢ')).toBe(4); // fullwidth forms
    expect(cells('￥')).toBe(2);
    expect(cells('🙂')).toBe(2);
    expect(cells('é')).toBe(1); // combining acute (Mn)
    expect(cells('a​b')).toBe(2); // zero-width space (Cf)
  });

  it('sizes a node and a pin by cells, not by UTF-16 length or code points', () => {
    const thai = 'บันทึกการตรวจสอบ'; // 16 code points, 2 of them marks
    const cjk = '注文キュー注文キュー';
    const map: SystemMap = {
      direction: 'LR',
      groups: [],
      nodes: [
        { id: 'thai', label: thai, group: null, shape: 'box', source: null },
        { id: 'cjk', label: cjk, group: null, shape: 'box', source: null },
      ],
      edges: [{ from: 'thai', to: 'cjk', label: null, kind: 'flow' }],
    };
    const pins: LayoutPin[] = [{ key: '1', at: 'thai', label: thai, status: 'x', title: 't' }];
    const d = layoutMap(map, pins, new Set(['thai', 'cjk']));
    expect(cells(thai)).toBe(14);
    expect(d.nodes[0].box.w).toBe(14 * 7.8 + 2 * 12);
    expect(cells(cjk)).toBe(18);
    expect(d.nodes[1].box.w).toBe(18 * 7.8 + 2 * 12);
    // The pin: pad, key (1 cell), key pad ×2, label (14 cells), pad.
    const keyW = 9 + 1 * 7.2 + 6;
    expect(d.pins[0].keyW).toBe(keyW);
    expect(d.pins[0].box.w).toBe(keyW + 6 + 14 * 7.2 + 9);
  });
});
