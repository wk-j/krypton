// Spec 306 — the assist sidecar's lane-facing half.
//
// The controller owns nothing about prompts: it decides WHEN a registered
// `AssistTask` may run against a lane, builds the task-agnostic `AssistContext`
// out of lane state, and publishes the result. The model call, its deadline
// and the breaker all live in `AssistEngine` (`assist/engine.ts`); what to ask
// lives in the task.
//
// Spec 275 shape: a plain class over a narrow host interface, no base class and
// no registry of its own. It never touches the DOM — a panel result is
// published by dirtying a region; a spec 323 follow-up result is written onto
// the reply it belongs to and the view patches that one row.

import { loadConfig } from '../config';

import { AcpAssistSession } from './assist/acp-completion';
import { resolveAssistConfig } from './assist/config';
import { AssistEngine } from './assist/engine';
import { ASSIST_TASKS, assistTask } from './assist/registry';
import type {
  AssistContext,
  AssistFailure,
  AssistMode,
  AssistPanelState,
  AssistTaskConfig,
  PanelAssistTask,
  RegisteredAssistTask,
  TranscriptAssistTask,
} from './assist/types';
import { followUpReply } from './assist/tasks/follow-up';
import { userText } from './assist/tasks/grammar';
import type { HarnessAssistHost } from './harness-view-host';
import type { HarnessLane, HarnessTranscriptItem } from './harness-view-types';
import type { StopReason } from './types';

/** The shortest assistant reply worth post-processing. */
const MIN_ASSISTANT_CHARS = 40;

/** A clean review stays on screen this long, then the panel leaves the rail. */
export const ASSIST_PANEL_OK_HIDE_MS = 4_000;

/** What started a run: the gates and the empty-result feedback differ. */
type AssistTrigger = 'turn-end' | 'user-prompt' | 'manual';

const FAILURE_TEXT: Record<AssistFailure, string> = {
  'no-backend': 'assist: backend did not start',
  'no-model': 'assist: backend rejected the model',
  timeout: 'assist: timed out',
  unavailable: 'assist: model unavailable',
  invalid: 'assist: unusable reply',
};

/** The items of the turn that just ended: the last user row and everything after it. */
function turnItems(lane: HarnessLane): readonly HarnessTranscriptItem[] {
  const transcript = lane.transcript;
  for (let i = transcript.length - 1; i >= 0; i -= 1) {
    if (transcript[i].kind === 'user') return transcript.slice(i);
  }
  return transcript.slice(-12);
}

export class HarnessAssistController {
  /** Per lane: the lane turn each task last ran for, so one turn yields one call. */
  private readonly turnSeqs = new Map<string, Map<string, number>>();
  /** Per lane: the `panel` task's review, painted in the right rail. */
  private readonly panels = new Map<string, AssistPanelState>();
  private readonly panelHideTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly modeOverrides = new Map<string, AssistMode>();
  /** Raw `get_config` blob; the tasks' config is resolved out of it per run. */
  private rawConfig: unknown = null;
  /** Bumped only by `cancel()` — a lane switch, respawn, close or dispose.
   *  A run captures it when it is queued, so a cancel also drops work that has
   *  not started yet; superseding is the engine's single-flight job, not this. */
  private epoch = 0;
  private queue: Promise<void> = Promise.resolve();
  private disposed = false;

  /** Null when the caller injected an engine (tests): no subprocess is owned. */
  private readonly session: AcpAssistSession | null;
  private readonly engine: AssistEngine;

  constructor(
    private readonly host: HarnessAssistHost,
    private readonly tasks: readonly RegisteredAssistTask[] = ASSIST_TASKS,
    engine: AssistEngine | null = null,
  ) {
    if (engine) {
      this.session = null;
      this.engine = engine;
    } else {
      const session = new AcpAssistSession({
        projectDir: () => host.projectDir,
        remoteRuntimeId: () => host.remoteRuntimeId,
      });
      this.session = session;
      this.engine = new AssistEngine(session.complete);
    }
    void this.reloadConfig();
  }

  async reloadConfig(): Promise<void> {
    try {
      this.rawConfig = await loadConfig();
    } catch {
      this.rawConfig = null;
    }
  }

  /** Spec 306 gate 1–10, minus the task's own gate, which `run` applies. */
  onTurnEnd(lane: HarnessLane, stopReason: StopReason): void {
    if (this.disposed) return;
    for (const task of this.tasks) {
      if (!task.onTurnEnd) continue;
      const cfg = this.configFor(task);
      if (cfg.mode !== 'auto') continue;
      if (stopReason !== 'end_turn') continue;
      if (this.ranThisTurn(lane, task.id)) continue;
      this.enqueue(lane, task, cfg, 'turn-end');
    }
  }

  /** The human just sent a prompt on `lane`: run every `onUserPrompt` task in `auto`. */
  onUserPrompt(lane: HarnessLane): void {
    if (this.disposed) return;
    for (const task of this.tasks) {
      if (!task.onUserPrompt) continue;
      const cfg = this.configFor(task);
      if (cfg.mode !== 'auto') continue;
      this.enqueue(lane, task, cfg, 'user-prompt');
    }
  }

  /** `Cmd+/` and `#assist [task] now`: re-ask even on the same turn. */
  request(lane: HarnessLane, taskId?: string): void {
    if (this.disposed) return;
    const task = taskId ? assistTask(taskId) : this.tasks[0];
    if (!task) {
      this.host.flashChip(`assist: unknown task ${taskId ?? ''}`.trim());
      return;
    }
    const cfg = this.configFor(task);
    if (cfg.mode === 'off') {
      this.host.flashChip(`assist: ${task.id} is off — #assist ${task.id} manual`);
      return;
    }
    this.enqueue(lane, task, cfg, 'manual');
  }

  /** The right-rail review for `lane`; `idle` means the panel is not mounted. */
  panelState(laneId: string): AssistPanelState {
    return this.panels.get(laneId) ?? { kind: 'idle' };
  }

  /** `Cmd+G`: load the corrected prompt into an empty draft. True when consumed. */
  acceptCorrection(lane: HarnessLane): boolean {
    const state = this.panelState(lane.id);
    if (state.kind !== 'ready' || state.check.corrected === null) return false;
    if (lane.draft.trim() !== '') {
      this.host.flashChip('assist: clear the draft first');
      return true;
    }
    const text = state.check.corrected;
    this.setPanel(lane.id, { kind: 'idle' });
    this.host.setDraft(lane, text, text.length);
    return true;
  }

  /** `Cmd+0`: close the review panel. */
  dismissPanel(lane: HarnessLane): boolean {
    const state = this.panelState(lane.id);
    if (state.kind === 'idle') return false;
    if (state.kind === 'pending') this.cancel();
    this.setPanel(lane.id, { kind: 'idle' });
    return true;
  }

  /** Resolves once every enqueued run has settled. Test seam. */
  whenIdle(): Promise<void> {
    return this.queue;
  }

  /** `#assist [task] off|manual|auto`. A null id sets every registered task. */
  setMode(taskId: string | null, mode: AssistMode): void {
    for (const task of this.tasks) {
      if (taskId !== null && task.id !== taskId) continue;
      this.modeOverrides.set(task.id, mode);
      if (mode !== 'off') this.engine.clearCooldown(task.id);
    }
  }

  /** One line per registered task, for bare `#assist`. */
  describe(): string[] {
    return this.tasks.map((task) => {
      const cfg = this.configFor(task);
      const cooldown = this.engine.cooldownUntil(task.id);
      const paused = cooldown > Date.now()
        ? ` · paused ${Math.ceil((cooldown - Date.now()) / 60_000)}m`
        : '';
      return `#assist ${task.id} · ${cfg.mode}${paused} — ${task.summary}`;
    });
  }

  taskIds(): string[] {
    return this.tasks.map((task) => task.id);
  }

  /** A lane switch invalidates an in-flight answer: it was about another lane. */
  cancel(): void {
    this.epoch += 1;
    this.engine.cancel();
  }

  resetLane(laneId: string): void {
    this.turnSeqs.delete(laneId);
    this.clearPanelTimer(laneId);
    this.panels.delete(laneId);
    this.cancel();
  }

  onLaneGone(lane: HarnessLane): void {
    this.resetLane(lane.id);
  }

  dispose(): void {
    this.disposed = true;
    this.cancel();
    this.turnSeqs.clear();
    for (const laneId of [...this.panelHideTimers.keys()]) this.clearPanelTimer(laneId);
    this.panels.clear();
    // The warm backend outlives individual turns, never the view.
    void this.session?.dispose();
  }

  // ─── internals ──────────────────────────────────────────────────

  private configFor(task: RegisteredAssistTask): AssistTaskConfig {
    const cfg = resolveAssistConfig(this.rawConfig, task);
    const override = this.modeOverrides.get(task.id);
    return override ? { ...cfg, mode: override } : cfg;
  }

  private setPanel(laneId: string, state: AssistPanelState): void {
    this.clearPanelTimer(laneId);
    if (state.kind === 'idle') this.panels.delete(laneId);
    else this.panels.set(laneId, state);
    this.host.invalidate('rightRail');
  }

  private clearPanelTimer(laneId: string): void {
    const timer = this.panelHideTimers.get(laneId);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.panelHideTimers.delete(laneId);
  }

  private ranThisTurn(lane: HarnessLane, taskId: string): boolean {
    return this.turnSeqs.get(lane.id)?.get(taskId) === lane.turnSeq;
  }

  private markRan(lane: HarnessLane, taskId: string): void {
    const seqs = this.turnSeqs.get(lane.id);
    if (seqs) seqs.set(taskId, lane.turnSeq);
    else this.turnSeqs.set(lane.id, new Map([[taskId, lane.turnSeq]]));
  }

  /** Gates that do not depend on the trigger, evaluated as late as possible.
   *  `snapshot` is the turn captured at enqueue (spec 323), else read now. */
  private eligible(
    lane: HarnessLane,
    task: RegisteredAssistTask,
    cfg: AssistTaskConfig,
    trigger: AssistTrigger,
    snapshot: readonly HarnessTranscriptItem[] | null,
  ): AssistContext | null {
    if (this.disposed) return null;
    if (lane.id !== this.host.activeLaneId) return null;
    // spec 323: a remote harness's commands and `localhost` are the remote's.
    if (task.surface === 'transcript' && this.host.remoteRuntimeId !== null) return null;
    if (lane.pendingPermissions.length > 0 || lane.pendingQuestions.length > 0) return null;
    if (trigger !== 'user-prompt' && lane.activeSystemLabel !== null) return null;
    if (this.engine.cooldownUntil(task.id) > Date.now()) return null;
    const turn = snapshot ?? turnItems(lane);
    // A prompt-reading task runs before (or without) any reply.
    const readsPrompt = trigger === 'user-prompt' || (trigger === 'manual' && task.onUserPrompt === true);
    if (!readsPrompt) {
      const assistantChars = turn
        .filter((item) => item.kind === 'assistant')
        .reduce((sum, item) => sum + item.text.length, 0);
      if (assistantChars < MIN_ASSISTANT_CHARS) return null;
    }
    const ctx: AssistContext = {
      laneId: lane.id,
      laneName: lane.displayName,
      backendId: lane.backendId,
      modelName: lane.currentModelId ?? lane.modelName,
      projectDir: this.host.projectDir,
      turn,
    };
    if (task.eligible?.(ctx, cfg) === false) return null;
    return ctx;
  }

  /**
   * Tasks run one at a time, in registry order: the engine is single-flight by
   * construction, so a parallel fan-out would only cancel itself.
   */
  private enqueue(
    lane: HarnessLane,
    task: RegisteredAssistTask,
    cfg: AssistTaskConfig,
    trigger: AssistTrigger,
  ): void {
    const epoch = this.epoch;
    // spec 323: follow-ups belong to the reply that just ended. Read later, the
    // turn would be the next prompt's if the human sent one while queued.
    const snapshot = task.surface === 'transcript' ? turnItems(lane) : null;
    this.queue = this.queue
      .then(() => this.run(lane, task, cfg, epoch, trigger, snapshot))
      .catch(() => undefined);
  }

  private async run(
    lane: HarnessLane,
    task: RegisteredAssistTask,
    cfg: AssistTaskConfig,
    epoch: number,
    trigger: AssistTrigger,
    snapshot: readonly HarnessTranscriptItem[] | null,
  ): Promise<void> {
    if (epoch !== this.epoch) return;
    const ctx = this.eligible(lane, task, cfg, trigger, snapshot);
    if (!ctx && trigger === 'manual' && task.onUserPrompt) {
      this.host.flashChip(`assist: nothing for ${task.id} to check`);
    }
    if (!ctx) return;
    this.markRan(lane, task.id);
    if (task.surface === 'panel') await this.runPanel(lane, task, ctx, cfg, epoch);
    else await this.runTranscript(lane, task, ctx, cfg, epoch);
  }

  private isStale(lane: HarnessLane, epoch: number, spawnEpoch: number): boolean {
    return this.disposed
      || epoch !== this.epoch
      || lane.spawnEpoch !== spawnEpoch
      || lane.id !== this.host.activeLaneId;
  }

  private async runPanel(
    lane: HarnessLane,
    task: PanelAssistTask,
    ctx: AssistContext,
    cfg: AssistTaskConfig,
    epoch: number,
  ): Promise<void> {
    const spawnEpoch = lane.spawnEpoch;
    const original = userText(ctx);
    const pending: AssistPanelState = { kind: 'pending', taskId: task.id, original };
    this.setPanel(lane.id, pending);

    const run = await this.engine.run(task, ctx, cfg);
    if (this.isStale(lane, epoch, spawnEpoch)) {
      // A dropped answer must not leave the panel spinning forever.
      if (!this.disposed && this.panels.get(lane.id) === pending) this.setPanel(lane.id, { kind: 'idle' });
      return;
    }
    if (!run.ok) {
      this.setPanel(lane.id, { kind: 'idle' });
      this.host.flashChip(FAILURE_TEXT[run.reason]);
      return;
    }
    this.setPanel(lane.id, { kind: 'ready', taskId: task.id, original, check: run.value });
    if (run.value.corrected === null) {
      // Nothing to fix: confirm briefly, then give the rail back.
      this.panelHideTimers.set(lane.id, setTimeout(() => {
        this.panelHideTimers.delete(lane.id);
        this.setPanel(lane.id, { kind: 'idle' });
      }, ASSIST_PANEL_OK_HIDE_MS));
    }
  }

  /**
   * Spec 323: the result belongs to the reply the candidates came from, so it
   * lands under that row even if the human has sent the next prompt since.
   * Nothing is painted while pending — a sealed row shows no live placeholder.
   */
  private async runTranscript(
    lane: HarnessLane,
    task: TranscriptAssistTask,
    ctx: AssistContext,
    cfg: AssistTaskConfig,
    epoch: number,
  ): Promise<void> {
    const owner = followUpReply(ctx);
    if (!owner) return;
    const spawnEpoch = lane.spawnEpoch;

    const run = await this.engine.run(task, ctx, cfg);
    if (this.isStale(lane, epoch, spawnEpoch) || !lane.transcript.includes(owner)) return;
    if (!run.ok) {
      this.host.flashChip(FAILURE_TEXT[run.reason]);
      return;
    }
    owner.followUps = run.value.length > 0 ? run.value : undefined;
    this.host.patchFollowUps(lane, owner.id);
  }
}
