# Rails Dock — Check Rules and the Check Page — Implementation Spec

> Status: Implemented (revision 2, 2026-11-15: the detail moves to a check page in the same panel; approved and implemented 2026-11-16; see Implementation notes)
> Date: 2026-11-15
> Milestone: ACP Harness — architecture conformance
> Builds on: 337 (Rails verifier) · 344 (Actions bar) · 345 (dock display budget) · 368 (manual checks)
> Amends: 337 §UI Content (checks, keys) · 345 §Display budget (check row) and rule 1

## Problem

A check row reads `rails-verdict  PASS  0.7s`. Nothing on it says what that PASS means. The user
(2026-11-15) called the dock "absolutely blackbox to user". The answer is already in the snapshot: the
`## Rails` bullet that names the check with `` `check:<name>` ``. The dock shows that link only the other
way round, on the rule rows, behind the collapsed `24 rules · 5 enforced ▸`.

The detail behind `Enter` has no room either. It opens inside the row, in a well nested in the 352 px
column, and shares the list's scroll. The user asked for the detail "in dedicate UI … replace the rails
UI in the same rails panel", with Esc going back, "because current main rails UI does not have enough
room to show detail".

## Solution

1. **A rule line under every check.** It shows the first rule the check enforces, as short id plus
   text on one line, with `+N` when the check enforces more. A check that no rule names shows
   `no rule — command only`.
2. **A check page in the same panel.** `Enter` on a check row (or a click on the already-selected check
   row) replaces the row list with that check's page. The page has a head with a back key and three
   sections at full panel height: **Proves** (each rule in full, with its source), **Command** and
   **Output**. `Esc` goes back to the list with the same row selected. A second `Esc` focuses the
   composer, as today.
3. **No new data.** `RailsSnapshot.rules[].check`, the run history and the manual-check records hold
   everything. No Rust, manifest or trust change.

## Research

- **Check row today** (`src/acp/components/rails-dock/index.ts:319-336`). `CheckRow.content` paints
  the outcome line. Then it adds `checkDetail(argv, result, manualRun)` when expanded, or the one-line
  `__cmd` argv while trust is pending (spec 345).
- **Why the expanded row is cramped.** The detail is a `__detail` well (padding 9 px) inside a row
  (padding 10 px) inside a section well (margin 8 px), with a 72 px label column. That leaves about
  218 px for text, against 316 px for a section well with no nesting. `__value` breaks words anywhere,
  so `loopback-session-gate`'s argv takes 13 lines broken mid-identifier. `__tail` is capped at 18em,
  and all of it scrolls with the list.
- **The link exists, one way.** Rust splits a trailing `` `check:<name>` `` off a bullet into
  `RailsRule.check` (`src-tauri/src/rails.rs:400`), so `rule.text` is the sentence without the marker.
  Only `RuleRow` (`index.ts:504-537`) uses it.
- **This repo** (`.krypton/rails.toml`, `docs/adr/`): `typecheck` → none; `rails-verdict` → `0025#1`;
  `rails-trust-gate` → `0025#2`; `loopback-session-gate` → `0026#1`, `0026#2`; `osv` (manual) → `0029#1`.
- **Keys and state today** (`src/acp/harness-rails-controller.ts:394-408`): `Enter` toggles
  `expanded` and `Escape` calls `focusComposer()`. A click only selects (`index.ts:709-735`). Selection
  and expansion live in the controller's model and the component reflects them, so the open page
  belongs in the model too.
- **Row identity.** `railsDockRows(model)` rebuilds rows on every paint, and `RowView` diffs deps with
  `Object.is` (`src/ui/component.ts:66`). A per-check rule list must keep its identity per snapshot.
- **Alternatives rejected:**
  1. *A `description` key on `[[check]]`.* It is a second home for the purpose text and can drift
     from the ADR bullet. It also touches the Rust parser, the trust hash and the manifest docs.
  2. *A count only* (`enforces 1 rule · 0025`). An id does not say what the check proves.
  3. *Test names parsed from the output tail.* Fragile per runner, and a test name proves less than
     its rule.
  4. *A modal over the Harness, as spec 319's Execution Inspector.* The user asked for the same
     panel. A modal also hides the transcript the checks are about.
  5. *Widening the dock while the detail shows.* It moves the transcript layout under the reader.

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| k9s | `Enter` drills into the selected resource (a deployment into its pods, a pod into its containers). `Esc` goes back one level, through the breadcrumbs when they are on. | Keyboard drill-in and back in the same pane: the model for the page. |
| lazygit | `Enter` on a commit replaces the commit list with that commit's files. `Esc` returns to the commits. | The same panel swaps content; the list is not kept beside it. |
| GitHub commit statuses | A status has a `context` (the name) and a one-line `description` in the pull request, plus a `target_url` for the full output. | Name + one-line purpose + details on demand: the rule line plus the page. |
| ArchUnit / ESLint | ArchUnit's failure header is the rule sentence; ESLint rules carry `meta.docs.description` and a docs `url`. | The rule text itself explains the check. |

**Krypton delta.** The purpose is not a separate field. It is the enforced rule, the sentence the check
exists to prove, from the same file the judge cites. The page keeps the dock's tab strip, Actions bar
and key hints in place, so the panel never changes shape.

## Affected Files

| File | Change |
|------|--------|
| `src/acp/rails/types.ts` | The `check` row gains `enforces`; `RailsDockModel` gains `detail` |
| `src/acp/rails/rows.ts` (+ test) | `enforcedRules(snapshot, name)`, memoized per snapshot; `railsDockRows` fills `enforces` |
| `src/acp/harness-rails-controller.ts` (+ test) | Open and close the page; page keys; click on the selected check row; close when the check leaves the manifest |
| `src/acp/components/rails-dock/check-page.ts` (new, + test) | `RailsCheckPage`: head, Proves, Command, Output |
| `src/acp/components/rails-dock/parts.ts` (new) | The block name, outcome badge, RUN key and time text the rows and the page share |
| `src/acp/components/rails-dock/index.ts` (+ test) | The rows region shows the list or the page; check rows never expand inline; the rule line; page key hints; the back key's click |
| `src/acp/components/rails-dock/rails-dock.css` | `__enforces`, `__more`, and the page's `__page*` rules, in the existing layer |
| Docs | 0337 §UI Content and keys; 0345 amendment note; `README.md` index |

## Design

### Data Structures

```ts
// rails/types.ts
interface RailsDockModel {
  …
  /** The check whose page replaces the row list; null shows the list. */
  readonly detail: string | null;
}
type RailsDockRow =
  | …
  | { kind: 'check'; key: string; section: 2; decl: RailsCheckDecl; manualRun: RailsCheckRun | null;
      result: RailsCheckResult | null; enforces: readonly RailsRule[] };

// rails/rows.ts
/** Rules whose `check` is `name`, in snapshot order. The same array for the same snapshot. */
export function enforcedRules(snapshot: RailsSnapshot, name: string): readonly RailsRule[];

// components/rails-dock/check-page.ts
export interface RailsCheckPageProps {
  readonly row: Extract<RailsDockRow, { kind: 'check' }>;
  /** `finishedAt` of the Rails run an auto check's result came from. */
  readonly runAt: string | null;
  readonly skipped: boolean;
  readonly inFlight: boolean;
  readonly runDisabledReason: string | null;
}
```

The memo is a `WeakMap<RailsSnapshot, Map<string, readonly RailsRule[]>>` with one shared frozen empty
array. A new snapshot misses the memo, and each check row repaints once.

### The list: the rule line

```
rails-verdict                       PASS   0.7s
  0025#1  The verdict is computed in code: any…
loopback-session-gate               PASS   2.1s
  0026#1  Session tokens are compared whole a…  +1
typecheck                           PASS   7.1s
  no rule — command only
```

- **Enforced:** `__rule` (`shortRuleId`), `__text` (one line, `…`), and a muted `+N` with more rules.
  The `title` lists every enforced rule as `<id> — <text>`.
- **No rule:** muted `no rule — command only`.
- **Untrusted:** the rule line stays, since reading repo docs needs no trust. The spec 345 argv line
  follows it.
- **Manual checks:** the same line under `name  RUN  <badge>  <time>`.
- **Colour:** neutral ink. The outcome badge stays the only fault colour (ADR-0017).
- Check rows no longer expand inline: `Enter` opens the page.

### The check page

```
‹ ESC   CHECKS › loopback-session-gate
loopback-session-gate               PASS   2.1s
run 23:42 · exit 0 · timeout 900s
PROVES                                       2
  0026#1  Session tokens are compared whole and
          in constant time (`LoopbackSession::…`),
          and `/app/session/<token>` answers …
          docs/adr/0026-loopback-app-session-…md
  0026#2  `next` must be a same-origin path: …
COMMAND
  sh scripts/rails-check.sh cargo
  loopback_app::tests::session_compare_checks_the_whole_token
  loopback_app::tests::session_landing_refuses_…
OUTPUT                                  exit 0
  running 5 tests
  test loopback_app::tests::asset_names_… ... ok
```

- **Head well:** a key cap `‹ ESC` (a button, `data-rails-back`) and the silk breadcrumb
  `CHECKS › <name>`. The second line is the check's own line: name, the `RUN` key for a manual check,
  the outcome lamp and the duration. The third line says where the result came from: `run 23:42`
  (the Rails run), or `manual · 11-10 02:17 · OMP-1` (spec 368), then `exit N` and the declared
  `timeout`. An auto check skipped for trust reads `skipped — waits for #rails trust`; one never run
  reads `not run`.
- **Proves:** one well with a count. Each rule shows its short id, its full text wrapping, and its
  source path (muted, one line, full path in `title`). With no rule: "No `## Rails` bullet names
  `check:<name>`, so its result says only whether the command succeeded."
- **Command:** one well. The argv breaks between arguments first, then after `::` and `/` inside an
  argument (`<wbr>`), and only then anywhere.
- **Output:** one well with `exit N` on the label line. The whole tail (Rust bounds it at 80 lines and
  8 KiB) has no height cap, and the page scrolls. With no output it reads `(no output)`, and before any
  run `not run`.
- **Scroll and updates:** the page is its own scroller in the rows region's slot; the hidden list keeps
  its rows. Opening a page starts at the top. A run that lands while the page is open repaints it in
  place and keeps the scroll position.
- **Around it:** the tab strip, the Actions bar (spec 344) and the key-hint row stay. The hints switch
  to `Esc back · j/k scroll · s send · r run · [ ] tab`.

### Keybindings (dock focused)

| Key | List (today, plus) | Page |
|-----|--------------------|------|
| `Enter` | On a check row: open its page. Other rows: expand, as today | — |
| `Esc` | Focus the composer, as today | Back to the list, the same row selected and scrolled into view |
| `j` / `k`, `↓` / `↑` | Move between rows | Scroll the page by about three lines |
| `s` / `r` | As today for the selected row | The same action as on that check's row |
| `1`–`5` | Jump to a section | Back to the list, then jump |
| `[` / `]` | Previous / next dock tab | The same; the page is still open when Rails is shown again |

Mouse: the first click on a row selects it, as today. A click on the already-selected check row opens
its page, and `‹ ESC` goes back.

### Display budget (amends 345)

| Check row state | Lines |
|---|---|
| Trusted | 2: outcome, rule line (was 1) |
| Untrusted | 3: outcome, rule line, argv (was 2) |
| Expanded | none: a check row no longer expands; its page uses the whole rows region |

**Spec 345 rule 1, narrowed.** "One fact, one place" now applies to the list's default view. An
enforced rule's text shows on its check's line, in full on the check page, and on its rule row. The rule
rows sit behind the collapsed `24 rules · 5 enforced ▸`, so the default list still shows each rule
text once.

## Edge Cases

- **The check leaves the manifest** (`#rails update`, an edit, or a manifest error, which empties the
  checks) while its page is open: the page closes to the list, the keys are the list's again, and the
  selection falls back as it does when a row disappears.
- **The dock is hidden or another tab is shown:** `detail` stays in the model, and showing Rails again
  shows the page.
- **A manual run started from the page (`r` or `RUN`):** the key reads `RUNNING`, and the result
  repaints the page in place.
- **Untrusted:** the page shows `skipped — waits for #rails trust`, `output not run`, and the full
  command, which is what trust would allow.
- **A rule named by an undeclared check:** already a manifest warning; no check row or page shows it.
- **Rules from two sources enforce one check:** snapshot order (source path, then bullet order) on the
  line and in Proves.

## Implementation notes (2026-11-16)

- `parts.ts` is new: the outcome badge, RUN key and time text moved out of `index.ts` so the rows and
  the page cannot paint a check two ways.
- `RailsCheckPageProps` has no `untrusted`: the page follows the row, which reads `skipped` from the
  latest run.
- Check rows ignore `expanded` (the controller no longer adds check keys), and the inline check detail
  and its `__tail` rule are gone.
- The controller closes a page in `renderDock()` when the snapshot no longer declares its check; the
  dock also falls back to the list when the row is missing.
- Proves rule rows stay flat, separated only by a groove border; the enclosing well owns the
  recess shadow (ADR-0030#4).

## Open Questions

None. These choices are deliberate:

1. The page replaces the list in the same panel (the user's choice). `Esc` goes back one level.
2. Only check rows get a page; findings, rules and runs keep their short inline expansion.
3. `typecheck` shows `no rule — command only`. Giving it a rule is a later docs change.

## Out of Scope

- Pages for findings, rules and runs, and stepping to the next or previous check from a page.
- A `description` key on `[[check]]`, a `check:typecheck` rule, translating rule text.
- Parsing test names out of the output tail.
- The head, the Actions bar's buttons, the footer and the loopback pages.

## Resources

- [k9s README (mirror)](https://github.com/davidnemec/k9s) and [Manage K8s with k9s — KodeKloud](https://kodekloud.com/blog/manage-k8s-with-k9s-kubernetes-cli/): `Enter` drills into a resource, `Esc` goes back one level through the breadcrumbs.
- [lazygit guide](https://talkohavy.github.io/guides/docs/programming/git/lazy-git) and [lazygit `Keybindings_en.md`](https://sources.debian.org/src/lazygit/0.57.0%2Bds1-1/docs/keybindings/Keybindings_en.md): `Enter` on a commit opens its files in the same panel, `Esc` returns.
- [REST API endpoints for commit statuses](https://developer.github.com/v3/repos/statuses): `context`, a one-line `description`, `target_url` for detail.
- [ESLint — Custom Rules](https://eslint.org/docs/v9.x/extend/custom-rules) and [ArchUnit `ArchRule` Javadoc](https://www.javadoc.io/static/com.tngtech.archunit/archunit/1.0.0/com/tngtech/archunit/lang/ArchRule.html): the rule's own text as the explanation.
- Internal: specs 337, 344, 345, 368, 319 (the modal alternative); `.krypton/rails.toml` and `docs/adr/0025`, `0026`, `0029` of this repo.
