# Code wiki lives in the target repo as markdown, not in the harness memory store

The `#wiki` composer command builds a **code wiki** — an LLM-maintained, compounding set of *why/decisions/domain* pages — for whatever project a lane is working on. We considered storing it in the existing `krypton-harness-memory` MCP store (already persistent and project-scoped via a SHA256-of-cwd JSON file at `~/.config/krypton/acp-harness-memory/`), but instead the wiki is written as plain markdown into the **target repo** at `<cwd>/docs/wiki/`.

## Considered Options

- **Harness memory store** (`memory_set` / per-lane JSON outside the repo). Rejected: it is a per-lane key→`{summary, detail}` blob, not a shared interlinked page-graph; it is opaque, lives outside the repo, and a human cannot browse or diff it. Storing the wiki there would discard the core of the LLM-Wiki pattern — *"the wiki is just a git repo of markdown files; Obsidian is the IDE, the LLM is the programmer, the wiki is the codebase."*
- **New `wiki_*` MCP tools.** Rejected as premature: a lane can already read/write files in its cwd, so ingest/query/lint are just file operations. The LLM-Wiki source itself warns against building tooling before scale demands it.

## Consequences

- The wiki is git-versioned and human-browsable for free; it survives independently of the harness.
- The harness's contribution is **discipline, not storage**: a `#wiki` command (mirroring `#handoff`) that injects a synthesis prompt via `enqueueSystemPrompt`, and a schema (page layout, `index.md`, `log.md`, incremental-ingest workflow) carried in that prompt template. No new persistence and no new MCP server.
- The per-lane `memory_*` store keeps its distinct role: ephemeral working/handoff state, not committed knowledge.
- Concurrent `#wiki` calls from sibling lanes on the same repo can race on the same files and lose edits before git records them; git is post-facto recovery, not race prevention. Acceptable given low frequency; not mitigated.
- "Git-versioned for free" holds only when the target cwd is a git repo; in a non-git cwd the wiki is still usable plain markdown, just without version history.
