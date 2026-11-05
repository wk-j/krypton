// Specs 168/361 — one harness: heading, attention triage (gauge + flag cards),
// the lane cards, foreign peers and the recent-event feed.

import { memo, useLayoutEffect, useState } from 'react';
import type { JSX } from 'react';

import { formatAgo, formatClock } from '../../kit';
import type { TelemetryAttentionItem, TelemetrySnapshot } from '../../../acp/harness-telemetry-schema';
import { drawGauge, gaugeTone } from './canvas';
import { formatEvent, formatTriage } from './format';
import { FrameCanvas } from './frame';
import { createLaneSamples, LaneCard, sampleLane } from './lane-card';
import type { LaneSamples } from './lane-card';

const FEED_CAP = 14;

function FlagMeta({ label, value }: { readonly label: string; readonly value: string }): JSX.Element {
  return (
    <span>
      <b>{label}</b>
      {` ${value || '-'}`}
    </span>
  );
}

function Flag({ item }: { readonly item: TelemetryAttentionItem }): JSX.Element {
  const tier = item.reversibility || 'costly';
  const traded = (item.tradedOff ?? []).join('; ');
  return (
    <div className="lb-dashboard__flag">
      <div className="lb-dashboard__flag-head">
        <span className="lb-dashboard__flag-lane">{item.laneName || item.laneId || '-'}</span>
        <span className={`lb-dashboard__flag-tier lb-dashboard__flag-tier--${tier}`}>
          {item.createdAt ? `${tier} · ${formatAgo(item.createdAt)}` : tier}
        </span>
      </div>
      <div className="lb-dashboard__flag-question">{item.question || 'untitled attention flag'}</div>
      <div className="lb-dashboard__flag-meta">
        <FlagMeta label="because" value={item.rationale} />
        <FlagMeta label="chosen" value={item.chosen} />
        <FlagMeta label="uncertainty" value={item.uncertainty} />
        {traded ? <FlagMeta label="tradeoff" value={traded} /> : null}
      </div>
    </div>
  );
}

function FeedRow({ time, who, text }: { readonly time: string; readonly who: string; readonly text: string }): JSX.Element {
  return (
    <div className="lb-dashboard__event">
      <span className="lb-dashboard__event-time">{time}</span>
      <span className="lb-dashboard__event-lane">{who}</span>
      <span className="lb-dashboard__event-text">{text}</span>
    </div>
  );
}

/** `laneId`'s CPU ring, created on first sight and stable while the lane stays in the snapshot. */
function samplesFor(rings: Map<string, LaneSamples>, laneId: string): LaneSamples {
  let entry = rings.get(laneId);
  if (!entry) {
    entry = createLaneSamples();
    rings.set(laneId, entry);
  }
  return entry;
}

function HarnessSectionView({ snap }: { readonly snap: TelemetrySnapshot }): JSX.Element {
  const id = snap.harnessId || 'harness';
  const lanes = snap.lanes ?? [];
  const peers = snap.foreignPeers ?? [];
  const items = snap.attention?.items ?? [];
  const events = (snap.recentEvents ?? []).slice(-FEED_CAP).reverse();
  const openCount = snap.attention?.openCount ?? 0;

  const [rings] = useState(() => new Map<string, LaneSamples>());
  // Every applied snapshot pushes one CPU sample per lane; a gone lane drops its ring.
  useLayoutEffect(() => {
    const live = new Set<string>();
    for (const lane of snap.lanes ?? []) {
      live.add(lane.id);
      sampleLane(samplesFor(rings, lane.id), lane);
    }
    for (const laneId of rings.keys()) if (!live.has(laneId)) rings.delete(laneId);
  }, [snap, rings]);

  return (
    <section className="lb-dashboard__harness" data-harness-id={id}>
      <header className="lb-dashboard__harness-head">
        <div>
          <h2 className="lb-h2">{id}</h2>
          <div className="lb-dashboard__meta">{snap.projectDir || 'no project'}</div>
        </div>
        <div className="lb-dashboard__meta lb-dashboard__triage">{formatTriage(snap)}</div>
      </header>
      <section className="lb-dashboard__triage-section">
        <h3 className="lb-h3">Attention triage</h3>
        <div className="lb-dashboard__triage-body">
          <div className="lb-dashboard__gauge">
            <FrameCanvas className="lb-dashboard__gauge-canvas" height={150} draw={(canvas) => drawGauge(canvas, openCount)} />
            <div className="lb-dashboard__gauge-label">
              <b className={`lb-dashboard__gauge-value lb-dashboard__gauge-value--${gaugeTone(openCount)}`}>{String(openCount)}</b>
              <span>flags in review queue</span>
            </div>
          </div>
          <div className="lb-dashboard__flags">
            {items.length === 0 ? (
              <div className="lb-dashboard__flags-empty">no open attention flags</div>
            ) : (
              items.map((item, i) => <Flag key={item.id || i} item={item} />)
            )}
          </div>
        </div>
      </section>
      <section>
        <h3 className="lb-h3">Active lanes</h3>
        <div className="lb-dashboard__lanes">
          {lanes.map((lane) => (
            <LaneCard key={lane.id} lane={lane} samples={samplesFor(rings, lane.id)} />
          ))}
        </div>
        <ul className="lb-dashboard__foreign" hidden={peers.length === 0}>
          {peers.map((p, i) => (
            <li key={i}>
              <span className="lb-dashboard__foreign-name">{p.displayName}</span>
              {` · ${p.backendId} · ${p.status || 'unknown'}${p.cwd ? ` · ${p.cwd}` : ''}`}
            </li>
          ))}
        </ul>
      </section>
      <div className="lb-dashboard__feed">
        {events.length === 0 ? (
          <FeedRow time="-" who="-" text="waiting for events" />
        ) : (
          events.map((ev, i) => (
            <FeedRow key={i} time={formatClock(ev.at || Date.now())} who={ev.laneName || '-'} text={formatEvent(ev)} />
          ))
        )}
      </div>
    </section>
  );
}

/** Every applied snapshot is a new object: the section repaints, its unchanged lane cards do not. */
export const HarnessSection = memo(HarnessSectionView);
