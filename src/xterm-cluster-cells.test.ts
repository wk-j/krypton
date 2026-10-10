import { describe, expect, it } from 'vitest';

import { splitCellClusters } from './xterm-cluster-cells';

describe('splitCellClusters', () => {
  it('keeps stacked Thai marks on their base consonant, one unit per terminal cell', () => {
    expect(splitCellClusters('ที่นี่')).toEqual(['ที่', 'นี่']);
    expect(splitCellClusters('ตั้งแต่')).toEqual(['ตั้', 'ง', 'แ', 'ต่']);
  });

  it('treats SARA AM as its own spacing cell, matching xterm width 1', () => {
    expect(splitCellClusters('น้ำ')).toEqual(['น้', 'ำ']);
  });

  it('keeps surrogate pairs and Latin combining marks whole', () => {
    expect(splitCellClusters('e\u0301😀a')).toEqual(['e\u0301', '😀', 'a']);
  });

  it('starts a unit with a leading orphan mark instead of dropping it', () => {
    expect(splitCellClusters('\u0e48x')).toEqual(['\u0e48', 'x']);
  });
});
