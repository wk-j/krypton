// Krypton — Rails verifier (spec 337): the `[rails]` envelope `send` delivers
// to a lane through `injectHarnessEnvelope`. Capped at 4 000 chars; the run
// file path, the check file lines and the instruction always survive the cap.
// Spec 368 amendment A: Send-all also carries each failed manual result the
// dock shows, as a pointer (last line, check file, rerun command), never its
// output: a long tail is over the cap and only a slice of the list.

import { fullActionTime } from '../harness-ticket-helpers';

import { plural } from './format';
import { shortRuleId } from './rows';
import type {
  RailsCheckDecl,
  RailsCheckOutcome,
  RailsCheckRun,
  RailsDockModel,
  RailsRunRecord,
  TrackedFinding,
} from './types';

export const RAILS_ENVELOPE_MAX = 4_000;

/** A manual result's last output line, after whitespace collapses. */
const LAST_LINE_MAX = 200;

const INSTRUCTION = 'Fix each finding and each failed check, or explain why the rule does not apply here. '
  + 'Never weaken, skip or delete a check, or edit a rule, to make it pass.';

/** What Send-all delivers now (spec 368 amendment A). */
export interface RailsSendSet {
  /** The newest run when it has open findings, else null. */
  readonly run: RailsRunRecord | null;
  /** Failed manual results the dock shows, in manifest order. */
  readonly manual: readonly RailsCheckRun[];
  /** `run:<runId>` when `run` is set, then `check:<name>@<finishedAt>` per result. */
  readonly keys: readonly string[];
  /** `3 open findings and failed osv` · `failed osv` · `1 open finding`; empty for an empty set. */
  readonly label: string;
}

export interface RailsEnvelopeRun {
  readonly record: RailsRunRecord;
  readonly path: string;
  /** Send just this finding of `record`. */
  readonly only?: TrackedFinding;
}

export interface RailsEnvelopeCheck {
  readonly result: RailsCheckRun;
  readonly decl: RailsCheckDecl;
  /** Absolute path of `.krypton/rails/checks/<name>.json`. */
  readonly path: string;
}

/** Fail and timeout break the rails; `error` (the command could not start) does not. */
export function isFailedCheck(outcome: RailsCheckOutcome): boolean {
  return outcome === 'fail' || outcome === 'timeout';
}

/** `failed osv`, `failed osv, suite`: the manual part of a Send label. */
export function failedChecksLabel(names: readonly string[]): string {
  return `failed ${names.join(', ')}`;
}

/** Manual results are read as the check rows read them; the check running now
 *  is left out, because its row shows `RUNNING` instead of the old result. */
export function railsSendSet(
  model: Pick<RailsDockModel, 'snapshot' | 'history' | 'checkRuns' | 'checkInFlight'>,
): RailsSendSet {
  const latest = model.history[0];
  const run = latest && latest.open.length > 0 ? latest : null;
  const manual: RailsCheckRun[] = [];
  for (const decl of model.snapshot?.checks ?? []) {
    if (!decl.manual || decl.name === model.checkInFlight) continue;
    const result = model.checkRuns.get(decl.name);
    if (result && isFailedCheck(result.result.outcome)) manual.push(result);
  }
  const keys = manual.map((result) => `check:${result.name}@${result.finishedAt}`);
  const parts = manual.length > 0 ? [failedChecksLabel(manual.map((result) => result.name))] : [];
  if (run) {
    keys.unshift(`run:${run.runId}`);
    parts.unshift(plural(run.open.length, 'open finding'));
  }
  return { run, manual, keys, label: parts.join(' and ') };
}

function findingLine(finding: TrackedFinding): string {
  const where = finding.line === null ? finding.file : `${finding.file}:${finding.line}`;
  const note = finding.note.replace(/\s+/g, ' ').trim();
  return `- ${finding.severity} ${shortRuleId(finding.rule)} ${where} — ${note}`;
}

function lastLine(tail: string): string {
  const lines = tail.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].replace(/\s+/g, ' ').trim();
    if (line) return line.length > LAST_LINE_MAX ? `${line.slice(0, LAST_LINE_MAX - 1)}…` : line;
  }
  return '';
}

function manualLine({ result, decl }: RailsEnvelopeCheck): string {
  const status = result.result.outcome === 'timeout' ? 'timeout' : `exit ${result.result.exitCode ?? '?'}`;
  const finished = Date.parse(result.finishedAt);
  const at = Number.isNaN(finished) ? result.finishedAt : fullActionTime(finished);
  const last = lastLine(result.result.outputTail);
  return `- ${decl.name} (${status}) at ${at}${last ? ` — last line: ${last}` : ''}`;
}

/** POSIX single-quoting for an argument a shell would split or expand. */
function shellWord(arg: string): string {
  return /^[A-Za-z0-9_./:=@%+,-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** One message for a lane: the open findings of `run` (or just `run.only`) and
 *  the failed manual results in `manual`. */
export function railsEnvelope(run: RailsEnvelopeRun | null, manual: readonly RailsEnvelopeCheck[]): string {
  const head: string[] = [run ? `[rails] run ${run.record.runId} — verdict ${run.record.verdict}` : '[rails] manual checks'];
  const failed = run?.record.checks.filter((check) => isFailedCheck(check.outcome)) ?? [];
  if (failed.length > 0) {
    const list = failed.map((check) =>
      check.outcome === 'timeout' ? `${check.name} (timeout)` : `${check.name} (exit ${check.exitCode ?? '?'})`);
    head.push(`Failed checks: ${list.join(', ')}`);
  }
  if (manual.length > 0) {
    head.push(`Failed manual checks (${manual.length}):`, ...manual.map(manualLine));
  }
  const findings = run ? (run.only ? [run.only] : run.record.open) : [];
  if (findings.length > 0) head.push(run?.only ? 'Finding:' : `Open findings (${findings.length}):`);

  const checkFiles = manual.map(({ decl, path }) => `Check file ${decl.name}: ${path} (last 80 lines of output) · `
    + `rerun for the full output: ${decl.argv.map(shellWord).join(' ')}`);
  const foot = [...(run ? [`Run file: ${run.path}`] : []), ...checkFiles, INSTRUCTION].join('\n');

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
