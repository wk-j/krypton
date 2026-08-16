import { describe, expect, it } from 'vitest';

import { renderDigestForBrief, type CommitEntry, type DayDigest, type ProjectDigest } from './daily-note';
import type { JournalEvent, JournalKind } from './journal';

// 2026-08-15 in the runner's own zone, so `clock()` and the fixtures agree
// wherever CI happens to run.
const DAY_START = new Date('2026-08-15T00:00:00').getTime();
const at = (h: number, m = 0): number => DAY_START + h * 3_600_000 + m * 60_000;

function project(over: Partial<ProjectDigest> = {}): ProjectDigest {
  return {
    name: 'krypton',
    path: '/Users/wk/Source/krypton',
    turns: 0,
    cancelledTurns: 0,
    userOriginTurns: 0,
    systemOriginTurns: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedReadTokens: 0,
    cachedWriteTokens: 0,
    reportedCost: 0,
    firstTurnAt: null,
    lastTurnAt: null,
    maxContextUsed: null,
    byLane: [],
    byModel: [],
    laneWallClockMs: [],
    commits: [],
    reviews: [],
    artifacts: [],
    ...over,
  };
}

function digest(over: Partial<DayDigest> = {}): DayDigest {
  return {
    date: '2026-08-15',
    tzOffsetMinutes: 420,
    project: project(),
    extra: [],
    events: [],
    truncated: false,
    generatedAt: at(20),
    ...over,
  };
}

function commit(over: Partial<CommitEntry> = {}): CommitEntry {
  return {
    hash: '686a173',
    at: at(8, 46),
    subject: 'feat(harness): trim composer status line',
    files: 9,
    added: 500,
    removed: 56,
    specs: [],
    ...over,
  };
}

function event(kind: JournalKind, hour: number, summary: string, meta = {}): JournalEvent {
  return {
    v: 1,
    at: at(hour),
    kind,
    harnessId: 'hm-3',
    lane: 'Claude-4',
    backend: 'claude',
    model: 'opus',
    summary,
    meta,
  };
}

function group(key: string, over: Record<string, number> = {}) {
  return {
    key,
    turns: 1,
    inputTokens: 0,
    outputTokens: 0,
    cachedReadTokens: 0,
    cachedWriteTokens: 0,
    reportedCost: 0,
    ...over,
  };
}

describe('renderDigestForBrief', () => {
  it('is deterministic — the same digest renders byte-identical output', () => {
    const d = digest({
      project: project({ turns: 3, commits: [commit()] }),
      events: [event('handoff', 8, 'wrote handoff')],
    });
    expect(renderDigestForBrief(d)).toBe(renderDigestForBrief(d));
  });

  // spec 225: the payload is evidence, not a file — the writer copies these
  // counts into the day's frontmatter rather than recounting them from prose.
  it('states the counts the writer has to put in frontmatter', () => {
    const note = renderDigestForBrief(digest({ project: project({ turns: 5, commits: [commit()] }) }));
    expect(note).toContain('date: 2026-08-15');
    expect(note).toContain('repos: [krypton]');
    expect(note).toContain('turns: 5');
    expect(note).toContain('commits: 1');
  });

  it('is a payload, not a note — no frontmatter block and no provenance section', () => {
    const note = renderDigestForBrief(digest({ project: project({ turns: 5, commits: [commit()] }) }));
    expect(note.startsWith('---')).toBe(false);
    expect(note).not.toContain('generated:');
    expect(note).not.toContain('ที่มาของข้อมูล');
    expect(note).not.toContain('#daily brief');
  });

  it('counts turns across every project, not just the primary one', () => {
    const note = renderDigestForBrief(
      digest({
        project: project({ turns: 40 }),
        extra: [project({ name: 'xenon', turns: 3 })],
      }),
    );
    expect(note).toContain('turns: 43');
    expect(note).toContain('repos: [krypton, xenon]');
  });

  it('says a quiet day is quiet instead of rendering empty sections', () => {
    const note = renderDigestForBrief(digest());
    expect(note).toContain('ไม่มีกิจกรรมที่บันทึกไว้');
    expect(note).not.toContain('## ที่ทำวันนี้');
    expect(note).not.toContain('## Lane ที่ลงแรง');
  });

  it('names the spec files a commit actually touched, without linking to them', () => {
    const note = renderDigestForBrief(
      digest({
        project: project({
          commits: [commit({ specs: ['221-harness-status-line-density', '72-acp-harness-view'] })],
        }),
      }),
    );
    expect(note).toContain('`221-harness-status-line-density`');
    expect(note).toContain('`72-acp-harness-view`');
    expect(note).toContain('9 ไฟล์');
    expect(note).toContain('+500 / -56');
  });

  it('files each event under the commit that closed over it', () => {
    const note = renderDigestForBrief(
      digest({
        project: project({
          commits: [
            commit({ hash: 'aaa1111', at: at(9), subject: 'first' }),
            commit({ hash: 'bbb2222', at: at(15), subject: 'second' }),
          ],
        }),
        events: [event('goal', 8, 'before first'), event('handoff', 12, 'between the two')],
      }),
    );
    const firstIdx = note.indexOf('before first');
    const secondHeading = note.indexOf('second');
    const betweenIdx = note.indexOf('between the two');
    expect(firstIdx).toBeGreaterThan(-1);
    expect(firstIdx).toBeLessThan(secondHeading);
    expect(betweenIdx).toBeGreaterThan(secondHeading);
  });

  it('puts events after the last commit under ค้างอยู่, not under a commit', () => {
    const note = renderDigestForBrief(
      digest({
        project: project({ commits: [commit({ at: at(9) })] }),
        events: [event('note', 18, 'still going')],
      }),
    );
    expect(note).toContain('## ค้างอยู่');
    expect(note.indexOf('still going')).toBeGreaterThan(note.indexOf('## ค้างอยู่'));
  });

  it('lists an attention flag that was never resolved, and drops one that was', () => {
    const note = renderDigestForBrief(
      digest({
        events: [
          event('attention', 10, 'open question', { action: 'flag', itemId: 'jdg-1' }),
          event('attention', 11, 'settled question', { action: 'flag', itemId: 'jdg-2' }),
          event('attention', 12, 'resolved it', { action: 'resolve', itemId: 'jdg-2' }),
        ],
      }),
    );
    expect(note).toContain('attention ที่ยังไม่ปิด');
    expect(note).toContain('open question');
    expect(note).not.toContain('settled question');
  });

  it('reports uncommitted work and flags a truncated count as a lower bound', () => {
    const note = renderDigestForBrief(
      digest({
        project: project({
          uncommitted: { repoRoot: '/r', files: 8, added: 61, removed: 51, truncated: true },
        }),
      }),
    );
    expect(note).toContain('working tree: 8 ไฟล์ +61 / -51');
    expect(note).toContain('นับได้ไม่ครบ');
  });

  // The caveat that wall-clock is not time worked moved into the prompt, where
  // it binds the writer; the column label still has to carry the distinction.
  it('labels the duration column lane wall-clock', () => {
    const note = renderDigestForBrief(
      digest({
        project: project({
          turns: 26,
          byLane: [group('Grok-2', { turns: 26, outputTokens: 213_724, cachedReadTokens: 36_852_992 })],
          laneWallClockMs: [['Grok-2', 3.32 * 3_600_000]],
        }),
      }),
    );
    expect(note).toContain('| Lane | Turns | Lane wall-clock |');
    expect(note).toContain('| Grok-2 | 26 | 3.32 h |');
    expect(note).toContain('213.7k');
  });

  it('names an unreadable extra project instead of dropping it silently', () => {
    const note = renderDigestForBrief(
      digest({ extra: [project({ name: 'xenon', unavailable: 'not a readable directory' })] }),
    );
    expect(note).toContain('**xenon** — อ่านไม่ได้ (not a readable directory)');
    // An unreadable project is not a repo we summarised.
    expect(note).toContain('repos: [krypton]');
  });

  it('names reviews and artifacts and prints their paths as plain text', () => {
    const note = renderDigestForBrief(
      digest({
        project: project({
          reviews: [{ slug: '2026-08-15-daily-note', path: '.krypton/reviews/2026-08-15-daily-note', at: at(16) }],
          artifacts: [
            {
              id: 'art-45',
              title: 'Harness Engineering Coach — UI mock',
              lane: 'Grok-2',
              harnessId: 'hm-3',
              path: '.krypton/artifacts/hm-3/Grok-2/art-45.html',
              at: at(14, 10),
            },
          ],
        }),
      }),
    );
    expect(note).toContain('**2026-08-15-daily-note** · `.krypton/reviews/2026-08-15-daily-note/review.md`');
    expect(note).toContain(
      '**Harness Engineering Coach — UI mock** · Grok-2 · `.krypton/artifacts/hm-3/Grok-2/art-45.html`',
    );
  });

  // The whole point of the format: a note published anywhere must not carry a
  // link whose target is only reachable from where it was written.
  it('emits no markdown link and no wikilink anywhere in the note', () => {
    const note = renderDigestForBrief(
      digest({
        project: project({
          turns: 5,
          commits: [commit({ specs: ['221-harness-status-line-density'] })],
          reviews: [{ slug: '2026-08-15-daily-note', path: '.krypton/reviews/2026-08-15-daily-note', at: at(16) }],
          artifacts: [
            {
              id: 'art-45',
              title: 'Harness Engineering Coach — UI mock',
              lane: 'Grok-2',
              harnessId: 'hm-3',
              path: '.krypton/artifacts/hm-3/Grok-2/art-45.html',
              at: at(14, 10),
            },
          ],
        }),
        events: [event('goal', 8, 'a goal')],
      }),
    );
    expect(note).not.toMatch(/\[\[/);
    expect(note).not.toMatch(/\]\(/);
  });

  // The writer is required to state truncation, so the payload has to say it.
  it('admits when a section was truncated', () => {
    const note = renderDigestForBrief(digest({ truncated: true, project: project({ turns: 1 }) }));
    expect(note).toContain('ถูกตัดที่ 50 รายการ');
  });

  it('never leaves a run of blank lines or a trailing gap', () => {
    const note = renderDigestForBrief(
      digest({
        project: project({ turns: 2, commits: [commit()], byLane: [group('Claude-4')] }),
        events: [event('handoff', 8, 'wrote handoff')],
      }),
    );
    expect(note).not.toMatch(/\n{3,}/);
    expect(note.endsWith('\n')).toBe(true);
    expect(note.endsWith('\n\n')).toBe(false);
  });
});
