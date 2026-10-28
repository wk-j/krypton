// Krypton — harness assist sidecar (spec 306): the contract.
//
// Nothing here knows about prompts, transport or UI. A task declares a system
// prompt, a payload builder and a strict parser; the engine owns everything
// else (the ACP session, the deadline, the byte caps, the circuit breaker).

import type { HarnessTranscriptItem } from '../harness-view-types';

export type AssistMode = 'off' | 'manual' | 'auto';

export interface AssistBudget {
  readonly maxInputChars: number;
  readonly timeoutMs: number;
}

/** Resolved per run: the mode, the ACP target, the budget, and the task's own
 *  scalar knobs from `[acp_harness.assist.tasks.<id>]`. A task ships its
 *  `Partial` as `defaults`; `resolveAssistConfig` fills the rest. */
export interface AssistTaskConfig extends AssistBudget {
  readonly mode: AssistMode;
  /** ACP backend id — the same id space as the lane picker. No API key: the
   *  backend's own CLI login is the credential. */
  readonly backendId: string;
  /** Model id or alias for `session/set_model`. `""` in TOML ⇒ `undefined` ⇒
   *  whatever the backend defaults to. */
  readonly modelId: string | undefined;
  readonly options: Readonly<Record<string, string | number | boolean>>;
}

export type AssistTaskDefaults = Partial<AssistTaskConfig>;

/** Built once per request by the controller. */
export interface AssistContext {
  readonly laneId: string;
  readonly laneName: string;
  readonly backendId: string;
  readonly modelName: string | null;
  readonly projectDir: string | null;
  /** This turn's items, oldest first. */
  readonly turn: readonly HarnessTranscriptItem[];
}

/** A `panel` task's result: a review of the prompt the human sent.
 *  `corrected === null` means the text had nothing to fix. */
export interface AssistCheck {
  readonly corrected: string | null;
  /** Each change as a short `wrong → right` pair, most important first. */
  readonly fixes: readonly string[];
}

/**
 * Spec 323: one follow-up action under a reply. A `run` or `open` target is
 * copied from a candidate Krypton extracted out of the reply's markdown — the
 * assist model only picks the candidate and writes `label`, so it never
 * authors the bytes that run. A `prompt` target (spec 327) is a message the
 * model wrote for the lane itself; it goes to the agent, never to a shell.
 * `hintLabel` is the `f` open-hint label (spec 206 target contract), `null`
 * outside hint mode.
 */
export interface FollowUpAction {
  /** A field no other open-hint target carries: the dispatch keys on it. */
  readonly followUpKind: 'run' | 'open' | 'prompt';
  /** 1..40 characters, written by the model. */
  readonly label: string;
  /** The command (`run`), http(s) URL (`open`) or message for the lane (`prompt`). */
  readonly target: string;
  hintLabel: string | null;
}

/** What the rail panel paints for one lane. `original` is the checked text. */
export type AssistPanelState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'pending'; readonly taskId: string; readonly original: string }
  | { readonly kind: 'ready'; readonly taskId: string; readonly original: string; readonly check: AssistCheck };

/** `no-backend` / `no-model` are hard: the subprocess would not start, or the
 *  agent rejected the model id, and retrying cannot help. The rest are soft
 *  and feed the breaker. */
export type AssistFailure = 'no-backend' | 'no-model' | 'timeout' | 'unavailable' | 'invalid';

/**
 * One model call the engine can run: a fixed system prompt, a payload built
 * from a context `C` within the budget, and a strict parser. Assist tasks are
 * calls over `AssistContext`; the rails judge (spec 337) is a call over its
 * own context.
 */
export interface AssistCall<T, C> {
  /** Breaker key; for a task, also `#assist <id>` and the TOML table key. */
  readonly id: string;
  system(cfg: AssistTaskConfig): string;
  payload(ctx: C, budget: AssistBudget): string;
  /** Strict parse. `null` means the model did not answer ⇒ `'invalid'`.
   *  `ctx` is the context `payload` was built from. */
  parse(raw: string, cfg: AssistTaskConfig, ctx: C): T | null;
}

export interface AssistTask<T> extends AssistCall<T, AssistContext> {
  /** `#assist <id>` and the `[acp_harness.assist.tasks.<id>]` key. */
  readonly id: string;
  /** One line, listed by bare `#assist`. */
  readonly summary: string;
  /** Which component paints `T`: the right-rail panel, or the reply row in
   *  the transcript (spec 323). */
  readonly surface: 'panel' | 'transcript';
  /** Eligible for the automatic turn-end trigger. */
  readonly onTurnEnd: boolean;
  /** Eligible for the automatic trigger when the human sends a prompt. */
  readonly onUserPrompt?: boolean;
  /** Mode / backend / budget this task wants before TOML speaks. */
  readonly defaults: AssistTaskDefaults;
  /** The task's own gate, on top of the engine's. Default: always eligible. */
  eligible?(ctx: AssistContext, cfg: AssistTaskConfig): boolean;
}

/** A review of the sent prompt in the right rail (`GrammarPanel`). */
export type PanelAssistTask = AssistTask<AssistCheck> & { readonly surface: 'panel' };
/** Follow-up actions under the reply that named them (`FollowUpRail`, spec 323). */
export type TranscriptAssistTask = AssistTask<FollowUpAction[]> & { readonly surface: 'transcript' };

export type RegisteredAssistTask = PanelAssistTask | TranscriptAssistTask;
