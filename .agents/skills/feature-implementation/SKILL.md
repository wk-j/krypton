---
name: feature-implementation
description: When implementing any feature, ensures all related project documentation in docs/ is updated to stay in sync with the actual implementation including PROGRESS.md, architecture, data-flow, configuration, and requirements docs.
---

## What I do

Enforce documentation synchronization whenever a feature is implemented. Code and docs are a single unit of work — a feature is not complete until every relevant doc reflects the current state.

## When to use me

Use this skill whenever you are:
- Implementing a new feature or capability
- Modifying existing behavior (refactor, bugfix that changes behavior, API change)
- Adding, removing, or renaming commands, keybindings, modes, or config options
- Changing architecture, data flow, or module responsibilities
- Completing or partially completing a milestone task

## Steps

### 1. Plan

Before writing code:
- Read the relevant milestone in `docs/07-milestones.md` for expected deliverables.
- Read `docs/PROGRESS.md` for current status.
- Identify which docs are affected (see Doc Map below).
- Add doc update tasks to the todo list alongside code tasks.

### 2. Implement

Write the code following `AGENTS.md` guidelines.

### 3. Update Documentation

After code compiles and works, update ALL affected documents. Rule: if the implementation changes what any doc says or implies, that doc must be updated.

#### Doc Map

| Change Type | Docs to Update |
|---|---|
| New Tauri command or IPC event | `docs/04-architecture.md` (crate table, IPC section), `docs/05-data-flow.md` |
| New frontend module or class | `docs/04-architecture.md` (compositor section, DOM structure) |
| New keybinding or mode | `docs/04-architecture.md` (Input Router sec 5.6), `docs/02-functional-requirements.md` |
| New config option | `docs/06-configuration.md` |
| Architecture change (new module, changed responsibility) | `docs/04-architecture.md` |
| Data flow change (keyboard routing, resize, PTY lifecycle) | `docs/05-data-flow.md` |
| New dependency (Rust crate or npm package) | `docs/04-architecture.md` (crate/package tables) |
| Milestone task completed | `docs/PROGRESS.md` (check box, update counts in overview table) |
| Milestone task partially done | `docs/PROGRESS.md` (add note like "basic version done, needs testing") |
| New terminology or concept | `docs/01-introduction.md` (glossary section) |
| Resolved open question | `docs/01-introduction.md` (open questions section) |
| Non-functional behavior change (perf, limits) | `docs/03-non-functional-requirements.md` |
| New user-facing capability | `docs/02-functional-requirements.md` |

#### PROGRESS.md rules

1. Check the box `[x]` for completed tasks.
2. Update overview table counts (e.g. `6/10` becomes `7/10`).
3. Update milestone status: `Not Started` -> `In Progress` -> `Complete`.
4. Set `> Last updated:` date to today.
5. Partially done tasks stay unchecked but append a note.

#### Architecture and data flow rules

1. New modules added to architecture diagram and responsibilities described.
2. DOM structure changes reflected in the HTML example in sec 5.4.
3. New modes or keybindings update the mode table in sec 5.6.
4. Keyboard routing changes update the key routing flow diagram in sec 5.6.
5. New Rust crates added to the crate table in sec 5.1.
6. New npm packages added to the package table in sec 5.2.
7. ASCII diagrams kept accurate when backend gains new modules.
8. Frontend-backend data flow changes reflected in `docs/05-data-flow.md`.

#### Configuration rules

1. New TOML config keys documented in `docs/06-configuration.md` with type, default, and description.
2. Restructured config sections update the full example in the doc.
3. New theme properties or keybinding options documented.

### 4. Verify

After updating docs:
- Re-read each modified doc section to confirm it matches the code just written.
- Ensure no stale references remain (old function names, removed features, wrong keybindings).
- Confirm `PROGRESS.md` overview table counts are arithmetically correct.

### 5. Report

When reporting completion, include a "Docs updated" section listing every doc file changed and what was updated.

## Anti-patterns

- Implementing a feature and leaving docs unchanged.
- Updating only `PROGRESS.md` but skipping architecture/data-flow docs.
- Writing "TODO: update docs" instead of updating them now.
- Leaving stale counts in the `PROGRESS.md` overview table.
- Describing planned/aspirational behavior in docs — docs must reflect ACTUAL implemented state.
- Updating docs speculatively before the code compiles and works.

## Completion checklist

Before declaring a feature complete, verify:
- Code compiles (`cargo build` / `npx tsc --noEmit`)
- Feature works as intended
- `PROGRESS.md` task checked off, counts updated
- Architecture doc reflects any new modules/commands/modes
- Data flow doc reflects any routing/lifecycle changes
- Config doc reflects any new options
- Functional requirements doc reflects any new capabilities
- Glossary updated if new terms introduced
- Open questions resolved if applicable
- No stale references in any doc
