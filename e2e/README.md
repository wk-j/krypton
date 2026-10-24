# Krypton e2e

End-to-end tests that drive the **running** Krypton app over its two loopback
HTTP servers. The native WKWebView window has no WebDriver on macOS, so these
tests use the HTTP surfaces that the app exposes on loopback:

- **Control API** (`/control/v1`, `src-tauri/src/control.rs`, spec 0154/0175):
  bearer-authenticated. Each operation goes Rust → Tauri event → `src/acp/control-bridge.ts` →
  harness view → Tauri reply → HTTP, so the whole app is exercised.
- **Loopback server** (`[loopback_server]`, `src-tauri/src/hook_server.rs`):
  the browser surfaces, MCP endpoint and capability-token pages.

The runner is one TypeScript file run directly by Node (type stripping), with
no dependencies. It implements the Krypton E2E Adapter Contract v1
(`.krypton/e2e/CONTRACT.md`), so Krypton's `#e2e` commands call it directly, and
you can also run it from a terminal.

## Prerequisites (manual)

- Node.js ≥ 22.18 on your login-shell `PATH`.
- Krypton running, either `/Applications/Krypton.app` or `make dev`, with the
  control API enabled (`[acp_controller] enabled = true`, the default). The runner
  never starts the app. If the app is not running, the verdict is `BLOCKED`.

The tests target your **live** instance. Every case is read-only, or sends only
forged or missing credentials, so running a case changes nothing.

## Run

```sh
node e2e/krypton-e2e.ts list                        # cases as JSON
node e2e/krypton-e2e.ts run control-api-roundtrip   # one case
node e2e/krypton-e2e.ts run loopback-api-authorization --param loopbackPort=8765
node e2e/krypton-e2e.ts history                     # every kept run as JSON
```

From a Krypton harness: `#e2e run <case>`, `#e2e run all`, `#e2e status`.

- Each run gets a `runId` (a UTC timestamp) and an evidence folder in
  `e2e/runs/<caseId>/<runId>/`. The folder is git-ignored and holds:
  - `result.json`: the Result, in the contract's format.
  - `log.txt`: the same log the run prints.
  - `responses/NN-<step>.json`: each request (method, URL, header **names**) and
    its full response.
- When `KRYPTON_E2E_RESULT` is set, the Result is also written to that path.
- Exit codes: `0` PASS, `1` FAIL, `2` BLOCKED, `3` ERROR, `64` usage.
- Verdicts:
  - `BLOCKED`: a precondition failed and the app was never exercised. Examples:
    no descriptor, a dead pid, or a port that refuses connections.
  - `FAIL`: an expected result did not hold.
  - `ERROR`: the harness itself broke.
- Secrets: the control bearer token is read at run time from
  `~/.config/krypton/runtime/controller.json`, which has mode `0600`. It is
  redacted from every log line, capture and Result. No environment variable is
  needed.
- Loopback server port: the runner reads `[loopback_server] port` from
  `~/.config/krypton/krypton.toml` (default `8765`). If the server fell back to
  an ephemeral port, pass `--param loopbackPort=<port>`.

## Cases

| Case | What it proves |
|---|---|
| `control-api-roundtrip` | `capabilities`, Rust-side validation, then `harness.list` / `peer.list` / `lane.list` through the frontend bridge with consistent lanes, plus the SSE `ready` event |
| `loopback-api-authorization` | The control API rejects a missing, forged or scheme-less bearer. The computer routes need a live lane capability on top of the bearer. Neither server grants CORS to a foreign origin. A cross-site `text/plain` POST to `/doc-feedback` is refused. Capability routes (`termctrl`, `acp-wire`, `hurl`, `artifact`) return `404` with an empty body for an unknown token. Neither port accepts connections on a non-loopback address. |

## Adding a case

1. Create `e2e/cases/<case-id>.ts`. The file name must equal `meta.id`. Use a
   kebab-case id. A case written for a GitHub issue is named
   `issue-<N>-<slug>.ts` and sets `issue: N`.
2. Export `meta` and `execute`:

   ```ts
   import { asRecord, http, requireControl } from '../lib/target.ts';
   import type { CaseContext, CaseMeta } from '../lib/run.ts';

   export const meta: CaseMeta = {
     id: 'issue-123-lane-status',
     title: 'lane.status reports idle after a turn',
     issue: 123,
     // params: { lane: 'Claude-1' },   // declared params and defaults
     // fresh: { lane: 'new' },         // single-use data for `#e2e run --fresh`
   };

   export async function execute({ run, params }: CaseContext): Promise<void> {
     const control = await requireControl(run);           // BLOCKED when the app is down
     const reply = await http(run, 'lane-list', `${control.url}/operations`, {
       method: 'POST',
       headers: { authorization: `Bearer ${control.token}`, 'content-type': 'application/json' },
       body: JSON.stringify({ operationId: `e2e-${run.runId}-lanes`, operation: 'lane.list', params: {} }),
     });
     run.check('lanes', 'lane.list answers 200', reply.status === 200, `status ${reply.status}`);
   }
   ```

3. Rules:
   - Check preconditions first: `requireControl(run)` and `requireLoopback(run, params)`.
     If anything else the case needs is missing, call
     `run.block(group, label, detail)`. That gives `BLOCKED`, never `FAIL`.
   - Write one `run.check(group, label, ok, detail)` per expected result in the
     issue, in order. `detail` says what was observed. Use `run.info` for notes
     and `run.skip` for checks that do not apply on this machine.
   - Send every request through `http()` or `firstSseEvent()`, so its evidence
     lands in `responses/`.
   - Use a fresh `operationId` per run (`e2e-${run.runId}-…`). The frontend caches
     replies by `operationId`.
   - Cases run against the user's live app. A write-path case (`harness.create`,
     `lane.spawn`, `lane.send`) must clean up after itself (`lane.close`). It
     should take its throwaway targets from `fresh` params. Remember that
     spawning a lane costs model tokens.
   - A value passed with `--param` arrives as a string. A default keeps its
     declared type. Convert with `Number()` or `String()` before use.
4. Run it once: `node e2e/krypton-e2e.ts run <case-id>`. `list` picks the new
   file up automatically, in file-name order.
