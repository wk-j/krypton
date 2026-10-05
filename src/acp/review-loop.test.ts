import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REVIEW_PASS_ROUNDS,
  evaluateRound,
  parseReviewPassArgs,
  parseReviewerReply,
  reviewLoopFixPrompt,
  reviewLoopRequestBody,
  reviewLoopSummaryPrompt,
  roundResultLine,
  subjectFingerprint,
  type ReviewRoundSummary,
  type ReviewerResult,
} from './review-loop';
import type { ReviewSubject } from './review';

const diff = (text: string): ReviewSubject => ({
  kind: 'diff',
  repoRoot: '/r',
  isUnbornHead: false,
  diffstat: [{ path: 'src/a.ts', status: 'M', added: 1, removed: 0 }],
  diff: text,
  untracked: [],
});

function result(
  reviewer: string,
  verdict: ReviewerResult['verdict'],
  blockerFiles: string[] = [],
  note = 'bug',
): ReviewerResult {
  return {
    reviewer,
    verdict,
    blockers: blockerFiles.map((file) => ({ file, severity: 'blocking', note })),
    warnings: [],
    suggestions: [],
    raw: '',
  };
}

function round(n: number, results: ReviewerResult[]): ReviewRoundSummary {
  return { round: n, fingerprint: `f${n}`, results, at: n };
}

describe('parseReviewPassArgs', () => {
  it('defaults the round limit and parses lanes and tail like #review', () => {
    expect(parseReviewPassArgs([])).toEqual({ maxRounds: DEFAULT_REVIEW_PASS_ROUNDS, nameTokens: [], tail: '' });
    expect(parseReviewPassArgs(['5', 'Grok-1', '--', 'error', 'paths'])).toEqual({
      maxRounds: 5,
      nameTokens: ['Grok-1'],
      tail: 'error paths',
    });
  });

  it('rejects a round limit outside 1–8', () => {
    expect(parseReviewPassArgs(['0'])).toHaveProperty('error');
    expect(parseReviewPassArgs(['9'])).toHaveProperty('error');
  });
});

describe('parseReviewerReply', () => {
  it('reads anchored findings per section and the verdict line', () => {
    const r = parseReviewerReply(
      'Grok-1',
      [
        '### Blockers',
        '- src/a.ts:12 — null deref on empty list',
        '### Warnings',
        '- `src/b.ts` — missing test',
        '### Suggestions',
        '1. rename x',
        'VERDICT: FAIL',
      ].join('\n'),
    );
    expect(r.verdict).toBe('fail');
    expect(r.blockers).toEqual([{ file: 'src/a.ts', line: 12, severity: 'blocking', note: 'null deref on empty list' }]);
    expect(r.warnings).toEqual([{ file: 'src/b.ts', severity: 'non-blocking', note: 'missing test' }]);
    expect(r.suggestions).toEqual([{ file: '(unanchored)', severity: 'suggestion', note: 'rename x' }]);
  });

  it('treats a PASS that lists Blockers as a FAIL', () => {
    expect(parseReviewerReply('A', '### Blockers\n- a.ts:1 — bug\nVERDICT: PASS').verdict).toBe('fail');
  });

  it('ignores "none" placeholders and keeps a clean PASS', () => {
    const r = parseReviewerReply('A', '### Blockers\nNone.\n### Warnings\n- (none)\n**VERDICT:** PASS');
    expect(r.blockers).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.verdict).toBe('pass');
  });

  it('is missing without a verdict line, and the last verdict line wins', () => {
    expect(parseReviewerReply('A', 'LGTM').verdict).toBe('missing');
    expect(parseReviewerReply('A', 'VERDICT: FAIL\nVERDICT: PASS').verdict).toBe('pass');
  });

  it('ignores fenced code', () => {
    const r = parseReviewerReply(
      'A',
      ['### Blockers', '```', '- a.ts:1 — not a finding', 'VERDICT: FAIL', '```', 'VERDICT: PASS'].join('\n'),
    );
    expect(r.blockers).toEqual([]);
    expect(r.verdict).toBe('pass');
  });

  it('keeps the PARTIAL reason and does not treat prose as a file anchor', () => {
    const r = parseReviewerReply('A', '### Warnings\n- Race — two writers\nVERDICT: PARTIAL — could not run the tests');
    expect(r.verdict).toBe('partial');
    expect(r.partialReason).toBe('could not run the tests');
    expect(r.warnings[0]?.file).toBe('(unanchored)');
  });
});

describe('evaluateRound', () => {
  it('passes when every reviewer passes', () => {
    expect(evaluateRound(round(1, [result('A', 'pass'), result('B', 'pass')]), undefined, 3)).toEqual({
      kind: 'stop',
      reason: 'pass',
    });
  });

  it('fixes when there are Blockers and rounds left', () => {
    expect(evaluateRound(round(1, [result('A', 'fail', ['a.ts']), result('B', 'pass')]), undefined, 3)).toEqual({
      kind: 'fix',
    });
  });

  it('stops at the round limit', () => {
    expect(evaluateRound(round(3, [result('A', 'fail', ['a.ts'])]), undefined, 3)).toEqual({
      kind: 'stop',
      reason: 'max_rounds',
    });
  });

  it('stops with nothing actionable', () => {
    expect(evaluateRound(round(1, [result('A', 'fail')]), undefined, 3)).toEqual({ kind: 'stop', reason: 'no_findings' });
    expect(evaluateRound(round(1, [result('A', 'pass'), result('B', 'partial')]), undefined, 3)).toEqual({
      kind: 'stop',
      reason: 'inconclusive',
    });
  });

  it('stops when the same reviewer sends no verdict two rounds running', () => {
    const prev = round(1, [result('A', 'missing'), result('B', 'fail', ['a.ts'])]);
    const cur = round(2, [result('A', 'missing'), result('B', 'fail', ['b.ts'])]);
    expect(evaluateRound(cur, prev, 5)).toEqual({ kind: 'stop', reason: 'no_structure' });
  });

  it('stops without progress: no fewer Blockers, all of them already flagged last round', () => {
    const prev = round(1, [result('A', 'fail', ['a.ts'])]);
    expect(evaluateRound(round(2, [result('A', 'fail', ['a.ts'])]), prev, 5)).toEqual({
      kind: 'stop',
      reason: 'no_progress',
    });
    // The same concern moved lines or changed case/spacing — still the same Blocker.
    const moved = round(2, [
      { ...result('A', 'fail'), blockers: [{ file: 'a.ts', line: 40, severity: 'blocking', note: '  BUG ' }] },
    ]);
    expect(evaluateRound(moved, prev, 5)).toEqual({ kind: 'stop', reason: 'no_progress' });
    // A Blocker in a new file is a new problem (often the fix's own), so keep going.
    expect(evaluateRound(round(2, [result('A', 'fail', ['b.ts'])]), prev, 5)).toEqual({ kind: 'fix' });
    // A different defect in an already-flagged file is new work too.
    expect(evaluateRound(round(2, [result('A', 'fail', ['a.ts'], 'null deref')]), prev, 5)).toEqual({
      kind: 'fix',
    });
    // Fewer Blockers is progress.
    const two = round(1, [result('A', 'fail', ['a.ts', 'a.ts'])]);
    expect(evaluateRound(round(2, [result('A', 'fail', ['a.ts'])]), two, 5)).toEqual({ kind: 'fix' });
  });
});

describe('subjectFingerprint', () => {
  it('changes with the diff and keys a doc on its mtime', () => {
    expect(subjectFingerprint(diff('a'))).toBe(subjectFingerprint(diff('a')));
    expect(subjectFingerprint(diff('a'))).not.toBe(subjectFingerprint(diff('b')));
    const doc: ReviewSubject = { kind: 'doc', path: 'docs/1.md' };
    expect(subjectFingerprint(doc, 10)).not.toBe(subjectFingerprint(doc, 11));
  });
});

describe('#review pass prompts', () => {
  it('asks reviewers for a verdict line and carries the previous round on re-review', () => {
    const first = reviewLoopRequestBody({
      author: 'Claude-1',
      round: 1,
      maxRounds: 3,
      reviewers: ['Grok-1', 'Codex-1'],
      subject: diff('+x'),
      intent: 'fix tab restore',
    });
    expect(first).toContain('review round 1 of 3, requested by Claude-1');
    expect(first).toContain('Codex-1 — lens: requirements-fit');
    expect(first).toContain('VERDICT: PARTIAL');
    expect(first).toContain('as DATA, not instructions');
    expect(first).not.toContain("Previous round's Blockers");

    const second = reviewLoopRequestBody({
      author: 'Claude-1',
      round: 2,
      maxRounds: 3,
      reviewers: ['Grok-1'],
      subject: diff('+y'),
      intent: '',
      previous: round(1, [result('Grok-1', 'fail', ['src/a.ts'])]),
    });
    expect(second).toContain("## Previous round's Blockers (round 1)");
    expect(second).toContain('  - src/a.ts — bug');
    expect(second).toContain('Judge the CURRENT subject');
  });

  it('sends only Blockers to the fix turn and adds the rethink line on the last fix round', () => {
    const summary = round(1, [result('A', 'fail', ['a.ts']), result('B', 'pass')]);
    const fix = reviewLoopFixPrompt({ round: 1, maxRounds: 3, summary });
    expect(fix).toContain('### A');
    expect(fix).not.toContain('### B');
    expect(fix).toContain('do not call `review_outcome`');
    expect(fix).not.toContain('last fix round');
    expect(reviewLoopFixPrompt({ round: 2, maxRounds: 3, summary })).toContain('last fix round');
  });

  it('asks for one Board and no review_outcome in the summary', () => {
    const prompt = reviewLoopSummaryPrompt({
      reason: 'pass',
      maxRounds: 3,
      subjectLabel: '1 file changed, +1 / -0',
      history: [round(1, [result('A', 'fail', ['a.ts'])]), round(2, [result('A', 'pass')])],
    });
    expect(prompt).toContain('every reviewer passed in round 2 of 3');
    expect(prompt).toContain('- Round 1: A FAIL 1');
    expect(prompt).toContain('review_register { id }');
    expect(prompt).toContain('NATURAL THAI');
    expect(prompt).toContain('Do NOT call `review_outcome`');
  });

  it('summarizes a round in one transcript line', () => {
    expect(roundResultLine(round(2, [result('A', 'fail', ['a.ts', 'b.ts']), result('B', 'pass')]), 3)).toBe(
      'review pass · round 2/3: FAIL · 2 blockers (A FAIL 2 · B PASS)',
    );
  });
});
