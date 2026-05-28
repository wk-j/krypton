# Lane Rail Disambiguation — Implementation Spec

> Status: Implemented
> Date: 2026-05-28
> Milestone: M8 — Polish

## Problem

Every lane in the ACP Harness rail currently renders the same shape: a status dot, the lane display name, and a single-line meta row that shows the directive's `icon` (a user-defined glyph) plus its `title`. In practice this collapses into visual noise because (a) most users either leave `icon` empty (Krypton's `fallback_icon()` derives a single up-cased character from `task`/`backend`/`id`, which trends to the same letters across same-backend lanes) or set the same decorative glyph everywhere, and (b) the directive `title` repeats the model name as a prefix ("Claude Issue Analysis", "Codex Review Changed Code") so the eye lands on the same word for every Claude or Codex lane. The user reports having to read every directive title in full to tell lanes apart at a glance — the rail is supposed to be a glanceable list, not a reading exercise.

## Solution

Layer three independent signals into the rail entry, driven by data the schema already carries, so the rail becomes scannable in three passes (model → role → identity) instead of one pass on the title:

1. **Backend logo** — an inline SVG monogram per backend (`claude`/`codex`/`gemini`/`opencode`/`pi-acp`/`droid`/`cursor`/`junie`/`omp`), tinted in a stable brand hue, placed between the status dot and the lane name. Tells the user at a glance which adapter the lane runs on.
2. **Role tag chip** — a small lowercase chrome chip on the meta line whose label and color come from `directive.task` (already a free-form `String` in the schema at `acp_harness_config.rs:55-56`, mirrored to `config.ts:195-196`). A keyword matcher normalizes the free-form value into a stable role slug (`analysis`/`review`/`impl`/`plan`/`explore`); unmatched or empty values hash into one of three fallback color buckets so any custom directive still gets a stable, distinct chip.
3. **Trimmed directive title** — strip a leading backend-label prefix from the title when rendering in the rail (e.g. "Claude Issue Analysis" → "Issue Analysis"), because the lane name and the logo already say "Claude". The original title is preserved in the directive picker and in `peer_list` output; only the rail render is trimmed.

The status dot keeps its existing semantic (idle / active / awaiting / busy) and is not repurposed. No schema, MCP surface, or Rust code changes are required — all signals are derived from data already in `HarnessLane.backendId` and `HarnessDirective.task`.

Prototype: [`docs/prototypes/125-lane-rail-disambiguation.html`](prototypes/125-lane-rail-disambiguation.html) — compares the current rail against three variants (role glyph+color, role tag prefix, role tag + backend logo). Variant C is the design landed by this spec.

## Research

- `renderRailEntry()` at `src/acp/acp-harness-view.ts:4477-4551` produces the rail entry today. The meta row (`acp-harness__rail-meta`) prints `metaDirective.icon || '◇'` followed by `metaDirective.title.trim() || metaDirective.id` and an optional pending hint. `directive.task` is not consulted anywhere in the rail render — it only flows out through MCP via `LaneSummary.activeDirective.task` at `src/acp/types.ts:264`.
- `HarnessDirective` carries `icon`, `title`, and `task` already (`src/config.ts:188-199`). `task` is documented as "Free-form task key (implementation/review/research/...)" and is exactly the field needed for the role tag.
- `BACKEND_LABELS` at `src/acp/acp-harness-view.ts:502-512` enumerates all nine built-in backends — same set as `BUILTIN_BACKEND_IDS` at `src-tauri/src/acp_harness_config.rs:23-25`. A 1:1 backend → SVG `<symbol>` table can be built against this list with no new config.
- The project ships no SVG asset for backends (`src-tauri/icons/` only contains the Krypton app icon). The prototype uses small geometric monograms drawn inline; these are placeholders that hint at each brand without copying the real marks. Production can swap in vetted brand assets later under `src/assets/backends/*.svg` without touching the lookup function.
- Status symbol rendering (`statusSymbol()` / `.acp-harness__rail-dot`) already encodes idle/active/busy, so the new logo cell carries no state and need not animate.
- `directive.icon` is user-editable and shows in the directive picker. The rail render currently exposes it; this spec removes it from the rail (the picker still shows it) because the new logo + role tag together carry more information per pixel and the user-icon was redundant in practice.
- The harness rail-entry tooltip (`entry.title` at `acp-harness-view.ts:4515`) still includes the canonical `directive.id` and pending hints; no a11y or hover info is lost when the title text is trimmed for display.

## Prior Art

| Surface | Implementation | Notes |
|---------|----------------|-------|
| VS Code Activity Bar | Each extension contributes a monochrome SVG icon, theme-tinted, with a label tooltip. | Logo carries identity, label carries name. Same split this spec uses. |
| Zed Agent Panel | Profile rows show a colored dot per profile plus the profile name. | Single-channel; less information density than what we need here. |
| Slack workspace switcher | 1-letter monogram in a colored tile per workspace. | Confirms that a compact brand mark plus a name is recognizable at small sizes. |
| Krypton existing chrome | `BACKEND_LABELS` (`acp-harness-view.ts:502`) and `laneAccent()` already carry per-backend display semantics. | The new SVG table parallels `BACKEND_LABELS` 1:1. |

**Krypton delta** — All nine backend marks live as inline `<symbol>` defs in the harness view so there are no extra image fetches and the rail can recolor via `currentColor`. Role tags are derived from existing data (`directive.task`) so the picker, MCP surface, and config file stay unchanged.

## Affected Files

| File | Change |
|------|--------|
| `src/acp/acp-harness-view.ts` | Add `directiveRole(task)`, `backendLogoId(backendId)`, and `hashBucket(s)` helpers. Inject the nine backend `<symbol>` defs once on view mount. Modify `renderRailEntry()` (currently at `:4477-4551`) so the entry's HTML is `dot · logo · head · meta` and the meta line is `tag · trimmed-title · pending-hint`. Add a `trimBackendPrefix(title, backendId)` helper that strips a single leading `<BACKEND_LABELS[backendId]> ` token from the directive title for display only (mutation does not propagate back to storage). |
| `src/styles/acp-harness.css` | Add `.acp-harness__rail-logo` (14px box, `currentColor`) and `.acp-harness__rail-logo--<backendId>` tint classes for the nine backends. Add `.acp-harness__rail-tag` chip and `.acp-harness__rail-tag--<role>` palette classes for `analysis` / `review` / `impl` / `plan` / `explore` / `hash-1` / `hash-2` / `hash-3`. Adjust the `acp-harness__rail-entry` grid template to accommodate the new logo cell. |
| `docs/72-acp-harness-view.md` | Update the rail-entry anatomy section to document logo + tag + trimmed title. |
| `docs/124-acp-harness-directive-management.md` | Add a short note that `directive.task` now also drives the rail role tag; the picker still shows the full `title` and user-defined `icon`. |
| `docs/PROGRESS.md` | Record after landing. |

No Rust, no schema, no MCP surface changes. `acp_harness_config.rs`, `commands.rs`, `hook_server.rs`, `types.ts`, and `config.ts` are untouched.

## Design

### Helpers (frontend-only)

```ts
type DirectiveRole =
  | 'analysis' | 'review' | 'impl' | 'plan' | 'explore'
  | 'hash-1' | 'hash-2' | 'hash-3';

// djb2-style hash → 3 buckets. Stable across renders.
function hashBucket(s: string): 'hash-1' | 'hash-2' | 'hash-3' {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  const i = Math.abs(h) % 3;
  return (i === 0 ? 'hash-1' : i === 1 ? 'hash-2' : 'hash-3');
}

// Patterns are checked in declaration order. Order matters when keywords overlap
// (e.g. "review-implementation" → review, not impl). `research` and `investigate`
// land in `explore` because they imply mapping the unknown rather than diagnosing
// a specific symptom (`analysis`).
function directiveRole(task: string): DirectiveRole {
  const t = task.trim().toLowerCase();
  if (!t) return hashBucket('');                  // empty task → still stable
  if (/\banaly|\bdiagnos/.test(t))            return 'analysis';
  if (/\breview/.test(t))                     return 'review';
  if (/\bimplement|\bimpl|\bfix/.test(t))     return 'impl';
  if (/\bplan|\bdesign|\bspec/.test(t))       return 'plan';
  if (/\bexplor|\bsurvey|\bmap|\bresearch|\binvestigat/.test(t)) return 'explore';
  return hashBucket(t);
}

// Display label for the chip. Matched roles use the canonical slug; an
// unmatched but non-empty `task` shows the raw value (lowercased + trimmed,
// CSS-truncated for safety); an empty `task` shows the literal `custom`.
// Keep separate from `directiveRole()` so the color bucket and the label can
// diverge — a `task = "refactor"` hashes to a stable color but the chip still
// reads "refactor", not the bucket id.
function directiveTagLabel(task: string): string {
  const t = task.trim().toLowerCase();
  if (!t) return 'custom';
  const matched =
    /\banaly|\bdiagnos/.test(t)            ? 'analysis' :
    /\breview/.test(t)                     ? 'review'   :
    /\bimplement|\bimpl|\bfix/.test(t)     ? 'impl'     :
    /\bplan|\bdesign|\bspec/.test(t)       ? 'plan'     :
    /\bexplor|\bsurvey|\bmap|\bresearch|\binvestigat/.test(t) ? 'explore' :
    null;
  return matched ?? t;   // raw task for unmatched; CSS ellipsizes if too long
}

function backendLogoId(backendId: string): string {
  switch (backendId) {
    case 'claude':   return 'krypton-logo-claude';
    case 'codex':    return 'krypton-logo-codex';
    case 'gemini':   return 'krypton-logo-gemini';
    case 'opencode': return 'krypton-logo-opencode';
    case 'pi-acp':   return 'krypton-logo-pi';
    case 'droid':    return 'krypton-logo-droid';
    case 'cursor':   return 'krypton-logo-cursor';
    case 'junie':    return 'krypton-logo-junie';
    case 'omp':      return 'krypton-logo-omp';
    default:         return 'krypton-logo-omp';   // safe neutral mark
  }
}

function trimBackendPrefix(title: string, backendId: string): string {
  const label = BACKEND_LABELS[backendId];
  if (!label) return title;
  const prefix = label + ' ';
  return title.startsWith(prefix) ? title.slice(prefix.length) : title;
}
```

`directiveRole()` is case-insensitive, accepts a free-form string, and never throws. Patterns are intentionally broad — `\bfix` catches "bug-fix"; `\bimpl` catches "impl" and "implementation"; `\bspec` and `\bdesign` both route into `plan`; `\bresearch` and `\binvestigat` route into `explore`. The hash bucket fallback ensures any custom value (e.g. `"refactor"`, `"observability"`, `"chore"`) still gets a stable color across reloads, so two lanes with the same custom task look identical and two lanes with different custom tasks look different. The label and the color are decoupled: `directiveTagLabel()` returns the canonical slug for matched roles and the raw lowercased `task` otherwise, while `directiveRole()` returns the color bucket. CSS clamps the chip to a reasonable width (see below) so a pathologically long hand-edited `task` cannot break the rail layout.

`backendLogoId()` returns the OMP mark for unknown backends. This is deliberately a neutral concentric-rings shape; nothing in the codebase routes user input directly into `backendId`, so the unknown branch is only hit for forward-compat (a new backend added to `BUILTIN_BACKEND_IDS` before this lookup is updated). A console warn in dev builds keeps the gap visible.

`trimBackendPrefix()` only strips an exact `"<Label> "` prefix. It does not lowercase, regex-match, or otherwise normalize, so a directive titled "Claude · Issue Analysis" or "claudette" is left untouched. Per the project rule about not mutating user-typed strings, the trim is presentation-only — `directive.title` in storage and in `peer_list`/picker output is unchanged.

### Backend logo `<symbol>` defs

A single hidden `<svg>` block is inserted once during view mount (alongside the existing harness DOM) with all nine `<symbol>` elements. Each symbol's geometry uses `currentColor` for strokes and fills so per-backend tint can be applied via a CSS class (`.acp-harness__rail-logo--claude { color: var(--krypton-backend-claude); }` etc.) and so that themes can override the palette without touching geometry. Geometry is copied verbatim from the prototype's nine `<symbol>` blocks — keep them in sync if either side is iterated.

```ts
// In AcpHarnessView.mount() (or equivalent one-time setup):
const defs = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
defs.setAttribute('width', '0'); defs.setAttribute('height', '0');
defs.setAttribute('aria-hidden', 'true');
defs.style.position = 'absolute';
defs.innerHTML = `<defs>${BACKEND_LOGO_SVG_DEFS}</defs>`;
this.rootEl.prepend(defs);
```

`BACKEND_LOGO_SVG_DEFS` is a module-level string constant holding the nine `<symbol>` elements with ids prefixed `krypton-logo-*` to avoid collisions with any other inline SVG in the document.

### Rail entry HTML

Before:

```html
<span class="acp-harness__rail-dot"></span>
<span class="acp-harness__rail-head">
  <span class="acp-harness__rail-name">Claude-2</span>
  <!-- peer/tool/ctx metrics -->
</span>
<span class="acp-harness__rail-meta">
  <span class="acp-harness__rail-meta__icon">◇</span>
  <span class="acp-harness__rail-meta__title">Claude Issue Analysis</span>
</span>
```

After:

```html
<span class="acp-harness__rail-dot"></span>
<span class="acp-harness__rail-logo acp-harness__rail-logo--claude">
  <svg><use href="#krypton-logo-claude"/></svg>
</span>
<span class="acp-harness__rail-head">
  <span class="acp-harness__rail-name">Claude-2</span>
  <!-- peer/tool/ctx metrics unchanged -->
</span>
<span class="acp-harness__rail-meta">
  <span class="acp-harness__rail-tag acp-harness__rail-tag--analysis">analysis</span>
  <span class="acp-harness__rail-meta__title">Issue Analysis</span>
  <!-- pending hint unchanged; pending-clear adds --clearing modifier to the tag -->
</span>
```

For a lane with no bound directive, the meta line keeps the existing status-label fallback (`statusLabel(lane.status)`) — no tag rendered. The logo cell is always present.

### Pending-change visual treatment

The current rail expresses pending directive changes through `metaDirective` selection + an `acp-harness__rail-meta__icon--clearing` strike-through class on the icon (`src/acp/acp-harness-view.ts:4527-4537`, CSS `src/styles/acp-harness.css:2252-2255`). Removing the icon from the rail removes the surface that class was attached to; the new render must carry the same affordance somewhere else, otherwise pending-clear becomes invisible until the next prompt.

The replacement uses the tag chip as the carrier:

- **Pending swap** (lane bound to A, swap to B queued): `metaDirective` becomes B (same as today). The tag and trimmed title reflect B; the existing `acp-harness__rail-meta__hint` span shows "· next send".
- **Pending clear** (lane bound to A, clear queued): `metaDirective` stays A (same as today). The tag and title still reflect A, but the tag gains a `.acp-harness__rail-tag--clearing` modifier rendering as `text-decoration: line-through; opacity: 0.55; border-style: dashed;` and the existing hint span shows "· clear next send".
- **No pending change**: no `--clearing` modifier, no hint.

The semantic mapping from `lane.pendingDirectiveChange` to the visual states is unchanged from `acp-harness-view.ts:4483-4492`; only the class attachment point moves from the icon span to the tag span. The `acp-harness__rail-meta__icon--clearing` rule can be retired once no other surface uses it (verify via grep before delete).

### Grid layout

`.acp-harness__rail-entry` currently uses a single grid column for content. Switch to `grid-template-columns: 8px 14px 1fr` (`dot · logo · body`) on the entry, and let `head` and `meta` stack inside the third cell as today. The logo cell is fixed width so lane names align across all rows regardless of backend mark complexity.

### Palette

Add to `:root` in `src/styles/acp-harness.css` (or the existing harness palette block):

```css
--krypton-role-analysis: #6fb8d9;
--krypton-role-review:   #d9c66f;
--krypton-role-impl:     #6fd994;
--krypton-role-plan:     #b86fd9;
--krypton-role-explore:  #d9886f;
--krypton-role-hash-1:   #d96fb3;
--krypton-role-hash-2:   #6f8fd9;
--krypton-role-hash-3:   #d9a86f;

--krypton-backend-claude:   #d97757;
--krypton-backend-codex:    #d7e7f0;
--krypton-backend-gemini:   #6f8fd9;
--krypton-backend-opencode: #c186d9;
--krypton-backend-pi:       #6fd9c0;
--krypton-backend-droid:    #d9a86f;
--krypton-backend-cursor:   #c0c0c0;
--krypton-backend-junie:    #d96fb3;
--krypton-backend-omp:      #d9c66f;
```

Hues are picked to be distinguishable on the Krypton Dark background and to roughly evoke each brand without copying its exact colors. Custom themes can override these by redeclaring the variables in their own `[data-theme="…"]` block.

## Edge Cases

- **No directive bound.** Lane renders dot + logo + name + status-label meta. No tag.
- **Directive bound, `task` empty.** Tag shows literal `custom`. Color bucket is `hashBucket('')` (deterministic, same bucket for every empty-task lane). Title is trimmed as usual.
- **Directive bound, `task` matches multiple keywords.** Patterns checked in declaration order: `analysis` → `review` → `impl` → `plan` → `explore` → hash. A directive with task `"review-implementation"` resolves to `review` because that pattern matches first. Acceptable given the free-form intent of the field; users wanting a specific bucket should pick a canonical task keyword.
- **Directive bound, `task` unmatched but non-empty.** (e.g. `"refactor"`, `"observability"`, `"chore"`.) Tag shows the raw lowercased `task`; color uses `hashBucket(task)` so two lanes with the same custom task look identical, two lanes with different ones look different. CSS clamps the chip to `max-width: 10ch` with `overflow: hidden; text-overflow: ellipsis;` so a pathologically long hand-edited value cannot break layout.
- **Backend id not in `BACKEND_LABELS`.** `backendLogoId()` returns the OMP mark and `trimBackendPrefix()` no-ops. Dev builds log a warning so we notice when adding a new backend.
- **Directive title is exactly the backend label.** `trimBackendPrefix("Claude", "claude")` requires the trailing space and so does **not** strip; render shows the title as-is ("Claude"). Falling back to `directive.id` happens only when title is empty. (Earlier draft incorrectly claimed this would strip — corrected in this revision.)
- **Pending directive change.** See *Pending-change visual treatment* above. The new tag carries the `--clearing` class for pending clears; the existing hint span still carries the "next send" / "clear next send" text. `acp-harness-view.ts:4483-4492` logic for selecting `metaDirective` is unchanged.
- **Turn-scoped directive override (`turnDirectiveOverride`).** The new tag mirrors `peer_list` semantics: it reflects `activeDirectiveId` only, not one-shot next-turn overrides. `effectiveDirective()` still consults the override for prompt injection (`acp-harness-view.ts:2209-2214`); the rail intentionally does not preview overrides because they vanish after one prompt and would otherwise create a flash-of-incorrect-tag. Document this so no one expects override previews from the new chip.
- **Theme contrast.** Tag chips use `border: 1px solid currentColor` with `background: rgba(0,0,0,0.2)`; on light themes the background can be flipped via `[data-theme="light"]` overrides. Out of scope for v1 (Krypton ships dark-only at the moment).

## Test Plan

### Unit (`cargo test` is irrelevant — these are TS helpers; place under `src/acp/__tests__/` or wherever existing harness unit tests live)

- [ ] `directiveRole()` — table-driven cases: `""` → some `hash-*` (stable); `"analysis"` → `analysis`; `"diagnose-flow"` → `analysis`; `"review"` → `review`; `"review-implementation"` → `review` (declaration order); `"implementation"` → `impl`; `"bug-fix"` → `impl`; `"plan"` / `"design"` / `"spec"` → `plan`; `"explore"` / `"survey"` / `"map"` / `"research"` / `"investigate"` → `explore`; `"refactor"` → some `hash-*` (stable across calls).
- [ ] `directiveTagLabel()` — same inputs as above with expected labels: empty → `"custom"`; matched → canonical slug; unmatched non-empty (`"refactor"`) → `"refactor"`; long unmatched (`"super-long-custom-task-name"`) → returned as-is (CSS truncates, not JS).
- [ ] `trimBackendPrefix()` — `("Claude Issue Analysis", "claude")` → `"Issue Analysis"`; `("Claude", "claude")` → `"Claude"` (no strip without trailing space); `("ClaudeFoo", "claude")` → `"ClaudeFoo"`; `("Issue Analysis", "claude")` → `"Issue Analysis"`; unknown backend `("Whatever", "made-up")` → `"Whatever"`.
- [ ] `hashBucket()` — determinism: same input returns same bucket across two calls; distribution sanity over a fixed corpus of 30 sample task strings.

### Manual / visual

- [ ] Open the prototype side-by-side with `npx tauri dev` and confirm the production rail matches Variant C for the seven backends with directives in `~/.config/krypton/acp-harness.toml`.
- [ ] Spawn three Claude lanes with different directives (`analysis`, `implementation`, `plan`) and visually confirm all three are recognizable in under one second of scanning.
- [ ] Create a directive with `task = "refactor"` and confirm it gets a stable hash-bucket color across app restarts; chip label reads `refactor`, not `custom`.
- [ ] Create a directive with empty `task` and confirm chip reads `custom`.
- [ ] Create a directive with `task` longer than 10 characters (`"observability-and-tracing"`) and confirm the chip truncates with ellipsis rather than pushing the title off the row.
- [ ] Clear the bound directive on a lane and confirm the meta line falls back to the status label and no tag is shown.
- [ ] Swap one bound directive for another via the picker and confirm: target tag/title shown, hint reads "· next send", no `--clearing` class anywhere.
- [ ] Issue a pending clear and confirm: current tag/title shown with `text-decoration: line-through` + dashed border + dimmed opacity, hint reads "· clear next send".
- [ ] Add a lane on every supported backend (`claude`/`codex`/`gemini`/`opencode`/`pi-acp`/`droid`/`cursor`/`junie`/`omp`) and confirm each renders a recognizable logo in its brand tint.
- [ ] Resize the harness rail down to its minimum width and confirm the logo column does not collapse and the title ellipsizes from the right.
- [ ] Verify `peer_list` output still returns the unmodified `activeDirective.title` (not the rail-trimmed version) and the unmodified `activeDirective.task` (not the normalized label).
- [ ] Issue a `turnDirectiveOverride` via MCP and confirm the rail tag does **not** update to reflect the override (intentional, per Edge Cases).

## Out of Scope

- Bringing in real, licensed brand assets for the nine backends. v1 uses the placeholder inline SVG monograms from the prototype.
- Animation on logo or tag (hover, swap, status change). The rail must stay glanceable; animation defeats that.
- Light theme support — Krypton ships dark-only today; light theme can layer overrides on the new CSS variables later.
- Re-exposing `directive.icon` on the rail. The picker continues to show it. Users who want a personal mark in the rail can revisit later if there is demand.
- Surfacing role/backend signals in any other view (transcript, composer chip, mention picker). Restricted to the lane rail in v1.

## Open Questions

- **Inline SVG monograms vs licensed assets.** The placeholders are intentionally distinct from each brand's official mark; if any look misleading we should swap them out before shipping. Decision deferred until visual review.
- **Picker congruence.** The directive picker (`acp-harness-view.ts:4273-4275`) still shows `directive.icon` + `directive.title` in full. Should the picker mirror the rail's role-tag + trimmed title for consistency? Out of scope for v1; revisit if user feedback says the picker is now the odd one out.

## Revision History

- **2026-05-28** — Initial spec.
- **2026-05-28 (r1)** — Folded Codex-1 review (env-1779951863978):
  - `directiveRole()` now recognizes `research` / `investigate` (route to `explore`).
  - Split `directiveTagLabel()` from `directiveRole()` so unmatched non-empty `task` displays the raw value while still picking a stable hash color; empty `task` shows literal `custom`.
  - Pending-clear now uses an `acp-harness__rail-tag--clearing` modifier (line-through + dashed border + dimmed) instead of the retired clearing-icon class.
  - Corrected the "title equals backend label" edge case (no strip without trailing space).
  - Added explicit edge case noting `turnDirectiveOverride` is intentionally not previewed in the rail.
  - Test plan: added unit-test section for `directiveRole`, `directiveTagLabel`, `trimBackendPrefix`, `hashBucket`.
- **2026-05-28 (r2, landed)** — Claude-3 implementation (env-1779952889898):
  - Status flipped Proposed → Implemented.
  - **BEM mapping for `pi-acp`.** The CSS tint class for `backendId: "pi-acp"` is `.acp-harness__rail-logo--pi`, not `--pi-acp`, because the double-dash inside the modifier would re-trigger BEM's modifier delimiter. `renderRailEntry()` maps `pi-acp → "pi"` inline before composing the class. `backendLogoId()` still returns `krypton-logo-pi` (unchanged from r1). Other eight backends keep `--<backendId>` verbatim.
  - **`backendLogoId()` warn dropped.** Implementation kept `backendLogoId()` as a pure helper (no side effects) and skipped the dev-only `console.warn` originally mentioned in the spec. The unknown-backend branch is exercised by unit tests; a forward-compat surface that has never fired in practice does not warrant a side effect in a pure helper. If we ever add a backend without updating the lookup, the OMP mark + silence is an acceptable fallback. Revisit only if a regression appears.
  - **Retired CSS.** `.acp-harness__rail-meta__icon` and `.acp-harness__rail-meta__icon--clearing` are removed — grep at land time confirmed no other surface referenced them.
  - **Unit tests landed.** 13 cases under `describe('spec 125 lane rail disambiguation')` in `src/acp/acp-harness-view.test.ts`; full suite (164 tests) passes; `npm run check` clean.
  - **Manual visual check pending.** Implementation did not run `npx tauri dev` (no screen access); user owns the visual acceptance pass per the spec's *Test Plan / Manual / visual* checklist.
