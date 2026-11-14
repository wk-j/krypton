# Bug Trail — Pre-Fix Diagnosis on the System Map — Implementation Spec

> Status: Implemented
> Date: 2026-11-14
> Milestone: ACP Harness — issue analysis
> Builds on: 0355 (e2e system map) · 0191 (`#analyze-github-issue`) · 0192 (analysis viewer) · 0337 (Rails trust and runner) · 0341 / 0361 (loopback app)

## Problem

Before a lane edits code to fix a bug, a technical reader needs to see the bug: where it shows, what was ruled out, where the cause is, what proves it, and which decisions are open. Today `#analyze-github-issue` writes prose (`root-cause.md`, `fix-plan.md`) for a non-technical reader. Proof is scattered and unchecked. In bcircle/tli-api-service#1364 the API path in the issue was inferred from SPEC.md, never reproduced on the unfixed build. A decision (deviate from the original system) surfaced only after the fix, as DEV-119.

## Solution

- **Same verb, one more file.** During Analyze, the lane also writes `trail.toml` into the analysis bundle. It holds ordered steps (`symptom`, `ruled-out`, `suspect`, `root-cause`, `decision`, `plan`), each pinned to a node of a 0355 system map, each carrying evidence pointers. Analyze stays read-only on the code: the prompt forbids edits outside the bundle, and Krypton records HEAD and the dirty set when Analyze starts and when the lane checks the trail.
- **Krypton checks; the model only claims.** Nothing in `trail.toml` can say "verified".
  - On every read, Krypton recomputes each evidence check: a `cite` quote must appear in the cited lines at the analysed commit, a `commit` must exist, and an `observed` file must exist in the bundle.
  - A `repro` is "reproduced" only by a Krypton-run record: a trusted command, run on the analysed commit with a clean tree, that ended as `expect` said.
- **A read-only page.** `/trail` draws the map with step numbers on nodes and the bug path between symptom and root cause. It shows the involved nodes by default. `j`/`k` steps through the investigation, and the page shows the open decisions and the not-reproduced gap.

## Research

- **Analyze today.**
  - `analyzeGithubIssuePrompt` (`src/acp/harness-prompts.ts:749`) writes markdown into `.krypton/analyses/<owner>/<repo>/<n>/` and asks for Thai prose for a non-technical reader. Nothing stops code edits.
  - Every in-app dispatch goes through `runGithubIssuePromptVerb` (`acp-harness-view.ts:12495-12586`), which is the hook point for the start snapshot. `verb-registry.ts:20` and `hash-commands.ts:523` build the same prompt for injected verbs, without that hook.
- **Bundle discovery.** `discover_analysis_bundles` (`hook_server.rs:8065`) reads top-level files only. Every non-`.md` file becomes an attachment, so `trail.toml` and `trail-state.json` must be excluded there. `/analysis` accepts `project=` or the legacy `harness=` (`:4087`).
- **Map reuse.** `parse_map` / `load_map` (`e2e.rs:934`, `:1034`) validate a 0355 map with path rules. `is_relative_clean` (`:265`) is private. The first version drew the map with mermaid into an `<img>`, as `#e2e open` does; the revision below replaces that with valence's layout, drawn inline.
- **Runner and trust.** Rails runs declared argv through `child_process::login_command`, with `read_capped` and `kill_group` (`rails.rs:24`, `execute` `:1018`). It keeps trust outside the project, in `<config>/rails-trust.toml`, keyed by root and the manifest's sha256 (`:650-705`). The repro runner copies that pattern.
- **Real project fit.** tli-api-service already has the pieces: `e2e/maps/tli-online.toml` (26 nodes), e2e cases tagged with `t.at(…)`, and bundles such as `.krypton/analyses/bcircle/tli-api-service/1410/`. Every cite in the #1364 example below was checked at `b420e805`. The rehearsal caught one off-by-one (`2326-2327` vs the real `2327-2328`), which is the case the quote check exists for.
- **Alternatives rejected.**
  1. **Record the trail during Fix.** The reader needs it before the edit (user decision, 2026-11-14).
  2. **A write tool per step.** The bundle convention is files the lane writes. One `trail_check` tool gives the same validation feedback without a new write path.
  3. **Persist check results.** Cite, commit and observed checks are cheap and deterministic, so they are recomputed on read. Only repro runs, which cannot be recomputed, are stored.
  4. **Pin nodes as in 0355.** Separate pin nodes would double a 26-node map. Step numbers go on a second label line instead.

## Prior Art

| Tool | Implementation | Notes |
|---|---|---|
| Sentry Seer issue fix | Fixed order: root cause analysis → solution → code. The RCA shows the event sequence and the most likely culprit before any code is generated | Diagnosis-before-fix as a hard stage; the reasoning is the model's own, unchecked |
| Datadog Watchdog RCA | Root cause → critical failure → impact, drawn on the service dependency map | Root cause and symptom on one topology; needs APM telemetry |
| Dynatrace Davis | Problem view with a Replay tab that plays how the problem evolved across Smartscape entities | Step-through on topology, ordered by event time |

**Krypton delta.**
- **No telemetry.** The map is project-authored (0355) and the evidence is code, commits, files and commands.
- **Checked claims.** Every claim is checked by code: a quote at a commit, or a run on the unmodified commit.
- **Replay by investigation step**, not by time, and keyboard-driven.
- **Decisions are first-class steps** that block nothing but are counted on the page.

## Affected Files

| File | Change |
|---|---|
| `src-tauri/src/trail.rs` | **New.** `trail.toml` parse and validate, evidence checks, state snapshots, `TRAIL_MD` guide, repro trust and run, payload |
| `src-tauri/src/e2e.rs` | `is_relative_clean` → `pub(crate)` |
| `src-tauri/src/hook_server.rs` | `/trail` page and `/trail.json` routes. Bundle discovery skips trail files and sets `has_trail`. The bundle file tabs gain `trail`. MCP `trail_check` (schema, dispatch, allowlists) |
| `src-tauri/src/lib.rs` | `mod trail`; commands `trail_begin`, `trail_trust`, `trail_run_repro` |
| `src/loopback/entries/trail.ts` | **New.** `bootPage('trail', TrailPage)` |
| `src/loopback/surfaces/trail/` | **New.** `index.tsx`, `model.ts` (pure), `model.test.ts`, `trail.test.tsx`, `trail.css`, `fixtures/1364.json` |
| `src/acp/harness-prompts.ts` | Analyze prompt: the read-only rule, `trail.toml` via `TRAIL.md`, `trail_check` |
| `src/acp/acp-harness-view.ts` | `trail_begin` on the analyze verb; `#trail` handler |
| `src/acp/hash-commands.ts` | `#trail` entry, surface category |
| `docs/README.md`, `DESIGN.binance.md`, `docs/0192-issue-analysis-viewer.md` | Index row; loopback surface row; viewer gains the trail tab |

## Design

### `trail.toml` (lane-authored, in the bundle)

```toml
version = 1
issue  = "bcircle/tli-api-service#1364"
title  = "เอกสาร CL เข้า Storage ไปอยู่ใต้เลขกรมธรรม์แทนเลขเคลม"   # optional
map    = "e2e/maps/tli-online.toml"   # repo-relative; may be a map.toml inside the bundle
commit = "b420e805"                   # the commit analysed; must resolve and equal the start snapshot HEAD

[[repro]]                             # optional; Krypton runs it only after #trail trust
id      = "done-cl-path"              # ^[a-z0-9][a-z0-9-]{0,39}$
argv    = ["hurl", "--test", ".krypton/analyses/bcircle/tli-api-service/1364/repro/done.hurl"]
expect  = "fail"                      # fail | pass, on the analysed commit
timeout_s = 300                       # 5..1800, default 300
what    = "Done a test claim on dev-tli, read the Alfresco folder"

[[step]]
at   = "api003"                       # a node id of `map`; otherwise listed under "not on the map"
kind = "root-cause"
note = "Done reads al_policy_no + the policy effective date for both folder and file name"
  [[step.evidence]]
  type  = "cite"
  file  = "tli-api/src/main/java/com/bc/dim/api/service/tli/TliClService.java"
  lines = "1688-1689"
  quote = 'policyInfo.get("al_policy_no")'
  [[step.evidence]]
  type = "repro"
  id   = "done-cl-path"
```

**Step kinds.** `symptom` · `ruled-out` · `suspect` · `root-cause` · `decision` (`question`, optional `options[]`; `answer` stays empty until the user answers in chat and the lane writes it; no form) · `plan` (where and how the fix will go; nothing applied).

**Evidence types and checks** (recomputed on every read):

| `type` | Fields | Check | Statuses |
|---|---|---|---|
| `cite` | `file`, `lines` (`a` or `a-b`, span ≤ 200), `quote` (1–200 chars) | `git show <commit>:<file>` (≤ 2 MiB); `quote` is a substring of those lines joined by `\n` | `ok` · `mismatch` · `missing` · `unavailable` |
| `commit` | `sha` | `git cat-file -e <sha>^{commit}` | `ok` · `unknown` · `unavailable` |
| `observed` | `file` (bundle-relative), `what` | regular file inside the bundle, no symlink escape | `ok` · `missing` |
| `repro` | `id` | latest `trail-runs/*.json` for `id` | `reproduced` · `unexpected` · `stale` · `not-run` · `untrusted` |
| `inferred` | `what`, optional `source` | none | `unchecked` |
| `ref` | `what`, optional `url` | none | `unchecked` |

**Limits.** File ≤ 128 KiB; ≤ 60 steps; ≤ 8 evidence per step; ≤ 10 repro; `note`/`question` ≤ 600 chars. Unknown keys are warnings, as in the 0355 map. Errors name a path: `step[4].evidence[0].lines: expected "a" or "a-b" (1-based line numbers)`.

### Krypton-owned files

- **`trail-state.json`** in the bundle:
  - `start {head, dirty[], at}` is written by `trail_begin`.
  - `check {head, dirty[], at, changed[]}` is written by every `trail_check`.
  - `dirty` is `git status --porcelain` minus `.krypton/**`. `changed` lists the paths dirty at check time and not at start, plus `HEAD moved` when HEAD differs.
- **`trail-runs/<runId>.json`** (`runId` uses the Rails format) holds `{id, argv, commit, treeClean, outcome: pass|fail|timeout|error, exitCode, durationMs, outputTail}`.
- **`<config>/trail-trust.toml`** holds `[[entry]] root, issue, sha256`, the sha256 of the canonical JSON of the trail's `[[repro]]` array. Editing any repro makes it `changed`, and the trail must be trusted again.
- **`.krypton/analyses/TRAIL.md`** is the format guide written by `trail_begin`, as `#e2e init` writes `CONTRACT.md`.

**Repro status rules.**
- `reproduced`: the latest run has `commit == trail.commit`, `treeClean`, and an outcome equal to `expect`. A `timeout` or `error` never counts.
- `unexpected`: the run passed when `expect = "fail"`, or the reverse.
- `stale`: the latest run was on another commit.

### API / Commands

```rust
#[tauri::command] fn trail_begin(project_dir: String, issue_key: String) -> Result<(), String>;      // TRAIL.md + start snapshot
#[tauri::command] fn trail_trust(project_dir: String, issue_key: String) -> Result<TrailTrust, String>; // {trusted, argv: Vec<Vec<String>>}
#[tauri::command] async fn trail_run_repro(project_dir: String, issue_key: String, id: Option<String>) -> Result<Vec<TrailRun>, String>;
pub(crate) fn trail_payload(project_dir: &Path, owner: &str, repo: &str, number: &str) -> TrailPayload;
```

- **`trail_run_repro` refusals.** It refuses with a named error when the repro is not trusted (`untrusted — #trail trust first`), when HEAD ≠ `commit` (`HEAD moved: repro runs on the analysed commit only`), when the tree is dirty outside `.krypton/`, or while another repro of the same bundle is running (single-flight).
- **Running.** Repros run one at a time, through the Rails launcher, in the project root.
- **MCP `trail_check { issue: "owner/repo#n" }`.** Open to every lane. It returns `{errors, warnings, steps: [{index, at, kind, evidence: [{type, status, detail}]}], changedDuringAnalysis}` and writes the `check` snapshot.
- **Routes.**
  - `GET /trail?project=<id>|harness=<id>&issue=<owner/repo/n>` serves `AppPage::new("trail", …, Scheme::Dark)`.
  - `GET /trail.json` (same query) serves `TrailPayload`.
  - Both are read-only. 404 when the bundle has no `trail.toml`.

```ts
interface TrailPayload {
  issue: string; title: string | null; commit: string; bundle: string;
  map: { path: string; map: E2eMap | null; errors: string[] };
  steps: TrailStep[]; repro: { id: string; argv: string[]; expect: 'fail' | 'pass'; what: string; trust: 'trusted' | 'untrusted' | 'changed' }[];
  state: { start: Snapshot | null; check: (Snapshot & { changed: string[] }) | null };
  errors: string[]; warnings: string[];
}
interface TrailStep { at: string; kind: StepKind; note: string; question?: string; options?: string[]; answer?: string; evidence: TrailEvidence[] }
interface TrailEvidence { type: EvidenceType; fields: Record<string, string>; status: CheckStatus; detail: string | null; outputTail?: string }
```

### Analyze prompt addition

The lines below are appended to `analyzeGithubIssuePrompt`, between steps 4 and 5:
- "Do not edit, create or delete any file outside the bundle folder during analysis."
- "If the issue reports wrong behaviour, also write `trail.toml` in the bundle, following `.krypton/analyses/TRAIL.md`. Use a system map from `e2e/maps/` when one covers the area; otherwise write a small `map.toml` in the bundle."
- "Call `trail_check` and fix every error before you finish."

Trail notes follow the analysis language rule (Thai). Ids, kinds and paths stay as written.

### Data Flow

```
1. Analyze (verb or Ticket Panel) → runGithubIssuePromptVerb → invoke trail_begin (failure: chip, prompt still sent)
2. Lane reads code read-only, writes root-cause.md / fix-plan.md / trail.toml, calls trail_check until clean
3. /analysis shows a "trail" tab when has_trail → /trail → GET /trail.json → trail_payload (checks recomputed)
4. Page: layoutMap(map, trailPins, involved) once per view → <SysMap> inline SVG; model.frame(payload, cur) restyles it and the step list
5. Optional: #trail trust → #trail run → trail-runs/*.json → next /trail.json shows reproduced / unexpected
```

### Page (`src/loopback/surfaces/trail/`)

**Pure model (`model.ts`).**
- **`frame(payload, upTo)`.** Each node's state is the last non-`decision`/`plan` step kind on it up to `upTo`. A `root-cause` node gets a level: `reproduced` when any of its repro evidence is reproduced; `cited` when every checkable evidence is `ok`; `claimed` otherwise.
- **`bugPath(map, frame)`.** Over `flow` edges only, the nodes in `(fwd(s) ∩ bwd(r)) ∪ (fwd(r) ∩ bwd(s))` for every symptom `s` and every root `r`. When no root-cause exists yet, suspects stand in for roots.
- **`focus(map, frame, path)`.** The pinned nodes, the path nodes, and the actors with a `flow` edge into either. Groups are kept only when non-empty.
- **`trailPins(payload)`.** One pin per step whose `at` is a map node, in step order: key `4` (`?7` for a decision), label the step kind, title the note. Its status (`pinStatus`) is the kind, a root cause's level (`root-reproduced` / `root-cited` / `root-claimed`) or a decision's (`decision-open` / `decision-answered`).
- **`submap(map, keep)` / `isPathEdge(edge, frame, path)`.** The involved view's map; whether an edge is drawn as the bug path.
- **`kit/sysmap/layout.ts`.** A port of valence's deterministic layered map layout (`internal/report/maplayout.go`): ranks, barycenter order, group items, S-curve / corridor / back-edge routing, monospace text measurement, pins hung under their node. Goldens produced by the Go original are the tests (see the revision below).

**View.**
- **Header.** Title, then `analysis @ <commit> · tree clean at start | changed during analysis (n)`, the map path, a status pill (`investigating` → `suspect` → `root cause cited` → `root cause reproduced`) and `n decisions open`.
- **Gap banner.** Full 1px accent border: `not reproduced on <commit>`, shown while a root cause exists and none is reproduced.
- **Map.** Inline SVG (`sysmap.tsx`) at its own size; it shrinks to 75% at most, then scrolls. Nodes stay neutral; pins carry the colour (symptom accent, root cause and suspect red, ruled out and answered decisions muted, plan neutral); path edges are red, dotted until a root is reproduced; ruled-out and uninvolved nodes are dashed grey. A caption `k of N nodes shown` and its toggle.
- **"Not on the map."** One line naming the steps whose `at` is not a map node.
- **Step list.** One row per step: number, kind pill, `at`, note. Then the evidence lines: status word, then file:lines or run id, plus the output tail for repro runs. Decision rows show the question and options as text.
- **Rendering.** The layout runs once per payload and view with every step's pin, so stepping changes classes only: pins past the frame are dimmed and nothing moves.

### Keybindings

| Key | Context | Action |
|---|---|---|
| `j` / `↓`, `k` / `↑` | trail page | next / previous step (the map shows steps ≤ current) |
| `g` / `G` | trail page | first / last step |
| `a` | trail page | involved nodes ↔ whole map |
| `#trail [<issue>]` | harness | open the trail (issue defaults to the active ticket's GitHub issue) |
| `#trail trust [<issue>]` / `#trail run [<id>] [<issue>]` | harness | trust the repro set / run trusted repros |

## Edge Cases

- **No `trail.toml`:** no tab; `/trail` answers 404.
- **Invalid `trail.toml` or map:** the page shows an error banner and the step list without the map.
- **`at` not in the map:** listed under "not on the map", with no node state.
- **Commit missing (shallow clone, typo):** cites become `unavailable` and a header error is shown.
- **Not a git repo:** cite and commit checks are `unavailable`; `trail_run_repro` refuses.
- **No start snapshot** (prompt built through `verb-registry` or `hash-commands.ts:523`): the header says `start snapshot missing`.
- **Re-analysis:** `trail_begin` overwrites `start` and clears `check`. Runs are kept, so older runs on another commit read as `stale`.
- **HEAD moved after the fix:** cites stay valid because they are read at `commit`. Repro runs are refused. The header shows the analysed commit, not HEAD.
- **Repro output:** capped as in Rails (2 MiB read, 8 KiB tail). A timeout is followed by SIGTERM, then SIGKILL after 5 s.
- **Untrusted text:** every string is a React text node (map and pin text included — the SVG is built from elements, never parsed from markup). The argv is never shell-joined.

## Testing

- **Rust (`trail.rs`).**
  - Parse: kinds, limits and unknown-key warnings.
  - Cite: `ok`, `mismatch`, `missing` and `unavailable` on a temp git repo.
  - Commit, plus the `observed` symlink escape.
  - Trust: `untrusted` → `trusted` → `changed`.
  - Run: refusals for untrusted, HEAD moved and dirty tree; outcome mapping to `reproduced`, `unexpected` and `stale`.
  - The `trail_check` `changed` list.
  - Bundle discovery excludes the trail files and sets `has_trail`.
- **Frontend.**
  - `model.test.ts` on `fixtures/1364.json`: the #1364 trail above with the 7 involved `tli-online` nodes plus 19 others. It asserts path `{api003, online006, alfresco}`, a focus of 6 nodes, the states per frame, `root cause cited`, 2 open decisions, identical source twice, and escaping.
  - `trail.test.tsx`: `j`/`k`/`g`/`G`/`a`, the gap banner, "not on the map", and that every request is a GET.
- **Smoke.**
  - A throwaway git repo with a map, a trail and a failing repro: `#trail trust`, `#trail run`, then the page shows `reproduced`.
  - With the user's OK, the #1364 trail written into the tli-api-service bundle.

## Open Questions

None. Decided above: Analyze-only (no `fix` or `verified` kinds), a file instead of a per-step tool, checks recomputed on read, repro runs only on the user's `#trail run`, the dark scheme like `#e2e open`, and the involved-nodes view by default.

## Out of Scope

- Post-fix steps (`fix`, `verified`, `false-alarm`, `open`), and running repros after HEAD moves.
- Krypton generating maps or steps itself, or a model call per page view.
- Editing a trail from the page, answering decisions from the page, or any POST route.
- Posting the trail to GitHub or publishing it to Xenon.

## Implementation Notes

Where the shipped code adds to the design above:

- **Guide source.** `TRAIL.md` is `src-tauri/src/trail-guide.md`, embedded with `include_str!`.
- **Payload.** Repro views also carry `timeoutS` and `lastRun`; evidence carries `outputTail` for repro runs. A repro whose last run ended `timeout` or `error` reads `not-run`, with the outcome in `detail`. A run on a dirty tree reads `stale`.
- **Root-cause level on the page.** `cited` needs at least one cite, commit or observed check, all `ok`. A repro that has not run does not lower it; only an `unexpected` run drops it to `claimed`. The pill also has a `root cause claimed` state, and the analysis line says `tree dirty at start (n)` when the start snapshot was dirty.
- **Entry.** `src/loopback/entries/trail.ts` boots with surface id `analyses`, since the trail belongs to a bundle and has no Home tile. Rust still serves `AppPage::new("trail", …)`, and `/trail` answers 404 unless the bundle holds `trail.toml`.
- **`#trail` opening.** The command opens `/trail?harness=<harness memory id>&issue=…`, the id `/analysis?harness=` already uses. Trust and run need a local harness.
- **Viewer.** A bundle holding only a trail says so instead of "only attachments".
- **Keys.** Step keys use functional state updates, because keys pressed faster than a render dropped steps.

**Verified:**

- **Rust.**
  - `cargo test`: 697 lib tests pass, 10 of them `trail::`, plus `analysis_bundle_trail_is_a_tab_not_an_attachment`.
  - `cargo clippy --all-targets` adds no warnings. The `bool_assert_comparison` at `timeline.rs:3244` was already there.
  - The changed files are formatted. `cargo fmt --check` still flags `acp.rs:2803`, which was already unformatted and is left alone.
- **Frontend.**
  - `npx vitest run src/loopback/surfaces/trail`: 23 tests.
  - The full `npx vitest run` passes except `acp-harness-view.test.ts > paints a tool call and its update …`, which fails the same way without this change (spec 398's `backgroundTasks`).
  - `npm run check` and `npm run build` pass; the build emits `dist/app/trail.js`.
- **Smoke (throwaway repo, scratch only).**
  - The repo had a 6-node map, a trail with a deliberate cite off-by-one, an off-map step, a decision, and a failing `sh` repro.
  - Steps in order: `trail_begin`; a payload showing `untrusted`; a refused run (`untrusted — #trail trust first`); trust; a run that ended `fail`, exit 1, with its output tail; `trail_check` returning `ok: false` with `quote is at line 2, not 3`; and a payload with `reproduced`.
  - The real `trail.js` / `app.css` bundle rendered that payload in Chromium. It showed the filled root-cause node, the red path edge, the dashed ruled-out node, 4 of 6 nodes (`a`: 6 of 6), the off-map line and the repro output.
  - `j`/`k`/`g`/`G`/`a` stepped the frames, sent as keydown events to the page.
- **#1364 (real data).**
  - `.krypton/analyses/bcircle/tli-api-service/1364/trail.toml` holds 10 steps on `e2e/maps/tli-online.toml` at `b420e805`, rebuilt from the issue, the ticket and the commits. It lists no repro, because none ran before the fix.
  - With HEAD at `91119e3f`, the payload had no errors. The map loaded with 26 nodes; all 10 cites and the commit read `ok`, the refs and the inference `unchecked`, and `watch-folder` was listed off the map.
  - The page showed `root cause cited`, `1 decision open` (the DEV-119 decision carries its answer), the `not reproduced on b420e805` gap, `start snapshot missing`, and 6 of 26 nodes.
  - Seen there and fixed: the step badge wrapped `?10`, so it is now a pill.
  - Still open then: long map labels wrapped mid-word under mermaid. Gone with the inline map (revision below).
- **Not exercised:** `#trail` and `trail_begin` inside a rebuilt Krypton, and the MCP round trip from a live lane.

## Revision — Home tile and trail index (2026-11-14)

**Problem.** Krypton Home lists every loopback surface, but the trail had no tile. It was reachable only from a bundle's `trail` tab or `#trail`, so the user could not see which issues have a trail.

**Change.**
- **Surface.** `trail` becomes a surface in `src/loopback/surfaces.ts`: title "Bug trails", group Project, scope project, open access, href `/trail?project=<id>`. It sits after Analyses. The entry now boots as `trail`, so the shell title and the `` ` `` switcher name it.
- **Index mode.** `/trail` and `/trail.json` take `issue` as optional.
  - Without it, the page is the project's trail index. `GET /trail.json?project=<id>` answers `{ projectId, projectName, trails: TrailPayload[] }`: one full payload per bundle holding `trail.toml`, newest issue first.
  - The page computes each row's status with the same `frame` / `trailStatus` / `gapText` / `stateLine` as the issue view, so the rules live in one place.
  - The project is `project=`, the legacy `harness=`, or else the first project with analyses. An unknown project answers 404.
- **Index view.**
  - One row per issue: issue key, title, status pill, `n decisions open`, `not reproduced`, step count, analysis commit, and the number of failing checks.
  - `j`/`k` (and `↓`/`↑`) move the selection, `Enter` opens the trail, and a click opens it too.
  - An empty project says how to get a trail: Analyze a bug issue in Krypton.
- **Issue view.** The header gains an `all trails` link back to the index.
- **Unchanged.** `/trail?issue=…` behaves as before, and the bundle tab and `#trail` stay.

**Verified.**
- Rust: `index_lists_trails_newest_issue_first`, and the `cargo test` lib suite (698 tests).
- Frontend: `trail.test.tsx` now also covers the index. It checks the rows and statuses, a single GET of `/trail.json?project=p1`, `j` then `Enter` opening `/trail?project=p1&issue=…`, the empty state, and the issue view's `all trails` link. `surfaces.test.ts` checks the tile's href.
- Browser (the real bundle against the #1364 payload):
  - Home shows a "Bug trails" tile after Analyses that links to `/trail?project=<id>`.
  - The index lists `bcircle/tli-api-service#1364` with `root cause cited`, `1 decision open`, `10 steps · analysis @ b420e805 · not reproduced`.

## Revision — inline map on valence's layout (2026-11-14)

**Problem.** On the #1364 trail the mermaid map read worse than the e2e map. Four causes:
- Mermaid's SVG says `width="100%"`, so inside an `<img>` it has no natural size and was stretched to the column: 841px drawn at 1074px or more.
- The step numbers sat inside the node labels.
- Whole nodes were outlined red or yellow.
- Long paths broke mid-word (`/tli-online/appendSt` · `orage/{BU}`).

The user asked for valence's drawing instead of an image.

**Change.**
- **Layout.** `layout.ts` ports valence's `maplayout.go` faithfully (since moved to `src/loopback/kit/sysmap/` with the drawing, which the e2e explorer now shares — spec 0355's revision). It adds `from`/`to` on edges, `id` on groups and `at` on pins, and uses one label text per pin.
- **Drawing.** `sysmap.tsx` draws it as inline SVG from React elements, following `sysmap.templ`.
  - Nodes keep their own labels and stay neutral. Each step is a pin (key cell + kind) hung under its node by a dotted stem, coloured by `pinStatus`.
  - Path edges are red, dotted until a root is reproduced. Ruled-out and uninvolved nodes are dashed grey.
  - The SVG is drawn at its own width; it shrinks to 75% at most and then scrolls.
- **Stepping.** The layout runs once per payload and view with every pin. Stepping changes classes only: pins past the frame are dimmed.
- **Removed.** `trailSource` and the mermaid / `<img>` path of this page.
- **Why inline is safe here.** Spec 0294 keeps mermaid output in an `<img>` because that SVG is markup produced from lane text. This SVG is built from React elements: every lane string is a text node, nothing is parsed, so the page needs no sanitiser.

**Verified.**
- **`layout.test.ts`.** The four goldens come from the unmodified Go `Layout`, run in a scratch harness: `tli-online` (26 nodes), the 6-node involved view, a TB map (back edges, refused edges, shapes, labels, Thai/CJK text, key-only and truncated pins), and an empty map. Each is deep-equal to the Go output, and so is `pinKeyCellPath`; 400 random maps also match. Goldens are built for amd64: arm64 Go fuses multiply-add, which changes the last bit of a few raw coordinates (the path strings stay identical).
- **Test suites.** `npx vitest run src/loopback/surfaces/trail` passes 37 tests, including the page now asserting inline SVG at its own width, 9 pins, path edges and dimmed future pins. The full suite fails only the `acp-harness-view` spec-301 test that already failed before this work. `npx tsc --noEmit` passes, and `npm run build` succeeds with no mermaid in `dist/app/trail.js`.
- **Browser, #1364 payload.**
  - The involved view draws at its own 957px.
  - Pins hang under API003 (`4 suspect`, `5 root cause`, `?7 decision`, `8 plan`), ONLINE006, Alfresco and `tr_policy`. The two red dotted path edges run into Alfresco, and labels such as `/tli-online/appendStorage/{BU}` stay on one line.
  - At step 4 only `4` is lit and only API003's edge is the path.
  - `a` draws all 26 nodes with the 20 uninvolved ones dashed grey.

## Resources

- [Sentry — Seer issue fix](https://docs.sentry.io/product/ai-in-sentry/seer/issue-fix): root cause analysis → solution → code as a fixed order; the RCA shows the event sequence and the culprit before code.
- [Datadog — Watchdog RCA](https://docs.datadoghq.com/watchdog/rca/): root cause, critical failure and impact on the dependency map.
- [Dynatrace — Root cause analysis](https://docs.dynatrace.com/docs/platform/davis-ai/problem-and-root-cause/root-cause-analysis): the problem replay over Smartscape topology; the precedent for step-through.
- [Mermaid — Flowcharts syntax](https://mermaid.js.org/syntax/flowchart.html): consulted for the first, mermaid-drawn version.
- valence `internal/report/maplayout.go` and `internal/web/components/sysmap.templ` (local, `~/Source/valence`): the layout this page ports and the inline-SVG drawing it follows.
- Internal: 0355, 0191, 0192, 0337, 0341, 0361, ADR 0026, ADR 0027; bcircle/tli-api-service#1364, commits `b420e805`, `8279c38d`, `18362385`.
