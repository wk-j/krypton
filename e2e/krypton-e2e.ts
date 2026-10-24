// Krypton e2e runner. Implements the Krypton E2E Adapter Contract v1
// (`.krypton/e2e/CONTRACT.md`) natively, and runs by hand from a terminal:
//
//   node e2e/krypton-e2e.ts list
//   node e2e/krypton-e2e.ts run <caseId> [--param k=v]...
//   node e2e/krypton-e2e.ts history
//
// `list` and `history` print only JSON on stdout. `run` logs on stdout, keeps
// its evidence in `e2e/runs/<caseId>/<runId>/`, and also writes the Result to
// `$KRYPTON_E2E_RESULT` when that is set. Exit code: 0 PASS, 1 FAIL, 2 BLOCKED,
// 3 ERROR, 64 usage.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { BlockedError, CASES_DIR, Run, RUNS_DIR, repoRelative, verdictOf } from './lib/run.ts';
import type { CaseMeta, CaseModule, ParamValue, Result, Verdict } from './lib/run.ts';

const USAGE = 'usage: node e2e/krypton-e2e.ts list | run <caseId> [--param k=v]... | history';
const EXIT_CODES: Record<Verdict, number> = { PASS: 0, FAIL: 1, BLOCKED: 2, ERROR: 3 };

async function loadCases(): Promise<Array<{ module: CaseModule; file: string }>> {
  const files = readdirSync(CASES_DIR)
    .filter((name) => name.endsWith('.ts'))
    .sort();
  const cases: Array<{ module: CaseModule; file: string }> = [];
  for (const name of files) {
    const file = join(CASES_DIR, name);
    // Cases are discovered from the folder at run time, so adding one is just a new file.
    const module = (await import(pathToFileURL(file).href)) as CaseModule;
    if (module.meta?.id !== basename(name, '.ts') || typeof module.execute !== 'function') {
      throw new Error(`${repoRelative(file)} must export meta.id = '${basename(name, '.ts')}' and execute()`);
    }
    cases.push({ module, file });
  }
  return cases;
}

async function list(): Promise<number> {
  const cases = await loadCases();
  const out = cases.map(({ module, file }) => {
    const meta: CaseMeta & { files: string[] } = { ...module.meta, files: [repoRelative(file)] };
    return meta;
  });
  process.stdout.write(`${JSON.stringify({ version: 1, cases: out })}\n`);
  return 0;
}

function history(): number {
  const runs: Result[] = [];
  if (existsSync(RUNS_DIR)) {
    for (const caseDir of readdirSync(RUNS_DIR, { withFileTypes: true })) {
      if (!caseDir.isDirectory()) continue;
      for (const runDir of readdirSync(join(RUNS_DIR, caseDir.name), { withFileTypes: true })) {
        const path = join(RUNS_DIR, caseDir.name, runDir.name, 'result.json');
        if (!runDir.isDirectory() || !existsSync(path)) continue;
        try {
          const result = JSON.parse(readFileSync(path, 'utf8')) as Result;
          if (result.version === 1 && result.caseId && result.runId && result.verdict && Array.isArray(result.checks)) {
            runs.push(result);
          }
        } catch (error) {
          process.stderr.write(`history: skipping ${repoRelative(path)}: ${String(error)}\n`);
        }
      }
    }
  }
  runs.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  process.stdout.write(`${JSON.stringify({ version: 1, runs })}\n`);
  return 0;
}

function parseRunArgs(args: string[]): { caseId: string; given: Record<string, string> } | string {
  const [caseId, ...rest] = args;
  if (!caseId || caseId.startsWith('-')) return 'run needs a case id';
  const given: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 1) {
    const pair = rest[i] === '--param' ? rest[i + 1] : undefined;
    const eq = pair?.indexOf('=') ?? -1;
    if (!pair || eq < 1) return `unexpected argument: ${rest[i]}`;
    given[pair.slice(0, eq)] = pair.slice(eq + 1);
    i += 1;
  }
  return { caseId, given };
}

async function run(args: string[]): Promise<number> {
  const parsed = parseRunArgs(args);
  if (typeof parsed === 'string') {
    process.stderr.write(`${parsed}\n${USAGE}\n`);
    return 64;
  }
  const { caseId, given } = parsed;
  const record = new Run(caseId, new Date());
  let params: Record<string, ParamValue> = { ...given };
  let verdict: Verdict;
  let message: string | undefined;
  try {
    const found = (await loadCases()).find(({ module }) => module.meta.id === caseId);
    if (!found) throw new Error(`unknown case: ${caseId}`);
    const { meta } = found.module;
    const declared = new Set([...Object.keys(meta.params ?? {}), ...Object.keys(meta.fresh ?? {})]);
    const undeclared = Object.keys(given).filter((key) => !declared.has(key));
    if (undeclared.length > 0) throw new Error(`undeclared param(s) for ${caseId}: ${undeclared.join(', ')}`);
    params = { ...(meta.params ?? {}), ...given };
    record.log(`run ${caseId} ${record.runId} ${JSON.stringify(params)}`);
    await found.module.execute({ run: record, params });
    verdict = verdictOf(record.checks);
    if (verdict === 'ERROR') message = 'the case recorded no passing assertion';
  } catch (error) {
    if (error instanceof BlockedError) {
      verdict = 'BLOCKED';
      message = error.message;
    } else {
      verdict = 'ERROR';
      message = error instanceof Error ? error.message : String(error);
      record.log(`ERROR ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    }
  }
  const result = record.finish(verdict, params, message);
  const target = process.env.KRYPTON_E2E_RESULT;
  if (target) {
    const path = resolve(process.cwd(), target);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(result, null, 2)}\n`);
  }
  const passed = result.checks.filter((c) => c.status === 'pass').length;
  const failed = result.checks.filter((c) => c.status === 'fail').length;
  record.log(
    `${verdict} ${caseId} ${passed}✓ ${failed}✗ run ${result.runId} → ${repoRelative(join(record.dir, 'result.json'))}${message ? ` — ${message}` : ''}`,
  );
  return EXIT_CODES[verdict];
}

async function main(): Promise<number> {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'list' && args.length === 0) return list();
  if (command === 'history' && args.length === 0) return history();
  if (command === 'run') return run(args);
  process.stderr.write(`${USAGE}\n`);
  return 64;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exitCode = 3;
  },
);
