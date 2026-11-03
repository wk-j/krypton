# Harness E2E Commands — Implementation Spec

> Status: Implemented (rev 4: no new UI; everything is a `#e2e` command in the ACP Harness) · rev 5 Implemented (check fields, 2026-11-03)
> Date: 2026-10-23
> Milestone: ACP Harness — commands
> Builds on: 0065 (Hurl runner) · 0305 (`#bg` transcript table) · 0326 (cell grid for output) · 0211 (new→register tool pattern)

> Later: [0329](0329-harness-e2e-browser-explorer.md) (2026-10-24) adds a read-only browser page opened by `#e2e open [<case>]`. Control stays in `#e2e` commands, and there is still no in-app view, panel, keybinding or palette entry.

> Later: [0355](0355-e2e-system-map.md) (2026-11-02) adds two optional contract fields, `Case.map` and `checks[].at`, which the browser page uses to draw a run on the case's system map.

> Rev 5 (2026-11-03, Implemented): seven optional check fields, `kind`, `step`, `target`, `params`, `evidence`, `expected` and `actual`, so a reader can tell preconditions, calls and expected results apart and see what each call sent. See [Rev 5 — Check Fields](#rev-5--check-fields).

## Problem

User, 2026-10-23, in order:

1. "I want to run on local machine only, but i want the feature build into krypton, so we can initlize e2e testing from krypton and able to execute test and tracking in krypton directly".
2. "Each project have difference e2e stucture how app now how to test without initlize phase?"
3. "App must support create e2e from zero event the project still not have any e2e setup".
4. "I think we no need any UI, we should minimal it by control everything with build-in command (#)".

Revs 1–3 of this spec designed an E2E Workbench content view. Rev 4 drops it: every action is a `#e2e` subcommand typed in the project's ACP Harness, and its output lands in that lane's transcript.

Observed in tli-api-service, the first target:

- **Runs stay on one machine.** 16 runs sit under the git-ignored `e2e/reports/`. #1328's comment lists 2 of its 14 runs and leaves out the latest PASS, `20261023T082053Z`.
- **No run records the commit it ran.** #1331's comment still says "ยังไม่ commit", but the case is `7c88246d` on `origin/wk-j`.
- **No single command reruns every case with fresh data.** `--set` rejects params a case does not declare (`run.mjs` `mergeParams`), and each case names its single-use datum differently.

## Solution

- **One hash command family, `#e2e`.** It acts on the Harness's project dir and works only in a local Harness. There is no in-app view, panel, keybinding or palette entry. Since 0329, `#e2e open` opens a read-only browser page; it cannot run anything.
- **Adapter Contract v1.** Each project has a manifest `.krypton/e2e/project.toml` and an adapter with `list`, `run` and an optional `history`. Every run reports one normalized Result JSON.
- **`#e2e init`** sends the Initialize prompt to the current lane. The lane picks one of two modes:
  - **Adopt** wraps the e2e runner the repo already has.
  - **Bootstrap** builds an e2e setup from zero. It plans in `PLAN.md` first, and the user approves by replying in the lane.

  Both modes end when the MCP tool `e2e_adapter_check` returns ok.
- **`#e2e run`, `rerun`, `cancel` and `status` are executed by Krypton, not the model.** Records are therefore deterministic: argv, git commit, case hash, exit code, log and Result. `#e2e case` and `#e2e report` are prompt verbs built from the manifest.

## Research

**Runner, first target** (tli-api-service at `7c88246d`)

- **CLI.** `node e2e/run.mjs <issue> [--set k=v]`. Exit codes: 0 PASS, 1 FAIL/ERROR, 2 BLOCKED. `--list` prints TSV without params.
- **Output per case.** The runner prints a `report e2e/reports/<issue>/<runId>/report.md` line. The run folder holds `report.md`, `files/` and `evidence.json`:
  - fields `{case, env, runId, verdict, params, state, results[{phase,section,status,label,detail}]}`;
  - `status` ∈ `pass|fail|skip|blocked|info`;
  - both cases record `state.images`.
- **Not recorded:** the git SHA, argv and exit code of a run.
- **SSH.** `lib/remote.mjs:13-14` sets no `BatchMode`.
- **Skills.** `create-e2e-test-case` and `run-e2e-test-case`; the latter reruns, then PATCHes the `<!-- e2e:<N> -->` comment.
- **gh.** `gh issue list --json …,comments` returns comment bodies but not comment `updatedAt`.

**Krypton**

- **Hash commands.** The roster is `HASH_COMMANDS` (`hash-commands.ts:56`), and `runHashCommand` (`acp-harness-view.ts:11628`) dispatches them. Two precedents:
  - **Prompt verbs.** They go through `enqueueSystemPrompt` and need an idle lane: `#lesson` (`:11968`), `#wiki` (`:11987`).
  - **Krypton-run output.** `#bg` prints its table as transcript text (`:12413-12418`). `!shell` appends a pending `shell` row and fills it once on completion (`:12420-12453`). `shell` rows render on the cell grid (`components/system-row/index.ts:90`).

  `REMOTE_UNSUPPORTED_HASH_COMMANDS` is at `:864`.
- **Why not `run_shell`.** It (`commands.rs:1131-1200`) runs `sh -c` with the GUI env, so `node` under nvm is not found, and it has no result file and no ledger. Login env comes from `pty.rs:36` (`cached_login_env`, `cached_login_path`), injected by `PtyManager::spawn` (`:367-382`).
- **Process runner.** `hurl.rs` `start_run` is the precedent: non-PTY child, stdin null, output cap. Not to copy:
  - it holds the `children` lock across `child.wait().await` (`:644-653`), so cancel blocks until exit;
  - `start_kill` kills only the direct child.

  Process-group teardown: `acp.rs:2010` uses `process_group(0)`, and `dispose_client` (`:2644-2677`) sends SIGTERM, then SIGKILL. The exit drain is at `lib.rs:605`.
- **Lane-called validation.** Review Board's `review_new`/`review_register` (`hook_server.rs:6528,6561`) is the pattern: the lane writes files, then a tool call makes Krypton validate them.

**Alternatives rejected**

1. **A workbench view (revs 1–3).** The user asked for commands only, and the transcript already shows text, tables and status.
2. **Hard-code one runner layout (rev 1).** It fails on the second project.
3. **Parse JUnit or Playwright output natively.** A JUnit `testcase` has only failure, error and skipped (go-junit-report `junit.go`): no blocked state, no params, no versions. An adapter can convert it.
4. **Framework templates in Krypton.** The stack differs per repo. `BOOTSTRAP.md` states the outcome, and the lane writes code in the repo's language.
5. **`#e2e run` as a prompt, with the lane running tests itself.** That spends a model turn per run and records only what the model chooses to report. A Krypton-run command records exact argv, commit and exit code.
6. **A trust store (revs 2–3).** It is not needed now: nothing runs when a view opens. Every execution is a `#e2e` command typed in that repo's Harness, the same as running its test script.

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| VS Code Testing API | Each framework extension registers a `TestController`, discovers tests with `resolveHandler`, and runs them through run profiles | Generic surface over a per-framework adapter |
| Allure | Per-framework adapters write one common `allure-results` format. Failed (product) vs Broken (test could not check); v3 adds one JSONL line per launch | Normalized Result; BLOCKED ≠ FAIL |
| Zed tasks | `task: spawn` and `task: rerun` from the command palette; per-project `.zed/tasks.json` | Command-only control; rerun as an exact replay |
| Playwright init | `npm init playwright@latest` asks about language, folder, CI and browsers, then writes `playwright.config.ts` and an example spec | Bootstrap asks first, then scaffolds |
| Cypress | The Launchpad asks for a testing type and lists generated config files for review. Spec rows show the last 4 statuses | Plan before files; verdict history strip |

**Krypton delta.** No tool lets an agent learn or build a repo's e2e setup and then runs and tracks it locally. Like Zed tasks, everything is a typed command, and results are transcript text instead of a test tree.

## Adapter Contract v1

`#e2e init` writes the contract into the project as `.krypton/e2e/CONTRACT.md`, together with a JSON Schema. The Rust validator decides what is valid.

| File in `.krypton/e2e/` (git-ignored in tli-api-service, `.gitignore:133`) | Written by |
|---|---|
| `CONTRACT.md`, `BOOTSTRAP.md` | Krypton, on every `#e2e init` |
| `PLAN.md` (Bootstrap) | the lane; the user may edit it |
| `project.toml`, adapter files | the lane, or the user |
| `launches.jsonl`, `runs/<launchId>/{result.json,log}` | Krypton |

```toml
version = 1
name = "dev-tli e2e"
adapter = ["node", ".krypton/e2e/adapter.mjs"]    # argv prefix, run from the repo root
history = true                                    # the adapter implements `history`
issue_label = "type: Automate E2E"                # optional: issue marks in #e2e status
create_prompt = "Use the create-e2e-test-case skill to write the case for {issue_url}."   # optional: #e2e case
report_prompt = "Use the run-e2e-test-case skill to post run {run_id} ({result_path}) on {issue_url} without rerunning it; the comment must contain {run_id}."  # optional: #e2e report
```

| Subcommand | Output | Rule |
|---|---|---|
| `list` | stdout `{"version":1,"cases":[Case]}` | exit 0 within 60 s |
| `run <caseId> [--param k=v]…` | log on stdout/stderr; Result written to `$KRYPTON_E2E_RESULT` before exit | exit code informational |
| `history` | stdout `{"version":1,"runs":[Result]}`, runs made outside Krypton | only when `history = true`; 60 s |

```
Case   { id, title, code?, issue?: number, params?: {k: string|number}, fresh?: {k: string}, files?: [path], map?: path }
Result { version: 1, caseId, runId, verdict: "PASS"|"FAIL"|"ERROR"|"BLOCKED", startedAt, finishedAt,
         env?, versions?: {component: version}, params?,
         checks: [{ group?, label, status: "pass"|"fail"|"skip"|"blocked"|"info", detail?, at?,
                    kind?, step?, target?, params?, evidence?, expected?, actual? }],   // rev 5
         artifacts?: [{ label, path }], message? }
```

**Rules.**

- Paths are relative to the repo root.
- `runId` is the adapter's own id, unique per case. Launches and `history` dedupe by `(caseId, runId)`.
- `BLOCKED`: a precondition failed and the app was never exercised.
- `ERROR`: the harness itself broke.
- `map` and `at` (spec 0355) are optional. `map` is a repo-relative TOML map of the system the case tests. `at` is the id of the map node a check is about. Readers that predate them ignore both.
- `kind`, `step`, `target`, `params`, `evidence`, `expected` and `actual` (rev 5) are optional; see [Rev 5 — Check Fields](#rev-5--check-fields). Readers that predate them ignore them.

**Expected Adopt output for tli-api-service.** This is the lane's work; the repo is unchanged.

- `list` imports each `e2e/cases/<N>/case.mjs` → `id`/`issue` = N, `code`, `params`, `files: ["e2e/cases/N"]`, `fresh` (#1328 `{tempRpNo:"new"}`).
- `run` spawns `node e2e/run.mjs N --set k=v` and reads the `report …` line. It maps `results` → `checks` (`section` → `group`), `state.images` → `versions`, and `report.md`/`files/` → `artifacts`.
- `history` converts every `e2e/reports/*/*/evidence.json`.

## Rev 5 — Check Fields

> Date: 2026-11-03. Approved and implemented the same day; see "Implementation Notes (rev 5)" at the end of this section.

### Problem

User, 2026-11-03, on valence run `tli-api-service/runs/f4e38d26221cfd5d` (case 1368, 29 checks): "i see everthing max together user unable to identify what apicall, log, etc", then "have multiple api call, why i see only one parameter panel?"

- A check carries `group`, `label`, `status`, `detail` and `at`. Nothing says whether a row is a precondition, something the harness did, or an expected result, nor which API, table or log it read.
- `CONTRACT.md` says "`group` is the section or phase": one field, two meanings. tli-api-service writes `group = section ?? phase` (`.krypton/e2e/adapter.mjs:69`). Rows with a section lose their phase, so group `verify` holds only 2 notes, and `execute` mixes the calls that set up the job with the calls under test.
- `Result.params` is one object per run: the case inputs (`policyNo=new`, `poRequestDate=today`). The run's 5 calls, and the values they actually sent (`83697031`; `25691103`, `20261103`, `25aa1103`), have no place in the Result.
- The raw responses exist (`evidence.json`, written by `e2e/run.mjs:114-116`), but only as one whole-file artifact that no check points into.

### Solution

Seven optional fields on a check. Existing fields keep their meaning, and a Result without the new fields is read exactly as today. Every field is optional, so the Result stays `version: 1`.

| Field | Answers | Type |
|---|---|---|
| `kind` | Is the row a precondition, something the harness did, or an expected result? | `"precondition"` \| `"step"` \| `"expect"` |
| `step` | Which step is the row about? On a `kind: "step"` row it declares the step; on any other row it links the row to that step | string, `^[a-z0-9][a-z0-9._-]{0,47}$` (the map node id rule) |
| `target` | What was called or read | `{ type, name }`: `type` ∈ `http` `db` `log` `file` `ui` `cli` `process` `other`; `name` one line, ≤ 200 chars |
| `params` | The inputs the step sent, or the keys a read used | `{k: string\|number\|boolean}`, the `Result.params` rule |
| `evidence` | Where the raw request, response, rows or screenshot are | `{ artifact, pointer? }`: `artifact` is the `label` of an `artifacts` entry; `pointer` is an RFC 6901 JSON Pointer into it when it is a `.json` file |
| `expected`, `actual` | What the check wanted and what it saw | strings; JSON text for structured values |

Writing rules, stated in `CONTRACT.md`:

- `status: "info"` stays the note; a note needs no `kind`.
- `detail` stays the one-line summary even when `expected`/`actual` are set, because `#e2e status` and pre-rev-5 readers show only `detail`.
- `group` is the section, for example the expected result a set of rows proves; the role belongs in `kind`. A pre-rev-5 adapter that put the phase in `group` stays valid.
- No secret values in `target.name`, `params`, `expected` or `actual`. A URL that carries a token is written as its template (`/e2e/{token}`).
- Large bodies go in an artifact that `evidence` points at.

Case 1368, the call that sends the CE date, and two rows about it:

```json
{ "kind": "step", "step": "call-ce", "label": "getWIPDocuments/POS · CE date (20261103)", "status": "pass", "detail": "204",
  "target": { "type": "http", "name": "POST /tli/getWIPDocuments/POS" }, "at": "api001",
  "params": { "policy_no": "83697031", "po_tr_type": "CJ", "po_request_date": "20261103", "user_name": "9003684" },
  "evidence": { "artifact": "evidence", "pointer": "/evidence/getWIPDocuments~1POS CE date (20261103)" } }
{ "kind": "expect", "step": "call-ce", "group": "4. ส่งวันที่เดียวกันเป็นปี ค.ศ. (20261103) → … จึงไม่พบ", "label": "HTTP status",
  "status": "pass", "detail": "= 204", "expected": "204", "actual": "204",
  "target": { "type": "http", "name": "POST /tli/getWIPDocuments/POS" }, "at": "api001" }
{ "kind": "expect", "step": "call-ce", "group": "4. ส่งวันที่เดียวกันเป็นปี ค.ศ. (20261103) → … จึงไม่พบ", "label": "ไม่มีแถว tr_log เพิ่ม",
  "status": "pass", "detail": "= 1", "expected": "1", "actual": "1",
  "target": { "type": "db", "name": "dim.tr_log" }, "params": { "action": 7, "policy_no": "83697031" }, "at": "dim-log" }
```

### Research

- **The run.** Its 29 rows are 8 preconditions (one a note), 2 setup calls, 3 calls under test, 7 response checks, 6 `tr_log` checks and 3 notes. The runner already knows most roles: `require` is a precondition, `check`/`checkThat` an expected result, `note` an info row (`e2e/lib/context.mjs:30-54`). It records only `{phase, section, at, status, label, detail}` (`:24`), and `check()` folds its separate `actual` and `expected` into `detail` (`:41-45`).
- **Readers today.** `validate_result` reads `group`, `detail`, `at`, `label` and `status`, and ignores other keys without error (`e2e.rs:504-508`). The browser page receives the whole Result (`E2eRunDetail.result: Option<Value>`, `e2e.rs:2461-2464`) and draws four of its fields (`surfaces/e2e/index.ts:116-122`, `:829-841`). valence decodes five fields (`internal/krypton/contract.go:234-240`) and pushes the raw Result unchanged (`internal/push/push.go:201`). An adapter can therefore write the new fields before any reader shows them.
- **The `at` precedent (0355).** `e2e_adapter_check` checks references; `validate_result` does not, because `INVALID RESULT` hides every row. Rev 5's references follow it.

**Alternatives rejected**

1. **Nested `steps[]` (Allure).** Every reader and the 0355 pins use the flat `checks` list, and a pre-rev-5 reader would lose nested rows. A key keeps the list flat.
2. **The role in `group`** (`prepare › environment`). One field keeps two meanings, and renamed groups break the 0355 comparison with the last PASS, which matches by `group`.
3. **The role from `status`.** `pass` does not tell a precondition from an expected result.
4. **The target from the map node's `shape`.** `store` covers tables and log files alike, and rows off the map have no node.
5. **A separate `id` for steps.** `step` on a `kind: "step"` row is the declaration, so one field does both.
6. **Request and response bodies inline.** Size and the secret rule; `evidence` points at the artifact instead.

### Prior Art

| Tool | Implementation | Taken |
|---|---|---|
| Allure | `result.json`: the test and each nested step carry `name`, `status`, `parameters[{name, value, excluded, mode}]` and `attachments[{name, source, type}]` | params and evidence per step |
| Playwright Test | `TestStep.category`: `expect`, `fixture`, `hook`, `pw:api`, `test.step`, `test.attach` | a role per row separates setup, actions and assertions |
| Hurl | `--report-json` writes `report.json` with each file's `--json` export and a reference to every HTTP response dumped to disk | evidence by reference, not inline |
| Node `assert` | `AssertionError` carries `actual`, `expected` and `operator` apart from its message | `expected`/`actual` apart from `detail` |

**Krypton delta.** The list stays flat and links by key instead of nesting. Three coarse roles instead of Playwright's six categories. No `masked` params as in Allure: Contract v1 forbids secret values outright.

### Validation

`validate_result` checks types only. A violation is an error, and the run is `INVALID RESULT`, as for `status` today.

| Field | Error |
|---|---|
| `kind` | `checks[i].kind: "x" is not one of precondition\|step\|expect` |
| `step` | `checks[i].step: "x" must match ^[a-z0-9][a-z0-9._-]{0,47}$` |
| `target` | an object; `type` one of the eight; `name` a non-empty single line ≤ 200 chars |
| `params` | an object; `checks[i].params.k: must be a string, number or boolean` |
| `evidence` | an object; `artifact` a non-empty string; `pointer` a string that is empty or starts with `/` |
| `expected`, `actual` | `checks[i].expected: must be a string` |

`e2e_adapter_check` also checks references in the smoke `result_path`. They are errors, so the wiring is fixed at init:

- `checks[j].step: "x" is already declared by checks[i]`: two `kind: "step"` rows share a key.
- `checks[j].step: "x" is not a declared step`: a link with no `kind: "step"` row.
- `checks[j].evidence.artifact: "x" is not an artifact label`.
- Warning `checks[j]: a failed precondition is "blocked"`, for `kind: "precondition"` with `status: "fail"`.

### Readers

**Browser page (`#e2e open`; 0329, 0355).**

- **Row,** in every layout:
  - a `kind` tag before the label (`pre`, `step`, `expect`);
  - the target as `http · POST /tli/getWIPDocuments/POS`;
  - `params` as `k=v · k=v`, keys sorted;
  - `expected` and `actual` lines, `actual` in the fail tone when the row failed, each cut at 500 chars with `…`;
  - `evidence: <label> <pointer>`;
  - in the group and map layouts, `← <step label>` when the row links to a step.

  A field that is absent adds nothing, so a pre-rev-5 row looks as it does today.
- **`m` cycles the run pane:** map → by group → by step → map. The map is skipped when the case has no loaded map (0355), and "by step" when the Result has no `kind: "step"` row. The choice persists while the page is open.
- **By step:**
  1. **Preconditions:** `kind: "precondition"` rows without a resolvable `step` link.
  2. **One block per declared step,** in Result order: the `kind: "step"` row that first carries a key, or a `kind: "step"` row with no key. The step row is the head, followed by the rows that link to it, in Result order. A step with no linked row is a setup call and shows its head alone.
  3. **Other checks:** every remaining row, including a `kind: "step"` row that repeats an earlier key, grouped by `group` as in the group layout.

  `f` keeps failed and blocked rows; a step head stays when any of its rows does.
- **Evidence by keyboard.** When a shown row has `evidence`, `Tab` adds a `checks` pane: cases → runs → checks → artifacts.
  - `j`/`k` (`↓`/`↑`) move a cursor over the rows that have `evidence`, in display order.
  - `Enter` opens the artifact in the existing viewer. For a `.json` artifact whose `pointer` resolves, the viewer shows that value pretty-printed under the title `<label> · <path> · <pointer>`. Otherwise it shows the whole artifact under a banner `pointer <p> not found — whole file`.
  - `Esc` closes the viewer, as today.
- **Map pins** stay one per (`at`, `group`); their rows are the enriched rows.

**`#e2e status`** is unchanged. Failure lines stay `✗ group › label — detail`, which is why `CONTRACT.md` asks for `detail` alongside `expected`/`actual`.

**valence** draws the fields in its own repo, as it followed 0355. Its `push` already sends them in the raw Result.

**Adopt for tli-api-service** (a later project change, not part of rev 5). Adopt changes no project code, so the adapter can write only what the runner records: `kind` from `phase` (`prepare` → `precondition`, `execute` → `step`, `verify` → `expect`; `info` rows get no `kind`). `step`, `target`, per-step `params`, `evidence` pointers and `expected`/`actual` need the runner to record them, which is a project change the user asks for separately.

### Affected Files (rev 5)

| File | Change |
|------|--------|
| `src-tauri/src/e2e.rs` | `CONTRACT_MD`: Result schema, "Check fields", Rules. `validate_result`: the type rules. `Check` gains `kind`, `step`, `evidence_artifact`. `adapter_check`: the reference checks |
| `src/loopback/surfaces/e2e/index.ts` | `Check` type; enriched `checkRow`; `m` three-way cycle; by-step layout; `checks` pane; pointer viewer |
| `src/loopback/surfaces/e2e/e2e.css` | kind tag, target, params, expected/actual, cursor, step block |
| `src/loopback/surfaces/e2e/e2e.test.ts`, `fixtures/` | a fixture shaped like run 1368 with the new fields |
| `docs/0329-harness-e2e-browser-explorer.md`, `docs/0355-e2e-system-map.md` | run pane rows, the `m` cycle, the `checks` pane |

### Edge Cases (rev 5)

- **A Result without the fields.** Validated and drawn as today; "by step" and the `checks` pane never appear.
- **A step key declared twice.** The first `kind: "step"` row declares it; later ones render under "Other checks". `e2e_adapter_check` reports it.
- **A link to an undeclared step.** The row is placed as if it had no `step`, and shows `no step "x"`.
- **An `evidence.artifact` not in `artifacts`, or an artifact with a problem** (missing, too large). The row shows the problem, and `Enter` flashes it, as for an artifact with a problem today.
- **A pointer on a non-JSON artifact or a directory, or one that does not resolve.** The whole artifact opens under the banner.
- **A step row that fails** (no response). It heads its block in the fail tone; its linked rows keep their own status.
- **A pre-rev-5 adapter that writes the phase in `group`.** Still valid; nothing is migrated.

### Out of Scope (rev 5)

- Nested steps, per-check timing, severity and tags.
- Any change to `#e2e status` output.
- valence's report (its repo). tli-api-service's adapter and runner, and Krypton's own `e2e/` runner, writing the fields.
- A new contract version.

### Testing (rev 5)

- **Rust:** each type rule with its error text; a Result with every field validates; each reference error and the precondition warning in `e2e_adapter_check`; a pre-rev-5 Result validates unchanged.
- **TS:** the by-step blocks (preconditions, steps in order, a setup step alone, other checks); `f` with step heads; the `m` cycle skipping map and steps; the `checks` pane cursor; pointer hit, miss and non-JSON; a row without new fields renders as today.
- **Smoke:** a copy of run 1368's Result with the fields added by hand, through `e2e_adapter_check` and `#e2e open`.

### Implementation Notes (rev 5)

**Where the shipped code adds to the design above:**

- **A pure module.** Step links, the by-step layout, row text and the JSON Pointer resolver live in `src/loopback/surfaces/e2e/checks.ts` (with `checks.test.ts` for the RFC 6901 escapes), as `map.ts` holds the pin rules.
- **`RunResult.artifact_labels`.** `validate_result` keeps the artifact labels, so `adapter_check` checks `evidence.artifact` without reading the JSON again.
- **Error texts the design left open.** `checks[i].evidence.pointer: "x" must be empty or start with "/"`. `target.type` and `target.name` use the map `source` wording (`must be a single line`, `longer than 200 characters`), and `target.name` treats `\r` as a line break too.
- **Toolbar.** The map toggle became `view: <layout>` (`m`), shown when the run offers more than one layout.
- **`Enter` from the runs pane** still goes to the artifacts; the `checks` pane is reached with `Tab`.
- **Fixture D** (`fixtures/d-tli-api-1368-rev5.json`) is tli-api-service run `20261103T091029Z` of case 1368 with the fields added by hand: `kind` from the phase, step links from the sections, targets, the params each call sent, and evidence pointers into that run's real `evidence.json`.

**Verified (2026-11-03):**

- **Checks.** `cargo test e2e::` passes 33 tests. `cargo fmt --check` and `cargo clippy -- -D warnings` are clean; `cargo clippy --all-targets` stops on a `bool_assert_comparison` in `timeline.rs` tests that this change does not touch. `npx vitest run src/loopback/surfaces/e2e` passes 31 tests (6 new page cases, 2 pointer cases), and `npx tsc --noEmit` exits 0.
- **Smoke, validator.** Fixture D through `adapter_check` in a scratch project: ok, no reference errors. An unknown `kind` made the Result invalid (`checks[3].kind: "setup" is not one of precondition|step|expect`), and a dangling link gave `result: checks[20].step: "call-xx" is not a declared step`.
- **Smoke, page.** The real page under Vite, with fixture D and the run's real `evidence.json` behind a stubbed API, in headless Chromium: 29 rows; `m` gave 5 step blocks (1, 1, 10, 4 and 3 rows); `Tab Tab`, `j j j`, `Enter` opened the CE-date call's response and its `tr_log` row at `/evidence/getWIPDocuments~1POS CE date (20261103)`; `Esc` closed it.
- **Not exercised.** `#e2e open` inside a rebuilt Krypton, and valence.

## Initialize (`#e2e init [<hint>]`)

1. Krypton writes `CONTRACT.md` and `BOOTSTRAP.md` (`e2e_write_guides`). It then enqueues `e2eInitPrompt(hint, currentManifest)` in the current lane, which must be idle (existing `lane busy - #cancel first` chip).
2. The lane surveys the repo: README, package and build files, test folders, CI config, `.claude/skills`, `docs/`.
3. **Adopt.** The repo already runs e2e or integration tests against a running app. The lane writes `project.toml` and an adapter in `.krypton/e2e/`; project code is not changed.
4. **Bootstrap, phase A.** Nothing runs the app end to end. The lane writes `PLAN.md` with seven required sections, answered from the repo, and ends its turn asking the user to approve:
   1. **What to test.** App kind (web UI, HTTP API, multi-service flow, CLI), and the first case: an issue, or the main happy path.
   2. **Target environment.** A start command or an existing URL or host, and how the runner checks it. A missing environment gives `BLOCKED`, never `FAIL`.
   3. **Stack, with the reason.** Defaults:
      - web UI → Playwright Test;
      - HTTP API → the repo's own test runner, or Hurl when it has none;
      - multi-service flow → a script harness in the repo's language with prepare / execute / verify, as in tli-api-service's `e2e/`;
      - CLI → a script harness.
   4. **Layout,** and how a case maps to an issue.
   5. **Test data and secrets.** Single-use data and its `fresh` params. Secrets by env var name only.
   6. **Dependencies.** Project-local packages. Machine-wide tools (browsers, runtimes, CLIs) are listed as manual steps; the lane never installs them.
   7. **Manifest.** `issue_label`, `create_prompt`, `report_prompt`.
5. **Bootstrap, phase B.** It starts when the user approves in the lane, after editing `PLAN.md` if they want. The lane follows the `BOOTSTRAP.md` rules:
   - code in the repo (for example `e2e/`), uncommitted, following the repo's AGENTS.md / CLAUDE.md;
   - the runner implements `list`, `run` and `history` natively, so `project.toml` points straight at it, and it still runs from a terminal;
   - preconditions give `BLOCKED`, there is one check per expected result, and raw evidence is kept per run;
   - a README with "Run" and "Adding a case", which `create_prompt` points at;
   - the first case from the plan.
6. **Done, both modes.** The lane runs `KRYPTON_E2E_RESULT=.krypton/e2e/smoke-result.json <adapter> run <first case>`. It then calls `e2e_adapter_check {result_path}` until the check returns ok. Any verdict is valid; `BLOCKED` because the environment is down still proves the wiring.

**MCP tool `e2e_adapter_check`** (`hook_server.rs`, project-backed, not auto-allowed):

- **Args.** `{ result_path? }`, which must be under `<root>/.krypton/e2e/`.
- **Checks.**
  - `project.toml` parses against v1;
  - `adapter[0]` resolves on the login `PATH`;
  - `list` exits 0 within 60 s with valid JSON, unique `id`s and positive `issue`s;
  - the result file, if given, is a valid Result;
  - `history` is valid when declared.
- **Returns.** `{ ok, name, cases, errors[], warnings[] }`.

## Commands

`HASH_COMMANDS` entry: `e2e`, args `[status [<case>] | run <case|all> [k=v…] [--fresh] | rerun | cancel | init [<hint>] | case <issue> | report <case|runId>]`. `#e2e` is added to `REMOTE_UNSUPPORTED_HASH_COMMANDS`.

| Command | Executed by | Behavior |
|---|---|---|
| `#e2e`, `#e2e status` | Krypton | Case table: last verdict, time, ✓/✗, commit or `ext`, last 10 verdicts, marks. Labelled issues with no case are listed as `no case` rows |
| `#e2e status <case>` | Krypton | That case's last 10 runs, plus the failed checks of the newest |
| `#e2e run <case> [k=v…] [--fresh]` | Krypton | Runs one case. `--fresh` merges the case's `fresh` params, and explicit `k=v` wins |
| `#e2e run all [--fresh]` | Krypton | Every case in list order, one at a time, one row per case |
| `#e2e rerun` | Krypton | Replays the project's last launch argv |
| `#e2e cancel` | Krypton | Kills the active launch and stops `run all` |
| `#e2e init [<hint>]` | lane | Initialize |
| `#e2e case <issue>` | lane | `create_prompt` with `{issue}`, `{issue_url}` |
| `#e2e report <case\|runId>` | lane | `report_prompt` with `{issue}`, `{issue_url}`, `{run_id}`, `{result_path}` for that run (a case means its newest PASS/FAIL) |

**Output.** Every Krypton-run subcommand appends one `shell`-kind row whose first line is the command, so it renders on the cell grid like `!shell`.

- While a run is active, the row reads `running 1331 · started 15:17 · #e2e cancel to stop`.
- On finish it is filled once and stays static, exactly as `!shell` does:

```
#e2e run 1331 --fresh
PASS  1331  CORE005-CR12-8  291✓ 0✗  2m55s
commit 7c88246d* wk-j · tli-mapping-tool v0.5.5 · tli-api v3.7.3
result .krypton/e2e/runs/20261023T081709Z/result.json
log    .krypton/e2e/runs/20261023T081709Z/log
```

On FAIL, up to 10 lines `✗ group › label — detail` follow the first line, plus `… N more`.

```
#e2e status
CASE  ISSUE  LAST  WHEN         ✓/✗    COMMIT    LAST 10      MARKS
1331  #1331  PASS  10-23 15:17  291/0  ext       PB           unreported
1328  #1328  PASS  10-23 15:20  41/0   ext       PPPBPBPPBE   unreported
—     #NNNN  —     —            —      —         —            no case
```

`LAST 10` is newest first: `P` PASS, `F` FAIL, `E` ERROR, `B` BLOCKED, `C` CANCELLED, `!` NO RESULT / INVALID RESULT / INTERRUPTED. The first two rows are the real local runs of #1331 and #1328. The `no case` row is illustrative, because today every labelled issue has a case. Krypton-run subcommands work whether the lane is idle or busy.

**Marks** (pure, `src/acp/e2e-command.ts`):

| Mark | Rule |
|---|---|
| `uncommitted` | one of the case's `files` is modified or untracked |
| `edited` | case hash ≠ the hash at its newest Krypton PASS |
| `unreported` | the newest PASS/FAIL runId appears in no comment on its issue (one `gh issue list --label … --json number,url,comments` call; bodies dropped in Rust) |
| `no case` | a labelled issue that no case links to |

Issue marks need `issue_label`. If gh fails, the table prints `issues unavailable: <first stderr line>` and omits them.

## Rust (`src-tauri/src/e2e.rs`)

| Command | Returns | Notes |
|---|---|---|
| `e2e_write_guides(root)` | `Option<String>` (current `project.toml`) | writes `CONTRACT.md`, `BOOTSTRAP.md` |
| `e2e_status(root, case?)` | `E2eStatus { cases, runs, issues?, errors }` | adapter `list` + `history` (60 s each) ∪ `runs/*/result.json` + ledger; per-case hash of `files`; one `git status --porcelain` |
| `e2e_run(root, caseId, params)` | `E2eRunSummary` (resolves at exit) | `Err("busy")` while the root has an active launch |
| `e2e_rerun(root)` | `E2eRunSummary` | last ledger `start` argv |
| `e2e_cancel(root)` | `()` | SIGTERM to the group, SIGKILL after 5 s |
| `e2e_find_run(root, caseOrRunId)` | `{ caseId, runId, issue?, resultPath }` | For `#e2e report`. A run known only from `history` is first written to `runs/ext-<caseId>-<runId>/result.json`, so every report has a file to cite |

**Launching a run.**

- Spawns `<adapter…> run <caseId> --param k=v…` with `current_dir(root)`.
- Env: `login_env_pairs()` (extracted from `PtyManager::spawn`) + `cached_login_path()` + `KRYPTON_E2E_RESULT=<root>/.krypton/e2e/runs/<launchId>/result.json`.
- stdin null, `process_group(0)`.
- stdout and stderr go to `runs/<launchId>/log`, capped at 5 MB. Each launch deletes logs beyond the newest 100.
- The wait task owns the `Child`, and `E2eState.active: Mutex<HashMap<root, {launchId, pgid}>>` holds no child, so cancel never waits on it.
- The exit drain in `lib.rs` signals every active group.

**Ledger** (`launches.jsonl`, one `O_APPEND` write per line): `start {launchId, startedAt, caseId, argv, git{sha, branch, dirty}, caseHash}` and `finish {launchId, finishedAt, exitCode, cancelled}`.

**Verdicts beyond the Result.**

- `NO RESULT`: no result file.
- `INVALID RESULT`: the result fails validation; errors are printed.
- `INTERRUPTED`: `start` without `finish`.
- `CANCELLED`.

## Affected Files

| File | Change |
|------|--------|
| `src-tauri/src/e2e.rs` | New: contract types, validator, guide texts, status, launches, ledger |
| `src-tauri/src/hook_server.rs` | `e2e_adapter_check` descriptor, dispatch arm, `project_backed_bus_tool`, `tool_category` |
| `src-tauri/src/pty.rs` | Extract `login_env_pairs()` from `PtyManager::spawn` |
| `src-tauri/src/lib.rs` | `mod e2e`, `.manage(E2eState)`, commands, exit drain |
| `src/acp/hash-commands.ts` | `e2e` entry |
| `src/acp/e2e-command.ts` + test | Pure: argument parser, status/summary formatters, marks |
| `src/acp/harness-prompts.ts` | `e2eInitPrompt`, and manifest prompt rendering for `case`/`report` |
| `src/acp/harness-e2e-controller.ts` + test | `HarnessE2eController`: subcommand dispatch, `run all` queue and cancel, prompt verbs (spec 275 controller pattern) |
| `src/acp/harness-view-host.ts` | `HarnessE2eHost` (`appendShellRow` / `finishShellRow`, the `runShellCommand` row life cycle) |
| `src/acp/acp-harness-view.ts` | `#e2e` branch in `runHashCommand` → `e2eCtl.runCommand`; `e2eHost()`; remote-unsupported set |

## Edge Cases

- **No project dir.** Chip: `e2e unavailable - no project directory`.
- **Not initialized.** `#e2e status`/`run` print `not initialized — #e2e init`.
- **Invalid manifest.** The validator errors are printed.
- **`list` or `history` exceeds 60 s.** Status prints the stderr tail and falls back to Krypton launches.
- **A prompt subcommand on a busy lane.** The existing `lane busy - #cancel first` chip. Missing `create_prompt`/`report_prompt` → `not configured in project.toml`.
- **`run` while another launch is active on the root.** `busy`. Different projects can run at once.
- **The Harness closes mid-run.** The run continues and finishes in the ledger, and the next `#e2e status` shows it. If Krypton quits, the exit drain kills the group → `INTERRUPTED`.
- **SSH inside a runner wants a TTY.** stdin is null, so ssh fails; the run is ERROR or NO RESULT, with ssh's message in the log.
- **Bootstrap environment down.** The smoke run is `BLOCKED`, which is valid. The plan's manual steps say what to start.
- **The user rejects a plan.** Edit `PLAN.md` or reply in the lane; `#e2e init` starts over.
- **`.krypton/` not git-ignored.** Krypton files show as untracked; Krypton never edits `.gitignore`.

## Open Questions

None.

## Out of Scope

- Any new in-app view, window, panel, keybinding or palette entry. (The read-only browser page of 0329 is the one exception; it reads and never runs.)
- Streaming the live log into the transcript; the log path is printed, so `tail -f` works in a terminal.
- CI or remote execution.
- Krypton writing issue comments.
- Native JUnit or Playwright parsing.
- Framework templates in Krypton.
- Installing machine-wide tools.
- Trend charts.

## Phases

1. Contract, validator, guides, `e2e_adapter_check`, `#e2e init` (Adopt and Bootstrap).
2. `#e2e run`, `run all`, `rerun`, `cancel`, `status`, plus ledger and logs.
3. Issue marks, `#e2e case`, `#e2e report`.

## Testing

- **Rust:** every validator rule with its error text; ledger join (`INTERRUPTED`, `NO RESULT`, `INVALID RESULT`); `(caseId, runId)` dedupe; runId found in comment bodies; `result_path` confinement; cancel returns while the child is alive.
- **TS:** grammar (each subcommand, `k=v` with `=` in the value, `--fresh` with explicit-param precedence, rejected forms); status and summary formatting (failed-check cap, `ext` vs commit); each mark rule; the `run all` queue stopping on cancel.
- **Smoke, tli-api-service (Adopt):** `#e2e init` passes the check; `#e2e status` lists the 16 existing runs as `ext`; `#e2e run <case> --fresh` gives a PASS row with commit and versions; `#e2e cancel` mid-run gives `CANCELLED`.
- **Smoke, scratch repo with a tiny HTTP server (Bootstrap):** `#e2e init` writes `PLAN.md`; after "approve", e2e code and `project.toml` appear and the check passes; `#e2e run <first>` is PASS with the server up and BLOCKED with it down.

## Implementation Notes

**Deviations from the plan above:**

- `E2eRunInfo` carries `code` on the run `#e2e run`/`rerun` just made, so a single-run summary shows the case code without a second `list`.
- An active launch is not a row in `runs`. Status prints `running <case> since …` instead, because no verdict fits a run in progress.
- `includeIssues`, `params` and `fresh` are optional `invoke` arguments.
- Validator errors are prefixed `project.toml:`, `list:` or `history:`.
- The controller lives in `harness-e2e-controller.ts` rather than inline in the view.

**Verified (2026-10-24):**

- **Checks.** `cargo fmt --check` and `cargo clippy -D warnings` are clean. `cargo test` passes 553 tests (19 of them `e2e::tests`), and `npx vitest run` passes 230 files.
- **tli-api-service (Adopt).** The adapter was written to `.krypton/e2e/`, as Initialize would write it; the lane-written step itself is not covered.
  - `e2e_adapter_check` returned ok with 2 cases, and status listed all 16 existing runs as `ext`.
  - `run 1328 --fresh` ran against dev-tli and passed 41/0 in 11 s. It wrote both ledger lines, and the same run reported by `history` was deduped.
- **Scratch repo with a native runner (Bootstrap output).**
  - Status read `not initialized` before `project.toml` existed.
  - With the app up the run was PASS; with the app down it was BLOCKED.
  - A 30 s case cancelled after 2 s ended `CANCELLED` with no orphan process.
- **Not exercised.** The lane side of `#e2e init` (survey, `PLAN.md`, approval), and the rows inside the running app, which needs a rebuilt Krypton. The real Rust output was rendered through the TS formatters instead.

## Docs

`0004-architecture.md` (Rust module) · `0005-data-flow.md` (init and run flows) · `docs/README.md` row · `CONTEXT.md` (Adapter, Initialize, Run, Launch). The `#commands` reference page is generated from `HASH_COMMANDS`.

## Resources

- [VS Code Testing API](https://code.visualstudio.com/api/extension-guides/testing): per-framework `TestController`, `resolveHandler`, run profiles.
- [Allure statuses](https://allurereport.org/docs/test-statuses), [history](https://allurereport.org/docs/history-and-retries): a common results format from per-framework adapters, Broken vs Failed, and per-launch history.
- [Zed tasks](https://zed.dev/docs/tasks): command-palette spawn/rerun and a per-project task file.
- [Playwright intro](https://playwright.dev/docs/intro), [Cypress Launchpad](https://docs.cypress.io/app/get-started/open-the-app), [Cypress recorded runs](https://docs.cypress.io/cloud/features/recorded-runs): ask-then-scaffold, review of generated files, recent-status strip.
- [go-junit-report `junit.go`](https://github.com/jstemmer/go-junit-report/blob/master/junit/junit.go): JUnit testcase states have no blocked state and no params.
- tli-api-service `e2e/README.md`, `e2e/run.mjs`, `e2e/lib/context.mjs`, `.claude/skills/{create,run}-e2e-test-case/SKILL.md` at `7c88246d`: the first Adopt target.
- [Allure test result file](https://allurereport.org/docs/how-it-works-test-result-file/): per-step `parameters` and `attachments`, with a `masked` mode (rev 5).
- [Playwright `testReporter.d.ts`, `TestStep.category`](https://github.com/microsoft/playwright/blob/main/packages/playwright/types/testReporter.d.ts): `expect`, `fixture`, `hook`, `pw:api`, `test.step`, `test.attach` (rev 5).
- [Hurl running tests, JSON report](https://hurl.dev/docs/running-tests.html#json-report): `report.json` refers to each HTTP response dumped to disk (rev 5).
- [Node.js `assert.AssertionError`](https://nodejs.org/api/assert.html#class-assertassertionerror): `actual`, `expected`, `operator` apart from the message (rev 5).
