# Browser Extension Active Ticket Sync — Implementation Spec

> Status: Implemented
> Date: 2026-09-25
> Milestone: ACP Harness — local working-ticket workflow

## Problem

The Chrome extension can send page context to a lane and show a GitHub issue's
`issue_progress`, but its popup cannot show the local ticket currently pinned in
Krypton's Ticket Panel. While reading in Chrome, the user must switch to Krypton
to see the ticket's local status, worker, context, resources, analysis, or progress.

## Solution

Show a compact, read-only Active Ticket section in the extension popup for the
selected lane's harness. A new authenticated `ticket.active` control operation
returns a bounded projection of the same in-memory ticket and worker that render
Krypton's Ticket Panel. The popup snapshots on open and lane change, then refreshes
every three seconds while open. It never copies ticket state into extension
storage or reads `.krypton/tickets/` directly.

## Research

- `AcpHarnessView.activeTicket` and `ticketWorker` already own the Ticket Panel's
  current state. The bundle detail is updated after user commands and
  `acp-ticket-progress`; `ticketWorker` is updated after worker claims.
- The existing GitHub issue card reads `github.issue-status`, which tracks an
  issue-to-lane fixing binding and `issue_progress`. That is independent of the
  project-local ticket status and cannot supply a local-only ticket.
- `lane.list` already returns globally unique lane names and their harness IDs.
  `control-bridge` routes a control operation carrying `lane` to its owning
  harness, so the popup needs no separate harness picker.
- `LocalTicketDetail` includes full `contextMarkdown` and resource paths. The
  Ticket Panel only renders the bounded `contextExcerpt`, six resource names,
  counts, and progress summary; the browser response should expose that subset.
- Chrome documents one-time messages for request/response and warns that MV3
  service workers can stop when dormant. Polling from the open popup needs no
  persistent worker state or new SSE event. Its existing service worker already
  performs authenticated loopback fetches with declared host permission.

## Prior Art

| App | Behavior | Relevance |
|-----|----------|-----------|
| VS Code GitHub Pull Requests and Issues | Shows the active issue in the Status Bar; selecting it offers issue actions and a web link | Keep the current work item visible near the user's next action |
| GitHub Issues | Shows issue metadata in the issue sidebar | Compact metadata and status belong beside the work surface |
| Krypton Ticket Panel | Shows local ticket, optional GitHub reference, worker, context, resources, analysis, and progress | Source and field order for the extension projection |

**Krypton delta:** the extension follows the active *local* ticket of the chosen
lane's harness, including tickets without a GitHub link. The GitHub page card
continues to describe that page's separate issue-fixing state.

## Affected Files

| File | Change |
|------|--------|
| `src-tauri/src/control.rs` | Advertise read-only `ticket.active` capability |
| `src/acp/acp-harness-view.ts`, `src/acp/harness-view-types.ts` | Return and type a bounded Ticket Panel projection for `ticket.active` |
| `extension/background.js` | Forward `activeTicket` popup message to `ticket.active` |
| `extension/manifest.json`, `extension/popup.html`, `extension/popup.js`, `extension/ticket-sync.js` | Describe, show, and refresh the synced section while open |
| `extension/README.md`, `docs/04-architecture.md`, `docs/05-data-flow.md` | Document the browser read path and distinction from GitHub issue status |
| `src/acp/control-bridge.test.ts`, `src/acp/acp-harness-view.test.ts`, `extension/ticket-sync.test.js` | Cover lane routing, bounded projection, refresh races, and cleared/error states |

## Design

### API and data boundary

The popup sends `{ type: 'activeTicket', lane: '<selected displayName>' }` to its
service worker. The worker calls `ticket.active` with `{ lane }` through the
existing authenticated control API. `control-bridge` resolves the lane's harness;
the view verifies that the lane belongs to it and returns:

```ts
interface ActiveTicketSnapshot {
  harnessId: string;
  ticket: null | {
    id: string;
    title: string;
    status: 'todo' | 'in_progress' | 'blocked' | 'done';
    github: null | { issueKey: string; issueUrl: string; state?: string };
    worker: null | { laneDisplayName: string };
    contextExcerpt: string | null;
    resourceCount: number;
    resources: Array<{ name: string; sizeBytes: number }>; // first six
    analysis: null | { markdownCount: number; attachmentCount: number };
    lastProgressSummary: string | null;
  };
}
```

The response excludes full Markdown, filesystem paths, resource contents,
bearer credentials, and unrelated tickets. `ticket: null` means no active ticket
for the selected harness. The control API uses its existing token and origin
rules; the extension needs no new Chrome permissions.

### Popup behavior

1. After `lane.list`, choose the stored lane as today and request its ticket.
2. On lane change, clear the old ticket immediately and request the new lane's
   ticket. Ignore a response whose request generation or lane no longer matches.
3. While the popup is open, refresh every three seconds, with at most one ticket
   request in flight for the selected lane. Also refresh when the popup regains
   focus.
4. Keep title, local status, ID, and latest progress visible in a compact ticket
   summary. A keyboard-accessible `Show ticket details` disclosure reveals the
   optional GitHub link/state, worker, context excerpt, resource count and first
   six names/sizes, and analysis counts. Start with details collapsed so the
   existing page context and actions stay in view; cap popup height at 600px
   and allow scrolling when details expand. Use text nodes for untrusted
   text and accept only `https://github.com/` issue URLs for the link.
5. Show `No active ticket` when the snapshot is empty. On a ticket fetch error,
   show `Ticket unavailable` without leaving old details on screen; the next
   refresh retries. Lane sending remains usable if only the ticket read fails.
6. Provide a keyboard-focusable `Refresh ticket` button and an `aria-live`
   status for loading, empty, and error states. No ticket mutation is offered.

### Verification

- Two open harnesses: selecting a lane shows only its harness's active ticket;
  switching lanes within a harness keeps the same ticket.
- Activate, update, clear, and worker-claim a ticket in Krypton: the popup reflects
  each change by its next refresh without being reopened.
- A delayed response from the previous lane cannot replace the new lane's data.
- Local-only and GitHub-linked tickets, long context, more than six resources,
  missing analysis, a closed GitHub issue, older Krypton without `ticket.active`,
  and Krypton offline all render safely.
- Run focused frontend tests, extension tests, TypeScript check, production build,
  Rust format check, and control capability tests.

## Edge Cases

- No lanes: keep the existing disabled send state and show no ticket selection.
- Stopped lane still listed: its harness may have an active ticket; show that
  ticket without implying the lane can work on it.
- The popup closes mid-request: its timer and DOM disappear; no background
  polling or saved ticket copy remains.
- Ticket removed or cleared: the next snapshot is empty, so the prior ticket is
  removed from view.
- Older app version: `unsupported_operation` affects only the ticket section.

## Open Questions

None. The selected lane defines which harness's ticket appears.

## Out of Scope

- Editing or selecting tickets from Chrome.
- Copying ticket files or resource contents into the browser.
- Changing the separate GitHub issue status card or GitHub issue state.
- Background sync while the popup is closed.

## Resources

- [Chrome extension message passing](https://developer.chrome.com/docs/extensions/develop/concepts/messaging) — one-time popup-to-worker requests.
- [Chrome extension service workers](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers) — dormant worker lifecycle.
- [Chrome cross-origin network requests](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests) — extension-origin fetch with host permission.
- [VS Code GitHub workflow](https://code.visualstudio.com/docs/sourcecontrol/github) — active issue visibility and actions.
- [GitHub issue fields](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/adding-and-managing-issue-fields) — issue sidebar metadata convention.
- [Local Ticket Bundles](./238-local-ticket-bundles.md) and [Browser Extension](./176-harness-browser-extension.md) — current internal contracts.
