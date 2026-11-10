# Rails Verifier — Implementation Spec

> Status: Implemented (rev 3, 2026-10-28: the Rails dock is a second tab in the Active Ticket dock's place; amended by spec 344, 2026-10-29: an Actions bar with Run, Send, Trust and Update buttons; by spec 345, 2026-10-29: a display budget for the dock content; and by spec 368, 2026-11-07: a check may be `manual`, skipped by Rails runs and run alone from its dock row, and Send carries a failed manual result (amendment A))
> Date: 2026-10-27
> Milestone: ACP Harness — architecture conformance
> Builds on: 306 (assist sidecar) · 276 / ADR-0021 (harness-owned verdict) · 145 (`#review` diff subject) · 328 (`#e2e` process runner) · 238 / 320 / 331 (ticket dock, panel toggles) · ADR-0001 · ADR-0004 · ADR-0007 · ADR-0008 · ADR-0017

## Problem

`/grill-with-docs` records decisions in `docs/adr/` and terms in `CONTEXT.md`. Nothing checks the code written afterwards against them. Lanes treat `AGENTS.md` as advice. `#review` reviewers never see ADRs, because `src/acp/review.ts` does not reference them, and `#review pass` runs no checks. Architectural drift is caught only when a human reads the diff, and sometimes never. The user also needs to follow, while lanes work, which rails hold, which are broken, and whether that is getting better or worse.

## Solution

Add a per-harness background **Rails verifier**. When the harness goes quiet, it makes one **rails run** over the project working tree:

1. **Check step.** Run the project's declared check commands: typecheck, tests, architecture tests. This step is deterministic and costs no tokens.
2. **Judge step.** A cheap headless model, using the spec 306 transport, compares the diff with the **rails**: the `## Rails` bullets that apply to the changed paths, plus the glossary entries the diff touches. A finding that does not cite one of those rule ids is dropped.

Code, not the model, decides the verdict. Every run is kept in `.krypton/rails/runs/`. The **Rails dock** is a dedicated panel that sits where the Active Ticket dock sits, as a second tab of the harness's right dock column. It tracks the current run, open findings and how long each has been open, what got resolved, every rule's latest status, and recent runs. A footer indicator shows the verdict outside the harness.

The human sends findings, and failed manual check results (spec 368), to a lane from the dock or with `#rails send`. The verifier never blocks a lane, never edits code, and never creates attention items. `#rails init` asks the current lane to turn existing ADRs into rails: it adds `## Rails` sections, writes `.krypton/rails.toml`, and writes architecture tests for the bullets that code can check. `#rails update` (spec 338) asks the current lane to change the existing rails from the human's own words.

## Research

- **What grill produces.** `grill-with-docs` is `grilling` plus `domain-modeling`. Its ADR format has no machine-readable rule section. The ADRs here are prose: 24 files, about 83 KB, plus about 30 KB of `CONTEXT.md`. That is too much to send on every run, so the verifier needs a compact rule section scoped by path.
- **Empryo v2 verifier** (`~/Source/empryo/src/core/agents/agent-verification.ts`) runs typecheck and tests with no tokens, then a read-only, fresh-context model that ends with `VERDICT:`. Its gaps: "errors are automatic FAIL" exists only in the prompt (code reads the verdict for a summary line, `step-utils.ts:190`); typecheck output is filtered to edited paths, hiding broken callers; test output is cut to 500 chars; it checks against the task, not the architecture.
- **Assist sidecar (spec 306).**
  - Reused as-is: `AssistEngine` (`src/acp/assist/engine.ts`: single-flight, deadline, breaker), `AcpAssistSession` (a backend with `mcpServers: []`) and `answerFencedRequest` (`headless-fence.ts:43-62`, declines every permission request and write).
  - Not usable as a task: assist tasks are active-lane only, run at turn end, are clamped to 20 s / 20 000 chars (`assist/config.ts:13-16`), and see only the transcript.
- **Getting the diff.** `acp_collect_review_git_state` (`commands.rs:470`) returns the diffstat, the diff (capped at 40 960 B) and untracked heads against `HEAD`. `working_diff_stat` (`commands.rs:740`) is the cheap clean-tree probe.
- **When to run.** LaneBus `lane:status` (`acp-harness-view.ts:1762`) carries `laneId`. ADR-0008 forbids filesystem watching.
- **Running commands.**
  - `run_command` and `run_shell` use the GUI env and have no timeout.
  - `e2e.rs` has `adapter_command` (login env, process group, `:1210`), `read_capped` (`:1224`) and `kill_group` (`:1194`).
  - No repo file declares checks today. The only one Krypton reads is `.krypton/e2e/project.toml`.
- **Where a dedicated panel fits.**
  - Five panels already share the right rail (`rail.top` / `rail.bottom`): plan, peek, thought, grammar and queue.
  - `dock.right` (`harness-layout.ts:43`) holds only the Active Ticket dock. That dock is a flush 352 px column with `position: absolute` (`harness-shared.css:130-149`). The dashboard yields `margin-right: 352px` under `.acp-harness--ticket-active` (`:126`), and below 960 px the dock becomes an overlay (`:206-221`). `renderTicketDock` sets the dock's `hidden` and toggles that class itself (`harness-ticket-controller.ts:591-593`); `›` and `Escape` hide it through `applyPanelsCommand` (`:289-296`).
  - Spec 320 gives each panel a titlebar toggle and a persisted hidden flag.
  - Content views open only as new tabs (`createContentTab`, `compositor.ts:6210`). Open-to-side (spec 296) is a Draft and not implemented.
  - Toasts were removed (specs 40/41).
  - Attention items come only from a lane's `attention_flag` (`acp-harness-view.ts:3149`).
- **Back to a lane.** `injectHarnessEnvelope(laneId, message)` (`inter-lane.ts:386`) delivers on the lane's next idle.
- **Remote harness.** The diff collectors run locally only, and the companion allowlist (`remote-runtime/src/main.rs:500-550`) forbids `npm` and `cargo`.
- **ADR-0001** rejected an "independent observer LLM watching all lane streams" and a "deterministic floor" for **judgement items**. Its reasons were: no latency before work reaches the human, no orchestration tax, and no second agent mis-judging what needs judgement. This design keeps to those reasons:
  - It creates no judgement items.
  - It runs only after lanes are idle and never blocks them.
  - The model may cite only declared rules.
  
  It does remove ADR-0001's "no automatic safety net" consequence for declared rails, at the user's request. That change is recorded as ADR-0025.

### Alternatives rejected

- **Extending `#review pass` only.** It is human-triggered and spends lanes. The user asked for a background checker.
- **Making it an `AssistTask`.** Assist tasks are active-lane only, see only the transcript, are capped at 20 s, and share single-flight with `follow-up` and `grammar`.
- **Injecting ADRs into the lane policy (spec 289).** That is advice, not a check, and it costs tokens on every resend.
- **Auto-detecting checks** (Empryo `detectProfile`). It guesses. Rails must be declared to be enforceable, and a declared list can be reviewed in git.
- **Auto-sending findings, or raising attention items.** A cheap judge can be wrong, and attention items contradict ADR-0001 item 1.
- **A slot in the shared right rail** (rev 1). It holds at most 8 rows beside five other panels, which leaves no room for history or rule status.
- **Stacking both docks in one column** (rev 2). The user chose tabs, so each dock keeps the full height.
- **A content view tab.** It is off screen while the user works in the harness, until spec 296 ships.
- **A loopback browser page** (like the e2e explorer, spec 329). It leaves the app. A tracker meant to be read at a glance belongs beside the lanes.

## Prior Art

| System | Implementation | Notes |
|---|---|---|
| Empryo `verifyEdits` | Typecheck and test, then a read-only model ending with `VERDICT: PASS\|FAIL\|PARTIAL`. Off by default. | Two-step shape adopted; the verdict moves from the prompt into code. |
| Cursor Bugbot | Reviews PR diffs with rules from `.cursor/BUGBOT.md`: the root file, plus files found walking up from changed files. Findings default to a `neutral` check. | Adopted: rules scoped by changed path, and model findings neutral. |
| archgate | ADR markdown plus a companion `.rules.ts`. `archgate check` reports file, line and ADR, with violation / warning / info severities. | ADR as rule source adopted. The project brings its own engine through `[[check]]`. |
| ArchUnit / dependency-cruiser | Architecture rules as unit tests (fitness functions). | What `#rails init` writes for bullets code can check. |
| direnv | Refuses a new `.envrc` until `direnv allow`, and records which files are allowed. | Trust gate for commands declared in the repo. |

**Krypton delta:** local, at lane quiet points rather than per PR, with no account or CI; tracked in a keyboard-driven dock beside the lanes; the model may cite only declared rules.

## Affected Files

| File | Change |
|---|---|
| `src-tauri/src/rails.rs` | **New.** Manifest, rule and glossary extraction, trust store, check runner, run ledger, tests |
| `src-tauri/src/child_process.rs` | **New.** `login_command`, `read_capped` and `kill_group` move here from `e2e.rs`, which then uses them |
| `src-tauri/src/hook_server.rs` | Make `write_file_atomic` (`:8332`) `pub(crate)` |
| `src-tauri/src/lib.rs` | `mod rails; mod child_process;` and register the 6 commands |
| `src-tauri/src/config.rs`, `src/config.ts` | `AcpHarnessRailsConfig` on `acp_harness`, plus tests |
| `src/acp/assist/engine.ts`, `types.ts` | Add `AssistCall<T, C>`; `AssistTask<T>` extends it; the engine becomes generic over the context type |
| `src/acp/rails/{types,glob,select,judge,track,envelope}.ts` | **New**, with tests |
| `src/acp/harness-rails-controller.ts` | **New.** Trigger, sequencing, state, history, send (spec 275 pattern) |
| `src/acp/harness-view-host.ts` | `HarnessRailsHost` |
| `src/acp/acp-harness-view.ts` | Build the dock column and tab strip, choose the shown tab, mount the Rails dock, route dock keys, dispatch `#rails`, construct and dispose the controller |
| `src/acp/harness-layout.ts` | `rails: { slot: 'dock.right', order: 20 }` |
| `src/acp/harness-ticket-controller.ts` | Stops creating the `dock.right` slot and toggling `--ticket-active`; shows its dock only while the Ticket tab is the shown tab |
| `src/styles/harness-shared.css` | `.acp-harness__dock` column (tab strip plus the shown dock) and `.acp-harness--dock-active` replace the ticket dock's own absolute placement and `--ticket-active` width rules |
| `src/acp/harness-panel-visibility.ts` | `rails` panel id and titlebar toggle; the selected dock tab, persisted per project |
| `src/acp/hash-commands.ts`, `src/acp/harness-prompts.ts` | `rails` entry and `commandMeta` (drift test); `railsInitPrompt` |
| `src/acp/components/rails-dock/` | **New** component, stylesheet and test; entry in `components/registry.ts`. The dock tabs reuse `TabStrip` (spec 302 §1.8) |
| `src/view-bus-types.ts`, `src/workspace-footer.ts`, `src/workspace-footer-rails.ts` | `system:rails` signal and footer segment |
| `docs/adr/0025-rails-verifier-is-a-harness-owned-background-checker.md` | **New** ADR; ADR-0001 gets a dated Update line pointing to it |
| `CONTEXT.md`, `docs/0004-architecture.md`, `docs/0005-data-flow.md`, `docs/0006-configuration.md`, `docs/0238-local-ticket-bundles.md`, `docs/0320-harness-titlebar-panel-toggles.md`, `docs/0331-ticket-panel-titlebar-hide.md`, `docs/README.md` | Terms and docs (0238/0320/0331: the ticket dock becomes a dock tab) |

## Design

### Terms (added to `CONTEXT.md`)

- **Rails**: the project's declared, checkable architecture rules. These are the `## Rails` bullets in rule sources plus the `[[check]]` commands in `.krypton/rails.toml`.
- **Enforced rule**: a rails bullet tied to a check by `check:<name>`. Every other bullet is **judge-only**.
- **Rails run**: one check step followed by one judge step over the current working tree. The check step runs only the checks not declared `manual` (spec 368).
- **Check**: one declared command. Its outcome is `pass`, `fail`, `timeout` or `error` (could not start). A check declared `manual` runs only when the human starts it, alone, outside any Rails run (spec 368).
- **Rails finding**: a judge-step result that cites one rule id, with severity `violation` or `suspect`.

### Rule source format

```markdown
## Rails

Applies to: `src/acp/**`, `src/ui/**`

- A sealed transcript row never repaints after its turn ends; late state goes through the owning component's `update()`.
- No stylesheet uses `backdrop-filter: blur()`. `check:arch-tests`
```

- **Section and bullets.** The section runs to the next `## ` heading. Only top-level `- ` bullets count, and continuation lines are joined to their bullet.
- **`Applies to:`** is optional. It takes comma-separated, backticked globs (`*`, `**`, `?`) relative to the repo root. Without it, the bullets apply to every path.
- **Enforced bullets.** A trailing `` `check:<name>` `` marks the bullet as enforced by that check. A name that is not declared becomes a warning.
- **Rule id.** The id is `<relative path>#<n>`, where `n` is the 1-based bullet index. The dock shortens it to the leading number, for example `0008#2`, or to the file stem when there is no number, for example `AGENTS#3`.
- **Glossary entries** come from the `glossary` file in `CONTEXT-FORMAT` form: `**Term**:` plus an `_Avoid_:` line. The id is `CONTEXT.md#<Term>`.

### Manifest `.krypton/rails.toml`

```toml
version = 1
sources = ["docs/adr", "AGENTS.md"]  # files, or directories (their *.md, non-recursive)
glossary = "CONTEXT.md"              # optional

[[check]]
name = "arch-tests"
argv = ["npx", "vitest", "run", "src/acp/components/styles-ownership.test.ts"]
timeout_s = 300                      # 5..1800, default 300
manual = false                       # optional; true: only the human starts it (spec 368)
```

Unknown keys become warnings, as in `e2e.rs:184-189`. A `version` other than 1 is an error. Check names must be unique. A `manual` that is not a boolean is an error: `check[i]: manual must be true or false`.

### Trust

- `~/.config/krypton/rails-trust.toml` holds `[[project]] root, sha256` entries, where `sha256` is the hash of the manifest bytes.
- `rails_load` reports `trust` as `trusted`, `untrusted` or `changed`.
- `rails_run_check` re-hashes the manifest and refuses to run unless it is trusted. The gate lives in Rust, not in the frontend.
- While trust is not `trusted`, each check row shows its argv on one line, and `Enter` on the row shows it whole (spec 345). `#rails trust`, or the dock's Trust button (spec 344), approves exactly that file content.
- Automatic runs require `trusted`. Without trust, a manual run does the judge step only.

### Rust API (`src-tauri/src/rails.rs`, serde camelCase)

```rust
#[tauri::command] fn rails_load(root: String) -> Result<RailsSnapshot, String>
#[tauri::command] fn rails_trust(root: String) -> Result<RailsSnapshot, String>
#[tauri::command] async fn rails_run_check(root: String, name: String) -> Result<RailsCheckResult, String> // Err("busy") while another check runs for root
#[tauri::command] fn rails_cancel(root: String) -> Result<(), String>
#[tauri::command] fn rails_record_run(root: String, run: serde_json::Value) -> Result<String, String> // atomic .krypton/rails/runs/<runId>.json; prunes to the newest 200; returns the path
#[tauri::command] fn rails_history(root: String, limit: u32) -> Result<Vec<serde_json::Value>, String> // newest first; unreadable files skipped
#[tauri::command] fn rails_record_check(root: String, run: serde_json::Value) -> Result<String, String> // spec 368: run.name must be a declared manual check; atomic .krypton/rails/checks/<name>.json; returns the path
#[tauri::command] fn rails_check_runs(root: String) -> Result<Vec<serde_json::Value>, String> // spec 368: every readable checks/*.json, sorted by file name; unreadable files skipped; no directory → empty

struct RailsSnapshot { manifest_path: String, trust: Trust, checks: Vec<RailsCheckDecl>, rules: Vec<RailsRule>,
                       glossary: Vec<GlossaryEntry>, uncovered_sources: Vec<String>, warnings: Vec<String>, error: Option<String> }
struct RailsCheckDecl { name: String, argv: Vec<String>, timeout_s: u64, manual: bool }
struct RailsRule { id: String, source: String, applies_to: Vec<String>, check: Option<String>, text: String }
struct GlossaryEntry { id: String, term: String, definition: String, avoid: Vec<String> }
struct RailsCheckResult { name: String, outcome: CheckOutcome, exit_code: Option<i32>, duration_ms: u64, output_tail: String /* ≤ 80 lines, 8 KiB */ }
```

- `uncovered_sources` lists the rule sources that have no `## Rails` section. Single-flight is per root. Check names use only letters, digits, `.`, `_` and `-`, so a `check:<name>` marker can always name one. Glossary term lines may carry a tag before the colon, as `CONTEXT.md` writes them (`**Lesson** (spec 298):`).
- Checks are spawned with `login_command` (login env, stdin null, own process group, cwd = root), stdout and stderr on one pipe. The newest 2 MiB of output is kept and the tail is taken from it. On timeout the group gets SIGTERM, then SIGKILL after 5 s; a check killed by `rails_cancel` returns `Err("cancelled")`, and the controller then drops the run unrecorded.
- `rails_record_run` requires a string `runId` matching `^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{4}$`, and first writes `.krypton/rails/.gitignore` (`*`, `!.gitignore`, the review-bundle pattern) so run files never reach `git status`. The run record shape is owned by `src/acp/rails/types.ts` (`RailsRunRecord`).
- `rails_record_check` (spec 368) uses the same atomic writer and `.gitignore` helper. It refuses a `run.name` that is not a string naming a check the manifest declares with `manual = true`, and a missing or invalid manifest. The record shape (`RailsCheckRun`) is owned by `types.ts`.

### Frontend

- `glob.ts`: `globToRegExp`. There is no glob dependency today.
- `select.ts`:
  - `selectRules(rules, changedPaths)` keeps rules with no `Applies to:` and rules where a glob matches a changed path.
  - `selectGlossary(entries, addedLines)` keeps entries whose term or `_Avoid_` word appears in the added lines.
- `judge.ts`: `railsJudge: AssistCall<RailsFindingSet, RailsJudgeContext>`.
- `track.ts`: finding lifecycle and rule status (see Tracking).
- `envelope.ts`: the text that `send` delivers, and the Send set (spec 368 amendment A).
- **Engine refactor.** `AssistEngine.run<T, C>(call: AssistCall<T, C>, ctx: C, cfg)`, where `AssistCall` is `{ id, system, payload, parse }` and `AssistTask<T>` extends `AssistCall<T, AssistContext>`. The rails controller owns its own `AssistEngine` and `AcpAssistSession`, so its single-flight and breaker are separate from the assist tasks; it disposes the session after 10 min without a run.
- At mount the controller calls `rails_load` and `rails_history(root, 20)`, so the dock shows tracking before the first run.

### Data Flow

```
1. A lane moves busy → idle (LaneBus lane:status). Preconditions: mode is auto, the harness is local,
   projectDir is set. Arm a debounce of debounce_ms; any later busy → idle re-arms it.
2. The debounce fires. If any lane is busy or needs_permission, wait for the next transition.
   Spec 339: inside `min_interval_ms` of the newest recorded run's start, hold the run instead (same timer,
   dock head "auto run held until HH:MM"); when the hold ends, step 2 runs again.
3. invoke working_diff_stat(projectDir). If files == 0: dock shows "clean tree", stop. Its repoRoot is the rails root.
4. invoke rails_load(root). On error: dock shows the error. If trust != trusted and the run is automatic: "paused", stop.
5. invoke acp_collect_review_git_state(cwd, untrackedAll: true) (one row per new file; #review keeps the default).
   fingerprint = SHA-256 of the diffstat, diff and untracked heads; an auto run equal to the last completed run stops,
   unless that run skipped checks and the manifest is now trusted.
6. Check step: invoke rails_run_check for each [[check]] with manual = false, in order; the dock shows
   "check i/n <name>", counting only those. On "busy": "busy (another harness)", stop.
7. Judge step, skipped when no rule and no glossary entry is selected: select, build the payload,
   then engine.run(railsJudge, …).
8. invoke working_diff_stat again. If it differs from step 3, mark the run stale; step 1 re-arms.
9. Compute the verdict. Snapshot the previous completed run from history BEFORE writing. Derive the
   tracking fields, call rails_record_run, update the dock, publish the footer signal.
```

A manual run (`#rails now`, `r` in the dock on any row but a manual check row, or the Run button) starts at step 3 and skips the fingerprint stop. Without trust, it skips step 6. `#rails off`, view dispose and harness close all cancel a run with `engine.cancel()`, plus `rails_cancel(root)` while a check is running.

A **manual check** (spec 368) never runs in a Rails run. The human starts it alone with `r` on its row, the row's `RUN` key or `#rails check <name>`: one `rails_run_check`, then `rails_record_check`. There is no clean-tree stop, fingerprint, judge or run record, and it never becomes `history[0]`. It is refused while mode is off, the manifest is not trusted, or a run or another check is in flight. At mount and after each run or check the controller reads `rails_check_runs`, keeping only declared manual checks. See spec 368 §Data Flow.

### Judge contract

- **Prompt.** The system prompt is fixed. Instructions are in English; notes must be in natural Thai, with technical terms and paths left in English.
- **Payload,** in this order, each part with its own budget inside `max_input_chars`:
  1. Selected rules, each whole. If they overflow, the first ones in source order are kept and the payload says "rules truncated (k of n)".
  2. The tail of each failed check, at most 2 000 chars each.
  3. The diffstat, then the diff in the remaining budget, with a truncation marker.
  4. Selected glossary entries, at most 4 000 chars.
- **Output.** One JSON object: `{"findings":[{"rule":"<id>","severity":"violation","file":"src/x.ts","line":42,"note":"…"}]}`.
- **`parse`** takes the text from the first `{` to the last `}` and keeps an entry only when `rule` is an id that was sent, `severity` is `violation` or `suspect`, `file` is a diffstat path, `line` is absent or an integer ≥ 1, and `note` is 1–240 chars. Other entries are counted as `dropped`. No object, or no `findings` array, returns `null`: the engine counts it as `invalid` toward the breaker. At most 20 findings are kept.

### Verdict (computed in code)

1. `check_failed` when any check outcome is `fail` or `timeout`. An `error` outcome (the command could not start) is reported as a run error, not as a rails failure.
2. Otherwise `findings` when at least one finding is kept.
3. Otherwise `clean`.

The model never overrides a check result (the Empryo gap; ADR-0021 precedent).

### Tracking

- **Finding identity** is `rule + file`; the line number can move between runs. Each run is compared with the newest earlier run that completed without error:
  - **`new`**: the finding was not in that run.
  - **`open since <time>`**: the finding was there too. The record carries the finding's `firstSeenRunId`.
  - **`resolved`**: the finding was there and is absent now, and its rule was in scope this run. If the rule was out of scope, the finding stays open, marked "not re-checked".
- **Rule status per run**: `violated`, `suspect`, `clean` (judged, no finding) or `out of scope`. An enforced rule takes its check's `pass` / `fail` instead. A rule enforced by a manual check (spec 368) never takes `clean` from the judge: it is `out of scope` unless a finding cites it (`violated` / `suspect`), and the dock's rule list and `#rails update` show that check's manual result instead (`pass`, `fail` or `manual · not run`). The dock shows each rule's status from the newest run in which the rule was in scope.
- **Manual results** (spec 368) never change a run's verdict, the tab badge or the footer; they show in their check row and the `#rails update` state block, and a `fail` or `timeout` result also in Send (amendment A).
- **Removed rules.** A previous finding whose rule or glossary id is gone from the snapshot is dropped, neither carried nor resolved.
- **Sources.** The dock reads history once at mount and then updates from the controller. It never polls.

### Commands

There is no new key binding; the Leader map is full (spec 222). The command is `#rails [now | check [<name>] | send | trust | init [<hint>] | update [<request>] | off | manual | auto]`:

- **bare**: selects and focuses the Rails tab, clearing its own hidden flag first; a hidden right panel (`#panels hide right`, spec 347) still wins and the chip says `right panel hidden · #panels show right`.
- **now**: starts a manual run (manual checks are skipped). With mode `off`, it refuses and says so, as `#assist` does.
- **check `<name>`** (spec 368): runs that one manual check alone, recording its result in `.krypton/rails/checks/<name>.json`. Bare, it lists the manual check names in a chip (`rails: manual checks — osv`).
- **send**: sends the Send set to the lane the command was typed in, as one `[rails]` envelope through `injectHarnessEnvelope`: the open findings of the newest run (when it has any) and every manual check whose row shows `FAIL` or `TIMEOUT` (spec 368 amendment A), at most 4 000 chars plus the run file path and each check file path, asking the lane to fix each finding and each failed check or explain why the rule does not apply, and never to weaken a check. A manual result goes as its last output line, its check file and its rerun command, never its output.
- **trust**: calls `rails_trust`.
- **init**: sends the one-shot `railsInitPrompt` to the current lane.
- **update**: sends `railsUpdatePrompt` to the current lane, carrying a fresh `rails_load` snapshot and the newest runs as fenced state plus the human's request; bare, the lane only proposes. Spec 338.
- **off | manual | auto**: an in-memory mode override, as `#assist` does. `manual` also drops an armed or held auto run (spec 339).

### `#rails init` prompt

The prompt tells the current lane to:

- read `docs/adr/*`, `CONTEXT.md` and `AGENTS.md`;
- add a `## Rails` section to each accepted ADR, with only checkable bullets plus `Applies to:`;
- for every bullet that code can check, write an architecture test in the repo's existing test framework, declare it in a `[[check]]`, and mark the bullet `check:<name>`;
- write `.krypton/rails.toml` with only checks it has run successfully;
- list the bullets that stay judge-only;
- not commit, and tell the human to run `#rails trust`.

### UI

**Placement**

- **Dock tabs.** The right column is `.acp-harness__dock` (absolute on the right, 352 px, flex column), holding a tab strip and one shown dock at full height; all other docks are `hidden`. Its ordered tabs are Ticket, Rails, and Assistants (spec 357). Rails uses `rails: { slot: 'dock.right', order: 20 }`; Assistants follows at order 30.
- **Availability.** Ticket requires an active ticket and Rails requires `.krypton/rails.toml`; each also requires its own panel flag and the right-side flag to be shown. Assistants requires those visibility flags but no content: an empty inventory is still available. It defaults hidden. A `TabStrip` (block `acp-dock`, item `tab`, role `tablist`; `TICKET | RAILS | ASSISTANTS`) renders when at least two tabs are available.
- **Badge.** The Rails tab label reads `RAILS ✗` after a failed check in the newest run; otherwise its count is the number of open findings. A manual check's result never sets it (spec 368). A finished run never switches tabs.
- **Selection.** The selected tab is persisted per project beside spec 320's flags. When it becomes unavailable (ticket cleared, tab hidden, manifest removed), the column shows the next available tab in dock order without changing the stored choice. Showing a tab through `#panels <id> show` selects it; Ticket/Rails titlebar toggles, `#ticket panel` and bare `#rails` preserve their existing selection behavior. `Open Assistant Instances` explicitly shows the right side, unhides Assistants, selects it and focuses it (spec 357).
- **Width.** `.acp-harness--dock-active` (any tab shown) reserves the width, replacing `--ticket-active`. The below-960 px overlay rules apply to the column.

**Content**

`RailsDock` lives in `src/acp/components/rails-dock/` (layer `krypton.component`, BEM `.acp-rails-dock`). Its sections, top to bottom, sized by spec 345:

1. **Head**, at most three lines: `RAILS`, the verdict pill and the run time (`▸` when an error or warnings are behind `Enter`); one state line (a run in progress such as `check 2/3 typecheck`, an error, the trust state such as `changed since trust · 4 checks wait`, the other progress lines, the empty-manifest hint or a warning count, the first that applies); and the trigger, lane and mode. `Enter` on the head shows the full state line, the manifest path, the full error and the warnings.
2. **Checks**: `name  PASS|FAIL|TIMEOUT|ERROR  1.2s`, with a labelled outcome badge (success, fault or warning), or muted `skipped` / `not run`. While trust is pending, each check's argv follows on one line. A manual check row (spec 368) reads its newest manual result instead of the run: `name  RUN  FAIL  14:02`, with a `RUN` key, the outcome badge (muted `manual` when never run) and the finish time; the duration moves into the expanded detail.
   The head's verdict and each check's outcome keep their state ink, tinted background and LED but no coloured
   outline or wrapper shadow; their transparent 1px border preserves dimensions (DESIGN.md 2.3.2).
3. **Findings**: each open finding as `violation|suspect  0008#2  file:line`, with the note on a second line and a tag `new` or `since 14:02`. A collapsed `resolved N` row follows.
4. **Rules**: one line such as `24 rules · 9 enforced`, then `3 sources without rails`. It expands to every rule with its latest status.
5. **Runs**: the newest 5 of the last 20, each with time, a flat verdict label (`✓ CLEAN`, `✗ CHECK FAILED`, `• FINDINGS` or `! ERROR`), findings count, trigger lane and a `stale` mark; `N older runs ▸` expands to the rest. Verdict labels keep their state ink and typography, with no background, border, padding or shadow.

Below the rows, outside the list, a fixed **Actions** bar (spec 344) holds four buttons: Run (`#rails now`), Send (`#rails send`), Trust (`#rails trust`) and Update (bare `#rails update`). A click takes the same path as the typed sub-command. Each button shows its state the way the Ticket Panel's issue actions do, through the shared `DockActionButton`; the bar's head line names the active lane that Send and Update go to.

**Keys** (dock focused):

| Key | Action |
|---|---|
| `j` / `k` | Move between rows |
| `Enter` | Expand the row: full note, check tail, rule text, or run detail |
| `1`–`5` | Jump to a section |
| `s` | Send the selected finding to the active lane; on a manual check row showing `FAIL` or `TIMEOUT`, that result alone (spec 368 amendment A); on the head row, the whole Send set |
| `r` | Start a manual run; on a manual check row, run that check alone (spec 368) |
| `[` / `]` | Previous / next available dock tab, wrapping in Ticket → Rails → Assistants order |
| `Escape` | Return focus to the composer |

In the Rails tab, `Escape` does not hide the tab, unlike the Ticket tab (spec 331), because tracking is meant to stay on screen; the titlebar toggle hides it. The view routes these keys only after a pending permission, question or file review has had them, and while the dock has focus it consumes every other unmodified key and the Ctrl editing chords, so nothing reaches the hidden draft. A tab switch moves focus to the newly shown dock. Section headings show their jump key as `[n]`. Rows and the Actions bar buttons are also clickable; the mouse is secondary, and Trust and Update have no dock key (spec 344). The dock has no `infinite` animation.

**Footer**

- The ViewBus signal `system:rails {sourceId, state, findings, failedCheck?}` feeds `workspace-footer-rails.ts`, which renders `RAILS ✓`, `RAILS 3` (neutral) or `RAILS ✗ <check>`, and hides itself when no harness has a manifest. Since spec 350, compact density shows only `RAILS N`, `RAILS error` and `RAILS ✗ <check>`; `clean`, `running` and `paused` show in detail density.
- Only a failed check is coloured, as a fault under ADR-0017. Model findings stay neutral, as evidence under ADR-0004.
- The label sits in a recessed readout using `--mat-well` and `--mat-well-shadow`, like the footer's Git branch: 8px theme radius, 18px height, 6px horizontal padding and 600-weight chrome type. It keeps the check name's original case, with no coloured outline or text glow; the footer stays 28px tall.

### Configuration

```toml
[acp_harness.rails]
mode = "auto"            # off | manual | auto — auto still needs a trusted manifest
backend = "claude"
model = "haiku"
timeout_ms = 60000       # judge step, 10_000..180_000
max_input_chars = 32000  # 4_000..80_000
debounce_ms = 5000       # 1_000..60_000
min_interval_ms = 0      # 0..3_600_000; 0 = off. Spaces auto run starts (spec 339)
```

## Edge Cases

- **A lane writes during a run.** Step 8 marks the run stale, and the next quiet point re-runs it (after `min_interval_ms` when set, spec 339).
- **Two harness views on one root.** `rails_run_check` returns `busy`, and the second dock shows "busy (another harness)". A manual check refused this way records nothing.
- **Manual checks** (spec 368): a never-run one shows muted `manual`; it still runs on a clean tree; removing `manual` makes it run in Rails runs again and its old `checks/<name>.json` is ignored; an older Krypton warns `unknown key "manual"` and runs it automatically.
- **The manifest is edited after trust.** Trust becomes `changed`; automatic runs pause and the dock shows the new argv.
- **A check binary is missing.** The outcome is `error` and the run is shown as an error, not as `check_failed`.
- **A check hangs.** It times out (TERM, then KILL after 5 s) and counts as failed.
- **The diff is over 40 KB.** It is truncated and the judge is told. Findings on any diffstat path are still accepted.
- **Rules over budget, or invalid judge output.** Rules over budget: the dock shows "rules truncated (k of n)". Three invalid outputs open the breaker for 5 min: "judge cooling down".
- **The model cites an unknown rule, or a file outside the change.** The finding is dropped, and the dock shows `dropped N`.
- **No `## Rails` section and no checks.** The dock shows `no rails` and the hint `#rails init`.
- **A cancelled turn.** It is still a busy → idle transition; the fingerprint stops a run when nothing changed.
- **Unborn HEAD, or large check output.** The collector diffs against the empty tree. Only the newest 2 MiB of output is kept, and the tail comes from it.
- **A harness narrower than 960 px.** The column becomes the overlay (solid background, spec 331 rev 2), with the tab strip and the shown dock.
- **Corrupt run files, or more than 200 runs.** `rails_history` skips unreadable files. The oldest files are pruned at write.
- **The harness is disposed mid-run.** `engine.cancel()` is called, and `rails_cancel(root)` too while a check is running (never during the judge, so another view's check on the same root is left alone). No record is written.
- **Remote harness.** The controller and the dock are never created; `#rails` replies "local projects only".

## Open Questions

None. The user confirmed every recommended default on 2026-10-27: findings must cite a rule; model `haiku`; mode `auto` behind `#rails trust`; findings reach a lane only by hand; `Escape` in the Rails tab does not hide it.

## Out of Scope

- Remote (SSH) harnesses.
- Auto-sending findings, auto-fixing, blocking a lane, gating commits or merges.
- Attention items, scores and rankings (ADR-0001, ADR-0004).
- CI or pre-commit integration; a project can run the same checks there itself.
- Editing the external `grill-with-docs` and `domain-modeling` skills. `#rails init` is the bridge.
- Editing rules or the manifest from the dock; a separate Rails content view or browser page. (Trust from the dock was here too; spec 344 adds a Trust button, which stays a human click with no dock key.)
- Inline annotations in the Diff Window, token metering (spec 306, ADR-0018/0019), and a built-in rule engine or DSL.

## Resources

- [Empryo `agent-verification.ts`](file:///Users/wk/Source/empryo/src/core/agents/agent-verification.ts): two-step verifier, prompt, typecheck/test filtering.
- [Cursor Bugbot docs](https://cursor.com/docs/bugbot): rules scoped by changed path; neutral-by-default findings.
- [archgate CLI](https://github.com/archgate/cli) and [Writing Rules](https://cli.archgate.dev/guides/writing-rules/): ADR plus companion rule file; severity tiers.
- [Fitness Functions for Your Architecture (InfoQ)](https://www.infoq.com/articles/fitness-functions-architecture): architecture rules as tests.
- [direnv(1)](https://direnv.net/man/direnv.1.html): `direnv allow` as a trust gate for files from a repo.
