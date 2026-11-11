# Remove ACP Harness Directives — Implementation Spec

> Status: Implemented (2026-11-11)
> Date: 2026-11-11
> Milestone: ACP Harness — simplification

## Problem

The user wants the directives feature removed from the app completely. Directives are reusable
system-prompt blocks in `~/.config/krypton/acp-harness.toml`. They are assigned to a lane through
a picker (`Cmd+P` then `.`), shown as a composer chip and a rail tag, and injected into the lane's
leading context. The feature spans the Rust backend, the harness view, seven components, the control
API, `kryptonctl`, and the agent-facing tool descriptions.

## Solution

Delete the feature end to end: storage, Tauri commands, picker, chip, rail tag, `#directive`, the
Shift+Enter spawn-with-directive path, context injection, control-API operations, the `kryptonctl`
verb, and the directive fields in `peer_list`. Also delete code that only existed for directives
and is already dead (the directive diff row and `DiffBlock`'s `raw` mode) or becomes dead (the
directive triage grant). The user's existing `acp-harness.toml` is **left on disk untouched**:
Krypton stops reading and creating it but never deletes a user file.

## Research

A full sweep of `src/`, `src-tauri/src/`, `raycast/`, Telegram and `src/loopback/` was made and
spot-checked by hand:
- **`acp-harness.toml` holds nothing else.** It contains only `version` and `[[directives]]`. Its
  only readers are `get_acp_harness_config` (called from `refreshDirectives`) and
  `get_acp_harness_config_path` (called from `#directive`), so `src-tauri/src/acp_harness_config.rs`
  can go in full. The `krypton.toml` `[acp_harness]` section (`AcpHarnessConfig` in `config.rs` and
  `src/config.ts`) is unrelated and stays.
- **No directive state is persisted.** `activeDirectiveId`, `pendingDirectiveChange`,
  `turnDirectiveOverride` and `previousDirectiveId` live only on the in-memory `HarnessLane`. No
  session store, snapshot or telemetry record carries them, so there is nothing to migrate. Old
  transcript lines such as `directive set: x` remain portable system text and render
  through the neutral `SYSTEM STATUS` fallback.
- **Already-dead directive code.** `DirectiveDiffRow` rendered the spec-124 approval card from
  `item.diff`. Its only producer, the `directive_apply` MCP tool, was removed by spec 161, and
  nothing sets `item.diff` any more. `DiffBlock` itself stays, because `tool-row` and
  `genui-catalog` use its `paired` and `unified` modes. Only its `raw` mode is directive-only.
- **Triage.** Spec 130 made `attention_flag` default-on, and lanes are equipped in `createLane`.
  The spec-129 directive grant (`directiveGrantsTriage`, `triageSource`, `computeTriageEquipped`,
  `refreshTriageEquip`, `lane.triageOverride`) therefore changes nothing today, and it is deleted.
  `lane.triageEquipped` stays.
- **Telegram** has no directive code. The `/directive` command in spec 200 was never built.
  Telegram's generic `/ctl <op>` is gated by `ADVERTISED_OPERATIONS`, so removing the ops there
  covers it.
- **Raycast** (`raycast/src`) has no directive references.
- **Unrelated uses of the word stay**: the mermaid `%%{init}%%` directive
  (`harness-mermaid-fence.ts`), "not a Goal/directive envelope" (`orchestratorDispatchBody`), and
  `scripts/session-matrix.py`, which parses `## Directive:` in historical session logs.

## Prior Art

N/A. This removes an internal feature and has no market equivalent to match.

**Krypton delta** — Persona and role text still reaches a lane through the user's own prompt, the
built-in Polly/Debby/Salty roles, which are unchanged, and each agent's native instruction files
(`CLAUDE.md`, `AGENTS.md`, …).

## Affected Files

| File | Change |
|------|--------|
| `src-tauri/src/acp_harness_config.rs` | **Delete** |
| `src-tauri/src/lib.rs` | Drop `mod acp_harness_config` and the two command registrations |
| `src-tauri/src/commands.rs` | Delete `get_acp_harness_config`, `get_acp_harness_config_path` |
| `src-tauri/src/control.rs` | Drop `lane.directive`, `directive.list` from `ADVERTISED_OPERATIONS` |
| `src-tauri/src/bin/kryptonctl.rs` | Drop the `acp directive` verb and its usage text |
| `src-tauri/src/hook_server.rs` | Drop the `directive_*` stub arm; remove `activeDirective` from the `peer_list` description and the directive clause from `artifact_new`'s |
| `src/acp/components/directive-picker/`, `src/acp/components/directive-diff-row/` | **Delete** |
| `src/acp/components/registry.ts`, `transcript/rows.ts` | Drop both components and the `directiveDiff` row kind |
| `src/acp/components/diff-block/index.ts` | Drop `raw` mode |
| `src/acp/components/composer-meta/{index.ts,.css}` | Drop the directive chip, `onOpenDirective`, and the chip-`extra` machinery only it used |
| `src/acp/components/rail-entry/{index.ts,.css}` | Drop the directive tag/title/pending states; the meta line shows the status hint or the run |
| `src/acp/components/lane-picker/index.ts` | Drop `pendingDirective` (head is always `// add lane`) |
| `src/acp/components/help-overlay/index.ts` | Drop the `#directive` row |
| `src/styles/harness-shared.css` | Drop the `--krypton-role-*` vars (only rail tags read them) |
| `src/acp/acp-harness-view.ts` | Drop the picker, leader `.`, `#directive`, assignment and send-path promotion, `## Directive:` role-block fallback, Shift+Enter spawn path, control ops and `lane.status` field, `peer_list` `activeDirective`, chip and rail props, triage-grant helpers |
| `src/acp/harness-view-types.ts`, `src/acp/types.ts`, `src/config.ts` | Drop the directive fields and types, `item.diff`, `LaneSummary.activeDirective`, `HarnessDirective`, `getAcpHarnessConfig*` |
| `src/acp/harness-lane-identity.ts` | Drop `directiveRole`, `directiveTagLabel`, `hashBucket`, `trimBackendPrefix`, `DirectiveRoleBucket` |
| `src/acp/harness-prompts.ts`, `src/acp/hash-commands.ts`, `src/acp/lane-context.ts` | Drop `directivePrompt` and the `#directive` entry; reword "your directive" in the ticket pin and the role-block comment |
| Tests | Update the suites listed in Edge Cases and drop directive-only tests |
| Docs | See Documentation below |

## Design

### What the user sees afterwards

| Before | After |
|---|---|
| `Cmd+P` then `.` opens the directive picker | Key is unbound; the leader menu has no Directives entry |
| Composer `directive …` chip | Gone; the permission-mode chip and the others remain |
| Rail meta line with a directive tag and title | Status hint or the running command, as for a lane with no directive today |
| `#directive <intent>` | Flashes `unknown command` (`runHashCommand` fallback); nothing is sent to the agent |
| Shift+Enter in the directive picker spawns a lane | Gone; the lane picker head is always `// add lane` |
| `## Directive: <title>` block in the leading context | Never sent; only Polly/Debby/Salty roles produce a role block |

### External surfaces

| Surface | After removal |
|---|---|
| HTTP control API `lane.directive`, `directive.list` | `unsupported_operation`; absent from `capabilities` |
| Control API `lane.status` rows | No `directive` field |
| `kryptonctl acp directive …` | Usage error |
| Telegram `/ctl lane.directive` | "Unsupported controller operation" |
| MCP `peer_list` | No `activeDirective` field |
| A stray cached `directive_*` tool call | `Unknown bus tool` |

### Data Flow

The send path loses one step. Before, it promoted a pending directive change and consumed a one-shot
override before composing context. Now it composes context directly. `renderRoleBlock` returns
`null` unless a Polly/Debby/Salty role is set, and `renderLanePolicy` already omits a null role
block. The policy hash changes only for lanes that had a directive, and none exist after a restart.

### Configuration

`acp-harness.toml` is no longer read or created. The file is not deleted, because it is the user's
data. `docs/0006-configuration.md` drops the "ACP Harness Directives" section and says the file is
unused and can be deleted. No `krypton.toml` key changes.

### Documentation

- **Living docs** have every directive statement removed or reworded: `0002`, `0004`, `0005`,
  `0006`, `0072`, `0154`, `0175`, `0185`, `0200`, `0202`, `0302` (catalog rows), `CONTEXT.md`
  (drop the "Triage grant" and "Manual equip" entries and the directive wording), `docs/README.md`.
  Each is grepped in full after editing.
- **Historical specs** `0124`, `0125`, `0129`, `0161` and `0163` keep their text and get a status
  line: `Removed by spec 389`. ADR 0001 and the `docs/prototypes/*` files stay as history.

### Implementation notes

These follow from the removal but were not listed above:
- `DiffBlock`'s constructor `mode` argument existed only to give `raw` a `<pre>` root, so it was
  removed. Its callers changed: `tool-row` (2), `fs-write-review-row`, `genui-catalog/data.ts`, and
  the test. The mode is still a prop.
- `ComposerMeta`'s chip-`extra`/marker code had one user, the directive chip, so it was removed and
  the chip map holds plain `Chip`s.
- `acp-harness__msg-text` was owned only by `DirectiveDiffRow` and went with it.
- The registry dropped from 88 to 86 components (`DirectivePicker`, `DirectiveDiffRow`).

## Edge Cases

- **Existing `acp-harness.toml`**: ignored, never rewritten or deleted.
- **A lane mid-turn when the new build starts**: impossible, because directive state is in-memory
  only and the app restarts.
- **Agents that learned `activeDirective` from an earlier `peer_list`**: the field is simply
  absent. The description no longer mentions it.
- **`styles-ownership.test.ts`**: CSS removals and `def.blocks` changes ship together so no sheet
  declares an unowned block.
- **Tests that change**: `acp-harness-view.test.ts` (imports and the identity-helper describes),
  `composer-meta` (re-key chip tests onto the permission chip), `rail-entry`, `lane-picker`,
  `diff-block` (raw mode), `system-row` and `system-command-row` (`directiveDiff`),
  `hash-commands.test.ts`, `wire-boundary.test.ts` (backendId count 8 → 7),
  `loopback/surfaces/harness/examples.test.ts` (`KRYPTON_ONLY`), and the `activeDirective: null`
  fixtures in the control-bridge, telemetry and inter-lane tests.

## Open Questions

None.
- Leave the user's file on disk? Yes.
- Delete the already-dead diff row and raw mode? Yes, they exist only for directives.
- Delete the triage grant? Yes, spec 130 already made it a no-op.

## Out of Scope

- The spec-128 Rust `triage_equipped` map and `acp_set_lane_triage_equipped`. They are write-only
  legacy, but not directive code.
- `scripts/session-matrix.py` parsing of `## Directive:` in old session logs.
- Rebinding leader `.` to anything else.
- Deleting `~/.config/krypton/acp-harness.toml`.

## Resources

N/A — purely internal change. The removal map comes from a read-only sweep of the repository,
spot-checked with `grep` for the readers of `acp-harness.toml`, persisted directive fields,
`item.diff` producers, and Telegram references.
