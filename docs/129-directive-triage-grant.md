# Directive-Bound Triage Grant — Implementation Spec

> Status: Implemented
> Date: 2026-05-30
> Milestone: M8 — Polish
> Extends: `docs/128-attention-triage.md` (spec 128), `docs/124-acp-harness-directive-management.md` (spec 124)
> Reviewed by: Codex-1 (adversarial design review, 7 findings — all adopted)

## Problem

Spec 128 makes a lane able to call `attention_flag` only when it is *triage-equipped*. v1 models equip as a runtime-only per-lane toggle (`HarnessLane.triageEquipped`, bound to `Cmd+P '`). In practice this is hard to use: **most ACP clients fetch `tools/list` exactly once at session start**, so equipping a lane *after* it spawned never makes the tool appear — the lane was born without it. Spec 128 documents this as a caveat (128:20-23) but offers no ergonomic path to "this kind of lane should be able to flag from turn one."

Directives (spec 124) already answer the adjacent question — "this kind of lane should carry this role/system-prompt" — and they bind at lane spawn, *before* the first `tools/list`. Tying the triage grant to a directive lets a lane be born triage-equipped, which is exactly when equip is effective.

## Solution

Add a **spawn-time capability grant** to the directive model: a directive may carry `triage_equipped = true`. A lane spawned with (or assigned, see caveats) such a directive is equipped — the existing equip path (`triageStore.equip()` + the Rust `acp_set_lane_triage_equipped` mirror) is driven from the directive binding rather than only from a manual keystroke. The three existing gates (tools/list filter, call-time gate, frontend `mergeAttentionFlag`) are **untouched**; we only add a new producer of the existing `triageEquipped` flag.

This is **not** a general live-reconfiguration mechanism and the spec must not claim it solves the cache problem in general. It is a spawn-time default. Mid-session directive reassignment updates call-time authorization and UI but **cannot** be relied on to make the tool appear in an already-initialized client (see Edge Cases).

## Scope decision (Codex finding 1) — boolean, not a tool list

We use a single boolean `triage_equipped`, **not** a general `tools = ["attention_flag"]` grant list. Each future gated tool will likely differ in semantics (advertise-only vs call-gated, frontend merge behavior, approval UX, persisted trust scope, server namespace); a generic list invites the false assumption that all capability grants are uniform. A future general shape (`capabilities` / `tool_grants`) is named here but **explicitly deferred** until a second real gated tool exists.

## Affected Files

| File | Change |
|------|--------|
| `src-tauri/src/acp_harness_config.rs` | Add `triage_equipped: bool` (serde default `false`) to `HarnessDirective`; `normalize`/`validate` pass-through. |
| `src-tauri/src/hook_server.rs` | `directive_apply` upsert accepts/persists the field; `directive_list` + the assign round-trip surface it so the frontend approval card can show the grant. Tool descriptor `inputSchema` for `directive_apply` documents the field. |
| `src/acp/types.ts` | Add `triageEquipped: boolean` to the TS `HarnessDirective` type; add `triageSource` modelling to `HarnessLane` (see Design). |
| `src/acp/acp-harness-view.ts` | Source-aware effective triage state; awaited pre-spawn Rust mirror in `addLaneFromDirective`; recompute on assign/clear/override; reload + close handling; rail chip / picker rows show which roles grant flagging; approval card surfaces the grant. |
| `docs/adr/0001-attention-triage-self-reported-router.md` | Append a consequence: per-lane opt-in may now be sourced from a directive grant (spawn-time), not only a manual toggle; trust model unchanged. |
| `docs/128-attention-triage.md` | Cross-reference: equip can be directive-sourced; the "effective at/before first turn" caveat is now *satisfiable* via a spawn-time directive grant. |
| `CONTEXT.md` | Add vocabulary: *triage grant* (directive-sourced) vs *manual equip* (runtime override). |
| `docs/PROGRESS.md`, `docs/06-configuration.md` | Note the new directive field (and that it is the only triage setting that lives on disk — equip itself remains per-lane runtime). |

## Design

### Data model

`HarnessDirective` (Rust + TS) gains one field:

```rust
/// spec 129: spawn-time grant — a lane born with this directive is
/// triage-equipped (may call attention_flag) from its first tools/list.
/// This is a DEFAULT grant, not live reconfiguration (see spec 129 caveats).
pub triage_equipped: bool,   // serde default false
```

Naming (Codex finding 7): the on-disk field is `triage_equipped` but is **defined as a spawn-time default grant**, not a live switch — the doc comment and `06-configuration.md` say so explicitly, so readers don't expect mid-session reconfiguration.

### Source-aware effective state (Codex finding 2)

A lane's effective equip must not be a blind boolean that the directive and the manual toggle fight over. We track the **source**:

```ts
// HarnessLane
triageEquipped: boolean;            // effective state (unchanged; still mirrored to Rust)
triageOverride: boolean | null;     // spec 129: manual Cmd+P ' override. null = follow directive.
```

Effective equip is computed, never set directly:

```
effective = triageOverride ?? (effectiveDirective(lane)?.triageEquipped ?? false)
```

- **`triageOverride === null`** → follow the directive grant (the default for a lane born from a directive, or a lane with no directive → off).
- **Manual `Cmd+P '`** → sets `triageOverride = !effective` (an explicit human decision; lane-local, wins until lane close or the next directive assignment).
- **Assigning or clearing a directive resets `triageOverride = null`** — re-derives from the new directive — *unless* the user explicitly toggles again afterward. This is the only coherent rule: a manual decision is scoped to the directive context it was made in.

Display source so the UX is legible (rail chip / picker / status):

```
triage: directive   // override null, directive grants
triage: manual       // override set (on or off — show which)
triage: off          // override null, no grant
```

### Pre-spawn mirror ordering (Codex finding 3 — the load-bearing correctness point)

`addLaneFromDirective()` (`acp-harness-view.ts:3508`) currently ends with `await this.spawnLane(lane)`, and the existing equip mirror (`:2307`) is **fire-and-forget** (`void invoke(...).catch(...)`). If the directive-driven equip reused that helper as-is, the Rust `acp_set_lane_triage_equipped` write could race the ACP client's first `tools/list` and lose — the tool would be missing exactly in the case this feature exists to serve.

The spec **requires** a synchronous ordering point in the spawn path:

```ts
private async addLaneFromDirective(directive: HarnessDirective): Promise<void> {
  // ... createLane, set activeDirectiveId ...
  const equip = directive.triageEquipped;          // compute BEFORE spawn
  if (equip) this.triageStore.equip(lane.id);
  lane.triageEquipped = equip;
  lane.triageOverride = null;
  await this.mirrorTriageEquip(lane, equip);        // AWAITED — must complete before the client starts
  await this.spawnLane(lane);                        // only now does the ACP session / tools/list begin
}
```

`mirrorTriageEquip(lane, equipped): Promise<void>` is the awaitable extraction of the existing invoke. The **manual** mid-session toggle path keeps using a fire-and-forget call (the lane is already running; its tools/list is already cached, so there is nothing to race) — only the spawn path must await.

### Configuration (on disk)

`~/.config/krypton/acp-harness.toml`, per directive:

```toml
[[directives]]
id = "implementer"
title = "Implementer"
task = "implementation"
system_prompt = "..."
enabled = true
triage_equipped = true   # spec 129: lanes born with this directive can flag judgement items
```

This is the **only** triage setting that lives on disk. Equip itself remains per-lane runtime (spec 128) — there is still no global `krypton.toml` enable, and `triage_equipped` is a *directive* property, not a harness-wide switch.

### Approval / visibility (Codex finding 6)

`directive_apply { action: "upsert" }` is approval-gated. The approval card today diffs `system_prompt`; it must now **prominently show** when a directive grants `triage_equipped` — a capability grant (who may call the human's attention) must never be buried in TOML metadata. Likewise `directive_list`, the directive picker rows, and the lane rail chip must indicate which roles can flag, so the user can see at a glance which lanes are allowed to raise judgement items.

### Assign is a capability escalation gate (post-review fix)

A gap surfaced in testing: `directive_apply { action: "assign" }` **auto-approves same-lane** assignments (spec 124). Once a `triage_equipped` directive exists (its creation was approved), a lane could assign that directive *to itself* and silently self-equip — bypassing the per-lane opt-in that ADR-0001 makes user-chosen. Approving the directive's *existence* is not the same as approving a *given lane* gaining the flag capability.

Fix: an assignment that would **newly equip** the target lane requires explicit user approval, even same-lane. The escalation is `triage_equipped && enabled && scope === 'lane' && !targetLane.triageEquipped`. The prompt is skipped when nothing new is granted — the lane is already equipped, the grant is cleared/non-triage, or the scope is `next_turn` (a one-shot override never drives equip). The approval banner names the grant explicitly (`… wants to self-equip attention-triage via directive …`). The `directive_apply` tool description tells agents this assign path is approval-gated. The manual `Leader '` toggle needs no card — it *is* the human acting directly.

## Edge Cases

- **Mid-session reassign (Codex finding 4).** `assignDirectiveToLane()` defers lane-scope changes while busy (`pendingDirectiveChange`) and `next_turn` is one-shot prompt state — neither implies a fresh MCP tool list. **Guarantee:** directive triage is reliable only for lanes *spawned* with the directive before session start. Existing-lane assignment updates `triageEquipped` (call-time auth + UI) but tool *advertisement* depends on client refresh behavior and must not be relied upon. A real fix (MCP `tools/list_changed` notification / client refresh / reconnect) is a separate protocol feature, out of scope here.
- **Disabled / deleted directive on reload (Codex finding 5).** `directiveCompatible()` already rejects assigning a disabled directive, and `effectiveDirective()` looks up by id without filtering `enabled`. `loadDirectives()` drops bindings to *deleted* directives but not *disabled* ones. Spec rule: on reload, if a lane's active directive is deleted **or** disabled, its directive-derived triage is removed (recompute effective → off unless a manual override is set). A manual override (`triageOverride !== null`) survives because it represents an explicit human decision, not the directive.
- **Lane with a manual override, then directive reassigned** → override resets to null, re-derives from the new directive (per Source model).
- **Lane closed** → existing `onLaneClosed` path drops queue/stats and tells Rust it is no longer equipped (unchanged).
- **Directive grants triage but the lane's backend can't reach the bus** → no change from spec 128; the tool simply never gets called.
- **`directive_apply` upsert flips `triage_equipped` on an existing directive** → affects only lanes spawned afterward; already-running lanes follow the mid-session caveat above.
- **A lane assigns a triage directive to itself** → treated as a capability escalation; requires user approval even same-lane (see "Assign is a capability escalation gate"). Approving the directive's existence does not pre-approve every lane self-equipping from it.
- **Re-assigning the same triage directive to an already-equipped lane** → no new capability, no approval prompt (idempotent).

## Open Questions

None blocking. One deferred-by-design: the general `capabilities` / `tool_grants` shape (Scope decision) is named but not built until a second gated tool exists.

## Out of Scope

- A general per-directive tool-grant list (deferred until ≥2 gated tools).
- Live `tools/list` refresh / MCP `tools/list_changed` notification so mid-session grants take effect without respawn (separate protocol feature).
- A global `krypton.toml` triage enable (still rejected — spec 128).
- Any change to the three existing gates or to the `attention_flag` round-trip itself.

## Resources

- `docs/128-attention-triage.md` — the feature this grants access to.
- `docs/124-acp-harness-directive-management.md` — the directive model and `directive_apply` round-trip reused here.
- `docs/adr/0001-attention-triage-self-reported-router.md` — the per-lane opt-in trust model this preserves.
- `CONTEXT.md` — vocabulary (triage grant vs manual equip).
- Codex-1 adversarial review (this session) — 7 findings, all adopted.
