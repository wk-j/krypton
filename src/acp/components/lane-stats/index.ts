// Spec 302 §4.4 — `LaneStats`.
//
// The understats line under an active lane's head:
// `sess 4f2a9c · krypton · ⌁128.4k/200.0k (64%) · cache 93% · in … out … ·
//  $0.4412 USD · ⚒37 · ≡412`. Ported from `harness-lane-chrome.ts:464-534`
// (`renderLaneStats`), which built it as one joined HTML string.
//
// Each cell is a `StatList` row in `inline` layout — a bare `<span>` with an
// optional `title`, which is exactly the markup that function emitted. Rows
// carry stable keys so a cell that only appears once usage arrives (cost,
// cache) does not shift its neighbours' nodes.

import './lane-stats.css';

import { Component } from '../../../ui/component';
import { el, frag } from '../../../ui/dom';
import { basename, formatCount, shortId, truncate } from '../../harness-format';
import { harnessIconEl } from '../../harness-icons';
import { isPollyImplementerBypass } from '../../harness-lane-chrome';
import type { HarnessLane } from '../../harness-view-types';
import { cacheHitRate, formatCacheHitPercent } from '../../usage-log';
import { StatList, type StatRowProps } from '../stat-list';
import type { ComponentDef } from '../types';

export interface LaneStatsProps {
  readonly lane: HarnessLane;
  readonly projectDir: string | null;
}

/**
 * The cells, in the order `renderLaneStats` pushed them.
 *
 * spec 215 follow-up: no backend logo/id cell here — the head's name span one
 * line up already carries the logo, and repeating it made the stats row read
 * as a second head instead of head metadata.
 */
function statRows(lane: HarnessLane, projectDir: string | null): StatRowProps[] {
  const rows: StatRowProps[] = [];
  rows.push({ key: 'sess', label: '', value: lane.sessionId ? `sess ${shortId(lane.sessionId)}` : 'sess pending' });
  if (projectDir) rows.push({ key: 'dir', label: '', value: basename(projectDir) });

  const usage = lane.usage;
  if (usage) {
    if (typeof usage.used === 'number') {
      const val = typeof usage.size === 'number' && usage.size > 0
        ? `${formatCount(usage.used)}/${formatCount(usage.size)} (${Math.round((usage.used / usage.size) * 100)}%)`
        : formatCount(usage.used);
      rows.push({ key: 'ctx', label: '', value: val, icon: { id: 'gauge' }, title: `context ${val}` });
    }
    const hitRate = lane.lastTurnTokens ? cacheHitRate(lane.lastTurnTokens) : null;
    if (hitRate !== null && lane.lastTurnTokens) {
      const percent = formatCacheHitPercent(hitRate);
      const r = formatCount(lane.lastTurnTokens.cachedRead ?? 0);
      const w = formatCount(lane.lastTurnTokens.cachedWrite ?? 0);
      const input = formatCount(lane.lastTurnTokens.input ?? 0);
      rows.push({
        key: 'cache',
        label: '',
        value: `cache ${percent}`,
        title: `this turn ${percent} · read ${r} · write ${w} · input ${input}`,
      });
    } else {
      // Prefer the coherent latest turn even for the raw fallback; the merged
      // display aggregate may retain cache fields that this turn omitted.
      const rawCache = lane.lastTurnTokens ?? {
        cachedRead: usage.cachedReadTokens,
        cachedWrite: usage.cachedWriteTokens,
      };
      if (typeof rawCache.cachedRead === 'number' || typeof rawCache.cachedWrite === 'number') {
        const r = formatCount(rawCache.cachedRead ?? 0);
        const w = formatCount(rawCache.cachedWrite ?? 0);
        rows.push({
          key: 'cache',
          label: '',
          // Four interleaved children (text, ↓, text, ↑) in one bare cell — a
          // fragment, because that cell is the `<span>` itself and nothing may
          // wrap the halves.
          value: frag(
            `cache ${r}`,
            harnessIconEl('dl', 'acp-harness__icon--dot'),
            w,
            harnessIconEl('ul', 'acp-harness__icon--dot'),
          ),
          title: `cache read ${r}, write ${w}`,
        });
      }
    }
    if (typeof usage.inputTokens === 'number' || typeof usage.outputTokens === 'number') {
      rows.push({
        key: 'io',
        label: '',
        value: `in ${formatCount(usage.inputTokens ?? 0)} out ${formatCount(usage.outputTokens ?? 0)}`,
      });
    }
    if (usage.cost) {
      rows.push({ key: 'cost', label: '', value: `$${usage.cost.amount.toFixed(4)} ${usage.cost.currency}` });
    }
  }

  if (lane.toolCalls.size > 0) {
    rows.push({
      key: 'tools',
      label: '',
      value: String(lane.toolCalls.size),
      icon: { id: 'tool' },
      title: `${lane.toolCalls.size} tool calls`,
    });
  }
  rows.push({
    key: 'rows',
    label: '',
    value: String(lane.transcript.length),
    icon: { id: 'list' },
    title: `${lane.transcript.length} transcript rows`,
  });
  if (lane.pendingPermissions.length > 0) rows.push({ key: 'perm', label: '', value: `${lane.pendingPermissions.length} perm` });
  if (lane.pendingQuestions.length > 0) rows.push({ key: 'ask', label: '', value: `${lane.pendingQuestions.length} ask` });
  if (lane.acceptAllForTurn) rows.push({ key: 'accept-all', label: '', value: 'accept-all' });
  if (lane.rejectAllForTurn) rows.push({ key: 'reject-all', label: '', value: 'reject-all' });
  if (lane.peerAutoAcceptForTurn) rows.push({ key: 'peer-auto', label: '', value: 'peer-auto' });
  if (isPollyImplementerBypass(lane)) rows.push({ key: 'polly-bypass', label: '', value: 'polly-bypass' });
  if (lane.error) rows.push({ key: 'err', label: '', value: `err: ${truncate(lane.error, 48)}` });

  return rows;
}

export class LaneStats extends Component<LaneStatsProps> {
  private readonly list: StatList;

  constructor() {
    super(el('div', { class: 'acp-harness__lane-stats' }));
    // The list adopts the stats container, so the inline cells stay direct
    // children of `.acp-harness__lane-stats` — the `span:not(:last-child)::after`
    // separator rule depends on that.
    this.list = new StatList('inline', this.el);
  }

  /**
   * Named field by field: `HarnessLane` is mutated in place, so the lane object
   * and its `usage` object are both unusable as dependencies.
   */
  protected readDeps(next: LaneStatsProps): readonly unknown[] {
    const lane = next.lane;
    const usage = lane.usage;
    const tokens = lane.lastTurnTokens;
    return [
      next.projectDir,
      lane.sessionId,
      usage === null,
      usage?.used,
      usage?.size,
      usage?.inputTokens,
      usage?.outputTokens,
      usage?.cachedReadTokens,
      usage?.cachedWriteTokens,
      usage?.cost?.amount,
      usage?.cost?.currency,
      tokens === null,
      tokens?.input,
      tokens?.cachedRead,
      tokens?.cachedWrite,
      lane.toolCalls.size,
      lane.transcript.length,
      lane.pendingPermissions.length,
      lane.pendingQuestions.length,
      lane.acceptAllForTurn,
      lane.rejectAllForTurn,
      lane.peerAutoAcceptForTurn,
      lane.pollyBuiltinRole,
      lane.permissionMode,
      lane.error,
    ];
  }

  protected syncClasses(): void {
    this.el.className = 'acp-harness__lane-stats';
  }

  protected paint(next: LaneStatsProps): void {
    this.syncClasses();
    this.list.update({
      rows: statRows(next.lane, next.projectDir),
      block: 'acp-harness__lane-stats',
      layout: 'inline',
    });
  }

  protected onDispose(): void {
    this.list.dispose();
  }
}

export const def: ComponentDef = { id: 'lane-stats', blocks: ['acp-harness__lane-stats'] };
