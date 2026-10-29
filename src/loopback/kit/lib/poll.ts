// Spec 341 — the one poll loop. The dashboard and gallery each carried a copy
// (`pollInFlight` / `hasSuccessfulPoll` / `lastSignature` / "reconnecting…"),
// termctrl, acp-wire and e2e each paused on `visibilitychange` their own way.

export type PollStatus = 'loading' | 'ok' | 'reconnecting';

export interface PollOptions<T> {
  load(signal: AbortSignal): Promise<T>;
  apply(value: T): void;
  onStatus?(status: PollStatus, error?: unknown): void;
  /** Repeat every `intervalMs`. Omit to load once (plus focus refreshes). */
  intervalMs?: number;
  /** Stop the interval while the tab is hidden; refresh on return. Default true. */
  pauseWhenHidden?: boolean;
  /** Refresh when the window regains focus. Default false. */
  refreshOnFocus?: boolean;
  /** Minimum gap between focus/visibility refreshes. Default 1000 ms. */
  minGapMs?: number;
  /** Skip `apply` when the value's signature has not moved. */
  signature?(value: T): string;
}

export interface Poller {
  /** Load now (no-op while a load is in flight). */
  refresh(): Promise<void>;
  readonly status: PollStatus;
  dispose(): void;
}

export function poll<T>(options: PollOptions<T>): Poller {
  const pauseWhenHidden = options.pauseWhenHidden ?? true;
  const minGapMs = options.minGapMs ?? 1000;
  let status: PollStatus = 'loading';
  let inFlight: Promise<void> | null = null;
  let lastSignature: string | null = null;
  let lastStart = 0;
  let timer: number | undefined;
  let disposed = false;
  const abort = new AbortController();

  const setStatus = (next: PollStatus, error?: unknown): void => {
    if (next === status && error === undefined) return;
    status = next;
    options.onStatus?.(next, error);
  };

  const hidden = (): boolean => document.visibilityState === 'hidden';

  const schedule = (): void => {
    if (disposed || options.intervalMs === undefined) return;
    window.clearTimeout(timer);
    timer = undefined;
    if (pauseWhenHidden && hidden()) return;
    timer = window.setTimeout(() => {
      timer = undefined;
      void refresh().then(schedule);
    }, options.intervalMs);
  };

  const refresh = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    if (inFlight) return inFlight;
    lastStart = Date.now();
    inFlight = (async () => {
      try {
        const value = await options.load(abort.signal);
        if (disposed) return;
        const signature = options.signature?.(value);
        if (signature === undefined || signature !== lastSignature) {
          lastSignature = signature ?? null;
          options.apply(value);
        }
        setStatus('ok');
      } catch (error) {
        if (disposed) return;
        setStatus('reconnecting', error);
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  };

  const onVisibility = (): void => {
    if (hidden()) {
      if (pauseWhenHidden) {
        window.clearTimeout(timer);
        timer = undefined;
      }
      return;
    }
    if (Date.now() - lastStart >= minGapMs) void refresh().then(schedule);
    else schedule();
  };
  const onFocus = (): void => {
    if (Date.now() - lastStart >= minGapMs) void refresh();
  };

  document.addEventListener('visibilitychange', onVisibility);
  if (options.refreshOnFocus) window.addEventListener('focus', onFocus);

  options.onStatus?.('loading');
  void refresh().then(schedule);

  return {
    refresh,
    get status() {
      return status;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      abort.abort();
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', onFocus);
    },
  };
}
