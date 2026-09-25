# Review Board Auto-Push to Xenon — Implementation Spec

> Status: Implemented
> Date: 2026-09-25
> Milestone: M-ACP — Harness convergence
> Builds on: 211, 212, 230, 259 · ADR-0016

## Problem

The user's `[xenon].auto_push` already lists `review`, but a completed Review Board
stays local until someone runs `#push review`. Today `auto_push` selects the kinds
covered by a bare `#push`; only `attention` has an automatic event trigger. The
setting's name and the older spec 212 example imply that reviews publish when
finished, so the current behavior is surprising.

## Solution

When `review_register` first makes a Review Board available, automatically push
that one bundle if `[xenon].auto_push` contains `review`. Keep the existing
`xenon_push` collector, secret scan, credential handling, content-addressed upload,
and report; automatic calls always use `force: false`. Show the result beside the
review's lane transcript. Serialize pushes within the running app and preserve
unrelated retry-queue entries so an automatic push cannot erase a concurrent or
earlier failure.

## Research

- `review_register` validates the completed `review.md`, then emits
  `acp-harness-review` with `state: 'registered'`, the exact bundle `slug`, and
  `registered: true` only on its first transition. Refreshes emit `false`.
  `AcpHarnessView.handleReviewEvent` already receives this event and raises the card.
- `xenon_push(cwd, kind, slug, force, attention)` already publishes one review
  through `.krypton/reviews/<slug>/`, generates the review source-excerpt sidecar,
  and returns a per-resource report. Xenon treats an identical push as unchanged.
  No Xenon protocol or server change is needed.
- `review_outcome` is a separate in-memory summary for the review gauge; it is not
  the publishable Board. `response.md` autosaves during the human's later review,
  so its edits are a separate lifecycle from initial registration.
- `commands.rs::xenon_push` currently replaces `.krypton/xenon-queue.json` with
  only the failures from its own call. Automatic review and attention pushes can
  overlap manual pushes; serialization plus queue merge is needed to retain
  failures for resources the new call did not attempt.
- Current `docs/06-configuration.md` and ADR-0016 say only `attention` publishes
  on creation. The original spec 212 `auto_push` example still says `review` is
  pushed when sealed; implementation must update the current contract coherently.

## Prior Art

| Product | Relevant behavior | Krypton choice |
|---|---|---|
| GitHub Actions | An upload-artifact step stores files produced by a workflow run. | Publish at the completed Board event, with an explicit opt-in kind. |
| SonarQube Server | CI-integrated pull-request analysis runs when a PR is opened or its branch changes. | Use `review_register` as the completion event; do not watch every file edit. |

These systems automate publication at a defined workflow point. Krypton's
keyboard command `#push review [<slug>]` remains available for an explicit retry
or a later revised bundle.

## Affected Files

| File | Change after approval |
|---|---|
| `src/acp/acp-harness-view.ts` | Push the first registered review when opted in; report the outcome to its lane. |
| `src/acp/review-auto-push.test.ts` | Cover eligibility, one-bundle scope, repeat registration, and failure feedback. |
| `src-tauri/src/commands.rs` | Serialize `xenon_push` calls and merge retry status by resource identity. |
| `src-tauri/src/xenon.rs` | Make retry-queue writes atomic and test retention/removal behavior. |
| `src-tauri/src/config.rs` | Clarify the `auto_push` field's two automatic triggers. |
| `docs/04-architecture.md`, `docs/05-data-flow.md`, `docs/06-configuration.md` | Describe the implemented trigger and status. |
| `docs/212-xenon-resource-server.md`, `docs/259-timeline-xenon-publishing.md`, `docs/adr/0016-generated-resources-publish-to-xenon.md` | Amend the older manual-only statements: `review` is a second opt-in exception; timeline remains explicit. |

## Design

### Trigger and configuration

`handleReviewEvent` handles a matching-harness payload as it does now. After it
raises the card, it starts one asynchronous push only when all of these hold:

1. `state === 'registered'` and `registered === true`;
2. `slug` is present and the view has a local project directory;
3. the view is not a remote runtime;
4. fresh `xenon_status(cwd)` says configured and `autoPush` includes `review`.

The status read uses the current config, so Reload Config can enable or disable
the next review without restarting. The call is
`xenon_push({ cwd, kind: 'review', slug, force: false, attention: [] })`. It is
fire-and-forget relative to `review_register`: a Xenon failure cannot fail the
local Board or delay the card.

### Result and retry behavior

Append one compact `[xenon]` system row to the authoring lane after the attempt.
Use the existing report formatter so a pushed result includes its permalink,
an unchanged result says it is current, and a blocked/failed result gives its
reason. If Xenon is configured
in `auto_push` but lacks a usable token or endpoint, report that the automatic
publish was skipped and leave the Board local. Do not flash a transient chip.
Successful push evidence updates the existing backend-link indicator.

An automatic push never uses `--force`; a secret-scan hit remains blocked until
the human inspects it and explicitly runs `#push --force review <slug>`. Transport
failures remain visible in `#xenon status` and can be retried with
`#push review <slug>`. This feature does not add background replay.

### Push coordination and queue

Use one process-wide `OnceLock<tokio::sync::Mutex<()>>` for `xenon_push`, held through resource
collection, network publication, and queue update. This deliberately serializes
pushes across projects to avoid two calls publishing different snapshots of the
same review and racing on one project's queue file. It does not block the UI.

At completion, read the existing queue. For each resource attempted by this
call, replace its `(kind, slug)` entry on a retryable failure; otherwise remove
its old entry. Keep entries for other resources. Atomically replace the queue
file (or remove it when empty). `PushReport.queued` continues to count failures
from this call; `#xenon status` reports the full retained queue depth. If the
queue write fails, return an error that says the upload may have completed but
the retry status was not saved; a repeat push is safe because Xenon deduplicates
identical revisions. Existing manual and attention pushes use the same rule.

### Keybindings and UI

No new keybinding or component. `#push review [<slug>]` and `#xenon status`
remain the keyboard paths for retry and diagnosis.

## Edge Cases

- Pending/cancelled Boards, duplicate `review_register`, and edit-driven refresh
  events do not trigger another automatic upload.
- A manual push and an automatic push for the same bundle serialize; Xenon's
  unchanged response avoids a duplicate revision for identical content.
- Missing token, offline server, blocked secret scan, and a missing/deleted bundle
  leave the local Review Board intact and report the publish result.
- Existing bundles found on startup do not auto-push; opt-in takes effect on the
  next first registration. Later `response.md` edits remain manual revisions.

## Verification

- Frontend tests assert the exact single-review invoke and skipped cases.
- Rust tests cover queue merge across distinct resources, clearing one retried
  resource without dropping another, and atomic queue replacement.
- Run targeted frontend tests, `npm run check`, Rust tests for Xenon publishing,
  `cargo fmt -- --check`, and `cargo clippy`.
- Manual smoke: with `auto_push = ["review"]`, register one Board against a
  reachable test Xenon and verify its permalink; repeat registration and confirm
  no new revision; block one secret and confirm no bytes were uploaded.

Implementation checks: 3,563 frontend tests and production build passed;
25 Xenon-focused Rust tests passed. The full Rust suite passed 402 tests in the
sandbox, and its one listener test passed on an isolated unsandboxed retry.
`cargo clippy --lib -- -D warnings` passed; `--all-targets` still finds three
warnings in untouched test files. The live-app/Xenon smoke above was not run.

## Open Questions

None for this draft: "review result" means the Board at first registration.
Subsequent human responses and document edits remain explicit pushes.

## Out of Scope

Automatic timeline/artifact/analysis publishing, response autosave publishing,
server changes, and automatic replay after a restart.

## Resources

- [GitHub Actions workflow artifacts](https://docs.github.com/en/actions/concepts/workflows-and-actions/workflow-artifacts) — artifact upload as a defined workflow step.
- [SonarQube Server pull-request analysis](https://docs.sonarsource.com/sonarqube-server/2025.1/analyzing-source-code/pull-request-analysis/introduction) — CI-triggered review at defined lifecycle events.
- `docs/211-review-board.md`, `docs/212-xenon-resource-server.md`, `docs/230-xenon-review-excerpts.md`, `docs/259-timeline-xenon-publishing.md`, and ADR-0016 — local contracts and trade-offs.
