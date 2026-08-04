# Live Assist Compact Activity — Implementation Spec

> Status: Implemented
> Date: 2026-08-01
> Milestone: M-ACP — Harness convergence

## Problem

Live Assist is meant to be a compact companion, but its transcript currently
renders every thought, tool call, and file-activity event as a full-width row.
Internal progress can therefore displace the user prompt and assistant answer,
making the auxiliary window consume attention and screen area like the full
Harness it was designed to complement.

## Solution

Make the Live Assist transcript conversation-first. Consecutive internal
activity rows become one collapsed native disclosure labelled
`ACTIVITY · N steps`; opening it reveals the original rows without altering or
discarding transcript data. User and assistant messages, errors, system events,
permissions, shell output, artifacts, and lane mail remain visible by default.

This is progressive disclosure, not a smaller-font treatment: the common view
shows the conversation, while diagnostic detail stays one keyboard action away.

## Research

- The implemented Live Assist contract already calls the window a
  purpose-built compact surface rather than a squeezed Harness copy, but
  `live-assist-view.ts` currently renders the last 120 raw items one-for-one.
- Krypton's full Harness already has a concise mode that hides thought and
  file-activity rows and reduces tool cards, establishing that internal activity
  is secondary information in compact contexts.
- Live Assist streams only user and assistant text incrementally. Thought and
  tool records arrive through authoritative snapshots, so grouping them is a
  pure presentation transform and does not change ordering, control dispatch,
  or stream recovery.
- VS Code exposes collapsed and fixed-height rendering modes for thinking,
  demonstrating the established agent-UI pattern of keeping reasoning
  available without letting it dominate chat.
- Raycast AI Chat centers the ongoing conversation in its floating window and
  moves background progress completion into status/notification affordances.

### Alternatives Rejected

- **Only reduce font size and padding:** fits slightly more content but leaves
  internal narration as the dominant hierarchy and worsens readability.
- **Remove internal rows entirely:** saves the most space but eliminates useful
  debugging evidence and violates transcript-tail viewing expectations.
- **Add a persistent compact/full preference:** adds configuration and state for
  a surface whose product contract is already compact. The full Harness remains
  the dedicated detailed view.
- **Show only the latest activity line:** still exposes command and path noise,
  while making it unclear how much work occurred.

## Prior Art

| App | Implementation | Krypton adoption |
|-----|----------------|------------------|
| VS Code Copilot Chat | Thinking can render collapsed by default, as a collapsing preview, or in a fixed-height scrolling region. | Collapse secondary agent work by default while preserving access. |
| Raycast AI Chat | Floating, always-on-top chat keeps conversation primary and reports background completion as status/notification. | Keep the companion surface focused on prompts, answers, and current state. |
| Krypton ACP Harness | Concise mode suppresses side-channel rows and reduces tool cards to their head line. | Reuse the existing hierarchy, but make it the default contract for Live Assist. |

**Krypton delta:** Live Assist groups each consecutive activity run into one
native disclosure instead of applying the full Harness's global concise toggle.
The result stays deterministic, keyboard-first, and local to the auxiliary
renderer.

## Affected Files

| File | Change |
|------|--------|
| `src/acp/live-assist-view.ts` | Group consecutive internal rows and render native activity disclosures. |
| `src/styles/live-assist.css` | Style the compact summary and quieter expanded detail. |
| `src/acp/live-assist-view.test.ts` | Test grouping boundaries, ordering, counts, and stable group identity. |
| `docs/208-harness-live-assist-mode.md` | Update the implemented transcript projection contract. |
| `docs/PROGRESS.md` | Record the compact activity refinement after validation. |

## Design

### Data Structures

The view adds a pure internal projection:

```ts
type LiveAssistTranscriptBlock =
  | { kind: 'message'; item: LiveAssistTranscriptItem }
  | { kind: 'activity'; id: string; items: LiveAssistTranscriptItem[] };

export function groupLiveAssistTranscript(
  items: LiveAssistTranscriptItem[],
): LiveAssistTranscriptBlock[];
```

Compactable kinds are `thought`, `tool`, `fs_activity`, and
`fs_write_review`. Every other kind is a boundary and remains a normal message
row. Activity block identity derives from its first item id so it remains stable
if later snapshots append more internal steps to the same run.

### Data Flow

1. The client keeps its existing 120-item raw transcript cap.
2. `renderTranscript()` groups that bounded tail without mutating the source.
3. Normal blocks use the existing message renderer.
4. Activity blocks render a collapsed `<details>` element whose `<summary>` says
   `ACTIVITY · N steps` (singular `step` for one).
5. Opening the disclosure renders the original rows in original order and with
   their current labels and text.
6. A snapshot reconciles by `data-block-key` (`a:<first item id>`), so a group
   whose stable id is still present keeps its own `<details>` node and therefore
   its open state; obsolete ids are pruned. Rows inside an expanded group are
   reconciled the same way, so opened detail does not flicker as steps are
   appended. When the bounded tail slides past a run's first item the id changes
   and the new group starts collapsed, as before.
7. Incremental user/assistant streaming remains unchanged.

### UI Changes

- A collapsed activity run occupies one dense row, regardless of its internal
  text length.
- The summary is focusable through normal Tab order and toggles with Enter or
  Space via native `<details>` behavior. Mouse click remains secondary.
- Expanded detail uses the existing semantic colors but reduced spacing and a
  subtle full-surface tint. It adds no side accent rail, nested card, or ambient
  animation.
- Transcript padding and ordinary message spacing remain unchanged initially;
  the measured problem is hierarchy, not base legibility.

### API / Commands

No IPC, Tauri command, control operation, payload, or stored preference changes.

### Configuration

None. Compact activity is the Live Assist default; the full Harness remains the
always-expanded diagnostic surface.

## Edge Cases

- A single internal row still becomes one `ACTIVITY · 1 step` disclosure.
- Activity runs separated by a user, assistant, error, system, shell, artifact,
  permission, restart, memory, or lane-mail row remain separate groups.
- Empty text and fallback tool status remain available inside expanded detail.
- A tail beginning midway through an activity run forms a valid group from the
  retained items only; the count never claims dropped history.
- Re-rendering after status or permission changes preserves open groups that
  still share the same first item id.
- Screen readers announce the native summary and expanded/collapsed state.

## Validation

- `npm run check`
- `npm test -- src/acp/live-assist-view.test.ts src/acp/live-assist-client.test.ts`
- `npm run build`
- `git diff --check`
- Manual visual check at the default `840 × 620` and minimum `560 × 420` sizes,
  confirming that the latest prompt and answer remain visible while activity is
  collapsed and that keyboard expansion works.

## Open Questions

None.

## Out of Scope

- Changing the native window size or minimum size
- Adding a persistent verbose/compact preference
- Markdown rendering or syntax highlighting in Live Assist
- Changing the full Harness transcript or concise mode
- Filtering backend transcript data or public control responses

## Resources

- [VS Code AI settings reference](https://code.visualstudio.com/docs/agents/reference/ai-settings) — documents collapsed and fixed-height thinking presentation modes.
- [Raycast AI Chat manual](https://manual.raycast.com/ai/chat) — documents the floating always-on-top conversation surface and background completion status.
- `docs/208-harness-live-assist-mode.md` — current Live Assist product and architecture contract.
- `src/acp/acp-harness-view.ts` and `src/styles/acp-harness.css` — existing Krypton concise-mode precedent.
