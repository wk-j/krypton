# Harness-generated resources publish to Xenon; Xenon never controls Krypton

> Status: accepted
> Date: 2026-08-07

## Context

Everything the ACP Harness produces — HTML artifacts, review bundles, issue
analyses, docs, attention flags — lives only in one machine's working tree under
a gitignored `.krypton/` subtree, readable only through loopback endpoints of a
*running* Krypton. Spec 212 adds Xenon, a separate server that stores this work
product durably.

Two questions follow. Which direction may data and authority flow? And is
publishing automatic?

## Decision

**Xenon is a sink, never a controller.** Krypton pushes resources to Xenon over
an authenticated HTTP API. Xenon has no channel back into a running harness: it
cannot spawn a lane, send a prompt, resolve a permission, or read a transcript.
Remote control of a live harness remains the exclusive job of `/control/v1`
(ADR-0005, ADR-0007), whose authority model is unchanged.

**Publishing is explicit, not ambient.** `#push` is a user action. Bare `#push`
covers the kinds named in `[xenon].auto_push` (all kinds when unset), but nothing
uploads on its own — there is no watcher and no background sync. A secret
pre-scan blocks a resource rather than leaking it, overridable only by an
explicit `#push --force` after the human has looked at the hit.

## Considered Options

- **Bidirectional sync.** Rejected: it would make a remote server an input to
  local agent behaviour, and every `.krypton/` resource is already authored by a
  lane on this machine. Pull has no use case that a git checkout does not serve.
- **Automatic upload on resource seal.** Rejected as the *default*: `.krypton/`
  is gitignored working knowledge that can carry source, absolute paths, and
  credentials. Sending it to a server is publishing, and publishing should be an
  act, not a side effect. `auto_push` exists for users who decide otherwise.
- **Extend `/control/v1` to serve stored resources.** Rejected: that API exists
  to control a running Krypton, and Xenon must serve when Krypton is closed.
- **Reuse the loopback hook server by exposing it beyond `127.0.0.1`.** Rejected
  for the reason ADR-0005 already gives — the hook server is unauthenticated and
  carries harness authority.

## Consequences

Xenon can be operated, restarted, backed up, and firewalled entirely
independently of Krypton; losing it costs published history, never local work.

The human is the transport. A resource is on the server only because someone ran
`#push`, so the server is never more current than the last explicit push — and
`#push` reports what it skipped, blocked, and queued rather than failing quietly.

The secret pre-scan is a guard rail, not a guarantee. It catches the credential
shapes that actually appear in agent output; a novel shape can still pass. Since
blobs are immutable and never auto-deleted, a leaked secret that reaches the
server must be removed there deliberately.
