// Krypton — Agent Context Compaction
// Two-layer context management:
// 1. afterToolCall: truncate large tool results
// 2. transformContext: auto-compact when context approaches the limit

import type { AgentMessage } from '@mariozechner/pi-agent-core';
import type { AfterToolCallContext, AfterToolCallResult } from '@mariozechner/pi-agent-core';
import type { AssistantMessage, Model, Usage } from '@mariozechner/pi-ai';
import { completeSimple } from '@mariozechner/pi-ai';

// ─── Settings ────────────────────────────────────────────────────

export interface CompactionSettings {
  reserveTokens: number;
  keepRecentTokens: number;
  maxToolOutputChars: number;
}

export const DEFAULT_SETTINGS: CompactionSettings = {
  reserveTokens: 16_384,
  keepRecentTokens: 20_000,
  maxToolOutputChars: 30_000,
};

const CHARS_PER_TOKEN = 4;

// ─── Token estimation ────────────────────────────────────────────

function getAssistantUsage(msg: AgentMessage): Usage | undefined {
  if (msg.role !== 'assistant') return undefined;
  const a = msg as AssistantMessage;
  if (a.stopReason === 'aborted' || a.stopReason === 'error') return undefined;
  return a.usage ?? undefined;
}

export function estimateTokens(message: AgentMessage): number {
  let chars = 0;

  if (message.role === 'user') {
    const content = (message as { content: string | Array<{ type: string; text?: string }> }).content;
    if (typeof content === 'string') {
      chars = content.length;
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'text' && block.text) chars += block.text.length;
      }
    }
    return Math.ceil(chars / CHARS_PER_TOKEN);
  }

  if (message.role === 'assistant') {
    const a = message as AssistantMessage;
    for (const block of a.content) {
      if (block.type === 'text') {
        chars += (block as { text: string }).text.length;
      } else if (block.type === 'thinking') {
        chars += ((block as { thinking: string }).thinking ?? '').length;
      } else if (block.type === 'toolCall') {
        const tc = block as { name: string; arguments: unknown };
        chars += tc.name.length + JSON.stringify(tc.arguments).length;
      }
    }
    return Math.ceil(chars / CHARS_PER_TOKEN);
  }

  if (message.role === 'toolResult') {
    const content = (message as { content: string | Array<{ type: string; text?: string }> }).content;
    if (typeof content === 'string') {
      chars = content.length;
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'text' && block.text) chars += block.text.length;
      }
    }
    return Math.ceil(chars / CHARS_PER_TOKEN);
  }

  return 0;
}

export function estimateContextTokens(
  messages: AgentMessage[],
): { tokens: number; lastUsageIndex: number | null } {
  // Find last assistant message with valid usage
  let lastUsage: Usage | undefined;
  let lastUsageIndex: number | null = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const u = getAssistantUsage(messages[i]);
    if (u) {
      lastUsage = u;
      lastUsageIndex = i;
      break;
    }
  }

  if (!lastUsage || lastUsageIndex === null) {
    let estimated = 0;
    for (const m of messages) estimated += estimateTokens(m);
    return { tokens: estimated, lastUsageIndex: null };
  }

  // usage.input = tokens the model saw (system + all messages up to that point)
  let trailingTokens = 0;
  for (let i = lastUsageIndex + 1; i < messages.length; i++) {
    trailingTokens += estimateTokens(messages[i]);
  }

  return {
    tokens: lastUsage.input + trailingTokens,
    lastUsageIndex,
  };
}

// ─── Cut point detection ─────────────────────────────────────────

function findCutPoint(messages: AgentMessage[], keepRecentTokens: number): number {
  let accumulated = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    accumulated += estimateTokens(messages[i]);
    if (accumulated >= keepRecentTokens) {
      // Walk forward to find a valid cut point (not a toolResult)
      for (let j = i; j < messages.length; j++) {
        if (messages[j].role !== 'toolResult') return j;
      }
      return i;
    }
  }

  return 0; // keep everything
}

// ─── Summarization ───────────────────────────────────────────────

function serializeMessages(messages: AgentMessage[]): string {
  const parts: string[] = [];

  for (const msg of messages) {
    if (msg.role === 'user') {
      const content = (msg as { content: string | Array<{ type: string; text?: string }> }).content;
      const text = typeof content === 'string'
        ? content
        : (content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n');
      parts.push(`[User]\n${text}`);
    } else if (msg.role === 'assistant') {
      const a = msg as AssistantMessage;
      const textBlocks = a.content
        .filter((b) => b.type === 'text')
        .map((b) => (b as { text: string }).text);
      const toolCalls = a.content
        .filter((b) => b.type === 'toolCall')
        .map((b) => {
          const tc = b as { name: string; arguments: unknown };
          return `  tool: ${tc.name}(${JSON.stringify(tc.arguments).slice(0, 200)})`;
        });
      parts.push(`[Assistant]\n${textBlocks.join('\n')}\n${toolCalls.join('\n')}`);
    } else if (msg.role === 'toolResult') {
      const content = (msg as { content: string | Array<{ type: string; text?: string }> }).content;
      const text = typeof content === 'string'
        ? content
        : (content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n');
      const toolName = (msg as { toolName?: string }).toolName ?? 'tool';
      // Truncate long tool results in the serialization too
      const truncated = text.length > 2000 ? text.slice(0, 2000) + '\n[... truncated for summary]' : text;
      parts.push(`[Tool Result: ${toolName}]\n${truncated}`);
    }
  }

  return parts.join('\n\n');
}

const COMPACTION_SYSTEM_PROMPT = 'You are a conversation summarizer. Be concise and precise.';

const COMPACTION_USER_PROMPT = `Summarize the following conversation so an AI assistant can continue the work seamlessly.

Preserve exactly:
- The user's goal and current task
- File paths, function names, error messages (verbatim)
- Key decisions and their rationale
- What was completed vs what remains

<conversation>
{conversation}
</conversation>

Respond with a structured summary under 500 words.`;

async function generateSummary(
  messages: AgentMessage[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  model: Model<any>,
  apiKey: string,
  reserveTokens: number,
): Promise<string> {
  const serialized = serializeMessages(messages);
  const promptText = COMPACTION_USER_PROMPT.replace('{conversation}', serialized);

  const response = await completeSimple(
    model,
    {
      systemPrompt: COMPACTION_SYSTEM_PROMPT,
      messages: [{
        role: 'user' as const,
        content: [{ type: 'text' as const, text: promptText }],
        timestamp: Date.now(),
      }],
    },
    { maxTokens: Math.floor(0.8 * reserveTokens), apiKey },
  );

  if (response.stopReason === 'error') {
    throw new Error(`Summarization failed: ${response.errorMessage ?? 'unknown'}`);
  }

  return response.content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
}

// ─── Hook factories ──────────────────────────────────────────────

/**
 * Creates an afterToolCall hook that truncates large tool results.
 */
export function createAfterToolCallHook(
  settings: CompactionSettings = DEFAULT_SETTINGS,
): (ctx: AfterToolCallContext, signal?: AbortSignal) => Promise<AfterToolCallResult | undefined> {
  return async (ctx: AfterToolCallContext) => {
    const textBlock = ctx.result.content?.find(
      (b: { type: string }) => b.type === 'text',
    ) as { type: 'text'; text: string } | undefined;

    if (!textBlock || textBlock.text.length <= settings.maxToolOutputChars) {
      return undefined;
    }

    const original = textBlock.text;
    const truncated = original.slice(0, settings.maxToolOutputChars)
      + `\n\n[... truncated ${original.length - settings.maxToolOutputChars} chars]`;

    console.log(
      `[compaction] truncated ${ctx.toolCall.name} result: `
      + `${original.length} → ${settings.maxToolOutputChars} chars`,
    );

    return {
      content: [{ type: 'text', text: truncated }],
      details: truncated,
    };
  };
}

/**
 * Creates a transformContext hook for auto-compaction.
 */
export function createTransformContext(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  model: Model<any>,
  contextWindow: number,
  getApiKey: (provider: string) => string | undefined,
  settings: CompactionSettings = DEFAULT_SETTINGS,
): (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]> {
  return async (messages: AgentMessage[]) => {
    const { tokens } = estimateContextTokens(messages);
    const threshold = contextWindow - settings.reserveTokens;

    if (tokens <= threshold) return messages;

    console.log(
      `[compaction] context ${tokens} tokens exceeds threshold ${threshold}, compacting...`,
    );

    const cutIndex = findCutPoint(messages, settings.keepRecentTokens);
    if (cutIndex <= 0) return messages; // nothing to cut

    const toSummarize = messages.slice(0, cutIndex);
    const toKeep = messages.slice(cutIndex);

    let summaryText: string;
    try {
      const apiKey = getApiKey(model.provider);
      if (!apiKey) throw new Error('No API key for summarization');
      summaryText = await generateSummary(toSummarize, model, apiKey, settings.reserveTokens);
    } catch (e) {
      console.warn('[compaction] summarization failed, falling back to naive truncation:', e);
      // Fallback: drop old messages without summary
      return toKeep;
    }

    const summaryMessage: AgentMessage = {
      role: 'user',
      content: `[Context Summary — earlier conversation was compacted]\n\n${summaryText}`,
      timestamp: Date.now(),
    } as AgentMessage;

    const keptTokens = estimateContextTokens([summaryMessage, ...toKeep]).tokens;
    console.log(
      `[compaction] compacted: ${tokens} → ~${keptTokens} tokens `
      + `(summarized ${toSummarize.length} messages, kept ${toKeep.length})`,
    );

    return [summaryMessage, ...toKeep];
  };
}
