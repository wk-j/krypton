# Analysis: krypton#1 — Cursor lane harness MCP via native `.cursor/mcp.json`

**Verdict:** Valid bug with an upstream root cause (`cursor-agent` ignores ACP `session/new` `mcpServers` since ~`2026.05.27`); the working-tree Krypton fix (native config + `mcp enable`, skip `session/new` injection) is **correct for fresh spawn** and matches the Junie overlay pattern. **Peer review (Claude-1): APPROVE to commit** — no blockers; resolve **WARN-1** (session resume/load gap) or document as unsupported before closing #1.

---

## Issue context

| Field | Value |
|-------|--------|
| **Issue** | [#1 — Cursor lane: no harness MCP tools (peer_send/memory)](https://github.com/wk-j/krypton/issues/1) |
| **Type** | Bug (`bug` label) |
| **Symptom** | Cursor lane connects over ACP but reports no `peer_send`, `peer_list`, or `memory_*` tools; cannot peer or use shared harness memory |
| **Reporter evidence** | HTTP/stdio probe servers injected via `session/new` receive zero connections on `cursor-agent 2026.05.28`; native `.cursor/mcp.json` + `cursor-agent mcp enable` works |
| **Upstream** | Cursor forum + [Zed #50924](https://github.com/zed-industries/zed/issues/50924); Cursor team: dynamic MCP / `loadSession` not implemented despite advertised `mcpCapabilities` |
| **Regression timeline** (issue comment, owner-verified) | `2026.05.20` honors injection → `2026.05.27`/`2026.05.28` do not; silent `cursor-agent` auto-update repointed symlink |

---

## Root-cause analysis

### Primary cause (upstream)

`cursor-agent` in ACP mode accepts `session/new` with `mcpServers` without error and advertises `mcpCapabilities: { http: true, sse: true }`, but **does not connect** to injected servers (stdio never spawned, HTTP never contacted). This is **not** a Krypton transport bug: the issue author verified the probe server works via direct `curl`, and Zed uses the same injection mechanism and fails identically.

**Confirmed in issue/comments.** Not re-run in this analysis session (no `cursor-agent` bisect here).

### Secondary cause (Krypton design assumption)

Spec 113 (`docs/113-acp-cursor-lane.md`) assumed Cursor consumes `krypton-harness-memory` via the same `mcpServersForLane()` → `session/new` path as Codex/Gemini. Krypton **did** send the descriptor; Cursor never loaded it.

Relevant delivery path before fix:

```2497:2514:src/acp/acp-harness-view.ts
  private async mcpServersForLane(lane: HarnessLane, caps: unknown): Promise<AcpMcpServerDescriptor[] | undefined> {
    const memoryServers = this.memoryServerForLane(lane);
    // ...
    if (
      lane.backendId === 'claude' ||
      lane.backendId === 'pi-acp' ||
      lane.backendId === 'junie' ||
      lane.backendId === 'cursor' ||
      lane.backendId === 'omp'
    ) {
      return lane.backendId === 'junie' || lane.backendId === 'cursor' ? [] : memoryServers;
```

After fix, `cursor` is excluded from `session/new` (returns `[]`) and gets MCP via native config instead (see below).

### Ineffective mitigation removed

`--approve-mcps acp` on spawn (`builtin_backends()` cursor entry) did not help: approval is irrelevant when Cursor never attempts to connect to injected servers; `--approve-mcps` also has no effect in ACP mode per issue testing.

```94:105:src-tauri/src/acp.rs
            "cursor",
            AcpBackend {
                command: "cursor-agent".to_string(),
                // cursor-agent ignores MCP servers passed via ACP `session/new`
                // ...
                args: vec!["acp".to_string()],
                display_name: "Cursor".to_string(),
            },
```

---

## Implemented fix (working tree, uncommitted)

Mirrors **Junie overlay** (spec 119): deliver harness MCP through the backend’s native config loader, not `session/new`.

### Mechanism

1. **Before spawn** (`spawnLane`, cursor branch): write per-lane `krypton-harness-memory` HTTP URL into `<projectDir>/.cursor/mcp.json` (merge, preserve user entries), then `cursor-agent mcp enable <name>` with lane cwd/env.
2. **At initialize**: `mcpServersForLane` returns `[]` for `cursor` — no duplicate injection.
3. **On lane close**: remove krypton-written names from `.cursor/mcp.json`; delete file if empty shell.

### Key code sites

| Layer | File | Lines | Role |
|-------|------|-------|------|
| Spawn hook | `src/acp/acp-harness-view.ts` | 2422–2436 | `prepareCursorMcp(projectDir, memoryServerForLane(lane))` |
| Session/new skip | `src/acp/acp-harness-view.ts` | 2507–2514 | `cursor` → `[]` |
| Cleanup | `src/acp/acp-harness-view.ts` | 3557–3562 | `cleanupCursorMcp` on close |
| IPC wrappers | `src/acp/mcp-bridge.ts` | 327–337 | `toClaudeMcpFile` → Tauri invoke |
| Write + approve | `src-tauri/src/acp.rs` | 1539–1597 | `prepare_cursor_mcp` |
| Remove entries | `src-tauri/src/acp.rs` | 1604–1636 | `cleanup_cursor_mcp` |
| Commands registered | `src-tauri/src/lib.rs` | 227–228 | Tauri handler |

`prepare_cursor_mcp` merges `mcpServers`, writes pretty JSON, runs `cursor-agent mcp enable` per name (warn-only on failure so spawn still proceeds).

### What was verified (per issue comment #2, not re-run here)

- `cargo build`, `cargo clippy`, `cargo test acp` (32 pass), `npm run check`
- E2E on `2026.05.28`: `.cursor/mcp.json` + `mcp enable` + ACP session → `initialize → tools/list → tools/call` including **`peer_send`**

---

## Proposed fix assessment

| Aspect | Assessment |
|--------|------------|
| **Correctness** | Addresses the only path Cursor actually uses in ACP mode (native config + per-project approval) |
| **Pattern fit** | Consistent with Junie `--mcp-location` overlay; Cursor lacks `--mcp-location`, so project `.cursor/mcp.json` is the pragmatic choice |
| **Regression-proof** | Survives `session/new` injection breakage; will remain valid if upstream re-adds injection (harmless duplicate skip) |
| **Upstream recovery** | If `session/new` injection returns, native workaround can be dropped (documented in `docs/113`, `docs/06-configuration.md`) |

### Known limitations (documented in code/comments)

1. **Only `krypton-harness-memory`** — project `.mcp.json` bridge servers are **not** mirrored into `.cursor/mcp.json` for Cursor (`docs/06-configuration.md`).
2. **Repo mutation** — writes `<projectDir>/.cursor/mcp.json` (cleaned on lane close; merge preserves user servers).
3. **Concurrent Cursor lanes** — share one file per project; each spawn rewrites with its lane-specific memory URL; already-running lanes keep their loaded server (race/stale-URL risk under concurrency).
4. **`mcp enable` failures are non-fatal** — lane spawns anyway; tools may remain unavailable without surfacing a harness warning (unverified whether UI shows this clearly).
5. **No dedicated Rust unit tests** for `prepare_cursor_mcp` / `cleanup_cursor_mcp` (grep shows no `#[test]` targets; reliance on manual E2E).

---

## Alternatives and risks

| Alternative | Pros | Cons |
|-------------|------|------|
| Pin `cursor-agent` to `2026.05.20` | Restores `session/new` injection without repo files | Fragile (auto-update); forfeits newer fixes |
| Global `~/.cursor/mcp.json` | No repo pollution | Collides across projects/lanes; wrong per-lane URL |
| Wait for upstream | Zero workaround debt | Blocks harness peering/memory on Cursor lane indefinitely |
| Mirror project `.mcp.json` into `.cursor/mcp.json` | Feature parity with other lanes | Duplication risk (spec 113 open question); more merge/cleanup complexity |

**Risks to watch:** `.gitignore` for `.cursor/` if users commit accidentally; approval slug mismatch if `mcp enable` cwd/env differs from lane spawn (mitigated by using same `cached_login_env` + `project_dir` in Rust).

---

## Peer review (Claude-1, 2026-05-29)

**Outcome:** APPROVE to commit (fresh-spawn path). One WARN to address in follow-up; no hard blockers.

### Confirmed positives

- `prepare_cursor_mcp` uses `tokio::process::Command` (non-blocking async).
- Same `cached_login_env()` + `current_dir(project_dir)` as lane spawn → approval slug matches.
- Merge preserves user entries; corrupt file falls back to `{}`.
- `mcpServersForLane` cursor → `[]` avoids duplicate injection; cleanup on close wired.

### WARN-1 — Session resume/load reintroduces the bug (**confirmed in code**)

`prepareCursorMcp` runs only in `spawnLane` (`acp-harness-view.ts:2422–2436`). The session picker path does **not**:

| Step | Location | Behavior |
|------|----------|----------|
| Probe spawn | `loadSessionPickerBackend` :3408 | `AcpClient.spawn(backendId, projectDir, [])` — no `prepareCursorMcp` |
| Resume/load | `startSelectedSession` :3497–3498 | `mcpServersForLane` → `[]`, `setMcpServers([])` |
| Lane field | — | `cursorMcpNames` never set → cleanup skipped |

`cursor-agent` reads `.cursor/mcp.json` at **process start**, so config written after the probe is running cannot attach to that process. A resumed/loaded Cursor lane therefore has **no harness MCP** — the same gap as #1 on a real user path **if** Cursor advertises `sessionCapabilities.list`.

**Severity gate:** `loadSessionPickerBackend` :3411–3421 errors when `!capabilities.canList`. If current `cursor-agent` does not advertise `list`, the picker path is dead and WARN-1 is latent only. If it does advertise `list`, WARN-1 is user-visible.

**Fix options (from review):**

- **(a)** Confirm cursor `canList` at runtime; if false, document session resume as unsupported for Cursor in `docs/113` / #1.
- **(b)** Call `prepareCursorMcp` for `cursor` **before** probe spawn in `loadSessionPickerBackend`, set `lane.cursorMcpNames` in `startSelectedSession`, keep cleanup on close.

### WARN-2 — Project `.mcp.json` not mirrored (scope boundary)

Only `memoryServerForLane` is written to `.cursor/mcp.json`; project bridge servers never reach Cursor lanes (unlike Codex/Gemini/OMP). Acceptable for #1 (harness peer/memory only); must stay explicit in `docs/113` and the issue.

### WARN-3 — Concurrent Cursor lanes (confirmed)

Shared server name `krypton-harness-memory` → later spawn overwrites URL in one file; first close removes the name siblings may still need. Documented limitation; per-lane server names would be a future isolation improvement.

### Nits (discretionary)

1. Empty `memoryServerForLane` still writes `{"mcpServers":{}}`; `cursorMcpNames=[]` skips cleanup → possible file leak.
2. `cleanup_cursor_mcp` may delete user’s pre-existing empty `{"mcpServers":{}}` (low risk).
3. No crash-time GC for cursor (Junie has `gcJunieMcpOverlays`).
4. Document `.cursor/` in `.gitignore` guidance (`docs/06-configuration.md`).
5. `mcp enable` failure warn-only — consider `harnessMemoryWarning`-style UI.
6. Add Rust unit tests for merge/cleanup JSON (no `cursor-agent` required).

---

## Open questions / unverified

- [x] Session resume/load: **does not** call `prepareCursorMcp` (see WARN-1).
- [ ] Does current `cursor-agent` advertise `sessionCapabilities.list`? (Determines whether WARN-1 is latent or user-visible.)
- [ ] Whether `prepareCursorMcp` failure should set `harnessMemoryWarning` or block spawn (currently `console.warn` only).
- [ ] Behavior when user already has `krypton-harness-memory` in `.cursor/mcp.json` with a different URL (merge overwrites per spawn).
- [ ] Re-bisect when Cursor ships a fix; add a capability probe or version gate to prefer `session/new` again.

---

## Recommended next steps

1. ~~**Peer/code review**~~ — Claude-1: APPROVE (fresh spawn).
2. **Before closing #1:** Resolve WARN-1 (fix resume path or document unsupported) **or** verify cursor `!canList`.
3. **Commit** working-tree fix referencing krypton#1.
4. **Manual test:** fresh Cursor lane → `peer_list` / `peer_send`; if `canList`, also test `Cmd+P → 0` resume.
5. **Follow-up:** WARN-2/3 in docs; nits (empty-server skip, Rust tests, `mcp enable` UI, `.gitignore` note).
6. **Track upstream** (Zed #50924, Cursor forum).
