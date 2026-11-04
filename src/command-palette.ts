// Krypton — Commands scope of the Search Palette (spec 349)
// Fuzzy-searchable list of every action in Krypton, plus the focused view's
// contextual actions. `Cmd+Shift+P` opens the Search Palette on this tab; the
// overlay itself lives in search-palette.ts.

import { invoke } from './profiler/ipc';
import { Compositor } from './compositor';
import { LayoutMode, type DashboardShortcut } from './types';
import type {
  AcceptControl,
  AcceptHow,
  PaletteAction,
  PaletteContext,
  PaletteSection,
  ScopeHint,
  ScopeQueryResult,
  ScopeRow,
  SearchScope,
} from './palette-types';
import { paletteIcon } from './palette-icons';
import type { WorkspaceFooter } from './workspace-footer';

/**
 * Fuzzy subsequence match.
 * Returns null if no match, otherwise a score and the matched character indices.
 * Higher score = better match. Favors:
 *   - Consecutive character runs
 *   - Matches at word boundaries
 *   - Matches near the start of the string
 */
function fuzzyMatch(query: string, target: string): { score: number; matchIndices: number[] } | null {
  const queryLower = query.toLowerCase();
  const targetLower = target.toLowerCase();

  if (queryLower.length === 0) return { score: 0, matchIndices: [] };
  if (queryLower.length > targetLower.length) return null;

  const matchIndices: number[] = [];
  let qi = 0;
  let score = 0;
  let lastMatchIdx = -2;

  for (let ti = 0; ti < targetLower.length && qi < queryLower.length; ti++) {
    if (targetLower[ti] === queryLower[qi]) {
      matchIndices.push(ti);

      // Consecutive bonus
      if (ti === lastMatchIdx + 1) {
        score += 10;
      }

      // Word boundary bonus (start of string, after space/separator)
      if (ti === 0 || /[\s_\-/]/.test(target[ti - 1])) {
        score += 8;
      }

      // Proximity to start bonus
      score += Math.max(0, 5 - ti);

      // Exact case match bonus
      if (target[ti] === query[qi]) {
        score += 1;
      }

      lastMatchIdx = ti;
      qi++;
    }
  }

  // All query characters must match
  if (qi < queryLower.length) return null;

  return { score, matchIndices };
}

/** A command row: one action plus the label indices the query matched. */
class ActionRow implements ScopeRow {
  readonly section?: PaletteSection;

  constructor(
    readonly action: PaletteAction,
    private readonly matchIndices: readonly number[],
  ) {
    this.section = action.section;
  }

  render(el: HTMLElement): void {
    el.classList.add('krypton-search-palette__row--action');
    el.appendChild(paletteIcon(this.action.icon));

    const category = document.createElement('span');
    category.className = 'krypton-search-palette__category';
    category.textContent = this.action.category;
    el.appendChild(category);

    if (this.action.swatch !== undefined) {
      const swatch = document.createElement('span');
      swatch.className = 'krypton-search-palette__swatch';
      swatch.style.background = this.action.swatch;
      el.appendChild(swatch);
    }

    const label = document.createElement('span');
    label.className = 'krypton-search-palette__label';
    const matchSet = new Set(this.matchIndices);
    for (let ci = 0; ci < this.action.label.length; ci++) {
      if (matchSet.has(ci)) {
        const mark = document.createElement('mark');
        mark.textContent = this.action.label[ci];
        label.appendChild(mark);
      } else {
        label.appendChild(document.createTextNode(this.action.label[ci]));
      }
    }
    el.appendChild(label);

    const key = document.createElement('span');
    key.className = 'krypton-search-palette__key';
    key.textContent = this.action.keybinding ?? '';
    el.appendChild(key);
  }
}

export class CommandScope implements SearchScope {
  readonly id = 'commands' as const;
  readonly label = 'Commands';
  readonly shortcut = '⇧⌘P';
  readonly prompt = '>';
  readonly placeholder = 'Type a command…';
  readonly hints: readonly ScopeHint[] = [
    { text: '↵ run' },
    { text: '⌥1–9 pick' },
    { text: '⇥ next tab' },
    { text: '⎋ close' },
  ];

  private compositor: Compositor;
  private workspaceFooter: WorkspaceFooter | null = null;
  private staticActions: PaletteAction[] = [];
  private actions: PaletteAction[] = [];
  private invalidate: (() => void) | null = null;

  /** Cached color themes (refreshed each time the tab activates) */
  private colorThemes: string[] = [];
  private activeColorTheme = '';

  constructor(compositor: Compositor) {
    this.compositor = compositor;
    this.registerActions();
  }

  setWorkspaceFooter(footer: WorkspaceFooter): void {
    this.workspaceFooter = footer;
  }

  setInvalidate(cb: () => void): void {
    this.invalidate = cb;
  }

  aside(): string {
    return '';
  }

  reset(): void {
    // Actions are rebuilt on every activate(); nothing is kept per open.
  }

  async activate(): Promise<void> {
    // Static + dynamic actions, and the focused view's Context section.
    this.rebuildActions();
    void this.refreshColorThemes();
  }

  async query(q: string): Promise<ScopeQueryResult> {
    const rows = this.filter(q.trim());
    const status = rows.length === 0
      ? 'no matches'
      : `${rows.length} command${rows.length === 1 ? '' : 's'}`;
    return { rows, status, pending: false };
  }

  async accept(row: ScopeRow, how: AcceptHow, ctl: AcceptControl): Promise<void> {
    if (how !== 'primary' || !(row instanceof ActionRow)) return;
    const action = row.action;

    // Close first: an action may open another overlay and set its own mode.
    ctl.playExecute();
    ctl.close();

    // Visual ack on the focused window's titlebar — silent confirmation that
    // the palette commit landed. See docs/0104-chrome-signal-upgrades.md.
    this.compositor.flashAck();

    let result: unknown;
    try {
      result = action.execute();
    } catch (err) {
      console.error(`[CommandScope] Action "${action.id}" threw:`, err);
      return;
    }
    if (result instanceof Promise) {
      result.catch((err) => console.error(`[CommandScope] Action "${action.id}" rejected:`, err));
    }
  }

  /** Empty query: every action in order. Otherwise fuzzy-match the label, or
   *  "Category: Label", and sort by score. */
  private filter(query: string): ActionRow[] {
    if (query.length === 0) {
      return this.actions.map((action) => new ActionRow(action, []));
    }

    const scored: Array<{ row: ActionRow; score: number }> = [];
    for (const action of this.actions) {
      const labelMatch = fuzzyMatch(query, action.label);
      const fullMatch = fuzzyMatch(query, `${action.category}: ${action.label}`);

      // Take the better match; label indices only highlight when the label won.
      const match = labelMatch && fullMatch
        ? (labelMatch.score >= fullMatch.score ? labelMatch : null)
        : labelMatch;
      const bestMatch = match ?? fullMatch;

      if (bestMatch) {
        scored.push({
          row: new ActionRow(action, match ? bestMatch.matchIndices : []),
          score: bestMatch.score,
        });
      }
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.map((s) => s.row);
  }

  // ─── Action Registry ──────────────────────────────────────────────

  private registerActions(): void {
    const c = this.compositor;

    // ── Window actions ──
    this.register({
      id: 'window.create',
      label: 'New Window',
      category: 'Window',
      icon: 'square-plus',
      keybinding: 'Leader n',
      execute: () => c.createWindow(),
    });
    this.register({
      id: 'window.close',
      label: 'Close Window',
      category: 'Window',
      icon: 'x',
      keybinding: 'Leader x',
      execute: () => {
        const id = c.focusedId;
        if (id) {
          c.closeWindow(id).then(() => {
            if (c.windowCount === 0) c.createWindow();
          });
        }
      },
    });
    this.register({
      id: 'window.maximize',
      label: 'Toggle Maximize',
      category: 'Window',
      icon: 'maximize-2',
      keybinding: 'Leader z',
      execute: () => c.toggleMaximize(),
    });
    this.register({
      id: 'window.pin',
      label: 'Toggle Pin',
      category: 'Window',
      icon: 'pin',
      keybinding: 'Leader p',
      execute: () => c.togglePin(),
    });
    this.register({
      id: 'window.focus-left',
      label: 'Focus Left',
      category: 'Window',
      icon: 'arrow-left',
      keybinding: 'Leader h',
      execute: () => c.focusDirection('left'),
    });
    this.register({
      id: 'window.focus-right',
      label: 'Focus Right',
      category: 'Window',
      icon: 'arrow-right',
      keybinding: 'Leader l',
      execute: () => c.focusDirection('right'),
    });
    this.register({
      id: 'window.focus-up',
      label: 'Focus Up',
      category: 'Window',
      icon: 'arrow-up',
      keybinding: 'Leader k',
      execute: () => c.focusDirection('up'),
    });
    this.register({
      id: 'window.focus-down',
      label: 'Focus Down',
      category: 'Window',
      icon: 'arrow-down',
      keybinding: 'Leader j',
      execute: () => c.focusDirection('down'),
    });

    // ── Workspace footer actions ──
    this.register({
      id: 'workspace.footer.toggle-density',
      label: 'Toggle Workspace Footer Detail',
      category: 'Workspace',
      icon: 'list',
      keybinding: 'Leader ?',
      execute: () => this.workspaceFooter?.toggleDensity(),
    });
    this.register({
      id: 'workspace.footer.toggle-visible',
      label: 'Toggle Workspace Footer',
      category: 'Workspace',
      icon: 'panel-bottom',
      execute: () => this.workspaceFooter?.toggleVisible(),
    });
    this.register({
      id: 'workspace.keyboard-overlay.toggle',
      label: 'Toggle Keyboard Overlay',
      category: 'Workspace',
      icon: 'keyboard',
      keybinding: 'Leader Shift+K',
      execute: () => c.toggleKeyboardOverlay(),
    });

    this.register({
      id: 'window.focus-next',
      label: 'Focus Next',
      category: 'Window',
      icon: 'chevrons-right',
      keybinding: 'Cmd+Shift+>',
      execute: () => c.focusCycle(1),
    });
    this.register({
      id: 'window.focus-prev',
      label: 'Focus Previous',
      category: 'Window',
      icon: 'chevrons-left',
      keybinding: 'Cmd+Shift+<',
      execute: () => c.focusCycle(-1),
    });

    // ── Layout actions ──
    this.register({
      id: 'layout.toggle',
      label: 'Cycle Layout (Grid/Focus/Depth/Scroll/Stage/Wheel)',
      category: 'Layout',
      icon: 'repeat',
      keybinding: 'Leader f',
      execute: () => c.toggleFocusLayout(),
    });
    this.register({
      id: 'layout.scroll',
      label: 'Layout: Scroll',
      category: 'Layout',
      icon: 'gallery-horizontal',
      execute: () => c.applyLayoutMode(LayoutMode.Scroll),
    });
    this.register({
      id: 'layout.grid',
      label: 'Layout: Grid',
      category: 'Layout',
      icon: 'layout-grid',
      execute: () => c.applyLayoutMode(LayoutMode.Grid),
    });
    this.register({
      id: 'layout.focus',
      label: 'Layout: Focus',
      category: 'Layout',
      icon: 'layout-panel-left',
      execute: () => c.applyLayoutMode(LayoutMode.Focus),
    });
    this.register({
      id: 'layout.depth',
      label: 'Layout: Depth',
      category: 'Layout',
      icon: 'layers',
      execute: () => c.applyLayoutMode(LayoutMode.Depth),
    });
    this.register({
      id: 'layout.stage',
      label: 'Layout: Stage',
      category: 'Layout',
      icon: 'gallery-horizontal-end',
      execute: () => c.applyLayoutMode(LayoutMode.Stage),
    });
    this.register({
      id: 'layout.wheel',
      label: 'Layout: Wheel',
      category: 'Layout',
      icon: 'orbit',
      execute: () => c.applyLayoutMode(LayoutMode.Wheel),
    });

    // ── Tab actions ──
    this.register({
      id: 'tab.create',
      label: 'New Tab',
      category: 'Tab',
      icon: 'plus',
      keybinding: 'Leader t',
      execute: () => c.createTab(),
    });
    this.register({
      id: 'tab.close',
      label: 'Close Tab',
      category: 'Tab',
      icon: 'x',
      keybinding: 'Leader w',
      execute: () => c.closeTab(),
    });
    this.register({
      id: 'tab.next',
      label: 'Next Tab',
      category: 'Tab',
      icon: 'chevrons-right',
      keybinding: 'Leader ]',
      execute: () => c.switchTab(1),
    });
    this.register({
      id: 'tab.prev',
      label: 'Previous Tab',
      category: 'Tab',
      icon: 'chevrons-left',
      keybinding: 'Leader [',
      execute: () => c.switchTab(-1),
    });

    // ── Pane actions ──
    this.register({
      id: 'pane.split-vertical',
      label: 'Split Vertical',
      category: 'Pane',
      icon: 'columns-2',
      keybinding: 'Leader \\',
      execute: () => c.splitPane('vertical'),
    });
    this.register({
      id: 'pane.split-horizontal',
      label: 'Split Horizontal',
      category: 'Pane',
      icon: 'rows-2',
      keybinding: 'Leader -',
      execute: () => c.splitPane('horizontal'),
    });
    this.register({
      id: 'pane.close',
      label: 'Close Pane',
      category: 'Pane',
      icon: 'x',
      keybinding: 'Leader Alt+x',
      execute: () => c.closePane(),
    });
    this.register({
      id: 'pane.focus-left',
      label: 'Focus Pane Left',
      category: 'Pane',
      icon: 'arrow-left',
      keybinding: 'Leader Alt+h',
      execute: () => c.focusPaneDirection('left'),
    });
    this.register({
      id: 'pane.focus-right',
      label: 'Focus Pane Right',
      category: 'Pane',
      icon: 'arrow-right',
      keybinding: 'Leader Alt+l',
      execute: () => c.focusPaneDirection('right'),
    });
    this.register({
      id: 'pane.focus-up',
      label: 'Focus Pane Up',
      category: 'Pane',
      icon: 'arrow-up',
      keybinding: 'Leader Alt+k',
      execute: () => c.focusPaneDirection('up'),
    });
    this.register({
      id: 'pane.focus-down',
      label: 'Focus Pane Down',
      category: 'Pane',
      icon: 'arrow-down',
      keybinding: 'Leader Alt+j',
      execute: () => c.focusPaneDirection('down'),
    });
    this.register({
      id: 'pane.cycle-next',
      label: 'Next Pane',
      category: 'Pane',
      icon: 'chevrons-right',
      keybinding: 'Cmd+]',
      execute: () => c.cyclePaneFocus(1),
    });
    this.register({
      id: 'pane.cycle-prev',
      label: 'Previous Pane',
      category: 'Pane',
      icon: 'chevrons-left',
      keybinding: 'Cmd+[',
      execute: () => c.cyclePaneFocus(-1),
    });
    // spec 296: open-to-side and split ratios.
    this.register({
      id: 'pane.markdown-to-side',
      label: 'Markdown Viewer To Side',
      category: 'Pane',
      icon: 'panel-right',
      keybinding: 'Leader O',
      execute: () => c.openToSide({ kind: 'markdown' }),
    });
    this.register({
      id: 'pane.split-grow-left',
      label: 'Move Split Divider Left',
      category: 'Pane',
      icon: 'arrow-left-from-line',
      keybinding: 'Leader r Shift+H',
      execute: () => c.resizeFocusedSplit('left'),
    });
    this.register({
      id: 'pane.split-grow-right',
      label: 'Move Split Divider Right',
      category: 'Pane',
      icon: 'arrow-right-from-line',
      keybinding: 'Leader r Shift+L',
      execute: () => c.resizeFocusedSplit('right'),
    });
    this.register({
      id: 'pane.split-grow-up',
      label: 'Move Split Divider Up',
      category: 'Pane',
      icon: 'arrow-up-from-line',
      keybinding: 'Leader r Shift+K',
      execute: () => c.resizeFocusedSplit('up'),
    });
    this.register({
      id: 'pane.split-grow-down',
      label: 'Move Split Divider Down',
      category: 'Pane',
      icon: 'arrow-down-from-line',
      keybinding: 'Leader r Shift+J',
      execute: () => c.resizeFocusedSplit('down'),
    });
    this.register({
      id: 'pane.split-equalize',
      label: 'Even Split',
      category: 'Pane',
      icon: 'scale',
      keybinding: 'Leader r =',
      execute: () => c.equalizeFocusedSplit(),
    });

    // ── Terminal actions ──
    this.register({
      id: 'terminal.quick-toggle',
      label: 'Toggle Quick Terminal',
      category: 'Terminal',
      icon: 'square-terminal',
      keybinding: 'Cmd+I',
      execute: () => c.toggleQuickTerminal(),
    });
    this.register({
      id: 'terminal.scroll-up',
      label: 'Scroll Up',
      category: 'Terminal',
      icon: 'arrow-up-to-line',
      keybinding: 'Ctrl+Shift+U',
      execute: () => c.scrollPages(-1),
    });
    this.register({
      id: 'terminal.scroll-down',
      label: 'Scroll Down',
      category: 'Terminal',
      icon: 'arrow-down-to-line',
      keybinding: 'Ctrl+Shift+D',
      execute: () => c.scrollPages(1),
    });

    // ── Diff View ──
    this.register({
      id: 'diff.open',
      label: 'Open Diff View',
      category: 'Window',
      icon: 'diff',
      keybinding: 'Leader d',
      execute: () => c.openDiffView(),
    });
    this.register({
      id: 'diff.open-staged',
      label: 'Open Diff View (Staged)',
      category: 'Window',
      icon: 'diff',
      keybinding: 'Leader D',
      execute: () => c.openDiffView({ staged: true }),
    });
    this.register({
      id: 'terminal.native-output.toggle',
      label: 'Toggle Native / Raw Command Output',
      category: 'Terminal',
      icon: 'toggle-left',
      keybinding: 'Leader i',
      execute: () => c.toggleNativeOutput(),
    });
    this.register({
      id: 'terminal.native-output.copy',
      label: 'Copy Native Command Output',
      category: 'Terminal',
      icon: 'copy',
      keybinding: 'Leader I',
      execute: () => c.copyNativeOutput(),
    });

    // ── AI Agent ──
    this.register({
      id: 'agent.open',
      label: 'Open AI Agent Window',
      category: 'Window',
      icon: 'sparkles',
      keybinding: 'Leader a',
      execute: () => c.openAgentView(),
    });

    // ── ACP Harness ──
    this.register({
      id: 'acp.live-assist.toggle',
      label: 'Toggle Harness Live Assist',
      category: 'ACP',
      icon: 'picture-in-picture-2',
      keybinding: 'Ctrl+Shift+I',
      execute: () => invoke('live_assist_toggle'),
    });
    this.register({
      id: 'acp.peek.show',
      label: 'ACP: Show Lane Peek',
      category: 'ACP',
      icon: 'eye',
      execute: () => c.showAcpLanePeek(),
    });
    this.register({
      id: 'acp.peek.hide',
      label: 'ACP: Hide Lane Peek',
      category: 'ACP',
      icon: 'eye-off',
      execute: () => c.hideAcpLanePeek(),
    });
    this.register({
      id: 'acp.peek.next',
      label: 'ACP: Peek Next Lane',
      category: 'ACP',
      icon: 'chevrons-right',
      execute: () => c.peekAcpLaneByDelta(1),
    });
    this.register({
      id: 'acp.peek.prev',
      label: 'ACP: Peek Previous Lane',
      category: 'ACP',
      icon: 'chevrons-left',
      execute: () => c.peekAcpLaneByDelta(-1),
    });
    this.register({
      id: 'acp.peek.activate',
      label: 'ACP: Activate Peeked Lane',
      category: 'ACP',
      icon: 'corner-down-left',
      execute: () => c.activateAcpPeekedLane(),
    });
    this.register({
      id: 'acp.peek.unlock',
      label: 'ACP: Unlock Lane Peek',
      category: 'ACP',
      icon: 'lock-open',
      execute: () => c.unlockAcpLanePeek(),
    });
    this.register({
      id: 'acp.peek.heat.metric',
      label: 'ACP: Cycle Peek Heat Metric',
      category: 'ACP',
      icon: 'flame',
      execute: () => c.cycleAcpPeekHeatMetric(),
    });
    this.register({
      id: 'acp.peek.heat.window',
      label: 'ACP: Cycle Peek Heat Window',
      category: 'ACP',
      icon: 'clock',
      execute: () => c.cycleAcpPeekHeatWindow(),
    });
    this.register({
      id: 'acp.peek.heat.detail',
      label: 'ACP: Toggle Peek Heat Detail',
      category: 'ACP',
      icon: 'list',
      execute: () => c.toggleAcpPeekHeatDetail(),
    });

    // ── Markdown Viewer ──
    this.register({
      id: 'markdown.open',
      label: 'Open Markdown Viewer',
      category: 'Window',
      icon: 'file-text',
      keybinding: 'Leader o',
      execute: () => c.openMarkdownView(),
    });

    // ── Daily (specs 223, 225) — opens an existing day; `#daily` writes one ──
    this.register({
      id: 'daily.open',
      label: 'Open Today',
      category: 'Window',
      icon: 'calendar',
      keybinding: 'Leader J',
      execute: () => c.openDailyNote(),
    });

    // ── Pencil (Excalidraw) ──
    this.register({
      id: 'pencil.open',
      label: 'Open Pencil (Excalidraw)',
      category: 'Window',
      icon: 'pencil',
      keybinding: 'Leader e',
      execute: () => c.openPencil(),
    });

    // ── Credit Usage ──
    this.register({
      id: 'usage.open',
      label: 'Open Credit Usage',
      category: 'Window',
      icon: 'chart-column',
      keybinding: 'Leader $',
      execute: () => c.openUsageView(),
    });
    this.register({
      id: 'telegram.settings',
      label: 'Open Telegram Controller Settings',
      category: 'Window',
      icon: 'send',
      execute: () => c.openTelegramSettings(),
    });
    this.register({
      id: 'computers.open',
      label: 'Connected Computers…',
      category: 'Window',
      icon: 'monitor',
      execute: () => c.openConnectedComputers(),
    });
    this.register({
      id: 'loopback.home',
      label: 'Open Krypton Home (every browser surface)',
      category: 'Window',
      icon: 'house',
      execute: () => c.openLoopbackHome(),
    });
    this.register({
      id: 'dashboard.open',
      label: 'Open Lane Monitor Dashboard',
      category: 'Window',
      icon: 'activity',
      keybinding: 'Leader Shift+L',
      execute: () => c.openDashboard(),
    });
    this.register({
      id: 'gallery.open',
      label: 'Open Artifact Gallery',
      category: 'Window',
      icon: 'images',
      execute: () => c.openGallery(),
    });
    this.register({
      id: 'genui-gallery.open',
      label: 'Open GenUI Component Gallery',
      category: 'Window',
      icon: 'shapes',
      execute: () => c.openGenUiGallery(),
    });
    this.register({
      id: 'docs.open',
      label: 'Open Docs Browser',
      category: 'Window',
      icon: 'book-open',
      execute: () => c.openDocs(),
    });
    // spec 298: same as the harness `#lessons` command.
    this.register({
      id: 'lessons.open',
      label: 'Open Lessons',
      category: 'ACP',
      icon: 'lightbulb',
      execute: () => c.openLessons(),
    });
    this.register({
      id: 'analyses.open',
      label: 'Open Issue Analysis Viewer',
      category: 'Window',
      icon: 'file-search',
      execute: () => c.openAnalyses(),
    });
    // spec 211: `review.open` WORKS a review (the in-app keyboard Board);
    // `reviews.open` BROWSES them (the read-only archive in the OS browser).
    this.register({
      id: 'review.open',
      label: 'Open Review Board',
      category: 'Window',
      icon: 'clipboard-list',
      keybinding: 'Leader Shift+R',
      execute: () => c.openReviewPicker(),
    });
    this.register({
      id: 'reviews.open',
      label: 'Open Review Board Archive',
      category: 'Window',
      icon: 'archive',
      execute: () => c.openReviews(),
    });
    this.register({
      id: 'termctrl.open',
      label: 'Open Terminal Control Monitor',
      category: 'Window',
      icon: 'radar',
      execute: () => c.openTermctrlMonitor(),
    });
    // spec 288: ACP wire profiler
    this.register({
      id: 'acp-wire.open',
      label: 'ACP Wire: Open Profiler',
      category: 'Window',
      icon: 'cable',
      execute: () => c.openAcpWire(),
    });
    this.register({
      id: 'acp-wire.capture-off',
      label: 'ACP Wire: Capture Off',
      category: 'Window',
      icon: 'circle-off',
      execute: () => c.setAcpWireMode('off'),
    });
    this.register({
      id: 'acp-wire.capture-meta',
      label: 'ACP Wire: Capture Meta',
      category: 'Window',
      icon: 'circle-dashed',
      execute: () => c.setAcpWireMode('meta'),
    });
    this.register({
      id: 'acp-wire.capture-full',
      label: 'ACP Wire: Capture Full',
      category: 'Window',
      icon: 'circle-dot',
      execute: () => c.setAcpWireMode('full'),
    });
    this.register({
      id: 'acp-wire.clear',
      label: 'ACP Wire: Clear',
      category: 'Window',
      icon: 'trash-2',
      execute: () => c.clearAcpWire(),
    });
    // spec 284: OSC 7501 program status
    this.register({
      id: 'program-status.next',
      label: 'Focus Next Program Needing You',
      category: 'Window',
      icon: 'bell-ring',
      keybinding: 'Leader !',
      execute: () => {
        if (!c.focusNextProgramAttention()) console.info('[Palette] no program needs you');
      },
    });

    // ── Hurl Client ──
    this.register({
      id: 'hurl.open',
      label: 'Open Hurl Client',
      category: 'Window',
      icon: 'arrow-right-left',
      keybinding: 'Leader H',
      execute: () => c.openHurlClient(),
    });
    this.register({
      id: 'hurl.open-web',
      label: 'Open Hurl Web Client',
      category: 'Window',
      icon: 'globe',
      execute: () => c.openHurlWebClient(),
    });
    this.register({
      id: 'hurl.clear-cache',
      label: 'Hurl: Clear Cache',
      category: 'Window',
      icon: 'trash-2',
      execute: async () => {
        try {
          await invoke('hurl_clear_cache', { filePath: null });
        } catch (e) {
          console.error('[Krypton] Failed to clear hurl cache:', e);
        }
      },
    });

    // ── SSH actions ──
    this.register({
      id: 'ssh.clone-tab',
      label: 'Clone SSH Session (New Tab)',
      category: 'SSH',
      icon: 'copy-plus',
      keybinding: 'Leader c',
      execute: () => c.cloneSshSession(),
    });
    this.register({
      id: 'ssh.clone-window',
      label: 'Clone SSH Session (New Window)',
      category: 'SSH',
      icon: 'copy-plus',
      keybinding: 'Leader Shift+C',
      execute: () => c.cloneSshSessionToNewWindow(),
    });

    // ── Config actions ──
    this.register({
      id: 'config.reload',
      label: 'Reload Config',
      category: 'Config',
      icon: 'refresh-cw',
      execute: async () => {
        try {
          await this.compositor.reloadConfig();
        } catch (e) {
          console.error('[Krypton] Failed to reload config:', e);
        }
      },
    });

    // ── Claude Code actions ──
    this.register({
      id: 'claude.copy-hook-config',
      label: 'Copy Hook Config to Clipboard',
      category: 'Claude Code',
      icon: 'copy',
      execute: async () => {
        try {
          await invoke<string>('get_hook_server_config_snippet');
        } catch (e) {
          console.error('[Krypton] Failed to get hook config:', e);
        }
      },
    });
    this.register({
      id: 'claude.show-hook-port',
      label: 'Show Hook Server Port',
      category: 'Claude Code',
      icon: 'plug',
      execute: async () => {
        try {
          const port = await invoke<number>('get_hook_server_port');
          console.log(`[Krypton] Hook server port: ${port}`);
        } catch (e) {
          console.error('[Krypton] Hook server not running');
        }
      },
    });
  }

  private register(action: PaletteAction): void {
    this.staticActions.push(action);
  }

  /** Format a dashboard shortcut for display in the palette */
  private formatDashboardShortcut(shortcut: DashboardShortcut): string {
    const parts: string[] = [];
    if (shortcut.ctrl) parts.push('Ctrl');
    if (shortcut.alt) parts.push('Alt');
    if (shortcut.shift) parts.push('Shift');
    if (shortcut.meta) parts.push('Cmd');
    const keyName = shortcut.key.replace('Key', '').replace('Digit', '');
    parts.push(keyName);
    return parts.join('+');
  }

  /**
   * Rebuild the full action list: static actions + dynamic actions
   * based on current compositor state. Called each time the Commands tab activates.
   */
  private rebuildActions(): void {
    const c = this.compositor;

    // Contextual section — focused view contributes via getPaletteActions?
    const ctx: PaletteContext = {
      focusedViewId: c.getFocusedViewId(),
      focusedContentType: c.getFocusedContentType(),
    };
    const focusedView = c.getFocusedPanePublic()?.contentView ?? null;
    let contextual: readonly PaletteAction[] = [];
    try {
      contextual = focusedView?.getPaletteActions?.(ctx) ?? [];
    } catch (e) {
      console.warn('[CommandPalette] getPaletteActions threw:', e);
      contextual = [];
    }
    const contextualTagged: PaletteAction[] = contextual.map((a) => ({
      ...a,
      section: 'context' as const,
    }));

    this.actions = [...contextualTagged, ...this.staticActions];

    // Dynamic: "Unpin: <window label>" for each pinned window
    for (const { id, label } of c.pinnedWindows) {
      this.actions.push({
        id: `window.unpin.${id}`,
        label: `Unpin: ${label}`,
        category: 'Window',
        icon: 'pin-off',
        execute: () => c.togglePin(id),
      });
    }

    // Dynamic: dashboard toggle actions
    for (const dash of c.dashboardManager.registeredDashboards) {
      const shortcutLabel = dash.shortcut
        ? this.formatDashboardShortcut(dash.shortcut)
        : undefined;
      const dashId = dash.id;
      this.actions.push({
        id: `dashboard.${dashId}`,
        label: `Toggle ${dash.title}`,
        category: 'Dashboard',
        icon: 'layout-dashboard',
        keybinding: shortcutLabel,
        execute: () => c.dashboardManager.toggle(dashId),
      });
    }

    // ACP Harness entry points.
    this.actions.push({
      id: 'acp.harness.open',
      label: 'Open ACP Harness',
      category: 'Window',
      icon: 'bot',
      keybinding: 'Leader Shift y',
      execute: () => c.openAcpHarnessView(),
    });
    this.actions.push({
      id: 'acp.harness.open-remote',
      label: 'Open Remote ACP Harness…',
      category: 'Window',
      icon: 'server',
      keybinding: 'Leader Shift s',
      execute: () => c.openRemoteAcpHarnessView(),
    });

    // Dynamic: color theme switching
    for (const themeName of this.colorThemes) {
      const isCurrent = themeName === this.activeColorTheme;
      this.actions.push({
        id: `theme.color.${themeName}`,
        label: `Color Theme: ${themeLabel(themeName)}${isCurrent ? ' (active)' : ''}`,
        category: 'Color Theme',
        icon: 'palette',
        execute: () => {
          void invoke('set_theme', { name: themeName }).catch((e) => {
            console.error('[CommandPalette] set_theme failed:', e);
          });
        },
      });
    }

    // Dynamic: per-window accent color (spec 304). Applies to the focused
    // window; entry 0 follows the active color theme.
    const accentWindowId = c.focusedId;
    const currentAccent = accentWindowId === null ? null : c.pickedAccentName(accentWindowId);
    c.accentOptions().forEach((color, index) => {
      const isCurrent = color.name === currentAccent;
      const suffix = index === 0 ? ' (theme)' : '';
      this.actions.push({
        id: `window.accent.${color.name}`,
        label: `Window Color: ${themeLabel(color.name)}${suffix}${isCurrent ? ' (current)' : ''}`,
        category: 'Window Color',
        icon: 'droplet',
        swatch: color.hex,
        execute: () => {
          const id = c.focusedId;
          if (id === null) {
            console.warn('[CommandPalette] window accent: no focused window');
            return;
          }
          c.setWindowAccentPick(id, color.name);
        },
      });
    });
    this.actions.push({
      id: 'window.accent.auto',
      label: `Window Color: Auto${currentAccent === null ? ' (current)' : ''}`,
      category: 'Window Color',
      icon: 'droplet',
      execute: () => {
        const id = c.focusedId;
        if (id === null) {
          console.warn('[CommandPalette] window accent: no focused window');
          return;
        }
        c.setWindowAccentPick(id, null);
      },
    });

    // Dynamic: sound theme switching
    const soundEngine = c.soundEngine;
    const currentPack = soundEngine.getCurrentPack();
    for (const themeName of soundEngine.getAvailableThemes()) {
      const displayName = soundEngine.getThemeDisplayName(themeName);
      const isCurrent = themeName === currentPack;
      this.actions.push({
        id: `sound.theme.${themeName}`,
        label: `${displayName}${isCurrent ? ' (active)' : ''}`,
        category: 'Sound Theme',
        icon: 'volume-2',
        execute: () => soundEngine.loadTheme(themeName),
      });
    }
  }

  private async refreshColorThemes(): Promise<void> {
    try {
      const [names, cfg] = await Promise.all([
        invoke<string[]>('list_themes'),
        invoke<{ theme?: { name?: string } }>('get_config'),
      ]);
      const active = (cfg.theme?.name ?? '').toLowerCase();
      const same =
        names.length === this.colorThemes.length &&
        names.every((n, i) => n === this.colorThemes[i]) &&
        active === this.activeColorTheme;
      this.colorThemes = names;
      this.activeColorTheme = active;
      if (!same) {
        this.rebuildActions();
        this.invalidate?.();
      }
    } catch (e) {
      console.warn('[CommandPalette] list_themes failed:', e);
    }
  }
}

function themeLabel(name: string): string {
  return name
    .split(/[-_]/g)
    .filter((w) => w.length > 0)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}
