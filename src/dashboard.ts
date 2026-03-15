// Krypton — Dashboard Manager
// Generic overlay dashboard framework. Manages registration, DOM lifecycle,
// show/hide transitions, and keyboard routing for overlay dashboards.

import type { DashboardDefinition, DashboardShortcut } from './types';

/** Callback to enter/exit Dashboard mode in the InputRouter */
type ModeCallback = (active: boolean) => void;

/** Callback to refocus the terminal after a dashboard closes */
type RefocusCallback = () => void;

export class DashboardManager {
  private registry: Map<string, DashboardDefinition> = new Map();
  private activeId: string | null = null;
  private overlay: HTMLElement | null = null;
  private cleanupFn: (() => void) | null = null;
  private animating = false;

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
      // Close any open dashboard first, then open the new one
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

    // Close any currently open dashboard
    if (this.activeId !== null) {
      this.closeImmediate();
    }

    // Build DOM
    this.overlay = this.buildOverlay(definition);
    document.body.appendChild(this.overlay);

    // Find the content container and call onOpen
    const content = this.overlay.querySelector('.krypton-dashboard__content') as HTMLElement;
    const result = definition.onOpen(content);
    if (typeof result === 'function') {
      this.cleanupFn = result;
    }

    this.activeId = id;

    // Trigger enter animation
    this.animating = true;
    requestAnimationFrame(() => {
      this.overlay?.classList.add('krypton-dashboard--visible');
      // Animation completes via CSS transition (150ms)
      setTimeout(() => {
        this.animating = false;
      }, 150);
    });

    // Notify InputRouter to enter Dashboard mode
    this.modeCallback?.(true);
  }

  /** Close the currently active dashboard (no-op if none open). */
  close(): void {
    if (this.activeId === null || !this.overlay) return;
    if (this.animating) return;

    const definition = this.registry.get(this.activeId);

    // Call onClose lifecycle
    definition?.onClose?.();
    if (this.cleanupFn) {
      this.cleanupFn();
      this.cleanupFn = null;
    }

    // Trigger exit animation
    this.animating = true;
    this.overlay.classList.remove('krypton-dashboard--visible');

    // Remove from DOM after transition
    const overlayRef = this.overlay;
    setTimeout(() => {
      overlayRef.remove();
      this.animating = false;
    }, 120);

    this.overlay = null;
    this.activeId = null;

    // Notify InputRouter to exit Dashboard mode
    this.modeCallback?.(false);

    // Restore terminal focus
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
   * Returns the dashboard ID if matched, null otherwise.
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

    // Default: Escape closes the dashboard
    if (e.key === 'Escape') {
      this.close();
      return true;
    }

    // Default: the dashboard's own toggle shortcut closes it
    if (definition.shortcut && this.shortcutMatches(e, definition.shortcut)) {
      this.close();
      return true;
    }

    return false;
  }

  // ─── Private ─────────────────────────────────────────────────────

  /** Close without animation (for dashboard switching) */
  private closeImmediate(): void {
    if (this.activeId === null || !this.overlay) return;

    const definition = this.registry.get(this.activeId);
    definition?.onClose?.();
    if (this.cleanupFn) {
      this.cleanupFn();
      this.cleanupFn = null;
    }

    this.overlay.remove();
    this.overlay = null;
    this.activeId = null;
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

    const header = document.createElement('div');
    header.className = 'krypton-dashboard__header';

    const title = document.createElement('span');
    title.className = 'krypton-dashboard__title';
    title.textContent = definition.title;

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

    header.appendChild(title);
    header.appendChild(shortcutHint);
    header.appendChild(closeBtn);

    const content = document.createElement('div');
    content.className = 'krypton-dashboard__content';

    panel.appendChild(header);
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

    // Convert code to readable key name
    const keyName = shortcut.key
      .replace('Key', '')
      .replace('Digit', '');
    parts.push(keyName);

    return parts.join('+');
  }
}
