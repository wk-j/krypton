# Weight-Dynamic Attention Gauge — Implementation Spec

> Status: Implemented
> Date: 2026-06-02
> Milestone: M8 — Polish

## Problem

The attention backpressure gauge in the workspace footer (spec 128) shows a flat
`N attention` amber chip. It tells the human *how many* forks await but nothing
about *how heavy* they are — an open `irreversible` decision looks identical to a
pile of trivial `reversible` ones. The single ambient pull should communicate
weight at a glance, not just a count.

## Solution

Make the chip **weight-dynamic** (prototype variant D): its colour reflects the
**heaviest open reversibility** in the queue (cyan `reversible` → amber `costly`
→ red `irreversible`), and a small **pip strip** encodes the count discretely
(1–6, then `6+`). This is dynamic by *judgement weight*, not by *activity* — it
stays fully **static** (no blink, no pulse, no motion), so it does not reopen the
ADR-0001 "busy dashboard" trap that made spec 128 deliberately motionless. Across
multiple harness tabs the footer sums counts and takes the **max** tier.

## Research

- **Deliberate-static precedent (the constraint this must respect).** Spec 128
  §UI and the `## Resources` ADR-0001 chose a motionless gauge on purpose:
  attention triage surfaces *judgement weight*, and `lane peek heat` already owns
  *activity*. Motion would conflate the two. **This spec keeps the gauge static**
  — colour + pips are steady-state encodings, not animations. The rejected
  prototype variant E (pulse-on-irreversible) is explicitly out of scope.
- **Data already on hand.** `AttentionTriageStore.openItems()`
  (`src/acp/attention-triage.ts:167`) returns items **already sorted by
  reversibility descending** (comparator at `:41`, `REVERSIBILITY_WEIGHT`), so
  `openItems()[0]?.reversibility` *is* the max tier — no new computation.
- **Publish path.** `publishAttentionCount()`
  (`acp-harness-view.ts:2476`) already emits `system:attention` and dedupes on
  `openCount`. It needs to also carry the tier and dedupe on it.
- **Footer aggregation.** `WorkspaceFooter` keeps `attentionBySource:
  Map<string, number>` and sums on render (`workspace-footer.ts:120, 385`). The
  value becomes `{ count, tier }`; sum counts, max the tier.
- **Validated visually** in the interactive prototype (artifact
  `art-2-202aae20.html`); the user selected variant D.

## Prior Art

| App | Implementation | Notes |
|-----|----------------|-------|
| VS Code status bar | Items recolour by severity (errorBackground / warningBackground); counts as plain numbers | Colour-as-severity is the same idiom; VS Code has no discrete pip encoding |
| GitHub / Linear badges | Numeric count pills, sometimes red when blocking | Count-only; no weight tier |
| macOS / iOS badges | Red dot + count | Count-only, single colour |

**Krypton delta** — Krypton already separates *activity* (`lane peek heat`) from
*judgement* (attention triage), so the gauge encodes the **reversibility tier of
the heaviest waiting decision** rather than activity intensity, and does it
**without motion** (unlike notification badges that bounce/pulse). The pip strip
is a cyberpunk-native discrete readout that keeps the chip narrow and glanceable.

## Affected Files

| File | Change |
|------|--------|
| `src/view-bus-types.ts` | Extend `system:attention` value with `maxReversibility: AttentionTier \| null` (local string union `'reversible' \| 'costly' \| 'irreversible'`, kept self-contained — no import from acp types). |
| `src/acp/acp-harness-view.ts` | `publishAttentionCount` → `publishAttention(openCount, maxTier)`; derive `maxTier = openItems()[0]?.reversibility ?? null`; dedupe on both fields; call sites at `:2209` (dispose → `0, null`) and `:2471`. |
| `src/workspace-footer.ts` | `attentionBySource: Map<string, {count, tier}>`; aggregate (sum counts, max tier by weight); `renderAttention` sets the tier modifier class, the `6+`-capped count label, and builds the pip strip. |
| `src/styles/workspace-footer.css` | Tier colour modifiers (`--rev-reversible/-costly/-irreversible`) on `--attention`; `.pips` / pip `i` styles. No animation. |
| `docs/128-attention-triage.md`, `docs/04-architecture.md` | Update the gauge description (was flat `N attention`); note this spec supersedes the flat chip while keeping the static-by-design rule. |
| `docs/PROGRESS.md` | Milestone note. |

## Design

### Data Structures

```ts
// view-bus-types.ts — self-contained union, mirrors acp Reversibility values
export type AttentionTier = 'reversible' | 'costly' | 'irreversible';

'system:attention': { sourceId: string; openCount: number; maxReversibility: AttentionTier | null };
```

```ts
// workspace-footer.ts
private attentionBySource = new Map<string, { count: number; tier: AttentionTier | null }>();
const TIER_WEIGHT: Record<AttentionTier, number> = { reversible: 0, costly: 1, irreversible: 2 };
```

### Data Flow

```
1. triageStore changes → acp-harness-view computes:
     openCount   = triageStore.openCount()
     maxTier     = triageStore.openItems()[0]?.reversibility ?? null   // list is pre-sorted desc
2. publishAttention(openCount, maxTier): dedupe on (count, tier); emit system:attention { sourceId, openCount, maxReversibility }
3. WorkspaceFooter.onSignal: openCount>0 ? set {count,tier} : delete sourceId
4. renderAttention(): n = Σ count; tier = argmax TIER_WEIGHT over present sources (null → fallback 'costly')
     - hidden when n == 0
     - class: __segment--attention + __segment--rev-<tier>
     - text:  `${n>6 ? '6+' : n} attention`
     - pips:  min(n,6) lit bars + (6 - that) dim bars
```

### UI Changes

- `--attention` gains one of three tier modifier classes driving colour
  (cyan / amber / red) of text, border, and background tint — reusing the
  triage-overlay palette so the footer chip and the overlay cards agree on what
  each colour means.
- A `.krypton-workspace-footer__attention-pips` strip of up to 6 `<i>` bars
  (`currentColor`, lit vs `opacity:0.18` dim) follows the count text. Caps at 6;
  the label reads `6+` past that. No transition longer than the existing colour
  fade; no keyframes.
- Chip keeps `flex:0 0 auto` + `overflow:visible` (spec for the no-clip fix) so
  the wider colour+pips chip still never ellipsises.

### Configuration

None. No new TOML keys (consistent with spec 128 — the gauge is not configurable).

## Edge Cases

- **count > 0 but tier null** (shouldn't happen — every open item has a
  reversibility): fall back to `costly` (amber, the old default) so the chip is
  never uncoloured.
- **Multiple harness tabs, different tiers**: counts sum, colour = the single
  heaviest tier across all sources (one red item anywhere ⇒ red chip).
- **count drops to 0**: source deleted from the map; chip hidden at total 0
  (unchanged).
- **count 1**: one lit pip — still drawn (a single pip is meaningful, not noise).
- **Reduced-motion users**: no impact — there is no motion to suppress.

## Open Questions

None.

## Out of Scope

- **Motion / pulse / blink** on the gauge — rejected (prototype variant E),
  conflicts with spec 128's static-by-design rule and ADR-0001.
- **Per-tier breakdown counts** (e.g. "2 red · 3 amber") — only the max tier is
  carried; a full breakdown is a heavier signal change and unneeded for v1.
- The **judgement-card overlay** redesign (separate uncommitted change) — this
  spec is footer-only.
- Count-**intensity** saturation (variant B) — not chosen.

## Resources

- `docs/128-attention-triage.md`, `docs/adr/0001-attention-triage-self-reported-router.md`
  — the static-by-design rule and the activity-vs-judgement distinction this spec must respect.
- Interactive prototype `art-2-202aae20.html` (variant D selected by the user) — the visual contract.
- No external/web research needed — purely internal UI on existing data.
