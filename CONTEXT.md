# Krypton

Keyboard-driven terminal emulator (Rust + Tauri + xterm.js) with a cyberpunk aesthetic. A single fullscreen transparent native window hosts DOM-based terminal "windows" and an ACP harness that drives multiple AI agent lanes in parallel.

## Language

**Workspace**:
A virtual desktop — a full-screen arrangement of terminal windows.
_Avoid_: desktop, screen

**Window**:
A DOM-based terminal instance with custom chrome. Never a native OS window.
_Avoid_: pane (a pane is a split *inside* a window), tab

**Lane**:
One ACP agent session inside the harness. Carries a `HarnessLaneStatus` (`starting | idle | busy | needs_permission | awaiting_peer | error | stopped`), an inbox, and optionally a bound directive.
_Avoid_: agent (ambiguous — could mean the backend process or the pi-agent), thread

**HTML artifact**:
A browser-rendered, possibly interactive HTML view a lane hands to the human: the lane writes it to a harness-issued path under `.krypton/artifacts/` and registers it, and the human opens it on demand in the OS browser. A live, editable file — the lane may iterate on it across turns — not an immutable snapshot. An opt-in, ephemeral deliverable a lane *chooses* to emit (normally swept on harness close; stale leftovers swept on startup) — never the harness's default output format. Distinct from the lane's transcript text and from tool output.
_Avoid_: prototype (a `docs/prototypes/*.html` is an author-side design mockup committed to this repo, not a lane-registered artifact), preview, output (a lane's ordinary turn text is its output; an artifact is a separate registered thing)

### Attention

**Attention triage**:
The act of distilling, from the activity of many lanes, the specific items that genuinely require the human's judgement — and surfacing them in one place for batched review. The human's attention is treated as the single serial bottleneck (the GIL of the agent fleet); triage exists to spend that bottleneck only on judgement, never to interrupt or "capture" the human's focus.
_Avoid_: extract attention (directional ambiguity — sounds like grabbing the human's focus), notify, alert

**Judgement item**:
The unit of attention triage. A single, specific decision extracted from within a lane's work that genuinely requires the human's judgement (e.g. "approve this auth-schema change", "pick a direction at this architectural fork") — *not* a whole lane and *not* a whole turn. The boring, machine-verifiable 80% of a turn never becomes a judgement item.
_Avoid_: task, todo, alert, notification, review request (a review request is a lane-to-lane peer message; a judgement item targets the human)

**Demand queue**:
The set of open judgement items — the things that actively call for the human's attention. Triage is a *router*, not a *gatekeeper*: the demand queue ranks what to look at first, it never decides on the human's behalf that something needn't be looked at.

**Silent pile**:
Every completed turn that produced no judgement item, plus any judgement item a lane has *self-resolved* (retracted because it answered its own question). Reviewable on demand but never demanding. A silent or self-resolved entry means "the machine handled it," *not* "auto-approved and discarded" — nothing leaves the system, it only stops demanding attention. The pile is how the human keeps the lock without being interrupted.

**Backpressure gauge**:
The single ambient signal of the triage UI: a static count of open judgement items (queue depth). It exists so the human can scale the agent fleet to their own review rate — the consumer seeing the producer's backlog — *not* to announce activity. It shows depth, never live motion; it does not blink, pulse, or alert.
_Avoid_: notification badge, alert count

**Triage grant** (spec 129):
A directive property (`triage_equipped`) that lets any lane *spawned* with that directive call `attention_flag` from its first turn — the per-lane opt-in sourced from a role rather than a keystroke. A *spawn-time default*, not live reconfiguration: flipping it does not retroactively equip a running lane.
_Avoid_: triage permission (a manual override can supersede it, so it is a default not a hard permission), enable triage (the feature is always on; the grant is per-lane)

**Manual equip** (spec 129, legacy):
A runtime override of a lane's triage grant — wins over the directive-sourced grant until the lane is closed or a new directive is assigned. Spec 130 made attention triage **default-on for every lane**, which retired the need to manually equip; the `setTriageEquipped` store path remains as legacy API but no leader key invokes it. The `Leader '` chord it once used is **now the Review Matrix overlay** (spec 146) — do not document `Leader '` as manual equip.

**Lane peek heat**:
The existing *deterministic* score that ranks lanes by activity (tools / tokens / peer / process) plus an alert boost (error > needs_permission > pendingShell > awaiting_peer). The pre-LLM baseline that attention triage builds on or replaces.
_Avoid_: priority, importance score

### Knowledge

**Code wiki**:
A persistent, LLM-maintained set of interlinked markdown pages capturing the *why* of a codebase — architectural rationale, domain model, trade-offs, and external research — **not** a re-summary of the code itself. Lives as markdown in the *target* project the lane operates on (`<cwd>/docs/wiki/`), so git gives version history and a human can browse it. The code plus git history is the source of truth for *what/how*; the code wiki owns *why/decisions/domain*, the layer the code does not record. A compounding artifact: the LLM integrates each new decision into existing pages rather than re-deriving it on every question. A **generic harness capability**, not specific to the Krypton repo — any lane in any project can maintain its project's wiki.
_Avoid_: docs (too broad — a code wiki excludes derived/how-to docs that restate code), index (the catalog file is one page *in* the wiki, not the wiki), harness memory (the per-lane `memory_*` store is ephemeral working/handoff state, kept outside the repo — the code wiki is persistent shared knowledge committed to the repo)

### Review

**Authoring lane**:
The single lane that edits the shared worktree and convenes a `#review` over its own working diff — the producer of the work under review, as distinct from the reviewer lanes that only read and report. Meaningful only under the "one lane edits, the others review" workflow; because every lane in a harness view shares one worktree, the diff is attributed to the authoring lane by *convention of that workflow*, not by per-line ownership the system can prove.
_Avoid_: requester (too generic — every peer message has a requester), convening lane (the act of convening; "authoring" names the role that owns the work), owner

**Review quality matrix**:
A per-session, in-memory surface that accumulates a small **summary** of each `#review` round against an [[Authoring lane]]'s work — the raw blocker/warning counts the reviewers reported (plus a subject label and reviewer count), shown as *history per lane*. An **observation, not a score**: it never blends those counts into a single quality number, never grades, and never ranks lanes — it shows how many problems reviewers kept finding so the human eyeballs a trend. The authoring lane self-reports the summary at synthesis time; the matrix keeps no fine-grained per-review detail (no stored diff size, no jump-back-to-transcript anchor) — the real reviewer replies live in scrollback. Surfaced exactly like attention triage: a neutral depth indicator in the workspace status bar (a count of reviews recorded, *not* an alarm) plus a summon-on-demand overlay.
_Avoid_: quality score (the explicit thing it refuses to be), lane grade, verdict, leaderboard, ranking
