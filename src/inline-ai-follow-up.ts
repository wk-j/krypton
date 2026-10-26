// Krypton — Inline AI failure follow-up (spec 335).
//
// After ↵ / ⇧↵ accepts a Cmd+K command, the overlay leaves the screen but its
// conversation stays open, and this module watches that command in its pane
// through OSC 133. The command fails when `D` reports an exit other than 0 or
// 130 (Ctrl+C), or when the shell rejects the line before running it: fish
// sends no `C`/`D` for a syntax error, so Enter is followed by a new prompt
// alone. A failure sends a `<command_result>` to the same conversation, and
// the answer is painted on a chip in the pane's corner. Cmd+K in that pane
// re-attaches the overlay on it. Nothing runs until the human accepts.

import type { IMarker } from '@xterm/xterm';

import type { FixOutcome } from './inline-ai';
import {
  buildCommandResult,
  collapseSpace,
  commandOutput,
  redactSecrets,
  rejectedOutput,
  type BufferReader,
  type CommandRecord,
  type Osc133,
} from './terminal-context';

export type WatchOutcome =
  | { kind: 'drop' }
  | { kind: 'failed'; exit: number }
  /** `typed`: the user pressed Enter (↵ path), so the line on screen is theirs to check. */
  | { kind: 'rejected'; from: IMarker; to: IMarker; typed: boolean };

const DROP: WatchOutcome = { kind: 'drop' };
/** Exits that leave nothing to fix: success, and the user's own Ctrl+C. */
const NOT_FAILED: ReadonlySet<number> = new Set([0, 130]);

/** One accepted command, from accept to its first verdict. Pure: no DOM, no conversation. */
export class CommandWatch {
  private submitted: boolean;
  /** The user's own Enter submitted the line, not ⇧↵. */
  private typed = false;
  private running = false;
  /** The cursor row of the last Enter: the rejected-line rows start there. */
  private submitMark: IMarker | null = null;

  constructor(
    readonly command: string,
    private readonly mark: () => IMarker | undefined,
    submitted: boolean,
  ) {
    this.submitted = submitted;
    if (submitted) this.remark();
  }

  /** Keystrokes typed into the watched pane; Enter submits the line. */
  input(data: string): void {
    if (this.running || !/[\r\n]/.test(data)) return;
    this.submitted = true;
    this.typed = true;
    this.remark();
  }

  /** null keeps watching. A `rejected` outcome hands its markers to the caller. */
  osc133(event: Osc133): WatchOutcome | null {
    if (event.kind === 'command') {
      if (event.cmdline !== null && collapseSpace(event.cmdline) !== collapseSpace(this.command)) return DROP;
      this.running = true;
      return null;
    }
    if (event.kind === 'end') {
      if (!this.running) return null;
      return event.exit === null || NOT_FAILED.has(event.exit) ? DROP : { kind: 'failed', exit: event.exit };
    }
    // A prompt that closes a running command without `D`: exit unknown (0334 rule).
    if (this.running) return DROP;
    // Before Enter a prompt is only a repaint.
    if (!this.submitted || this.submitMark === null) return null;
    const to = this.mark();
    if (!to) return DROP;
    const from = this.submitMark;
    this.submitMark = null;
    return { kind: 'rejected', from, to, typed: this.typed };
  }

  dispose(): void {
    this.submitMark?.dispose();
    this.submitMark = null;
  }

  private remark(): void {
    this.submitMark?.dispose();
    this.submitMark = this.mark() ?? null;
  }
}

export type FollowUpState = 'watching' | 'fixing' | 'ready' | 'none' | 'error';

/** The overlay surface a follow-up drives: `InlineAIOverlay` in the app. */
export interface FollowUpOverlay {
  runFix(report: string, failedCommand: string, label: string): Promise<FixOutcome>;
  close(): void;
}

/** The watched pane, as the compositor exposes it. */
export interface FollowUpPane {
  /** The pane's `viewId`: the key its OSC 133 handler and input path share. */
  readonly viewId: string;
  /** `.krypton-pane` (`position: relative`): hosts the chip. */
  readonly element: HTMLElement;
  /** A marker at the cursor row (`terminal.registerMarker(0)`). */
  mark(): IMarker | undefined;
  buffer(): BufferReader;
  /** The pane's `ShellCommandLog`, already updated for the current event. */
  records(): readonly CommandRecord[];
}

export interface FollowUpOptions {
  shell: string | null;
  /** `[inline_ai] context`: false sends the command and its result, not its output. */
  includeOutput: boolean;
  /** Chip click: the Cmd+K path for this pane. */
  onResume(): void;
  /** The follow-up ended by itself: passed, dropped, or made stale by a new command. */
  onEnd(): void;
}

const BLOCK = 'krypton-inline-followup';
const LABEL_COMMAND_MAX = 24;

function shortCommand(command: string): string {
  const text = redactSecrets(command).text;
  return text.length > LABEL_COMMAND_MAX ? `${text.slice(0, LABEL_COMMAND_MAX - 1)}…` : text;
}

/**
 * The follow-up of one accepted command. The compositor holds one or none:
 * the backend process keeps a single ACP session, so the next Cmd+K anywhere
 * ends this one.
 */
export class InlineFollowUp<O extends FollowUpOverlay> {
  private watch: CommandWatch | null;
  private stateValue: FollowUpState = 'watching';
  private ended = false;
  private chip: HTMLElement | null = null;
  private chipText: HTMLElement | null = null;

  constructor(
    private readonly pane: FollowUpPane,
    private readonly overlay: O,
    command: string,
    run: boolean,
    private readonly options: FollowUpOptions,
  ) {
    // ⇧↵ has already submitted the line; ↵ waits for the user's Enter.
    this.watch = new CommandWatch(command, () => pane.mark(), run);
  }

  get viewId(): string {
    return this.pane.viewId;
  }

  get state(): FollowUpState {
    return this.stateValue;
  }

  input(data: string): void {
    this.watch?.input(data);
  }

  osc133(event: Osc133): void {
    if (this.ended) return;
    if (this.watch) {
      const outcome = this.watch.osc133(event);
      if (outcome) this.settle(this.watch, outcome);
      return;
    }
    // A fix is running or shown: the next command in this pane makes it stale.
    if (event.kind === 'command') this.end();
  }

  /** Cmd+K in this pane: the overlay to re-attach once a fix exists; null while still watching. */
  resume(): O | null {
    if (this.ended || this.stateValue === 'watching') return null;
    this.ended = true;
    this.removeChip();
    return this.overlay;
  }

  /** Close the conversation (cancelling a running fix turn) and remove the chip. */
  dispose(): void {
    if (this.ended) return;
    this.ended = true;
    this.watch?.dispose();
    this.watch = null;
    this.removeChip();
    this.overlay.close();
  }

  private end(): void {
    if (this.ended) return;
    this.dispose();
    this.options.onEnd();
  }

  private settle(watch: CommandWatch, outcome: WatchOutcome): void {
    this.watch = null;
    watch.dispose();
    if (outcome.kind === 'drop') {
      this.end();
      return;
    }
    if (outcome.kind === 'failed') {
      // Read now: the log keeps markers only on its newest finished record.
      const records = this.pane.records();
      const newest = records[records.length - 1];
      const output = newest ? commandOutput(this.pane.buffer(), newest) : null;
      void this.fix(watch.command, outcome.exit, output ?? ['(output no longer in scrollback)']);
      return;
    }
    const { from, to } = outcome;
    const output = from.line >= 0 && to.line >= 0
      ? rejectedOutput(this.pane.buffer(), from.line, to.line - 1, outcome.typed ? watch.command : null)
      : null;
    from.dispose();
    to.dispose();
    if (output === null) {
      // The line was edited or cleared, or Enter printed nothing.
      this.end();
      return;
    }
    void this.fix(watch.command, null, output);
  }

  private async fix(command: string, exit: number | null, output: string[]): Promise<void> {
    const report = buildCommandResult({
      shell: this.options.shell,
      command,
      exit,
      output: this.options.includeOutput ? output : null,
    });
    const result = exit === null ? 'rejected by the shell' : `exit ${exit}`;
    this.show('fixing', `fixing · ${result}`);
    const label = `fix · $ ${shortCommand(command)} → ${exit ?? 'rejected'}`;
    const outcome = await this.overlay.runFix(report, command, label);
    // Resumed (the overlay now shows the result) or ended meanwhile.
    if (this.ended) return;
    if (outcome.kind === 'command') this.show('ready', outcome.command);
    else if (outcome.kind === 'none') this.show('none', `no fix · ${outcome.reason}`);
    else this.show('error', outcome.message);
  }

  private show(state: Exclude<FollowUpState, 'watching'>, text: string): void {
    this.stateValue = state;
    if (!this.chip || !this.chipText) {
      const chip = document.createElement('div');
      chip.setAttribute('role', 'status');
      const tag = document.createElement('span');
      tag.className = `${BLOCK}__tag`;
      tag.textContent = 'AI FIX';
      const body = document.createElement('span');
      body.className = `${BLOCK}__text`;
      const key = document.createElement('span');
      key.className = `${BLOCK}__key`;
      key.textContent = '\u2318K';
      chip.append(tag, body, key);
      chip.addEventListener('click', () => this.options.onResume());
      this.pane.element.appendChild(chip);
      this.chip = chip;
      this.chipText = body;
    }
    this.chip.className = `${BLOCK} ${BLOCK}--${state}`;
    this.chip.title = text;
    this.chipText.textContent = text;
  }

  private removeChip(): void {
    this.chip?.remove();
    this.chip = null;
    this.chipText = null;
  }
}
