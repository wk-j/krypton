// @vitest-environment happy-dom
import { describe, expect, it, vi, type Mock } from 'vitest';

import type { IMarker } from '@xterm/xterm';

import type { FixOutcome } from './inline-ai';
import { CommandWatch, InlineFollowUp, type FollowUpOverlay, type FollowUpPane } from './inline-ai-follow-up';
import type { BufferReader, CommandRecord, Osc133 } from './terminal-context';

/** A marker the test moves by hand; `dispose()` behaves like xterm's (line → -1). */
class FakeMarker {
  disposed = false;
  constructor(public line: number) {}
  dispose(): void {
    this.disposed = true;
    this.line = -1;
  }
}

const asMarker = (m: FakeMarker): IMarker => m as unknown as IMarker;

const CMD = 'npm test && (cd src-tauri && cargo test)';
const command = (cmdline: string | null): Osc133 => ({ kind: 'command', cmdline });
const end = (exit: number | null): Osc133 => ({ kind: 'end', exit });
const PROMPT: Osc133 = { kind: 'prompt' };

/** Marks rows in order: the first call returns row `rows[0]`, and so on. */
function marks(...rows: number[]): { mark: () => IMarker; made: FakeMarker[] } {
  const made: FakeMarker[] = [];
  return {
    made,
    mark: () => {
      const m = new FakeMarker(rows[made.length] ?? 0);
      made.push(m);
      return asMarker(m);
    },
  };
}

describe('CommandWatch', () => {
  it('reports a run command that exits non-zero, matching its cmdline across spacing', () => {
    const watch = new CommandWatch(CMD, marks(0).mark, true);
    expect(watch.osc133(command('npm test &&  (cd src-tauri && cargo test) '))).toBeNull();
    expect(watch.osc133(end(1))).toEqual({ kind: 'failed', exit: 1 });
  });

  it.each([0, 130, null])('drops a command that ends with exit %s', (exit) => {
    const watch = new CommandWatch(CMD, marks(0).mark, true);
    watch.osc133(command(CMD));
    expect(watch.osc133(end(exit))).toEqual({ kind: 'drop' });
  });

  it('drops when a different command starts', () => {
    const watch = new CommandWatch(CMD, marks(0).mark, true);
    expect(watch.osc133(command('ls'))).toEqual({ kind: 'drop' });
  });

  it('accepts a C without a cmdline as the watched command', () => {
    const watch = new CommandWatch(CMD, marks(0).mark, true);
    expect(watch.osc133(command(null))).toBeNull();
    expect(watch.osc133(end(2))).toEqual({ kind: 'failed', exit: 2 });
  });

  it('drops when a prompt closes the command without D', () => {
    const watch = new CommandWatch(CMD, marks(0).mark, true);
    watch.osc133(command(CMD));
    expect(watch.osc133(PROMPT)).toEqual({ kind: 'drop' });
  });

  it('ignores a prompt repaint before Enter, then reports Enter followed by a bare prompt as rejected', () => {
    const { mark, made } = marks(4, 9);
    const watch = new CommandWatch(CMD, mark, false);
    expect(made).toHaveLength(0);
    expect(watch.osc133(PROMPT)).toBeNull();
    watch.input('x');
    expect(made).toHaveLength(0);
    watch.input('\r');
    const outcome = watch.osc133(PROMPT);
    expect(outcome).toEqual({ kind: 'rejected', from: made[0], to: made[1], typed: true });
    // The outcome owns the markers now.
    watch.dispose();
    expect(made[0].disposed).toBe(false);
  });

  it('re-marks on every Enter and disposes the earlier mark', () => {
    const { mark, made } = marks(3, 4, 7);
    const watch = new CommandWatch(CMD, mark, false);
    watch.input('\r');
    watch.input('\r');
    expect(made[0].disposed).toBe(true);
    expect(watch.osc133(PROMPT)).toEqual({ kind: 'rejected', from: made[1], to: made[2], typed: true });
  });

  it('marks a ⇧↵ line as not typed, so its half-painted echo is not checked', () => {
    const { mark, made } = marks(2, 6);
    const watch = new CommandWatch(CMD, mark, true);
    expect(watch.osc133(PROMPT)).toEqual({ kind: 'rejected', from: made[0], to: made[1], typed: false });
  });
});

class FakeOverlay implements FollowUpOverlay {
  readonly fixes: Array<{ report: string; failed: string; label: string }> = [];
  closed = 0;
  private settle: ((outcome: FixOutcome) => void) | null = null;

  runFix(report: string, failed: string, label: string): Promise<FixOutcome> {
    this.fixes.push({ report, failed, label });
    return new Promise((resolve) => {
      this.settle = resolve;
    });
  }

  async finish(outcome: FixOutcome): Promise<void> {
    this.settle?.(outcome);
    await Promise.resolve();
    await Promise.resolve();
  }

  close(): void {
    this.closed++;
  }
}

function rows(lines: string[]): BufferReader {
  return {
    type: 'normal',
    length: lines.length,
    viewportY: 0,
    rows: lines.length,
    line: (row) => (lines[row] === undefined ? null : { text: lines[row], wrapped: false }),
  };
}

interface Harness {
  followUp: InlineFollowUp<FakeOverlay>;
  overlay: FakeOverlay;
  host: HTMLElement;
  onEnd: Mock<() => void>;
  onResume: Mock<() => void>;
}

function harness(opts: {
  run?: boolean;
  lines?: string[];
  markRows?: number[];
  records?: CommandRecord[];
  includeOutput?: boolean;
} = {}): Harness {
  const host = document.createElement('div');
  const overlay = new FakeOverlay();
  const onEnd = vi.fn<() => void>();
  const onResume = vi.fn<() => void>();
  const pane: FollowUpPane = {
    viewId: 'view-1',
    element: host,
    mark: marks(...(opts.markRows ?? [0, 4])).mark,
    buffer: () => rows(opts.lines ?? []),
    records: () => opts.records ?? [],
  };
  const followUp = new InlineFollowUp(pane, overlay, CMD, opts.run ?? true, {
    shell: 'fish',
    includeOutput: opts.includeOutput ?? true,
    onResume,
    onEnd,
  });
  return { followUp, overlay, host, onEnd, onResume };
}

const chip = (host: HTMLElement): HTMLElement | null => host.querySelector('.krypton-inline-followup');

/** A finished record whose output is rows 1–2 of `FAILED_ROWS`. */
const FAILED_ROWS = [' ! cargo test', 'test result: FAILED. 3 passed; 1 failed', 'error: test failed', ' ! '];
const failedRecord = (): CommandRecord => ({
  cmdline: CMD,
  exit: 101,
  running: false,
  start: asMarker(new FakeMarker(1)),
  end: asMarker(new FakeMarker(3)),
  endCol: 0,
});

describe('InlineFollowUp', () => {
  it('asks once for a fix with the failed output, and shows the answer on a chip', async () => {
    const h = harness({ lines: FAILED_ROWS, records: [failedRecord()] });
    h.followUp.osc133(command(CMD));
    h.followUp.osc133(end(101));

    expect(h.overlay.fixes).toHaveLength(1);
    const [fix] = h.overlay.fixes;
    expect(fix.failed).toBe(CMD);
    expect(fix.report).toContain('shell: fish');
    expect(fix.report).toContain('result: exit 101\noutput:\ntest result: FAILED. 3 passed; 1 failed\nerror: test failed\n</command_result>');
    expect(fix.label).toBe('fix · $ npm test && (cd src-tau… → 101');
    expect(h.followUp.state).toBe('fixing');
    expect(chip(h.host)?.className).toBe('krypton-inline-followup krypton-inline-followup--fixing');
    expect(chip(h.host)?.textContent).toBe('AI FIXfixing · exit 101\u2318K');

    await h.overlay.finish({ kind: 'command', command: 'npm test && cargo test --manifest-path src-tauri/Cargo.toml' });
    expect(h.followUp.state).toBe('ready');
    expect(chip(h.host)?.className).toContain('--ready');
    expect(chip(h.host)?.title).toBe('npm test && cargo test --manifest-path src-tauri/Cargo.toml');
    expect(h.overlay.closed).toBe(0);
  });

  it('reports a ⇧↵ line the shell rejected, even when fish had not painted all of it', () => {
    // Measured: fish ran the line before painting its last word.
    const lines = [' ! npm test && (cd src-tauri && cargo', 'fish: command substitutions not allowed in command position.', '', ''];
    const h = harness({ run: true, lines, markRows: [0, 3] });
    h.followUp.osc133(PROMPT);
    expect(h.overlay.fixes).toHaveLength(1);
    expect(h.overlay.fixes[0].report).toContain('result: rejected by the shell before it ran\noutput:\nfish: command substitutions not allowed in command position.');
    expect(chip(h.host)?.textContent).toContain('fixing · rejected by the shell');
  });

  it('ends without asking when the user edited the line before Enter', () => {
    const h = harness({ run: false, lines: [' ! ls -la', 'fish: unknown'], markRows: [0, 2] });
    h.followUp.input('\r');
    h.followUp.osc133(PROMPT);
    expect(h.overlay.fixes).toHaveLength(0);
    expect(h.overlay.closed).toBe(1);
    expect(h.onEnd).toHaveBeenCalledOnce();
    expect(chip(h.host)).toBeNull();
  });

  it('ends without asking when Enter printed nothing', () => {
    const h = harness({ run: true, lines: [` ! ${CMD}`, ''], markRows: [0, 2] });
    h.followUp.osc133(PROMPT);
    expect(h.overlay.fixes).toHaveLength(0);
    expect(h.onEnd).toHaveBeenCalledOnce();
  });

  it('ends quietly when the command passes', () => {
    const h = harness();
    h.followUp.osc133(command(CMD));
    h.followUp.osc133(end(0));
    expect(h.overlay.fixes).toHaveLength(0);
    expect(h.overlay.closed).toBe(1);
    expect(h.onEnd).toHaveBeenCalledOnce();
  });

  it('sends the command and its result but no output when context is off', () => {
    const h = harness({ lines: FAILED_ROWS, records: [failedRecord()], includeOutput: false });
    h.followUp.osc133(command(CMD));
    h.followUp.osc133(end(101));
    expect(h.overlay.fixes[0].report).not.toContain('output:');
    expect(h.overlay.fixes[0].report).not.toContain('FAILED');
  });

  it('shows NO_FIX reasons and errors on the chip', async () => {
    const none = harness({ lines: FAILED_ROWS, records: [failedRecord()] });
    none.followUp.osc133(command(CMD));
    none.followUp.osc133(end(101));
    await none.overlay.finish({ kind: 'none', reason: '1 test failed in config.rs' });
    expect(none.followUp.state).toBe('none');
    expect(chip(none.host)?.title).toBe('no fix · 1 test failed in config.rs');

    const error = harness({ lines: FAILED_ROWS, records: [failedRecord()] });
    error.followUp.osc133(command(CMD));
    error.followUp.osc133(end(101));
    await error.overlay.finish({ kind: 'error', message: 'inline AI: "claude" exited — press Cmd+K again' });
    expect(chip(error.host)?.className).toContain('--error');
  });

  it('a new command in the pane makes a shown fix stale', async () => {
    const h = harness({ lines: FAILED_ROWS, records: [failedRecord()] });
    h.followUp.osc133(command(CMD));
    h.followUp.osc133(end(101));
    await h.overlay.finish({ kind: 'command', command: 'make' });
    h.followUp.osc133(command('git status'));
    expect(chip(h.host)).toBeNull();
    expect(h.overlay.closed).toBe(1);
    expect(h.onEnd).toHaveBeenCalledOnce();
  });

  it('a new command while the fix runs cancels it, and its late answer paints nothing', async () => {
    const h = harness({ lines: FAILED_ROWS, records: [failedRecord()] });
    h.followUp.osc133(command(CMD));
    h.followUp.osc133(end(101));
    h.followUp.osc133(command('git status'));
    expect(h.overlay.closed).toBe(1);
    await h.overlay.finish({ kind: 'command', command: 'make' });
    expect(chip(h.host)).toBeNull();
  });

  it('resume hands back the overlay only once a fix exists', async () => {
    const h = harness({ lines: FAILED_ROWS, records: [failedRecord()] });
    expect(h.followUp.resume()).toBeNull();
    h.followUp.osc133(command(CMD));
    h.followUp.osc133(end(101));
    expect(h.followUp.resume()).toBe(h.overlay);
    expect(chip(h.host)).toBeNull();
    // The overlay now belongs to the compositor: neither the late answer nor dispose touch it.
    await h.overlay.finish({ kind: 'command', command: 'make' });
    h.followUp.dispose();
    expect(chip(h.host)).toBeNull();
    expect(h.overlay.closed).toBe(0);
  });

  it('a chip click takes the resume path', async () => {
    const h = harness({ lines: FAILED_ROWS, records: [failedRecord()] });
    h.followUp.osc133(command(CMD));
    h.followUp.osc133(end(101));
    chip(h.host)?.click();
    expect(h.onResume).toHaveBeenCalledOnce();
  });
});
