# No surface marks state with a left-edge accent rail

> Status: accepted
> Date: 2026-10-30

## Context

A coloured line down only the left side of a row, card or message is the stock way to mark selection, the active item, a status or a kind. The user banned it as a standing aesthetic rule (spec 134 dates it 2026-06-12), and specs 38, 92, 120, 128, 134, 151, 158, 160, 162, 168, 171, 178, 180 and 181 each restate it for their own surface. It was never written down in one place, so new surfaces kept reaching for it: the Rails dock (spec 337) shipped its selected row with an amber `border-left`, which the user flagged on 2026-10-30.

## Decision

No Krypton surface — app chrome, harness components, loopback pages, the browser extension — draws a left-edge accent rail. Selection, focus, the active item, status, kind and emphasis are carried by a background tint, a full 1px border or `outline` (`outline-offset: -1px` keeps it inside the box), or the colour of the text or icon. A neutral divider that separates two side-by-side columns along their full height is layout, not a rail. The rule sits in the Rails below, so the verifier's judge checks every stylesheet change against it.

## Considered Options

- **An enforced check** (a stylesheet scan with `check:<name>`). Rejected for now: telling a rail from a column divider takes judgement a pattern match does not have, and the existing candidates would fail it on the first run. A judge-only rule checks each stylesheet change as it lands.

## Consequences

- The rule is judge-only: the judge sees it only when a run's changed files include a stylesheet, and it sees the diff, not whole files. Rails that predate this ADR are not swept by it; each one goes when its surface is next touched or swept on purpose.

## Rails

Applies to: `src/**/*.css`, `extension/**/*.css`

- No rule draws a left-edge accent rail: a coloured line on only the left side of a row, card, message, block or chip — `border-left` / `border-left-color`, a left-only inset `box-shadow`, or a thin `::before` / `::after` bar — to mark selection, focus, the active item, status, kind or emphasis. Those use a background tint, a full 1px border or `outline`, or text / icon colour. A neutral divider separating two side-by-side columns along their full height is not a rail.
