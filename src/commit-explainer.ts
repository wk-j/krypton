// Spec 376 — Commit explainer background jobs.
//
// The Commit Browser's `e` queues a job here instead of borrowing a Harness
// lane. Each job runs on its own ACP process (`[knowledge] backend`, codex by
// default) whose working directory is a fresh scratch dir from
// `knowledge_job_prepare`. The session is forced into `[knowledge] mode`
// (codex `workspace-write`: the OS sandbox lets it write only the scratch dir,
// `$TMPDIR` and `/tmp`, with no network) and every approval request is
// declined, so a job can do only what that sandbox allows without asking. The
// agent writes `explainer.md` in the scratch dir; after `end_turn`,
// `knowledge_store` copies it into the knowledge dir. Up to `parallel` jobs run
// at once, the rest queue FIFO. Jobs live as long as the app, not the browser.
//
// Progress (spec 377): the fence records each tool call as a step (the last
// `EXPLAIN_STEPS_KEPT`, plus a count) and the thought / message chunks as the
// phase between tools. The Commit Browser's explainer strip paints them.

import { invoke as tauriInvoke } from '@tauri-apps/api/core';

import { AcpClient } from './acp/client';
import { loadHomeDir, truncate } from './acp/harness-format';
import { answerFencedRequest } from './acp/headless-fence';
import { learnCommitPrompt } from './acp/harness-prompts';
import { mergeToolCall, toolChipKind, toolSubject } from './acp/harness-tool-render';
import type {
  AcpEvent, AcpInstanceOwner, AgentSessionInfo, StopReason, ToolCall, ToolCallUpdate, ToolStatus,
} from './acp/types';
import { loadConfig, type KnowledgeConfig } from './config';

export type ExplainState = 'queued' | 'running';
/** What a running job does between tools. */
export type ExplainPhase = 'starting' | 'thinking' | 'replying' | 'continuing';
export type ExplainStepState = 'running' | 'done' | 'failed';

/** One tool call of a running job, as the explainer strip shows it. */
export interface ExplainStep {
  readonly id: string;
  /** `toolChipKind`: read · edit · search · execute · fetch · move · delete · other. */
  readonly kind: string;
  /** Command, path or title: its first line, shortened by `jobSubject`, case kept. */
  readonly subject: string;
  readonly state: ExplainStepState;
}

export interface ExplainJob {
  readonly root: string;
  readonly repoName: string;
  readonly sha: string;
  state: ExplainState;
  /** Epoch ms the job started running; null while queued. */
  startedAt: number | null;
  /** Backend and model of a running job (from the config read at its start). */
  backend: string | null;
  model: string | null;
  /** What the agent does between tools; null while queued. */
  phase: ExplainPhase | null;
  /** The last `EXPLAIN_STEPS_KEPT` tool calls, oldest first. Replaced on change, never mutated. */
  steps: readonly ExplainStep[];
  /** Every tool call since the job started. */
  stepCount: number;
  /** Continuation turns sent after a declined approval. */
  continuations: number;
}

export type ExplainChange =
  | { kind: 'update'; job: ExplainJob }
  | { kind: 'ready'; job: ExplainJob; path: string }
  | { kind: 'failed'; job: ExplainJob; message: string }
  | { kind: 'cancelled'; job: ExplainJob };

/** What `knowledge_job_prepare` returns. */
export interface KnowledgeJob {
  scratch: string;
  draft: string;
  path: string;
  repo: string;
}

/** `[knowledge]` with every job field resolved. */
export interface ExplainConfig {
  backend: string;
  model: string;
  mode: string;
  parallel: number;
}

export type ExplainSpawn = (backendId: string, cwd: string, owner: AcpInstanceOwner) => Promise<AcpClient>;
export type ExplainInvoke = <T>(cmd: string, args: Record<string, unknown>) => Promise<T>;

export interface CommitExplainerDeps {
  config?: () => Promise<Partial<KnowledgeConfig> | undefined>;
  invoke?: ExplainInvoke;
  spawn?: ExplainSpawn;
  home?: () => Promise<string | null>;
  now?: () => number;
  graceMs?: number;
}

/** The dirs a job's step subjects are shortened against. */
export interface JobPlaces {
  root: string;
  scratch: string;
  home: string | null;
}

/** How long a cancelled turn may take to honour `session/cancel` before its
 *  process is disposed anyway. */
export const EXPLAIN_CANCEL_GRACE_MS = 5_000;
export const EXPLAIN_MAX_PARALLEL = 4;
/** Follow-up turns after a declined approval ended the turn, before the job fails. */
export const EXPLAIN_MAX_CONTINUATIONS = 3;
/** Steps a job keeps for the strip: the now line and the three before it. */
export const EXPLAIN_STEPS_KEPT = 4;
const SUBJECT_MAX = 200;

/** Sent after a declined approval stopped the turn: codex offers no "decline
 *  and go on" for a sandbox escalation, only `cancel`, which ends the turn. */
export const DECLINED_CONTINUE_PROMPT =
  'Your last action needed approval and was declined: nobody can approve anything in this ' +
  'background run. Do not retry it or anything else outside your sandbox; continue the task ' +
  'within it and finish writing the document.';

const ABANDONED = Symbol('abandoned');

interface RunHandle {
  client: AcpClient | null;
  cancelled: boolean;
  /** The agent asked a question, which the fence answers by cancelling the turn. */
  asked: boolean;
  /** The fence declined an approval since the current turn started. */
  declined: boolean;
  /** Set once the scratch dir exists; tool calls are recorded only after. */
  places: JobPlaces | null;
  /** The merged tool call behind each kept step, by toolCallId. */
  calls: Map<string, ToolCall | ToolCallUpdate>;
  abandoned: Promise<typeof ABANDONED>;
  abandon: () => void;
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function key(root: string, sha: string): string {
  return `${root}\u0000${sha}`;
}

function stepState(status: ToolStatus | undefined): ExplainStepState {
  if (status === 'completed') return 'done';
  if (status === 'failed') return 'failed';
  return 'running';
}

function under(dir: string, path: string): string | null {
  const base = dir.replace(/\/+$/, '');
  return base && path.startsWith(`${base}/`) ? path.slice(base.length + 1) : null;
}

/** A step subject for display: its first line; a path in the scratch dir or
 *  the repo becomes relative to it, and HOME becomes `~` in anything else.
 *  Case is kept: paths are case-sensitive. */
export function jobSubject(text: string, places: JobPlaces): string {
  const line = (text.split('\n', 1)[0] ?? '').trim();
  // macOS reports the temp dir as /var/… and by its real path /private/var/….
  const relative = under(places.scratch, line) ?? under(`/private${places.scratch}`, line) ?? under(places.root, line);
  if (relative !== null) return truncate(relative, SUBJECT_MAX);
  const home = places.home?.replace(/\/+$/, '');
  return truncate(home ? line.split(`${home}/`).join('~/') : line, SUBJECT_MAX);
}

export function resolveExplainConfig(k: Partial<KnowledgeConfig> | undefined): ExplainConfig {
  const parallel = Math.floor(Number(k?.parallel ?? 2));
  return {
    backend: k?.backend || 'codex',
    // An empty model keeps the backend default; only a missing key falls back.
    model: k?.model ?? 'gpt-6.1-sol[high]',
    mode: k?.mode ?? 'workspace-write',
    parallel: Number.isFinite(parallel) ? Math.min(EXPLAIN_MAX_PARALLEL, Math.max(1, parallel)) : 2,
  };
}

export class CommitExplainer {
  private readonly loadKnowledge: () => Promise<Partial<KnowledgeConfig> | undefined>;
  private readonly invoke: ExplainInvoke;
  private readonly spawn: ExplainSpawn;
  private readonly home: () => Promise<string | null>;
  private readonly now: () => number;
  private readonly graceMs: number;
  /** Every live job (queued or running), by `root\0sha`. */
  private readonly jobs = new Map<string, ExplainJob>();
  private readonly queue: ExplainJob[] = [];
  /** Runs holding a slot, by `root\0sha` — including a cancelled run still cleaning up. */
  private readonly running = new Map<string, RunHandle>();
  private readonly listeners = new Set<(change: ExplainChange) => void>();
  private pumping = false;
  private pumpAgain = false;

  constructor(deps: CommitExplainerDeps = {}) {
    this.loadKnowledge = deps.config ?? (async () => (await loadConfig()).knowledge);
    this.invoke = deps.invoke ?? (<T>(cmd: string, args: Record<string, unknown>) => tauriInvoke<T>(cmd, args));
    this.spawn = deps.spawn ?? ((backendId, cwd, owner) => AcpClient.spawn(backendId, cwd, owner, []));
    this.home = deps.home ?? loadHomeDir;
    this.now = deps.now ?? Date.now;
    this.graceMs = deps.graceMs ?? EXPLAIN_CANCEL_GRACE_MS;
  }

  /** Queue a job for `sha`. A live job for the same commit is returned as is. */
  start(root: string, repoName: string, sha: string): ExplainJob {
    const existing = this.jobs.get(key(root, sha));
    if (existing) return existing;
    const job: ExplainJob = {
      root, repoName, sha, state: 'queued', startedAt: null, backend: null, model: null,
      phase: null, steps: [], stepCount: 0, continuations: 0,
    };
    this.jobs.set(key(root, sha), job);
    this.queue.push(job);
    this.emit({ kind: 'update', job });
    void this.pump();
    return job;
  }

  /** Cancel a queued or running job. False when there is none. */
  cancel(root: string, sha: string): boolean {
    const k = key(root, sha);
    const job = this.jobs.get(k);
    if (!job) return false;
    this.jobs.delete(k);
    const at = this.queue.indexOf(job);
    if (at >= 0) {
      this.queue.splice(at, 1);
    } else {
      const handle = this.running.get(k);
      if (handle) {
        handle.cancelled = true;
        if (handle.client) void handle.client.cancel().catch(() => undefined);
        setTimeout(handle.abandon, this.graceMs);
      }
    }
    this.emit({ kind: 'cancelled', job });
    return true;
  }

  job(root: string, sha: string): ExplainJob | null {
    return this.jobs.get(key(root, sha)) ?? null;
  }

  /** Queued jobs ahead of `job`; 0 for a running job. */
  queuedAhead(job: ExplainJob): number {
    return Math.max(0, this.queue.indexOf(job));
  }

  subscribe(listener: (change: ExplainChange) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private emit(change: ExplainChange): void {
    for (const listener of [...this.listeners]) listener(change);
  }

  /** Fill free slots from the queue. Re-entrant calls fold into one more pass. */
  private async pump(): Promise<void> {
    if (this.pumping) {
      this.pumpAgain = true;
      return;
    }
    this.pumping = true;
    try {
      do {
        this.pumpAgain = false;
        if (this.queue.length === 0) break;
        let cfg: ExplainConfig;
        try {
          cfg = resolveExplainConfig(await this.loadKnowledge());
        } catch (e) {
          for (const job of this.queue.splice(0)) {
            this.jobs.delete(key(job.root, job.sha));
            this.emit({ kind: 'failed', job, message: `config unavailable — ${errorText(e)}` });
          }
          break;
        }
        while (this.running.size < cfg.parallel && this.queue.length > 0) {
          const job = this.queue.shift() as ExplainJob;
          void this.run(job, cfg);
        }
      } while (this.pumpAgain);
    } finally {
      this.pumping = false;
    }
  }

  private async run(job: ExplainJob, cfg: ExplainConfig): Promise<void> {
    const k = key(job.root, job.sha);
    let abandon!: () => void;
    // Executor form: tsconfig's ES2021 lib has no `Promise.withResolvers`.
    const abandoned = new Promise<typeof ABANDONED>((resolve) => { abandon = () => resolve(ABANDONED); });
    const handle: RunHandle = {
      client: null, cancelled: false, asked: false, declined: false, places: null, calls: new Map(), abandoned, abandon,
    };
    this.running.set(k, handle);
    job.state = 'running';
    job.startedAt = this.now();
    job.backend = cfg.backend;
    job.model = cfg.model || null;
    job.phase = 'starting';
    this.emit({ kind: 'update', job });

    let change: ExplainChange;
    try {
      const path = await this.explain(job, cfg, handle);
      change = { kind: 'ready', job, path };
    } catch (e) {
      change = { kind: 'failed', job, message: errorText(e) };
    } finally {
      if (handle.client) void handle.client.dispose();
      this.running.delete(k);
    }
    // A cancelled job already reported itself when `cancel()` ran.
    if (!handle.cancelled) {
      this.jobs.delete(k);
      this.emit(change);
    }
    void this.pump();
  }

  /** One job end to end; resolves with the stored doc path. */
  private async explain(job: ExplainJob, cfg: ExplainConfig, handle: RunHandle): Promise<string> {
    const { backend } = cfg;
    const live = (): void => {
      if (handle.cancelled) throw new Error('cancelled');
    };
    const prepared = await this.invoke<KnowledgeJob>('knowledge_job_prepare', { cwd: job.root, sha: job.sha });
    handle.places = { root: job.root, scratch: prepared.scratch, home: await this.home() };
    live();
    let client: AcpClient;
    try {
      client = await this.spawn(backend, prepared.scratch, {
        role: 'commit_explainer',
        label: `explain ${job.repoName}@${job.sha.slice(0, 7)}`,
        harness_id: null,
        lane_id: null,
      });
    } catch (e) {
      throw new Error(`"${backend}" did not start — ${errorText(e)}`);
    }
    handle.client = client;
    live();

    let session: AgentSessionInfo;
    try {
      await client.initializeOnly();
      // Installed before session/new and kept for the process: nobody sits
      // behind a background job, so every request must be answered here.
      client.onEvent((event) => this.fence(job, handle, client, event));
      session = await client.sessionNew();
    } catch (e) {
      throw new Error(`"${backend}" did not start — ${errorText(e)}`);
    }
    live();
    if (cfg.model) {
      try {
        await client.setLaneModel(cfg.model);
      } catch {
        const base = cfg.model.split('[')[0];
        const near = (session.available_models ?? [])
          .map((m) => m.model_id)
          .filter((id) => id.split('[')[0] === base);
        const hint = near.length > 0 ? ` (available: ${near.join(', ')})` : '';
        throw new Error(`"${backend}" rejected model "${cfg.model}"${hint} — set [knowledge] model`);
      }
    }
    // Never run in the backend's own default: codex's `agent` mode lets its
    // auto-reviewer approve escalations the fence would never see.
    if (cfg.mode) {
      try {
        await client.setSessionMode(cfg.mode);
      } catch {
        throw new Error(`"${backend}" rejected mode "${cfg.mode}" — set [knowledge] mode`);
      }
    }
    live();

    job.phase = 'thinking';
    this.emit({ kind: 'update', job });
    let text = learnCommitPrompt({
      sha: job.sha,
      path: prepared.draft,
      repo: prepared.repo,
      repoRoot: job.root,
      scratch: prepared.scratch,
    });
    for (let continued = 0; ; continued += 1) {
      handle.declined = false;
      const turn = client.prompt([{ type: 'text', text }]);
      let stop: StopReason | typeof ABANDONED;
      try {
        stop = await Promise.race([turn, handle.abandoned]);
      } catch (e) {
        throw new Error(`"${backend}" failed — ${errorText(e)}`);
      } finally {
        void turn.catch(() => undefined);
      }
      live();
      if (handle.asked) throw new Error(`"${backend}" asked a question — a background job cannot answer`);
      if (stop === 'end_turn') break;
      if (stop !== 'cancelled' || !handle.declined) throw new Error(`turn stopped (${String(stop)})`);
      if (continued === EXPLAIN_MAX_CONTINUATIONS) {
        throw new Error(`"${backend}" kept asking for approval — a background job declines every request`);
      }
      job.continuations += 1;
      job.phase = 'continuing';
      this.emit({ kind: 'update', job });
      text = DECLINED_CONTINUE_PROMPT;
    }
    return this.invoke<string>('knowledge_store', { cwd: job.root, sha: job.sha });
  }

  /** The job fence: approve nothing. The first reject option is picked: a
   *  `decline` lets the turn go on, while codex's `cancel` (all a sandbox
   *  escalation offers) ends it and `explain` sends a continuation turn. */
  private fence(job: ExplainJob, handle: RunHandle, client: AcpClient, event: AcpEvent): void {
    if (event.type === 'permission_request') {
      const decline = event.options.find((option) => option.kind === 'reject_once');
      handle.declined = true;
      void client.respondPermission(event.requestId, decline?.optionId ?? null).catch(() => undefined);
      return;
    }
    if (event.type === 'ask_user_question' || event.type === 'elicitation_request') handle.asked = true;
    if (answerFencedRequest(client, event)) return;
    if (handle.cancelled) return;
    switch (event.type) {
      case 'tool_call':
        if (this.recordStep(job, handle, event.call, true)) this.emit({ kind: 'update', job });
        return;
      case 'tool_call_update':
        if (this.recordStep(job, handle, event.update, false)) this.emit({ kind: 'update', job });
        return;
      // Chunks stamped with a parent tool belong to a subagent, not this agent's phase.
      case 'thought_chunk':
        if (!event.parentToolUseId) this.setPhase(job, 'thinking');
        return;
      case 'message_chunk':
        if (!event.parentToolUseId) this.setPhase(job, 'replying');
    }
  }

  /** Record a tool call (`isNew`) or an update as a step; true when a step
   *  changed. An update for a step no longer kept is dropped. */
  private recordStep(job: ExplainJob, handle: RunHandle, call: ToolCall | ToolCallUpdate, isNew: boolean): boolean {
    const places = handle.places;
    const previous = handle.calls.get(call.toolCallId);
    if (!places || (!previous && !isNew)) return false;
    const merged = mergeToolCall(previous, call);
    handle.calls.set(call.toolCallId, merged);
    const { kind, subject } = toolSubject(merged);
    const step: ExplainStep = {
      id: call.toolCallId,
      kind: toolChipKind(kind),
      subject: jobSubject(subject, places),
      state: stepState(merged.status),
    };
    if (previous) {
      const at = job.steps.findIndex((s) => s.id === step.id);
      const old = job.steps[at];
      if (!old || (old.kind === step.kind && old.subject === step.subject && old.state === step.state)) return false;
      job.steps = job.steps.map((s, i) => (i === at ? step : s));
      return true;
    }
    job.stepCount += 1;
    // Once this tool ends, the agent is thinking until a chunk says otherwise.
    job.phase = 'thinking';
    const steps = [...job.steps, step];
    while (steps.length > EXPLAIN_STEPS_KEPT) {
      const dropped = steps.shift();
      if (dropped) handle.calls.delete(dropped.id);
    }
    job.steps = steps;
    return true;
  }

  private setPhase(job: ExplainJob, phase: ExplainPhase): void {
    if (job.phase === phase) return;
    job.phase = phase;
    this.emit({ kind: 'update', job });
  }
}
