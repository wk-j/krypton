# Agent Runtime Model Switching — Implementation Spec

> Status: Implemented
> Date: 2026-04-05
> Milestone: Agent UX

## Problem

The agent model is locked at init time — set by `agent.active` in `krypton.toml` and only read once. Users with multiple presets (e.g. `zai`, `ollama-gemma4`) must edit the TOML and restart a session to switch models.

## Solution

Extend the existing `/model` slash command to support switching between configured presets at runtime. `/model` shows current info + available presets. `/model <name>` switches to that preset, re-initializing the agent while preserving the session.

## Affected Files

| File | Change |
|------|--------|
| `src/agent/agent.ts` | Add `switchModel(presetName)` method, extract preset resolution into reusable helper, track active preset name |
| `src/agent/agent-view.ts` | Extend `/model` command handler to support `/model <name>` switching and list available presets |

## Design

### AgentController changes (`agent.ts`)

```ts
// New field to track active preset
private activePreset: AgentModelPreset | null = null;

// New public method
async switchModel(name: string): Promise<{ ok: boolean; error?: string }>;

// New helper extracted from prompt() lazy-init block
private async resolvePreset(name?: string): Promise<{ preset: AgentModelPreset; apiKey: string | null } | { error: string }>;

// New getter for UI
getActivePresetName(): string | null;
getAvailablePresets(): Promise<AgentModelPreset[]>;
```

**`switchModel(name)`** flow:
1. Call `resolvePreset(name)` to find the preset and resolve its API key
2. If error, return `{ ok: false, error }`
3. Abort any running prompt
4. Null out `this.agent` (forces re-init on next prompt with new preset)
5. Store the chosen preset so `prompt()` uses it instead of re-reading config
6. Return `{ ok: true }`

**`resolvePreset(name?)`** — extracted from the existing lazy-init block in `prompt()`. Reads config, finds the preset by name (or active default), resolves the API key. Used by both `prompt()` and `switchModel()`.

Key detail: conversation history is **not** cleared on model switch. The pi-agent-core `Agent` instance is nulled and rebuilt on next prompt, but the session file persists. The user can `/new` separately if they want a clean slate.

### AgentView `/model` command changes (`agent-view.ts`)

Current behavior: `/model` → shows model info.

New behavior:
- `/model` → shows current model + list of available presets
- `/model <name>` → switches to that preset

### Data Flow

```
1. User types `/model ollama-gemma4`
2. AgentView.handleSlashCommand parses args
3. AgentView calls controller.switchModel('ollama-gemma4')
4. switchModel calls resolvePreset('ollama-gemma4')
5. resolvePreset reads config via invoke('get_config'), finds preset, resolves API key
6. switchModel nulls this.agent, stores preset override
7. Returns { ok: true } → AgentView shows "Switched to ollama-gemma4"
8. Next user prompt triggers lazy init with the stored preset
```

## Edge Cases

- **Unknown preset name**: `resolvePreset` returns error, `/model` shows available names
- **Missing API key**: `resolvePreset` returns error with env var name
- **Switch while running**: `switchModel` aborts the current run first
- **No presets configured**: Shows helpful error message

## Out of Scope

- Persisting the runtime model choice back to `krypton.toml`
- Adding/editing presets from the UI
- Per-session model memory (always starts with config default)
