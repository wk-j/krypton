# Agent Skill Auto-Detection — Implementation Spec

> Status: Implemented
> Date: 2026-03-30
> Milestone: M3 — AI Agent

## Problem

Krypton's AI agent has no awareness of the project's Claude Code skills (`.claude/skills/`, `.agents/skills/`). These skills contain valuable workflow instructions (design-first, feature-implementation, etc.) that the agent should follow automatically when relevant.

## Solution

On each user prompt, scan the skill directories for `SKILL.md` files, match their `description` field against the user's input using keyword matching, and inject matched skill content into the system prompt via `agent.setSystemPrompt()` before the LLM call. A lightweight skill index (name + description + trigger keywords) is built once at agent init; full skill content is only loaded when matched.

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
  path: string;           // absolute path to SKILL.md
  keywords: string[];     // extracted from description for matching
}

interface SkillMatch {
  skill: SkillMeta;
  score: number;          // match confidence (0-1)
}
```

### Skill Discovery (`skills.ts`)

```typescript
/** Scan skill directories and build index. Called once at agent init. */
async function discoverSkills(projectDir: string): Promise<SkillMeta[]>

/** Match user input against skill index. Returns skills sorted by score. */
function matchSkills(input: string, skills: SkillMeta[], threshold?: number): SkillMatch[]

/** Load full SKILL.md content for injection into system prompt. */
async function loadSkillContent(skill: SkillMeta): Promise<string>
```

**Discovery** scans two directories:
- `<projectDir>/.claude/skills/*/SKILL.md`
- `<projectDir>/.agents/skills/*/SKILL.md`

Deduplicates by `name` (`.claude/skills/` takes priority).

**Keyword extraction**: Split the `description` field on whitespace/punctuation, lowercase, remove stop words, keep words > 3 chars. Also include the skill `name` split on hyphens.

**Matching**: For each skill, compute a score based on how many of its keywords appear in the user's input (normalized by total keywords). Also check for explicit `/skill <name>` invocation (score = 1.0). Default threshold: 0.3.

### Data Flow

```
1. User types prompt text
2. AgentController.prompt(text) is called
3. matchSkills(text, this.skillIndex) returns matched skills
4. For each matched skill, loadSkillContent() reads the full SKILL.md
5. System prompt is rebuilt: BASE_SYSTEM_PROMPT + cwd + skill instructions
6. agent.setSystemPrompt(newPrompt) updates the pi-agent-core state
7. agent.prompt(text) runs with skill-aware system prompt
8. After the turn, system prompt reverts to base (no sticky injection)
```

### Slash Command

Add `/skills` to list discovered skills and their match status:

```
/skills           — List all discovered skills
/skill <name>     — Force-activate a skill for next prompt
```

### UI Changes

When skills are active for a turn, the agent label briefly shows which skills matched (e.g., `AI [design-first]`). This is informational only — displayed as part of the assistant message label.

## Edge Cases

- **No skills directory exists**: `discoverSkills` returns empty array, no error
- **Malformed SKILL.md (no frontmatter)**: Skip with console warning
- **Multiple skills match**: All matched skills are injected (concatenated with separators)
- **Skill content is very large**: Cap injected skill content at 4000 chars per skill
- **User says `/skill nonexistent`**: Show system message listing available skills
- **Duplicate skill names across directories**: `.claude/skills/` wins

## Open Questions

None.

## Out of Scope

- Skill-defined tools (skills adding custom agent tools)
- Skill chaining or dependency resolution
- Remote/shared skills
- Skill output validation (checking if the agent followed the skill instructions)
