// Krypton — Rails verifier (spec 337): the shared contract.
//
// The Rust half (`src-tauri/src/rails.rs`, serde camelCase) mirrors the
// snapshot and check types below. The run record is opaque JSON to Rust: this
// file owns its shape, and `rails_record_run` / `rails_history` only store and
// list it.

import type { AssistFailure } from '../assist/types';
import type { ReviewDiffstatEntry, ReviewUntrackedExcerpt } from '../types';

export type RailsMode = 'off' | 'manual' | 'auto';

export type RailsTrust = 'trusted' | 'untrusted' | 'changed';

export type RailsCheckOutcome = 'pass' | 'fail' | 'timeout' | 'error';

export interface RailsCheckDecl {
  readonly name: string;
  readonly argv: readonly string[];
  readonly timeoutS: number;
}

/** One `## Rails` bullet. `id` is `<relative path>#<n>` (1-based). */
export interface RailsRule {
  readonly id: string;
  /** Repo-relative path of the markdown file the bullet came from. */
  readonly source: string;
  /** Backticked globs from `Applies to:`; empty = every path. */
  readonly appliesTo: readonly string[];
  /** Name from a trailing `` `check:<name>` `` marker: an enforced rule. */
  readonly check: string | null;
  readonly text: string;
}

/** One `**Term**:` entry of the glossary file. `id` is `<glossary path>#<Term>`. */
export interface RailsGlossaryEntry {
  readonly id: string;
  readonly term: string;
  readonly definition: string;
  readonly avoid: readonly string[];
}

/** `rails_load` / `rails_trust`. `present: false` means no `.krypton/rails.toml`. */
export interface RailsSnapshot {
  readonly present: boolean;
  /** Absolute path of the manifest (also when it does not exist). */
  readonly manifestPath: string;
  readonly trust: RailsTrust;
  readonly checks: readonly RailsCheckDecl[];
  readonly rules: readonly RailsRule[];
  readonly glossary: readonly RailsGlossaryEntry[];
  /** Repo-relative rule sources that have no `## Rails` section. */
  readonly uncoveredSources: readonly string[];
  readonly warnings: readonly string[];
  /** Manifest parse / validation error; nothing may run while set. */
  readonly error: string | null;
}

/** `rails_run_check`. `outputTail` is the last ≤ 80 lines, ≤ 8 KiB. */
export interface RailsCheckResult {
  readonly name: string;
  readonly outcome: RailsCheckOutcome;
  readonly exitCode: number | null;
  readonly durationMs: number;
  readonly outputTail: string;
}

export type RailsSeverity = 'violation' | 'suspect';

/** One judge-step finding, after strict parsing. */
export interface RailsFinding {
  readonly rule: string;
  readonly severity: RailsSeverity;
  readonly file: string;
  readonly line: number | null;
  /** 1–240 chars, natural Thai with technical terms in English. */
  readonly note: string;
}

/** What `railsJudge.parse` returns. */
export interface RailsFindingSet {
  readonly findings: readonly RailsFinding[];
  /** Entries the model returned that failed validation. */
  readonly dropped: number;
}

/**
 * - `new`: not open in the previous completed run.
 * - `open`: open in the previous run too; `firstSeenRunId` is when it appeared.
 * - `not-rechecked`: open before, its rule was out of scope this run, so it
 *   was carried over unjudged.
 */
export type TrackedFindingStatus = 'new' | 'open' | 'not-rechecked';

export interface TrackedFinding extends RailsFinding {
  /** Identity across runs: `${rule}\u0000${file}`. */
  readonly key: string;
  readonly status: TrackedFindingStatus;
  readonly firstSeenRunId: string;
  /** `finishedAt` of the run that first reported it (RFC 3339). */
  readonly firstSeenAt: string;
}

/** `pass` / `fail` only for enforced rules (from their check). */
export type RailsRuleStatus = 'violated' | 'suspect' | 'clean' | 'out-of-scope' | 'pass' | 'fail';

/**
 * Computed in code (spec 337 §Verdict). `error` = the run could not judge the
 * tree: a check that could not start, a manifest error, or a judge failure
 * with no check failure to report.
 */
export type RailsVerdict = 'clean' | 'findings' | 'check_failed' | 'error';

export type RailsJudgeState = 'ran' | 'skipped' | 'failed';

export interface RailsRunTrigger {
  readonly kind: 'auto' | 'manual';
  /** The lane whose busy → idle armed an auto run, or the lane `#rails now` was typed in. */
  readonly laneId: string | null;
  readonly laneName: string | null;
}

/** One file under `.krypton/rails/runs/<runId>.json`. */
export interface RailsRunRecord {
  readonly version: 1;
  /** `YYYYMMDDTHHMMSSZ-xxxx` (UTC, 4 lowercase hex). Rust validates this. */
  readonly runId: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly trigger: RailsRunTrigger;
  /** SHA-256 hex of the diffstat rows, the diff and the untracked heads. */
  readonly fingerprint: string;
  readonly verdict: RailsVerdict;
  /** The working tree changed while the run was in flight. */
  readonly stale: boolean;
  readonly checks: readonly RailsCheckResult[];
  /** True when checks were skipped because the manifest is not trusted. */
  readonly checksSkipped: boolean;
  readonly judge: RailsJudgeState;
  readonly judgeFailure: AssistFailure | null;
  /** Findings open after this run (new, still open, or carried over). */
  readonly open: readonly TrackedFinding[];
  /** Open in the previous run, re-judged and absent now. */
  readonly resolved: readonly RailsFinding[];
  readonly dropped: number;
  /** Set when the selected rules did not all fit the payload. */
  readonly rulesTruncated: { readonly kept: number; readonly total: number } | null;
  /** Every rule in the snapshot → its status in this run. */
  readonly ruleStatus: Readonly<Record<string, RailsRuleStatus>>;
  readonly error: string | null;
}

/** Built by the controller per judge call; `railsJudge` reads only this. */
export interface RailsJudgeContext {
  /** Selected rules (already filtered by changed paths), source order. */
  readonly rules: readonly RailsRule[];
  /** Selected glossary entries. */
  readonly glossary: readonly RailsGlossaryEntry[];
  readonly diffstat: readonly ReviewDiffstatEntry[];
  /** Possibly truncated by the Rust collector (40 960 B). */
  readonly diff: string;
  readonly untracked: readonly ReviewUntrackedExcerpt[];
  /** Only checks whose outcome is `fail` or `timeout`. */
  readonly failedChecks: readonly RailsCheckResult[];
}

/** Resolved `[acp_harness.rails]`, clamped (spec 337 §Configuration). */
export interface RailsConfig {
  readonly mode: RailsMode;
  readonly backendId: string;
  /** `""` in TOML ⇒ undefined ⇒ the backend's own default model. */
  readonly modelId: string | undefined;
  readonly timeoutMs: number;
  readonly maxInputChars: number;
  readonly debounceMs: number;
}

/** What the dock head shows while nothing new is recorded. */
export type RailsProgress =
  | { readonly kind: 'idle' }
  | { readonly kind: 'checking'; readonly index: number; readonly total: number; readonly name: string }
  | { readonly kind: 'judging' }
  /** An automatic run stopped at trust; the dock lists the argv waiting for `#rails trust`. */
  | { readonly kind: 'paused' }
  | { readonly kind: 'clean-tree' }
  /** Another harness holds the per-root check lock. */
  | { readonly kind: 'busy' }
  /** The judge breaker is open until this epoch ms. */
  | { readonly kind: 'cooling'; readonly until: number }
  | { readonly kind: 'error'; readonly message: string };

/** Everything the Rails dock paints. Selection lives here, not in the component. */
export interface RailsDockModel {
  /** `null` until the first `rails_load` resolves. */
  readonly snapshot: RailsSnapshot | null;
  readonly mode: RailsMode;
  readonly progress: RailsProgress;
  /** Newest first, at most 20; `[0]` is the latest completed run. */
  readonly history: readonly RailsRunRecord[];
  /** Key of the selected row (see `RailsDockRow.key`), or null. */
  readonly selectedKey: string | null;
  /** Keys of expanded rows. */
  readonly expanded: ReadonlySet<string>;
}

/** 1 head · 2 checks · 3 findings · 4 rules · 5 runs (the `1`–`5` jump keys). */
export type RailsDockSection = 1 | 2 | 3 | 4 | 5;

/**
 * The dock's navigable rows, in paint order. `railsDockRows(model)` in
 * `rows.ts` derives them; the component paints them and the controller moves
 * the selection over the same list, so the two can never disagree.
 */
export type RailsDockRow =
  | { readonly kind: 'head'; readonly key: 'head'; readonly section: 1 }
  | {
      readonly kind: 'check';
      readonly key: string; // `check:<name>`
      readonly section: 2;
      readonly decl: RailsCheckDecl;
      /** From the latest run; null when it has not run (or checks were skipped). */
      readonly result: RailsCheckResult | null;
    }
  | { readonly kind: 'finding'; readonly key: string; readonly section: 3; readonly finding: TrackedFinding } // `finding:<TrackedFinding.key>`
  | { readonly kind: 'resolved'; readonly key: 'resolved'; readonly section: 3; readonly findings: readonly RailsFinding[] }
  | {
      readonly kind: 'rules';
      readonly key: 'rules';
      readonly section: 4;
      readonly total: number;
      readonly enforced: number;
      readonly judgeOnly: number;
    }
  /** Present only while the `rules` row is expanded. */
  | {
      readonly kind: 'rule';
      readonly key: string; // `rule:<id>`
      readonly section: 4;
      readonly rule: RailsRule;
      /** Status from the newest run in which the rule was in scope; null if never. */
      readonly status: RailsRuleStatus | null;
    }
  | { readonly kind: 'uncovered'; readonly key: 'uncovered'; readonly section: 4; readonly sources: readonly string[] }
  | { readonly kind: 'run'; readonly key: string; readonly section: 5; readonly run: RailsRunRecord }; // `run:<runId>`

/** `system:rails` ViewBus signal value (footer). `none` = this harness has no manifest. */
export interface RailsFooterSignal {
  readonly sourceId: string;
  readonly state: 'none' | 'running' | 'paused' | 'clean' | 'findings' | 'check_failed' | 'error';
  readonly findings: number;
  readonly failedCheck: string | null;
}
