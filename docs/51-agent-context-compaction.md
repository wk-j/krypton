# Agent Context Compaction — Implementation Spec

> Status: Implemented
> Date: 2026-04-01
> Milestone: M8 — Polish

## Problem

The Krypton agent crashes with `Provider finish_reason: model_context_window_exceeded` when a single turn accumulates too many tool results (large file reads, verbose bash output). The `read_file` and `bash` tools return unbounded content, and there is no mechanism to prevent the context from exceeding the 128K token limit of glm-4.7.

## Solution

Add two layers of context management, modeled after Claude Code and pi-coding-agent:

1. **Tool result truncation** — Cap `read_file` and `bash` output via the `afterToolCall` hook so no single tool result blows up the context.
2. **Auto-compaction via `transformContext`** — Before each LLM call, estimate context tokens. When usage exceeds a threshold, summarize older messages and replace them with a compact summary, keeping recent messages intact.

Both use existing pi-agent-core hooks — no framework changes required.

## Affected Files

| File | Change |
|------|--------|
| `src/agent/agent.ts` | Wire `transformContext` and `afterToolCall` into `buildAgent()` |
| `src/agent/compaction.ts` | **New** — token estimation, compaction logic, summary generation |
| `src/agent/tools.ts` | Add `MAX_TOOL_OUTPUT_CHARS` constant (used by afterToolCall, not inline) |

## Design

### Constants

```typescript
// compaction.ts
const MAX_TOOL_OUTPUT_CHARS = 30_000;     // ~7500 tokens — truncate individual tool results
const RESERVE_TOKENS = 16_384;            // keep free for model output
const KEEP_RECENT_TOKENS = 20_000;        // preserve this many tokens of recent messages
const CHARS_PER_TOKEN = 4;                // conservative estimation ratio
```

### Data Structures

```typescript
// compaction.ts
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
```

### Layer 1: Tool Result Truncation (afterToolCall)

Registered in `buildAgent()` as the `afterToolCall` option. Runs after every tool execution. If the text content of a tool result exceeds `maxToolOutputChars`, it is truncated with a `[truncated]` marker.

```typescript
afterToolCall: async (ctx) => {
  const text = ctx.result.content
    ?.find(b => b.type === 'text')?.text;
  if (!text || text.length <= MAX_TOOL_OUTPUT_CHARS) return undefined;

  const truncated = text.slice(0, MAX_TOOL_OUTPUT_CHARS)
    + `\n\n[... truncated ${text.length - MAX_TOOL_OUTPUT_CHARS} chars]`;
  return {
    content: [{ type: 'text', text: truncated }],
    details: truncated,
  };
},
```

This prevents any single tool call from consuming more than ~7.5K tokens.

### Layer 2: Auto-Compaction (transformContext)

Registered in `buildAgent()` as the `transformContext` option. Called before every LLM request.

**Algorithm:**

```
1. Estimate total context tokens using last assistant message's usage.input
   (falls back to chars/4 heuristic for messages after last usage)
2. If tokens < contextWindow - reserveTokens → return messages unchanged
3. Walk backwards from newest message, accumulating token estimates
4. Stop when accumulated >= keepRecentTokens — this is the cut point
5. Never cut at a toolResult message (must follow its toolCall)
6. Serialize messages before cut point into text
7. Call the model with a summarization prompt to produce a compact summary
8. Replace discarded messages with a single user message containing the summary
9. Return [summaryMessage, ...keptMessages]
```

**Summarization prompt:**

```typescript
const COMPACTION_SYSTEM_PROMPT = 'You are a conversation summarizer. Be concise.';

const COMPACTION_USER_PROMPT = `Summarize this conversation for an AI assistant to continue the work.

Preserve:
- The user's goal and current task
- File paths, function names, error messages (exact strings)
- Key decisions and their rationale
- What was done vs what remains

<conversation>
{serialized_messages}
</conversation>

Respond with a structured summary under 500 words.`;
```

The summarization call uses the same model and API key as the main agent.

### Data Flow

```
1. User sends prompt → agent.prompt(text)
2. Agent loop calls transformContext(messages) before LLM request
3. transformContext:
   a. Reads usage.input from last assistant message
   b. Estimates trailing message tokens (chars/4)
   c. total = usage.input + trailing estimate
   d. If total < contextWindow - reserveTokens → return messages as-is
   e. Otherwise: find cut point, summarize, return compacted messages
4. Agent loop calls LLM with compacted messages
5. If LLM calls tools → afterToolCall truncates large results
6. Loop continues with manageable context size
```

### Token Estimation

Mirrors the pi-coding-agent approach:

```typescript
export function estimateTokens(message: AgentMessage): number {
  // Extract all text content from the message
  // Return Math.ceil(totalChars / CHARS_PER_TOKEN)
}

export function estimateContextTokens(
  messages: AgentMessage[],
  contextWindow: number,
): { tokens: number; needsCompaction: boolean } {
  // Use last assistant message's usage.input when available
  // Fall back to chars/4 heuristic for trailing messages
  // needsCompaction = tokens > contextWindow - RESERVE_TOKENS
}
```

### Integration in agent.ts

In `buildAgent()`, add the two hooks:

```typescript
return new Agent({
  initialState: { ... },
  getApiKey: ...,
  toolExecution: 'sequential',

  // NEW: truncate large tool results
  afterToolCall: createAfterToolCallHook(settings),

  // NEW: auto-compact when context is filling up
  transformContext: createTransformContext(model, this.modelContextWindow, settings, getApiKey),
});
```

Both `createAfterToolCallHook` and `createTransformContext` are exported from `compaction.ts`.

### AgentView Integration

When compaction fires, emit a `usage_update` event so the context percent display updates. No new UI is needed — the existing context percentage badge in agent-view already shows usage. Optionally log to console:

```
[agent] context compaction: 118K → 42K tokens (summarized 14 messages)
```

## Edge Cases

| Case | Handling |
|------|----------|
| First message exceeds context | afterToolCall truncation prevents this — no single result > 30K chars |
| Model refuses to summarize | Catch error, fall back to naive truncation (drop oldest messages without summary) |
| Compaction makes context too small | keepRecentTokens (20K) ensures enough recent context survives |
| Tool result has no text content (images) | afterToolCall returns undefined (no-op) for non-text results |
| Summarization call itself fails (network) | Log warning, return messages unchanged — the LLM call may still fail but we don't lose data |
| Multiple compactions in one turn | Each transformContext call is independent; if the agent does many tool calls in one turn, compaction can fire multiple times |

## Out of Scope

- Manual compaction trigger (e.g., `/compact` command in agent view)
- Compaction persistence to session JSONL (summaries are ephemeral, per-conversation)
- Configurable compaction settings in krypton.toml
- Context surgery UI in ContextView
- Streaming progress indicator during summarization
