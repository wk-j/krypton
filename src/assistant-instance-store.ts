import { invoke } from './profiler/ipc';
import type { AcpInstanceRole, AcpInstanceSnapshot } from './acp/types';
import type { AcpLaneMetrics } from './types';

export type EmbeddedInstanceRole = 'agent_view' | 'file_manager_ai' | 'markdown_ai';

export type AssistantInstance = Omit<AcpInstanceSnapshot, 'session' | 'execution' | 'owner'> & {
  id: string;
  kind: 'acp' | 'embedded';
  owner: {
    role: AcpInstanceRole | EmbeddedInstanceRole;
    label: string;
    harness_id: string | null;
    lane_id: string | null;
  };
  execution: { kind: 'local' | 'remote' | 'embedded'; runtime_id: string | null; host: string | null };
  metrics: AcpLaneMetrics | null;
  cpu_ready: boolean;
};

export interface AssistantInventoryState {
  instances: readonly AssistantInstance[];
  loading: boolean;
  error: string | null;
  refreshed_at_ms: number | null;
  sampled_at_ms: number | null;
}

interface StoreDependencies {
  listInstances(): Promise<AcpInstanceSnapshot[]>;
  getMetrics(): Promise<AcpLaneMetrics[]>;
  now(): number;
  setTimeout(callback: () => void, delay: number): number;
  clearTimeout(timer: number): void;
}

export interface EmbeddedInstanceOptions {
  role: EmbeddedInstanceRole;
  label: string;
  cwd: string | null;
  model_id: string | null;
}

export interface EmbeddedInstanceRegistration {
  readonly id: string;
  update(change: Partial<Pick<AssistantInstance, 'cwd' | 'activity' | 'lifecycle' | 'has_error'>> & { model_id?: string | null }): void;
  retire(): void;
}

const defaultDependencies: StoreDependencies = {
  listInstances: () => invoke<AcpInstanceSnapshot[]>('acp_list_instances'),
  getMetrics: () => invoke<AcpLaneMetrics[]>('acp_get_lane_metrics'),
  now: () => Date.now(),
  setTimeout: (callback, delay) => window.setTimeout(callback, delay),
  clearTimeout: (timer) => window.clearTimeout(timer),
};

let embeddedInstanceEpoch = 0;

/** One app-wide poll cycle, shared by Harness resource consumers and visible inventories. */
export class AssistantInstanceStore {
  private readonly deps: StoreDependencies;
  private readonly inventoryListeners = new Set<(state: AssistantInventoryState) => void>();
  private readonly metricsListeners = new Set<(metrics: readonly AcpLaneMetrics[]) => void>();
  private readonly embedded = new Map<string, AssistantInstance>();
  private snapshots: readonly AcpInstanceSnapshot[] = [];
  private metrics: readonly AcpLaneMetrics[] = [];
  private metricsBySession = new Map<number, AcpLaneMetrics>();
  private timer: number | null = null;
  private inFlight = false;
  private refreshRequested = false;
  private generation = 0;
  private inventoryGeneration = 0;
  private metadataError: string | null = null;
  private metricsError: string | null = null;
  private state: AssistantInventoryState = {
    instances: [], loading: false, error: null, refreshed_at_ms: null, sampled_at_ms: null,
  };

  constructor(dependencies: Partial<StoreDependencies> = {}) {
    this.deps = { ...defaultDependencies, ...dependencies };
  }

  subscribeInventory(listener: (state: AssistantInventoryState) => void): () => void {
    const first = this.inventoryListeners.size === 0;
    const wasActive = this.hasDemand();
    this.inventoryListeners.add(listener);
    if (first) {
      this.inventoryGeneration++;
      this.state = { ...this.state, loading: true };
      if (!wasActive) this.generation++;
    }
    listener(this.state);
    if (first) this.requestRefresh();
    return () => {
      if (!this.inventoryListeners.delete(listener)) return;
      if (this.inventoryListeners.size === 0) this.inventoryGeneration++;
      this.stopIfUnused();
    };
  }

  subscribeMetrics(listener: (metrics: readonly AcpLaneMetrics[]) => void): () => void {
    const wasActive = this.hasDemand();
    this.metricsListeners.add(listener);
    if (!wasActive) {
      this.generation++;
      this.requestRefresh();
    } else if (this.state.sampled_at_ms !== null) {
      listener(this.metrics);
    }
    return () => {
      this.metricsListeners.delete(listener);
      this.stopIfUnused();
    };
  }

  /** Called only once a real Pi Agent has been constructed, never for a wrapper. */
  registerEmbedded(options: EmbeddedInstanceOptions): EmbeddedInstanceRegistration {
    const id = `embedded:${crypto.randomUUID()}:${++embeddedInstanceEpoch}`;
    const now = this.deps.now();
    this.embedded.set(id, {
      id, kind: 'embedded', backend_id: 'pi',
      owner: { role: options.role, label: options.label, harness_id: null, lane_id: null },
      cwd: options.cwd ?? '', acp_session_id: null,
      execution: { kind: 'embedded', runtime_id: null, host: null },
      pid: null, lifecycle: 'ready', activity: 'idle', liveness: 'alive', has_error: false,
      requested_model_id: options.model_id, confirmed_model_id: options.model_id, model_uncertain: false,
      started_at_ms: now, last_activity_at_ms: now, metrics: null, cpu_ready: false,
    });
    this.publishInventory();
    return {
      id,
      update: ({ model_id, ...change }) => {
        const current = this.embedded.get(id);
        if (!current) return;
        this.embedded.set(id, {
          ...current, ...change,
          ...(model_id !== undefined ? { requested_model_id: model_id, confirmed_model_id: model_id } : {}),
          last_activity_at_ms: this.deps.now(),
        });
        this.publishInventory();
      },
      retire: () => {
        if (this.embedded.delete(id)) this.publishInventory();
      },
    };
  }

  private hasDemand(): boolean {
    return this.inventoryListeners.size > 0 || this.metricsListeners.size > 0;
  }

  private stopIfUnused(): void {
    if (this.hasDemand()) return;
    this.generation++;
    this.refreshRequested = false;
    if (this.timer !== null) this.deps.clearTimeout(this.timer);
    this.timer = null;
  }

  private requestRefresh(): void {
    if (this.timer !== null) this.deps.clearTimeout(this.timer);
    this.timer = null;
    if (this.inFlight) {
      this.refreshRequested = true;
      return;
    }
    void this.poll();
  }

  private async poll(): Promise<void> {
    if (!this.hasDemand() || this.inFlight) return;
    this.inFlight = true;
    const generation = this.generation;
    const inventoryGeneration = this.inventoryGeneration;
    const inventoryRequested = this.inventoryListeners.size > 0;
    try {
      const [inventory, resources] = await Promise.allSettled([
        inventoryRequested ? this.deps.listInstances() : Promise.resolve(null),
        this.deps.getMetrics(),
      ]);
      if (generation !== this.generation || !this.hasDemand()) return;
      if (resources.status === 'fulfilled') {
        this.metrics = resources.value;
        this.metricsBySession = new Map(this.metrics.map((sample) => [sample.session, sample]));
        this.metricsError = null;
        this.state = { ...this.state, sampled_at_ms: this.deps.now() };
        for (const listener of this.metricsListeners) listener(this.metrics);
      } else {
        this.metricsError = String(resources.reason);
      }
      if (inventoryRequested && inventoryGeneration === this.inventoryGeneration && this.inventoryListeners.size > 0) {
        if (inventory.status === 'fulfilled' && inventory.value !== null) {
          this.snapshots = inventory.value;
          this.metadataError = null;
          this.state = { ...this.state, loading: false, refreshed_at_ms: this.deps.now() };
        } else if (inventory.status === 'rejected') {
          this.metadataError = String(inventory.reason);
          this.state = { ...this.state, loading: false };
        }
      }
      this.publishInventory();
    } finally {
      this.inFlight = false;
      if (this.hasDemand()) {
        if (this.refreshRequested) {
          this.refreshRequested = false;
          this.requestRefresh();
        } else {
          this.timer = this.deps.setTimeout(() => {
            this.timer = null;
            void this.poll();
          }, 2000);
        }
      }
    }
  }

  private publishInventory(): void {
    const instances: AssistantInstance[] = this.snapshots.map(({ session, ...snapshot }) => {
      const sample = this.metricsBySession.get(session);
      const matched = snapshot.execution.kind === 'local' && snapshot.liveness === 'alive'
        && sample?.root_alive && sample.root_pid === snapshot.pid ? sample : null;
      return {
        ...snapshot, id: `acp:${session}`, kind: 'acp',
        // Only aggregate resource values belong in the monitor, never process argv.
        metrics: matched ? { ...matched, processes: [] } : null,
        cpu_ready: matched?.cpu_ready === true,
      };
    });
    instances.push(...this.embedded.values());
    this.state = { ...this.state, instances, error: this.metadataError ?? this.metricsError };
    for (const listener of this.inventoryListeners) listener(this.state);
  }
}

export const assistantInstanceStore = new AssistantInstanceStore();
