// Krypton — Rails verifier (spec 337): `[acp_harness.rails]`.
//
// Rust passes the table through untyped; every default, clamp and validation
// lives here, following `assist/config.ts`.

import { ASSIST_MODES } from '../assist/config';
import type { AssistTaskConfig } from '../assist/types';
import type { RailsConfig, RailsMode } from './types';

export const RAILS_LIMITS = {
  timeoutMs: { min: 10_000, max: 180_000, fallback: 60_000 },
  maxInputChars: { min: 4_000, max: 80_000, fallback: 32_000 },
  debounceMs: { min: 1_000, max: 60_000, fallback: 5_000 },
} as const;

export const RAILS_DEFAULT_BACKEND = 'claude';
export const RAILS_DEFAULT_MODEL = 'haiku';

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** Missing ⇒ `auto` (runs still need a trusted manifest); present but invalid ⇒ `off`. */
function readMode(block: Record<string, unknown> | null): RailsMode {
  if (!block || block.mode === undefined || block.mode === null) return 'auto';
  const mode = block.mode;
  return typeof mode === 'string' && (ASSIST_MODES as readonly string[]).includes(mode)
    ? mode as RailsMode
    : 'off';
}

/** `undefined` when the key is absent; `{ value: undefined }` for `""`. */
function readText(block: Record<string, unknown> | null, key: string): { value: string | undefined } | undefined {
  const raw = block?.[key];
  if (typeof raw !== 'string') return undefined;
  const text = raw.trim();
  return { value: text === '' ? undefined : text };
}

function readClamped(
  block: Record<string, unknown> | null,
  key: string,
  limits: { readonly min: number; readonly max: number; readonly fallback: number },
): number {
  const raw = block?.[key];
  const value = typeof raw === 'number' && Number.isFinite(raw) ? raw : limits.fallback;
  return Math.min(limits.max, Math.max(limits.min, Math.round(value)));
}

/** `rawConfig` is the untyped `get_config` blob. */
export function resolveRailsConfig(rawConfig: unknown): RailsConfig {
  const rails = asRecord(asRecord(asRecord(rawConfig)?.acp_harness)?.rails);
  const model = readText(rails, 'model');
  return {
    mode: readMode(rails),
    backendId: readText(rails, 'backend')?.value ?? RAILS_DEFAULT_BACKEND,
    modelId: model ? model.value : RAILS_DEFAULT_MODEL,
    timeoutMs: readClamped(rails, 'timeout_ms', RAILS_LIMITS.timeoutMs),
    maxInputChars: readClamped(rails, 'max_input_chars', RAILS_LIMITS.maxInputChars),
    debounceMs: readClamped(rails, 'debounce_ms', RAILS_LIMITS.debounceMs),
  };
}

/** The engine's view of the judge step. */
export function railsAssistConfig(cfg: RailsConfig): AssistTaskConfig {
  return {
    mode: cfg.mode,
    backendId: cfg.backendId,
    modelId: cfg.modelId,
    timeoutMs: cfg.timeoutMs,
    maxInputChars: cfg.maxInputChars,
    options: {},
  };
}
