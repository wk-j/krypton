# ADR-0019 — Per-turn usage is streamed telemetry, not a published resource

> Status: Accepted
> Date: 2026-08-09
> Spec: `docs/214-llm-usage-statistics.md`
> Related: ADR-0016 (generated resources publish to Xenon, explicitly), ADR-0018 (pricing)

## Context

ADR-0016 makes publishing to Xenon **explicit**: `.krypton/` is gitignored
working knowledge that can contain source, absolute paths, and secrets, so
sending it off-box is publishing and a human decides each time. Attention flags
are already the one exception, because they exist only in memory and a flag
nobody remembers to push is simply lost.

Per-turn usage rows arrive ~130 times a day. Two questions had to be answered:
does a row travel inside the resource envelope, and does a human approve each
push?

## Decision

**Usage rows are neither resources nor explicit.** They stream to a dedicated
endpoint (`POST /v1/projects/{p}/usage/turns`) into a dedicated table
(`usage_turn`), continuously and unattended, the moment each turn ends.

Two properties make that safe and correct:

1. **The row is content-free by construction.** Counts, a model id, a lane
   label, a stop reason. No prompt text, no response text, no file paths, no
   tool arguments. There is nothing in it a human would want to review before
   it leaves, which is precisely why ADR-0016's gate does not apply.
2. **The row is not a document.** A resource revision is a sealed snapshot of
   content-addressed files. Appending one 300-byte row to a day would mean
   re-uploading and re-sealing the whole day, and pushing once a day would
   leave the ledger up to 24 hours stale.

Durability comes from a local write-ahead log (`.krypton/usage/<date>.jsonl`)
written *before* any network call, with an ack cursor. Idempotency comes from a
client-generated row id and `ON CONFLICT DO NOTHING`.

## Consequences

- **The ledger has no gaps on busy days.** A push-when-you-remember model fails
  exactly when there is most to measure.
- **Usage is not an `[xenon].auto_push` value.** That list is for kinds whose
  default is manual and whose automation is an opt-in. Usage inverts it:
  `[usage_log].publish = false` is the opt-*out*. One behaviour, one switch.
- **Usage rows get no permalink and no revision history.** They are rows in a
  table, not addressable documents. Answering "spend by model last week" is
  ordinary SQL; answering "show me revision 3 of Tuesday" is not a question
  anyone asks of a counter.
- **Xenon carries a second ingest surface and a schema migration.** The
  resource protocol is untouched, but there are now two ways in, and
  `docs/01-protocol.md` has to describe both.
- **The row shape is the safeguard.** Because no human approves each send, the
  guarantee that a row carries no free text is load-bearing, not stylistic. It
  is asserted in `usage-log.test.ts` so widening the row is a deliberate act.
- **A rejected row is acked anyway.** A row the server will never accept would
  otherwise wedge every row behind it forever. It is logged and skipped; the
  gap is visible in the counts, which is better than a stalled queue.
