import { describe, expect, it } from 'vitest';

import { COMMAND_RUN_REVEAL_MS, CommandRunTracker, commandRunText } from './harness-command-runs';

function clock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

describe('commandRunText', () => {
  it('never paints the secret after #xenon token', () => {
    expect(commandRunText('#xenon token xk_live_abc123')).toBe('#xenon token');
    expect(commandRunText('  #xenon   token   xk_live_abc123  ')).toBe('#xenon token');
    expect(commandRunText('#xenon status')).toBe('#xenon status');
  });

  it('collapses whitespace and cuts long commands to 28 chars', () => {
    expect(commandRunText('  #e2e   run\tlogin ')).toBe('#e2e run login');
    const long = commandRunText('#create-github-issue the composer loses its draft on lane switch');
    expect(long).toHaveLength(28);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('CommandRunTracker', () => {
  it('reveals a run only once it is COMMAND_RUN_REVEAL_MS old', () => {
    const c = clock();
    const runs = new CommandRunTracker(c.now);
    runs.begin('lane-1', '#push review');
    c.advance(COMMAND_RUN_REVEAL_MS - 1);
    expect(runs.visible('lane-1')).toEqual([]);
    c.advance(1);
    expect(runs.visible('lane-1').map((r) => r.text)).toEqual(['#push review']);
  });

  it('lists a lane’s runs oldest first with their elapsed time, ignoring other lanes', () => {
    const c = clock();
    const runs = new CommandRunTracker(c.now);
    runs.begin('lane-1', '#e2e run login');
    c.advance(70_000);
    runs.begin('lane-2', '#daily');
    runs.begin('lane-1', '#push');
    c.advance(64_000);
    expect(runs.visible('lane-1').map((r) => [r.text, r.elapsed])).toEqual([
      ['#e2e run login', '2:14'],
      ['#push', '1:04'],
    ]);
    expect(runs.visible('lane-2').map((r) => r.text)).toEqual(['#daily']);
  });

  it('reports whether an ended run was on screen', () => {
    const c = clock();
    const runs = new CommandRunTracker(c.now);
    const quick = runs.begin('lane-1', '#home');
    c.advance(10);
    expect(runs.end(quick)).toBe(false);
    const slow = runs.begin('lane-1', '#push');
    c.advance(COMMAND_RUN_REVEAL_MS);
    expect(runs.end(slow)).toBe(true);
    expect(runs.end(slow)).toBe(false);
    expect(runs.size).toBe(0);
  });

  it('drops a closed lane’s runs and leaves the later end a no-op', () => {
    const c = clock();
    const runs = new CommandRunTracker(c.now);
    const gone = runs.begin('lane-1', '#e2e run all');
    runs.begin('lane-2', '#push');
    runs.dropLane('lane-1');
    expect(runs.hasLane('lane-1')).toBe(false);
    expect(runs.hasLane('lane-2')).toBe(true);
    c.advance(COMMAND_RUN_REVEAL_MS);
    expect(runs.end(gone)).toBe(false);
    expect(runs.size).toBe(1);
  });
});
