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

**Harness Controller CLI**:
An external command-line client that connects to the running Krypton instance to observe and control its ACP harnesses and lanes. It controls Krypton itself; it is neither an ACP agent lane nor a standalone ACP client that bypasses Krypton.
_Avoid_: ACP agent CLI, standalone ACP client

**Telegram Controller**:
A remote conversational control surface, available in private and group chats while the Krypton application is running, through which an authorized Telegram user can exercise the full control authority of Krypton's ACP harness, including lane lifecycle actions and permission decisions. It controls existing harnesses and lanes; it is neither a [[Lane]] nor an inter-lane peer.
_Avoid_: notification bot (it can act, not merely notify), Telegram lane (it is a controller, not an ACP session), peer

**Authorized Telegram user**:
A Telegram account whose immutable numeric user ID appears in Krypton's configured allowlist. Only messages attributable to an account on this allowlist may exercise [[Telegram Controller]] authority.
_Avoid_: Telegram username (mutable and reusable), chat ID (identifies a conversation rather than the acting person), bot administrator

**Authorized Telegram chat**:
A private chat belonging to an [[Authorized Telegram user]], or a group chat whose immutable numeric chat ID appears in Krypton's separate configured chat allowlist. A group command is admitted only when both the acting user and the group are authorized.
_Avoid_: known chat (prior contact does not grant authority), bot-member group (adding the bot does not authorize a group), public group

**Telegram target lane**:
The process-local [[Lane]] selected for one [[Authorized Telegram chat]] as the destination for its admitted Telegram messages and control actions. Selecting it also subscribes that chat to all subsequent observable activity in the shared lane, regardless of who initiated that activity. The selection remains until an authorized user changes it, its harness or lane closes, its ACP session is replaced, or Krypton exits; Krypton never persists the selection or silently substitutes another lane.
_Avoid_: active lane (already means the lane active in the in-app harness UI), per-user target (members of one group share a target), default lane (the target is an explicit per-chat selection), bound lane (the selection is replaceable)

**Telegram message provenance**:
Trusted metadata attached by Krypton to a Telegram-originated prompt that identifies Telegram as the source and records the sender's numeric user ID and display name. It remains separate from user-authored prompt text so the sender cannot forge or erase the audit identity.
_Avoid_: sender prefix (ordinary text can be forged), username tag (usernames are mutable), prompt decoration

**Admitted Telegram message**:
A message from an [[Authorized Telegram user]] in an [[Authorized Telegram chat]] that the [[Telegram Controller]] accepts as intentional input. Ordinary text is intentional in a private chat; in a group it must use `/ask`, mention the bot, or reply directly to a bot message.
_Avoid_: group message (most group conversation is ignored), Telegram update (updates also include callbacks and unrelated events), forwarded message

**Telegram operational digest**:
The compact Telegram projection of a [[Lane]]'s observable activity: live assistant text, summarized tool progress, permission requests, status changes, and errors. It omits thought/reasoning events and keeps detailed history available on demand through the transcript command.
_Avoid_: transcript mirror (the digest intentionally suppresses noisy event detail), notification feed (it is live interactive session output), reasoning stream

**Telegram bypass policy**:
The permission policy carried by every Telegram-originated prompt, including while it waits in a lane queue: all permission requests raised during that prompt's turn are accepted automatically, including high-risk operations. The policy ends with that turn and never changes the lane's persistent permission mode or applies to turns from another source.
_Avoid_: lane bypass (the whole lane is not placed in bypass mode), permission approval (there is no interactive decision), trusted prompt (the content remains untrusted even though its turn has execution authority)

**Telegram bot credential**:
The secret Bot API token used by Krypton's Telegram backend, stored in the operating system's credential vault and never returned to the frontend or control clients. Application configuration records only whether Telegram is enabled and which identities are authorized.
_Avoid_: bot token setting (ordinary settings are frontend-visible), environment variable (GUI launches do not reliably inherit shell state), config value

**Telegram Settings**:
The keyboard-operable in-app configuration surface for enabling the [[Telegram Controller]], setting or removing its credential, managing user and chat allowlists, and observing redacted connection health. It exposes credential presence but never the stored token value.
_Avoid_: general settings (Krypton has no general settings view), token viewer, Telegram dashboard (session control remains in Telegram and the harness)

**Telegram pairing request**:
A short-lived enrollment proposal created when someone submits a locally generated single-use code to the Telegram bot. It records the numeric sender and chat identities for local review but grants no authority until a human accepts it in [[Telegram Settings]].
_Avoid_: login (Telegram already authenticated the account), authorization code (the code alone grants nothing), invitation (acceptance changes Krypton's local allowlists)

**Goal** *(removed 2026-09-01 — duplicated the Active Ticket panel, spec 238; spec 148 marked Removed)*:
A declared, single-task **focus scope** bound to one [[Lane]]: a short statement of what this lane is currently working on. Its purpose is *scoping and focus*, not autonomy — it (a) keeps the agent anchored to that task so it does not drift onto unrelated work, and (c) reminds the human which task this lane is on. Setting a goal **clears the lane** (fresh ACP session + empty transcript, equivalent to `#new`) so the lane refocuses with nothing from before bleeding in; harness `memory_*` state and the peer inbox/pending sends are **left untouched**. A goal does **not** auto-continue the lane across turns and is **not** checked for completion — there is no evaluator and no self-reported "done". It persists, purely as scope, until the human replaces it (a new goal) or clears it.
_Avoid_: completion condition / "keep working until met" (that is Claude Code's `/goal`, a different feature — autonomy via an independent evaluator; Krypton's goal borrows the name and the clear-on-new behaviour but **not** the auto-loop or the evaluator), directive (a [[Lane]] directive is a persistent role/persona; a goal is the current *task*, set ad-hoc and cleared freely), task/todo (a goal is one active scope per lane, not a tracked list)

**HTML artifact**:
A browser-rendered, possibly interactive HTML view a lane hands to the human: the lane writes it to a harness-issued path under `.krypton/artifacts/` and registers it, and the human opens it on demand in the OS browser. A live, editable file — the lane may iterate on it across turns — not an immutable snapshot. An opt-in, ephemeral deliverable a lane *chooses* to emit (normally swept on harness close; stale leftovers swept on startup) — never the harness's default output format. Distinct from the lane's transcript text and from tool output.
_Avoid_: prototype (a `docs/prototypes/*.html` is an author-side design mockup committed to this repo, not a lane-registered artifact), preview, output (a lane's ordinary turn text is its output; an artifact is a separate registered thing)

### Verbs

**Verb**:
A built-in, one-job system prompt shipped inside Krypton and injected into a [[Lane]] on demand — the harness's own action vocabulary (e.g. `#dispatch-github-issue`, `#polly`, `#wiki`, `#review`). Invoked from the composer's `#` palette as `#name [args]`; the harness resolves the name to a prompt builder and sends the rendered prompt as the lane's next turn. **Built-in and project-agnostic**: works in every lane in every project with no per-project `.claude/skills/` or config. The lane carries out the verb with the tools it already has (`gh`, edit, bash) — a verb adds no MCP tool of its own.
_Avoid_: skill (an agent-side `.claude/skills/*` file the *agent* discovers per-project — a verb is harness-side, embedded, and project-agnostic; the harness only surfaces discoverability, it does not ship agent skills), MCP tool (a verb is prompt text, not a callable tool with a schema), slash command (the agent-provided `/` palette; verbs are the harness-owned `#` palette), `#` command (the invocation *syntax*; "verb" names the thing invoked)

**Composed verb**:
A [[Verb]] whose prompt **embeds other verbs as tokens**: a verb name is a token (e.g. `{{#analyze-github-issue}}`) that may appear *inline anywhere* inside another verb's prompt prose. When the composing verb is invoked, the resolver **substitutes each verb token with that referenced verb's full prompt text**, yielding ONE combined prompt sent to the lane in a **single turn**. It is NOT a serial pipeline `[a → b → c]` — the composing verb is free-form prompt prose (with its own connective / conditional instructions) into which verb tokens are injected wherever, however many times, the author needs. This inline-token substitution is the *only* new mechanism composition adds; verbs remain plain prompts. A composed verb is itself a verb — it can be called directly or nested inside another composed verb. Only prompt-verbs are injectable as tokens (a token resolves to prompt *text*); a control-op verb — one that performs an operation rather than carrying prompt text, e.g. `#dispatch-github-issue`, which spawns/targets a lane and clears its session — has no text to substitute and cannot be a token.
_Avoid_: workflow engine / pipeline runner (there is no multi-turn driver or prompt queue; substitution is resolved once, at invocation, into a single prompt), serial chain / step array (it is not an ordered list of verbs run in sequence — tokens are embedded in prose, not chained), orchestration (that is the [[Orchestrator]] fanning work across many lanes; a composed verb runs on one lane in one turn)

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

**Docs browser** (spec 171):
A read-only loopback web surface that renders the markdown files **already in a harness's working directory** (`<cwd>`) in the OS browser — the browser-facing reader for a repo's `docs/`, ADRs, README, and [[Code wiki]]. A *renderer*, not a store: it owns no files, generates nothing, and reflects whatever markdown is committed/present under `<cwd>` (filtered through `.gitignore`, `.git/` excluded). Served by the same loopback server as the [[Artifact gallery]] and the lane monitor dashboard, harness-grouped, addressed by **repo-relative path with no token** (path validated under `<cwd>`, symlinks-out rejected). Files render server-side (comrak, raw HTML escaped); each rendered page is a full standalone HTML page (a flat, filterable list of every repo `.md` path for the index; content only for one file) so every doc has a bookmarkable URL, and intra-repo `.md` links are rewritten to navigate within the browser.
_Avoid_: Vault Viewer (the *in-app* `.krypton-vault` markdown viewer — the Docs browser is the *external-browser* counterpart), Code wiki (the Docs browser *renders* a code wiki when one exists, but it serves all repo markdown, not only `docs/wiki/`), artifact gallery (that lists lane-authored registered HTML under `.krypton/artifacts/`; the Docs browser reads pre-existing repo markdown the harness never created), docs server (it does not generate or build a doc site)

### Review

**Working diff**:
The full uncommitted state of a worktree as one reviewable unit: tracked modifications *plus* untracked, non-ignored files (rendered as pure additions). The subject `#review` packages for reviewer lanes and the thing the Diff Window displays. A displayed working diff is **stale** the moment any lane writes after the snapshot was taken.
_Avoid_: git diff (the plain command omits untracked files, which are first-class lane output), changes (too vague — could mean one turn's edits or one tool call's diff)

**Review priority**:
A per-*hunk* hint, **self-reported by the [[Authoring lane]]** as it finishes a turn, ranking how much each change in the [[Working diff]] warrants the human's eye (core logic the human asked for vs. routine/mechanical edits). The Diff Window uses it to collapse routine hunks **in place** (the diff always stays in file order — it never reorders) and to drive priority-aware navigation (a keystroke that jumps only to high-priority hunks) — but **never to hide**: a low-priority hunk is collapsed-yet-expandable, never removed, so nothing leaves the human's reach (the [[Silent pile]] principle applied to a diff). **Advisory, not a verdict** — a lane grading its own diff cannot be trusted to *suppress*, only to *suggest reading order*; the human keeps the lock.
_Avoid_: salience (too abstract for the human who types in English), severity/risk score (it is reading-order guidance, not a graded judgement), attention triage (that surfaces discrete *decisions* needing the human's judgement across lanes; review priority orders *every* hunk for reading — a hunk that happens to be the subject of a [[Judgement item]] gets pinned to the top, but the two are different units), lane peek heat (ranks whole lanes by activity, not hunks within one diff)

**Authoring lane**:
The single lane that edits the shared worktree and convenes a `#review` over its own working diff — the producer of the work under review, as distinct from the reviewer lanes that only read and report. Meaningful only under the "one lane edits, the others review" workflow; because every lane in a harness view shares one worktree, the diff is attributed to the authoring lane by *convention of that workflow*, not by per-line ownership the system can prove.
_Avoid_: requester (too generic — every peer message has a requester), convening lane (the act of convening; "authoring" names the role that owns the work), owner

**Review Board** (spec 211):
A **lane-authored review document** the human reads in a dedicated Krypton content window and answers once — ordinary Markdown plus a small set of typed fenced blocks (`walkthrough`, `diff`, `finding`, `decision`, `chart`, `metrics`, `svg`) the harness can count, anchor, and route. Its job is **comprehension, not defect-hunting**: the spine is prose plus a `walkthrough` (an ordered, `file:line`-anchored tour in reading order), and findings and decisions are *additions* — a Board with zero of either is the normal shape of a clean review ("here is what this code does, and it is sound"), labelled `reference` rather than given a completion status. Its subject need not be a [[Working diff]]: a lane can compose one over a design doc or over existing code the human wants explained, so the archive doubles as a growing set of explanations of the codebase. Authored by the same path-handoff as an [[HTML artifact]], but the result is a **[[Review bundle]]**, not a swept file.
_Avoid_: review (bare "review" means the `#review` multi-reviewer round; the Board is the *document* that round now produces), report, findings list (a Board that is only findings is the failure mode it was built to replace), HTML artifact (that is arbitrary mouse-first HTML in the OS browser, opaque to the harness; a Board is keyboard-native, in-app, and semantically typed — they coexist, and a block may link to an artifact), diff view (the Board links *into* the Diff Window rather than absorbing it)

**Review bundle** (spec 211):
The on-disk result of a [[Review Board]]: a gitignored, **subject-keyed** directory at `.krypton/reviews/<date>-<slug>/` holding the lane's composition (`review.md`), the human's answers (`response.md`, autosaved as they are made), and any images the lane attached (`assets/`). Follows the `.krypton/analyses/` convention — **never session state**: it is found by walking the directory, so it outlives the lane, the harness view, and the app, and reopening it next week restores every triage decision, answer, and comment. **Never swept**: an artifact is a throwaway view, a review is a record, so a bundle persists until the human deletes it. Browsable read-only at `/reviews` (`#reviews`); *worked* in the app with `Leader Shift+R`.
_Avoid_: artifact scratch (`.krypton/artifacts/` is session-keyed and swept; a bundle is date/title-keyed and permanent), session state, cache, log (a bundle is the reviewed artifact itself, not a record of events)

**Review quality matrix**:
A per-session, in-memory surface that accumulates a small **summary** of each `#review` round against an [[Authoring lane]]'s work — the raw blocker/warning counts the reviewers reported (plus a subject label and reviewer count), shown as *history per lane*. An **observation, not a score**: it never blends those counts into a single quality number, never grades, and never ranks lanes — it shows how many problems reviewers kept finding so the human eyeballs a trend. The authoring lane self-reports the summary at synthesis time; the matrix keeps no fine-grained per-review detail (no stored diff size, no jump-back-to-transcript anchor) — the real reviewer replies live in scrollback. Surfaced exactly like attention triage: a neutral depth indicator in the workspace status bar (a count of reviews recorded, *not* an alarm) plus a summon-on-demand overlay.
_Avoid_: quality score (the explicit thing it refuses to be), lane grade, verdict, leaderboard, ranking

### Orchestration

**Orchestrator** (spec 180):
A [[Lane]] designated as the harness's coordination seat — a privileged, *tool-bearing* role, the first asymmetric role in a system otherwise built on equal peer lanes. The designation is **behavior-neutral**: it unlocks the [[Orchestrator console]], reserves the lane as the home for orchestrator-only tools (added by later specs), and badges it — but it does **not** itself change how the lane's model acts. Autonomous coordination — proactively [[Dispatch]]ing work to other lanes and looping on their replies until a goal is met — is supplied by running `#polly` on the lane (the existing orchestration prompt), which an orchestrator is the natural home for; the role and that behavior stay decoupled (you can be an orchestrator without an active `#polly` run, and `#polly` remains a one-shot verb usable anywhere). When autonomy *is* running, the human is never displaced as the bottleneck for *judgement*: the orchestrator escalates genuine forks through [[Attention triage]], and the human — watching from the console — keeps lifecycle override (interrupt the current turn / kill / restart) over any lane. The division is sharp: **the AI owns coordination; the human owns judgement and the kill switch.** At most one orchestrator per harness.
_Avoid_: peer (a peer relationship is symmetric and reactive; the orchestrator is asymmetric), command center (the harness view's bottom footer region is already the "command center"; the orchestrator's panel is the [[Orchestrator console]]), autopilot (the human is never removed from judgement and can override at any moment), `#polly` (that is the *behavior* an orchestrator may run; the orchestrator is the *role/seat*, which exists independently)

**Dispatch** (spec 180):
The act of the [[Orchestrator]] handing **one unit of work (a task)** to another lane. Mechanically it is an ordinary `peer_send` — it drops the task into the target lane's inbox, which the target drains on its own next idle turn; it does **not** set the target's [[Goal]] and does **not** clear its session (a dispatch never wipes a worker's context mid-run). What distinguishes a dispatch from a plain peer message is *role and intent*, not transport: a peer message is a symmetric consult ("what do you think?"), a dispatch is the orchestrator **assigning work** as it coordinates the fleet (directional: orchestrator → worker). A dispatch can be issued two ways — by the orchestrator's own model during its autonomous fan-out, or by the human pressing the dispatch key in the [[Orchestrator console]]. It is delegation, not compulsion: the worker still runs on its own turn cadence and can flag or decline.
_Avoid_: command / order (implies the worker is compelled or interrupted — it is not; the worker drains on its own idle turn), assign goal (a dispatch is explicitly *not* a [[Goal]] set — that would clear the worker's session), broadcast (a dispatch targets one lane)

**Orchestrator console** (spec 180):
The dedicated, full-surface, keyboard-driven panel the human opens from the [[Orchestrator]] lane to see every lane at once and act on them. The **in-app, interactive** counterpart to the read-only lane monitor dashboard (which lives in the OS browser and only observes): the console renders the same live lane signals but lets the human dispatch work and control lanes from inside the harness.
_Avoid_: command center (collides with the existing footer region of the harness view), dashboard (the lane monitor is the read-only browser dashboard; the console is in-app and acts), seat (the *seat* is the orchestrator lane the console is bound to; the console is the panel itself)
