# ADR-0018 — LLM usage is priced by Xenon at read time, not by Krypton

> Status: Accepted
> Date: 2026-08-09
> Spec: `docs/214-llm-usage-statistics.md`
> Related: ADR-0016 (publishing is explicit), ADR-0019 (usage is telemetry)

## Context

A per-turn usage row carries token counts and a model id. Turning that into
money needs a rate table, and there are three places it could live and three
moments it could be applied:

1. **In Krypton, at record time** — the row would arrive at the server already
   priced.
2. **In Xenon, at ingest time** — the Langfuse model: cost is computed once, on
   insert, and stored on the row.
3. **In Xenon, at read time** — the row stores tokens only; every report prices
   them from the current table.

Most agent lanes are subscription-billed (Claude, Codex) and report no cost at
all, so an estimate is the only number those lanes will ever have. Some lanes
(Cursor, OpenCode) do report one.

## Decision

**Xenon owns the rate table and prices at read time.** Krypton records tokens
and a model id and nothing else. A turn's adapter-reported cost, when it has
one, is stored as reported and shown in its own column; it is never merged with
an estimate and never overwritten by one.

The table is `$XENON_DATA_DIR/prices.json` — a data file, not a compiled-in
constant — matched by pattern per LiteLLM/Langfuse convention, first match wins.

## Consequences

- **Correcting a price corrects history.** A provider changes a rate; the
  operator edits one file and restarts; every report — including last quarter's
  — is right. Under (1) or (2) the wrong number is frozen into rows already
  written and can only be fixed by a migration nobody will write.
- **Krypton ships no prices.** It cannot get them wrong, cannot go stale between
  releases, and needs no update mechanism for them.
- **`#usage` in the composer can only show *reported* cost.** The estimate lives
  where the table lives. This is the real cost of the decision: the in-app
  read-out is honest but incomplete for subscription lanes, and the full picture
  is one `#usage open` away.
- **An unmatched model is blank, never zero.** `estimate()` returns `None` and
  the model is named in `unpriced[]`. An all-zero entry — the shape
  `prices.example.json` ships — is treated as *unfilled*, not as free, so a
  copied-verbatim table never bills `$0.0000` with confidence.
- **Restart is the reload.** The table is read once at boot. An operator editing
  rates wants to see the new numbers deliberately, not discover them mid-read.
