// Spec 302 §3.4 — `ToolRow` (live).
//
// The transcript row for `item.kind === 'tool'`. It ports `renderToolBody`
// (`harness-tool-render.ts:551-627`), `renderToolOutput` + its section builders
// (`:776-860`), the three rich `git` renderings (`:862-1060`) and
// `patchStreamingToolBody` (`:635-664`).
//
// WHAT THE DEP TUPLE REPLACES
// `transcriptRenderSignature` (`harness-transcript-render.ts:472-488`) rebuilt a
// joined string for every visible row on every pass — 3 `.map()` + 4 `.join()`
// over the whole section/diff/subagent payload — and compared it against the
// string stashed on the node. `bodyDeps()` below is that signature as ten
// values (plus spec 370's `jobs`) compared with `Object.is`. Two of them are arrays compared by
// REFERENCE, which is only sound because the lane decoder (`adapters/tool.ts`,
// spec 380) keeps the prior `sections` / `diffs` arrays when the ACP update
// carried no output — tested in `adapters/tool.test.ts`.
//
// `statusBucket` is `toolStatusSignature` (`harness-transcript-render.ts:448-451`):
// `pending` and `in_progress` collapse into one bucket so the in-flight tick
// does not repaint. That is also why `item.status` — which the view keeps in
// step with `tool.status` — is deliberately NOT a dep: the base row's
// `readDeps()` is overridden here for exactly that reason.
//
// THE LIVE CONTRACT
// `appendChunk()` touches ONLY `.acp-harness__tool-output` (or forwards to the
// subagent card). Head nodes are fields, built once, written through guarded
// setters, so even a full `paint()` leaves them alone when nothing moved. The
// `body.dataset.toolStreamSig` / `subagentLiveSig` dedupe keys the old patch
// function stashed on the DOM are gone: the output block dedupes on the subset
// of this component's own deps that it reads, and the card dedupes on its rows'.
//
// The row seals ITSELF: `update()` calls `seal()` once `item.tool.status`
// reaches a terminal value. That is the terminal-status transition spec 301
// names as one of the only `seal()` callers.
//
// The glyph is the `Spinner` component, so the `liveSpinnerGlyph` module global
// (`harness-tool-render.ts:32-39`) is not needed: a repaint of this row does
// not rebuild the spinner node, and the shared frame counter lives in the
// spinner module. Spinner owns its whole `class` attribute, so the three
// `acp-harness__tool-glyph*` classes are re-applied here after `update()`.

import './tool-row.css';

import { sameDeps } from '../../../ui/component';
import { classes, el, setAttr, setChildren } from '../../../ui/dom';
import { disposeList, reconcile, syncOrder } from '../../../ui/list';
import { Chip } from '../chip';
import { DiffBlock, pairedDiffRows, unifiedDiffRows, type DiffBlockProps } from '../diff-block';
import { imageStripSignature } from '../image-strip';
import { Meter } from '../meter';
import { Spinner } from '../spinner';
import { SubagentCard } from '../subagent-card';
import { ExecutionCard } from '../execution-card';
import { RemoteCommandCard } from '../remote-command-card';
import { JobList } from '../job-list';
import { TranscriptRow, type RowProps } from '../transcript-row';
import { jobsSummary, subagentSummary } from '../../harness-subagents';
import { gridifyText } from '../../cell-grid';
import {
  formatToolElapsed,
  isGitDiffCommand,
  isGrepLikeOutput,
  isTerminalToolStatus,
  parseGitDiffStat,
  parseGitStatusShort,
  renderArtifactRedaction,
  renderGrepSection,
  gitStatusTone,
  toolChipKind,
  toolSectionTone,
} from '../../harness-tool-render';
import type { ToolPayload } from '../../harness-view-types';
import type { ComponentDef } from '../types';

const PREFIX = 'acp-harness';

/** A section as the payload carries it. */
interface ToolSection {
  readonly label: string;
  readonly text: string;
}

/** Guarded so a pass that changed nothing writes nothing. */
function setText(node: Node, value: string): void {
  if (node.textContent !== value) node.textContent = value;
}

/** `harness-tool-render.ts:843-860`. A label that only names the payload slot
 *  (`content`, `output`, `stdout`, `text` — the `output` tone) says nothing the
 *  well does not, so it paints no label line. Any other label (stderr, error,
 *  summary, diff, terminal, …) stays.
 *  Output laid out by columns (a frame, a table around Thai) sits on the cell
 *  grid (spec 326); it is built inside the deps-gated rebuild, so it adds no deps. */
function plainSection(section: ToolSection): HTMLElement {
  const tone = toolSectionTone(section.label);
  let label: HTMLElement | null = null;
  if (tone !== 'output') {
    label = el('div', { class: `${PREFIX}__tool-section-label`, text: section.label });
  }
  const text = el('pre', { class: `${PREFIX}__tool-section-text`, text: section.text });
  gridifyText(text);
  return el(
    'div',
    { class: classes(`${PREFIX}__tool-section`, `${PREFIX}__tool-section--${tone}`) },
    label,
    text,
  );
}

/** `harness-tool-render.ts:1003-1019`. */
function gitStatusBlock(
  rows: ReadonlyArray<{ index: string; worktree: string; path: string }>,
): HTMLElement {
  return el(
    'div',
    { class: classes(`${PREFIX}__tool-rich`, `${PREFIX}__tool-rich--gitstatus`) },
    ...rows.map((row) =>
      el(
        'div',
        { class: `${PREFIX}__tool-status-row` },
        el('span', {
          class: classes(
            `${PREFIX}__tool-status-badge`,
            `${PREFIX}__tool-status-badge--${gitStatusTone(row.index, row.worktree)}`,
          ),
          text: `${row.index}${row.worktree}`.trim() || 'M',
        }),
        el('span', {
          class: classes(`${PREFIX}__tool-status-path`, `${PREFIX}__tok-path`),
          text: row.path,
        }),
      ),
    ),
  );
}

export class ToolRow extends TranscriptRow {
  private readonly head = el('div', { class: `${PREFIX}__tool-head` });
  private readonly glyph = new Spinner();
  private readonly kind = new Chip();
  private readonly subject = el('span', { class: `${PREFIX}__tool-subject` });
  private readonly result = el('span');
  /** spec 282 — `3/4 done · background`; spec 370 — `1 running · 2 done` for a
   *  `wait` row. A second `--result` span in the head. */
  private readonly summary = el('span', {
    class: classes(`${PREFIX}__tool-result`, `${PREFIX}__subagent-summary`),
  });
  private readonly timer = el('span');
  private readonly output = el('div', { class: `${PREFIX}__tool-output` });
  private readonly diffs = el('div', { class: `${PREFIX}__tool-diffs` });

  /** `Chip` compares `data` by reference; a new literal per paint would make
   *  every head repaint rebuild the chip's children for nothing. */
  private kindData: Readonly<Record<string, string>> = { kind: '' };
  private card: SubagentCard | null = null;
  private jobList: JobList | null = null;
  private executionCard: ExecutionCard | null = null;
  private remoteCommandCard: RemoteCommandCard | null = null;
  private unidiff: DiffBlock | null = null;
  private readonly statBars: Meter[] = [];
  private statCursor = 0;
  private redaction: HTMLElement | null = null;
  private redactionFor: ToolPayload['artifactRedaction'] = undefined;
  /** The slice of this row's deps that `.acp-harness__tool-output` reads. */
  private outputDeps: readonly unknown[] | null = null;
  private props: RowProps | null = null;

  constructor(props: RowProps) {
    super(props, props.item.tool ? !isTerminalToolStatus(props.item.tool.status) : false);
    this.head.appendChild(this.kind.el);
  }

  update(next: RowProps): void {
    const wasLive = this.isLive;
    this.props = next;
    if (!wasLive && this.remoteCommandCard && next.item.tool?.remoteCommand
      && !next.item.tool.artifactRedaction && !next.item.tool.subagents && !next.item.tool.execution) {
      this.paintRemoteCommand(next);
      return;
    }
    super.update(next);
    // A cold replay can supply its result after an already-terminal start.
    // Only the owning summary changes; the sealed row stays put.
    if (!wasLive) {
      this.paintExecution(next);
      this.paintRemoteCommand(next);
    }
    if (next.item.tool && isTerminalToolStatus(next.item.tool.status)) this.seal(next);
  }

  patchExecutionHint(label: string | null): void {
    this.executionCard?.setHint(label);
  }

  patchRemoteCommandHint(label: string | null): void {
    this.remoteCommandCard?.setHint(label);
  }

  /**
   * The base tuple is replaced, not extended: a tool row's label is the
   * constant `tool`, its `item.status` is the uncollapsed twin of dep 1, and
   * its `streaming` flag is the lane's, not the tool's. The image-strip
   * signature stays — a tool row DOES carry images (`collectToolImages`,
   * `acp-harness-view.ts:14198`).
   */
  protected readDeps(next: RowProps): readonly unknown[] {
    return [imageStripSignature(next.item), next.streaming, ...this.bodyDeps(next)];
  }

  /** Spec 302 §3.4, including spec 370's `jobs`. */
  protected bodyDeps(next: RowProps): readonly unknown[] {
    const tool = next.item.tool;
    if (tool?.execution && !tool.artifactRedaction && !tool.subagents) {
      return [
        isTerminalToolStatus(tool.status) ? tool.status : 'active',
        tool.execution.title,
        tool.execution.language,
        tool.execution.cellStatus,
        tool.execution.durationMs,
        tool.execution.detached,
        tool.diffs,
      ];
    }
    if (tool?.remoteCommand && !tool.artifactRedaction && !tool.subagents && !tool.execution) {
      return [
        tool.remoteCommand, tool.status, tool.startedAt, tool.endedAt, tool.sections,
        next.item.remoteCommandTarget?.hintLabel, tool.diffs,
      ];
    }
    return [
      // `toolStatusSignature` — pending and in_progress share one bucket.
      tool ? (isTerminalToolStatus(tool.status) ? tool.status : 'active') : '',
      tool?.kind,
      tool?.subject,
      tool?.command,
      tool?.result,
      tool?.sections,
      tool?.diffs,
      tool?.subagents,
      (next.item.subagentExpanded ?? []).join('\u001f'),
      tool?.jobs,
    ];
  }

  protected bodyClasses(): readonly string[] {
    return [`${PREFIX}__tool`];
  }

  /**
   * `--streaming` is the lane's flag AND this row's own liveness. The second
   * half is what `seal()` needs: a tool that finished inside a turn that is
   * still streaming must not keep the pulsing label.
   */
  protected syncClasses(next: RowProps): void {
    super.syncClasses({ ...next, streaming: next.streaming && this.isLive });
  }

  protected paintBody(body: HTMLElement, next: RowProps): void {
    const tool = next.item.tool;
    if (!tool) {
      syncOrder(body, []);
      return;
    }
    if (tool.execution && !tool.artifactRedaction && !tool.subagents) {
      this.dropCard();
      this.dropRemoteCommandCard();
      this.dropJobList();
      this.glyph.update({ running: false, terminalGlyph: tool.glyph });
      this.executionCard ??= new ExecutionCard();
      this.paintExecution(next);
      const children: HTMLElement[] = [this.executionCard.el];
      if (tool.diffs.length > 0) {
        this.paintDiffs(tool.diffs);
        children.push(this.diffs);
      }
      syncOrder(body, children);
      return;
    }
    this.dropExecutionCard();
    if (tool.remoteCommand && !tool.artifactRedaction && !tool.subagents) {
      this.dropCard();
      this.dropJobList();
      this.glyph.update({ running: false, terminalGlyph: tool.glyph });
      this.remoteCommandCard ??= new RemoteCommandCard();
      this.paintRemoteCommand(next);
      const children: HTMLElement[] = [this.remoteCommandCard.el];
      if (tool.diffs.length > 0) {
        this.paintDiffs(tool.diffs);
        children.push(this.diffs);
      }
      syncOrder(body, children);
      return;
    }
    this.dropRemoteCommandCard();
    this.paintHead(tool);
    const children: HTMLElement[] = [this.head];

    if (tool.artifactRedaction) {
      // spec 133 — path + bytes + hash, never the HTML, and nothing else.
      if (!this.redaction || this.redactionFor !== tool.artifactRedaction) {
        this.redaction = renderArtifactRedaction(tool.artifactRedaction);
        this.redactionFor = tool.artifactRedaction;
      }
      this.dropCard();
      this.dropJobList();
      children.push(this.redaction);
      syncOrder(body, children);
      return;
    }

    if (tool.subagents) {
      // spec 282: the card replaces the "Running agent X…" sections.
      this.dropJobList();
      this.card ??= new SubagentCard();
      this.card.update({ payload: tool.subagents, expanded: next.item.subagentExpanded ?? [] });
      this.sealSettledCard(next);
      children.push(this.card.el);
    } else if (tool.jobs) {
      // spec 370: the job list replaces the model-facing `wait` text.
      this.dropCard();
      this.jobList ??= new JobList();
      this.jobList.update({ payload: tool.jobs });
      children.push(this.jobList.el);
    } else {
      this.dropCard();
      this.dropJobList();
      this.paintOutput(tool);
      if (tool.sections.length > 0) children.push(this.output);
    }

    if (tool.diffs.length > 0) {
      this.paintDiffs(tool.diffs);
      children.push(this.diffs);
    }
    syncOrder(body, children);
  }

  /** The live pass. Head nodes are never reached from here. */
  protected appendChunk(next: RowProps): void {
    const tool = next.item.tool;
    if (!tool || tool.artifactRedaction) return;
    if (tool.execution && !tool.subagents) {
      this.paintExecution(next);
      return;
    }
    if (tool.remoteCommand && !tool.subagents) {
      this.paintRemoteCommand(next);
      return;
    }
    if (tool.subagents) {
      this.card?.update({ payload: tool.subagents, expanded: next.item.subagentExpanded ?? [] });
      return;
    }
    // A fresh jobs payload per frame moves the deps, so `paint()` already ran.
    if (tool.jobs) return;
    this.paintOutput(tool);
  }

  /** The spinner has already been told to stop by the terminal `paint()`. */
  protected onSeal(): void {
    if (this.props) this.sealSettledCard(this.props);
  }

  /**
   * spec 370: an OMP background spawn returns before its agents finish, so the
   * row seals while the card still has live agents. The card is the owning
   * sub-component of that late state: it stays live, taking each new payload
   * through `update()`, until its agents settle or the turn ends with them
   * last reported — then this seals it. A card cold-mounted in an already
   * sealed row is sealed here on its first paint.
   */
  private sealSettledCard(next: RowProps): void {
    const payload = next.item.tool?.subagents;
    if (!this.card || !payload || this.isLive) return;
    if (payload.background && !payload.lastReported) return;
    this.card.seal({ payload, expanded: next.item.subagentExpanded ?? [] });
  }

  private paintHead(tool: ToolPayload): void {
    const spinning = !isTerminalToolStatus(tool.status);
    this.glyph.update({ running: spinning, terminalGlyph: tool.glyph });
    const glyphClass = classes(
      `${PREFIX}__tool-glyph`,
      `${PREFIX}__tool-glyph--${tool.status}`,
      spinning ? `${PREFIX}__spinner` : null,
    );
    if (this.glyph.el.className !== glyphClass) this.glyph.el.className = glyphClass;

    const chipKind = toolChipKind(tool.kind);
    if (this.kindData.kind !== chipKind) this.kindData = { kind: chipKind };
    // The status LED sits inside the kind chip, before its legend.
    this.kind.update({
      block: `${PREFIX}__tool-kind`,
      text: tool.kind,
      leading: this.glyph.el,
      data: this.kindData,
    });

    const nodes: HTMLElement[] = [this.kind.el];
    if (tool.subject) {
      setText(this.subject, tool.subject);
      setAttr(this.subject, 'title', tool.subject);
      nodes.push(this.subject);
    }
    if (tool.result) {
      this.result.className = classes(`${PREFIX}__tool-result`, `${PREFIX}__tool-result--${tool.status}`);
      setText(this.result, tool.result);
      nodes.push(this.result);
    }
    const summary = tool.subagents ? subagentSummary(tool.subagents) : tool.jobs ? jobsSummary(tool.jobs) : '';
    if (summary) {
      setText(this.summary, summary);
      nodes.push(this.summary);
    }
    if (tool.startedAt !== undefined) {
      this.paintTimer(tool, tool.startedAt);
      nodes.push(this.timer);
    }
    syncOrder(this.head, nodes);
  }

  /** `data-started-at` / `data-ended-at` are the view's 1 s elapsed ticker's
   *  contract (`acp-harness-view.ts` `updateToolTick`), not decoration. */
  private paintTimer(tool: ToolPayload, startedAt: number): void {
    this.timer.className = classes(`${PREFIX}__tool-timer`, `${PREFIX}__tool-timer--${tool.status}`);
    setAttr(this.timer, 'data-started-at', String(startedAt));
    setAttr(this.timer, 'data-ended-at', tool.endedAt === undefined ? undefined : String(tool.endedAt));
    const elapsed = tool.endedAt === undefined ? performance.now() - startedAt : tool.endedAt - startedAt;
    setText(this.timer, formatToolElapsed(elapsed));
  }

  /** `harness-tool-render.ts:791-836`, deduped on the deps the block reads. */
  private paintOutput(tool: ToolPayload): void {
    const deps = [tool.sections, tool.kind, tool.command, tool.subject];
    if (this.outputDeps && sameDeps(this.outputDeps, deps)) return;
    this.outputDeps = deps;
    setChildren(this.output, this.outputNodes(tool));
  }

  private outputNodes(tool: ToolPayload): HTMLElement[] {
    this.statCursor = 0;
    // Spec 380: sections arrive decoded — backend wrappers (Grok's `exit: N`,
    // `<workspace_result>`, read anchors) were removed by the lane adapter.
    const painted: ToolSection[] = tool.sections.filter((section) => section.text.trim());

    const nodes: HTMLElement[] = [];
    for (const section of painted) {
      const rich =
        (tool.kind === 'execute' ? this.richExecuteSection(tool, section) : null) ??
        (isGrepLikeOutput(tool, section) ? renderGrepSection(tool, section) : null);
      if (rich) {
        nodes.push(rich);
        continue;
      }
      nodes.push(plainSection(section));
    }
    return nodes;
  }

  /** `harness-tool-render.ts:862-877` — diffstat, unified diff, short status. */
  private richExecuteSection(tool: ToolPayload, section: ToolSection): HTMLElement | null {
    const label = section.label.toLowerCase();
    if (label !== 'stdout' && label !== 'output') return null;
    if (/\bgit\s+diff\s+--stat\b/.test(tool.command)) {
      const rows = parseGitDiffStat(section.text);
      if (rows.length > 0) return this.diffStatBlock(rows, section.text);
    }
    if (isGitDiffCommand(tool.command) && section.text.includes('diff --git')) {
      this.unidiff ??= new DiffBlock();
      this.unidiff.update({ mode: 'unified', rows: unifiedDiffRows(section.text), prefix: PREFIX });
      return this.unidiff.el;
    }
    if (/\bgit\s+status\s+--short\b/.test(tool.command)) {
      const rows = parseGitStatusShort(section.text);
      if (rows.length > 0) return gitStatusBlock(rows);
    }
    return null;
  }

  /** `harness-tool-render.ts:901-929`; the bar is `Meter` in `diffstat` mode. */
  private diffStatBlock(
    rows: ReadonlyArray<{ path: string; changes: number; plus: number; minus: number }>,
    source: string,
  ): HTMLElement {
    const block = el('div', { class: classes(`${PREFIX}__tool-rich`, `${PREFIX}__tool-rich--diffstat`) });
    const total = Math.max(1, ...rows.map((row) => row.changes));
    for (const row of rows) {
      const bar = this.statBars[this.statCursor] ?? new Meter('diffstat');
      if (this.statBars.length === this.statCursor) this.statBars.push(bar);
      this.statCursor++;
      bar.update({ mode: 'diffstat', value: row.plus, minus: row.minus, max: total });
      block.appendChild(
        el(
          'div',
          { class: `${PREFIX}__tool-stat-row` },
          el('span', {
            class: classes(`${PREFIX}__tool-stat-path`, `${PREFIX}__tok-path`),
            text: row.path,
          }),
          el('span', { class: `${PREFIX}__tool-stat-count`, text: String(row.changes) }),
          bar.el,
        ),
      );
    }
    const omitted =
      source.split('\n').filter((line) => line.trim() && !/\d+\s+files?\s+changed/.test(line)).length -
      rows.length;
    if (omitted > 0) {
      block.appendChild(
        el('div', {
          class: `${PREFIX}__tool-rich-more`,
          text: `${omitted} more file${omitted === 1 ? '' : 's'}`,
        }),
      );
    }
    return block;
  }

  /** One `DiffBlock` per diff, keyed so a second chunk does not rebuild the first. */
  private paintDiffs(diffs: ToolPayload['diffs']): void {
    const items = diffs.map((diff, index) => ({
      key: `${index}:${diff.path}`,
      props: {
        mode: 'paired',
        rows: pairedDiffRows(diff.oldText, diff.newText),
        path: diff.path || undefined,
        prefix: PREFIX,
      } satisfies DiffBlockProps,
    }));
    reconcile<(typeof items)[number], DiffBlock>(this.diffs, items, {
      key: (item) => item.key,
      create: (item) => {
        const block = new DiffBlock();
        block.update(item.props);
        return block;
      },
      update: (block, item) => block.update(item.props),
    });
  }

  private paintExecution(next: RowProps): void {
    const tool = next.item.tool;
    if (!tool?.execution || !this.executionCard) return;
    this.executionCard.update({
      payload: tool.execution,
      status: tool.status,
      startedAt: tool.startedAt,
      endedAt: tool.endedAt,
      hintLabel: next.item.executionTarget?.hintLabel ?? null,
    });
  }

  private paintRemoteCommand(next: RowProps): void {
    const tool = next.item.tool;
    if (!tool?.remoteCommand || !this.remoteCommandCard || tool.artifactRedaction || tool.subagents || tool.execution) return;
    this.remoteCommandCard.update({
      payload: tool.remoteCommand, status: tool.status, startedAt: tool.startedAt, endedAt: tool.endedAt,
      hintLabel: next.item.remoteCommandTarget?.hintLabel ?? null, diagnostics: tool.sections,
    });
  }

  private dropRemoteCommandCard(): void {
    if (!this.remoteCommandCard) return;
    this.remoteCommandCard.dispose();
    this.remoteCommandCard = null;
  }

  private dropExecutionCard(): void {
    if (!this.executionCard) return;
    this.executionCard.el.remove();
    this.executionCard.dispose();
    this.executionCard = null;
  }

  private dropCard(): void {
    if (!this.card) return;
    this.card.el.remove();
    this.card.dispose();
    this.card = null;
  }

  private dropJobList(): void {
    if (!this.jobList) return;
    this.jobList.el.remove();
    this.jobList.dispose();
    this.jobList = null;
  }

  protected onDispose(): void {
    super.onDispose();
    this.dropCard();
    this.dropJobList();
    this.dropExecutionCard();
    this.dropRemoteCommandCard();
    this.glyph.dispose();
    this.kind.dispose();
    this.unidiff?.dispose();
    this.unidiff = null;
    for (const bar of this.statBars) bar.dispose();
    this.statBars.length = 0;
    disposeList(this.diffs);
  }
}

export const def: ComponentDef = {
  id: 'tool-row',
  blocks: [
    'acp-harness__tool',
    'acp-harness__tool-head',
    'acp-harness__tool-glyph',
    'acp-harness__tool-kind',
    'acp-harness__tool-subject',
    'acp-harness__tool-result',
    'acp-harness__tool-timer',
    'acp-harness__tool-output',
    'acp-harness__tool-section',
    'acp-harness__tool-section-label',
    'acp-harness__tool-section-text',
    'acp-harness__tool-rich',
    'acp-harness__tool-rich-more',
    'acp-harness__tool-stat-row',
    'acp-harness__tool-stat-path',
    'acp-harness__tool-stat-count',
    'acp-harness__tool-stat-bar',
    'acp-harness__tool-status-row',
    'acp-harness__tool-status-badge',
    'acp-harness__tool-status-path',
    'acp-harness__tool-diffs',
    'acp-harness__tool-diff',
    'acp-harness__tool-diff-path',
    'acp-harness__tool-diff-file',
    'acp-harness__tool-diff-line',
    'acp-harness__tool-diff-mark',
    'acp-harness__tool-diff-text',
    'acp-harness__tool-body--diff',
    'acp-harness__tool-meta',
    'acp-harness__tool-more',
    'acp-harness__diff-line',
    'acp-harness__diff-num',
    'acp-harness__diff-mark',
    'acp-harness__diff-text',
    'acp-harness__grep-row',
    'acp-harness__tok-path',
    'acp-harness__tok-line',
    'acp-harness__tok-sep',
    'acp-harness__tok-text',
    'acp-harness__tok-hit',
    'acp-harness__tok-ctx',
    'acp-harness__artifact-redaction',
    'acp-harness__artifact-redaction-note',
    'acp-harness__artifact-redaction-meta',
  ],
};
