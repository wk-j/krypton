// Spec 302 §4.5 — `RailEntry`.
//
// One lane row in the zen-mode left rail: status dot, backend logo, head line
// (name · peer glyphs · tool count · context count) and the meta line (role tag
// + trimmed directive title + pending hint, or the compact permission/status
// hint). Ported from `acp-harness-view.ts:13053-13171` (`renderRailEntry`),
// which rebuilt the whole entry — `document.createElement` + one `innerHTML` —
// on every rail refresh.
//
// `peerHint` arrives as a prop rather than being derived here: it needs the
// coordinator and the *other* lanes' statuses (`deriveRailPeerHint`), neither
// of which a lane-scoped component may reach for.

import './rail-entry.css';

import { Component } from '../../../ui/component';
import { classes, el } from '../../../ui/dom';
import { syncOrder } from '../../../ui/list';
import { formatCount } from '../../harness-format';
import type { CommandRunView } from '../../harness-command-runs';
import { compactPermissionMeta } from '../../harness-lane-chrome';
import {
  BACKEND_LABELS,
  backendLogoId,
  directiveRole,
  directiveTagLabel,
  trimBackendPrefix,
} from '../../harness-lane-identity';
import type { HarnessLane } from '../../harness-view-types';
import type { RailPeerHint } from '../../lane-peek';
import type { HarnessDirective } from '../../../config';
import { Chip, type ChipProps } from '../chip';
import { statusLabel } from '../lane-symbol';
import type { ComponentDef } from '../types';

/**
 * The directive the meta line shows, plus how it got there.
 *
 * spec 124: a pending change is shown when it actually differs from the current
 * binding — a swap (`directiveId` → different id) or a clear (`directiveId` →
 * null while a directive is bound). For a pending clear the meta line keeps
 * showing the currently bound directive (with the strike on the tag), so the
 * user can see which directive is being removed. `pending !== 'none'` therefore
 * always comes with a directive to show, which is why this is one object.
 */
export interface RailDirective {
  readonly directive: HarnessDirective;
  readonly pending: 'none' | 'swap' | 'clear';
}

export interface RailEntryProps {
  readonly lane: HarnessLane;
  readonly active: boolean;
  readonly peerHint: RailPeerHint;
  readonly directive: RailDirective | null;
  readonly reviewCount: number;
  /** spec 343: built-in `#` commands in flight on this lane, oldest first. */
  readonly runs: readonly CommandRunView[];
}

const SVG_NS = 'http://www.w3.org/2000/svg';

export class RailEntry extends Component<RailEntryProps> {
  private readonly dotEl = el('span', { class: 'acp-harness__rail-dot' });
  private readonly logoEl = el('span', { attrs: { 'aria-hidden': 'true' } });
  private readonly headEl = el('span', { class: 'acp-harness__rail-head' });
  private readonly nameEl = el('span', { class: 'acp-harness__rail-name' });
  private readonly peersEl = el('span', { class: 'acp-harness__rail-peers' });
  private readonly metaEl = el('span', { class: 'acp-harness__rail-meta' });
  private readonly metaTitleEl = el('span', { class: 'acp-harness__rail-meta__title' });
  private readonly metaHintEl = el('span', { class: 'acp-harness__rail-meta__hint' });
  private readonly metaRunEl = el('span', { class: 'acp-harness__rail-meta__run' });
  private readonly reviewEl = el('span', { class: 'acp-harness__rail-review-count' });
  private readonly chipPool = new Map<string, Chip>();
  private logoId: string | null = null;
  private accent: string | null = null;
  /** Derived in `readDeps()` so the string the meta line shows is itself the
   *  dependency — `pendingPermissions[0]` is mutated in place. */
  private nextHint = '';
  /** spec 343: the run text the meta line shows; '' when none or a decision wins. */
  private nextRun = '';

  constructor() {
    super(el('div'));
    this.el.append(this.dotEl, this.logoEl, this.headEl, this.metaEl);
  }

  protected readDeps(next: RailEntryProps): readonly unknown[] {
    const lane = next.lane;
    this.nextHint = next.directive ? '' : railStatusHint(lane);
    this.nextRun = railRunText(next);
    return [
      lane.status,
      lane.accent,
      lane.displayName,
      lane.backendId,
      lane.toolCalls.size,
      lane.usage?.used,
      lane.usage?.size,
      next.active,
      next.peerHint.awaitingSuffix,
      next.peerHint.inboxSuffix,
      next.peerHint.trafficSuffix,
      next.peerHint.title,
      next.peerHint.kind,
      next.directive?.directive.id,
      next.directive?.directive.title,
      next.directive?.directive.task,
      next.directive?.pending,
      next.reviewCount,
      this.nextHint,
      this.nextRun,
      next.runs.map((run) => run.text).join('\n'),
    ];
  }

  protected syncClasses(next: RailEntryProps): void {
    const hint = next.peerHint;
    this.el.className = classes(
      'acp-harness__rail-entry',
      `acp-harness__rail-entry--${next.lane.status}`,
      next.active && 'acp-harness__rail-entry--active',
      hint.kind !== 'none' && `acp-harness__rail-entry--peer-${hint.kind}`,
      next.directive && 'acp-harness__rail-entry--directive',
      next.directive && next.directive.pending !== 'none' && 'acp-harness__rail-entry--pending',
    );
  }

  protected paint(next: RailEntryProps): void {
    const lane = next.lane;
    this.syncClasses(next);
    if (lane.accent !== this.accent) {
      this.accent = lane.accent;
      this.el.style.setProperty('--acp-lane-accent', lane.accent);
    }
    this.paintLogo(lane.backendId);

    const live = new Set<string>();
    this.paintHead(next, live);
    this.paintMeta(next, live);
    for (const [key, chip] of this.chipPool) {
      if (live.has(key)) continue;
      chip.dispose();
      this.chipPool.delete(key);
    }

    const titleBase = next.peerHint.title ? `${next.peerHint.title} · ` : '';
    const meta = next.directive;
    const titleDirective = meta
      ? ` · directive ${meta.directive.id}`
        + (meta.pending === 'swap' ? ' (next send)' : meta.pending === 'clear' ? ' (clear next send)' : '')
      : '';
    const titleRuns = next.runs.length > 0 ? ` · running ${next.runs.map((run) => run.text).join(', ')}` : '';
    this.el.title = `${titleBase}${statusLabel(lane.status)}${titleDirective}${titleRuns}`;

    if (next.reviewCount > 0) {
      this.reviewEl.textContent = `${next.reviewCount} reviews`;
      if (this.reviewEl.parentNode !== this.el) this.el.appendChild(this.reviewEl);
    } else {
      this.reviewEl.remove();
    }
  }

  /** The rail logo is a bare `<svg><use/></svg>` inside an `aria-hidden` span,
   *  sized by `.acp-harness__rail-logo svg` — deliberately NOT the
   *  `.acp-harness__icon` wrapper `harnessSymbolEl()` produces, which carries a
   *  1em box and would shrink the 14px rail mark. */
  private paintLogo(backendId: string): void {
    this.logoEl.className = classes(
      'acp-harness__rail-logo',
      `acp-harness__rail-logo--${backendId === 'pi-acp' ? 'pi' : BACKEND_LABELS[backendId] ? backendId : 'omp'}`,
    );
    const logoId = backendLogoId(backendId);
    if (logoId === this.logoId) return;
    this.logoId = logoId;
    const svg = document.createElementNS(SVG_NS, 'svg');
    const use = document.createElementNS(SVG_NS, 'use');
    use.setAttribute('href', `#${logoId}`);
    svg.appendChild(use);
    this.logoEl.replaceChildren(svg);
  }

  private paintHead(next: RailEntryProps, live: Set<string>): void {
    const lane = next.lane;
    this.nameEl.textContent = lane.displayName;
    const nodes: HTMLElement[] = [this.nameEl];

    const hint = next.peerHint;
    const peers: HTMLElement[] = [];
    if (hint.awaitingSuffix) peers.push(this.chip('peer-awaiting', live, peerChip('awaiting', hint.awaitingSuffix)));
    if (hint.inboxSuffix) peers.push(this.chip('peer-inbox', live, peerChip('inbox', hint.inboxSuffix)));
    if (hint.trafficSuffix) peers.push(this.chip('peer-traffic', live, peerChip('traffic', hint.trafficSuffix)));
    // spec 118 — one wrapper span around the glyphs so the head's flex columns
    // stay put when only some glyphs are present; absent entirely when none are.
    if (peers.length > 0) {
      syncOrder(this.peersEl, peers);
      nodes.push(this.peersEl);
    } else {
      this.peersEl.remove();
    }

    const toolCount = lane.toolCalls.size;
    if (toolCount > 0) {
      nodes.push(this.chip('tools', live, {
        block: 'acp-harness__rail-metric',
        modifiers: ['acp-harness__rail-metric--tools'],
        text: formatCount(toolCount),
        title: `${toolCount} tool call${toolCount === 1 ? '' : 's'}`,
      }));
    }
    const usage = lane.usage;
    const ctxUsed = usage && typeof usage.used === 'number' ? usage.used : null;
    if (usage && ctxUsed !== null) {
      const size = usage.size;
      nodes.push(this.chip('ctx', live, {
        block: 'acp-harness__rail-metric',
        modifiers: ['acp-harness__rail-metric--ctx'],
        text: formatCount(ctxUsed),
        title: typeof size === 'number' && size > 0
          ? `context ${ctxUsed}/${size} tokens`
          : `context ${ctxUsed} tokens`,
      }));
    }
    syncOrder(this.headEl, nodes);
  }

  /** spec 125 — the meta line is a role tag chip + trimmed directive title (the
   *  user icon it replaced carried less per pixel), or the compact permission /
   *  status hint when no directive is bound. spec 343: a running built-in takes
   *  the status word's place, or the directive title's; the head line has no
   *  room for it. */
  private paintMeta(next: RailEntryProps, live: Set<string>): void {
    const meta = next.directive;
    if (this.nextRun) this.metaRunEl.textContent = this.nextRun;
    if (!meta) {
      if (this.nextRun) {
        syncOrder(this.metaEl, [this.metaRunEl]);
        return;
      }
      this.metaHintEl.textContent = this.nextHint;
      syncOrder(this.metaEl, [this.metaHintEl]);
      return;
    }
    const tag = this.chip('tag', live, {
      block: 'acp-harness__rail-tag',
      text: directiveTagLabel(meta.directive.task),
      modifiers: [
        `acp-harness__rail-tag--${directiveRole(meta.directive.task)}`,
        ...(meta.pending === 'clear' ? ['acp-harness__rail-tag--clearing'] : []),
      ],
    });
    const raw = meta.directive.title.trim();
    this.metaTitleEl.textContent = trimBackendPrefix(raw, next.lane.backendId) || raw || meta.directive.id;
    const nodes: HTMLElement[] = [tag, this.nextRun ? this.metaRunEl : this.metaTitleEl];
    if (meta.pending === 'swap' || meta.pending === 'clear') {
      this.metaHintEl.textContent = meta.pending === 'swap' ? '· next send' : '· clear next send';
      nodes.push(this.metaHintEl);
    } else {
      this.metaHintEl.remove();
    }
    syncOrder(this.metaEl, nodes);
  }

  private chip(key: string, live: Set<string>, props: ChipProps): HTMLElement {
    live.add(key);
    let cmp = this.chipPool.get(key);
    if (!cmp) {
      cmp = new Chip();
      this.chipPool.set(key, cmp);
    }
    cmp.update(props);
    return cmp.el;
  }

  protected onDispose(): void {
    for (const chip of this.chipPool.values()) chip.dispose();
    this.chipPool.clear();
  }
}

function peerChip(kind: 'awaiting' | 'inbox' | 'traffic', glyph: string): ChipProps {
  return {
    block: 'acp-harness__rail-peer',
    modifiers: [`acp-harness__rail-peer--${kind}`],
    text: glyph,
  };
}

/** spec 343: the first run, `+N` for the rest. A lane waiting on the user keeps
 *  its permission/question hint — the decision outranks the run. */
function railRunText(next: RailEntryProps): string {
  const [first, ...rest] = next.runs;
  if (!first) return '';
  if (!next.directive && next.lane.status === 'needs_permission') return '';
  return rest.length > 0 ? `${first.text} +${rest.length}` : first.text;
}

/** The meta hint for a lane with no directive bound. */
function railStatusHint(lane: HarnessLane): string {
  if (lane.status !== 'needs_permission') return statusLabel(lane.status);
  if (lane.pendingPermissions.length > 0) return compactPermissionMeta(lane.pendingPermissions[0]);
  if (lane.pendingQuestions.length > 0) {
    return `ask · 1–9/Enter · x ${lane.pendingQuestions[0]?.wire === 'elicitation' ? 'decline' : 'skip'}`;
  }
  return statusLabel(lane.status);
}

export const def: ComponentDef = {
  id: 'rail-entry',
  blocks: [
    'acp-harness__rail-entry',
    'acp-harness__rail-dot',
    'acp-harness__rail-logo',
    'acp-harness__rail-head',
    'acp-harness__rail-name',
    'acp-harness__rail-peers',
    'acp-harness__rail-peer',
    'acp-harness__rail-metric',
    'acp-harness__rail-meta',
    'acp-harness__rail-tag',
    'acp-harness__rail-review-count',
  ],
};
