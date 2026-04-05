# Agent Model Configuration — Implementation Spec

> Status: Implemented
> Date: 2026-04-05
> Milestone: M8 — Polish

## Problem

The AI agent is hardcoded to ZAI's `glm-4.7` model. Users who want to run local models via Ollama or switch between cloud providers must edit source code. There's no way to define model presets and quickly switch between them.

## Solution

Add an `[agent]` section to `krypton.toml` with a **model registry** (`[[agent.models]]`) and an `active` field to select which model to use. Users define named presets once, then switch by changing a single line. Ollama is supported via the existing `openai-completions` API in `pi-ai` — no new dependencies needed.

## Affected Files

| File | Change |
|------|--------|
| `src-tauri/src/config.rs` | Add `AgentConfig` + `AgentModelConfig` structs |
| `src/agent/agent.ts` | Read agent config via IPC, build model from active preset |
| `docs/06-configuration.md` | Document `[agent]` config section |
| `docs/53-ollama-provider-support.md` | This spec |

## Design

### Data Structures

**Rust:**

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct AgentConfig {
    pub active: String,                  // name of the active model preset
    pub models: Vec<AgentModelConfig>,   // named model presets
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentModelConfig {
    pub name: String,           // unique preset name, e.g. "zai", "ollama-gemma4"
    pub provider: String,       // "zai", "ollama", "openai", "anthropic", etc.
    pub model: String,          // "glm-4.7", "gemma4:latest", "gpt-4o", etc.
    pub base_url: String,       // API endpoint URL
    pub api_key_env: String,    // env var name for API key (empty = no key needed)
    pub context_window: u32,    // model's context window in tokens
    pub max_tokens: u32,        // max output tokens
}
```

Default: one preset — the current ZAI config — set as active. Existing users see no behavior change.

```rust
impl Default for AgentConfig {
    fn default() -> Self {
        Self {
            active: "zai".into(),
            models: vec![AgentModelConfig {
                name: "zai".into(),
                provider: "zai".into(),
                model: "glm-4.7".into(),
                base_url: "https://api.z.ai/api/coding/paas/v4".into(),
                api_key_env: "ZAI_API_KEY".into(),
                context_window: 128000,
                max_tokens: 8192,
            }],
        }
    }
}
```

**TypeScript — config shape returned via IPC:**

```typescript
interface AgentModelConfig {
  name: string;
  provider: string;
  model: string;
  base_url: string;
  api_key_env: string;
  context_window: number;
  max_tokens: number;
}

interface AgentConfig {
  active: string;
  models: AgentModelConfig[];
}
```

### API / Commands

No new IPC commands. The existing `get_config` command returns the full `KryptonConfig` — adding `agent: AgentConfig` to the struct makes it available automatically.

### Data Flow

```
1. User defines model presets in krypton.toml under [[agent.models]]
2. User sets agent.active = "ollama-gemma4" to switch
3. Rust loads config, AgentConfig deserialized with defaults
4. Frontend calls get_config → finds active preset by name
5. buildAgent() constructs Model from preset:
   a. Try pi-ai registry: getModel(provider, model) + override baseUrl
   b. Fallback: construct Model manually with api = "openai-completions"
6. If api_key_env is non-empty → read that env var via get_env_var
7. If api_key_env is empty → skip key (local models)
8. Agent runs against configured endpoint
```

### Configuration

```toml
[agent]
active = "zai"                          # which preset to use

[[agent.models]]
name = "zai"
provider = "zai"
model = "glm-4.7"
base_url = "https://api.z.ai/api/coding/paas/v4"
api_key_env = "ZAI_API_KEY"
context_window = 128000
max_tokens = 8192

[[agent.models]]
name = "ollama-gemma4"
provider = "ollama"
model = "gemma4:latest"
base_url = "http://localhost:11434/v1"
api_key_env = ""
context_window = 128000
max_tokens = 8192

[[agent.models]]
name = "openai-gpt4o"
provider = "openai"
model = "gpt-4o"
base_url = "https://api.openai.com/v1"
api_key_env = "OPENAI_API_KEY"
context_window = 128000
max_tokens = 16384
```

**Switching models** — change one line:

```toml
active = "ollama-gemma4"
```

### Model Construction in buildAgent()

```typescript
private async buildAgent(apiKey: string | null, preset: AgentModelConfig): Promise<any> {
  const [{ Agent }, { getModel }] = await Promise.all([
    import('@mariozechner/pi-agent-core'),
    import('@mariozechner/pi-ai'),
  ]);

  let model;
  try {
    // Try pi-ai registry first (works for zai, openai, anthropic, etc.)
    model = {
      ...getModel(preset.provider, preset.model),
      baseUrl: preset.base_url,
      contextWindow: preset.context_window,
      maxTokens: preset.max_tokens,
    };
  } catch {
    // Fallback: construct OpenAI-compatible model manually (ollama, vllm, lm-studio)
    model = {
      id: preset.model,
      name: `${preset.provider}/${preset.model}`,
      api: 'openai-completions',
      provider: preset.provider,
      baseUrl: preset.base_url,
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: preset.context_window,
      maxTokens: preset.max_tokens,
    };
  }

  this.modelContextWindow = model.contextWindow;

  const getApiKey = (_provider: string): string | undefined =>
    apiKey ?? undefined;

  // ... rest unchanged
}
```

### API Key Retrieval

Updated `prompt()` flow:

1. Read `agentConfig` from `get_config` IPC
2. Find active preset: `agentConfig.models.find(m => m.name === agentConfig.active)`
3. If preset's `api_key_env` is non-empty → read that env var via `get_env_var`
4. If `api_key_env` is empty → pass `null` (local models like Ollama)
5. Pass key + preset to `buildAgent()`

## Edge Cases

- **Ollama not running**: Connection error surfaced in agent view via existing error path.
- **Invalid model name in Ollama**: Ollama returns an error. Same error path.
- **Unknown active preset name**: Fall back to first model in the list. If list is empty, use hardcoded ZAI default.
- **Hot-reload**: Changing `active` takes effect on next agent `reset()` (new session). Matches the lazy-init pattern where `this.agent = null` triggers re-build.
- **Missing `[agent]` section**: `#[serde(default)]` provides ZAI defaults — fully backward compatible.
- **Empty models list**: Default implementation provides the ZAI preset.

## Out of Scope

- Runtime model switching UI (command palette picker) — future enhancement
- Ollama model pull/management from within Krypton
- Per-model compaction tuning (chars-per-token varies — current estimate is adequate)
- Tool calling compatibility checks (user's responsibility to pick a capable model)
