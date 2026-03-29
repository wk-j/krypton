# pi-mono Reference

Local repo: `/Users/wk/Source/pi-mono`

Use this skill whenever working on agent integration (`src/agent/`), adding tools, changing model/provider, debugging events, or anything touching `@mariozechner/pi-agent-core` or `@mariozechner/pi-ai`.

**Always read the local source — it is the ground truth. npm dist types can lag.**

---

## Packages

| Package | npm name | Path |
|---------|----------|------|
| Agent core | `@mariozechner/pi-agent-core` | `packages/agent/` |
| LLM abstraction | `@mariozechner/pi-ai` | `packages/ai/` |
| Coding agent SDK | `@mariozechner/pi-coding-agent` | `packages/coding-agent/` |
| Terminal UI | `@mariozechner/pi-tui` | `packages/tui/` |
| Web UI | `@mariozechner/pi-web-ui` | `packages/web-ui/` |

---

## pi-agent-core

### Key files
- `packages/agent/src/agent.ts` — Agent class (all methods)
- `packages/agent/src/types.ts` — AgentEvent union, AgentTool, AgentToolResult, AgentOptions
- `packages/agent/src/agent-loop.ts` — runAgentLoop, tool execution logic
- `packages/agent/test/agent.test.ts` — usage patterns

### AgentOptions (constructor)
```typescript
interface AgentOptions {
  initialState?: Partial<AgentState>;       // systemPrompt, model, tools, messages, thinkingLevel
  getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
  streamFn?: StreamFn;                      // custom stream function
  toolExecution?: "parallel" | "sequential"; // default: "parallel"
  convertToLlm?: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
  transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
  beforeToolCall?: (ctx: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined>;
  afterToolCall?: (ctx: AfterToolCallContext, signal?: AbortSignal) => Promise<AfterToolCallResult | undefined>;
  sessionId?: string;
  transport?: "sse" | "websocket" | "auto";
  maxRetryDelayMs?: number;
  steeringMode?: "all" | "one-at-a-time";
  followUpMode?: "all" | "one-at-a-time";
  onPayload?: SimpleStreamOptions["onPayload"];
  thinkingBudgets?: ThinkingBudgets;
}
```

### Agent public API
```typescript
// Prompting
agent.prompt(text: string): Promise<void>
agent.prompt(msg: AgentMessage | AgentMessage[]): Promise<void>
agent.continue(): Promise<void>

// State setters
agent.setSystemPrompt(v: string): void
agent.setModel(m: Model<any>): void
agent.setThinkingLevel(l: ThinkingLevel): void
agent.setTools(t: AgentTool[]): void
agent.replaceMessages(ms: AgentMessage[]): void
agent.appendMessage(m: AgentMessage): void
agent.clearMessages(): void
agent.reset(): void

// Control
agent.subscribe(fn: (e: AgentEvent) => void): () => void  // returns unsubscribe fn
agent.abort(): void
agent.waitForIdle(): Promise<void>

// Steering / follow-up (inject messages mid-run)
agent.steer(m: AgentMessage): void
agent.followUp(m: AgentMessage): void

// State
agent.state: AgentState  // .isStreaming, .messages, .error, .model, .tools, .systemPrompt
```

### AgentEvent — complete union
```typescript
type AgentEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; messages: AgentMessage[] }       // messages[last].errorMessage on error
  | { type: "turn_start" }
  | { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
  | { type: "message_start"; message: AgentMessage }
  | { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
  | { type: "message_end"; message: AgentMessage }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: any }
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; args: any; partialResult: any }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: AgentToolResult<any>; isError: boolean }
```

**Errors**: `agent_end` is emitted even on error. Check `messages[messages.length - 1].errorMessage` on the last message in `e.messages`. The loop never throws — errors are encoded in the stream.

### AssistantMessageEvent — complete union
```typescript
type AssistantMessageEvent =
  | { type: "start"; partial: AssistantMessage }
  | { type: "text_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "text_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "text_end"; contentIndex: number; content: string; partial: AssistantMessage }
  | { type: "thinking_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "thinking_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "thinking_end"; contentIndex: number; content: string; partial: AssistantMessage }
  | { type: "toolcall_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "toolcall_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall; partial: AssistantMessage }
  | { type: "done"; reason: StopReason; message: AssistantMessage }
  | { type: "error"; reason: "aborted" | "error"; error: AssistantMessage }
```

**Streaming text**: listen for `message_update` where `assistantMessageEvent.type === "text_delta"` and read `assistantMessageEvent.delta`.

### AgentTool definition
```typescript
interface AgentTool<TParameters extends TSchema = TSchema, TDetails = any> extends Tool<TParameters> {
  label: string;  // shown in UI
  execute: (
    toolCallId: string,
    params: Static<TParameters>,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback<TDetails>,
  ) => Promise<AgentToolResult<TDetails>>;
}

interface AgentToolResult<T> {
  content: (TextContent | ImageContent)[];  // sent to LLM as tool result
  details: T;                               // shown in UI (use result.details for display text)
}
```

**Tool errors**: throw inside `execute()` — pi-agent-core catches it and creates an error tool result automatically.

### Minimal Agent example
```typescript
import { Agent } from "@mariozechner/pi-agent-core";
import { getModel } from "@mariozechner/pi-ai";

const agent = new Agent({
  initialState: {
    systemPrompt: "You are helpful.",
    model: getModel("zai", "glm-5"),
    tools: [],
  },
  getApiKey: (provider) => provider === "zai" ? process.env.ZAI_API_KEY : undefined,
  toolExecution: "sequential",
});

const unsub = agent.subscribe((e) => {
  if (e.type === "message_update" && e.assistantMessageEvent.type === "text_delta") {
    process.stdout.write(e.assistantMessageEvent.delta);
  }
  if (e.type === "agent_end") {
    const last = e.messages[e.messages.length - 1];
    if (last?.errorMessage) console.error("Error:", last.errorMessage);
  }
});

await agent.prompt("Hello");
unsub();
```

---

## pi-ai

### Key files
- `packages/ai/src/models.ts` — getModel, getModels, getProviders
- `packages/ai/src/models.generated.ts` — all providers and model IDs
- `packages/ai/src/types.ts` — AssistantMessageEvent, Message types, Tool, Context
- `packages/ai/src/stream.ts` — streamSimple, completeSimple

### getModel
```typescript
function getModel<TProvider extends KnownProvider, TModelId extends keyof MODELS[TProvider]>(
  provider: TProvider,
  modelId: TModelId,
): Model<...>
```

Throws at **compile time** if provider or modelId is wrong — use exact string literals.

### KnownProvider values
```
amazon-bedrock | anthropic | google | google-gemini-cli | google-antigravity | google-vertex
openai | azure-openai-responses | openai-codex | github-copilot
xai | groq | cerebras | openrouter | vercel-ai-gateway
zai | mistral | minimax | minimax-cn | huggingface | opencode | opencode-go | kimi-coding
```

### ZAI provider models
All at `baseUrl: "https://api.z.ai/api/coding/paas/v4"`, api: `openai-completions`, env var: `ZAI_API_KEY`.

| Model ID | Notes |
|----------|-------|
| `glm-4.5` | reasoning, 131k ctx |
| `glm-4.5-air` | lighter, 131k ctx |
| `glm-4.5-flash` | free tier |
| `glm-4.5v` | vision, 64k ctx |
| `glm-4.6` | 204k ctx |
| `glm-4.6v` | vision variant |
| `glm-4.7` | latest stable |
| `glm-4.7-flash` | fast variant |
| `glm-5` | reasoning, 204k ctx |
| `glm-5-turbo` | faster glm-5 |

All ZAI models have `reasoning: true` and `thinkingFormat: "zai"`. Thinking is **off by default** unless `thinkingLevel` is set.

### Message types
```typescript
type Message = UserMessage | AssistantMessage | ToolResultMessage

// Key fields:
AssistantMessage.errorMessage?: string  // set on error stop
AssistantMessage.stopReason: "stop" | "length" | "toolUse" | "error" | "aborted"
ToolResultMessage.details?: T           // display value (same as AgentToolResult.details)
ToolResultMessage.isError: boolean
```

---

## pi-coding-agent

### Key files
- `packages/coding-agent/src/core/sdk.ts` — createAgentSession
- `packages/coding-agent/src/core/auth-storage.ts` — AuthStorage
- `packages/coding-agent/src/core/model-registry.ts` — ModelRegistry
- `packages/coding-agent/src/tools/` — all built-in tool implementations
- `packages/coding-agent/examples/sdk/` — runnable examples

### Built-in tools
```typescript
// Fixed to process.cwd()
readTool | bashTool | editTool | writeTool | grepTool | findTool | lsTool
codingTools  // [read, bash, edit, write]
readOnlyTools  // [read, ls, find, grep]

// With custom cwd (preferred)
createReadTool(cwd) | createBashTool(cwd) | createEditTool(cwd) | createWriteTool(cwd)
createGrepTool(cwd) | createFindTool(cwd) | createLsTool(cwd)
createCodingTools(cwd) | createReadOnlyTools(cwd)
withFileMutationQueue(tools)  // serializes concurrent file writes
```

### createAgentSession options
```typescript
interface CreateAgentSessionOptions {
  cwd?: string;
  agentDir?: string;             // default: ~/.pi/agent
  authStorage?: AuthStorage;
  modelRegistry?: ModelRegistry;
  model?: Model<any>;
  thinkingLevel?: ThinkingLevel;
  tools?: Tool[];
  sessionManager?: SessionManager;
  settingsManager?: SettingsManager;
  resourceLoader?: ResourceLoader;
}
```

### AuthStorage
```typescript
const auth = AuthStorage.create();               // uses ~/.pi/agent/auth.json
auth.setRuntimeApiKey("zai", apiKey);           // in-memory, not persisted
auth.saveApiKey("zai", apiKey);                 // persisted to disk
```

### SDK examples
| File | What it shows |
|------|--------------|
| `examples/sdk/01-minimal.ts` | Minimal usage, stream text_delta |
| `examples/sdk/02-custom-model.ts` | Pick model, set thinkingLevel |
| `examples/sdk/03-custom-prompt.ts` | Override system prompt |
| `examples/sdk/05-tools.ts` | Tool configuration, custom cwd |
| `examples/sdk/06-extensions.ts` | Register custom tools via ExtensionFactory |
| `examples/sdk/09-api-keys-and-oauth.ts` | Runtime API key injection |
| `examples/sdk/11-sessions.ts` | Session persistence and resumption |
| `examples/sdk/12-full-control.ts` | Full override of all subsystems |

---

## Common patterns

### Read tool result text in tool_execution_end
```typescript
// result is AgentToolResult<T>
const text = typeof result.details === "string"
  ? result.details
  : result.content.find(c => c.type === "text")?.text ?? "";
```

### Check for agent error after agent_end
```typescript
agent.subscribe((e) => {
  if (e.type === "agent_end") {
    const last = e.messages[e.messages.length - 1] as any;
    if (last?.errorMessage) {
      // surface last.errorMessage to user
    }
  }
});
```

### Abort in-flight run
```typescript
agent.abort();
// agent_end is still emitted with aborted stopReason
await agent.waitForIdle(); // optional: wait for cleanup
```
