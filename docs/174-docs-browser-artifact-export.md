# Docs Browser Artifact Export — Implementation Spec

> Status: Implemented
> Date: 2026-06-23
> Milestone: ACP Harness — observability
> Builds on: `docs/171-docs-browser.md`, `docs/172-docs-browser-inline-feedback.md`, `docs/133-harness-html-artifacts.md`

## Problem

The Docs browser can render repo markdown and send point comments back to a lane,
but it cannot turn the current document into a lane-authored HTML artifact from
inside the browser. The user has to return to the harness composer and manually
ask an agent to create an artifact for the doc they are already reading.

## As-built

Implemented as the `/doc` reader's compact `artifact` pill plus the `a` shortcut
when focus is not inside an editor or the feedback overlay. The page POSTs
`{ batchId, title }` to `POST /doc-artifact?harness=<id>&path=<rel>` using the
default title `Docs artifact · <basename>`.

Rust validates the harness, repo-relative `.md` path, non-empty `batchId`, and
artifact-title length, then emits `acp-docs-artifact-requested` and waits for the
same `acp_bus_reply` round-trip used by docs feedback. The frontend resolves the
harness's active live lane, queues a `DocArtifactRequestEnvelope`, and drains it
on the next `idle`/`awaiting_peer` transition. The queue lives in
`src/acp/artifact-feedback.ts` beside the existing shared drain-on-idle
feedback core rather than a separate `browser-request-queue.ts`; the behavior is
the same, with less file churn.

## Solution

Add a **Generate artifact** action to `/doc` pages. The browser posts a small
request (`harness` + `path` + idempotency key + title) to the existing loopback
server. The **browser owns the default title** (`Docs artifact · <basename>`) and
always sends it; Rust validates the doc path/title and emits a synchronous bus
event. The frontend routes it to the harness's active live lane and queues a
system turn that instructs the lane to read the source markdown, call
`artifact_new`, edit the issued scaffold, and call `artifact_register`. The
browser does not write the artifact itself because artifacts are intentionally
lane-authored, transcripted, feedback-capable files.

## Research

- Existing docs feedback already solves the browser-to-active-lane transport:
  `/doc-feedback` validates the same `harness` + `path`, emits
  `acp-docs-feedback-received`, and waits for `acp_bus_reply`.
- Artifact creation is intentionally an agent/lane operation (`artifact_new` →
  edit scaffold → `artifact_register`) so the transcript card, write grant,
  feedback token, path redaction, and pending cap all stay consistent.
- VS Code's Markdown preview keeps preview and source connected, including live
  preview, side-by-side viewing, scroll sync, and double-click navigation back to
  source. Krypton should similarly keep the generated artifact tied to the source
  doc rather than only copying rendered DOM.
- MkDocs represents the traditional path: convert Markdown into a static HTML
  documentation site with live preview while writing. This feature is narrower:
  one ad-hoc, lane-authored artifact for the current doc, not a docs-site build.
- Obsidian Publish is a hosted publish flow for selected notes. Krypton diverges:
  the result stays local, ephemeral/recoverable through the artifact registry,
  and can include agent-added structure or visualization beyond a raw export.

## Prior Art

| App | Implementation | Notes |
|-----|----------------|-------|
| VS Code | Markdown preview and preview-to-source linkage | Familiar model: a rendered doc action should preserve source context. |
| MkDocs | Builds Markdown source files into static HTML docs | Similar output medium, but whole-site and deterministic rather than lane-authored. |
| Obsidian Publish | Publishes selected Markdown notes as a hosted site | Similar "turn notes into browsable HTML" intent, but cloud-hosted and not agent-generated. |
| Browser "Save Page As" | Saves the current rendered page | Rejected as the primary model because it would bypass artifact registry and feedback. |

**Krypton delta** — The action is in the browser where the user is reading, but
the generated file still flows through the ACP lane artifact contract. That keeps
keyboard/browser ergonomics without creating a second, untracked artifact path.

## Affected Files

| File | Change |
|------|--------|
| `src/acp/artifact-docs.html` | Add a `/doc`-only fixed action beside the feedback pill: button + `a` shortcut, POSTing a doc artifact request and showing queued/error state. |
| `src-tauri/src/hook_server.rs` | Add `POST /doc-artifact?harness=<id>&path=<rel>`; validate path, cap title, emit `acp-docs-artifact-requested`, await `acp_bus_reply`, return accepted/no-live-lane/retry. |
| `src/acp/types.ts` | Add `DocArtifactRequestEnvelope` type. |
| `src/acp/artifact-feedback.ts` | Add `DocArtifactRequestQueue` beside the existing shared drain-on-idle feedback core. Artifact generation is not feedback, but the existing base queue already provides the right idle/awaiting-peer drain semantics without a new module. |
| `src/acp/acp-harness-view.ts` | Listen for `acp-docs-artifact-requested`, route to the active live lane, enqueue the request, append a transcript row, and reply to Rust. |
| `docs/171-docs-browser.md` | Note that `/doc` now has a generate-artifact action. |
| `docs/PROGRESS.md` | Record the landing when implemented. |
| `docs/adr/0010-docs-browser-serves-repo-markdown-over-tokenless-loopback.md` | Amend the tokenless write-channel section to include artifact-generation requests. |

## Design

### Data Structures

```ts
export interface DocArtifactRequestEnvelope {
  kind: 'doc_artifact_request';
  batchId: string;
  harnessId: string;
  docPath: string;
  title: string;
  sentAt: number;
}
```

### API / Commands

`POST /doc-artifact?harness=<id>&path=<rel>`

Body:

```json
{ "batchId": "da-...", "title": "Artifact title" }
```

Responses:

- `200 { "status": "accepted" }` — request queued into the active lane.
- `409 { "status": "no-live-lane" }` — no active live lane exists.
- `400` — missing `batchId`, missing/empty `title`, or malformed body.
- `404` — unknown harness or invalid/nonexistent `.md` path.
- `413` — title too long.
- `503 { "status": "retry" }` — frontend did not answer the bus round-trip.

New Tauri event payload:

```ts
{
  harnessId?: string;
  docPath: string;
  batchId: string;
  title: string; // required; defaulted by the browser before POST
  requestId?: string;
}
```

### Data Flow

```text
1. User opens /doc?harness=hm-1&path=docs/171-docs-browser.md.
2. User clicks Generate artifact or presses `a` while not typing.
3. Browser derives `Docs artifact · <basename>`, then POSTs { batchId, title }
   to /doc-artifact?harness=&path=.
4. Rust validates the doc path exactly like /doc-feedback.
5. Rust registers a bus reply, emits acp-docs-artifact-requested, and waits.
6. AcpHarnessView filters by harness id, resolves the active live lane, de-dupes
   by batchId, queues DocArtifactRequestEnvelope, and replies accepted.
7. On the lane's next idle/awaiting_peer state, the queue injects a system turn.
   If multiple doc-artifact requests accrued, it groups them by `docPath` and
   emits one task section per requested artifact title.
8. The lane reads the source .md, calls artifact_new, edits the scaffold, and
   calls artifact_register. The existing artifact card appears in the transcript.
```

### Prompt

The queued system turn should be narrow and operational:

```text
The user is reading docs/171-docs-browser.md in the Docs browser and asked you to
generate an HTML artifact from that source document.

Read the SOURCE markdown file docs/171-docs-browser.md, then create a browser
artifact titled "Docs artifact · 171-docs-browser.md": call artifact_new,
edit the issued scaffold, and call artifact_register.

Do not edit the source markdown. Preserve factual claims from the source, but
you may restructure the artifact for browser reading: tables, diagrams,
checklists, summaries, or navigation are appropriate when they make the document
clearer. Keep a visible repo-relative source path in the artifact.
```

### UI Changes

- `/doc` pages gain a compact fixed control near the existing feedback pill:
  `artifact` / `queued` / `retry` states.
- Keyboard shortcut: `a` starts the request when focus is not inside an input,
  textarea, contenteditable node, or the feedback overlay.
- Title editing is not part of v1; the browser always sends
  `Docs artifact · <basename>`, and Rust caps it with the same artifact title
  maximum.

### Configuration

None.

## Edge Cases

- **No active live lane / active lane is stopped** — browser shows
  `no active lane`; request is not persisted and the POST returns `409`.
- **Lane is busy** — accepted into the queue and drains on the lane's next idle
  or awaiting-peer transition, matching docs feedback.
- **Duplicate POST after timeout** — de-dupe by `batchId`; reply accepted.
- **Pending artifact cap hit** — the lane receives the request and the existing
  `artifact_new` tool returns the cap error; no special browser path needed.
- **Doc changes before the lane acts** — intentional; the lane reads current
  source at execution time, so output reflects the latest file.
- **Source linkage** — v1 stores no artifact-registry backpointer to the source
  doc. The linkage is carried in the queued prompt and required visible source
  path inside the generated artifact; searchable registry metadata can be added
  later if the gallery needs source filtering.
- **Raw HTML in Markdown** — the lane reads source text, not trusted rendered
  DOM. Any source content remains untrusted user/project data.
- **Local process abuse** — same tokenless loopback write posture as docs
  feedback. The prompt is constrained to a doc path validated under `<cwd>`, but
  it still injects work into the active lane.

## Open Questions

None for v1. The chosen design keeps requests tokenless to match spec 172 and
routes to the active lane to match docs feedback.

## Out of Scope

- Server-side direct Markdown-to-artifact conversion.
- Multi-file/site export.
- A lane picker inside the browser page.
- Custom artifact templates or persistent user title editing.
- Auto-opening the created artifact in the browser; existing artifact cards stay
  user-opened.

## Resources

- [VS Code Markdown documentation](https://code.visualstudio.com/docs/languages/markdown) — preview/source linkage and Markdown preview conventions.
- [MkDocs](https://www.mkdocs.org/) — Markdown-to-static-HTML documentation generation model.
- [Obsidian Publish](https://obsidian.md/help/publish) — selected-note publishing prior art.
- `docs/172-docs-browser-inline-feedback.md` — existing docs browser browser→lane channel.
- `docs/133-harness-html-artifacts.md` — artifact lifecycle and constraints.
