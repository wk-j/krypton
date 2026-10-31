// Spec 337 §UI Placement — the harness's right dock column.
//
// `dock.right` used to hold only the Active Ticket dock, which placed itself
// (`position: absolute`) and toggled the root class that makes the dashboard
// yield its width. With the Rails dock as a second tab, placement, the shown
// tab and the reserved width belong to one owner: this column.
//
// A tab is AVAILABLE when its dock has content and neither its own spec 320
// flag nor the spec 347 right-panel flag hides it; each owner reports that,
// the column decides what is SHOWN. The selected tab is a stored preference
// that availability never rewrites: when it becomes unavailable the column
// shows the other one, and goes back as soon as it can.

import { TabStrip, type TabStripTab } from './components/tab-strip';
import { readDockTab, writeDockTab, type HarnessDockTab } from './harness-panel-visibility';

/** Paint order of the tab strip, left to right. */
const DOCK_TABS: readonly HarnessDockTab[] = ['ticket', 'rails'];

/** The root class that reserves the column's width (`harness-shared.css`). */
export const DOCK_ACTIVE_CLASS = 'acp-harness--dock-active';

/** What the Rails tab label carries: `RAILS ✗` after a failed check, else the open count. */
export interface RailsTabBadge {
  readonly failedCheck: string | null;
  /** Open findings of the latest run; null before any run. */
  readonly open: number | null;
}

const NO_BADGE: RailsTabBadge = { failedCheck: null, open: null };

function otherTab(tab: HarnessDockTab): HarnessDockTab {
  return tab === 'ticket' ? 'rails' : 'ticket';
}

export class HarnessDock {
  /** The column, `.acp-harness__dock`: the tab strip, then the shown dock. */
  readonly el: HTMLElement;
  /** The `dock.right` layout slot (`display: contents`) the docks mount into. */
  readonly slotEl: HTMLElement;
  private readonly strip = new TabStrip('button');
  private readonly panes = new Map<HarnessDockTab, HTMLElement>();
  private readonly available: Record<HarnessDockTab, boolean> = { ticket: false, rails: false };
  private selected: HarnessDockTab;
  private shownTab: HarnessDockTab | null = null;
  private badge: RailsTabBadge = NO_BADGE;

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

  /** `[` / `]`: with two tabs there is only "the other one". False when there is nothing to switch to. */
  cycle(): boolean {
    if (!this.available.ticket || !this.available.rails || this.shownTab === null) return false;
    this.select(otherTab(this.shownTab));
    return true;
  }

  /** `[` / `]` without modifiers, from either tab. */
  handleKey(event: KeyboardEvent): boolean {
    if (event.key !== '[' && event.key !== ']') return false;
    if (event.metaKey || event.ctrlKey || event.altKey) return false;
    if (!this.cycle()) return false;
    event.preventDefault();
    return true;
  }

  dispose(): void {
    this.strip.dispose();
    this.root.classList.remove(DOCK_ACTIVE_CLASS);
  }

  private sync(): void {
    const next = this.available[this.selected]
      ? this.selected
      : this.available[otherTab(this.selected)]
        ? otherTab(this.selected)
        : null;
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
    const both = this.available.ticket && this.available.rails;
    this.strip.el.hidden = !both;
    if (!both) return;
    const tabs: TabStripTab[] = DOCK_TABS.map((tab) => this.tabFor(tab));
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
        if (id === 'ticket' || id === 'rails') this.select(id);
      },
    });
  }

  private tabFor(tab: HarnessDockTab): TabStripTab {
    if (tab === 'ticket') return { id: 'ticket', label: 'TICKET' };
    if (this.badge.failedCheck !== null) return { id: 'rails', label: 'RAILS ✗' };
    return this.badge.open === null
      ? { id: 'rails', label: 'RAILS' }
      : { id: 'rails', label: 'RAILS', count: this.badge.open };
  }
}
