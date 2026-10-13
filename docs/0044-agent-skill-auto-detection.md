# Agent Skill Auto-Detection — Implementation Spec

> Status: Implemented
> Date: 2026-03-30
> Milestone: M3 — AI Agent

## Problem

Krypton's AI agent has no awareness of the project's Claude Code skills (`.claude/skills/`, `.agents/skills/`). These skills contain valuable workflow instructions (design-first, feature-implementation, etc.) that the agent should follow automatically when relevant.

## Solution

On each user prompt, scan skill directories for `SKILL.md` files and `.claude/commands/*.md` files, match their `description` field against the user's input using keyword matching, and inject matched skill content into the system prompt via `agent.setSystemPrompt()` before the LLM call. A lightweight skill index (name + description + trigger keywords) is built once at agent init; full skill content is only loaded when matched.

Custom commands (`.claude/commands/*.md`) are additionally registered as slash commands, invocable via `/command-name [args]`. The `$ARGUMENTS` placeholder in command bodies is replaced with user-provided arguments at runtime.

## Affected Files

| File | Change |
|------|--------|
| `src/agent/skills.ts` | **New** — skill scanner, matcher, and loader |
| `src/agent/agent.ts` | Call skill matcher before each prompt, update system prompt |
| `src/agent/agent-view.ts` | Show active skills indicator in UI (optional, minimal) |
| `src/agent/index.ts` | Export new types |

## Design

### Data Structures

```typescript
interface SkillMeta {
  name: string;
  description: string;
  path: string;           // absolute path to SKILL.md or command .md
  isCommand: boolean;     // true for .claude/commands/ files
}

interface SkillMatch {
  skill: SkillMeta;
  score: number;          // 1.0 for LLM-matched or forced skills
}
```

### Skill Discovery (`skills.ts`)

```typescript
/** Scan all skill sources and build index. Called once at agent init. */
async function discoverSkills(projectDir: string): Promise<SkillMeta[]>

/** Match user input against skill index. Returns skills sorted by score. */
function matchSkills(input: string, skills: SkillMeta[], threshold?: number): SkillMatch[]

/** Load skill/command content. For commands, replaces $ARGUMENTS with args. */
async function loadSkillContent(skill: SkillMeta, args?: string): Promise<string>
```

**Discovery** scans four locations:

1. `<projectDir>/.claude/skills/*/SKILL.md` — Krypton skill format (priority)
2. `<projectDir>/.agents/skills/*/SKILL.md` — Krypton skill format
3. `~/.claude/commands/*.md` — Claude Code user-global commands
4. `<projectDir>/.claude/commands/*.md` — Claude Code project commands (overrides global)

Deduplicates by `name` (`.claude/skills/` takes priority over `.agents/skills/`; project commands override user-global commands; skills take priority over commands with the same name).

### Claude Code Command Format

Command files use the Claude Code convention:
- **Location**: `.claude/commands/<name>.md` (project) or `~/.claude/commands/<name>.md` (global)
- **Name**: derived from filename (e.g., `review.md` → `review`)
- **Frontmatter**: optional `description:` field; if absent, first 80 chars of body used
- **`$ARGUMENTS`**: placeholder in body replaced with user-provided args at invocation
- **Invocation**: `/command-name [args]` in the agent prompt (registered as slash commands)

**Matching**: Uses LLM-based classification. On each prompt, a lightweight API call sends the skill catalog (names + descriptions) and the user's input to the same model. The LLM returns a JSON array of relevant skill names. This replaces the earlier keyword-matching approach for more accurate and context-aware skill selection. Falls back gracefully (no skills) on API failure.

### Data Flow

**Auto-matched skills (keyword matching):**
```
1. User types prompt text
2. AgentController.prompt(text) is called
3. matchSkills(text, this.skillIndex) returns matched skills
4. For each matched skill, loadSkillContent() reads the full file
5. System prompt is rebuilt: BASE_SYSTEM_PROMPT + cwd + skill instructions
6. agent.setSystemPrompt(newPrompt) updates the pi-agent-core state
7. agent.prompt(text) runs with skill-aware system prompt
8. After the turn, system prompt reverts to base (no sticky injection)
```

**Custom command invocation (`/command-name args`):**
```
1. User types /review fix the login bug
2. AgentView.handleCustomCommand() finds the "review" command skill
3. controller.setForcedSkill("review") queues the command
4. controller.prompt("fix the login bug", callback, "fix the login bug") called
5. applySkills() loads command body, replaces $ARGUMENTS with args
6. System prompt is rebuilt with command content injected
7. agent.prompt() runs with command-aware system prompt
8. After the turn, system prompt reverts to base
```

### Slash Commands

```
/skills           — List all discovered skills and commands (commands tagged [cmd])
/skill <name>     — Force-activate a skill for next prompt
/<command-name>   — Invoke a custom command from .claude/commands/
```

### UI Changes

When skills are active for a turn, the agent label briefly shows which skills matched (e.g., `AI [design-first]`). This is informational only — displayed as part of the assistant message label.

## Edge Cases

- **No skills directory exists**: `discoverSkills` returns empty array, no error
- **Malformed SKILL.md (no frontmatter)**: Name derived from directory name; description empty
- **Command .md without frontmatter**: Name from filename, description from first 80 chars of body
- **Multiple skills match**: All matched skills are injected (concatenated with separators)
- **Skill content is very large**: Cap injected skill content at 4000 chars per skill
- **User says `/skill nonexistent`**: Show system message listing available skills
- **Duplicate skill names across directories**: `.claude/skills/` wins over `.agents/skills/`; skills win over commands
- **Duplicate command names**: Project-level `.claude/commands/` overrides `~/.claude/commands/`
- **Command without `$ARGUMENTS`**: Body injected as-is; args ignored
- **Command with no args**: `$ARGUMENTS` replaced with empty string

## Open Questions

None.

## Out of Scope

- Skill-defined tools (skills adding custom agent tools)
- Skill chaining or dependency resolution
- Remote/shared skills
- Skill output validation (checking if the agent followed the skill instructions)
