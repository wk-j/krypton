# Harness Inter-Lane Transcript UX — Implementation Spec

> Status: Implemented (Phases 1–2; Phase 3 partial — harness event styling)
> Date: 2026-05-26
> Milestone: M-ACP — Harness Multi-Agent
> Related: `docs/106-inter-lane-messaging.md`, `docs/112-acp-review-lane-mode.md`, `docs/115-mention-fanout.md`, `docs/116-soft-awaiting-peer.md`, `docs/118-acp-peer-activity-ui.md`, `docs/72-acp-harness-view.md`
> **Visual review:** `docs/previews/120-harness-inter-lane-ux-review.html` (open in browser)

## Problem

Users in the ACP Harness cannot reliably tell **lane mail** (agent-to-agent messages via `peer_send`, `@mention`, or `#review`) apart from **assistant replies** (the lane’s user-facing model output). The current `inter_lane` transcript rows use a light tint and markdown body that reads like a second assistant turn; when a lane drains peer mail and runs a turn, the following assistant block has no causal label.

A premature UI experiment (loud “LANE MESSAGE” peer cards) was reverted; this spec replaces ad-hoc styling with a disciplined visual language and provenance.

## Solution

Introduce a **four-type transcript model** in the harness dashboard, without new panels or filter toggles in v1:

1. **Lane mail** — quiet inbox cards for `inter_lane` rows (plain text, direction + peer name, visually quieter than assistant).
2. **Harness event** — thin system/log rows for coordinator notices (`appendSystemNotice`, synthetic `__harness__` envelopes); not content cards.
3. **Assistant reply** — unchanged streaming/markdown path; optional **provenance** line when the turn was triggered by draining lane mail.
4. **User** — composer-submitted prompts only (`submitActiveLane` → `appendTranscript(..., 'user', ...)`).

Implementation ships in **phases**: dedup audit → lane-mail visuals → provenance tagging → harness-event + mention/review alignment. No Rust changes. No transcript filter UI in v1 (keyboard-first, density-first).

## Research

**Codebase (current behavior):**

- `InterLaneCoordinator.deliver()` appends **outbound** `inter_lane` rows on the sender (`inter-lane.ts`).
- `drain()` appends **inbound** `inter_lane` rows per envelope, then calls `enqueueSystemPrompt()` with a composed `[inter-lane] From …` text block (`inter-lane.ts:738–739`).
- `enqueueSystemPrompt()` (`acp-harness-view.ts:726–738`) calls `lane.client.prompt([{ type: 'text', text }])` only — it does **not** call `appendTranscript(..., 'user', ...)`. The `[inter-lane]` prompt is **ACP-session-only**, not a harness user bubble today.
- `appendSystemNotice()` adds `system` rows prefixed with `[inter-lane]` for cancel/close side effects (`acp-harness-view.ts:634–637`).
- Synthetic `fromLaneId: '__harness__'` envelopes skip `inter_lane` rows on drain; the notice is system-only (`inter-lane.ts:703–707`).
- `renderTranscriptItem()` renders `inter_lane` with markdown (`acp-harness-view.ts:5387–5396`) — matches assistant body styling and drives confusion.
- Spec **118** already adds zen-rail peer hints, composer peer strip, and peek preempt — this spec **audits** those surfaces for copy alignment; it does not replace them.

**Lane brainstorm (Codex-1, Claude-1, user revert):**

- Codex: lane mail ≠ assistant; system notices = event rail; provenance on post-drain assistant; avoid “peer” in chrome; filters deferred.
- Claude: **dedup first**; provenance tied with visual separation; skip filter toggles v1; smallest slice = CSS then `causedByEnvelopeId`; align mention fan-out and review cards; design doc before code (precedent: unapproved peer-card shipped and reverted).

**Alternatives ruled out:**

- *Loud peer cards / nested lane-mail card* — reverted / rejected; too assistant-like and nested.
- *Transcript show/hide toggles in v1* — click affordance, low value for keyboard-first users.
- *Synthetic user row for every drain* — would duplicate the inbound `inter_lane` card; provenance on assistant is sufficient.
- *God-view file split* — Spec 105; out of scope here.

## Prior Art

| App | Closest pattern | Notes |
|-----|-----------------|-------|
| Slack / Discord | Channel messages vs thread replies; system messages styled differently | Badge + message type separation |
| Zed / VS Code | Separate agent threads; no cross-thread mail in one transcript | Krypton merges lanes in one dashboard per project |
| Email clients | Inbox vs sent vs system notifications | Lane mail maps to inbox artifact |

**Krypton delta** — Lane mail stays in the **same lane transcript** (no global mixed-lane feed). Visual language is flat BEM, purple/blue peering accent (`#b8a6ff`, Spec 106), no `backdrop-filter`. Chrome labels are lowercase English; `title` may carry Thai hints. MCP tool names remain `peer_send` / `peer_list`.

## Affected Files

| File | Change |
|------|--------|
| `src/acp/acp-harness-view.ts` | `renderInterLaneBody()`; provenance on assistant rows; harness-event system styling; track `pendingDrainEnvelopeId` per lane turn; extend `HarnessTranscriptItem` / `transcriptRenderSignature` |
| `src/acp/inter-lane.ts` | Pass envelope id into host when starting drain-driven prompt (host callback or lane turn context) |
| `src/styles/acp-harness.css` | Lane-mail card, harness-event row, provenance line styles |
| `src/acp/acp-harness-view.test.ts` | Render-signature / provenance helper tests |
| `docs/106-inter-lane-messaging.md` | Cross-reference visual language + dedup |
| `docs/118-acp-peer-activity-ui.md` | Align composer strip copy with “lane mail” |
| `docs/PROGRESS.md` | Entry when approved/implemented |

## Design

### Transcript taxonomy

| Kind | Source | User-facing label (column) | Body treatment |
|------|--------|---------------------------|----------------|
| `user` | Composer `submitActiveLane` | `user` | Existing user styling |
| `assistant` | ACP `session/update` | `agent` | Markdown/streaming; optional provenance prefix |
| `inter_lane` | `appendInterLaneRow` | `mail` | Quiet **lane-mail card**, plain text |
| `system` + harness prefix | `appendSystemNotice` or tagged notices | `event` | **Harness event** rail (dim, single-line preferred) |
| `review` | Spec 112 | `rev` | Existing review card (unchanged structure; shared accent family) |

Do not use the word **peer** in chrome labels. MCP tools keep `peer_*` names.

### Data Structures

```ts
// acp-harness-view.ts — extend existing payloads
interface InterLanePayload {
  direction: 'in' | 'out';
  peerId: string;
  peerDisplayName: string;
  done: boolean;
  envelopeId?: string;   // NEW — ties to InterLaneEnvelope.id
  channel?: 'peer' | 'mention' | 'review';  // NEW — default 'peer'
}

interface HarnessTranscriptItem {
  // ...existing fields...
  /** Set on the first assistant row of a turn started by coordinator drain. */
  replyingToLaneMail?: {
    envelopeId: string;
    peerDisplayName: string;
    direction: 'in';
  };
}

// Per-lane turn bookkeeping (HarnessLane or view-private Map)
interface LaneTurnContext {
  drainEnvelopeIds: string[];  // cleared when turn ends (stop_reason)
}
```

### Provenance rules

1. When `InterLaneCoordinator.drain()` calls `enqueueSystemPrompt`, the host records `lane.pendingDrainEnvelopeIds` from drained non-synthetic envelope ids (or the first id if batched).
2. On the **first** `assistant` transcript item created while `pendingDrainEnvelopeIds.length > 0`, set `replyingToLaneMail` from the oldest id and the matching inbound `inter_lane` row’s `peerDisplayName`.
3. Clear `pendingDrainEnvelopeIds` when the lane turn ends (`stop_reason` handled in `onLaneEvent`).
4. Render provenance as a **dim single line** above the assistant body: `↩ replying to lane mail from cursor-1` (lowercase peer display name).
5. Mention fan-out drains: same provenance path; envelope `kind === 'mention_request'` sets `channel: 'mention'` on the inbound `inter_lane` row label suffix optional (`mail · mention`).

### Dedup rules (priority 0)

| Scenario | Rule |
|----------|------|
| Inbound mail | One `inter_lane` row per envelope in `drain()` — keep. |
| `enqueueSystemPrompt` text | **Not** mirrored as a `user` row (already true). |
| `__harness__` synthetic drain | No `inter_lane` row; only `system` harness event if `appendSystemNotice` already fired — keep. |
| Cancel/close | `appendSystemNotice` → harness **event** row only; must **not** repeat full mail body if an `inter_lane` row with same envelope already exists. |
| Review request | Outbound summary `inter_lane` + inbound full prompt via drain — not duplicate; review **card** on reply (Spec 112) stays separate from lane-mail card. |

**Audit task (Phase 0):** Manually trace `#cancel`, peer close, and mention fan-out; add tests if two rows show the same semantic content.

### UI — Lane mail row (flat; no nested container)

**Rejected:** nested “lane mail card” (wrapper + inset body + dashed inner border). User feedback + reverted loud peer-card experiment — too assistant-like and visually heavy.

**Chosen: Option A — flat meta line + text** (see `docs/previews/120-harness-inter-lane-ux-review.html`). Same DOM depth as every other transcript row: `.acp-harness__msg` → `.acp-harness__msg-label` + `.acp-harness__msg-body` only.

Rendered in `renderTranscriptItem()` for `kind === 'inter_lane'`:

- Label column: `mail` (uppercase, purple/blue via row modifier).
- Row modifiers: `.acp-harness__msg--inter_lane`, `.acp-harness__msg--mail-in` | `--mail-out` — color tokens only (label + meta); **no colored left border** on lane-mail rows (user feedback).
- Body modifier: `.acp-harness__msg-body--lane-mail` — same body text size as assistant rows, muted foreground (quieter than assistant). Optional **flat** `background` tint on the body only (no border, no inset shadow). Meta/provenance lines may stay smaller.
- Body children (no wrapper div):
  - `span.acp-harness__lane-mail-meta` — one dim line: `← from codex-1 · lane mail` or `→ to claude-1 · lane mail` (lowercase display names; arrow + text, not icon-only).
  - `span.acp-harness__lane-mail-text` — `textContent` only, `white-space: pre-wrap` (no markdown).
- If `done`: append `· closed` to the meta line (no extra chip/container).
- **Alternatives considered:** (B) meta in label column + dashed border on body only; (C) single-line fs-activity-style chip — rejected for long messages.

Visual priority: **lower** than `.acp-harness__msg--assistant` (no green lane accent, no inset box-shadow). `content-visibility: auto` on sealed rows per Spec 117.

### UI — Harness event rows

For `kind === 'system'` where `text.startsWith('[inter-lane]')` or `item.harnessEvent === true`:

- Label: `event`.
- Classes: `.acp-harness__msg--harness-event`, `.acp-harness__harness-event-body`.
- Single-line when possible; wrap only if long. No markdown. **No left border** — dim purple text + typography only, not chrome bars.

### UI — Awaiting peer (align Spec 118)

Composer peer strip and flash chips use **lane mail** vocabulary:

- `awaiting reply from codex-1 · #cancel to release` (informational; Spec 116 — composer not blocked).

Audit existing `buildComposerPeerStrip()` strings; change “peer” → “lane mail” where user-visible.

### Data Flow

```
1. Lane A peer_send → coordinator.deliver
2. A gets inter_lane out row; B inbox push
3. B idle → drain: inter_lane in row(s) per envelope
4. Host sets B.pendingDrainEnvelopeIds; enqueueSystemPrompt(composed text)  // no user row
5. B busy → assistant streams
6. First assistant row gets replyingToLaneMail metadata → render provenance line
7. Turn ends → clear pendingDrainEnvelopeIds
```

### Keybindings

No new keybindings. `#cancel` remains the escape hatch (Spec 106).

### Configuration

No new TOML keys.

## Implementation Phases

| Phase | Scope | Files |
|-------|--------|-------|
| **0** | Dedup audit + tests for cancel/close/mention | `inter-lane.test.ts`, manual checklist in PR |
| **1** | Flat lane-mail row CSS + plain-text render + copy | `acp-harness-view.ts`, `acp-harness.css` |
| **2** | Provenance: `pendingDrainEnvelopeIds`, `replyingToLaneMail`, render line | `acp-harness-view.ts`, `inter-lane.ts` (host hook) |
| **3** | Harness-event system styling; mention/review `channel` on inter_lane | `acp-harness-view.ts`, `acp-harness.css` |
| **4** | Copy alignment in composer strip / rail (Spec 118 audit) | `acp-harness-view.ts`, `docs/118-…` cross-ref |

Phases 1–2 are the **minimum shippable** fix for the reported confusion.

## Edge Cases

- **Multiple envelopes in one drain** — Provenance references the **first** envelope id; all inbound rows still render. Provenance text: `replying to lane mail (N messages) from cursor-1` when N>1.
- **User composer prompt while inbox pending** — User turn wins; drain runs on next idle. Provenance only for coordinator-driven prompts.
- **Review reply** — Uses `review` card, not lane-mail provenance string; optional `channel: 'review'` on related `inter_lane` summary rows only.
- **Assistant turn with no text** (tool-only) — Provenance attaches to first assistant **content** row if any; else omit.
- **Lane closed mid-await** — Harness event notice only; no provenance on partial assistant.

## Phase 0 audit (2026-05-26)

**Method:** Static trace of `InterLaneCoordinator` + `enqueueSystemPrompt` + Vitest in `inter-lane.test.ts` (`InterLaneCoordinator transcript dedup`).

| Flow | Transcript rows | Duplicate mail card? |
|------|-----------------|----------------------|
| `peer_send` → `deliver` (sender) | One `inter_lane` **out** | No |
| `drain` (recipient) | One `inter_lane` **in** per envelope | No — batched envelopes = N rows, not 2× same envelope |
| `enqueueSystemPrompt` after drain | **None** (ACP session only) | No user row; not a second card |
| `#cancel` / lane close | One `system` via `appendSystemNotice`; harness synth skips `inter_lane` on drain | No second card — system line + agent prompt differ in text and role |
| `review_request` drain | Short `inter_lane` in + full prompt to ACP | Intentional summary vs body — not byte-identical duplicate |
| `review_reply` | `review` card + optional `__harness__` inject (no `inter_lane` for synth) | No |

**Root cause of user confusion (not dedup):** `inter_lane` rows use markdown styling similar to assistant output, and the **next assistant turn** after drain has **no provenance** — reads as “agent spoke twice.” Phase 1–2 address this; Phase 0 found no bug requiring dedup fixes before UI work.

**Follow-up (optional):** Style `appendSystemNotice` rows as harness events (Phase 3) so cancel lines do not look like generic `sys` noise next to lane mail.

## Resolved decisions

- **Column labels (2026-05-26):** User approved English chrome labels `mail`, `event`, `agent`, `user` as specified. Optional Thai `title` tooltips allowed later; not required for v1.
- **Phase 0 (2026-05-26):** User asked to run dedup check first. Audit complete; proceed to Phase 1–2.
- **Layout (2026-05-26):** User rejected nested container / card-in-card. Spec updated to **Option A** flat meta line + text (preview HTML revised).
- **Chrome (2026-05-26):** User rejected left-border accent on lane mail (and harness events). Distinction = label color + meta line + muted body only.

## Out of Scope

- Transcript filter toggles (“show lane mail”).
- Global cross-lane timeline panel.
- Markdown rendering inside lane-mail bodies.
- Splitting `acp-harness-view.ts` (Spec 105).
- Rust / MCP protocol changes.
- Thai primary chrome labels (English chrome + optional `title` Thai per lane).

## Resources

- `docs/106-inter-lane-messaging.md` — peering lifecycle, `inter_lane` row type
- `docs/118-acp-peer-activity-ui.md` — rail + composer strip
- Codex-1 / Claude-1 inter-lane UX brainstorm (2026-05-26, harness lanes) — priorities and dedup
- N/A — no external web research required
