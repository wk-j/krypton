# OMP Async Bash Monitor — Implementation Spec

> Status: Paused — current user instruction forbids editing third-party apps; Krypton-only scope
> Date: 2026-11-14
> Milestone: ACP Harness
> Builds on: [305](./0305-background-task-monitor.md), [370](./0370-harness-omp-background-jobs.md), [380](./0380-acp-lane-adapters.md), [384](./0384-visible-background-task-strip.md), [397](./0397-active-background-task-strip.md)

## Current scope override

The user subsequently instructed: “Not not try to edit third party app”. Stop all OMP edits,
dependency/tool installation and third-party build work. Only Krypton is in scope now.
The Solution and Design sections below retain the earlier cross-repository proposal as history,
not current authorization. Existing OMP source changes are not installed and are left untouched;
removing them would require an explicit cleanup instruction. Krypton's current integration depends
on the unshipped extension and is not a finished Krypton-only solution. With stock OMP's idle event
gap, the UI must not claim either continued execution or completion without fresh evidence.

## Problem

OMP `bash` with `async: true` starts real background work, but the composer `BACKGROUND` strip stays empty. Capturing the launch alone would leave a false `RUNNING` row after the command finishes while the lane is idle: OMP 18.20.0 does not forward those tool updates outside an active prompt.

## Original solution (superseded scope)

Support the complete lifecycle, including idle completion, through a small read-only OMP ACP extension and Krypton's existing shared metrics cadence. Register explicit async and auto-backgrounded Bash jobs from structured adapter data, then query the owning OMP process for their state without sending a prompt or consuming their results. Reuse the existing strip, lane-head count, Lane Metrics and `#bg`; never repaint the completed launch row.

This is one cross-repository feature. The extension is absent from stock OMP 18.20.0; both sides are implemented in local source, with OMP runtime verification still pending prerequisites. A Krypton-only launch indicator is not completion of this feature.

## Research

- Live probe of installed `omp/18.20.0`, using `terminal: false`, launched `printf ACP_BG_START; sleep 20; printf ACP_BG_END` with `async: true`, `pty: false`, `timeout: 40`. The launch returned at 2.16 s with `details.async: {state: "running", jobId: "bg_1", type: "bash"}`. Subsequent updates carried output while the prompt remained open. The prompt ended at 3.08 s; no tool frame arrived during the following 24 s, covering the command's expected completion. This establishes the notification gap, not an observed exit status.
- Pinned OMP v18.20.0 source confirms `AcpAgent.#finishPrompt()` unsubscribes its prompt event listener. Lifetime forwarding covers compaction and model/thinking changes, not jobs. `extMethod()` has no job-inspection method.
- OMP `BashTool.#startManagedBashJob()` already owns a job ID, full command, owner ID, live process IDs, progress text, final state and result metadata. Job-manager state is authoritative; no private output-file layout is needed. Foreground auto-background candidates remain hidden until promoted.
- OMP job records can be evicted after consumption. Missing records therefore mean unavailable, not success. Its manager must remain the owner of delivery and retention.
- Krypton's `parseOmpJobs()` already accepts Bash jobs in `wait` snapshots, but the composer registry is fed only by Claude launches. The current file reader and no-process heuristic cannot be applied to an OMP in-process shell.
- `AcpClient` and the Rust ACP transport already support dedicated extension requests for steering. Use the same transport, not a second HTTP listener, a subprocess inspector, or an injected agent prompt.

## Prior Art

| Surface | Behavior | Decision |
| --- | --- | --- |
| OMP Bash / job manager | Structured job identity, progress and settlement; `proc://` inspection does not consume delivery. | Expose that same authority to the ACP host. |
| OMP `wait` | Structured `details.jobs[]` snapshots, including Bash jobs. | Fold matching Bash states into the same registry; do not require the agent to call `wait`. |
| Claude Code / Krypton 384 | Background work remains visible beside the prompt after the launch turn ends. | Preserve the existing strip's placement and active-only presentation. |

Krypton adds passive host-side observation. It adds no job controls, shortcut, alternate terminal, or autonomous agent turn.

## Affected Files

| Repository / files | Change |
| --- | --- |
| OMP `packages/coding-agent/src/modes/acp/acp-agent.ts` and its existing tests | Advertise and implement the scoped snapshot extension, usable while idle. |
| OMP `packages/coding-agent/src/async/job-manager.ts`, `src/tools/bash.ts` | Retain the launching tool-call ID on Bash job records, for exact identity across ID reuse. |
| Krypton `src-tauri/src/acp.rs`, `src-tauri/src/lib.rs` | Preserve the capability; add a dedicated, bounded request command using the owning transport. |
| `src/acp/types.ts`, `src/acp/client.ts`, `src/acp/adapters/{types,generic,decoder,omp-background}.ts` | Carry capability and decode structured launch, update and snapshot data independently of tool retention, before wire compaction. |
| `src/acp/harness-view-types.ts`, `src/acp/harness-background-tasks.ts`, `src/acp/acp-harness-view.ts` | Source-aware task registry, snapshot folding, shared polling, lifecycle cleanup and existing detail projections. |
| `src/acp/components/background-tasks/index.ts` and relevant component tests | Honest OMP terminal/unavailable labels and optional file-only facts; reuse strip layout unchanged. |
| Relevant decoder, registry, transport and harness integration tests | Consumer-visible lifecycle and isolation regressions. |
| `docs/{0004,0005,0069,0302,0305,0370,0384,0397}-*.md`, `docs/README.md`, OMP ACP documentation | Document amended scope, protocol dependency and verified behavior. |

## Design

### Proposed OMP ACP API

Advertise top-level `initialize._meta.omp.backgroundJobs = {version: 1, snapshot: true}`. Do not infer support from a version string or from `async: true` being accepted.

```ts
// Proposed extension request; IDs are opaque, never filesystem paths.
_omp/jobs/snapshot({
  sessionId: string,
  jobs: readonly { id: string; toolCallId: string }[], // maximum 20
}) => {
  jobs: readonly {
    id: string;
    toolCallId: string;
    state: 'running' | 'completed' | 'failed' | 'cancelled' | 'unavailable';
    startedAt: number | null; // epoch milliseconds; null only when unavailable
    endedAt: number | null;
    exitCode: number | null;
    pid: number | null;
    lastLine: string; // sanitized plain text, at most 200 characters
  }[];
}
```

Resolve `sessionId` through the connection's existing managed-session lookup. Select only backgrounded Bash jobs owned by that session's root agent, matching both job ID and launching tool-call ID. Validate the entire request before querying. Reject invalid IDs/types or more than 20 entries as invalid params. Return one entry per requested identity; absent, evicted, mismatched or foreign jobs return `unavailable`, with null metadata and empty output. Never reveal a foreign job's existence.

Retain `toolCallId` in the job's registration metadata; a reused `bg_1` must not satisfy an earlier launch's query. Exclude still-foreground candidates. Read state directly without calling `wait`, acknowledging delivery, extending retention, starting model work, changing approval policy, or cancelling jobs. A running PID is the first current OS process ID when one exists, otherwise null; an embedded virtual PID is never presented as an OS PID. Derive the tail from progress/final text, strip terminal controls, and do not return raw result bodies, trace data or images. Never invent an exit code from missing metadata.

### Krypton transport and adapter boundary

Add `acp_omp_background_job_status(session, jobs)` with a 2 s request deadline. Rust obtains the protocol session ID from that exact client; it rejects non-OMP transports or absent capability before sending. Do not accept an arbitrary method, backend, host path or protocol session ID from the frontend. The existing local/remote ACP transport carries the request to wherever the owning OMP process runs.

`AcpClient` decodes replies through the OMP adapter into canonical task updates. Neither the view nor components inspect `rawOutput`. Launch capture requires validated `details.async.type === 'bash'`, nonempty `jobId`, a known launching tool call and its command. The `async` input flag or matching prose alone is insufficient. The same path handles auto-background promotion; a normal foreground Bash result registers nothing. Extract progress before display trimming, preferring the result's own text blocks rather than command echoes accumulated in ACP `content`.

### Registry and lifecycle

Give each task an observation source: `{kind: 'claude-output', outputPath}` or `{kind: 'omp-job', toolCallId}`. Remove the unconditional `outputPath` requirement and migrate all existing consumers; do not use a fabricated path. Preserve current Claude behavior. Keep common command/timing/output/PID fields, with unavailable byte counts represented as null rather than `0 B`.

Map OMP `running` to `running`, `completed` to `exited`, `failed` to a distinct `failed` state, `cancelled` to `cancelled`, and `unavailable` to `unknown`. A completed OMP task without exit metadata reads `completed`, not `exit 0` or `exit ?`. Keep failures without exit metadata distinguishable from cancellation. Terminal states are sticky for a launch identity, so late running frames cannot reopen them. A later authoritative snapshot may recover `unknown` to running or terminal. Existing Claude file/process heuristics run only for `claude-output` tasks.

1. Decode the launch and register once per lane + transport epoch + tool-call ID + job ID. Patch only the composer strip and task chrome immediately.
2. On the existing shared 2 s metrics cycle, query each capable OMP lane with unresolved jobs, including idle lanes. Batch at most 20 identities per request; if more live jobs exist, cover all batches in that cycle rather than dropping them. Permit only one snapshot refresh per lane at a time. No separate interval.
3. Fold matching direct tool updates and `wait` snapshots while a turn is open. An absent job in a `wait` snapshot means nothing. Once registered, tasks survive transcript eviction; later updates for that known launch may update the registry without reconstructing a transcript row.
4. A terminal snapshot removes the running strip row and updates retained detail state even while idle. Keep completed jobs subject to the existing bounded-history policy. Stop querying terminal jobs.
5. On snapshot timeout, malformed reply or disconnect, mark unresolved OMP observations `unknown`, clear advisory PID/resource data and hide them from the active-only strip. Lane Metrics and `#bg` say `status unavailable`, not `output gone` or `completed`. Keep querying unresolved identities on later shared cycles while the same transport exists.
6. Reject in-flight results after lane/session reset, transport replacement or disposal using the existing epoch pattern. Clear the registry on those lifecycle transitions. Never infer termination from turn end or a missing process-tree match.

An OMP version without the capability must not display a launch-only perpetual `RUNNING` row: show a single per-lane system notice when an async Bash launch is seen, explaining that this OMP lacks background status support. Generic tool output and `wait` cards continue to work. This compatibility behavior is not acceptance of the full feature; end-to-end acceptance requires the updated OMP.

### UI, keyboard and configuration

Reuse spec 397 unchanged: only running tasks, maximum three visible newest-first, overflow hint, known PID only, command and latest output, no clock or extra head line. Keep draft/decision, Zen and concise placement, existing material tokens and responsive layout. Detail surfaces use the source-aware facts above. No new controls, keybindings, configuration or persistent storage. `#bg` and Lane Metrics remain the keyboard paths for history and unavailable status.

## Verification

- OMP protocol tests: an idle session returns live and settled states without model calls or result consumption; owner/session isolation, ID reuse, foreground exclusion, malformed requests, caps and eviction are deterministic.
- Krypton adapter/registry regressions: real captured launch shape, auto-background, output placement, success/failure/cancellation, missing exit code, duplicate frames, stale running frames and opaque IDs. Claude launch/file behavior remains covered.
- Harness integration: the turn ends while a Bash job runs; a later snapshot settles it, removes the strip row and retains detail history. Assert no mutations in a sealed transcript row, preserved draft node/text/focus and unchanged scroll position. Cover lane switching, reset during a request, disconnect/recovery, unknown capability and batches beyond 20.
- Live updated OMP ACP probe: launch harmless commands that succeed and fail after the prompt ends, then observe their terminal snapshots while idle. Confirm snapshot requests do not consume the async result delivered to the next agent turn. Exercise cancellation through OMP's existing control path, not a new Krypton action.
- Browser smoke with production decoder/composer/detail components at 320px and wide widths, dark/light, draft/decision: show running, output/PID changes, terminal removal and unavailable detail. Verify equal observations write no DOM.
- Native Krypton proof requires the running app to load the implementation and an OMP build advertising this extension. Do not claim native proof from a decoder or browser reproduction alone. Run only focused checks after implementation.

### Current verification

- Krypton `npm run check` passes; nine focused frontend suites pass (151 tests), including idle settlement, sealed launch-row protection, draft/focus/scroll preservation, unsupported capability, status recovery, reset races and batches beyond 20.
- Rust `omp_background_job_tests` passes (3 tests), covering capability identity, backend/session isolation and bounded requests.
- OMP tests in the 16.3.11 checkout stop at module loading because its dependencies/native addon are absent; no OMP protocol or live updated-runtime pass is claimed from that attempt.
- Following the user's checkout request, a separate stock v18.20.0 checkout was created at `/Users/wk/Source/oh-my-pi-18.20.0` and the extension was implemented there too, preserving the 16.3.11 work. All seven changed TypeScript source/test files parse without syntax errors. This is not an OMP type-check or runtime pass. That checkout requires Bun ≥1.4.4; the available standalone Bun is 1.3.14.
- No existing browser surface was available: Tern is not attached, terminal-browser lists no sessions, and the Chrome relay target query timed out. Native apps and the installed OMP binary have not been replaced or restarted.

## Open Questions

The Krypton-only representation of unconfirmed idle job status remains undecided. Stock OMP 18.20.0 does not expose the proposed API; no further third-party edits or installation are authorized. Existing source changes remain in `/Users/wk/Source/oh-my-pi` and `/Users/wk/Source/oh-my-pi-18.20.0`; neither replaces the installed binary. The original idle-runtime acceptance has not passed and is not waived.

## Out of Scope

Named `bash` services, async `eval`, subagent-card lifecycle changes, job control UI, a full log viewer, completion notifications, result-delivery changes, auto-prompting, app-restart recovery, parsing assistant narration, scanning private OMP files, a new timer, and enabling ACP terminals. Under the current scope override, third-party edits, third-party dependency/tool setup and the original cross-repository implementation are also out of scope.

## Resources

- [OMP v18.20.0 ACP agent](https://github.com/can1357/oh-my-pi/blob/v18.20.0/packages/coding-agent/src/modes/acp/acp-agent.ts) — subscription lifetime and extension dispatch.
- [OMP v18.20.0 Bash tool](https://github.com/can1357/oh-my-pi/blob/v18.20.0/packages/coding-agent/src/tools/bash.ts) — launch/update data, background promotion, command and process metadata.
- [OMP v18.20.0 job manager](https://github.com/can1357/oh-my-pi/blob/v18.20.0/packages/coding-agent/src/async/job-manager.ts) — ownership, progress, retention and process identity.
- [OMP v18.20.0 job snapshots](https://github.com/can1357/oh-my-pi/blob/v18.20.0/packages/coding-agent/src/async/job-control.ts) — read-model and owner-scope precedent.
- [OMP Bash documentation](https://github.com/can1357/oh-my-pi/blob/main/docs/tools/bash.md) — user-facing async and inspection behavior; pinned source governs version-specific claims.
- [OMP ACP async issue #1324](https://github.com/can1357/oh-my-pi/issues/1324) — distinction between background creation and post-prompt lifecycle.
- Internal specs linked above and the live 18.20.0 probe described in Research.
