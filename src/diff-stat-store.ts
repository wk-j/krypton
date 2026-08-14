// Krypton — window status-bar diff stat (spec 220): the polling store.
//
// Keyed by *repo root*, not by window: four windows open on one project share
// one timer and one git call per tick. Ref-counted like `UsageStore` — the
// first subscriber for a root starts its poll, the last one stops it — so a
// repo nobody is looking at costs nothing.
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

  /** Last known counts for `repoRoot`, or `null` before the first fetch lands
   *  (and after one that failed — an unreadable repo reports nothing rather
   *  than a stale number). */
  snapshot(repoRoot: string): WorkingDiffStat | null {
    return this.repos.get(repoRoot)?.stat ?? null;
  }

  /** Watch one repo. Returns the unsubscribe; the last one out stops the poll. */
  subscribe(repoRoot: string, callback: () => void): () => void {
    this.bindVisibility();
    const state = this.stateFor(repoRoot);
    const wasEmpty = state.subscribers.size === 0;
    state.subscribers.add(callback);
    if (wasEmpty) {
      void this.fetch(repoRoot);
      this.startTimer(repoRoot, state);
    }
    return () => {
      state.subscribers.delete(callback);
      if (state.subscribers.size > 0) return;
      this.stopTimer(state);
      // Keep the last snapshot: reopening a window on this repo then renders
      // the previous counts immediately instead of flashing empty for a tick.
      this.repos.set(repoRoot, state);
    };
  }

  /**
   * Out-of-band refresh — a lane just went idle in this repo, so the counts are
   * knowably stale a tick early. No-op for a repo nobody is watching.
   */
  refresh(repoRoot: string): void {
    if (!this.repos.get(repoRoot)?.subscribers.size) return;
    void this.fetch(repoRoot);
  }

  private stateFor(repoRoot: string): RepoState {
    let state = this.repos.get(repoRoot);
    if (!state) {
      state = { stat: null, subscribers: new Set(), timer: null, inFlight: null, again: false };
      this.repos.set(repoRoot, state);
    }
    return state;
  }

  private startTimer(repoRoot: string, state: RepoState): void {
    if (state.timer !== null || this.hidden()) return;
    state.timer = setInterval(() => void this.fetch(repoRoot), DIFF_STAT_POLL_MS);
  }

  private stopTimer(state: RepoState): void {
    if (state.timer !== null) clearInterval(state.timer);
    state.timer = null;
  }

  /** Single-flight per repo: a tick that lands while the previous git call is
   *  still running rides it rather than spawning a second one. */
  private fetch(repoRoot: string): Promise<void> {
    const state = this.stateFor(repoRoot);
    if (state.inFlight) {
      state.again = true;
      return state.inFlight;
    }
    const request = this.fetchRepo(repoRoot, state).finally(() => {
      state.inFlight = null;
      if (state.again) {
        state.again = false;
        if (state.subscribers.size > 0) void this.fetch(repoRoot);
      }
    });
    state.inFlight = request;
    return request;
  }

  private async fetchRepo(repoRoot: string, state: RepoState): Promise<void> {
    let next: WorkingDiffStat | null = null;
    try {
      next = await invoke<WorkingDiffStat>('working_diff_stat', { cwd: repoRoot });
    } catch {
      // A repo that vanished, a missing git, a call that raced a `rm -rf`: the
      // rail drops the readout. Never a notification — a status line must not nag.
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
      for (const [repoRoot, state] of this.repos) {
        if (state.subscribers.size === 0) continue;
        if (this.hidden()) {
          this.stopTimer(state);
        } else {
          void this.fetch(repoRoot);
          this.startTimer(repoRoot, state);
        }
      }
    });
  }
}

export const diffStatStore = new DiffStatStore();
