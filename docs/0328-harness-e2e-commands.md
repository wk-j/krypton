# Harness E2E Commands — Implementation Spec

> Status: Implemented (rev 4: no new UI; everything is a `#e2e` command in the ACP Harness)
> Date: 2026-10-23
> Milestone: ACP Harness — commands
> Builds on: 0065 (Hurl runner) · 0305 (`#bg` transcript table) · 0326 (cell grid for output) · 0211 (new→register tool pattern)

> Later: [0329](0329-harness-e2e-browser-explorer.md) (2026-10-24) adds a read-only browser page opened by `#e2e open [<case>]`. Control stays in `#e2e` commands, and there is still no in-app view, panel, keybinding or palette entry.

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
Case   { id, title, code?, issue?: number, params?: {k: string|number}, fresh?: {k: string}, files?: [path] }
Result { version: 1, caseId, runId, verdict: "PASS"|"FAIL"|"ERROR"|"BLOCKED", startedAt, finishedAt,
         env?, versions?: {component: version}, params?,
         checks: [{ group?, label, status: "pass"|"fail"|"skip"|"blocked"|"info", detail? }],
         artifacts?: [{ label, path }], message? }
```

**Rules.**

- Paths are relative to the repo root.
- `runId` is the adapter's own id, unique per case. Launches and `history` dedupe by `(caseId, runId)`.
- `BLOCKED`: a precondition failed and the app was never exercised.
- `ERROR`: the harness itself broke.

**Expected Adopt output for tli-api-service.** This is the lane's work; the repo is unchanged.

- `list` imports each `e2e/cases/<N>/case.mjs` → `id`/`issue` = N, `code`, `params`, `files: ["e2e/cases/N"]`, `fresh` (#1328 `{tempRpNo:"new"}`).
- `run` spawns `node e2e/run.mjs N --set k=v` and reads the `report …` line. It maps `results` → `checks` (`section` → `group`), `state.images` → `versions`, and `report.md`/`files/` → `artifacts`.
- `history` converts every `e2e/reports/*/*/evidence.json`.

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
