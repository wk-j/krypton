// Spec 337 §UI Placement — the harness's right dock column.
//
// One column owns placement, availability and the persisted selected tab.
// Owners report availability (Assistants does not require inventory rows).
// Fallback follows tab order without rewriting the stored preference.

import { TabStrip, type TabStripTab } from './components/tab-strip';
import { readDockTab, writeDockTab, type HarnessDockTab } from './harness-panel-visibility';

/** Paint order of the tab strip, left to right. */
const DOCK_TABS: readonly HarnessDockTab[] = ['ticket', 'rails', 'assistants', 'git'];

/** The root class that reserves the column's width (`harness-shared.css`). */
export const DOCK_ACTIVE_CLASS = 'acp-harness--dock-active';

/** What the Rails tab label carries: `RAILS ✗` after a failed check, else the open count. */
export interface RailsTabBadge {
  readonly failedCheck: string | null;
  /** Open findings of the latest run; null before any run. */
  readonly open: number | null;
}

const NO_BADGE: RailsTabBadge = { failedCheck: null, open: null };

/** What the Git tab label carries: `GIT ✗` when any path conflicts, else the row count. */
export interface GitTabBadge {
  readonly conflicts: boolean;
  /** Null when the tree is clean or status has not loaded. */
  readonly rows: number | null;
}

const NO_GIT_BADGE: GitTabBadge = { conflicts: false, rows: null };


export class HarnessDock {
  /** The column, `.acp-harness__dock`: the tab strip, then the shown dock. */
  readonly el: HTMLElement;
  /** The `dock.right` layout slot (`display: contents`) the docks mount into. */
  readonly slotEl: HTMLElement;
  private readonly strip = new TabStrip('button');
  private readonly panes = new Map<HarnessDockTab, HTMLElement>();
  private readonly available: Record<HarnessDockTab, boolean> = { ticket: false, rails: false, assistants: false, git: false };
  private selected: HarnessDockTab;
  private shownTab: HarnessDockTab | null = null;
  private badge: RailsTabBadge = NO_BADGE;
  private gitBadge: GitTabBadge = NO_GIT_BADGE;

  /**
   * @param root the harness root, which carries `acp-harness--dock-active`.
   * @param projectDir read on every write: the view may resolve it after mount.
   * @param onShown called after the shown tab changed, so its owner can paint.
   */
  constructor(
    private readonly root: HTMLElement,
    private readonly projectDir: () => string | null,
    private readonly onShown: (tab: HarnessDockTab | null) => void = () => undefined,
  ) {
    this.selected = readDockTab(projectDir());
    this.el = document.createElement('div');
    this.el.className = 'acp-harness__dock';
    this.el.hidden = true;
    this.slotEl = document.createElement('div');
    this.slotEl.className = 'acp-harness__layout-slot';
    this.slotEl.dataset.layoutSlot = 'dock.right';
    this.strip.el.hidden = true;
    this.el.append(this.strip.el, this.slotEl);
    this.paintStrip();
  }

  /** Register the element whose `hidden` this column owns from now on. */
  setPane(tab: HarnessDockTab, el: HTMLElement): void {
    this.panes.set(tab, el);
    el.hidden = this.shownTab !== tab;
  }

  setAvailable(tab: HarnessDockTab, available: boolean): void {
    if (this.available[tab] === available) return;
    this.available[tab] = available;
    this.sync();
  }

  isAvailable(tab: HarnessDockTab): boolean {
    return this.available[tab];
  }

  setRailsBadge(badge: RailsTabBadge): void {
    if (badge.failedCheck === this.badge.failedCheck && badge.open === this.badge.open) return;
    this.badge = badge;
    this.paintStrip();
  }

  /** Spec 396: conflict wins over the row count. A clean tree paints `GIT` alone. */
  setGitBadge(badge: GitTabBadge): void {
    if (badge.conflicts === this.gitBadge.conflicts && badge.rows === this.gitBadge.rows) return;
    this.gitBadge = badge;
    this.paintStrip();
  }

  /** Store the choice, even for a tab that is unavailable right now. */
  select(tab: HarnessDockTab): void {
    if (this.selected !== tab) {
      this.selected = tab;
      writeDockTab(this.projectDir(), tab);
    }
    this.sync();
  }

  /** The stored choice, not necessarily the shown tab. */
  selectedTab(): HarnessDockTab {
    return this.selected;
  }

  shown(): HarnessDockTab | null {
    return this.shownTab;
  }

  isShown(tab: HarnessDockTab): boolean {
    return this.shownTab === tab;
  }

  /** Traverse available tabs in paint order, wrapping in either direction. */
  cycle(direction: 1 | -1 = 1): boolean {
    if (this.shownTab === null) return false;
    const next = this.nextAvailable(this.shownTab, direction);
    if (next === null || next === this.shownTab) return false;
    this.select(next);
    return true;
  }

  /** `[` / `]` without modifiers, from either tab. */
  handleKey(event: KeyboardEvent): boolean {
    if (event.key !== '[' && event.key !== ']') return false;
    if (event.metaKey || event.ctrlKey || event.altKey) return false;
    if (!this.cycle(event.key === '[' ? -1 : 1)) return false;
    event.preventDefault();
    return true;
  }

  dispose(): void {
    this.strip.dispose();
    this.root.classList.remove(DOCK_ACTIVE_CLASS);
  }

  private nextAvailable(from: HarnessDockTab, direction: 1 | -1): HarnessDockTab | null {
    const start = DOCK_TABS.indexOf(from);
    for (let step = 1; step <= DOCK_TABS.length; step++) {
      const tab = DOCK_TABS[(start + step * direction + DOCK_TABS.length) % DOCK_TABS.length];
      if (this.available[tab]) return tab;
    }
    return null;
  }

  private sync(): void {
    const next = this.available[this.selected] ? this.selected : this.nextAvailable(this.selected, 1);
    const changed = next !== this.shownTab;
    this.shownTab = next;
    for (const [tab, el] of this.panes) el.hidden = tab !== next;
    this.el.hidden = next === null;
    this.root.classList.toggle(DOCK_ACTIVE_CLASS, next !== null);
    this.paintStrip();
    if (changed) this.onShown(next);
    this.rescueFocus(next);
  }

  /** Never leave the keyboard on a node that just went `hidden`: follow the
   *  switch into the shown pane, or give it back to the harness root. */
  private rescueFocus(next: HarnessDockTab | null): void {
    const focused = document.activeElement;
    if (!(focused instanceof HTMLElement) || !this.el.contains(focused)) return;
    if (!this.el.hidden && focused.closest('[hidden]') === null) return;
    const target = next === null ? this.root : (this.panes.get(next) ?? this.root);
    target.focus({ preventScroll: true });
  }

  private paintStrip(): void {
    const available = DOCK_TABS.filter((tab) => this.available[tab]);
    this.strip.el.hidden = available.length < 2;
    if (available.length < 2) return;
    const tabs: TabStripTab[] = available.map((tab) => this.tabFor(tab));
    this.strip.update({
      tabs,
      activeId: this.shownTab ?? this.selected,
      block: 'acp-dock',
      item: 'tab',
      activeClass: 'acp-dock__tab--active',
      count: 'badge',
      role: 'tablist',
      ariaLabel: 'Dock',
      onSelect: (id) => {
        if (id === 'ticket' || id === 'rails' || id === 'assistants' || id === 'git') this.select(id);
      },
    });
  }

  private tabFor(tab: HarnessDockTab): TabStripTab {
    if (tab === 'ticket') return { id: 'ticket', label: 'TICKET' };
    if (tab === 'assistants') return { id: 'assistants', label: 'ASSISTANTS' };
    if (tab === 'git') {
      if (this.gitBadge.conflicts) return { id: 'git', label: 'GIT ✗' };
      return this.gitBadge.rows === null
        ? { id: 'git', label: 'GIT' }
        : { id: 'git', label: 'GIT', count: this.gitBadge.rows };
    }
    if (this.badge.failedCheck !== null) return { id: 'rails', label: 'RAILS ✗' };
    return this.badge.open === null
      ? { id: 'rails', label: 'RAILS' }
      : { id: 'rails', label: 'RAILS', count: this.badge.open };
  }
}
