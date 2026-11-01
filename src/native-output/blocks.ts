// Krypton — command blocks for native output (spec 351).
//
// A block is one shell command's output: the rows between its OSC 133 `C`
// (command start) and `D` (command end). The tracker owns its own markers —
// `ShellCommandLog` (spec 334) drops all but the newest record's — and hands
// each finished block to its consumer, which then owns both markers.

import type { IMarker } from '@xterm/xterm';

import type { Osc133 } from '../terminal-context';

export interface CommandBlock {
  readonly id: number;
  readonly cmdline: string | null;
  /** Cursor row at `C`: the first output row. */
  readonly start: IMarker;
  /** Cursor row at `D`. */
  readonly end: IMarker;
  /** Cursor column at `D`: 0 means the output ended with a newline. */
  readonly endCol: number;
  /** null when the shell sent `D` without a status. */
  readonly exit: number | null;
}

/** Where the tracker reads the cursor; `terminal.registerMarker(0)` in the app. */
export interface BlockMarkSource {
  mark(): IMarker | null;
  cursorX(): number;
}

interface OpenBlock {
  cmdline: string | null;
  start: IMarker;
}

export class CommandBlockTracker {
  private readonly source: BlockMarkSource;
  private readonly onFinish: (block: CommandBlock) => void;
  private open: OpenBlock | null = null;
  private nextId = 1;

  constructor(source: BlockMarkSource, onFinish: (block: CommandBlock) => void) {
    this.source = source;
    this.onFinish = onFinish;
  }

  apply(event: Osc133): void {
    if (event.kind === 'command') {
      this.drop();
      const start = this.source.mark();
      if (start) this.open = { cmdline: event.cmdline, start };
      return;
    }
    // A prompt while a block is open means the shell never sent `D`
    // (interrupted, or a shell that marks prompts only): no block.
    if (event.kind === 'prompt') {
      this.drop();
      return;
    }
    const open = this.open;
    if (!open) return;
    this.open = null;
    const end = this.source.mark();
    if (!end) {
      open.start.dispose();
      return;
    }
    this.onFinish({
      id: this.nextId++,
      cmdline: open.cmdline,
      start: open.start,
      end,
      endCol: this.source.cursorX(),
      exit: event.exit,
    });
  }

  /** RIS: forget the open block. Finished blocks belong to their consumer. */
  reset(): void {
    this.drop();
  }

  private drop(): void {
    this.open?.start.dispose();
    this.open = null;
  }
}

/**
 * Rows the block's output occupies now (markers follow reflow and scrollback).
 * `D` lands at column 0 of the row after the output when it ended with a
 * newline (that row later holds the prompt), or mid-row when it did not.
 */
export function rawRows(block: Pick<CommandBlock, 'start' | 'end' | 'endCol'>): number {
  const start = block.start.line;
  const end = block.end.line;
  if (start < 0 || end < 0 || end < start) return 0;
  return end - start + (block.endCol > 0 ? 1 : 0);
}

/**
 * Whether a finished block's exit status can still have a native view.
 * `git diff --exit-code` and `diff -u` report differences with 1. 141 is
 * SIGPIPE: quitting a pager (delta/less) before the end kills `git diff`
 * with it, although nothing went wrong — the common case for any diff
 * longer than a screen. null: the shell sent `D` without a status.
 */
export function acceptsExit(exit: number | null): boolean {
  return exit === null || exit === 0 || exit === 1 || exit === 141;
}
