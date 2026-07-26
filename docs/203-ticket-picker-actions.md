# Ticket Picker Actions - Implementation Spec

> Status: Implemented
> Date: 2026-07-25
> Milestone: ACP Harness - working-ticket workflow

## Problem

The `#ticket` dialog can select and set a shared working ticket, but the user must
close it and type a second hash command to analyze, comment on, or fix that issue.
The selected row already contains the exact issue reference, so this extra round
trip adds friction and makes the dialog feel like a passive picker.

## Solution

Add an action bar for the selected row with `Set ticket`, `Analyze`, `Post comment`,
and `Fix here`. The three work actions reuse the existing spec-191 GitHub prompt
verbs in the active lane. They do not add a GitHub API path or bypass the lane's
permission mode. Before starting a work action, Krypton sets the selected issue as
the shared working ticket so subsequent turns cannot receive a stale ticket pin
for a different issue.

## Research

- `renderTicketOverlayEl()` already owns the selected row, filter text, and modal
  shell. It is the smallest UI seam for rendering a contextual action bar.
- `handleTicketPickerKey()` currently gives printable keys to live filtering.
  Plain `a`, `c`, or `f` shortcuts would therefore break issue search. Modified
  number shortcuts avoid that collision while keeping the dialog keyboard-first.
- `runGithubIssuePromptVerb()` is the single existing path for
  `analyze-github-issue`, `post-github-comment`, and `fix-github-issue`. It already
  validates lane readiness, builds the exact prompt, resolves composed verbs, and
  uses `enqueueSystemPrompt()`. The dialog should call this path with the selected
  row URL instead of duplicating prompt or dispatch logic.
- The issue verbs run in the current lane. `#fix-github-issue` explicitly differs
  from `#dispatch-github-issue`, which creates a fresh lane. Keeping that distinction
  makes the buttons predictable and avoids a hidden lane-spawn side effect.
- `ActiveWorkTicket` and `IssueBinding` remain separate. Setting ticket context does
  not claim ownership; `issue_progress` auto-binds the lane only when the agent
  reports actual work.
- The dialog currently has no mouse row selection or semantic buttons. Adding
  delegated click handling gives mouse users a secondary path without changing the
  keyboard-first interaction model.
- Zed's ACP client sends a prompt through the existing agent session rather than
  rebuilding session configuration for each action. Krypton should likewise start
  a normal lane turn and leave `session/new` and MCP configuration untouched.

## Prior Art

| App | Implementation | Relevance |
|-----|----------------|-----------|
| VS Code GitHub Issues | A selected issue exposes `Start Working on Issue`; the action can set working-issue state, create or check out a branch, and prefill the commit message | Confirms that issue selection and the next work action belong on the same surface |
| Linear | Issue views keep contextual actions beside the selected issue, while comments use an explicit submit action and keyboard shortcut | Supports visible, verb-led actions tied to one selected record |
| Zed ACP client | User actions become prompts in the existing agent session | Supports reusing the active lane instead of creating a parallel control path |

**Krypton delta:** the dialog remains dense, amber, and keyboard-first. It does not
perform repository or GitHub mutations itself. Each work button starts an existing
agent verb in the visible active lane, so transcripts, permission handling, progress,
and failure feedback remain observable in one place.

## Affected Files

| File | Change |
|------|--------|
| `src/acp/acp-harness-view.ts` | Add ticket action type/helpers, render semantic buttons, handle button clicks and modified-number shortcuts, and route selected rows through existing issue verbs |
| `src/styles/acp-harness.css` | Add the flat action bar, button states, target-lane/status text, and narrow-width wrapping |
| `src/acp/acp-harness-view.test.ts` | Cover shortcut mapping and lane/action availability rules as pure helpers |
| `docs/194-working-ticket-picker.md` | Record that the implemented picker now has direct actions |
| `docs/04-architecture.md` | Note that ticket actions reuse prompt verbs and the active lane |
| `docs/05-data-flow.md` | Add the selected-ticket action flow |
| `docs/PROGRESS.md` | Add the landing after implementation |

No Rust, Tauri command, persistence, MCP, or GitHub transport changes are required.

## Design

### Data Structures

```ts
type TicketPickerAction =
  | 'set-ticket'
  | 'analyze-github-issue'
  | 'post-github-comment'
  | 'fix-github-issue';
```

The existing picker state remains unchanged:

```ts
{ rows: TicketPickerRow[]; filter: string; index: number }
```

The selected row stays derived from `ticketPickerMatches()` and `index`; there is no
second selection source to synchronize.

### API / Commands

No new public API or hash command. Action routing is an internal method:

```ts
private async runTicketPickerAction(action: TicketPickerAction): Promise<void>
```

For work actions it calls:

```ts
runGithubIssuePromptVerb(activeLane, action, [selectedRow.url])
```

### Data Flow

1. User opens `#ticket`; existing `gh issue list` loading and filtering are unchanged.
2. User highlights a row with arrows, filter text, or a mouse click.
3. `Enter` or `Set ticket` keeps the current behavior: set the shared ticket and close.
4. Analyze, Post comment, or Fix here first validates that the active lane has a
   client and is `idle` or `awaiting_peer`.
5. Krypton sets the selected row as `ActiveWorkTicket`, closes the dialog, and starts
   the matching existing spec-191 prompt verb with the row's explicit URL.
6. The lane transcript, permission policy, `issue_progress`, auto-binding, queue rules,
   and error handling continue through their existing paths.

Validation happens before changing the active ticket. If the lane is busy or stopped,
the dialog stays open and explains why the work actions are unavailable.

### Keybindings

| Key | Dialog action |
|-----|---------------|
| `↑` / `↓`, `Ctrl+P` / `Ctrl+N` | Move selected issue |
| Printable text / `Backspace` | Filter issues |
| `Enter` | Set selected issue as working ticket |
| `Cmd/Ctrl+1` | Analyze selected issue in the active lane |
| `Cmd/Ctrl+2` | Post a comment through the active lane |
| `Cmd/Ctrl+3` | Fix selected issue in the active lane |
| `Esc` | Close dialog |

The modified-number shortcuts are local to the open ticket dialog. They do not collide
with printable filtering or compositor-mode number keys.

### UI Changes

The panel keeps one flat surface and gains a footer action band:

```text
┌ working ticket ───────────── target: Codex-1 · idle ┐
│ filter…                                             │
│ #31  selected issue title                 2h        │
│ #32  another issue                        1d        │
├─────────────────────────────────────────────────────┤
│ [Enter Set ticket] [⌘1 Analyze] [⌘2 Post comment]  │
│                                      [⌘3 Fix here] │
└─────────────────────────────────────────────────────┘
```

- Use real `<button type="button">` elements with `data-ticket-action`.
- `Set ticket` remains available whenever a row exists.
- Work buttons are disabled when there is no runnable active lane. The action band
  names the target lane and status so "Fix here" is unambiguous.
- The selected row is clickable; click changes selection but does not execute.
- Action buttons use the existing amber secondary-button vocabulary: full 1px border,
  transparent background, square geometry, visible `:focus-visible`, and no left rail.
- Buttons wrap as a single flex row on narrow panels. The list keeps the remaining
  vertical space; the panel never grows past its current `72vh`.
- No new animation. Selection and busy/disabled state changes are immediate.

### Action Semantics

- **Set ticket:** context-only. It does not start a lane turn or create a binding.
- **Analyze:** starts `analyzeGithubIssuePrompt`; its existing behavior may write the
  local analysis bundle and apply the analyzed label through the lane.
- **Post comment:** starts `postGithubCommentPrompt`; the lane drafts and posts using
  its existing permission policy. The dialog itself never posts.
- **Fix here:** starts `fixGithubIssuePrompt` in the currently active lane. It never
  spawns a fresh lane; users still use `#dispatch-github-issue` for that workflow.

## Edge Cases

- **No matching rows:** show the existing empty state; all action buttons are disabled.
- **Lane busy:** keep the dialog open, retain selection/filter, disable work actions,
  and show `target <lane> · busy`; Set ticket still works.
- **No active/live lane:** work actions are disabled with `no active lane`; Set ticket
  still works.
- **Malformed row URL:** keep the dialog open and flash the existing parse error.
- **Action double activation:** close the picker before awaiting the started turn so a
  second click or key repeat cannot enqueue a duplicate action.
- **Existing different active ticket:** a work action replaces it only after lane
  validation succeeds, preventing the chosen lane from receiving a conflicting pin.
- **Closed issue:** the picker currently lists open issues, but direct data remains
  defensive; a closed selected row can be set or acted on with its state visible.
- **Comment risk:** the button starts the existing agent prompt and does not weaken
  approval policy. Any hard-to-undo GitHub write remains attributable to the lane turn.

## Open Questions

None for approval. The consequential choices in this draft are explicit:

1. Work actions target the visible active lane, not a new lane.
2. Starting a work action also makes that issue the shared working ticket.
3. `Post comment` starts the existing end-to-end comment verb; it is not a draft-only
   UI editor.

## Out of Scope

- A ticket detail/description pane inside the picker
- Creating, assigning, labelling, closing, or reopening issues from dialog-owned code
- A new comment editor or confirmation modal
- Choosing a different target lane inside the ticket dialog
- Changing `#dispatch-github-issue` or multi-lane issue ownership
- New Rust commands, GitHub API clients, or persistence formats

## Resources

- [VS Code GitHub Issues integration](https://code.visualstudio.com/blogs/2020/05/06/github-issues-integration) - working-issue action and branch workflow
- [VS Code GitHub Pull Requests and Issues extension](https://github.com/microsoft/vscode-pull-request-github) - current issue command and setting surface
- [Linear comments and reactions](https://linear.app/docs/comment-on-issues) - contextual comment action and explicit submit shortcut
- `/Users/wk/Source/zed/crates/agent_servers/src/acp.rs` - prompt requests stay in the existing ACP session
- Internal: specs 190, 191, and 194; ADR-0007; `DESIGN.amber.md`
