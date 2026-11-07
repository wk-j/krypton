# Rails Manual Checks — Implementation Spec

> Status: Implemented (approved 2026-11-07: "ลงมือตามสเปก docs/0368-rails-manual-checks.md ตามที่เสนอ"). Amendment A (Send carries failed manual results): Implemented, approved 2026-11-07 ("อนุมัติ Amendment A ใน docs/0368-rails-manual-checks.md แล้วลงมือแก้โค้ดตามหัวข้อ Send (amendment A)")
> Date: 2026-11-07
> Milestone: ACP Harness — Rails
> Builds on: 337 (Rails verifier) · 344 (Actions bar) · 345 (display budget) · ADR-0025 · ADR-0029

## Problem

Every `[[check]]` runs in every Rails run, at each harness quiet point. Two kinds of check do not fit
that. A slow check (a 15-minute suite) would hold up every run. A check whose answer does not come
from the diff should run when the human asks for it, for example `osv`, which asks `api.osv.dev` about
the lockfiles. `osv` works around this today by scanning only lockfiles that differ from HEAD. On
2026-11-07 all 26 runs printed `lockfiles match HEAD, nothing to scan` and showed `PASS`. A full scan
of the same lockfiles finds 3 critical and 61 high advisory groups. There is no way to run one check
on demand.

**Amendment A.** A failed manual result cannot reach a lane. Send, `#rails send` and `s` read only the
newest run (spec 344), so on 2026-11-07 Send stayed disabled (`no open findings`) beside `osv FAIL
19:40`, and `s` on the `osv` row answered `select a finding, or the head row to send all`.

## Solution

A check may declare `manual = true`. Rails runs skip it: the quiet-point run, `#rails now`, `r` and
the Run button. The human runs it alone from its row in the Rails dock, with `r` on the row, the
row's `RUN` key, or `#rails check <name>`. Its newest result is kept per check in
`.krypton/rails/checks/<name>.json`. The row shows that result and the time it ran. As with a GitLab
optional manual job, the result never changes a run's verdict, the tab badge or the footer. This repo
marks `osv` manual, and `osv` then scans every lockfile whole.

**Amendment A.** Send-all (the Send button, `#rails send`, `s` on the head row) also carries every
manual result whose row shows `FAIL` or `TIMEOUT`; `s` on such a row sends it alone. The envelope
points at the result (last line, file, rerun command) and never pastes the output.

## Research

- **Manifest.** `parse_check` (`rails.rs:233-293`) reads `[[check]]` by hand. It accepts `name`,
  `argv` and `timeout_s`; any other key is a warning, not an error. A build without this spec reads
  `manual = true`, warns `check[i]: unknown key "manual"`, and runs the check automatically.
- **Trust** hashes the raw manifest bytes (`rails.rs:728,739`). Adding `manual` makes trust
  `changed`, and the human trusts again. That is correct, because what runs on its own changes.
- **The runner exists.** `rails_run_check(root, name)` (`rails.rs:1264-1272`) already runs exactly one
  check, behind the trust gate, the per-root single-flight lock, the timeout and the 80-line tail. The
  controller calls it once per check in `run()` (`harness-rails-controller.ts:503-529`).
- **Everything reads the newest run.**
  - Check rows (`rows.ts:24-61`), the tab badge (`controller:812-817`), the footer
    (`controller:827-844`) and Send (`envelope.ts`) all read `history[0].checks`.
  - A check missing from that run shows `not run`.
  - Its enforced rule falls back to the judge's status (`track.ts:145-152`). For `osv` that means the
    model can mark a rule `clean` that only a scan can check.
- **A run is about the diff.** It stops on a clean tree (`controller:461-469`) or on an unchanged
  fingerprint, and then it judges. A one-check result recorded as a run would become `history[0]`.
  It would then replace the head verdict, the Send source and the tracking base for findings.
- **Spec 344.** Every dock button is a `#rails` sub-command. No row has a button today: the Out of
  Scope section kept a per-finding Send button off because `s` already does it.
- **Send today** (amendment A): `send` (`controller:919-933`) needs an open finding in `history[0]`;
  `sendSelected` (`:935-940`) knows finding and head rows; `RailsSendMark` is keyed by `runId`.
- **The `osv` output does not fit an envelope.** The 19:40 tail is 80 lines, 6 650 chars: 39 of 185
  rows, all from `src-tauri/Cargo.lock` (rows sort by lockfile), then the count line, which ADR-0029
  puts last so the tail keeps it. Pasted, it passes the 4 000-char cap and shows a slice as the whole.

**Alternatives rejected**

- **Record a manual check as a run** (`trigger.kind = 'check'`). It would become the newest run, as
  above, and every reader would need to filter it out.
- **Keep the result in memory.** A 15-minute result would be lost on reload.
- **`mode = "auto" | "manual"` per check.** A third value has no use, so a boolean is enough.
- **Amendment A.** Sending a manual result only when the run has no open finding: what Send sends
  would depend on an unrelated run. Pasting the tail: over the cap, and a slice.

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| GitLab CI | `when: manual` on a job. It shows as skipped until someone selects **Run** (▶) next to the job. An *optional* manual job (`allow_failure: true`, the default outside `rules`) does not affect the pipeline status; a *blocking* one makes the pipeline `blocked`. | The row-level Run and the optional status are the model here. |
| pre-commit | `stages: [manual]`. No git hook triggers the hook; it runs only through `pre-commit run --hook-stage manual [hookid]`. | One flag in the config; the hook runs only when named. |
| Bazel | `tags = ["manual"]` leaves a target out of wildcard expansion (`...`, `:all`). It is built or tested only when named. | The whole set (Rails run) skips it; naming it (`#rails check`) runs it. |
| GitHub Actions + Copilot | **Explain Error** on a failed job's page, or under **More actions** for a failing check in the PR merge box, opens a Copilot chat about that one job. | Amendment A: the hand-off sits where the failure shows, one job at a time. |
| GitLab Duo | **Troubleshoot**, from a failed job's log or the merge request's Pipelines tab, runs Root Cause Analysis on the last 100 000 characters of the job log. | Amendment A: the agent gets the log because it cannot run the job. |

**Krypton delta.** Same as GitLab CI, pre-commit and Bazel: one flag, left out of the whole run, run by
name. Krypton runs it from the selected row with a key (`r`), and a click is the secondary path. The
result never blocks or colours anything outside its row, because Rails never gates (spec 337 Out of
Scope). Amendment A: as in GitHub and GitLab, a failure goes to an agent from where it shows. Unlike
them, the human picks the lane, and the message points at the result, not the log: a lane can read
the file and rerun the check.

## Affected Files

| File | Change |
|------|--------|
| `src-tauri/src/rails.rs`, `src-tauri/src/lib.rs` | `manual` in `parse_check` and `RailsCheckDecl`; `rails_record_check`, `rails_check_runs`; tests |
| `src/acp/rails/types.ts` | `RailsCheckDecl.manual`, `RailsCheckRun`, `RailsDockModel.checkRuns` / `checkInFlight` |
| `src/acp/harness-rails-controller.ts` (+ test) | Runs skip manual checks; `requestCheck`; `r` on a manual row; `#rails check`; load check runs at mount |
| `src/acp/rails/track.ts` (+ test) | `ruleStatuses`: a rule whose check is manual never takes `clean` from the judge |
| `src/acp/rails/rows.ts`, `actions.ts`, `update-state.ts` (+ tests) | A manual row reads `checkRuns`; Run tooltip; the `#rails update` state block |
| `src/acp/components/rails-dock/` (index, css, test) | `RUN` key, finish time, detail line |
| `src/acp/acp-harness-view.ts`, `src/acp/hash-commands.ts` | `#rails check <name>` dispatch and anatomy |
| `src/acp/harness-prompts.ts` | The init and update prompts name the `manual` key |
| `.krypton/rails.toml`, `scripts/rails-osv.py` | `osv` is manual and scans every lockfile |
| Docs | 0337 (Manifest, Rust API, Data Flow, Tracking, Commands, UI, Edge Cases), 0344 (Run tooltip, Out of Scope), 0345 (check row), ADR-0025, ADR-0029, `CONTEXT.md` (Check, Rails run), `README.md` |
| **Amendment A:** `src/acp/rails/envelope.ts`, `actions.ts` (+ tests) | `railsSendSet`; `railsEnvelope(run, manual)`; `RailsSendMark` keys on the Send set; `sendSet` replaces `latest` in the actions input |
| **Amendment A:** `src/acp/harness-rails-controller.ts` (+ test), `components/rails-dock/rails-dock.test.ts` | `send` uses the Send set; `s` on a manual check row; chips; the actions input shape |
| **Amendment A:** Docs | 0337 (Tracking, Commands `send`, Keys `s`), 0344 (Send state row, Send mark, Paths table, Send data flow), `0005-data-flow.md` (`#rails send`), ADR-0025 (item 1), `CONTEXT.md` (Check) |

## Design

### Manifest

```toml
[[check]]
name = "osv"
argv = ["python3", "scripts/rails-osv.py"]
timeout_s = 120
manual = true   # optional, default false: only the human starts it
```

A `manual` that is not a boolean is a manifest error: `check[i]: manual must be true or false`.

### Data Structures

```rust
pub struct RailsCheckDecl { pub name: String, pub argv: Vec<String>, pub timeout_s: u64, pub manual: bool }
```

```ts
export interface RailsCheckDecl { readonly name: string; readonly argv: readonly string[]; readonly timeoutS: number; readonly manual: boolean }

/** `.krypton/rails/checks/<name>.json`: the newest manual run of one check. */
export interface RailsCheckRun {
  readonly version: 1;
  readonly name: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  /** The lane `#rails check` was typed in, or the active lane for `r` / a click; null without one. */
  readonly laneName: string | null;
  readonly result: RailsCheckResult;
}

// RailsDockModel gains:
readonly checkRuns: ReadonlyMap<string, RailsCheckRun>; // manual checks only, by name
readonly checkInFlight: string | null;                  // the manual check running now
```

The check row keeps its shape. For a manual check, `result` comes from `checkRuns`, never from a run.

### API

```rust
// `run.name` must be a check the manifest declares with manual = true. Writes
// .krypton/rails/checks/<name>.json atomically (the runs/ writer) and returns its path.
#[tauri::command] fn rails_record_check(root: String, run: serde_json::Value) -> Result<String, String>
// Every readable checks/*.json; unreadable files are skipped, as rails_history does.
#[tauri::command] fn rails_check_runs(root: String) -> Result<Vec<serde_json::Value>, String>
```

```ts
// HarnessRailsController — the one path for `r`, a click on RUN and `#rails check <name>`.
requestCheck(name: string, lane: HarnessLane | null): Promise<void> | null
```

### Data Flow

```
1. The human presses r on a manual check row, clicks its RUN key, or types #rails check osv.
2. requestCheck refuses, with a chip, when: mode is off ("rails: off — #rails manual"); the manifest
   is not trusted ("rails: not trusted — #rails trust"); a run or a check is in flight ("rails: a run
   is already in progress"); the name is not a declared manual check ("rails: no manual check <name>").
3. checkInFlight = name; progress {checking, 1, 1, name}; the RUN key latches; the footer shows running.
4. invoke rails_run_check(root, name). "untrusted" (trust changed since step 2) → progress paused;
   "busy" → "busy (another harness)"; "cancelled" → nothing. Any other error becomes an `error`
   result, as in a run.
5. invoke rails_record_check; checkRuns.set(name, run); checkInFlight = null; progress idle; render; publish.
6. If an auto run came due during steps 3–5, arm the debounce again.
```

There is no clean-tree stop, no fingerprint, no judge and no run record. Step 6 of a Rails run (spec
337) iterates only the checks with `manual = false`; `check i/n` counts only those. At mount, and
after each run or check, the controller reads `rails_check_runs`. Only a record whose name is a
declared manual check is shown; any other record is ignored.

### Verdict, rules and signals

- A run's verdict, the tab badge and the footer read runs only. A manual result shows in its row, the
  `#rails update` state block and, while `fail` or `timeout`, Send (amendment A); nowhere else. While
  a manual check runs, the footer shows `running`, as it does for a run.
- A rule enforced by a manual check (`check:osv`) never takes `clean` from the judge. In a run its
  status is `out-of-scope`, unless a finding cites it (`violated` / `suspect`). The dock's rule list
  and `#rails update` show that check's manual result instead: `pass`, `fail`, or `manual · not run`.

### Keybindings

| Key | Context | Action |
|-----|---------|--------|
| `r` | Rails dock, a manual check row selected | Run that check alone |
| `r` | Rails dock, any other row | Start a manual run, as today (manual checks are skipped) |
| `s` | Rails dock, a manual check row showing `FAIL` or `TIMEOUT` | Send that result to the active lane (amendment A) |

The key-hint line stays `r run`. No new key.

### UI Changes

A manual check row is one line:

```
osv                        RUN   FAIL   14:02
osv                        RUN   manual
osv                    RUNNING   running
```

- **`RUN`** is a small dense key (`acp-rails-dock__run`, 24 px) between the name and the badge; the
  name truncates first.
  - A click takes the `#rails check <name>` path.
  - While its check runs, the key is latched and backlit cyan with `RUNNING` (the spec 344 running
    colour).
  - It is disabled, with the reason as its tooltip, when: mode is off (`rails is off · #rails
    manual`), the manifest is not trusted (`not trusted · #rails trust`), or another run or check is
    in flight (`a run is already in progress`).
- **Badge** is the manual result's outcome, coloured as any check's. It is muted `manual` when the
  check has never run.
- **Time** is the finish time: `HH:MM` today, `MM-DD` on an earlier day. The tooltip gives the full
  time and the lane. The duration moves into the detail.
- **Expanded** (`Enter`): `argv`, `ran 2026-11-07 14:02 · OMP-1 · 3.7s`, `exit`, then the tail, as
  spec 337 does. While trust is pending, the argv line of spec 345 shows as for any check.
- **Run tooltip** (trusted) becomes `Run the auto checks and the judge now (#rails now · r)`.

### Commands

`#rails check <name>` runs one manual check. Bare `#rails check` lists the names in a chip, for
example `rails: manual checks — osv`. `hash-commands.ts` adds it to the `rails` anatomy.

### Send (amendment A)

The **Send set** is what Send-all delivers: the newest run when it has open findings, plus each manual
result the dock shows as `FAIL` or `TIMEOUT`, in manifest order. It reads manual results as the check
rows do and leaves out the check running now, whose row shows `RUNNING`, not the old result. An
`error` result stays out, as a run's envelope leaves out `error` checks.

```ts
// src/acp/rails/envelope.ts
export interface RailsSendSet {
  readonly run: RailsRunRecord | null;       // null when the newest run has no open finding
  readonly manual: readonly RailsCheckRun[]; // failed manual results, manifest order
  readonly keys: readonly string[];          // `run:<runId>` if run; `check:<name>@<finishedAt>` each
  readonly label: string;                    // `3 open findings and failed osv` · `failed osv`
}
export function railsSendSet(model: RailsDockModel): RailsSendSet;
// run: { record, path, only? }; manual: { result, decl, path }, where path is the check file
export function railsEnvelope(run: RailsEnvelopeRun | null, manual: readonly RailsEnvelopeCheck[]): string;
```

**Envelope.** Each manual result adds a line to the head and a file line to the foot; the foot (run
file, check files, instruction) always survives the 4 000-char cap. The check file path is built as
`runPath` builds a run file's. The last line is the tail's last non-blank line, whitespace collapsed,
≤ 200 chars, left out for an empty tail. Argv is joined by spaces; an argument with a character
outside `[A-Za-z0-9_./:=@%+,-]` is POSIX single-quoted. With `osv` alone:

```
[rails] manual checks
Failed manual checks (1):
- osv (exit 1) at 2026-11-07 19:40 — last line: osv: 185 known vulnerabilities in 65 packages of package-lock.json, src-tauri/Cargo.lock, raycast/package-lock.json

Check file osv: /Users/wk/Source/krypton/.krypton/rails/checks/osv.json (last 80 lines of output) · rerun for the full output: python3 scripts/rails-osv.py
Fix each finding and each failed check, or explain why the rule does not apply here. Never weaken, skip or delete a check, or edit a rule, to make it pass.
```

With a run, its lines stay as today and `Failed manual checks (n):` sits between `Failed checks:` and
`Open findings (n):`. A timed-out result reads `- <name> (timeout) at …`. Every envelope's instruction
gains `and each failed check`.

**Send button** (replaces the Send row of spec 344 §State rules). Never running. Done (badge
`✓ <time>`, tooltip `<label> sent to <lane> <date time>`) while the set is not empty and every key is
in `lastSend.keys`, so a clean run after a send keeps it, and open findings in a newer run or a newer
failed result clear it. Disabled on an empty set (`no open findings or failed manual checks`) or with
no active lane (`no active lane`). Idle tooltip: `Send <label> to <lane> (#rails send · s on the head row)`.

**Flow.** Send-all calls `send(laneId, null)`: an empty set flashes `rails: no open findings or failed
manual checks`; otherwise `injectEnvelope`, chip `rails: sent <label> → <lane>`, and `lastSend = { keys,
label, laneName, at }`. `s` on a manual check row calls `sendCheck(laneId, name)`, which refuses while
the check runs (`rails: osv is running`) or unless its result is `fail` / `timeout` (`rails: osv has no
failed result to send`), then sends that result alone with chip `rails: sent failed osv → <lane>` and
no mark, as for one finding. `s` on any other non-finding row says `rails: select a finding, a failed
manual check, or the head row to send all`.

### Adoption in this repo

- **Manifest.** `.krypton/rails.toml`: `osv` gets `manual = true`; `timeout_s` stays 120.
- **Script.** `scripts/rails-osv.py` scans all three lockfiles whole on every run; the HEAD
  comparison goes. A missing lockfile is skipped. It fails on every known vulnerability, as ADR-0029
  already does for a changed lockfile.
- **ADR-0029** is updated in place, with an `Updated: 2026-11-07 — spec 368` line:
  - *Decision:* `osv` is a manual check that scans every lockfile whole.
  - *Considered Options:* "Scan on every run" is now rejected only for automatic runs.
  - *`## Rails` bullet:* `No lockfile carries a package with a known vulnerability (OSV). check:osv`.
- **ADR-0025** Decision 1 gains: a check declared `manual` runs only when the human starts it.

## Edge Cases

- **Never run.** The row shows muted `manual` with no colour, and its rule shows `manual · not run`.
- **`manual` removed.** The check runs in Rails runs again, and its row reads runs. Its old file is
  ignored, not deleted.
- **`manual` added.** Trust becomes `changed`. After the human trusts again, the row reads only
  `checks/<name>.json`; an earlier run's result is not shown as its manual result.
- **Check renamed or removed.** Its file is ignored.
- **Clean tree.** A manual check still runs, because it does not depend on the diff.
- **A lane writes during a manual check.** No stale mark; the row says when the check ran.
- **Another harness on the same root.** It gets `busy` and records nothing. Each view re-reads
  `rails_check_runs` at mount and after its own runs and checks, so a result from another view
  appears after that.
- **View disposed, or `#rails off`, mid-check.** `rails_cancel(root)`; nothing is recorded.
- **The result cannot be written.** The row still shows it; the head's state line says
  `check <name> result not saved: <error>`.
- **Untrusted.** `RUN` is disabled; `#rails check` says `rails: not trusted — #rails trust`, and Rust
  refuses anyway.
- **Mode.** Allowed in harness mode `manual` and `auto`, refused in `off`.
- **Older Krypton** reading `manual = true`: a warning, and the check runs automatically.
- **Amendment A.** An old result is sent with its date (the row shows `MM-DD`). A rerun takes the
  check out of the Send set while it runs; a new `fail` has a new `finishedAt`, so Send shows idle.
  Trust does not gate Send, which runs nothing.

## Open Questions

None. These choices are deliberate, and each can be flipped before approval:

1. A manual result never colours the tab badge or the footer and never changes a run's verdict
   (GitLab's optional manual job). The alternative, `RAILS ✗ osv` until it passes, would keep the
   footer red while any lockfile carries an advisory: 185 groups today.
2. `osv` fails on every known vulnerability, not only high and critical; ADR-0029 is unchanged on
   that.
3. The dock has no stop key for a running check. `#rails off` cancels it, as it cancels a run.
4. Amendment A: a failed result rides every Send-all while it fails, rather than once per result.

## Out of Scope

- Stopping a running check from the dock with a key or a button.
- Running an auto check alone.
- `#rails send <name>`: Send paths take no argument (spec 344); `s` on the row sends one check.
- A manual result's output in the envelope (see Send), and an `error` or `pass` result in Send.
- A run with a failed auto check but no open finding in Send-all (spec 337, unchanged).
- A "tree changed since" mark on a manual result.
- Running manual checks on a schedule or in CI.
- A severity threshold for `osv`.

## Resources

- [Control how jobs run — GitLab Docs](https://docs.gitlab.com/ci/jobs/job_control/): `when: manual`, optional vs blocking manual jobs, Run (▶) beside the job, shown as skipped until run.
- [Confining hooks to run at certain stages — pre-commit](https://github.com/pre-commit/pre-commit.com/blob/main/sections/advanced.md): the `manual` stage, run only by `pre-commit run --hook-stage manual [hookid]`.
- [Common definitions — Bazel](https://bazel.build/reference/be/common-definitions): the `manual` tag leaves a target out of wildcard expansion.
- [Copilot users can ask about a failed Actions job (GA) — GitHub Changelog](https://github.blog/changelog/2025-01-15-copilot-users-can-ask-about-a-failed-actions-job-ga): Explain Error on the job page and in the merge box; one job at a time.
- [Ask GitLab Duo Chat — GitLab Docs](https://docs.gitlab.com/user/gitlab_duo_chat/examples/): Troubleshoot failed CI/CD jobs with Root Cause Analysis, from the job log or the MR Pipelines tab, over the last 100 000 characters of the log.
