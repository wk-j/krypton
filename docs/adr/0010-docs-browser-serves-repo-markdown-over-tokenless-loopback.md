# Docs browser serves repo markdown over token-less loopback by path

> Status: accepted
> Date: 2026-06-21

## Context

The Docs browser (spec 171) renders the markdown files already present in a
harness's working directory (`<cwd>`) in the OS browser. Unlike the Artifact
gallery — which serves files the lane *created and registered* under
`.krypton/artifacts/`, reached by an unguessable 128-bit capability token — the
Docs browser serves *pre-existing repo files* the harness never authored. This
forces two coupled decisions: how a file is addressed, and whether access is
gated by a token.

ADR-0005 established that the **mutating** Harness Controller API is
authenticated. The **read-only** loopback surfaces (`/telemetry`, `/gallery`,
`/artifacts`) are deliberately token-free: the project's posture is "loopback is
trusted for read-only observation."

## Decision

The Docs browser serves repo markdown over the existing read-only loopback
server addressed by **repo-relative path with no token** (`/doc?harness=<id>&path=<rel>`),
consistent with the token-free posture of `/telemetry` and `/gallery`. Safety
comes from **strict path validation rather than a capability token**:

- the file set is restricted to markdown discovered under `<cwd>` with
  `.gitignore` respected and `.git/` excluded (crate `ignore`);
- every served path is canonicalized and must resolve under `<cwd>`; symlinks
  that escape `<cwd>` are rejected (mirrors `validate_artifact_file`);
- only `.md` is served by `/doc`; image assets are served by a sibling
  `/doc-asset` endpoint restricted to a whitelisted set of image extensions
  under the same validation;
- ~~markdown is rendered server-side with raw HTML escaped (comrak,
  `unsafe_ = false`), so embedded `<script>`/`<iframe>` cannot execute.~~
  **Reversed in spec 171 rev 2** (see Amendment below).

## Amendment (spec 171 rev 2) — raw HTML now renders

The rev-1 escaping (`render.unsafe = false` + `render.escape = true`) is dropped:
markdown is now rendered with raw HTML **live** (`render.unsafe = true`,
`render.escape = false`), so embedded `<script>`/`<iframe>`/`<div>` in a repo's
`.md` files execute/render in the browser. This was an explicit user decision to
make the Docs browser a faithful renderer of authored HTML-in-markdown,
accepting the security trade-off below. The `render_markdown_doc_renders_raw_html`
unit test locks the new behavior. The containment boundary (path validation)
is unchanged; only the content-sanitization stance changed.

### Added consequence

The Docs browser no longer sanitizes at the boundary. Any HTML/JS that lives in
a tracked `.md` file under `<cwd>` runs in the browser when that file is viewed
over loopback — a stored-XSS vector scoped to the loopback origin. This is
accepted: the markdown is the repo's own content under the user's control, the
surface is read-only loopback, and the user opted into faithful rendering over
sanitization.

This keeps per-file URLs **bookmarkable** (the value spec 168 established for the
dashboard) and lets intra-repo `.md` links be rewritten to plain `href`s for
in-browser navigation with near-zero client JS.

## Amendment (spec 172) — tokenless feedback adds a write channel

The Docs browser is no longer strictly read-only. Spec 172 adds an inline
**feedback overlay** to the `/doc` reader: the user points at a passage, types a
comment, and the page POSTs it to `POST /doc-feedback?harness=<id>&path=<rel>`,
which **injects a system turn into the harness's active lane** (a doc has no
owning lane, so the recipient is resolved by the frontend, not a token). A sibling
`GET /doc-state` returns the file's sha256 for the overlay's live-reload poll.

The feedback POST stays **tokenless**, keyed by the same `harness`+`path` the read
uses, and runs the same `validate_doc_path` containment check (only a real `.md`
under `<cwd>` is a valid target). This was an explicit user decision (Q1=A), for
consistency with the surface's existing tokenless posture and the already-accepted
loopback risks (the `/artifacts` gallery exposes the artifact feedback token, so
loopback turn-injection is already reachable; spec 149/170).

### Added consequence

Turn-injection over loopback is a **write** side-effect, more sensitive than the
prior reads: any local process reaching `127.0.0.1` can inject a prompt into the
active lane of any open harness, with no token. The contents are framed as
untrusted `<doc-comment>` data in the composed turn (never instructions) and the
server caps comment count/body/quote — but the channel's reachability is the
accepted trade-off. The cheap hardening declined here (a per-server-session
feedback nonce baked into each served `/doc` page; Q1=B) remains a future option
if the posture is revisited.

## Amendment (spec 174) — tokenless artifact-generation requests

Spec 174 adds a second `/doc` write-side action:
`POST /doc-artifact?harness=<id>&path=<rel>`. The browser sends an idempotency
key and artifact title, Rust validates the same repo-relative `.md` path, and
the frontend routes the request to the harness's active live lane. The lane then
creates a normal HTML artifact through `artifact_new`, edits the issued scaffold,
and calls `artifact_register`.

This request stays **tokenless** for the same reason as docs feedback: it is
keyed by the same `harness`+`path` as the read, preserves bookmarkable doc URLs,
and reuses the accepted loopback turn-injection posture. It is a write
side-effect, but it does not introduce a second artifact storage path: the final
HTML still flows through the existing lane-authored artifact registry, write
grant, transcript card, and feedback-token machinery.

## Considered Options

- **Token-per-file** (like artifacts). Rejected: the token would change on every
  rescan, breaking bookmarkable URLs, while adding no meaningful protection over
  loopback that already serves `/telemetry` and `/artifacts` token-free.
- **A single docs-session token** scoping a path subtree. Rejected: same
  bookmark cost for marginal benefit; inconsistent with sibling endpoints.
- **Inline images as data URIs** instead of a `/doc-asset` endpoint. Rejected:
  bloats pages and forces every referenced image to be read at render time even
  when unviewed.

## Consequences

The loopback server's read-only surface now exposes **user repo files** (committed
markdown + referenced images), not only harness-authored artifacts and
telemetry. This is acceptable under the existing "loopback = trusted read-only"
posture but is a deliberate widening of what is reachable: any local process can
read a harness's repo markdown over `127.0.0.1`. Sensitive content that happens
to live in tracked `.md` files is therefore enumerable on loopback. Correctness
of the containment guarantee rests entirely on path validation (canonicalize +
under-`<cwd>` + symlink-out rejection); that validation is the security boundary
and must be tested as such.
