# Telegram Controller has full harness authority

> Status: accepted
> Date: 2026-07-24

## Context

Telegram could be implemented as a notification-only companion, a restricted
prompt relay, or a genuine remote controller. The requested product is the last
option: an authorized user should be able to operate a running Harness session
from Telegram, including lifecycle actions. The same request also establishes
that Telegram-originated turns should never pause for permission confirmation.

## Decision

An authorized Telegram user can perform the full set of operations advertised by
the existing ACP Harness Control API, including sending prompts and controlling
lane and session lifecycle.

Every Telegram-originated prompt carries a turn-scoped bypass policy that
automatically accepts all permission requests, including high-risk operations.
The policy travels with a queued prompt, begins only when that prompt starts a
turn, ends on every terminal turn/lane path, and never changes the lane's
persistent permission mode or affects a prompt from another source.

Telegram does not gain agent-only MCP identity: it cannot impersonate a lane to
call `peer_send`, and the TypeScript Harness view remains the state authority
per ADR-0007.

## Considered Options

- **Notification-only bot.** Rejected because it cannot control the session.
- **Prompt relay with lifecycle controls omitted.** Rejected because the
  requested surface is a full remote controller.
- **Set the target lane's persistent permission mode to bypass.** Rejected
  because local and other-origin turns would inherit authority they were not
  granted.
- **Confirm high-risk operations in Telegram.** Rejected by the explicit
  “always bypass” product decision.

## Consequences

The Telegram authorization boundary protects local command-execution authority,
not merely transcript visibility. A compromised authorized Telegram account or
authorized group can cause destructive local actions through its prompt turns.
The product must therefore fail closed on user/chat identity, keep provenance
auditable, make bypass conspicuous in local settings and bot status, and ensure
the turn-scoped policy cannot leak to another turn.
