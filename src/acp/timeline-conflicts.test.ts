import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  fileURLToPath(new URL('./timeline-conflicts.ts', import.meta.url)),
  'utf8',
);

describe('TimelineConflicts sheet contract (spec 266)', () => {
  it('requires a rationale before any write', () => {
    expect(source).toContain("return this.showError('กรุณาใส่เหตุผล')");
    expect(source).toContain("return this.showError('กรุณาใส่เหตุผลว่าทำไมคู่นี้ควรตรวจ')");
  });

  it('requires evidence for resolved', () => {
    expect(source).toContain("this.verdict === 'resolved' && !sourceRef && !resolutionEventId");
  });

  it('maps verdict keys and leaves typing in fields alone', () => {
    expect(source).toContain("'1': 'confirmed'");
    expect(source).toContain("'4': 'resolved'");
    expect(source).toContain('if (isTextField(event.target)');
  });

  it('never claims there are no conflicts when the scan is partial or never ran', () => {
    expect(source).toContain("scan.state === 'partial'");
    expect(source).toContain("scan.state === 'never_run'");
    expect(source).not.toContain('ไม่มีข้อขัดแย้ง');
  });

  it('renders file text with textContent only', () => {
    expect(source).not.toContain('innerHTML');
  });
});
