# Telegram Bot Token lives in the OS credential vault

> Status: accepted
> Date: 2026-07-24

## Context

A Telegram Bot API token authenticates a public-cloud channel that can exercise
full local Harness authority. Krypton's generic configuration is serialized to
the frontend, GUI bundles do not reliably inherit shell environment variables,
and plaintext config files are commonly copied into support bundles or dotfile
repositories.

## Decision

Krypton stores the Telegram Bot API token in the operating system's credential
vault and exposes only configured/missing/unavailable status to the frontend.
Set, replace, test, and remove operations run in Rust; no read operation returns
the token.

Non-secret enablement and numeric identity allowlists live in the separate,
application-managed `~/.config/krypton/telegram.toml`. The application continues
to treat the user's main `krypton.toml` as read-only. If the credential vault is
unavailable, Telegram stays disabled; there is no plaintext or environment
fallback.

## Considered Options

- **Token in `krypton.toml`.** Rejected because the entire config crosses the
  Tauri boundary and is easy to copy or commit.
- **Environment variable.** Rejected because macOS GUI launches do not reliably
  inherit shell variables and environment inspection widens exposure.
- **Separate plaintext secrets file.** Rejected because filesystem permissions
  are weaker than the platform credential store and still invite accidental
  disclosure.
- **Frontend-managed token.** Rejected because browser/WebView memory and IPC
  would unnecessarily hold the remote-control credential.

## Consequences

The implementation needs a platform credential-store abstraction and must
surface an actionable unavailable state without falling back insecurely.
Settings, logs, DTOs, events, snapshots, and tests may expose only credential
presence. Token replacement must restart the poller and rebind the update
watermark to the newly verified bot identity.
