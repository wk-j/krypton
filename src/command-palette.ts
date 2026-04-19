// Krypton — Command Palette
// Fuzzy-searchable overlay listing every action in Krypton.
// Activated by Cmd+Shift+P. Each entry shows the action name and keybinding.

import { invoke } from './profiler/ipc';
import { Compositor } from './compositor';
import type { DashboardShortcut } from './types';

/** A single action in the command palette registry */
interface PaletteAction {
  id: string;
  label: string;
  category: string;
  keybinding?: string;
  execute: () => unknown;
}

/** Fuzzy match result with scoring and match indices */
interface FuzzyResult {
  action: PaletteAction;
  score: number;
  matchIndices: number[];
}

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

export class CommandPalette {
  private overlay: HTMLElement;
  private container: HTMLElement;
  private input: HTMLInputElement;
  private resultsList: HTMLElement;
  private staticActions: PaletteAction[] = [];
  private actions: PaletteAction[] = [];
  private filtered: FuzzyResult[] = [];
  private selectedIndex = 0;
  private visible = false;
  private compositor: Compositor;

  /** Callbacks to notify when the palette opens/closes */
  private onOpenCallbacks: Array<() => void> = [];
  private onCloseCallbacks: Array<() => void> = [];

  constructor(compositor: Compositor) {
    this.compositor = compositor;

    // Build DOM
    this.overlay = document.createElement('div');
    this.overlay.className = 'krypton-palette';

    this.container = document.createElement('div');
    this.container.className = 'krypton-palette__container';

    const inputRow = document.createElement('div');
    inputRow.className = 'krypton-palette__input-row';

    const prompt = document.createElement('span');
    prompt.className = 'krypton-palette__prompt';
    prompt.textContent = '>';

    this.input = document.createElement('input');
    this.input.className = 'krypton-palette__input';
    this.input.type = 'text';
    this.input.placeholder = 'Type a command...';
    this.input.spellcheck = false;
    this.input.autocomplete = 'off';

    inputRow.appendChild(prompt);
    inputRow.appendChild(this.input);

    this.resultsList = document.createElement('div');
    this.resultsList.className = 'krypton-palette__results';

    this.container.appendChild(inputRow);
    this.container.appendChild(this.resultsList);
    this.overlay.appendChild(this.container);
    document.body.appendChild(this.overlay);

    // Wire input events
    this.input.addEventListener('input', () => {
      this.filter();
    });

    // Prevent overlay clicks from propagating (would steal focus from input)
    this.overlay.addEventListener('mousedown', (e) => {
      // If clicking outside the container, close
      if (e.target === this.overlay) {
        this.close();
      }
    });

    // Register all built-in actions
    this.registerActions();
  }

  /** Register a callback for when the palette opens */
  onOpen(cb: () => void): void {
    this.onOpenCallbacks.push(cb);
  }

  /** Register a callback for when the palette closes */
  onClose(cb: () => void): void {
    this.onCloseCallbacks.push(cb);
  }

  /** Whether the palette is currently visible */
  get isVisible(): boolean {
    return this.visible;
  }

  /** Open the palette */
  open(): void {
    if (this.visible) return;
    this.visible = true;
    this.input.value = '';
    this.selectedIndex = 0;
    this.overlay.classList.add('krypton-palette--visible');
    this.compositor.soundEngine.play('command_palette.open');

    for (const cb of this.onOpenCallbacks) cb();

    // Rebuild actions (static + dynamic based on current state)
    this.rebuildActions();

    // Filter with empty query shows all actions
    this.filter();

    // Focus the input after a microtask to ensure DOM is rendered
    requestAnimationFrame(() => {
      this.input.focus();
    });
  }

  /** Close the palette without executing */
  close(): void {
    if (!this.visible) return;
    this.visible = false;
    this.overlay.classList.remove('krypton-palette--visible');
    this.compositor.soundEngine.play('command_palette.close');

    for (const cb of this.onCloseCallbacks) cb();
  }

  /** Toggle open/close */
  toggle(): void {
    if (this.visible) {
      this.close();
    } else {
      this.open();
    }
  }

  /**
   * Handle a keydown event while the palette is open.
   * Returns true if the event was consumed.
   */
  handleKey(e: KeyboardEvent): boolean {
    if (!this.visible) return false;

    switch (e.key) {
      case 'Escape':
        this.close();
        return true;

      case 'ArrowDown':
        e.preventDefault();
        this.selectNext();
        return true;

      case 'ArrowUp':
        e.preventDefault();
        this.selectPrev();
        return true;

      case 'Enter':
        e.preventDefault();
        this.executeSelected();
        return true;

      case 'Tab':
        // Tab acts like ArrowDown, Shift+Tab like ArrowUp
        e.preventDefault();
        if (e.shiftKey) {
          this.selectPrev();
        } else {
          this.selectNext();
        }
        return true;

      default:
        // Let the input handle all other keys (typing, backspace, etc.)
        return false;
    }
  }

  // ─── Private ──────────────────────────────────────────────────────

  private filter(): void {
    const query = this.input.value.trim();

    if (query.length === 0) {
      // Show all actions grouped by category
      this.filtered = this.actions.map((action) => ({
        action,
        score: 0,
        matchIndices: [],
      }));
    } else {
      // Fuzzy match against "category: label" combined string
      this.filtered = [];
      for (const action of this.actions) {
        // Match against label, then fall back to "Category: Label"
        const labelMatch = fuzzyMatch(query, action.label);
        const fullMatch = fuzzyMatch(query, `${action.category}: ${action.label}`);

        // Take the better match
        const match = labelMatch && fullMatch
          ? (labelMatch.score >= fullMatch.score ? labelMatch : null)
          : labelMatch;
        const bestMatch = match ?? fullMatch;

        if (bestMatch) {
          this.filtered.push({
            action,
            score: bestMatch.score,
            matchIndices: match ? bestMatch.matchIndices : [],
          });
        }
      }

      // Sort by score descending
      this.filtered.sort((a, b) => b.score - a.score);
    }

    this.selectedIndex = 0;
    this.renderResults();
  }

  private renderResults(): void {
    this.resultsList.innerHTML = '';

    if (this.filtered.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'krypton-palette__empty';
      empty.textContent = 'No results';
      this.resultsList.appendChild(empty);
      return;
    }

    for (let i = 0; i < this.filtered.length; i++) {
      const { action, matchIndices } = this.filtered[i];

      const item = document.createElement('div');
      item.className = 'krypton-palette__item';
      if (i === this.selectedIndex) {
        item.classList.add('krypton-palette__item--selected');
      }
      item.dataset.index = String(i);

      // Category tag
      const category = document.createElement('span');
      category.className = 'krypton-palette__item-category';
      category.textContent = action.category;

      // Label with highlighted match characters
      const label = document.createElement('span');
      label.className = 'krypton-palette__item-label';

      const matchSet = new Set(matchIndices);
      for (let ci = 0; ci < action.label.length; ci++) {
        if (matchSet.has(ci)) {
          const mark = document.createElement('mark');
          mark.textContent = action.label[ci];
          label.appendChild(mark);
        } else {
          label.appendChild(document.createTextNode(action.label[ci]));
        }
      }

      // Keybinding hint
      const key = document.createElement('span');
      key.className = 'krypton-palette__item-key';
      key.textContent = action.keybinding ?? '';

      item.appendChild(category);
      item.appendChild(label);
      item.appendChild(key);

      // Click to execute
      item.addEventListener('mousedown', (e) => {
        e.preventDefault();
        this.selectedIndex = i;
        this.executeSelected();
      });

      // Hover to select
      item.addEventListener('mouseenter', () => {
        this.selectedIndex = i;
        this.updateSelection();
      });

      this.resultsList.appendChild(item);
    }
  }

  private selectNext(): void {
    if (this.filtered.length === 0) return;
    this.selectedIndex = (this.selectedIndex + 1) % this.filtered.length;
    this.updateSelection();
    this.scrollToSelected();
  }

  private selectPrev(): void {
    if (this.filtered.length === 0) return;
    this.selectedIndex = (this.selectedIndex - 1 + this.filtered.length) % this.filtered.length;
    this.updateSelection();
    this.scrollToSelected();
  }

  private updateSelection(): void {
    const items = this.resultsList.querySelectorAll('.krypton-palette__item');
    items.forEach((el, i) => {
      if (i === this.selectedIndex) {
        el.classList.add('krypton-palette__item--selected');
      } else {
        el.classList.remove('krypton-palette__item--selected');
      }
    });
  }

  private scrollToSelected(): void {
    const items = this.resultsList.querySelectorAll('.krypton-palette__item');
    const selected = items[this.selectedIndex];
    if (selected) {
      selected.scrollIntoView({ block: 'nearest' });
    }
  }

  private executeSelected(): void {
    if (this.filtered.length === 0 || this.selectedIndex >= this.filtered.length) return;

    const action = this.filtered[this.selectedIndex].action;
    this.visible = false;
    this.overlay.classList.remove('krypton-palette--visible');
    this.compositor.soundEngine.play('command_palette.execute');

    for (const cb of this.onCloseCallbacks) cb();

    // Execute the action (may be async)
    const result = action.execute();
    if (result instanceof Promise) {
      result.catch((err) => console.error(`[CommandPalette] Action "${action.id}" failed:`, err));
    }
  }

  // ─── Action Registry ──────────────────────────────────────────────

  private registerActions(): void {
    const c = this.compositor;

    // ── Window actions ──
    this.register({
      id: 'window.create',
      label: 'New Window',
      category: 'Window',
      keybinding: 'Leader n',
      execute: () => c.createWindow(),
    });
    this.register({
      id: 'window.close',
      label: 'Close Window',
      category: 'Window',
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
      keybinding: 'Leader z',
      execute: () => c.toggleMaximize(),
    });
    this.register({
      id: 'window.pin',
      label: 'Toggle Pin',
      category: 'Window',
      keybinding: 'Leader p',
      execute: () => c.togglePin(),
    });
    this.register({
      id: 'window.focus-left',
      label: 'Focus Left',
      category: 'Window',
      keybinding: 'Leader h',
      execute: () => c.focusDirection('left'),
    });
    this.register({
      id: 'window.focus-right',
      label: 'Focus Right',
      category: 'Window',
      keybinding: 'Leader l',
      execute: () => c.focusDirection('right'),
    });
    this.register({
      id: 'window.focus-up',
      label: 'Focus Up',
      category: 'Window',
      keybinding: 'Leader k',
      execute: () => c.focusDirection('up'),
    });
    this.register({
      id: 'window.focus-down',
      label: 'Focus Down',
      category: 'Window',
      keybinding: 'Leader j',
      execute: () => c.focusDirection('down'),
    });
    this.register({
      id: 'window.focus-next',
      label: 'Focus Next',
      category: 'Window',
      keybinding: 'Cmd+Shift+>',
      execute: () => c.focusCycle(1),
    });
    this.register({
      id: 'window.focus-prev',
      label: 'Focus Previous',
      category: 'Window',
      keybinding: 'Cmd+Shift+<',
      execute: () => c.focusCycle(-1),
    });

    // ── Layout actions ──
    this.register({
      id: 'layout.toggle',
      label: 'Toggle Grid/Focus Layout',
      category: 'Layout',
      keybinding: 'Leader f',
      execute: () => c.toggleFocusLayout(),
    });

    // ── Tab actions ──
    this.register({
      id: 'tab.create',
      label: 'New Tab',
      category: 'Tab',
      keybinding: 'Leader t',
      execute: () => c.createTab(),
    });
    this.register({
      id: 'tab.close',
      label: 'Close Tab',
      category: 'Tab',
      keybinding: 'Leader w',
      execute: () => c.closeTab(),
    });
    this.register({
      id: 'tab.next',
      label: 'Next Tab',
      category: 'Tab',
      keybinding: 'Leader ]',
      execute: () => c.switchTab(1),
    });
    this.register({
      id: 'tab.prev',
      label: 'Previous Tab',
      category: 'Tab',
      keybinding: 'Leader [',
      execute: () => c.switchTab(-1),
    });

    // ── Pane actions ──
    this.register({
      id: 'pane.split-vertical',
      label: 'Split Vertical',
      category: 'Pane',
      keybinding: 'Leader \\',
      execute: () => c.splitPane('vertical'),
    });
    this.register({
      id: 'pane.split-horizontal',
      label: 'Split Horizontal',
      category: 'Pane',
      keybinding: 'Leader -',
      execute: () => c.splitPane('horizontal'),
    });
    this.register({
      id: 'pane.close',
      label: 'Close Pane',
      category: 'Pane',
      keybinding: 'Leader Alt+x',
      execute: () => c.closePane(),
    });
    this.register({
      id: 'pane.focus-left',
      label: 'Focus Pane Left',
      category: 'Pane',
      keybinding: 'Leader Alt+h',
      execute: () => c.focusPaneDirection('left'),
    });
    this.register({
      id: 'pane.focus-right',
      label: 'Focus Pane Right',
      category: 'Pane',
      keybinding: 'Leader Alt+l',
      execute: () => c.focusPaneDirection('right'),
    });
    this.register({
      id: 'pane.focus-up',
      label: 'Focus Pane Up',
      category: 'Pane',
      keybinding: 'Leader Alt+k',
      execute: () => c.focusPaneDirection('up'),
    });
    this.register({
      id: 'pane.focus-down',
      label: 'Focus Pane Down',
      category: 'Pane',
      keybinding: 'Leader Alt+j',
      execute: () => c.focusPaneDirection('down'),
    });
    this.register({
      id: 'pane.cycle-next',
      label: 'Next Pane',
      category: 'Pane',
      keybinding: 'Cmd+]',
      execute: () => c.cyclePaneFocus(1),
    });
    this.register({
      id: 'pane.cycle-prev',
      label: 'Previous Pane',
      category: 'Pane',
      keybinding: 'Cmd+[',
      execute: () => c.cyclePaneFocus(-1),
    });

    // ── Terminal actions ──
    this.register({
      id: 'terminal.quick-toggle',
      label: 'Toggle Quick Terminal',
      category: 'Terminal',
      keybinding: 'Cmd+I',
      execute: () => c.toggleQuickTerminal(),
    });
    this.register({
      id: 'terminal.scroll-up',
      label: 'Scroll Up',
      category: 'Terminal',
      keybinding: 'Ctrl+Shift+U',
      execute: () => c.scrollPages(-1),
    });
    this.register({
      id: 'terminal.scroll-down',
      label: 'Scroll Down',
      category: 'Terminal',
      keybinding: 'Ctrl+Shift+D',
      execute: () => c.scrollPages(1),
    });

    // ── Diff View ──
    this.register({
      id: 'diff.open',
      label: 'Open Diff View',
      category: 'Window',
      keybinding: 'Leader d',
      execute: () => c.openDiffView(),
    });
    this.register({
      id: 'diff.open-staged',
      label: 'Open Diff View (Staged)',
      category: 'Window',
      keybinding: 'Leader D',
      execute: () => c.openDiffView({ staged: true }),
    });

    // ── AI Agent ──
    this.register({
      id: 'agent.open',
      label: 'Open AI Agent Window',
      category: 'Window',
      keybinding: 'Leader a',
      execute: () => c.openAgentView(),
    });

    // ── Markdown Viewer ──
    this.register({
      id: 'markdown.open',
      label: 'Open Markdown Viewer',
      category: 'Window',
      keybinding: 'Leader o',
      execute: () => c.openMarkdownView(),
    });

    // ── Hurl Client ──
    this.register({
      id: 'hurl.open',
      label: 'Open Hurl Client',
      category: 'Window',
      keybinding: 'Leader H',
      execute: () => c.openHurlClient(),
    });
    this.register({
      id: 'hurl.clear-cache',
      label: 'Hurl: Clear Cache',
      category: 'Window',
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
      keybinding: 'Leader c',
      execute: () => c.cloneSshSession(),
    });
    this.register({
      id: 'ssh.clone-window',
      label: 'Clone SSH Session (New Window)',
      category: 'SSH',
      keybinding: 'Leader Shift+C',
      execute: () => c.cloneSshSessionToNewWindow(),
    });

    // ── Config actions ──
    this.register({
      id: 'config.reload',
      label: 'Reload Config',
      category: 'Config',
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
   * based on current compositor state. Called each time the palette opens.
   */
  private rebuildActions(): void {
    this.actions = [...this.staticActions];

    const c = this.compositor;

    // Dynamic: "Unpin: <window label>" for each pinned window
    for (const { id, label } of c.pinnedWindows) {
      this.actions.push({
        id: `window.unpin.${id}`,
        label: `Unpin: ${label}`,
        category: 'Window',
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
        keybinding: shortcutLabel,
        execute: () => c.dashboardManager.toggle(dashId),
      });
    }

    // Dynamic: hook toast toggle (shows current state)
    const toastsOn = c.hookToastsVisible;
    this.actions.push({
      id: 'claude.toggle-toasts',
      label: `Hook Toasts: ${toastsOn ? 'ON' : 'OFF'}`,
      category: 'Claude Code',
      execute: () => c.toggleHookToasts(),
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
        execute: () => soundEngine.loadTheme(themeName),
      });
    }
  }
}
