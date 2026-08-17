# ACP fs Image / Binary Reads — Implementation Spec

> Status: Implemented
> Date: 2026-08-17
> Milestone: M-ACP — Harness convergence
> Builds on: `docs/88-acp-fs-activity-surface.md`, `docs/135-acp-grok-lane.md`

## Problem

The Grok lane routes every `read_file` through ACP `fs/read_text_file` because Krypton advertises `clientCapabilities.fs.readTextFile`. That method is text-only. A PNG/JPEG the lane saved for visual QA (`/private/tmp/hurl-layout-before.png`) dies in `std::fs::read_to_string` with Rust's `stream did not contain valid UTF-8`. Standalone Grok TUI can see the same file. The chip is red; the model never gets pixels.

## Solution

Two complementary changes, Grok-first:

1. **Grok only: stop advertising `readTextFile`.** Keep `writeTextFile: true`. ACP requires the agent not to call `fs/read_text_file` when the capability is false, so Grok falls back to its native `read_file` (`xai-grok-tools` image embed path). Writes still hit the Spec 89 review card and session-scratch auto-apply.
2. **Every lane: if `fs/read_text_file` still hits non-UTF-8, reply with a typed error** (`binary file (image/png, 18432 bytes); fs/read_text_file is text-only`) instead of the raw IO string. Safety net if a future Grok still calls ACP, and a readable chip for Claude/Codex on a PNG.

Do **not** stuff base64 into `{content: string}`. ACP's read response is text; the model would not receive a vision block.

## Research

- ACP file-system is text-only: `fs/read_text_file` → `{content: string}`. Images travel as prompt/tool `ContentBlock` `{type:"image", mimeType, data}` when `promptCapabilities.image` is set — user paste / screen capture (specs 62, 63), not agent file reads. [File System](https://agentclientprotocol.com/protocol/v1/file-system), [Content](https://agentclientprotocol.com/protocol/content).
- Krypton initialize hard-codes `readTextFile: true, writeTextFile: true` for every backend (`acp.rs` `acp_initialize`). Handler uses `read_to_string`; `InvalidData` is forwarded verbatim (`fs/read_text_file: {e}`).
- Spec 135: Grok remaps every `read_file` through ACP when the client advertises the capability. That is why sibling-repo scoping had to be lifted — not because native Grok cannot read those paths.
- Grok 1.0.4 (`d846eb93d94d`) contains both `file_system/acp_fs.rs` (ACP, `text/plain`) and `file_system/client_fs.rs` (native), plus `read_file/image.rs` ("Could not embed image in conversation", PNG/JPEG/WebP embed). Binary reject list includes gif/bmp/zip/exe but **not** png/jpg/webp. Native path is the one that sees screenshots.
- Zed's `handle_read_text_file` also returns a `String` from a text buffer — same protocol limit; it does not invent a binary read.
- Returning a data-URL in `content` would dump tens of KB of base64 into a text field. Grok's ACP adapter has no evidence it rehydrates that into `ImageContent`.

### Alternatives ruled out

- **Clearer error only.** The chip would read better; Grok still cannot see the screenshot. Rejected as the sole fix.
- **Serve the image as `{content: "data:image/png;base64,…"}`.** Protocol-legal, not multimodal. Token-heavy. Rejected.
- **Client injects a follow-up `session/prompt` image block after a failed read.** Mid-turn the agent is blocked on the JSON-RPC reply; a second prompt is a new turn and a surprise user message. Rejected.
- **Implement `x.ai/fs/read_file`.** Grok's ACP gateway calls standard `fs/read_text_file` whenever that capability is on. Extra method would sit unused.
- **Turn off `readTextFile` for Claude/Copilot too.** Same class of bug is possible, but those lanes use ACP fs for audit/unsaved-buffer by design (spec 88). Out of scope; Grok is the lane that *must* remap.

## Prior Art

| App | Implementation | Notes |
|-----|----------------|-------|
| Grok TUI | Native `read_file` embeds png/jpeg/webp as `ImageContent` | The behavior we want back |
| Grok ACP (today) | `read_file` → `fs/read_text_file` → UTF-8 or fail | Capability-driven remap |
| Zed ACP client | Text buffer snapshot only | Same protocol; no binary read |
| Claude Code ACP | Most reads via `fs/read_text_file` | Keep advertising; better error only |
| Krypton composer | Paste / drop / `Ctrl+Shift+K` → prompt image blocks | User→agent only |

**Krypton delta** — restore Grok's native vision path by not claiming a text-only capability we cannot honor for images. Other lanes keep ACP reads. Failed binary reads become a typed chip, not a Rust IO leak.

## Affected Files

| File | Change |
|------|--------|
| `src-tauri/src/acp.rs` | Per-backend `readTextFile`; classify non-UTF-8 reads; unit tests |
| `docs/228-acp-fs-image-reads.md` | This spec |
| `docs/README.md` | Index row 228 |
| `docs/04-architecture.md` | Grok reads native; binary error note on fs activity |
| `docs/05-data-flow.md` | Grok reads skip `fs/read_text_file`; typed binary error |
| `docs/88-acp-fs-activity-surface.md` | Binary-error contract |
| `docs/135-acp-grok-lane.md` | `readTextFile: false`; native image embed |

No frontend change. Failed chips already render `error`. Grok image reads will show as Grok's own `tool_call` (already rendered), not an `FS 📖` chip.

## Design

### Data structures

```rust
fn advertise_read_text_file(backend_id: &str) -> bool {
    backend_id != "grok"
}

/// Sniff for the error chip only — not a general mime detector.
fn sniff_binary_kind(path: &str, head: &[u8]) -> &'static str {
    // magic first, then lowercase extension.
    // png / jpeg / gif / webp / pdf / zip / wasm / "binary"
}

fn binary_read_error(path: &str) -> String {
    // "binary file (image/png, 18432 bytes); fs/read_text_file is text-only"
}
```

`acp_initialize` builds capabilities from the session's `backend_id`:

```rust
"fs": {
    "readTextFile": advertise_read_text_file(&client.backend_id),
    "writeTextFile": true,
}
```

### `fs/read_text_file` arm

Keep NotFound → empty content. On `ErrorKind::InvalidData` (or `read_to_string` fail after a successful byte read that is not UTF-8):

1. `sniff_binary_kind` from the first 16 bytes (and extension if magic is unknown).
2. Emit `fs_activity` `ok: false` with the typed message.
3. Reply `-32000` / that message.

Do not `from_utf8_lossy`. Do not return empty-success (that would look like a missing file).

### Data flow

```
Grok read_file on foo.png
  → readTextFile is false
  → Grok native read_file / image.rs embeds ImageContent
  → session/update tool_call(+update)  (existing transcript chip)
  → model sees the screenshot

Claude/Codex/… read_file on foo.png
  → fs/read_text_file
  → typed binary error + red FS chip
  → model can ask the user to paste, or skip

Grok write_file
  → unchanged fs/write_text_file (review card / session-scratch auto-apply)
```

### Tests (`acp.rs`)

- `advertise_read_text_file("grok") == false`; `"claude" | "codex" | "copilot" | "droid" == true`.
- `sniff_binary_kind` on PNG/JPEG/GIF/WebP magic and on a `.png` with unknown magic; unknown bytes → `"binary"`.
- `binary_read_error` includes kind + size + the `text-only` clause.
- Existing Spec 135 `fs_path_in_scope` tests stay (writes still unscoped for Grok).

Live verification after merge (not a unit test): spawn a Grok lane, `read_file` a tiny PNG, confirm no `FS × read` UTF-8 chip and the model describes the image. If Grok 1.0.4 still calls `fs/read_text_file` despite the capability, the typed error is the fallback; file a follow-up — do not re-enable the capability.

## Edge Cases

- **Non-image binary** (wasm, zip, pdf): typed error, no embed. Matches Grok TUI's binary reject list for those types.
- **UTF-8 text that happens to have a `.png` name:** `read_to_string` succeeds; serve as text.
- **Empty file:** valid UTF-8, empty `content`.
- **Permission / EISDIR:** keep today's IO error string (not InvalidData).
- **Grok sandbox:** spawn is `grok agent stdio` with no sandbox flags; native reads match TUI. Do not add sandbox here.
- **Sibling-repo reads (spec 135):** native Grok `read_file` already escapes the project (that is why ACP scoping was the bug). Turning off ACP reads does not re-introduce "Path outside project root" on reads.
- **FS activity chips for Grok text reads:** disappear; `tool_call` chips remain. Acceptable.

## Open Questions

None. Verified 2026-08-17 against grok 1.0.4: initialize with `readTextFile: false` → native `read_file` on a 1×1 red PNG, zero `fs/read_text_file` calls, model answered `red`. Fallback if a future Grok ignores the capability remains the typed binary error — do not flip the flag back without a new spec.

## Out of Scope

- A real ACP binary/image read method (needs a protocol change).
- Turning off `readTextFile` for Claude, Copilot, or other lanes.
- Auto-attaching a failed image read as a user prompt block.
- Displaying the image in the Krypton transcript (Grok's tool_call payload may include it later; not required).
- PDF page rasterization (Grok TUI has `PdfPageImages`; unused here).

## Resources

- [ACP File System](https://agentclientprotocol.com/protocol/v1/file-system) — text-only `fs/read_text_file`
- [ACP Content](https://agentclientprotocol.com/protocol/content) — image blocks are prompt/tool content, not fs responses
- [ACP Initialize](https://agentclientprotocol.com/protocol/v1/initialization) — `fs.readTextFile` must be false or the agent may remap
- [xAI Headless & Scripting](https://docs.x.ai/build/cli/headless-scripting) — `grok agent stdio`; example advertises both fs flags
- `~/.grok/docs/user-guide/15-agent-mode.md` — Grok `x.ai/fs/*` extensions; ACP still uses standard fs when advertised
- Grok 1.0.4 binary strings: `acp_fs.rs`, `client_fs.rs`, `read_file/image.rs`
- `docs/135-acp-grok-lane.md` — why Grok remaps `read_file` through ACP
- `docs/88-acp-fs-activity-surface.md` — chip contract
- Zed `crates/agent_servers/src/acp.rs` `handle_read_text_file` — client-side text-only prior art
