# Git AI Commit Message and Key Hints — Implementation Spec

> Status: Implemented (approved 2026-11-16)
> Date: 2026-11-16
> Milestone: ACP Harness — Git dock
> Builds on: 396 (Git panel), 306 (fenced assist transport), 369 (key caps)
> Amends: 396 commit editor and footer hints

## Problem

The Git dock has no action to draft a commit message from staged changes. Its existing hints form a wrapping sentence: several keys have no action label, columns do not align, and separator dots can end a line. The user requested AI drafting and an organized layout for both new and existing hints.

## Solution

Add an explicit **AI DRAFT** action beside **COMMIT**. It generates editable text from the index only; it never stages, commits, pushes, or sends a lane prompt. Keep the existing editor and human-triggered commit path. Replace the dock's dot-separated hints with locally scoped, aligned grids of key/action pairs.

## Research

- `HarnessGitController` owns the message, mutations, project epoch and input routing; `GitDock` is props-only. Preserve that split and textarea identity.
- `keyHintNodes()` inserts separator text nodes between atomic `.krypton-key-hint` spans. `GitDock` supplies empty labels for `j/k`, `r`, and `Esc`; its footer has no grid layout. The change is local to Git, not the shared hint helper.
- `AcpAssistSession` and `AssistEngine` already provide a fenced subprocess, cancellation, setup/prompt deadlines, and classified errors. Rails already owns a separate engine/session; Git follows that ownership pattern rather than interrupting lane assist work.
- `collect_working_diff(staged: true)` excludes unstaged/untracked content but uses the uncapped collector. A new index-only panel reader reuses `run_git_capped` (5s, 2 MiB), so a large diff fails before creating an unbounded prompt.
- Assist backend/model and budgets already have generic TOML overrides under `assist.tasks.<id>`. `resolveAssistConfig` only reads `id` and `defaults`; narrow its parameter to that pair rather than inventing a fake registered task.

## Prior Art

| App | Observed implementation | Krypton choice |
|---|---|---|
| VS Code | Source Control sparkle action drafts a commit message from code changes | Explicit action in the commit editor, editable result |
| Zed | `generate_commit_message` uses staged changes when present, otherwise worktree changes; a running action offers cancellation | Allow cancellation, but require staged changes to match Krypton's index-only Commit |

Krypton keeps visible keyboard access and labelled physical keys, not an unexplained sparkle icon. No fallback to the whole working tree.

## Affected Files

| File | Change |
|---|---|
| `src/acp/harness-git-controller.ts` | AI request lifecycle, keyboard/click routing, stale-result gates, injected dependencies |
| `src/acp/components/git-dock/index.ts` | AI action/state and labelled hint groups |
| `src/acp/components/git-dock/git-dock.css` | Local hint grids, action layout and steady running state |
| `src/acp/git-commit-message.ts` (new) | Pure prompt/payload/parser and assist configuration defaults |
| `src/acp/assist/config.ts` | Accept `Pick<AssistTask<unknown>, 'id' \| 'defaults'>` without changing merge semantics |
| `src/acp/acp-harness-view.ts` | Supply the Git sidecar's owner identity |
| `src-tauri/src/git.rs` | Capped, read-only staged context plus fingerprint |
| `src-tauri/src/commands.rs`, `src-tauri/src/lib.rs` | Expose/register the context command |
| `src/acp/harness-git-controller.test.ts`, Rust Git tests | Extend coverage for consumer-visible race and scope edges |
| `docs/0396-harness-git-panel.md`, `docs/0005-data-flow.md`, `docs/0006-configuration.md`, `docs/README.md` | Update the editor contract, flow, settings and index |

## Design

### Context and AI call

```ts
interface GitCommitContext {
  readonly repoRoot: string;
  readonly diff: string;
  readonly fingerprint: string;
}
// Added to GitPanelApi:
commitContext(cwd: string): Promise<GitCommitContext>;
// Added to HarnessGitHost:
assistOwner(): AcpInstanceOwner;
```

`git_panel_commit_context({ cwd })` runs on the blocking pool after the existing panel repo-root gate. Fixed argv: `git --no-pager diff --cached --no-ext-diff --no-textconv --no-color --full-index -M --`. No caller-supplied arguments, shell, external diff driver or Git mutation. Empty output is `nothing staged`; nonzero exit, timeout or size overflow is an error. Return camelCase fields; `fingerprint` is SHA-256 of the full returned diff. Binary/mode-only changes retain their Git metadata. No patch, draft or model output is logged.

The pure `AssistCall<string, { diff: string; draft: string }>` has id `commit-message`. Its payload includes the staged patch and the current draft, clearly delimited as untrusted data. The prompt asks for an English imperative subject (aim for 72 characters) and an optional short body, preserving identifiers; no fences, commentary, invented tests or tool use. The parser trims plain text, rejects empty output, NUL, fenced answers and output over 100,000 UTF-8 bytes. It does not silently rewrite content.

Use a lazily created, Git-owned `AcpAssistSession` and `AssistEngine`; owner role `assist`, label `Git commit message`, harness identity supplied by the host, lane id null, local runtime only. Reuse the configured assist backend/model with optional `[acp_harness.assist.tasks.commit-message]` backend/model/timeout/input overrides. Defaults: existing backend fallback (`claude`), backend-default model, `timeout_ms = 20000`, `max_input_chars = 20000`; existing clamps apply. This is a click/key-only Git action, not a registered lane task: `assist.mode` continues to govern registered lane tasks and does not disable this explicit action. No automatic generation, new credentials or automatic task enablement.

Require the **whole** serialized payload to fit `max_input_chars` before calling the engine. If too large, show `Staged changes exceed the AI input limit; stage a smaller commit.` Do not silently truncate or summarize only the first files.

### Request lifecycle

1. AI DRAFT requires a local project, a loaded repo, staged rows, no conflicts, no mutation and no existing generation. Recheck the actual index through the context command before spending a prompt.
2. Capture project epoch, message edit revision and full staged context. Keep the editor usable. The action becomes **CANCEL AI** with a steady running key state; generation never changes transcript rows.
3. Run one fenced completion. On completion, reread staged context and compare repo root/fingerprint; require the same project epoch and message edit revision before applying the text.
4. If valid, fill the existing textarea and focus it only if focus is still inside this dock. The human edits it and explicitly commits as before.
5. If the user types (including changing the draft and changing it back), cancels, switches project or disposes the view, invalidate the request. An edited draft always wins. AI failure or a changed index preserves the draft and reports the cause; no automatic retry.
6. Stage/unstage/discard and Commit are disabled/refused while AI runs. External Git changes are still caught by the final fingerprint check. Clicking CANCEL AI or pressing its chord cancels; no automatic commit follows success. Hiding the Git tab cancels without moving focus. Dispose cancels and disposes the session; a session finishing setup after cancellation must also be disposed.

### Keyboard and layout

| Context | Key | Action |
|---|---|---|
| Git list | `g` | AI draft; cancel if already running |
| Commit textarea | Cmd/Ctrl+Shift+G | AI draft; cancel if already running |
| Existing contexts | Existing keys | Unchanged; IME input still passes through |

The new textarea chord must be intercepted by both `passesToField` and `handleDockKey`, before the harness's global shortcuts. Bare `g` in the textarea remains typed text. Discard confirmation retains priority over list `g`.

**Commit well:** textarea, then a dedicated row of **AI DRAFT / CANCEL AI** and **COMMIT** keys, then a labelled hint grid. List focus shows `c edit`, `g AI draft/cancel`, `⌘Enter commit` with the commit chord labelled as field-only; field focus shows `Esc list`, `⌘⇧G AI draft/cancel`, `⌘Enter commit`. Keep the action row separate so buttons never squeeze the hints. Key states follow DESIGN.md, without spinner, infinite animation, coloured border or frame glow.

**Original footer:** replace the continuous sentence with the following stable reading order:
- Navigation: `j/k move`, `Enter diff`, `r refresh`.
- Selected file: `s stage`, `u unstage`, `x discard`.
- Whole list / exit: `S stage all`, `U unstage all`, `Esc composer`.

Use the existing key-cap builder with **no separator nodes**, one atomic key/action hint per grid cell. Three aligned columns at the standard 352px dock; two when the dock's content width is under 320px, one under 240px. Scope container queries and styles to `.acp-git-dock`; do not alter other surfaces. Cells are content-sized, key/action pairs never split, no ellipsis or clipping of shortcuts. If user font size makes even one cell wider than the dock, scroll the hint region horizontally instead of shrinking text. Discard confirmation is a separate wrapping sentence, not a grid of fake hints. Preserve all `[hidden]` overrides.

## Edge Cases and Verification

- No staged changes, conflicts, remote harness or missing repo: action disabled with an accessible reason; keyboard path reports the same reason and starts no AI call.
- Already running: the same AI action cancels rather than starting a second request. A mutation cannot race a still-valid result.
- Index changed, project changed, hide/dispose, typed-then-restored draft: deterministic controller tests prove that old output never overwrites the message.
- Backend/model missing, timeout, invalid/empty response, read/size failures: retain the draft, show a clear error, allow a later explicit request subject to the existing per-call breaker.
- Extend controller tests for the real click/key paths, preserving typed `g`, plain Enter and IME handling. Extend Rust tests for staged-only context, unchanged worktree/index, binary/mode-only metadata and fingerprint changes.
- Verify the actual Git dock component with host/reset/keycap/material CSS in a browser at 352px, 280px and 220px, dark/light, list/field focus, generating/disabled/confirm states. Inspect bounding boxes for aligned cells, unbroken key/action pairs, visible labels and no horizontal overflow at standard size. Verify tab hiding via computed visibility.
- Prove the AI-to-editor path through the normal app runtime when an authenticated backend is available. Otherwise report the live-model verification limit explicitly; injected completions prove races, not model availability.

## Implementation Notes

- The controller owns a lazy, separate assist engine/session. Cancellation retires that
  session immediately and again after any in-flight setup settles, without disposing a
  newer request's session. A project change also retires a warm session.
- Editor input cancels generation immediately; a monotonic edit revision protects a
  draft even when the user changes it back to its original text.
- Commit hints use two columns with the commit chord spanning the next row; the original
  footer uses the specified three/two/one-column layout.
- Verification used the actual controller/component with host CSS and shipped theme
  palettes. The AI-to-editor browser path used an injected completion; a live,
  authenticated model call was not exercised.

## Open Questions

None. Approval covers the interpretation of “comment” as **commit message**, staged-only input, explicit draft replacement and the local Git hint layout above.

## Out of Scope

Posting GitHub comments, commit/push automation, unstaged fallback, shared hint-helper redesign, other dock footers, remote Git, model picker UI, diff chunking, commit-history sampling, and unrelated existing changes.

## Resources

- [VS Code AI smart actions](https://code.visualstudio.com/docs/editing/copilot-smart-actions) — Source Control commit-message generation.
- Zed local source: `/Users/wk/Source/zed/crates/git_ui/src/git_panel.rs`, `generate_commit_message` and `render_generate_commit_message_button` — index/worktree choice and cancel action.
- Internal: specs 306 and 396; `src/acp/assist/{acp-completion,engine,config}.ts`, `src/ui/kbd.ts`, `src-tauri/src/git.rs`, DESIGN.md.
