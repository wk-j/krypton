// Krypton — `#rails update` (spec 338): the rails state Krypton holds and a
// lane cannot re-derive (trust, loader warnings, latest outcomes and output,
// rule → check map and statuses), as one fenced block of plain lines.
// Capped at `RAILS_UPDATE_STATE_MAX`; the first line that does not fit is
// replaced by a pointer to the run file and the rule sources.

import { latestRuleStatus } from './track';
import type { RailsCheckResult, RailsRunRecord, RailsSnapshot } from './types';

export const RAILS_UPDATE_STATE_MAX = 12_000;
/** Each non-pass check contributes at most this much of its output tail. */
export const RAILS_UPDATE_TAIL_MAX = 2_000;
const RULE_TEXT_MAX = 160;
/** Room kept for the omission line, so it always fits under the cap. */
const OMITTED_ROOM = 100;

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * `history` is newest first; `runPath` is the newest run's file. A check reads
 * `not run` when there is no run, that run skipped checks, or it was declared
 * since.
 */
export function railsUpdateState(
  snapshot: RailsSnapshot,
  history: readonly RailsRunRecord[],
  runPath: string | null,
): string {
  const latest = history[0] ?? null;
  const results = new Map<string, RailsCheckResult>(
    latest && !latest.checksSkipped ? latest.checks.map((check) => [check.name, check]) : [],
  );

  const lines: string[] = [`manifest ${snapshot.manifestPath} · trust ${snapshot.trust}`];
  if (snapshot.error !== null) lines.push(`manifest error: ${oneLine(snapshot.error)}`);
  for (const warning of snapshot.warnings) lines.push(`warning: ${oneLine(warning)}`);

  lines.push(latest === null
    ? 'no runs yet'
    : `latest run ${latest.runId} · ${latest.verdict}${latest.checksSkipped ? ' · checks skipped (untrusted)' : ''} · ${runPath ?? '—'}`);

  lines.push(`checks ${snapshot.checks.length}:`);
  for (const decl of snapshot.checks) {
    const result = results.get(decl.name);
    const outcome = result
      ? `${result.outcome} (exit ${result.exitCode ?? '—'}, ${(result.durationMs / 1000).toFixed(1)}s)`
      : 'not run';
    lines.push(`- ${decl.name} · timeout_s ${decl.timeoutS} · argv ${JSON.stringify(decl.argv)} · ${outcome}`);
  }

  for (const decl of snapshot.checks) {
    const result = results.get(decl.name);
    if (!result || result.outcome === 'pass' || result.outputTail.trim() === '') continue;
    lines.push(`output of ${decl.name} (${result.outcome}), last ${RAILS_UPDATE_TAIL_MAX} chars:`);
    lines.push(...result.outputTail.slice(-RAILS_UPDATE_TAIL_MAX).split('\n'));
  }

  const enforced = snapshot.rules.filter((rule) => rule.check !== null).length;
  lines.push(`rules ${snapshot.rules.length} · enforced ${enforced} · judge-only ${snapshot.rules.length - enforced}:`);
  for (const rule of snapshot.rules) {
    const text = oneLine(rule.text);
    const cut = text.length > RULE_TEXT_MAX ? `${text.slice(0, RULE_TEXT_MAX - 1)}…` : text;
    const status = latestRuleStatus(history, rule.id) ?? 'no status';
    lines.push(`- ${rule.id} · ${rule.check === null ? 'judge-only' : `check:${rule.check}`} · ${status} · ${cut}`);
  }

  if (snapshot.uncoveredSources.length > 0) {
    lines.push(`sources without rails ${snapshot.uncoveredSources.length}:`);
    for (const source of snapshot.uncoveredSources) lines.push(`- ${source}`);
  }

  const kept: string[] = [];
  let used = 0;
  for (let i = 0; i < lines.length; i += 1) {
    // Repo text must not close the fence early.
    const line = lines[i].replace(/<\/rails-state>/gi, '<\\/rails-state>');
    if (used + line.length + 1 > RAILS_UPDATE_STATE_MAX - OMITTED_ROOM) {
      kept.push(`… ${lines.length - i} lines omitted — read the run file and the rule sources`);
      break;
    }
    kept.push(line);
    used += line.length + 1;
  }
  return `<rails-state>\n${kept.join('\n')}\n</rails-state>`;
}
