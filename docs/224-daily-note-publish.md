# Publish the Daily Note to Xenon — Implementation Spec

> Status: Superseded by [225](./225-daily-brief.md)
> Date: 2026-08-15
> Milestone: M-ACP — Harness convergence

**Superseded (2026-08-16).** The `daily` Xenon resource kind, its slug scheme
(`/r/<project>/daily/<date>`), and the push plumbing described here all survive
and are still authoritative. What does not is the two-file model: a day no
longer publishes `note.md` plus an optional `brief.md`, because that put a file
switcher in front of every reader before any content. A day is one file, keyed
`daily.md`, and `<date>.brief.md` is no longer written. See spec 225.

## Problem

The developer daily note (spec 223) is the one record that answers "what did this
project do on day N", and it exists only on the machine that produced it. Spec 223
listed pushing it to Xenon as out of scope, so a note cannot be read from a phone,
linked to from a ticket, or kept once the laptop is reimaged. The **brief** — the
lane's narration of the note — is worse off still: it is turn text that scrolls away
and was never durable at all.

## Solution

Add `daily` as Xenon's sixth resource kind. One resource per day, slug `<YYYY-MM-DD>`,
carrying up to two files: the deterministic `note.md` and, when it exists, the lane's
`brief.md`. Publishing rides the existing `#push` machinery unchanged — manifest
negotiation, blob dedupe, secret pre-scan, retry queue and permalinks all come free.

To make the brief publishable it must first become a file: `#daily brief` gains a
sibling output at `<output_dir>/<date>.brief.md`, written by the lane with its own
file tools. The deterministic note is still never written by a model — the two live
in separate files, and the manifest labels which is which.

## Research

- `xenon::KINDS` is a 5-element const (`artifact`, `review`, `analysis`, `doc`,
  `attention`) validated in `commands.rs::xenon_push:1429`. `collect(cwd, kind,
  slug_filter)` dispatches per kind; `collect_bundles` handles directory-shaped kinds
  and `collect_docs` file-shaped ones. A sixth arm is the whole backend change.
- `Publisher` already runs `scan_for_secrets` over every text file and every `meta`
  before upload (`xenon.rs:965/987`), blocking rather than leaking. A daily note gets
  that for free — worth having, since notes quote commit subjects and the human's own
  `#daily note` lines.
- `journal::note_path(cwd, output_dir, date)` already resolves `[daily_note].output_dir`,
  including the absolute-vault-path case. The collector must go through it rather than
  hardcoding `.krypton/journal`.
- **Pre-existing gap found while researching:** `hook_server::collect_journal_notes:5112`
  *does* hardcode `.krypton/journal`, so with an absolute `output_dir` the `/journal`
  index silently lists nothing. Not caused by this spec; noted so the new collector does
  not copy the mistake. Fixing `/journal` is out of scope here.
- **Spec 161 is the deciding precedent for how the brief gets written.** Four
  `directive_*` MCP tools were deleted to reclaim ~1,224 tokens *per turn*; authoring
  moved to `#directive`, where the agent edits the file with its own tools. A
  `daily_brief_set` MCP tool would be used once a day and taxed on every turn of every
  lane forever, so the brief is written the `#directive` way.
- `enqueueSystemPrompt()` is fire-and-forget with no completion callback, and lanes keep
  no last-answer buffer. Harvesting the brief out of the transcript would mean new
  plumbing in the event path; having the lane write the file is strictly less machinery.
- `PushOutcome` already models `Unchanged`, so re-pushing a day whose note has not
  changed is a no-op round trip, and regenerating a note that produces identical bytes
  costs nothing.

## Prior Art

| Tool | Implementation | Notes |
|---|---|---|
| [dev-journal](https://github.com/LakshmiSravyaVedantham/dev-journal) | `collect` then `generate`; output stays local files | The tool closest to spec 223 has no publish step at all — local-only is the norm here |
| [standup-journal-mcp](https://glama.ai/mcp/servers/rominap22/standup-journal-mcp) | Logging and standup generation exposed as MCP tools | The design this spec deliberately rejects: an everyday token cost for a once-a-day action (spec 161) |
| [Obsidian Publish](https://obsidian.md/help/getting-started/sync-your-notes-across-devices) | Per-note opt-in, custom domain, password protection; explicitly not whole-vault | Confirms per-note opt-in over blanket sync — matches `#push daily <date>` |
| [obsidian-sync-share](https://github.com/Alt-er/obsidian-sync-share) | Self-hosted Docker backend, share links per note | Same posture as Xenon: your own server, permalink per note |
| [Permalink Opener](https://www.obsidianstats.com/plugins/noteson-publish) | Maps a local note to its published URL by slug | Why the slug is the bare date — the local filename and the permalink stay guessable from each other |

**Krypton delta** — every tool above publishes prose a human wrote. Krypton publishes a
record a *machine* derived, alongside an optional model narration, and keeps the two in
separate files so the reader can always tell which is which. No tool surveyed makes that
distinction; the daily-note market treats "the note" as one undifferentiated blob.

## Affected Files

| File | Change |
|---|---|
| `src-tauri/src/xenon.rs` | `KINDS` gains `daily`; `collect()` takes the resolved daily dir; new `collect_daily()` |
| `src-tauri/src/journal.rs` | `brief_path()`; `note_dates()` — enumerate rendered days in the configured dir |
| `src-tauri/src/commands.rs` | `xenon_push` passes `[daily_note].output_dir` into `collect()` |
| `src/acp/harness-prompts.ts` | `dailyBriefPrompt()` gains the brief path + the write instruction |
| `src/acp/acp-harness-view.ts` | `#daily brief` resolves and passes the brief path |
| `src/acp/hash-commands.ts` | `#push` description lists `daily` |
| `docs/212-xenon-resource-server.md`, `docs/223-developer-daily-note.md` | Kind table + the out-of-scope line this spec retires |
| `docs/06-configuration.md`, `docs/README.md` | `auto_push` values; index entry |

## Design

### Data Structures

No new types. The resource is assembled with the existing `LocalResource`:

```rust
// xenon.rs — one day, one resource. Two files at most, both markdown.
LocalResource {
    manifest: ResourceManifest {
        kind: "daily",
        slug: "2026-08-15",                 // bare local date; matches the filename
        title: /* the note's H1, via title_from_markdown */,
        origin: origin_value(cwd),
        meta: json!({
            "source": daily_dir_display,     // ".krypton/journal" or the vault path
            "date": "2026-08-15",
            "hasBrief": true,
            // The reader must never have to guess which file a model wrote.
            "briefAuthor": "lane-narration",
            "noteAuthor": "krypton-journal",
        }),
        files: Vec::new(),
    },
    sources: { "note.md": <path>, "brief.md": <path> },   // brief.md only when present
    inline: BTreeMap::new(),
}
```

A `<date>.generated.md` (spec 223's protected-note fallback) is pushed **instead of**
`<date>.md` when it exists, since it is the current machine-generated truth; the
hand-edited original stays local. `meta.handEdited: true` records that it happened.

### API / Commands

| Command | Change |
|---|---|
| `xenon_push` | Unchanged signature. `kind: "daily"` now validates, and the daily dir is read from config before `collect()` |
| `daily_note_write` | Unchanged — the brief is written by the lane, not through this |

```rust
// journal.rs
pub fn brief_path(cwd: &Path, output_dir: &str, date: &str) -> PathBuf; // <dir>/<date>.brief.md
pub fn note_dates(cwd: &Path, output_dir: &str) -> Vec<String>;         // newest first

// xenon.rs — the daily dir is resolved by the caller, which owns config access
pub fn collect(cwd: &Path, kind: &str, slug_filter: Option<&str>, daily_dir: &Path)
    -> Result<Vec<LocalResource>, String>;
```

### Data Flow

```
Brief (opt-in, unchanged trigger)
1. User runs #daily brief [<date>] [<focus>]
2. Harness builds the digest, renders the note, and resolves brief_path()
3. dailyBriefPrompt() now ends with: write the same narration to <brief path>,
   as markdown with `generated: lane-narration` frontmatter, and change nothing else
4. Lane answers in the transcript AND writes <date>.brief.md with its own file tool
   (one fs_write permission prompt, per lane, per day)

Publish
5. User runs #push daily [<date>]  (or a bare #push when auto_push lists it)
6. commands.rs reads [daily_note].output_dir, resolves the dir, calls collect()
7. collect_daily() walks the dir, pairs <date>.md (or <date>.generated.md) with
   <date>.brief.md, one LocalResource per day, filtered by slug when given
8. Publisher: secret pre-scan → manifest POST → upload missing blobs → commit
9. PushReport per day; permalink /r/<project>/daily/<date>
```

### Keybindings

| Form | Action |
|---|---|
| `#push daily` | Publish every rendered note in the configured directory |
| `#push daily 2026-08-15` | Publish one day |
| `#daily brief [<date>] [<focus>]` | Narrate **and** write `<date>.brief.md` |

No new keybinding. `Leader J` still opens today's note locally.

### Configuration

No new keys. `[xenon].auto_push` accepts `"daily"`; `[daily_note].output_dir` is
reused as the source directory.

```toml
[xenon]
auto_push = ["review", "daily"]   # a bare #push now covers rendered notes too
```

`daily` is **not** added to the auto-push-on-write exception that `attention` has: a
note is durable on disk, so it stays manual like every other kind.

## Edge Cases

| Case | Handling |
|---|---|
| No note rendered for a date | `#push daily <date>` reports `blocked: no note for <date>` rather than silently pushing nothing |
| Brief exists, note does not | Not collected. The brief is a reading *of* the note; publishing it alone would put a model's prose on the server with no record behind it |
| Both `<date>.md` and `<date>.generated.md` exist | The generated one is pushed as `note.md`, `meta.handEdited: true`; the hand-edited file stays local |
| `output_dir` is an absolute vault path | Resolved through `journal::note_path`, so it works. `/journal` still won't list it — pre-existing, out of scope |
| Note contains a credential-shaped string | The existing pre-scan blocks the day and names the hit; `#push --force daily` overrides after the human reads it |
| Re-push of an unchanged day | `PushOutcome::Unchanged`, one round trip, no upload |
| Lane refuses or fails the brief write | The turn still answers in the transcript; `#push daily` publishes note-only. A brief is never required |
| Brief written for the wrong day | The path is computed by the harness from the digest's own `date` and passed in; the lane is told the filename, not asked to derive it |
| Notes accumulate for months | `#push daily` with no slug pushes all of them; dedupe makes repeats cheap, and `#push daily <date>` stays the targeted form |

## Out of Scope

- Auto-publishing a note when it is rendered. Publishing stays explicit (ADR 0016)
- A Xenon-side daily *view* (calendar, streak, cross-project rollup) — this ships the
  resource; presentation is a Xenon change
- Fixing `/journal` to honour an absolute `output_dir`
- Pushing the raw `.krypton/journal/<date>.jsonl` capture log. It is an implementation
  substrate, not a record a human reads
- Weekly/monthly rollups, and pushing to Telegram or Slack
- Retiring the local Markdown Viewer path — the note is still opened locally first

## Implementation Notes

Deviations from the design above, and why.

| Change | Reason |
|---|---|
| `src/acp/xenon-push.ts` was also edited — it was missing from Affected Files | The kind list is duplicated: `XENON_KINDS` validates in the frontend *before* `xenon_push` is invoked, so without it `#push daily` fails with "unknown kind" and never reaches the Rust arm. Both lists now carry a comment naming the other |
| A new `daily_brief_path` command, rather than resolving the path in the harness view | `[daily_note].output_dir` may be absolute (a vault) or project-relative; that rule already lives in `journal::notes_dir`, and reimplementing it in TypeScript would be a second copy that can drift |
| `journal::note_dates_in(dir)` takes a resolved directory, not `(cwd, output_dir)` | Its only caller is the collector, which already resolved one. The `(cwd, output_dir)` form would have been an unused wrapper |
| `#push daily <date>` with no note returns an `Err`, not a `Blocked` item | `Blocked` is built inside `Publisher::push_resource`, which never sees a resource that was not collected. An error surfaces the same message through the same chip, and the form only ever pushes one kind |
| `collect()` gained a `daily_dir` parameter instead of reading config | `xenon.rs` has no config access by design; `commands.rs` already holds the lock |
| The `/commands` reference page shows the write-the-brief prompt | `hash-commands.ts` renders `dailyBriefPrompt` for the page. Passing no path would have documented a behaviour the command no longer has |

Verified: `cargo fmt --check` clean, `cargo clippy --all-targets` clean in both changed
modules, 303 Rust tests (4 new for `collect_daily`, 2 new in `journal.rs`) and 796
frontend tests green, `tsc --noEmit` clean. Not yet exercised against a live Xenon
server — the collector is unit-tested against real temp directories, but the
manifest/blob/commit round trip for the new kind is unproven until the app is
rebuilt and pushed at one.

## Resources

- [dev-journal](https://github.com/LakshmiSravyaVedantham/dev-journal) — the local-only baseline this spec extends past
- [standup-journal-mcp](https://glama.ai/mcp/servers/rominap22/standup-journal-mcp) — the MCP-tool approach, rejected on spec 161's per-turn token grounds
- [Obsidian Publish — sync and publishing model](https://obsidian.md/help/getting-started/sync-your-notes-across-devices) — per-note opt-in rather than whole-vault sync
- [obsidian-sync-share](https://github.com/Alt-er/obsidian-sync-share) — self-hosted publish backend with per-note share links
- [Obsidian publishing plugins survey (2026)](https://www.obsidianstats.com/posts/2025-04-16-publish-plugins) — permalink/slug conventions across the plugin ecosystem
