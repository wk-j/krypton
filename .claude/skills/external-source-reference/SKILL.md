---
name: external-source-reference
description: Reference for the local external-source repos that are ground truth for Krypton's vendored deps and prior art — pi-mono (@mariozechner/pi-agent-core, pi-ai, pi-coding-agent), pretext (@chenglou/pretext text layout/measurement), Zed editor (ACP / MCP / agent-server / model-selection prior art), and Obsidian Web Clipper (browser clipping, extraction, template rendering, Obsidian handoff). Use when working on src/agent/, debugging agent events, adding tools, or changing models/providers (pi-mono); creating text layouts/animations, measuring text without DOM, or rendering text to canvas/SVG (pretext); studying how Zed implements ACP, MCP context-server forwarding, external agent servers, or model selection for the ACP harness (zed); or designing clipping/import flows, Markdown extraction, template engines, browser-extension surfaces, highlights, or Obsidian URI/CLI handoff (obsidian-clipper).
---

# External Source Reference

Krypton depends on or studies these local repos as **ground truth**. npm dist types and blog
posts lag — when a question touches one of these, **read the local source before answering.**
This skill is a router: load the one reference file for the source you need.

| Source | Local repo | When to load | Reference |
|--------|-----------|--------------|-----------|
| **pi-mono** | `/Users/wk/Source/pi-mono` | `src/agent/`, agent events, adding tools, model/provider changes, anything touching `@mariozechner/pi-agent-core` / `pi-ai` / `pi-coding-agent` | [pi-mono.md](pi-mono.md) |
| **pretext** | `/Users/wk/Source/pretext` | text layout, text animation, measuring text height without DOM reflow, rendering text to canvas/SVG, multiline measurement, `@chenglou/pretext` | [pretext.md](pretext.md) |
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
- pi-mono and zed are large; the reference files give you the entry points so you don't have to
  scan the whole tree.
- If a reference file disagrees with the source (version drift), trust the source and fix the
  reference.
