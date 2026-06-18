# Scope Memory to Handoff Only — Implementation Spec

> Status: Implemented
> Date: 2026-06-18
> Milestone: M-ACP — Harness
> Refines: `docs/98-acp-harness-memory-on-demand.md` (spec 98), `docs/75-acp-harness-lane-memory.md` (spec 75), `docs/139-default-memory-handoff.md` (spec 139)

## Problem

The harness memory tools (`memory_set` / `memory_get` / `memory_list`) were framed as an **ambient shared scratchpad**: the per-turn context packet advertised them on every prompt ("Shared memory is available… call `memory_set` to record state for future turns / to update your own… `memory_get { lane }` to read another lane"), and the Rust tool descriptions reinforced it (`memory_set` = *"a living README other agents in this tab will read"*, `memory_list` = *"discover what other agents are doing"*).

Two problems with that framing, surfaced in review:

1. **Marginal value in steady state.** Within a single session a lane already retains its own working state in context, so an ambient "record state for future turns" scratchpad adds little until the session/process ends. The genuine durable use is **cross-session handoff** — which spec 139 already deliberately made explicit (`#handoff` / `#resume`), not ambient.
2. **Correctness hazard (stale read).** A memory document is an overwrite **snapshot** of mutable truth (repo, code, decisions) frozen at write time. `updated_at` gives recency, not validity — a doc written minutes ago can already be wrong if a file changed. There is no invalidation. A lane that reads memory and acts on it without re-verifying against the live repo can reintroduce a fixed bug or repeat undone work. Advertising memory ambiently every turn invites exactly that misuse. This is the classic *treat-a-cache-as-source-of-truth* failure of the shared-memory paradigm; `peer_send` does not share it to the same degree because a peer reply is **computed fresh** by a live lane at reply time.

## Solution

Scope the memory tools to their one durable, deliberate role: the **backing store for `#handoff` / `#resume`**. Concretely:

- **Remove the ambient memory stub from the per-turn packet** (`renderPromptMemoryPacket`). Memory is no longer named on every turn. The `#handoff` / `#resume` prompts already name the exact tools + argument shape when the user invokes them, so the model still reaches them at the right moment — without a per-turn nudge to use them as a scratchpad. The inter-lane **peering** paragraph (a separate mechanism, `peer_send`) is unchanged.
- **Reword the Rust tool descriptions** so the model's tool-use view matches: `memory_set` = "write your lane's single **handoff document** — the resume point a future session (or another lane picking up your work) reads"; `memory_get` = "read a lane's handoff document… treat the contents as a possibly-stale snapshot; verify against the live repo before acting"; `memory_list` = "list lanes that have a saved handoff." The reference-by-path discipline (a path stays verifiable; a pasted copy goes stale) is stated in `memory_set`'s description, reinforcing what the `#handoff` prompt already instructs.

**Cross-lane read is kept.** `memory_get { lane }` / `memory_list` can still read *another* lane's handoff (you can read any lane, write only your own). This stays within "handoff only" — it is reading a handoff to pick up work, not a shared scratchpad — and required no logic change, only rewording. Writes remain self-only (enforced by the per-lane server URL, unchanged).

**No exceptions.** Review (Cursor-4, architecture & correctness) surfaced one remaining scratchpad use: the `#polly` orchestrator (spec 164) was told to maintain a `## Polly tasks` section in `memory_set` and was granted "edit your lane memory" in its role prompt. The author flagged whether to keep that as a pragmatic exception; the user decided memory is handoff-only with **no exceptions**, so `#polly` was realigned to track task/worker status in its own working context (see Affected Files). The orchestrator already retains that state in context across the orchestration turns, so the scratchpad was redundant anyway.

No change to: the MCP tools' registration, write-path logic, per-project disk persistence + on-startup restore, the memory drawer UI (`⌘M`), or the `#handoff` / `#resume` commands themselves.

## Affected Files

| File | Change |
|------|--------|
| `src/acp/acp-harness-view.ts` | `renderPromptMemoryPacket()`: drop both ambient memory stub lines (multi-lane and single-lane); keep the peering paragraph under `hasPeers`. Added a comment explaining the handoff-only scoping + stale-read rationale. |
| `src-tauri/src/hook_server.rs` | `bus_tool_descriptors()`: reword the `memory_set` / `memory_get` / `memory_list` descriptions from shared-scratchpad framing to handoff-store framing (incl. the stale-snapshot caveat on `memory_get` and the reference-by-path discipline on `memory_set`). No logic change. |
| `src/acp/polly.ts` | **No exceptions (user decision after review):** the `#polly` orchestrator role prompt no longer grants "edit your lane memory", and step 5 of `pollyRequestPrompt` no longer tells the orchestrator to maintain a `## Polly tasks` scratchpad in `memory_set` — it tracks task/worker status in its own working context across turns instead. Memory is reserved for `#handoff`/`#resume`. |
| `src/acp/polly.test.ts` | `pollyRequestPrompt` assertion updated from `memory_set` (scratchpad task board) to `working context`. |
| `docs/165-memory-handoff-only.md` | This spec. |
| `docs/98-acp-harness-memory-on-demand.md`, `docs/75-acp-harness-lane-memory.md`, `docs/139-default-memory-handoff.md`, `docs/164-polly-orchestration.md` | Banner / note pointing here; `docs/98` also corrects a stale "(full roster)" claim about `memory_list` (it lists only lanes with a saved document). |
| `docs/PROGRESS.md` | Spec 165 entry. |
| `CLAUDE.md` | Note that memory is scoped to the handoff store for `#handoff`/`#resume`. |

## Edge Cases

- **Memory available but never advertised.** The packet no longer mentions memory in steady state; discovery is via the help drawer (`#handoff` / `#resume` rows) and the injected command prompts. Acceptable — the commands name the tools explicitly.
- **Non-Claude / no-MCP lane (Pi).** Unchanged: `#handoff`/`#resume` inject the instruction, the lane states it has no memory tools. Same tolerance as spec 98/139.
- **Memory bus unavailable (`!harnessMemoryId`).** The existing early-return "Continue without krypton-harness-memory MCP tools" line is unchanged (it covers the whole bus, not just memory).

## Resources

- `src/acp/acp-harness-view.ts` — `renderPromptMemoryPacket()` (packet stub), `runHashCommand()` `#handoff`/`#resume` branches, `HANDOFF_WRITE_PROMPT` / `handoffResumePrompt`.
- `src-tauri/src/hook_server.rs` — `bus_tool_descriptors()` (tool descriptions), `memory_set` / `memory_get` / `memory_list` (logic, unchanged), per-project persistence + on-startup restore.
- `docs/139-default-memory-handoff.md` — the `#handoff` / `#resume` commands this scopes memory to.
- `docs/98-acp-harness-memory-on-demand.md` — the pull-on-demand stub model this refines.
