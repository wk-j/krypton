# ACP Antigravity Lane — Implementation Spec

> Status: Implemented (rev 3)
> Date: 2026-10-12
> Milestone: ACP Harness — backends
> Rev 2 (review): an install manifest replaces version-dir scanning, so `cmd`/`args` survive offline and Windows `.exe` resolves. Old versions are GC'd only before the process's first Antigravity spawn, never while a lane may run them. Registry checks are throttled to 1 h. Archive hosts are allowlisted. Auth is detected by code + message, gated on the advertised method, and also covers resume/load. The cache moves to `app_cache_dir()`. The remote picker hides the backend. Affected Files matches the codebase.
> Rev 3: the resolve fast path is lock-free, so a background refresh's download never blocks a spawn. Refreshes and first installs re-check under the mutex.

## Problem

Google Antigravity ships an ACP agent server, but Krypton's ACP harness has no
`antigravity` backend. Unlike the other thirteen backends there is no command to put on
`PATH`: the interactive `agy` CLI (1.3.3) has no ACP mode, and the ACP server is
distributed only as a per-platform zip in the ACP Registry.

## Solution

Add `antigravity` as the 14th built-in ACP backend. Krypton manages the server binary the
way Zed does: it reads the ACP Registry entry `antigravity-acp`, downloads the platform
zip into Krypton's app cache, records the target's `cmd`/`args` in an install manifest,
and spawns that command by absolute path from its install directory.

When `session/new` (or `session/resume`/`session/load`) fails with ACP auth-required and
the server advertises `oauth-personal`, Krypton sends `authenticate { methodId:
"oauth-personal" }` once and retries. That call reuses the Google sign-in shared with
`agy`, Antigravity IDE, and Gemini (Keychain). **The server persists that choice to the
user's `~/.gemini/antigravity-acp/settings.json`.** Users who need another auth type must
set `auth.type` there first. Everything after session creation (models, MCP,
permissions) runs on the generic lane path unchanged.

Decision (2026-10-12): the primary user signs in with a personal Google account, so
automatic `oauth-personal` stays the default. Workspace users set `auth.type` first.

## Research

Live probes against `agy-acp-server-1.3.0-darwin-arm64` (2026-10-12):

- **Zip layout:** `agy_acp_server.par` (Mach-O, ~279 MB) + `localharness_external`
  (~119 MB). The `.par` looks for `localharness_external` next to its *real* path, and
  only at `session/new`, not at spawn. A `PATH` symlink to the `.par` fails at
  `session/new` with "Could not find default localharness binary … set
  ANTIGRAVITY_HARNESS_PATH". So the binary has to be launched from its install directory,
  and that directory must outlive every process started from it. A PATH-only install
  like the other backends does not work.
- **Size:** the darwin-arm64 zip is 111,456,962 bytes (HEAD `Content-Length`). Extracted
  it is ~398 MB per version.
- **`initialize`:** `loadSession: true`, `mcpCapabilities { http, sse }`,
  `sessionCapabilities { list, resume }`, prompt image/audio/embeddedContext.
  `authMethods`: `oauth-personal`, `oauth-business`, `gemini-api-key`, `agent-platform`.
  So the per-lane harness-memory HTTP MCP server rides `session/new` with no native
  overlay (unlike Cline/Junie/Cursor).
- **Auth:** with no `settings.json`, `session/new` returns `-32000 Authentication
  required` and names the `authenticate` RPC and the settings path.
  `authenticate { methodId: "oauth-personal" }` returned `{}` with no browser (creds already
  in Keychain), wrote `settings.json`, and the following `session/new` succeeded.
  `AcpClient::request_with_id` (`acp.rs`) surfaces a JSON-RPC error as the string
  `session/new failed: {"code":-32000,"message":"Authentication required…"}`.
- **`session/new`:** advertises `models { availableModels, currentModelId }` (11 Gemini
  models), so the generic model picker and `session/set_model` path work as is. Modes:
  `default` / `auto_edit` / `yolo`. Krypton's per-lane permission mode answers
  `session/request_permission` client-side, so the agent stays on `default`.
- **Turn:** a `session/prompt` streamed `agent_message_chunk`, `usage_update`, and
  `available_commands_update`, then `stopReason: end_turn`.
- **Registry entry** (`https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json`,
  verified 2026-10-12): id `antigravity-acp`, top-level `version` `1.3.0`,
  `distribution.binary` keys `darwin-aarch64`, `darwin-x86_64`, `linux-x86_64`,
  `linux-aarch64`, `windows-x86_64`, `windows-aarch64`. Each target is
  `{ archive, cmd, args? }`.
  - `cmd` is `./agy_acp_server.par` on macOS and Linux and `./agy_acp_server.exe` on Windows.
  - The Linux targets carry `args: ["--uid="]`.
  - No `sha256`. Archives come from `https://dl.google.com/agy-extensions/releases/…`.
- **Lane close cancels in-flight requests:** `acp_dispose` kills the child, and
  `finalize_disconnect` clears `pending`. So an `authenticate` still waiting on a browser
  sign-in fails promptly when the user closes the lane. No separate cancel path is needed.
- **Alternatives ruled out:** (a) manual curl/unzip install with a `PATH` symlink:
  breaks (see zip layout), and the install hint would pin a version and go stale. (b) a
  config key pointing at a user-extracted dir: works, but puts download, extraction, and
  updates on the user for no design gain. (c) reuse Zed's install under `~/Library/
  Application Support/Zed/external_agents/registry/`: couples Krypton to another app's
  private cache layout.

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| Zed | `AgentRegistryStore` fetches the registry (1 h throttle); `LocalRegistryArchiveAgent::get_command` downloads/extracts into `external_agents/registry/<id>/v_<version>_<hash>/`, joins `./cmd`, removes stale versions | sha256 only when registry/GitHub provides it; Antigravity has none |
| JetBrains / VS Code | Antigravity extension bundles its own server | Not an ACP-registry client |
| pi-go | `scripts/install-agy-acp.sh` extracts to `~/.pi-go/acp/agy` | Manual install, same "agy CLI has no ACP mode" finding |
| Krypton `remote_harness.rs` | Managed `krypton-remote` binary under Tauri `app_cache_dir()/remote-runtime/<version>/<target>/` | Local precedent for managed binaries |

**Krypton delta:** same managed-install model as Zed, cut to one backend (no registry
browser UI, no npx agents). Unlike Zed, stale versions are never removed while this
process may still be running them. Lane UX is identical to every other backend.

## Affected Files

| File | Change |
|------|--------|
| `src-tauri/src/acp_install.rs` (new) | Registry fetch (1 h throttle), host allowlist, streamed zip download/extract, `current.json` manifest, install lock, first-resolve GC |
| `src-tauri/src/acp.rs` | `antigravity` entry in `builtin_backends()`. `acp_spawn`: local-only guard, then command/args from `acp_install::resolve`. `is_auth_required` helper; auth retry in `acp_session_new` and `acp_session_restore`. `startup_hint` branch |
| `src-tauri/src/lib.rs` | `mod acp_install;` |
| `src-tauri/Cargo.toml` | `zip` (`default-features = false`, `features = ["deflate"]`); `reqwest` `stream` is already enabled |
| `src-tauri/src/config.rs` | Add `antigravity` to the `lane_models` backend-id doc comment |
| `src/acp/harness-lane-identity.ts` | `BACKEND_LABELS.antigravity`; `backendLogoId` case; `laneAccentForLabel` `/antigravity/i` → slot 14; 14th `LANE_ACCENT_PALETTE` entry; `harnessBackends(backends, { remote })` drops `antigravity` when `remote` |
| `src/acp/acp-harness-view.ts` | Pass `{ remote: this.remoteRuntimeId !== null }` at the three `harnessBackends(...)` call sites |
| `src/acp/harness-icons.ts` | `krypton-logo-antigravity` symbol |
| `src/styles/acp-harness.css` | `--krypton-backend-antigravity`; `.acp-harness__rail-logo--antigravity`; `.acp-harness__lane-mail-logo--antigravity` |
| `src/styles/theme-scheme.css` | Light-scheme `--krypton-backend-antigravity` |
| `src/config.ts` | Add `antigravity` to the backend-id doc comment |
| `src/acp/acp-harness-view.test.ts` | Palette tests move from 13 to 14 slots (`/antigravity/i` → slot 14 distinct from slot 1); `harnessBackends` remote filter |
| `docs/06-configuration.md`, `docs/04-architecture.md`, `docs/README.md` | Backend row + managed-install/auth notes; index entry |

## Design

### Data Structures

```rust
// acp.rs builtin_backends(): `command` is a placeholder name for the
// descriptor list. acp_spawn replaces command + args with acp_install::resolve.
("antigravity", AcpBackend {
    command: "agy_acp_server".to_string(),
    args: vec![],
    display_name: "Antigravity".to_string(),
})

// acp_install.rs
pub struct ManagedAgent {
    registry_id: &'static str,                 // "antigravity-acp"
    dir_name: &'static str,                    // "antigravity"
    archive_url_prefix: &'static str,          // "https://dl.google.com/agy-extensions/"
}

/// <root>/current.json, replaced atomically (write tmp + rename).
#[derive(Serialize, Deserialize)]
struct InstallManifest {
    version: String,            // registry top-level `version`
    cmd: String,                // target `cmd`, e.g. "./agy_acp_server.par"
    args: Vec<String>,          // target `args`, e.g. ["--uid="] on Linux
    checked_at_unix: u64,       // last registry check (throttle)
}

/// Absolute command path + args. Installs on first use.
pub async fn resolve(app: &AppHandle, agent: &ManagedAgent)
    -> Result<(PathBuf, Vec<String>), String>;
```

- Install root: `app_cache_dir()/acp-agents/<dir_name>/`. Versions live in `<root>/<version>/`.
- A process-wide `tokio::sync::Mutex` (`OnceLock`) serializes install, refresh, and GC.
- A process-wide `AtomicBool` records whether this process has resolved an Antigravity lane yet.

### Data Flow

```
1. User adds an Antigravity lane → frontend acp_spawn("antigravity", …) (unchanged IPC).
   A remote harness never offers it: harnessBackends(…, { remote: true }) drops it.
2. acp_spawn: remote_runtime_id set → Err("Antigravity lanes are local-only")
3. acp_install::resolve(app, &ANTIGRAVITY):
   a. First resolve of this process only (AtomicBool, under the install mutex): delete
      every <root>/<version>/ except current.json's version, and every <root>/.tmp-*.
      No lane from this process can be running an older version yet, and no refresh can
      be in flight (refreshes start only from step b). Later resolves never delete a
      version dir.
   b. Fast path, lock-free (current.json is only ever replaced by atomic rename):
      current.json present and <root>/<version>/<cmd> exists → return
      (<root>/<version>/<cmd>, args) immediately. A refresh holding the mutex through a
      111 MB download must never block a spawn. If checked_at_unix is ≥ 1 h old, also
      spawn a detached refresh (c–f). The refresh takes the install mutex, re-reads
      checked_at_unix, and exits if a concurrent refresh already ran. It only lands a
      new version for a LATER spawn.
   c. Fetch registry.json (15 s timeout). Pick distribution.binary[<os>-<arch>] with
      os ∈ {darwin, linux, windows}, arch ∈ {aarch64, x86_64}. Missing key → error
      listing the available keys.
   d. Same version as current.json → only rewrite checked_at_unix; done.
   e. Validate before touching disk:
      - the archive URL starts with archive_url_prefix (https + dl.google.com allowlist);
      - cmd starts with "./" and has no ".." component;
      - args are strings.
   f. Stream the zip to <root>/.tmp-<version>/archive.zip (reqwest bytes_stream, never
      fully in memory). Extract with zip::ZipArchive::extract into
      <root>/.tmp-<version>/pkg/ (enclosed_name guards zip-slip; unix mode bits kept).
      Check pkg/<cmd> exists, rename pkg/ to <root>/<version>/ (atomic), delete .tmp-*.
      Then atomically replace current.json. Older dirs stay until the next process's
      step 3a.
   Nothing installed → b fails → take the install mutex, re-check b (a concurrent first
   install may have finished), else run c–f inline while the lane shows its spawning state.
4. Command::new(<abs cmd>).args(<manifest args>).current_dir(lane cwd) — the generic
   spawn path otherwise unchanged (login env, process group, kill_on_drop).
5. acp_initialize as today; keep authMethods on the client.
6. session/new, session/resume, or session/load returns an error where
   is_auth_required(err): the string contains "\"code\":-32000" AND
   "Authentication required". If backend_id == "antigravity" and authMethods advertises
   "oauth-personal" → authenticate { methodId: "oauth-personal" } (300 s timeout; may
   wait on a browser sign-in; closing the lane aborts it via acp_dispose →
   finalize_disconnect) → retry the same call once with its normal timeout. A second
   failure, or no oauth-personal method → spawn error with the auth hint.
7. Generic path: set_model if configured, MCP via session/new, permissions client-side.
```

### UI Changes

- Rail and lane-mail logo, plus a 14th accent color. Lane label `Antigravity-N`.
- On first install the lane stays in its existing spawning state.
- A failed install or failed auth shows in the existing spawn-error row with the `startup_hint` text.
- The backend does not appear in a remote harness's add-lane picker.

### Configuration

None. Model selection uses the generic path: `[acp_harness.lane_models.antigravity]
active = "<model id>"`, where the id is one of the `availableModels` the lane's model
picker lists. The 11 ids are not recorded here; read them from a live lane.

## Edge Cases

- **Offline, nothing installed** → spawn error + hint "Antigravity's ACP server downloads
  on first use (~110 MB download, ~400 MB on disk); check network". Offline with an
  install → launches the version in `current.json`. The detached refresh fails, logs
  `warn!`, and leaves `checked_at_unix` unchanged.
- **Two lanes spawn at once on first install** → install mutex; the second waits, then
  takes step 3b.
- **Update while lanes run** → the refresh adds `<root>/<new>/` and repoints
  `current.json`. Running lanes keep their old directory until the next app launch
  (step 3a), so disk briefly holds two versions (~800 MB).
- **Interrupted download / extraction** → work happens in `.tmp-<version>`; never renamed;
  removed by the next refresh or the next process's step 3a.
- **`current.json` names a version whose `<cmd>` is missing** (manual deletion) → treated
  as not installed: install inline.
- **Archive URL off the allowlist** (registry moved hosts or was tampered with) → refuse,
  `warn!`. The installed version keeps working, and first install errors with the URL.
- **Unsupported platform** (no registry key) → error listing the available keys.
- **Not signed in to Google** → `authenticate` presumably starts the server's browser
  sign-in (unverified: the probe machine was signed in). Timeout/failure → hint "Run
  `agy` once to sign in, or set `auth.type` in ~/.gemini/antigravity-acp/settings.json".
- **Workspace / API-key / Agent Platform users** → with `auth.type` already set,
  `session/new` succeeds and the retry never fires. With no `settings.json`, Krypton picks
  `oauth-personal` and the server persists it. Switching later means editing
  `auth.type`. `docs/06-configuration.md` states this.
- **`settings.json` removed after first use** → the next resume/load hits auth-required
  and takes the same retry as `session/new`.
- **Registry drops the entry** → the installed version keeps working; refresh logs `warn!`.

## Out of Scope

- A generic ACP Registry browser or support for other registry agents.
- Remote-harness Antigravity lanes.
- Usage/quota meter, `#debby`/`#salty` roster membership.
- Mapping Krypton permission mode to Antigravity `auto_edit`/`yolo` session modes.
- An auth-method picker; `oauth-personal` is the only automatic choice.

## Resources

- [Antigravity — Zed extension docs](https://antigravity.google/docs/ide/extensions/zed) — registry install, `auth.type` values.
- [Antigravity — IDE extensions](https://antigravity.google/docs/ide/extensions) — unified sign-in across CLI/IDE/extensions.
- [Zed ACP agent page: antigravity-acp](https://zed.dev/acp/agent/antigravity-acp) — `./agy_acp_server.par` launch.
- [ACP Registry JSON](https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json) — distribution targets.
- [pi-go agy client](https://pkg.go.dev/github.com/dimetron/pi-go@v0.2.7/internal/acp/client/agy) — "agy CLI has no ACP mode".
- `/Users/wk/Source/zed/crates/project/src/agent_server_store.rs` (`LocalRegistryArchiveAgent::get_command`) and `agent_registry_store.rs` — managed-install prior art.
- `src-tauri/src/remote_harness.rs` (`app_cache_dir()/remote-runtime/…`) — local managed-binary precedent.
- `docs/159-acp-cline-lane.md` — template for adding a backend.
