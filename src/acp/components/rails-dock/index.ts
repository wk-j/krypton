// Spec 337 §UI Content — `RailsDock`.
//
//   RAILS  [3 findings]  14:02
//   auto run · codex-1 · trusted · mode auto
//   check 2/3 typecheck
//   checks ─────────────────────────── [2]
//   typecheck   PASS     1.2s
//   findings ───────────────────────── [3]
//   violation  0008#2  src/acp/x.ts:12   new
//     note on its own line
//   resolved 1
//   rules ──────────────────────────── [4]
//   24 rules · 9 enforced · 15 judge-only
//   3 sources without rails
//   runs ───────────────────────────── [5]
//   14:02  •  3 open  codex-1  stale
//   j/k · ↵ · 1–5 · s send · r run · [ ] tab · esc
//
// **Props only.** The row list is `railsDockRows(model)` — the same list the
// controller moves the selection over — so the painted order and the `j`/`k`
// order cannot disagree. Selection and expansion live in the model; the
// component only reflects them. One delegated click listener on the root
// reports the clicked row's key.
//
// The root is the `<aside class="acp-harness__rails-dock">` the view creates:
// its class and `hidden` are placement, owned by the dock column. The
// component appends its content block `.acp-rails-dock` and never touches
// the root's attributes.
//
// Times are local `HH:MM`, never relative ages, so nothing here needs a timer.
// Model findings are neutral evidence (ADR-0004); only a failed check uses the
// fault colour (ADR-0017).

import './rails-dock.css';

import { Component } from '../../../ui/component';
import { classes, el, setAttr } from '../../../ui/dom';
import { disposeList, listComponent, reconcile } from '../../../ui/list';
import { railsDockRows, shortRuleId } from '../../rails/rows';
import type {
  RailsCheckOutcome,
  RailsCheckResult,
  RailsDockModel,
  RailsDockRow,
  RailsDockSection,
  RailsFinding,
  RailsMode,
  RailsProgress,
  RailsRuleStatus,
  RailsRunRecord,
  RailsSnapshot,
  RailsVerdict,
} from '../../rails/types';
import type { ComponentDef } from '../types';

export interface RailsDockProps {
  readonly model: RailsDockModel;
  readonly onSelectRow?: (key: string) => void;
}

export const RAILS_DOCK_KEY_HINTS = 'j/k · ↵ · 1–5 · s send · r run · [ ] tab · esc';

const B = 'acp-rails-dock';

const SECTION_LABEL: Record<Exclude<RailsDockSection, 1>, string> = {
  2: 'checks',
  3: 'findings',
  4: 'rules',
  5: 'runs',
};

const OUTCOME_LABEL: Record<RailsCheckOutcome, string> = {
  pass: 'PASS',
  fail: 'FAIL',
  timeout: 'TIMEOUT',
  error: 'ERROR',
};

const VERDICT_GLYPH: Record<RailsVerdict, string> = {
  clean: '✓',
  check_failed: '✗',
  findings: '•',
  error: '!',
};

const RULE_STATUS_LABEL: Record<RailsRuleStatus, string> = {
  violated: 'violated',
  suspect: 'suspect',
  clean: 'clean',
  'out-of-scope': 'out of scope',
  pass: 'pass',
  fail: 'fail',
};

// ── formatting ──────────────────────────────────────────────────────────────

/** Local `HH:MM` of an RFC 3339 string or epoch ms; `--:--` when unparseable. */
export function localHhMm(at: string | number): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return '--:--';
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function formatDuration(ms: number): string {
  return `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
}

function location(finding: RailsFinding): string {
  return finding.line === null ? finding.file : `${finding.file}:${finding.line}`;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function triggerText(run: RailsRunRecord): string {
  const kind = run.trigger.kind === 'auto' ? 'auto run' : 'manual run';
  return run.trigger.laneName ? `${kind} · ${run.trigger.laneName}` : kind;
}

/** Static head progress line; null when idle. */
export function progressText(progress: RailsProgress): string | null {
  switch (progress.kind) {
    case 'idle':
      return null;
    case 'checking':
      return `check ${progress.index}/${progress.total} ${progress.name}`;
    case 'judging':
      return 'judging';
    case 'paused':
      return 'auto run paused at trust';
    case 'clean-tree':
      return 'no changes to check';
    case 'busy':
      return 'busy (another harness)';
    case 'cooling':
      return `judge cooling until ${localHhMm(progress.until)}`;
    case 'error':
      return progress.message;
  }
}

interface Pill {
  readonly text: string;
  readonly tone: RailsVerdict | 'none';
}

function verdictPill(snapshot: RailsSnapshot | null, latest: RailsRunRecord | null): Pill {
  if (snapshot === null) return { text: 'loading', tone: 'none' };
  if (!snapshot.present) return { text: 'no manifest', tone: 'none' };
  if (isEmptyManifest(snapshot)) return { text: 'no rails', tone: 'none' };
  if (latest === null) return { text: 'no runs', tone: 'none' };
  switch (latest.verdict) {
    case 'clean':
      return { text: 'clean', tone: 'clean' };
    case 'findings':
      return { text: plural(latest.open.length, 'finding'), tone: 'findings' };
    case 'check_failed':
      return { text: 'CHECK FAILED', tone: 'check_failed' };
    case 'error':
      return { text: 'error', tone: 'error' };
  }
}

/** A manifest that declares nothing: no `## Rails` bullets and no `[[check]]`. */
function isEmptyManifest(snapshot: RailsSnapshot): boolean {
  return snapshot.present && snapshot.rules.length === 0 && snapshot.checks.length === 0;
}

function checksSummary(run: RailsRunRecord): string {
  if (run.checksSkipped) return 'checks skipped (untrusted)';
  if (run.checks.length === 0) return 'no checks';
  return run.checks
    .map((check) => `${check.name} ${OUTCOME_LABEL[check.outcome]} ${formatDuration(check.durationMs)}`)
    .join(' · ');
}

// ── rows ────────────────────────────────────────────────────────────────────

type RowOf<K extends RailsDockRow['kind']> = Extract<RailsDockRow, { kind: K }>;

interface RowProps<R extends RailsDockRow> {
  readonly row: R;
  readonly selected: boolean;
  readonly expanded: boolean;
}

interface HeadProps extends RowProps<RowOf<'head'>> {
  readonly snapshot: RailsSnapshot | null;
  readonly mode: RailsMode;
  readonly progress: RailsProgress;
  /** Serialized `progress`, so a fresh-but-equal object does not repaint. */
  readonly progressKey: string;
  readonly latest: RailsRunRecord | null;
}

interface CheckProps extends RowProps<RowOf<'check'>> {
  /** The latest run skipped checks (untrusted manifest). */
  readonly skipped: boolean;
}

/**
 * One navigable row. The element, its key and its selected / expanded classes
 * are shared; each kind paints its own content from the data in its row.
 */
abstract class RowView<R extends RailsDockRow, P extends RowProps<R> = RowProps<R>> extends Component<P> {
  constructor(private readonly kind: R['kind']) {
    super(el('div', { attrs: { role: 'option' } }));
  }

  protected readDeps(next: P): readonly unknown[] {
    return [next.row.key, next.selected, next.expanded, ...this.contentDeps(next)];
  }

  protected syncClasses(next: P): void {
    this.el.className = classes(
      `${B}__row`,
      `${B}__row--${this.kind}`,
      next.selected && `${B}__row--selected`,
      next.expanded && `${B}__row--expanded`,
    );
  }

  protected paint(next: P): void {
    this.syncClasses(next);
    setAttr(this.el, 'data-rails-key', next.row.key);
    setAttr(this.el, 'aria-selected', String(next.selected));
    this.el.replaceChildren(...this.content(next));
  }

  /** Every value `content()` reads besides key / selected / expanded. */
  protected abstract contentDeps(next: P): readonly unknown[];

  protected abstract content(next: P): readonly HTMLElement[];
}

function line(...children: readonly (HTMLElement | string)[]): HTMLElement {
  return el('div', { class: `${B}__line` }, ...children);
}

function span(cls: string, text: string): HTMLElement {
  return el('span', { class: cls, text });
}

function detail(...children: readonly HTMLElement[]): HTMLElement {
  return el('div', { class: `${B}__detail` }, ...children);
}

function detailLine(label: string, value: string): HTMLElement {
  return el('div', { class: `${B}__detail-line` }, span(`${B}__label`, label), span(`${B}__value`, value));
}

class HeadRow extends RowView<RowOf<'head'>, HeadProps> {
  constructor() {
    super('head');
  }

  protected contentDeps(next: HeadProps): readonly unknown[] {
    return [next.snapshot, next.mode, next.progressKey, next.latest];
  }

  protected content(next: HeadProps): readonly HTMLElement[] {
    const { snapshot, latest } = next;
    const pill = verdictPill(snapshot, latest);
    const top = line(
      span(`${B}__eyebrow`, 'RAILS'),
      span(`${B}__pill ${B}__pill--${pill.tone}`, pill.text),
    );
    if (latest) top.append(span(`${B}__time`, localHhMm(latest.finishedAt)));

    const meta: string[] = [];
    if (latest) meta.push(triggerText(latest));
    if (snapshot?.present) meta.push(snapshot.trust);
    meta.push(`mode ${next.mode}`);
    if (latest?.stale) meta.push('stale');
    const out: HTMLElement[] = [top, el('div', { class: `${B}__meta`, text: meta.join(' · ') })];

    const progress = progressText(next.progress);
    if (progress !== null) {
      out.push(el('p', { class: classes(`${B}__progress`, `${B}__progress--${next.progress.kind}`), text: progress }));
    }
    if (snapshot && isEmptyManifest(snapshot)) {
      out.push(el('p', { class: `${B}__hint`, text: 'no rails yet — #rails init asks the lane to write them' }));
    }
    // Any untrusted manifest, whatever the progress or mode: these are the
    // commands `#rails trust` would allow to run.
    if (snapshot?.present && snapshot.trust !== 'trusted' && snapshot.checks.length > 0) {
      out.push(
        el('p', {
          class: `${B}__trust`,
          text:
            snapshot.trust === 'changed'
              ? 'rails.toml changed since trust — checks wait for #rails trust'
              : 'rails.toml not trusted — checks wait for #rails trust',
        }),
        el(
          'ul',
          { class: `${B}__argv` },
          ...snapshot.checks.map((check) =>
            el('li', {}, span(`${B}__name`, check.name), el('code', { text: check.argv.join(' ') })),
          ),
        ),
      );
    }
    if (snapshot?.error) out.push(el('p', { class: `${B}__error`, text: snapshot.error }));
    if (snapshot && snapshot.warnings.length > 0) {
      out.push(
        el('ul', { class: `${B}__warnings` }, ...snapshot.warnings.map((warning) => el('li', { text: warning }))),
      );
    }
    return out;
  }
}

class CheckRow extends RowView<RowOf<'check'>, CheckProps> {
  constructor() {
    super('check');
  }

  protected contentDeps(next: CheckProps): readonly unknown[] {
    return [next.row.decl, next.row.result, next.skipped];
  }

  protected content(next: CheckProps): readonly HTMLElement[] {
    const { decl, result } = next.row;
    const outcome = result
      ? span(`${B}__outcome ${B}__outcome--${result.outcome}`, OUTCOME_LABEL[result.outcome])
      : span(`${B}__outcome ${B}__outcome--none`, next.skipped ? 'skipped' : '—');
    const out: HTMLElement[] = [
      line(
        span(`${B}__name`, decl.name),
        outcome,
        span(`${B}__duration`, result ? formatDuration(result.durationMs) : ''),
      ),
    ];
    if (next.expanded) out.push(checkDetail(decl.argv, result));
    return out;
  }
}

function checkDetail(argv: readonly string[], result: RailsCheckResult | null): HTMLElement {
  const lines: HTMLElement[] = [detailLine('argv', argv.join(' '))];
  if (result) {
    lines.push(detailLine('exit', result.exitCode === null ? '—' : String(result.exitCode)));
    lines.push(el('pre', { class: `${B}__tail`, text: result.outputTail || '(no output)' }));
  } else {
    lines.push(detailLine('output', 'not run'));
  }
  return detail(...lines);
}

class FindingRow extends RowView<RowOf<'finding'>> {
  constructor() {
    super('finding');
  }

  protected contentDeps(next: RowProps<RowOf<'finding'>>): readonly unknown[] {
    return [next.row.finding];
  }

  protected content(next: RowProps<RowOf<'finding'>>): readonly HTMLElement[] {
    const finding = next.row.finding;
    const tag =
      finding.status === 'new'
        ? 'new'
        : finding.status === 'open'
          ? `since ${localHhMm(finding.firstSeenAt)}`
          : 'not re-checked';
    const out: HTMLElement[] = [
      line(
        span(`${B}__severity`, finding.severity),
        span(`${B}__rule`, shortRuleId(finding.rule)),
        span(`${B}__loc`, location(finding)),
        span(`${B}__tag ${B}__tag--${finding.status}`, tag),
      ),
      el('p', { class: `${B}__note`, text: finding.note }),
    ];
    if (next.expanded) out.push(detail(detailLine('rule', finding.rule), detailLine('file', location(finding))));
    return out;
  }
}

function findingList(findings: readonly RailsFinding[]): HTMLElement {
  return el(
    'ul',
    { class: `${B}__list` },
    ...findings.map((finding) =>
      el(
        'li',
        {},
        line(span(`${B}__rule`, shortRuleId(finding.rule)), span(`${B}__loc`, location(finding))),
        el('p', { class: `${B}__note`, text: finding.note }),
      ),
    ),
  );
}

class ResolvedRow extends RowView<RowOf<'resolved'>> {
  constructor() {
    super('resolved');
  }

  protected contentDeps(next: RowProps<RowOf<'resolved'>>): readonly unknown[] {
    return [next.row.findings];
  }

  protected content(next: RowProps<RowOf<'resolved'>>): readonly HTMLElement[] {
    const out: HTMLElement[] = [line(span(`${B}__summary`, `resolved ${next.row.findings.length}`))];
    if (next.expanded) out.push(detail(findingList(next.row.findings)));
    return out;
  }
}

class RulesRow extends RowView<RowOf<'rules'>> {
  constructor() {
    super('rules');
  }

  protected contentDeps(next: RowProps<RowOf<'rules'>>): readonly unknown[] {
    return [next.row.total, next.row.enforced, next.row.judgeOnly];
  }

  protected content(next: RowProps<RowOf<'rules'>>): readonly HTMLElement[] {
    const { total, enforced, judgeOnly } = next.row;
    return [
      line(
        span(`${B}__summary`, `${plural(total, 'rule')} · ${enforced} enforced · ${judgeOnly} judge-only`),
        span(`${B}__disclosure`, next.expanded ? '▾' : '▸'),
      ),
    ];
  }
}

class RuleRow extends RowView<RowOf<'rule'>> {
  constructor() {
    super('rule');
  }

  protected contentDeps(next: RowProps<RowOf<'rule'>>): readonly unknown[] {
    return [next.row.rule, next.row.status];
  }

  protected content(next: RowProps<RowOf<'rule'>>): readonly HTMLElement[] {
    const { rule, status } = next.row;
    const out: HTMLElement[] = [
      line(
        span(`${B}__status ${B}__status--${status ?? 'none'}`, status ? RULE_STATUS_LABEL[status] : '—'),
        span(`${B}__rule`, shortRuleId(rule.id)),
        span(`${B}__text`, rule.text),
      ),
    ];
    if (next.expanded) {
      out.push(
        detail(
          el('p', { class: `${B}__note`, text: rule.text }),
          detailLine('source', rule.id),
          detailLine('applies to', rule.appliesTo.length > 0 ? rule.appliesTo.join(', ') : 'every path'),
          detailLine('check', rule.check ?? 'judge-only'),
        ),
      );
    }
    return out;
  }
}

class UncoveredRow extends RowView<RowOf<'uncovered'>> {
  constructor() {
    super('uncovered');
  }

  protected contentDeps(next: RowProps<RowOf<'uncovered'>>): readonly unknown[] {
    return [next.row.sources];
  }

  protected content(next: RowProps<RowOf<'uncovered'>>): readonly HTMLElement[] {
    const sources = next.row.sources;
    const out: HTMLElement[] = [
      line(span(`${B}__summary`, `${plural(sources.length, 'source')} without rails`)),
    ];
    if (next.expanded) {
      out.push(detail(el('ul', { class: `${B}__list` }, ...sources.map((path) => el('li', { text: path })))));
    }
    return out;
  }
}

class RunRow extends RowView<RowOf<'run'>> {
  constructor() {
    super('run');
  }

  protected contentDeps(next: RowProps<RowOf<'run'>>): readonly unknown[] {
    return [next.row.run];
  }

  protected content(next: RowProps<RowOf<'run'>>): readonly HTMLElement[] {
    const run = next.row.run;
    const head = line(
      span(`${B}__time`, localHhMm(run.finishedAt)),
      span(`${B}__glyph ${B}__glyph--${run.verdict}`, VERDICT_GLYPH[run.verdict]),
      span(`${B}__count`, `${run.open.length} open`),
      span(`${B}__lane`, run.trigger.laneName ?? run.trigger.kind),
    );
    if (run.stale) head.append(span(`${B}__tag ${B}__tag--stale`, 'stale'));
    const out: HTMLElement[] = [head];
    if (next.expanded) {
      const lines: HTMLElement[] = [
        detailLine('checks', checksSummary(run)),
        detailLine('judge', run.judgeFailure ? `${run.judge} (${run.judgeFailure})` : run.judge),
        detailLine('resolved', String(run.resolved.length)),
      ];
      if (run.dropped > 0) lines.push(detailLine('dropped', String(run.dropped)));
      if (run.rulesTruncated) {
        lines.push(detailLine('rules sent', `${run.rulesTruncated.kept}/${run.rulesTruncated.total} (truncated)`));
      }
      if (run.error) lines.push(el('p', { class: `${B}__error`, text: run.error }));
      lines.push(detailLine('run', `${run.runId} · ${triggerText(run)}`));
      out.push(detail(...lines));
    }
    return out;
  }
}

/** A non-navigable heading between sections 2–5. */
class SectionHead extends Component<Exclude<RailsDockSection, 1>> {
  constructor() {
    super(el('div', { class: `${B}__section`, attrs: { role: 'presentation' } }));
  }

  protected readDeps(next: Exclude<RailsDockSection, 1>): readonly unknown[] {
    return [next];
  }

  protected syncClasses(_next: Exclude<RailsDockSection, 1>): void {
    this.el.className = `${B}__section`;
  }

  protected paint(next: Exclude<RailsDockSection, 1>): void {
    this.syncClasses(next);
    // `[n]` is the jump key for this section, not a count.
    this.el.replaceChildren(span(`${B}__section-label`, SECTION_LABEL[next]), span(`${B}__section-key`, `[${next}]`));
  }
}

// ── dock ────────────────────────────────────────────────────────────────────

type Item =
  | { readonly kind: 'section'; readonly section: Exclude<RailsDockSection, 1> }
  | { readonly kind: 'row'; readonly row: RailsDockRow };

type ItemView =
  | SectionHead
  | HeadRow
  | CheckRow
  | FindingRow
  | ResolvedRow
  | RulesRow
  | RuleRow
  | UncoveredRow
  | RunRow;

function itemKey(item: Item): string {
  return item.kind === 'section' ? `section\u001f${item.section}` : `${item.row.kind}\u001f${item.row.key}`;
}

function items(rows: readonly RailsDockRow[]): Item[] {
  const out: Item[] = [];
  let section: RailsDockSection | 0 = 0;
  for (const row of rows) {
    if (row.section !== section) {
      section = row.section;
      if (row.section !== 1) out.push({ kind: 'section', section: row.section });
    }
    out.push({ kind: 'row', row });
  }
  return out;
}

export class RailsDock extends Component<RailsDockProps> {
  private readonly contentEl = el('div', { class: B });
  private readonly rowsEl = el('div', {
    class: `${B}__rows`,
    attrs: { role: 'listbox', 'aria-label': 'Rails' },
  });
  private readonly keysEl = el('footer', { class: `${B}__keys`, text: RAILS_DOCK_KEY_HINTS });
  private selectRow: ((key: string) => void) | undefined;
  /** The selection last scrolled into view; scroll happens only when it moves. */
  private scrolledKey: string | null = null;

  constructor(root: HTMLElement) {
    super(root);
    this.contentEl.append(this.rowsEl, this.keysEl);
    root.appendChild(this.contentEl);
    this.bag.listen(this.el, 'click', (event: Event) => {
      if (!this.selectRow || !(event.target instanceof Element)) return;
      const node = event.target.closest<HTMLElement>('[data-rails-key]');
      if (!node || !this.rowsEl.contains(node)) return;
      const key = node.dataset.railsKey;
      if (key !== undefined) this.selectRow(key);
    });
  }

  update(next: RailsDockProps): void {
    this.selectRow = next.onSelectRow;
    super.update(next);
  }

  protected readDeps(next: RailsDockProps): readonly unknown[] {
    const model = next.model;
    return [
      model.snapshot,
      model.mode,
      JSON.stringify(model.progress),
      model.history,
      model.selectedKey,
      [...model.expanded].sort().join('\u0000'),
    ];
  }

  protected syncClasses(_next: RailsDockProps): void {
    this.contentEl.className = B;
  }

  protected paint(next: RailsDockProps): void {
    this.syncClasses(next);
    const model = next.model;
    const latest = model.history[0] ?? null;
    const progressKey = JSON.stringify(model.progress);
    const skipped = latest?.checksSkipped ?? false;
    const rows = railsDockRows(model);

    const rowState = (row: RailsDockRow): { selected: boolean; expanded: boolean } => ({
      selected: row.key === model.selectedKey,
      expanded: model.expanded.has(row.key),
    });
    const updateView = (view: ItemView, item: Item): void => {
      if (item.kind === 'section') {
        if (view instanceof SectionHead) view.update(item.section);
        return;
      }
      const row = item.row;
      const state = rowState(row);
      switch (row.kind) {
        case 'head':
          if (view instanceof HeadRow) {
            view.update({ row, ...state, snapshot: model.snapshot, mode: model.mode, progress: model.progress, progressKey, latest });
          }
          return;
        case 'check':
          if (view instanceof CheckRow) view.update({ row, ...state, skipped });
          return;
        case 'finding':
          if (view instanceof FindingRow) view.update({ row, ...state });
          return;
        case 'resolved':
          if (view instanceof ResolvedRow) view.update({ row, ...state });
          return;
        case 'rules':
          if (view instanceof RulesRow) view.update({ row, ...state });
          return;
        case 'rule':
          if (view instanceof RuleRow) view.update({ row, ...state });
          return;
        case 'uncovered':
          if (view instanceof UncoveredRow) view.update({ row, ...state });
          return;
        case 'run':
          if (view instanceof RunRow) view.update({ row, ...state });
          return;
      }
    };
    const createView = (item: Item): ItemView => {
      if (item.kind === 'section') return new SectionHead();
      switch (item.row.kind) {
        case 'head':
          return new HeadRow();
        case 'check':
          return new CheckRow();
        case 'finding':
          return new FindingRow();
        case 'resolved':
          return new ResolvedRow();
        case 'rules':
          return new RulesRow();
        case 'rule':
          return new RuleRow();
        case 'uncovered':
          return new UncoveredRow();
        case 'run':
          return new RunRow();
      }
    };

    reconcile<Item, ItemView>(this.rowsEl, items(rows), {
      key: itemKey,
      create: (item) => {
        const view = createView(item);
        updateView(view, item);
        return view;
      },
      update: updateView,
    });

    if (model.selectedKey !== this.scrolledKey) {
      this.scrolledKey = model.selectedKey;
      const selected = rows.find((row) => row.key === model.selectedKey);
      const node = selected ? listComponent(this.rowsEl, itemKey({ kind: 'row', row: selected }))?.el : undefined;
      if (node && typeof node.scrollIntoView === 'function') node.scrollIntoView({ block: 'nearest' });
    }
  }

  protected onDispose(): void {
    disposeList(this.rowsEl);
    this.contentEl.remove();
  }
}

export const def: ComponentDef = { id: 'rails-dock', blocks: ['acp-rails-dock'] };
