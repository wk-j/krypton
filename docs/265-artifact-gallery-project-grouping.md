# Artifact Gallery Project Grouping — Implementation Spec

> Status: Implemented
> Date: 2026-09-22
> Milestone: ACP Harness — observability
> Builds on / amends: 170, 173

## Problem

The Artifact Gallery is tabbed by lane and grouped by transient harness ID, even though artifacts
are durable work products stored under a project. This makes a project-wide gallery read like an
agent activity report: `Claude-1`, `Codex-4`, and `hm-2` are prominent while the project that gives
the artifacts meaning is absent.

## Solution

Make project the gallery's primary navigation and grouping axis. Replace lane tabs with `all` plus
one tab per project, group the all view into project sections, and keep the creating lane as
secondary provenance on every artifact card. Harness IDs leave the visible UI.

Aggregate and deduplicate by project in Rust before returning `/artifacts`. This is necessary
because two live harnesses for the same project can each rehydrate the same on-disk artifacts; a
frontend-only regroup would render duplicate cards.

## Research

- `HarnessArtifactStore` already carries `project_dir`, but
  `list_all_artifacts_for_gallery()` discards it and returns only `harnessId` plus artifacts.
- The browser then derives distinct lane tabs across harnesses, filters each harness by the active
  lane, and conditionally renders `hm-*` headings. Lane is therefore both filter and card
  provenance, while project is not represented at all.
- Spec 173 scans the complete `.krypton/artifacts/**` tree for every newly opened harness and
  re-homes those entries under that live harness. Its documented edge case says two harnesses with
  the same `project_dir` both list the same set. Project grouping must union those stores and
  deduplicate by artifact ID within the project.
- The canonical project path is the durable identity available in the registry, but the token-free
  loopback JSON should not expose absolute local paths. Krypton already hashes canonical project
  paths for harness persistence; the gallery can reuse that pattern to expose an opaque project ID
  and derive a human label from the directory basename.
- Artifact IDs carry a global monotonic sequence plus random suffix. Latest-first order remains
  the parsed sequence descending after project aggregation.
- Figma's file browser organizes related files in folders rather than by author. Notion similarly
  uses top-level teamspaces/project areas while authorship stays content metadata. GitHub Actions
  defines artifacts as outputs of a workflow run, keeping the work context primary rather than the
  individual job or actor. These products support project/work-context grouping as the familiar
  retrieval model.

### Alternatives considered

- **Frontend-only regrouping.** Add project fields to each harness and regroup in JavaScript. This
  preserves the old endpoint shape but forces the browser to resolve duplicate rehydrated entries
  and leaks backend lifecycle structure into display code.
- **Project tabs plus lane sub-tabs.** Keeps every current filter, but creates two competing tab rows
  and preserves lane as unnecessary primary navigation. Lane remains visible on each card instead.
- **Rename harness headings to project names.** Cosmetic only: duplicate same-project sections and
  lane-first tabs remain.

## Prior Art

| Product / surface | Organization | Design consequence |
|---|---|---|
| Figma file browser | Files are grouped in folders (previously projects) | Group durable outputs by their work container, not creator |
| Notion sidebar/library | Content is organized into teamspaces and project areas | Keep the shared context primary and authorship secondary |
| GitHub Actions artifacts | Artifacts belong to a workflow run | Preserve production context around an output |
| Krypton Docs browser | Repository/project is chosen before a document | Reuse project-first navigation across loopback knowledge surfaces |

**Krypton delta** — unlike cloud workspaces, the project identity is a local canonical path. The
gallery exposes only an opaque ID and basename, retains the fixed Binance-dark status-wall theme,
and keeps keyboard access for every project tab.

## Affected Files

| File | Change |
|---|---|
| `src-tauri/src/hook_server.rs` | Aggregate stores by canonical project identity, deduplicate artifacts, return project-shaped JSON, and update focused tests |
| `src/acp/artifact-gallery.html` | Replace lane tabs/harness sections with project tabs/project sections; retain lane provenance on cards |
| `docs/170-artifact-gallery-endpoint.md` | Amend the endpoint shape, primary grouping, UI, and tests |
| `docs/173-gallery-disk-rehydration.md` | Resolve the documented same-project duplicate-listing edge case through project aggregation |
| `docs/04-architecture.md` | Describe project-grouped gallery projection |
| `docs/05-data-flow.md` | Describe project aggregation and deduplication before `/artifacts` response |
| `docs/README.md` | Index this spec |

No artifact storage path, feedback token, artifact lifecycle, command, or route changes.

## Design

### Project identity and response shape

`list_all_artifacts_for_gallery()` becomes a project projection rather than a direct dump of
harness stores:

```json
{
  "projects": [
    {
      "projectId": "project-7f0fd0b70a8f4c21",
      "projectName": "krypton",
      "artifacts": [
        {
          "id": "art-81-1f5466a8",
          "laneLabel": "Codex-4",
          "title": "Xenon Timeline UI preview",
          "state": "live",
          "size": 40639,
          "hash": "...",
          "tail": ".krypton/artifacts/hm-4/Codex-4/art-81-1f5466a8.html",
          "token": "..."
        }
      ]
    }
  ]
}
```

- `projectId` is `project-` plus the existing 16-hex SHA-256 prefix of the canonical project path.
  It is stable across harnesses and app restarts without revealing the path.
- `projectName` is the canonical directory basename, preserved exactly without uppercasing.
- Stores without a project directory and projects with zero artifacts do not produce empty tabs.
- Projects sort case-insensitively by `projectName`, then `projectId`, keeping keyboard tab positions
  stable across the 1-second poll.
- Artifacts within a project sort latest-creation-first by parsed artifact sequence, then ID.

### Deduplication

For all live stores sharing one `projectId`, union entries by artifact ID. Duplicate entries are
expected after disk rehydration and are not an error.

When duplicates differ, choose deterministically:

1. `RegisteredLive` over `Pending`.
2. The entry with a non-empty hash over an empty hash.
3. Lowest harness ID as the final stable tie-breaker.

The selected row retains its real path tail and existing feedback token. The token-enumeration
security posture from specs 149/170 is unchanged; raw `project_dir` never enters the response.

### Gallery UI

- The sticky tab row renders `all <count>` then one project tab with its count.
- In `all`, render one section per project with `<projectName>` and artifact count.
- In a selected project, omit the redundant project section heading and show its card grid directly.
- Always render `laneLabel` on each card. It answers who produced the artifact without controlling
  where the artifact lives.
- Remove harness headings and all `hm-*` display text. Harness remains an internal routing key.
- Preserve cards, live/pending pills, sizes, hash/tail, Open behavior, polling cadence, stale-signature
  guard, reconnect behavior, and fixed Binance-dark design.
- If two projects share the same basename, display `name · <projectId suffix>` for both tabs and
  section headings. The opaque suffix disambiguates without exposing parent directories.

### Keyboard

| Key | Action |
|---|---|
| `[` / `]` | Previous / next project tab |
| `1`–`9` | Open the corresponding project tab |
| `0` | Return to all projects |

Update the footer and tab hint from lane to project. The active project persists across polls and
falls back to `all` only when that project no longer appears.

### Data flow

1. Each live harness store retains its project directory and artifact entries as today.
2. `/artifacts` snapshots all stores under one lock.
3. Rust canonicalizes/hashes each project directory and groups stores by `projectId`.
4. Entries are unioned by artifact ID using the deterministic duplicate rule.
5. Projects and artifacts are sorted, then serialized without raw paths or visible harness IDs.
6. The gallery polls `{ projects }`, keeps the active project when still present, and renders project
   tabs/sections with lane provenance on cards.

## Edge Cases

| Case | Handling |
|---|---|
| Two harnesses open the same project | One project tab; duplicate rehydrated artifacts collapse |
| Two projects have the same basename | Add each opaque project ID suffix to the visible label |
| Project directory cannot canonicalize | Hash the stored path as the existing persistence helper does |
| Harness has no project or no artifacts | Omit it from the project projection |
| Active project closes but another harness for it remains | Project and selection remain |
| Last harness for active project closes | Project disappears; UI falls back to `all` |
| Same artifact exists as pending and live | Live row wins |
| Poll fails | Keep last good project view and show `reconnecting...` |
| Historical artifact's lane is not live | It still lists and opens; feedback keeps existing `409 no_live_lane` behavior |

## Open Questions

None. Approval chooses project as the sole primary filter; lane remains visible provenance rather
than a second filter row.

## Out of Scope

- Moving artifact files out of `.krypton/artifacts/<harness>/<lane>/`
- Renaming lanes or changing feedback routing
- Retention, deletion, archival, pagination, or search
- Cross-project artifact moves or copying
- Exposing absolute project paths in loopback JSON
- Changing the gallery route, poll interval, or loopback security posture

## Implementation Notes

- Shipped the project-shaped `/artifacts` response, canonical-path project identity, deterministic
  same-project deduplication, project tabs/sections, basename collision labels, and project keyboard
  navigation described above.
- Performance audit: the page keeps one delegated click listener, one document key listener, and one
  document-lifetime interval; it rebuilds card DOM only when the project snapshot signature changes.
  Project grouping adds no per-card listeners, layout reads, or animation loop. The existing gallery
  still renders the full artifact set without virtualization; this change reduces duplicate cards but
  does not solve the inherited large-history rendering limit.
- Verified with `cargo test --lib` (391 passed, 1 ignored), `cargo clippy --lib -- -D warnings`,
  `cargo fmt -- --check`, `npm run check`, `npm test -- --run` (3,543 passed), `npm run build`,
  page-script syntax parsing, and `git diff --check`. The loopback-listener Rust suite required the
  normal unsandboxed test environment. No packaged Tauri visual smoke test was run.

## Resources

- Internal: `src/acp/artifact-gallery.html`, `src-tauri/src/hook_server.rs`,
  `docs/170-artifact-gallery-endpoint.md`, `docs/173-gallery-disk-rehydration.md`, and
  `DESIGN.binance.md`
- [Figma: Guide to files and folders](https://help.figma.com/hc/en-us/articles/1500005554982-Guide-to-files-and-folders) — related files are grouped in a shared container
- [Notion: Structure your sidebar with teamspaces](https://www.notion.com/help/guides/structure-sidebar-focused-work-teamspaces) — project/team context organizes shared work
- [GitHub Actions: Workflow artifacts](https://docs.github.com/en/actions/concepts/workflows-and-actions/workflow-artifacts) — artifacts are outputs attached to their workflow context
