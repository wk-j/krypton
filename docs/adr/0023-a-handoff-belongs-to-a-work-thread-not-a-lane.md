# ADR-0023 — A handoff belongs to a work thread, not a lane

> Status: Accepted
> Date: 2026-10-13
> Spec: `docs/0293-global-handoff-resume.md`
> Supersedes: the lane-keyed store of spec 139 / 165

## Context

Handoffs were stored one per lane label, and `#resume` read the resuming lane's own label. Lane
labels do not identify work. The counter resets on every app start and increments within a run.
After a restart, `Claude-1` resumes yesterday's unrelated `Claude-1` document, and a fresh
`Claude-4` finds nothing. Slots of retired backends never go away.

## Decision

A handoff is a project-level document with its own id (`ho-…`). The lane label is recorded as the
author for display only. A lane is **bound** to at most one handoff, and the binding lives only in
memory. `#handoff` overwrites the bound handoff, or mints one if the lane has none. `#resume` binds
the lane to the handoff it resumes. `#new`, `#restart`, and closing the lane drop the binding.
Bare `#resume` takes the newest handoff in the project, whichever lane wrote it.

## Considered Options

- **Keep lane slots, resume the newest slot.** Rejected: a recurring label still overwrites
  unrelated work, and dead slots persist.
- **One document per project.** Rejected: two lanes working in parallel would clobber each other's
  handoff.
- **Always mint a new handoff on every `#handoff`.** Rejected: a thread resumed three times would
  leave three near-duplicate handoffs, and "newest" would stop meaning "latest state of the work".

## Consequences

- The store file moves to version 2. v1 lane slots migrate to one handoff each.
- One store is shared by every Harness tab of a project. This also removes the multi-tab
  overwrite that came from one store per tab.
- The lane-keyed MCP reads (`handoff_get`, `handoff_list`) go away, because resume injects the
  document. `memory.get` / `memory.clear <lane>` now address the handoff bound to that live lane.
- Two lanes that resume the same handoff share it, and the last write wins.
