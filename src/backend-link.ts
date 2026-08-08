// Krypton — Backend Link Probe (spec 213)
//
// Krypton talks to an off-machine backend (the Xenon resource server, spec 212)
// but nothing in the workspace said whether that link was alive: `#xenon status`
// reports *configuration* and never touches the network, so a server that is
// down, a revoked token, and a healthy link all looked the same until a push
// failed. This scheduler runs a periodic authenticated probe and publishes the
// result on the ViewBus; the workspace footer owns the presentation.

import { invoke } from '@tauri-apps/api/core';

import type { ViewBus } from './view-bus';
import { SYSTEM_SOURCE } from './view-bus-types';
import type { BackendLinkState } from './view-bus-types';

/** Mirrors the Rust `xenon::LinkReport`. */
interface LinkReport {
  state: BackendLinkState;
  baseUrl: string;
  project: string;
  detail: string | null;
  latencyMs: number | null;
  checkedAt: number;
}

const BACKEND_ID = 'xenon';
const DEFAULT_INTERVAL_SECS = 60;

export class BackendLinkProbe {
  private readonly bus: ViewBus;
  private cwd: string | null = null;
  private intervalSecs = DEFAULT_INTERVAL_SECS;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  /** Guards against a slow probe overlapping the next tick. */
  private inFlight = false;
  private lastState: BackendLinkState = 'off';
  private readonly onVisibilityChange = (): void => {
    // A hidden workspace has no one to inform, so ticks are skipped while
    // hidden; coming back is exactly when a stale reading matters.
    if (document.visibilityState === 'visible') void this.probeNow();
  };

  constructor(bus: ViewBus) {
    this.bus = bus;
  }

  /** Interval in seconds; `0` disables the timer, leaving manual (`⌘P X`) and
   *  push-driven updates. Safe to call again on config hot-reload. */
  setIntervalSecs(secs: number): void {
    const next = Number.isFinite(secs) && secs > 0 ? Math.floor(secs) : 0;
    if (next === this.intervalSecs) return;
    this.intervalSecs = next;
    if (this.running) this.restartTimer();
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    this.restartTimer();
    await this.probeNow();
  }

  stop(): void {
    this.running = false;
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Probe once and publish the result. Returns the state so a caller that
   * triggered it by hand (`⌘P X`) can report what it found.
   */
  async probeNow(): Promise<BackendLinkState> {
    // A probe already in flight will publish its own result; reporting `off`
    // here would tell a `⌘P X` caller the backend is switched off, which is a
    // different and wrong answer.
    if (this.inFlight) return this.lastState;
    this.inFlight = true;
    try {
      const cwd = await this.resolveCwd();
      if (!cwd) return this.lastState;
      const report = await invoke<LinkReport>('xenon_probe', { cwd });
      this.publish(report);
      return report.state;
    } catch (e) {
      // The command only errors on a poisoned config lock; treat it as a fault
      // rather than swallowing it, so the segment does not go quietly stale.
      console.warn('[Krypton] xenon_probe failed:', e);
      this.publish({
        state: 'offline',
        baseUrl: '',
        project: '',
        detail: String(e),
        latencyMs: null,
        checkedAt: Math.floor(Date.now() / 1000),
      });
      return 'offline';
    } finally {
      this.inFlight = false;
    }
  }

  private publish(report: LinkReport): void {
    this.lastState = report.state;
    this.bus.publishSignal({
      kind: 'system:backend-link',
      source: SYSTEM_SOURCE,
      value: {
        backendId: BACKEND_ID,
        label: BACKEND_ID,
        baseUrl: report.baseUrl,
        project: report.project,
        state: report.state,
        detail: report.detail,
        latencyMs: report.latencyMs,
        checkedAt: report.checkedAt,
      },
    });
  }

  private restartTimer(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.intervalSecs <= 0) return;
    this.timer = setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      void this.probeNow();
    }, this.intervalSecs * 1000);
  }

  private async resolveCwd(): Promise<string | null> {
    if (this.cwd) return this.cwd;
    try {
      this.cwd = await invoke<string>('get_app_cwd');
    } catch {
      this.cwd = null;
    }
    return this.cwd;
  }
}

/**
 * spec 213: map a `#push` outcome onto the same link signal. A completed
 * interaction is stronger evidence than a probe and costs no extra request, so
 * the segment updates from it directly.
 */
export function publishLinkFromPush(
  bus: ViewBus,
  outcome: {
    baseUrl: string;
    project: string;
    reachedServer: boolean;
    unauthorized: boolean;
    detail: string | null;
  },
): void {
  const state: BackendLinkState = outcome.unauthorized
    ? 'unauthorized'
    : outcome.reachedServer
      ? 'linked'
      : 'offline';
  bus.publishSignal({
    kind: 'system:backend-link',
    source: SYSTEM_SOURCE,
    value: {
      backendId: BACKEND_ID,
      label: BACKEND_ID,
      baseUrl: outcome.baseUrl,
      project: outcome.project,
      state,
      detail: state === 'linked' ? null : outcome.detail,
      latencyMs: null,
      checkedAt: Math.floor(Date.now() / 1000),
    },
  });
}
