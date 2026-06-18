# User-Triggered Memory Handoff — Implementation Spec

> Status: Implemented. Redesigned to **user-triggered** per user direction (the always-on draft Codex-1 reviewed was rejected).
> Date: 2026-06-02
> Extends: `docs/98-acp-harness-memory-on-demand.md` (spec 98), `docs/76-acp-harness-memory-persistence.md` (spec 76)
> Updated by [docs/165-memory-handoff-only.md](165-memory-handoff-only.md): the lane-context stub described as "unchanged / only states that memory exists" below was *subsequently* changed — spec 165 removed the ambient memory stub entirely, so `#handoff` / `#resume` are now the ONLY surfaces that name the memory tools. The mechanism in this spec is otherwise intact.

## Problem

Krypton already has the substrate for cross-session handoff — `memory_set { summary, detail }` writes one persisted, per-project document per lane, and `memory_get` reads it back — but nothing makes a lane *use* it as a handoff. The lane-context stub (`renderPromptMemoryPacket`) only states that memory exists; it never tells a lane to (a) resume from its own prior memory or (b) keep that document in a handoff shape (what's done, current state, references, next steps).

The user wants handoff to work, but **not as an always-on convention like attention-triage or live memory**. Always-on handoff is expensive in a way the other default-on behaviors are not: attention-triage and peering add only cheap stub text, but baking handoff into every prompt pushes the lane to *do real work proactively* — read its memory at the start of every session (an unconditional `memory_get` round-trip) and rewrite its `memory_set` doc at every checkpoint (extra output tokens), whether or not anyone wants a handoff this session. **Handoff should be triggered by explicit user request only**, so the cost is paid exactly when the user asks for it.

## Solution

Add two **hash-commands** to the harness composer, mirroring the existing `#new` / `#cancel` / `#restart` / `#mem` family, each injecting a single one-shot instruction turn into the active lane via `enqueueSystemPrompt()`:

- **`#handoff`** — "Write/refresh your `memory_set` handoff document now: what's done, current state, next steps, open questions. Reference files/commits/artifacts by path rather than pasting them. Never write secrets/tokens/credentials. Overwrite, don't accrete; keep detail under 8000 characters."
- **`#resume`** — "Call `memory_get { lane: \"<this lane's display name>\" }`, load your handoff from a previous session, and continue from it."

No always-on stub line, no automatic `memory_get` on session start, no per-lane resume flag, and no per-turn cost. The lane-context stub is **unchanged**. No new MCP tools, no new directive, no skill, no Rust changes. The handoff *shape* lives in the injected command text, the *store* is the existing `memory_set` document, and the *trigger* is the user typing the command.

## Research

- Hash-commands are parsed in `runHashCommand()` (`src/acp/acp-harness-view.ts:4942`), dispatched from the composer submit path when `text.startsWith('#')` (`:3285`). Each branch typically clears the draft (`setDraft(lane, '', 0)`) and performs its action. `#handoff` / `#resume` slot in as two new `parts[0]` branches.
- `enqueueSystemPrompt(lane, text, drain?)` (`:1231`) is the exact mechanism for injecting a programmatic user-turn: it requires `lane.client` to exist and `lane.status` to be `idle` or `awaiting_peer`, sets the lane busy, and calls `lane.client.prompt([{ type:'text', text }])`. This is what `#handoff` / `#resume` use (with no `drain` context — they are not coordinator drains). Guard exactly like `newLaneSession()`: if the lane is `busy`/`needs_permission`/`starting`, `flashChip('lane busy - #cancel first')` and return.
- Memory availability is gated by `this.harnessMemoryId` (see `newLaneSession` `:4873` and the `#mem clear` path). Both commands require memory; if `!this.harnessMemoryId`, `flashChip` the same "memory unavailable" message and do not inject.
- Hash-commands have **no autocomplete palette** — the `/`-palette (`filteredSlashCommands`, `:9259`) is for ACP-provided `lane.availableCommands` only. Hash-commands are surfaced solely through the help drawer command list (`:6535-6543`). So `#handoff` / `#resume` need a help-drawer `<dt>/<dd>` entry, nothing more.
- `memory_set` (`src-tauri/src/hook_server.rs:2039`) overwrites the lane's single document (≤ 8000 chars detail, ≤ 300 summary), persists it to disk, and **restores it on startup** — so a `#resume` in a fresh app session in the same project sees the prior `#handoff` doc. `memory_set` does **no secret redaction**, so the "never write secrets" instruction must live in the injected `#handoff` text; the store will not enforce it.
- The session that produced this spec began with the user literally typing **"Continue handoff"** — natural-language confirmation that resume is a user gesture, which is exactly what `#resume` formalizes into a deterministic, model-agnostic command.

- **Alternatives considered.** (1) *Always-on stub convention + once-per-session resume flag (the original spec 139 design, reviewed by Codex-1 who endorsed the hybrid flag).* Rejected by the user: pays per-turn token cost and pushes proactive `memory_get`/`memory_set` work even when no handoff is wanted. The flag/reset-site machinery (`handoffResumeHinted`, resets in `restartLane`/`newLaneSession`) is entirely dropped because an explicit command needs no "is this the first turn?" signal. (2) *Natural-language only* — zero code; rely on the model interpreting "continue handoff" plus tool-description hints. Cheapest, but non-deterministic and weakest for non-Claude lanes (Pi/Codex/Cursor) that may not infer the handoff shape. The command gives a deterministic, model-agnostic injection. (3) *Tool-description change in Rust* — reinforces shape on every tool consideration but is always-present (mild constant cost), pulls the change into Rust, and contradicts spec 98's "don't touch tool descriptions." Left out of scope. (4) *Auto-write a handoff on session end via a lifecycle hook* — writes without the model's judgment and can clobber a better hand-authored doc; rejected.

## Prior Art

| App / Tool | Implementation | Notes |
|------------|----------------|-------|
| mattpocock `handoff` skill | A *user-invoked* skill that compacts the session into a transition doc, references artifacts by path (no duplication), redacts secrets, lists suggested next-session skills. | The feature we're matching — and it is **user-invoked**, not ambient. We match it as a hash-command over persisted memory rather than an installed skill / temp-dir file. |
| Krypton `#new` / `#new!` / `#mem clear` | User-typed hash-commands that perform a lane lifecycle action and clear the draft. | The exact pattern `#handoff` / `#resume` follow. |
| Claude Code `/compact` | A user-invoked command that compacts context on demand, not every turn. | Confirms "compaction/handoff is a deliberate user gesture, not ambient." |

**Krypton delta** — Handoff is neither a separate artifact/skill nor an always-on convention; it is two composer commands that inject a one-shot instruction to read or refresh the lane's existing `memory_set` document. Cost is paid only on the user's command. Storage is per-project and persisted; redaction is instructed in the injected text, not enforced.

## Affected Files

| File | Change |
|------|--------|
| `src/acp/acp-harness-view.ts` | Add `#handoff` and `#resume` branches to `runHashCommand()` (`:4942`). Each: clear the draft; if `!this.harnessMemoryId` → `flashChip` "memory unavailable" and return; if lane not `idle`/`awaiting_peer` → `flashChip('lane busy - #cancel first')` and return; else `await this.enqueueSystemPrompt(lane, <command text>)`. `#resume` interpolates `lane.displayName` into the `memory_get { lane: "…" }` text. Add the two `<dt>/<dd>` rows to the help-drawer command list (`:6535`). |
| `docs/72-acp-harness-view.md` | Document the `#handoff` / `#resume` commands in the composer/commands section. |
| `docs/05-data-flow.md` | Note the user-triggered handoff flow (command → `enqueueSystemPrompt` → lane reads/writes memory). |
| `docs/PROGRESS.md` | Add spec 139 entry. |

No `types.ts` change (no new lane state). No new Tauri commands. No new MCP tools. No change to the memory store, persistence, or `memory_set`/`memory_get`/`memory_list`. The lane-context stub (`renderPromptMemoryPacket`) is untouched.

## Design

### `#handoff` — injected text

```
Write or refresh your memory_set handoff document now so a future session can
resume. Shape it as: what's done, current state, next steps, open questions.
Reference files, commits, and artifacts by path rather than pasting their
contents. Never write secrets, tokens, or credentials (this document is not
redacted). Overwrite your existing document, don't accrete; keep detail under
8000 characters.
```

### `#resume` — injected text

```
Call memory_get { lane: "<displayName>" } to load your handoff document from a
previous session, then continue the work from where it left off. If the
document is empty or missing, start fresh.
```

`<displayName>` is filled with the active lane's exact `lane.displayName` (e.g. `"Claude-1"`) so the model can copy the argument verbatim.

### `runHashCommand` branches (sketch)

```ts
if (parts[0] === '#handoff') {
  this.setDraft(lane, '', 0);
  if (!this.harnessMemoryId) { this.flashChip('memory unavailable - use #new'); return; }
  if (lane.status !== 'idle' && lane.status !== 'awaiting_peer') {
    this.flashChip('lane busy - #cancel first'); return;
  }
  await this.enqueueSystemPrompt(lane, HANDOFF_WRITE_PROMPT);
  return;
}
if (parts[0] === '#resume') {
  this.setDraft(lane, '', 0);
  if (!this.harnessMemoryId) { this.flashChip('memory unavailable - use #new'); return; }
  if (lane.status !== 'idle' && lane.status !== 'awaiting_peer') {
    this.flashChip('lane busy - #cancel first'); return;
  }
  await this.enqueueSystemPrompt(lane, resumePrompt(lane.displayName));
  return;
}
```

(`enqueueSystemPrompt` itself re-checks `lane.client` and status; the explicit guard above is for the user-facing `flashChip` feedback, matching `newLaneSession`.)

### Data Flow

```
1. User types #handoff (or #resume) in the active lane composer and submits.
2. Composer submit sees text.startsWith('#') → runHashCommand(lane, text) (:3285).
3. Branch clears the draft, checks memory availability + lane idle, then calls
   enqueueSystemPrompt(lane, <one-shot instruction>).
4. The lane runs one turn: #handoff → memory_set { summary, detail } (handoff doc);
   #resume → memory_get { lane: self } then continues the work.
5. hook_server persists the memory_set doc to disk; a later session (even after
   app restart) recovers it via #resume.
6. No further cost until the user types a handoff command again.
```

## Edge Cases

- **Lane busy / needs-permission / starting** → `flashChip('lane busy - #cancel first')`, no injection. `awaiting_peer` is **allowed** (not blocked): a soft-awaiting lane (spec 116) may still do user-directed work, and `enqueueSystemPrompt()` itself accepts `idle`/`awaiting_peer`. So the gate is *not* identical to `#new` (which blocks `awaiting_peer` implicitly via its own status check) — it matches the `enqueueSystemPrompt` contract.
- **Memory unavailable** (`!this.harnessMemoryId`) → `flashChip` "memory unavailable", no injection. Both commands are no-ops without the hook server.
- **Pi / no-MCP lane** → `enqueueSystemPrompt` still injects the instruction, but the lane cannot call `memory_get`/`memory_set`; it will simply state it has no memory tools. Informational only, same tolerance as spec 98. (Optional refinement: skip injection for lanes without harness-memory tools — out of scope unless requested.)
- **`#resume` with empty prior memory** → `memory_get` returns `{ entry: null }`; the injected text tells the lane to start fresh. Acceptable.
- **`#handoff` mid-work** → writes the current state as the handoff; overwrites the previous doc by design (`memory_set` is not append).
- **Secrets** → not redacted by the store; the `#handoff` text instructs the model not to write them. Residual risk is the model disobeying — accepted (same trust posture as the rest of the memory feature).
- **`#resume` on a brand-new lane that never had a session** → reads null memory, starts fresh. Harmless.

## Resolved Questions

- **Always-on vs user-triggered? → user-triggered (user decision).** Handoff pushes proactive read/write work, unlike the cheap always-on stub behaviors; cost should be paid only on explicit request.
- **Trigger surface? → hash-commands `#handoff` / `#resume` (option 1, user pick).** Deterministic, discoverable in the help drawer, and model-agnostic (injects explicit instruction text rather than relying on the model to infer intent), so it works the same for Claude, Codex, Pi, Cursor, etc. Natural-language-only and tool-description options were declined as non-deterministic / out of scope.
- **Resume mechanism (from the prior always-on design)?** Codex-1 endorsed a once-per-session flag (`handoffResumeHinted`) *under the always-on assumption*. That machinery is **moot under the command design** — an explicit `#resume` needs no first-turn signal — so the flag, the `types.ts`/`HarnessLane` field, and the `restartLane`/`newLaneSession` reset sites are all dropped.

## Out of Scope

- Any always-on / per-turn handoff stub in `renderPromptMemoryPacket()`.
- Editing the `memory_set` / `memory_get` / `memory_list` tool descriptions in `hook_server.rs` (could reinforce the handoff shape on every tool consideration, but spec 98 kept descriptions unchanged and this keeps the change frontend-only).
- Auto-writing a handoff on session end via a lifecycle hook.
- A new directive, skill file, or `/`-palette command (hash-commands are not in the slash palette).
- Skipping injection for non-MCP lanes (possible refinement; not required for v1).
- Cross-project handoff (memory is per-project by design).

## Resources

- `docs/98-acp-harness-memory-on-demand.md` — the pull-on-demand stub model; precedent for "agent decides when to read/write" and "no tool-description changes."
- `docs/76-acp-harness-memory-persistence.md` — the per-project persisted store that makes cross-session resume possible.
- `src/acp/acp-harness-view.ts:4942` — `runHashCommand` (the `#new`/`#cancel`/`#restart`/`#mem` family `#handoff`/`#resume` join).
- `src/acp/acp-harness-view.ts:1231` — `enqueueSystemPrompt` (one-shot injection mechanism + idle/client guards).
- `src/acp/acp-harness-view.ts:3285` — composer submit hash-command dispatch.
- `src/acp/acp-harness-view.ts:6535` — help-drawer command list.
- `src-tauri/src/hook_server.rs:2039` — `memory_set` (overwrite, char caps, no redaction); on-startup restore makes `#resume` work across app restarts.
- https://github.com/mattpocock/skills/blob/main/skills/productivity/handoff/SKILL.md — the user-invoked handoff skill being matched as composer commands rather than an installed skill.
</content>
</invoke>
