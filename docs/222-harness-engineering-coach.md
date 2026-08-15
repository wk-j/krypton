# Harness Engineering Coach — Implementation Spec

> Status: Draft
> Date: 2026-08-15
> Milestone: ACP Harness — observability
> Builds on: 168/169 (loopback dashboard + `/telemetry`) · 151 (`usage.rs` Codex walker) · 214 / ADR-0019 (numbers-only WAL) · 69/72/97 (no Krypton transcript warehouse) · ADR-0002 · ADR-0004 · `DESIGN.binance.md`

## Problem

Krypton already has a *live* lane wall (`#dashboard`), subscription gauges (`Leader $`, spec 151), and a numbers-only turn ledger (spec 214). It has no historical mirror of *how the human runs agents*. Closing an ACP tab drops in-memory transcripts (69/97); adapters keep the JSONL. There is no local, no-model surface that counts session hygiene from those logs without scoring people or shipping prompt text.

## Solution

Ship **Harness Engineering Coach**: a tokenless loopback sibling of the lane monitor.

- `GET /coach` — `src/acp/artifact-coach.html` via `include_str!` (`COACH_HTML` next to `DASHBOARD_HTML` in `hook_server.rs`).
- `GET /coach/summary` — camelCase JSON. **No prompt/response text. No `promptHash`.**
- Open: `#coach` (copy `#dashboard`: `get_hook_server_port` + `open_url`) + palette `Open Harness Engineering Coach`. **No new Leader letter** (`input-router.ts` occupies a–z plus `$`; do not steal `Leader Shift+L` or `Leader $`).
- Core analysis is parsers + a fixed rule table in Rust. Zero extra tokens. Optional AI stays Phase 2.

**Accepted risk (capability ≠ static `/dashboard` HTML):** tokenless on `127.0.0.1`, same bind as `/dashboard`/`/telemetry` (ADR-0010). A local `GET /coach/summary` may **walk all history metadata** under `~/.claude/projects` and `~/.codex/sessions`; it **parses/returns only the lookback window**. `[coach].enabled=false` is the off switch. No Host-header work in v1.

## Research

- **Claude JSONL.** Turns as before. Tools: `tool_use.id`. **Project paths (this machine):** `Edit`/`Write` write `input.file_path`; `Read` reads it. Increment exec on `Bash` — **never store `command`/`old_string`/`new_string`/`content`**. MCP names `mcp__*`. Skip sidechain / `memory/` / `subagents/` / `tool-results/`. Prefer record `cwd`.
- **Codex JSONL.** Turns as before. `apply_patch` is a raw string: keep only `*** Update File:` / `*** Add File:` paths, drop the patch body. `exec_command`/`shell` increment exec — never store `cmd`. `update_plan` increments plan. Model: `turn_context.payload.model`.
- **`usage.rs::codex_sessions_dir` (private today, lines 508–516):** `CODEX_HOME` or `~/.codex`, then `join("sessions")`, then `is_dir()`. Extract as `pub(crate)` on **`usage.rs`**. **Do not** make `usage.rs` depend on `coach`. `newest_rollout_files` + `CODEX_MAX_FILES=10` stay for quota. Coach walks **every** Codex day dir; never skip a dir solely because `YYYY/MM/DD` is older than lookback (resumed rollouts keep the birth-day path).
- **Spec 214 WAL.** Public `read_day` + `day_stamp` only (`usage_dir` private). `read_day` returns `[]` for missing *and* empty files — **do not** add `day_exists`. `usageOverlay = None` iff **zero kept rows** after the `at` filter.
- **Loopback:** `handle_dashboard` / `GET /telemetry` / `all_telemetry_snapshots()`; insert routes next to `.route("/gallery"`. Same `html_response` headers. Tokenless bind, wider capability (see Solution).
- **Leader map is full.** Palette + `#` is how `/gallery` shipped (spec 170). `#coach` needs `HASH_COMMANDS` **and** `commandMeta().coach` — `hash-commands.test.ts` asserts those key sets equal.

### Alternatives rejected

In-app usage view / overlay dashboard — wrong family. Persist ACP transcripts — 69/97. Clone AIEC scores — ADR-0004. POST to Xenon — 214 / ADR-0019.

## Prior Art

| System | What it does | Notes |
|---|---|---|
| [microsoft/AI-Engineering-Coach](https://github.com/microsoft/AI-Engineering-Coach) | VS Code extension (also Copilot canvas). Any-harness parsers. 45 markdown rules + Rule Editor. Local. Optional Copilot LM. Practice scores, XP, achievements. MIT; **not** an official Microsoft product | Inspiration, not a port |
| ccusage | Claude/Codex JSONL → cost tables | Spend, not practice |
| Lane monitor / usage / WAL (168/151/214) | Live status, quota, token rows | Not project output |

**Krypton delta.** Same loopback family as the lane monitor. v1 copies AIEC’s *project* surfaces (files/languages written, work mix, repo readiness, skill-shaped repeats) without scores, XP, or prompt text. Session hygiene is details.

## Affected Files

| File | Change |
|---|---|
| `src-tauri/src/coach/` | **New.** `mod.rs`, `paths.rs` (Claude dir + index cache path only), `parse.rs`, `session.rs`, `rules.rs`, `summary.rs`, `context.rs`, `wal.rs`, `fixtures/*.jsonl`, `RULES.md` |
| `src-tauri/Cargo.toml` | Add `chrono = { version = "0.4", default-features = false, features = ["clock", "std"] }` — local TZ heatmap |
| `src-tauri/src/lib.rs` | `pub mod coach;` |
| `src-tauri/src/usage.rs` | `pub(crate) fn codex_sessions_dir` — keep `…/sessions` + `is_dir()`. Usage keeps newest-10 |
| `src-tauri/src/hook_server.rs` | `COACH_HTML`; `GET /coach`, `GET /coach/summary`; `CoachEngine` on `HookServer`; add both paths to `artifact_routes_do_not_conflict` |
| `src-tauri/src/config.rs` | `CoachConfig` + `KryptonConfig.coach` |
| `src/acp/artifact-coach.html` | **New.** Clone dashboard chrome; every data-derived string via `esc()` / `textContent` (no raw interpolation) |
| `src/acp/hash-commands.ts` (+ test) | `#coach` in `HASH_COMMANDS` **and** `commandMeta()` (`surface`); existing equality test must stay green |
| `src/acp/acp-harness-view.ts` | `#coach` dispatch = `#dashboard` block → `/coach` |
| `src/compositor.ts` | `openCoach()` clone of `openGallery()` (~2955) |
| `src/command-palette.ts` | `coach.open` — "Open Harness Engineering Coach", no keybinding |
| `DESIGN.binance.md` | `appliesTo`, surfaces table, and the body “seven” counts. Analyses/reviews optional same-pass cleanup — not a coach blocker |
| `docs/04-architecture.md`, `docs/05-data-flow.md`, `docs/06-configuration.md`, `docs/PROGRESS.md` | Module, `#coach` flow, `[coach]` keys |

## Design

### Data structures (Rust, `#[serde(rename_all = "camelCase")]`)

```rust
#[serde(rename_all = "lowercase")]
pub enum CoachVendor { Claude, Codex }
#[serde(rename_all = "lowercase")]
pub enum CoachSeverity { Info, Warning }

pub struct CoachFileKey { pub path: String, pub mtime_ms: i64, pub size: u64 }
#[serde(rename_all = "snake_case")]
pub enum CoachSkipReason { Empty, Unreadable, Unparseable, TooLarge, Symlink }
pub struct CoachSkip { pub key: CoachFileKey, pub reason: CoachSkipReason }

// Index + disk (`coach-index.json`). No #[serde(skip)]. No preimage.
pub struct CoachSession {
    pub key: CoachFileKey,
    pub vendor: CoachVendor,
    pub session_id: String,
    pub cwd: Option<String>,
    pub started_at: i64,              // first record ts (Codex: session_meta)
    pub ended_at: i64,                // last record ts of any type
    pub user_turn_count: u32,
    pub tool_call_count: u32,
    pub models: Vec<String>,
    pub first_prompt_bytes: u32,      // UTF-8 after strip, before casefold
    pub prompt_hash: Option<String>,  // persisted on disk; never on the wire
    pub user_turn_at: Vec<i64>,       // persisted; heatmap input
    pub write_calls: u32,
    pub read_calls: u32,
    pub exec_calls: u32,
    pub plan_calls: u32,
    pub mcp_calls: u32,
    pub touches: Vec<CoachTouch>,     // cap 80; paths only
}

pub struct CoachTouch { pub path: String, pub writes: u32, pub reads: u32 } // no file body

pub struct OverlapGroup {
    pub cwd: Option<String>,
    pub vendors: Vec<CoachVendor>,
    pub session_ids: Vec<String>,     // cap 20
}

pub struct WorkMix { pub impl_w: u32, pub test_w: u32, pub doc_w: u32, pub config_w: u32 }

pub struct LangRow { pub ext: String, pub files: u32, pub writes: u32 }

pub struct ReadyBit { pub name: String, pub present: bool } // cwd scan, no score

pub struct CoachProject {             // query-time, cap 10 by write volume
    pub cwd: String,
    pub langs: Vec<LangRow>,
    pub top_files: Vec<CoachTouch>,   // cap 15 by writes
    pub work: WorkMix,
    pub ready: Vec<ReadyBit>,
}

// Wire DTO for CoachSummary.sessions (cap 200). No key / hash / user_turn_at.
pub struct CoachSessionRow {
    pub vendor: CoachVendor, pub session_id: String, pub cwd: Option<String>,
    pub started_at: i64, pub ended_at: i64,
    pub user_turn_count: u32, pub tool_call_count: u32,
    pub models: Vec<String>, pub first_prompt_bytes: u32,
}

pub struct CoachHit {
    pub rule_id: String,
    pub severity: CoachSeverity,
    pub count: u32,                   // last-7d *ended_at* cohort; unit = per-rule table
    pub prev_count: u32,              // prior-7d cohort; always 0 for thin-context
    pub session_ids: Vec<String>,     // cap 20, last-7d; overlap = flattened unique
    #[serde(skip_serializing_if = "Option::is_none")]
    pub groups: Option<Vec<OverlapGroup>>, // overlap only; last-7d; cap 20
}

pub struct InstructionFile { pub name: String, pub present: bool, pub bytes: u32 }

pub struct CoachIndexFile {           // disk only; ≠ CoachSummary.schema_version
    pub index_version: u32,           // 2 — touches + call counts
    pub sessions: Vec<CoachSession>,
    pub skips: Vec<CoachSkip>,
}

pub struct CoachSources {
    pub claude_files: u32,
    pub codex_files: u32,
    pub skipped_files: u32,
    pub wal_projects: u32,
}

pub struct CoachTotals {
    pub sessions: u32,
    pub user_turns: u32,
    pub tool_calls: u32,
    pub unique_cwds: u32,
}

pub struct WalGroup { pub key: String, pub turns: i64, pub input_tokens: i64, pub output_tokens: i64 }

pub struct WalOverlay {               // token sums only; no text
    pub turns: i64,
    pub turns_without_tokens: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cached_read_tokens: i64,
    pub cached_write_tokens: i64,
    pub by_backend: Vec<WalGroup>,
    pub by_model: Vec<WalGroup>,
}

pub struct CoachSummary {
    pub schema_version: u32,          // 2 — project slices + overlap cwd
    pub projects: Vec<CoachProject>,  // cap 10; empty if no writes in window
    pub generated_at: i64,
    pub lookback_days: u32,
    pub enabled: bool,
    pub building: bool,               // true ⇒ last-good index while a scan runs
    pub sources: CoachSources,
    pub totals: CoachTotals,          // last-7d ended_at cohort ∩ filters
    pub prev_totals: CoachTotals,     // prior-7d ended_at cohort ∩ filters
    pub heatmap: [[u32; 24]; 7],      // chrono::Local; [0]=Sunday
    pub sessions: Vec<CoachSessionRow>, // cap 200, most recently ended
    pub hits: Vec<CoachHit>,
    pub context_health: Vec<ContextHealth>,
    pub usage_overlay: Option<WalOverlay>,
}

pub struct ContextHealth { pub cwd: String, pub files: Vec<InstructionFile> }
```

TS consumers use the camelCase JSON of the wire structs (`claude`/`codex`, `info`/`warning`). Map `CoachSession` → `CoachSessionRow` at serialize time (do not `#[serde(skip)]` the index type).

`started_at` = first record timestamp in the file (`session_meta` for Codex). `ended_at` = last record timestamp of any type. Empty or wholly unparseable file ⇒ skip (`skippedFiles`).

**Human vs programmatic.** A candidate turn is **programmatic** (excluded from `userTurnCount`, `user_turn_at`, `firstPromptBytes`, `promptHash`) if its raw concatenated text matches any of: `(?m)^\[inter-lane\]`, `(?m)^\[mention reply\]`, or contains `Only the original initiator` (`InterLaneCoordinator.composePrompt`, `src/acp/inter-lane.ts:760-810`). Header-only stripping is **not** enough — exclude the whole turn. Accepted miss: a `mention_request` body with no header is indistinguishable from a human prompt in adapter logs. Tool-result-only records stay non-turns.

**First *human* turn only.** Never concatenate later turns. Strip wrappers (`krypton://…` lines, `<context ref=…>…</context>`, Codex `<environment_context>` / `<recommended_plugins>` / `<skills_instructions>`). Then: `firstPromptBytes = stripped.utf8_len` (Rust `.len()`). Empty ⇒ bytes 0, hash `None`. Bytes `< 32` ⇒ keep bytes, hash `None`. Else `prompt_hash = sha256(lowercase+collapse(stripped))[..16]`. **Drop the buffer.** Never write the preimage to disk, logs, or JSON.

### Index, lookback, query

Index = unfiltered `CoachSession` **plus** `CoachSkip` tombstones, keyed by `CoachFileKey`. Disk is `CoachIndexFile` at `dirs::cache_dir()/krypton/coach-index.json` (`index_version` **2**, distinct from `CoachSummary.schema_version`). Load: deserialize fail, corrupt file, or `index_version` mismatch → discard and rebuild (`building: true`). Ignore leftover `coach-index.*.json.tmp`. **Write:** same dir, unique `coach-index.<pid>.<u32>.json.tmp` (never a fixed `.tmp`). Then **replace dest**: Unix `rename(tmp, dest)` (atomic overwrite — last rename wins). Windows **accepted fallback** — `remove_file(dest)` if present, then `rename` (not atomic; **failed replace ⇒ best-effort remove own temp; crash may leave temp, ignored on load**; missing/corrupt dest ⇒ rebuild). Concurrent Windows writers are **best-effort / arbitrary winner** — do not promise last-writer-wins; no concurrent-writer test. No extra crate. Derived views are **query time**.

Let `W = lookback_days * 86_400_000` (clamp `lookback_days` to **1..=365** at read; `0→1`, `>365→365`). `cutoff = now_ms - W`.

- **Visible set S** (session table, context cwd list): interval overlap `[started_at, ended_at] ∩ [cutoff, now_ms]`, then `?vendor=` / `?cwd=`. Long sessions with recent activity stay visible here.
- **WoW cohort (no double-count):** a session belongs to at most one week, by **`ended_at`**. Last 7d = `ended_at ∈ [now_ms - 7*86_400_000, now_ms]`; prior 7d = `[now_ms - 14*86_400_000, now_ms - 7*86_400_000)`. `totals` / `hits.count` use last-7d ∩ filters; `prev_*` use prior-7d ∩ filters. Whole-session turn/tool counts go to the week the session **ended** (lumpiness accepted; no per-tool timestamps in v1). A session still running across both weeks is in S but in neither WoW column until it ends.
- **Heatmap** counts `user_turn_at` in `[cutoff, now_ms]`. Implement with `chrono::Local` (`Cargo.toml` as above). Sunday = `Weekday::Sun` → index 0; hour = local hour. DST via `Local` at each timestamp. Tests call a `bucket_local(ts_ms, FixedOffset)` helper so they do not depend on the developer TZ; production uses `Local`.
- **WAL (exact ms window):** for the filtered cwd list (cap 20, most recently ended), enumerate **every UTC date whose civil day intersects `[cutoff, now_ms]`** (30d ⇒ up to **31** dates). `read_day` each; keep `TurnRecord.at ∈ [cutoff, now_ms]`. Not vendor-filtered. **`usageOverlay = None` iff kept rows == 0** (missing file and empty-after-filter are the same, because `read_day` cannot tell them apart). `Some` only when ≥1 kept row. `sources.walProjects` = cwds in the cap-20 list with ≥1 kept row. `sources.*Files` are **global** scan diagnostics.
- Serialize ≤ **200** `CoachSessionRow` (most recently ended in S).
- **Projects:** roll S’s `touches` by cwd. Path class: `test` if `/test/` `/tests/` `.test.` `.spec.` `_test.`; `doc` if `/docs/` or `.md`; `config` if `.toml` `.yml` `.yaml` `.json` at repo root; else `impl`. Ext = last `.suffix` of basename. `ready` bits (cwd-only, present/absent, **no score**): `AGENTS.md`, `CLAUDE.md`, `copilot-instructions.md`, `.github/copilot-instructions.md`, `.claude/skills` or `.agents/skills` (≥1 `SKILL.md`), `.mcp.json`, `.devcontainer/devcontainer.json`. Cap 10 projects by write volume.

**Discovery (mtime + cache, never path-date):** walk every Claude `*.jsonl` (skip `memory/`, `sessions-index.json`, `subagents/`, `tool-results/`) and every Codex `sessions/**/rollout-*.jsonl`. **Do not** skip a Codex `YYYY/MM/DD` dir because the path-date is old. Skip a *file* only if `mtime < cutoff - 86_400_000` **and** there is no cached `CoachSession` whose interval overlaps `[cutoff, now_ms]`. Symlinks: skip, tombstone `symlink`. File `size > 64 MiB`: skip, tombstone `too_large`. Parse with `BufRead` (no `read_to_string` of the whole file). Line `> 1 MiB`: skip that line. Growing file: one EOF pass; next ensure sees dirty mtime/size.

**Ensure (single-flight):** `building` mutex; in-flight GET returns 200 + last-good + `building: true`. Drop keys whose **path** is gone. Same path + new mtime/size ⇒ drop old key, insert new (session or skip). A `CoachSkip` is not re-parsed unless mtime/size changed. `lookback_days` change or `enabled` false→true ⇒ re-walk; evict sessions whose interval does not overlap the new window **and** whose mtime is outside slop. `enabled=false` ⇒ empty, no scan.

Targets: first open 30d / ~1k files **< 2 s**; incremental **< 200 ms**.

### API

| Route | Behavior |
|---|---|
| `GET /coach` | `html_response(COACH_HTML)` |
| `GET /coach/summary?vendor=&cwd=` | `secured_json_response`. Missing dirs = empty source, not 4xx |

Query: `vendor` optional, case-insensitive `claude` \| `codex`; missing/empty = all; anything else → **400** `{ "error": "invalid vendor" }` **before** the `enabled` check (400 even when disabled; no scan). `cwd` optional; **exact** match on stored `cwd`; missing/empty = all. Repeated keys: last wins. **Unknown query keys are ignored** (not 400). Valid/missing vendor + `enabled=false` → empty summary, no scan.

No new Tauri command. **New** hook-server config path (not an existing pattern): `app_handle.try_state::<Arc<RwLock<KryptonConfig>>>()` at request time. Config *is* `.manage`d in `lib.rs` before `hook_server::start`. **`None` ⇒ `CoachConfig::default()`** so unit `Router` tests stay usable.

```
1. Palette / #coach → get_hook_server_port → open_url(http://127.0.0.1:<port>/coach)
2. Page fetches /coach/summary (and optionally /telemetry for a "now" rail — no second bus).
3. handle_coach_summary: try_state or CoachConfig::default(); enabled=false → empty + enabled:false.
4. CoachEngine.ensure(): single-flight spawn_blocking of dirty files → persist unfiltered sessions + skip tombstones.
5. Filter S; derive hits/totals/heatmap/context/WAL; serialize cap-200 `CoachSessionRow`. building=true if a scan is running.
6. Page polls summary every 2 s while building, every 15 s when idle. Telemetry rail polls /telemetry at 2 s only if a live harness exists; pause on document.hidden.
```

### v1 rules (`src-tauri/src/coach/rules.rs` is source of truth; `RULES.md` mirrors ids)

Session rules evaluate on the **ended_at cohort** of that column (last 7d vs prior 7d), not on overlap-set S. `repeated-prompt` ignores `prompt_hash == None`. `thin-context` is **current** cwd health (four names, cwd-only — no parent/global walk); `prevCount` always 0; not historical WoW.

| id | When | sev | `count` unit |
|---|---|---|---|
| `mega-session` | `ended-started ≥ 4h` **or** `userTurnCount ≥ 80` | info | matching sessions |
| `one-shot-giant` | `firstPromptBytes ≥ 8000` | warning | matching sessions |
| `no-tool-use` | `userTurnCount ≥ 8` && `toolCallCount == 0` | warning | matching sessions |
| `overlap` | ≥2 sessions, same `cwd`, intervals overlap ≥ 10 min | info | **groups** as `OverlapGroup` (cwd + vendors + ids); never rebuild from the session table |
| `write-no-read` | `writeCalls ≥ 5` && `readCalls == 0` | warning | matching sessions |
| `impl-only` | cwd lookback `impl_w ≥ 10` && `test_w == 0` | warning | matching cwds |
| `thin-context` | cwd missing **all four** instruction names | warning | matching cwds now; `prevCount=0` |
| `model-thrash` | unique `models.len() ≥ 4` | info | matching sessions |
| `repeated-prompt` | same hash on ≥ 4 **human** sessions in lookback S | warning | **clusters**; assign each eligible cluster to **one** week = `max(ended_at)` of members; never emit a 0/0 hit |
| `tool-storm` | `toolCallCount ≥ 200` | info | matching sessions |

Activity heatmap is a **view**, not a rule. No practice score, XP, achievement, or lane leaderboard (ADR-0004).

### Keybindings / open

| Path | Binding |
|---|---|
| Hash command | `#coach` (`HASH_COMMANDS` + `commandMeta()`) |
| Command palette | `coach.open` — no keybinding |
| Leader | **none** |

### UI (`DESIGN.binance.md`)

**Project work first** (AIEC Output / Context Health / SDLC / Skill Finder — no scores, no prompt text). Session hygiene is secondary. Forbidden: left rails, nested cards, second accent, `backdrop-filter`, uppercased paths, score numerals, raw HTML interpolation. `esc()` / `textContent` for every log string (cwd, path, id, model).

**Primary**

1. Top: title · lookback · `building` · now busy/idle (optional `/telemetry`).
2. **This project** (`projects[0]` or `?cwd=`): languages AI wrote (ext + file count + writes); top files (path, writes, reads); work mix impl/test/doc/config; readiness checklist (present/absent only).
3. **Findings** (max 5): fixed copy table, not rule ids. `{ problem, where=cwd/path, action }` from hits + project rollup. `repeated-prompt` → “same first prompt N times — extract a skill”. `impl-only` → “wrote implementation, no tests”. `thin-context` → “add AGENTS.md”. `write-no-read` → “wrote without reading”. Overlap → “claude + codex both on \<cwd\>”.
4. **Other projects** in the window: one line each (cwd, writes, langs).

**Secondary** (`<details>` “session details”): WoW ended_at totals; rule-id table; overlap `OverlapGroup` cards (cwd + vendors + ids, `groups.len()==2` test); cap-200 session table (no hash); heatmap; WAL if `Some`.

Footer: `read-only observation · no scores · no prompt text · local only`. App-global; no harness ⇒ vendor logs still render.

### Configuration

```toml
[coach]
enabled = true          # false ⇒ /coach still serves HTML; summary is empty, no FS scan
lookback_days = 30      # clamped to 1..=365 at read (0→1, >365→365)
```

Hot-reload via the existing config watcher (`serde(default)` on `CoachConfig`). Changing `lookback_days` or flipping `enabled` on invalidates as above.

### Tests & logging

- Fixtures: path extract Edit/`file_path` + apply_patch markers (no body); work-mix classes; readiness bits; programmatic turns; `ended_at` cohort; two overlap groups with cwd; `impl-only`; WAL `None`=0 kept; `index_version` 2 rebuild; second write replaces dest; no-text JSON; HTML `esc`.
- `log::debug!` / `warn!` only (files scanned, skipped). **Never** log prompt text or line contents.

## Edge Cases

- Missing log dir → empty source. Unreadable / symlink / `>64 MiB` → skip tombstone. Bad JSONL line → skip line.
- `tool_result`-only or programmatic turn → not human. Empty/`<32` first human text → no hash.
- Overlap without `cwd` → no group. Same cwd, two vendors → still overlap.
- WAL kept==0 → `usageOverlay=None`. Invalid vendor → 400 even if disabled. Unknown query keys ignored.
- `try_state` None → `CoachConfig::default()`. Wire `schemaVersion` bump → page “refresh”. Bad `index_version` → rebuild. Non-overlap `groups` **absent** (never JSON `null`).

## Out of Scope

Phase 2: more vendors; ACP event index; community skill catalog / AI review; parent instruction walk; prorated WoW; in-app view; Rule Editor; scores / XP; upload; Host-header.

## Resources

- `src-tauri/src/hook_server.rs` — `handle_dashboard`, `handle_telemetry`, `DASHBOARD_HTML`, `all_telemetry_snapshots`, route table ~7687, `artifact_routes_do_not_conflict`
- `src-tauri/src/usage.rs` — `codex_sessions_dir` (508–516), `newest_rollout_files`, `CODEX_MAX_FILES`
- `src-tauri/src/usage_log.rs` — `TurnRecord`, `pub fn read_day`, `pub fn day_stamp` (UTC), `pub fn rollup`; `src/acp/usage-log.ts` — `TurnUsageRecord`
- `src/acp/hash-commands.ts` — `HASH_COMMANDS`, `commandMeta()`; `src/acp/acp-harness-view.ts` `#dashboard` ~9478
- `docs/168`, `169`, `151`, `214`, `69`, `97`; `docs/adr/0002`, `0004`, `0010`, `0019`
- https://github.com/microsoft/AI-Engineering-Coach (MIT, unofficial)

## Key Decisions

| Decision | Rationale |
|---|---|
| Name = Harness Engineering Coach | Product name; not an AIEC clone |
| Loopback `/coach` + `/coach/summary`, tokenless; walk is an accepted local risk | Sibling bind of `/dashboard`; capability is wider; `enabled=false` is the off switch |
| `#coach` + palette; no Leader letter | Leader map full; matches `#gallery` |
| Adapter JSONL + 214 WAL overlay; no ACP warehouse | 69/97 leave transcripts with adapters |
| 10 Rust rules; no scores | ADR-0004; include `write-no-read` / `impl-only` |
| Index = sessions + skips; derive at query time | Filters must not bake global hits |
| Disk unique tmp; Unix last-rename-wins; Windows best-effort | Crash leftover ignored on load |
| Overlap `OverlapGroup` has cwd + vendors | Stories need the repo |
| Primary UI = files / langs / work mix / readiness / actions | AIEC Output+Context+SDLC; session dump is details |
| Lookback change / enable-on ⇒ re-walk + evict by interval+mtime, not path-date | Resumed Codex rollouts keep the birth-day path |
| Visible S = interval overlap; WoW = `ended_at` cohort | Overlap keeps long sessions on the table; cohort stops double-counting weeks |
| WAL `None` = zero kept rows via `read_day`; cwd cap 20 | No `day_exists`; missing ≡ empty-after-filter |
| Query/lookback: clamp 1..=365; unknown keys ignored; vendor 400 first | Observable API |
| Programmatic peer turns excluded; `repeated-prompt` → `max(ended_at)` | Human work, not mail; no 0/0 |
| Heatmap `chrono::Local`; `esc()` all log strings; stream JSONL | No in-tree TZ helper; ADR-0002 |
| `codex_sessions_dir` stays on `usage.rs`; `try_state` miss → default | No `usage → coach` dep |

## PR Plan

Order 1→5; each PR lands without later ones. Do not start PR3 until the contracts above are this spec.

1. **`coach: parse Claude + Codex JSONL`** — `coach/{mod,paths,parse,session}`, fixtures, `lib.rs`, `pub(crate) codex_sessions_dir`, chrono. Tests only.
2. **`coach: rules + project rollup + WAL`** — work mix, readiness, findings copy, `ended_at` cohort. Deps: 1.
3. **`coach: loopback /coach + /coach/summary`** — routes, `CoachEngine`, `[coach]`, `artifact-coach.html` + `esc()`. Deps: 2.
4. **`coach: #coach + palette open`** — `HASH_COMMANDS` + `commandMeta()` + existing equality test; `#coach` clone of the `#dashboard` block; `openCoach()` clone of `openGallery()`; `command-palette.ts`. Deps: 3.
5. **`coach: docs`** — this spec stays Draft until 3 lands; then `04`, `05`, `06`, `DESIGN.binance.md` (`appliesTo`, table, “seven” counts; analyses/reviews optional), `PROGRESS.md`. Deps: 3–4.
