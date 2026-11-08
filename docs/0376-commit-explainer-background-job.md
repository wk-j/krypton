# Commit Explainer Background Job — Implementation Spec

> Status: Implemented
> Date: 2026-11-08
> Milestone: Git — learning from history
> Builds on: 0375 (Commit Browser, `learnCommitPrompt`) · 0333 (Inline AI headless session) · 0357 (Assistant instances)

## Problem

The Commit Browser's `e` only works when an ACP Harness is already open in the repo with an idle
lane (`NOTIFY_OPEN_HARNESS`, `NOTIFY_NO_IDLE_LANE`). The user wants the explainer to run on its own
background ACP instance, like an assistant, with no Harness lane opened first, on `codex` with
GPT-6.1 Sol.

## Solution

`e` hands the commit to a new app-level `CommitExplainer` service. Each job spawns its own `codex`
ACP process whose working directory is a fresh scratch dir, forces codex's `workspace-write` mode
(OS sandbox: writes only to the working dir, `$TMPDIR` and `/tmp`, no network) and declines every
approval request. The agent reads the repo read-only, runs repros in the scratch dir and writes
the draft there. After `end_turn`, Rust copies the draft into the knowledge dir. Up to
`[knowledge] parallel` jobs (default 2) run at once and the rest wait in a queue. Jobs outlive the
browser. The row lamp shows the state, and a toast reports the result. `#learn <sha>` in a Harness
lane stays as it is.

## Research

- **Codex does its own I/O.** codex-acp 2.5.0 (the copy npx has cached locally) never calls ACP
  `fs/*` or `terminal/*`. Commands and patches run inside codex's own sandbox, and Krypton
  advertises `terminal: false` anyway (`acp.rs:2621-2633`). Krypton's write scope
  (`fs_path_in_scope`) and `fs_write_pending` never see a codex write. The only levers are the
  session **mode** and the answers to `session/request_permission`.
- **codex-acp modes** (`src/AgentMode.ts`): `read-only` (nothing writable), `workspace-write` (cwd +
  `$TMPDIR` + `/tmp`, no network, user approves escalations), `agent` (the default: the same sandbox,
  but codex's auto-reviewer may approve escalations without asking the client), `agent-full-access`
  (no sandbox, never asks). The Harness never sets a codex mode, so its lanes run in `agent`. Only
  `workspace-write` routes every escalation to Krypton.
- **Declining.** The headless fence answers `null`, which codex maps to `cancel`, and `cancel`
  stops the turn. Some command requests also offer `decline` (reject_once, "continue without
  running"), and picking the first `reject_once` option uses it when present. A **sandbox
  escalation offers only `cancel`** (smoke, codex-acp 2.5.0: `touch` into the repo offered
  `allow_once`, `accept_execpolicy_amendment`, `cancel`), so the turn ends anyway. The job then
  sends a continuation turn on the same session ("declined, stay inside the sandbox, finish"); in
  the smoke the agent carried on and wrote the draft.
- **Models.** Codex advertises one id per effort, `model[effort]` (e.g. `gpt-5.6-sol[high]` in
  `usage-log.test.ts`). `set_model` with an id that is not advertised is rejected. `acp_spawn`
  applies `[acp_harness.lane_models.codex].active` before the caller's own `setLaneModel`. OpenAI
  lists the model as `gpt-6.1-sol`.
- **Headless patterns in the repo.** `InlineAcpSession` (spec 333) keeps a warm process per
  pane cwd, runs a serial queue and fences every request with `answerFencedRequest`. It also sets
  the asking mode explicitly, because a user default could approve on its own. The new service
  copies the explicit mode and the fence, but uses one process per job because the cwd differs
  for every job.
- **Alternatives ruled out:**
  - *The assist engine (`AssistEngine` + `AcpAssistSession`, spec 306):* it is built for one
    no-tool completion. The transport fences every request and never sets a mode ("A one-shot
    that needs a tool has already gone wrong", `acp-completion.ts:11`), so codex can run neither
    `git show` nor a repro. Its other limits:
    - The deadline is capped at 20 s for assist and 180 s for Rails.
    - The payload is capped at 20k/80k characters, while p90 commits run to 2,833 changed lines.
    - It is single-flight: a new run aborts the one in flight.
    - A per-task breaker cools down after three failures.
    - One warm session carries context across calls.
    - The session's cwd and owner come from a Harness.

    A no-tool variant would have Krypton inline the diff and drop "How this was checked", which is
    the spec 375 contract.
  - *cwd = repo root:* the sandbox would make the repo writable, and only the prompt would stop
    the agent.
  - *cwd = knowledge dir* or *`additionalDirectories`*: the whole library becomes writable, and it
    may be an Obsidian vault folder. The second also needs a `session/new` change.
  - *Markdown in the final reply:* replies carry chatter. A file has a clear boundary.
  - *A hidden Harness lane:* it drags in the whole Harness view.
  - *Unbounded parallel jobs:* one `e` per row would start that many codex processes and drain the
    codex quota in a burst. A small cap (`parallel`, default 2, 1–4) keeps the rest queued.

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| Codex CLI `codex exec` | Non-interactive run. Default sandbox `read-only`; `--sandbox workspace-write` allows edits. Nobody can answer approvals, so automation presets the sandbox. `-o` writes the final message to a file. | The closest model: preset sandbox, no human. |
| Cursor Cloud Agents | Each run gets its own isolated VM; "you can close your laptop and check the result later"; results come back as artifacts. | Cloud, not local. |
| GitLens Explain Commit | One AI call from the commit graph renders a markdown summary. | No tools, not stored. |
| JetBrains AI Assistant | Log → *Explain Commit* → answer in the chat window. | Needs the chat. |

**Krypton delta:** like `codex exec --sandbox workspace-write`, but driven over ACP. It reuses the
user's codex login, appears in the Assistants dock, and runs locally. The output lands in the
knowledge library, and progress shows as a lamp instead of a chat.

## Affected Files

| File | Change |
|------|--------|
| `src/commit-explainer.ts` (new) + `.test.ts` | `CommitExplainer` service: bounded parallel queue, job run, fence, cancel, change events |
| `src/compositor.ts` | Owns one lazily created `CommitExplainer`, hands it to each browser and routes its outcomes to `showNotification`; the browser's `harness:lane-idle` subscription is removed |
| `src/commit-browser-view.ts` + `.test.ts` | `e`/`E` start a job, `x` cancels it, lamps and preview read job state. Picker, `repoHarnesses`, `sendLearn`, `settlePending`, `onHarnessLaneIdle` and the two Harness notices are removed. |
| `src/styles/commit-browser.css` | Drop the picker rules and keep the help overlay rules they share |
| `src/acp/harness-prompts.ts` + `.test.ts` | `learnCommitPrompt` gains `repoRoot` + `scratch`; the lane text is unchanged |
| `src/acp/acp-harness-view.ts`, `src/acp/control-types.ts` | Remove the `lane.learn` op and the `'commit_browser'` caller source. `#learn` stays. |
| `src/acp/components/lane-learn-control-integration.test.ts` | Delete (tests the removed op) |
| `src-tauri/src/knowledge.rs`, `commands.rs`, `lib.rs` | `knowledge_job_prepare`, `knowledge_store` + tests |
| `src-tauri/src/config.rs`, `src/config.ts` | `[knowledge] backend / model / mode` |
| `src-tauri/src/acp.rs`, `src/acp/types.ts`, `src/assistant-instance-store.ts`, `src/acp/components/assistant-instances/index.ts` | Instance role `commit_explainer`, labelled "Commit explainer" |
| `docs/0375-commit-browser.md`, `0004`, `0006`, `0072`, `README.md` | The runner, config, the removed op, the index |

## Design

### Data Structures

```ts
type ExplainState = 'queued' | 'running';
interface ExplainJob {
  readonly root: string; readonly repoName: string; readonly sha: string;
  state: ExplainState;
  startedAt: number | null;   // ms; set when running starts
  activity: string | null;    // latest tool_call title
}
type ExplainChange =
  | { kind: 'update'; job: ExplainJob }
  | { kind: 'ready'; job: ExplainJob; path: string }
  | { kind: 'failed'; job: ExplainJob; message: string }
  | { kind: 'cancelled'; job: ExplainJob };

class CommitExplainer {
  start(root: string, repoName: string, sha: string): ExplainJob; // existing job for (root, sha) → returned as-is
  cancel(root: string, sha: string): boolean;
  job(root: string, sha: string): ExplainJob | null;
  queuedAhead(job: ExplainJob): number;
  subscribe(listener: (c: ExplainChange) => void): () => void;
}
```

```rust
#[serde(rename_all = "camelCase")]
pub struct KnowledgeJob { pub scratch: String, pub draft: String, pub path: String, pub repo: String }
```

### API / Commands

| Command | Signature | Notes |
|---|---|---|
| `knowledge_job_prepare` | `(cwd, sha) -> KnowledgeJob` | The same checks as `knowledge_write_path` (commit id, `<sha>^{commit}`, creates the knowledge dir). Recreates an empty `<temp_dir>/krypton-learn/<repo>-<sha7>/` and returns it, `draft = <scratch>/explainer.md`, and `path = <dir>/<repo>-<sha7>.md`. |
| `knowledge_store` | `(cwd, sha) -> String` | Derives the same scratch dir; TS never passes a path. The draft must exist, be non-empty UTF-8 and be ≤ 1 MiB. Rust writes `<path>.tmp` and renames it over `path`, removes the scratch dir and returns `path`. A missing draft gives `Err("finished without writing explainer.md")`. |

`knowledge_write_path` stays for `#learn`.

### Data Flow

```
1. e on a row → explainer.start(root, repoName, sha) → job 'queued' → lamp pending
2. fewer than `parallel` jobs running → run it ('running', startedAt); else wait FIFO
3. invoke knowledge_job_prepare(root, sha) → {scratch, draft, path, repo}
4. AcpClient.spawn(backend, scratch, {role:'commit_explainer', label:`explain <repo>@<sha7>`})
   → initializeOnly → install the job fence (below) → sessionNew
   → model ≠ "" → setLaneModel(model); a rejection fails the job and lists the advertised ids
     that share the part before `[`
   → setSessionMode(mode); a rejection fails the job: never run in the backend's default mode
5. prompt(learnCommitPrompt({sha, repo, language, path: draft, scratch, repoRoot: root}))
   each tool_call → job.activity = title → 'update'
6. stop must be end_turn → invoke knowledge_store(root, sha) → 'ready' {path}
   any failure → 'failed' {message}; the client is always disposed; the next queued job takes
   the freed slot
7. compositor: 'ready' → toast "Explainer ready — <repo>@<sha7>"; 'failed' → "Explain <sha7>
   failed — <message>". Browser: repaint the lamp, and on 'ready' re-run knowledge_list
```

**Job fence** (in `commit-explainer.ts`, the shared `headless-fence.ts` is untouched): a
`permission_request` gets the first `reject_once` option, or `null` when there is none.
`fs_write_pending` is refused. `ask_user_question` / `elicitation_request` cancel the turn and fail
the job. Nothing is ever approved, so a job can do only what `workspace-write` allows without
asking. A turn that a declined approval stopped (`cancelled` after a decline) gets a continuation
turn, `DECLINED_CONTINUE_PROMPT`, at most `EXPLAIN_MAX_CONTINUATIONS` (3) times; the next one fails
the job with `kept asking for approval`.

**Prompt, background variant.** `learnCommitPrompt` keeps its contract text and changes only where
the work happens:
- The repo path (data) is outside the working dir and read-only: run `git -C <root> …` and read
  files by absolute path.
- The scratch dir is the working dir, where repros run.
- The output path is the draft.
- Nobody watches the run: never ask a question, and work inside the sandbox, because any request
  for approval is declined.

With `repoRoot: null` the lane variant renders today's text byte for byte.

**Cancel.** `x` on a pending row: a queued job leaves the queue. A running job gets `cancel()`, and
its process is disposed after 5 s (`CANCEL_GRACE_MS`). Either way the job ends `'cancelled'`.

### Keybindings

| Key | Context | Action |
|-----|---------|--------|
| `e` / `E` | Commit Browser | Queue an explainer job (`E` overwrites an existing doc), no Harness needed |
| `x` | Commit Browser | Cancel the selected row's queued or running job |

### UI Changes

- Lamp: `pending` (amber) while queued or running; there is no new lamp state.
- Preview of a pending row: `explain · queued (N ahead)`, or `explain · codex · <model> · since
  14:02 · <activity>`. It shows a start time rather than a ticking timer, so nothing repaints on its
  own.
- Help row `e` reads "explain in the background", plus a new `x` row. The lane picker DOM is removed.
- Assistants dock: one `commit_explainer` row per running job.

### Configuration

```toml
[knowledge]
dir = "~/.config/krypton/knowledge"
language = "Thai"
backend = "codex"            # ACP backend that runs explainer jobs
model = "gpt-6.1-sol[high]"  # an id the backend advertises; "" keeps the backend default
mode = "workspace-write"     # agent-side mode; it must sandbox writes to the working dir
parallel = 2                 # jobs that run at once, clamped to 1–4; the rest queue
```

Read when each job starts, so **Reload Config** applies to the next job. The sandbox guarantee holds
only for codex `workspace-write`. Another backend or mode is the user's call. Under Claude's
asking mode, for example, `git show` is declined.

## Edge Cases

- **Browser closed mid-job:** the job continues and the toast still fires. Reopening the browser
  shows the lamp from `explainer.job()`.
- **`e` on a pending row:** flash `<sha7> is already explaining`. **`e` on a ready row:** unchanged
  (`NOTIFY_ALREADY_EXPLAINED`).
- **codex missing, logged out, or the first npx download (≤ 300 s):** the preview shows `starting
  codex`. A spawn or `session/new` error fails the job with the adapter's message.
- **Agent tries to write the repo or use the network:** the sandbox blocks it, the request is
  declined, and the job sends a continuation turn when codex's `cancel` ended the turn.
- **`end_turn` without a draft:** `failed — finished without writing explainer.md`.
- **Draft over 1 MiB or not UTF-8:** failed, and the knowledge doc is untouched.
- **`#learn` and a job write the same doc:** last writer wins (rename), which is accepted.
- **WebContent reload:** the queue is lost and running processes live until app exit, the same as
  Inline AI's warm process. Their drafts are never stored.
- **Parallel jobs on a cold npx cache:** each job runs its own `npx -y …@latest`, as several codex
  Harness lanes already do on restore.

## Open Questions

None. Decisions taken:
- the lane path (`lane.learn`, picker) is removed and `#learn` stays;
- up to `parallel` jobs (default 2) run at once, the rest wait in a queue;
- a declined approval that ends the turn gets up to 3 continuation turns (implementation-time
  deviation: the draft assumed `decline` always keeps the turn alive).
- the default is codex `gpt-6.1-sol[high]` in `workspace-write`.

## Out of Scope

Re-running a failed job, a timeout, a sound cue, a job list outside the browser (the Assistants dock
shows the process), restoring jobs after a reload, SSH repos, and changing `headless-fence.ts` for
Inline AI or assist.

## Resources

- [codex-acp `src/AgentMode.ts`](https://github.com/agentclientprotocol/codex-acp/blob/main/src/AgentMode.ts) — mode ids, sandbox and approval policy per mode
- [codex-acp README](https://github.com/agentclientprotocol/codex-acp) — `INITIAL_AGENT_MODE`, runtime env, mode selection
- [codex-acp permission profiles](https://github.com/agentclientprotocol/codex-acp/blob/main/docs/permission-profiles.md) — `session/set_mode` selection, `runtimeWorkspaceRoots` = cwd
- [codex-acp issue #310](https://github.com/agentclientprotocol/codex-acp/issues/310) — modes override config.toml sandbox; full access never raises requests
- [Codex non-interactive mode](https://developers.openai.com/codex/noninteractive) — `codex exec` sandbox presets for unattended runs
- [GPT-6.1 Sol model page](https://developers.openai.com/api/docs/models/gpt-6.1-sol) — model id `gpt-6.1-sol`
- [Cursor background agents](https://cursor.com/help/ai-features/background-agents) — background run model, report back on completion
- [GitLens 17.1](https://gitkraken.com/blog/gitlens-17-1-visual-history-reimagined) · [JetBrains AI in VCS](https://jetbrains.com/help/ai-assistant/ai-in-vcs-integration.html) — commit-explain UX (from spec 375)
