// Spec 337 / 404 — the pieces the Rails dock's rows and its check page share:
// the block name, the outcome badge, the manual check's RUN key and the time
// texts. Both paint a check the same way, so the two can never disagree.

import { classes, el } from '../../../ui/dom';
import { fullActionTime } from '../../harness-ticket-helpers';
import type { RailsCheckOutcome, RailsCheckResult, RailsCheckRun } from '../../rails/types';

export const B = 'acp-rails-dock';

export const OUTCOME_LABEL: Record<RailsCheckOutcome, string> = {
  pass: 'PASS',
  fail: 'FAIL',
  timeout: 'TIMEOUT',
  error: 'ERROR',
};

export function formatDuration(ms: number): string {
  return `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
}

export function line(...children: readonly (HTMLElement | string)[]): HTMLElement {
  return el('div', { class: `${B}__line` }, ...children);
}

export function span(cls: string, text: string): HTMLElement {
  return el('span', { class: cls, text });
}

/** A lit outcome lamp, or the unlit legend (`not run`, `skipped`, `manual`, `running`). */
export function outcomeBadge(result: RailsCheckResult | null, unlit: string): HTMLElement {
  return result
    ? span(`${B}__outcome ${B}__outcome--${result.outcome}`, OUTCOME_LABEL[result.outcome])
    : span(`${B}__outcome ${B}__outcome--none`, unlit);
}

/** Spec 368: a manual check's RUN key. Its click routes through `data-rails-check`. */
export function runKey(name: string, inFlight: boolean, disabledReason: string | null): HTMLButtonElement {
  const run = el('button', {
    class: classes(`${B}__run`, inFlight && `${B}__run--running`),
    text: inFlight ? 'RUNNING' : 'RUN',
    attrs: { type: 'button', 'data-rails-check': name },
  });
  run.disabled = inFlight || disabledReason !== null;
  run.title = inFlight ? `${name} is running` : disabledReason ?? `Run ${name} alone (#rails check ${name} · r)`;
  return run;
}

/** `2026-11-07 14:02 · OMP-1 · 3.7s`: when a manual check ran, who started it, how long. */
export function ranText(run: RailsCheckRun): string {
  const parts = [fullActionTime(Date.parse(run.finishedAt))];
  if (run.laneName) parts.push(run.laneName);
  parts.push(formatDuration(run.result.durationMs));
  return parts.join(' · ');
}
