---
name: design-first
description: Before writing any code for a new feature or significant improvement, write an implementation specification in docs/ and wait for explicit user approval. No code is written until the spec is approved.
---

## What I do

Enforce a design-first workflow. Every new feature or significant change requires a written implementation spec that the user must approve before any code is written. This prevents wasted effort, catches design issues early, and creates a permanent record of architectural decisions.

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

### 1. Gather Context

Before writing the spec:
- Read relevant existing code to understand the current architecture
- Read `docs/PROGRESS.md` for milestone context
- Read `docs/04-architecture.md` and `docs/05-data-flow.md` for system design
- Identify all files and modules that will be affected
- Identify any open questions or design trade-offs

### 2. Write the Spec

Create a markdown file at `docs/<NN>-<feature-name>.md` (following the existing numbering convention) using the template below.

The spec must be **concrete and specific** — not aspirational. It should contain enough detail that someone could implement it without further questions.

#### Spec Template

```markdown
# <Feature Name> — Implementation Spec

> Status: Draft | Approved | Implemented
> Date: YYYY-MM-DD
> Milestone: M<N> — <name>

## Problem

What is the user-facing problem or missing capability? 1-3 sentences.

## Solution

High-level approach in 2-5 sentences.

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
```

### 3. Present for Approval

After writing the spec:
- Output a summary of the spec to the user
- List the key design decisions
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

1. **NEVER write implementation code before the spec is approved.** Reading code for research is fine. Writing new code or editing existing code is not.
2. **The spec must be a file**, not just chat output. It persists as a design record.
3. **Open questions block approval.** All open questions must be resolved before asking for approval.
4. **The spec is a contract.** Deviations during implementation must be documented and justified.
5. **Keep specs concise.** A spec for a small feature should be ~50 lines. A complex feature ~150 lines. Never exceed 300 lines.
6. **One spec per feature.** Don't combine unrelated features in a single spec.

## Anti-patterns

- Writing code "just to explore" before the spec — use reading/grep/search instead
- Writing a vague spec that says "we'll figure it out during implementation"
- Skipping the approval gate and starting to code after writing the spec
- Writing the spec after the code is already written (post-hoc rationalization)
- Putting implementation details in the spec that belong in code comments
- Over-engineering the spec with UML diagrams or excessive formality

## Spec File Conventions

- Location: `docs/<NN>-<feature-name>.md` (e.g., `docs/11-selection-mode.md`)
- Naming: numbered prefix following existing docs, kebab-case, descriptive
- Keep all specs even after implementation — they serve as design history
- Update the status field as the spec progresses through its lifecycle
