import { describe, expect, it } from 'vitest';

import { headStateLine } from './format';
import type { RailsSnapshot } from './types';

// Spec 345: the Rails dock head shows one state line, the first rule that applies.

const SNAPSHOT: RailsSnapshot = {
  present: true,
  manifestPath: '/repo/.krypton/rails.toml',
  trust: 'changed',
  checks: [
    { name: 'typecheck', argv: ['npx', 'tsc'], timeoutS: 300 },
    { name: 'arch', argv: ['npx', 'vitest'], timeoutS: 300 },
  ],
  rules: [{ id: 'docs/adr/0001-x.md#1', source: 'docs/adr/0001-x.md', appliesTo: [], check: null, text: 'a' }],
  glossary: [],
  uncoveredSources: [],
  warnings: ['check `lint` is never referenced'],
  error: null,
};

describe('headStateLine', () => {
  it('puts a run in progress first, then an error, then trust', () => {
    const checking = { kind: 'checking', index: 2, total: 2, name: 'arch' } as const;
    expect(headStateLine({ ...SNAPSHOT, error: 'bad toml' }, checking)).toEqual({ text: 'check 2/2 arch', tone: 'accent' });
    expect(headStateLine({ ...SNAPSHOT, error: 'bad toml' }, { kind: 'paused' })).toEqual({ text: 'bad toml', tone: 'ink' });
    expect(headStateLine(SNAPSHOT, { kind: 'error', message: 'judge died' })).toEqual({ text: 'judge died', tone: 'ink' });
  });

  it('names the trust state with the number of waiting checks, or auto runs when there are none', () => {
    expect(headStateLine(SNAPSHOT, { kind: 'paused' })?.text).toBe('changed since trust · 2 checks wait');
    const one = { ...SNAPSHOT, trust: 'untrusted' as const, checks: SNAPSHOT.checks.slice(0, 1) };
    expect(headStateLine(one, { kind: 'idle' })?.text).toBe('not trusted · 1 check waits');
    expect(headStateLine({ ...one, checks: [] }, { kind: 'idle' })?.text).toBe('not trusted · auto runs wait');
  });

  it('falls through to the other progress lines, then the empty-manifest hint, then warnings', () => {
    const trusted = { ...SNAPSHOT, trust: 'trusted' as const };
    expect(headStateLine(trusted, { kind: 'held', until: Date.parse('2026-10-29T07:05:00Z') })?.text)
      .toMatch(/^auto run held until \d\d:\d\d · min interval$/);
    expect(headStateLine(trusted, { kind: 'idle' })).toEqual({ text: '1 manifest warning', tone: 'ink' });
    // An empty manifest shows the init hint even while untrusted: there is nothing to trust yet.
    const empty = { ...SNAPSHOT, rules: [], checks: [], trust: 'untrusted' as const };
    expect(headStateLine(empty, { kind: 'idle' })).toEqual({ text: 'no rails yet · #rails init', tone: 'ink' });
    expect(headStateLine({ ...trusted, warnings: [] }, { kind: 'idle' })).toBeNull();
  });
});
