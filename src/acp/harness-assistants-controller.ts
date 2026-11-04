import { assistantInstanceStore, type AssistantInventoryState } from '../assistant-instance-store';
import { AssistantInstances } from './components/assistant-instances';

export interface HarnessAssistantsHost {
  isPanelHidden(): boolean;
  setDockTabAvailable(available: boolean): void;
  dockTabShown(): boolean;
  /** Invalidate only rightRail; never schedule transcript or composer work. */
  invalidate(): void;
  focusComposer(): void;
}

type InventorySource = Pick<typeof assistantInstanceStore, 'subscribeInventory'>;

/** Read-only monitor lifetime and selection. HarnessDock exclusively owns hidden. */
export class HarnessAssistantsController {
  readonly dockEl: HTMLElement;
  readonly dock: AssistantInstances;
  private shown = false;
  private disposed = false;
  private unsubscribe: (() => void) | null = null;
  private subscriptionGeneration = 0;
  private selectedId: string | null = null;
  private inventory: AssistantInventoryState = {
    instances: [], loading: true, error: null, refreshed_at_ms: null, sampled_at_ms: null,
  };

  constructor(
    private readonly host: HarnessAssistantsHost,
    private readonly source: InventorySource = assistantInstanceStore,
  ) {
    this.dockEl = document.createElement('aside');
    this.dockEl.className = 'acp-harness__assistants-dock';
    this.dockEl.hidden = true;
    this.dock = new AssistantInstances(this.dockEl);
    this.dockEl.addEventListener('click', this.onClick);
    document.addEventListener('visibilitychange', this.onVisibilityChange);
  }

  /** Call on rightRail invalidation and EVERY dock shown-tab transition. */
  renderDock(): void {
    if (this.disposed) return;
    this.host.setDockTabAvailable(!this.host.isPanelHidden());
    this.shown = this.host.dockTabShown();
    this.syncSubscription();
    if (!this.shown) return;
    this.dock.update({ inventory: this.inventory, selectedId: this.selectedId, now: Date.now() });
  }

  focus(): void { this.dockEl.focus({ preventScroll: true }); }

  /** Host calls this after permission/question handling and dock [ / ] handling. */
  handleDockKey(event: KeyboardEvent): boolean {
    if (!this.shown || !(event.target instanceof Node) || !this.dockEl.contains(event.target)) return false;
    if (event.key === 'Escape') {
      event.preventDefault();
      this.host.focusComposer();
      return true;
    }
    if (!event.metaKey && !event.ctrlKey && !event.altKey) {
      const instances = this.inventory.instances;
      const current = instances.findIndex((instance) => instance.id === this.selectedId);
      let next: number | null = null;
      if (event.key === 'j' || event.key === 'ArrowDown') next = Math.min(instances.length - 1, current + 1);
      else if (event.key === 'k' || event.key === 'ArrowUp') next = Math.max(0, current - 1);
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = instances.length - 1;
      if (next !== null) {
        event.preventDefault();
        this.selectedId = instances[next]?.id ?? null;
        this.renderDock();
        const selected = [...this.dockEl.querySelectorAll<HTMLElement>('[data-assistant-id]')]
          .find((row) => row.dataset.assistantId === this.selectedId);
        selected?.scrollIntoView({ block: 'nearest' });
        return true;
      }
      // Tab stays native. Brackets have already been offered to HarnessDock.
      // All other monitor typing must not reach composer shortcuts or drafts.
      if (event.key !== 'Tab') event.preventDefault();
    }
    return true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.subscriptionGeneration++;
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    this.dockEl.removeEventListener('click', this.onClick);
    this.dock.dispose();
  }

  private readonly onVisibilityChange = (): void => { this.syncSubscription(); };

  private readonly onClick = (event: MouseEvent): void => {
    if (!(event.target instanceof Element)) return;
    const row = event.target.closest<HTMLElement>('[data-assistant-id]');
    if (!row || !this.dockEl.contains(row)) return;
    this.selectedId = row.dataset.assistantId ?? null;
    this.renderDock();
    this.focus();
  };

  private syncSubscription(): void {
    const active = !this.disposed && this.shown && document.visibilityState === 'visible';
    if (!active) {
      this.subscriptionGeneration++;
      this.unsubscribe?.();
      this.unsubscribe = null;
      return;
    }
    if (this.unsubscribe) return;
    const generation = ++this.subscriptionGeneration;
    this.unsubscribe = this.source.subscribeInventory((state) => {
      if (generation !== this.subscriptionGeneration || this.disposed || !this.shown || document.visibilityState !== 'visible') return;
      this.inventory = state;
      if (!state.instances.some((instance) => instance.id === this.selectedId)) {
        this.selectedId = state.instances[0]?.id ?? null;
      }
      this.host.invalidate();
    });
  }
}
