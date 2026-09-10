# ACP Harness Dictation — Implementation Spec

> Status: Implemented
> Date: 2026-09-10
> Milestone: ACP Harness — command center input

## Problem

The ACP Harness composer accepts keyboard and image input only. A user who wants
to explain a task aloud must rely on system-wide Dictation, which is awkward for
the Harness's custom-rendered composer because it is not a native text field.

## Solution

Add opt-in speech-to-text dictation to the active Harness composer. `Cmd+D`
starts English (`en-US`) recognition, `Cmd+Shift+D` starts Thai (`th-TH`), and
the `MIC` control starts English. Either chord or the control stops the session.
Interim text is shown inline, and the final transcript is inserted at the saved
composer cursor. Dictation never submits a prompt automatically: the user can
edit the resulting text and presses `Enter` through the existing prompt path.

Version 1 uses the host webview's Web Speech API behind runtime capability
detection. Krypton does not record, persist, or send audio itself and introduces
no transcription account, model download, API key, or backend service. The user
agent chooses its recognition service, which may be local or remote.

## Research

- `AcpHarnessView` owns a custom `<span>` composer rather than an `<input>` or
  `<textarea>`. All edits already flow through `setDraft()` / `insertDraft()`, so
  dictation must join that state path instead of relying on browser text insertion.
- `InputRouter` gives a focused `ContentView.onKeyDown()` first refusal in Normal
  mode. Plain `Cmd+D` and `Cmd+Shift+D` are unbound in the Harness and can be
  implemented without a new global mode or a change to `input-router.ts`;
  existing `Ctrl+D` remains readline-style delete-forward.
- `renderComposer()` rebuilds the composer for state and timer changes. Rebuilding
  it for every recognition result would repeat a known high-frequency churn seam.
  Interim updates therefore patch dedicated text/status nodes with `textContent`;
  normal structural renders seed those nodes from current dictation state.
- The Web Speech API provides distinct `stop()` and `abort()` semantics: stop ends
  capture and attempts a final result, while abort ends capture without returning
  one. That maps directly to stop-and-keep versus `Esc` cancel-and-restore.
- Recognition results contain immutable final entries followed by replaceable
  interim entries. The adapter must reconstruct both portions from each event;
  appending every callback would duplicate words.
- The current WebKit source contains a dedicated speech-recognition microphone
  permission path, and `WKUIDelegate` defines the embedded-view media-capture
  permission prompt. Even so, `SpeechRecognition` is not a Baseline web feature,
  so presence must be probed at runtime and unsupported builds must degrade to the
  unchanged text composer.
- A signed macOS Tauri bundle needs microphone and speech-recognition purpose
  strings plus the Hardened Runtime audio-input entitlement. The app also needs a visible in-product
  recording state; colour alone is not enough.
- Alternatives considered:
  - **Native `SFSpeechRecognizer` + `AVAudioEngine`** gives explicit control over
    on-device-only recognition, but adds Objective-C callback/thread ownership,
    three framework crates, IPC events, and platform-specific lifecycle state for
    a feature the host webview already exposes. Defer it unless the runtime probe
    proves WebKit unsuitable or an on-device-only guarantee becomes required.
  - **Cloud transcription API** was rejected for v1 because it adds credentials,
    cost, audio retention policy, upload failure modes, and a new vendor.
  - **Local Whisper sidecar/model** was rejected for v1 because model distribution,
    memory/CPU load, download UX, and cross-platform audio capture are a separate
    subsystem.
  - **Automatically submit after speech ends** was rejected because recognition
    errors could immediately execute an unintended agent instruction.

## Prior Art

| App | Implementation | Notes |
|-----|----------------|-------|
| VS Code | Microphone control or `Cmd+I` in chat/Agents; shortcut toggles, hold supports push-to-talk; dictation inserts text but does not submit; `Esc` cancels the current dictated text | Closest agent-composer model |
| ChatGPT | Microphone records an audio message, returns an editable transcription, then the user sends it | Review-before-send convention; cloud transcription |
| macOS Dictation | System shortcut or microphone key toggles Dictation at a text insertion point; visible pulsing cursor; `Esc` or the shortcut stops | Familiar platform cue, but Krypton's composer is not a native text field |
| Web Speech API | `continuous` recognition with interim/final results; `stop()` finalizes and `abort()` discards | Browser primitive used by this design |

**Krypton delta** — follow the familiar microphone-toggle and editable-transcript
convention, but keep Krypton's keyboard-first flow with `Cmd+D` (English) /
`Cmd+Shift+D` (Thai), lane-coloured command-center styling, and explicit
active-lane ownership. Unlike a voice-chat mode, the agent receives only the
ordinary text prompt after the user presses `Enter`. The language is chosen by
the start chord, not by the OS UI locale.

## Affected Files

| File | Change |
|------|--------|
| `src/acp/harness-dictation.ts` | **New** Web Speech API type shim, capability probe, recognition adapter, and pure transcript/draft helpers |
| `src/acp/harness-dictation.test.ts` | **New** tests for result replacement, insertion, cancel, stale callbacks, and unsupported runtimes |
| `src/acp/acp-harness-view.ts` | Own one dictation session, route keys/clicks, patch preview nodes, and stop capture on lifecycle changes |
| `src/styles/acp-harness.css` | `MIC` control, recording state, interim text, reduced-motion, and narrow-pane rules |
| `src-tauri/Info.plist` | **New** macOS microphone and speech-recognition purpose strings merged into the generated bundle plist |
| `src-tauri/Entitlements.plist` | **New** Hardened Runtime audio-input entitlement |
| `src-tauri/tauri.conf.json` | Point macOS bundling at `Entitlements.plist` |
| `docs/02-functional-requirements.md` | Add the Harness dictation requirement |
| `docs/04-architecture.md` | Record dictation as a frontend Harness input adapter and its privacy boundary |
| `docs/05-data-flow.md` | Record start, partial, stop/commit, cancel, and submit flow |
| `docs/72-acp-harness-view.md` | Document UI, keybinding, lifecycle, limitations, and verification |
| `docs/README.md` | Add this spec to the index |

No ACP protocol, lane queue, prompt payload, transcript row, Rust command, Tauri
IPC event, or `ContentView` interface changes. The final dictated string enters
the existing `lane.draft` and then follows the existing submit/queue path.

## Design

### Data Structures

```typescript
export type DictationPhase =
  | 'idle'
  | 'starting'
  | 'listening'
  | 'stopping';
export interface DictationResultSnapshot {
  finalText: string;
  interimText: string;
}
export interface HarnessDictationSession {
  token: number;
  laneId: string;
  phase: Exclude<DictationPhase, 'idle'>;
  lang: string;
  baseDraft: string;
  insertAt: number;
  finalText: string;
  interimText: string;
  cancelRequested: boolean;
}

export interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onstart: ((event: Event) => void) | null;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: ((event: Event) => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
```

`HarnessDictationSession` belongs to the view, not to `HarnessLane`. Only one
microphone capture may be active in one Harness view; `token` makes callbacks
from an ended recognizer harmless. The session snapshots the lane draft and
cursor so `Esc` can restore them exactly.

Pure helpers:

```typescript
export function speechRecognitionConstructor(): SpeechRecognitionCtor | null;
export function collectDictationResults(event: SpeechRecognitionEventLike): DictationResultSnapshot;
export function insertDictationText(base: string, cursor: number, speech: string): {
  text: string;
  cursor: number;
};
```

`insertDictationText` adds one separating space only when the characters on both
sides require it; it does not rewrite capitalization, punctuation, code words,
or the rest of the draft.

### API / Commands

No Tauri command is added. `harness-dictation.ts` resolves the first available
constructor in this order:

```typescript
window.SpeechRecognition ?? window.webkitSpeechRecognition ?? null
```

The adapter configures:

```typescript
recognition.continuous = true;
recognition.interimResults = true;
recognition.lang = shiftKey ? 'th-TH' : 'en-US';
```

`Cmd+D` and the `MIC` control use `en-US`. `Cmd+Shift+D` uses `th-TH`. The
webview UI locale is ignored so English-primary Macs can still dictate Thai.
Either chord stops an active session; language cannot change mid-capture.

The implementation handles `start`, `result`, `error`, and `end`. It must not
assume an `end` event means success; it commits only when the session was stopped
or ended naturally with recognized text, and restores the snapshot after abort.

### Data Flow

Start and live preview:

1. User focuses a normal Harness composer and presses `Cmd+D` (English),
   `Cmd+Shift+D` (Thai), or clicks `MIC` (English).
2. `AcpHarnessView` rejects the action when there is no active lane, a permission
   or question owns the composer, an overlay/picker is open, or dictation is
   already owned by another active state.
3. The view snapshots `lane.draft` and `lane.cursor`, creates a recognizer, sets
   phase `starting`, and calls `start()` from the user gesture.
4. Browser/OS requests microphone access on first use. The recognizer's `start`
   event changes the state to `listening` and the composer shows `● REC`.
5. Each `result` reconstructs final and interim text. The view patches only the
   dictation preview and status nodes; `lane.draft` is unchanged.

Stop and send:

1. User presses `Cmd+D`, `Cmd+Shift+D`, `Enter`, or clicks the active `MIC` control.
2. The view changes to `stopping` and calls `recognition.stop()`.
3. On the final result followed by `end`, the latest non-empty recognized text is
   inserted at the saved cursor through `setDraft()` and the recognizer is released.
4. The user edits if needed and presses `Enter`; existing `submitActiveLane()`
   sends or queues exactly the same text payload as a typed prompt.

Cancel and teardown:

1. `Esc` calls `abort()`, invalidates the session token, and restores the exact
   pre-dictation draft/cursor without entering transcript focus.
2. Lane switch, lane close, Harness focus leaving the pane, or view disposal also
   aborts and restores before the surface disappears, so no hidden microphone
   session survives.

### Keybindings

| Key | Context | Action |
|-----|---------|--------|
| `Cmd+D` | Normal composer | Start English (`en-US`) dictation; press again to stop and keep text |
| `Cmd+Shift+D` | Normal composer | Start Thai (`th-TH`) dictation; press again to stop and keep text |
| `Enter` | Dictation active | Stop and keep text; does not submit on the same keypress |
| `Esc` | Dictation active | Abort and restore the pre-dictation draft |
| Other keys | Dictation active | Consumed; edit after dictation stops |

`Ctrl+D` remains delete-forward. Both chords are view-local and do not become
global shortcuts. The help overlay and the microphone control expose them. The
idle `MIC` control starts English; its title lists both chords.

### UI Changes

Normal composer, idle:

```text
memory: 3/3 · ⎇ main                         ? help  MIC  ⌘D  ⇧D
Codex-1 ⠋ explain the migration plan█
```

Listening:

```text
memory: 3/3 · 0:12                           ? help  ● REC EN  ⌘D
Codex-1 ⠋ explain the [migration plan for the old rows…]█
```

- Add a real `<button type="button">` in `.acp-harness__composer-tools` on the
  status row (right of `.acp-harness__composer-meta`, not on the input line) with
  `aria-label="Start English dictation"` / `"Stop dictation"` and `aria-pressed`.
  The idle title is `English: Cmd+D · Thai: Cmd+Shift+D`. The status row sits
  above the input so the control is not painted over by the window footer's
  magnified KR/GR drop caps (specs 218–220 overflow upward over the pane).
  `? help` lives in the same tools cluster.
- Idle shows `MIC` plus `⌘D` and `⇧D` hints. `starting` shows `MIC EN` /
  `MIC TH`; `listening` shows `● REC EN` / `● REC TH`; `stopping` shows
  `FINALIZING…`. Text labels make state and language legible without colour.
- Final recognized text uses normal input colour. Interim text is dimmer and
  underlined with a full-width bottom decoration, not a left accent rail.
- The recording dot uses an opacity-only pulse; `prefers-reduced-motion` keeps it
  solid. No `backdrop-filter` and no L-shaped brackets.
- On narrow panes, hide the `⌘D` / `⇧D` hints but retain the `MIC` / `REC` label.
- When recognition is unsupported, omit the control. Either chord flashes
  `dictation unavailable in this webview` and leaves the draft unchanged.
- If the user-agent has no Thai pack, `Cmd+Shift+D` flashes
  `dictation language unavailable` and leaves the draft unchanged.

### Packaging and Privacy

`src-tauri/Info.plist` is merged by Tauri and contains:

```xml
<key>NSMicrophoneUsageDescription</key>
<string>Krypton uses the microphone to transcribe speech into an ACP Harness prompt.</string>
<key>NSSpeechRecognitionUsageDescription</key>
<string>Krypton uses speech recognition to turn spoken words into an ACP Harness prompt.</string>
```

`src-tauri/Entitlements.plist` grants only:

```xml
<key>com.apple.security.device.audio-input</key>
<true/>
```

Krypton does not retain audio, attach audio to ACP requests, or log recognized
text separately. The Web Speech API may use a remote service selected by the
user agent; the UI/help and docs state this limitation. An on-device-only mode is
out of scope until the native recognizer path is justified.

## Edge Cases

- Permission denied or service unavailable: release the recognizer, preserve the
  original draft, and flash a specific short reason.
- No speech: `end` with no text preserves the draft and flashes `no speech heard`.
- Partial text followed by recognizer error: keep the latest recognized text in
  the composer and flash the error, unless the user explicitly pressed `Esc`.
- Stale callback after cancel/restart: ignore it when its captured token no longer
  matches the active session.
- Browser ends naturally after silence: commit the latest text but never submit.
- `start()` throws `InvalidStateError`: release state and preserve the draft.
- Lane becomes blocked by a permission/question: abort dictation before rendering
  the pre-empting composer.
- Lane switch by tab click, `Ctrl+N/P`, transcript numeric key, or programmatic
  activation: the central `activateLane()` path aborts first.
- Harness loses focus to another Krypton pane/window: a root `focusout` guard
  aborts unless the new focused element is still inside the same Harness.
- Two Harness views start recognition: the browser may reject the second capture;
  its error is local and neither view mutates the other's draft.
- Existing draft, cursor in the middle, multiline draft, punctuation-only result,
  and Unicode/Thai text are covered by pure insertion tests.

## Verification

Automated:

- `npm test -- --run src/acp/harness-dictation.test.ts`
- `npm test -- --run src/acp/acp-harness-view.test.ts`
- `npm run check`
- `npm run build`
- `cargo fmt -- --check` (packaging/config remains valid)
- `cargo clippy -- -D warnings`
- `git diff --check`

Manual on a signed macOS app bundle:

1. First start shows the OS microphone prompt with Krypton's purpose string.
2. Allow: interim words appear, stop commits once, and a separate Enter sends.
3. Deny: no crash, no draft mutation, and the next attempt reports denial.
4. `Esc`, lane switch, pane focus change, lane close, and Harness close all turn
   off the macOS microphone indicator and restore the draft.
5. `Cmd+D` transcribes English and `Cmd+Shift+D` transcribes Thai on an
   English-primary Mac. Verify Unicode insertion. Recognition quality and Thai
   language-pack availability remain user-agent-owned.
6. Verify `Ctrl+D` still deletes forward and both chords work only in Harness
   composer text mode.

## Open Questions

None. Approval may replace any decision above before implementation.

## Out of Scope

- Automatically submitting or continuously conversing with an agent
- Text-to-speech playback of agent replies
- Wake words, always-listening mode, or global dictation outside ACP Harness
- Dictation in Live Assist, Agent view, terminal, review, annotation, permission,
  question, ticket, or orchestrator-console inputs
- Microphone selection, audio files, recordings, waveform/amplitude display
- Arbitrary language picker, custom vocabulary, punctuation cleanup, or LLM transcript cleanup
  (English/Thai are fixed chords, not a locale menu)
- Native `SFSpeechRecognizer`, on-device model management, cloud transcription,
  or local Whisper fallback
- Persisting audio or dictated text outside the existing draft/prompt lifecycle

## Resources

- [Web Speech API specification](https://webaudio.github.io/web-speech-api/) — recognition lifecycle, interim/final result replacement, and stop versus abort semantics.
- [WebKit speech-recognition permission path](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/UserMediaPermissionRequestManagerProxy.cpp) — confirms current WebKit has an embedded speech microphone permission flow.
- [WKUIDelegate media-capture permission API](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/API/Cocoa/WKUIDelegate.h) — embedded WKWebView microphone prompt behavior.
- [Tauri macOS application bundle](https://v2.tauri.app/distribute/macos-application-bundle/) — Info.plist merge and entitlement configuration.
- [Apple Audio Input Entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.device.audio-input) — Hardened Runtime microphone access requirement.
- [Apple microphone authorization guidance](https://developer.apple.com/documentation/AVFoundation/requesting-authorization-to-capture-and-save-media) — purpose string, explicit consent, and failure behavior.
- [Apple Speech recognition authorization](https://developer.apple.com/documentation/speech/sfspeechrecognizer/requestauthorization%28_%3A%29) — speech-recognition purpose string requirement.
- [VS Code Voice support](https://code.visualstudio.com/docs/configure/accessibility/voice) — editable chat dictation, toggle/push-to-talk, and `Esc` cancellation prior art.
- [ChatGPT Voice Dictation FAQ](https://help.openai.com/en/articles/12168547-voice-dictation-faq) — editable-transcription-before-send prior art and contrasting cloud retention model.
- [Apple: Dictate messages and documents on Mac](https://support.apple.com/en-gb/guide/mac-help/mh40584/26/mac/26) — system toggle, visible listening cue, stop, language, and microphone conventions.
