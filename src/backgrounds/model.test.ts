import { describe, expect, it } from 'vitest';

import { ANCHORS, backgroundStyles, choice, DESKTOP, emptyState, itemFor, library, PRESETS, sameChoice, validChoice, validRule } from './model';

const id = 'a'.repeat(64);
const state = { ...emptyState(), assets: [{ id, name: 'A', imagePath: '/a.png', thumbnailPath: '/a-thumb.png', width: 1, height: 1, bytes: 1 }] };
describe('background model', () => {
  it('defaults to desktop with a disabled/null rule', () => {
    expect(emptyState().active).toEqual(DESKTOP);
    expect(emptyState().permissionRule).toEqual({ enabled: false, target: null });
    expect(PRESETS.map((p) => p.name)).toEqual(['Desktop / Transparent', 'Graphite', 'Midnight', 'Paper', 'Custom colour', 'Dusk', 'Ocean']);
    expect(library(state)).toHaveLength(8);
    for (const p of PRESETS) expect(validChoice(p.choice, state)).toBe(true);
  });
  it('validates strict content, numbers and owned asset membership', () => {
    expect(validChoice(choice({ kind: 'solid', color: '#abC123' }), state)).toBe(true);
    for (const color of ['red', '#abc', 'url(file:///etc/passwd)', '#123456;opacity:0', '#GGGGGG']) {
      expect(validChoice(choice({ kind: 'solid', color }), state)).toBe(false);
    }
    for (const opacity of [NaN, Infinity, -0.1, 1.01]) expect(validChoice({ ...DESKTOP, opacity }, state)).toBe(false);
    for (const dimming of [NaN, Infinity, -0.1, 0.91]) expect(validChoice({ ...DESKTOP, dimming }, state)).toBe(false);
    expect(validChoice(choice({ kind: 'image', assetId: id }), state)).toBe(true);
    expect(validChoice(choice({ kind: 'image', assetId: 'b'.repeat(64) }), state)).toBe(false);
    expect(validChoice(choice({ kind: 'gradient', from: '#000000', to: '#ffffff', angle: 135 }), state)).toBe(false);
    expect(validChoice(null, state)).toBe(false);
    expect(validRule({ enabled: true, target: null }, state)).toBe(false);
    expect(validRule({ enabled: false, target: null }, state)).toBe(true);
  });
  it('maps image sizing and every anchor without arbitrary CSS', () => {
    const image = choice({ kind: 'image', assetId: id });
    expect(image.dimming).toBe(0.2);
    for (const anchor of ANCHORS) expect(backgroundStyles({ ...image, anchor }, 'asset://image').backgroundPosition).toBe(anchor.replace('-', ' '));
    expect(backgroundStyles({ ...image, fit: 'stretch' }, 'asset://image').backgroundSize).toBe('100% 100%');
    expect(backgroundStyles({ ...image, fit: 'contain' }, 'asset://image').backgroundSize).toBe('contain');
    expect(backgroundStyles(DESKTOP).backgroundColor).toBe('transparent');
  });
  it('identifies saved sources independently from draft appearances', () => {
    const draft = { ...structuredClone(PRESETS[1].choice), opacity: 0.5 };
    expect(itemFor(draft, state)).toBe('graphite');
    expect(sameChoice(draft, state.active)).toBe(false);
    expect(itemFor(choice({ kind: 'solid', color: '#123456' }), state)).toBe('custom');
    expect(itemFor(choice({ kind: 'image', assetId: id }), state)).toBe(id);
    expect(itemFor(null, state)).toBeNull();
  });
});
