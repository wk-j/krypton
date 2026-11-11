import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const railCss = readFileSync(join(here, 'lane-rail.css'), 'utf8');
const sharedCss = readFileSync(join(here, '../../../styles/harness-shared.css'), 'utf8');

/** The window's left frame must read the same from the titlebar down: a lit
 *  left bevel on the rail (and the command-centre strip under it) started at
 *  the titlebar seam and drew a step in the frame there. */
describe('LaneRail left edge', () => {
  it('lights only the rail top, not its left edge', () => {
    const rule = railCss.match(/\.acp-harness__rail\s*\{[^}]*\}/)?.[0] ?? '';
    expect(rule).toMatch(/box-shadow:\s*inset 0 1px 0 var\(--mat-bevel-hi\)/);
    expect(rule).not.toMatch(/inset 1px 0 0/);
  });

  it('gives the command-centre strip under the rail no left bevel either', () => {
    const rule = sharedCss.match(
      /\.acp-harness__body:has\(> \.acp-harness__dashboard > \.acp-harness__rail\) \+ \.acp-harness__command-center\s*\{[^}]*\}/,
    )?.[0] ?? '';
    expect(rule).toMatch(/box-shadow:\s*none/);
  });
});
