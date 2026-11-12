# Junie Backend Removal

> Status: Implemented
> Approval: Full removal approved in conversation before implementation.

## Scope

Remove Junie as an ACP backend throughout Krypton, not merely from the lane
picker. Backend discovery no longer advertises it and backend resolution rejects
it before spawning a process. This applies to local and remote harnesses and
other callers of the shared ACP transport.

## Implementation

- Remove the backend registration, launch flag, startup hints and native MCP
  overlay commands, including their Tauri registrations.
- Remove the overlay lifecycle and lane state from the harness, and remove the
  Junie argument from the shared frontend spawn signature and every caller.
- Restrict remote native overlays to Cline and `cline_mcp_settings.json`.
- On every launch, after logging starts, remove the retired local overlay root
  `~/.config/krypton/runtime/junie/` (`acp::remove_retired_junie_overlays`).
- Remove Junie's label, logo, warning chip and brand styles. Keep the accent
  palette and remaining backend slot assignments stable.
- Retain shared MCP serialization, SSE, protocol-version negotiation and strict
  permission parsing. These are protocol/security behavior, not Junie support.
- Keep the Cline overlay path sanitizer, overlay protocol and Cursor serializer.

## Compatibility and Data

No user configuration, installation, credentials or saved transcripts are
deleted. Old `lane_models.junie` entries remain parseable but have no effect
because the backend no longer exists. Historical feature specs and prototypes
remain as design history; spec 119 is retired.

The local Junie overlay root is the one deletion. Krypton generated it, it is
not user data, and its per-lane `mcp.json` files carry project MCP servers with
`${VAR}` already expanded, so a header or env value may be a live token. Lane
close and the per-harness GC used to remove it; with both gone, an overlay left
by a crash or force-quit would otherwise stay on disk indefinitely. Remote
overlays need no cleanup: the remote runtime writes them under a per-process
temp root that it removes when it exits.

## Regression Coverage

Backend tests assert Junie cannot resolve or appear in discovery while Cline
still resolves. Remote-runtime tests reject both Junie overlay writes/removals
and its former filename, retaining Cline path sanitization coverage. A startup
cleanup test removes the retired Junie root and leaves Cline overlays intact.
Existing MCP permission and serialization regressions remain backend-neutral.

## Resources

N/A — internal removal; the implementation plan was based on repository tracing.