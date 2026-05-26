# ACP Built-In Memory Auto-Approval — Implementation Spec

> Status: Implemented
> Date: 2026-05-08
> Milestone: M8 — Polish
> Note: Spec 107 extends this detector into a harness-wide memory/peer taxonomy while preserving the built-in-server-marker safety rule described here for third-party tools.

## Problem

The ACP harness should auto-approve only Krypton's built-in lane memory tools, but in practice those prompts can still require manual approval. Codex-style permission payloads may name tools as `mcp__krypton_harness_memory__memory_set`, or render the request as `MEMORY_SET` plus content text like `Tool: krypton-harness-memory/memory_set`, while the detector only recognized plain tool names and hyphenated server markers.

## Solution

Keep memory auto-approval, but make the detector require both an allowed memory tool name and a built-in memory server marker. The accepted markers are the server name `krypton-harness-memory`, the namespaced identifier fragment `krypton_harness_memory`, or the local endpoint path `/mcp/harness/`. Tool name matching covers structured tool ids, title text, ACP content text, and `permission.options[].name` labels, case-insensitively. The option-label path was added so adapters that emit generic prompts (e.g., Junie/JetBrains, where `toolCall.title` is just `"Allow running MCP?"` and the server/tool identity appears only in option labels such as `Always allow ("krypton-harness-memory:peer_send")`) still auto-approve. Requests from `.mcp.json` bridged servers, third-party MCP servers, or arbitrary tools with the same names continue through the normal permission UI.

## Research

- `src/acp/acp-harness-view.ts` defines the harness auto-allow tool taxonomy and auto-resolves matching permission requests in `addPermission()`.
- The original `harnessMemoryPermissionToolName()` detector had three detection paths. It missed namespaced tool identifiers such as `mcp__krypton_harness_memory__memory_set` because underscores prevent the old word-boundary regex from matching `memory_set`. Spec 107 later renamed the helper to `harnessAutoAllowToolName()` when peer tools joined the same harness policy.
- ACP permission display payloads can expose the usable tool identity in `ToolCall.content[].content.text` instead of structured `rawInput`, for example `Tool: krypton-harness-memory/memory_set`.
- The structured detector also needed to keep the same built-in-server-marker requirement as the raw/title string paths.
- `src-tauri/src/hook_server.rs` exposes the built-in HTTP MCP endpoint at `POST /mcp/harness/:harness_id/lane/:lane_label` and reports server name `krypton-harness-memory`.
- `docs/83-acp-shared-mcp-config.md` explicitly says bridged `.mcp.json` servers must not be auto-allowed; the existing intent is memory-only auto-allow.
- `docs/73-acp-harness-mcp-memory.md` and `docs/75-acp-harness-lane-memory.md` define the built-in memory surface as exactly `memory_set`, `memory_get`, and `memory_list`.

## Prior Art

| App | Implementation | Notes |
|-----|----------------|-------|
| Zed ACP host | Permission handling is adapter/client mediated; MCP servers remain explicit trust boundaries. | Closest conceptual match: server identity matters, not just tool name. |
| Claude/Gemini/Codex ACP adapters | Emit `session/request_permission` for tool calls depending on their own safety model. | Krypton receives the permission request and must decide only local auto-policy. |
| Krypton current harness | Auto-allows built-in memory tools and prompts for non-memory tools. | Desired behavior, with one detector path too broad. |

**Krypton delta** — Keep the current keyboard-first no-prompt flow for built-in memory, but make the allow rule exact enough that same-named third-party tools do not inherit Krypton's trust.

## Affected Files

| File | Change |
|------|--------|
| `src/acp/acp-harness-view.ts` | Tighten the harness auto-allow detector so every accepted path requires a built-in server marker, and support namespaced built-in memory tool names. |
| `src/acp/acp-harness-view.test.ts` | Add focused Vitest coverage for built-in memory auto-approval detection. |
| `docs/72-acp-harness-view.md` | Clarify that harness auto-allow applies only when the permission request identifies Krypton's built-in harness MCP server. |
| `docs/83-acp-shared-mcp-config.md` | Optionally tighten wording that `.mcp.json` tools with memory-like names still prompt. |
| `docs/PROGRESS.md` | Add a Recent Landings note after implementation. |

## Design

### Data Structures

No persisted data changes.

Use the existing constants:

```ts
const HARNESS_MEMORY_TOOL_NAMES = new Set(['memory_set', 'memory_get', 'memory_list']);
```

The detector should effectively require:

```ts
interface MemoryPermissionMatch {
  toolName: 'memory_set' | 'memory_get' | 'memory_list';
  hasBuiltInServerMarker: true;
}
```

### Permission Policy

Auto-approve only when both conditions are true:

1. The permission request contains one of the allowed built-in tool names (memory: `memory_set`, `memory_get`, `memory_list`; peer: `peer_send`, `peer_list`; review: `review_request`, `review_reply`) somewhere in `toolCall.{rawInput,title,content}` or in any `permission.options[].name`.
2. The permission request also contains a built-in server marker (`krypton-harness-memory`, `krypton_harness_memory`, `krypton-harness-bus`, `krypton_harness_bus`, or `/mcp/harness/`) somewhere in `toolCall` or in any option label.

All other requests, including a third-party MCP server that also exposes `memory_set` or `peer_send`, must enter the existing permission flow.

### Data Flow

```
1. ACP adapter sends session/request_permission.
2. AcpClient emits permission_request to AcpHarnessView.
3. addPermission() calls the harness auto-allow detector.
4. Detector scans toolCall.rawInput, toolCall.title, toolCall.content text, and permission.options[].name labels.
5. If allowed harness tool + built-in marker are both present:
   5a. resolveHarnessPermission() sends allow_once/allow_always option.
   5b. Transcript logs a structured permission card with the harness auto-allow reason.
6. Otherwise the permission is queued and rendered in the composer.
```

### Tests

Add Vitest cases for:

- Accept namespaced raw input/title containing `mcp__krypton_harness_memory__memory_set`.
- Accept raw/title strings containing `memory_get` plus `/mcp/harness/`.
- Accept content text containing `Tool: krypton-harness-memory/memory_set` plus uppercase title `MEMORY_SET`.
- Reject `{ name: 'memory_set' }` with no built-in marker.
- Reject non-memory tools even when a marker appears.
- Accept Junie-style payload where `toolCall.title` is generic ("Allow running MCP?") and both the server marker and tool name appear only inside `permission.options[].name`.
- Reject Junie-style option labels that reference a third-party server, even if a known tool name is present.
- Reject Junie-style option labels that reference the built-in server with a non-allowed tool (e.g., `shell_run`).

## Edge Cases

- **Adapter omits server identity entirely:** prompt the user. This is safer than guessing from a tool name.
- **Adapter includes only endpoint URL:** `/mcp/harness/` is enough to auto-allow.
- **Adapter includes only server name:** `krypton-harness-memory` is enough to auto-allow.
- **Malformed or deeply nested raw input:** keep the existing bounded scan depth.
- **No accept option in permission options:** existing behavior remains; do not auto-resolve.

## Open Questions

None.

## Out of Scope

- Auto-allow for any `.mcp.json` or third-party MCP server.
- New user configuration for permission policy.
- Backend-side permission policy enforcement.
- Changes to memory persistence, prompt injection, or memory tool schemas.

## Resources

- `src/acp/acp-harness-view.ts` — current memory permission detector and auto-resolution path.
- `src-tauri/src/hook_server.rs` — built-in memory MCP server name and `/mcp/harness/` route.
- `docs/75-acp-harness-lane-memory.md` — current lane-owned memory tool surface.
- `docs/83-acp-shared-mcp-config.md` — existing rule that bridged servers should prompt normally.
