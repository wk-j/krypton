// Spec 168 — the lane monitor: polls `/telemetry` every second and renders
// one section per harness (attention gauge, flag cards, lane cards, event
// feed). Read-only; the canvases redraw on every animation frame.

import { el } from '../../../ui/dom';
import { disposeList, listComponents, reconcile } from '../../../ui/list';
import { Banner, dot, fetchJson, poll, StatBar } from '../../kit';
import type { BannerTone, Poller, PollStatus } from '../../kit';
import { TELEMETRY_SCHEMA_VERSION } from '../../../acp/harness-telemetry-schema';
import type { TelemetrySnapshot } from '../../../acp/harness-telemetry-schema';
import { formatUptime } from './format';
import { HarnessSection } from './harness-section';

import './dashboard.css';

const POLL_MS = 1000;

export interface TelemetryPoll {
  /** Snapshots this page can read (exact schema match). */
  readonly snapshots: TelemetrySnapshot[];
  /** Harnesses answered, but none on this page's schema: the page is stale. */
  readonly mismatch: boolean;
}

function isCurrentSnapshot(value: unknown): value is TelemetrySnapshot {
  return (
    typeof value === 'object' &&
    value !== null &&
    'schemaVersion' in value &&
    value.schemaVersion === TELEMETRY_SCHEMA_VERSION
  );
}

/** Keep the snapshots on `TELEMETRY_SCHEMA_VERSION`; drop the rest. */
export function readTelemetry(body: unknown): TelemetryPoll {
  const raw =
    typeof body === 'object' && body !== null && 'harnesses' in body && Array.isArray(body.harnesses)
      ? (body.harnesses as unknown[])
      : [];
  const snapshots = raw.filter(isCurrentSnapshot);
  return { snapshots, mismatch: raw.length > 0 && snapshots.length === 0 };
}

export class DashboardView {
  readonly el: HTMLElement;
  private readonly stats = new StatBar([], { align: 'end' });
  private readonly session = el('div', { class: 'lb-dashboard__session', text: 'connecting...' });
  private readonly banner = new Banner();
  private readonly harnesses = el('div', { class: 'lb-dashboard__harnesses' });
  private readonly startedAt = Date.now();
  private readonly poller: Poller;
  private liveDot: HTMLElement = dot('idle');
  private snapshots: TelemetrySnapshot[] = [];
  private live = false;
  private mismatch = false;
  private everLoaded = false;
  private status: PollStatus = 'loading';
  private frameId = 0;

  constructor() {
    this.el = el(
      'div',
      { class: 'lb-page lb-dashboard' },
      el(
        'header',
        { class: 'lb-dashboard__head' },
        el('div', { class: 'lb-dashboard__brand' }, this.liveDot, this.session),
        this.stats.el,
      ),
      this.banner.el,
      this.harnesses,
      el('footer', {
        class: 'lb-dashboard__footer',
        text: 'read-only observation · polls /telemetry · activity = synthetic status pulse · sparkline = lane CPU% (live while active)',
      }),
    );
    this.paintStats(Date.now());
    this.poller = poll<TelemetryPoll>({
      load: async (signal) => readTelemetry(await fetchJson<unknown>('/telemetry', { signal })),
      apply: (value) => this.apply(value),
      onStatus: (status) => {
        this.status = status;
        this.paintStatus();
      },
      signature: (value) =>
        value.mismatch
          ? 'schema-mismatch'
          : JSON.stringify(value.snapshots.map((s) => [s.harnessId, s.version, s.generatedAt])),
      intervalMs: POLL_MS,
    });
    this.frameId = requestAnimationFrame(this.frame);
  }

  /** Load now; resolves once the in-flight poll settles. */
  refresh(): Promise<void> {
    return this.poller.refresh();
  }

  dispose(): void {
    this.poller.dispose();
    cancelAnimationFrame(this.frameId);
    disposeList(this.harnesses);
    this.banner.dispose();
    this.stats.dispose();
  }

  private readonly frame = (): void => {
    const now = Date.now();
    this.paintStats(now);
    for (const cmp of listComponents(this.harnesses)) {
      if (cmp instanceof HarnessSection) cmp.frame(now);
    }
    this.frameId = requestAnimationFrame(this.frame);
  };

  private apply(value: TelemetryPoll): void {
    this.everLoaded = true;
    this.mismatch = value.mismatch;
    this.snapshots = value.snapshots;
    reconcile(this.harnesses, this.snapshots, {
      key: (snap) => snap.harnessId || 'harness',
      create: (snap) => new HarnessSection(snap),
      update: (cmp, snap) => cmp.update(snap),
    });
    this.paintStats(Date.now());
    const live = this.snapshots.length > 0;
    if (live !== this.live) {
      const next = dot(live ? 'live' : 'idle');
      this.liveDot.replaceWith(next);
      this.liveDot = next;
      this.live = live;
    }
    this.paintStatus();
  }

  private paintStats(now: number): void {
    let lanes = 0;
    let turns = 0;
    for (const snap of this.snapshots) {
      for (const lane of snap.lanes ?? []) {
        lanes++;
        turns += lane.observedTurns || 0;
      }
    }
    this.stats.update([
      { key: 'uptime', label: 'uptime', value: formatUptime(now - this.startedAt) },
      { key: 'harnesses', label: 'harnesses', value: this.snapshots.length },
      { key: 'lanes', label: 'lanes', value: lanes },
      { key: 'turns', label: 'observed turns', value: turns },
    ]);
  }

  /** The session line and the state banner, from the poll status and the last applied value. */
  private paintStatus(): void {
    let text: string;
    let session: string;
    let tone: BannerTone = 'info';
    if (this.status === 'reconnecting') {
      text = this.everLoaded ? 'reconnecting...' : 'connecting...';
      session = text;
      tone = this.everLoaded ? 'error' : 'info';
    } else if (this.status === 'loading' && !this.everLoaded) {
      text = 'connecting...';
      session = text;
    } else if (this.mismatch) {
      text = 'refresh the dashboard (schema mismatch)';
      session = 'schema mismatch';
      tone = 'error';
    } else if (this.snapshots.length > 0) {
      text = 'live telemetry';
      session = 'live';
      tone = 'ok';
    } else {
      text = 'no active harness yet';
      session = text;
    }
    this.session.textContent = session;
    this.banner.show(text, tone);
  }
}
