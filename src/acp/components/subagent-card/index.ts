// Spec 302 §3.5 — `SubagentCard` (live).
//
// The per-agent card a subagent-spawning tool renders inside its row (spec
// 282). Ported from `harness-subagents.ts:353-455`: `renderSubagentCard` built
// a whole fresh card on every pass and `morphSubagentCard` then walked the new
// tree against the mounted one, replacing any node whose tag or child count had
// moved. That morph is what kept the running glyph's pulse animation and an
// expanded detail's scroll alive — at the cost of building the entire card,
// twice over, on every progress tick.
//
// Here the morph IS the component contract: `reconcile()` keys the rows by
// agent id, so one agent's progress updates one row and its siblings are not
// touched at all, and each row's own dep tuple decides whether even that row
// writes. `appendChunk()` is the live path — the Claude card mutates its
// payload IN PLACE (`absorbChildToolCall` / `appendChildOutput`
// `harness-subagents.ts:305-319`), so payload reference equality cannot see
// those updates and the live pass must re-offer the entries to the rows every
// time. The card's own deps are the structural key the old code already
// computed (`subagentStructureSignature`), nothing more.
//
// The `+N more` tail is a reconcile item rather than an appended sibling: the
// reconciler owns every child of `.acp-harness__subagents`, and a node it does
// not know about would be removed and re-appended on every live pass.

import './subagent-card.css';

import { Component, LiveComponent } from '../../../ui/component';
import { classes, el, setAttr, setChildren } from '../../../ui/dom';
import { reconcile, syncOrder, type ListNode } from '../../../ui/list';
import { subagentStructureSignature } from '../../harness-subagents';
import { gridifyText } from '../../cell-grid';
import { formatToolElapsed } from '../../harness-tool-render';
import type { SubagentEntry, SubagentPayload, SubagentStatus } from '../../harness-view-types';
import type { ComponentDef } from '../types';

/** `harness-subagents.ts:339-345`, unchanged. The cancelled glyph is U+2013. */
const STATUS_GLYPH: Readonly<Record<SubagentStatus, string>> = {
  pending: '\u25cb',
  running: '\u25cf',
  completed: '\u2713',
  failed: '\u2717',
  cancelled: '\u2013',
};

/** `harness-subagents.ts:380-385` — tools / tokens / elapsed, `·`-joined. */
export function subagentStats(entry: SubagentEntry): string {
  return [
    entry.toolCount !== null ? `${entry.toolCount} tools` : '',
    entry.tokens === null
      ? ''
      : entry.tokens >= 1000
        ? `${Math.round(entry.tokens / 1000)}k tok`
        : `${entry.tokens} tok`,
    entry.durationMs !== null && entry.durationMs > 0 ? formatToolElapsed(entry.durationMs) : '',
  ]
    .filter(Boolean)
    .join(' \u00b7 ');
}

/** Guarded so a live pass that changed nothing writes nothing. */
function setText(node: Node, value: string): void {
  if (node.textContent !== value) node.textContent = value;
}

/** What a reconciled child of the card accepts. */
interface CardChild extends ListNode {
  sync(item: CardItem, expanded: readonly string[]): void;
}

interface CardItem {
  readonly key: string;
  /** Null for the overflow tail. */
  readonly entry: SubagentEntry | null;
  readonly overflow: number;
}

/** One entry line. Private to `SubagentCard` — nothing else mounts it. */
interface SubagentRowProps {
  readonly entry: SubagentEntry;
  readonly expanded: boolean;
}

class SubagentRow extends Component<SubagentRowProps> implements CardChild {
  private readonly line = el('div', { class: 'acp-harness__subagent-line' });
  private readonly hint = el('span', { class: 'acp-harness__subagent-hint' });
  private readonly glyph = el('span', { class: 'acp-harness__subagent-glyph' });
  private readonly name = el('span', { class: 'acp-harness__subagent-name' });
  private readonly agent = el('span', { class: 'acp-harness__subagent-agent' });
  private readonly activity = el('span', { class: 'acp-harness__subagent-activity' });
  private readonly stats = el('span', { class: 'acp-harness__subagent-stats' });
  private readonly tools = el('span', { class: 'acp-harness__subagent-tools' });
  private readonly detail = el('div', { class: 'acp-harness__subagent-detail' });

  /** `data-subagent-id` is the view's click target (`acp-harness-view.ts:14352`). */
  constructor(id: string) {
    super(el('div', { data: { 'subagent-id': id } }));
  }

  sync(item: CardItem, expanded: readonly string[]): void {
    if (!item.entry) return;
    this.update({ entry: item.entry, expanded: expanded.includes(item.entry.id) });
  }

  protected readDeps(next: SubagentRowProps): readonly unknown[] {
    const entry = next.entry;
    return [
      entry.id,
      entry.agent,
      entry.status,
      entry.hintLabel,
      entry.activity,
      entry.recentTools.join('\u001f'),
      entry.toolCount,
      entry.tokens,
      entry.durationMs,
      next.expanded,
      // Task and output are painted only inside an open detail.
      next.expanded ? entry.task : null,
      next.expanded ? entry.output : null,
    ];
  }

  protected syncClasses(next: SubagentRowProps): void {
    this.el.className = classes(
      'acp-harness__subagent',
      `acp-harness__subagent--${next.entry.status}`,
      next.entry.hintLabel ? 'acp-harness__subagent--hinted' : null,
    );
  }

  protected paint(next: SubagentRowProps): void {
    const entry = next.entry;
    this.syncClasses(next);
    setAttr(this.el, 'data-subagent-id', entry.id);

    if (entry.hintLabel) setText(this.hint, entry.hintLabel);
    setText(this.glyph, STATUS_GLYPH[entry.status]);
    setText(this.name, entry.id);
    if (entry.agent) setText(this.agent, entry.agent);
    setText(this.activity, entry.activity);
    setText(this.stats, subagentStats(entry));
    syncOrder(this.line, [
      ...(entry.hintLabel ? [this.hint] : []),
      this.glyph,
      this.name,
      ...(entry.agent ? [this.agent] : []),
      this.activity,
      this.stats,
    ]);

    // The recent-tool trail is shown only while the agent can still add to it.
    const tools =
      entry.recentTools.length > 0 && (entry.status === 'running' || entry.status === 'pending');
    if (tools) setText(this.tools, `\u21b3 ${entry.recentTools.join(' \u00b7 ')}`);
    if (next.expanded) this.paintDetail(entry);
    syncOrder(this.el, [this.line, ...(tools ? [this.tools] : []), ...(next.expanded ? [this.detail] : [])]);
  }

  /** `harness-subagents.ts:390-402` — TASK then OUTPUT, each label + `<pre>`. */
  private paintDetail(entry: SubagentEntry): void {
    const nodes: HTMLElement[] = [];
    for (const [label, value] of [
      ['TASK', entry.task],
      ['OUTPUT', entry.output],
    ] as const) {
      if (!value) continue;
      nodes.push(el('span', { class: 'acp-harness__subagent-detail-label', text: label }));
      const text = el('pre', { class: 'acp-harness__subagent-detail-text', text: value });
      gridifyText(text); // spec 326
      nodes.push(text);
    }
    if (!entry.task && !entry.output) {
      nodes.push(
        el('span', {
          class: 'acp-harness__subagent-detail-label',
          text: 'no task or output yet',
        }),
      );
    }
    setChildren(this.detail, nodes);
  }
}

interface MoreRowProps {
  readonly count: number;
}

/** The `+N more` tail — a reconciled child so the card owns every node. */
class MoreRow extends Component<MoreRowProps> implements CardChild {
  constructor() {
    super(el('span'));
  }

  sync(item: CardItem, _expanded: readonly string[]): void {
    this.update({ count: item.overflow });
  }

  protected readDeps(next: MoreRowProps): readonly unknown[] {
    return [next.count];
  }

  protected syncClasses(_next: MoreRowProps): void {
    this.el.className = 'acp-harness__subagent-more';
  }

  protected paint(next: MoreRowProps): void {
    this.syncClasses(next);
    setText(this.el, `+${next.count} more`);
  }
}

export interface SubagentCardProps {
  readonly payload: SubagentPayload;
  /** Entry ids whose inline detail is open (`item.subagentExpanded`). */
  readonly expanded: readonly string[];
}

export class SubagentCard extends LiveComponent<SubagentCardProps> {
  /** Kept so `onSeal()` can land the final live fields: `seal()` re-derives
   *  classes but never paints, and the settled card must show its last stats. */
  private last: SubagentCardProps | null = null;

  constructor() {
    super(el('div'));
  }

  update(next: SubagentCardProps): void {
    this.last = next;
    super.update(next);
  }

  /**
   * The structural key the old renderer already computed. Everything else an
   * agent row paints — activity, recent tools, counters, output — is a dep of
   * the ROW, reached through `appendChunk()` while the card is live.
   */
  protected readDeps(next: SubagentCardProps): readonly unknown[] {
    return [subagentStructureSignature(next.payload, next.expanded)];
  }

  protected syncClasses(next: SubagentCardProps): void {
    this.el.className = 'acp-harness__subagents';
    setAttr(this.el, 'data-background', next.payload.background ? '1' : '0');
  }

  protected paint(next: SubagentCardProps): void {
    this.syncClasses(next);
    this.sync(next);
  }

  /** Live progress: re-offer every entry; each row's deps decide. */
  protected appendChunk(next: SubagentCardProps): void {
    this.sync(next);
  }

  protected onSeal(): void {
    if (this.last) this.sync(this.last);
  }

  private sync(next: SubagentCardProps): void {
    const items: CardItem[] = next.payload.agents.map((entry) => ({
      key: `agent:${entry.id}`,
      entry,
      overflow: 0,
    }));
    if (next.payload.overflow > 0) {
      items.push({ key: 'more', entry: null, overflow: next.payload.overflow });
    }
    reconcile<CardItem, CardChild>(this.el, items, {
      key: (item) => item.key,
      create: (item) => {
        const child: CardChild = item.entry ? new SubagentRow(item.entry.id) : new MoreRow();
        child.sync(item, next.expanded);
        return child;
      },
      update: (child, item) => child.sync(item, next.expanded),
    });
  }
}

export const def: ComponentDef = {
  id: 'subagent-card',
  blocks: [
    'acp-harness__subagents',
    'acp-harness__subagent',
    'acp-harness__subagent-line',
    'acp-harness__subagent-hint',
    'acp-harness__subagent-glyph',
    'acp-harness__subagent-name',
    'acp-harness__subagent-agent',
    'acp-harness__subagent-activity',
    'acp-harness__subagent-stats',
    'acp-harness__subagent-tools',
    'acp-harness__subagent-more',
    'acp-harness__subagent-detail',
    'acp-harness__subagent-detail-label',
    'acp-harness__subagent-detail-text',
  ],
};
