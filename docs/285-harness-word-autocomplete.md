# ACP Harness Word Autocomplete (Ghost Text) — Implementation Spec

> Status: Implemented (rev 3: Krypton-owned engine, all-lane history in SQLite)
> Date: 2026-10-10
> Milestone: ACP Harness polish

## Problem

OMP's TUI prompt shows a dim predicted completion for the word you are typing
(`la` → `la`+`nguage`). `Tab` or `→` accepts it. The ACP Harness composer has
nothing like this. Suggestions must also learn from **every harness lane**:
prompts typed to Claude, Codex, OMP, Gemini, and other lanes all feed one shared
word history.

## Solution

Ship a Krypton-owned predictor:

1. **One prompt history for all lanes.** Every prompt submitted from the harness
   composer, from any lane, backend, or Harness view (local or remote), is
   recorded by the Rust backend in a SQLite DB at
   `~/.config/krypton/harness-prompt-history.db`, the same shape as OMP's `history.db`.
2. **One n-gram engine in a Web Worker.** The engine starts from that history.
   It is also seeded **read-only** from the prompt histories the user already
   has: OMP `~/.omp/agent/history.db`, Claude Code `~/.claude/history.jsonl`, and
   Codex `~/.codex/history.jsonl`. These are the same sources OMP's own n-gram
   bootstraps from. Each new submit updates the model at once.
3. **Words come from `Intl.Segmenter`** (JavaScriptCore/ICU), so Thai is
   predicted as well as space-separated languages.
4. The **UX matches OMP**: the suggestion shows as dim ghost text after the
   caret, `Tab` accepts it and adds a space, and `→` accepts it with no space.

## Research

- **OMP's engine cannot learn from harness lanes.** Its `text-predict` daemon
  ingests only `~/.omp/agent/history.db` rows with `id > cursor`
  (`predict/daemon.ts`). It reads Claude/Codex `history.jsonl`
  (`predict/foreign-history.ts`) only once, when its state is first created.
  An ingest `sync` happens only when the **interactive TUI** adds a history row
  (`historyStorage.setAddListener(KGr)`).
  - Checked 2026-10-10: this session's prompts went through `omp acp` and are
    **not** in `history.db`. The newest row is a TUI prompt from 16:09.
  - Claude/Codex lane prompts never reach it.
- Keeping OMP's engine would mean writing Krypton prompts into OMP's
  `history.db` (a foreign schema at `user_version = 1`). The rows would also be
  ingested only after the daemon's idle restart or the next TUI prompt, unless
  Krypton spoke the daemon's private, version-gated socket protocol. On top of
  that, a ~414 MB `omp --mode rpc` sidecar, no Thai output (`"ช่วยแก้ ภา"` →
  `null`), and a hard `omp` install dependency. **Rejected.**
- `Intl.Segmenter('th', {granularity:'word'})` in JSC (the WKWebView engine,
  tested with Bun):
  - `ช่วยแก้ภาษาไทยให้หน่อย` → `ช่วย|แก้|ภาษา|ไทย|ให้|หน่อย`
  - The partial input `ช่วยแก้ภาษ` → `ช่วย|แก้|ภาษ`: the trailing prefix stays one
    segment.
  - The whole Claude history (308,586 chars → 51,746 words) segmented in 20 ms.
- Corpus size today: Claude history 309 K chars, OMP `history.db` 4.6 K chars,
  Codex 19 KB file. The model fits in a few MB.
- Harness composer (`acp-harness-view.ts`):
  - The draft and cursor are `lane.draft` + `lane.cursor`. `setDraft()` calls
    `renderComposer()`, which rebuilds `before<span class="acp-harness__caret">█</span>after`.
  - Every lane submits through `submitActiveLane()`. Its in-memory
    `lane.promptHistory` holds 100 entries per lane and is not persisted.
  - Palettes own `Tab` while visible. Plain `Tab` is otherwise unbound.
- Workers are an existing pattern: `cursor-trail-worker.ts`,
  `keyboard-overlay-worker.ts`, `animation-worker.ts` via
  `new Worker(new URL(…), { type: 'module' })`.

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| OMP TUI | n-gram trained from its own prompt history, plus a one-time Claude/Codex bootstrap. Ghost text shows only at end of line. `Tab` accepts + space; `→` accepts with no space. | The UX matched here. The learning source is broader here. |
| fish | Grey autosuggestion from shell history. `→`/`Ctrl+F` accepts all; `Alt+→` accepts one word. | `→` convention. |
| zsh-autosuggestions | fish-like, history strategy. `forward-char` accepts. | Same. |
| GitHub Copilot | Inline ghost text, `Tab` accepts. | `Tab` convention. |

**Krypton delta** — Same keys and look as OMP. The history is shared across all
lanes and backends, Thai works, and there is no external process.

## Affected Files

| File | Change |
|------|--------|
| `src-tauri/src/prompt_history.rs` (new) | SQLite prompt store (dedupe + cap); read-only corpus loader for the four sources; two commands. |
| `src-tauri/src/lib.rs` | Register the commands. |
| `src-tauri/src/config.rs`, `src/config.ts` | `[acp_harness] word_autocomplete = true`. |
| `src/acp/word-predict-model.ts` (new) | Pure n-gram model: tokenize, observe, complete. |
| `src/acp/word-predict-worker.ts` (new) | Worker that hosts the model. |
| `src/acp/word-predict.ts` (new) | Main-thread client (lazy worker, latest-wins requests) plus ghost helpers (eligibility, accept, type-through). |
| `src/acp/acp-harness-view.ts` | Log on submit, request on draft change, render the ghost, `Tab`/`→` accept. |
| `src/styles/acp-harness.css` | `.acp-harness__ghost`. |
| Tests | Model ranking/threshold/Thai, ghost helpers, Rust log cap and source parsing. |
| `docs/72-acp-harness-view.md`, `docs/06-configuration.md`, `docs/04-architecture.md`, `docs/05-data-flow.md`, `docs/README.md` | Contract, keys, config, storage. |

## Design

### Backend — `prompt_history.rs`

```rust
#[tauri::command] async fn harness_prompt_log(text: String, backend_id: Option<String>, cwd: Option<String>) -> Result<bool, String> // true = new row
#[tauri::command] async fn harness_word_corpus() -> Result<Vec<String>, String>
```

- **Store**: `~/.config/krypton/harness-prompt-history.db`, created with mode `0600`.
  It uses `journal_mode = WAL` and `busy_timeout = 2000`, and one connection
  lives in Tauri state behind a `Mutex`. Krypton's other own stores are JSON
  files, and SQLite was used before only to *read* external DBs. This is
  Krypton's first SQLite store it owns. It is chosen because this data is
  append-heavy, needs dedupe, and is written by every lane.

  ```sql
  CREATE TABLE IF NOT EXISTS prompt_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    prompt TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,          -- unix seconds, last use
    use_count INTEGER NOT NULL DEFAULT 1,
    backend_id TEXT,                      -- lane backend at last use (claude, codex, omp, …)
    cwd TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_prompt_history_created_at ON prompt_history(created_at DESC);
  PRAGMA user_version = 1;
  ```

  - Insert is `INSERT … ON CONFLICT(prompt) DO UPDATE SET use_count = use_count + 1,
    created_at = excluded.created_at, backend_id = excluded.backend_id, cwd = excluded.cwd`,
    the same rule as OMP. Repeated prompts such as `Ok` or `Yes` stay one row.
  - Skipped: empty text, text starting with `/`, `#`, or `!` (commands and
    shell escapes), and texts over 8 KB (pastes).
  - Cap: after an insert, if the row count is over 20,000, the oldest rows by
    `created_at` are deleted down to 20,000. This runs in the same transaction,
    with no file rewrite.
  - `harness_prompt_log(text, backendId, cwd)` returns whether the row is new.
    The model observes only new rows, so repeating a prompt does not inflate its
    counts (OMP observes each row once).
  - The prompts stay in the user's own config dir and are never sent anywhere.
  - Each write is atomic, and WAL lets two Krypton instances append concurrently
    without losing rows.
- **Corpus**: `harness_word_corpus` returns texts oldest-first, read in this
  order: Claude `display`, Codex `text`, OMP `SELECT prompt FROM history ORDER BY id`
  (opened `SQLITE_OPEN_READ_ONLY` with busy timeout 200 ms), then the Krypton store
  (`ORDER BY id`).
  - Each source is optional. A missing or unreadable source is skipped with a
    `debug!` log.
  - Lines starting with `/` and `[Pasted text #n]` / `[Image #n]` markers are
    stripped, as OMP does.
  - The total is capped at the newest 4 MB of text.

### Model — `word-predict-model.ts`

```ts
export class WordModel {
  observe(text: string): void;                       // update counts
  complete(before: string): string | null;           // suffix for the word ending at end of `before`
}
```

- **Tokens**: `Intl.Segmenter(undefined, {granularity:'word'})` keeps
  `isWordLike` segments.
  - Matching is case-insensitive. The key is NFC `toLowerCase()`, and the
    most-seen surface form is stored per key.
- **Counts**:
  - `unigram: Map<key, n>`.
  - `bigram: Map<prevKey, Map<key, n>>`, reset at each sentence or line break.
  - A sorted key array is rebuilt lazily after `observe()` and used to find the
    prefix range by binary search.
- **Complete**:
  - The prefix is the last word-like segment ending exactly at the cursor. It
    must be ≥2 code points; for Thai it must be ≥2 non-combining characters.
  - The candidates are the keys that start with the prefix and are longer than it.
  - The score is `3·bigram(prev, w) + unigram(w)`.
  - A suggestion is shown only if the best candidate's score is ≥2, is ≥20 %
    of all scores for the prefix (the typed prefix as a finished word
    included), **and** is ≥1.2× the runner-up. This keeps out low-confidence
    noise, as OMP's show threshold does.
  - *Deviation from the approved draft (≥40 % share):* with 40 %, the real
    history (5,229 prompts) did not even give `thai la` → `language`, which has
    only a 23 % share. The share + lead rule does show it, and still stays
    silent for `please re` (11 %), ties, and `the` (an 88 % exact match).
  - The suffix is `surface.slice(prefix.length)`.
  - Thai fallback: if the segmenter split a partial word into several short
    segments, it retries with the last 2–3 segments joined and takes the longest
    joined prefix that has candidates.
- No accept/reject feedback weighting in this rev. Accepted words reach the
  model through the submitted prompt.

### Frontend flow

```
1. Harness first focus → word-predict client lazily spawns the worker → worker calls
   invoke('harness_word_corpus') via the main thread (postMessage) → observe() all
2. setDraft(): typed char === ghost.suffix[0] → shorten the ghost (no flicker);
   otherwise clear the ghost
3. Eligible (config on; cursor at end of text or before '\n'; no palette; not
   dictating; no pending permission/question; focus = text) → seq++ →
   worker.complete(lane.draft.slice(0, cursor))
4. Reply: drop it if seq is stale or lane.draft/cursor changed → ghost → renderComposer()
5. Tab → accept + space (no space if the word is Thai/Lao/Khmer/Myanmar/CJK);
   → → accept with no space. Both use setDraft() with no bloom (spec 252: completion ≠ insertion)
6. submitActiveLane(): invoke('harness_prompt_log', { text, backendId, cwd }) → if new row, worker.observe(text)
```

### Keybindings

| Key | Context | Action |
|-----|---------|--------|
| `Tab` | Composer, ghost visible, no palette open | Accept suggestion (+ space for space-delimited scripts) |
| `→` | Composer, ghost visible | Accept suggestion, no space |
| any other key | Ghost visible | Normal behaviour; ghost re-predicts or clears |

### UI

```html
…la<span class="acp-harness__caret">█</span><span class="acp-harness__ghost" aria-hidden="true">nguage</span>
```

`.acp-harness__ghost` uses the inherited font and
`color: rgba(var(--krypton-fg-rgb), 0.38)`. There is no glow, animation, or
selection. It is hidden in `--command` mode.

### Configuration

```toml
[acp_harness]
word_autocomplete = true   # ghost-text word completion; history is logged regardless of this flag
```

When `false`, no ghost is shown and the worker is not spawned. Prompts are still
logged, so turning the feature on later does not start cold. The key applies on
Reload Config.

## Edge Cases

- **First keystrokes before the corpus loads**: no ghost, and no blocking.
- **Multi-line draft**: a ghost appears only at the end of the text or before `\n`.
- **Mid-word cursor**: none.
- **Remote Harness**: the composer, log, and worker are local. Remote lanes
  share the same history.
- **Two Krypton instances**: WAL + `busy_timeout` serialise the writers, and no
  rows are lost. Each instance's in-memory model only sees the other's prompts
  after its next corpus load. This is accepted.
- **DB corrupt or unopenable**: logging returns `Err`, which the frontend
  ignores with a `warn!` logged once, and prediction still runs on the
  read-only seed sources. The DB is never deleted automatically.
- **Lane switch**: the ghost is keyed by `laneId` and cleared on switch.
- **History recall (`↑`/`↓`)**: no prediction.
- **Secrets typed into prompts** are stored in the local DB, just as they are
  in OMP/Claude/Codex history today. The DB file is created with mode `0600`.

## Open Questions

None. Rev 2 replaces rev 1's OMP RPC sidecar, because that engine cannot learn
from non-OMP lanes or from ACP prompts.

## Out of Scope

- Persisting `lane.promptHistory` (`↑`/`↓` recall) across restarts.
- Multi-word or sentence suggestions, partial accept, and accept/reject weighting.
- A SmolLM/LLM-backed engine.
- Agent view composer, Live Assist composer, terminal panes.
- Writing into OMP/Claude/Codex history files (read-only seed only).

## Resources

- `omp` 18.8.7 bundle (`~/Library/Application Support/Tern/omp/versions/18.8.7`):
  `predict/daemon.ts` (history cursor ingest), `predict/foreign-history.ts`,
  `predict/client.ts`, `rpc-mode.ts` `predict_word`, `interactive-mode` `setAddListener(KGr)`.
- `/Users/wk/Source/oh-my-pi/packages/tui/src/components/editor.ts`: inline-hint
  rendering only at the cursor's end of line.
- Local JSC probe (Bun, 2026-10-10): `Intl.Segmenter('th', {granularity:'word'})` output and corpus timing quoted in Research.
- [fish shell — Autosuggestions](https://fishshell.com/docs/current/interactive.html): `→` accept convention.
- [zsh-autosuggestions README](https://github.com/zsh-users/zsh-autosuggestions/blob/master/README.md): history-strategy suggestions.
- `docs/252-harness-composer-soft-bloom.md`: completion acceptance does not bloom.
