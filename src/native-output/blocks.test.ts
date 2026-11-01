import { describe, expect, it } from 'vitest';
import type { IMarker } from '@xterm/xterm';

import { acceptsExit, CommandBlockTracker, rawRows, type CommandBlock } from './blocks';

interface FakeMarker extends IMarker {
  line: number;
  isDisposed: boolean;
}

function fakeMarker(line: number): FakeMarker {
  const marker = {
    id: line,
    line,
    isDisposed: false,
    dispose(): void {
      marker.isDisposed = true;
      marker.line = -1;
    },
    onDispose: () => ({ dispose(): void {} }),
  };
  return marker as FakeMarker;
}

function setup(): { tracker: CommandBlockTracker; blocks: CommandBlock[]; cursor: { row: number; col: number }; marks: FakeMarker[] } {
  const cursor = { row: 0, col: 0 };
  const blocks: CommandBlock[] = [];
  const marks: FakeMarker[] = [];
  const tracker = new CommandBlockTracker(
    {
      mark: () => {
        const m = fakeMarker(cursor.row);
        marks.push(m);
        return m;
      },
      cursorX: () => cursor.col,
    },
    (block) => blocks.push(block),
  );
  return { tracker, blocks, cursor, marks };
}

describe('CommandBlockTracker', () => {
  it('turns C then D into a block spanning the rows between them', () => {
    const { tracker, blocks, cursor } = setup();
    cursor.row = 3;
    tracker.apply({ kind: 'command', cmdline: 'git diff' });
    cursor.row = 9;
    tracker.apply({ kind: 'end', exit: 0 });
    expect(blocks).toHaveLength(1);
    expect([blocks[0].cmdline, blocks[0].exit, blocks[0].start.line, blocks[0].end.line]).toEqual(['git diff', 0, 3, 9]);
    expect(rawRows(blocks[0])).toBe(6);
  });

  it('drops a block the shell closed with a prompt instead of D, and disposes its marker', () => {
    const { tracker, blocks, marks } = setup();
    tracker.apply({ kind: 'command', cmdline: 'sleep 9' });
    tracker.apply({ kind: 'prompt' });
    tracker.apply({ kind: 'end', exit: 130 });
    expect(blocks).toHaveLength(0);
    expect(marks[0].isDisposed).toBe(true);
  });

  it('replaces an open block when a second C arrives, and reset forgets it', () => {
    const { tracker, blocks, marks } = setup();
    tracker.apply({ kind: 'command', cmdline: 'a' });
    tracker.apply({ kind: 'command', cmdline: 'b' });
    expect(marks[0].isDisposed).toBe(true);
    tracker.reset();
    tracker.apply({ kind: 'end', exit: 0 });
    expect(blocks).toHaveLength(0);
  });
});

describe('rawRows', () => {
  it('counts the D row only when the output did not end with a newline', () => {
    expect(rawRows({ start: fakeMarker(4), end: fakeMarker(6), endCol: 0 })).toBe(2);
    expect(rawRows({ start: fakeMarker(4), end: fakeMarker(6), endCol: 12 })).toBe(3);
    expect(rawRows({ start: fakeMarker(4), end: fakeMarker(4), endCol: 0 })).toBe(0);
  });

  it('is 0 once a marker is trimmed out of scrollback', () => {
    expect(rawRows({ start: fakeMarker(-1), end: fakeMarker(6), endCol: 0 })).toBe(0);
  });
});

describe('acceptsExit', () => {
  it('keeps a diff whose pager was quit early (SIGPIPE 141), and drops real failures', () => {
    expect([0, 1, 141, null].map(acceptsExit)).toEqual([true, true, true, true]);
    expect([2, 127, 128, 130].map(acceptsExit)).toEqual([false, false, false, false]);
  });
});
