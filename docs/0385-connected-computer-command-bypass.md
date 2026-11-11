# Connected Computer Command Bypass — Implementation Spec

> Status: Implemented (manual SSH/Tauri smoke pending; see Verification Results)
> Date: 2026-11-11
> Milestone: ACP Harness — connected computers

## Problem

Remote commands outside the read-only classifier still require `approve once`, even when a lane uses `bypass`. A user who trusts a connected computer needs an explicit way to stop those prompts without weakening approval on every other computer.

## Solution

Add an opt-in, persistent `bypass_command_approval` boolean to each Connected Computer profile, default `false`. When enabled, valid lane requests to that computer skip the exact-command approval gate, including commands that modify files or services. The setting applies to every authorized local lane using that profile, across projects. Lane permission modes remain independent.

## Research

- `src-tauri/src/connected_computers.rs::exec` validates the live lane, connection, command, timeout and directory before calling `auto_approved_script`; only a classifier miss enters `await_approval`.
- Both `hook_server.rs` MCP dispatch and `control.rs::computer_exec_for_lane` call this same `exec` method. A Rust-side profile decision covers both without trusting agent-supplied permission metadata.
- `ComputerProfile` is serialized to camelCase for IPC; `StoredProfile` persists snake_case TOML. Existing `auto_approve_read_only` defaults to `true`. Preserve it rather than replace the existing setting or migrate user profiles.
- `ConnectedComputersContentView` already has a keyboard-accessible checkbox editor and revision-checked save. Rust rejects profile edits while connected, connecting, or executing. Keep that restriction, so enabling bypass requires disconnect → edit → save → reconnect.
- `computer-approval.ts` and `addComputerApproval` deliberately isolate remote requests from lane bypass, Telegram turns and role-assigned bypass. Retain that separation for profiles without the new opt-in.
- Alternative: inherit lane bypass. Rejected because roles and Telegram can enable bypass without the user granting authority over a particular SSH account. A session-only grant would expire sooner but require repeating the opt-in after reconnect or restart.

## Prior Art

| App | Implementation | Notes |
|---|---|---|
| Claude Code | Explicit `bypassPermissions` mode; CLI activation via `--dangerously-skip-permissions`; documentation recommends isolated containers or VMs. `Shift+Tab` includes bypass only after it is enabled. | Explicit opt-in, not a claim that commands are safe. Some safeguards remain independent. |
| Krypton today (specs 311/318) | Per-computer read-only auto-approval; every other command asks once. | Reuse the profile editor and central Rust gate. |

**Krypton delta:** authority is attached to a selected computer profile, not the agent session. No new lane shortcut or approval-row blanket grant.

## Affected Files

| File | Change |
|---|---|
| `src-tauri/src/connected_computers.rs` | Profile/storage field, conversions, bypass branch in `exec`, policy/persistence regression coverage. |
| `src/connected-computers-view.ts`, `src/connected-computers-view.test.ts` | Profile type, checkbox, warning, effective policy readout and editor behavior. |
| `src-tauri/src/hook_server.rs`, `src/acp/acp-harness-view.ts` | MCP description and both MCP/CLI lane-context instructions describe the profile opt-in. |
| `src/acp/computer-approval.ts`, `src/acp/harness-permission-scan.ts` | Clarify comments: the queue remains manual when Rust requests approval; the backend may skip it under an explicit profile policy. |
| `docs/0311-connected-computer-commands.md`, `docs/0318-connected-computer-read-only-auto-approval.md`, `docs/0004-architecture.md`, `docs/0005-data-flow.md`, `docs/0006-configuration.md`, `docs/0072-acp-harness-view.md`, `docs/README.md` | Amend the approval contract, configuration and index. Sweep entire affected documents for unconditional approval claims. |

## Design

### Data Structures / Configuration

Add `pub bypass_command_approval: bool` to `ComputerProfile` and `StoredProfile`; missing means `false`. Persist only `true`; retain schema version `1` and the existing read-only field. IPC and the frontend use `bypassCommandApproval`; the frontend accepts omission as `false`.

```toml
[[computers]]
id = "mac-mini"
host = "mac-mini"
bypass_command_approval = true # optional; default false; includes writes and service changes
```

No new API, exec argument, environment variable, MCP permission identity, or CLI flag. An agent cannot enable bypass by adding a field to a command request.

### Data Flow and Precedence

1. Perform all current request validation and obtain the connected profile snapshot.
2. If `bypass_command_approval`, skip classifier and approval queue. Execute the original command bytes through the existing `sh -s` transport; borrow the existing command string rather than cloning it for this branch.
3. Otherwise preserve spec 318: when `auto_approve_read_only` and classification succeeds, execute the re-quoted script. On any miss, await exact-command approval as today.
4. All paths recheck the lane and connection and retain capacity, timeout, cancellation, bounded output and no-retry behavior.

| Bypass | Read-only auto-approval | Result |
|---|---|---|
| On | Either | Any valid command skips the approval row; original command runs. |
| Off | On | Only classifier-approved commands skip the row; re-quoted script runs. |
| Off | Off | Every command requires its own approval. |

### UI and Keybindings

In **Connected Computers…**, add an unchecked checkbox labelled `Bypass remote command approval` after the read-only checkbox. Adjacent text: `All local lanes can run any command on this computer without asking, including file deletion and service changes. This setting is saved across app restarts.`

When checked, disable the read-only checkbox without clearing its value. Read its checked state directly on save, as the existing editor does; do not derive it from disabled form-field submission. Unchecking bypass restores the saved read-only choice.

The detail region shows `Command approval: BYPASS — all commands` when enabled; otherwise `Read-only auto-approval` or `Always ask` according to the existing setting. The list appends plain `BYPASS` text to the existing state readout for enabled profiles. Use existing typography and material styles, with no new frame, glow, animation or modal.

Keyboard route: `Cmd+Shift+P` → **Connected Computers…** → select → `x` if connected → `e` → `Tab` to checkbox → `Space` → `Cmd+Enter` → `Enter` to reconnect. `Esc` discards unsaved edits. No new dedicated shortcut is required.

## Edge Cases / Security

- Existing and new profiles default to bypass off. Other computer IDs are unaffected, even if they resolve to the same physical host.
- The grant is app-wide for the profile: ordinary, role-assigned and Telegram-driven local lanes may all use it. The UI warning must not imply lane-only scope.
- This is not a sandbox. Shell syntax, credential reads, deletion, network activity and service changes run with the SSH account's permissions; the read-only path guard does not apply in bypass.
- Turning bypass off requires disconnecting first; existing disconnect/cancellation semantics apply. Already pending approvals are not automatically accepted by saving or reconnecting. A stale request must still pass the existing lane/connection checks before execution.
- Saved opt-in survives restart, but connections still require explicit Connect. Profile conflicts, invalid files and missing capabilities fail as before.
- No new transcript permission row is fabricated for bypassed calls. The ordinary tool call and result remain visible.

## Verification / Acceptance

- Extend focused Rust coverage: legacy omission defaults off; true persists/reloads; false restores the read-only/manual branches; bypass preserves shell syntax verbatim even when read-only auto-approval is false; a second profile remains manual. Invalid command/cwd/timeout, revoked capability and disconnected host remain rejected.
- Extend focused editor coverage for saving/reopening bypass, cancel, and preserving the read-only choice while disabled. Retain remote-queue coverage proving lane bypass alone never approves a manual-profile request.
- After implementation, exercise the actual editor in a browser harness. With a user-authorized disposable SSH target, exercise MCP and CLI: bypass a harmless non-allowlisted command such as `printf '%s\n' bypass-smoke`, then disable bypass and observe the exact-command prompt. No production mutation is needed.
- Run the focused tests and frontend type check once after integration. Report any unavailable SSH/Tauri verification explicitly; do not label unit coverage as end-to-end proof.

### Verification Results

- `cargo test connected_computers::tests --lib`: 8 passed.
- Frontend: 5 profile-editor tests passed; the existing 355 Harness tests also passed, including the isolated remote-approval queue.
- `npm run check`: passed.
- Browser smoke used the actual `ConnectedComputersContentView` with Tauri IPC mocked in a temporary page: keyboard toggle/save, reopen, preserved read-only choice, disable/restore and cancel passed. Wide and 580px layouts were visually checked; the narrow layout had no horizontal overflow and the disabled input computed opacity was `0.45`. No browser errors were reported.
- The editor regression fixture initially failed because its checkbox was detached from the document in happy-dom. Attaching the view before native clicks fixed the fixture; production browser interactions already passed.
- Not exercised: live SSH through MCP/CLI, the installed Tauri app, and connected-request `cwd` rejection. No disposable SSH target was supplied. Existing `cwd` validation remains before policy selection; unit coverage is not end-to-end SSH proof.
- Temporary browser harness removed after smoke verification. No user computer profile or connection was changed.

## Open Questions

None. The user approved persistent per-computer authority shared by all local lanes on 2026-11-11.

## Out of Scope

Lane-mode inheritance; auto-connect; remote Harness execution changes; new allowlists; per-command remembered approvals; sandboxing; changing transport, limits, retries or the manual approval UI.

## Resources

- [Claude Code — Choose a permission mode](https://code.claude.com/docs/en/permission-modes) — explicit bypass activation, visible mode and isolation guidance.
- [Connected Computer Commands](./0311-connected-computer-commands.md) — existing app-owned gate and profile lifecycle.
- [Connected Computer Read-Only Auto-Approval](./0318-connected-computer-read-only-auto-approval.md) — existing classifier and execution contract.
