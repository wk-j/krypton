# Diff review priority is lane-self-reported and may only fold, never hide or reorder

> Status: accepted
> Date: 2026-06-14

## Context

In the ACP harness workflow a lane produces a [[Working diff]] far faster and
larger than a human can read line-by-line, and the human's attention is the
serial bottleneck (the GIL of the agent fleet). The Diff Window (spec 38, made
live by spec 155 / ADR-0008) still presents every hunk for a human to read in
full file order — built for the human-authored-diff era, not the
machine-authored one. We want the window to *pre-triage* the diff so the human
spends attention on what warrants it.

The danger is the obvious one: any pre-triage that lets the producer's opinion
*suppress* content is a fox guarding the henhouse — if a lane mislabels a hunk
that deletes logic as "just a rename," the human skips real risk. That is worse
than no triage at all.

## Decision

The Diff Window gains a **[[Review priority]]** signal with these properties:

- **Source — the authoring lane self-reports it.** At the end of each turn the
  lane calls a default-on MCP tool (`mark_review_priority`) reporting, per
  change, one of three levels: `normal` (default), `routine`, or `high`. This
  follows the established self-reported-router pattern (ADR-0001 attention
  triage, ADR-0004 review matrix) rather than computing salience with
  deterministic heuristics in the window.
- **Anchoring — line-range, reusing the spec-158 anchor shape**
  (`{file, side, lineStart, lineEnd}`). The window maps each git/diff2html hunk
  to the overlapping reported ranges; a hunk takes the highest priority of any
  range overlapping it.
- **Authority — it may fold and navigate, never hide and never reorder.**
  `routine` hunks collapse **in place** (always expandable); `high` hunks get a
  marker and are the targets of priority-aware navigation (a keystroke jumps
  only to them). The diff always stays in file order. Nothing ever leaves the
  human's reach — the [[Silent pile]] principle applied to a diff.
- **Safe defaults everywhere.** Silence means `normal`: a lane that never calls
  the tool (e.g. a non-Claude lane) yields today's full diff. A priority whose
  anchor drifts after a refresh reverts to `normal` rather than mis-folding.
- **No honesty tracking (for now).** We do not measure how accurate a lane's
  labels are. Because `routine` only collapses-but-stays-expandable-in-place,
  the safeguard against a bad label is **structural** (the human can always
  expand), not statistical, so a tracking surface would solve a problem the
  expandability already neutralizes.

## Considered Options

- **Window computes salience with deterministic heuristics** (test files later,
  import blocks folded, large deletions boosted). Rejected: this is the kind of
  guessing-on-the-human's-behalf ADR-0008 already refused; "imports = boilerplate"
  is exactly the heuristic that erodes trust.
- **A separate reviewer lane scores the diff.** Rejected for v1: it spends a
  whole extra lane/turn to produce what the authoring lane already knows from
  its own intent.
- **Priority may hide low-value hunks.** Rejected: hiding hands the
  keep-or-drop decision to the AI and violates the silent-pile principle (a
  folded thing means "the machine thinks this is routine," not "approved and
  discarded").
- **Priority reorders hunks (high floats to top).** Considered and initially
  attractive as an "importance order, not path order" stance, but rejected:
  priority-aware *navigation* already delivers "go to the important part first"
  without churning scroll anchors (the very thing ADR-0008 protects), without
  breaking the file-order mental model, and without making the spec-158 line
  anchors ambiguous.
- **Lazy pull** (the window asks the lane to annotate the diff on open/refresh).
  Rejected: it burns an extra LLM turn on every open and re-runs on every
  refresh — against the budget ADR-0008 set out to protect.
- **Honesty observation** (count when a human comments on a `routine` hunk, à la
  the review matrix) and a **cap** on the `routine` fraction. Both deferred: the
  first is a reasonable second-order feature to add if real misuse appears; the
  cap is arbitrary and would punish legitimately-all-routine diffs (a 30-hunk
  mechanical rename *should* be 100% routine).

## Consequences

- Lanes that don't implement the tool degrade silently to the current full
  diff — the coupling is one optional MCP tool, not a hard dependency.
- The signal is advisory by construction: every level is recoverable by the
  human (expand a fold, ignore a marker), so a wrong label costs reading time,
  never a missed change.
- This is a distinct concept from [[Attention triage]]: a [[Judgement item]] is
  one *decision* needing the human across lanes; review priority orders *every*
  hunk for *reading*. They compose — a hunk that is the subject of a judgement
  item is pinned high — but they are different units and must not be merged.
