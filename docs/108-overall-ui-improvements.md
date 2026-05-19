# Overall UI Improvements — Concept Backlog

> Status: Concept backlog
> Date: 2026-05-19
> Milestone: Post-M-current polish

## Purpose

This document tracks broad UI improvement candidates for Krypton. It is intentionally an overview list, not an implementation spec.

When an item is selected for implementation, create a dedicated feature document with research, detailed design, affected files, keyboard behavior, accessibility notes, testing plan, and rollout steps. Do not expand this backlog into a deep implementation document.

## Principles

- Keep Krypton keyboard-first.
- Improve scanability before adding more surface area.
- Prefer dense, instrumented UI over decorative panels.
- Keep app windows as DOM panes inside one native Tauri window.
- Use existing theme variables, BEM CSS, and direct TypeScript DOM patterns.
- Avoid hover-only controls; every important action needs a keyboard path.
- Do not add frontend frameworks or CSS frameworks.

## Candidate Improvements

1. **ACP contextual lane activity peek** — implemented in `docs/109-acp-contextual-lane-peek.md`; automatically shows the most relevant non-active lane summary based on the active lane's interaction state.
2. **ACP transcript row focus** — add keyboard-first navigation and actions for transcript rows.
3. **Permission detail expansion** — let compact permission cards reveal deeper context when focused.
4. **Context-aware command palette** — adapt palette actions to the active pane and workflow.
5. **Chrome HUD numerics** — replace passive titlebar status text with compact live readouts.
6. **Display typography moments** — show brief mode/workspace state moments in large display type.
7. **Pane-local quick actions** — expose the most relevant commands for the active view without opening a separate dashboard.
8. **Unified empty/loading/error states** — make non-PTY content views use consistent compact states for loading, failure, and recovery.
9. **View-specific status summaries** — let each pane publish a short summary that chrome, palette, and overview surfaces can reuse.
10. **Navigation memory** — make recent panes, files, URLs, agents, and commands easier to revisit from the keyboard.
11. **Visual density tuning** — reduce low-value decoration and improve spacing, hierarchy, and truncation in dense panes.
12. **Accessibility polish** — improve focus rings, contrast checks, reduced-motion behavior, and screen-reader labels for non-terminal controls.
13. **Inline diff preview with quick apply/revert** — render agent file edits as a diff inside the transcript row with keyboard actions to revert or stage, removing the round-trip to an external editor or `git`.
14. **Per-turn repo checkpoints** — snapshot the working tree before and after each agent turn so a single bad turn can be rolled back without manual `git reset`, with retention and cleanup rules.
15. **Auto-context from active pane** — let the ACP lane attach the file/cursor context of the adjacent terminal or editor pane automatically, reducing manual `@file` references for the most common coding loop.

## Recommended Next Pick

**ACP contextual lane activity peek** is the recommended next UI improvement.

Why this first:

- ACP harness is currently the densest, highest-value workflow in the app.
- Multi-lane work creates attention-management problems fastest in non-active lanes, because their transcripts are not visible.
- Active lanes already have full transcript context; non-active lanes need a compact peek to explain whether they require attention.
- The active lane often implies which non-active lane matters next: awaiting peer reply, received inbox message, requested review, pending permission on another lane, or recent cross-lane file activity.
- The recent permission-card and peering work added richer state; the UI should surface the most relevant lane automatically without forcing a lane switch or manual cycling first.
- It improves real use before adding more general chrome polish.
- It creates a compact state vocabulary that can later feed command palette summaries, view status summaries, and chrome HUD surfaces.

The design should avoid three traps: do not squeeze detailed activity into the collapsed lane row, do not create a global mixed-lane overview, and do not make the feature hover-only. Collapsed rows should keep only minimal status markers. The richer summary should appear as a hideable peek for one automatically selected non-active lane, showing only that lane's state.

The dedicated implementation spec is `docs/109-acp-contextual-lane-peek.md`.

## Suggested Selection Order

Shipped:

1. **ACP contextual lane activity peek** — hidden lane state can now be inspected through a contextual single-lane peek.
2. **Context-aware command palette** — focused view contributes a "Context" section via the optional `ContentView.getPaletteActions?` capability; ACP harness is the v1 contributor. See `docs/110-context-aware-command-palette.md`.
3. **ACP Review Lane Mode (V0.5)** — `#review <lane>` chat command + `review_request` / `review_reply` MCP tools deliver a structured git packet to a reviewer lane and render anchored findings as a `review` transcript card. See `docs/112-acp-review-lane-mode.md`.

Recommended next:

1. **ACP transcript row focus** — creates the keyboard model needed for richer transcript interactions.
2. **Permission detail expansion** — builds directly on structured permission cards.
3. **Chrome HUD numerics** — completes the next concrete chrome-signal slice from `docs/104-chrome-signal-upgrades.md`.
4. **Display typography moments** — polish after the higher-information surfaces are improved.

## Relationship To Existing Docs

- `docs/104-chrome-signal-upgrades.md` remains the umbrella for window chrome that communicates state.
- `docs/105-view-protocol.md` covers the ViewBus infrastructure that can support many of these ideas.
- `docs/106-inter-lane-messaging.md` covers peering state, the strongest initial trigger for contextual lane peek.
- `docs/107-acp-harness-transcript-readability.md` covers the first slice of structured ACP transcript readability.
- `docs/109-acp-contextual-lane-peek.md` is the implemented spec for the recommended next UI improvement.
- Future selected items from this backlog should become their own numbered documents.
