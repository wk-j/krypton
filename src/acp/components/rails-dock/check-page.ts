// Spec 404 — `RailsCheckPage`, one check's detail in place of the Rails row list.
//
// The row list has no room for a check's detail: inside a row it was a well in
// a well, about 218 px wide, with the output capped at 18em. The page takes
// the whole rows region of the same panel instead, and the dock's tab strip,
// Actions bar and key hints stay where they are. It shows, top to bottom:
//
//   ‹ ESC   CHECKS › loopback-session-gate
//   loopback-session-gate               PASS   2.1s
//   run 23:42 · exit 0 · timeout 900s
//   PROVES                                       2      each rule in full, with its source
//   COMMAND                                             wraps between arguments
//   OUTPUT                                  exit 0      the whole tail, no height cap
//
// **Props only.** `RailsDock` owns where the page sits, whether it is shown
// and its scroll position; the controller owns which check is open
// (`RailsDockModel.detail`). `‹ ESC` and the RUN key report through
// `data-rails-back` / `data-rails-check`, which the dock's one click
// listener routes.

import { Component } from '../../../ui/component';
import { classes, el, setAttr, type ElChild } from '../../../ui/dom';
import { fullActionTime } from '../../harness-ticket-helpers';
import { localHhMm } from '../../rails/format';
import { shortRuleId } from '../../rails/rows';
import type { RailsDockRow } from '../../rails/types';
import { B, formatDuration, line, outcomeBadge, runKey, span } from './parts';

export interface RailsCheckPageProps {
  readonly row: Extract<RailsDockRow, { kind: 'check' }>;
  /** `finishedAt` of the Rails run an auto check's result came from. */
  readonly runAt: string | null;
  /** The latest run skipped checks (untrusted manifest). */
  readonly skipped: boolean;
  /** Spec 368: this manual check is running now. */
  readonly inFlight: boolean;
  /** Spec 368: why the RUN key is disabled, or null. */
  readonly runDisabledReason: string | null;
}

interface SourceLine {
  readonly text: string;
  /** `accent` is the amber of the head's waiting state lines. */
  readonly tone: 'ink' | 'accent';
}

/** Where the result came from, its exit code and the declared timeout. */
function sourceLine(next: RailsCheckPageProps): SourceLine {
  const { decl, result, manualRun } = next.row;
  const timeout = `timeout ${decl.timeoutS}s`;
  if (!decl.manual && result === null && next.skipped) {
    return { text: `skipped — waits for #rails trust · ${timeout}`, tone: 'accent' };
  }
  const parts: string[] = [];
  if (decl.manual) {
    if (manualRun) {
      parts.push('manual', fullActionTime(Date.parse(manualRun.finishedAt)));
      if (manualRun.laneName) parts.push(manualRun.laneName);
    } else {
      parts.push('manual · never run');
    }
  } else if (result === null) {
    parts.push('not run');
  } else {
    parts.push(next.runAt ? `run ${localHhMm(next.runAt)}` : 'run');
  }
  if (result) parts.push(`exit ${result.exitCode === null ? '—' : result.exitCode}`);
  parts.push(timeout);
  return { text: parts.join(' · '), tone: 'ink' };
}

/** Breaks only between arguments; inside one longer than the line, after `::` and `/` first. */
function argvNodes(argv: readonly string[]): ElChild[] {
  const out: ElChild[] = [];
  argv.forEach((arg, index) => {
    if (index > 0) out.push(' ');
    const node = el('span', { class: `${B}__page-arg` });
    for (const part of arg.split(/(::|\/)/)) {
      if (part === '') continue;
      node.append(part);
      if (part === '::' || part === '/') node.append(document.createElement('wbr'));
    }
    out.push(node);
  });
  return out;
}

function section(label: string, aside: string | null): HTMLElement {
  return el(
    'div',
    { class: `${B}__section`, attrs: { role: 'presentation' } },
    span(`${B}__section-label`, label),
    aside === null ? null : span(`${B}__page-aside`, aside),
  );
}

export class RailsCheckPage extends Component<RailsCheckPageProps> {
  constructor() {
    super(el('section', { class: `${B}__page`, attrs: { role: 'region' } }));
  }

  protected readDeps(next: RailsCheckPageProps): readonly unknown[] {
    const { decl, result, manualRun, enforces } = next.row;
    return [decl, result, manualRun, enforces, next.runAt, next.skipped, next.inFlight, next.runDisabledReason];
  }

  protected syncClasses(_next: RailsCheckPageProps): void {
    this.el.className = `${B}__page`;
  }

  protected paint(next: RailsCheckPageProps): void {
    this.syncClasses(next);
    const { decl, result, enforces } = next.row;
    setAttr(this.el, 'aria-label', `${decl.name} check`);

    const back = el('button', {
      class: `${B}__back`,
      text: '‹ ESC',
      title: 'Back to the Rails list (Esc)',
      attrs: { type: 'button', 'data-rails-back': true },
    });
    const crumb = el(
      'span',
      { class: `${B}__crumb` },
      span(`${B}__crumb-label`, 'checks'),
      ' › ',
      span(`${B}__crumb-name`, decl.name),
    );
    const unlit = decl.manual ? (next.inFlight ? 'running' : 'manual') : next.skipped ? 'skipped' : 'not run';
    const check = line(
      span(`${B}__name`, decl.name),
      ...(decl.manual ? [runKey(decl.name, next.inFlight, next.runDisabledReason)] : []),
      outcomeBadge(next.inFlight ? null : result, unlit),
      span(`${B}__duration`, result && !next.inFlight ? formatDuration(result.durationMs) : ''),
    );
    check.classList.add(`${B}__page-check`);
    const source = sourceLine(next);
    const head = el(
      'div',
      { class: `${B}__page-head` },
      line(back, crumb),
      check,
      el('p', {
        class: classes(`${B}__page-meta`, source.tone === 'accent' && `${B}__page-meta--wait`),
        title: source.text,
        text: source.text,
      }),
    );

    const rules = enforces.length === 0
      ? [el('p', {
          class: `${B}__page-none`,
          text: `No \`## Rails\` bullet names \`check:${decl.name}\`, so its result says only whether the command succeeded.`,
        })]
      : enforces.map((rule) =>
          el(
            'div',
            { class: `${B}__page-rule` },
            span(`${B}__rule`, shortRuleId(rule.id)),
            ' ',
            span(`${B}__page-rule-text`, rule.text),
            el('span', { class: `${B}__page-source`, text: rule.id, title: rule.id }),
          ));

    const tail = result ? result.outputTail || '(no output)' : next.skipped && !decl.manual ? 'skipped' : 'not run';
    this.el.replaceChildren(
      head,
      section('proves', String(enforces.length)),
      el('div', { class: `${B}__page-well ${B}__page-proves` }, ...rules),
      section('command', null),
      el('div', { class: `${B}__page-well ${B}__page-argv` }, ...argvNodes(decl.argv)),
      section('output', result ? `exit ${result.exitCode === null ? '—' : result.exitCode}` : null),
      el('div', { class: `${B}__page-well` }, el('pre', { class: `${B}__page-tail`, text: tail })),
    );
  }
}
