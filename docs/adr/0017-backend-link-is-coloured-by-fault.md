# The backend link indicator is coloured by fault, unlike the review depth gauges

> Status: accepted
> Date: 2026-08-08

## Context

Krypton's workspace footer now carries four `sourceId`-keyed indicators in its
right-hand global cluster, and two different colour policies already coexist
there:

- the **attention gauge** (spec 128/138) is coloured by reversibility tier,
  because an open [[Judgement item]] is demand on the human;
- the **review-count** (spec 146, ADR-0004) and **review-priority** (spec 162,
  ADR-0009) gauges are deliberately *never* coloured, because they are advisory
  depth — "N things recorded, press to inspect" — and colouring depth trains the
  eye to ignore colour.

Spec 213 adds a fourth: the backend link indicator, showing whether the
off-machine Xenon resource server (spec 212 / ADR-0016) is reachable with our
credential. Without a stated rule the next indicator gets its colour decided by
whoever writes it, and the footer's colour vocabulary quietly stops meaning
anything.

The concrete problem the indicator solves is that `#xenon status` reports
*configuration*, not connectivity: it reads the TOML and asks the OS credential
vault whether a token exists, and never issues a request. A server that is down,
a revoked token, and a perfectly healthy link are indistinguishable until a
`#push` fails.

## Decision

**The footer colours an indicator when, and only when, it represents a fault or
a demand the human must act on. It never colours advisory depth.** Applied to
the backend link:

- **`linked` is not coloured.** It renders at the footer's muted foreground,
  same as the depth gauges. A healthy link is ambient information and must not
  compete with the attention gauge for the eye.
- **`unauthorized` is coloured warning (amber), `offline` coloured fault (red).**
  Both are demand: every publish silently fails until the human acts, and the
  two have different fixes (store a token vs. bring the server up), so they are
  distinguished rather than collapsed into one "broken" state.
- **`off` hides the segment entirely** rather than showing it greyed. The
  footer's established idiom is to stay quiet about subsystems that are switched
  off, not to advertise them. An unconfigured backend is not a fault.
- **Static, like every other footer chip.** Colour carries the state; there is
  no pulse, blink, or animation (the spec-128 static-by-design rule).
- **The tooltip carries the fix, not just the state.** A segment has room for a
  colour and a word; a human who sees a fault needs the server URL, the project
  slug, when it was last checked, and the concrete remedy.

The probe backing it is one authenticated `GET /v1/projects`. The server's
`/healthz` cannot see the bearer token, so a probe against it would report green
while a revoked credential blocked every push; the authenticated route
distinguishes *unreachable* (transport error), *unauthorized* (401/403), and
*linked* (2xx) in a single request.

## Considered Options

- **Never colour the link either, for consistency with the two review gauges.**
  Rejected: it optimises for a surface rule ("footer gauges are neutral") over
  the actual one. A broken link is not "N things to inspect at your leisure" —
  it is publishing being silently broken, which is precisely the class the
  attention gauge is already coloured for.
- **Colour `linked` green.** Rejected: an always-on green teaches the eye that
  footer colour is decorative, which then costs the amber and red their meaning.
  Green-when-fine is also the state you spend 99% of your time in — paying
  attention budget for the uninteresting case.
- **Show a greyed segment when Xenon is off.** Rejected: it advertises a
  subsystem the user has switched off, on a footer whose scarcity is the point.
  The user who turns Xenon on will see the segment appear, which is a clearer
  signal than a permanent grey one.
- **Poll `xenon_status` instead of adding a probe.** Rejected: it reports
  configuration only, never touches the network, and opens an OS
  credential-vault entry on every tick — it would answer green for a dead
  server.
- **Update only on push (no probe).** Rejected: accurate, but only *after* a
  failure — exactly the situation the indicator exists to pre-empt. Kept as a
  supplement: a completed push is stronger evidence than a probe and costs no
  extra request, so it publishes the same signal.
- **A blinking or pulsing fault state.** Rejected: motion in a persistent status
  bar is a permanent tax on peripheral vision, and spec 128 already settled that
  the footer encodes state statically.

## Consequences

- The footer's colour vocabulary now has one legible rule — *colour means the
  human has something to do* — that the next indicator can be checked against
  instead of re-litigated.
- The two review gauges (ADR-0004, ADR-0009) stay neutral, and this ADR is the
  record of *why* the link diverges from them rather than an inconsistency.
- The signal is `backendId`-keyed, so a second backend can publish into the same
  segment without a footer change. When more than one publishes, the worst state
  wins the segment — that is the one the human has to act on.
- The indicator reports the link, not the queue. Draining Xenon's retry queue on
  reconnect remains a separate, unsolved concern.
