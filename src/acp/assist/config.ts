// Krypton — harness assist sidecar (spec 306): config merge.
//
// `[acp_harness.assist]` is the global default block; `[acp_harness.assist.tasks.<id>]`
// overrides it per task and may carry arbitrary extra scalars, which reach the
// task as opaque `options`. Rust holds no task knowledge, so every clamp and
// every validation lives here.

import type { AssistMode, AssistTask, AssistTaskConfig } from './types';

export const ASSIST_MODES: readonly AssistMode[] = ['off', 'manual', 'auto'];

/** Clamp bounds and the fallback used when no layer supplies a value. */
export const ASSIST_LIMITS = {
  timeoutMs: { min: 1_000, max: 20_000, fallback: 8_000 },
  maxInputChars: { min: 500, max: 20_000, fallback: 6_000 },
} as const;

/** No layer supplies one: the default ACP backend and a cheap model on it. */
export const ASSIST_FALLBACK_BACKEND = 'claude';

/** The five generic keys every layer may carry. Anything else in a per-task
 *  block is a task knob and flows through as `options`. */
export const ASSIST_RESERVED_KEYS: readonly string[] = [
  'mode', 'backend', 'model', 'timeout_ms', 'max_input_chars',
];

type Scalar = string | number | boolean;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isScalar(value: unknown): value is Scalar {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** A present but invalid mode fails closed: a paid call never starts by accident. */
function readMode(block: Record<string, unknown> | null): AssistMode | undefined {
  if (!block || block.mode === undefined) return undefined;
  const mode = block.mode;
  return typeof mode === 'string' && (ASSIST_MODES as readonly string[]).includes(mode)
    ? mode as AssistMode
    : 'off';
}

function readText(block: Record<string, unknown> | null, key: string): { value: string | undefined } | undefined {
  if (!block || typeof block[key] !== 'string') return undefined;
  const text = (block[key] as string).trim();
  return { value: text === '' ? undefined : text };
}

function readNumber(block: Record<string, unknown> | null, key: string): number | undefined {
  if (!block) return undefined;
  const value = block[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Extra scalars from a per-task block — the knobs Rust never interprets. */
function readOptions(block: Record<string, unknown> | null): Record<string, Scalar> {
  const options: Record<string, Scalar> = {};
  if (!block) return options;
  for (const [key, value] of Object.entries(block)) {
    if (ASSIST_RESERVED_KEYS.includes(key)) continue;
    if (isScalar(value)) options[key] = value;
  }
  return options;
}

/**
 * Merge `task.defaults` ← `[acp_harness.assist]` ← `[…assist.tasks.<id>]`,
 * then clamp. `rawConfig` is the untyped `get_config` blob.
 */
export function resolveAssistConfig(rawConfig: unknown, task: AssistTask<unknown>): AssistTaskConfig {
  const assist = asRecord(asRecord(asRecord(rawConfig)?.acp_harness)?.assist);
  const override = asRecord(asRecord(assist?.tasks)?.[task.id]);
  const defaults = task.defaults;

  const mode = readMode(override) ?? readMode(assist) ?? defaults.mode ?? 'off';

  const backend = readText(override, 'backend') ?? readText(assist, 'backend');
  const backendId = (backend ? backend.value : defaults.backendId) ?? ASSIST_FALLBACK_BACKEND;

  const model = readText(override, 'model') ?? readText(assist, 'model');
  const modelId = model ? model.value : defaults.modelId;

  const timeoutMs = readNumber(override, 'timeout_ms')
    ?? readNumber(assist, 'timeout_ms')
    ?? defaults.timeoutMs
    ?? ASSIST_LIMITS.timeoutMs.fallback;
  const maxInputChars = readNumber(override, 'max_input_chars')
    ?? readNumber(assist, 'max_input_chars')
    ?? defaults.maxInputChars
    ?? ASSIST_LIMITS.maxInputChars.fallback;

  return {
    mode,
    backendId,
    modelId,
    timeoutMs: clamp(timeoutMs, ASSIST_LIMITS.timeoutMs.min, ASSIST_LIMITS.timeoutMs.max),
    maxInputChars: clamp(maxInputChars, ASSIST_LIMITS.maxInputChars.min, ASSIST_LIMITS.maxInputChars.max),
    options: { ...defaults.options, ...readOptions(override) },
  };
}
