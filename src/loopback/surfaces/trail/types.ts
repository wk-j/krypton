// Spec 400 — the `/trail.json` payload, as `trail.rs` serializes it (camelCase).
// The map is the 0355 `E2eMap`; every check status is Krypton's, never the lane's.

import type { E2eMap } from '../e2e/map';

export type StepKind = 'symptom' | 'ruled-out' | 'suspect' | 'root-cause' | 'decision' | 'plan';
export type EvidenceType = 'cite' | 'commit' | 'observed' | 'repro' | 'inferred' | 'ref';
export type CheckStatus =
  | 'ok'
  | 'mismatch'
  | 'missing'
  | 'unavailable'
  | 'unknown'
  | 'reproduced'
  | 'unexpected'
  | 'stale'
  | 'not-run'
  | 'untrusted'
  | 'unchecked';

export interface TrailSnapshot {
  readonly head: string | null;
  readonly dirty: readonly string[];
  /** Epoch milliseconds. */
  readonly at: number;
}

export interface TrailCheckSnapshot extends TrailSnapshot {
  readonly changed: readonly string[];
}

export interface TrailRun {
  readonly runId: string;
  readonly id: string;
  readonly argv: readonly string[];
  readonly commit: string | null;
  readonly treeClean: boolean;
  readonly outcome: 'pass' | 'fail' | 'timeout' | 'error';
  readonly exitCode: number | null;
  readonly durationMs: number;
  readonly outputTail: string;
}

export interface TrailRepro {
  readonly id: string;
  readonly argv: readonly string[];
  readonly expect: 'fail' | 'pass';
  readonly what: string;
  readonly timeoutS: number;
  readonly trust: 'trusted' | 'untrusted' | 'changed';
  readonly lastRun: TrailRun | null;
}

/** `fields`: cite {file, lines, quote} · commit {sha} · observed {file, what} · repro {id} · inferred {what, source?} · ref {what, url?}. */
export interface TrailEvidence {
  readonly type: EvidenceType;
  readonly fields: Readonly<Record<string, string>>;
  readonly status: CheckStatus;
  readonly detail: string | null;
  readonly outputTail: string | null;
}

export interface TrailStep {
  readonly at: string;
  readonly kind: StepKind;
  readonly note: string;
  readonly question: string | null;
  readonly options: readonly string[];
  readonly answer: string | null;
  readonly evidence: readonly TrailEvidence[];
}

export interface TrailPayload {
  readonly issue: string;
  readonly title: string | null;
  readonly commit: string;
  readonly bundle: string;
  readonly map: {
    readonly path: string;
    readonly map: E2eMap | null;
    readonly errors: readonly string[];
    readonly warnings: readonly string[];
  };
  readonly steps: readonly TrailStep[];
  readonly repro: readonly TrailRepro[];
  readonly state: { readonly start: TrailSnapshot | null; readonly check: TrailCheckSnapshot | null };
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
}

/** `GET /trail.json?project=<id>` without `issue`: every trail of the project, newest issue first. */
export interface TrailIndex {
  readonly projectId: string;
  readonly projectName: string;
  readonly trails: readonly TrailPayload[];
}
