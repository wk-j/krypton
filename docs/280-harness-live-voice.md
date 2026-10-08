# Harness Live Voice (`#live`) — Implementation Spec

> Status: Implemented (Rust signaling + sideband smoke-tested against the live endpoint; the in-app mic/speaker loop is not yet exercised)
> Date: 2026-10-08
> Milestone: M-ACP — Harness convergence
> Builds on: specs 72, 136, 151, 175, 246, 275, 278 · inspired by OMP `/live`

## Problem

The Harness accepts voice only as dictation into the composer (spec 246): the user speaks, reads
the draft, presses Enter, and reads the reply. There is no hands-free mode where the user talks with
a lane and hears answers, while the lane does the actual repository work.

## Solution

Add `#live [voice]` / `Cmd+Shift+L`: a realtime voice session bound to one Harness lane. A Codex
realtime voice model (`gpt-live-1-codex`) talks with the user through the mic and speakers. When the
user asks for real work, the model creates a **delegation**. Krypton sends that delegation text to
the bound lane as an ordinary prompt and streams the lane's progress and final answer back. The
model then says the result as its own.

The session uses the same private Codex endpoint as OMP `/live`, authenticated with the ChatGPT
OAuth token Codex CLI already keeps in `~/.codex/auth.json`. Usage counts against the user's ChatGPT
subscription, not an API key. This choice was made by the user (2026-10-08), with the risks listed
under Risks.

Media (mic, Opus, playback, echo cancellation) runs in the main webview with WebKit's
`RTCPeerConnection`. Rust handles the two steps that need auth headers: the HTTP signaling call and
the sideband WebSocket. The OAuth token never crosses IPC.

## Research

**OMP `/live`** (`@oh-my-pi/pi-coding-agent` 17.3.5, `src/live/`):
- Signaling: `POST https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas`
  with JSON `{ sdp, session: { model: "gpt-live-1-codex", instructions, audio: { output: { voice } },
  delegation: { type: "client" } } }`. The body of the response is the SDP answer. The `Location` header
  carries the call id `rtc_*` (`transport.ts:18,64,201-234`; `protocol.ts:166`).
- Headers (`transport.ts:79-98`, `pi-catalog/src/wire/codex.ts`): `Authorization: Bearer <access>`,
  `OpenAI-Alpha: quicksilver=v2`, `User-Agent: Codex Desktop/0.144.1`, `originator: Codex Desktop`,
  `version: 0.144.1`, `x-session-id: <uuid>`, `session-id` and `thread-id: <session id>`,
  `chatgpt-account-id`. It also sends `x-oai-attestation`, an Apple DeviceCheck envelope claiming bundle
  `com.openai.codex` (`attestation.ts`). OMP sends that header only on darwin-arm64. On every other
  platform it sends no attestation.
- Sideband: `wss://api.openai.com/v1/live/<callId>` with the same headers. It is opened after the
  `oai-events` data channel opens, with 5 attempts (backoff 200 ms·2ⁿ) and a 15 s timeout. Client
  messages go out **only** on the sideband. While the sideband is open, server events from the data
  channel are ignored except `error` (`transport.ts:236-348`).
- Server events: `session.started|updated`, `input_transcript.added`, `output_transcript.added`,
  `turn.done {role, transcript}`, `delegation.created {item: {id, content: input_text[]}}`, `error`.
  Client messages: `delegation.context.append {delegation_item_id, channel?, content}`,
  `session.context.append`, `session.close`. Text is chunked at ≤500 UTF-8 bytes (`protocol.ts`).
- Delegation loop (`controller.ts:294-349`): text of an assistant message that ends in a tool call →
  append with `channel: "commentary"` (silent progress). The last assistant text at turn end → append
  with no channel, rendered as `"Agent Final Message":\n\n<text>`. The bundled prompt
  (`prompts/live-instructions.md`) tells the model it and the backend are one assistant, to delegate
  all repository work, never to recite commentary, and to present the final message as its own.
- Phases: `connecting | listening | working | speaking | muted | error`. Voices: arbor, breeze,
  cove, ember, juniper, maple, sol (default), spruce, vale (`voices.ts`).
- OMP captures native PCM and gates echo by hand (`controller.ts:22-24,384-394`). Krypton does not need
  this: `getUserMedia({ echoCancellation: true })` gives WebKit's echo cancellation against the remote
  track played in the same page.

**Krypton:**
- `usage.rs:728-755` already parses `~/.codex/auth.json` (`tokens.access_token`, `account_id`) and
  calls `chatgpt.com/backend-api` with originator `Codex Desktop`. Codex CLI owns refresh. The
  observed access token lifetime is 240 h.
- `src-tauri/Info.plist` already declares `NSMicrophoneUsageDescription`, which spec 246 added.
  Tauri maintainers confirm WebRTC/`getUserMedia` works on macOS once that key exists
  (tauri#10898). One reporter needed a non-null CSP before `navigator.mediaDevices` appeared.
  Krypton's CSP is `null`, so Phase 0 verifies this.
- Harness hooks: the event switch (`acp-harness-view.ts:7819`) sees `message_chunk` / `tool_call`,
  and `finishTurn` (`:8433`) marks the turn end. `submitLanePrompt` (`:8042`) already starts,
  steers (spec 278), or queues (spec 136) a prompt depending on lane status. Spec 275 says new
  features are controllers with a narrow host.
- No WebSocket client crate is in `Cargo.lock`. `reqwest` 0.12 with rustls is already present.

**Alternatives rejected:**
- *OpenAI public Realtime API with an API key:* documented and stable, but billed per use. The user
  chose the subscription path.
- *Run `omp --mode rpc` and use its `live_start`:* delegated work would run in OMP's own session,
  not in a Harness lane. It would add a second model hop and make `omp` a hard dependency.
- *Native capture and WebRTC in Rust (`webrtc-rs` + `cpal` + libopus):* large new dependencies, and
  echo cancellation would have to be built by hand. This is the fallback only if Phase 0 fails.
- *Run the session in the Live Assist window (spec 208):* that window is lazy and hidden on `Esc`,
  and it receives no stream events while hidden. Audio must survive the hide.

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| OMP `/live` | `/live` or `Ctrl+L`; voice model delegates to the same session's turns; phase bar, levels, rolling transcript | The direct model for this spec |
| OMP RPC `live_start` | Same session over RPC with `live_phase`, `live_levels`, `live_transcript`, `live_end` frames | Frame shapes reused for Krypton's UI state |

**Krypton delta:** the session is bound to one Harness lane, so delegated work appears in that lane's
transcript like any other prompt, with permissions, steering, and queueing unchanged. A keyboard
chord starts and stops it.

## Affected Files

| File | Change |
|------|--------|
| `src-tauri/src/live_voice.rs` (new) | Credentials, signaling POST, sideband WS, event forwarding, send/close, tests |
| `src-tauri/src/usage.rs` | Make `parse_codex_backend_credentials` + Codex home lookup `pub(crate)` for reuse |
| `src-tauri/src/lib.rs`, `commands.rs` | Manage `LiveVoiceState`; register the four commands |
| `src-tauri/Cargo.toml` | Add `tokio-tungstenite` (rustls, webpki roots) |
| `src-tauri/Info.plist` | Microphone text also covers live voice |
| `src/acp/live-voice.ts` (new) | Pure: event parsing, 500-byte chunking, transcript merge, prompt, delegation bookkeeping |
| `src/acp/harness-live-voice-controller.ts` (new) | Peer, mic, playback, levels, phases, lane binding, delegation relay |
| `src/acp/harness-view-host.ts` | `HarnessLiveVoiceHost` |
| `src/acp/acp-harness-view.ts` | `#live` command, `Cmd+Shift+L` / `Cmd+Alt+L`, event/turn-end/status/close hooks, live strip render |
| `src/acp/harness-view-types.ts` | `QueuedPrompt.liveDelegationId?`, transcript item `voice?: true` |
| `src/styles/acp-harness.css` | `.acp-harness__live` strip (BEM, lane accent, reduced motion) |
| `docs/72-acp-harness-view.md`, `04-architecture.md`, `05-data-flow.md`, `02-functional-requirements.md`, `README.md`, `PROGRESS.md` | Document the feature |

## Design

### Rust (`live_voice.rs`)

```rust
pub struct LiveVoiceState { inner: tokio::sync::Mutex<Option<LiveCall>> } // one call app-wide
struct LiveCall { generation: u64, access: CodexAccess, realtime_session_id: String,
                  session_id: String, call_id: Option<String>,
                  sideband_tx: Option<mpsc::UnboundedSender<String>>, task: Option<JoinHandle<()>> }

#[tauri::command] async fn live_voice_signal(offer_sdp: String, instructions: String, voice: String)
    -> Result<LiveSignal /* { generation, answerSdp, callId } */, String>;
#[tauri::command] async fn live_voice_open_sideband(generation: u64) -> Result<(), String>;
#[tauri::command] async fn live_voice_send(generation: u64, message: String) -> Result<(), String>;
#[tauri::command] async fn live_voice_close(generation: u64) -> Result<(), String>;
// event: "live-voice-event" { generation, payload: String /* raw server JSON */ }
//        "live-voice-closed" { generation, error: Option<String> }
```

- `signal` **supersedes** any existing call: it tears the old call down silently and bumps the
  generation, so a reloaded webview never finds the slot stuck. "Already active" is enforced by the
  frontend controller. It reads `auth.json` and fails with
  `codex-not-connected` if the file is missing, or `codex-token-expired` if JWT `exp` has passed.
  It never refreshes or writes the file. It POSTs with the OMP headers above, **without**
  `x-oai-attestation`, matching OMP's path on non-darwin-arm64.
- `open_sideband` connects with the same headers (5 attempts, 15 s timeout). One task forwards text
  frames as `live-voice-event` and drains `sideband_tx`. Socket close or failure emits
  `live-voice-closed` with the reason.
- Every command checks `generation`, so a stale frontend call can never touch a newer session.
- Errors are static sentinels or bounded (≤2 KB, whitespace-collapsed) response bodies. The token is
  never logged.

### Frontend

`live-voice.ts` (pure, unit-tested): `parseLiveServerEvent`, `chunkLiveContext` (≤500 UTF-8 bytes,
never splitting a code point), `mergeTranscript`, which follows OMP's add/finish rules,
`renderLiveInstructions(laneName, userName)`, and the `delegationContext(id, text, channel?)` /
`finalMessage(text)` builders.

`HarnessLiveVoiceController` holds at most one `LiveSession`:

```ts
type LivePhase = 'connecting' | 'listening' | 'working' | 'speaking' | 'muted' | 'error';
interface LiveSession {
  laneId: string; generation: number; phase: LivePhase; muted: boolean; voice: string;
  pc: RTCPeerConnection; mic: MediaStream; audioEl: HTMLAudioElement;
  inputLevel: number; outputLevel: number;          // AnalyserNode RMS, sampled ≤10 Hz
  userLine: string; assistantLine: string;          // last transcript turn per role
  currentDelegationId: string | null;               // owns the running turn's final message
  progressBuffer: string;                           // assistant text since the last tool call
}
interface HarnessLiveVoiceHost extends HarnessViewHost {
  render(): void;
  /** Start an idle lane, steer a busy one (spec 278), else queue it (spec 136); full queue → 'rejected'. */
  deliverLivePrompt(lane: HarnessLane, text: string, delegationId: string):
    Promise<'started' | 'steered' | 'queued' | 'rejected'>;
}
```

The view forwards: `onMessageText(lane, text)`, `onToolCall(lane)`, `onTurnEnd(lane, stopReason)`,
`onLaneStatus(lane, status)`, `onLaneClosed(lane)`, and `onPromptStarted(lane, liveDelegationId)`
when a queued prompt tagged with a delegation starts its turn.

### Data Flow

```
1. User types `#live [voice]` in a lane's composer, or presses Cmd+Shift+L.
2. Controller: getUserMedia({audio:{echoCancellation,noiseSuppression,autoGainControl}}),
   new RTCPeerConnection, add mic track, createDataChannel('oai-events'), createOffer.
3. invoke live_voice_signal(offer, instructions, voice) → setRemoteDescription(answer).
4. Data channel open → invoke live_voice_open_sideband(generation). Phase: connecting → listening
   on `session.started`. Remote track → hidden <audio autoplay>.
5. Speech: input/output transcript events update the live strip only. They are not persisted.
6. `delegation.created {id, text}` → phase working → host.deliverLivePrompt(lane, text, id):
     started/steered → currentDelegationId = id
     queued          → lane mid-turn and not steerable (or a missed steer): the id rides on
                       QueuedPrompt.liveDelegationId and onPromptStarted sets it later; append
                       `"Agent Queued": <lane> is still on earlier work; this request is queued
                       (position N) and runs as soon as that work finishes.`
     rejected        → session.context.append "Agent Could Not Start: <lane status>" (a mid-turn
                       lane: "<lane> prompt queue is full")
   The user row in the lane transcript carries `voice: true` (rendered as a `voice` tag).
7. Lane `message_chunk` text → progressBuffer. `tool_call` → append progressBuffer as
   `commentary` chunks, then clear it.
8. finishTurn → append `"Agent Final Message":\n\n<progressBuffer or "(no text reply)">` to
   currentDelegationId; cancelled turns send `"Agent Turn Cancelled"`. Clear it; phase returns to
   listening/speaking from output level.
9. A permission that waits for the human (`addPermission` after every auto-accept rule: permission
   mode, turn-wide accept/reject, peer-auto, Telegram) → append (speakable)
   `"Agent Permission Request": <tool title>`. The user approves with the existing Harness keys (or
   Live Assist / console); `resolvePermission` then appends `"Agent Permission Resolved": approved |
   rejected` to the same delegation. Without that second append the model never learned the request
   was answered and kept asking (user report, 2026-10-08); auto-accepted requests in `bypass` mode
   used to announce themselves too, because the notice rode the `needs_permission` status change.
10. Cmd+Shift+L / `#live stop` / lane closed / lane error → send `session.close`, close the peer,
    stop mic tracks, invoke live_voice_close; the strip shows the end reason for 4 s.
```

Each `delegation.created` while a turn runs follows step 6. With spec 278 steering, the newest
delegation takes over the running turn; an older delegation that was superseded gets no final
message. That matches OMP, where one active delegation id is overwritten.

### Instructions

These follow OMP's `live-instructions.md` with three changes: "Krypton Live, voice surface of the
`<lane>` lane"; "always speak Thai, technical terms in English" (the user speaks Thai, and speech
recognition can mistake Thai for another language, so following the detected language is not
reliable); and rules for
`"Agent Permission Request"` (say what needs approval and that it is approved on screen; never
claim it was approved before `"Agent Permission Resolved"`), `"Agent Permission Resolved"`
(never ask for that approval again), and `"Agent Queued"` (say it is queued; never create the same
delegation again). Remarks about approvals and other conversation are never delegations, because
every delegation reaches the lane.

### Keybindings

| Key | Context | Action |
|-----|---------|--------|
| `Cmd+Shift+L` | Harness focused | Start live on the active lane / stop the running session |
| `Cmd+Alt+L` | Live session running | Toggle mic mute |
| `#live [voice]`, `#live stop`, `#live mute` | Harness composer | Same, by command |

Neither chord is used by the input router or Harness today (`Cmd+Shift+M` and `Cmd+L` are).

### UI

An `.acp-harness__live` strip sits above the composer of the bound lane only:
`LIVE · <phase> · <voice>`, two 8-segment level meters (`__live-meter--in/--out`), and one
ellipsized line with the latest user or assistant transcript, then the key hint
`⌘⇧L stop · ⌘⌥L mute`. While muted the hint reads `unmute` in the gold token, so mute state is visible
at the end of the strip. The phase label reserves the width of its longest value (`connecting`), so a
listening ↔ speaking flip never shifts the rest of the strip. The phase colors the label through the
lane accent. Error uses the existing error token. There is no left-border rail and no corner
bracket. The meters are text (`█░`), so there is no motion to reduce. The strip stays above the
permission / question prompt row while the composer shows one — the live session announces that
request by voice, so hiding the strip there removed the only live readout at the moment it mattered
(user report, 2026-10-08).

## Edge Cases

- **Second `#live` anywhere:** flash `live already active on <lane>`. One session app-wide.
- **Mic denied / `mediaDevices` missing:** flash the reason; no signaling call is made.
- **401/403 from signaling:** `codex auth rejected — run codex once to refresh`.
  **Other non-2xx:** show the bounded body.
- **Sideband drops mid-session:** the session ends with an error; no auto-reconnect.
- **Lane busy at delegation and the adapter cannot steer** (or the lane is in `needs_permission` /
  `awaiting_peer`): the prompt is queued (spec 136) and the model hears `"Agent Queued"`;
  `queue_full` → rejected path. Dropping these instead (2026-10-08, after remarks like "there's
  nothing to approve" piled up in the queue) lost every real request made while the lane worked, so
  it was reverted the same day. The pile-up is handled at its source: `"Agent Permission Resolved"`
  tells the model an approval is done, and the instructions forbid delegating remarks.
- **Turn starts from someone else (peer mail, user typing):** it is not tagged, so its final message
  is not spoken. `currentDelegationId` stays tied to tagged prompts.
- **Krypton not frontmost:** capture and playback continue. Phase 0 verifies that WebKit does not
  suspend them.
- **App quit / webview reload:** the sideband task dies with the process; a reloaded page's next
  `signal` supersedes the orphaned call, and stale generations are rejected.
- **Open sideband twice:** `sideband-already-open` (added during implementation).

## Risks (accepted by choosing the subscription endpoint)

- The endpoint is private and undocumented (`OpenAI-Alpha: quicksilver=v2`). It can change or
  disappear without notice. The version string `0.144.1` is pinned and may need bumping.
- Krypton identifies itself as `Codex Desktop`. This may violate OpenAI's terms and could affect the
  user's account.
- Attestation: Phase 0 showed the endpoint accepts calls **without** `x-oai-attestation` from macOS
  arm64 (201, delegation round-trip spoken, 2026-10-08). The server may start requiring it later.

## Implementation Phases

0. **Gate spike** (throwaway, not committed): in the bundled app, confirm that `navigator.mediaDevices`
   exists, the mic prompt appears, `RTCPeerConnection` connects, signaling without attestation
   returns 2xx, and audio continues while another app is frontmost. Any failure → stop and amend this
   spec before writing feature code.
1. Rust module + tests (headers, call-id parse, sideband URL, generation guard, JWT expiry).
2. Pure frontend module + tests (chunking, transcript merge, event parse, delegation bookkeeping).
3. Controller, view hooks, UI, keys. Smoke test in the running app: a spoken request becomes a lane
   prompt, progress stays silent, and the final answer is spoken.
4. Docs.

### Results (2026-10-08)

- Phase 0: signaling without attestation → 201 plus an `rtc_*` call id; a synthesized spoken request
  produced `delegation.created`, and the appended `"Agent Final Message"` was spoken back (it said
  it was "on the main branch"). Wire names match OMP. The data channel and the sideband carry the
  same frames, plus `turn.created`, `turn.delta`, `session.usage.updated`, and `session.closed`,
  which are ignored. A WKWebView on a custom `tauri://` scheme exposes `navigator.mediaDevices` as a
  secure context, and `RTCPeerConnection` produces an Opus offer that includes the data channel.
- The Rust `post_offer` / `connect_sideband` code ran against the live endpoint with a native WebRTC
  peer: signal ok, sideband open, a client append was acknowledged (`session.context.appended`).
- Not verified: the in-app path (WebKit mic permission prompt, playback, Cmd+Shift+L routing), and
  whether audio continues while Krypton is not frontmost. A second dev instance next to the
  installed app raised a keychain prompt, so the GUI smoke run was stopped.

## Out of Scope

- Approving permissions by voice; voice choice in `krypton.toml` (the `#live` argument only).
- Live Assist window integration; global (app-unfocused) shortcut.
- Persisting the spoken conversation; auto-reconnect; API-key Realtime backend.
- Refreshing Codex tokens or writing `~/.codex/auth.json`.

## Resources

- `~/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/src/live/{transport,protocol,controller,attestation,voices}.ts`, `prompts/*.md` — protocol, headers, delegation loop, prompt (OMP 17.3.5).
- `@oh-my-pi/pi-catalog/src/wire/codex.ts` — Codex base URL, client version, header names.
- `omp://rpc.md` "Live Voice Sub-Protocol" — phase/levels/transcript frame shapes.
- `omp://natives-media-system-utils.md` — native WebRTC peer, 16 kHz PCM, `oai-events` channel.
- [tauri#10898](https://github.com/tauri-apps/tauri/issues/10898) — `NSMicrophoneUsageDescription` enables WebRTC/getUserMedia on macOS; CSP caveat.
- [WebKit changeset 271229](https://trac.webkit.org/changeset/271229/webkit) — WKWebView exposes `navigator.mediaDevices` for app-bundle content.
