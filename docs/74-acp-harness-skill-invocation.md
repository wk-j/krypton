# ACP Harness Skill Discoverability — Implementation Spec

> Status: Draft
> Date: 2026-05-02
> Milestone: M5 — ACP Harness

## Problem

Users running ACP lanes in Krypton (Claude Code, Gemini, Codex) can already invoke `/<skill-name>` because each agent loads `.claude/skills/` on its own. The remaining gap is **discoverability**: a user looking at the harness composer has no way to see which skills exist without `ls`-ing the skills directory or asking the agent. This makes skills feel hidden and discourages use.

## Solution

Add a slash-prefixed autocomplete dropdown to the harness composer. When the user types `/` at the start of the draft, scan project + user-global skill directories and surface the list as a filter-as-you-type picker. Selecting an entry inserts `/<name> ` into the draft; pressing Enter sends it as an ordinary user turn. **The harness does not expand, intercept, or otherwise inspect skill bodies** — that stays the agent's job.

This is deliberately scoped to discoverability only. We previously considered harness-side skill expansion and rejected it (see Research below).

## Research

**Verified agent-side skill behavior (tested live in this Krypton session):**

| Agent | Mechanism | UX cost |
|-------|-----------|---------|
| Claude Code (ACP server) | Built-in `Skill` tool exposed to the model + auto-trigger via system-prompt skill catalog | Silent, instant; no tool roundtrip visible to user |
| Gemini (ACP server) | Built-in skill loader; activates skill before responding | Surfaces a `PERM` prompt ("activate design-first?") |
| Codex (ACP server) | No first-class skill loader; the model recognises the convention and opens the file with `Read` | 2–3 tool calls visible (read SKILL.md, optional `memory_search`, then act) |

All three respond correctly to a literal `/<skill-name>` typed in the harness composer. **Harness-side expansion would override Claude's auto-trigger and waste tokens on Gemini's existing loader**, while only marginally helping Codex (which already works, just with extra tool roundtrips visible).

**Existing infrastructure we can reuse:**
- `src/agent/skills.ts` exports `discoverSkills(projectDir)` and parses YAML frontmatter (`name`, `description`). Used by the agent view today.
- `discoverSkills` currently scans project-level `.claude/skills/`, `.agents/skills/`, `.claude/commands/` and user-global `.claude/commands/`. **It does not scan user-global `~/.claude/skills/`** — every Claude Code user has skills there, so we extend the scanner.
- The harness composer already supports filter-as-you-type behavior in other contexts (`renderComposer` in `src/acp/acp-harness-view.ts`).

**Why we are not doing harness-side expansion:**
- Duplicates work all three agents already do.
- Forces a uniform UX, but in practice each agent's UX is appropriate to its safety model (Claude silent, Gemini permissioned, Codex transparent).
- Locks Krypton out of model-driven auto-trigger improvements that ship on the agent side.

## Prior Art

| App | Implementation | Notes |
|-----|----------------|-------|
| Claude Code (CLI) | `/` opens a slash command picker filtered by name + description | The UX we are matching. |
| Cursor | `/` opens a command palette listing custom commands from `.cursor/commands/` | Same shape — filter-as-you-type, Enter to insert. |
| Zed (with ACP agents) | Each ACP agent advertises commands via `available_commands`; client lists them | Different layer (protocol-level), but same end-user UX. We could subscribe to that capability later as an additional source. |
| Krypton agent view | `/skills` lists discovered skills as a transcript message | Less ergonomic than a dropdown but currently all we have. |

**Krypton delta:** Match Claude Code's picker shape (Tab/Enter to select, Esc to dismiss, fuzzy filter on name + description). Diverge by *only* inserting text — no expansion, no extra protocol calls, no Skill-as-tool. The dropdown is purely a draft-completion aid.

## Affected Files

| File | Change |
|------|--------|
| `src/skills.ts` | **New** — re-export of discovery from `src/agent/skills.ts` after extending it with user-global `~/.claude/skills/`. (Keeps the agent-view import path stable via re-export from the original location.) |
| `src/agent/skills.ts` | Add `~/.claude/skills/*/SKILL.md` to `discoverSkillFiles`. No signature change. |
| `src/acp/acp-harness-view.ts` | Discover skills on mount + on `cwd` change. Render dropdown when draft starts with `/`. Handle ↑/↓/Tab/Enter/Esc when dropdown is open. |
| `src/acp/types.ts` | Add `HarnessSkillEntry` type (small alias over `SkillMeta`). |
| `src/styles/acp-harness.css` | Style for `.acp-harness__skill-picker`, items, selected state. |
| `docs/PROGRESS.md` | Tick the milestone entry. |

No Rust changes. No new Tauri commands. No ACP layer changes.

## Design

### Discovery extension

In `src/agent/skills.ts`, extend `discoverSkillFiles`:

```ts
const homeDir = await invoke<string>('get_env_var', { name: 'HOME' }).catch(() => '');
const dirs = [
  ...(homeDir ? [`${homeDir}/.claude/skills`] : []),  // NEW: user-global skills
  `${projectDir}/.claude/skills`,
  `${projectDir}/.agents/skills`,
];
```

Project-level entries win on name collision (existing precedence already handles this via the `seen` set; we just prepend user-global so it's processed first and overridden by later dirs). Verify with a quick test that `~/.claude/skills/caveman` shows up in a project that also has `.claude/skills/cyberpunk-aesthetic`.

### Picker state

In `AcpHarnessView`:

```ts
private skillEntries: SkillMeta[] = [];                  // discovered skills
private skillPicker: {
  open: boolean;
  query: string;     // text after the leading "/"
  selectedIndex: number;
  filtered: SkillMeta[];
} = { open: false, query: '', selectedIndex: 0, filtered: [] };
```

`skillEntries` is rebuilt on:
- harness mount (`init` lifecycle, after `projectDir` resolves)
- `cwd` change

(No filesystem watcher — discovery is cheap and skills rarely change mid-session. Use `#restart` if a user adds a new skill.)

### Open / close rules

The picker opens when **all** are true:
- Composer focus is `text` (not transcript)
- Active lane is not in `permission` mode
- Draft starts with `/`
- Cursor is somewhere inside the leading slash token (no whitespace before cursor in the draft)

Closes on:
- Draft becomes empty or first character is no longer `/`
- User types a space (the slash token is committed)
- Esc pressed while open

### Filtering

Query is `lane.draft.slice(1, firstWhitespaceIndex)`. Filter `skillEntries` by:
1. Case-insensitive substring match on `name` (primary).
2. If no name matches, case-insensitive substring match on `description` (secondary, max 5 entries).
3. Sort by: starts-with-query first, then alphabetical.

Cap displayed list at 8 entries. If more match, show `+N more — keep typing` row.

### Keybindings (picker open)

| Key | Action |
|-----|--------|
| ↑ / Ctrl+P | Move selection up |
| ↓ / Ctrl+N | Move selection down |
| Tab | Insert `/<selected name> ` into draft, close picker |
| Enter | Same as Tab if selection exists; otherwise submit draft as-is |
| Esc | Close picker, leave draft unchanged |

These intercept inside the existing composer key handler — *only* while picker is open. Closed-state behavior is unchanged.

### Insertion

`/<name> ` (with trailing space) replaces the existing `/<query>` token. Cursor moves to after the trailing space. The draft is *not* submitted automatically — the user can type args before pressing Enter.

### UI

Dropdown is a fixed-position element anchored just above the composer, accent-colored per active lane. Each row:

```
/<name>           <description, dimmed, ellipsized>
```

Selected row gets the lane accent border + slight inverse fill. Mirror the cyberpunk aesthetic — sharp geometry, no border-radius, single-pixel glows, no `backdrop-filter: blur()`.

Empty state: `no skills match — Esc to dismiss`.

No state when closed (element removed from DOM).

### Discoverability of the picker itself

When a fresh harness lane shows the help footer (`renderHelp` in `acp-harness-view.ts`), add one line: `/ — list skills`. Single line, no other UX surface.

## Edge Cases

- **No skills discovered**: typing `/` shows `no skills available — install at ~/.claude/skills/<name>/SKILL.md`. Don't suppress the dropdown — the empty state is the discoverability answer.
- **`projectDir` is null**: only user-global `~/.claude/skills/` entries appear.
- **Skill with very long description**: truncated at 80 chars, ellipsized. Full text available on hover (CSS `title` attribute).
- **User types `//`**: not relevant — picker closes once first non-`/` char appears, but `//` keeps the picker visible filtering on `/` (which matches nothing). Acceptable; user can Esc.
- **User types `/word ` and edits back to `/wor`**: picker re-opens. Open/close is purely a function of current draft state.
- **Mouse click on dropdown row**: optional — supported in v1 because it's trivial (mousedown handler that re-uses the Tab path), and keyboard-first does not preclude mouse where it's free.
- **Picker open while agent finishes turn / sends tool call**: harmless — picker is composer-local UI, not lane-state-coupled.
- **Two skills with same name**: discovery dedupes (project beats user-global). Only one row shown.

## Out of Scope

- **Harness-side expansion of skill bodies**. Considered and rejected (see Research). Agents handle this themselves.
- **Auto-trigger from natural language**. Agent-side concern.
- **Slash command builtins** (`/help`, `/clear`, `/lane`). Separate spec if/when needed.
- **`//` escape for literal slash**. Not needed since we don't intercept agent traffic.
- **Filesystem watcher for hot-reload of skills**. `#restart` is a sufficient escape hatch.
- **Plugin skills** (`~/.claude/plugins/*/skills/`). Add later by extending `discoverSkillFiles` directories.
- **Subscription to ACP `available_commands` capability**. Different mechanism, different layer; revisit when more agents adopt it.

## Resources

- `docs/44-agent-skill-auto-detection.md` — original skill discovery design used by the agent view; this spec reuses its scanner.
- `docs/72-acp-harness-view.md` — ACP harness view architecture; relevant for composer rendering.
- `src/agent/skills.ts` — existing scanner being extended.
- `src/acp/acp-harness-view.ts:496` (`submitActiveLane`) — composer entry point we are *not* modifying (no interception in this spec).
- Live in-session verification of agent-side skill behavior:
  - Claude Code: this conversation's `Skill({skill: "design-first"})` invocation at the system level.
  - Gemini: user-reported `PERM other "design-first"` activation prompt.
  - Codex: user-reported `Read` of `.claude/skills/design-first/SKILL.md` followed by `memory_search`.
- [Agent Client Protocol — `available_commands`](https://github.com/zed-industries/agent-client-protocol) — out-of-scope alternative source for skill listings.
