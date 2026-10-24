// Krypton e2e — the Result model (Krypton E2E Adapter Contract v1), the
// per-run evidence folder and the check recorder a case writes into.

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const E2E_DIR: string = fileURLToPath(new URL('..', import.meta.url));
export const REPO_ROOT: string = resolve(E2E_DIR, '..');
export const CASES_DIR: string = join(E2E_DIR, 'cases');
export const RUNS_DIR: string = join(E2E_DIR, 'runs');

export type Verdict = 'PASS' | 'FAIL' | 'ERROR' | 'BLOCKED';
export type CheckStatus = 'pass' | 'fail' | 'skip' | 'blocked' | 'info';
export type ParamValue = string | number;

export interface Check {
  group?: string;
  label: string;
  status: CheckStatus;
  detail?: string;
}

export interface Artifact {
  label: string;
  path: string;
}

export interface Result {
  version: 1;
  caseId: string;
  runId: string;
  verdict: Verdict;
  startedAt: string;
  finishedAt: string;
  env?: string;
  versions?: Record<string, string>;
  params?: Record<string, ParamValue>;
  checks: Check[];
  artifacts?: Artifact[];
  message?: string;
}

export interface CaseMeta {
  id: string;
  title: string;
  code?: string;
  issue?: number;
  params?: Record<string, ParamValue>;
  fresh?: Record<string, string>;
}

export interface CaseContext {
  run: Run;
  params: Record<string, ParamValue>;
}

export interface CaseModule {
  meta: CaseMeta;
  execute(ctx: CaseContext): Promise<void>;
}

/** Thrown by `Run.block()`: a precondition failed and the app was never exercised. */
export class BlockedError extends Error {}

/** UTC timestamp id, unique per case and stable across `run` and `history`. */
export function newRunId(now: Date): string {
  return now.toISOString().replace(/[-:.]/g, '');
}

export function repoRelative(path: string): string {
  return relative(REPO_ROOT, path).split('\\').join('/');
}

export class Run {
  readonly caseId: string;
  readonly runId: string;
  readonly startedAt: string;
  readonly dir: string;
  readonly checks: Check[] = [];
  readonly artifacts: Artifact[] = [];
  readonly versions: Record<string, string> = {};
  env = 'local';
  private readonly logPath: string;
  private readonly secrets: string[] = [];
  private captureSeq = 0;

  constructor(caseId: string, startedAt: Date) {
    this.caseId = caseId;
    this.runId = newRunId(startedAt);
    this.startedAt = startedAt.toISOString();
    this.dir = join(RUNS_DIR, caseId, this.runId);
    mkdirSync(join(this.dir, 'responses'), { recursive: true });
    this.logPath = join(this.dir, 'log.txt');
    writeFileSync(this.logPath, '');
    this.artifacts.push({ label: 'log', path: repoRelative(this.logPath) });
  }

  /** Register a value that must never reach the log, a capture or the Result. */
  addSecret(value: string): void {
    if (value) this.secrets.push(value);
  }

  redact(text: string): string {
    let out = text;
    for (const secret of this.secrets) out = out.split(secret).join('<redacted>');
    return out;
  }

  log(message: string): void {
    const line = this.redact(message);
    process.stdout.write(`${line}\n`);
    appendFileSync(this.logPath, `${new Date().toISOString()} ${line}\n`);
  }

  check(group: string, label: string, ok: boolean, detail: string): boolean {
    this.record({ group, label, status: ok ? 'pass' : 'fail', detail });
    return ok;
  }

  info(group: string, label: string, detail: string): void {
    this.record({ group, label, status: 'info', detail });
  }

  skip(group: string, label: string, detail: string): void {
    this.record({ group, label, status: 'skip', detail });
  }

  block(group: string, label: string, detail: string): never {
    this.record({ group, label, status: 'blocked', detail });
    throw new BlockedError(this.redact(detail));
  }

  /** Save one piece of raw evidence under `responses/` and list it as an artifact. */
  capture(step: string, data: unknown): void {
    this.captureSeq += 1;
    const name = `${String(this.captureSeq).padStart(2, '0')}-${step}.json`;
    const path = join(this.dir, 'responses', name);
    writeFileSync(path, `${this.redact(JSON.stringify(data, null, 2))}\n`);
    this.artifacts.push({ label: step, path: repoRelative(path) });
  }

  finish(verdict: Verdict, params: Record<string, ParamValue>, message?: string): Result {
    const result: Result = {
      version: 1,
      caseId: this.caseId,
      runId: this.runId,
      verdict,
      startedAt: this.startedAt,
      finishedAt: new Date().toISOString(),
      env: this.env,
      versions: { ...this.versions },
      params: { ...params },
      checks: this.checks,
      artifacts: this.artifacts,
    };
    if (message) result.message = this.redact(message);
    writeFileSync(join(this.dir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
    return result;
  }

  private record(check: Check): void {
    const detail = check.detail === undefined ? undefined : this.redact(check.detail);
    this.checks.push({ ...check, detail });
    const tag = check.status.toUpperCase().padEnd(7);
    this.log(`${tag} [${check.group ?? ''}] ${check.label}${detail ? ` — ${detail}` : ''}`);
  }
}

/** PASS needs at least one passing assertion and no failure. */
export function verdictOf(checks: Check[]): Verdict {
  if (checks.some((c) => c.status === 'fail')) return 'FAIL';
  if (!checks.some((c) => c.status === 'pass')) return 'ERROR';
  return 'PASS';
}
