# Harness Browser Extension — Implementation Spec

> Status: Implemented
> Date: 2026-06-26
> Milestone: M-ACP — Harness convergence

## Problem

A user reading any web page wants to push that page's content — a selection, the
URL, the title — straight into a running Krypton harness lane without copy-paste
or switching windows. The control API (doc 175) can already accept the data over
loopback HTTP, but a browser extension cannot reach it: it does not know the
bearer token (the `0600` runtime descriptor is unreadable from an extension
sandbox), and we want **zero configuration** — the user installs Krypton and the
extension, and it just works.

## Solution

Ship a Chrome/Chromium **MV3 extension** that is a thin *client* of the existing
control API (Option A; no new server, frontend stays the authority). Two pieces
close the zero-config gap:

1. **Fixed port** (already landed, doc 175) — the control API binds
   `127.0.0.1:8766`, so the extension needs no port discovery.
2. **Native Messaging host** — a tiny `krypton-bridge` binary that Chrome launches
   on demand; it reads the `0600` descriptor *as the user* and returns
   `{ port, token }` to the extension over the stdio native-messaging protocol.
   Only the extension whose ID matches the host manifest's `allowed_origins` can
   invoke it, so the token never crosses the local trust boundary. Krypton writes
   the host manifest into the browser's `NativeMessagingHosts` directory on launch
   (config-gated), making the whole chain install-and-go.

The popup is an **action picker**: the user highlights text on the page, opens
the extension, and chooses an *action* — a predefined prompt template (e.g.
"Explain", "Summarize", "Translate to Thai", "Find issues"). The extension fills
the template with the selection + page metadata and `POST`s it as a `lane.send`
to `http://127.0.0.1:8766/control/v1` (reading `lane.list` for targeting).
Because the extension declares `host_permissions` for that origin, MV3 exempts
the request from CORS — the new `cors_origins` config is **not** needed for the
extension path.

A fixed **Ingest** action (`INGEST_ACTION` in `actions.js`) is rendered after the
editable list. It is the same `lane.send` path, but its prompt asks the target
lane to file the page (or selection) into the LLM wiki it maintains
(`docs/concepts/llm-wiki.md`, spec 144) — write/update a source page, update
`index.md`, touch related pages, append to `log.md`. It is defined in code rather
than seeded into `chrome.storage.sync`, so it always appears even for installs
whose action list was seeded before it existed (and it is not user-deletable).

## Research

- **Control API reuse (doc 175).** `lane.send`, `lane.list`, `harness.list`
  already exist and are reachable. No new control operation is required for a
  send-only v1; the extension is purely a client.
- **MV3 extension CORS.** A service worker fetch to a host listed in
  `host_permissions` is not subject to CORS response checks — so the extension
  reaches `127.0.0.1:8766` directly without Krypton emitting CORS headers. The
  `cors_origins` knob remains for *ordinary* web apps (different origin, no host
  permission), not this extension.
- **Native Messaging mechanics.** Chrome launches the host binary named in a
  per-user manifest JSON; messages are UTF-8 JSON framed by a 4-byte
  native-endian length prefix over stdio. Manifest fields: `name`, `description`,
  `path` (absolute), `type:"stdio"`, `allowed_origins:["chrome-extension://<ID>/"]`.
  macOS per-user manifest dirs: Chrome
  `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`, plus
  sibling paths for Chromium / Edge / Brave. **Opera and Opera GX are the
  exception: on macOS they do NOT read their own `com.operasoftware.*` profile
  dir — they read Google Chrome's `NativeMessagingHosts` dir.** Writing to the
  Opera profile dir produces "Specified native messaging host not found", so
  `opera`/`opera-gx` map to the Chrome dir. All Chromium-based, so the extension
  and its pinned ID are identical across them.
- **Stable extension ID.** `allowed_origins` needs the extension ID *before*
  install. Pinning a base64 public `"key"` in the extension manifest yields a
  deterministic ID, so Krypton can write the host manifest with a known origin.
- **Binary discovery.** Cargo auto-builds `src-tauri/src/bin/*.rs`; a new
  `krypton-bridge.rs` ships alongside `kryptonctl` with no `Cargo.toml` change.
  `make install` already places CLIs in `~/.local/bin`.

## Prior Art

| Tool | Browser→local bridge | Notes |
|------|----------------------|-------|
| 1Password / Dashlane | MV3 extension ↔ desktop app via **Native Messaging** | Same token-never-leaves-host pattern this spec uses |
| GNOME Shell integration | Extension ↔ `chrome-gnome-shell` native host | Manifest-installed host, stdio protocol |
| "Open in VS Code" extensions | Extension → `vscode://` URL or local HTTP | URL-handler variant; no auth needed |
| Raycast / Alfred web shortcuts | Browser → local app via URL scheme or local server | Send-a-payload-to-local-app UX parallel |
| Chrome DevTools Protocol | External client → browser over loopback + token | Inverse direction, same loopback-auth shape |

**Krypton delta** — Native Messaging is the established, OS-sanctioned way for an
extension to talk to a local app with a secret (password managers do exactly
this). Krypton adds nothing exotic: the host only *reads* the descriptor and
relays `{port, token}`; all harness mutation still goes through the authenticated
control API and the frontend authority. Unlike a URL-scheme handler, the
extension gets a real request/response channel (and later, the SSE feed).

## Affected Files

| File | Change |
|------|--------|
| `extension/manifest.json` | New — MV3 manifest: pinned `key`, `nativeMessaging` perm, `host_permissions:["http://127.0.0.1:8766/*"]`, action popup |
| `extension/background.js` | New — service worker: native handshake → cache `{port,token}` → call control API |
| `extension/popup.html` / `popup.js` | New — lane picker + action list; render template; send |
| `extension/options.html` / `options.js` | New — view/edit/add action templates (`chrome.storage.sync`) |
| `extension/actions.js` | New — built-in default actions + placeholder rendering |
| `src-tauri/src/bin/krypton-bridge.rs` | New — native-messaging host: read descriptor, reply `{port,token}` |
| `src-tauri/src/native_host.rs` | New — write/remove the host manifest(s) into browser dirs |
| `src-tauri/src/lib.rs` | Call `native_host::install_manifests()` on launch when enabled |
| `src-tauri/src/config.rs` | `[acp_controller]`: `install_native_host: bool` (default true), `native_host_browsers: Vec<String>` |
| `Makefile` | Install `krypton-bridge` to `~/.local/bin` alongside `kryptonctl` |
| `docs/PROGRESS.md`, `docs/04-architecture.md` | Document the bridge + extension |

## Design

### Action templates

An **action** is a predefined prompt the user picks after selecting context:

```ts
interface ExtensionAction {
  id: string;        // stable key
  label: string;     // shown in the popup list
  template: string;  // prompt with {selection} {title} {url} placeholders
}
```

Built-in defaults (seeded into extension storage, editable in the options page):

| id | label | template (abridged) |
|----|-------|---------------------|
| `explain` | Explain | `Explain the following:\n\n{selection}` |
| `summarize` | Summarize | `Summarize the following:\n\n{selection}` |
| `translate_th` | Translate to Thai | `Translate to Thai:\n\n{selection}` |
| `critique` | Find issues | `Review the following and list problems:\n\n{selection}` |
| `custom` | Custom… | free-text note typed in the popup |

Rendering: substitute placeholders; if the template omits `{url}`, append
`\n\nSource: {title} — {url}`. Selection is wrapped so the lane treats it as
quoted source, not instructions.

### Components & Data Flow

```
1. User highlights text, clicks the extension action on a web page
2. content.js returns the current selection (if any)
3. background.js: if no cached creds, chrome.runtime.sendNativeMessage(
     "com.krypton.bridge", { cmd: "credentials" })
4. krypton-bridge reads ~/.config/krypton/runtime/controller.json,
   replies { port, token, pid } (or { error })  [stdio, length-prefixed JSON]
5. popup.js shows: lane picker (GET lane.list; default remembered/sole lane)
     + the action list (built-ins + user actions from storage)
6. User picks an action (Custom → types a note); popup renders the template
7. background.js POST /control/v1/operations
     { operationId, operation:"lane.send", params:{ lane, text:<rendered> } }
     Header: Authorization: Bearer <token>
8. Control server → frontend → lane.send → text lands in the lane
9. POST result { status:"started"|"queued" } → popup shows a toast
```

### Native host manifest (written by Krypton on launch)

```json
{
  "name": "com.krypton.bridge",
  "description": "Krypton harness bridge",
  "path": "/Users/<user>/.local/bin/krypton-bridge",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://<PINNED_EXTENSION_ID>/"]
}
```

`native_host.rs` resolves the absolute `krypton-bridge` path, writes this JSON
into each configured browser's `NativeMessagingHosts/com.krypton.bridge.json`
(creating the dir), and removes it on an uninstall path.

### Bridge protocol (`krypton-bridge`)

- Reads one length-prefixed JSON request from stdin, writes one response to
  stdout, exits. Only command in v1: `{ "cmd": "credentials" }`.
- Response: `{ "port": 8766, "token": "…", "pid": 1234 }` or
  `{ "error": "descriptor_missing" | "descriptor_unreadable" }`.
- It validates descriptor `pid` liveness (reuse `control::pid_is_live`) so a
  stale descriptor from a dead Krypton is reported, not handed out.

### Configuration

```toml
[acp_controller]
install_native_host = true              # write the native-messaging manifest on
                                        # launch (zero-config bridge)
native_host_browsers = ["chrome"]       # which browsers' manifest dirs to target:
                                        # chrome | chromium | edge | brave | opera | opera-gx
                                        # (Opera GX users set ["opera-gx"]; on macOS
                                        # opera/opera-gx resolve to Chrome's dir — Opera
                                        # reads native hosts from there, not its own)
```

## Edge Cases

- **Krypton not running** — descriptor missing/stale → bridge returns `error`;
  popup shows "Krypton is not running".
- **Token rotated** (Krypton restart) — control API returns `401`; background
  drops cached creds and re-handshakes once, then retries.
- **No harness/lane open** — `lane.send` errors `unknown_harness`/`lane_not_ready`;
  surfaced verbatim in the popup.
- **Multiple harnesses/lanes** — popup lists all from `lane.list`; ambiguous
  send without a chosen lane is rejected by the existing control routing.
- **Manifest path drift** — if `krypton-bridge` isn't at the expected path, the
  manifest is written with whatever absolute path resolves at launch; a missing
  binary surfaces as a native-host connection error.
- **Selection empty** — fall back to page title + URL only. **Superseded by doc 177:**
  when the selection is empty the extension now extracts the page's main content as
  Markdown client-side (Defuddle, injected on demand) and sends that instead of URL-only.

## Open Questions

_Recommended defaults below; please confirm or adjust at approval:_

1. **What data + interaction** — RESOLVED: the popup is an **action picker**. The
   user selects page text, then picks a predefined-prompt action (Explain /
   Summarize / Translate / Find issues / Custom…); the extension fills the
   template with the selection + source and sends it as a `lane.send` prompt
   immediately.
2. **Where action templates live / who edits them** — default: shipped as
   built-in defaults in the extension, editable in the extension **options page**
   (`chrome.storage.sync`), so the extension stays self-contained. Alternative:
   define them in `krypton.toml` and have the extension fetch them (couples
   actions to harness config). Recommendation: extension storage for v1. Confirm?
3. **Lane targeting** — default: popup lists lanes via `lane.list`, remembers the
   last-used lane, defaults to the sole/active lane. Confirm?
4. **Read-back** — v1 is **send-only** (toast from the POST result); live
   SSE read-back is deferred (and depends on the spec-175 `seq`-race blocker).
   Confirm send-only for v1?
5. **Manifest auto-install** — confirm Krypton may write into the browser's
   `NativeMessagingHosts` dir on launch (default on, config-gated). If you prefer,
   `make install` does it instead and launch only verifies.

## Implementation Notes (deviations)

- **No persistent content script.** The selection is read on demand via
  `chrome.scripting.executeScript` (activeTab + scripting permissions) instead of
  a `content.js` injected into every page — less invasive, same result. **Doc 177**
  keeps this on-demand model: it injects a bundled Defuddle for content extraction
  only when the popup is opened with no selection, never as a declared content script.
- The extension ID is pinned by the public `key` in `extension/manifest.json`;
  the matching private key lives at `extension/.signing-key.pem` (gitignored).
  Regenerating the key requires updating both the manifest `key` and
  `native_host::EXTENSION_ID`.

## Out of Scope

- SSE read-back / live lane mirror in the extension (separate follow-up; needs
  the spec-175 streaming blockers resolved first).
- Firefox (`browser_specific_settings` + different manifest dir) and Safari
  (App-Extension model) — Chrome/Chromium family only in v1.
- Screenshot / full-DOM-to-markdown capture — v1 sends text + URL.
  **(full-DOM-to-markdown is now in scope — see doc 177.)**
- Publishing to the Chrome Web Store — v1 is an unpacked/dev-loaded extension
  with a pinned key.
- Any new control operation — v1 rides existing `lane.send` / `lane.list`.

## Resources

- `docs/175-harness-web-control-api.md` — the control API + fixed port this client consumes.
- `docs/154-harness-controller-cli.md` / ADR-0007 — descriptor format, token, frontend-authority constraint.
- Chrome Native Messaging — https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging — host manifest, stdio framing, `allowed_origins`.
- MV3 host permissions & CORS — https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest#cors / extension network behavior — basis for the no-CORS-needed claim.
- Chrome extension key / stable ID — https://developer.chrome.com/docs/extensions/reference/manifest/key — pinning the extension ID for `allowed_origins`.
