import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  fileURLToPath(new URL('./timeline-capture.ts', import.meta.url)),
  'utf8',
);

describe('TimelineCapture semantic topic contract', () => {
  it('keeps stale and cancelled responses from changing the form', () => {
    expect(source).toContain('generation !== this.semanticGeneration');
    expect(source).toContain('this.cancelSemanticRequest()');
    expect(source).toContain('this.disposed');
  });

  it('requires an explicit visible choice before save', () => {
    expect(source).toContain("this.semanticDecision === null");
    expect(source).toContain("useExisting.textContent = 'ใช้หัวข้อนี้'");
    expect(source).toContain("createNew.textContent = 'สร้างหัวข้อใหม่'");
  });

  it('retains silent fallback and keyboard-native buttons', () => {
    expect(source).toContain('TypeSafe is optional');
    expect(source).toContain("useExisting.type = 'button'");
    expect(source).toContain("createNew.type = 'button'");
  });
});
