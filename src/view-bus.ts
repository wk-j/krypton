// View Protocol — in-process pub/sub bus for cross-view communication.
// See docs/105-view-protocol.md for design rationale.

import type {
  Intent,
  IntentFilter,
  IntentHandlerResult,
  IntentKind,
  Signal,
  SignalFilter,
  SignalKind,
  SignalSource,
  Unsubscribe,
  ViewAddress,
} from './view-bus-types';

type SignalHandler<K extends SignalKind> = (s: Signal<K>) => void;
type IntentHandler<K extends IntentKind> = (i: Intent<K>) => IntentHandlerResult;

interface SignalEntry<K extends SignalKind> {
  filter: SignalFilter<K>;
  cb: SignalHandler<K>;
}

interface IntentEntry<K extends IntentKind> {
  filter: IntentFilter<K>;
  cb: IntentHandler<K>;
}

const RING_BUFFER_SIZE = 200;
const MAX_DEPTH = 16;

const defaultIsDev = (): boolean => {
  try {
    return Boolean((import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV);
  } catch {
    return false;
  }
};

export interface ViewBusOptions {
  /** Override DEV detection (for tests). Defaults to import.meta.env.DEV. */
  isDev?: boolean;
}

export class ViewBus {
  private readonly signalHandlers = new Map<SignalKind, Set<SignalEntry<SignalKind>>>();
  private readonly intentHandlers = new Map<IntentKind, Set<IntentEntry<IntentKind>>>();
  private readonly signalRing: Signal[] = [];
  private readonly intentRing: Intent[] = [];
  private readonly isDev: boolean;

  private depth = 0;
  private readonly kindStack: string[] = [];

  constructor(options: ViewBusOptions = {}) {
    this.isDev = options.isDev ?? defaultIsDev();
  }

  publishSignal<K extends SignalKind>(sig: Omit<Signal<K>, 'ts'>): void {
    const full: Signal<K> = { ...sig, ts: Date.now() } as Signal<K>;
    this.recordSignal(full);
    const entries = this.signalHandlers.get(sig.kind);
    if (!entries || entries.size === 0) return;
    this.dispatch(sig.kind, () => {
      for (const entry of entries) {
        if (!matchesSignalFilter(entry.filter, full)) continue;
        this.invoke(sig.kind, () => entry.cb(full as Signal<SignalKind>));
      }
    });
  }

  publishIntent<K extends IntentKind>(intent: Omit<Intent<K>, 'ts'>): boolean {
    const full: Intent<K> = { ...intent, ts: Date.now() } as Intent<K>;
    this.recordIntent(full);
    const entries = this.intentHandlers.get(intent.kind);
    if (!entries || entries.size === 0) return false;
    let consumed = false;
    this.dispatch(intent.kind, () => {
      for (const entry of entries) {
        const result = this.invoke(intent.kind, () =>
          entry.cb(full as Intent<IntentKind>),
        );
        if (result && typeof result === 'object' && result.consumed) {
          consumed = true;
        }
      }
    });
    return consumed;
  }

  onSignal<K extends SignalKind>(
    filter: SignalFilter<K>,
    cb: SignalHandler<K>,
  ): Unsubscribe {
    const set = this.getOrCreateSignalSet(filter.kind);
    const entry: SignalEntry<SignalKind> = {
      filter: filter as SignalFilter<SignalKind>,
      cb: cb as SignalHandler<SignalKind>,
    };
    set.add(entry);
    return () => {
      set.delete(entry);
    };
  }

  onIntent<K extends IntentKind>(
    filter: IntentFilter<K>,
    cb: IntentHandler<K>,
  ): Unsubscribe {
    const set = this.getOrCreateIntentSet(filter.kind);
    const entry: IntentEntry<IntentKind> = {
      filter: filter as IntentFilter<IntentKind>,
      cb: cb as IntentHandler<IntentKind>,
    };
    set.add(entry);
    return () => {
      set.delete(entry);
    };
  }

  snapshot(): { signals: readonly Signal[]; intents: readonly Intent[] } {
    return { signals: [...this.signalRing], intents: [...this.intentRing] };
  }

  private dispatch(kind: string, run: () => void): void {
    if (this.depth >= MAX_DEPTH) {
      throw new Error(
        `[ViewBus] depth ${this.depth} exceeded for "${kind}"; stack: ${this.kindStack.join(' → ')}`,
      );
    }
    if (this.isDev && this.kindStack.includes(kind)) {
      throw new Error(
        `[ViewBus] re-entrant publish of "${kind}"; stack: ${this.kindStack.join(' → ')} → ${kind}`,
      );
    }
    this.depth++;
    this.kindStack.push(kind);
    try {
      run();
    } finally {
      this.depth--;
      this.kindStack.pop();
    }
  }

  private invoke<T>(kind: string, run: () => T): T | undefined {
    try {
      return run();
    } catch (err) {
      if (this.isDev) throw err;
      console.error('[ViewBus]', kind, err);
      return undefined;
    }
  }

  private getOrCreateSignalSet(kind: SignalKind): Set<SignalEntry<SignalKind>> {
    let set = this.signalHandlers.get(kind);
    if (!set) {
      set = new Set();
      this.signalHandlers.set(kind, set);
    }
    return set;
  }

  private getOrCreateIntentSet(kind: IntentKind): Set<IntentEntry<IntentKind>> {
    let set = this.intentHandlers.get(kind);
    if (!set) {
      set = new Set();
      this.intentHandlers.set(kind, set);
    }
    return set;
  }

  private recordSignal(s: Signal): void {
    if (this.signalRing.length >= RING_BUFFER_SIZE) this.signalRing.shift();
    this.signalRing.push(s);
  }

  private recordIntent(i: Intent): void {
    if (this.intentRing.length >= RING_BUFFER_SIZE) this.intentRing.shift();
    this.intentRing.push(i);
  }
}

function matchesSignalFilter<K extends SignalKind>(
  filter: SignalFilter<K>,
  signal: Signal<K>,
): boolean {
  if (filter.sourceRole || filter.sourceViewId) {
    if (!isViewAddress(signal.source)) return false;
    if (filter.sourceRole && signal.source.role !== filter.sourceRole) return false;
    if (filter.sourceViewId && signal.source.viewId !== filter.sourceViewId) return false;
  }
  return true;
}

function isViewAddress(source: SignalSource): source is ViewAddress {
  return 'viewId' in source;
}

let globalBus: ViewBus | null = null;

export function getViewBus(): ViewBus {
  if (!globalBus) globalBus = new ViewBus();
  return globalBus;
}

// Test-only escape hatch.
export function __resetViewBusForTests(): void {
  globalBus = null;
}
