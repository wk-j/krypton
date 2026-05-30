# Harness HTML Artifacts — Implementation Spec

> Status: Proposed
> Date: 2026-05-30
> Milestone: M8 — Polish

## Problem

ACP harness lanes can only surface output as transcript text turns, structured tool cards, memory entries, peer messages, and attention flags — all plain text. There is no way for a lane to hand the user a rich, visual, or interactive view of its work. Anthropic's ["unreasonable effectiveness of HTML"](https://claude.com/blog/using-claude-code-the-unreasonable-effectiveness-of-html) argues that HTML output (tables, SVG diagrams, side-by-side comparisons, parameterized previews, small interactive editors) is dramatically more useful than Markdown for specs, reviews, and design exploration. Krypton already uses this pattern by hand — `docs/prototypes/*.html` are opened in a browser for design review — but that is an author-side convention tied to this repo, not a capability the harness offers a lane working in **any** project.

The goal is a built-in, **project-agnostic** harness primitive: a lane produces an HTML artifact as a real, **iteratively editable** file, the harness registers it, and the user opens it on demand — without polluting the target repository's tracked files and without a heavyweight in-app rendering subsystem.

## Solution

Use a **path-handoff** protocol (the lane writes the file; the harness never transports HTML bytes). A lane calls `artifact_new { title }` on the existing lane-scoped `krypton-harness-bus` server; the harness allocates an artifact id and returns a destination path **inside the target project** at `.krypton/artifacts/<harnessId>/<laneId>/<artifactId>.html`. The lane writes the HTML to that path with its **normal file-write tool**, then calls `artifact_register { id }`. The harness validates the file (see Security), records the artifact attributed to the lane, and renders a hintable artifact card in the transcript. The user opens it with a hint label (same label system as the existing `f` hint mode), and the harness opens the `file://` path in the **OS browser** via the existing `open_url` command.

**Artifacts are live files, not immutable snapshots.** The whole point is iteration: the lane reads the file back and edits it with its ordinary edit tool across turns (the blog's refine-the-HTML workflow), or registers a fresh artifact. The card reflects a live file on disk; it does not promise frozen bytes. Size + content hash are recorded at register time for the card label and so the UI can note "changed since registered" if desired — but editing is expected behaviour, not tampering.

The HTML bytes never travel through an `artifact_*` MCP argument and never enter `artifact_register`'s `rawInput`. **However, path-handoff does not by itself keep HTML out of the transcript** — the lane's *file-write tool* card would otherwise show a diff/content preview (spec 72). See Security: artifact-path write cards must be redacted, or the spec-103 hole simply reappears under the write tool instead of `artifact_register`.

This deliberately does **not** adopt the blog's "HTML-by-default for all output." HTML is an opt-in artifact a lane chooses to emit, not the harness's default output format — the harness runs multiple lanes (token cost multiplies) and the transcript is text. Opening is always user-triggered, never automatic.

Prototype: [`docs/prototypes/133-harness-html-artifacts.html`](prototypes/133-harness-html-artifacts.html)

## Invocation & propensity (when a lane makes one)

The harness adds **no special command or composer syntax** for artifacts — consistent with the harness's "discoverability only; the agent expands" stance. A lane reaches for an artifact in exactly two situations:

- **User-driven (base case).** The user asks in ordinary natural language ("show me a side-by-side", "make an HTML view of this", "give me an interactive scorecard"). The capability is discoverable through the `artifact_new` tool description plus a one-line mention in the lane-context stub; the lane uses its own judgement from there.
- **Directive-driven (opt-in amplifier).** A spec 124 directive (e.g. "HTML-first review") raises a lane's propensity to emit artifacts for reviews/comparisons/reports. This reuses the existing system-prompt layer — no new mechanism.

**Default propensity is conservative.** Because HTML is opt-in and the harness runs many lanes, a lane must *not* spontaneously produce artifacts for ordinary prose, plans, or answers — those stay in turn text. It emits an artifact only when the user asked for a visual/interactive view or a directive instructs it. Over-eager artifacts are artifact spam across the fleet and break the "opt-in, not default" contract; this guard belongs in the tool description, mirroring the "never flag proactively" guard on `attention_flag`/`peer_send`.

Tool description (what the agent reads), carrying the guard:

> `artifact_new` — Create an HTML artifact the user opens in their browser, for views that beat prose: side-by-side comparisons, diagrams, annotated diffs, parameterized previews, dashboards. Use ONLY when the user asks for a visual/interactive artifact, or your active directive explicitly tells you to produce HTML artifacts for this task. Do NOT default to HTML for ordinary prose, plans, or answers, and do NOT volunteer unsolicited dashboards — those stay in your turn text. Returns a destination path; write the HTML there with your normal file tool, then call `artifact_register`.

## MCP surface

Three new tools on `krypton-harness-bus` (alongside `memory_*`/`peer_*`/`attention_*`/`directive_*`):

| Tool | Input | Returns | Role |
|------|-------|---------|------|
| `artifact_new` | `{ title }` | `{ id, path }` | Allocate `artifactId` for the caller lane (`pending`), issue the destination path, open issued-path-only write auto-approval |
| `artifact_register` | `{ id }` | `{ ok, id, size, hash }` \| error | First call: validate the issued file (see Security), transition `pending → registered_live`, raise the card. Repeat call on a live id: **idempotent metadata refresh** (re-stat/re-hash). |
| `artifact_cancel` | `{ id }` | `{ ok }` | `pending` only: close auto-approval, drop the pending entry, best-effort delete the pending file. Errors `already_registered` on a live id (no retire feature in v1). |

**No `hintLabel` in the bus contract.** Hint labels are viewport/UI state (they depend on visible cards, tail-window slicing, hint mode, the label alphabet, and collisions with other hint targets). `AcpHarnessView` assigns them dynamically when hint mode opens — Rust never allocates one. The bus returns registry facts only (`id`, `size`, `hash`).

**Card metadata stays current without a lane round-trip.** Because the harness already observes (and auto-approves) every artifact-path write/edit, it re-stats and re-hashes on each one and updates the registry/card in place — so a live edit's new size/hash appear without the lane calling anything. `artifact_register` being idempotent (above) is the explicit fallback refresh.

**The file write/edit is *not* a bus tool.** The lane fills/edits the file with its backend-native file tool (e.g. the adapter's Write/Edit). Because that tool is not the harness MCP server, its auto-approval cannot key off the built-in-server marker (spec 96) — it keys off path + issued-id + same lane/session (see Security). Opening uses the existing `open_url` Rust IPC command, not an MCP tool.

## Artifact lifecycle (state machine)

Explicit so lifecycle semantics are not reinvented ad-hoc across the codebase. States: **`pending` → `registered_live` → `swept`**, plus terminal **`cancelled`** from `pending`.

| From | Trigger | To | Notes |
|------|---------|----|-------|
| (none) | `artifact_new` (caller lane) | `pending` | Fails if the lane's pending cap is hit. Opens write auto-approval for the issued path |
| `pending` | same-lane write/edit to issued path | `pending` | Auto-approved, redacted, size-capped per write |
| `pending` | `artifact_register { id }` | `registered_live` | Validates the file; raises the card |
| `pending` | `artifact_cancel { id }` | `cancelled` | Closes auto-approval; best-effort deletes the pending file |
| `pending` | turn end / lane cancel / lane restart-close / harness close | `cancelled` | **Pending must not outlive the turn** — see below |
| `registered_live` | same-lane write/edit to the path | `registered_live` | Still auto-approved + redacted + capped; harness re-stats/re-hashes and refreshes the card (the live-edit path) |
| `registered_live` | `artifact_register { id }` again | `registered_live` | Idempotent metadata refresh |
| `registered_live` | harness close / startup stale-sweep | `swept` | File removed; reopening the card reports "unavailable" |

**Auto-approval lifetime (resolves the prior contradiction).** A path's write grant is open while the artifact is `pending` **or** `registered_live` for the same lane — it closes on `cancel` (pending) or `sweep`/harness-close (live), **not** at register. Earlier text that said "only until registered" was wrong for the live-edit model and is superseded here. Every write/edit is re-validated and size-capped regardless of state.

**Pending carries a write grant, so it is short-lived.** v1 expects `artifact_new → write → artifact_register` within **one turn**; a small per-lane `pending` cap bounds outstanding grants, and any pending entry is auto-cancelled at turn end and on lane/harness teardown. Multi-turn construction is intentionally not supported — an issued-but-never-registered path must never leave a long-lived auto-approval behind.

**Edge cases (all defined):** register-after-cancel → error; double-register → idempotent refresh (above); `id` belonging to a different lane/harness → error `not_found` (no path detail leaked); cancel on a live id → error `already_registered`; lane closed/restarted while pending → auto-cancel.

## Ownership (who does what)

Modelled on spec 124's ownership split:

- **Rust / bus server owns**: artifact id allocation, the scratch-root path policy, path validation on register, `.krypton/artifacts/.gitignore` creation, the per-harness artifact registry, and stale-sweep. Safety is enforced **here**, not via an ACP permission prompt (spec 124).
- **Lane owns**: writing/editing the HTML at the issued path with its ordinary file tools. The lane never chooses the directory; it only fills/edits the file at the path it was handed.
- **Frontend (`AcpHarnessView`) owns**: rendering the hintable artifact card, mapping a hint keypress to `open_url(file://…)`, redacting artifact-path write cards, and reflecting registry state. The card is best-effort *visibility*, never the approval mechanism.

## Security

This feature auto-approves filesystem writes, so the threat model is stated honestly. **The auto-approval is a policy filter plus register-time validation, not kernel-enforced confinement** — Krypton approves a *separate* tool's write; it does not perform the write itself with `openat(O_NOFOLLOW)`. A lane could in principle swap a path component between approval and the adapter's actual write. This is accepted under the same trust envelope that already lets a lane run `bash` and write files; it is not sold as hard containment.

- **Transcript hygiene (the real spec-103 fix).** Both the write/edit **permission card** and the **tool-observation card** for an artifact path must be redacted to **path + byte count + hash only** — never the diff/content — for `pending` *and* `registered_live` paths (live edits leak otherwise). Lanes should write artifacts with file-write/edit APIs that do not echo file contents into the tool card, *not* with shell heredocs (`cat > … <<EOF`) that put the HTML in the command line (an unavoidable footgun: a lane that insists on shell can still leak its own command text). Without this, path-handoff still leaks HTML into the transcript model under the write tool.
- **Issued-path-only auto-approval.** Auto-approve a file-write *only* when its canonical target matches an artifact path in the registry for that exact `harnessId + laneId + artifactId`, in state `pending` or `registered_live` (lifetime per the state machine above). Match against the **registry entry**, not a string check on `.krypton/artifacts/` — the latter would let a lane write into another lane's tree or spew junk. This differs from the memory/peer auto-allow model and **cannot** rely on the built-in-server marker (spec 96) — the write tool is often a backend-native filesystem tool, not the harness MCP server.
- **Path validation on register/approve.** Canonicalize and `lstat` every *existing* parent component; require the canonical issued parent under the canonical scratch root; require the final basename equals exactly `<artifactId>.html`. Reject a symlink in **any** component (`.krypton`, `artifacts`, `harnessId`, `laneId`, and the file itself). Use path-**component** comparison, not string-prefix (so `…/artifacts2` is not treated as under `…/artifacts`). Reject hardlinks (`nlink > 1` where available). After open/stat, require a regular file within the size cap; reject directories, device files, FIFOs, sockets.
- **Limits.** Cap title length, per-artifact file bytes (enforced on **every** write/edit and at register/open — a live edit that grows past cap makes the card unavailable/error rather than silently opening), artifacts per session, and outstanding **`pending`** artifacts per lane (pending entries authorize a write, so they are bounded and short-lived). Defined overflow errors throughout. These are cheap on-disk checks, not MCP payload guards.
- **Trust is honest, not minimized.** See [`docs/adr/0002`](adr/0002-html-artifacts-open-in-os-browser.md): the artifact opens verbatim (full HTML+JS, no sandbox) in the user's real browser profile — it can beacon, navigate, trigger downloads/URL schemes, and persist outside Krypton's cancellation/audit loop. Made tolerable by *opt-in + user-opened + lane-attributed + capped*, not by claiming harmlessness.

## Scratch lifecycle & collisions

- **"Session" = harness tab.** Key every artifact by `harnessId / laneId / artifactId` (monotonic/random id), **never by lane display name** — labels are reused after `#new`/`#restart`, and multiple harness tabs can share one project.
- **Completeness over atomicity.** Because artifacts are editable live files, immutability is not a goal. The harness reads the file at register time and requires it to exist as a regular file within the cap; the lane must let its write/edit operation complete (close/flush) before calling `artifact_register`. Sequential tool calls in a turn give this ordering, but a backgrounded writer (e.g. a detached shell) would break it — so completeness is required of the lane-side write, not assumed from call order alone.
- **`.gitignore` scope.** Write a self-ignoring `.krypton/artifacts/.gitignore` (`*`, keep `!.gitignore`), **not** `.krypton/.gitignore` — `.krypton` may hold intentional tracked agent config. Create only if absent (never overwrite a user's file); if creation fails (no perms, etc.) `artifact_new` fails closed with no issued id rather than handing back a path that would pollute git status. Already-tracked files are not retroactively untracked — documented, not auto-fixed.
- **Project = cwd.** Scratch lives under the lane's working dir, matching lane sandboxing; in a monorepo subdir this is the subdir, not the repo root. Stated explicitly so it is not surprising.
- **Cleanup** on normal harness close *and* a startup stale-sweep (crash cleanup cannot depend on close). The startup sweep must **not** delete a currently-running tab's artifacts after an app reload — sweep only `harnessId`s absent from the live registry (or use an app-run marker), never the live set. Never delete/reuse an artifact path while a transcript card that can still open it is live.

## Design Decisions

| # | Decision | Chosen | Rejected alternatives |
|---|----------|--------|-----------------------|
| 1 | Scope | Built-in harness feature, project-agnostic | HTML convention for the Krypton repo's own docs |
| 2 | Display surface | OS browser via `open_url` (see ADR 0002) | Inline iframe in transcript; in-app webview pane (spec 102) |
| 3 | Open trigger | Register, then open on keypress | Auto-open browser on tool call |
| 4 | Who writes the file | **Lane writes it** (path-handoff) — enables iterative editing with the lane's normal edit tools; no HTML through MCP | Harness writes it from an HTML string arg (no targeted edits; re-sends whole file per edit; payload ceiling) |
| 5 | Storage | `.krypton/artifacts/<harnessId>/<laneId>/<id>.html` in project, gitignored; live files, swept on close + startup | Dir outside repo (lane write-sandbox conflict); persistent/cross-session |
| 6 | Mutability | **Live, editable files**; size+hash recorded at register for display/integrity | Immutable/frozen snapshots (fights the iterate-on-it workflow) |
| 7 | JS / security | Full HTML+JS, no sandbox — same trust as `bash`/file-write, made tolerable by opt-in + user-opened + capped | Strip JS; CSP/sandbox (kills interactivity, the core value) |
| 8 | Opening among many | Hint-style "open artifact" label per card (distinct from URL hints), open-in-browser exception explicit | Open-most-recent only; dedicated artifact-list view |

## Architectural Decision Record

The display-surface choice (decision #2 — OS browser over in-app webview) is recorded separately as [`docs/adr/0002-html-artifacts-open-in-os-browser.md`](adr/0002-html-artifacts-open-in-os-browser.md): surprising given the keyboard-first / single-window constraints, the result of a genuine trade-off against the existing webview-pane surface (spec 102), and reversible only at the cost of changed user expectation.

## Affected Files

| File | Change |
|------|--------|
| `src/acp/*` (harness MCP server / `krypton-harness-bus`) | Add `artifact_new { title }` (allocate id + issue path) and `artifact_register { id }` (validate + record size/hash); own scratch root, `.krypton/artifacts/.gitignore`, registry, stale-sweep. Tool descriptions carry the conservative-propensity guard |
| Lane-context stub (`buildPromptBlocks()`) | One-line mention that artifacts exist and are opt-in/user-driven — discoverability only, no behaviour change |
| `src/acp/acp-harness-view.ts` | Issued-path-only write auto-approval (path + issued-id + same lane/session, separate from the memory/peer detector); **redact artifact-path write cards** to path+bytes+hash; render hintable artifact card; wire hint → `open_url`; document the read-only-transcript exception in the input model; cleanup on close |
| Auto-allow taxonomy (spec 96 site) | Add artifact write auto-approval as a **separate** path/registry-keyed mechanism; explicitly *not* a built-in-server-marker detector entry |
| `src/styles/acp-harness.css` | `.acp-harness__msg--artifact` card styling |
| Rust backend | Reuse existing `open_url`; scratch path allocation/validation (symlink/hardlink/component checks)/sweep; no new IPC command expected |
| `docs/72-acp-harness-view.md` | Artifact card as a new transcript output type; artifact-path write-card redaction; hintable-card ("open artifact", not URL hint) exception to the read-only transcript, active only in hint mode |
| `docs/96-*` (auto-approval) | Path/issued-id-keyed artifact write auto-approval as a separate taxonomy from `memory_*`/`peer_*` |
| `docs/102-webview-windows.md` | Cross-reference: artifact cards are "open artifact" hints, not URL hints; open OS browser, not a webview pane |
| `docs/PROGRESS.md` | Record milestone task |

## Out of Scope (v1)

- HTML as a default output format (blog's stance) — artifacts are opt-in only
- In-app rendering (inline iframe or webview pane) — OS browser only
- Auto-open on registration
- Persistent / cross-session artifact storage, reload/bookmark, and an artifact-list view
- Sandboxing / CSP / JS stripping
- Passing HTML through MCP (string/base64/chunked) — path-handoff makes it unnecessary
- A dedicated composer command / syntax for artifacts — invocation is natural-language + directive only (see Invocation & propensity)
- Markdown or image rendering in the transcript itself
