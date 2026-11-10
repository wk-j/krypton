// Spec 380 — the generic adapter: the ACP spec plus the tolerant readers every
// backend gets. Backend adapters (`claude.ts`, `codex.ts`, …) only refine it.

import type { AskUserOption, AskUserQuestion } from '../ask-user-question';
import type {
  AcpAgentMode,
  AcpAvailableCommand,
  AcpSessionCapabilities,
  AcpSessionInfo,
  AcpSessionListResult,
  ContentBlock,
  ModelInfo,
  SteerOutcome,
  StopReason,
  UsageInfo,
} from '../types';
import type { LaneAdapter, LaneEvent, LaneInit, LaneSession, PromptResult } from './types';

export const genericAdapter: LaneAdapter = { id: 'generic' };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

// ─── Content ──────────────────────────────────────────────────────────────

export function extractText(content: unknown): string {
  const c = asRecord(content);
  return c && c.type === 'text' && typeof c.text === 'string' ? c.text : '';
}

/** One ACP content block, typed. Malformed or future blocks degrade to empty text. */
export function normalizeContentBlock(content: unknown): ContentBlock {
  const value = asRecord(content);
  if (!value) return { type: 'text', text: '' };
  if (value.type === 'text') {
    return { type: 'text', text: typeof value.text === 'string' ? value.text : '' };
  }
  if (value.type === 'resource_link' && typeof value.uri === 'string') {
    return {
      type: 'resource_link',
      uri: value.uri,
      name: typeof value.name === 'string' ? value.name : undefined,
      title: typeof value.title === 'string' ? value.title : undefined,
      description: typeof value.description === 'string' ? value.description : undefined,
      mimeType: typeof value.mimeType === 'string' ? value.mimeType : undefined,
      size: typeof value.size === 'number' && Number.isFinite(value.size) && value.size >= 0
        ? value.size
        : undefined,
    };
  }
  if (value.type === 'resource') {
    const resource = asRecord(value.resource);
    if (resource && typeof resource.uri === 'string') {
      return {
        type: 'resource',
        resource: {
          uri: resource.uri,
          mimeType: typeof resource.mimeType === 'string' ? resource.mimeType : undefined,
          text: typeof resource.text === 'string' ? resource.text : undefined,
          blob: typeof resource.blob === 'string' ? resource.blob : undefined,
        },
      };
    }
  }
  // Image/audio blocks are forwarded when complete.
  if (value.type === 'image' && typeof value.data === 'string' && typeof value.mimeType === 'string') {
    return {
      type: 'image',
      data: value.data,
      mimeType: value.mimeType,
      uri: typeof value.uri === 'string' ? value.uri : undefined,
    };
  }
  if (value.type === 'audio' && typeof value.data === 'string' && typeof value.mimeType === 'string') {
    return { type: 'audio', data: value.data, mimeType: value.mimeType };
  }
  return { type: 'text', text: '' };
}

/** Decode one assistant content block without discarding non-text ACP data. */
export function assistantMessageEvent(
  content: unknown,
  messageId: unknown,
  parentToolId?: string | null,
): Extract<LaneEvent, { type: 'message_chunk' }> {
  const block = normalizeContentBlock(content);
  return {
    type: 'message_chunk',
    text: block.type === 'text' ? block.text : '',
    content: block,
    messageId: typeof messageId === 'string' && messageId.length > 0 ? messageId : undefined,
    ...(parentToolId ? { parentToolId } : {}),
  };
}

// ─── Session updates ──────────────────────────────────────────────────────

export function usageFromUpdate(update: Readonly<Record<string, unknown>>): UsageInfo {
  const cost = asRecord(update.cost);
  return {
    used: typeof update.used === 'number' ? update.used : undefined,
    size: typeof update.size === 'number' ? update.size : undefined,
    cost: cost && typeof cost.amount === 'number'
      ? { amount: cost.amount, currency: typeof cost.currency === 'string' ? cost.currency : 'USD' }
      : undefined,
  };
}

export function availableCommands(value: unknown): AcpAvailableCommand[] {
  if (!Array.isArray(value)) return [];
  const out: AcpAvailableCommand[] = [];
  for (const item of value) {
    const c = asRecord(item);
    if (!c || typeof c.name !== 'string' || c.name.length === 0) continue;
    const input = asRecord(c.input);
    out.push({
      name: c.name,
      description: typeof c.description === 'string' ? c.description : undefined,
      inputHint: typeof input?.hint === 'string' ? input.hint : undefined,
    });
  }
  return out;
}

/** spec 278: a `_session/steering` outcome; unknown or missing → 'failed'. */
export function steerOutcome(value: unknown): SteerOutcome {
  return value === 'injected' || value === 'startedNewTurn' || value === 'promptRequired'
    ? value
    : 'failed';
}

// ─── Questions (spec 229) ─────────────────────────────────────────────────

/** `ask_user_question` questions from `{ questions }`, `{ params: { questions } }`, or a bare array. */
export function parseAskUserQuestions(input: unknown): AskUserQuestion[] {
  const root = Array.isArray(input) ? { questions: input } : asRecord(input);
  const nested = asRecord(root?.params);
  const raw = root?.questions ?? nested?.questions;
  if (!Array.isArray(raw)) return [];
  const out: AskUserQuestion[] = [];
  for (const item of raw) {
    const rec = asRecord(item);
    if (!rec) continue;
    const question = typeof rec.question === 'string' ? rec.question : '';
    const optionsRaw = Array.isArray(rec.options) ? rec.options : [];
    const options: AskUserOption[] = [];
    for (const opt of optionsRaw) {
      const o = asRecord(opt);
      if (!o) continue;
      const label = typeof o.label === 'string' ? o.label : '';
      if (!label) continue;
      options.push({
        label,
        description: typeof o.description === 'string' ? o.description : '',
        preview: typeof o.preview === 'string' ? o.preview : undefined,
      });
    }
    if (!question.trim() && options.length === 0) continue;
    const multi = rec.multiSelect === true || rec.multi_select === true;
    out.push({
      question,
      options,
      multiSelect: multi || undefined,
    });
  }
  return out;
}

// ─── initialize ───────────────────────────────────────────────────────────

const MODEL_KEYS = [
  'model', 'modelId', 'model_id', 'selectedModel', 'selected_model',
  'activeModel', 'active_model', 'defaultModel', 'default_model',
] as const;

/** A model name an agent put anywhere in its capabilities (depth-limited walk). */
export function findModelName(value: unknown, depth = 0): string | null {
  if (depth > 8 || !value || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const match = findModelName(item, depth + 1);
      if (match) return match;
    }
    return null;
  }
  const record = value as Record<string, unknown>;
  for (const key of MODEL_KEYS) {
    const candidate = record[key];
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  for (const item of Object.values(record)) {
    const match = findModelName(item, depth + 1);
    if (match) return match;
  }
  return null;
}

export function sessionCapabilitiesFromAgent(caps: unknown): AcpSessionCapabilities {
  const record = asRecord(caps);
  const sessionCaps = asRecord(record?.sessionCapabilities);
  return {
    canList: Boolean(sessionCaps?.list),
    canResume: Boolean(sessionCaps?.resume),
    canLoad: record?.loadSession === true,
  };
}

/** ACP `SessionMode[]` (or the off-spec capability list of the same shape). */
export function parseModes(value: unknown): AcpAgentMode[] {
  if (!Array.isArray(value)) return [];
  const out: AcpAgentMode[] = [];
  for (const item of value) {
    const mode = asRecord(item);
    if (!mode || typeof mode.id !== 'string') continue;
    out.push({
      id: mode.id,
      name: typeof mode.name === 'string' ? mode.name : mode.id,
      description: typeof mode.description === 'string' ? mode.description : undefined,
    });
  }
  return out;
}

export function decodeInit(raw: unknown): LaneInit {
  const init = asRecord(raw);
  const caps = asRecord(init?.agent_capabilities);
  const prompt = asRecord(caps?.promptCapabilities);
  const mcp = asRecord(caps?.mcpCapabilities);
  return {
    promptImage: Boolean(prompt?.image),
    promptEmbeddedContext: Boolean(prompt?.embeddedContext),
    sessions: sessionCapabilitiesFromAgent(caps),
    mcp: { http: Boolean(mcp?.http), sse: Boolean(mcp?.sse) },
    steering: init?.steering_supported === true,
    authMethods: Array.isArray(init?.auth_methods) ? init.auth_methods : [],
    reportedModel: findModelName(caps),
    modes: parseModes(caps?.availableModes),
  };
}

// ─── session/new | resume | load | list ──────────────────────────────────

function parseModels(value: unknown): ModelInfo[] {
  if (!Array.isArray(value)) return [];
  const out: ModelInfo[] = [];
  for (const item of value) {
    const model = asRecord(item);
    if (!model || typeof model.model_id !== 'string') continue;
    out.push({
      model_id: model.model_id,
      name: typeof model.name === 'string' ? model.name : model.model_id,
      description: typeof model.description === 'string' ? model.description : null,
    });
  }
  return out;
}

export function decodeSession(raw: unknown): LaneSession {
  const session = asRecord(raw);
  const modes = asRecord(session?.modes);
  const currentModeId = modes?.currentModeId;
  return {
    sessionId: typeof session?.session_id === 'string' ? session.session_id : '',
    models: parseModels(session?.available_models),
    currentModelId: typeof session?.current_model_id === 'string' ? session.current_model_id : null,
    modes: parseModes(modes?.availableModes),
    currentModeId: typeof currentModeId === 'string' && currentModeId.length > 0 ? currentModeId : null,
    modelApplyFailed: session?.model_apply_failed === true,
  };
}

export function decodeSessionList(raw: unknown): AcpSessionListResult {
  const list = asRecord(raw);
  const sessions: AcpSessionInfo[] = [];
  for (const item of Array.isArray(list?.sessions) ? list.sessions : []) {
    const entry = asRecord(item);
    if (!entry || typeof entry.sessionId !== 'string') continue;
    sessions.push({
      sessionId: entry.sessionId,
      cwd: typeof entry.cwd === 'string' ? entry.cwd : '',
      title: typeof entry.title === 'string' ? entry.title : null,
      updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : null,
    });
  }
  const nextCursor = list?.nextCursor;
  return { sessions, nextCursor: typeof nextCursor === 'string' ? nextCursor : null };
}

// ─── session/prompt result ────────────────────────────────────────────────

/**
 * The turn-end reply. Usage is off-spec: claude-agent-acp puts it at the top
 * level and codex-acp under `_meta`. Both are read for every backend so one
 * that copies either convention still reports it.
 */
export function decodePromptResult(raw: unknown): PromptResult {
  const result = asRecord(raw);
  const reason = result?.stopReason;
  // Passed through unvalidated, as before: a newer reason still reaches the UI.
  const stopReason = typeof reason === 'string' ? reason as StopReason : 'end_turn';
  const usage = asRecord(result?.usage) ?? asRecord(asRecord(result?._meta)?.usage);
  return {
    stopReason,
    usage: usage && Object.keys(usage).length > 0 ? usage as UsageInfo : null,
  };
}
