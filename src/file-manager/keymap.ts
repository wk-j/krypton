// Krypton — File Manager normal-mode keymap (spec 317, extension point B).
//
// Add a key: if the action is new, add a method to `KeyCtx` and implement it in
// view.ts; append a `KeyBinding` to `NORMAL_KEYMAP`; add the row to the
// docs/0052 key table. keymap.test.ts fails on a key that is bound twice.

import type { FileManagerState } from './state';

export interface ChordTracker {
  /** True if `key` was armed less than `withinMs` ago. */
  pending(key: string, withinMs: number): boolean;
  arm(key: string): void;
  clear(): void;
}

/** The vim-style `gg` tracker (`lastKey` + `lastKeyTime` in the old view). */
export class KeyChord implements ChordTracker {
  private lastKey = '';
  private lastKeyTime = 0;

  pending(key: string, withinMs: number): boolean {
    return this.lastKey === key && Date.now() - this.lastKeyTime < withinMs;
  }

  arm(key: string): void {
    this.lastKey = key;
    this.lastKeyTime = Date.now();
  }

  clear(): void {
    this.lastKey = '';
  }
}

/** Everything a normal-mode command may do. Implemented by FileManagerView; faked in tests. */
export interface KeyCtx {
  readonly state: Readonly<FileManagerState>;
  readonly chord: ChordTracker;
  moveCursor(delta: number): void;
  /** `reset-scroll`: offset = 0 (gg). `clamp`: clampScroll (G). */
  jumpTo(index: number, mode: 'reset-scroll' | 'clamp'): void;
  enterSelected(): void;
  goParent(): void;
  goHome(): void;
  goBack(): void;
  scrollPreview(delta: number): void;
  resizeSplit(delta: number): void;
  openPreview(): void;
  togglePreview(): void;
  startFilter(): void;
  startSearch(): void;
  close(): void;
  clearMarks(): void;
  toggleMark(): void;
  toggleMarkAll(): void;
  toggleHidden(): void;
  cycleSort(): void;
  reverseSort(): void;
  yank(op: 'copy' | 'cut'): void;
  paste(): void;
  deleteSelection(): void;
  rename(): void;
  promptCreateFile(): void;
  promptCreateDir(): void;
  copyPath(): void;
  track(): void;
  openTrackedDiff(): void;
  openAI(): void;
}

export interface KeyBinding {
  /** Stable handle for tests and docs, e.g. `cursor.down`. */
  readonly id: string;
  /** `KeyboardEvent.key` values. */
  readonly keys: readonly string[];
  /** One line, for docs/0052 and a future help overlay. */
  readonly help: string;
  /** Return `false` to report "unhandled". */
  run(ctx: KeyCtx, e: KeyboardEvent): boolean | void;
}

export const GG_CHORD_MS = 500;

export const NORMAL_KEYMAP: readonly KeyBinding[] = [
  { id: 'cursor.down', keys: ['j', 'ArrowDown'], help: 'Move cursor down', run: (c) => c.moveCursor(1) },
  { id: 'cursor.up', keys: ['k', 'ArrowUp'], help: 'Move cursor up', run: (c) => c.moveCursor(-1) },
  { id: 'enter', keys: ['l', 'Enter'], help: 'Enter directory / preview file', run: (c) => c.enterSelected() },
  { id: 'parent', keys: ['h', 'Backspace'], help: 'Go to parent directory', run: (c) => c.goParent() },
  {
    id: 'cursor.top',
    keys: ['g'],
    help: 'gg: jump to top',
    run: (c) => {
      if (c.chord.pending('g', GG_CHORD_MS)) {
        c.jumpTo(0, 'reset-scroll');
        c.chord.clear();
        return;
      }
      c.chord.arm('g');
    },
  },
  { id: 'preview.scroll-down', keys: ['J'], help: 'Scroll preview down', run: (c) => c.scrollPreview(80) },
  { id: 'preview.scroll-up', keys: ['K'], help: 'Scroll preview up', run: (c) => c.scrollPreview(-80) },
  { id: 'split.narrow', keys: ['H'], help: 'Narrow the list column', run: (c) => c.resizeSplit(-5) },
  { id: 'split.widen', keys: ['L'], help: 'Widen the list column', run: (c) => c.resizeSplit(5) },
  {
    id: 'cursor.bottom',
    keys: ['G'],
    help: 'Jump to bottom',
    run: (c) => c.jumpTo(Math.max(0, c.state.filtered.length - 1), 'clamp'),
  },
  {
    id: 'page.down',
    keys: ['d'],
    help: 'Ctrl+d: half page down',
    run: (c, e) => {
      if (!e.ctrlKey) return false;
      c.moveCursor(Math.floor(c.state.visibleRows / 2));
    },
  },
  {
    id: 'page.up',
    keys: ['u'],
    help: 'Ctrl+u: half page up',
    run: (c, e) => {
      if (!e.ctrlKey) return false;
      c.moveCursor(-Math.floor(c.state.visibleRows / 2));
    },
  },
  { id: 'filter', keys: ['/'], help: 'Filter by name', run: (c) => c.startFilter() },
  { id: 'close', keys: ['q'], help: 'Close the file manager', run: (c) => c.close() },
  { id: 'marks.clear', keys: ['Escape'], help: 'Clear marks', run: (c) => c.clearMarks() },
  { id: 'hidden.toggle', keys: ['.'], help: 'Toggle hidden files', run: (c) => c.toggleHidden() },
  {
    id: 'sort',
    // quirk P4: `S` is not bound — shift+s arrives as `e.key === 'S'`.
    keys: ['s'],
    help: 's: cycle sort field (name → size → modified); shift+s: reverse order',
    run: (c, e) => (e.shiftKey ? c.reverseSort() : c.cycleSort()),
  },
  { id: 'mark.toggle', keys: [' '], help: 'Toggle mark and move down', run: (c) => c.toggleMark() },
  { id: 'mark.all', keys: ['v'], help: 'Mark / unmark all', run: (c) => c.toggleMarkAll() },
  { id: 'yank', keys: ['y'], help: 'Yank (copy) marked or current', run: (c) => c.yank('copy') },
  { id: 'cut', keys: ['x'], help: 'Cut marked or current', run: (c) => c.yank('cut') },
  { id: 'delete', keys: ['D'], help: 'Delete marked or current (confirm y/N)', run: (c) => c.deleteSelection() },
  { id: 'rename', keys: ['r'], help: 'Rename current', run: (c) => c.rename() },
  { id: 'new.file', keys: ['A'], help: 'Create file', run: (c) => c.promptCreateFile() },
  { id: 'new.dir', keys: ['M'], help: 'Create directory', run: (c) => c.promptCreateDir() },
  { id: 'home', keys: ['~'], help: 'Go to home directory', run: (c) => c.goHome() },
  { id: 'back', keys: ['-'], help: 'Go back in history', run: (c) => c.goBack() },
  { id: 'paste', keys: ['p'], help: 'Paste clipboard into the current directory', run: (c) => c.paste() },
  { id: 'preview.open', keys: ['o'], help: 'Open preview for the current file', run: (c) => c.openPreview() },
  { id: 'preview.toggle', keys: ['w'], help: 'Show / hide the preview pane', run: (c) => c.togglePreview() },
  { id: 'path.copy', keys: ['Y'], help: 'Copy the absolute path to the clipboard', run: (c) => c.copyPath() },
  { id: 'ai', keys: ['i'], help: 'Open the AI assistant', run: (c) => c.openAI() },
  { id: 'track', keys: ['t'], help: 'Track marked or current file as a diff baseline', run: (c) => c.track() },
  { id: 'track.diff', keys: ['T'], help: 'Open the diff against tracked baselines', run: (c) => c.openTrackedDiff() },
  { id: 'search', keys: ['f'], help: 'Fuzzy-search files under the start directory', run: (c) => c.startSearch() },
];

/**
 * A matched binding returns `run() !== false` and never touches the chord
 * (quirk P3). An unmatched key clears the chord (unless it is `g`) and returns
 * false.
 */
export function dispatchNormalKey(map: readonly KeyBinding[], ctx: KeyCtx, e: KeyboardEvent): boolean {
  const binding = map.find((b) => b.keys.includes(e.key));
  if (binding) return binding.run(ctx, e) !== false;
  if (e.key !== 'g') ctx.chord.clear();
  return false;
}
