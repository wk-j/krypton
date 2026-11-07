import { describe, expect, it } from 'vitest';

import { JobList } from './index';
import type { JobLine, JobsPayload } from '../../harness-view-types';

function job(over: Partial<JobLine> = {}): JobLine {
  return { id: 'Reviewer', type: 'task', status: 'running', label: 'Reviewer', durationMs: 4000, exitCode: null, ...over };
}

function payload(jobs: JobLine[], over: Partial<JobsPayload> = {}): JobsPayload {
  return { jobs, overflow: 0, interrupted: false, ...over };
}

function records(target: Node, run: () => void): MutationRecord[] {
  const observer = new MutationObserver(() => undefined);
  observer.observe(target, { subtree: true, childList: true, attributes: true, characterData: true });
  run();
  const seen = observer.takeRecords();
  observer.disconnect();
  return seen;
}

function lines(list: JobList): string[] {
  return Array.from(list.el.children).map((node) => node.textContent ?? '');
}

describe('JobList', () => {
  it('draws one line per job: glyph, id, type, a label that differs from the id, exit and time', () => {
    const list = new JobList();
    list.update({
      payload: payload([
        job(),
        job({ id: 'build', type: 'bash', status: 'failed', label: 'npm run build', durationMs: 3200, exitCode: 2 }),
        job({ id: 'Scout', status: 'cancelled', label: 'Scout', durationMs: 0 }),
      ], { overflow: 2 }),
    });
    expect(lines(list)).toEqual([
      '\u25cfReviewertask4.0s',
      '\u2717buildbashnpm run buildexit 2 \u00b7 3.2s',
      '\u2013Scouttask',
      '+2 more',
    ]);
    expect(list.el.children[1]?.className).toBe('acp-harness__job acp-harness__job--failed');
  });

  it('leaves the other lines alone when a progress frame ticks one job', () => {
    const list = new JobList();
    const host = document.createElement('div');
    host.appendChild(list.el);
    list.update({ payload: payload([job(), job({ id: 'Scout', label: 'Scout' })]) });
    const [first, second] = Array.from(list.el.children);

    const seen = records(host, () => {
      list.update({ payload: payload([job(), job({ id: 'Scout', label: 'Scout', durationMs: 4500 })]) });
    });

    expect(Array.from(list.el.children)).toEqual([first, second]);
    expect(seen.length).toBeGreaterThan(0);
    expect(second?.querySelector('.acp-harness__job-stats')?.textContent).toBe('4.5s');
    for (const record of seen) expect(first?.contains(record.target)).toBe(false);
  });

  it('hides the well when the snapshot has no jobs', () => {
    const list = new JobList();
    list.update({ payload: payload([job()]) });
    expect(list.el.hidden).toBe(false);
    list.update({ payload: payload([], { interrupted: true }) });
    expect(list.el.hidden).toBe(true);
    expect(list.el.children).toHaveLength(0);
  });
});
