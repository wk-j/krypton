// Specs 168/170/341/361 — the lane monitor: polls `/telemetry` every second
// and renders one section per harness (attention gauge, flag cards, lane
// cards, event feed). Read-only; the canvases redraw on every animation frame.

import { useState } from 'react';
import type { JSX } from 'react';

import { Banner, Dot, fetchJson, StatBar, usePoll } from '../../kit';
import type { BannerTone } from '../../kit';
import { TELEMETRY_SCHEMA_VERSION } from '../../../acp/harness-telemetry-schema';
import type { TelemetrySnapshot } from '../../../acp/harness-telemetry-schema';
import { formatUptime } from './format';
import { FrameProvider, useFrame } from './frame';
import { HarnessSection } from './harness-section';

import './dashboard.css';

const POLL_MS = 1000;
const NO_SNAPSHOTS: readonly TelemetrySnapshot[] = [];

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

/** The summary row; the uptime ticks per frame without re-rendering the page. */
function DashboardStats({
  snapshots,
  startedAt,
}: {
  readonly snapshots: readonly TelemetrySnapshot[];
  readonly startedAt: number;
}): JSX.Element {
  const [uptime, setUptime] = useState(() => formatUptime(Date.now() - startedAt));
  useFrame((now) => setUptime(formatUptime(now - startedAt)));
  let lanes = 0;
  let turns = 0;
  for (const snap of snapshots) {
    for (const lane of snap.lanes ?? []) {
      lanes++;
      turns += lane.observedTurns || 0;
    }
  }
  return (
    <StatBar
      align="end"
      stats={[
        { key: 'uptime', label: 'uptime', value: uptime },
        { key: 'harnesses', label: 'harnesses', value: snapshots.length },
        { key: 'lanes', label: 'lanes', value: lanes },
        { key: 'turns', label: 'observed turns', value: turns },
      ]}
    />
  );
}

/** The page (non-reader: portalled into `#lb-main`; it reads no props). */
export function DashboardPage(): JSX.Element {
  const [startedAt] = useState(() => Date.now());
  const { value, status } = usePoll<TelemetryPoll>({
    load: async (signal) => readTelemetry(await fetchJson<unknown>('/telemetry', { signal })),
    signature: (next) =>
      next.mismatch ? 'schema-mismatch' : JSON.stringify(next.snapshots.map((s) => [s.harnessId, s.version, s.generatedAt])),
    intervalMs: POLL_MS,
  });
  const everLoaded = value !== undefined;
  const snapshots = value?.snapshots ?? NO_SNAPSHOTS;

  // The session line and the state banner, from the poll status and the last applied value.
  let text: string;
  let session: string;
  let tone: BannerTone = 'info';
  if (status === 'reconnecting') {
    text = everLoaded ? 'reconnecting...' : 'connecting...';
    session = text;
    tone = everLoaded ? 'error' : 'info';
  } else if (status === 'loading' && !everLoaded) {
    text = 'connecting...';
    session = text;
  } else if (value?.mismatch) {
    text = 'refresh the dashboard (schema mismatch)';
    session = 'schema mismatch';
    tone = 'error';
  } else if (snapshots.length > 0) {
    text = 'live telemetry';
    session = 'live';
    tone = 'ok';
  } else {
    text = 'no active harness yet';
    session = text;
  }

  return (
    <FrameProvider>
      <div className="lb-page lb-dashboard">
        <header className="lb-dashboard__head">
          <div className="lb-dashboard__brand">
            <Dot state={snapshots.length > 0 ? 'live' : 'idle'} />
            <div className="lb-dashboard__session">{session}</div>
          </div>
          <DashboardStats snapshots={snapshots} startedAt={startedAt} />
        </header>
        <Banner text={text} tone={tone} />
        <div className="lb-dashboard__harnesses">
          {snapshots.map((snap) => (
            <HarnessSection key={snap.harnessId || 'harness'} snap={snap} />
          ))}
        </div>
        <footer className="lb-dashboard__footer">
          read-only observation · polls /telemetry · activity = synthetic status pulse · sparkline = lane CPU% (live while active)
        </footer>
      </div>
    </FrameProvider>
  );
}
