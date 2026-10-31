// Spec 337 — the Rails verifier's harness-facing half.
//
// At a harness quiet point the controller makes one rails run over the project
// working tree: the declared checks (no tokens), then a cheap headless judge
// against the `## Rails` bullets that apply to the changed paths. Code, not the
// model, decides the verdict; every run is recorded under `.krypton/rails/runs/`.
//
// Spec 275 shape: a plain class over a narrow host. It owns its OWN
// `AssistEngine` + `AcpAssistSession`, so its single-flight and breaker never
// collide with the assist tasks (spec 306). It owns the Rails dock component
// and its root, the way the ticket controller owns the ticket dock; placement
// (the dock column, the tab, the reserved width) stays with the view.
//
// Local harness only: the view never constructs it for a remote harness.

import { invoke as tauriInvoke } from '@tauri-apps/api/core';

import { loadConfig } from '../config';
import { DisposableBag } from '../ui/component';
import type { WorkingDiffStat } from '../window-footer-diff-stat';

import { AcpAssistSession } from './assist/acp-completion';
import { AssistEngine } from './assist/engine';
import type { AssistFailure } from './assist/types';
import { RailsDock } from './components/rails-dock';
import type { RailsTabBadge } from './harness-dock';
import { railsInitPrompt, railsUpdatePrompt } from './harness-prompts';
import type { HarnessRailsHost } from './harness-view-host';
import type { HarnessLane } from './harness-view-types';
import { railsDockActions, type RailsDockAction, type RailsDockActions, type RailsSendMark } from './rails/actions';
import { railsAssistConfig, resolveRailsConfig } from './rails/config';
import { railsEnvelope } from './rails/envelope';
import { RAILS_JUDGE_ID, judgePayload, railsJudge } from './rails/judge';
import { railsDockRows } from './rails/rows';
import { addedLines, selectGlossary, selectRules } from './rails/select';
import {
  autoRunHoldMs,
  computeVerdict,
  diffFingerprint,
  newRunId,
  previousCompletedRun,
  ruleStatuses,
  trackFindings,
} from './rails/track';
import { railsUpdateState } from './rails/update-state';
import type {
  RailsCheckResult,
  RailsConfig,
  RailsDockModel,
  RailsDockSection,
  RailsFinding,
  RailsFooterSignal,
  RailsJudgeState,
  RailsMode,
  RailsProgress,
  RailsRunRecord,
  RailsRunTrigger,
  RailsSnapshot,
  TrackedFinding,
} from './rails/types';
import type { LaneBusEvent, ReviewGitState } from './types';

/** The dock reads at most this many runs, newest first. */
export const RAILS_HISTORY_LIMIT = 20;

/** The warm judge backend is killed after this long without a run. */
export const RAILS_SESSION_IDLE_MS = 10 * 60_000;

export const RAILS_USAGE = 'usage: #rails [now | send | trust | init [<hint>] | update [<request>] | off | manual | auto]';

/** The turn label `#rails update` runs under. Spec 344: a lane carrying it is
 *  running Update, whether it was clicked or typed. */
export const RAILS_UPDATE_LABEL = 'rails update';

const JUDGE_FAILURE_TEXT: Record<AssistFailure, string> = {
  'no-backend': 'judge backend did not start',
  'no-model': 'judge backend rejected the model',
  timeout: 'judge timed out',
  unavailable: 'judge model unavailable',
  invalid: 'judge reply unusable',
};

export type RailsInvoke = <T>(cmd: string, args: Record<string, unknown>) => Promise<T>;

export interface RailsControllerDeps {
  readonly invoke?: RailsInvoke;
  /** Injected (tests): the controller then owns no ACP session. */
  readonly engine?: AssistEngine;
  readonly loadConfig?: () => Promise<unknown>;
  readonly now?: () => number;
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** `rails_history` returns opaque JSON: keep only what the dock can paint. */
function isRunRecord(value: unknown): value is RailsRunRecord {
  if (value === null || typeof value !== 'object') return false;
  const run = value as Partial<RailsRunRecord>;
  return run.version === 1
    && typeof run.runId === 'string'
    && typeof run.finishedAt === 'string'
    && typeof run.verdict === 'string'
    && Array.isArray(run.checks)
    && Array.isArray(run.open)
    && Array.isArray(run.resolved)
    && run.ruleStatus !== null
    && typeof run.ruleStatus === 'object';
}

function sameStat(a: WorkingDiffStat, b: WorkingDiffStat): boolean {
  return a.files === b.files && a.added === b.added && a.removed === b.removed && a.truncated === b.truncated;
}

/** Thrown inside a run when `cancel()` or `dispose()` superseded it. */
class RunCancelled extends Error {}

export class HarnessRailsController {
  /** The `<aside class="acp-harness__rails-dock">` the view places in the dock column. */
  readonly dockEl: HTMLElement;
  /** Mounted by the view's `LayoutHost` into `dock.right`; its root IS `dockEl`. */
  readonly dock: RailsDock;
  private readonly invoke: RailsInvoke;
  private readonly readConfig: () => Promise<unknown>;
  private readonly now: () => number;
  private readonly session: AcpAssistSession | null;
  private readonly engine: AssistEngine;
  private readonly bag = new DisposableBag();
  private readonly unsubscribe: () => void;

  private rawConfig: unknown = null;
  private modeOverride: RailsMode | null = null;
  /** The repo root rails commands run against; resolved from `working_diff_stat`. */
  private root: string | null = null;
  private snapshot: RailsSnapshot | null = null;
  private history: readonly RailsRunRecord[] = [];
  private progress: RailsProgress = { kind: 'idle' };
  private selectedKey: string | null = null;
  private expanded: ReadonlySet<string> = new Set();
  private readonly runPaths = new Map<string, string>();
  /** Spec 344: the newest run's findings went to a lane (send-all). Memory only. */
  private lastSend: RailsSendMark | null = null;

  /** Bumped by `cancel()`: an in-flight run whose token differs is dropped unrecorded. */
  private epoch = 0;
  private running = false;
  private runPromise: Promise<void> = Promise.resolve();
  private loading: Promise<void> = Promise.resolve();
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private armedTrigger: RailsRunTrigger | null = null;
  private sessionTimer: ReturnType<typeof setTimeout> | undefined;
  private lastSignal = '';
  private disposed = false;

  private readonly selectRow = (key: string): void => {
    this.selectedKey = key;
    this.renderDock();
  };

  /** Spec 344: an Actions bar button. It runs its typed `#rails` sub-command in
   *  the active lane, which shows the same spec-343 run chip as typing it. */
  readonly runDockAction = (action: RailsDockAction): void => {
    const lane = this.activeLane();
    if (!lane) {
      if (action === 'now') void this.requestRun(null);
      else if (action === 'trust') void this.trust();
      else this.host.flashChip('no active lane');
      return;
    }
    const text = `#rails ${action}`;
    void this.host.trackCommandRun(lane, text, () => this.runCommand(lane, [action], text));
  };

  constructor(private readonly host: HarnessRailsHost, deps: RailsControllerDeps = {}) {
    this.invoke = deps.invoke ?? (<T>(cmd: string, args: Record<string, unknown>) => tauriInvoke<T>(cmd, args));
    this.readConfig = deps.loadConfig ?? loadConfig;
    this.now = deps.now ?? Date.now;
    if (deps.engine) {
      this.session = null;
      this.engine = deps.engine;
    } else {
      const session = new AcpAssistSession({
        projectDir: () => host.projectDir,
        remoteRuntimeId: () => null,
      });
      this.session = session;
      this.engine = new AssistEngine(session.complete, this.now);
    }
    this.dockEl = document.createElement('aside');
    this.dockEl.className = 'acp-harness__rails-dock';
    this.dockEl.tabIndex = -1;
    this.dockEl.hidden = true;
    this.dockEl.setAttribute('aria-label', 'Rails');
    this.dock = new RailsDock(this.dockEl);
    this.unsubscribe = host.subscribeLaneBus((event: LaneBusEvent) => {
      if (event.type !== 'lane:status') return;
      this.onLaneStatus(event.payload.laneId, event.payload.prev, event.payload.next);
      // Spec 344: the Actions bar follows lane status — the active lane's line
      // and Update's running state. A deps compare when nothing changed.
      this.renderDock();
    });
    this.bag.add(() => {
      this.clearDebounce();
      this.clearSessionTimer();
    });
  }

  /** At mount: snapshot + history, so the dock shows tracking before the first run. */
  mount(): Promise<void> {
    this.loading = this.load();
    return this.loading;
  }

  async reloadConfig(): Promise<void> {
    try {
      this.rawConfig = await this.readConfig();
    } catch {
      this.rawConfig = null;
    }
  }

  mode(): RailsMode {
    return this.modeOverride ?? this.config().mode;
  }

  /** `#rails off | manual | auto`: in memory, like `#assist`. */
  setMode(mode: RailsMode): void {
    this.modeOverride = mode;
    if (mode === 'off') this.cancel();
    else this.engine.clearCooldown(RAILS_JUDGE_ID);
    // spec 339: `manual` also drops an armed or held auto run.
    if (mode === 'manual') {
      this.clearDebounce();
      if (this.progress.kind === 'held') this.progress = { kind: 'idle' };
    }
    this.renderDock();
  }

  /** Resolves once the current run (if any) has settled. Test seam. */
  whenIdle(): Promise<void> {
    return this.runPromise;
  }

  /** `#rails <sub…>`; `text` is the whole typed command (for the `init` hint and the `update` request). */
  async runCommand(lane: HarnessLane, args: readonly string[], text: string): Promise<void> {
    const sub = (args[0] ?? '').toLowerCase();
    const extra = args.length > 1;
    if (sub === '') {
      this.host.showRailsDock();
      return;
    }
    if (sub === 'init') {
      await this.init(lane, text.trim().replace(/^#rails\s+init\b/i, '').trim());
      return;
    }
    if (sub === 'update') {
      await this.update(lane, text.trim().replace(/^#rails\s+update\b/i, '').trim());
      return;
    }
    if (extra) {
      this.host.flashChip(RAILS_USAGE);
      return;
    }
    if (sub === 'now') {
      // spec 343: the command lasts as long as the run it started, so the lane
      // shows `#rails now` until the checks and the judge are done.
      const run = this.requestRun(lane);
      if (run) await run;
      return;
    }
    if (sub === 'send') {
      this.send(lane.id, null);
      return;
    }
    if (sub === 'trust') {
      await this.trust();
      return;
    }
    if (sub === 'off' || sub === 'manual' || sub === 'auto') {
      await this.reloadConfig();
      this.setMode(sub);
      this.host.flashChip(`rails: ${sub}`);
      return;
    }
    this.host.flashChip(RAILS_USAGE);
  }

  /** `#rails now` and `r` in the dock: start at step 3, no fingerprint stop.
   *  Returns the started run (it never rejects), or null when none started. */
  requestRun(lane: HarnessLane | null): Promise<void> | null {
    if (this.disposed) return null;
    if (this.mode() === 'off') {
      this.host.flashChip('rails: off — #rails manual');
      return null;
    }
    if (this.running) {
      this.host.flashChip('rails: a run is already in progress');
      return null;
    }
    this.startRun({ kind: 'manual', laneId: lane?.id ?? null, laneName: lane?.displayName ?? null });
    return this.runPromise;
  }

  /** The dock's keys while it has focus. `[` / `]` belong to the dock column. */
  handleDockKey(event: KeyboardEvent): boolean {
    if (event.metaKey || event.ctrlKey || event.altKey) return false;
    const key = event.key;
    if (key === 'j' || key === 'ArrowDown') this.moveSelection(1);
    else if (key === 'k' || key === 'ArrowUp') this.moveSelection(-1);
    else if (key === 'Enter') this.toggleExpanded();
    else if (key >= '1' && key <= '5' && key.length === 1) this.jumpToSection(Number(key) as RailsDockSection);
    else if (key === 's') this.sendSelected();
    else if (key === 'r') this.runDockAction('now');
    else if (key === 'Escape') this.host.focusComposer();
    else return false;
    event.preventDefault();
    return true;
  }

  /** Availability, badge and (when shown) the dock's paint. */
  renderDock(): void {
    if (this.disposed) return;
    const present = this.snapshot?.present === true;
    this.host.setDockTabAvailable('rails', present && !this.host.isPanelHidden('rails'));
    this.host.setRailsBadge(this.badge());
    if (!this.host.dockTabShown('rails')) return;
    this.dock.update({
      model: this.model(),
      actions: this.actions(),
      onSelectRow: this.selectRow,
      onAction: this.runDockAction,
    });
  }

  /** `#rails off`, a lane-set close, dispose: drop the run unrecorded. */
  cancel(): void {
    this.epoch += 1;
    this.clearDebounce();
    this.engine.cancel();
    if (!this.running) return;
    this.running = false;
    // Only a check holds the per-root lock; killing it while this view judges
    // would kill another harness's check on the same root.
    if (this.root && this.progress.kind === 'checking') {
      void this.invoke<void>('rails_cancel', { root: this.root }).catch(() => undefined);
    }
    // The superseded run's `finally` no longer owns the idle timer.
    this.armSessionTimer();
    this.setProgress({ kind: 'idle' });
  }

  dispose(): void {
    if (this.disposed) return;
    this.cancel();
    this.disposed = true;
    this.unsubscribe();
    this.bag.dispose();
    this.dock.dispose();
    void this.session?.dispose();
    this.host.publishRailsSignal({ state: 'none', findings: 0, failedCheck: null });
  }

  // ─── trigger ────────────────────────────────────────────────────

  private onLaneStatus(laneId: string, prev: string, next: string): void {
    if (this.disposed || prev !== 'busy' || next !== 'idle') return;
    if (this.mode() !== 'auto' || !this.host.projectDir) return;
    const lane = this.host.lanes.find((candidate) => candidate.id === laneId);
    this.arm({ kind: 'auto', laneId, laneName: lane?.displayName ?? null });
  }

  /** Step 1: any later busy → idle re-arms the debounce. */
  private arm(trigger: RailsRunTrigger): void {
    this.clearDebounce();
    this.armedTrigger = trigger;
    this.debounceTimer = setTimeout(() => this.onDebounce(), this.config().debounceMs);
  }

  /**
   * Step 2: a busy lane means "wait for the next transition", which re-arms.
   * Step 2a (spec 339): inside `min_interval_ms` the run is held, not dropped.
   * The hold reuses the debounce timer and trigger, so a later busy → idle
   * replaces it and the next fire recomputes the same window end.
   */
  private onDebounce(): void {
    this.debounceTimer = undefined;
    const trigger = this.armedTrigger;
    this.armedTrigger = null;
    if (this.disposed) return;
    const quiet = this.host.lanes.every((lane) => lane.status !== 'busy' && lane.status !== 'needs_permission');
    if (!trigger || this.running || this.mode() !== 'auto' || !quiet) {
      if (this.progress.kind === 'held') this.setProgress({ kind: 'idle' });
      return;
    }
    const hold = autoRunHoldMs(this.history, this.config().minIntervalMs, this.now());
    if (hold > 0) {
      this.armedTrigger = trigger;
      this.debounceTimer = setTimeout(() => this.onDebounce(), hold);
      this.setProgress({ kind: 'held', until: this.now() + hold });
      return;
    }
    // A cooling judge does not stop the run: `run()` still does the checks
    // and records the judge as skipped by the breaker.
    this.startRun(trigger);
  }

  private clearDebounce(): void {
    clearTimeout(this.debounceTimer);
    this.debounceTimer = undefined;
    this.armedTrigger = null;
  }

  // ─── the run ────────────────────────────────────────────────────

  private startRun(trigger: RailsRunTrigger): void {
    this.running = true;
    // Spec 344: Run shows the run from its first step, before any progress.
    this.renderDock();
    // A run in flight must not lose its warm judge backend to the idle timer.
    this.clearSessionTimer();
    const token = this.epoch;
    this.runPromise = this.run(trigger, token)
      .catch((e: unknown) => {
        if (this.disposed || token !== this.epoch) return;
        // Still our run, killed from outside (`Err("cancelled")`): nothing is recorded.
        this.setProgress(e instanceof RunCancelled ? { kind: 'idle' } : { kind: 'error', message: errorText(e) });
      })
      .finally(() => {
        // A superseded run must not touch the state of the run that replaced it.
        if (token !== this.epoch) return;
        this.running = false;
        this.armSessionTimer();
        this.renderDock();
        this.publish();
      });
  }

  /** Throws `RunCancelled` once `cancel()` has superseded `token`. */
  private live(token: number): void {
    if (this.disposed || token !== this.epoch) throw new RunCancelled();
  }

  private async run(trigger: RailsRunTrigger, token: number): Promise<void> {
    const manual = trigger.kind === 'manual';
    const projectDir = this.host.projectDir;
    if (!projectDir) {
      this.setProgress({ kind: 'error', message: 'no project dir' });
      return;
    }
    await this.loading;
    this.live(token);
    const startedAt = new Date(this.now()).toISOString();

    // 3. Clean-tree probe.
    const before = await this.invoke<WorkingDiffStat>('working_diff_stat', { cwd: projectDir });
    this.live(token);
    const root = before.repoRoot || projectDir;
    this.root = root;
    if (before.files === 0) {
      this.setProgress({ kind: 'clean-tree' });
      return;
    }

    // 4. Manifest and trust.
    const snapshot = await this.invoke<RailsSnapshot>('rails_load', { root });
    this.live(token);
    this.snapshot = snapshot;
    if (!snapshot.present) {
      this.setProgress({ kind: 'idle' });
      return;
    }
    if (snapshot.error !== null) {
      this.setProgress({ kind: 'error', message: snapshot.error });
      return;
    }
    const trusted = snapshot.trust === 'trusted';
    if (!trusted && !manual) {
      this.setProgress({ kind: 'paused' });
      return;
    }

    // 5. Subject and fingerprint.
    // `untrackedAll`: every untracked file is a changed path, not just the first few heads.
    const git = await this.invoke<ReviewGitState>('acp_collect_review_git_state', { cwd: projectDir, untrackedAll: true });
    this.live(token);
    const fingerprint = await diffFingerprint(git);
    this.live(token);
    const last = previousCompletedRun(this.history);
    // A judge-only run on this tree never ran the checks a trusted manifest now allows.
    const checksPending = trusted && last?.checksSkipped === true;
    if (!manual && !checksPending && last?.fingerprint === fingerprint) {
      this.setProgress({ kind: 'idle' });
      return;
    }

    // 6. Check step (skipped without trust: a manual run is then judge-only).
    const checks: RailsCheckResult[] = [];
    if (trusted) {
      for (const [index, decl] of snapshot.checks.entries()) {
        this.setProgress({ kind: 'checking', index: index + 1, total: snapshot.checks.length, name: decl.name });
        let result: RailsCheckResult;
        try {
          result = await this.invoke<RailsCheckResult>('rails_run_check', { root, name: decl.name });
        } catch (e) {
          this.live(token);
          const message = errorText(e);
          // `rails_cancel` killed it (another view's `#rails off`, or ours racing): no record.
          if (message === 'cancelled') throw new RunCancelled();
          if (message === 'busy') {
            this.setProgress({ kind: 'busy' });
            return;
          }
          if (message === 'untrusted') {
            this.setProgress({ kind: 'paused' });
            return;
          }
          result = { name: decl.name, outcome: 'error', exitCode: null, durationMs: 0, outputTail: message };
        }
        this.live(token);
        checks.push(result);
      }
    }

    // 7. Judge step, skipped when nothing applies.
    const cfg = railsAssistConfig(this.config());
    const changed = git.diffstat.map((row) => row.path);
    const rules = selectRules(snapshot.rules, changed);
    const added = [...addedLines(git.diff), ...git.untracked.flatMap((file) => file.head.split('\n'))];
    const glossary = selectGlossary(snapshot.glossary, added);
    const ctx = {
      rules,
      glossary,
      diffstat: git.diffstat,
      diff: git.diff,
      untracked: git.untracked,
      failedChecks: checks.filter((check) => check.outcome === 'fail' || check.outcome === 'timeout'),
    };
    let judge: RailsJudgeState = 'skipped';
    let judgeFailure: AssistFailure | null = null;
    let findings: readonly RailsFinding[] = [];
    let dropped = 0;
    let rulesTruncated: RailsRunRecord['rulesTruncated'] = null;
    let judgeError: string | null = null;
    let selectedRuleIds: ReadonlySet<string> = new Set<string>();
    if (rules.length > 0 || glossary.length > 0) {
      const built = judgePayload(ctx, { maxInputChars: cfg.maxInputChars, timeoutMs: cfg.timeoutMs });
      if (built.rulesKept < rules.length) rulesTruncated = { kept: built.rulesKept, total: rules.length };
      // Exactly what the judge saw: a rule cut by the budget was not re-checked.
      selectedRuleIds = built.sentIds;
      if (this.engine.cooldownUntil(RAILS_JUDGE_ID) > this.now()) {
        judge = 'failed';
        judgeError = 'judge cooling down';
      } else {
        this.setProgress({ kind: 'judging' });
        const result = await this.engine.run(railsJudge, ctx, cfg);
        this.live(token);
        if (result.ok) {
          judge = 'ran';
          findings = result.value.findings;
          dropped = result.value.dropped;
        } else {
          judge = 'failed';
          judgeFailure = result.reason;
          judgeError = JUDGE_FAILURE_TEXT[result.reason];
        }
      }
    }

    // 8. Stale re-probe.
    const after = await this.invoke<WorkingDiffStat>('working_diff_stat', { cwd: projectDir });
    this.live(token);
    const stale = !sameStat(before, after);

    // 9. Verdict and tracking against the run BEFORE this one is written.
    const previous = previousCompletedRun(this.history);
    const finishedAt = new Date(this.now()).toISOString();
    const runId = newRunId(new Date(this.now()));
    const judged = judge === 'ran';
    const knownIds = new Set([...snapshot.rules.map((rule) => rule.id), ...snapshot.glossary.map((entry) => entry.id)]);
    const tracked = trackFindings({ previous, findings, selectedRuleIds, knownIds, judged, runId, finishedAt });
    const unstartable = checks.find((check) => check.outcome === 'error');
    const error = unstartable ? `check ${unstartable.name} could not start` : judgeError;
    const record: RailsRunRecord = {
      version: 1,
      runId,
      startedAt,
      finishedAt,
      trigger,
      fingerprint,
      verdict: computeVerdict({ checks, findings, judge, error }),
      stale,
      checks,
      checksSkipped: !trusted,
      judge,
      judgeFailure,
      open: tracked.open,
      resolved: tracked.resolved,
      dropped,
      rulesTruncated,
      ruleStatus: ruleStatuses({ rules: snapshot.rules, selectedRuleIds, findings, checks, judged }),
      error,
    };
    const path = await this.invoke<string>('rails_record_run', { root, run: record });
    this.live(token);
    this.runPaths.set(runId, path);
    this.history = await this.readHistory(root, record);
    this.live(token);
    const cooling = this.engine.cooldownUntil(RAILS_JUDGE_ID);
    this.setProgress(cooling > this.now() ? { kind: 'cooling', until: cooling } : { kind: 'idle' });
    // Step 1 re-arms: the tree moved under the run, so the next quiet point
    // re-runs it — automatically, whatever started this one.
    if (stale && this.mode() === 'auto') this.arm({ kind: 'auto', laneId: trigger.laneId, laneName: trigger.laneName });
  }

  /** Newest first, ≤ 20. A failed read keeps the local list with the new run on top. */
  private async readHistory(root: string, written: RailsRunRecord): Promise<readonly RailsRunRecord[]> {
    try {
      const runs = await this.invoke<unknown[]>('rails_history', { root, limit: RAILS_HISTORY_LIMIT });
      return runs.filter(isRunRecord).slice(0, RAILS_HISTORY_LIMIT);
    } catch {
      return [written, ...this.history.filter((run) => run.runId !== written.runId)].slice(0, RAILS_HISTORY_LIMIT);
    }
  }

  // ─── mount, trust, init, send ───────────────────────────────────

  private async load(): Promise<void> {
    await this.reloadConfig();
    const root = await this.resolveRoot();
    if (!root || this.disposed) return;
    try {
      this.snapshot = await this.invoke<RailsSnapshot>('rails_load', { root });
      if (this.snapshot.error !== null) this.progress = { kind: 'error', message: this.snapshot.error };
      else if (this.snapshot.present && this.snapshot.trust !== 'trusted' && this.mode() === 'auto') {
        this.progress = { kind: 'paused' };
      }
    } catch (e) {
      this.progress = { kind: 'error', message: errorText(e) };
    }
    if (this.snapshot?.present) {
      try {
        const runs = await this.invoke<unknown[]>('rails_history', { root, limit: RAILS_HISTORY_LIMIT });
        this.history = runs.filter(isRunRecord).slice(0, RAILS_HISTORY_LIMIT);
      } catch {
        this.history = [];
      }
    }
    if (this.disposed) return;
    this.renderDock();
    this.publish();
  }

  private async resolveRoot(): Promise<string | null> {
    if (this.root) return this.root;
    const projectDir = this.host.projectDir;
    if (!projectDir) return null;
    try {
      const stat = await this.invoke<WorkingDiffStat>('working_diff_stat', { cwd: projectDir });
      this.root = stat.repoRoot || projectDir;
    } catch {
      this.root = projectDir;
    }
    return this.root;
  }

  private async trust(): Promise<void> {
    const root = await this.resolveRoot();
    if (!root) {
      this.host.flashChip('#rails: no project dir');
      return;
    }
    try {
      this.snapshot = await this.invoke<RailsSnapshot>('rails_trust', { root });
    } catch (e) {
      this.host.flashChip(`rails trust failed: ${errorText(e)}`);
      return;
    }
    if (this.progress.kind === 'paused') this.progress = { kind: 'idle' };
    this.host.flashChip(`rails: trusted ${this.snapshot.checks.length} checks`);
    this.renderDock();
    this.publish();
  }

  private async init(lane: HarnessLane, hint: string): Promise<void> {
    if (lane.status !== 'idle' && lane.status !== 'awaiting_peer') {
      this.host.flashChip('lane busy - #cancel first');
      return;
    }
    await this.host.enqueueSystemPrompt(lane, railsInitPrompt(hint), undefined, 'rails init');
  }

  /** spec 338: a fresh snapshot plus the newest runs, and the human's request, to the typed lane. */
  private async update(lane: HarnessLane, request: string): Promise<void> {
    if (lane.status !== 'idle' && lane.status !== 'awaiting_peer') {
      this.host.flashChip('lane busy - #cancel first');
      return;
    }
    const root = await this.resolveRoot();
    if (!root) {
      this.host.flashChip('#rails: no project dir');
      return;
    }
    // Feeds only the prompt: a run in flight keeps the snapshot it loaded.
    let snapshot: RailsSnapshot;
    try {
      snapshot = await this.invoke<RailsSnapshot>('rails_load', { root });
    } catch (e) {
      this.host.flashChip(`rails update failed: ${errorText(e)}`);
      return;
    }
    if (this.disposed) return;
    // A manifest error does not stop: a broken manifest is a reason to update.
    if (!snapshot.present) {
      this.host.flashChip('rails: no .krypton/rails.toml — #rails init');
      return;
    }
    const latest = this.history[0];
    const state = railsUpdateState(snapshot, this.history, latest ? this.runPath(latest) : null);
    await this.host.enqueueSystemPrompt(lane, railsUpdatePrompt(request, state), undefined, RAILS_UPDATE_LABEL);
  }

  /** `only` null: every open finding of the newest run. */
  private send(laneId: string, only: TrackedFinding | null): void {
    const latest = this.history[0];
    if (!latest || latest.open.length === 0) {
      this.host.flashChip('rails: no open findings');
      return;
    }
    this.host.injectEnvelope(laneId, railsEnvelope(latest, this.runPath(latest), only ?? undefined));
    const name = this.host.lanes.find((lane) => lane.id === laneId)?.displayName ?? laneId;
    const count = only ? 1 : latest.open.length;
    this.host.flashChip(`rails: sent ${count} finding${count === 1 ? '' : 's'} → ${name}`);
    if (!only) {
      this.lastSend = { runId: latest.runId, laneName: name, count, at: this.now() };
      this.renderDock();
    }
  }

  private sendSelected(): void {
    const row = railsDockRows(this.model()).find((candidate) => candidate.key === this.selectedKey);
    if (row?.kind === 'finding') this.send(this.host.activeLaneId, row.finding);
    else if (row?.kind === 'head') this.send(this.host.activeLaneId, null);
    else this.host.flashChip('rails: select a finding, or the head row to send all');
  }

  private runPath(run: RailsRunRecord): string {
    return this.runPaths.get(run.runId) ?? `${this.root ?? this.host.projectDir ?? ''}/.krypton/rails/runs/${run.runId}.json`;
  }

  // ─── dock model ─────────────────────────────────────────────────

  private model(): RailsDockModel {
    return {
      snapshot: this.snapshot,
      mode: this.mode(),
      progress: this.progress,
      history: this.history,
      selectedKey: this.selectedKey,
      expanded: this.expanded,
    };
  }

  private actions(): RailsDockActions {
    const lane = this.activeLane();
    return railsDockActions({
      snapshot: this.snapshot,
      mode: this.mode(),
      progress: this.progress,
      running: this.running,
      latest: this.history[0] ?? null,
      lastSend: this.lastSend,
      activeLane: lane ? { displayName: lane.displayName, status: lane.status, hasClient: lane.client !== null } : null,
      updateLane: this.host.lanes.find((candidate) => candidate.activeSystemLabel === RAILS_UPDATE_LABEL)?.displayName ?? null,
      now: this.now(),
    });
  }

  private activeLane(): HarnessLane | null {
    return this.host.lanes.find((lane) => lane.id === this.host.activeLaneId) ?? null;
  }

  private moveSelection(delta: 1 | -1): void {
    const rows = railsDockRows(this.model());
    if (rows.length === 0) return;
    const at = rows.findIndex((row) => row.key === this.selectedKey);
    const next = at === -1 ? 0 : Math.min(rows.length - 1, Math.max(0, at + delta));
    this.selectRow(rows[next].key);
  }

  private toggleExpanded(): void {
    const key = this.selectedKey;
    if (key === null) return;
    const next = new Set(this.expanded);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    this.expanded = next;
    this.renderDock();
  }

  private jumpToSection(section: RailsDockSection): void {
    const row = railsDockRows(this.model()).find((candidate) => candidate.section === section);
    if (row) this.selectRow(row.key);
  }

  private badge(): RailsTabBadge {
    const latest = this.history[0];
    if (!latest) return { failedCheck: null, open: null };
    const failed = latest.checks.find((check) => check.outcome === 'fail' || check.outcome === 'timeout');
    return { failedCheck: failed?.name ?? null, open: latest.open.length };
  }

  private setProgress(progress: RailsProgress): void {
    this.progress = progress;
    this.renderDock();
    this.publish();
  }

  // ─── footer ─────────────────────────────────────────────────────

  private footerSignal(): Omit<RailsFooterSignal, 'sourceId'> {
    const none = { state: 'none', findings: 0, failedCheck: null } as const;
    if (this.disposed || this.snapshot?.present !== true) return none;
    const latest = this.history[0] ?? null;
    const findings = latest?.open.length ?? 0;
    const kind = this.progress.kind;
    if (kind === 'checking' || kind === 'judging') return { state: 'running', findings, failedCheck: null };
    if (kind === 'paused') return { state: 'paused', findings, failedCheck: null };
    if (kind === 'error') return { state: 'error', findings, failedCheck: null };
    if (!latest) {
      return this.snapshot.trust === 'trusted' ? none : { state: 'paused', findings: 0, failedCheck: null };
    }
    if (latest.verdict === 'check_failed') {
      const failed = latest.checks.find((check) => check.outcome === 'fail' || check.outcome === 'timeout');
      return { state: 'check_failed', findings, failedCheck: failed?.name ?? null };
    }
    return { state: latest.verdict, findings, failedCheck: null };
  }

  private publish(): void {
    if (this.disposed) return;
    const signal = this.footerSignal();
    const key = JSON.stringify(signal);
    if (key === this.lastSignal) return;
    this.lastSignal = key;
    this.host.publishRailsSignal(signal);
  }

  // ─── internals ──────────────────────────────────────────────────

  private config(): RailsConfig {
    return resolveRailsConfig(this.rawConfig);
  }

  /** The warm judge backend outlives runs, not ten idle minutes. */
  private armSessionTimer(): void {
    if (!this.session || this.disposed) return;
    this.clearSessionTimer();
    const session = this.session;
    this.sessionTimer = setTimeout(() => {
      this.sessionTimer = undefined;
      void session.dispose();
    }, RAILS_SESSION_IDLE_MS);
  }

  private clearSessionTimer(): void {
    clearTimeout(this.sessionTimer);
    this.sessionTimer = undefined;
  }
}
