// Krypton — harness assist sidecar (spec 306): the contract.
//
// Nothing here knows about prompts, transport or UI. A task declares a system
// prompt, a payload builder and a strict parser; the engine owns everything
// else (the ACP session, the deadline, the byte caps, the circuit breaker).

import type { HarnessTranscriptItem } from '../harness-view-types';
import type { PlanEntry, StopReason } from '../types';

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
  readonly stopReason: StopReason;
  /** This turn's items, oldest first. */
  readonly turn: readonly HarnessTranscriptItem[];
  readonly plan: readonly PlanEntry[] | null;
  readonly queuedPrompts: number;
  readonly draft: string;
}

/** One suggestion row — the only shape the `strip` surface paints.
 *  `label` is 1..48 characters, `prompt` 8..240. */
export interface AssistAction {
  readonly label: string;
  readonly prompt: string;
}

/** A `panel` task's result: a review of the prompt the human sent.
 *  `corrected === null` means the text had nothing to fix. */
export interface AssistCheck {
  readonly corrected: string | null;
  /** Each change as a short `wrong → right` pair, most important first. */
  readonly fixes: readonly string[];
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

export type AssistState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'pending'; readonly taskId: string }
  | { readonly kind: 'ready'; readonly taskId: string; readonly actions: readonly AssistAction[] }
  | { readonly kind: 'failed'; readonly taskId: string; readonly reason: AssistFailure };

export interface AssistTask<T> {
  /** `#assist <id>` and the `[acp_harness.assist.tasks.<id>]` key. */
  readonly id: string;
  /** One line, listed by bare `#assist`. */
  readonly summary: string;
  /** Which component paints `T`: the composer strip or the right-rail panel. */
  readonly surface: 'strip' | 'panel';
  /** Eligible for the automatic turn-end trigger. */
  readonly onTurnEnd: boolean;
  /** Eligible for the automatic trigger when the human sends a prompt. */
  readonly onUserPrompt?: boolean;
  /** Mode / backend / budget this task wants before TOML speaks. */
  readonly defaults: AssistTaskDefaults;
  /** The task's own gate, on top of the engine's. Default: always eligible. */
  eligible?(ctx: AssistContext, cfg: AssistTaskConfig): boolean;
  system(cfg: AssistTaskConfig): string;
  payload(ctx: AssistContext, budget: AssistBudget): string;
  /** Strict parse. `null` means the model did not answer ⇒ `'invalid'`. */
  parse(raw: string, cfg: AssistTaskConfig): T | null;
}

/** Next-prompt suggestions above the draft line (`AssistStrip`). */
export type StripAssistTask = AssistTask<readonly AssistAction[]> & { readonly surface: 'strip' };
/** A review of the sent prompt in the right rail (`GrammarPanel`). */
export type PanelAssistTask = AssistTask<AssistCheck> & { readonly surface: 'panel' };

export type RegisteredAssistTask = StripAssistTask | PanelAssistTask;
