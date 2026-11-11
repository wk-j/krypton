---
name: external-source-reference
description: Router to the local source repos that are ground truth for Krypton's vendored deps and prior art; read the matching reference before answering. Zed for its ACP client, MCP context-server forwarding, external agent servers, model selection; Obsidian Web Clipper for clipping/import flows, Markdown extraction, template engines, highlights, Obsidian URI/CLI handoff.
---

# External Source Reference

Krypton depends on or studies these local repos as **ground truth**. npm dist types and blog
posts lag — when a question touches one of these, **read the local source before answering.**
This skill is a router: load the one reference file for the source you need.

| Source | Local repo | When to load | Reference |
|--------|-----------|--------------|-----------|
| **zed** | `/Users/wk/Source/zed` | ACP harness work — how Zed implements the ACP client, forwards MCP `context_servers` into `session/new`, manages external agent servers, and selects models | [zed.md](zed.md) |
| **obsidian-clipper** | `/Users/wk/Source/obsidian-clipper` | browser clipping/import flows, Markdown extraction, template variables/filters/logic, highlights, reader mode, cross-browser extension packaging, Obsidian URI/CLI handoff | [obsidian-clipper.md](obsidian-clipper.md) |

## How to use

1. Match the user's task to a row above.
2. Open the matching reference file for the key files, APIs, and patterns.
3. Open the actual source at the listed repo path to confirm — the reference is a map, not a
   substitute. The source wins on any disagreement.

## Notes

- These are **read-only** references for code that lives outside the Krypton tree. Don't edit
  files under these repos as part of Krypton work.
- The reference files give you the entry points so you don't have to scan the whole tree.
- If a reference file disagrees with the source (version drift), trust the source and fix the
  reference.
