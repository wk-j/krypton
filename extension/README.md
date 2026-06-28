# Krypton Harness — Browser Extension

Send the current page selection into a running Krypton harness lane as a chosen
action (predefined prompt). See `docs/176-harness-browser-extension.md` for the
full design.

## How it works

1. The Krypton app runs the control API on `127.0.0.1:8766` and, on launch,
   writes a Native Messaging host manifest for `krypton-bridge`.
2. This extension asks `krypton-bridge` for the control token (zero config), then
   `POST`s `lane.send` to the control API.

## Install (dev)

1. `make install` (builds + installs `krypton-bridge` to `~/.local/bin`, builds
   the app to `/Applications`, **and bundles the content-extraction script** via
   `make extension`), then launch Krypton so the host manifest is written.
   - To rebuild only the extension bundle: `make extension` (runs
     `npm --prefix extension ci && npm run build` → `dist/content.bundle.js`).
2. Open your browser's extensions page, enable **Developer mode**, click **Load
   unpacked**, and select this `extension/` directory:
   - Chrome/Chromium/Edge/Brave: `chrome://extensions`
   - **Opera / Opera GX: `opera://extensions`**
   Set `[acp_controller].native_host_browsers` to match your browser so the host
   manifest lands in its dir — e.g. `["opera-gx"]` for Opera GX (default is
   `["chrome"]`).
3. The pinned `key` in `manifest.json` fixes the extension ID to match the host
   manifest — do not remove it.

## Use

Highlight text on any page → click the extension → pick a lane and an action
(Explain / Summarize / Translate / Find issues / Custom…). Edit the action list
on the extension's **Options** page.

A fixed **Ingest** button sits after the editable actions: it sends the page (or
selection) to the chosen lane with a prompt to file it into the lane's LLM wiki
(`docs/concepts/llm-wiki.md`). Point it at a lane running in your wiki repo. It is
defined in code (not the editable list), so it always appears.

If you **don't** select anything, the extension extracts the page's main content
as Markdown client-side (via Defuddle, injected on demand) and sends that — so
pages the lane can't fetch server-side (Reddit, YouTube, login-walled, SPAs) still
work. A selection always takes precedence; use the `{page}` placeholder in a
custom action to force full-page capture even with a selection. See
`docs/177-harness-extension-content-extraction.md`.

## Notes

- `.signing-key.pem` is the private key behind the pinned extension ID. It is
  gitignored; keep it if you need to rebuild/publish with the same ID.
