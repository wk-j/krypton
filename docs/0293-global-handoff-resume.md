# Global Handoff Resume — Implementation Spec

> Status: Implemented (2026-10-13)
>
> **Implementation deviations** — everything else landed as written:
> 1. **A project Xenon has never seen lists as empty.** `GET …/resources` answers `404` until the
>    first push; `#resume` treats that as "no remote handoffs" instead of a reason line on every resume.
> 2. **`#resume` reserves the lane before the Xenon reads** and dispatches the prompt itself (as
>    `#review` does) instead of `enqueueSystemPrompt`, so peer mail or a typed prompt cannot take the
>    lane during the ≤5 s read. The `resumed …` line is appended before the prompt, so it sits above
>    the reply.
> 3. **Xenon browse opens a handoff on `handoff.md`** (`ENTRY_FILES` in `xenon/src/web.rs`).
> 4. **Live wire test** `handoff_round_trips_through_the_read_path` added to `src-tauri/tests/xenon_live.rs`.
> Date: 2026-10-13
> Milestone: M-ACP — Harness convergence
> Builds on: 139 (`#handoff` / `#resume`), 165 (memory is handoff-only), 212 (Xenon), ADR-0016
> Decisions: ADR-0022 (handoffs are the one resource pulled from Xenon), ADR-0023 (a handoff belongs
> to a work thread, not a lane)

## Problem

A handoff is keyed by lane label and `#resume` reads only the resuming lane's **own** label. Lane
labels do not identify work: the counter resets on every app start and increments within a run
(`harness-directory.ts:32-38`). After a restart, `Claude-1` silently resumes yesterday's unrelated
`Claude-1` doc, and a new `Claude-4` finds nothing. Handoffs also never leave the machine.

## Solution

A handoff becomes a **project-level document with its own id**, not a lane slot. `#resume` with no
argument resumes the **newest handoff in the project**, from the local store and — when Xenon is
configured — from Xenon, whichever lane, backend, or machine wrote it. `#resume list` opens the
handoff picker overlay over those rows and `#resume <id>` picks one directly. Krypton resolves the
document and injects its text as a one-shot prompt, so every backend can resume (no tool or MCP
needed). A lane that resumes handoff `H` adopts
`H`, so its next `#handoff` continues the same thread instead of creating a new one.

## Research

- **Store today** (`hook_server.rs:467-592, 2091-2109, 5469-5577`): one `HashMap<label, doc>` per
  harness instance `hm-N`, loaded from `~/.config/krypton/acp-harness-memory/<hash16>.json` at tab
  creation and written back whole. Two tabs on one project overwrite each other. A project-level
  store fixes that as a side effect of the new model.
- **Real data** (this repo's store): 9 lane slots, 2026-05-04 → 2026-10-12, including `Gemini-1`,
  a backend since removed from the Harness. The lane key keeps dead slots forever.
- **Readers of the lane key**: `#resume` prompt (`harness-prompts.ts:18`), MCP `handoff_get` /
  `handoff_list`, control ops `memory.get/clear <lane>` (`kryptonctl.rs:131-135`), the memory
  drawer, and `clear_harness_memory_lane`.
- **Xenon read path exists**: list `?kind=` (title, slug, `updated_at`), `GET /v1/resources/{id}`,
  `GET /v1/revisions/{rev}/files/{*path}`, bearer + `resource:read` (`xenon/src/api.rs:59-72,
  895-966`). The kind list is closed on server, Xenon CLI, Rust `KINDS`, and TS `XENON_KINDS`.
- **Alternatives ruled out.** *Keep lane slots, resume newest slot*: still overwrites parallel work
  when a label recurs and keeps dead slots. *One project-wide document*: two parallel lanes clobber
  each other's handoff. *MCP pull tool*: an agent could pull remote content on its own (ADR-0016's
  rejected path) and non-MCP lanes could not resume.

## Prior Art

| Tool | Implementation | Notes |
|---|---|---|
| Claude Code `--continue` / `--resume` | `--continue` resumes the most recent session in the directory; `--resume` opens a picker | Same "newest by default, pick if needed" shape |
| OpenCode | `--continue` = last session; `session import <share-url>` restores another machine's session | Full transcript, same backend only |
| mattpocock `handoff` skill | Transition doc referencing artifacts by path | Document shape spec 139 already uses |

**Krypton delta** — the unit is the agent-written handoff, so a Claude lane can continue an OpenCode
lane's thread on another machine. Default/pick split matches `--continue` / `--resume`.

## Affected Files

| File | Change |
|---|---|
| `src-tauri/src/hook_server.rs` | project-level `ProjectHandoffStore` shared by every tab of a project (ref-counted by harness id); v1→v2 file migration; lane→handoff bindings; `handoff_set` writes the bound handoff and its description drops lane-slot wording; remove `handoff_get` / `handoff_list` tools |
| `src-tauri/src/commands.rs`, `lib.rs` | `list_harness_memory` returns handoffs; new `handoff_bind`, `handoff_unbind`; `xenon_push` takes `handoffs`; new `xenon_handoff_list`, `xenon_handoff_fetch` |
| `src-tauri/src/xenon.rs` | `KINDS += "handoff"`; `handoff_resources`; read calls `list_kind`, `fetch_handoff` |
| `src/acp/types.ts` | `HarnessMemoryEntry` → `HandoffEntry { id, author, host, summary, detail, createdAt, updatedAt }` |
| `src/acp/xenon-push.ts` | `XENON_KINDS += 'handoff'`; `parseResumeCommand`; merge/select helpers |
| `src/acp/harness-prompts.ts` | `HANDOFF_WRITE_PROMPT` reworded to "this work's handoff"; `handoffResumePrompt(doc)` takes the document |
| `src/acp/acp-harness-view.ts` | `#resume` forms; bind on resume, unbind on `#new`/`#new!`/`#restart`/close; drawer rows; control `memory.*`; `auto_push` on memory-changed; remote guard |
| `src/acp/harness-permission-scan.ts` (+ test) | drop `handoff_get`, `handoff_list` |
| `src/acp/hash-commands.ts` | help rows |
| `~/Source/xenon/src/api.rs`, `cli/src/push.rs`, `docs/01-protocol.md` | add `handoff` kind; `resource.updated_at` moves only when a revision seals (today it moves on every manifest POST, `api.rs:423-426`, so no-op and failed pushes reorder `?kind=` lists) |
| `docs/0139`, `0165`, `0212`, `0072`, `0005`, `0006`, `0175`, `adr/0016` | doc updates |

## Design

### Data Structures

```rust
struct Handoff {
    id: String,          // "ho-<base36 ms>-<6 hex>", globally unique; also the Xenon slug
    author: String,      // lane label at last write — display only, never a key
    host: String,        // hostname at last write
    summary: String,     // ≤ 300
    detail: String,      // ≤ 8000
    created_at: u64,
    updated_at: u64,
}
struct PersistedHandoffs { version: u32 /* 2 */, project_dir: String, saved_at: u64, handoffs: Vec<Handoff> }
struct ProjectHandoffStore {
    handoffs: Vec<Handoff>,                          // newest first, capped at 50
    bindings: HashMap<(String, String), String>,     // (harness_id, lane label) → handoff id; memory only
    persistence_path: Option<PathBuf>,
    save_pending: Arc<AtomicBool>,
}
// HookServer: handoff_stores: HashMap<String /* canonical project dir or "hm-N" if none */, ProjectHandoffStore>
```

Migration: a v1 file (`lanes: { label: { summary, detail, updatedAt } }`) loads as one handoff per
slot, `id` freshly minted, `author` = label, `created_at` = `updated_at`, `host` = this machine.

### Write — `#handoff` (unchanged command)

`handoff_set { summary, detail }` from lane `L` in tab `T`: if `(T, L)` is bound to `H`, overwrite
`H`; otherwise mint a new handoff and bind `(T, L)` to it. Empty summary + detail deletes the bound
handoff and drops the binding. Each write emits `acp-harness-memory-changed`; with
`auto_push = ["handoff"]` the frontend pushes that one handoff.

### Resume — `#resume`

| Command | Action |
|---|---|
| `#resume` | newest handoff in the project, local ∪ Xenon |
| `#resume list` | opens the handoff picker overlay (`j`/`k` move, `Enter` resumes, `Esc` closes) over the merged rows: `id · age · host · author · summary` and source `local`/`xenon` — see [307](0307-handoff-picker.md) |
| `#resume <id>` | that handoff; unique prefix of ≥ 4 chars after `ho-` accepted |

```
1. Guard: lane idle (else "lane busy - #cancel first"), store available.
2. local  = list_harness_memory.
   remote = xenon_handoff_list (only if [xenon].enabled; 5 s budget): GET resources?kind=handoff
            (newest by seal time), then GET /v1/resources/{id} for the first 10 in parallel
            (concurrency 4) — the list carries no meta, and author/host/updatedAt live in meta.
3. Merge by id; per id keep the newer meta.updatedAt. Pick newest / by id.
   `#resume <id>` not in the first 10 remote → one extra list scan by slug.
4. If the pick's newest copy is remote: GET /v1/revisions/{rev}/files/handoff.md → detail.
5. handoff_bind(T, L, id)  — the lane now continues this thread.
6. enqueueSystemPrompt(lane, handoffResumePrompt(doc), …, 'resuming')
7. System line: "resumed ho-… · <author>@<host> · <age> · <source>".
```

`handoffResumePrompt(doc)` frames the document as possibly-stale data from another session: verify
files, branches, and commits against this checkout before acting; if something referenced is
missing, say so and stop for direction. The document follows inside a `<handoff>` block.

### Xenon resource

`kind = handoff`, `slug = id`, `title = summary`, `meta = { id, author, host, summary, createdAt,
updatedAt }`, `files = [handoff.md = detail]` (inline). `#push handoff [<id>]` publishes; secret
scan applies. Pull needs a token with `resource:read`; spec 212's setup text recommends
`resource:read` + `resource:write`. A lane on machine B that resumed `H` and runs `#handoff` writes
`H` locally, and the next push adds a revision to the same Xenon resource.

### Unchanged meanings

`memory.get` / `memory.clear <lane>` (control API, kryptonctl) address the handoff **bound** to that
live lane. The memory drawer (⌘M) lists handoffs newest first with author, host, and age.

### Configuration

None new. `auto_push = ["handoff"]` is the opt-in for publish-on-write.

## Edge Cases

- **No handoff anywhere** — chip `no handoff to resume`; nothing is injected.
- **Two live lanes bound to one handoff** — last write wins; on Xenon each write is its own revision.
- **`#new` / `#new!` / `#restart` / lane close** — unbind; the next `#handoff` starts a new thread.
- **Label reused after restart** — bindings are memory-only, so no stale binding exists.
- **Cap** — store keeps the 50 newest; eviction never removes a currently bound handoff.
- **Xenon disabled** — local only, silently. **Enabled but unreachable / `missing_scope`** — local
  only, plus a system line naming the reason.
- **Same id local and remote** — newer `updatedAt` wins; the fetched copy is not written locally (ADR-0022).
- **Remote harness tab** — ephemeral per-tab store, no Xenon (`REMOTE_UNSUPPORTED_HASH_COMMANDS`).
- **Xenon server without the `handoff` kind** — list returns `400 invalid_kind`; treated like unreachable, reason `server has no handoff kind — update Xenon`. Push of `handoff` fails the same way and is not queued.
- **Last tab of a project closes** — `dispose_harness_memory` drops its bindings; the project store is flushed and dropped when no tab references it.
- **Lane without MCP (Pi)** — resume works (injection); `#handoff` still needs `handoff_set`.

## Out of Scope

Agent-initiated pull · pulling any other kind · deleting a published handoff (admin
`DELETE /v1/admin/resources/{id}` exists) · cross-project resume · control-API ops for resume.

A picker overlay was out of scope here; [307](0307-handoff-picker.md) revisits it and makes
`#resume list` open one.

## Resources

- `claude --help` (local) — `-c, --continue` resumes the most recent conversation; `-r, --resume [id]` picks one
- [OpenCode — CLI](https://opencode.ai/docs/cli/) — `--continue`, `session import <share-url>`; import verified locally (v2.0.26)
- [OpenCode — Share](https://opencode.ai/docs/share/) — whole-session publish model not copied
- `docs/0212-xenon-resource-server.md`, `~/Source/xenon/docs/01-protocol.md` — read routes and scopes
