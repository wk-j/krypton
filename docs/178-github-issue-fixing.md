# GitHub Issue Fixing — Implementation Spec

> Status: Implemented
> Date: 2026-06-27
> Milestone: M9 — Harness loopback & web control

> **Update (spec 191):** the `#fix-issue` verb below was renamed
> `#dispatch-github-issue` (a control-op that dispatches the fix to a *fresh* lane);
> `#fix-issue` is kept as a back-compat alias. Spec 191 adds a composable
> GitHub-issue verb set that runs *in the current lane* — `#analyze-github-issue`,
> `#fix-github-issue`, `#tag-github-issue`, `#post-github-comment`, and the composed
> `#handle-github-issue`. Those verbs reuse this spec's `issue_progress` + auto-bind
> plumbing but do the earlier-out-of-scope write-backs (labels, comments) directly
> via `gh`. See `docs/191-composable-verbs-github-issue-toolset.md`.

## Problem

A user has no way to hand a GitHub issue to a Krypton lane to fix, nor to see how a
fix is progressing without switching to the Krypton window. There is currently **no
GitHub integration anywhere in the codebase**. The fix should be startable **from
anywhere** — inside Krypton (keyboard-first) or from the browser — and its status
should be visible from anywhere too.

## Solution

Make "fix this issue" a single, surface-agnostic operation. One control op,
`github.dispatch-issue`, is the single convergence point; **any** surface can
trigger it, and **every** surface can read the resulting status:

1. **Dispatch from anywhere** — the same op is invoked from (a) Krypton's command
   palette / a keybinding (keyboard-first, the primary in-app path) and (b) a card
   injected on the GitHub issue page. It records an **issue↔lane binding** and
   prompts a lane to fix the issue.
2. **Status from anywhere** — bindings + live lane status are exposed via
   `github.issue-status` / `github.list-issues`. Krypton shows an issue badge on the
   bound lane; the extension injects a live status card onto the GitHub issue page,
   streamed over the existing SSE channel (`/control/v1/events`).

Issue metadata (title/body) is obtained per surface: the issue-page card scrapes
the authenticated DOM (no token); Krypton's command palette fetches via the local
`gh` CLI, falling back to letting the lane fetch it. Writing back to GitHub
(comments, labels, PR creation) is explicitly **out of scope for v1**.

## Research

- **Codebase** — Control API (`src-tauri/src/control.rs`): `POST /control/v1/operations`
  (Bearer) routes typed ops to the frontend via `control-bridge.ts`; `GET
  /control/v1/events` is an authenticated SSE stream carrying `{ harnessId, lane,
  kind, seq, payload }` frames (status, attention, message_chunk, permission_request,
  tool_call, …). Frontend is the sole state authority (ADR-0007); Rust is a dumb
  router/broadcaster, so new ops only need to be advertised in `capabilities` and
  handled in `acp-harness-view.ts::handleControlOperation`.
- Lanes already carry `status`, `goal`, `directive`, `transcript`; `lane.send`,
  `lane.spawn`, `lane.goal` ops exist and are reusable. Per-lane MCP server
  (`krypton-harness-memory`) is the seam for a lane self-report tool.
- **Extension** (`extension/`) — MV3, `background.js` holds the loopback `{url,token}`
  from the native bridge and proxies control ops; `host_permissions` already cover
  `127.0.0.1:8766`. Content extraction (spec 177) shows the pattern for reading the
  page DOM client-side. No content script currently runs on `github.com`.
- **External** — GitHub Copilot coding agent and Cursor background agents both use
  the same UX: assign/dispatch an issue, the agent works asynchronously, and status
  appears inline (PR body / issue timeline comment). Krypton's twist is a *local*
  lane plus a *live* (SSE, not polled-comment) overlay on the issue page.

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| GitHub Copilot coding agent | Assign issue to "Copilot" in the Assignees menu; optional prompt field; agent opens a PR and posts status updates into the PR body + issue timeline | Cloud, async; status is polled comments, not live |
| Cursor background agents | `@Cursor` in an issue/PR comment dispatches an agent; it pushes commits and replies with status + todos | Trigger lives in GitHub comments; status via comment |
| Devin / Sweep | Issue → autonomous PR; status via PR description + dashboard | Separate dashboard, not on-page live |

**Krypton delta** — Dispatch is initiated from the extension (no GitHub write
needed), the agent is a *local* Krypton lane the user already controls, and status
is a **live SSE overlay** on the issue page rather than after-the-fact comments.
No market equivalent overlays a local agent's live status on the GitHub issue page.

## Affected Files

| File | Change |
|------|--------|
| `src/acp/types.ts` (or where lane types live) | Add `IssueBinding`, `IssueStatusSnapshot` types |
| `src/acp/acp-harness-view.ts` | Lane carries `issueBinding`; `dispatchIssue()` shared path; handle `github.*` control ops; `getPaletteActions` "Fix GitHub Issue…" + "Open Bound Issue"; `#fix-issue` palette verb; `gh issue view` metadata fetch via `run_command`; agent-view badge; persist/restore binding; wire `issue_progress` MCP tool |
| `src/acp/control-bridge.ts` | Route `github.list-issues` (global) like `peer.list`; per-lane ops resolve by binding/harness |
| `src-tauri/src/control.rs` | Advertise `github.*` ops in `capabilities` |
| `src-tauri/src/hook_server.rs` | Add `issue_progress` MCP JSON-RPC method on the harness-memory server; disk-backed bindings store (atomic write + rehydrate on `register_harness`) |
| `src-tauri/src/lib.rs` | Register Tauri commands to save/load persisted issue bindings |
| `extension/manifest.json` | Add a `github.com/*` content script (broad match: GitHub is an SPA, so a narrow `/issues/<n>` match misses the issues-list page and never injects on soft navigation) + `scripting` for that origin |
| `extension/github-issue.js` (new) | Content script: self-gate to issue URLs, scrape title/body, inject status card, open Port to background; SPA-navigation aware (mounts/re-keys/tears down on client-side URL changes) |
| `extension/github-issue.css` (new) | Status-card styling (light/dark, no left-border rails) |
| `extension/background.js` | SSE subscription + per-tab Port relay; `dispatchIssue` + `issueStatus` control calls |
| `DESIGN.binance.md` or extension styles | Note the on-GitHub card styling rules |

## Design

### Data Structures

```ts
type IssuePhase =
  | 'investigating' | 'fixing' | 'testing'
  | 'review' | 'pr_opened' | 'done' | 'blocked';

interface IssueBinding {
  issueKey: string;       // canonical id: "owner/repo#123"
  issueUrl: string;
  repo: string;           // "owner/repo"
  number: number;
  title: string;          // scraped from the page DOM
  harnessId: string;
  laneId: string;
  laneDisplayName: string;
  dispatchedAt: number;   // epoch ms
  // optional rich status, set only by the lane via issue_progress:
  phase?: IssuePhase;
  summary?: string;       // one-line, lane-authored
  prUrl?: string;
  updatedAt: number;
}

interface IssueStatusSnapshot {
  bound: boolean;
  binding?: IssueBinding;
  laneStatus?: LaneStatus;     // idle | busy | needs_permission | error | stopped
  lastMessage?: string;        // truncated latest assistant text
  pendingPermissions?: number;
  attention?: number;          // open attention items for the lane
}
```

Bindings live on the frontend (state authority, ADR-0007), keyed by `issueKey`,
and are **persisted to disk** (see *Persistence & Browser Refresh* below) so they
survive a Krypton restart.

### API / Commands

New control operations (`POST /control/v1/operations`, Bearer):

| Operation | Params | Returns |
|-----------|--------|---------|
| `github.dispatch-issue` | `{ issueKey, issueUrl, repo, number, title, body, targetLane?, prompt? }` | `{ harnessId, lane, issueKey }` |
| `github.issue-status` | `{ issueKey }` | `IssueStatusSnapshot` |
| `github.list-issues` | `{}` | `IssueBinding[]` (global, all harnesses) |
| `github.unlink-issue` | `{ issueKey }` | `{ ok: true }` |

`targetLane` is a display name, or the sentinel `"__new__"` to spawn a dedicated
lane named `fix/#<number>`. If omitted, dispatch goes to the sole active lane (or
errors if ambiguous), consistent with spec 176.

New MCP tool on `krypton-harness-memory` (per-lane, no token — same channel as
`memory_*`/`peer_*`):

```
issue_progress { issue_key: string, phase: IssuePhase, summary?: string, pr_url?: string }
```

The lane reports its own fix progress, naming the issue with `issue_key`
(`owner/repo#123`, copied verbatim from its fix prompt). The harness resolves the
binding **by that key** — not by guessing the lane's most-recent dispatch, which
would misroute when one lane is fixing more than one issue — verifies the binding
belongs to the reporting lane, updates `phase/summary/prUrl/updatedAt`, and
publishes a `status` event so the overlay refreshes live.

**Auto-bind (spec 190).** `issue_progress` must work whether the fix started from
the browser plugin *or* straight in the harness (the user just tells a lane to fix
`owner/repo#123` in conversation, with no prior `dispatchIssue`). So when a valid
`issue_key` has **no binding**, the harness **self-registers** one against the
reporting lane (parse `issue_key`, create the `IssueBinding`, set the lane goal chip
if unset, enrich the title via `gh` in the background) and then applies the update —
rather than rejecting. The misroute guard is kept: a key already bound to a
**different live lane** returns `wrong_lane`; a **stale** binding whose lane is gone
is taken over by the reporting live lane. Reason codes: `unknown_lane` (reporting
name is not a live lane), `wrong_lane`, and `invalid_issue_key` (unparseable key,
no binding created). The former `no_binding` reason is **retired** — a valid key
always binds. See `docs/190-issue-progress-auto-bind.md`.

### Dispatch Surfaces

All surfaces converge on the **same** `dispatchIssue(params)` path in
`acp-harness-view.ts` (create binding → set lane goal → `lane.send`). They differ
only in how they reach it and how they obtain issue metadata:

| Surface | Trigger | Metadata source |
|---------|---------|-----------------|
| **Krypton command palette** (`getPaletteActions`, primary keyboard path) | "Fix GitHub Issue…" → input prompts for URL or `owner/repo#123` | `gh issue view <n> -R <repo> --json title,body` via `run_command` |
| **Krypton `#` harness palette** | `#fix-issue <url>` | same `gh` fetch |
| **Extension issue-page card** | injected card on `/issues/<n>` | scrape DOM (no token) |

In-Krypton surfaces call `dispatchIssue` directly (no control round-trip). Browser
surfaces call it through `POST /control/v1/operations { github.dispatch-issue }`.
If `gh` is missing/unauthed, dispatch still proceeds with the URL only and the
prompt instructs the lane to fetch the issue itself.

### Data Flow

**Dispatch from Krypton (keyboard-first, primary):**
```
1. User opens command palette → "Fix GitHub Issue…", types a URL or owner/repo#123
2. acp-harness-view resolves repo+number, runs `gh issue view ... --json` for metadata
3. dispatchIssue(): create IssueBinding, set lane.goal = "Fix #123: <title>",
   spawn/target lane, lane.send the fix prompt, persist binding
4. Frontend publishes a status event → any open browser overlay lights up live
```

**Dispatch from the browser:**
```
1. User clicks "Fix in Krypton" on the issue-page card; metadata scraped from DOM
2. background.js → POST /control/v1/operations { github.dispatch-issue, params }
3. control.rs routes to frontend; same dispatchIssue() path as above runs
4. Frontend publishes a status event; reply { harnessId, lane, issueKey } returns
```

**Live status overlay:**
```
1. github-issue.js loads, parses issueKey, opens a Port to background.js
2. background.js calls github.issue-status → renders the card
3. background.js holds one SSE connection to /control/v1/events; frames whose
   { harnessId, lane } match a bound issue on an open tab are relayed to that
   tab's Port (kinds: status, attention, message_chunk, permission_request)
4. github-issue.js updates the card in place (phase, lane status, last line, PR link)
```

### Persistence & Browser Refresh

Status is built on a **snapshot-first + stream** model so a browser refresh (or
opening the issue on a later day, in a new tab, or from another machine pointed at
the same loopback) always rebuilds the card correctly — it never depends on having
caught live events:

- **Snapshot** — every content-script load calls `github.issue-status { issueKey }`,
  which returns the persisted binding (incl. last `phase/summary/prUrl`) merged
  with the live lane status. Refresh = re-snapshot.
- **Stream** — SSE carries *deltas only*; a `gap` frame triggers a re-snapshot.

To survive a **Krypton restart** (not just a browser refresh), bindings are
disk-backed, reusing the existing atomic-write pattern (`hook_server.rs:445-460`,
tmp-file + rename) and the rehydrate-on-`register_harness` pattern that artifacts
use (spec 173):

- On every binding mutation (dispatch, `issue_progress`, unlink) the frontend calls
  a Tauri command to persist the harness's bindings to disk (sibling to the
  `PersistedMemory` file, e.g. `issue-bindings.json`, **separate** from the
  handoff-only `memory_*` store).
- On `register_harness`, bindings rehydrate from disk; `refreshIssueBindings()`
  replays them into the lane mirror, mirroring `refreshArtifacts()`
  (`acp-harness-view.ts:4493`).
- After a restart the lane process is gone, so the snapshot reports
  `laneStatus: stopped` but still renders the last persisted `phase/summary/prUrl`;
  the card offers re-dispatch.

### Keybindings

| Key | Context | Action |
|-----|---------|--------|
| (palette) | Agent view | "Fix GitHub Issue…" command (`getPaletteActions`) — opens the URL input |
| `#fix-issue <url>` | Harness `#` palette | Dispatch inline without leaving the prompt |
| (palette) | Agent view, bound lane | "Open Bound GitHub Issue" → `open_url(issueUrl)` |

The bound lane shows the issue as its goal badge. On the GitHub page itself there
are no Krypton keybindings (not a Krypton surface).

### UI Changes

- **GitHub page** — a compact "Krypton" status card. On the classic,
  server-rendered issue page it is injected inline into the issue sidebar
  (`#partial-discussion-sidebar`, below Assignees). On the new React issue page —
  whose only sidebar anchor is a `position: sticky` metadata container that pins +
  clips an injected card and hydrates late (racing the content script) — the card
  renders as a **fixed floating card** pinned top-right, below GitHub's header.
  This keeps the rendering deterministic instead of flickering between inline and
  floating. States: *unbound* (a "Fix in Krypton ▸" button +
  lane picker that defaults to the first existing lane, falling back to "＋ New
  lane" only when none exist), *working* (phase chip + lane status dot + last line + cancel),
  *done* (✓ + PR link if reported), *offline* ("Krypton not running"). Honors
  GitHub light/dark. No left-border accent rails; use a full border / bg tint.
- **Krypton agent view** — bound lane gains an issue badge (`#123`) in its header,
  driven by `lane.goal`; clicking/keybinding opens the issue URL.

### Configuration

None required for v1 (`github.com` only). A future `[github] hosts = [...]` for
GitHub Enterprise is noted as out of scope.

## Edge Cases

- **Duplicate dispatch** — `issueKey` already bound: focus the existing binding,
  do not create a second lane.
- **`issue_progress` with no binding (spec 190)** — a lane that picked up the issue
  directly (no dispatch) auto-binds itself from `issue_key` instead of getting
  `no_binding`; an unparseable key yields `invalid_issue_key` and creates nothing.
- **Lane closed/restarted/stopped** — snapshot reports `laneStatus: stopped`; card
  offers re-dispatch; binding retained until unlinked.
- **Krypton offline** — native handshake fails; card shows offline state, no error spam.
- **Private repo** — issue-page surface reads the authenticated DOM; Krypton's
  command palette relies on the user's already-authed local `gh`.
- **`gh` missing/unauthed** — Krypton dispatch proceeds with the URL only; the
  prompt tells the lane to fetch the issue (e.g. via its own `gh`/web tools).
- **Malformed issue input** — Krypton input rejects strings that don't parse to a
  repo + number (or full `/issues/<n>` URL) with an inline error, no binding created.
- **PR pages / non-issue pages** — the content script is injected on all of
  `github.com/*` but self-gates: it only mounts the card on `/<owner>/<repo>/issues/<n>`
  URLs (via `parseIssue`), and tears it down on navigation away.
- **SPA / soft navigation** — GitHub (Turbo + a React router) never reloads the
  document on in-site navigation, so the script cannot rely on a fresh injection
  or `DOMContentLoaded`. It watches client-side URL changes (Navigation API
  `navigatesuccess`, with `turbo:load` / `pjax:end` / `popstate` fallbacks) and
  re-runs `handleLocation()` to mount, re-key (to the new `owner/repo#n`), or tear
  down the card. The live Port is connected once and kept alive for the tab,
  re-arming its `watch` on each issue change. (Fixes #7: card previously appeared
  only after a hard refresh.)
- **Multiple harnesses** — binding records `harnessId`; SSE relay filters on
  `{ harnessId, lane }`, so cards never cross-talk. The popup/content-script
  `lane.list` carries no `harnessId` (no harness picker in the extension), so
  `control-bridge` **fans it out across every open harness and concatenates** the
  rows — the same pattern as the `github.*` reads. Lane `displayName`s are globally
  unique, so the lane picker stays usable with two or more harnesses open instead
  of failing with `lane.list requires harnessId` (fixes #8). For the same reason a
  **dispatch** carries its target as `targetLane` (a displayName) — never
  `lane`/`harnessId` — so `control-bridge` resolves the owning harness from that
  displayName and routes there; the `__new__` sentinel (or an absent target) falls
  back to the sole-harness rule and errors `ambiguous_harness` when two or more are
  open. Without this, dispatching to a named lane failed with `github.dispatch-issue
  requires harnessId` (the dispatch analogue of #8).
  > **Naming note** — "dispatch" here (`github.dispatch-issue`: hand an issue to a
  > lane, which **sets that lane's Goal** and clears its session) is a *different*
  > verb from spec 180's **Dispatch** (an orchestrator `peer_send` that **never**
  > sets a Goal and never clears the worker's session — see `CONTEXT.md` → Dispatch).
  > Same word, opposite session semantics.
- **SSE gap** (slow client) — on a `gap` frame, background re-fetches
  `github.issue-status` for visible tabs (re-snapshot).

## Decisions (resolved 2026-06-27)

1. **Rich status tool** — *include* the `issue_progress` MCP tool so the lane can
   report *PR opened / done* (lane status alone can't express that).
2. **Dispatch target** — offer both. The issue-page card **defaults to the first
   existing lane** when one is running (reuse over spawn); only when there are no
   lanes does it default to the `__new__` sentinel that spawns a dedicated
   `fix/#123` lane.
3. **Write-back to GitHub** — *out of scope for v1*. No extension-side token, no
   auto-comment/label/PR; the agent may run `gh` inside the lane.
4. **Metadata fetch for non-DOM surfaces** — local `gh` CLI (`gh issue view --json`)
   with URL-only fallback to the lane when `gh` is missing/unauthed.

## Out of Scope

- Writing to GitHub from the extension (comments, labels, assignees, PR creation).
- GitHub OAuth / token management in the extension.
- GitHub Enterprise / non-`github.com` hosts.
- Dispatching from PR pages or issue *comments*.
- A dedicated Krypton-internal issue dashboard (bindings surface via lane badge +
  `github.list-issues` only).

## Resources

- [Assigning and completing issues with Copilot coding agent](https://github.blog/ai-and-ml/github-copilot/assigning-and-completing-issues-with-coding-agent-in-github-copilot/) — confirmed the assign→async→inline-status UX and PR-body status pattern.
- [Cursor: Background Agents on GitHub Issues](https://forum.cursor.com/t/background-agents-on-github-issues/107223) — comment-triggered dispatch + status-via-comment prior art.
- Internal: spec 175 (web control API + SSE), spec 176/177 (extension + content extraction), ADR-0007 (frontend authority).
