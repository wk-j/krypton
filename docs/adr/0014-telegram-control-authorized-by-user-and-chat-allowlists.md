# Telegram control is authorized by user and chat allowlists

> Status: accepted
> Date: 2026-07-24

## Context

Telegram exposes several tempting but unsafe identity signals: usernames are
mutable, display names are non-unique, group membership can change outside
Krypton, and merely adding the bot to a group says nothing about which members
may exercise local command authority. A group also has two independent security
subjects: the acting person and the destination that will receive sensitive lane
output.

## Decision

Krypton authorizes Telegram control by matching immutable numeric identifiers
against locally managed allowlists before processing any command or callback:

- private chats require an authorized sender user ID;
- group/supergroup chats require both an authorized sender user ID and the
  group's authorized chat ID;
- usernames, display names, Telegram admin status, and group membership never
  grant authority;
- callbacks re-run authorization rather than treating an inline button as a
  credential;
- removing a user or group stops both future control and future digest delivery.

The primary enrollment path is a single-use five-minute pairing code submitted
to Telegram and explicitly confirmed in the local Settings view. Manual numeric
ID entry remains available. Supplying a pairing code alone never grants
authority.

## Considered Options

- **Username allowlist.** Rejected because usernames are mutable and reusable.
- **Chat-only allowlist.** Rejected because any member of an authorized group
  could control the local machine.
- **User-only allowlist.** Rejected because an authorized person could add the
  bot to an unintended group and leak lane output there.
- **Trust Telegram administrators.** Rejected because Telegram group
  administration is not Krypton authorization.
- **Pair immediately without local confirmation.** Rejected because possession
  or guessing of a short-lived code should not itself grant command execution.

## Consequences

Every admitted request is attributable to a numeric sender ID, and every group
destination is explicitly authorized. The Settings view must treat IDs as
strings to avoid JavaScript precision loss. Pairing needs a narrow
pre-authorization exception for `/pair`, but that exception may only create a
pending local request and cannot invoke Harness control.
