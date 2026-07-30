# Krypton Raycast Extension

Raycast client for the Krypton ACP harness control API (`/control/v1`,
`docs/154` / `docs/175`). Spec: `docs/205-raycast-extension.md`.

Standalone npm project — not part of the Krypton Vite/Tauri build. macOS only.

## Commands

| Command | What it does |
|---------|--------------|
| **Lanes** | Browse lanes across all open harnesses; send prompts, cancel turns, view transcripts, cycle permission mode, restart stopped/errored lanes |
| **Attention Queue** | Triage open attention flags (question/chosen/rationale detail pane); resolve from anywhere |
| **Pending Permissions** | Answer the head permission request per lane — Enter accepts, ⌘R rejects |
| **Harness Status** | Menu-bar badge (`2▸ ✋1 ⚑1` = busy / needs permission / attention), background-refreshed every minute |

## How it connects

Reads `~/.config/krypton/runtime/controller.json` (written by Krypton on
launch: control URL, bearer token, pid), verifies the pid is alive and
`apiVersion` major is 1, then POSTs operations with the bearer token. If
Krypton is not running every command shows a "Launch Krypton" empty state.

The token rotates on every app launch: reads are retried once after a
descriptor re-read; mutations are never replayed (lane names reset with the
process).

The hook-server port preference (default `8765`) is used only to build
browser URLs for the dashboard/gallery surfaces.

## Development

```sh
cd raycast
npm install
npm run dev      # ray develop — installs the local extension into Raycast
npm run check    # tsc --noEmit
npm run build    # ray build -e dist
```

`ray` comes with the Raycast app (Settings → Advanced → install CLI) or
`npm i -g @raycast/api@latest` tooling. Not published to the Raycast store.
