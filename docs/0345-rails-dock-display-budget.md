# Rails Dock Display Budget — Implementation Spec

> Status: Implemented (approved 2026-10-29 after the UI preview: "ลงมือ implement สเปก docs/0345-rails-dock-display-budget.md ตามภาพจำลองที่แก้แล้วได้เลย")
> Date: 2026-10-29
> Milestone: ACP Harness — architecture conformance
> Builds on: 337 (Rails dock content) · 344 (Actions bar)
> Amends: 337 §UI Content (head, checks, rules, runs)

## Problem

The Rails dock column is 352 px wide and its rows share the height with the fixed Actions bar and
key hints. Today the head row alone can fill most of it. In the user's screenshot of this repo
(manifest `changed`, four checks), the head takes 31 wrapped lines and about three quarters of the
rows area before `CHECKS` begins. 26 of those lines are the argv list, and the check names in it
appear again in `CHECKS` two rows later. Two lines say the same thing ("auto run paused at trust"
and "rails.toml changed since trust — checks wait for #rails trust"). The meta line and the rules
summary are cut off with `…`, so `mode` and the judge-only count are not readable. The Actions bar
(spec 344, about 115 px) was not yet in that build, so the room is now smaller still.

## Solution

Give every element a fixed place and a size, by three rules:

1. **One fact, one place.** A fact appears once, in the row where it is acted on.
2. **The head is a status of at most three lines:** the verdict line, one state line, one meta
   line. Detail moves behind `Enter` on the head.
3. **Long text is one line; growing lists are capped.** The full text is behind `Enter`, as check
   tails and rule text already are.

## Research

- **Where the room goes** (`components/rails-dock/index.ts:248-298`). The head always paints the
  meta line, then the progress line, then, for any untrusted manifest with checks, the trust
  sentence and the full argv of every check (`__argv`, wrapped, `overflow-wrap: anywhere`), then
  the manifest error and one line per warning. In this repo's manifest
  (`.krypton/rails.toml`) the argv of `loopback-session-gate` alone is 5 test paths, 13 wrapped
  lines.
- **The argv is already reachable elsewhere.** An expanded check row shows `argv`, `exit` and the
  output tail (`checkDetail`, `:327-336`). The head list duplicates both the names and that
  detail.
- **The head row ignores `expanded`.** `toggleExpanded` works for any selected key
  (`harness-rails-controller.ts`), but `HeadRow.content` never reads `next.expanded`, so `Enter` on
  the head does nothing today. It can hold the head's detail without a new key.
- **Truncation today:** `__meta` is `nowrap` + ellipsis, so its last item (`mode …`) is the one cut.
  The rules row has the same shape with `▸` after it.
- **Runs grow to 20 rows** (`RAILS_HISTORY_LIMIT`). The head already shows the newest run's time
  and verdict.
- **Why the argv was listed (spec 337 §Trust):** the human should see the commands they approve.
  direnv, the model for the trust gate, prints only `<path> is blocked. Run 'direnv allow' to
  approve its content` and leaves reading the file to the user. Trust also covers only the
  manifest bytes; a script a check runs (`scripts/rails-check.sh`) is not hashed, so the argv list
  was never a full review. The program and first arguments are what identify a command.

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| direnv | A blocked `.envrc` produces one line: `<path> is blocked. Run 'direnv allow' to approve its content`. The content is not printed. | Trust needs the decision and where to look, not the whole file in the status. |
| VS Code Testing view | A tree with a status icon per test; output opens on demand (**Show Output**, Test Results panel). | One line per item; detail behind an action. |
| Krypton Rails dock (337) | Check rows already expand to argv, exit code and output tail. | The pattern this spec extends to the head and the runs. |

**Krypton delta.** Keeps the argv on screen while trust is pending, one line per check where the
check already is, instead of dropping it as direnv does.

## Affected Files

| File | Change |
|------|--------|
| `src/acp/rails/rows.ts` (+ test) | Runs capped at 5 rows; an `older` row (`N older runs`) expands to the rest |
| `src/acp/rails/types.ts` | `RailsDockRow` gains `{ kind: 'older'; count }`; the `rules` row drops `judgeOnly` |
| `src/acp/rails/format.ts` (+ new test) | `headStateLine()`: the one state line, by priority; `isEmptyManifest()` moves here from the component |
| `src/acp/components/rails-dock/index.ts` (+ test) | Head: verdict, state and meta lines, detail on `Enter`; check rows: argv line while untrusted, `not run`; rules summary; `OlderRow` |
| `src/acp/components/rails-dock/rails-dock.css` | `__state` and `__cmd` one-line rules, the head's `▸`; the `__trust` and `__argv` rules go (`__warnings` stays for the head detail) |
| Docs | 0337 §Trust and §UI Content, `README.md` index |

## Design

### Display budget

| Element | Today | After |
|---------|-------|-------|
| Head line 1 | `RAILS` · pill · time | Same, plus `▸` / `▾` when the head has detail (an error or warnings) |
| Head meta | `manual run · OMP-8 · changed · mode auto · stale` (cut) | `manual · OMP-8 · mode auto` (+ `· stale`). Trust moves to the state line |
| Head state | Progress line, plus the 2-line trust sentence, plus the empty-manifest hint | **One** line, see below |
| argv list | Every check, full argv, wrapped (26 lines here) | Removed from the head |
| Manifest error | Full paragraph | In the state line (one line, `…`); full text when the head is expanded |
| Warnings | One line per warning | In the state line as `2 manifest warnings` when nothing above it applies; list when the head is expanded |
| Check row | `name  PASS  1.2s`; `—` when not run | Same; `—` becomes `not run`. While trust ≠ `trusted`, a second line holds the argv, one line with `…` |
| Findings, resolved | 2 lines / 1 line | Same |
| Rules summary | `12 rules · 4 enforced · 8 judge-only ▸` (cut) | `12 rules · 4 enforced ▸`; judge-only is the rest, and the expanded list shows each rule |
| Sources without rails | 1 line | Same |
| Runs | Up to 20 rows | Newest 5, then `15 older runs ▸`, which expands to the rest |
| Actions bar, key hints | Fixed | Same |

### The state line

One line, the first that applies:

| Priority | When | Text | Tone |
|----------|------|------|------|
| 1 | progress `checking` / `judging` | `check 2/3 typecheck` · `judging` | amber |
| 2 | progress `error`, or manifest `error` | the message | ink-2 |
| 3 | trust ≠ `trusted` and the manifest is not empty | `changed since trust · 4 checks wait` / `not trusted · 4 checks wait`; with rules but no checks, `… · auto runs wait` | amber |
| 4 | progress `held`, `cooling`, `busy`, `clean-tree` | as today (`progressText`) | amber |
| 5 | empty manifest | `no rails yet · #rails init` (the lane writes them) | ink-2 |
| 6 | manifest warnings | `2 manifest warnings` | ink-2 |

`paused` needs no text of its own: it only happens when rule 3 applies.

The trust texts are sized to the column: at the user's 16 px font, `rails.toml changed · 4 checks
wait for trust` is cut with `…`, while the four rule-3 texts above fit (measured in the UI preview).
A longer `progressText` (`auto run held until 14:05 · min interval`) or an error may still be cut;
its full text stays behind `Enter` on the head.

### Head detail (`Enter` on the head row)

The expanded head shows, inside the existing `__detail` box: the state line in full (left out when
it is the manifest error, which follows), `manifest <path>`, the full manifest error and the warning
list. Nothing else moves there. The state line also carries its text as a `title`.

### Data Structures

```ts
// rails/types.ts
type RailsDockRow = … | { kind: 'older'; key: 'older'; section: 5; count: number };
// rails/rows.ts
export const RAILS_DOCK_RECENT_RUNS = 5;
// rails/format.ts
export interface HeadState { text: string; tone: 'accent' | 'ink' }  // accent → `__progress`, ink → `__hint`
export function headStateLine(snapshot: RailsSnapshot | null, progress: RailsProgress): HeadState | null;
export function isEmptyManifest(snapshot: RailsSnapshot): boolean;
```

`railsDockRows` emits the newest 5 runs, then the `older` row when more exist; while `older` is in
`expanded`, the remaining runs follow it.

### Keybindings

No change. `Enter` on the head now expands it; `Enter` on `older` lists the older runs.

## Edge Cases

- **A selected run moves under `older`** (a new run lands): the selection key no longer matches a
  painted row, so `moveSelection` starts from the top, as it does today when a row disappears.
- **Untrusted, rules but no checks:** no argv lines; the state line says auto runs wait for trust,
  which is what `paused` means there. An empty manifest shows the `#rails init` hint instead.
- **Error and untrusted at once:** the error wins the state line; the argv lines still show.
- **Narrow overlay (< 960 px):** same column width; nothing changes.
- **Light scheme:** an amber state line keeps the `__progress` class, which has a light-scheme
  rule; an ink one uses `__hint`, whose ink variable already follows the scheme.

## Open Questions

None. These choices are deliberate:

1. While trust is pending, each check row shows its argv on **one** line; the full command is behind
   `Enter`. The alternative keeps the full wrapped argv in each check row; it only saves the
   duplicated names (4 lines here) and keeps most of the height.
2. Runs show the newest 5 by default.
3. Warnings and the manifest path move behind `Enter` on the head; the state line counts warnings
   only when nothing more urgent applies.

## Out of Scope

- A sticky head. The dock is transparent over the window backdrop (spec 238), so a pinned row
  would need its own solid background.
- Diffing the manifest against the trusted version (the trust store keeps only a hash).
- Changes to the Actions bar, the key hints or the Ticket Panel.

## Resources

- [direnv `internal/cmd/rc.go`](https://github.com/direnv/direnv/blob/master/internal/cmd/rc.go): the blocked message, `%s is blocked. Run 'direnv allow' to approve its content`.
- [Testing — Visual Studio Code docs](https://code.visualstudio.com/docs/debugtest/testing): Test Explorer tree, status per item, output on demand.
- Internal: specs 337 (§Trust, §UI Content), 344; `.krypton/rails.toml` of this repo.
