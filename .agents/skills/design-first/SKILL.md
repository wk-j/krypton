---
name: design-first
description: Before writing any code for a new feature or significant improvement, perform deep research then write an implementation specification in docs/ and wait for explicit user approval. No code is written until the spec is approved.
---

## What I do

Enforce a design-first workflow. Every new feature or significant change requires:
1. **Deep research** — understand how the feature works in the wild, what prior art exists, what constraints apply
2. **A written implementation spec** — concrete enough to implement without further questions
3. **User approval** — no code until approved

This prevents wasted effort, catches design issues early, and creates a permanent record of decisions and their rationale.

## When to use me

Use this skill whenever:
- Implementing a **new feature** (new module, new mode, new UI element, new command)
- Making a **significant change** to existing behavior (architectural refactor, new data flow, mode system changes)
- Adding a **new subsystem** (new Rust crate integration, new frontend module)
- The implementation involves **3+ files** or touches **2+ subsystems** (backend + frontend)

## When NOT to use me

Skip this skill for:
- Bug fixes where the fix is obvious (e.g., typo, wrong variable, off-by-one)
- One-line changes (e.g., passing an existing value to an existing function)
- Documentation-only changes
- Config value changes
- The user explicitly says "just do it" or "skip the spec"

## Steps

### 1. Deep Research

Before writing the spec, research the feature thoroughly. Research informs the design — skip it and you risk speccing the wrong thing.

**Codebase research (always):**
- Read all relevant existing code — don't just skim, understand how it works
- Read `docs/PROGRESS.md` for milestone context
- Read `docs/04-architecture.md` and `docs/05-data-flow.md` for system design
- Grep for related symbols, patterns, and TODOs that touch this area
- Identify all files and modules that will be affected

**External research (for non-trivial features):**
- Search the web for how similar terminal emulators or tools implement this feature (e.g., "kitty terminal multiplexer protocol", "xterm.js selection API", "VT100 escape sequences for X")
- Look for relevant RFCs, specifications, or standards (e.g., ANSI escape codes, OSC sequences, W3C specs)
- Look for reference implementations in open-source projects (tmux, kitty, alacritty, wezterm, etc.)
- Check crate docs / MDN / library changelogs for API details that affect the design
- Note API constraints discovered during research (what the library can/can't do)

**Market comparison (always for user-facing features):**
- Identify whether this feature already exists in popular apps — terminal emulators (iTerm2, WezTerm, Kitty, Alacritty, Hyper), multiplexers (tmux, Zellij), or productivity tools (VS Code, Zed, Nova, Warp) if the feature is more general
- Document exactly how those apps implement it: what the UX looks like, what keyboard shortcuts they use, what limitations they have
- Note where Krypton's implementation should match the convention (familiarity) and where it should deliberately differ (keyboard-first, cyberpunk aesthetic, no mouse dependency)
- If the feature is novel and has no market equivalent, say so explicitly

**Summarize findings** — before writing the spec, write a short "Research Notes" section capturing what you found. This goes in the spec as the `## Research` section.

### 2. Write the Spec

Create a markdown file at `docs/<NN>-<feature-name>.md` (following the existing numbering convention) using the template below.

The spec must be **concrete and specific** — not aspirational. It should contain enough detail that someone could implement it without further questions. All external resources discovered during research must be listed in the `## Resources` section.

#### Spec Template

```markdown
# <Feature Name> — Implementation Spec

> Status: Draft | Approved | Implemented
> Date: YYYY-MM-DD
> Milestone: M<N> — <name>

## Problem

What is the user-facing problem or missing capability? 1-3 sentences.

## Solution

High-level approach in 2-5 sentences. Summarize the chosen approach and why it was selected over alternatives.

## Research

Key findings from research that shaped this design. Include:
- Relevant API capabilities or constraints discovered
- Any prior art in this codebase (related TODOs, half-finished work, etc.)
- Alternatives considered and why they were ruled out

## Prior Art

How popular apps implement this feature (or the closest equivalent). Be specific — not "tmux has panes" but "tmux uses `prefix %` / `prefix "` to split; pane borders are drawn with box-drawing characters; resize is `prefix M-arrow`".

| App | Implementation | Notes |
|-----|---------------|-------|
| iTerm2 | ... | ... |
| WezTerm | ... | ... |
| tmux | ... | ... |
| _add others_ | ... | ... |

**Krypton delta** — where this design matches convention (for familiarity) and where it intentionally diverges (keyboard-first, no mouse dependency, cyberpunk aesthetic). If the feature has no market equivalent, state that here.

## Affected Files

| File | Change |
|------|--------|
| `path/to/file` | Brief description of what changes |

## Design

### Data Structures

New types, structs, interfaces, enums. Show the actual signatures.

### API / Commands

New Tauri commands, IPC events, or public methods. Show signatures and payload types.

### Data Flow

Step-by-step flow of how data moves through the system for the primary use case.
Use numbered steps like:

```
1. User does X
2. Module A calls B
3. B emits event C
4. Frontend receives C and does D
```

### Keybindings (if applicable)

| Key | Context | Action |
|-----|---------|--------|
| `v` | Compositor mode | Enter selection mode |

### UI Changes (if applicable)

Describe any DOM structure changes, new CSS classes, or visual elements.

### Configuration (if applicable)

New TOML config keys with types and defaults.

## Edge Cases

List edge cases and how they're handled.

## Open Questions

Any unresolved design decisions. These must be resolved before approval.

## Out of Scope

What this spec explicitly does NOT cover (to prevent scope creep).

## Resources

All external sources consulted during research. Format:
- [Title](URL) — one-line note on what it contributed to the design
- Crate/library docs, RFCs, reference implementations, MDN pages, etc.
- If no external research was needed, write "N/A — purely internal change."
```

### 3. Present for Approval

After writing the spec:
- Output a summary of the spec to the user
- Call out the key findings from research that shaped the design
- Summarize how popular apps handle this feature and where Krypton's design aligns or intentionally diverges
- List the key design decisions and any trade-offs made
- Highlight any open questions that need the user's input
- **Explicitly ask: "Should I proceed with this design?"**
- **STOP and WAIT for the user's response**

### 4. Handle Feedback

If the user:
- **Approves**: Update spec status to "Approved", then proceed to implementation
- **Requests changes**: Update the spec, present the changes, ask again
- **Rejects**: Update spec status to "Rejected", ask what approach they'd prefer

### 5. Implement

Once approved:
- Update spec status to "Approved"
- Implement the code following the spec
- If you discover during implementation that the spec needs changes, note the deviation and explain why
- After implementation, update spec status to "Implemented"

## Rules

1. **NEVER write implementation code before the spec is approved.** Reading code and web research is fine. Writing new code or editing existing code is not.
2. **Research before designing.** A spec written without research is a guess. External resources must appear in `## Resources`.
3. **The spec must be a file**, not just chat output. It persists as a design record.
4. **Open questions block approval.** All open questions must be resolved before asking for approval.
5. **The spec is a contract.** Deviations during implementation must be documented and justified.
6. **Keep specs concise.** A spec for a small feature should be ~80 lines. A complex feature ~200 lines. Never exceed 350 lines.
7. **One spec per feature.** Don't combine unrelated features in a single spec.

## Anti-patterns

- Writing code "just to explore" before the spec — use reading/grep/web search instead
- Skipping external research for non-trivial features — "I already know how to do this" is how bad designs happen
- Writing a vague spec that says "we'll figure it out during implementation"
- Skipping the approval gate and starting to code after writing the spec
- Writing the spec after the code is already written (post-hoc rationalization)
- Putting implementation details in the spec that belong in code comments
- Over-engineering the spec with UML diagrams or excessive formality
- Listing resources you didn't actually consult — only include sources that informed the design

## Spec File Conventions

- Location: `docs/<NN>-<feature-name>.md` (e.g., `docs/11-selection-mode.md`)
- Naming: numbered prefix following existing docs, kebab-case, descriptive
- Keep all specs even after implementation — they serve as design history
- Update the status field as the spec progresses through its lifecycle
