# `#ticket github` Browser Opener — Implementation Spec

> Status: Draft
> Date: 2026-09-08
> Milestone: ACP Harness — local working-ticket workflow

## Problem

An active local ticket can carry a GitHub issue reference, but the `#ticket`
command family cannot open that issue directly. The existing `#ticket open`
command already opens the local `ticket.md`, so changing its meaning would break
an established workflow.

## Solution

Add `#ticket github`. It opens `activeTicket.github.issueUrl` in the OS browser
through the existing `open_url` Tauri command. It does not call `gh`, refresh the
ticket, mutate GitHub, or change the active ticket.

If there is no active ticket, show `no working ticket set`. If the active ticket
has no GitHub reference, show `active ticket has no GitHub reference; use #ticket
link <ref>`. If the OS browser cannot be opened, keep the ticket unchanged and
show the existing error text in the status chip.

## Research

- `AcpHarnessView.runTicketCommand()` owns every `#ticket` subcommand and already
  dispatches `#ticket open` to the local Markdown Viewer.
- `GithubTicketReference.issueUrl` is the canonical URL persisted with the local
  ticket. Reusing it avoids rebuilding a URL from repository and issue-number
  fields.
- Krypton already opens browser surfaces through `invoke('open_url', { url })`.
  The Rust command delegates to the system default handler, so this feature needs
  no backend change.
- GitHub CLI uses the same explicit distinction: `gh issue view` renders issue
  details in the terminal, while `gh issue view --web` opens the issue in a
  browser. An explicit browser-oriented subcommand therefore preserves the local
  `open` behavior without ambiguity.

## Prior Art

| App | Implementation | Relevance |
|-----|----------------|-----------|
| GitHub CLI | `gh issue view <ref> --web` opens the selected issue in the browser | Confirms that opening the web issue should be an explicit action rather than changing the default local view |
| Krypton browser surfaces | `#dashboard`, `#docs`, and related commands call the shared `open_url` IPC command | Reuses the established OS-browser path and its error handling |

**Krypton delta:** the command resolves the already-active ticket rather than
accepting another issue argument. Selecting or linking a ticket remains the job
of the existing `#ticket` commands.

## Affected Files

| File | Change |
|------|--------|
| `src/acp/acp-harness-view.ts` | Handle `#ticket github`, validate active GitHub metadata, and call `open_url` |
| `src/acp/hash-commands.ts` | Advertise `github` in the `#ticket` argument grammar |
| `src/acp/acp-harness-view.test.ts` | Cover URL resolution and missing-reference behavior |
| `src/acp/hash-commands.test.ts` | Keep the command manifest discoverable |
| `docs/05-data-flow.md` | Record the browser-opening branch in the ticket flow |
| `docs/238-local-ticket-bundles.md` | Add the command to the authoritative ticket command table |
| `docs/README.md` | Index this spec |

No Rust, persistence, MCP, CSS, or GitHub API files change.

## Design

### API / Commands

```text
#ticket github
```

No new Tauri command is added. The frontend calls the existing command:

```ts
await invoke('open_url', { url: activeTicket.github.issueUrl });
```

### Data Flow

1. The user submits `#ticket github` in the ACP Harness composer.
2. `runHashCommand()` routes the request to `runTicketCommand(['github'])`.
3. The command validates that an active ticket and `github` reference exist.
4. Krypton calls `open_url` with the stored `issueUrl`.
5. The OS opens the issue in the default browser and Krypton flashes the URL.
6. On failure, Krypton flashes `GitHub issue open failed: <error>`.

### Keyboard Access

The composer command is fully keyboard accessible. No additional global
keybinding, dialog control, or mouse-only action is added.

## Edge Cases

- **No active ticket:** do not invoke `open_url`; show `no working ticket set`.
- **Local-only ticket:** do not invoke `open_url`; direct the user to `#ticket
  link <ref>`.
- **Closed GitHub issue:** open it normally; issue state does not make its URL
  invalid.
- **Stale metadata:** open the persisted canonical URL without an implicit
  network refresh.
- **Browser launch failure:** keep all ticket state unchanged and show the error.

## Open Questions

None. The command name is explicit so `#ticket open` remains backward compatible.

## Out of Scope

- Changing `#ticket open` or adding aliases.
- Opening GitHub inside a Krypton webview.
- Adding a Ticket Panel button or a global shortcut.
- Refreshing issue metadata before opening.

## Resources

- [GitHub CLI `gh issue view`](https://cli.github.com/manual/gh_issue_view) — documents the explicit `--web` browser-opening behavior.
- [Local Ticket Bundles](./238-local-ticket-bundles.md) — authoritative active-ticket model and current command family.
- [Architecture Overview](./04-architecture.md) — existing ticket ownership and browser-opening boundaries.
