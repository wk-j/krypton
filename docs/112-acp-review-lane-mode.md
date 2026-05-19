# ACP Review Lane Mode — Implementation Spec

> Status: Implemented (V0.5 scope)
> Date: 2026-05-20
> Milestone: M-ACP — Harness Multi-Agent

## Problem

Krypton's ACP harness already runs multiple lanes side-by-side, but the only way one lane can "review" another's work is through `peer_send` — free-form chat. In practice the reviewer either restates the whole diff in prose, asks for files the requester forgot to attach, or produces abstract advice ("consider adding tests") that the implementer cannot act on without re-reading the transcript.

The result: multi-lane coding is not yet *materially* more useful than a single lane plus careful prompting. There is no structured channel for "lane A finished a unit of work — lane B, please review the patch + commands + failures and reply with anchored findings."

## Solution

Add **Review Lane Mode**: a user-directed protocol where one lane sends a *review packet* to another lane and receives back a *structured findings list*. The harness — not the agent — assembles the packet from existing lane state (recent user intent, transcript commands, git working-tree state). The reviewer is required to reply via a typed tool with mandatory `file:line` anchors; prose-only replies are rejected and re-requested.

Two new MCP tools (`review_request`, `review_reply`) sit next to `peer_send` on the existing `krypton-harness-bus` server. Transport reuses the peer envelope + inbox path from Spec 106. A new transcript item kind `review` renders the findings as a card in the requester's lane.

**V0.5 scope** (this spec): user-triggered `#review <lane>` chat command, structured git packet (`repoRoot` + diffstat + capped per-file hunks + untracked excerpts + staging metadata + worktree fingerprint), reviewer prompt, `review_reply` schema with validator + retry budget, review card on requester side. Deferred to V1+: palette action, mirrored card in reviewer lane, structured `evidence` field, automatic unresolved-failure inference, `ToolPayload.exitCode` extension, no-git absolute-path mode, per-finding expansion UI, "fix this finding" round-trip.

## Research

- **`peer_send` already round-trips** (Spec 106 addendum): Rust → Frontend → Rust with a oneshot reply, registered in `HookServer::pending_bus_replies`. The same pattern fits `review_request` and `review_reply` cleanly — no new transport.
- **Transcript already stores tool calls structured** (`acp-harness-view.ts:133`): `ToolPayload` carries `kind`, `subject`, `command`, `result`, `diffs[]`, `startedAt`, `endedAt`. Iterating `lane.transcript` since a marker timestamp yields the "commands run" and "files edited" view for free.
- **Permission card pattern** (Spec 107): `HarnessTranscriptItem` already supports first-class structured payloads (`ToolPayload`, `PermissionPayload`, `InterLanePayload`, `FsReviewPayload`). Adding `ReviewPayload` follows the same shape.
- **`inter_lane` rows + `awaiting_peer` status** (Spec 106): an in-flight review fits naturally on top — requester goes `busy → awaiting_peer` while reviewer is `idle → busy`. The drain rule and `#cancel` path already handle the lifecycle.
- **Git diff in Rust**: the backend already shells out to git for cwd (`get_pty_cwd`); reusing `git diff HEAD -- <paths>` is straightforward via `std::process::Command`. No new crate needed.
- **Per-turn checkpoints (#14)** is *not* a prerequisite. V1 uses `HEAD` as the diff base and documents the limitation (uncommitted pre-existing changes leak into the review packet). When #14 lands, the base flips to the lane's start-of-session checkpoint.

**Alternatives ruled out:**
- *Overload `peer_send` with a structured payload field* — bloats the most common tool; reviewers can't tell a review request from a chat. Separate tool is clearer.
- *Reviewer constructs the packet themselves via tool calls* — wastes a turn and lets the reviewer cherry-pick context. Harness-built packets are more consistent and auditable.
- *Auto-trigger review after every assistant turn* — context rot and noise. Explicit user trigger only, matching the user-directed peering philosophy.
- *Free-form prose findings with regex parsing* — fragile. Strict tool schema with retry is the only reliable path.

## Prior Art

| App | Implementation | Notes |
|-----|----------------|-------|
| Aider Architect mode | One model proposes the change ("architect"); a second model ("editor") translates it into edits. Sequential, single-author. | Closest "two-model coding" pattern, but Aider is implementer-implementer, not implementer-reviewer. |
| Cursor Bug Bot / GitHub Copilot review | Agent posts inline PR comments anchored to file:line; user accepts/dismisses. | Strong precedent for anchored findings; runs on completed PRs, not in-progress work. |
| CodeRabbit / Greptile | LLM PR-review bots: structured walkthrough, file-anchored comments, severity labels. | Confirms `file:line` + severity is the dominant shape. |
| Claude Code subagents (`Task`) | Hierarchical: parent agent spawns subagent with isolated context, gets one synthesized reply. | Synthesized prose, no enforced structure. |
| OpenAI Swarm `handoff` | Single-active-speaker handoff between agents. | Not a review pattern; sequential turn-taking. |

**Krypton delta** — Krypton's lanes are independent, live, user-visible ACP sessions, not subagents. The harness sits *between* them and can enforce protocol (structured packet in, structured findings out) without either agent's cooperation. PR-review bots run on a completed branch; Krypton reviews *uncommitted, in-progress* work on the working tree. No existing terminal emulator implements this — it's novel at this layer.

## Affected Files

| File | Change |
|------|--------|
| `src-tauri/src/hook_server.rs` | Register `review_request` + `review_reply` tools; add git-state collector (`rev-parse --show-toplevel`, `status --porcelain`, `diff --numstat`, per-file `diff` capped, untracked excerpts); new Tauri events `acp-review-requested` / `acp-review-reply-requested`; both auto-allowed alongside memory/peer. |
| `src-tauri/src/commands.rs` | New `acp_review_reply` command mirroring `acp_bus_reply` (oneshot completion). |
| `src/acp/inter-lane.ts` | Extend coordinator with `deliverReviewRequest()` / `deliverReviewReply()`; track pending reviews per lane (parallel to pending peers). |
| `src/acp/review.ts` | **New.** Pure helpers: build packet (intent + commands + failures + tool summary) from lane transcript; format reviewer prompt; validate findings shape. |
| `src/acp/acp-harness-view.ts` | Add `ReviewPayload` + `review` transcript kind; render review card with fingerprint-mismatch banner; new chat command `#review <lane>`; route `acp-review-*` events into coordinator; maintain per-lane `reviewedThrough` marker (advanced only on successful reply). |
| `src/acp/types.ts` | Export `ReviewPacket`, `ReviewFinding`, `ReviewSeverity`, `ReviewReply`. |
| `src/styles/acp-harness.css` | Review card styles: header, findings list, severity markers, no `backdrop-filter`. |
| `docs/106-inter-lane-messaging.md` | Cross-reference Review Lane Mode in inbox/awaiting_peer lifecycle. |
| `docs/108-overall-ui-improvements.md` | Mark #5 (Review Lane Mode) as shipped after implementation. |
| `docs/PROGRESS.md` | Add landing note after implementation. |

## Design

### Data Structures

```ts
// src/acp/types.ts
export type ReviewSeverity = 'block' | 'warn' | 'nit';

export interface ReviewFinding {
  file: string;          // repo-root-relative path; required
  line: number;          // 1-based; required (use 1 if file-level)
  severity: ReviewSeverity;
  concern: string;       // one line, ≤ 200 chars
  suggestedCheck?: string; // runnable command or "read X to verify"; REQUIRED when severity = 'block'
}

export interface ReviewPacket {
  packetId: string;            // ULID
  fromLaneId: string;
  toLaneId: string;
  intent: string;              // originating user prompt(s) for the work
  repoRoot: string;            // absolute path; `git rev-parse --show-toplevel` from lane cwd
  patchBase: 'head';           // V0.5 always HEAD; 'checkpoint' deferred to #14
  hasStagedChanges: boolean;
  hasUnstagedChanges: boolean;
  partialStagingDetected: boolean; // true if any path differs in both index and worktree
  worktreeFingerprint: string; // sha256(HEAD_sha + porcelain output + changed-path size/mtime)
  diffstat: Array<{ path: string; status: 'M' | 'A' | 'D' | 'R' | '?'; added: number; removed: number }>;
  patchHunks: Array<{
    path: string;
    status: 'M' | 'A' | 'D' | 'R' | '?';
    hunk: string;              // unified diff for this file, capped at PER_FILE_HUNK_CAP (8 KB)
    truncated: boolean;
  }>;
  untrackedExcerpts: Array<{ path: string; head: string }>; // first ~40 lines per untracked file
  commands: Array<{
    command: string;
    exitCode: number | null;   // best-effort tail parse; null when unknown
    summary: string;           // truncated stdout/stderr tail, ≤ 400 chars
    at: number;
  }>;
  toolSummary: Array<{ kind: 'read' | 'edit' | 'search' | 'other'; subject: string; count: number }>;
  note?: string;               // optional requester hint passed via review_request
  sentAt: number;
}

export interface ReviewReply {
  packetId: string;
  findings: ReviewFinding[];   // may be empty (= clean review)
  summary: string;             // one paragraph, ≤ 600 chars
  blockedByProtocol?: string;  // set by harness if reviewer ignored schema twice
}

export interface ReviewPayload {
  direction: 'sent' | 'received';
  peerId: string;
  peerDisplayName: string;
  packetId: string;
  summary: string;
  findings: ReviewFinding[];
  worktreeMatchAtReceipt: boolean; // computed once at reply time vs packet fingerprint
}
```

Add `'review'` to `HarnessTranscriptItem.kind` and a `review?: ReviewPayload` field.

### MCP Tools

Both auto-allowed (added to `HARNESS_AUTO_ALLOW_TOOL_NAMES`). Both round-trip Rust ↔ frontend coordinator like `peer_send`.

**`review_request`** — initiate a review.

```json
{
  "name": "review_request",
  "description": "Ask another lane to review your recent work. The harness assembles a structured packet (intent + patch + commands + failures) from your lane state — you do not need to paste anything. The reviewer is required to reply with anchored findings via review_reply. After calling this tool, end your turn; the reply arrives as a structured transcript card.",
  "inputSchema": {
    "type": "object",
    "required": ["to_lane"],
    "properties": {
      "to_lane": { "type": "string" },
      "note":    { "type": "string", "description": "Optional one-line hint to the reviewer (focus area, known concerns)." }
    }
  }
}
```

**`review_reply`** — submit findings.

```json
{
  "name": "review_reply",
  "description": "Reply to a review packet with structured findings. Each finding requires file + line + severity + concern. Use empty findings[] for a clean review. Free-form prose is rejected — use this tool.",
  "inputSchema": {
    "type": "object",
    "required": ["packet_id", "summary", "findings"],
    "properties": {
      "packet_id": { "type": "string" },
      "summary":   { "type": "string", "maxLength": 600 },
      "findings": {
        "type": "array",
        "items": {
          "type": "object",
          "required": ["file", "line", "severity", "concern"],
          "properties": {
            "file":     { "type": "string" },
            "line":     { "type": "integer", "minimum": 1 },
            "severity": { "enum": ["block", "warn", "nit"] },
            "concern":  { "type": "string", "maxLength": 200 },
            "suggested_check": { "type": "string" }
          }
        }
      }
    }
  }
}
```

### Packet Assembly

Packet assembly is split: **frontend** contributes transcript-derived signals (intent, commands, tool summary), **Rust** is the source of truth for the git state.

**Frontend side** (`src/acp/review.ts::buildPacketFromTranscript(lane, since)`):

- **intent** — concatenate `kind === 'user'` items from `since` forward (truncate to 2000 chars).
- **commands** — `kind === 'tool'` where `tool.kind === 'shell'` or tool family is bash-execute; pull `command`, last 400 chars of `result`. `exitCode` is **best-effort tail parse**; `null` when ambiguous. No structured `ToolPayload.exitCode` extension in V0.5.
- **toolSummary** — count tool calls grouped by kind (read/edit/search/other) with most-touched subject per group. Transcript-derived only; not used as the patch file-set.

**Rust side** (`hook_server.rs::collectGitState(cwd)`):

1. `git rev-parse --show-toplevel` from lane cwd → `repoRoot`. If this fails: return `{ repoRoot: cwd, hasStagedChanges: false, hasUnstagedChanges: false, partialStagingDetected: false, worktreeFingerprint: '<no-git>', diffstat: [], patchHunks: [], untrackedExcerpts: [] }`. Packet header surfaces `<no git repo>` and `review_request` is rejected with `reason: 'no_git_repo'` in V0.5 (deferred no-git mode).
2. `git status --porcelain=v1 -z` to enumerate **all** changed paths (tracked + untracked). Source of truth for the file set.
3. **Staging detection:** `git diff --cached --name-only` → staged set; `git diff --name-only` → unstaged set.
   - `hasStagedChanges = stagedSet.size > 0`
   - `hasUnstagedChanges = unstagedSet.size > 0`
   - `partialStagingDetected = any path in both sets`
4. `git diff HEAD --numstat` → `diffstat` (combined staged+unstaged vs HEAD, status from porcelain).
5. For each tracked changed path: `git diff HEAD -- <path>` → cap at `PER_FILE_HUNK_CAP` (8 KB); set `truncated: true` if cut.
6. For each untracked path: read first 40 lines (or 4 KB, whichever first) → `untrackedExcerpts`. Binary files (per `file -b --mime`) record `head: '<binary>'`.
7. All paths in `diffstat`, `patchHunks`, `untrackedExcerpts` are normalized **repo-root-relative**.
8. Total payload cap: `TOTAL_PATCH_CAP` (40 KB) across hunks + excerpts. When exceeded, hunks past the cap drop body but keep diffstat entry (marked `truncated: true`). Order of inclusion: tracked files by hunk size descending, then untracked. Diffstat always complete.
9. **Worktree fingerprint:** `sha256(HEAD_sha + porcelain_output + sorted_list(path|size|mtime for each changed path))`. Computed atomically with the rest of the collection.

The frontend keeps two markers per lane:

- `requestedThrough: number` — advanced on every successful `review_request` (gates the in-flight check).
- `reviewedThrough: number` — advanced only on a non-protocol-blocked reply; this is the marker passed as `since` to packet assembly.

If a review protocol-fails after retry budget, `reviewedThrough` does not advance — the same delta is included in the next review.

### Fingerprint Mismatch Detection

When a `ReviewReply` arrives at the requester, the coordinator recomputes `worktreeFingerprint` (same recipe, current state) and sets `worktreeMatchAtReceipt = currentFingerprint === packet.worktreeFingerprint` on the payload before rendering the card.

### Reviewer Prompt Format

The drain coordinator wraps the packet into one ACP user-turn message (parallel to Spec 106's `[inter-lane]` framing):

```
[review request] From Claude-1 (packet: <id>):

  Note: <optional note>

  ## Working-tree state
  - repo root: <repoRoot>
  - staging: staged=<yes|no> · unstaged=<yes|no> · partial=<yes|no>
    (if partial=yes: "WARNING — some paths differ in both index and worktree;
     the patch below reflects worktree state and may not match what would be committed")

  ## Intent
  <intent text>

  ## Patch (vs HEAD)
  Diffstat: 3 files changed, +42 / -7
    M  src/foo.rs    (+12 / -5)
    M  src/bar.rs    (+3 / -2)
    ?  src/new.rs    (untracked, 18 lines)

  ```diff
  <per-file hunks; truncated files marked>
  ```

  Untracked excerpts:
    src/new.rs (head):
      <first 40 lines>


  ## Commands run (best-effort)
  - `cargo test session_pool` → exit 0
  - `cargo clippy` → exit 1

  ## Tool summary
  - edit: src/foo.rs (×3), src/bar.rs (×1)
  - read: src/baz.rs (×2)

[review request] Reply ONLY by calling review_reply({ packet_id: "<id>", summary, findings: [{ file, line, severity, concern, suggested_check? }, …] }).
Each finding MUST anchor to a file:line. Empty findings[] = clean review. Prose-only replies are rejected and re-requested.
```

### Protocol Enforcement

Two distinct failure modes get distinct corrective envelopes; retry budget = 2 in both cases.

When the reviewer ends its turn:

1. **Success:** at least one `review_reply` tool call landed with `packet_id` matching the open packet AND the payload passes the validator → packet resolved, findings sent back.
2. **No tool call** (reviewer wrote prose only): coordinator synthesizes `[review-protocol] Your last reply did not call review_reply. Findings must use the tool. Reply again now.` Retry counter +=1.
3. **Tool called but validation failed** (missing file/line, severity not in enum, `block` finding without `suggested_check`, etc.): coordinator synthesizes `[review-protocol] Your review_reply was rejected: <validator errors per finding index>. Resubmit via review_reply.` Retry counter +=1.
4. **Retry budget exhausted (2):** coordinator sends `ReviewReply` to requester with `blockedByProtocol: 'reviewer schema failed after 2 attempts'` (or `'reviewer did not use review_reply after 2 attempts'`), empty findings, and the prose reply (if any) embedded in `summary`.

The validator runs **per-finding**; partially valid findings are accepted, invalid ones flagged in the corrective envelope. If at least one valid finding lands AND no invalid ones, treat as success even if reviewer added prose alongside the tool call.

### Status Lifecycle

- **Requester:** `busy → awaiting_peer` (existing semantics, exposes packet target in pendingPeers metadata) → `idle` once reply lands.
- **Reviewer:** receives via inbox drain like a normal peer message → `idle → busy` for the review turn → `idle` after reply.
- **`#cancel` on requester:** synthesizes a `harness: review cancelled` envelope into reviewer's inbox; requester clears pending packet → `idle`.
- **Reviewer lane closes mid-review:** requester gets `ReviewReply` with `blockedByProtocol: 'reviewer lane closed'`, empty findings.

### UI

**Review card** (new `kind: 'review'` row) in requester's transcript:

```text
┌ review · from Codex-1 · 2 findings (1 block, 1 nit)
│ ⚠ worktree changed since review request   ← only when worktreeMatchAtReceipt=false
│
│ summary
│   patch looks correct; one regression in session_pool reaping and a
│   missing test for the error path.
│
│ block   src/session_pool.rs:142  reap() drops sessions still in
│                                  use; add reference guard
│         check: cargo test session_pool::reap_active
│ nit     src/foo.rs:3             unused import; remove
└
```

- Header: direction + peer + finding counts grouped by severity.
- Fingerprint mismatch banner (`worktreeMatchAtReceipt === false`) sits between header and summary.
- Summary block: reviewer's one-paragraph summary.
- Findings list: one row per finding, prefix with severity text label (`block`/`warn`/`nit`); not emoji (`feedback_no_uppercase_paths` rules apply to paths).
- `suggestedCheck` always rendered inline if present (no per-finding expansion UI in V0.5).
- No mirrored review card in reviewer's transcript (V0.5 cut — reviewer only sees the inbound packet as a peer-style entry).

### Trigger Surface

Single path in V0.5, user-directed:

- **Chat command in composer:** `#review <lane>` (e.g. `#review Codex-1`) — parsed in `parseCommand()` next to `#cancel` / `#new`. Optional trailing text becomes the `note`.

Palette action and global keybindings deferred to V1+. The in-flight guard (one open packet per requester) is enforced **synchronously inside the coordinator** before any async git collection — two fast `#review`s cannot both pass.

### Data Flow

```
1. User on Claude-1 types "#review Codex-1 focus on session_pool".
2. acp-harness-view parses → calls hook_server::review_request({ to_lane, note }) via local MCP path
   (or directly if invoked via palette — internal handler bypasses MCP).
3. Coordinator does synchronous in-flight check (one open packet per requester); if a packet
   is already in flight from Claude-1, reject with reason: 'review_in_flight' before any I/O.
4. hook_server::review_request:
   a. Resolves cwd from lane via existing Tauri command.
   b. Reads transcript-derived metadata from frontend via new acp-review-requested event
      (intent, commands, toolSummary, reviewedThrough marker).
   c. Rust collects git state: `rev-parse --show-toplevel`, `status --porcelain`,
      staged/unstaged sets, `diff --numstat`, per-file `diff HEAD -- <path>` (capped),
      untracked excerpts, and computes worktreeFingerprint.
   d. Frontend assembles final ReviewPacket from transcript signals + Rust git payload and
      pushes to Codex-1 inbox via InterLaneCoordinator.deliverReviewRequest. requestedThrough
      advances to now; reviewedThrough does NOT advance yet.
   e. Returns { delivered: true, packetId } to Claude-1.
4. Claude-1 ends turn → status busy → awaiting_peer (pendingReviews populated).
5. Codex-1 hits idle → coordinator drains inbox → composes the [review request] prompt with packet
   contents → enqueueSystemPrompt(text) → Codex-1 status idle → busy.
6. Codex-1 runs review_reply tool → hook_server::review_reply registers oneshot, emits
   acp-review-reply-requested → frontend coordinator validates each finding
   (file/line/severity/concern required; suggested_check required when severity=='block') →
   calls deliverReviewReply → reply lands as inbox entry for Claude-1. Coordinator recomputes
   worktreeFingerprint at this moment and sets worktreeMatchAtReceipt on the payload.
7. If review_reply not called OR validation fails: distinct protocol-retry envelope
   synthesized (see Protocol Enforcement). Stale replies for cancelled packetIds are dropped.
8. On a non-protocol-blocked reply: reviewedThrough advances to the packet's sentAt.
   Claude-1 hits idle → drain → review transcript card rendered. Status → idle
   (no follow-up turn unless user prompts).
```

### Configuration

No new TOML keys. Feature always on when peering is available and lane cwd is under a git repo. Constants in `src/acp/review.ts`:

- `TOTAL_PATCH_CAP = 40_960` (40 KB) — combined hunks + untracked excerpts.
- `PER_FILE_HUNK_CAP = 8_192` (8 KB) — single-file hunk ceiling.
- `UNTRACKED_HEAD_LINES = 40` / `UNTRACKED_HEAD_BYTES = 4_096`.
- `REVIEW_PROTOCOL_RETRY_BUDGET = 2`.
- `INTENT_CAP = 2_000` chars; `COMMAND_RESULT_TAIL = 400` chars.

## Edge Cases

- **Empty git status** (no tracked changes and no untracked files): `review_request` returns `{ delivered: false, reason: 'no_changes' }`. Tool description hints to make at least one edit first.
- **Patch exceeds `TOTAL_PATCH_CAP`:** diffstat is always complete; per-file hunks past the cap drop their body (kept as diffstat entry marked `truncated: true`). Untracked excerpts truncated to head-only. Order of inclusion: tracked files by absolute hunk size descending (largest churn first), then untracked.
- **Single-file hunk > `PER_FILE_HUNK_CAP`:** that file's hunk is truncated at the cap with `truncated: true`. Reviewer can still anchor findings against truncated regions; `evidence` hunk-ref is permitted to point at the diffstat entry alone in that case.
- **Lane cwd is not under a git repo:** `review_request` rejected with `reason: 'no_git_repo'` in V0.5. (Absolute-path mode deferred.)
- **Renamed/deleted files:** captured via `git status --porcelain` and surfaced in diffstat with status `R` / `D`. `patchHunks` includes the rename diff if any; deletes have empty hunk body with `status: 'D'`.
- **Binary or generated files:** untracked binaries get `head: '<binary>'`; tracked binary diffs render as `<binary file changed>` in the hunk slot.
- **Lane subdir cwd:** all paths normalize to repo-root-relative via `git rev-parse --show-toplevel`. Findings cite repo-root-relative paths; validator rejects paths that resolve outside `repoRoot`.
- **Partial staging** (index and worktree differ for same path): captured in packet metadata + reviewer prompt warning; no rejection. Reviewer sees worktree state and is informed it may not match a future commit.
- **Worktree changed during review:** detected at reply time via fingerprint recomputation; card shows `worktree changed since review request` banner. Findings still rendered; user verifies against current code.
- **Cancel then immediate re-request:** the cancelled packetId is recorded in a small `cancelledPacketIds` set on the coordinator; any later `review_reply` for that id is dropped silently with a one-line debug log. The new `review_request` proceeds normally after the synchronous in-flight check passes.
- **Protocol-fail does not advance `reviewedThrough`:** the same delta is included in the next review attempt; no unreviewed work is silently dropped.
- **Reviewer is same backend** (Claude-1 reviewing Claude-1): blocked at `to_lane === fromLaneId` (existing `self_send` reject in peer transport).
- **Concurrent review requests** from same requester: V1 allows only one open packet per requester; second `review_request` returns `{ delivered: false, reason: 'review_in_flight' }`.
- **Multiple findings on same file:line:** allowed; render as separate rows.
- **Finding file path not in patch:** allowed (reviewer may notice unchanged-but-related issue); no validation against patch files in V1.
- **Reviewer returns invalid finding** (missing file or non-positive line): rejected per-finding by harness validator; if all findings invalid, treated as prose-only and protocol retry kicks in.
- **`#cancel` mid-review:** documented above; clean lifecycle.
- **Reviewer crashes or errors mid-turn:** treated as protocol failure after retry budget exhausted; requester gets `blockedByProtocol: 'reviewer error'`.

## Open Questions

None. All three previous open questions resolved by user choosing the V0.5 cut (Option C from round-2 Codex grilling):

1. ✅ V0.5 = one-shot review only.
2. ✅ Patch base = HEAD; dirty-tree honesty via staging metadata + worktree fingerprint.
3. ✅ Structured caps (40 KB total / 8 KB per-file, diffstat always complete).

## Out of Scope

- **V2: "Fix this finding" round-trip** — action on a review card that synthesizes a new prompt back to the implementer lane with the finding embedded. Designed once V1 ships.
- **Auto-trigger review** at end of every assistant turn. User-directed only.
- **Multi-reviewer fan-out** (request review from N lanes at once). Point-to-point in V1.
- **Persisting review history** across harness restart.
- **Review against arbitrary git ref** (`HEAD~3`, branch X). HEAD only in V1.
- **Findings against uncommitted-but-unedited files** is supported, but findings against files outside the lane cwd are not validated.
- **Streaming reviewer reply.** Reply is a single tool call.
- **Telemetry** for review traffic / acceptance rates.
- **Memory-derived `openQuestions`** — pulling `memory_get` content or last assistant paragraph into the packet. Removed to avoid context rot; explicit `note` field on `review_request` is the only sender-side hint.

### Deferred from V0.5 (round-2 cut, ship later)

- **Palette action** for `ACP: Send review to <Lane>` via `getPaletteActions()`.
- **Mirrored review card** in reviewer's transcript.
- **Structured `evidence` field** on findings (`{ kind: 'command'|'hunk'|'diffstat', ... }`).
- **Automatic unresolved-failure derivation** from command exit codes (V0.5 ships commands as-is, no inference).
- **`ToolPayload.exitCode` / `exitSource` extension** for first-class exit code on tool rows.
- **No-git absolute-path mode** for findings when lane cwd is outside a git repo.
- **Per-finding expansion UI** + keyboard cursor.
- **Submodule / nested repo handling**, permission-only / symlink / mode-change diff headers, ignored-file detection.
- **"Fix this finding" round-trip** (V2 — action on a finding synthesizes a follow-up prompt to the implementer lane).

## Resources

- `docs/106-inter-lane-messaging.md` — peer transport, `awaiting_peer` lifecycle, inbox drain, `#cancel`.
- `docs/107-acp-harness-transcript-readability.md` — structured transcript payload pattern that `ReviewPayload` mirrors.
- `docs/108-overall-ui-improvements.md` (#5) — backlog entry this spec ships.
- `docs/110-context-aware-command-palette.md` — palette action registration via `getPaletteActions`.
- `src/acp/acp-harness-view.ts:60–144` — `HarnessTranscriptItem` and existing payload shapes.
- `src-tauri/src/hook_server.rs:215–875` — MCP server, tool registration, peer round-trip pattern.
- [Aider Architect mode](https://aider.chat/docs/usage/modes.html) — two-model implementer pattern.
- [CodeRabbit review walkthrough format](https://docs.coderabbit.ai/reviews/walkthrough) — anchored findings + severity precedent.
- [Cursor Bug Bot](https://docs.cursor.com/bugbot) — inline anchored review comments.

## Review History

- 2026-05-20 — peer review by Codex-1 (lane) on draft v1. Key changes incorporated: patch assembly uses `git status --porcelain` as source of truth (not transcript edit subjects) to catch untracked files / renames / formatter rewrites / shell-generated edits; `repoRoot` normalized via `git rev-parse --show-toplevel`; structured patch cap (diffstat always complete + per-file hunk cap) instead of raw 40 KB truncation; distinct corrective envelopes for "no tool call" vs "validation failed"; `block` severity requires `suggested_check`; `Set<number>` moved out of payload; memory-derived `openQuestions` removed (replaced by explicit `note`).
- 2026-05-20 — post-implementation peer review by Codex-1 round 3 (against shipped code). Block-level corrections applied:
  - **Routing bug fixed**: `handleReviewReply` was resolving requesterLane via `packet.toLaneId` (the reviewer); now uses `packet.fromLaneId` and verifies `reviewerLane.id === packet.toLaneId` (rejects with `unauthorized_reviewer` on mismatch).
  - **Prose-only reviewer hook added**: coordinator now tracks `assignedReviewPackets` (reviewer → packetId). `finishTurn` calls a new `checkProseOnlyReviewer` path on `end_turn`; if the reviewer ended its turn without a matching `review_reply`, the harness injects `composeMissingToolEnvelope` and increments the retry counter, or exhausts the budget and delivers `blockedByProtocol`.
  - **`cwd` removed from `review_request` schema**: Rust review_request no longer collects git (drops the optional `cwd` argument from the MCP tool); frontend listener resolves the lane's own cwd via `this.projectDir` and calls `acp_collect_review_git_state` directly. Agents now never need to know or pass `cwd`.
  - **UTF-8 safe truncation**: `safe_truncate(s, max_bytes)` walks backwards to the nearest `is_char_boundary`, replacing the panicking `&raw[..PER_FILE_HUNK_CAP]` slice.
  - **Rename parsing**: porcelain entries of the form `OLD -> NEW` now use the NEW path for `git diff HEAD -- <path>` instead of feeding the literal arrow string.
  - **Git flags hardened**: all diff invocations now use `--no-pager --no-ext-diff --no-textconv` to prevent user diff machinery (external drivers, textconv filters, pagers) from stalling the collector.
  - **Path normalization tightened**: validator now requires `file === repoRoot || file.startsWith(repoRoot + '/')` instead of bare `startsWith`, blocking `/repo-rooted-other/...` from being accepted under `/repo`. `..` segments rejected via per-segment check.
  - **Retry constant renamed** `REVIEW_PROTOCOL_RETRY_BUDGET` → `REVIEW_PROTOCOL_MAX_ATTEMPTS = 2` with doc comment "max total review_reply attempts per packet (initial + retries)" to match observed behavior.
  - **Unused `reviewRequestedThrough` field removed** — `reviewedThrough` alone drives signal assembly.
- 2026-05-20 — peer review by Codex-1 round 2 (grilled). Spec rescoped to **V0.5** per user direction. Block fixes applied: (1) `hasStagedChanges` / `hasUnstagedChanges` / `partialStagingDetected` packet metadata + reviewer-prompt warning to prevent reviewing pre-staged unrelated work; (2) `evidence` field cut entirely (was declared in TS but not in tool schema/prompt — dead code); (3) `worktreeFingerprint` (sha256 of HEAD + porcelain + changed-path size/mtime) computed at request time and recomputed at reply time to drive a `worktree changed since review request` banner on the review card. Other changes: split markers `requestedThrough` vs `reviewedThrough` so protocol-failed reviews don't silently drop unreviewed work; synchronous in-flight guard before any async git collection; stale-reply discard via `cancelledPacketIds` set; no-git mode rejects request rather than degrading. Deferred to V1+: palette action, mirrored card, evidence schema, unresolved-failure derivation, `ToolPayload.exitCode` extension, no-git absolute-path mode, per-finding expansion, submodule/symlink/mode-change handling.
