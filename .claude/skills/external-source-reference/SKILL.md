---
name: external-source-reference
description: Router to the local source repos that are ground truth for Krypton's vendored deps and prior art; read the matching reference before answering. pi-mono (pi-agent-core, pi-ai, pi-coding-agent) for src/agent/, agent events, tools, models/providers; Zed for its ACP client, MCP context-server forwarding, external agent servers, model selection; Obsidian Web Clipper for clipping/import flows, Markdown extraction, template engines, highlights, Obsidian URI/CLI handoff; Omnigent for multi-agent orchestration, sub-agent fanout, cross-review, native coding-agent harnesses, Polly/Debby/Scribe-style agents.
---

# External Source Reference

Krypton depends on or studies these local repos as **ground truth**. npm dist types and blog
posts lag — when a question touches one of these, **read the local source before answering.**
This skill is a router: load the one reference file for the source you need.

| Source | Local repo | When to load | Reference |
|--------|-----------|--------------|-----------|
| **pi-mono** | `/Users/wk/Source/pi-mono` | `src/agent/`, agent events, adding tools, model/provider changes, anything touching `@mariozechner/pi-agent-core` / `pi-ai` / `pi-coding-agent` | [pi-mono.md](pi-mono.md) |
| **zed** | `/Users/wk/Source/zed` | ACP harness work — how Zed implements the ACP client, forwards MCP `context_servers` into `session/new`, manages external agent servers, and selects models | [zed.md](zed.md) |
| **obsidian-clipper** | `/Users/wk/Source/obsidian-clipper` | browser clipping/import flows, Markdown extraction, template variables/filters/logic, highlights, reader mode, cross-browser extension packaging, Obsidian URI/CLI handoff | [obsidian-clipper.md](obsidian-clipper.md) |
| **omnigent** | `/Users/wk/Source/omnigent` | multi-agent orchestration, Polly/Debby/Scribe examples, sub-agent fanout, cross-vendor review, native coding-agent harnesses, terminal bridge behavior, model routing, cost/profile selection | [omnigent.md](omnigent.md) |

## How to use

1. Match the user's task to a row above.
2. Open the matching reference file for the key files, APIs, and patterns.
3. Open the actual source at the listed repo path to confirm — the reference is a map, not a
   substitute. The source wins on any disagreement.

## Notes

- These are **read-only** references for code that lives outside the Krypton tree. Don't edit
  files under these repos as part of Krypton work.
- pi-mono and zed are large; the reference files give you the entry points so you don't have to
  scan the whole tree.
- If a reference file disagrees with the source (version drift), trust the source and fix the
  reference.
