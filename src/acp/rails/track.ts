// Krypton — Rails verifier (spec 337): verdict and tracking across runs.
//
// Code decides the verdict; the model never overrides a check. A finding's
// identity is `rule + file` (the line moves between runs), and each run is
// compared with the newest earlier run that completed without error.

import type { ReviewGitState } from '../types';
import type {
  RailsCheckResult,
  RailsFinding,
  RailsJudgeState,
  RailsRule,
  RailsRuleStatus,
  RailsRunRecord,
  RailsVerdict,
  TrackedFinding,
} from './types';

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

/** `YYYYMMDDTHHMMSSZ-xxxx` in UTC; `xxxx` is 4 lowercase hex digits. */
export function newRunId(now: Date, random: () => number = Math.random): string {
  const stamp = `${pad(now.getUTCFullYear(), 4)}${pad(now.getUTCMonth() + 1, 2)}${pad(now.getUTCDate(), 2)}`
    + `T${pad(now.getUTCHours(), 2)}${pad(now.getUTCMinutes(), 2)}${pad(now.getUTCSeconds(), 2)}Z`;
  const suffix = Math.min(0xffff, Math.max(0, Math.floor(random() * 0x10000)));
  return `${stamp}-${suffix.toString(16).padStart(4, '0')}`;
}

/** SHA-256 hex over the diffstat rows, the diff and the untracked heads. */
export async function diffFingerprint(
  state: Pick<ReviewGitState, 'diffstat' | 'diff' | 'untracked'>,
): Promise<string> {
  const material = JSON.stringify([
    state.diffstat.map((row) => [row.path, row.status, row.added, row.removed]),
    state.diff,
    state.untracked.map((file) => [file.path, file.head]),
  ]);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(material));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** `history` is newest first. */
export function previousCompletedRun(history: readonly RailsRunRecord[]): RailsRunRecord | null {
  return history.find((run) => run.verdict !== 'error') ?? null;
}

/**
 * spec 339: ms an auto run must still wait so that it starts at least
 * `minIntervalMs` after the newest recorded run (any trigger, any verdict)
 * started; 0 = it may start now. Capped at `minIntervalMs`, so a `startedAt`
 * in the future (the clock moved back) never holds longer than one interval.
 */
export function autoRunHoldMs(history: readonly RailsRunRecord[], minIntervalMs: number, now: number): number {
  const latest = history[0];
  if (minIntervalMs <= 0 || !latest) return 0;
  const started = Date.parse(latest.startedAt);
  if (!Number.isFinite(started)) return 0;
  return Math.min(minIntervalMs, Math.max(0, started + minIntervalMs - now));
}

export function findingKey(finding: Pick<RailsFinding, 'rule' | 'file'>): string {
  return `${finding.rule}\u0000${finding.file}`;
}

function plain(finding: RailsFinding): RailsFinding {
  return { rule: finding.rule, severity: finding.severity, file: finding.file, line: finding.line, note: finding.note };
}

/**
 * - A finding open before and reported again is `open` (first-seen kept).
 * - A finding not open before is `new`.
 * - A previous finding absent now is `resolved` only when its rule was selected
 *   and the judge ran; otherwise it carries over as `not-rechecked`.
 * - A previous finding whose rule is not in `knownIds` (every rule and glossary
 *   id of the current snapshot) is dropped: its rule was removed or renumbered,
 *   so it is neither carried over nor reported as resolved.
 * Duplicate identities in `findings` keep the first.
 */
export function trackFindings(input: {
  previous: RailsRunRecord | null;
  findings: readonly RailsFinding[];
  selectedRuleIds: ReadonlySet<string>;
  knownIds: ReadonlySet<string>;
  judged: boolean;
  runId: string;
  finishedAt: string;
}): { open: TrackedFinding[]; resolved: RailsFinding[] } {
  const before = new Map<string, TrackedFinding>();
  for (const finding of input.previous?.open ?? []) before.set(finding.key, finding);

  const open: TrackedFinding[] = [];
  const seen = new Set<string>();
  for (const finding of input.findings) {
    const key = findingKey(finding);
    if (seen.has(key)) continue;
    seen.add(key);
    const prior = before.get(key);
    open.push({
      ...plain(finding),
      key,
      status: prior ? 'open' : 'new',
      firstSeenRunId: prior ? prior.firstSeenRunId : input.runId,
      firstSeenAt: prior ? prior.firstSeenAt : input.finishedAt,
    });
  }

  const resolved: RailsFinding[] = [];
  for (const [key, prior] of before) {
    if (seen.has(key) || !input.knownIds.has(prior.rule)) continue;
    if (input.judged && input.selectedRuleIds.has(prior.rule)) {
      resolved.push(plain(prior));
    } else {
      open.push({ ...prior, status: 'not-rechecked' });
    }
  }
  return { open, resolved };
}

function judgeStatus(
  ruleId: string,
  selected: boolean,
  findings: readonly RailsFinding[],
  judged: boolean,
): RailsRuleStatus {
  const citing = findings.filter((finding) => finding.rule === ruleId);
  if (citing.some((finding) => finding.severity === 'violation')) return 'violated';
  if (citing.length > 0) return 'suspect';
  return selected && judged ? 'clean' : 'out-of-scope';
}

/** Every rule → its status in this run. An enforced rule follows its check
 *  unless the check has no result or could not start. */
export function ruleStatuses(input: {
  rules: readonly RailsRule[];
  selectedRuleIds: ReadonlySet<string>;
  findings: readonly RailsFinding[];
  checks: readonly RailsCheckResult[];
  judged: boolean;
}): Record<string, RailsRuleStatus> {
  const byName = new Map(input.checks.map((check) => [check.name, check]));
  const statuses: Record<string, RailsRuleStatus> = {};
  for (const rule of input.rules) {
    const check = rule.check === null ? undefined : byName.get(rule.check);
    if (check?.outcome === 'pass') {
      statuses[rule.id] = 'pass';
    } else if (check?.outcome === 'fail' || check?.outcome === 'timeout') {
      statuses[rule.id] = 'fail';
    } else {
      statuses[rule.id] = judgeStatus(rule.id, input.selectedRuleIds.has(rule.id), input.findings, input.judged);
    }
  }
  return statuses;
}

/** spec 337 §Verdict. A check that could not start is a run error, not a rails failure. */
export function computeVerdict(input: {
  checks: readonly RailsCheckResult[];
  findings: readonly RailsFinding[];
  judge: RailsJudgeState;
  error: string | null;
}): RailsVerdict {
  if (input.checks.some((check) => check.outcome === 'fail' || check.outcome === 'timeout')) return 'check_failed';
  if (input.checks.some((check) => check.outcome === 'error')) return 'error';
  if (input.error !== null) return 'error';
  if (input.judge === 'failed' && input.findings.length === 0) return 'error';
  if (input.findings.length > 0) return 'findings';
  return 'clean';
}

/** The status from the newest run (`history` newest first) in which the rule was in scope. */
export function latestRuleStatus(history: readonly RailsRunRecord[], ruleId: string): RailsRuleStatus | null {
  for (const run of history) {
    const status = run.ruleStatus[ruleId];
    if (status !== undefined && status !== 'out-of-scope') return status;
  }
  return null;
}
