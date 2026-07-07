# Composable Verbs + GitHub-Issue Verb Set — Implementation Spec

> Status: Implemented
> Date: 2026-07-07
> Milestone: M — ACP Harness / verb vocabulary

## Problem

Krypton ships built-in [[Verb]]s (`#fix-issue`, `#polly`, `#wiki`, `#review`, …)
— one-job system prompts injected into a [[Lane]] from the `#` palette, working in
every project with no per-project `.claude/skills/`. Two gaps:

1. **No GitHub-issue verbs beyond dispatch.** Spec 178 can hand an issue to a lane
   to fix, but there is no built-in verb to *analyse* an issue (find a fix
   solution, pull down its attachments), *label* it, or *comment* on it. Today a
   lane does these ad-hoc with raw `gh`, with nothing built-in guiding it and
   nothing project-agnostic to invoke.
2. **Verbs cannot be built from other verbs.** An author who wants a richer verb
   (analyse, then fix, then comment) must hand-copy each sub-prompt. There is no
   way for one verb's prompt to reuse another's.

## Solution

Two parts, one small mechanism.

**A. Verb composition = inline token substitution (ADR-0012).** A verb name is a
**token**. Any verb's prompt may embed another verb inline as `{{#verb-name}}`.
When the verb is invoked, a resolver **substitutes each token with the referenced
verb's rendered prompt text**, producing ONE combined prompt sent to the lane in a
**single turn**. It is NOT a serial pipeline and there is NO runner — the
composing verb is free-form prompt prose with verb tokens dropped into it wherever
(and however often, and under whatever conditions) the author writes them. Only
prompt-verbs are injectable; a control-op verb (e.g. the `#fix-issue` dispatch)
has no text to substitute and cannot be a token.

**B. A GitHub-issue verb set** as the first consumers:

| Verb | Kind | What its prompt tells the lane to do |
|------|------|--------------------------------------|
| `#create-github-issue <what to file> [-R owner/repo]` | prompt | Draft a title + body from a plain-language request and file a NEW issue via `gh issue create …` (writes immediately — see §Risk). Takes free text, not an issue ref; **not injectable** |
| `#analyze-github-issue <url>` | prompt | Investigate the issue to find a fix solution; download its attached resources; write markdown analysis into the per-issue bundle `.krypton/analyses/<owner>/<repo>/<number>/` |
| `#tag-github-issue <url> [labels…]` | prompt | Apply labels via `gh issue edit … --add-label …` |
| `#post-github-comment <url>` | prompt | Draft and post a comment via `gh issue comment …` (writes immediately — see §Risk) |
| `#fix-github-issue <url>` | prompt | Fix the issue's bug **in the current lane** (injectable) |
| `#dispatch-github-issue <url>` | control-op | Existing spec-178 dispatch (spawn/target a fresh lane, set goal, send fix prompt). Renamed from `#fix-issue`; `#fix-issue` kept as alias. **Not injectable.** |

Plus one composed verb demonstrating (A) over (B):

```
#handle-github-issue <url>  →  prose that embeds
  {{#analyze-github-issue}} … {{#fix-github-issue}} … {{#post-github-comment}}
```

No MCP tool, no Rust change, no browser-extension change. Every verb runs on the
lane with the tools it already has (`gh`, `curl`, edit, bash). The harness *sees*
the work through the existing `issue_progress` tool + auto-bind (spec 178/190),
which the verb prompts instruct the lane to call.

## Research

- **Verb roster + manifest.** `src/acp/hash-commands.ts` is the single source of
  truth: `HASH_COMMANDS` (palette autocomplete), `commandMeta()` +
  `buildCommandManifest()` (spec 185, the `/commands` reference page that renders
  the *real* injected prompt templates). A drift-guard test asserts `commandMeta`
  keys equal the manifest name set.
- **Prompt builders.** `src/acp/harness-prompts.ts` holds pure builders
  (`wikiIngestPrompt`, `issueFixPrompt`, `goalSeedPrompt`, …) — exported so the
  manifest renders the same text the dispatch injects. New verbs add builders
  here.
- **Dispatch + send.** `AcpHarnessView.runHashCommand` (`acp-harness-view.ts:7992`)
  switches on the token and calls `enqueueSystemPrompt(lane, promptText, …)`. This
  is the single point where a verb's prompt text is materialised before being
  sent — the natural home for the token resolver.
- **Issue plumbing already exists (spec 178/190).** `parseIssueRef` (`:5508`),
  `fetchIssueMeta` (`:5528`), `IssueBinding`, `publishIssueStatus`, `autoBindIssue`
  (`:5548`), and the `issue_progress` MCP tool (`hook_server.rs:2745`). The new
  issue verbs reuse all of it; they add no new state.
- **`.krypton/` is gitignored** (`.gitignore:29`) and hosts `.krypton/artifacts/`.
  Files there survive on local disk across harness close but are not committed, not
  in a PR, and not shown by the Docs browser (which filters through `.gitignore`).
- **Not reused: `queuedPrompts` (spec 136).** The prompt queue drains one prompt
  per idle turn — using it for composition would make composition a multi-turn
  runner, which ADR-0012 rejects. It stays for its existing purpose.

## Prior Art

- **Claude Code / agent skills** (`.claude/skills/*`, `/`-commands) — agent-side,
  per-project, discovered by the agent. Verbs are the harness-side, embedded,
  project-agnostic counterpart (the harness ships them; the agent needs no files).
- **Template includes / partials** (Handlebars `{{> partial}}`, Jinja `{% include %}`)
  — the exact shape of composition here: named fragments substituted inline into a
  larger template, resolved once. Krypton's twist: the fragments are themselves
  first-class invocable verbs.
- **Spec 178 GitHub issue fixing** — the dispatch + status-binding substrate the
  issue verbs plug into.

## Affected Files

| File | Change |
|------|--------|
| `src/acp/harness-prompts.ts` | Add builders: `analyzeGithubIssuePrompt`, `tagGithubIssuePrompt`, `postGithubCommentPrompt`, `fixGithubIssuePrompt`. Each reuses `parseIssueRef`-style input and states the `issue_progress` reporting contract + `.krypton/analyses/…` bundle convention. |
| `src/acp/verb-compose.ts` (new) | `resolveVerbTokens(promptText, lookup, opts)` — scan `{{#verb-name}}` tokens, substitute each with the referenced verb's rendered prompt, with a visited-set + max-depth cycle guard. Pure + unit-tested. |
| `src/acp/verb-registry.ts` (new) or extend `hash-commands.ts` | Map from verb name → its prompt builder (the `lookup` the resolver uses), and a `composed` roster (built-in composed verbs like `#handle-github-issue`, whose prompt bodies contain tokens). |
| `src/acp/hash-commands.ts` | Add the new verbs to `HASH_COMMANDS` + `commandMeta()`; rename `fix-issue` → `dispatch-github-issue` with `alias: 'fix-issue'`; mark composed verbs with an `anatomy` listing embedded verbs; render resolved prompts in the manifest. |
| `src/acp/acp-harness-view.ts` | `runHashCommand`: route the new tokens; run `resolveVerbTokens` on any verb prompt before `enqueueSystemPrompt`; keep `#fix-issue`/`#dispatch-github-issue` on the existing dispatch path (control-op, unresolved). |
| `docs/178-github-issue-fixing.md` | Note the `#fix-issue` → `#dispatch-github-issue` rename + alias; cross-link the new verb set. |
| `docs/PROGRESS.md` | Index entry for this spec. |
| `hash-commands.test.ts`, `verb-compose.test.ts` (new) | Drift guard stays green; resolver cycle/depth/substitution tests. |

## Design

### Token syntax & resolver

- **Token:** `{{#verb-name}}` — the same `#name` the palette uses, wrapped in
  `{{ }}`. Appears anywhere in a verb's prompt prose.
- **`resolveVerbTokens(text, lookup, { maxDepth: 4, seen: Set })`:** replace each
  `{{#name}}` with `lookup(name)` (the referenced verb's rendered prompt),
  recursing so a composed verb may embed another composed verb. A `name` already
  in `seen` (cycle) or exceeding `maxDepth` throws; `runHashCommand` catches and
  `flashChip`s the error instead of sending a broken prompt. An unknown `name`
  throws likewise (typo caught at invocation, not silently left literal).
- **No arg passing through tokens (v1).** A token is bare `{{#name}}`. Embedded
  verb prompts are authored to act on *"the GitHub issue you are working on"* —
  the composing verb's own prose names the issue once (from its `<url>` arg), and
  every embedded prompt refers back to that established subject. This keeps the
  resolver a pure string substitution and matches how the issue verbs already lean
  on the lane's bound issue. (Arg-bearing tokens are a possible v2.)

### The GitHub-issue verbs

The issue-referencing prompt-verbs take an issue reference (`<url>` or
`owner/repo#123`, validated by the existing `parseIssueRef`) and, in their prompt,
instruct the lane to call `issue_progress { issue_key, phase, … }` at the right
phases so the status card + lane monitor reflect the work (auto-bind, spec 190,
creates the binding if the issue was never dispatched). `#create-github-issue` is
the exception — it files a new issue from free text, so it carries no ref and no
`issue_progress` line.

- **`#analyze-github-issue`** — prompt: investigate the codebase + issue to find a
  fix solution; download the issue's attached resources (images, logs) into the
  bundle; write one or more markdown analysis files (e.g. `root-cause.md`,
  `fix-plan.md`) into `.krypton/analyses/<owner>/<repo>/<number>/`. The lane uses
  `gh`/`curl`/its edit tool; report `phase: investigating` then a summary.
- **`#tag-github-issue`** — prompt: choose/confirm labels and apply with
  `gh issue edit <n> -R <repo> --add-label …`.
- **`#post-github-comment`** — prompt: draft a comment and post with
  `gh issue comment <n> -R <repo> --body …`. **Writes to GitHub immediately.**
- **`#fix-github-issue`** — prompt: implement the fix for the issue **in the
  current lane** (edit code, run tests). This is the injectable "fix" building
  block, distinct from dispatch.
- **`#create-github-issue`** — prompt: file a NEW issue from a plain-language
  request. Unlike the others it takes free text (with an optional `-R owner/repo`)
  rather than an issue ref, so it uses no `parseIssueRef` and is **not injectable**
  (it has no existing issue to back-reference as a token). Drafts a title + body and
  runs `gh issue create …`. **Writes to GitHub immediately.**

**Audience convention (all human-facing output).** The verbs that produce prose a
person will read — `#analyze-github-issue` (the markdown analysis), `#post-github-comment`
(the thread comment), and `#create-github-issue` (the issue title + body) — instruct
the lane to write in **plain, natural Thai composed from scratch** (not a word-for-word
translation from English) for a non-technical reader, and to end the document/comment/body
with the footer `🤖 Analyzed by AI (Claude <MODEL_NAME>)`.

### The per-issue bundle

`.krypton/analyses/<owner>/<repo>/<number>/` is a folder holding a lane's analysis
markdown (multiple files) plus resources it downloaded from the issue. It survives
on local disk but is **gitignored** — not committed, not in a PR, not shown by the
Docs browser (which filters through `.gitignore`). That is intentional: it is
working knowledge for the fix, not repo documentation. (Promoting an analysis into
committed `docs/` is out of scope.) The bundle is read back through the dedicated
**Issue Analysis Viewer** loopback surface (`#analyses`, spec 192), which walks
`.krypton/analyses` directly instead of the gitignore-filtered Docs tree.

### Discoverability (spec 185 reuse)

New verbs appear in the `#` palette and the `/commands` page automatically via
`HASH_COMMANDS` + `commandMeta`. Composed verbs render with an `anatomy` line
(`analyze → fix → comment`) naming embedded verbs, and the manifest shows the
**resolved** prompt (tokens already substituted) so a reader sees exactly what the
lane receives.

### The composed verb

`#handle-github-issue <url>` — built-in composed verb whose prompt prose embeds
`{{#analyze-github-issue}}`, `{{#fix-github-issue}}`, `{{#post-github-comment}}`
with the author's connective/conditional instructions between them (e.g. "if this
is a duplicate, skip the fix and only comment"). Resolved to one prompt at
invocation.

### Inline verb injection into a user prompt

The token resolver is not limited to harness-authored composed verbs — it also runs
over a **free-form user prompt**. When the user submits a normal message (not a
`#`-command, not `!`-shell) that contains one or more `{{#verb}}` tokens, the
composer expands each token to its rendered prompt **in place, at whatever position
the user typed it**, before the prompt is queued or sent. A user can therefore write:

```
Focus on the auth module first, then {{#analyze-github-issue}} and give me a summary.
```

and the lane receives the surrounding prose with the analyze verb's prompt spliced in.

- **Hook point.** `AcpHarnessView.submitLanePrompt`, after the `#`/`!` routing and the
  lane-ready guard, before the busy-queue branch — so a prompt queued while the lane is
  busy stores the already-resolved text and the drain path sends it verbatim (expanded
  once, idempotently).
- **Same registry + resolver.** Uses `resolveVerbTokens` + `injectableVerbPrompt`
  (`verb-registry.ts`); only injectable prompt-verbs expand. A control-op token
  (`{{#dispatch-github-issue}}`), a creation verb that takes free text
  (`{{#create-github-issue}}`), an unknown token, a cycle, or excessive nesting throws
  `VerbCompositionError` → `flashChip` → nothing sent (never a half-expanded prompt).
- **Embedded tokens resolve to the back-reference variant** ("the GitHub issue you are
  working on"), because the token carries no ref — exactly as inside a composed verb.
  When the user wants a concrete issue, they use the direct command form instead
  (`#analyze-github-issue <url>`).
- **Transcript shows the resolved text** (what the lane actually received), consistent
  with how composed verbs already send one combined prompt.

#### Autocompletion (the `{{#` syntax is never typed by hand)

Typing `{{#verb-name}}` by hand is tedious, so the composer autocompletes it from a bare
`#`. A dedicated **inline verb palette** (`verb-palette.ts`) is cursor-aware: when the
user types a bare `#<prefix>` at **any position** of a prompt, it offers the injectable
verbs and, on **Tab**, inserts the full `{{#verb-name}}` token in place — the user never
types the braces.

- **Trigger.** `verbPaletteContext(draft, cursor)` matches a `#<token>` ending at the
  cursor whose `#` sits at text start or right after a non-token char — so `foo #ana`,
  `line #ana`, and a half-typed `{{#ana` trigger, but `issue#42` / `a#b` do not.
- **Distinct from the `#command` palette.** The whole-draft `#command` palette
  (`hash-commands.ts`) still owns a bare leading `#token` (it dispatches a command and
  lists every `#` command); the inline verb palette suppresses itself in that case
  (`hashPaletteVisible(draft, false)` regex check) and otherwise offers **only injectable
  verbs** (`injectableVerbNames()`), so the two never show at once.
- **Insertion.** `applyVerbSelection` replaces the `#<prefix>` with `{{#name}}` and, if
  the user had already typed a leading `{{`, absorbs it so the result is never `{{{{#…}}`.
- **UI reuse.** Same palette chrome, navigation (↑↓ / ⌃n⌃p), and dismiss (Esc) as the
  mention/slash/command palettes; parallel lane state `verbPaletteIndex` /
  `verbPaletteDismissed`, reset on every draft change.

## Edge Cases

- **Cycle / runaway nesting** → resolver throws; `flashChip` shows `#verb: cyclic
  composition` / `depth exceeded`; nothing sent.
- **Unknown token** (`{{#typo}}`) → throws at invocation; surfaced, not sent
  literally.
- **`gh` missing/unauthed** → the issue-write verbs behave like spec 178's
  fallback: the prompt tells the lane the write may fail and to report `blocked`
  via `issue_progress` rather than pretending success.
- **Composed verb embeds a control-op token** (`{{#dispatch-github-issue}}`) →
  rejected by the resolver: control-op verbs are not in the injectable `lookup`.
- **Alias** — `#fix-issue` continues to dispatch (maps to
  `#dispatch-github-issue`), so spec-178 docs/extension references keep working.

## Decisions (resolved in grilling, 2026-07-07)

1. **Deliverable is verbs, not MCP tools.** Each capability is a built-in prompt
   verb; the lane executes with its own `gh`/edit/bash. (Supersedes an earlier
   MCP-tool framing — executing tool, reply-timeout, tool-shape — all dropped.)
2. **Composition = inline token substitution, single turn (ADR-0012).** Not a
   serial pipeline, not a multi-turn runner, not `composedOf: []`.
3. **Writes execute-then-observe (no human gate).** `#tag`/`#post-comment` write
   immediately; the harness observes via `issue_progress`. The human accepted this
   trade-off (§Risk).
4. **Analysis bundle lives at `.krypton/analyses/<owner>/<repo>/<number>/`** —
   gitignored working knowledge, multiple files incl. downloaded issue resources.
5. **Naming pattern `#<action>-github-<object>`** for the new verbs.

### Open for approval

- **The `#fix-issue` → `#dispatch-github-issue` rename + new `#fix-github-issue`
  prompt-verb.** The grill settled on renaming the *existing dispatch* to
  `#dispatch-github-issue` (alias `#fix-issue`) so the clearer name
  `#fix-github-issue` is free for the injectable fix-in-place prompt-verb the
  composed verb needs. Confirm this split (two distinct "fix" concepts, two names)
  — the alternative is to leave dispatch as `#fix-issue` and name the prompt-verb
  something else.

## Risk

A composed verb ending in `{{#post-github-comment}}`, or `#post-github-comment`
called directly, posts to a public GitHub thread within the turn, with no approval
step (decision 3). A wrong comment is visible immediately and hard to undo. This is
the author's/user's explicit choice; verbs that write should say so in their
palette description, and `#handle-github-issue`'s prose should gate the comment on
the fix being verified.

## Out of Scope

- Human approval gate before GitHub writes (execute-then-observe chosen).
- Arg-bearing tokens (`{{#verb arg}}`) — v1 tokens are bare.
- User-authored / config-defined verbs or composed verbs — v1 roster is built-in.
- Multi-turn or cross-lane workflows (that is orchestration, spec 180).
- Promoting a `.krypton/analyses/…` bundle into committed repo docs.
- GitHub Enterprise / non-`github.com` hosts (per spec 178).

## Resources

- ADR-0012 — verb composition is inline token substitution.
- Spec 178 (GitHub issue fixing), spec 190 (issue_progress auto-bind), spec 185
  (`/commands` manifest), spec 136 (`queuedPrompts`, deliberately not reused).
- `CONTEXT.md` → **Verb**, **Composed verb**.
