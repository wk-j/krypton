// Spec 168 — one harness: heading, attention triage (gauge + flag cards),
// the lane cards, foreign peers and the recent-event feed.

import { Component } from '../../../ui/component';
import { el, setChildren } from '../../../ui/dom';
import { disposeList, listComponents, reconcile } from '../../../ui/list';
import { formatAgo, formatClock } from '../../kit';
import type {
  TelemetryAttentionItem,
  TelemetryEvent,
  TelemetryForeignPeer,
  TelemetrySnapshot,
} from '../../../acp/harness-telemetry-schema';
import { drawGauge, FittedCanvas, gaugeTone } from './canvas';
import { formatEvent, formatTriage } from './format';
import { LaneCard } from './lane-card';

const FEED_CAP = 14;

export class HarnessSection extends Component<TelemetrySnapshot> {
  private readonly title = el('h2', { class: 'lb-h2' });
  private readonly project = el('div', { class: 'lb-dashboard__meta' });
  private readonly triage = el('div', { class: 'lb-dashboard__meta lb-dashboard__triage' });
  private readonly gauge = new FittedCanvas('lb-dashboard__gauge-canvas', 150);
  private readonly gaugeValue = el('b', { class: 'lb-dashboard__gauge-value', text: '0' });
  private readonly flags = el('div', { class: 'lb-dashboard__flags' });
  private readonly lanes = el('div', { class: 'lb-dashboard__lanes' });
  private readonly foreign = el('ul', { class: 'lb-dashboard__foreign', attrs: { hidden: true } });
  private readonly feed = el('div', { class: 'lb-dashboard__feed' });
  private openCount = 0;

  constructor(snap: TelemetrySnapshot) {
    super(el('section', { class: 'lb-dashboard__harness' }));
    this.el.append(
      el(
        'header',
        { class: 'lb-dashboard__harness-head' },
        el('div', {}, this.title, this.project),
        this.triage,
      ),
      el(
        'section',
        { class: 'lb-dashboard__triage-section' },
        el('h3', { class: 'lb-h3', text: 'Attention triage' }),
        el(
          'div',
          { class: 'lb-dashboard__triage-body' },
          el(
            'div',
            { class: 'lb-dashboard__gauge' },
            this.gauge.el,
            el(
              'div',
              { class: 'lb-dashboard__gauge-label' },
              this.gaugeValue,
              el('span', { text: 'flags in review queue' }),
            ),
          ),
          this.flags,
        ),
      ),
      el('section', {}, el('h3', { class: 'lb-h3', text: 'Active lanes' }), this.lanes, this.foreign),
      this.feed,
    );
    this.update(snap);
  }

  /** One rAF tick: the gauge and every lane card. */
  frame(now: number): void {
    drawGauge(this.gauge, this.openCount);
    for (const cmp of listComponents(this.lanes)) {
      if (cmp instanceof LaneCard) cmp.frame(now);
    }
  }

  protected readDeps(next: TelemetrySnapshot): readonly unknown[] {
    return [next];
  }

  protected paint(snap: TelemetrySnapshot): void {
    const id = snap.harnessId || 'harness';
    this.el.dataset.harnessId = id;
    this.title.textContent = id;
    this.project.textContent = snap.projectDir || 'no project';
    this.triage.textContent = formatTriage(snap);

    reconcile(this.lanes, snap.lanes ?? [], {
      key: (lane) => lane.id,
      create: (lane) => new LaneCard(lane),
      update: (cmp, lane) => cmp.update(lane),
    });

    this.paintForeign(snap.foreignPeers ?? []);
    this.paintFlags(snap.attention?.items ?? []);
    this.paintFeed(snap.recentEvents ?? []);

    this.openCount = snap.attention?.openCount ?? 0;
    this.gaugeValue.textContent = String(this.openCount);
    this.syncClasses();
  }

  protected syncClasses(): void {
    this.gaugeValue.className = `lb-dashboard__gauge-value lb-dashboard__gauge-value--${gaugeTone(this.openCount)}`;
  }

  protected onDispose(): void {
    disposeList(this.lanes);
  }

  private paintForeign(peers: readonly TelemetryForeignPeer[]): void {
    this.foreign.hidden = peers.length === 0;
    setChildren(
      this.foreign,
      peers.map((p) =>
        el(
          'li',
          {},
          el('span', { class: 'lb-dashboard__foreign-name', text: p.displayName }),
          ` · ${p.backendId} · ${p.status || 'unknown'}${p.cwd ? ` · ${p.cwd}` : ''}`,
        ),
      ),
    );
  }

  private paintFlags(items: readonly TelemetryAttentionItem[]): void {
    if (items.length === 0) {
      setChildren(this.flags, [el('div', { class: 'lb-dashboard__flags-empty', text: 'no open attention flags' })]);
      return;
    }
    setChildren(
      this.flags,
      items.map((item) => {
        const tier = item.reversibility || 'costly';
        const traded = (item.tradedOff ?? []).join('; ');
        const meta = (label: string, value: string): HTMLElement => el('span', {}, el('b', { text: label }), ` ${value || '-'}`);
        return el(
          'div',
          { class: 'lb-dashboard__flag' },
          el(
            'div',
            { class: 'lb-dashboard__flag-head' },
            el('span', { class: 'lb-dashboard__flag-lane', text: item.laneName || item.laneId || '-' }),
            el('span', {
              class: ['lb-dashboard__flag-tier', `lb-dashboard__flag-tier--${tier}`],
              text: item.createdAt ? `${tier} · ${formatAgo(item.createdAt)}` : tier,
            }),
          ),
          el('div', { class: 'lb-dashboard__flag-question', text: item.question || 'untitled attention flag' }),
          el(
            'div',
            { class: 'lb-dashboard__flag-meta' },
            meta('because', item.rationale),
            meta('chosen', item.chosen),
            meta('uncertainty', item.uncertainty),
            traded ? meta('tradeoff', traded) : null,
          ),
        );
      }),
    );
  }

  private paintFeed(events: readonly TelemetryEvent[]): void {
    const rows = events.slice(-FEED_CAP).reverse();
    const row = (t: string, who: string, msg: string): HTMLElement =>
      el(
        'div',
        { class: 'lb-dashboard__event' },
        el('span', { class: 'lb-dashboard__event-time', text: t }),
        el('span', { class: 'lb-dashboard__event-lane', text: who }),
        el('span', { class: 'lb-dashboard__event-text', text: msg }),
      );
    setChildren(
      this.feed,
      rows.length === 0
        ? [row('-', '-', 'waiting for events')]
        : rows.map((ev) => row(formatClock(ev.at || Date.now()), ev.laneName || '-', formatEvent(ev))),
    );
  }
}
