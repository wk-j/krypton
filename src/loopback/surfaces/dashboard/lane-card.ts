// Specs 168/169/277 — one lane card: name, agent, status pill, live turn
// counter, activity beat, CPU sparkline, memory bar, count chips and the
// lane's `#review pass` loop. The card owns its canvases and their sample
// buffers, so a lane that leaves the snapshot takes its history with it.

import { Component } from '../../../ui/component';
import { el, setChildren } from '../../../ui/dom';
import type { ElChild } from '../../../ui/dom';
import { card, chip, formatAgo, pill, statusTone } from '../../kit';
import type { Tone } from '../../kit';
import type {
  TelemetryLane,
  TelemetryReviewLoop,
  TelemetryReviewLoopReviewer,
} from '../../../acp/harness-telemetry-schema';
import { drawBeat, drawCpuSpark, FittedCanvas, heatTone } from './canvas';
import type { BeatState } from './canvas';
import { agentLine, formatElapsed, formatRss, isActiveStatus, PHASE_LABEL, statusKey, statusLabel, turnLine } from './format';

const SAMPLES = 120;
/** Memory-bar full scale (spec 169). */
const MEM_FULL_MB = 2048;

/** A label that keeps counting between polls: elapsed since, or age of. */
interface Ticker {
  readonly node: HTMLElement;
  readonly at: number;
  readonly kind: 'since' | 'ago';
}

function tickText(ticker: Ticker, now: number): string {
  return ticker.kind === 'since' ? formatElapsed(now - ticker.at) : formatAgo(ticker.at, now);
}

export class LaneCard extends Component<TelemetryLane> {
  private readonly name = el('div', { class: 'lb-dashboard__lane-name' });
  private readonly agent = el('div', { class: 'lb-dashboard__lane-agent' });
  private readonly pillSlot = el('div', { class: 'lb-dashboard__lane-pill' });
  private readonly turn = el('div', { class: 'lb-dashboard__turn' });
  private readonly beatCanvas = new FittedCanvas('lb-dashboard__beat', 22);
  private readonly cpuValue = el('span', { class: 'lb-dashboard__value', text: '—' });
  private readonly sparkCanvas = new FittedCanvas('lb-dashboard__spark', 40);
  private readonly memValue = el('span', { class: 'lb-dashboard__value', text: '—' });
  private readonly memFill = el('i', { class: 'lb-dashboard__bar-fill' });
  private readonly chips = el('div', { class: 'lb-dashboard__chips' });
  private readonly loop = el('div', { class: 'lb-dashboard__loop', attrs: { hidden: true } });

  private readonly beat: BeatState = {
    status: 'idle',
    tone: 'muted',
    active: false,
    turnActiveSince: null,
    buf: new Array<number>(SAMPLES).fill(0),
    spike: 0,
  };
  private readonly cpuSamples: number[] = new Array<number>(SAMPLES).fill(0);
  private cpuSeeded = false;
  private cpu: number | null = null;
  private tickers: Ticker[] = [];

  constructor(lane: TelemetryLane) {
    super(card({ tag: 'article', class: 'lb-dashboard__lane' }));
    this.el.append(
      el(
        'div',
        { class: 'lb-dashboard__lane-head' },
        el('div', { class: 'lb-dashboard__lane-id' }, this.name, this.agent),
        this.pillSlot,
      ),
      this.turn,
      el('div', { class: 'lb-dashboard__row' }, el('span', { class: 'lb-dashboard__label', text: 'activity' })),
      this.beatCanvas.el,
      el('div', { class: 'lb-dashboard__row' }, el('span', { class: 'lb-dashboard__label', text: 'cpu' }), this.cpuValue),
      this.sparkCanvas.el,
      el(
        'div',
        { class: 'lb-dashboard__mem' },
        el('div', { class: 'lb-dashboard__row' }, el('span', { class: 'lb-dashboard__label', text: 'mem' }), this.memValue),
        el('div', { class: 'lb-dashboard__bar' }, this.memFill),
      ),
      this.chips,
      this.loop,
    );
    this.el.dataset.laneId = lane.id;
    this.update(lane);
  }

  /** One rAF tick: live counters and both canvases. */
  frame(now: number): void {
    this.turn.textContent = turnLine(this.beat.turnActiveSince, now);
    for (const ticker of this.tickers) ticker.node.textContent = tickText(ticker, now);
    drawBeat(this.beatCanvas, this.beat, now);
    drawCpuSpark(this.sparkCanvas, this.cpuSamples, this.cpu);
  }

  protected readDeps(next: TelemetryLane): readonly unknown[] {
    // Every applied snapshot is a new object and pushes one CPU sample.
    return [next];
  }

  protected paint(lane: TelemetryLane): void {
    const now = Date.now();
    const status = statusKey(lane.status);
    this.name.textContent = lane.displayName || lane.id;
    this.agent.textContent = agentLine(lane);
    this.pillSlot.replaceChildren(pill(statusLabel(status), statusTone(status)));
    this.beat.status = status;
    this.beat.tone = statusTone(status);
    this.beat.active = isActiveStatus(status);
    this.beat.turnActiveSince = lane.turnActiveSince ?? null;
    this.turn.textContent = turnLine(this.beat.turnActiveSince, now);

    const attn = lane.attnOpen || 0;
    setChildren(this.chips, [
      chip(`attn ${attn}`, { alert: attn > 0 }),
      chip(`rev ${lane.reviews || 0}`),
      chip(`pri ${lane.highPriority || 0}`),
      chip(`peer ${lane.inboxDepth || 0}`),
    ]);

    // Spec 169 — `rootAlive: false` or no CPU sample → "—" and a flat baseline.
    if (lane.rootAlive && lane.cpuPercent !== null && lane.cpuPercent !== undefined) {
      const cpu = lane.cpuPercent;
      if (!this.cpuSeeded) {
        this.cpuSamples.fill(cpu);
        this.cpuSeeded = true;
      }
      this.cpuSamples.push(cpu);
      this.cpuSamples.shift();
      this.cpu = cpu;
      this.setValue(this.cpuValue, `${Math.round(cpu)}%`, heatTone(cpu));
      const rss = lane.rssMb ?? 0;
      this.setValue(this.memValue, formatRss(rss), 'fg');
      this.memFill.style.width = `${Math.min(100, (rss / MEM_FULL_MB) * 100)}%`;
    } else {
      this.cpu = null;
      this.cpuSeeded = false;
      this.setValue(this.cpuValue, '—', 'muted');
      this.setValue(this.memValue, '—', 'muted');
      this.memFill.style.width = '0';
    }

    this.paintLoop(lane.reviewLoop ?? null, now);
    this.syncClasses();
  }

  protected syncClasses(): void {
    /* the card's own classes never change; its pill and values are rebuilt */
  }

  private setValue(node: HTMLElement, text: string, tone: Tone | 'fg'): void {
    node.textContent = text;
    node.className = `lb-dashboard__value lb-dashboard__value--${tone}`;
  }

  /** Spec 277 — the lane's review pass loop, flat on the card under one hairline. */
  private paintLoop(loop: TelemetryReviewLoop | null, now: number): void {
    this.tickers = [];
    if (!loop) {
      this.loop.hidden = true;
      this.loop.replaceChildren();
      return;
    }
    this.loop.hidden = false;
    const cells: HTMLElement[] = [];
    for (let i = 0; i < loop.maxRounds; i++) {
      const round = loop.rounds[i];
      cells.push(
        el('i', {
          class: [
            'lb-dashboard__round',
            round && `lb-dashboard__round--${round.verdict}`,
            loop.running && i === loop.round - 1 && 'lb-dashboard__round--current',
          ],
          text: round ? String(round.blockers) : '',
        }),
      );
    }
    const phase: ElChild[] = loop.running
      ? [
          el('span', { class: 'lb-dashboard__phase-name', text: PHASE_LABEL[loop.phase ?? ''] ?? loop.phase ?? '' }),
          ' · ',
          this.ticker(loop.phaseSince, 'since', now),
        ]
      : ['ended ', loop.endedAt ? this.ticker(loop.endedAt, 'ago', now) : null];
    const note = loop.stopLabel
      ? el('div', {
          class: 'lb-dashboard__loop-note lb-dashboard__loop-note--stop',
          text: loop.running ? `stop: ${loop.stopLabel}` : loop.stopLabel,
        })
      : loop.subjectLabel
        ? el('div', { class: 'lb-dashboard__loop-note', text: loop.subjectLabel })
        : null;
    setChildren(this.loop, [
      el(
        'div',
        { class: 'lb-dashboard__loop-head' },
        el('span', { class: 'lb-dashboard__label', text: 'review pass' }),
        el('span', { class: 'lb-dashboard__loop-state', text: `${loop.round}/${loop.maxRounds}` }),
      ),
      el('div', { class: 'lb-dashboard__loop-phase' }, ...phase),
      el('div', { class: 'lb-dashboard__rounds' }, ...cells),
      ...loop.reviewers.map((rv) => this.reviewerRow(loop, rv, now)),
      note,
    ]);
  }

  private reviewerRow(loop: TelemetryReviewLoop, rv: TelemetryReviewLoopReviewer, now: number): HTMLElement {
    let state: ElChild[];
    if (rv.state === 'replied') state = rv.repliedAt ? ['replied ', this.ticker(rv.repliedAt, 'ago', now)] : ['replied'];
    else if (rv.state === 'not_sent') state = ['not sent'];
    // Withdrawn or never answered: nothing is pending once the round stopped.
    else if (loop.phase !== 'reviewing') state = ['no reply'];
    else state = ['pending ', this.ticker(loop.phaseSince, 'since', now)];
    return el(
      'div',
      { class: 'lb-dashboard__reviewer' },
      el(
        'span',
        {},
        el('span', { class: 'lb-dashboard__reviewer-name', text: rv.name }),
        el('span', { class: 'lb-dashboard__reviewer-state' }, ...state),
      ),
      rv.state === 'replied' ? verdictPill(rv) : null,
    );
  }

  private ticker(at: number, kind: Ticker['kind'], now: number): HTMLElement {
    const ticker: Ticker = { node: el('span'), at, kind };
    ticker.node.textContent = tickText(ticker, now);
    this.tickers.push(ticker);
    return ticker.node;
  }
}

function verdictPill(rv: TelemetryReviewLoopReviewer): HTMLElement {
  const v = rv.verdict;
  const tone: Tone = v === 'pass' ? 'add' : v === 'fail' ? 'del' : 'accent';
  const word =
    v === 'fail' ? `FAIL${rv.blockers ? ` ${rv.blockers}` : ''}` : v === 'missing' ? 'no verdict' : String(v ?? '').toUpperCase();
  return pill(word, tone);
}
