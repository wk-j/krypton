// Krypton — Rails verifier (spec 337): the dock's navigable rows.
//
// The component paints these rows and the controller moves the selection over
// the same list, so painting and navigation can never disagree.

import { latestRuleStatus, manualCheckStatus } from './track';
import type { RailsDockModel, RailsDockRow } from './types';

/** `docs/adr/0008-x.md#2` → `0008#2`; `AGENTS.md#3` → `AGENTS#3`; `CONTEXT.md#Lane` → `CONTEXT#Lane`. */
export function shortRuleId(id: string): string {
  const hash = id.indexOf('#');
  const path = hash === -1 ? id : id.slice(0, hash);
  const suffix = hash === -1 ? '' : id.slice(hash);
  const stem = path.slice(path.lastIndexOf('/') + 1).replace(/\.[^.]*$/, '');
  const number = /^\d+/.exec(stem);
  return `${number ? number[0] : stem}${suffix}`;
}

/** Spec 345: runs listed before the `older` row; the head already shows the newest. */
export const RAILS_DOCK_RECENT_RUNS = 5;

/** Paint order: head · checks · open findings · resolved · rules (+ each rule
 *  when expanded) · uncovered sources · the newest runs · `older` (+ the rest
 *  when expanded). */
export function railsDockRows(model: RailsDockModel): RailsDockRow[] {
  const rows: RailsDockRow[] = [{ kind: 'head', key: 'head', section: 1 }];
  const latest = model.history[0] ?? null;
  const snapshot = model.snapshot;

  // Spec 368: a manual check never runs in a Rails run, so its row reads only
  // its own manual result — never an older run's result from before it was manual.
  for (const decl of snapshot?.checks ?? []) {
    const manualRun = decl.manual ? model.checkRuns.get(decl.name) ?? null : null;
    const result = decl.manual
      ? manualRun?.result ?? null
      : latest?.checks.find((check) => check.name === decl.name) ?? null;
    rows.push({ kind: 'check', key: `check:${decl.name}`, section: 2, decl, manualRun, result });
  }

  for (const finding of latest?.open ?? []) {
    rows.push({ kind: 'finding', key: `finding:${finding.key}`, section: 3, finding });
  }
  if (latest && latest.resolved.length > 0) {
    rows.push({ kind: 'resolved', key: 'resolved', section: 3, findings: latest.resolved });
  }

  const rules = snapshot?.rules ?? [];
  const enforced = rules.filter((rule) => rule.check !== null).length;
  rows.push({ kind: 'rules', key: 'rules', section: 4, total: rules.length, enforced });
  if (model.expanded.has('rules')) {
    const manual = new Set((snapshot?.checks ?? []).filter((decl) => decl.manual).map((decl) => decl.name));
    for (const rule of rules) {
      const manualCheck = rule.check !== null && manual.has(rule.check) ? rule.check : null;
      const status = manualCheck !== null
        ? manualCheckStatus(model.checkRuns.get(manualCheck))
        : latestRuleStatus(model.history, rule.id);
      rows.push({ kind: 'rule', key: `rule:${rule.id}`, section: 4, rule, status, manualCheck: manualCheck !== null });
    }
  }
  const uncovered = snapshot?.uncoveredSources ?? [];
  if (uncovered.length > 0) rows.push({ kind: 'uncovered', key: 'uncovered', section: 4, sources: uncovered });

  const recent = model.history.slice(0, RAILS_DOCK_RECENT_RUNS);
  for (const run of recent) rows.push({ kind: 'run', key: `run:${run.runId}`, section: 5, run });
  const older = model.history.slice(RAILS_DOCK_RECENT_RUNS);
  if (older.length > 0) {
    rows.push({ kind: 'older', key: 'older', section: 5, count: older.length });
    if (model.expanded.has('older')) {
      for (const run of older) rows.push({ kind: 'run', key: `run:${run.runId}`, section: 5, run });
    }
  }
  return rows;
}
