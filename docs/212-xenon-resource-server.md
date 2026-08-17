# Xenon — Central Resource Server — Implementation Spec

> Status: Implemented (2026-08-07)
> Date: 2026-08-07
> Milestone: M-ACP — Harness convergence (new axis: off-machine resource durability)
> New repo: `~/Source/xenon` (git remote `https://github.com/wk-j/xenon.git`, currently empty)
> Builds on: 133/134/149/170/173 (artifacts) · 191/192 (analyses) · 211 (Review Board) · 171/172/174
> (docs browser) · 128/130/138 (attention) · 154/175 + ADR-0005/0007 (control API) · ADR-0015 (keychain)
> Revised 2026-08-07: user registration + user-minted integration tokens added (supersedes the
> original single-tenant, project-token-only auth model). See Open Question 3.
>
> **Implementation deviations (2026-08-07)** — everything else landed as written:
> 1. **Project slugs are a single path segment.** `<owner>/<repo>` would span two segments and
>    could not route (`/v1/projects/{project}/resources`), so Krypton derives `<owner>.<repo>`
>    and any `/` is replaced with `-`. Resource slugs still contain slashes (an analysis bundle
>    is `owner/repo/number`): they travel in the JSON body on write and a trailing `{*slug}`
>    wildcard on browse, so nothing needed percent-encoding.
> 2. **`POST /v1/admin/tokens` and `XENON_ADMIN_TOKEN` were dropped entirely.** With
>    first-user-becomes-admin there is no bootstrap credential to place in the environment, which
>    is strictly better than one that must be generated and then protected. `XENON_SESSION_SECRET`
>    is the only required env var.
> 3. **Added `XENON_INSECURE_COOKIES`** so the server is usable over plain HTTP in local
>    development; it logs a warning at boot and is off by default.
> 4. **Artifacts publish their HTML as `artifact.html`** inside the resource; the original
>    `<harness>/<lane>/<id>` path is preserved as the resource slug.
> 5. **`Publisher::with_token`** exists so the live wire-compatibility test
>    (`src-tauri/tests/xenon_live.rs`, `--ignored`) can run without prompting for keychain access.

## Problem

Every durable thing the ACP Harness produces — HTML artifacts, review bundles, issue analyses,
rendered docs, attention flags — lives **only** in one machine's working tree under a gitignored
`.krypton/` subtree (attention flags never even reach disk; they are in-memory frontend state). It is
therefore invisible from any other machine, unshareable with a teammate, lost when the checkout is
deleted, and unbrowsable when Krypton is not running, since every viewing surface is a loopback
endpoint of the running app. There is no server-side home for the work product of an agent fleet.

## Solution

Add **Xenon**, a standalone single-binary HTTP service (its own repo, deployed on a server) that is
the central store for Krypton-generated resources, plus a **publisher** in Krypton that pushes them.

- **One uniform resource envelope** covers all five kinds: a resource is
  `{ project, kind, slug, title, meta, files[] }`. Bundles (review, analysis) and single-file kinds
  (artifact, doc) differ only in file count; attention flags carry `meta` and zero files.
- **Content-addressed, two-phase upload** (manifest → missing blobs → commit), so re-pushing a
  review whose `response.md` changed transfers one small file, and interrupted pushes resume.
- **Immutable blobs, append-only revisions.** A resource's history is a chain of sealed revisions;
  the latest is the current view. Nothing is ever silently overwritten.
- **Push is explicit and opt-in.** `.krypton/` is gitignored working knowledge that can contain
  source, paths, and secrets; sending it to a server is publishing. Manual `#push` is the default,
  with per-kind `auto_push` available in config.
- **Accounts own projects; tokens are the only machine credential.** A person registers, logs into
  the browse UI with a session cookie, and mints scoped API tokens from a settings page — one for
  their Krypton install, others for external services. Tokens are shown once and stored hashed.

Chosen over the alternatives in Research: a git-backed store (loses dedupe, forces a working copy
server-side, terrible for 32 HTML artifacts), and pushing straight to object storage (no query
surface, no browse UI, credentials on every client).

## Research

**What actually exists to publish** (verified in-tree):

| Kind | On-disk today | Shape |
|---|---|---|
| `artifact` | `.krypton/artifacts/<harnessId>/<lane>/<id>.html` — 32 files here | one self-contained HTML file; carries a baked loopback feedback token + base URL |
| `review` | `.krypton/reviews/<date>-<slug>/` | `review.md` (frontmatter: title/lane/subject/created) + `response.md` (frontmatter is source of truth) + `assets/` + generated `excerpts.json` at `#push` (spec 230; not stored under `.krypton/`) |
| `analysis` | `.krypton/analyses/<owner>/<repo>/<num>/` | N Thai `.md` files (`root-cause.md`, `fix-plan.md`, …) + downloaded issue resources |
| `doc` | repo markdown (`docs/**.md`) — **tracked in git, not under `.krypton/`** | source `.md`; the loopback `/doc` reader renders it with comrak |
| `attention` | **nothing** — in-memory `AttentionTriageStore` only | `TelemetryAttentionItem` (`harness-telemetry.ts:52`): id, lane, createdAt, question, chosen, rationale, tradedOff[], uncertainty, reversibility |
| `daily` | `<[daily_note].output_dir>/<date>.md` (+ `.brief.md`) — **may sit outside the project**, in a real Obsidian vault | one day per resource, files fixed at `note.md` (derived from records) and optional `brief.md` (a lane's narration). Added by spec 224; see `docs/224-daily-note-publish.md` |

Consequences: (1) `attention` has no file, so the envelope must allow zero files and carry structured
`meta`; (2) `review` and `artifact` are **mutable in place** (`response.md` autosaves every ~400 ms;
artifacts are live-editable files the harness re-stats), so a resource cannot be write-once — hence
revisions; (3) `doc` is already in git, the one kind where pushing is hosting, not durability.

**Reusable Krypton infrastructure.** `src-tauri/Cargo.toml` already carries every dependency the
publisher needs — `reqwest` (rustls), `sha2`, `serde`, `tokio`, `keyring` (the Telegram-token
precedent, ADR-0015) — so Krypton gains none. That same set plus `axum 0.8` and bundled `rusqlite`
is also exactly what the server needs, which is the main argument for building Xenon in Rust.
**Identity:** `TelemetrySnapshot` already carries `projectDir`, `hostname` is a dependency, and
`git.rs` can read the remote — a stable project key without inventing a registry.

**Alternatives ruled out.** *Extend the loopback hook server to accept remote connections* — ADR-0005
already rejected exposing harness authority beyond `127.0.0.1`, and it is unauthenticated. *Reuse
`/control/v1` in reverse* — that controls a **running** Krypton (ADR-0007); Xenon must serve when
Krypton is off. *Store resources in git* — spec 133/211 deliberately keep `.krypton/` gitignored.

## Prior Art

| System | Implementation | Notes |
|---|---|---|
| GitHub Actions Artifacts v4 | Gzipped chunked upload via scoped SAS URLs; artifacts **immutable** once uploaded, ID returned immediately. | Immutability kills the concurrent-upload corruption class. Xenon takes it at the *blob* layer and adds revisions on top, because reviews genuinely mutate. |
| OCI / Docker Registry v2 | `HEAD /blobs/<digest>`, `PUT` only what's missing, then a manifest commit. | Source of the two-phase dedupe protocol. Xenon inverts the check: the manifest POST returns all missing digests in one round trip instead of N `HEAD`s. |
| ReportPortal | Project + launch model; REST API for results, logs, attachments; per-project API key in every client integration. | Confirms auto-registered projects and attachments-belong-to-a-parent-record. |
| GitHub personal access tokens | Prefixed (`ghp_`), shown once at creation, stored hashed, scoped, optionally expiring, last-used timestamp, individually revocable. | The token UX is copied wholesale, including the `xen_` prefix so leaks are greppable by secret scanners — Krypton's own pre-push scan included. |
| Gitea / Grafana (self-hosted) | First registrant becomes instance admin; open signup is a flag defaulting **off**; invite codes are the middle ground. | Exactly the bootstrap and signup posture adopted below — no seeded admin credential in the environment. |
| Allure Report | Frameworks write results to a directory; a separate CLI builds a static HTML report. | Analogous to `.krypton/` bundles, but Allure's report is a static build with no server; Xenon keeps a queryable API so bundles stay addressable. |
| Chromatic / Netlify previews | Content-addressed upload negotiation, then a hosted permalinked snapshot per revision. | Permalink-per-revision is what makes a pushed artifact shareable; Xenon copies it. |

**Krypton delta.** No terminal emulator or agent harness has this — the market equivalent is CI
artifact hosting, so the prior art is CI/report servers rather than iTerm2/WezTerm/tmux. Xenon
diverges in three ways: uploads are **explicit and keyboard-driven** (`#push`), never ambient sync,
because the payload is gitignored working knowledge rather than build output; resources are
**mutable via revisions**, unlike CI artifacts, because a review bundle is a living document; and the
browse surface follows `DESIGN.binance.md`, so a pushed resource looks identical hosted and local.

## Affected Files

### Xenon (new repo, `~/Source/xenon`)

| File | Change |
|---|---|
| `Cargo.toml`, `src/main.rs` | axum 0.8 + tokio + rusqlite(bundled) + sha2 + serde; binds `0.0.0.0:$XENON_PORT` |
| `src/config.rs` | env config: `XENON_PORT`, `XENON_DATA_DIR`, `XENON_SESSION_SECRET`, `XENON_MAX_BLOB_MB`, `XENON_ALLOW_SIGNUP` |
| `src/db.rs` | SQLite schema + migrations (tables below) |
| `src/blob.rs` | content-addressed store at `$DATA/blobs/<aa>/<bb>/<sha256>`; temp+rename writes |
| `src/api.rs` | `/v1` ingest + read routes |
| `src/web.rs` | browse UI (Binance-dark), `/r/<project>/<kind>/<slug>` permalinks, plus `/register`, `/login`, `/settings/tokens` |
| `src/auth.rs` | argon2id password hashing, cookie sessions, bearer-token verification, scope checks, constant-time compare |
| `src/account.rs` | **new** — registration, login/logout, invites, token mint/list/revoke |
| `Dockerfile`, `README.md`, `docs/01-protocol.md` | deploy + the wire contract (this spec is the source; `docs/01-protocol.md` is its extract) |

### Krypton

| File | Change |
|---|---|
| `src-tauri/src/xenon.rs` | **new** — publisher: walk a resource dir, build manifest, negotiate, upload blobs, commit; on-disk retry queue |
| `src-tauri/src/config.rs` | `[xenon]` section (`base_url`, `project`, `auto_push`, `enabled`) |
| `src-tauri/src/commands.rs` | `xenon_push`, `xenon_status`, `xenon_set_token` (keychain write) |
| `src-tauri/src/lib.rs` | register the three commands |
| `src-tauri/src/control.rs` | `xenon.push` / `xenon.status` control ops (so kryptonctl / Telegram / Raycast can drive it) |
| `src-tauri/src/hook_server.rs` | collectors: enumerate review/analysis/artifact resources for push (reuses the existing `read_dir` walks) |
| `src/acp/hash-commands.ts` | `#push` command + arg parsing |
| `src/acp/acp-harness-view.ts` | `#push` handler; attention-flag push from `AttentionTriageStore` |
| `docs/06-configuration.md`, `docs/04-architecture.md`, `docs/PROGRESS.md` | doc updates |
| `docs/adr/0016-generated-resources-publish-to-xenon.md` | **new** ADR — publishing is explicit, server never controls the harness |

## Design

### Data Structures

```rust
// Wire types (shared shape; Krypton mirrors these in xenon.rs).
struct ResourceManifest {
    kind: ResourceKind,      // artifact | review | analysis | doc | attention
    slug: String,            // stable per (project, kind): "2026-08-07-peering-guard-rewrite",
                             // "wk-j/krypton/12", "hm-1/Claude-1/art-10-0f765408", "docs/211-review-board.md"
    title: String,
    origin: Origin,          // { hostname, project_dir, krypton_version }
    meta: serde_json::Value, // kind-specific: attention item, review frontmatter, lane label…
    files: Vec<FileEntry>,   // may be empty (attention)
}
struct FileEntry { path: String, sha256: String, size: u64, content_type: String }

struct ManifestAck { resource_id: String, revision_id: String, missing: Vec<String>, unchanged: bool }
```

```sql
-- Xenon SQLite schema
CREATE TABLE user     (id TEXT PRIMARY KEY, email TEXT UNIQUE COLLATE NOCASE, display_name TEXT,
                       password_hash TEXT,            -- argon2id, never reversible
                       is_admin INTEGER DEFAULT 0,    -- first registered user => 1
                       created_at INTEGER, disabled_at INTEGER);
CREATE TABLE session  (id TEXT PRIMARY KEY,           -- sha256 of the cookie value, never the value
                       user_id TEXT, created_at INTEGER, expires_at INTEGER, user_agent TEXT);
CREATE TABLE invite   (code_hash TEXT PRIMARY KEY, created_by TEXT, created_at INTEGER,
                       expires_at INTEGER, used_by TEXT, used_at INTEGER);
CREATE TABLE token    (id TEXT PRIMARY KEY,           -- public half, shown in the UI
                       hash TEXT UNIQUE,              -- sha256 of the secret half
                       user_id TEXT, project_id TEXT, -- project_id NULL => all the user's projects
                       label TEXT, scopes TEXT,       -- CSV: resource:read,resource:write,project:admin
                       created_at INTEGER, expires_at INTEGER, last_used_at INTEGER, revoked_at INTEGER);
CREATE TABLE project  (id TEXT PRIMARY KEY, slug TEXT UNIQUE, owner_id TEXT,
                       is_public INTEGER DEFAULT 0, created_at INTEGER);
CREATE TABLE resource (id TEXT PRIMARY KEY, project_id TEXT, kind TEXT, slug TEXT, title TEXT,
                       created_at INTEGER, updated_at INTEGER, head_revision TEXT,
                       UNIQUE(project_id, kind, slug));
CREATE TABLE revision (id TEXT PRIMARY KEY, resource_id TEXT, seq INTEGER, meta TEXT,
                       origin TEXT, created_at INTEGER, sealed_at INTEGER);  -- sealed_at NULL = open
CREATE TABLE rev_file (revision_id TEXT, path TEXT, sha256 TEXT, size INTEGER, content_type TEXT,
                       PRIMARY KEY(revision_id, path));
CREATE TABLE blob     (sha256 TEXT PRIMARY KEY, size INTEGER, created_at INTEGER);
```

### API

**Token format.** `xen_<id>_<secret>` — 12-char id, 32-char secret, both base32. The id is stored in
the clear (so the settings page can list and match tokens without seeing the secret) and the secret
only as sha256, so the plaintext token exists exactly once, in the creation response. The `xen_`
prefix makes leaked tokens greppable by secret scanners — including Krypton's own pre-push scan.

Accounts — session-cookie authenticated (`HttpOnly`, `Secure`, `SameSite=Lax`, server-side `session`
row so logout and revocation are real):

| Route | Purpose |
|---|---|
| `POST /v1/auth/register` | `{ email, password, display_name, invite? }`. The **first** registration ever becomes admin and needs no invite; after that, allowed only if `XENON_ALLOW_SIGNUP=1` **or** a valid unused `invite` is supplied — otherwise `403 signup_closed`. Password ≥ 12 chars, argon2id. |
| `POST /v1/auth/login` · `POST /v1/auth/logout` | mint / destroy a session. Login is rate-limited per-IP and per-email (5 per 15 min → `429`); failures are indistinguishable between unknown-email and wrong-password. |
| `GET /v1/me` | the current user, their projects, and their non-revoked tokens (id, label, scopes, last-used — **never** the secret). |
| `POST /v1/invites` | admin only → `{ code, expires_at }`, single-use, 7-day default. |

Tokens — session-authenticated (a token may never mint another token, so a leaked integration token
cannot escalate):

| Route | Purpose |
|---|---|
| `POST /v1/tokens` | `{ label, scopes[], project?, expires_in_days? }` → `{ id, token }`. **The only time the secret is returned.** Scopes are validated against the caller's own access; `project` restricts the token to one project. |
| `GET /v1/tokens` · `DELETE /v1/tokens/{id}` | list (metadata only) · revoke immediately (`revoked_at` set; checked on every request, no cache). |

Ingest — all require `Authorization: Bearer <token>` with `resource:write` and access to the project:

| Route | Purpose |
|---|---|
| `POST /v1/projects/{project}/resources` | body `ResourceManifest` → `ManifestAck`. Creates the resource if absent, opens a revision, returns the digests it does **not** have. `unchanged: true` (and no open revision) when every digest and `meta` match the head revision — the client stops there. |
| `PUT /v1/blobs/{sha256}` | raw body. Verifies the digest, rejects on mismatch (`400 digest_mismatch`) and over `XENON_MAX_BLOB_MB` (`413`). Idempotent. |
| `POST /v1/revisions/{revision_id}/commit` | seals; `409 missing_blobs` listing any digest still absent. Sets `head_revision` atomically. |
| `POST /v1/projects/{project}/resources:inline` | single-shot for small payloads (attention records; any resource ≤ 1 MB total): manifest + base64 file bodies in one request. Same semantics, one round trip. |

A project is created on first push, owned by the token's user; a token can only reach projects its
user owns. Read — bearer with `resource:read`, or a session cookie, or unauthenticated if the
project is `is_public`:

`GET /v1/projects` · `GET /v1/projects/{p}/resources?kind=&since=&limit=` ·
`GET /v1/resources/{id}` (head revision + file list) · `GET /v1/resources/{id}/revisions` ·
`GET /v1/revisions/{rev}/files/{path}` (raw bytes; `no-store`, `nosniff`, `no-referrer`) ·
`GET /healthz`.

Browse (HTML, Binance-dark per `DESIGN.binance.md`): `/` project list · `/p/<project>` resource list
filterable by kind · `/r/<project>/<kind>/<slug>` the resource (markdown rendered with comrak;
`artifact` HTML served in a sandboxed iframe) · `/r/.../@<seq>` a pinned revision permalink ·
`/register` · `/login` · `/settings/tokens` (mint, list, revoke; the new secret is displayed once
with a copy button and never re-shown).

Krypton-side Tauri commands: `xenon_push(kind, slug?) -> PushReport`,
`xenon_status() -> { configured, base_url, project, queued, last_push }`,
`xenon_set_token(token) -> ()` (writes the OS keychain, never the TOML).

### Data Flow

```
1. `#push reviews` in the composer (or `xenon.push` on /control/v1) → invoke('xenon_push').
2. xenon.rs enumerates .krypton/reviews/*/, hashes every file (sha256), builds a ResourceManifest,
   and runs the secret pre-scan over text files.
3. A hit → that resource is `blocked` with the file+line; nothing leaves the machine. Otherwise:
4. POST /v1/projects/{p}/resources (bearer = keychain token) → ManifestAck; `unchanged` → done.
5. PUT /v1/blobs/<sha> for each digest in `missing` (concurrency 4).
6. POST /v1/revisions/{rev}/commit → seals, bumps head_revision, returns the permalink.
7. PushReport { pushed, unchanged, blocked, failed, permalinks } → a system transcript line with the
   permalink; transport failures land in the on-disk retry queue.
```

Attention flags take the same path minus disk: `AttentionTriageStore.openItems()` →
`resources:inline` with `files: []` and the `TelemetryAttentionItem` as `meta`, slug = the item id.

### Keybindings

No new global leader key — `#push` is a composer hash-command, consistent with
`#docs`/`#gallery`/`#dashboard`/`#reviews`/`#analyses`.

| Command | Action |
|---|---|
| `#push` | push every kind listed in `[xenon].auto_push`, or all kinds if unset |
| `#push <kind>` | push one kind (`review`, `analysis`, `artifact`, `doc`, `attention`, `daily`) |
| `#push <kind> <slug>` | push one resource |
| `#push --force …` | override the secret pre-scan after the human has read the hit |
| `#xenon` | open the configured Xenon project page in the OS browser |
| `#xenon status` | report enabled / base_url / project / token state / queue depth |
| `#xenon token <token>` | store the bearer token in the OS credential vault |
| `#xenon token clear` | delete the stored token |

`#xenon token` is the **only** way a token reaches the vault. The value is never
echoed to the chip, the transcript, or the lane, and the composer draft is
cleared before the async write begins.

`#xenon status` reports **configuration, not connectivity** — it reads the TOML
and asks the credential vault whether a token exists, and never issues a
request, so `token: configured` says nothing about whether the server is up.
Live link state is the workspace footer's backend-link segment (spec 213 /
ADR-0017), driven by a separate `xenon_probe` command; `⌘P X` re-probes on
demand, and every `#push` updates it from its own outcome.

### Configuration

```toml
[xenon]
enabled   = false              # bool — master switch; false disables #push entirely
base_url  = ""                 # string — e.g. "https://xenon.example.com"; empty = unconfigured
project   = ""                 # string — override; default derived from the git remote, else
                               #          "local/<basename>-<8 hex of abs path>"
auto_push = []                 # array — kinds pushed automatically when sealed, e.g. ["review"]
```

The bearer token is **never** in TOML. It lives in the OS keychain under service `krypton-xenon`,
account `<base_url>`, written by `xenon_set_token` — the ADR-0015 pattern. First-time setup is:
register at `/register` → mint a `resource:write` token at `/settings/tokens` → paste it once into
Krypton. The same page mints the separate tokens external services use.

### Server deployment

Single static binary; `Dockerfile` (distroless) with `$XENON_DATA_DIR` on a mounted volume holding
`xenon.db` + `blobs/`. TLS terminates at the reverse proxy — Xenon speaks plain HTTP, refuses to
start with an empty `XENON_SESSION_SECRET`, and refuses to set a `Secure` cookie over a request it
cannot confirm is HTTPS (`X-Forwarded-Proto`).

Bootstrap: start the server, visit `/register`, and the first account becomes admin. There is no
seeded admin password and no admin token in the environment — nothing to leak from a shell history
or a compose file. Env: `XENON_PORT`, `XENON_DATA_DIR`, `XENON_SESSION_SECRET`, `XENON_MAX_BLOB_MB`,
`XENON_ALLOW_SIGNUP` (default `0` — see Open Question 3).

## Edge Cases

- **Digest mismatch on `PUT`** — reject `400`, do not store; the client retries once, then queues.
- **Commit with missing blobs** — `409 missing_blobs` with the list; the client re-uploads exactly those.
- **Two machines push the same slug** — allowed and expected; each push is a new revision, and
  `origin.hostname` records which machine. Last commit wins as `head_revision`; nothing is lost.
- **Concurrent revisions on one resource** — revisions are independent rows; `head_revision` is set
  in the commit transaction, so an interleaved commit yields a deterministic winner.
- **Resource shrinks** (a bundle file deleted locally) — the new revision's manifest simply omits it;
  earlier revisions keep it. Orphan blobs stay until an explicit `POST /v1/admin/gc`.
- **Artifact feedback token baked into pushed HTML** — the token addresses a loopback endpoint on the
  author's machine and is inert off-box, but it is still a capability string. The publisher strips the
  `{{feedbackToken}}`/`{{feedbackBaseUrl}}` script block from `artifact` HTML before hashing.
- **Secret in a bundle** — pre-scan (AWS keys, `gh[pousr]_`, `sk-`/`sk-ant-`, PEM headers, generic
  `[A-Za-z0-9_\-]{32,}` assigned to a `token|secret|password|api_key` name) blocks the push and names
  the file; `#push --force <kind> <slug>` overrides after the human has looked.
- **Xenon unreachable / 5xx** — the resource is appended to `.krypton/xenon-queue.json` and retried
  with exponential backoff on the next push or app start. `#push` reports the queue depth.
- **`enabled = false` or no token** — `#push` flashes the chip and does nothing, like `#mem` with
  memory unavailable.
- **Blob over the cap** — `413`; the publisher marks that resource `failed` and continues with the rest.
- **`doc` kind slug collision with a path containing `/`** — slugs are stored URL-encoded and
  compared decoded; `validate_doc_path` still gates which files are eligible.
- **Registration on a fresh instance** — the first account becomes admin unconditionally, so
  `README.md` says to register immediately after first boot (the standard Gitea/Grafana caveat).
- **Duplicate email** — `409`, but the form shows the same generic message either way, so the
  endpoint is not an account-existence oracle.
- **Token revoked mid-push** — `revoked_at` is checked per request, uncached, so an in-flight push
  fails `401` at its next call; its revision is never sealed and the publisher queues it. No partial
  resource is ever visible.
- **`resource:write` without `resource:read`** — allowed and useful: CI can push without being able
  to enumerate the project.
- **Expired token / session** — `401 token_expired` / redirect to `/login`, evaluated server-side
  against `expires_at`; a clock-skewed client cannot extend either.
- **Krypton's stored token invalid** — `#push` reports `unauthorized` with the settings URL; the
  retry queue is for transport failures, never auth failures.
- **User disabled** — `disabled_at` fails every session and token on the next request. Their
  projects and resources are retained, not cascaded away.

## Open Questions

Each has a recommendation; approving this spec accepts them as written.

1. **Server language — Rust/axum, or Node/TypeScript?** **Settled 2026-08-07 — Rust/axum + SQLite**
   (acknowledged via attention triage `jdg-1786109040786-2edbd1b0`). It reuses Krypton's exact
   dependency set (axum 0.8, tokio, rusqlite bundled, sha2, serde), deploys as one static binary with
   no runtime on the box, and lets the manifest/blob types be copied verbatim between the two repos.
   Rejected: Node/TypeScript (faster browse UI, matches the Raycast extension's ecosystem, but needs a
   Node runtime on the server and a second hand-maintained copy of the data model) and .NET (matches
   much of the rest of `~/Source` but shares nothing with Krypton). Accepted cost: the browse UI is
   slower to build in Rust than it would be in Node.
2. **Does Xenon ever push back to Krypton?** *Recommend no, for v1.* Xenon is write-and-read only;
   it never controls a harness. Control stays with `/control/v1` under ADR-0005/0007. Proposed as
   ADR-0016.
3. **Signup policy.** **Superseded 2026-08-07 by user direction** — the server does support user
   registration and user-minted integration tokens (spec revised above; the earlier "single-tenant,
   no accounts" recommendation is withdrawn). What remains open is *who may register*:
   **Settled 2026-08-07 — `XENON_ALLOW_SIGNUP=0` by default** (acknowledged via attention triage
   `jdg-1786109596417-18dece58`): the first account becomes admin, everyone else needs an
   admin-issued invite code, and open signup is a deliberate flag flip. On a public-internet host,
   open-by-default signup lets any stranger create an account and consume disk. Rejected:
   open-by-default (convenient on a trusted network, wrong on the public internet) and
   invite-only-always (blocks the flag flip if this ever becomes a shared team instance).
   *Still deferred:* project **sharing between users** — v1 has one owner per project and no
   membership table, so collaboration means the `is_public` read flag or a shared token.
4. **Spec home.** *Recommend this file stays authoritative*, with `~/Source/xenon/docs/01-protocol.md`
   as a mechanical extract of the wire contract, so the protocol is not described twice.

## Out of Scope

Real-time sync or SSE from Xenon · pulling resources back into a checkout · editing a review response
on the server · teams, org accounts, per-project membership, or sharing a project with a second user ·
OAuth/SSO/2FA and email password reset (an admin re-enables an account instead) · S3/object-storage
backends (local filesystem only) · automatic retention/GC (explicit admin GC only) · CI integration ·
pushing transcripts, lane telemetry, or memory documents · an in-app Krypton browser for Xenon (the
OS browser is the surface, per ADR-0002).

## Resources

- [Get started with v4 of GitHub Actions Artifacts](https://github.blog/news-insights/product-news/get-started-with-v4-of-github-actions-artifacts/) — chunked upload + scoped-token blob handoff, and the immutability argument that shaped the blob layer.
- [GitHub Actions Artifacts v4 GA changelog](https://github.blog/changelog/2023-12-14-github-actions-artifacts-v4-is-now-generally-available/) — immediate-ID-on-upload behaviour, mirrored by returning `resource_id` from the manifest POST.
- [ReportPortal REST API](https://reportportal.io/docs/features/RESTAPI/) and [test framework integration](https://reportportal.io/docs/log-data-in-reportportal/test-framework-integration/) — per-project API key, attachments-belong-to-a-parent-record, and the URL + key + project client-config triple `[xenon]` copies.
- [Allure Report docs](https://allurereport.org/docs/v3/) — the collect-to-a-directory-then-publish split that `.krypton/` bundles already follow.
- In-tree: `docs/211-review-board.md` + `docs/192-issue-analysis-viewer.md` (bundle layouts),
  `docs/170-artifact-gallery-endpoint.md` + `docs/173-gallery-disk-rehydration.md` (artifact on-disk
  model), `src/acp/harness-telemetry.ts` (attention item shape), `docs/adr/0005-*` / `0007-*`
  (control authority), `docs/adr/0015-*` (keychain precedent).
