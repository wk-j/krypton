# Diff Review Priority — Implementation Spec

> Status: Implemented
> Date: 2026-06-14
> Milestone: M8 — Polish
> Decision record: [ADR-0009](adr/0009-diff-review-priority-is-lane-self-reported.md)
> Glossary: **Review priority** in [CONTEXT.md](../CONTEXT.md#review)

## Problem

In the harness workflow a lane produces a **working diff** far faster and larger
than a human can read line-by-line, and the human's attention is the serial
bottleneck (the GIL of the agent fleet). The Diff Window (spec 38, made live by
spec 155 / ADR-0008) still presents *every* hunk in full file order for the
human to read — it was built for the human-authored-diff era. On a 2,000-line
machine-authored diff where 3 hunks are substantive and 200 are mechanical
(generated code, renames, import churn), the human spends their scarcest
resource scrolling past the routine 97% to find the 3% that warrant judgement.

The window does nothing to help the human spend attention where it matters.

## Solution

The authoring lane **self-reports a review priority per change** at the end of
each turn (a default-on MCP tool). The Diff Window uses it to **pre-triage** the
diff: `routine` hunks collapse in place, `high` hunks get a marker and a
dedicated navigation key — but the diff always stays in file order, nothing is
ever hidden, and a folded hunk is always one keystroke from full. The priority
is **advisory**: the human keeps the lock (the silent-pile principle applied to
a diff). This turns the review job from "read every line" into "jump to what the
lane flagged + spot-check the rest on demand."

Built almost entirely from spec-158 primitives — it reuses the
`{file, side, lineStart, lineEnd}` anchor shape and the
diff2html-line-number extractor — plus one new MCP tool and the existing
drain-on-idle / `harness:lane-idle` plumbing. No Rust, no HTTP, no filesystem
watcher.

**Complement, not replacement:**
- **vs spec 158 (review comments)** — 158 carries the *human's notes in* to a
  lane; 160 carries the *lane's reading-order hints out* to the human. Opposite
  direction, same anchor shape.
- **vs attention triage** — a judgement item is one *decision* needing the human
  across lanes; review priority orders *every* hunk for *reading*. Different
  unit (see ADR-0009 Consequences). They compose: a hunk that is the subject of
  a judgement item is pinned `high`.
- **vs review quality matrix (spec 146)** — that observes reviewer findings
  across `#review` rounds; 160 has deliberately **no** accuracy tracking (Q10/
  ADR-0009): expandability is the structural safeguard, not a statistic.

## Design

### 1. The signal (data contract)

Three levels, reported per change by the authoring lane:

| Level | Meaning | Window behaviour |
|-------|---------|------------------|
| `high` | core logic / interface / risk the human asked for | marker in the gutter + target of priority-aware navigation |
| `normal` | **default** — anything unspecified | rendered exactly as today |
| `routine` | mechanical / generated / rename / import churn | collapsed in place (one line), always expandable |

**Silence = `normal`.** A lane that never calls the tool (e.g. a non-Claude
lane that lacks it) yields today's full, uncollapsed diff. This is the safe
degrade path — the feature is purely additive.

### 2. Reporting mechanism — MCP tool, default-on, push per turn

A new tool on the `krypton-harness-bus` server, callable by the authoring lane
at the end of any turn (default-on, mirroring `attention_flag` per spec 130 and
`review_outcome` per spec 146):

```
mark_review_priority {
  ranges: Array<{
    file: string;        // path relative to repo root (post-change name)
    lineStart: number;   // new-side line numbers (the lines it just wrote)
    lineEnd: number;
    level: 'high' | 'routine';   // 'normal' is the default — never reported
    reason?: string;     // optional short explanation shown in priority panels
  }>
}
```

- The lane only reports the **non-default** ranges (`high` / `routine`);
  everything else stays `normal`. Keeps payloads small and intent explicit.
- Each range may include an optional **short `reason`** (capped at 240 chars at
  the tool boundary). Reasons are explanatory labels, not review comments: they
  tell the human why the range was marked, while the range itself still controls
  folding / marking.
- Reported on the **new side** (the post-change lines the lane just wrote, which
  it knows the numbers of). Anchored exactly like a spec-158 comment.
- **Push, not pull.** The lane has already finished its turn; the window cannot
  retroactively ask. A lazy "annotate on open" turn was rejected (ADR-0009) for
  burning an LLM turn per open/refresh against the ADR-0008 budget.
- The latest call for a lane **replaces** that lane's prior report (the diff is
  cumulative working state, so the freshest read wins).

### 3. Anchoring & hunk mapping

The lane reports line *ranges*; the window renders git/diff2html *hunks*. The
window maps them at render time:

- For each diff2html hunk, find reported ranges (same `file`, overlapping
  new-side line numbers) using the **spec-158 extractor in reverse** (read
  `.line-num2` / `.d2h-code-side-linenumber` on the right panel).
- A hunk takes the **highest** priority of any range overlapping it
  (`high` > `normal` > `routine`). So a single `high` range inside an otherwise
  routine hunk keeps the hunk visible.
- A reported range that maps to **no** hunk (drift after a refresh) is dropped —
  the hunk reverts to `normal`. Priority **never mis-folds**; the failure mode
  is always under-collapse (show more), never over-collapse (hide). Same
  best-effort stance as spec-158 pin markers.

### 4. Window behaviour (never hide, never reorder)

- **`routine` → collapse in place.** Rendered as a single summary line
  (`▸ 14 routine lines`) at the hunk's natural file-order position. `Enter` /
  click expands it; expanded state is remembered for the session.
- **`high` → marker + navigation.** A gutter marker (full-cell tint or a
  heading-colour glyph — **never a left accent rail**, per the house rule). A
  new keybinding jumps **only** between `high` hunks (proposed `N` capital /
  `}`; final binding chosen against the existing `n`/`N` hunk-nav at
  implementation — **no Alt**). Plain `n`/`N` still walk all hunks.
- **File order is preserved.** No reordering, ever (Q8). Navigation delivers
  "go to the important part first" without churning scroll anchors (the thing
  ADR-0008 protects).
- **Freshness on auto-refresh.** Auto-refresh (ADR-0008, on `harness:lane-idle`)
  re-maps priority to the new hunks and preserves the current file + scroll +
  expanded-fold state, exactly as it preserves file/scroll today.
- **Header summary.** The nav bar shows a static count
  (`3 high · 18 routine`), consistent with the backpressure-gauge style — depth,
  never motion, no blink/pulse.

### 5. No honesty tracking (Q10 / ADR-0009)

The window does **not** measure label accuracy. Because `routine` only
collapses-but-stays-expandable-in-place, a mislabel costs reading time, never a
missed change — the safeguard is structural. An observation surface (count of
human comments landing on `routine` hunks, à la spec 146) is a possible
second-order feature if real misuse appears, explicitly deferred.

## Architecture wiring

Mirrors spec 158's broker pattern — `DiffContentView` stays decoupled from the
harness:

- **Tool → harness.** `mark_review_priority` lands on `AcpHarnessView`, which
  stores the latest report per lane keyed by repo root.
- **Harness → window.** When the diff view is open over a repo, the compositor
  (already the broker for `refreshProvider` and the spec-158 review channel)
  pulls the current priority report on open and on each refresh — a **pull**, a
  fresh snapshot per refresh, like `resolveDiffReviewTargets()`. No new ViewBus
  broadcast.
- **Multiple lanes / cross-harness.** The report is per authoring lane. Under
  the "one lane edits, others review" workflow there is normally one author; if
  several lanes reported, the window merges (a hunk takes the max across
  reports). The diff is attributed by workflow convention, not provable
  per-line ownership (see [[Authoring lane]]).

## Types (additions to `src/acp/types.ts`)

```ts
/** One lane-reported priority range over the working diff (spec 160). */
export interface ReviewPriorityRange {
  file: string;          // post-change name, repo-relative
  lineStart: number;     // new-side line numbers (inclusive)
  lineEnd: number;
  level: 'high' | 'routine';   // 'normal' is the unreported default
  reason?: string;       // optional short human-readable explanation
}

/** The latest priority report from one authoring lane. */
export interface ReviewPriorityReport {
  laneId: string;
  ranges: ReviewPriorityRange[];
  reportedAt: number;
}
```

(Reuses the spec-158 anchor concept; deliberately **not** the
`DiffReviewComment` type — that carries a human note and an idempotency id this
signal has no use for.)

## Open implementation details (settled in code)

- **`high`-only navigation:** `}` (next) / `{` (prev), cycling with wrap. Plain
  `n`/`N` still walk all hunks; `[`/`]` stay file nav; no Alt. The targets are the
  current file's high-hunk block-header rows (`highHunkAnchors`).
- **Routine summary line:** `▸ N routine line(s) — Enter to expand`, a single
  muted clickable row with a faint accent tint at the hunk's file-order position.
  In side-by-side the matching old-panel row is a blank spacer (keeps the split
  rows aligned without duplicating the label).
- **`high` marker:** a full-cell gutter tint (`.krypton-diff__hl-high` on the
  hunk rows' line-number cells) plus a `◆ high` heading-colour badge on the
  block header — no left accent rail (house rule).
- **Expanded-fold state** is remembered for the session (`expandedHunks`, keyed
  `${fileKey}#${hunkIndex}`), so it survives an auto-refresh / re-render but not a
  window close (the view is disposed).

## Cross-file priority panel (variant B — live preview)

The in-file `}`/`{` nav (above) only walks the **current** file's high hunks. When
`high`/`routine` regions are spread across files, the human had no overview and
had to `t`-switch files by hand. The **priority panel** is a cross-file table of
contents over *every* reported range, opened with **`p`**.

- **Docked, not modal.** The panel docks to the **right** of the diff (300px) in
  a flex content row; `[hidden]` collapses it so the diff reflows to full width —
  no width math, no re-render. It does not cover the diff (unlike the `t`/`?`
  modal overlays), because the whole point is to *watch the diff while browsing*.
- **Live preview on navigate (no `Enter`).** `j`/`k` move the selection **and the
  diff jumps + tints the selected region immediately** — a fast overview without
  committing. This is the deliberate difference from the `t` file switcher
  (confirm-to-jump): the panel is for *scrubbing* the flagged regions.
  - Same-file moves scroll instantly; a **file switch is debounced ~80ms** so a
    fast `j`/`k` run coalesces re-renders (the panel selection still updates every
    keystroke; the diff catches up on the pause).
  - The previewed hunk gets a full-row tint (`.krypton-diff__preview-row`),
    distinct from the `high` line-number marker.
- **Contents & order.** Rows list **`high` first, then `routine`**, each in file
  order (badge `◆ high` / `▸ routine` + `L<start>–<end>` + file path + optional
  reason). The diff itself is **never reordered** (ADR-0009) — only the panel
  groups by level. Ranges whose file is not in the diff (drift) are dropped.
- **Close semantics.** `Enter` / `q` / `p` close the panel and **keep** the
  previewed position; `Esc` closes and **restores** the diff to where it was when
  the panel opened (a cancelled browse).
- **Auto-refresh.** When a `harness:lane-idle` refresh re-renders the diff while
  the panel is open, the items are re-mapped to the new file set, the selection is
  clamped, and the current item is re-previewed (closes if everything drifted).

State lives in `DiffContentView` (`priorityItems`, `prioritySelectedIndex`,
`priorityReturn*`); the panel is built only when the `reviewPriority` channel is
wired, so a diff opened without the harness never grows the dock. Discoverability:
the nav bar shows `p priority · ? help` whenever ranges were reported.

## Implementation note — the MCP tool lives in Rust

The spec's "No Rust" framing held for the *window* (all folding/marking is
frontend DOM work on the already-rendered diff). But the `krypton-harness-bus`
MCP server itself is the Rust hook server, so a new bus tool's schema +
validation + frontend round-trip necessarily land in `src-tauri/src/hook_server.rs`
— exactly as `review_outcome` (spec 146) and `attention_flag` (spec 130) do.
`mark_review_priority` validates the ranges (positive integer new-side lines,
`high`/`routine` level, ≤ 500 ranges), emits `acp-review-priority`, and awaits
the frontend's `{ recorded }`. The frontend (`AcpHarnessView`) stores the latest
report per authoring lane and exposes it via the `diff.review-priority` control
op; the compositor broker merges across harnesses on the repo. No HTTP, no
filesystem watcher, no new persistence — that part of the "no Rust" intent holds.

## Docs to update on implementation

Per `/feature-implementation`: `docs/PROGRESS.md`, `docs/04-architecture.md`
(diff-view subsystem + new MCP tool), `docs/05-data-flow.md` (report push →
pull-on-refresh path). The glossary term and ADR-0009 already landed during
design.
