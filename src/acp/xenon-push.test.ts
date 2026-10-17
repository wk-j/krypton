import { describe, expect, it } from 'vitest';

import {
  describePush,
  linkEvidenceFromPush,
  matchHandoffReference,
  mergeHandoffs,
  parsePushCommand,
  parseResumeCommand,
  summarizePush,
  xenonProjectUrl,
  type PushReport,
  type RemoteHandoff,
  type XenonStatus,
} from './xenon-push';
import type { HandoffEntry } from './types';

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

  it('accepts timeline and a confirmed event id', () => {
    expect(parsePushCommand('#push timeline tl-20260920T100000Z-abcd1234')).toEqual({
      ok: true,
      args: { kind: 'timeline', slug: 'tl-20260920T100000Z-abcd1234', force: false },
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

  it('accepts the handoff kind with an id as its slug', () => {
    expect(parsePushCommand('#push handoff ho-mg3k2x1a-3f9c0e')).toEqual({
      ok: true,
      args: { kind: 'handoff', slug: 'ho-mg3k2x1a-3f9c0e', force: false },
    });
  });
});

describe('xenonProjectUrl', () => {
  const status: XenonStatus = {
    enabled: true,
    configured: true,
    baseUrl: 'https://xenon.example.com',
    project: 'wk-j/krypton',
    token: 'configured',
    queued: 0,
    autoPush: [],
  };

  it('opens the project timeline and safely encodes an optional topic', () => {
    expect(xenonProjectUrl(status, '')).toBe(
      'https://xenon.example.com/p/wk-j%2Fkrypton/timeline',
    );
    expect(xenonProjectUrl(status, 'Release / cutover')).toBe(
      'https://xenon.example.com/p/wk-j%2Fkrypton/timeline?topic=Release%20%2F%20cutover',
    );
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

function localHandoff(overrides: Partial<HandoffEntry> = {}): HandoffEntry {
  return {
    id: 'ho-aaaa0001-000001',
    author: 'Claude-1',
    host: 'mbp',
    summary: 'local summary',
    detail: 'local detail',
    createdAt: 1_000,
    updatedAt: 1_000,
    boundLanes: [],
    ...overrides,
  };
}

function remoteHandoff(overrides: Partial<RemoteHandoff> = {}): RemoteHandoff {
  return {
    id: 'ho-aaaa0001-000001',
    author: 'Codex-2',
    host: 'studio',
    summary: 'remote summary',
    detail: null,
    createdAt: 1_000,
    updatedAt: 1_000,
    seq: 1,
    url: 'https://xenon.example.com/r/1',
    ...overrides,
  };
}

describe('parseResumeCommand', () => {
  it('reads a bare #resume as "newest"', () => {
    expect(parseResumeCommand('#resume')).toEqual({ ok: true, request: { mode: 'newest' } });
    expect(parseResumeCommand('  #resume  ')).toEqual({ ok: true, request: { mode: 'newest' } });
  });

  it('reads list and an id reference', () => {
    expect(parseResumeCommand('#resume list')).toEqual({ ok: true, request: { mode: 'list' } });
    expect(parseResumeCommand('#resume ho-mg3k')).toEqual({
      ok: true,
      request: { mode: 'id', reference: 'ho-mg3k' },
    });
  });

  it('rejects more than one argument', () => {
    expect(parseResumeCommand('#resume list extra').ok).toBe(false);
    expect(parseResumeCommand('#resume a b').ok).toBe(false);
  });

  it('refuses input that is not #resume', () => {
    expect(parseResumeCommand('#handoff').ok).toBe(false);
  });
});

describe('mergeHandoffs', () => {
  it('keeps one row per id and the newer copy wins', () => {
    const merged = mergeHandoffs(
      [localHandoff({ updatedAt: 2_000 })],
      [remoteHandoff({ updatedAt: 3_000 })],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].source).toBe('xenon');
    expect(merged[0].author).toBe('Codex-2');
    expect(merged[0].detail).toBeNull();
  });

  it('prefers the local copy when it is newer or equally new', () => {
    expect(mergeHandoffs([localHandoff({ updatedAt: 5_000 })], [remoteHandoff({ updatedAt: 4_000 })])[0])
      .toMatchObject({ source: 'local', detail: 'local detail' });
    expect(mergeHandoffs([localHandoff({ updatedAt: 4_000 })], [remoteHandoff({ updatedAt: 4_000 })])[0])
      .toMatchObject({ source: 'local', detail: 'local detail' });
  });

  it('unions distinct ids newest first', () => {
    const merged = mergeHandoffs(
      [localHandoff({ id: 'ho-a', updatedAt: 1_000 }), localHandoff({ id: 'ho-c', updatedAt: 3_000 })],
      [remoteHandoff({ id: 'ho-b', updatedAt: 2_000 })],
    );
    expect(merged.map((h) => [h.id, h.source])).toEqual([
      ['ho-c', 'local'],
      ['ho-b', 'xenon'],
      ['ho-a', 'local'],
    ]);
  });

  it('is empty when both sides are', () => {
    expect(mergeHandoffs([], [])).toEqual([]);
  });
});

describe('matchHandoffReference', () => {
  const list = [
    { id: 'ho-mg3k2x1a-3f9c0e' },
    { id: 'ho-mg3k9zzz-111111' },
    { id: 'ho-ab12cd34-222222' },
  ];

  it('matches an exact id', () => {
    const result = matchHandoffReference(list, 'ho-ab12cd34-222222');
    expect(result.ok && result.handoff.id).toBe('ho-ab12cd34-222222');
  });

  it('accepts a unique prefix with or without ho-', () => {
    const bare = matchHandoffReference(list, 'ab12');
    expect(bare.ok && bare.handoff.id).toBe('ho-ab12cd34-222222');
    const prefixed = matchHandoffReference(list, 'ho-mg3k2');
    expect(prefixed.ok && prefixed.handoff.id).toBe('ho-mg3k2x1a-3f9c0e');
  });

  it('rejects a prefix shorter than four characters after ho-', () => {
    for (const reference of ['ab1', 'ho-ab1']) {
      const result = matchHandoffReference(list, reference);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('too_short');
    }
  });

  it('reports an ambiguous prefix rather than picking one', () => {
    const result = matchHandoffReference(list, 'mg3k');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('ambiguous');
  });

  it('reports no match separately so the caller can ask Xenon', () => {
    const result = matchHandoffReference(list, 'zzzz');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('none');
  });
});
