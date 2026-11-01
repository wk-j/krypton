// Krypton — window status-bar diff stat (spec 220): the polling store.
//
// Keyed by *repo*, not by window: four windows open on one project share one
// timer and one git call per tick. Ref-counted like `UsageStore` — the first
// subscriber for a repo starts its poll, the last one stops it — so a repo
// nobody is looking at costs nothing.
//
// Why polling at all, when ADR-0008 has the Diff Window refresh only at lane
// quiet points: this readout is two integers with no scroll position to disturb,
// and it has to stay honest about edits made outside the harness (a terminal, an
// external editor) that emit no lane signal. Lane quiet points are still wired
// in on top, via `refresh()` — they are what makes the number land the instant a
// turn ends rather than up to one tick later. See
// `docs/adr/0020-diff-stat-polls-diff-window-does-not.md`.

import { invoke } from '@tauri-apps/api/core';

import type { WorkingDiffStat } from './window-footer-diff-stat';

/**
 * Where a window's counts come from. A local project is keyed by its repo root.
 * An SSH Harness's `cwd` is a path on the remote host (spec 247), so its counts
 * come from that Harness's runtime — resolving the path locally would report
 * nothing, or a same-named local repo.
 */
export type DiffStatSource =
  | { kind: 'local'; root: string }
  | { kind: 'ssh'; runtimeId: string; cwd: string };

/** Store key: a local repo root, or the remote runtime plus its cwd. */
export function diffStatKey(source: DiffStatSource): string {
  return source.kind === 'local' ? source.root : `ssh:${source.runtimeId}:${source.cwd}`;
}

function fetchStat(source: DiffStatSource): Promise<WorkingDiffStat> {
  if (source.kind === 'local') return invoke<WorkingDiffStat>('working_diff_stat', { cwd: source.root });
  return invoke<WorkingDiffStat>('remote_harness_request', {
    runtimeId: source.runtimeId,
    method: 'diff_stat',
    params: { cwd: source.cwd },
  });
}

/**
 * Cadence per repo root.
 *
 * Measured on this repo (733 tracked files): the numstat plus the untracked
 * walk is ≈30 ms wall, dominated by two process spawns. At 4 s that is ~0.7% of
 * one core per repo that has a visible window — inside the idle-CPU budget only
 * because it is deduped per repo and stopped while the app is hidden.
 */
export const DIFF_STAT_POLL_MS = 4_000;

/** Where "is the app on screen?" comes from. Injectable so the pause-while-
 *  hidden behaviour is testable without a DOM (the unit suite runs on node). */
export interface VisibilitySource {
  hidden(): boolean;
  onChange(listener: () => void): void;
}

/** The real source: the webview's own visibility. Inert when there is no DOM. */
const documentVisibility: VisibilitySource = {
  hidden: () => typeof document !== 'undefined' && document.visibilityState === 'hidden',
  onChange: (listener) => {
    if (typeof document === 'undefined') return;
    document.addEventListener('visibilitychange', listener);
  },
};

interface RepoState {
  source: DiffStatSource;
  stat: WorkingDiffStat | null;
  subscribers: Set<() => void>;
  timer: ReturnType<typeof setInterval> | null;
  inFlight: Promise<void> | null;
  /** A refresh asked for while a fetch was in flight — the answer that landed
   *  may predate the edit that triggered it, so one trailing fetch follows. */
  again: boolean;
}

export class DiffStatStore {
  private repos = new Map<string, RepoState>();
  private visibilityBound = false;
  private visibility: VisibilitySource;

  constructor(visibility: VisibilitySource = documentVisibility) {
    this.visibility = visibility;
  }

  /** Last known counts for `source`, or `null` before the first fetch lands
   *  (and after one that failed — an unreadable repo reports nothing rather
   *  than a stale number). */
  snapshot(source: DiffStatSource): WorkingDiffStat | null {
    return this.repos.get(diffStatKey(source))?.stat ?? null;
  }

  /** Watch one repo. Returns the unsubscribe; the last one out stops the poll. */
  subscribe(source: DiffStatSource, callback: () => void): () => void {
    this.bindVisibility();
    const state = this.stateFor(source);
    const wasEmpty = state.subscribers.size === 0;
    state.subscribers.add(callback);
    if (wasEmpty) {
      void this.fetch(state);
      this.startTimer(state);
    }
    return () => {
      state.subscribers.delete(callback);
      if (state.subscribers.size > 0) return;
      this.stopTimer(state);
      // Keep the last snapshot: reopening a window on this repo then renders
      // the previous counts immediately instead of flashing empty for a tick.
      this.repos.set(diffStatKey(source), state);
    };
  }

  /**
   * Out-of-band refresh — a lane just went idle in this repo, so the counts are
   * knowably stale a tick early. No-op for a repo nobody is watching.
   */
  refresh(source: DiffStatSource): void {
    const state = this.repos.get(diffStatKey(source));
    if (!state?.subscribers.size) return;
    void this.fetch(state);
  }

  private stateFor(source: DiffStatSource): RepoState {
    const key = diffStatKey(source);
    let state = this.repos.get(key);
    if (!state) {
      state = { source, stat: null, subscribers: new Set(), timer: null, inFlight: null, again: false };
      this.repos.set(key, state);
    }
    return state;
  }

  private startTimer(state: RepoState): void {
    if (state.timer !== null || this.hidden()) return;
    state.timer = setInterval(() => void this.fetch(state), DIFF_STAT_POLL_MS);
  }

  private stopTimer(state: RepoState): void {
    if (state.timer !== null) clearInterval(state.timer);
    state.timer = null;
  }

  /** Single-flight per repo: a tick that lands while the previous git call is
   *  still running rides it rather than spawning a second one. */
  private fetch(state: RepoState): Promise<void> {
    if (state.inFlight) {
      state.again = true;
      return state.inFlight;
    }
    const request = this.fetchRepo(state).finally(() => {
      state.inFlight = null;
      if (state.again) {
        state.again = false;
        if (state.subscribers.size > 0) void this.fetch(state);
      }
    });
    state.inFlight = request;
    return request;
  }

  private async fetchRepo(state: RepoState): Promise<void> {
    let next: WorkingDiffStat | null = null;
    try {
      next = await fetchStat(state.source);
    } catch {
      // A repo that vanished, a missing git, a call that raced a `rm -rf`, a
      // disconnected remote Harness: the rail drops the readout. Never an
      // alert — a status line must not nag.
      next = null;
    }
    state.stat = next;
    for (const callback of state.subscribers) callback();
  }

  private hidden(): boolean {
    return this.visibility.hidden();
  }

  /** Nothing to poll for while the app is hidden — and on return the numbers
   *  are refetched at once, so a user coming back never reads a stale count. */
  private bindVisibility(): void {
    if (this.visibilityBound) return;
    this.visibilityBound = true;
    this.visibility.onChange(() => {
      for (const state of this.repos.values()) {
        if (state.subscribers.size === 0) continue;
        if (this.hidden()) {
          this.stopTimer(state);
        } else {
          void this.fetch(state);
          this.startTimer(state);
        }
      }
    });
  }
}

export const diffStatStore = new DiffStatStore();
