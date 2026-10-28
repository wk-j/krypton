// Krypton — Rails verifier (spec 337): the `[rails]` envelope `send` delivers
// to a lane through `injectHarnessEnvelope`. Capped at 4 000 chars; the run
// file path and the instruction always survive the cap.

import { shortRuleId } from './rows';
import type { RailsRunRecord, TrackedFinding } from './types';

export const RAILS_ENVELOPE_MAX = 4_000;

function findingLine(finding: TrackedFinding): string {
  const where = finding.line === null ? finding.file : `${finding.file}:${finding.line}`;
  const note = finding.note.replace(/\s+/g, ' ').trim();
  return `- ${finding.severity} ${shortRuleId(finding.rule)} ${where} — ${note}`;
}

/** The open findings of `run` (or just `only`) as one message for a lane. */
export function railsEnvelope(run: RailsRunRecord, runPath: string, only?: TrackedFinding): string {
  const head: string[] = [`[rails] run ${run.runId} — verdict ${run.verdict}`];
  const failed = run.checks.filter((check) => check.outcome === 'fail' || check.outcome === 'timeout');
  if (failed.length > 0) {
    const list = failed.map((check) =>
      check.outcome === 'timeout' ? `${check.name} (timeout)` : `${check.name} (exit ${check.exitCode ?? '?'})`);
    head.push(`Failed checks: ${list.join(', ')}`);
  }
  const findings = only ? [only] : run.open;
  if (findings.length > 0) head.push(only ? 'Finding:' : `Open findings (${findings.length}):`);

  const foot = [
    `Run file: ${runPath}`,
    'Fix each finding, or explain why the rule does not apply here. '
      + 'Never weaken, skip or delete a check, or edit a rule, to make it pass.',
  ].join('\n');

  const headText = head.join('\n').slice(0, RAILS_ENVELOPE_MAX - foot.length - 1);
  const room = RAILS_ENVELOPE_MAX - headText.length - foot.length - 2;
  const lines: string[] = [];
  let used = 0;
  for (let i = 0; i < findings.length; i += 1) {
    const line = findingLine(findings[i]);
    const remaining = findings.length - i - 1;
    const marker = remaining > 0 ? `… ${remaining} more in the run file`.length + 1 : 0;
    if (used + line.length + 1 + marker > room) {
      const omitted = `… ${findings.length - i} more in the run file`;
      if (used + omitted.length + 1 <= room) lines.push(omitted);
      break;
    }
    lines.push(line);
    used += line.length + 1;
  }

  const body = lines.length > 0 ? `${lines.join('\n')}\n` : '';
  return `${headText}\n${body}\n${foot}`.slice(0, RAILS_ENVELOPE_MAX);
}
