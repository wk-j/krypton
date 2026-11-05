// Specs 168/169/277/361 — one lane card: name, agent, status pill, live turn
// counter, activity beat, CPU sparkline, memory bar, count chips and the
// lane's `#review pass` loop. The card owns its beat buffer; the CPU sample
// ring lives in its section (`LaneSamples`, one sample per applied snapshot)
// so a card whose lane did not change is not re-rendered, and a lane that
// leaves the snapshot takes its history with it.

import { memo, useRef } from 'react';
import type { JSX, ReactNode } from 'react';

import { Card, Chip, formatAgo, Pill, statusTone } from '../../kit';
import type { Tone } from '../../kit';
import type {
  TelemetryLane,
  TelemetryReviewLoop,
  TelemetryReviewLoopReviewer,
} from '../../../acp/harness-telemetry-schema';
import { drawBeat, drawCpuSpark, heatTone } from './canvas';
import type { BeatState } from './canvas';
import { agentLine, formatElapsed, formatRss, isActiveStatus, PHASE_LABEL, statusKey, statusLabel, turnLine } from './format';
import { FrameCanvas, LiveText } from './frame';

const SAMPLES = 120;
/** Memory-bar full scale (spec 169). */
const MEM_FULL_MB = 2048;

/** Spec 169 — a lane's client-side ring of `cpuPercent` samples. */
export interface LaneSamples {
  readonly ring: number[];
  seeded: boolean;
  /** The latest live CPU sample; null without a live process. */
  cpu: number | null;
  /** The lane object last sampled: one sample per applied snapshot, however often it renders. */
  sampled: TelemetryLane | null;
}

export function createLaneSamples(): LaneSamples {
  return { ring: new Array<number>(SAMPLES).fill(0), seeded: false, cpu: null, sampled: null };
}

/** Push `lane`'s CPU sample (once per lane object). `rootAlive: false` or no sample → reset. */
export function sampleLane(samples: LaneSamples, lane: TelemetryLane): void {
  if (samples.sampled === lane) return;
  samples.sampled = lane;
  if (lane.rootAlive && lane.cpuPercent !== null && lane.cpuPercent !== undefined) {
    const cpu = lane.cpuPercent;
    if (!samples.seeded) {
      samples.ring.fill(cpu);
      samples.seeded = true;
    }
    samples.ring.push(cpu);
    samples.ring.shift();
    samples.cpu = cpu;
  } else {
    samples.cpu = null;
    samples.seeded = false;
  }
}

/** A label that keeps counting between polls: elapsed since, or age of. */
function Ticker({ at, kind }: { readonly at: number; readonly kind: 'since' | 'ago' }): JSX.Element {
  return <LiveText text={(now) => (kind === 'since' ? formatElapsed(now - at) : formatAgo(at, now))} />;
}

function Value({ text, tone }: { readonly text: string; readonly tone: Tone | 'fg' }): JSX.Element {
  return <span className={`lb-dashboard__value lb-dashboard__value--${tone}`}>{text}</span>;
}

function verdictPill(rv: TelemetryReviewLoopReviewer): JSX.Element {
  const v = rv.verdict;
  const tone: Tone = v === 'pass' ? 'add' : v === 'fail' ? 'del' : 'accent';
  const word =
    v === 'fail' ? `FAIL${rv.blockers ? ` ${rv.blockers}` : ''}` : v === 'missing' ? 'no verdict' : String(v ?? '').toUpperCase();
  return <Pill label={word} tone={tone} />;
}

function ReviewerRow({ loop, rv }: { readonly loop: TelemetryReviewLoop; readonly rv: TelemetryReviewLoopReviewer }): JSX.Element {
  let state: ReactNode;
  if (rv.state === 'replied')
    state = rv.repliedAt ? (
      <>
        {'replied '}
        <Ticker at={rv.repliedAt} kind="ago" />
      </>
    ) : (
      'replied'
    );
  else if (rv.state === 'not_sent') state = 'not sent';
  // Withdrawn or never answered: nothing is pending once the round stopped.
  else if (loop.phase !== 'reviewing') state = 'no reply';
  else
    state = (
      <>
        {'pending '}
        <Ticker at={loop.phaseSince} kind="since" />
      </>
    );
  return (
    <div className="lb-dashboard__reviewer">
      <span>
        <span className="lb-dashboard__reviewer-name">{rv.name}</span>
        <span className="lb-dashboard__reviewer-state">{state}</span>
      </span>
      {rv.state === 'replied' ? verdictPill(rv) : null}
    </div>
  );
}

function roundClass(loop: TelemetryReviewLoop, i: number): string {
  const round = loop.rounds[i];
  let className = 'lb-dashboard__round';
  if (round) className += ` lb-dashboard__round--${round.verdict}`;
  if (loop.running && i === loop.round - 1) className += ' lb-dashboard__round--current';
  return className;
}

/** Spec 277 — the lane's review pass loop, flat on the card under one hairline. */
function ReviewLoop({ loop }: { readonly loop: TelemetryReviewLoop }): JSX.Element {
  const cells: JSX.Element[] = [];
  for (let i = 0; i < loop.maxRounds; i++) {
    const round = loop.rounds[i];
    cells.push(
      <i key={i} className={roundClass(loop, i)}>
        {round ? String(round.blockers) : ''}
      </i>,
    );
  }
  const phase = loop.running ? (
    <>
      <span className="lb-dashboard__phase-name">{PHASE_LABEL[loop.phase ?? ''] ?? loop.phase ?? ''}</span>
      {' · '}
      <Ticker at={loop.phaseSince} kind="since" />
    </>
  ) : (
    <>
      {'ended '}
      {loop.endedAt ? <Ticker at={loop.endedAt} kind="ago" /> : null}
    </>
  );
  const note = loop.stopLabel ? (
    <div className="lb-dashboard__loop-note lb-dashboard__loop-note--stop">
      {loop.running ? `stop: ${loop.stopLabel}` : loop.stopLabel}
    </div>
  ) : loop.subjectLabel ? (
    <div className="lb-dashboard__loop-note">{loop.subjectLabel}</div>
  ) : null;
  return (
    <div className="lb-dashboard__loop">
      <div className="lb-dashboard__loop-head">
        <span className="lb-dashboard__label">review pass</span>
        <span className="lb-dashboard__loop-state">{`${loop.round}/${loop.maxRounds}`}</span>
      </div>
      <div className="lb-dashboard__loop-phase">{phase}</div>
      <div className="lb-dashboard__rounds">{cells}</div>
      {loop.reviewers.map((rv, i) => (
        <ReviewerRow key={`${i}:${rv.name}`} loop={loop} rv={rv} />
      ))}
      {note}
    </div>
  );
}

export interface LaneCardProps {
  readonly lane: TelemetryLane;
  /** This lane's CPU ring, stable for the lane's id; sampled by the section. */
  readonly samples: LaneSamples;
}

function LaneCardView({ lane, samples }: LaneCardProps): JSX.Element {
  const status = statusKey(lane.status);
  const tone = statusTone(status);
  const turnActiveSince = lane.turnActiveSince ?? null;
  const beat = useRef<BeatState>({
    status: 'idle',
    tone: 'muted',
    active: false,
    turnActiveSince: null,
    buf: new Array<number>(SAMPLES).fill(0),
    spike: 0,
  });

  const drawLaneBeat = (canvas: Parameters<typeof drawBeat>[0], now: number): void => {
    const state = beat.current;
    state.status = status;
    state.tone = tone;
    state.active = isActiveStatus(status);
    state.turnActiveSince = turnActiveSince;
    drawBeat(canvas, state, now);
  };

  // Spec 169 — `rootAlive: false` or no CPU sample → "—" and a flat baseline.
  const live = lane.rootAlive && lane.cpuPercent !== null && lane.cpuPercent !== undefined;
  const cpu = live ? (lane.cpuPercent ?? 0) : null;
  const rss = lane.rssMb ?? 0;
  const attn = lane.attnOpen || 0;
  const loop = lane.reviewLoop ?? null;

  return (
    <Card tag="article" className="lb-dashboard__lane" data-lane-id={lane.id}>
      <div className="lb-dashboard__lane-head">
        <div className="lb-dashboard__lane-id">
          <div className="lb-dashboard__lane-name">{lane.displayName || lane.id}</div>
          <div className="lb-dashboard__lane-agent">{agentLine(lane)}</div>
        </div>
        <div className="lb-dashboard__lane-pill">
          <Pill label={statusLabel(status)} tone={tone} />
        </div>
      </div>
      <LiveText tag="div" className="lb-dashboard__turn" text={(now) => turnLine(turnActiveSince, now)} />
      <div className="lb-dashboard__row">
        <span className="lb-dashboard__label">activity</span>
      </div>
      <FrameCanvas className="lb-dashboard__beat" height={22} draw={drawLaneBeat} />
      <div className="lb-dashboard__row">
        <span className="lb-dashboard__label">cpu</span>
        {cpu === null ? <Value text="—" tone="muted" /> : <Value text={`${Math.round(cpu)}%`} tone={heatTone(cpu)} />}
      </div>
      <FrameCanvas
        className="lb-dashboard__spark"
        height={40}
        draw={(canvas) => drawCpuSpark(canvas, samples.ring, samples.cpu)}
      />
      <div className="lb-dashboard__mem">
        <div className="lb-dashboard__row">
          <span className="lb-dashboard__label">mem</span>
          {cpu === null ? <Value text="—" tone="muted" /> : <Value text={formatRss(rss)} tone="fg" />}
        </div>
        <div className="lb-dashboard__bar">
          <i className="lb-dashboard__bar-fill" style={{ width: cpu === null ? '0' : `${Math.min(100, (rss / MEM_FULL_MB) * 100)}%` }} />
        </div>
      </div>
      <div className="lb-dashboard__chips">
        <Chip text={`attn ${attn}`} alert={attn > 0} />
        <Chip text={`rev ${lane.reviews || 0}`} />
        <Chip text={`pri ${lane.highPriority || 0}`} />
        <Chip text={`peer ${lane.inboxDepth || 0}`} />
      </div>
      {loop ? <ReviewLoop loop={loop} /> : <div className="lb-dashboard__loop" hidden />}
    </Card>
  );
}

/** Re-render only when the lane's data moved (every poll parses fresh objects). */
export const LaneCard = memo(
  LaneCardView,
  (prev: LaneCardProps, next: LaneCardProps): boolean =>
    prev.samples === next.samples && JSON.stringify(prev.lane) === JSON.stringify(next.lane),
);
