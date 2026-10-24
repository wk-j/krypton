# Harness E2E Browser Explorer — Implementation Spec

> Status: Implemented
> Date: 2026-10-24
> Milestone: ACP Harness — e2e
> Builds on: 0328 (`#e2e` commands, `src-tauri/src/e2e.rs`) · 0227 (per-cwd capability page, Hurl) · 0198/0288 (capability-token tier) · 0316 timeline page (refresh-on-focus) · `DESIGN.binance.md`
> Prerequisite: the 0328 implementation. This spec edits those files; 0328 and 0329 were committed together in `0e00bea`.

## Problem

User, 2026-10-24: "I want loopback UI in browser to explore test in project and the test result". `#e2e status` prints a fixed table in the transcript. It shows the last 10 runs of one case and only the failed checks of the newest run. You cannot browse every case's history, read a passing run's checks, open a run's log, or look at the evidence files an adapter lists in `artifacts`. Rust validates those files and then drops them (`e2e.rs:510-525`).

Spec 0328 rev 4 removed every UI ("I think we no need any UI, we should minimal it by control everything with build-in command (#)"). This spec amends 0328 for the browser only:
- control stays in `#` commands;
- the new page reads and never runs a test;
- there is still no in-app view, panel, keybinding or palette entry.

## Solution

A read-only page served by the existing loopback server and opened by a new `#e2e open [<case>]`. It shows:
- every case with its latest verdict and a strip of recent verdicts;
- every run of the selected case;
- the full Result of the selected run: all checks, versions, params and message;
- the Krypton log for that run;
- the adapter's `artifacts`, as text, as images, or as a download.

Logs and evidence are content, not metadata. So the page uses the capability-token tier (0198/0288), with one 128-bit token per project root. It follows the Hurl web client (0227), not the tokenless timeline. Data comes from the same `gather()` that `#e2e status` uses. The page never spawns `run`. It does not poll the adapter: it reloads on focus and on `r`, and while a launch is active it polls only a cheap in-memory endpoint.

## Research

- **Data already exists** (`e2e.rs`, 0328 as built). `gather()` (`:1588`) returns `E2eStatus`: cases with hash and uncommitted marks, merged Krypton and ext runs, issues and `activeLaunch`. It is private. Krypton runs keep `runs/<launchId>/{result.json,log}`. Ext Results live only in memory (`Gathered.ext_raw`). `find_run` writes them to disk, so the page must not use it.
- **Cost.** Every `gather` spawns adapter `list`, then `history` (60 s timeout each), runs `git status`, re-hashes the case files, and runs `gh` when `issue_label` is set. Nothing is cached. A 1 s poll like the dashboard's would spawn adapters every second.
- **Two tiers on the loopback server.** Metadata pages are tokenless (ADR-0010: dashboard, gallery, docs, timeline). Content pages use a process-lifetime token in the path, and an unknown token gets a bare `404`: termctrl (0198), acp-wire (0288) and Hurl (0227). Hurl binds a token to a canonical cwd (`HurlWebSessions::issue`, `hurl.rs:194`) and reuses it for that cwd until exit. e2e logs and adapter evidence can hold API responses from the system under test, so they belong in the content tier.
- **Page conventions.**
  - One self-contained `src/acp/artifact-*.html` embedded with `include_str!` and served by `html_response`.
  - JSON goes through `secured_json_response` (no-store, nosniff, no-referrer).
  - Rendering uses `textContent` only. Keys: `/`, `j`/`k`, `r`, `Esc`.
  - The timeline page refreshes on `focus`/`visibilitychange` instead of a timer. Its test asserts there is no `setInterval(`.
  - A new route goes into both the real and the test router (`hook_server.rs:10056`, `:11206`).
- **Openers.** `#timeline open` → `get_hook_server_port` + `open_url` (`harness-timeline-controller.ts:61`). `#hurl` → `get_hurl_web_url(cwd)`. `#e2e` already reaches `HarnessE2eController` with `host.projectDir` as `root`.
- **Alternatives rejected.**
  1. **Tokenless with `?harness=`** like the timeline: it would expose logs and evidence to anything that can reach loopback, with no capability. Bookmarks are not worth that.
  2. **Run/cancel buttons:** they need a write channel and bring back 0328's trust question ("nothing runs when a view opens"). `#e2e run <case>` is one line. The page shows that command and copies it with `y`.
  3. **Reading ext results through `find_run`:** it writes `runs/ext-*`. A per-root in-memory cache of the last `history` output avoids the write and avoids a second spawn.
  4. **Rendering an HTML artifact** (e.g. a Playwright report): it would run project-authored script on the loopback origin. It is served as `text/plain` with `CSP: sandbox`.

## Prior Art

| Tool | Implementation | Notes |
|---|---|---|
| Playwright HTML reporter | Self-contained report, `npx playwright show-report` serves it on localhost. You can filter by passed, failed, flaky or skipped, and search. A test opens attachments and a trace | One run only; history needs a CI service |
| Vitest UI (`vitest --ui`) | A browser UI for exploring results, live while tests run, or as a static HTML report. It has a module-graph tab | A live dev server, tied to Vitest |
| Allure Report | Links runs of the same test by history ID, with a History tab per test, Retries, and trend charts. Allure 3 keeps a `history.jsonl` | Closest to "every run of one case" |
| Krypton loopback pages | termctrl/acp-wire/Hurl (token in the path, read views), timeline (refresh on focus) | Same server, same shell |

**Krypton delta.** Like Allure, runs are grouped per case across launches, and both the Krypton ledger and the adapter's own history are merged. Like Playwright, filters and a failures-only view are one key away. Unlike all three, it is runner-agnostic (any adapter under Contract v1), read-only, keyboard-first, and opened from the harness with `#e2e open`. No trend charts (0328 Out of Scope).

## Affected Files

| File | Change |
|---|---|
| `src-tauri/src/e2e.rs` | `pub(crate) async fn status`; a history cache in `E2eState`; `run_detail`, `launch_log`, `run_artifact` |
| `src-tauri/src/e2e_web.rs` | **New.** `E2eWebSessions`, the six routes with their own router and state, handlers, `E2E_HTML` |
| `src-tauri/src/hook_server.rs` | `HookServer.e2e_web` + `e2e_web_url`; `start()` merges `e2e_web::router`; `html_response` / `secured_json_response` become `pub(crate)`; the route-conflict test merges the router |
| `src-tauri/src/commands.rs`, `src-tauri/src/lib.rs` | `get_e2e_web_url(root)` registered |
| `src/acp/artifact-e2e.html` | **New** page |
| `src/acp/e2e-command.ts`, `src/acp/harness-e2e-controller.ts`, `src/acp/hash-commands.ts` | `#e2e open [<case>]` |
| Tests | `e2e.rs` and `e2e_web.rs` unit tests (routes over real HTTP); `e2e-command.test.ts`, `harness-e2e-controller.test.ts`, new `artifact-e2e.test.ts` (happy-dom runs the page script) |
| Docs | this spec; 0328 (status note, Out of Scope); 0004, 0005, `DESIGN.binance.md` (`appliesTo` + surfaces), `docs/README.md`, `e2e/README.md` |

## Design

### Rust

```rust
// e2e.rs
pub struct E2eState {
    active: Mutex<HashMap<PathBuf, Active>>,
    /// Last validated `history` Results per root, replaced by every gather (read by the page only).
    history: Mutex<HashMap<PathBuf, HashMap<(String, String), Value>>>,
}
pub(crate) async fn status(state: &E2eState, root: &Path, include_issues: bool) -> E2eStatus;
pub(crate) fn run_detail(state: &E2eState, root: &Path, case_id: &str, run_id: &str) -> Result<E2eRunDetail, String>;
pub(crate) fn launch_log(root: &Path, launch_id: &str) -> Result<Vec<u8>, String>;
pub(crate) fn run_artifact(state: &E2eState, root: &Path, case_id: &str, run_id: &str, index: usize)
    -> Result<(PathBuf, Vec<u8>), String>;

#[serde(rename_all = "camelCase")]
pub struct E2eRunDetail {
    pub info: E2eRunInfo,            // the same row `status` returns
    pub result: Option<Value>,       // the full validated Result, or None (INTERRUPTED, NO RESULT…)
    pub log: bool,                   // a Krypton log exists for this launch
    pub artifacts: Vec<E2eArtifactInfo>,
}
pub struct E2eArtifactInfo { pub label: String, pub path: String, pub size: Option<u64>, pub problem: Option<String> }
```

- `run_detail` finds a Krypton run through the ledger (`caseId` + `runId`) and reads `runs/<launchId>/result.json`. It finds an ext run in the history cache. On a cache miss it returns `not_found`, and the page reloads status once.
- `launch_log` accepts only a `launchId` that is present in the ledger. The path is built from `runs_dir`, never from request text.
- `run_artifact` takes `artifacts[index].path` from that run's Result. It must pass `is_relative_clean`, canonicalize, `strip_prefix(canonical root)` (so symlinks cannot escape), be a regular file, and be at most 25 MiB, which matches `/review-asset`.
- The Tauri command `e2e_status` calls `status` too, so `#e2e status` fills the same cache.

```rust
// e2e_web.rs
pub struct E2eWebSessions { by_root: Mutex<HashMap<PathBuf, String>>, by_token: Mutex<HashMap<String, PathBuf>> }
impl E2eWebSessions { pub fn issue(&self, root: &str) -> Result<String, String>; pub fn root(&self, token: &str) -> Option<PathBuf> }
```
`issue` canonicalizes the root, requires a directory, and reuses one `capability_token()` per root until Krypton exits (as in `HurlWebSessions`).

### Routes

| Route | Response |
|---|---|
| `GET /e2e/{token}` | `html_response(E2E_HTML)` |
| `GET /e2e/api/{token}/status` | `E2eStatus` plus `projectName` (the root's folder name). Issues are included when `issue_label` is set |
| `GET /e2e/api/{token}/active` | `{ activeLaunch }` from `E2eState` only, with no spawn |
| `GET /e2e/api/{token}/run?case=&run=` | `E2eRunDetail` |
| `GET /e2e/api/{token}/log?launch=` | `text/plain; charset=utf-8` (already capped at 5 MB on write) |
| `GET /e2e/api/{token}/artifact?case=&run=&index=` | Bytes. Images (`png jpg jpeg gif webp`) get their image type. `json txt log md csv xml yaml yml html svg` get `text/plain`. Anything else is `application/octet-stream` + `attachment` |

- Every route: an unknown token gives a bare `404`; errors starting with `not_found:` → `404`; anything else → `400 {"error"}`.
- JSON uses `secured_json_response`. Logs and artifacts add `nosniff`, `no-store` and `Content-Security-Policy: sandbox`.

### Opening

1. `#e2e open [<case>]` → `parseE2eCommand` → `{ kind: 'open', caseId? }`.
2. `HarnessE2eController.openBrowser(caseId)` → `invoke('get_e2e_web_url', { root })` → `http://127.0.0.1:<port>/e2e/<token>`. If the server is down, `SERVER_UNAVAILABLE` → `flashChip`.
3. Append `#case=<id>` when a case was given, then `invoke('open_url', { url })` and `flashChip(url)`.
4. The page reads its selection from the URL hash (`case`, `run`) and writes it back, so a reload keeps it.

`#e2e open` works on an uninitialized project too; the page then says `not initialized — #e2e init`. Remote harnesses already reject `#e2e`.

### Page (`artifact-e2e.html`)

Fixed dark (a status wall, like acp-wire), 1400 px split shell, Binance tokens.

- **Header:** `KRYPTON // E2E`, manifest name, project folder, the `running <case> since …` chip (green `.dot.live`), a filter box, and the load time.
- **Errors:** `status.errors` as `.chip.alert` lines (manifest, `list`/`history` stderr tail, `gh`).
- **Cases** (left): the latest verdict pill, `id`, `code`, title, `#issue`, marks (`edited`, `uncommitted`, `unreported`, using 0328's rules), and the last 10 verdict letters (`P F B E C !`).
- **Case pane** (right, top):
  - title, files, declared `params`/`fresh`, and the command `#e2e run <id>` (`y` copies it);
  - a runs table with verdict, runId, origin (`krypton`/`ext`), start, duration, pass/fail counts, `sha*`/branch and versions.
- **Run pane** (right, bottom):
  - message, then every check grouped by `group`, with status chips; `f` toggles failures only;
  - artifacts (label, path, size or problem). Enter on one opens it: text in a `<pre>`, images inline, other types download;
  - `l` loads the Krypton log into a `<pre>`;
  - INTERRUPTED, NO RESULT and INVALID RESULT runs show their message and the log.
- **Keys:**
  - `/` filter cases; `j`/`k` move in the focused list; `Tab`/`Shift+Tab` cycle cases → runs → checks/artifacts; `Enter` open;
  - `f` failures only; `l` log; `y` copy the run command; `r` reload;
  - `Esc` closes the viewer, then clears the filter.
- **Selection:** the list highlight moves at once. The case and run panes keep the previous selection until `/run` answers, then both render in one task, so a switch never paints an empty pane or moves the page scroll. `loading run…` shows only when the answer takes longer than 250 ms (`LOADING_DELAY_MS`).
- **Refresh:**
  - no adapter polling;
  - full `status` on load, on `r`, and on `focus`/`visibilitychange` when ≥ 10 s have passed since the last load;
  - while `activeLaunch` is set and the tab is visible, `/active` every 2 s (a `setTimeout` chain, one request in flight); when the launch changes or ends, one full reload.
- **Footer:** `read-only · refreshes on focus · run with #e2e run <case>`.

## Edge Cases

- **Krypton restarted:** the old token gives `404`. Run `#e2e open` again.
- **Not initialized or invalid manifest:** empty state with `#e2e init`, or the validator errors.
- **`list`/`history` time out (60 s):** errors banner; Krypton runs still show (0328 behaviour). The first paint waits for `gather`, so a loading line shows meanwhile.
- **Ext run missing from the cache:** the page's own status load fills the cache, so a miss means a later `gather` no longer saw that run (the adapter pruned its history). `run` returns `404`; the page reloads status once, and the run drops out of the list.
- **Artifact missing, too large, absolute, `..`, or a symlink escaping the root:** listed with `problem`; the endpoint returns `404`/`413`/`400`.
- **Huge Results** (hundreds of checks): rendered once per selection; groups collapse.
- **Two harnesses on one project:** same token (keyed by canonical root).
- **The same run reported by `run` and `history`:** shown once (0328 dedupe keeps the Krypton record).
- **Secrets:** the page shows only what adapters wrote. Contract v1 already forbids secret values in Results and logs.

## Out of Scope

- Running, cancelling or re-running from the browser; any POST route.
- Live log streaming (`tail -f` works). Trend charts. Rendering HTML reports.
- An in-app view, panel, keybinding or palette entry (0328 still holds).
- Remote harnesses; editing cases; `#e2e report` from the page.

## Open Questions

None. Three decisions are made above: token tier, read-only, and the `/active` poll.

## Verification Plan

- **Rust.**
  - `get_e2e_web_url` is capability-gated and stable per root.
  - Unknown token → `404`.
  - `run_artifact` rejects `..`, absolute paths, symlink escape and size > cap.
  - `launch_log` rejects ids not in the ledger.
  - `run_detail` for a Krypton run and an ext run (temp project with a ledger and result files).
  - The route-conflict router is updated.
  - `E2E_HTML` string checks: `textContent`, no `method: 'POST'`, no `setInterval(`, no `border-left:`, no `backdrop-filter`.
- **TS.**
  - The parser accepts `open` and `open <case>`.
  - The controller calls `open_url` with `/e2e/<token>#case=…`.
  - The page's inline script parses (`new Function`).
- **Smoke.**
  - In this repo, `#e2e run all`, then `#e2e open`. In Chromium, check both cases, a run's 24 checks, an artifact `responses/*.json`, the log, `f`, `/` and `y`.
  - Stop Krypton: the old URL gives `404`.

## Implementation Notes

Where the shipped code differs from the draft, and why:

- **Own module and router.** The draft put the routes into `hook_server.rs`. They live in `e2e_web.rs` with their own state (`E2eWebSessions` + `Arc<E2eState>`). `hook_server::start` merges that router after `with_state`. The handlers need no `AppHandle`, so a test serves the real router on an ephemeral port and drives it with `reqwest`. The duplicate route-conflict router merges the same router.
- **Behaviour tests for the page, not string checks.** `artifact-e2e.test.ts` runs the real inline script in happy-dom against a mocked API. It checks that:
  - project text renders as text, never as markup;
  - the URL hash selects a case and run, and stays in sync;
  - `f` filters the checks;
  - an expired token shows the reopen hint;
  - every request is a GET;
  - during a run only `/active` is polled, and one full reload follows the end;
  - a switch keeps the shown case and run until `/run` answers, then swaps both; `loading run…` appears only after 250 ms.
- **Marks are computed twice.** The page has no module imports, so it repeats `e2eCaseMarks` (0328) as `marksOf`. A change to the mark rules must update both.
- **No loading frame on a switch.** The first build emptied the run pane to `loading run…` on every selection and rendered the new case pane at once. Even a 1 ms `/run` painted that frame: in Chromium the detail column dropped from 1547 px to 718 px for one or two frames and the page scroll jumped, which read as a flash on every `j`/`k`. `selectRun` now holds the pending case pane and paints it with the run pane, and clears `detail` while a request is in flight so `l` and artifacts cannot open the old run's files under the new run id.
- **`active_launch`** on `E2eState` became `pub(crate)` for the `/active` route.

**Verified:**

- `cargo test --workspace`: 559 lib tests pass. The new tests cover `run_detail` (a Krypton run, a launch with no Result, an ext run through the cache), `resolve_artifact` (absolute path, `..`, directory, missing, symlink escape, 25 MiB edge and +1), `launch_log`, and the routes (`404` with an empty body for a forged token on all six, CSP/nosniff headers, `text/plain` for HTML evidence, download for a binary, `405` on POST).
- `cargo clippy --all-targets -D warnings` is clean except one lint in code this work did not touch: `bool_assert_comparison` at `timeline.rs:3225`, from the new toolchain.
- `npx vitest run`: 231 files and 2931 tests pass. `npm run check` exits 0.
- **Chromium smoke.** A throwaway server (since removed) served this repo after a real `run_case` of `loopback-api-authorization`, which gave PASS with launch `20261024T020217Z`. Observed:
  - both cases, with verdict strips `P` and `PP`;
  - the Krypton run row showing `877ce433* master`;
  - 24 checks;
  - `l` loaded the log, which does not contain the token;
  - `Tab Tab j Enter` opened `responses/01-loopback-identity.json`.
- **Not exercised:** `#e2e open` → `open_url` inside a rebuilt Krypton (it needs a new build), and the "stop Krypton → 404" step (the forged-token route test covers the same response).

## Resources

- [Playwright — Reporters (HTML reporter)](https://playwright.dev/docs/test-reporters) — a self-contained report served locally, opened on failure.
- [Playwright — Trace viewer intro](https://playwright.dev/docs/trace-viewer-intro) — filters by passed, failed, flaky and skipped, plus search; a test opens a detail view.
- [Vitest UI guide](https://vitest.dev/guide/ui) — a browser UI for exploring results, live or as a static HTML report.
- [Allure Report — History and retries](https://allurereport.org/docs/history-and-retries/) — runs of one test linked across launches by history ID; the History tab.
- Internal: `docs/0328-harness-e2e-commands.md`, `docs/0227-hurl-web-client.md`, `docs/0198-termctrl-session-monitor.md`, `docs/0288-acp-wire-profiler.md`, `docs/adr/0010-docs-browser-serves-repo-markdown-over-tokenless-loopback.md`, `DESIGN.binance.md`.
