# The loopback app shell holds a session capability in localStorage

> Status: accepted
> Date: 2026-10-29

## Context

Spec 341 turns every loopback browser page into one application with a shell on every page and a Home page that links every surface. Four surfaces are capability-gated — Terminal Control (`/termctrl/<token>`), ACP wire (`/acp-wire/<token>`), Hurl (`/hurl/<token>`, one token per cwd) and E2E (`/e2e/<token>`, one per project root) — and until now their tokens reached the browser only through a Tauri command when Krypton opened the page. A tokenless Home cannot link them. The other surfaces are deliberately tokenless and bookmarkable (ADR-0010).

## Decision

Krypton mints one **session capability** per process (`LoopbackSession`, 128-bit, constant-time compare) and opens every loopback page through `/app/session/<token>?next=<path>`. That landing stores the token in the origin's `localStorage` (`krypton.loopback.session`) and forwards to `next` (a same-origin path, validated on both sides). The shell on every page trades the stored token for capability paths at `GET /app/api/<token>/capabilities`; a 404 (Krypton restarted) clears it, and the shell then shows those four surfaces as unavailable with the reason. The four surfaces keep their own tokens, routes and scopes unchanged; tokenless surfaces stay tokenless.

## Considered Options

- **Leave capability surfaces off Home.** Rejected: four of fourteen surfaces would stay reachable only from Krypton, which is the fragmentation spec 341 removes.
- **An HttpOnly session cookie.** Rejected: cookies are not port-isolated (RFC 6265 §8.5), so a `127.0.0.1` cookie is sent to every local server the browser visits. `localStorage` is scoped to the origin including the port.
- **Put every page under one token-prefixed path.** Rejected: it ends the bookmarkable tokenless URLs ADR-0010 chose and changes every route.
- **A single-page app holding the token in memory.** Rejected in spec 341 for hosting reasons (Rust-rendered readers, raw markdown scripts); it would not change the exposure below, since those scripts would run in the same realm.

## Consequences

- **Accepted widening:** any script running on the loopback origin — a lane-authored HTML artifact, or raw HTML in a repo's markdown rendered by `/doc` — can read the stored token and so reach the four capability surfaces directly (terminal screens and logs, ACP traffic, Hurl runs, E2E evidence). This stays inside the envelope ADR-0002 accepted for artifact script (it can already call every lane's MCP tools on this origin, including `peer_send`) and the one ADR-0010 accepted for repo markdown, but it is a real increase in what such script reaches without going through a lane.
- Other sites, DNS-rebinding origins and other local ports do not get the token: it is never in a cookie, never in a Referer (`no-referrer`), and only same-origin script can read the origin's storage.
- The token lives as long as the Krypton process; a restart invalidates every stored copy.
- If the posture is revisited, the cheapest tightening is serving artifacts and repo markdown from a second loopback origin, the option ADR-0002's reviewer recommended and the user declined.

## Rails

Applies to: `src-tauri/src/loopback_app.rs`, `src-tauri/src/hook_server.rs`, `src/loopback-open.ts`, `src/loopback/entries/session.ts`, `src/loopback/kit/lib/session.ts`, `src/loopback/kit/lib/nav.ts`

- Session tokens are compared whole and in constant time (`LoopbackSession::matches`), and `/app/session/<token>` answers a token that is not this process's session with `404` before it looks at `next`. `check:loopback-session-gate`
- `next` must be a same-origin path: `loopback_url` refuses to build a session URL for anything else and the landing answers `400`; `//host`, `/\host`, scheme-prefixed, relative and control-character paths are refused, and `/app/assets/` serves only `dist/app/` names (`<name>`, `chunks/<name>`). `check:loopback-session-gate`
- The session token lives only in the origin's `localStorage` (`krypton.loopback.session`): no loopback response sets it in a cookie, and every response that carries it in a URL sends `Referrer-Policy: no-referrer`.
- The four capability surfaces (`/termctrl`, `/acp-wire`, `/hurl`, `/e2e`) keep their own tokens, routes and scopes; the session only hands out their paths and never replaces their own token check, and tokenless surfaces stay tokenless.
