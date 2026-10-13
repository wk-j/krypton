# ADR-0022 — Handoffs are the one resource Krypton pulls from Xenon, and only on a human command

> Status: Accepted
> Date: 2026-10-13
> Spec: `docs/0293-global-handoff-resume.md`
> Related: ADR-0016 (Xenon is a sink, never a controller), ADR-0023 (handoff identity), spec 139 / 165

## Context

ADR-0016 rejected bidirectional sync: a remote server must not become an input to local agent
behaviour, and "pull has no use case that a git checkout does not serve." A handoff breaks that
premise. It is not in git, it lives in `~/.config` on one machine, and it exists to be read by a
*different* session, which may run in another lane, backend, or machine.

## Decision

Krypton may read **one** kind back from Xenon, `handoff`, and only when a human types `#resume`.
Krypton fetches the document itself and injects it as a one-shot prompt that frames it as
possibly-stale data. No agent tool reads Xenon and nothing is pulled in the background. The fetched
text is never written into the local store. The resuming lane adopts only the handoff's **id**, so
its own later `#handoff` continues the same thread, and a later push adds a revision to the same
Xenon resource.

Xenon is still not a controller: it cannot start, prompt, or steer a lane. A human command decides
when a document enters a lane.

## Considered Options

- **An MCP tool (`handoff_get { source: "xenon" }`).** Rejected: an agent could pull remote content
  on its own initiative, which is the input path ADR-0016 closed. Lanes without MCP could not resume.
- **Copy the fetched document into the local store.** Rejected: the local store would hold text no
  local lane wrote, and a later local edit would silently fork it.
- **Allow pull for every kind.** Rejected: reviews, artifacts, and analyses have no resume
  semantics, and other machines already see them in the browse UI.

## Consequences

- Bare `#resume` makes a network read when Xenon is enabled. It falls back to local handoffs and
  states why.
- Resume from Xenon needs a token with `resource:read`. Push-only tokens still push.
- The trust boundary is the user's own Xenon account. A handoff is only as safe as whoever can write
  to that project. The prompt frames it as data, but that is guidance, not isolation.
- Pulling any other kind needs its own ADR. This exception does not generalize.
