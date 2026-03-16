// Krypton — Dashboard Manager
// Generic overlay dashboard framework. Manages registration, DOM lifecycle,
// show/hide transitions, tabbed content, and keyboard routing for overlay dashboards.

import type { DashboardDefinition, DashboardShortcut } from './types';

/** Callback to enter/exit Dashboard mode in the InputRouter */
type ModeCallback = (active: boolean) => void;

/** Callback to refocus the terminal after a dashboard closes */
type RefocusCallback = () => void;

export class DashboardManager {
  private registry: Map<string, DashboardDefinition> = new Map();
  private activeId: string | null = null;
  private overlay: HTMLElement | null = null;
  private animating = false;

  /** Currently active tab index */
  private activeTab = 0;
  /** Tab bar element (null if single tab) */
  private tabBar: HTMLElement | null = null;
  /** Tab content container */
  private tabContent: HTMLElement | null = null;

  /** Called when a dashboard opens (true) or closes (false) */
  private modeCallback: ModeCallback | null = null;

  /** Called after a dashboard closes to restore terminal focus */
  private refocusCallback: RefocusCallback | null = null;

  /** Set the mode transition callback (wired by InputRouter) */
  onModeChange(cb: ModeCallback): void {
    this.modeCallback = cb;
  }

  /** Set the refocus callback (wired by compositor) */
  onRefocus(cb: RefocusCallback): void {
    this.refocusCallback = cb;
  }

  /** Register a new dashboard. Throws if ID already registered. */
  register(definition: DashboardDefinition): void {
    if (this.registry.has(definition.id)) {
      throw new Error(`Dashboard "${definition.id}" is already registered`);
    }
    this.registry.set(definition.id, definition);
  }

  /** Unregister a dashboard by ID. */
  unregister(id: string): void {
    if (this.activeId === id) {
      this.close();
    }
    this.registry.delete(id);
  }

  /** Toggle a dashboard by ID. Opens if closed, closes if the same one is open. */
  toggle(id: string): void {
    if (this.animating) return;
    if (this.activeId === id) {
      this.close();
    } else {
      if (this.activeId !== null) {
        this.closeImmediate();
      }
      this.open(id);
    }
  }

  /** Open a specific dashboard (no-op if already open). */
  open(id: string): void {
    if (this.animating) return;
    if (this.activeId === id) return;

    const definition = this.registry.get(id);
    if (!definition) {
      console.error(`[DashboardManager] Unknown dashboard: "${id}"`);
      return;
    }

    if (this.activeId !== null) {
      this.closeImmediate();
    }

    // Build DOM
    this.overlay = this.buildOverlay(definition);
    document.body.appendChild(this.overlay);

    this.activeId = id;
    this.activeTab = 0;

    // Trigger enter animation
    this.animating = true;
    requestAnimationFrame(() => {
      this.overlay?.classList.add('krypton-dashboard--visible');
      setTimeout(() => {
        this.animating = false;
      }, 150);
    });

    // Notify InputRouter to enter Dashboard mode
    this.modeCallback?.(true);

    // Call onOpen — dashboard loads data, then calls ready() to render tabs
    if (definition.onOpen) {
      definition.onOpen(() => {
        if (this.activeId !== id) return; // closed before ready
        this.renderActiveTab();
      });
    } else {
      // No onOpen, render first tab immediately
      this.renderActiveTab();
    }
  }

  /** Close the currently active dashboard (no-op if none open). */
  close(): void {
    if (this.activeId === null || !this.overlay) return;
    if (this.animating) return;

    const definition = this.registry.get(this.activeId);
    definition?.onClose?.();

    this.animating = true;
    this.overlay.classList.remove('krypton-dashboard--visible');

    const overlayRef = this.overlay;
    setTimeout(() => {
      overlayRef.remove();
      this.animating = false;
    }, 120);

    this.overlay = null;
    this.tabBar = null;
    this.tabContent = null;
    this.activeId = null;
    this.activeTab = 0;

    this.modeCallback?.(false);
    this.refocusCallback?.();
  }

  /** Returns the currently active dashboard ID, or null. */
  get activeDashboardId(): string | null {
    return this.activeId;
  }

  /** Returns all registered dashboard definitions. */
  get registeredDashboards(): DashboardDefinition[] {
    return Array.from(this.registry.values());
  }

  /**
   * Check if a keyboard event matches any dashboard shortcut.
   * Called by InputRouter from Normal mode.
   */
  matchShortcut(e: KeyboardEvent): string | null {
    for (const [id, def] of this.registry) {
      if (def.shortcut && this.shortcutMatches(e, def.shortcut)) {
        return id;
      }
    }
    return null;
  }

  /**
   * Handle a keydown event while a dashboard is active.
   * Returns true if the event was consumed.
   */
  handleKey(e: KeyboardEvent): boolean {
    if (this.activeId === null) return false;

    const definition = this.registry.get(this.activeId);
    if (!definition) return false;

    // Let the dashboard handle the key first
    if (definition.onKeyDown) {
      const consumed = definition.onKeyDown(e);
      if (consumed) return true;
    }

    // Tab switching: [ and ] or 1-9
    if (definition.tabs.length > 1) {
      if (e.key === '[' && !e.metaKey && !e.ctrlKey) {
        this.switchTab(this.activeTab - 1);
        return true;
      }
      if (e.key === ']' && !e.metaKey && !e.ctrlKey) {
        this.switchTab(this.activeTab + 1);
        return true;
      }
      // 1-9 to switch tabs directly
      const num = parseInt(e.key, 10);
      if (num >= 1 && num <= definition.tabs.length && !e.metaKey && !e.ctrlKey && !e.altKey) {
        this.switchTab(num - 1);
        return true;
      }
    }

    // Escape closes the dashboard
    if (e.key === 'Escape') {
      this.close();
      return true;
    }

    // Dashboard's own toggle shortcut closes it
    if (definition.shortcut && this.shortcutMatches(e, definition.shortcut)) {
      this.close();
      return true;
    }

    return false;
  }

  // ─── Tab Management ──────────────────────────────────────────────

  /** Switch to a tab by index (wraps around) */
  switchTab(index: number): void {
    if (this.activeId === null) return;
    const definition = this.registry.get(this.activeId);
    if (!definition || definition.tabs.length <= 1) return;

    const count = definition.tabs.length;
    // Wrap around
    this.activeTab = ((index % count) + count) % count;
    this.updateTabBarHighlight();
    this.renderActiveTab();
  }

  /** Render the currently active tab into the content area */
  private renderActiveTab(): void {
    if (!this.tabContent || this.activeId === null) return;
    const definition = this.registry.get(this.activeId);
    if (!definition) return;

    const tab = definition.tabs[this.activeTab];
    if (!tab) return;

    this.tabContent.innerHTML = '';
    tab.render(this.tabContent);
  }

  /** Update the tab bar active indicator */
  private updateTabBarHighlight(): void {
    if (!this.tabBar) return;
    const buttons = this.tabBar.querySelectorAll('.krypton-dashboard__tab');
    buttons.forEach((btn, i) => {
      btn.classList.toggle('krypton-dashboard__tab--active', i === this.activeTab);
    });
  }

  // ─── Private ─────────────────────────────────────────────────────

  /** Close without animation (for dashboard switching) */
  private closeImmediate(): void {
    if (this.activeId === null || !this.overlay) return;

    const definition = this.registry.get(this.activeId);
    definition?.onClose?.();

    this.overlay.remove();
    this.overlay = null;
    this.tabBar = null;
    this.tabContent = null;
    this.activeId = null;
    this.activeTab = 0;
  }

  /** Build the overlay DOM structure */
  private buildOverlay(definition: DashboardDefinition): HTMLElement {
    const overlay = document.createElement('div');
    overlay.className = 'krypton-dashboard';

    const backdrop = document.createElement('div');
    backdrop.className = 'krypton-dashboard__backdrop';
    backdrop.addEventListener('mousedown', (e) => {
      e.preventDefault();
      this.close();
    });

    const panel = document.createElement('div');
    panel.className = 'krypton-dashboard__panel';

    // ─── Header ─────────────────────────────────────────────────
    const header = document.createElement('div');
    header.className = 'krypton-dashboard__header';

    const title = document.createElement('span');
    title.className = 'krypton-dashboard__title';
    title.textContent = definition.title;

    header.appendChild(title);

    // Tab bar (only if multiple tabs)
    if (definition.tabs.length > 1) {
      const tabBarEl = document.createElement('div');
      tabBarEl.className = 'krypton-dashboard__tabbar';

      definition.tabs.forEach((tab, i) => {
        const btn = document.createElement('button');
        btn.className = 'krypton-dashboard__tab';
        if (i === 0) btn.classList.add('krypton-dashboard__tab--active');

        const keyHint = document.createElement('span');
        keyHint.className = 'krypton-dashboard__tab-key';
        keyHint.textContent = tab.key ?? String(i + 1);

        const label = document.createElement('span');
        label.className = 'krypton-dashboard__tab-label';
        label.textContent = tab.label;

        btn.appendChild(keyHint);
        btn.appendChild(label);

        btn.addEventListener('mousedown', (e) => {
          e.preventDefault();
          this.switchTab(i);
        });

        tabBarEl.appendChild(btn);
      });

      header.appendChild(tabBarEl);
      this.tabBar = tabBarEl;
    }

    // Shortcut hint + close button pushed to end
    const headerEnd = document.createElement('div');
    headerEnd.className = 'krypton-dashboard__header-end';

    const shortcutHint = document.createElement('span');
    shortcutHint.className = 'krypton-dashboard__shortcut-hint';
    shortcutHint.textContent = definition.shortcut
      ? this.formatShortcut(definition.shortcut)
      : 'Esc to close';

    const closeBtn = document.createElement('button');
    closeBtn.className = 'krypton-dashboard__close';
    closeBtn.textContent = '\u00d7';
    closeBtn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      this.close();
    });

    headerEnd.appendChild(shortcutHint);
    headerEnd.appendChild(closeBtn);
    header.appendChild(headerEnd);

    // Header accent bar (match krypton-window chrome)
    const headerAccent = document.createElement('div');
    headerAccent.className = 'krypton-window__header-accent';

    // ─── Content ────────────────────────────────────────────────
    const content = document.createElement('div');
    content.className = 'krypton-dashboard__content';
    this.tabContent = content;

    // Corner accent elements (match krypton-window chrome)
    for (const pos of ['tl', 'tr', 'bl', 'br']) {
      const corner = document.createElement('div');
      corner.className = `krypton-window__corner krypton-window__corner--${pos}`;
      panel.appendChild(corner);
    }

    panel.appendChild(header);
    panel.appendChild(headerAccent);
    panel.appendChild(content);

    overlay.appendChild(backdrop);
    overlay.appendChild(panel);

    return overlay;
  }

  /** Check if a keyboard event matches a shortcut descriptor */
  private shortcutMatches(e: KeyboardEvent, shortcut: DashboardShortcut): boolean {
    return (
      e.code === shortcut.key &&
      (!!shortcut.meta === e.metaKey) &&
      (!!shortcut.shift === e.shiftKey) &&
      (!!shortcut.ctrl === e.ctrlKey) &&
      (!!shortcut.alt === e.altKey)
    );
  }

  /** Format a shortcut for display */
  private formatShortcut(shortcut: DashboardShortcut): string {
    const parts: string[] = [];
    if (shortcut.ctrl) parts.push('Ctrl');
    if (shortcut.alt) parts.push('Alt');
    if (shortcut.shift) parts.push('Shift');
    if (shortcut.meta) parts.push('Cmd');
    const keyName = shortcut.key.replace('Key', '').replace('Digit', '');
    parts.push(keyName);
    return parts.join('+');
  }
}
