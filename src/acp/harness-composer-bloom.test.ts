import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  COMPOSER_BLOOM_DEFAULT_MS,
  COMPOSER_BLOOM_DEFAULT_TRAIL,
  COMPOSER_BLOOM_STAGGER_MS,
  applyComposerBloomSettings,
  clampComposerBloomSettings,
  graphemeUnits,
  isVisibleComposerGlyph,
  planComposerBlooms,
} from './harness-composer-bloom';

describe('clampComposerBloomSettings', () => {
  it('uses the artifact defaults', () => {
    expect(clampComposerBloomSettings(undefined)).toEqual({
      enabled: true,
      durationMs: COMPOSER_BLOOM_DEFAULT_MS,
      trail: COMPOSER_BLOOM_DEFAULT_TRAIL,
    });
  });

  it('clamps speed and trail to the prototype ranges', () => {
    expect(clampComposerBloomSettings({
      enabled: false,
      durationMs: 20,
      trail: 40,
    })).toEqual({ enabled: false, durationMs: 180, trail: 12 });
    expect(clampComposerBloomSettings({ durationMs: 900, trail: 0 }))
      .toEqual({ enabled: true, durationMs: 700, trail: 1 });
  });
});

describe('applyComposerBloomSettings', () => {
  it('publishes live CSS variables and the enable flag', () => {
    const vars = new Map<string, string>();
    const root = {
      style: {
        setProperty(name: string, value: string): void {
          vars.set(name, value);
        },
      },
      dataset: {} as Record<string, string>,
    };
    const settings = applyComposerBloomSettings(root as unknown as HTMLElement, {
      enabled: false,
      durationMs: 480,
      trail: 3,
    });
    expect(settings).toEqual({ enabled: false, durationMs: 480, trail: 3 });
    expect(root.dataset.acpComposerBloom).toBe('off');
    expect(vars.get('--acp-composer-bloom-duration')).toBe('480ms');
    expect(vars.get('--acp-composer-bloom-trail')).toBe('3');
  });
});

describe('graphemeUnits', () => {
  it('keeps a combining Thai cluster as one unit when Segmenter exists', () => {
    const units = graphemeUnits('กำ');
    expect(units.join('')).toBe('กำ');
    if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
      expect(units).toHaveLength(1);
    }
  });
});

describe('isVisibleComposerGlyph', () => {
  it('skips space, newline, and empty units', () => {
    expect(isVisibleComposerGlyph('ก')).toBe(true);
    expect(isVisibleComposerGlyph(' ')).toBe(false);
    expect(isVisibleComposerGlyph('\n')).toBe(false);
    expect(isVisibleComposerGlyph('')).toBe(false);
  });
});

describe('planComposerBlooms', () => {
  it('spawns one letter afterimage per typed grapheme', () => {
    expect(planComposerBlooms('ก', 5)).toEqual([{ offset: 0, delayMs: 0, unit: 'ก' }]);
  });

  it('caps a paste to the trail and staggers like the prototype', () => {
    const inserted = 'abcdefghij';
    expect(planComposerBlooms(inserted, 4)).toEqual([
      { offset: 6, delayMs: 0, unit: 'g' },
      { offset: 7, delayMs: COMPOSER_BLOOM_STAGGER_MS, unit: 'h' },
      { offset: 8, delayMs: COMPOSER_BLOOM_STAGGER_MS * 2, unit: 'i' },
      { offset: 9, delayMs: COMPOSER_BLOOM_STAGGER_MS * 3, unit: 'j' },
    ]);
  });

  it('skips whitespace so a paste trail is letters, not empty flashes', () => {
    expect(planComposerBlooms('a \nb', 5)).toEqual([
      { offset: 0, delayMs: 0, unit: 'a' },
      { offset: 3, delayMs: COMPOSER_BLOOM_STAGGER_MS, unit: 'b' },
    ]);
  });

  it('ignores empty insertions', () => {
    expect(planComposerBlooms('', 5)).toEqual([]);
    expect(planComposerBlooms('\n', 5)).toEqual([]);
  });
});

describe('spawnComposerBlooms source', () => {
  it('paints the inserted grapheme at the Range origin, not an ellipse offset', () => {
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'harness-composer-bloom.ts'),
      'utf8',
    );
    expect(src).toContain('particle.textContent = plan.unit');
    expect(src).toContain('rectAtTextIndex(pieces, insertedStart + plan.offset, plan.unit.length)');
    expect(src).toContain('rect.left - inputRect.left');
    expect(src).toContain('rect.top - inputRect.top');
    expect(src).not.toContain('inputRect.left - 7');
    expect(src).not.toContain('inputRect.top + 2');
    expect(src).not.toContain('range.collapse(true)');
  });
});
