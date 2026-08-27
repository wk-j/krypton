# Hurl Web Client — Copy as curl

> Status: Implemented
> Date: 2026-08-27
> Builds on: `docs/227-hurl-web-client.md`

## Problem

The loopback Hurl page can run a `.hurl` file against a selected `*.env`, but there is no way to hand the same request to a terminal, a teammate, or another client. `y` copies the response body. Users want a curl command whose `{{variables}}` are already filled from the env currently selected in the topbar.

## Solution

Add **Copy as curl** to the Hurl web client only. Convert the selected `.hurl` source to POSIX curl **without running the request**. Substitute values from the selected `*.env` (the same map already loaded via `GET /env`). `c` copies; a `curl` chip sits next to Run. Canonical converter lives in `src/hurl-curl.ts` with vitest; `artifact-hurl.html` inlines the same functions (same split as `hurl-tree.ts`).

Rejected: `hurl --curl` (it executes the request). Rejected: `hurlfmt --out json` (it dropped `[BasicAuth]` in 7.1.0). Rejected: shell `source dev.env` plus `$VAR` (Hurl names can contain hyphens; the paste would need the env file beside it).

## Research

- The page already holds `sourceText` and `envVars` for the selected file / env. Copy does not need a new hook-server route or the `hurl` binary — useful when the binary is missing.
- Hurl templates are `{{name}}` (inner whitespace trimmed). Env files are `KEY=VALUE` via existing `hurl_read_env_file`. `[Options] variable: k=v` applies to that entry and later ones. Captures cannot be resolved without a run — they stay as `{{name}}`. Built-in functions `newUuid` / `newDate` are evaluated at copy time so the command is plain curl.
- `hurl --curl FILE` writes curl **after** performing the HTTP call (Hurl 6.0+). That is the wrong verb for “copy this request”.
- In-app `HurlContentView` already uses `y` / `Y` / `C` / `p` for response, source, AI context, and path. This spec does not change that window.

## Prior Art

| App | Implementation | Notes |
|-----|----------------|-------|
| Postman | Code pane → cURL; active environment is resolved into the snippet | Mouse-centric; inlines values |
| Bruno | Context menu → Generate code → cURL | File-first cousin; `--request` + `--url` + `--header` + `--data` |
| Hoppscotch | “Copy as cURL” on the request | Browser-native; inlines the current env |
| Insomnia | Generate Code → curl | Same idea |
| Hurl CLI | `hurl --curl out.txt file.hurl` | Executes first; not a copy action |
| Firefox / Chrome DevTools | Copy → Copy as cURL | After a network call |

**Krypton delta** — Keyboard-first (`c`), env taken from the existing `*.env` picker (not a Postman environment store), no request is fired, no new loopback capability. Curl is POSIX (single-quoted), not cmd.exe.

## Affected Files

| File | Change |
|------|--------|
| `src/hurl-curl.ts` | Converter: parse request entries, substitute, emit curl; `hurlCliCommand` |
| `src/hurl-curl.test.ts` | Vitest: env inline, query/form/json/auth/options, multi-entry, unresolved |
| `src/acp/artifact-hurl.html` | `curl` chip, `c` key, banner; inline the converter |
| `docs/227-hurl-web-client.md` | Keybinding + topbar chip |
| `docs/05-data-flow.md` | Copy path (no HTTP) |
| `docs/README.md` | Index row 237 |

## Design

### Data structures

```typescript
export interface HurlCurlOptions {
  /** Directory of the .hurl file; used to resolve `file,name;` and multipart files. */
  fileDir?: string;
}

export interface HurlCurlResult {
  curl: string;             // one command per request, separated by a blank line
  unresolved: string[];     // unique {{names}} still present (captures, missing env, unknown funcs)
  requestCount: number;
}

export function hurlToCurl(
  source: string,
  vars: Record<string, string>,
  opts?: HurlCurlOptions,
): HurlCurlResult;
```

No new Tauri command, IPC event, or `/hurl/api/...` route.

### Substitution

Walk `{{...}}`. Trim the inner name.

1. If `vars[name]` is set (selected env, then any `[Options] variable:` seen so far), replace with that string.
2. Else if `name === 'newUuid'`, insert a v4 UUID.
3. Else if `name === 'newDate'`, insert an RFC 3339 UTC timestamp.
4. Else leave `{{name}}` and record `name` in `unresolved`.

Env `(none)` → `vars` is `{}`. Templates stay. Copy still succeeds.

### Parser (request only)

Split the file into entries on a line that is `METHOD URL` (`METHOD` = uppercase HTTP verb, same set as `hurl-highlight.ts`). Skip `#` comments, `HTTP` response lines, `[Asserts]`, `[Captures]`, `[Filters]`.

Per request, collect:

| Hurl | curl |
|------|------|
| method + URL | URL last; `-X METHOD` only when method is not `GET` |
| `Name: value` headers | `-H 'Name: value'` |
| `[Query] k: v` | append encoded `k=v` to the URL (keep any query already on the URL) |
| `[Form] k: v` | `--data-urlencode k=v` (implies POST body; still emit `-X` if method ≠ GET) |
| `[Multipart]` text | `--form 'k=v'` |
| `[Multipart]` `file,path;` | `--form 'k=@<abs>'` (`fileDir` + path) |
| `[Cookies] k: v` | `-H 'Cookie: k=v; …'` |
| `[BasicAuth] user: pass` | `-u 'user:pass'` |
| `[Options] insecure/location/compressed/http2/http3/ipv4/ipv6/path-as-is` | `-k` / `-L` / `--compressed` / `--http2` / `--http3` / `-4` / `-6` / `--path-as-is` |
| `[Options] proxy/user/unix-socket/max-time/connect-timeout/cacert/cert/key` | `-x` / `-u` / `--unix-socket` / `--max-time` / `--connect-timeout` / `--cacert` / `--cert` / `--key` |
| `[Options] variable: k=v` | add to `vars` for this entry and later ones; not a curl flag |
| JSON `{…}` / XML / `` ``` `` / `` `…` `` body | `--data-binary '…'` ; JSON with no Content-Type header also gets `-H 'Content-Type: application/json'` |
| `file,path;` body | `--data-binary @<abs>` |
| `base64,…;` / `hex,…;` | decode, then `--data-binary` of the bytes as a quoted string if UTF-8-safe; otherwise skip that body and list `unresolved` as `body:base64` / `body:hex` |

Skip `delay`, `retry`, `skip`, `verbose`, `output`, asserts. Multipart + JSON body: body wins (Hurl rule).

Several entries → several curl commands separated by `\n\n`. No `#` comment header (comments would still paste, but a teammate’s first instinct is to run the clipboard; keep it a command).

POSIX quoting: wrap every value and the URL in single quotes; encode an embedded `'` as `'\''`.

### Data flow

```
1. User selects a .hurl file (existing) and an env (existing E / <select>)
2. Page already has sourceText + envVars
3. User presses c, or clicks the curl chip
4. hurlToCurl(sourceText, envVars, { fileDir: dirname(selected) })
5. navigator.clipboard.writeText(result.curl)
6. Banner: "Copied curl · env: dev.env" or "Copied curl · (none)"
   If unresolved.length > 0, append " · N unresolved: a, b"
7. No file selected / empty source → banner "Select a .hurl file" ; clipboard unchanged
```

Hidden-tab / running-request: copy is allowed; it uses current source + env, not the in-flight response.

### Keybindings

| Key | Context | Action |
|-----|---------|--------|
| `c` | Page, filter not focused | Copy as curl |
| click `curl` chip | Topbar | Same |
| `H` | Page, filter not focused | Copy `hurl [--verbose] [--variables-file env] file` |
| click `hurl` chip | Topbar | Same |

`h` stays fold. `y` stays copy-response. Do not steal `C` (in-app AI context; unused on the page).

The hurl CLI line uses listing `rel_path` values so it is meant to be run from the session cwd. Env `(none)` omits `--variables-file`. Active `v` / `VV` chips add `--verbose` / `--very-verbose`.

### UI

Topbar actions become: env `<select>` · `v` · `VV` · `curl` · `hurl` · `Run`.

`curl` / `hurl` are `.chip` like `v`/`VV` (not the accent Run button). `title="Copy as curl (c)"` / `title="Copy hurl command (H)"`. Disabled when no file is selected (`run` already does this). Footer keys add `<kbd>c</kbd> curl` and `<kbd>H</kbd> hurl`.

Banner uses the existing ok/error styles. No modal, no preview pane.

## Edge Cases

- **Unresolved templates** — still copy; banner lists unique names.
- **Clipboard denied** — banner "Copy failed"; do not `execCommand` fallback (loopback `http://127.0.0.1` is a secure context).
- **No env** — copy with `{{var}}` intact.
- **Switch env then `c`** — uses the newly loaded `envVars` (same as highlighting).
- **Binary / 415 source** — `sourceText` is empty; treat as no source.
- **Multipart file missing on disk** — still emit `@<abs>`; curl will fail later. Copy does not stat.
- **Very large body** — copy the full source-derived body; no extra cap beyond what the source endpoint already returned.

## Open Questions

None.

## Out of Scope

- In-app `HurlContentView` (`Leader q`)
- New hook-server / Tauri endpoints
- cmd.exe / PowerShell curl dialects
- Writing `.hurl` or `.env`
- Resolving `[Captures]` from a previous run
- Import curl → `.hurl`

## Resources

- [Hurl request format](https://hurl.dev/docs/request.html) — headers, sections, body kinds, options
- [Hurl templates](https://hurl.dev/docs/templates.html) — `{{var}}`, `newUuid` / `newDate`, `[Options] variable`
- [Hurl `--curl`](https://hurl.dev/docs/manual.html#curl) — executes, then writes curl; rejected as the copy path
- [Bruno “Generate code”](https://github.com/usebruno/bruno/discussions/4017) — Copy as cURL via context menu
- `docs/227-hurl-web-client.md` — page, env picker, `y` copy body
- `docs/65-hurl-client-window.md` Q13 — `*.env` via `--variables-file` only
