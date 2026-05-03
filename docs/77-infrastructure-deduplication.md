# Infrastructure Deduplication — Implementation Spec

> Status: Approved
> Date: 2026-05-03
> Milestone: Cross-cutting / tech debt

## Problem

Several infrastructure-layer patterns are copy-pasted across the codebase, hurting readability and risking drift when error formats, observability, or lifecycle conventions change. Six clusters were identified in a code survey:

1. `RwLock`/`Mutex` poison-error mapping in Rust commands.
2. `std::fs::*` error-string boilerplate in Rust commands.
3. Silent `let _ = app_handle.emit(...)` event emission with no logging.
4. Manual `UnlistenFn` storage and cleanup in TS views.
5. ACP harness `createLane()` initializing 19 fields per lane via long object literals.
6. Bulk `document.documentElement.style.setProperty('--krypton-*', ...)` calls.

None of these are bugs today, but the survey counted **30+ direct occurrences** that all change in lock-step when convention shifts.

## Solution

Introduce six small, surgical helpers — three Rust, three TS — and migrate the existing call sites to them. No public API changes, no runtime behavior changes (except newly-logged emit failures, which is the intent). Helpers stay in their respective layers; nothing crosses the IPC boundary.

**Error-string preservation invariant**: Tauri commands return errors as `String` over IPC, so error text is observable. The lock helpers must emit the exact same strings as today: `"Config lock poisoned: {e}"`, `"Sound engine lock poisoned: {e}"`, etc. — caller passes the label (`"Config"`, `"Sound engine"`) and the helper appends `" lock poisoned: {e}"`. The fs helper appends `": {e}"` after the caller-supplied op label, matching today's `format!("{op}: {e}")` shape exactly. Migration is a textual substitution, not a behavioral change.

## Research

Verified each duplication cluster by reading the actual source:

- **Lock poisoning**: `commands.rs:35-37,75-77`, `sound.rs:391-447` (`Mutex` not `RwLock` — 6 nearly identical match arms), plus `hook_server.rs` poisoning sites. The `RwLock` and `Mutex` cases share the same shape but use different APIs (`PoisonError<RwLockReadGuard<'_, T>>` vs `PoisonError<MutexGuard<'_, T>>`), so a single helper must abstract both.
- **fs error mapping**: `commands.rs:185, 193, 195, 270, 276, 294` — all match `std::fs::* .map_err(|e| format!("{op}: {e}"))?`. The op label is per-call and used in the surfaced error.
- **Silent emit** (full sweep — confirmed by grep `let _ = .*\.emit\(`): 18 sites total — `music.rs:646,667,755`; `acp.rs:247`; `pty.rs:375,385,388,392`; `hurl.rs:447,485,496`; `hook_server.rs:480,491,550,796`; `lib.rs:60,63,456`. The codebase is inconsistent — `hook_server.rs:460` already uses `if let Err(e) { log::error! }`. We migrate **all 18** sites to `emit_or_log` for uniform observability.
- **TS listener lifecycle**: `acp/client.ts:46, 66, 122-128` stores a single `UnlistenFn`, gates dispose on `disposed` flag. Same pattern in `pencil-view.ts:127, 234`. **`main.ts:87-88` is fire-and-forget** (`void listen(...)` with no UnlistenFn storage and no cleanup) — nothing to dedupe, so it is **not** in scope.
- **ACP harness `createLane`**: `acp/acp-harness-view.ts:436-466` — a 30-line object literal called 4 times. Most fields are constants (`status: 'starting'`, empty arrays/maps, false flags); only `id`, `index`, `backendId`, `displayName`, `accent`, and the starter-transcript text vary per call.
- **CSS vars**: `compositor.ts:334-361` — 7 consecutive `setProperty` calls in one function. Pure boilerplate.

Already factored (do not touch):
- Frontend `invoke<T>()` is centralized at `src/profiler/ipc.ts` with metrics instrumentation. ✅
- Sound pack/WAV registration is centralized via `WAV_NAMES` array in `sound.rs`. ✅

## Prior Art

This is internal refactoring with no user-facing surface; market comparison is N/A. The patterns are derived from existing in-tree conventions, not external references:

- **Lock helpers**: free functions with explicit labels — keeps clippy happy and avoids macro indirection.
- **`IoErrExt` extension trait**: same shape as `Result::map_err` plus an op label; chosen over a wrapper macro to stay grep-friendly.
- **`ListenerBag` cleanup convention**: mirrors `AcpClient.onEvent` (`src/acp/client.ts:84-90`), which already returns a cleanup closure today.

**Krypton delta** — N/A (no user-visible behavior).

## Affected Files

| File | Change |
|------|--------|
| `src-tauri/src/util/mod.rs` | **NEW** — module entry |
| `src-tauri/src/util/lock.rs` | **NEW** — `lock_read`, `lock_write`, `lock_mutex` helpers |
| `src-tauri/src/util/fs_err.rs` | **NEW** — `IoErrExt` trait (`.with_op(&str)`) |
| `src-tauri/src/util/emit.rs` | **NEW** — `EmitExt` trait with default-logging `emit_or_log()` |
| `src-tauri/src/lib.rs` | Add `mod util;` |
| `src-tauri/src/commands.rs` | Migrate 9 fs sites + 2 lock sites |
| `src-tauri/src/sound.rs` | Migrate 6 mutex match-arm sites to `lock_mutex` |
| `src-tauri/src/hook_server.rs` | Migrate `let _ = emit` (4 sites: 480, 491, 550, 796) + lock sites (confirmed during impl) |
| `src-tauri/src/pty.rs` | Migrate `let _ = emit` sites (4: 375, 385, 388, 392) |
| `src-tauri/src/music.rs` | Migrate `let _ = emit` sites (3: 646, 667, 755) |
| `src-tauri/src/acp.rs` | Migrate `let _ = emit` site (1: 247) |
| `src-tauri/src/hurl.rs` | Migrate `let _ = emit` sites (3: 447, 485, 496) |
| `src-tauri/src/lib.rs` | Add `mod util;`; migrate `let _ = emit` sites (3: 60, 63, 456) |
| `src/util/listener.ts` | **NEW** — `setupListener<T>()` and `ListenerBag` |
| `src/util/css-vars.ts` | **NEW** — `setCssVars()` batch helper |
| `src/acp/client.ts` | Use `setupListener` for `acp-event-${session}` |
| `src/acp/acp-harness-view.ts` | Replace `createLane` body with default-spread + per-call overrides |
| `src/compositor.ts` | Replace 7 `setProperty` calls with one `setCssVars` |
| `src/pencil-view.ts` | Use `ListenerBag` for the two existing listeners |

`src/main.ts` is **not** migrated: existing listeners are fire-and-forget (`void listen(...)`), there is no UnlistenFn lifecycle to dedupe. Other frontend views with listeners stay as-is; we don't sweep the whole frontend in one PR.

## Design

### Rust helpers

```rust
// src-tauri/src/util/lock.rs
use std::sync::{Mutex, RwLock, RwLockReadGuard, RwLockWriteGuard, MutexGuard};

pub fn lock_read<'a, T>(lock: &'a RwLock<T>, label: &str)
    -> Result<RwLockReadGuard<'a, T>, String>
{
    lock.read().map_err(|e| format!("{label} lock poisoned: {e}"))
}

pub fn lock_write<'a, T>(lock: &'a RwLock<T>, label: &str)
    -> Result<RwLockWriteGuard<'a, T>, String>
{
    lock.write().map_err(|e| format!("{label} lock poisoned: {e}"))
}

pub fn lock_mutex<'a, T>(lock: &'a Mutex<T>, label: &str)
    -> Result<MutexGuard<'a, T>, String>
{
    lock.lock().map_err(|e| format!("{label} lock poisoned: {e}"))
}
```

```rust
// src-tauri/src/util/fs_err.rs
pub trait IoErrExt<T> {
    fn with_op(self, op: &str) -> Result<T, String>;
}

impl<T> IoErrExt<T> for std::io::Result<T> {
    fn with_op(self, op: &str) -> Result<T, String> {
        self.map_err(|e| format!("{op}: {e}"))
    }
}
```

Migration example (`commands.rs:191-196`):
```rust
// Before
if let Some(parent) = std::path::Path::new(&path).parent() {
    std::fs::create_dir_all(parent).map_err(|e| format!("write_file mkdir: {e}"))?;
}
std::fs::write(&path, content).map_err(|e| format!("write_file: {e}"))

// After
use crate::util::fs_err::IoErrExt;
if let Some(parent) = std::path::Path::new(&path).parent() {
    std::fs::create_dir_all(parent).with_op("write_file mkdir")?;
}
std::fs::write(&path, content).with_op("write_file")
```

```rust
// src-tauri/src/util/emit.rs
use serde::Serialize;
use tauri::{AppHandle, Emitter};

pub trait EmitExt {
    fn emit_or_log<P: Serialize + Clone>(&self, event: &str, payload: P);
}

impl EmitExt for AppHandle {
    fn emit_or_log<P: Serialize + Clone>(&self, event: &str, payload: P) {
        if let Err(e) = self.emit(event, payload) {
            log::warn!("emit '{event}' failed: {e}");
        }
    }
}
```

Migration: `let _ = state.app_handle.emit("foo", &payload);` → `state.app_handle.emit_or_log("foo", &payload);`

### TS helpers

```ts
// src/util/listener.ts
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

/** Subscribe to a Tauri event; returns an unsubscribe fn. */
export async function setupListener<T>(
  event: string,
  handler: (payload: T) => void,
): Promise<UnlistenFn> {
  return listen<T>(event, (e) => handler(e.payload));
}

/** Collects unlisten fns; call .dispose() to clean up all of them. */
export class ListenerBag {
  private fns: UnlistenFn[] = [];
  add(fn: UnlistenFn): void { this.fns.push(fn); }
  async dispose(): Promise<void> {
    const fns = this.fns.splice(0);
    for (const fn of fns) {
      try { fn(); } catch (e) { console.warn('[ListenerBag] unlisten failed:', e); }
    }
  }
}
```

```ts
// src/util/css-vars.ts
export function setCssVars(target: HTMLElement, vars: Record<string, string>): void {
  for (const [k, v] of Object.entries(vars)) {
    target.style.setProperty(k, v);
  }
}
```

`createLane` migration in `acp-harness-view.ts`:
```ts
// LANE_DEFAULTS contains ONLY immutable primitives and null.
// All mutable container fields (arrays, Maps, Sets) MUST be constructed
// per-lane inside createLane() so lanes never share references.
const LANE_DEFAULTS = {
  client: null,
  status: 'starting' as const,
  draft: '',
  cursor: 0,
  usage: null,
  sessionId: null,
  supportsEmbeddedContext: false,
  error: null,
  acceptAllForTurn: false,
  rejectAllForTurn: false,
  currentAssistantId: null,
  currentThoughtId: null,
  stickToBottom: true,
  pendingShellId: null,
  supportsImages: false,
};

private createLane(index: number, backendId: string, displayName: string): HarnessLane {
  return {
    ...LANE_DEFAULTS,
    id: `${backendId}-${index}`,
    index,
    backendId,
    displayName,
    accent: laneAccent(index),
    // Per-lane mutable containers — must be fresh instances:
    pendingPermissions: [],
    pendingTurnExtractions: [],
    stagedImages: [],
    transcript: [{ id: makeId(), kind: 'system', text: `starting ${displayName}...` }],
    toolTranscriptIds: new Map(),
    toolCalls: new Map(),
    seenTranscriptIds: new Set(),
  };
}
```

### Data Flow

No runtime flow changes. The only observable effect is that previously-silent emit failures will now appear in the log.

## Edge Cases

- **`Mutex` vs `RwLock`** — distinct helpers (`lock_mutex` vs `lock_read`/`lock_write`); we don't try to abstract over the lock kind.
- **`async` lock guards** — none in scope; current code uses `std::sync` only. If a future async lock appears, it gets its own helper.
- **Error-string preservation** — `lock_read(&cfg, "Config")?` produces `"Config lock poisoned: {e}"`, byte-identical to today's hand-rolled string. `.with_op("write_file mkdir")?` produces `"write_file mkdir: {e}"`, also byte-identical. Diff during migration must show no string changes.
- **`LANE_DEFAULTS` aliasing** — Maps/Sets/arrays are NOT in `LANE_DEFAULTS`; each lane creates its own (snippet above is the source of truth). Caught by code review checklist.
- **Listener cleanup ordering** — `ListenerBag.dispose()` calls all fns even if one throws; failures are logged not propagated, matching current behavior in `AcpClient.dispose`.
- **`emit_or_log` log level** — `warn!` (not `error!`) since most emit failures occur during teardown when the window is being torn down.

## Open Questions

None. Defaults above were chosen during research; flagged here for visibility:
- Log level for emit failures: **warn** (not error) — open for change during review.
- Whether to sweep all frontend views to use `ListenerBag` in this PR: **no**, only the three already-listed call sites; broader sweep is a follow-up.

## Out of Scope

- Migrating every frontend view to `ListenerBag` (only `acp/client.ts` and `pencil-view.ts`).
- Migrating `src/main.ts` listeners — they are fire-and-forget by design.
- Refactoring `hook_server.rs` poisoning sites that aren't in command handlers (we'll do them opportunistically when touched).
- Any changes to public Tauri command signatures, IPC payloads, or error string formats.
- Bundling `LANE_DEFAULTS` into a class hierarchy or builder — keep it a plain const + spread.

## Resources

- [`tauri::Emitter` docs](https://docs.rs/tauri/latest/tauri/trait.Emitter.html) — confirmed `emit()` returns `Result<(), tauri::Error>`, safe to wrap.
- [`std::sync::PoisonError` docs](https://doc.rust-lang.org/std/sync/struct.PoisonError.html) — confirmed `Display` impl, safe to format.
- Internal: `src/profiler/ipc.ts` — model for how a thin instrumented wrapper looks in TS.
- Internal: `src/acp/client.ts:84-90` — model for "factory returns cleanup fn" convention.
- Internal grep `let _ = .*\.emit\(` over `src-tauri/src` — produced the authoritative list of 18 silent emit sites used in the migration table.
