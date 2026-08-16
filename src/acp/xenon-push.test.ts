import { describe, expect, it } from 'vitest';

import {
  describePush,
  linkEvidenceFromPush,
  parsePushCommand,
  summarizePush,
  type PushReport,
} from './xenon-push';

function report(overrides: Partial<PushReport> = {}): PushReport {
  return {
    pushed: 0,
    unchanged: 0,
    blocked: 0,
    failed: 0,
    queued: 0,
    items: [],
    baseUrl: 'https://xenon.example.com',
    project: 'wk-j.krypton',
    ...overrides,
  };
}

describe('parsePushCommand', () => {
  it('treats a bare #push as "every configured kind"', () => {
    const result = parsePushCommand('#push');
    expect(result).toEqual({ ok: true, args: { kind: null, slug: null, force: false } });
  });

  it('accepts a kind and an optional slug', () => {
    expect(parsePushCommand('#push review')).toEqual({
      ok: true,
      args: { kind: 'review', slug: null, force: false },
    });
    expect(parsePushCommand('#push review 2026-08-07-peering-guard')).toEqual({
      ok: true,
      args: { kind: 'review', slug: '2026-08-07-peering-guard', force: false },
    });
  });

  it('accepts --force anywhere and keeps it out of the positionals', () => {
    expect(parsePushCommand('#push --force review')).toEqual({
      ok: true,
      args: { kind: 'review', slug: null, force: true },
    });
    expect(parsePushCommand('#push review my-slug -f')).toEqual({
      ok: true,
      args: { kind: 'review', slug: 'my-slug', force: true },
    });
    expect(parsePushCommand('#push -f')).toEqual({
      ok: true,
      args: { kind: null, slug: null, force: true },
    });
  });

  // spec 224: the kind list is duplicated in Rust, and this side validates
  // first — a missing entry here rejects the command before it is ever invoked.
  it('accepts the daily kind with a date as its slug', () => {
    expect(parsePushCommand('#push daily')).toEqual({
      ok: true,
      args: { kind: 'daily', slug: null, force: false },
    });
    expect(parsePushCommand('#push daily 2026-08-15')).toEqual({
      ok: true,
      args: { kind: 'daily', slug: '2026-08-15', force: false },
    });
  });

  it('rejects an unknown kind rather than silently pushing everything', () => {
    const result = parsePushCommand('#push reviews');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('unknown kind "reviews"');
  });

  it('rejects excess arguments', () => {
    const result = parsePushCommand('#push review a b');
    expect(result.ok).toBe(false);
  });

  it('tolerates ragged whitespace', () => {
    expect(parsePushCommand('  #push   review   my-slug  ')).toEqual({
      ok: true,
      args: { kind: 'review', slug: 'my-slug', force: false },
    });
  });

  it('refuses input that is not #push at all', () => {
    expect(parsePushCommand('#pull review').ok).toBe(false);
  });
});

describe('summarizePush', () => {
  it('says nothing to push instead of reporting zeroes', () => {
    expect(summarizePush(report())).toBe('nothing to push');
  });

  it('lists only the non-zero buckets', () => {
    const summary = summarizePush(
      report({
        pushed: 2,
        unchanged: 5,
        items: [{ kind: 'review', slug: 'a', title: 'A', state: 'pushed' }],
      }),
    );
    expect(summary).toBe('wk-j.krypton: 2 pushed · 5 unchanged');
    expect(summary).not.toContain('blocked');
  });
});

describe('describePush', () => {
  it('names every blocked item so a secret block is never silent', () => {
    const detail = describePush(
      report({
        blocked: 1,
        pushed: 1,
        items: [
          {
            kind: 'review',
            slug: '2026-08-07-x',
            title: 'X',
            state: 'blocked',
            reason: 'review.md line 12: looks like a GitHub token',
          },
          {
            kind: 'doc',
            slug: 'docs/212.md',
            title: 'Spec',
            state: 'pushed',
            url: 'https://xenon.example.com/r/wk-j.krypton/doc/docs/212.md',
          },
        ],
      }),
    );
    expect(detail).toContain('blocked  review/2026-08-07-x');
    expect(detail).toContain('looks like a GitHub token');
    expect(detail).toContain('https://xenon.example.com/r/wk-j.krypton/doc/docs/212.md');
  });

  it('marks a retryable failure as queued', () => {
    const detail = describePush(
      report({
        failed: 1,
        queued: 1,
        items: [
          {
            kind: 'review',
            slug: 'a',
            title: 'A',
            state: 'failed',
            reason: 'connect: timed out',
            retryable: true,
          },
        ],
      }),
    );
    expect(detail).toContain('(queued for retry)');
  });

  it('does not claim a retry for a non-retryable failure', () => {
    const detail = describePush(
      report({
        failed: 1,
        items: [
          {
            kind: 'review',
            slug: 'a',
            title: 'A',
            state: 'failed',
            reason: 'invalid_token - check your token',
            retryable: false,
          },
        ],
      }),
    );
    expect(detail).not.toContain('queued for retry');
    expect(detail).toContain('invalid_token');
  });

  it('says everything is up to date when nothing changed', () => {
    const detail = describePush(
      report({
        unchanged: 3,
        items: [{ kind: 'review', slug: 'a', title: 'A', state: 'unchanged' }],
      }),
    );
    expect(detail).toContain('everything already up to date');
  });
});

describe('linkEvidenceFromPush', () => {
  it('proves the link is up when anything reached the server', () => {
    expect(
      linkEvidenceFromPush(
        report({
          pushed: 1,
          items: [{ kind: 'review', slug: 'a', title: 'A', state: 'pushed', url: 'u' }],
        }),
      ),
    ).toEqual({
      baseUrl: 'https://xenon.example.com',
      project: 'wk-j.krypton',
      reachedServer: true,
      unauthorized: false,
      detail: null,
    });
  });

  it('reads a non-retryable token failure as unauthorized, not offline', () => {
    const evidence = linkEvidenceFromPush(
      report({
        failed: 1,
        items: [
          {
            kind: 'review',
            slug: 'a',
            title: 'A',
            state: 'failed',
            reason: 'invalid_token - check your token at .../settings/tokens',
            retryable: false,
          },
        ],
      }),
    );
    expect(evidence?.unauthorized).toBe(true);
    expect(evidence?.reachedServer).toBe(false);
  });

  it('reads a transport failure as offline', () => {
    const evidence = linkEvidenceFromPush(
      report({
        failed: 1,
        items: [
          {
            kind: 'review',
            slug: 'a',
            title: 'A',
            state: 'failed',
            reason: 'connect: connection refused',
            retryable: true,
          },
        ],
      }),
    );
    expect(evidence?.unauthorized).toBe(false);
    expect(evidence?.reachedServer).toBe(false);
    expect(evidence?.detail).toContain('connection refused');
  });

  // A push that never left the machine says nothing about the server, and
  // painting the segment green off it would hide a dead link.
  it('proves nothing when the push was empty or blocked locally', () => {
    expect(linkEvidenceFromPush(report())).toBeNull();
    expect(
      linkEvidenceFromPush(
        report({
          blocked: 1,
          items: [
            { kind: 'review', slug: 'a', title: 'A', state: 'blocked', reason: 'looks like a token' },
          ],
        }),
      ),
    ).toBeNull();
  });
});
