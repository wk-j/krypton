# HTML artifacts open in the OS browser, not an in-app webview

## Context

The ACP harness gives lanes a way to register a rich, possibly interactive HTML artifact for the human to view (see `docs/133-harness-html-artifacts.md`; `CONTEXT.md`: *HTML artifact*). Something has to display that HTML. Krypton's architecture constraints #1 (keyboard-first) and #2 (single native window) plus the user's keyboard-only workflow all pull toward keeping the artifact *inside* the app — and an in-app surface already exists: webview panes (spec 102). Sending the user out to the OS browser is therefore surprising and wants a recorded rationale.

## Decision

Registered HTML artifacts open in the **OS browser** via the existing `open_url` command, against the in-app pull of the keyboard-first / single-window constraints.

The path-handoff contract (`artifact_new { title }` → lane writes the file → `artifact_register { id }`, see `docs/133`) and the register-then-open-on-keypress model are independent of this choice — they describe *how a lane produces and hands over* an artifact and *when* it opens, not *where* it renders. Only the display surface is fixed here.

## Considered Options

- **In-app webview pane (spec 102)** — rejected for v1: native child webviews render above the transparent DOM workspace on macOS (z-order constraint) and must be hidden when off-screen; the surface also forces a JS-sandbox/CSP decision and adds a rendering surface to maintain. Kept explicitly as the natural future target if a keyboard-native surface becomes a priority.
- **Inline iframe in the transcript** — rejected: fights the tail-window transcript (spec 103) and the single-window constraint, and still needs sandboxing.
- **OS browser via `open_url`** — chosen: reuses an existing command, removes the need for *Krypton* to implement a sandbox or fight the z-order machinery, and follows the precedent of commit 6acdc12, which deliberately moved HTML hint targets out of the in-app webview and into the OS browser. Note this does *not* remove browser-profile trust (see Consequences) — it relocates rendering to a surface Krypton does not have to maintain.

## Consequences

- **Accepted cost: a context switch out of Krypton.** Opening an artifact pulls focus to the browser, which cuts against keyboard-first / single-window. This is softened by the register-and-open-on-keypress model: artifacts never auto-open, so the user stays in the app until they choose to look (this user is keyboard-only, so an unsolicited focus grab would be especially jarring — see `docs/133`).
- **Trust follows `bash`/file-write, with honest incremental risk.** The artifact opens verbatim in the user's *real* browser profile with `file://` privileges (full HTML+JS, no sandbox) — it can beacon out, navigate, phish, trigger downloads or URL-scheme handlers, run against existing cookies/extensions, and persist as a live page *outside* Krypton's cancellation/audit loop. This is not "strictly less dangerous than shell"; it is a genuine additional surface. It is accepted because the lane already has shell and file-write under the same trust envelope, and is made tolerable by the feature being opt-in, user-opened, lane-attributed, and capped — not by claiming it is harmless. No sandbox is added by design (sandboxing kills the interactivity that is the feature's point).
- **Reversible at low cost.** Switching to an in-app webview pane (spec 102) later changes only the display step; the `artifact_register` contract and the transcript card are unaffected.
- **Multi-lane focus discipline depends on the keypress gate.** If auto-open were ever added, concurrent lanes registering artifacts would yank focus unpredictably — the keypress gate is what keeps the OS-browser choice tolerable under many lanes.
