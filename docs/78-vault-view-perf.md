# Vault View Load Performance — Implementation Spec

> Status: Implemented
> Date: 2026-05-03
> Milestone: Cross-cutting / perf

## Problem

The vault view (`docs/59-obsidian-vault-window.md`) is slow to load on a realistic vault. Tested with `~/Source/llm-wiki` (344 markdown files, 11 MB, 1188 total entries): every initial open of the view stalls noticeably while `buildVaultIndex` runs, and reopening the same vault root pays the full cost again. The bottleneck is `buildVaultIndex`, not rendering. Explicit `r` (reload) is always expected to take time; this spec targets the cold-open path and the redundant-reopen path.

## Solution

Three surgical fixes inside `src/vault-parser.ts` plus one new Rust bulk-read command. No changes to the public `VaultIndex` shape, no UI/UX changes.

1. Replace serial per-file IPC with one bulk Rust command (`read_vault_files`) that reads all `.md` files in parallel via `tokio::task::spawn_blocking` + `join_all`.
2. Pre-build a `slugMap: Map<string, string>` once per index so wikilink resolution is O(1) instead of O(N) per link. The map stores **every suffix segment** of each file's relative path so that `[[folder/note]]`, `[[note]]`, and full-path links all resolve identically to today's `endsWith('/' + normalized)` linear scan.
3. Defer parsing of `headings` from index time to file-open time. They are only consulted in the file-detail view (outline + status), not in the sidebar/index/backlinks. Tags and wikilinks stay at index time because the global tag map and backlink graph need them.

A small index cache (last `VaultIndex` keyed by `vaultRoot`) skips re-indexing when the user reopens the same vault. Explicit `r` (`reload()`) always rebuilds and overwrites the cache.

## Research

Confirmed by reading source:

- `vault-parser.ts:216-222` — index loop is `for ... { await readVaultFile(absPath); ... }`. 344 files × ~1 ms IPC overhead each ≈ 350 ms minimum even with hot disk cache, before any parsing.
- `vault-parser.ts:150-160` `readVaultFile` invokes `run_command` with `program: 'cat'`. So each read also forks a `cat` subprocess. That's a *huge* per-call overhead (process spawn ≫ file read for a 30 KB note).
- `vault-parser.ts:121-132` `resolveWikilinkTarget` linearly scans `fileMap` per link. With ~1500–3000 wikilinks across 344 files, this is the highest constant factor in the whole pipeline.
- `vault-parser.ts:185` `parseHeadings(body)` runs a global regex over every file's body during index build. The result is only ever read in the file-detail view; nothing in the index path or sidebar uses it.
- `vault-view.ts:1046-1057` `reload()` always rebuilds the entire index, even if vault root and file list are unchanged. Reload is bound to the `r` key so it's a frequent operation.
- `commands.rs:1058-1073` `stat_files` already exists as a bulk command. Pattern is established.
- The frontmatter parser (`vault-parser.ts:45-63`) is naïve — it only handles single-line `key: value` pairs. Good news: it's already cheap. No need to change.

Alternatives considered:
- **Memory-mapped reads in Rust**: rejected — premature; vault is 11 MB, fits comfortably in RAM.
- **Web Worker for parsing**: rejected — adds bundling complexity; the wins below are sufficient.
- **Persisted on-disk index (sqlite/json)**: rejected — out of scope; in-memory cache covers the reload path.

## Prior Art

| App | Indexing approach | Source |
|-----|------------------|--------|
| Foam (VS Code) | Reads files in parallel via `vscode.workspace.fs.readFile`; uses a `Map<resourceId, Resource>` for slug resolution. | foambubble/foam — `packages/foam-vscode/src/core/model/workspace.ts` |
| Obsidian | Lazy: builds a `MetadataCache` on startup, with a normalized-name → file map for wikilinks. | Closed source — described in their public docs ("Plugins / MetadataCache"). Treat as conceptual reference, not verified. |

Logseq's Datalog/Datascript DB approach was considered but ruled out — too heavy for a notes browser and out of scope for this spec.

**Krypton delta** — same approach as Foam: parallel bulk read + pre-built slug map. We additionally defer heading parsing to per-file open since our sidebar doesn't display headings.

## Affected Files

| File | Change |
|------|--------|
| `src-tauri/src/commands.rs` | **NEW** `read_vault_files(paths: Vec<String>) -> Vec<String>` — bulk-read using parallel `tokio::task::spawn_blocking` |
| `src-tauri/src/lib.rs` | Register `read_vault_files` in `invoke_handler` |
| `src/vault-parser.ts` | Replace serial loop with bulk IPC; build `slugMap`; remove `parseHeadings` from `parseVaultFile`; expose `parseHeadingsForFile()` for on-demand use |
| `src/vault-view.ts` | Call `parseHeadingsForFile()` lazily inside `openFile()` guarded by `headingsLoaded`; static `indexCache` short-circuits *re-opens* of the same vault (not `reload()`) |
| `docs/PROGRESS.md` | Note vault perf landed |

## Design

### New Rust command

```rust
// src-tauri/src/commands.rs
#[tauri::command]
pub async fn read_vault_files(paths: Vec<String>) -> Vec<String> {
    use tokio::task;
    let handles: Vec<_> = paths
        .into_iter()
        .map(|p| {
            task::spawn_blocking(move || match std::fs::read(&p) {
                // Lossy decode preserves replacement-char semantics of the
                // existing `cat`-based readVaultFile (which round-tripped
                // bytes through String::from_utf8_lossy at the Rust IPC
                // boundary). Without lossy, files with invalid UTF-8 would
                // newly come back as empty strings — observable behavior change.
                Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
                Err(_) => String::new(),
            })
        })
        .collect();
    let mut out = Vec::with_capacity(handles.len());
    for h in handles {
        out.push(h.await.unwrap_or_default());
    }
    out
}
```

Returns one entry per input path, in the same order. Empty string on read failure or `JoinError`. Invalid UTF-8 → `String::from_utf8_lossy` (replacement chars), matching today's `cat | from_utf8_lossy` behavior in the IPC layer.

### Updated parser

```ts
// src/vault-parser.ts
export async function readVaultFiles(paths: string[]): Promise<string[]> {
  try {
    return await invoke<string[]>('read_vault_files', { paths });
  } catch {
    return paths.map(() => '');
  }
}

// Insert keys for every path-suffix of each file. This matches the
// existing linear scan, which accepts any link whose normalized form
// ends with '/<key>' or equals the full base. Iteration order over
// `files` mirrors insertion order (sorted by listVaultFiles), so the
// `if (!slug.has(key))` guard preserves first-match semantics.
function buildSlugMap(files: Map<string, VaultFile>): Map<string, string> {
  const slug = new Map<string, string>();
  for (const [, file] of files) {
    const base = file.relativePath.replace(/\.md$/, '').toLowerCase();
    if (!slug.has(base)) slug.set(base, file.relativePath);
    const segments = base.split('/');
    // suffixes shorter than full path: 'b/c', 'c' for 'a/b/c'
    for (let i = 1; i < segments.length; i++) {
      const suffix = segments.slice(i).join('/');
      if (!slug.has(suffix)) slug.set(suffix, file.relativePath);
    }
  }
  return slug;
}

function resolveWikilinkTarget(target: string, slug: Map<string, string>): string {
  const normalized = target.toLowerCase().replace(/\.md$/, '');
  return slug.get(normalized) ?? target;
}

export function parseHeadingsForFile(content: string): Heading[] {
  return parseHeadings(content); // existing unexported helper, now reachable
}

export async function buildVaultIndex(root: string): Promise<VaultIndex> {
  const filePaths = await listVaultFiles(root);
  const [contents, mtimes] = await Promise.all([
    readVaultFiles(filePaths),
    invoke<number[]>('stat_files', { paths: filePaths }).catch(() => [] as number[]),
  ]);

  const files = new Map<string, VaultFile>();
  for (let i = 0; i < filePaths.length; i++) {
    const file = parseVaultFile(filePaths[i], root, contents[i]);
    file.modifiedAt = mtimes[i] ?? 0;
    files.set(file.relativePath, file);
  }

  const slug = buildSlugMap(files);
  const backlinks = new Map<string, string[]>();
  const tags = new Map<string, string[]>();

  for (const [, file] of files) {
    for (const link of file.wikilinks) {
      link.target = resolveWikilinkTarget(link.target, slug);
      const arr = backlinks.get(link.target) ?? [];
      arr.push(file.relativePath);
      backlinks.set(link.target, arr);
    }
    for (const tag of file.tags) {
      const arr = tags.get(tag) ?? [];
      arr.push(file.relativePath);
      tags.set(tag, arr);
    }
  }

  return { root, files, backlinks, tags };
}
```

`parseVaultFile` drops the `headings: parseHeadings(body)` call. `VaultFile.headings` becomes `Heading[]` with default `[]`; a sibling `headingsLoaded: boolean` marks whether parsing has run. `vault-view.ts` populates both on first `openFile()`. Using a boolean flag (not `length === 0`) keeps lazy parsing idempotent for files that genuinely have zero headings — without the flag they would re-parse on every reopen.

### Index cache (reopen path, not reload path)

The cache short-circuits the *first-init* path when a vault root has been indexed before (e.g. user closed the view and reopened it). `init()` calls `ensureIndex()` instead of `buildVaultIndex` directly. `reload()` keeps its current behavior — always rebuilds — and overwrites the cache entry. The cache does **not** affect `r`-key reload latency:

```ts
// vault-view.ts
private static indexCache = new Map<string, VaultIndex>();

private async ensureIndex(): Promise<void> {
  const cached = VaultView.indexCache.get(this.vaultRoot);
  if (cached) { this.index = cached; return; }
  this.index = await buildVaultIndex(this.vaultRoot);
  VaultView.indexCache.set(this.vaultRoot, this.index);
}

private async reload(): Promise<void> {
  this.statusBarEl.textContent = 'RELOADING...';
  this.index = await buildVaultIndex(this.vaultRoot);
  VaultView.indexCache.set(this.vaultRoot, this.index);
  // ... rest unchanged
}
```

### Data Flow (init)

```
1. user opens vault view
2. ensureIndex() — cache hit returns immediately, else:
3. listVaultFiles(root) → Vec<String>          (1 IPC, find subprocess)
4. parallel:
   read_vault_files(paths)     → Vec<String>   (1 IPC, parallel fs reads)
   stat_files(paths)           → Vec<u64>       (1 IPC)
5. parseVaultFile per entry (frontmatter + wikilinks + tags only)
6. buildSlugMap(files) once
7. resolve all wikilinks via slug.get() — O(1) each
8. cache VaultIndex by vaultRoot
9. render sidebar
```

Total IPC roundtrips on cold path: **3** (down from `1 + 1 + 344 = 346`).

### Configuration

None.

## Edge Cases

- **Read failure for an individual file**: bulk command returns empty string for that slot — same as today's per-file `readVaultFile` catch branch. Indexing continues.
- **Slug collision** (two notes with same basename in different folders): `buildSlugMap` writes each suffix key only if not already present. Iteration follows insertion order of `files`, which mirrors `listVaultFiles`'s sort — so the first-seen full path wins for ambiguous suffixes. This matches today's linear `endsWith` scan, which also returned the first match.
- **Suffix-path wikilinks** (e.g. `[[folder/note]]`): supported by storing every path-suffix as a key. `[[a/b/c]]`, `[[b/c]]`, and `[[c]]` all resolve to the same file — equivalent to today's `fileBase.endsWith('/' + normalized)` check.
- **Invalid UTF-8 in vault files**: bulk command uses `String::from_utf8_lossy` so replacement chars appear in content (matches today's `cat`-then-utf8-lossy behavior). Without lossy decode, files would silently become empty.
- **`headings: []` lazy population**: `vault-view.ts` checks `if (!file.headingsLoaded) { file.headings = parseHeadingsForFile(content); file.headingsLoaded = true; }` inside `openFile()`. The boolean flag (not `length === 0`) makes this idempotent for files that legitimately have no headings.
- **Index cache staleness across reloads of the *same* vault**: explicit `reload()` overwrites the cache entry. File watcher (out of scope) is not in this spec.
- **Multiple vaults**: cache is keyed by `vaultRoot`, so switching vaults doesn't pollute or evict.

## Open Questions

None. All resolved during research:
- Cache invalidation: explicit `reload()` only. File watcher out of scope.
- Headings on big files: deferred to `openFile`; that path already does heavy markdown rendering, adding heading parse there is a no-op cost compared to the markdown parse it's about to do.
- Bulk command parallelism strategy: `spawn_blocking` per file is fine; tokio's blocking pool caps concurrency, no need to bound it ourselves for 344 files.

## Out of Scope

- Markdown rendering speed (single-threaded line-by-line parse in `vault-view.ts:444-615`). Separate spec if needed.
- Filter input debounce on the sidebar. Negligible impact today.
- Virtual scrolling — current pagination already handles long lists.
- Filesystem watcher / hot-reload. Cache only invalidates on explicit `r`.
- Persisting the index across app restarts.

## Resources

- [`tokio::task::spawn_blocking` docs](https://docs.rs/tokio/latest/tokio/task/fn.spawn_blocking.html) — offloads blocking fs reads without stalling the IPC dispatcher.
- [`String::from_utf8_lossy` docs](https://doc.rust-lang.org/std/string/struct.String.html#method.from_utf8_lossy) — chosen to preserve replacement-char semantics from existing `cat`-based read path.
- [Foam — `workspace.ts`](https://github.com/foambubble/foam/blob/main/packages/foam-vscode/src/core/model/workspace.ts) — slug-map resolution reference.
- Internal: `src-tauri/src/commands.rs:1058-1073` `stat_files` — pattern reference for a bulk-paths Tauri command.
- Internal: `src/vault-parser.ts:121-132` and `:216-222` — current resolver semantics and serial loop being replaced.
- Internal: `docs/59-obsidian-vault-window.md` — original vault feature spec.
