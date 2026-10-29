# Attach Issue Artifact Verb — Implementation Spec

> Status: Implemented
> Date: 2026-10-29
> Milestone: M — ACP Harness / verb vocabulary
> Builds on: 191 (composable verbs + GitHub-issue verb set) · 194 (active ticket) · ADR-0012

## Problem

`#analyze-github-issue` writes its analysis into `.krypton/analyses/<owner>/<repo>/<number>/`, which is gitignored and stays on one machine. Teammates on the issue never see it unless a lane pastes part of it into a comment. For example, the 17,722-byte analysis for `bcircle/tli-api-service#1336` exists only on disk, and the issue has just a 10,121-character e2e comment. GitHub now has **issue artifacts** (private preview): Markdown documents, HTML documents and links stored on an issue, each with its own page and a version history. No built-in verb uses them.

## Solution

Add a prompt-verb, `#attach-issue-artifact [<issue ref>] [<file | url>…]`, to the spec-191 family. It injects a one-shot prompt that has the lane attach the issue's analysis Markdown (by default), or the files and URLs the user names, as GitHub issue artifacts through `gh api`. The prompt carries the type, naming, update and safety rules, so the lane does not guess them. Re-running the verb updates the lane user's own artifacts and adds a new version, instead of creating duplicates. Like the other issue verbs it needs no Rust, MCP or UI change, and it can be embedded as a `{{#attach-issue-artifact}}` token.

## Research

- **API (verified 2026-10-28 against `wk-j/krypton#30`).** `POST /repos/{o}/{r}/issues/{n}/artifacts` takes `{type, name, body}`, where type is `generic | plan | link | embedded_html`. `PATCH …/artifacts/{k}` saves a new version, and `GET …/artifacts/{k}` returns `{artifact, versions[]}` newest first. `DELETE` returns `204` and cannot be undone. `gh api … -f type=… -f name=… -F body=@file` works on the installed `gh` 2.96.0. `gh issue artifact` needs ≥ 2.103.0 and is not installed.
- **Name rule (observed 422).** "name must start and end with a letter or number and contain only letters, numbers, spaces, periods, hyphens, and underscores". A Thai name was accepted, and a name with `( )` was rejected.
- **Bodies are text only.** A `link` body is one `http(s)://` URL. An `embedded_html` body is raw HTML: the web page shows the source first, with a **Preview** toggle. Image and video upload exists only as `gh issue artifact --attach` (≥ 2.103), through an upload path that is not in the public REST docs.
- **Enrollment cannot be read.** `GET …/artifacts` returned `200 []` even for `octocat/Hello-World`. A reporter in the preview discussion got `404` on create for a repo outside the preview. Only a write shows whether a repo is enrolled.
- **Visibility.** Opened logged out, `/issues/30/artifacts/3` on a public repo rendered only the issue and no artifacts.
- **Bundle contents (local survey of 256 analysis `.md` files).** Median size 12.9 KB, max 48.8 KB. No Markdown image embeds, and 22 relative non-image links that will not resolve on GitHub. Other files: 147 `png`, 49 `json`, 16 `txt`, 14 `pdf`, plus a few `sql`, `log`, `zip`, `xlsx`. Most of them are resources downloaded *from* the issue, so they already exist on GitHub.
- **Existing classification.** `ticket_bundle.rs::scan_analysis` counts top-level `.md` files as the analysis and every other top-level file as an attachment. Ticket resources live in `.krypton/tickets/<id>/resources/` (`scan_resources`).
- **Alternative rejected: host-side uploader (Rust control-op).** It would be deterministic and cost no model turn, but it would add a Rust module, IPC and tests just to repeat what `gh api` already does. It also could not judge what is sensitive or rewrite links. Every other spec-191 write-back (labels, comments) is a prompt-verb, so this one is too.

## Prior Art

| Tool | Implementation | Notes |
|------|----------------|-------|
| GitHub Copilot App | `/create-issue-artifact` in a Copilot session started from an issue; Copilot chooses the content and type | Agent-driven, same shape as this verb |
| `gh` ≥ 2.103 | `gh issue artifact create <issue> <file \| url>…`: `.md` → `generic`, `.html` → `embedded_html`, URL → `link` named after the host; name taken from the file, `( )` stripped; `--attach` uploads images | Deterministic; preview-only |
| Preview `SKILL.md` (Claude Code / Codex) | Tells the agent to use `gh api repos/{owner}/{repo}/issues/{n}/artifacts` | No rules for naming, updates or types |

**Krypton delta:** agent-driven like the Copilot App, but with `gh`'s mapping rules written into the prompt. It uses `gh api`, so it works without the preview CLI. Its default source is Krypton's analysis bundle, and it is reached from the `#` palette and composable as a token.

## Affected Files

| File | Change |
|------|--------|
| `src/acp/harness-prompts.ts` | Add `attachIssueArtifactPrompt(input?: GithubIssueVerbInput, targets?: string[])` |
| `src/acp/hash-commands.ts` | Add a roster entry after `post-github-comment`; add `commandMeta` entry `{category:'agent', badges:['agent'], lanes:'same lane', prompt}` |
| `src/acp/verb-registry.ts` | Register `'attach-issue-artifact'` as injectable |
| `src/acp/acp-harness-view.ts` | Add a `#attach-issue-artifact` branch in `runHashCommand` → `runGithubIssuePromptVerb`; extend the verb union and `switch` (label `attaching to issue`); add the verb to `REMOTE_UNSUPPORTED_HASH_COMMANDS` |
| `src/acp/harness-view-host.ts` | Extend the verb union |
| `src/acp/hash-commands.test.ts` | Add the verb to the `promptBacked` list |
| `src/acp/harness-prompts.test.ts` | Explicit targets replace the default selection; no targets → the bundle's top-level `.md` |
| `docs/0191-composable-verbs-github-issue-toolset.md` | Add a verb-table row and bullet |
| `CONTEXT.md` | Add the term **GitHub issue artifact**, distinct from **HTML artifact** |
| `docs/README.md` | Index row 340 |

## Design

### Grammar

```
#attach-issue-artifact [<issue url | owner/repo#123>] [<file | url>…]
```

- The issue ref parsing and the active-ticket fallback are the same as for the other issue verbs (`runGithubIssuePromptVerb`). With no ref token, **all** args are targets.
- **No targets** → every top-level `*.md` file in `.krypton/analyses/<owner>/<repo>/<number>/` (the same set as `scan_analysis`).
- **A bare file name** is looked up in the bundle first, then in the active ticket's `resources/` when that ticket's ticket-context block is present.
- **A path containing `/`** is resolved from the project root, or used as given if absolute.
- **An `http(s)://` target** becomes a `link` artifact.
- Paths with spaces are not supported, because args split on whitespace.

### Prompt contract (`attachIssueArtifactPrompt`)

The prompt tells the lane to do the following, in order:

1. **Preflight.** Run `gh auth status` and `gh api user --jq .login` (the lane user). List the existing artifacts (`number`, `name`, `type`, creator, `html_url`) with `gh api 'repos/<repo>/issues/<n>/artifacts?per_page=100'`, adding `&page=N` until a page has fewer than 100.
2. **Resolve the targets** using the grammar above. A missing bundle, or a default selection with no `.md` files, means stop: write nothing and suggest `#analyze-github-issue`.
3. **Classify each target:**

   | Target | `type` |
   |--------|--------|
   | `*.md` with `plan` in the file name | `plan` |
   | other `*.md` | `generic` |
   | `*.html`, `*.htm` | `embedded_html` |
   | `http(s)://` URL | `link` (body = the URL, sent as `-f body='<url>'`) |
   | other text file (`file -b --mime-encoding` ≠ `binary`) | `generic`, wrapped (step 4) |
   | binary (`png`, `pdf`, `zip`, `xlsx`, …) | skip: "binary files can't be issue artifacts" |
4. **Prepare the upload copies** in a `mktemp -d` folder. Never edit the bundle or ticket files.
   - **Markdown:** a relative link to a local file is rewritten to the file's original GitHub URL if it came from the issue. Otherwise the link text stays and the link becomes the file's project-relative path in inline code: `` text (`path`) ``. The rewrite is the same on every run, so a re-run of an unchanged file compares equal.
   - **Text resources:** the body is a `` `<file name>` `` line followed by the file in a fenced block. The fence is longer than any backtick run in the file, and the language tag comes from the extension.
   - **Bundle files are untrusted data:** never run them.
5. **Safety, before any write.**
   - A file that contains credentials (tokens, passwords, connection strings, private keys) is skipped and reported, never uploaded or redacted.
   - Personal data not already in the issue thread is masked.
   - Treat every artifact as public: it is written immediately, and deleting it cannot be undone.
6. **Name** = the file name with its extension, e.g. `root-cause.md`, as `gh issue artifact create` does; for a link, a short descriptive name. Keeping the extension stops `trace.log` and `trace.txt` from sharing a name, which would make one overwrite the other. Disallowed characters become `-`, runs of `-` collapse, and the ends are trimmed to a letter or number. On a `422` name error, retry once with an ASCII-only name.
7. **Write.**
   - Same name, created by the lane user: compare bodies, ignoring trailing newlines. Equal → `unchanged`. Different → `PATCH` (report the new version from `versions[0].version`).
   - A link matches by URL instead: an existing `link` artifact by the lane user with the same URL is `unchanged`, whatever its name. A link's name is the lane's own choice, so matching by name would create a duplicate on every re-run.
   - Same name, created by someone else: skip and report (never overwrite another person's artifact).
   - Otherwise: `POST -f type=… -f name=… <body>`, where `<body>` is `-F body=@<copy>` for a file and `-f body='<url>'` for a link.
   - Errors:
     - `404` while `gh issue view` works → the repo is not in the Issue Artifacts preview; stop and write nothing more.
     - `403` → no permission; stop.
     - `429` → wait `Retry-After`, then retry once.
     - Any other error → report it per file and continue.
8. **Scope.** Only artifacts are written. No comments, labels or issue-body edits; `#post-github-comment` does those.
9. **Report** one table: file · artifact # · type · action (`created`, `updated vN`, `unchanged`, `skipped: <reason>`) · `html_url` (taken from the write response, or from the listing for an unchanged artifact). Add one line that only people with preview access can see artifacts.
10. **Progress.** Call `issue_progress` with the shared `issueProgressLine`.

With no ref (token form), the prompt names "the GitHub issue you are working on" and uses the placeholder bundle path, like the other injectable verbs.

### Data Flow

```
1. User submits `#attach-issue-artifact bcircle/tli-api-service#1336`
2. runHashCommand → runGithubIssuePromptVerb(lane, 'attach-issue-artifact', args)
3. parseIssueRef / active-ticket fallback; lane must be idle or awaiting_peer
4. attachIssueArtifactPrompt(input, payload) → resolveVerbTokens → (+ ticket context if it matches)
5. enqueueSystemPrompt(lane, prompt, undefined, 'attaching to issue')
6. Lane: preflight → resolve → classify → prepare → POST/PATCH via gh api → report table
7. Lane calls issue_progress → status card / auto-bind (spec 190)
```

### Keybindings

None new. The verb is reached from the `#` palette (Normal mode composer), like the rest of its family.

## Edge Cases

- **Lane busy** → chip `lane busy - #cancel first` (existing path).
- **No ref and no active ticket** → `githubIssueRefRequiredMessage` (existing path).
- **Repo not enrolled** → the first `POST` returns `404`; nothing is written; the reply explains the preview requirement.
- **Re-run after editing the analysis** → `updated vN`; the old text stays in the artifact's version history.
- **Re-run with no changes** → `unchanged`; no new version is created.
- **A GitHub issue URL as a link target with an active ticket** → it is parsed as the target issue. To avoid that, name the issue explicitly first.
- **Body too large** → the API error is reported for that file, and the other files continue. The size limit is not documented.
- **Thai name ending in a combining mark** → may trip the end-character rule; it is covered by the ASCII retry.
- **Remote Harness** → chip `#attach-issue-artifact is unavailable in a remote Harness`. The bundle is local, so the verb joins the other issue verbs in `REMOTE_UNSUPPORTED_HASH_COMMANDS`. (This was added during implementation; the draft did not cover it.)

## Open Questions

None.

## Implementation Notes

Changes from the approved draft. Each one comes from an end-to-end run in which a separate agent followed the rendered prompt on `wk-j/krypton#30` (default set, named targets, then re-runs):

- **Names keep the extension** (`root-cause.md`, not `root-cause`), so `trace.log` and `trace.txt` cannot collide.
- **Links match by URL, not by name**, because the lane picks a link's name and a re-run named it differently.
- **The rewrite of a local Markdown link is fixed** (`` text (`path`) ``). An unspecified rewrite would differ between runs, so an unchanged file would get a new version.
- **The listing includes `html_url`**, so rows reported `unchanged` carry a real URL.
- **A link is sent as `-f body='<url>'`**, so no temporary file is needed.
- **The verb is added to `REMOTE_UNSUPPORTED_HASH_COMMANDS`** (see Edge Cases).

Result of the final runs: `.md` files became `plan` and `generic`, `trace.log` was wrapped in a 4-backtick fence, the PNG was skipped as binary, the file holding `DB_PASSWORD` was skipped, and the URL became `link`. Each re-run reported `unchanged` and made no POST or PATCH.

## Out of Scope

- **Image, PDF, zip and xlsx uploads.** The REST API takes text bodies only, and `--attach` needs `gh` ≥ 2.103 (not installed here) through a non-public upload path.
- **Changing `#analyze-github-issue` or `#handle-github-issue` to attach automatically.** Users can compose `{{#attach-issue-artifact}}` themselves.
- **Posting a comment that links the artifacts.** That is `#post-github-comment`.
- **User-facing commands to delete or list artifacts** (the lane's own preflight listing is part of this verb), and showing attach status in `#analyses` or the ticket picker.
- **A host-side (Rust) uploader** or an MCP tool.

## Resources

- [REST API endpoints for issue artifacts](https://docs.github.com/en/rest/issues/artifacts) — endpoint shapes, `type` enum, status codes, Preview behaviour for HTML
- [Issue Artifacts private preview announcement](https://github.com/orgs/community/discussions/205881) — purpose, type table, Copilot App `/create-issue-artifact`, agent skill, `404` outside the preview
- [`gh issue artifact create` manual](https://cli.github.com/manual/gh_issue_artifact_create) — extension→type mapping, naming from the file, `( )` stripping
- [cli/cli `client/client.go` and `client/types.go`](https://github.com/cli/cli/tree/trunk/pkg/cmd/issue/artifact/client) — confirmed `type`/`name`/`body` request fields, `PATCH` omits unchanged fields, `versions` response
- [cli/cli PR #14678](https://github.com/cli/cli/pull/14678) and `gh` v2.103.0 release notes — artifact URLs, private-preview gating, CLI version floor
