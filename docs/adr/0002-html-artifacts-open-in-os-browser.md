# HTML artifacts open in the OS browser, not an in-app webview

> **Amended by spec 149 (2026-06-07):** the *open URL* changes from `file://<path>`
> to a served loopback origin `http://127.0.0.1:<harnessMemoryPort>/artifact/<token>`
> (served by the existing harness-memory HTTP server). The **core decision is
> unchanged** — artifacts still render in the user's real OS browser, still only
> on a user keypress, never auto-opened. Only the URL scheme changes. The move is
> deliberate (the author's call) for future headroom: a served origin is the
> precondition for same-origin `fetch`, server-pushed SSE live-reload, and any
> server-mediated feature a `file://` page cannot have — and its direct payoff is
> that the inline-feedback page (spec 149) is **same-origin** with the feedback
> endpoint, so the `Origin: null` / CORS problem disappears. The token in the path
> is the sole capability. See "Amended trust posture (spec 149)" under Consequences.

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

### Amended trust posture (spec 149)

Serving over `http://127.0.0.1` rather than `file://` changes the trust posture, not just the URL mechanism — recorded honestly here:

- **Loopback HTTP is reachable by other local processes/tabs.** Any local process (or another browser tab) that holds the unguessable per-artifact token can `GET` the artifact or `POST` feedback. The token is the sole capability; the server binds loopback only and rejects unknown tokens (`404`, no existence leak). Tokens are revoked forward-only on lane close / `#new` (`410`); `#restart` keeps them.
- **The page shares the MCP/bus server's origin.** Because the artifact is served on the *same port* as `/mcp/harness/{harness_id}/lane/{lane_label}` (which authenticates lane identity from the URL path with no HTTP auth), the artifact's own (lane-authored) JS can same-origin `fetch` those JSON-RPC endpoints and impersonate any lane's tools (`memory_set/get`, `peer_send`, `directive_*`, `artifact_*`). **This is an accepted risk (user decision `jdg-…363a5ad0`):** the reviewer-recommended fix (a second loopback origin) was explicitly declined to keep a single port. It is acceptable under the same trust envelope as the artifact feature itself (the lane already writes the file + has shell), and the token is *not* a defense against the artifact's own script. Revisit before any non-local/shared deployment; the cheap partial mitigation, if reconsidered, is a per-page nonce the MCP handler requires and the artifact origin never receives.
- **Everything else is unchanged.** Full HTML+JS in the real browser profile, no sandbox, opt-in, user-opened, lane-attributed, capped — exactly as the original decision recorded.
