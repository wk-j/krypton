# issue_progress Auto-Bind — Implementation Spec

> Status: Implemented
> Date: 2026-07-06
> Milestone: M — ACP Harness / GitHub issue-fixing (extends spec 178)

## Problem

`issue_progress` only succeeds when an issue↔lane **binding already exists**, and a
binding is created **only** by `dispatchIssue` (the extension's "Fix in Krypton"
card, `#fix-issue`, or the palette). A lane that picks up an issue **directly in
the harness** — the user just tells it to fix `owner/repo#151` in conversation —
has no binding, so the tool returns `no_binding`, and the lane has to fall back to
editing the GitHub label by hand. The status card and lane-monitor never reflect
the work.

`issue_progress` should always work: both the browser-plugin dispatch path (already
does) and a lane working an issue directly in the harness (currently fails).

## Solution

When `issue_progress` arrives with a valid `issue_key` and **no binding**, the
harness **auto-binds** the issue to the reporting lane (self-register) and then
applies the phase update — instead of rejecting. A valid `issue_key` is all that is
required; the harness parses `owner/repo#123` (the same parser dispatch uses),
creates the `IssueBinding` against the calling lane, sets the lane's goal chip, and
lazily enriches the title via `gh` in the background. The misroute guard is kept: a
key already bound to a **different live lane** still returns `wrong_lane`; a binding
whose lane is **gone** (stale, e.g. post-restart) is taken over by the reporting
live lane, mirroring `dispatchIssue`'s stale-binding handling.

## Research

- **Round-trip relay (Rust).** `issue_progress` (`hook_server.rs:2745`) is a thin
  relay: it validates `issue_key`/`phase`, emits `acp-issue-report`, and returns the
  frontend's `{ ok, reason }` verbatim as `Ok`/`Err`. All binding logic lives in the
  frontend (state authority, ADR-0007). **No Rust change is needed** — auto-bind is
  purely a frontend decision inside the `acp-issue-report` listener.
- **The reject site.** `acp-harness-view.ts:2546-2550`: `const binding =
  this.issueBindings.get(env.issueKey); if (!binding) { sendReply({ ok: false,
  reason: 'no_binding' }); return; }`. This is the only place `no_binding` is
  produced. Line 2552 keeps `wrong_lane` when the binding's `laneId` differs.
- **Reusable building blocks already exist.** `parseIssueRef` (`:5493`) validates
  and extracts `{ repo, number, url }` from `owner/repo#123`; `fetchIssueMeta`
  (`:5510`) fetches title via `gh`, returning `null` on failure; `dispatchIssue`
  (`:5581-5599`) shows the exact `IssueBinding` shape, goal-chip set, `persist` +
  `publishIssueStatus` sequence to mirror; its stale-binding dedup (`:5544-5552`)
  is the precedent for taking over a dead lane's binding.
- **Latency.** The relay awaits a bus reply under `BUS_REPLY_TIMEOUT`. Auto-bind
  must not block the reply on `gh` (can take seconds). So bind with
  `title = issueKey` immediately, reply `ok`, then enrich the title in the
  background and re-publish — same "proceed with URL only" philosophy dispatch uses
  when `gh` is missing (`:5557-5561`, spec 178 §Dispatch Surfaces).

## Prior Art

Issue-fixing status tracking wired to an agent lane is a Krypton-specific concept
(spec 178) with no direct terminal-emulator equivalent. The closest analogue is
issue-tracker automation (e.g. GitHub Actions labelling a PR on state change, Linear
auto-linking a branch to an issue by naming convention). The relevant convention
those tools follow is **infer the link from context rather than demanding an explicit
pre-registration step** — which is exactly the gap this spec closes: the lane already
names the issue in `issue_key`, so requiring a separate prior dispatch is redundant.

**Krypton delta** — auto-bind makes `issue_key` the single source of the link.
Dispatch remains the richer entry (it spawns/targets a lane, fetches metadata up
front, sends the fix prompt); auto-bind is the lightweight tail for work that began
conversationally.

## Affected Files

| File | Change |
|------|--------|
| `src/acp/acp-harness-view.ts` | In the `acp-issue-report` listener, replace the `no_binding` rejection with an auto-bind path; add a private `autoBindIssue(lane, issueKey)` helper reusing `parseIssueRef`/`fetchIssueMeta`; take over stale bindings whose lane is gone. |
| `docs/178-github-issue-fixing.md` | Update the `issue_progress` contract + edge-cases sections to document auto-bind and the retired `no_binding` reason. |
| `docs/PROGRESS.md` | Add index entry for this spec. |

No Rust change. No browser-extension change (auto-bound issues simply show as bound
when their page is later opened — a positive side effect).

## Design

### Handler flow (`acp-issue-report` listener)

The listener callback becomes `async`. New order:

```
1. Filter by harnessId (unchanged).
2. lane = lanes.find(displayName === fromLaneId)
     → not found: reply { ok:false, reason:'unknown_lane' }  (unchanged)
3. binding = issueBindings.get(issueKey)
   3a. binding exists, binding.laneId === lane.id            → update (existing path)
   3b. binding exists, other lane is LIVE                    → reply 'wrong_lane' (unchanged)
   3c. binding exists, other lane is STOPPED/gone (stale)    → delete it, fall through to 3d
   3d. no binding                                            → autoBindIssue(lane, issueKey)
         → invalid key: reply { ok:false, reason:'invalid_issue_key' }
         → else: create binding, set goal, persist, publish; then fall through to update
4. Apply phase/summary/prUrl → persist → publishIssueStatus → reply { ok:true }
```

Steps 3d + 4 collapse: `autoBindIssue` returns the fresh `binding`, then the same
update block that 3a uses runs on it. Reply is sent **before** the background title
fetch resolves.

### `autoBindIssue(lane, issueKey)` — new private method

```ts
/** Self-register a binding for a lane reporting progress on an issue it picked up
 *  directly (no prior dispatchIssue). Mirrors dispatchIssue's binding creation but
 *  without spawning/targeting a lane or sending a fix prompt. Returns null on an
 *  unparseable issue_key. Title is enriched via gh in the background. */
private autoBindIssue(lane: HarnessLane, issueKey: string): IssueBinding | null {
  const ref = this.parseIssueRef(issueKey);
  if (!ref || !this.harnessMemoryId) return null;
  const now = Date.now();
  const binding: IssueBinding = {
    issueKey, issueUrl: ref.url, repo: ref.repo, number: ref.number,
    title: issueKey,                       // enriched below, in the background
    harnessId: this.harnessMemoryId,
    laneId: lane.id, laneDisplayName: lane.displayName,
    dispatchedAt: now, updatedAt: now,
  };
  this.issueBindings.set(issueKey, binding);
  if (!lane.goal) lane.goal = { text: `Fix #${ref.number}`, setAt: now };  // don't clobber an existing goal
  this.persistIssueBindings();
  this.publishIssueStatus(binding);
  // Background enrich: fetch title, then re-publish + refresh the goal chip.
  void this.fetchIssueMeta(ref.repo, ref.number).then((meta) => {
    const t = meta?.title?.trim();
    if (!t || this.issueBindings.get(issueKey) !== binding) return;
    binding.title = t;
    if (lane.goal && lane.goal.text === `Fix #${ref.number}`)
      lane.goal = { text: `Fix #${ref.number}: ${t}`.slice(0, 200), setAt: binding.dispatchedAt };
    this.persistIssueBindings();
    this.publishIssueStatus(binding);
    this.render();
  });
  return binding;
}
```

### Reason codes

| Reason | Before | After |
|--------|--------|-------|
| `unknown_lane` | reporting display name not a live lane | unchanged |
| `wrong_lane` | key bound to another lane | key bound to another **live** lane only |
| `no_binding` | no binding for key | **retired** — auto-bind creates one |
| `invalid_issue_key` | — | **new** — `issue_key` fails `parseIssueRef` |

## Edge Cases

- **Unparseable `issue_key`** → `invalid_issue_key`, no binding created (the tool
  requires `owner/repo#123`; garbage in stays out).
- **`gh` missing/unauthed** → binding still created with `title = issueKey`; goal
  chip shows `Fix #<n>`; background enrich silently no-ops (matches dispatch).
- **Stale binding after restart** (bound lane `stopped`) → the reporting live lane
  takes it over, so a lane resuming a fix across a restart can keep reporting.
- **Two live lanes, same issue** → first to bind wins; the second gets `wrong_lane`
  (the misroute guard that spec 178 exists to enforce).
- **Reply latency** → reply is sent before the `gh` fetch; round-trip stays within
  `BUS_REPLY_TIMEOUT` regardless of `gh` speed.
- **Manually-set lane goal** → auto-bind sets the goal chip only when the lane has
  none, so it never clobbers a user/agent-set goal.

## Out of Scope

- Spawning or targeting lanes from `issue_progress` (that stays dispatch-only).
- Sending a fix prompt on auto-bind (the lane is already working).
- Any Rust or browser-extension change.
- GitHub Enterprise hosts (still `github.com` only, per spec 178).

## Resources

N/A — purely internal change; all references are in-repo (spec 178,
`hook_server.rs`, `acp-harness-view.ts`).
