# Xenon Timeline UI Parity — Implementation Spec

> Status: Implemented
> Date: 2026-09-22
> Milestone: M-ACP — Harness convergence
> Builds on: 259 · Xenon `docs/02-frontend-architecture.md` Stage 7

## Problem

Krypton and Xenon expose the same confirmed project history with visibly different navigation.
Krypton presents a compact topic rail beside the chronology, while Xenon first presents a topic
table and then moves to a separate-looking detail page. The extra transition makes the published
view slower to scan and obscures that both surfaces are projections of the same timeline model.

## Solution

Make both Xenon timeline routes render one shared, server-rendered split view modeled on Krypton's
`artifact-timeline.html`: topics and counts on the left, the selected chronology on the right,
compact day-grouped rows, one search field, and keyboard navigation. The project header, tabs,
authentication, theme toggle, English copy, and stable Xenon URLs remain Xenon-owned.

The index route shows all published events and the topic route shows one selected topic. This is
progressive enhancement: ordinary links and GET forms remain complete without JavaScript; a small
page script only adds Krypton-like keyboard movement and row selection.

## Research

- Krypton's current Timeline uses a `200–250px` topic rail, latest-active topic titles, day headers,
  `42px` time cells, compact metadata pills, and a yellow selection tint. Its keyboard contract is
  `/`, `Escape`, `[`, `]`, `r`, `j`, `k`, and `Enter`; `Space`/`i` open local-only context and audit
  details.
- Xenon already shares Krypton's Binance-dark tokens and flat chronology rules. The visual work is
  layout and component parity, not a new theme. Existing constraints still forbid nested cards,
  left accent rails, extra decorative hues, blur, and framework code.
- Xenon's Timeline is Askama-rendered and authenticated. `/p/<project>/timeline` currently builds
  topic summaries only; `/p/<project>/timeline/<topic-id>` builds event rows. Both handlers already
  load the same validated latest resource revisions, so a shared view model can remove the visual
  split without adding an API or client-side data fetch.
- Xenon's published projection intentionally contains only bounded list metadata. Rationale,
  impact, evidence, and recording instructions remain in `event.md`. Inline Krypton-style audit
  expansion would require widening the publishing contract or reparsing Markdown, so event rows
  continue to open the stable resource permalink for full detail.
- Askama escapes Timeline fields by default. The enhancement script can operate only on
  server-authored URLs and text already in the DOM; it must not inject resource Markdown or use
  `innerHTML`.
- GitHub also treats a timeline as ordered, individually addressable typed events. Linear's
  Timeline is deliberately high-level and separates project chronology from granular issue work.
  Both support keeping the topic/project scope visible while scanning events, but neither justifies
  turning this read-mostly Xenon page into a client-side application.

### Alternatives considered

- **CSS-only restyle of the existing topic table.** Lowest cost, but it keeps the interaction model
  that differs most from Krypton and leaves the index without chronology.
- **Copy Krypton's page as a client-side JSON viewer.** Closest literal clone, but duplicates the
  read model, introduces another authenticated JSON surface, and contradicts Xenon's
  server-rendered/no-framework architecture.
- **Inline full event context.** Useful locally, but Xenon does not have that bounded metadata in
  its read model. The existing resource permalink is the safe, complete detail view.

## Prior Art

| Product / surface | Implementation | Design consequence |
|---|---|---|
| Krypton Timeline | Two-column topic rail and chronology, compact selected rows, keyboard-first navigation | Source of truth for layout, density, selection, topic ordering, and shortcuts |
| GitHub issue timeline | Ordered typed events with actors, timestamps, and stable event identity | Keep each event visibly attributable and independently openable |
| Linear Timeline | High-level project chronology separated from issue-level details | Keep the timeline focused on confirmed project history, not generic resources |
| Xenon resource browser | Askama HTML, embedded CSS/JS, plain links/forms, authenticated resource permalinks | Preserve progressive enhancement and the single-binary frontend |

**Krypton delta** — Xenon matches the topic rail, chronology density, responsive collapse, yellow
selection, and keyboard movement. It intentionally retains Xenon's global chrome, explicit
dark/light toggle, English interface copy, and resource-permalink detail pages.

## Affected Files

### Krypton

| File | Change |
|---|---|
| `docs/264-xenon-timeline-ui-parity.md` | Cross-repository design contract |
| `docs/README.md` | Index this cross-repository spec |

### Xenon (`/Users/wk/Source/xenon`)

| File | Change |
|---|---|
| `src/web.rs` | Build one shared Timeline view model for index and topic routes; expose topic selection, all-event rows, and order URLs |
| `templates/timeline.html` | Replace the table with the shared topic-rail/chronology shell |
| `templates/timeline_topic.html` | Remove after both routes render the shared template |
| `assets/app.css` | Add scoped split-view, topic-link, compact row, selected-row, sticky-day, and responsive rules |
| `assets/timeline.js` | New progressive enhancement for `/`, `Escape`, `[`, `]`, `r`, `j`, `k`, and `Enter` |
| `src/assets.rs` | Embed and serve `timeline.js` through the existing hashed asset mechanism |
| `tests/flow.rs` | Replace table assertions and cover shared-shell, all/topic modes, filters, ordering, accessibility hooks, and no-JS links |
| `docs/02-frontend-architecture.md` | Update Stage 7 from table/detail UI to the shared split view |

No database, ingest protocol, resource schema, or Krypton publisher change is required.

## Design

### View model

Both routes render `TimelineTemplate`. The exact private Rust names may follow local style, but the
model must carry these semantics:

```rust
struct TimelineTemplate {
    topics: Vec<TimelineTopic>,
    active_topic_id: Option<String>,
    heading: String,
    event_count: usize,
    days: Vec<TimelineDay>,
    search: String,
    order: &'static str,
    all_href: String,
    reverse_order_href: String,
    diagnostic_count: usize,
    // Existing shared chrome and project fields remain unchanged.
}

struct TimelineTopic {
    id: String,
    title: String,
    count: usize,
    href: String,
    active: bool,
    latest_ms: i64,
}
```

`TimelineRow` gains the topic title and topic URL needed for a compact topic pill in all-events
mode. No raw Markdown or unbounded event body enters this model.

### Routes and query behavior

| Route | Main pane | Active rail item |
|---|---|---|
| `/p/<project>/timeline` | All matching published events | `all events` |
| `/p/<project>/timeline/<topic-id>` | Matching events in that topic | The selected topic |

`q` searches topic title, summary, and `madeBy`; `order=asc|desc` keeps the current stable
occurrence/recording/id ordering. Topic and order links preserve the current query. The legacy
`?topic=` redirect remains supported.

Topics sort by latest event descending, matching Krypton rather than Xenon's current alphabetical
table. Their displayed title still comes from the latest occurred event. The all-events row count
reflects the current filter; each topic count remains the total valid published event count for that
topic so the rail does not jump as search terms change. Search narrows the rail to topics containing
at least one matching event, while an active topic remains visible even when its main pane is empty.

### UI

Inside the existing project header and tabs, render:

```text
search + order summary
┌ topic rail (200–250px) ┬ chronology ─────────────────────────┐
│ all events          42 │ Selected topic / all events    count │
│ topic A             12 │ date header                           │
│ topic B              7 │ time  summary          actor / pills │
└────────────────────────┴───────────────────────────────────────┘
```

- Topic links use transparent rows, a yellow-tinted active state, wrapping titles, and mono counts.
- Event rows use time, full wrapping summary, actor, optional topic/source/superseded pills, and
  relation text. They use rules rather than cards and never add a left accent rail.
- The whole summary link opens `/r/<project>/timeline/<event-id>`; related published events retain
  their own links.
- Day headers are sticky within the viewport and use the page background plus a bottom hairline.
- At `<=720px`, the rail stacks above the chronology and loses its right border.
- Empty and invalid-resource diagnostics keep the existing Xenon wording and full-border treatment.
- Xenon's explicit dark/light choice remains authoritative; do not replace it with OS-only theme
  detection from the local Krypton page.

### Keyboard enhancement

`assets/timeline.js` is loaded only on Timeline pages:

| Key | Action |
|---|---|
| `/` | Focus and select the search field |
| `Escape` | Clear a non-empty search by navigating to the same view without `q`; otherwise blur |
| `[` / `]` | Open previous / next topic rail link, including `all events` |
| `r` | Open the supplied reverse-order URL while preserving topic and search |
| `j` / `k` | Move `.is-selected` and DOM focus through visible event rows |
| `Enter` | Open the selected event permalink |

The script ignores shortcuts while an input, select, button, or link owns focus. Every action has a
visible link or GET control, and the initial selected row is the first event without forcing scroll.
No `Space`/`i` binding is added because Xenon does not expose the local audit payload inline.

### Data flow

1. The route authenticates the browser session and resolves project visibility as today.
2. `load_timeline_events` validates latest sealed `timeline` revisions as today.
3. A shared projector builds latest-first topic summaries and derives supersession once.
4. The route filters all events or the selected topic, applies stable order, and groups rows by day.
5. Askama renders the full rail and chronology; ordinary links/forms are immediately usable.
6. `timeline.js` adds focus movement and shortcut navigation without fetching or mutating data.
7. Opening an event follows its existing stable resource permalink and safe Markdown renderer.

## Edge Cases

| Case | Handling |
|---|---|
| No valid published events | Rail contains only `all events`; main pane shows the existing empty state |
| Search matches event metadata but not topic title | Matching event stays in the main pane; selected topic remains present in the rail |
| Active topic has no search matches | Keep the active topic and heading; show the filtered empty state |
| Topic removed or unknown | Existing `404` behavior remains |
| Invalid published resource | Omit it and show the existing diagnostic count |
| Related target not published | Keep unresolved text; do not create a dead link |
| JavaScript disabled or CSP blocks it | Links, search, order, and event opening remain functional |
| Narrow viewport | Stack rail above chronology; no horizontal page scroll |
| Long Thai title or summary | Wrap without ellipsis or uppercasing |

## Open Questions

None. Approval chooses structural/visual parity while retaining Xenon's own language, chrome,
server-rendering model, and published-resource detail boundary.

## Out of Scope

- Changing timeline ingest, metadata schema, publication, authority, or supersession semantics
- Editing, merging, confirming, or deleting Timeline events from Xenon
- Parsing `event.md` to duplicate Krypton's inline rationale/evidence/audit panels
- Translating Xenon's global UI or Timeline labels to Thai
- Replacing Xenon's global navigation or theme preference with Krypton's loopback header
- Adding a frontend framework, JSON Timeline endpoint, polling, or client-side read model

## Implementation Notes

- Both Timeline routes now render the shared `TimelineTemplate`: the index selects `all events`,
  while the topic route selects its topic in the same latest-first rail and chronology shell.
- `timeline_topic.html` was removed. The remaining template keeps ordinary links and GET controls
  complete without JavaScript; `timeline.js` adds only the specified keyboard navigation.
- The performance audit found no timers, observers, animation loops, client-side HTML rebuilding,
  or persistent work beyond one page-lifetime key listener. Row selection updates only the previous
  and next rows. Long histories use `content-visibility`, while true pagination or virtualization
  remains out of scope; the existing server-side maximum is still 5,000 rendered events.
- Validation passed on 2026-09-23: `make check` (formatting, Clippy, 123 library tests, 7 CLI unit
  tests, 7 CLI integration tests, 69 flow tests, and doc tests), the focused Timeline flow test,
  `node --check assets/timeline.js`, and `git diff --check`.
- No packaged-app or live-browser visual smoke test was run; the shared layout and interaction
  contract are covered by server-rendered flow assertions and JavaScript syntax validation.

## Resources

- Internal: `src/acp/artifact-timeline.html`, `DESIGN.binance.md`, and
  `docs/259-timeline-xenon-publishing.md` — source UI and cross-repository Timeline contract
- Internal: Xenon `src/web.rs`, `templates/timeline*.html`, `assets/app.css`,
  `docs/02-frontend-architecture.md` — current hosted projection and frontend constraints
- [GitHub REST API: Timeline events](https://docs.github.com/en/rest/issues/timeline) — ordered,
  typed, addressable event model
- [Linear Timeline](https://linear.app/docs/timeline) — high-level chronology kept separate from
  granular issue implementation
