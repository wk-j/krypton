# Publish Project Timeline to Xenon — Implementation Spec

> Status: Implemented
> Date: 2026-09-20
> Milestone: M-ACP — Harness convergence
> Builds on: 212, 253–256 · ADR-0016

## Problem

Confirmed project-timeline events are intentionally local under
`.krypton/timeline/events/`. They disappear with the checkout, cannot be read from another device,
and cannot be shared through Xenon. Publishing them as ordinary docs would lose their topic,
chronology, relation, and decision-authority fields, while ambient sync would violate Xenon's
explicit-publish boundary for gitignored working knowledge.

## Solution

Add `timeline` as Xenon's seventh resource kind. Krypton publishes **one confirmed event per
resource**, keyed by the immutable timeline event ID, with the original Markdown as `event.md` and
a bounded structured projection in `meta`. Pending and dismissed suggestions never leave the
machine.

Publishing remains explicit through `#push timeline [<event-id>]` or a bare `#push` whose configured
kind set includes `timeline`. Xenon adds a project `timeline` tab that reconstructs topics,
chronology, and supersession from the latest published event resources; each row links to the
event's stable resource permalink. `#xenon timeline [<topic>]` opens that hosted view without
changing the local `#timeline` command.

## Research

- Krypton's timeline core already owns bounded parsing, confinement, relation validation, and
  derived supersession in `timeline::scan_project()`. The Xenon collector should reuse that result,
  not parse frontmatter a second time.
- Xenon's publisher already supplies secret scanning, content-addressed upload, unchanged
  detection, retry queuing, upload authorship, and per-resource permalinks. A new collector and kind
  allowlist entry are enough for transport.
- The Xenon server rejects unknown kinds at ingest and in list filters, so Krypton-only support
  would fail at the first manifest request. Server and client must ship in a compatible order.
- Xenon's resource schema stores `kind` as text and generic Markdown rendering already handles
  frontmatter safely with raw HTML disabled. No database migration or new storage protocol is
  required.
- Xenon's project resource list sorts by upload time. That is incorrect for backfilled timeline
  events, so `resources?kind=timeline` is not an adequate timeline UI; the hosted view must sort by
  the event's own occurrence timestamp.
- `occurred_at` is RFC 3339 and may contain offsets. Krypton will add numeric `occurredAtMs` and
  `recordedAtMs` projection fields so Xenon can sort correctly without adding a date dependency.
- `madeBy` is a claim preserved from the timeline record, not an identity Xenon authenticated.
  Xenon's verified uploader account and token remain visually separate from the recorded decision
  authority, following its existing upload-authorship contract.
- One resource per event was chosen over one resource per topic or one project-wide bundle. It
  preserves stable event permalinks, uploads only new/changed events, and lets Xenon derive topic
  views without rewriting an ever-growing blob. Topic bundles would make cross-topic relations and
  targeted publishing harder; a project bundle would transfer the full ledger on every addition.
- Timeline files are durable on disk, unlike in-memory attention flags. They therefore do not gain
  attention's auto-push-on-create exception; ADR-0016 continues to require an explicit publish.
- A malformed local event must be visible without preventing unrelated resource kinds from being
  pushed. Timeline collection reports a non-retryable failed item for each diagnostic while still
  returning valid events.

## Prior Art

| Product / Pattern | Implementation | Krypton/Xenon lesson |
|---|---|---|
| GitHub issue timeline | Individual typed events carry stable IDs, actors, and creation times and are listed chronologically per issue | Keep an event as the addressable unit and preserve actor/time separately |
| Linear project updates / Pulse | Hosted, recency-oriented project updates with project-scoped filtering | Give remote project history a first-class project view rather than hiding it among generic files |
| Event Sourcing pattern | Immutable events form an append-only audit trail; read models project them for queries | Keep local events authoritative and build Xenon's timeline as a read projection |
| Xenon resources | Content-addressed blobs plus append-only revisions and stable `{project, kind, slug}` permalinks | Reuse the transport and history model instead of adding a timeline-specific ingest API |

**Krypton delta** — GitHub and Linear host the primary record. Here the local confirmed timeline
remains the source record and Xenon is an explicitly published, read-only projection. Xenon verifies
who uploaded a revision but does not claim to verify `madeBy` or the event's evidence.

## Affected Files

### Krypton

| File | Change |
|---|---|
| `src-tauri/src/xenon.rs` | Add `timeline`, collect confirmed events, project structured meta, and surface malformed-event diagnostics |
| `src-tauri/src/commands.rs` | Include timeline resources/diagnostics in `xenon_push` without aborting other kinds |
| `src/acp/xenon-push.ts` | Accept `timeline` and keep push reporting unchanged |
| `src/acp/xenon-push.test.ts` | Cover `#push timeline [<event-id>]` parsing |
| `src/acp/acp-harness-view.ts` | Add `#xenon timeline [<topic>]` hosted-view opener |
| `src/acp/acp-harness-view.test.ts` | Cover hosted timeline URL construction and command errors |
| `docs/02-functional-requirements.md` | Add explicit remote timeline publication/read requirement |
| `docs/04-architecture.md`, `docs/05-data-flow.md` | Document the publication and hosted projection flow |
| `docs/06-configuration.md` | Add `timeline` to `auto_push` values and retain explicit-publish semantics |
| `docs/212-xenon-resource-server.md`, `docs/253-project-decision-requirement-timeline.md` | Cross-reference the seventh kind and remote projection |
| `docs/README.md` | Index this spec |

### Xenon (`/Users/wk/Source/xenon`)

| File | Change |
|---|---|
| `src/api.rs` | Accept and filter the `timeline` resource kind |
| `src/web.rs` | Add the authenticated project timeline route, read-model query, validation, and relation links |
| `templates/projecttabs.html` | Add the project-level `timeline` tab |
| `templates/timeline.html` | New server-rendered topic/chronology view |
| `assets/app.css` | Add the timeline kind hue and flat chronology layout; no left rails or nested cards |
| `tests/flow.rs` | Prove ingest, ordering, topic filtering, supersession, malformed meta, permissions, and stable links |
| `cli/src/push.rs`, `cli/tests/cli.rs` | Accept all seven server kinds (`daily` drift included) and cover `timeline` |
| `docs/01-protocol.md`, `docs/02-frontend-architecture.md`, `README.md` | Document the kind and hosted route |

No database migration is required in Xenon.

## Design

### Resource Shape

```rust
LocalResource {
    manifest: ResourceManifest {
        kind: "timeline",
        slug: event.id,                 // tl-20260920T124346Z-648462
        title: truncate_300(event.summary),
        origin: origin_value(cwd),
        meta: json!({
            "schema": 1,
            "eventId": event.id,
            "topicId": event.topic_id,
            "topicTitle": event.topic_title,
            "summary": event.summary,
            "occurredAt": event.occurred_at,
            "occurredAtMs": parse_rfc3339_ms(event.occurred_at),
            "madeBy": event.made_by,
            "recordedAt": event.recorded_at,
            "recordedAtMs": parse_rfc3339_ms(event.recorded_at),
            "recordedBy": event.recorded_by,
            "recorderLane": event.recorder_lane,
            "sourceRef": event.source_ref,
            "relation": event.relation,
            "relatedEvent": event.related_event,
            "suggestedByLane": event.suggested_by_lane,
            "suggestionId": event.suggestion_id,
            "lane": event.recorder_lane,
        }),
        files: Vec::new(),              // Publisher fills after hashing
    },
    sources: { "event.md": absolute_event_path },
    inline: BTreeMap::new(),
}
```

`superseded` is deliberately absent from `meta`: it is derived on Xenon from published
`relation == "supersedes"` edges, so publishing a newer event updates the read model without
rewriting the older resource. Full evidence, authorizing instruction, rationale, and impact remain
in `event.md`; the projection contains only fields needed to list, group, link, and attribute rows.

Only events returned by `timeline::scan_project()` are publishable. Pending and dismissed files are
not scanned. The existing secret pre-scan examines both `event.md` and `meta`; `--force` keeps its
current explicit override semantics.

### Commands and Routes

| Surface | Contract |
|---|---|
| Krypton | `#push timeline` publishes every valid confirmed event |
| Krypton | `#push timeline <event-id>` publishes exactly one confirmed event or reports it missing |
| Krypton | `#xenon timeline [<topic-id-or-title>]` opens `/p/<project>/timeline[?topic=…]` |
| Xenon API | Existing resource ingest/list/detail routes accept `kind=timeline` |
| Xenon web | `GET /p/<project>/timeline?topic=<id-or-title>&q=<text>&order=asc|desc` |
| Xenon permalink | `GET /r/<project>/timeline/<event-id>` renders `event.md` through the existing safe Markdown path |

No timeline-specific write API is added. Xenon remains a sink and cannot create, confirm, edit, or
delete Krypton timeline events.

### Hosted Read Model

The project timeline route reads the latest sealed revision for each `timeline` resource and
validates the bounded projection. Invalid projections are omitted from chronology and counted in a
visible diagnostic line; they remain available through the generic resource page for inspection.

Rows sort by `occurredAtMs`, then `recordedAtMs`, then event ID. Topic labels use the title from the
latest occurred event in that topic. Superseded IDs are derived from valid published edges. Each row
shows occurrence time, full summary, `madeBy` labelled as timeline-record provenance, topic, source
presence, and superseded state; opening a row follows its stable resource permalink. Related event
IDs link when the target exists in the same readable project and otherwise render as unresolved
text.

The page is server-rendered and uses ordinary GET query parameters for topic, search, and order.
It follows Xenon's existing session/project visibility checks and Binance design system. Data stays
mono, prose stays sans, timeline gets one non-semantic kind hue, and the page uses full-width rules
rather than left accent rails. No polling or ambient animation is added.

### Data Flow

```text
1. A confirmed event already exists under .krypton/timeline/events/.
2. User runs #push timeline [event-id] (or an explicit bare #push covering timeline).
3. timeline::scan_project validates confirmed records and derives structured events.
4. Krypton creates one timeline LocalResource per valid event; malformed records become visible,
   non-retryable failed report items and do not block other resource kinds.
5. Existing Xenon publisher secret-scans event.md + meta, negotiates missing blobs, uploads, commits.
6. Xenon stores the resource/revision and records the authenticated uploader through its existing
   activity/authorship path.
7. /p/<project>/timeline projects all published timeline heads by event occurrence time.
8. A row opens /r/<project>/timeline/<event-id>; Xenon never writes back to Krypton.
```

### Configuration

No new key. `timeline` becomes a valid `[xenon].auto_push` value:

```toml
[xenon]
auto_push = ["review", "timeline"]
```

This affects what an explicit bare `#push` includes. It does **not** publish when an event is
created or confirmed. Attention remains the only `auto_push` kind with an on-create exception.

### Deployment Order

1. Deploy Xenon with `timeline` in its server and CLI allowlists plus the hosted route.
2. Release Krypton with the collector and command support.
3. Run the ignored live compatibility test against that Xenon build and manually publish one
   synthetic event before enabling the kind in normal use.

An older Xenon server returns `400 invalid_kind`; Krypton reports the failure as non-retryable and
does not queue it forever.

## Edge Cases

| Case | Handling |
|---|---|
| No confirmed events | `#push timeline` reports nothing to push |
| Pending/dismissed suggestion | Never collected or published |
| Unknown targeted event ID | Clear local error; no network request |
| Malformed/oversized/symlinked event | Failed diagnostic item; valid events and other kinds continue |
| Secret-shaped content | Existing pre-scan blocks the event; `--force` requires explicit human action |
| Historical backfill | Hosted page uses `occurredAtMs`, not upload time |
| New superseding event only | Xenon derives the older event's state from the new edge; no republish needed |
| Relation target not yet published | Show unresolved target text until a later push publishes it |
| Same event pushed unchanged | One manifest round trip, no blob upload, `unchanged` outcome |
| Local event removed | Xenon keeps the last published resource; this feature does not infer remote deletion |
| Private project | Existing session/token authorization applies to list, detail, and timeline routes |
| Server/client version skew | Old server rejects `timeline`; old client rejects the command before upload |

## Open Questions

None. Approval chooses explicit publication, one resource per confirmed event, and a Xenon-side
read projection as the implementation contract.

## Implementation Notes

Implemented on 2026-09-20 across Krypton and Xenon. Krypton reuses the authoritative Timeline
scanner, publishes only confirmed records, reports malformed local files independently, supports
targeted event pushes, and opens the hosted chronology through a small pure URL builder. Xenon
accepts `timeline` in both server and CLI allowlists, requires schema-1 metadata plus `event.md`,
renders the authenticated topic/search/order view, derives supersession, and preserves generic
resource permalinks.

One test-placement detail differs from the draft file map: `#xenon timeline` URL construction is
covered in `xenon-push.test.ts` through the extracted pure helper rather than through the large
`acp-harness-view.test.ts` fixture. The command still calls that same helper. The ignored live
compatibility test and a manual publish to a deployed Xenon remain release/deployment checks, not
local implementation checks.

Verified locally with Krypton's production frontend build, 3,541 frontend tests, 381 Rust tests
(one unrelated live TypeSafe test intentionally ignored), Xenon's complete server/CLI workspace
(206 tests), focused cross-repo chronology and allowlist tests, Rust formatting, and
`git diff --check`.

## Out of Scope

- Ambient upload when an event is recorded, suggested, confirmed, or the app exits
- Publishing pending or dismissed suggestions
- Editing, confirming, superseding, or deleting timeline events from Xenon
- Pull/sync from Xenon back into `.krypton/timeline/`
- Treating the Xenon uploader as the event's decision authority
- Cross-project topic merging, organization-wide timelines, notifications, or feeds
- Replacing the local `#timeline` browser or trace workflow

## Resources

- [GitHub REST API — Timeline events](https://docs.github.com/en/rest/issues/timeline) — stable,
  typed issue events exposed as a chronological read surface
- [GitHub REST API — Issue event types](https://docs.github.com/en/rest/using-the-rest-api/issue-event-types) — common event identity, actor, action, commit, and timestamp fields
- [Linear Pulse](https://linear.app/docs/pulse) — hosted project/initiative updates organized by recency with scoped feeds
- [Linear Timeline](https://linear.app/docs/timeline) — separates high-level project chronology from granular issue implementation
- [Microsoft Azure Architecture Center — Event Sourcing pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/event-sourcing) — append-only events plus query-oriented projections and their trade-offs
- Internal: `docs/212-xenon-resource-server.md`, `docs/253-project-decision-requirement-timeline.md`,
  `docs/adr/0016-generated-resources-publish-to-xenon.md`, `src-tauri/src/timeline.rs`,
  `src-tauri/src/xenon.rs`, and Xenon `docs/01-protocol.md`
