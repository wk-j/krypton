# Harness Notice Rows — Implementation Spec

> Status: Implemented (approved 2026-11-08: "อนุมัติสเปก docs/0371-harness-notice-rows.md ให้เป็น Approved แล้วเริ่มแก้โค้ดตามสเปกนั้น")
> Date: 2026-11-08
> Milestone: Krypton Console — consistency
> Builds on: 302 §3.14 (`SystemRow`) · 366 (Console faceplate) · DESIGN.md "Chips", "Surfaces"

## Problem

Harness subsystems (triage, Xenon, review, usage, inter-lane) report into a lane's transcript as
`system` rows whose text starts with a bracket tag and an event phrase:
`SYS  [triage] flagged for review: <question>`. `SystemRow` writes the text as one text node, so
the tag, the event and the subject read as one run of body text, the label says `sys` for every
source, and a failure (`[xenon] push failed: …`) looks like a success. Only `[inter-lane]` is
recognised; its prefix is parsed out and the label becomes `event`.

## Solution

A subsystem row carries a structured `notice` — `{ source, action, tone, subject }` — set by the
caller. The row label names the source (`TRIAGE`, `XENON`, `REVIEW`, `USAGE`, `EVENT`) in the
engraved silk every row label uses. The body opens with the action as a flat-ink legend, with a
status LED before it when the tone asks for the human (amber: weigh in; fault: it failed), then the
subject in body ink. This is the tool row's grammar (label · LED · kind legend · subject). One
builder writes `item.text` as `[source] action: subject`, so Live Assist, the orchestrator feed and
the control API keep a complete line. `[inter-lane]` moves onto the payload and prefix parsing goes.

## Research

- **Call sites** (all in `src/acp/acp-harness-view.ts`): `[inter-lane]` 2032 (from
  `inter-lane.ts` `appendSystemNotice`: `peer X cancelled` / `closed`); `[review] recorded` 3311;
  `[triage] flagged for review` 3361; `[review thread]` 3642; `[triage] redirect failed` 5733;
  `[xenon]` push 7205 / push failed 7213 / token 7468 / status 7502 / handoff auto-push 9833 /
  review auto-push 9865; `[usage]` 7423; unbracketed `xenon: … - local handoffs only` 11872.
- **Renderer**: `system-row/index.ts:33-49` recognises only `[inter-lane]`; `:98` writes
  `body.textContent = text`. `transcript/rows.ts:53` routes the event variant before the
  `item.diff` branch.
- **Label column**: `harness-shared.css:523-545` — 7.5ch, right-aligned, silk, 0.64em uppercase
  with 0.13em tracking; about nine label characters fit. Every proposed label is six or fewer.
- **Transcript label rule**: DESIGN.md "Chips" and spec 366 — every transcript label is flat ink, no
  key face, capsule, border or shadow; its LED sits before the legend. The tool row is the model
  (`tool-row.css:58-131`: a 6px LED, an uppercase legend at 0.78em with 0.09em tracking, then the
  subject). ADR-0017: colour only for a fault or something the human must act on. ADR-0004:
  model output stays ink or amber.
- **`text` has other readers**: Live Assist prints it under `SYSTEM` (`live-assist-view.ts:458,
  621, 879`); the orchestrator feed lists system rows (`acp-harness-view.ts:6179-6183`); the
  control API `lane.transcript` (`:2501-2511`, used by the Raycast extension) returns `text` only.
  So `text` must stay a whole sentence. Precedent: `item.usage` (spec 250) — a payload for the
  row, `text` as the portable fallback (`harness-view-types.ts:145-147`).
- **No disk form**: `lane.transcript` is in memory; nothing writes it to disk, so there are no
  stored rows to migrate.
- **Alternative ruled out — parse the prefix at render**, generalising `[inter-lane]`. No caller
  changes, but the action/subject split would be a guess at the first `:` (subjects contain colons:
  `krypton: 3 pushed`), and the tone would be a regex on `failed`. The caller already knows all
  four fields.

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| WeeChat | Each line has a prefix column, right-aligned by default (`weechat.look.prefix_align`); system lines get their own prefix and colour (`prefix_network` `--`, `prefix_error` `=!=`) | Same layout as Krypton's right-aligned label column |
| GitHub (Primer `Timeline`) | A timeline event is a badge (icon coloured by state) and a body ("X added the bug label") | Source and state are separate from the sentence |
| Krypton tool row | Label `TOOL`, 6px status LED, flat kind legend, subject | The grammar this spec reuses |

**Krypton delta**: the source goes in the existing label column rather than an icon; state is an
LED, not a coloured badge; the action is flat ink, not a chip (DESIGN.md forbids chips in the
transcript).

## Affected Files

| File | Change |
|------|--------|
| `src/acp/harness-notice.ts` (new) | `HarnessNotice` types, `NOTICE_LABEL`, `noticeText()` |
| `src/acp/harness-view-types.ts` | `HarnessTranscriptItem.notice?: HarnessNotice` |
| `src/acp/acp-harness-view.ts` | `appendNotice()`; the 13 call sites above use it |
| `src/acp/components/system-row/index.ts` | Paint the notice; drop the `[inter-lane]` parse |
| `src/acp/components/system-row/system-row.css` | Action legend, LED, subject; light scheme |
| `src/acp/components/system-row/system-row.test.ts` | Event tests on the payload; notice tests |
| `src/acp/components/transcript/rows.ts` | Route `notice` rows where `event` rows went |
| `src/acp/xenon-push.ts` | `pushTone(report)` beside `describePush()` |
| `src/acp/review-auto-push.test.ts` | Assert the auto-push notice (source, action, tone) |
| `docs/0302-harness-component-catalog.md` §3.14, `DESIGN.md` "Chips", `docs/0120`, `docs/0307`, `docs/README.md` | Example rows, the notice legend in the flat-label list, superseded notes, index |

## Design

### Data Structures

```ts
// src/acp/harness-notice.ts
export type NoticeSource = 'inter-lane' | 'triage' | 'xenon' | 'review' | 'usage';
/** info: no LED. attention: amber LED, the human should weigh in. fault: fault LED, it failed. */
export type NoticeTone = 'info' | 'attention' | 'fault';
export interface HarnessNotice {
  source: NoticeSource;
  /** Short verb phrase drawn as the legend; omitted when the subject says it all. */
  action?: string;
  tone: NoticeTone;
  subject: string;
}
export const NOTICE_LABEL: Record<NoticeSource, string>; // 'inter-lane' → 'event', others → source
export function noticeText(n: HarnessNotice): string;   // `[source] action: subject` / `[source] subject`
```

`AcpHarnessView.appendNotice(lane, notice)` calls `appendTranscript(lane, 'system',
noticeText(notice))` and sets `item.notice` before the row's first paint. A notice is immutable
once appended.

### Call-site mapping

| Site | source | action | tone | subject |
|------|--------|--------|------|---------|
| inter-lane peer cancelled / closed | inter-lane | — | info | `peer X cancelled` |
| `review_outcome` | review | `recorded` | info | `label — 2 blockers, 1 warning across 3 reviewers` |
| `attention_flag` | triage | `flagged` | attention | the question |
| review thread created | review | `thread` | info | `<threadId> · กำลังเตรียม Guide` |
| triage redirect failed | triage | `redirect failed` | fault | reason |
| `#xenon push` | xenon | `push` | fault if `failed + blocked > 0`, else info | `describePush(report)` |
| `#xenon push` threw | xenon | `push failed` | fault | message |
| `#xenon token` | xenon | `token` | info | `stored in` / `cleared from the credential vault` |
| `#xenon status` | xenon | `status` | info | the six `key: value` lines |
| handoff / review auto-push | xenon | `handoff auto-push` / `review auto-push` | fault on error or a failed/blocked item; attention when Xenon is not ready; else info | as today |
| resume with Xenon unreachable | xenon | `resume` | fault | `<reason> — local handoffs only` |
| `#usage` | usage | — | info | `describeUsage(rollup)` |

`#usage` with a recorded rollup still renders `UsageRow` (`item.usage` routes first).

### Data Flow

```
1. A subsystem calls appendNotice(lane, { source, action, tone, subject })
2. appendTranscript stores text = noticeText(notice); appendNotice sets item.notice
3. rowKindFor: kind 'system' with notice → SystemRow (before the item.diff branch, as event did)
4. SystemRow: label = NOTICE_LABEL[source]; body = [action legend][subject]
5. Live Assist, orchestrator feed, control API read item.text unchanged in shape
```

### UI Changes

```
 TRIAGE  ● FLAGGED  Should the CLEAN lamp be green like PASS?
  XENON  ● PUSH FAILED  network unreachable
  XENON  PUSH  krypton: 3 pushed · 1 unchanged
 REVIEW  RECORDED  auth refactor — 0 blockers, 2 warnings across 2 reviewers
  EVENT  peer OMP-2 cancelled
    SYS  turn ended — max_tokens
```

- Label: the shared `.acp-harness__msg-label` with `NOTICE_LABEL[source]`; no new label style.
- Body: `<span class="acp-harness__notice-action acp-harness__notice-action--{tone}">` then
  `<span class="acp-harness__notice-subject">`. The action legend copies the tool kind legend
  (uppercase, 0.78em, 0.09em tracking, 8px before the subject), inline so a long subject wraps
  under the body's left edge. Ink: info `--krypton-ink-3`, attention `--mat-lit`, fault the danger
  ink (light scheme capped as `tool-kind`).
- LED: a 6px inline-block `::before` on the legend, 5px before it, only for attention
  (`--mat-lens-on` + `--mat-lens-glow`) and fault (the danger lens with glow, as
  `tool-glyph--failed`). Info has no LED.
- Subject: body ink (`--krypton-ink-2`), `pre-wrap`, so multi-line subjects keep their lines.
- `inter-lane` rows keep `acp-harness__msg--harness-event` and `acp-harness__harness-event-body`.
- `system-row` `def.blocks` gains `acp-harness__notice`.

## Edge Cases

- **No action** (`inter-lane`, `usage`): the body is the subject alone, under the source label.
- **Multi-line subject** (`#xenon status`, a push with failed items): the first line follows the
  legend, the rest start at the body's left edge.
- **System rows with no subsystem** (`turn ended …`, `permission reply failed: …`): no notice; the
  plain `sys` row is unchanged.
- **Hidden-rows indicator**: unchanged; it is synthetic and has no notice.
- **Sealed rows**: a notice row is static (`live = false`) and the notice never changes, so the row
  paints once (AGENTS.md constraint 10). `bodyDeps` lists `item.notice`.
- **Remote runtime on an older build**: its rows arrive without `notice` and render as plain `sys`
  rows with the bracket text, as today.

## Out of Scope

- Live Assist styling: it keeps printing `text` under `SYSTEM`.
- Giving a notice to system lines no subsystem raises (`turn ended …`, `permission reply failed: …`).
- New keys or actions on a notice row (for example opening the triage queue from it).
- Changing what any subsystem reports; only how the row presents it.

## Implementation Notes

- `pushTone()` lives in `xenon-push.ts` with the report formatter, so the manual push and both
  auto-pushes share one rule.
- `deliverRedirect()` may return no `reason`; the triage `redirect failed` subject then reads
  `not delivered` instead of the old `undefined`.
- Verified by rendering real `SystemRow` DOM with the shipped sheets in `WKWebView`, dark and light.

## Resources

- [WeeChat User's Guide — `weechat.look.prefix_*` options](https://weechat.org/files/doc/stable/weechat_user.en.html) — right-aligned prefix column; per-type prefixes for network and error lines.
- [Primer Timeline](https://primer.style/product/components/timeline/) — event = state badge + sentence body.
