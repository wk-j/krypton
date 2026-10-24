// Krypton — `#e2e` command grammar and transcript formatting (spec 328).
//
// Pure module: the Rust side (`src-tauri/src/e2e.rs`) gathers data and runs
// the project's adapter; this file parses the command, derives the marks and
// lays the results out as `shell`-row text (cell grid, spec 326).

export type E2eVerdict =
  | 'PASS'
  | 'FAIL'
  | 'ERROR'
  | 'BLOCKED'
  | 'CANCELLED'
  | 'NO RESULT'
  | 'INVALID RESULT'
  | 'INTERRUPTED';

export interface E2eManifestInfo {
  name: string;
  history: boolean;
  issueLabel: string | null;
  createPrompt: string | null;
  reportPrompt: string | null;
}

export interface E2eCaseInfo {
  id: string;
  title: string;
  code: string | null;
  issue: number | null;
  params: Record<string, string | number>;
  fresh: Record<string, string>;
  files: string[];
  caseHash: string | null;
  uncommitted: boolean;
}

export interface E2eFailedCheck {
  group: string | null;
  label: string;
  status: 'fail' | 'blocked';
  detail: string | null;
}

export interface E2eRunInfo {
  caseId: string;
  /** The case's short code; set only on the run `#e2e run`/`rerun` just made. */
  code: string | null;
  runId: string;
  origin: 'krypton' | 'ext';
  launchId: string | null;
  verdict: E2eVerdict;
  startedAt: string | null;
  finishedAt: string | null;
  counts: { pass: number; fail: number; skip: number; blocked: number; info: number };
  failed: E2eFailedCheck[];
  versions: Record<string, string>;
  params: Record<string, string> | null;
  git: { sha: string; branch: string; dirty: boolean } | null;
  caseHash: string | null;
  exitCode: number | null;
  resultPath: string | null;
  logPath: string | null;
  message: string | null;
  argv: string[] | null;
}

export interface E2eIssueInfo {
  number: number;
  title: string;
  url: string;
  state: string;
  reportedRunIds: string[];
}

export interface E2eStatus {
  initialized: boolean;
  manifest: E2eManifestInfo | null;
  errors: string[];
  cases: E2eCaseInfo[];
  runs: E2eRunInfo[];
  issues: E2eIssueInfo[] | null;
  issuesError: string | null;
  activeLaunch: { launchId: string; caseId: string; startedAt: string } | null;
}

export interface E2eFoundRun {
  caseId: string;
  runId: string;
  issue: number | null;
  resultPath: string;
}

export type E2eCommand =
  | { kind: 'status'; caseId: string | null }
  | { kind: 'run'; caseId: string; params: Record<string, string>; fresh: boolean }
  | { kind: 'run-all'; fresh: boolean }
  | { kind: 'rerun' }
  | { kind: 'cancel' }
  | { kind: 'init'; hint: string }
  | { kind: 'case'; issue: number }
  | { kind: 'report'; target: string }
  | { kind: 'open'; caseId: string | null }
  | { kind: 'usage'; error: string };

export const E2E_USAGE =
  '#e2e [status [<case>] | run <case|all> [k=v…] [--fresh] | rerun | cancel | open [<case>] | init [<hint>] | case <issue> | report <case|runId>]';

const PARAM_KEY = /^[A-Za-z0-9_.-]+$/;

/** Parse the full composer text (`#e2e …`). A bare `#e2e` is `status`. */
export function parseE2eCommand(text: string): E2eCommand {
  const trimmed = text.trim();
  const tokens = trimmed.split(/\s+/);
  const sub = tokens[1] ?? 'status';
  const rest = tokens.slice(2);
  switch (sub) {
    case 'status':
      if (rest.length > 1) return usage('status takes at most one case');
      return { kind: 'status', caseId: rest[0] ?? null };
    case 'run':
      return parseRun(rest);
    case 'rerun':
      return rest.length === 0 ? { kind: 'rerun' } : usage('rerun takes no arguments');
    case 'cancel':
      return rest.length === 0 ? { kind: 'cancel' } : usage('cancel takes no arguments');
    case 'init':
      // The hint is free text: keep its spacing, only drop the command words.
      return { kind: 'init', hint: trimmed.replace(/^\S+\s+init\b/, '').trim() };
    case 'case': {
      if (rest.length !== 1) return usage('case takes one issue number');
      const issue = parseIssueNumber(rest[0]);
      return issue === null ? usage(`not an issue number: ${rest[0]}`) : { kind: 'case', issue };
    }
    case 'report':
      if (rest.length !== 1) return usage('report takes one case or run id');
      return { kind: 'report', target: rest[0] };
    case 'open':
      if (rest.length > 1) return usage('open takes at most one case');
      return { kind: 'open', caseId: rest[0] ?? null };
    default:
      return usage(`unknown subcommand: ${sub}`);
  }
}

function parseRun(rest: string[]): E2eCommand {
  const target = rest[0];
  if (!target) return usage('run needs a case id or all');
  if (target.startsWith('-')) return usage('run needs a case id before options');
  let fresh = false;
  const params: Record<string, string> = {};
  for (const token of rest.slice(1)) {
    if (token === '--fresh') {
      fresh = true;
      continue;
    }
    const eq = token.indexOf('=');
    if (eq <= 0) return usage(`expected k=v or --fresh, got ${token}`);
    const key = token.slice(0, eq);
    if (!PARAM_KEY.test(key)) return usage(`bad param name: ${key}`);
    if (key in params) return usage(`duplicate param: ${key}`);
    params[key] = token.slice(eq + 1);
  }
  if (target === 'all') {
    if (Object.keys(params).length > 0) return usage('run all takes only --fresh');
    return { kind: 'run-all', fresh };
  }
  return { kind: 'run', caseId: target, params, fresh };
}

function parseIssueNumber(token: string): number | null {
  const match = /^#?(\d+)$/.exec(token);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function usage(error: string): E2eCommand {
  return { kind: 'usage', error };
}

// ─── Marks ──────────────────────────────────────────────────────────────────

const VERDICT_LETTER: Record<E2eVerdict, string> = {
  PASS: 'P',
  FAIL: 'F',
  ERROR: 'E',
  BLOCKED: 'B',
  CANCELLED: 'C',
  'NO RESULT': '!',
  'INVALID RESULT': '!',
  INTERRUPTED: '!',
};

/** Runs of one case, newest first (the status list is already newest first). */
export function runsForCase(runs: readonly E2eRunInfo[], caseId: string): E2eRunInfo[] {
  return runs.filter((run) => run.caseId === caseId);
}

/** The newest run that judged the app: PASS or FAIL. */
export function newestJudgedRun(caseRuns: readonly E2eRunInfo[]): E2eRunInfo | null {
  return caseRuns.find((run) => run.verdict === 'PASS' || run.verdict === 'FAIL') ?? null;
}

export function verdictStrip(caseRuns: readonly E2eRunInfo[], limit = 10): string {
  return caseRuns.slice(0, limit).map((run) => VERDICT_LETTER[run.verdict]).join('');
}

/**
 * Spec 328 marks for one case. `issue` is the labelled issue the case links
 * to; `issuesKnown` is false when issues were not fetched, so `unreported`
 * is never guessed.
 */
export function e2eCaseMarks(
  c: E2eCaseInfo,
  caseRuns: readonly E2eRunInfo[],
  issue: E2eIssueInfo | undefined,
  issuesKnown: boolean,
): string[] {
  const marks: string[] = [];
  if (c.uncommitted) marks.push('uncommitted');
  const lastKryptonPass = caseRuns.find((run) => run.origin === 'krypton' && run.verdict === 'PASS');
  if (c.caseHash && lastKryptonPass?.caseHash && lastKryptonPass.caseHash !== c.caseHash) {
    marks.push('edited');
  }
  if (issuesKnown && issue) {
    const judged = newestJudgedRun(caseRuns);
    if (judged && !issue.reportedRunIds.includes(judged.runId)) marks.push('unreported');
  }
  return marks;
}

/** Labelled issues that no case links to. */
export function issuesWithoutCase(status: E2eStatus): E2eIssueInfo[] {
  if (!status.issues) return [];
  const linked = new Set(status.cases.map((c) => c.issue).filter((n): n is number => n !== null));
  return status.issues.filter((issue) => !linked.has(issue.number));
}

// ─── Formatting ─────────────────────────────────────────────────────────────

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** Local `MM-DD HH:mm`, or `—` when the time is unknown or unparsable. */
export function shortWhen(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

export function clockTime(ms: number): string {
  const date = new Date(ms);
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

export function runDuration(run: E2eRunInfo): string | null {
  if (!run.startedAt || !run.finishedAt) return null;
  const ms = new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  const total = Math.round(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes > 0 ? `${minutes}m${pad2(seconds)}s` : `${seconds}s`;
}

function commitLabel(run: E2eRunInfo): string {
  if (run.origin === 'ext') return 'ext';
  if (!run.git) return '—';
  return `${run.git.sha.slice(0, 8)}${run.git.dirty ? '*' : ''}`;
}

/** Columns padded with two spaces; the transcript lays them on the cell grid. */
function table(rows: readonly (readonly string[])[]): string[] {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, [...cell].length);
    });
  }
  return rows.map((row) =>
    row
      .map((cell, i) => (i === row.length - 1 ? cell : cell + ' '.repeat(widths[i] - [...cell].length)))
      .join('  ')
      .trimEnd(),
  );
}

const NOT_INITIALIZED = 'not initialized — #e2e init';

export function formatE2eStatus(command: string, status: E2eStatus): string {
  const lines = [command];
  if (!status.initialized) {
    lines.push(NOT_INITIALIZED);
    return lines.join('\n');
  }
  if (status.manifest) lines.push(status.manifest.name);
  const issuesKnown = status.issues !== null;
  const issueByNumber = new Map((status.issues ?? []).map((issue) => [issue.number, issue]));
  const rows: string[][] = [['CASE', 'ISSUE', 'LAST', 'WHEN', '✓/✗', 'COMMIT', 'LAST 10', 'MARKS']];
  for (const c of status.cases) {
    const caseRuns = runsForCase(status.runs, c.id);
    const last = caseRuns[0];
    const issue = c.issue === null ? undefined : issueByNumber.get(c.issue);
    rows.push([
      c.id,
      c.issue === null ? '—' : `#${c.issue}`,
      last ? last.verdict : '—',
      last ? shortWhen(last.startedAt) : '—',
      last ? `${last.counts.pass}/${last.counts.fail}` : '—',
      last ? commitLabel(last) : '—',
      caseRuns.length > 0 ? verdictStrip(caseRuns) : '—',
      e2eCaseMarks(c, caseRuns, issue, issuesKnown).join(' '),
    ]);
  }
  for (const issue of issuesWithoutCase(status)) {
    rows.push(['—', `#${issue.number}`, '—', '—', '—', '—', '—', 'no case']);
  }
  if (rows.length === 1) lines.push('no cases');
  else lines.push(...table(rows));
  if (status.activeLaunch) {
    lines.push(`running ${status.activeLaunch.caseId} since ${shortWhen(status.activeLaunch.startedAt)}`);
  }
  if (status.manifest?.issueLabel && status.issuesError) {
    lines.push(`issues unavailable: ${status.issuesError}`);
  }
  for (const error of status.errors) lines.push(`! ${error}`);
  return lines.join('\n');
}

const FAILED_LINES = 10;

function failedLines(run: E2eRunInfo): string[] {
  const lines = run.failed.slice(0, FAILED_LINES).map((check) => {
    const mark = check.status === 'blocked' ? '!' : '✗';
    const where = check.group ? `${check.group} › ${check.label}` : check.label;
    return check.detail ? `${mark} ${where} — ${check.detail}` : `${mark} ${where}`;
  });
  if (run.failed.length > FAILED_LINES) lines.push(`… ${run.failed.length - FAILED_LINES} more`);
  return lines;
}

export function formatE2eCaseDetail(command: string, status: E2eStatus, caseId: string): string {
  const lines = [command];
  if (!status.initialized) {
    lines.push(NOT_INITIALIZED);
    return lines.join('\n');
  }
  const c = status.cases.find((entry) => entry.id === caseId);
  const caseRuns = runsForCase(status.runs, caseId);
  if (!c && caseRuns.length === 0) {
    const known = status.cases.map((entry) => entry.id).join(', ') || 'none';
    lines.push(`unknown case "${caseId}"; known: ${known}`);
    return lines.join('\n');
  }
  if (c) {
    const issue = c.issue === null ? undefined : status.issues?.find((entry) => entry.number === c.issue);
    const marks = e2eCaseMarks(c, caseRuns, issue, status.issues !== null);
    lines.push([c.id, c.code ?? '', c.issue === null ? '' : `#${c.issue}`, marks.join(' ')].filter(Boolean).join('  '));
    lines.push(c.title);
  }
  if (caseRuns.length === 0) {
    lines.push('no runs yet');
    return lines.join('\n');
  }
  const rows: string[][] = [['WHEN', 'VERDICT', '✓/✗', 'COMMIT', 'RUN']];
  for (const run of caseRuns.slice(0, 10)) {
    rows.push([
      shortWhen(run.startedAt),
      run.verdict,
      `${run.counts.pass}/${run.counts.fail}`,
      commitLabel(run),
      run.launchId ?? run.runId,
    ]);
  }
  lines.push(...table(rows));
  const failed = failedLines(caseRuns[0]);
  if (failed.length > 0) lines.push(...failed);
  return lines.join('\n');
}

export function formatE2ePending(command: string, caseId: string, startedAtMs: number): string {
  return `${command}\nrunning ${caseId} · started ${clockTime(startedAtMs)} · #e2e cancel to stop`;
}

export function formatE2eRunSummary(command: string, run: E2eRunInfo, c?: E2eCaseInfo): string {
  const head = [run.verdict, run.caseId];
  const code = c?.code ?? run.code;
  if (code) head.push(code);
  head.push(`${run.counts.pass}✓ ${run.counts.fail}✗`);
  if (run.counts.blocked > 0) head.push(`${run.counts.blocked}!`);
  const duration = runDuration(run);
  if (duration) head.push(duration);
  const lines = [command, head.join('  ')];
  const provenance: string[] = [];
  if (run.git) provenance.push(`commit ${run.git.sha.slice(0, 8)}${run.git.dirty ? '*' : ''} ${run.git.branch}`.trimEnd());
  for (const [component, version] of Object.entries(run.versions)) provenance.push(`${component} ${version}`);
  if (provenance.length > 0) lines.push(provenance.join(' · '));
  if (run.resultPath) lines.push(`result ${run.resultPath}`);
  if (run.logPath) lines.push(`log    ${run.logPath}`);
  lines.push(...failedLines(run));
  if (run.message) lines.push(run.message);
  return lines.join('\n');
}

// ─── Prompts from the manifest ──────────────────────────────────────────────

export interface E2ePromptVars {
  issue?: number;
  issueUrl?: string;
  runId?: string;
  resultPath?: string;
}

/** Fill `{issue}`, `{issue_url}`, `{run_id}`, `{result_path}`; leave other braces alone. */
export function renderE2ePrompt(template: string, vars: E2ePromptVars): string {
  const values: Record<string, string | undefined> = {
    issue: vars.issue === undefined ? undefined : String(vars.issue),
    issue_url: vars.issueUrl,
    run_id: vars.runId,
    result_path: vars.resultPath,
  };
  return template.replace(/\{(issue|issue_url|run_id|result_path)\}/g, (whole, key: string) => values[key] ?? whole);
}

/** `https://github.com/<owner>/<repo>` from an `origin` URL, or null when it is not GitHub. */
export function githubRepoUrl(remote: string): string | null {
  const match = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(remote.trim());
  return match ? `https://github.com/${match[1]}/${match[2]}` : null;
}
