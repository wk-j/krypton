// Krypton — the native output layer of one terminal pane (specs 351, 352).
//
// Watches OSC 133 for finished command blocks. A block whose rows hold a
// unified diff — or a local plain `git diff` / `git status`, re-run in a
// machine-readable form — gets a `NativeCard` laid over exactly those rows.
// Cards follow the buffer on every xterm render: the cell grid is the
// coordinate system, markers give the rows. Nothing here writes to the PTY or
// the terminal's cells.

import type { IBuffer, Terminal } from '@xterm/xterm';

import { parseOsc133 } from '../terminal-context';
import { CommandBlockTracker, rawRows, type CommandBlock } from './blocks';
import { isGitDiffCmdline, looksLikeUnifiedDiff, parseNativeDiff } from './git-diff';
import { gitStatusText, isGitStatusCmdline, parseGitStatus, type NativeGitStatusRaw } from './git-status';
import { NativeCard, type NativeModel, type NativeView } from './native-card';

export type { NativeView } from './native-card';

/** Oldest cards go first; their blocks stay raw. */
const MAX_CARDS = 16;
/** Lines read before deciding whether a block can be a diff at all. */
const SNIFF_LINES = 8;
const RERUN_DETAIL = 'Re-ran without pager or colour after it finished — Raw shows what it printed';

export interface NativeOutputHost {
  enabled(): boolean;
  defaultView(): NativeView;
  /** Re-run a finished `git diff` when the pane's own shell is in front; null when it cannot. */
  rerunGitDiff(cmdline: string): Promise<string | null>;
  /** The same for `git status`, as porcelain v2 plus staged/unstaged numstat. */
  rerunGitStatus(cmdline: string): Promise<NativeGitStatusRaw | null>;
  notify(message: string): void;
}

/** What a block renders as, and what Copy writes for it. */
interface NativeContent {
  readonly model: NativeModel;
  readonly copyText: string;
  readonly detail: string;
}

interface CardEntry extends NativeContent {
  readonly block: CommandBlock;
  readonly card: NativeCard;
  readonly label: string;
  view: NativeView;
}

/** Distinguishes each pane's `.xterm-screen` in its row-hiding rules. */
let nextScopeId = 1;

export class NativeOutputLayer {
  private readonly terminal: Terminal;
  private readonly host: NativeOutputHost;
  private readonly tracker: CommandBlockTracker;
  private root: HTMLElement | null = null;
  /** Hides the raw rows under Native cards (DOM renderer rows), so a card can stay transparent. */
  private hideSheet: HTMLStyleElement | null = null;
  private hiddenKey = '';
  private readonly scopeId = nextScopeId++;
  private cards: CardEntry[] = [];
  private cellH = 0;
  private alt = false;

  constructor(terminal: Terminal, host: NativeOutputHost) {
    this.terminal = terminal;
    this.host = host;
    this.tracker = new CommandBlockTracker(
      { mark: () => terminal.registerMarker(0), cursorX: () => terminal.buffer.active.cursorX },
      // Out of the parser callback: reading and parsing the block is not VT work.
      (block) => window.setTimeout(() => void this.finish(block), 0),
    );
    // Observed only: `false` lets wireProgramStatus's handler and xterm run too.
    terminal.parser.registerOscHandler(133, (data: string) => {
      const event = parseOsc133(data);
      if (event) this.tracker.apply(event);
      return false;
    });
    terminal.parser.registerEscHandler({ final: 'c' }, () => {
      this.tracker.reset();
      for (const entry of [...this.cards]) this.remove(entry);
      return false;
    });
    terminal.onRender(() => this.layout());
    terminal.onScroll(() => this.layout());
    terminal.onResize(() => this.layout());
    terminal.buffer.onBufferChange(() => this.layout());
  }

  /** `Leader i`: flip the newest card that is at least partly in view. */
  toggleTarget(): boolean {
    const entry = this.target();
    if (!entry) return false;
    this.setView(entry, entry.view === 'native' ? 'raw' : 'native');
    return true;
  }

  /** `Leader Shift+I`: copy that card's diff or status. */
  copyTarget(): boolean {
    const entry = this.target();
    if (!entry) return false;
    void this.copy(entry);
    return true;
  }

  private async finish(block: CommandBlock): Promise<void> {
    const mounted = await this.tryMount(block);
    if (!mounted) {
      block.start.dispose();
      block.end.dispose();
    }
  }

  private async tryMount(block: CommandBlock): Promise<boolean> {
    if (!this.host.enabled() || rawRows(block) < 1) return false;
    // `git diff --exit-code` and `diff -u` report differences with 1.
    if (block.exit !== null && block.exit !== 0 && block.exit !== 1) return false;
    const content = await this.resolve(block);
    if (content === null || block.start.isDisposed || block.end.isDisposed) return false;
    return this.mount({ ...content, block, label: block.cmdline ?? 'output' });
  }

  /** The block's rows when they are a diff; else a re-run of a plain local `git diff` / `git status`. */
  private async resolve(block: CommandBlock): Promise<NativeContent | null> {
    const buffer = this.terminal.buffer.normal;
    if (looksLikeUnifiedDiff(blockLines(buffer, block, SNIFF_LINES))) {
      const text = blockLines(buffer, block, Infinity).join('\n');
      const files = parseNativeDiff(text);
      return files && { model: { kind: 'diff', files }, copyText: text, detail: 'Native view of this output — Raw shows the terminal text' };
    }
    const cmdline = block.cmdline;
    if (cmdline !== null && isGitDiffCmdline(cmdline)) {
      const text = await this.host.rerunGitDiff(cmdline);
      const files = text === null ? null : parseNativeDiff(text);
      return files && text !== null ? { model: { kind: 'diff', files }, copyText: text, detail: RERUN_DETAIL } : null;
    }
    if (cmdline !== null && isGitStatusCmdline(cmdline)) {
      const raw = await this.host.rerunGitStatus(cmdline);
      const status = raw === null ? null : parseGitStatus(raw);
      return status && { model: { kind: 'status', status }, copyText: gitStatusText(status), detail: RERUN_DETAIL };
    }
    return null;
  }

  private mount(parts: Omit<CardEntry, 'card' | 'view'>): boolean {
    const root = this.ensureRoot();
    if (!root) return false;
    // The callbacks run on clicks, long after `entry` is assigned.
    const entry: CardEntry = {
      ...parts,
      view: this.host.defaultView(),
      card: new NativeCard({
        onView: (view) => this.setView(entry, view),
        onCopy: () => void this.copy(entry),
      }),
    };
    root.append(entry.card.el);
    this.cards.push(entry);
    entry.block.start.onDispose(() => this.remove(entry));
    entry.block.end.onDispose(() => this.remove(entry));
    while (this.cards.length > MAX_CARDS) this.remove(this.cards[0]);
    this.paint(entry);
    this.layout();
    return true;
  }

  private remove(entry: CardEntry): void {
    const index = this.cards.indexOf(entry);
    if (index < 0) return;
    this.cards.splice(index, 1);
    entry.card.el.remove();
    entry.card.dispose();
    entry.block.start.dispose();
    entry.block.end.dispose();
    this.layout();
  }

  private setView(entry: CardEntry, view: NativeView): void {
    entry.view = view;
    this.paint(entry);
    this.layout();
  }

  private paint(entry: CardEntry): void {
    entry.card.update({ label: entry.label, detail: entry.detail, model: entry.model, view: entry.view });
  }

  private async copy(entry: CardEntry): Promise<void> {
    try {
      await navigator.clipboard.writeText(entry.copyText);
      this.host.notify(entry.model.kind === 'diff' ? 'Diff copied' : 'Status copied');
    } catch (e) {
      console.error('[native-output] copy failed:', e);
      this.host.notify('Copy failed');
    }
  }

  private target(): CardEntry | null {
    if (this.terminal.buffer.active.type !== 'normal') return null;
    const viewportY = this.terminal.buffer.active.viewportY;
    for (let i = this.cards.length - 1; i >= 0; i--) {
      const entry = this.cards[i];
      const top = entry.block.start.line - viewportY;
      if (visible(top, rawRows(entry.block), this.terminal.rows)) return entry;
    }
    return null;
  }

  private ensureRoot(): HTMLElement | null {
    if (this.root) return this.root;
    const screen = this.terminal.element?.querySelector<HTMLElement>('.xterm-screen');
    if (!screen) return null;
    screen.dataset.kryptonNative = String(this.scopeId);
    this.root = document.createElement('div');
    this.root.className = 'krypton-native-output';
    this.hideSheet = document.createElement('style');
    this.root.appendChild(this.hideSheet);
    screen.appendChild(this.root);
    return this.root;
  }

  /** Place every card from its markers. Runs per xterm render, so it reads
   *  inline styles only (no layout) and writes only what moved. */
  private layout(): void {
    const root = this.root;
    if (!root) return;
    const active = this.terminal.buffer.active;
    const alt = active.type === 'alternate';
    if (alt !== this.alt) {
      this.alt = alt;
      root.classList.toggle('krypton-native-output--alt', alt);
    }
    if (alt || this.cards.length === 0) {
      this.hideRows([]);
      return;
    }
    const rows = this.terminal.rows;
    // xterm keeps the CSS canvas size inline on `.xterm-screen`.
    const screenHeight = Number.parseFloat(root.parentElement?.style.height ?? '');
    const cellH = rows > 0 ? screenHeight / rows : 0;
    if (!(cellH > 0)) return;
    if (cellH !== this.cellH) {
      this.cellH = cellH;
      root.style.setProperty('--krypton-native-cell-h', `${cellH}px`);
      root.style.setProperty('--krypton-native-font', this.terminal.options.fontFamily ?? 'monospace');
      root.style.setProperty('--krypton-native-font-size', `${this.terminal.options.fontSize ?? 13}px`);
    }
    const hidden: Array<readonly [number, number]> = [];
    for (const entry of this.cards) {
      const n = rawRows(entry.block);
      const top = entry.block.start.line - active.viewportY;
      if (!visible(top, n, rows)) {
        entry.card.place(null);
        continue;
      }
      // The bar rides the first visible row once the block's top scrolls off.
      const barTop = top < 0 ? Math.min(-top, n - 1) * cellH : 0;
      entry.card.place({ top: top * cellH, height: n * cellH, barTop });
      if (entry.view === 'native') hidden.push([Math.max(top, 0) + 1, Math.min(top + n, rows)]);
    }
    this.hideRows(hidden);
  }

  /**
   * Hide the raw rows under Native cards — 1-based viewport rows, which are
   * the DOM renderer's `.xterm-rows` children in order. One rule per card,
   * rewritten only when the set changes; Selection and Hint mode (the
   * `--suspended` root class) show them again because they paint on them.
   */
  private hideRows(ranges: ReadonlyArray<readonly [number, number]>): void {
    const key = ranges.map(([from, to]) => `${from}-${to}`).join(',');
    if (key === this.hiddenKey || !this.hideSheet) return;
    this.hiddenKey = key;
    const scope = `:root:not(.krypton-native-output--suspended) .xterm-screen[data-krypton-native="${this.scopeId}"] .xterm-rows > div`;
    this.hideSheet.textContent = ranges
      .map(([from, to]) => `${scope}:nth-child(n+${from}):nth-child(-n+${to}) { visibility: hidden; }`)
      .join('\n');
  }
}

function visible(top: number, rows: number, viewportRows: number): boolean {
  return rows > 0 && top < viewportRows && top + rows > 0;
}

/**
 * Up to `limit` logical lines of a block's output (wrapped rows joined). A row
 * that continues on the next keeps its trailing blanks; `D` mid-row means the
 * last row holds output up to the cursor column only.
 */
function blockLines(buffer: IBuffer, block: CommandBlock, limit: number): string[] {
  const end = block.end.line;
  const last = block.endCol > 0 ? end : end - 1;
  const lines: string[] = [];
  for (let row = block.start.line; row <= last; row++) {
    const line = buffer.getLine(row);
    if (!line) continue;
    const continues = buffer.getLine(row + 1)?.isWrapped === true && row < last;
    const text = row === end ? line.translateToString(true, 0, block.endCol) : line.translateToString(!continues);
    if (line.isWrapped && lines.length > 0) {
      lines[lines.length - 1] += text;
    } else {
      if (lines.length >= limit) break;
      lines.push(text);
    }
  }
  return lines;
}

/** Selection and Hint mode paint on raw cells, so cards hide while they run;
 *  Compositor mode shows the bars of Raw cards so `Leader i` has a target. */
export function syncNativeOutputMode(mode: { suspended: boolean; leader: boolean }): void {
  const root = document.documentElement.classList;
  root.toggle('krypton-native-output--suspended', mode.suspended);
  root.toggle('krypton-native-output--leader', mode.leader);
}
