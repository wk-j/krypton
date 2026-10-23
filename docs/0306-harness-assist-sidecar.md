# Harness Assist — cheap-model turn sidecar

> Status: Implemented; the `next-prompt` task and its `AssistStrip` were removed on 2026-10-23 (see the last addendum)
> Date: 2026-10-17
> Milestone: ACP Harness — composer
> Builds on: 0072 (harness view) · 0069 (ACP client) · 0275 (feature controllers) · 0301/0302 (component kernel) · 0285 (ghost text, the other composer suggestion) · 0136 (prompt queue) · 0126/0127 (`session/set_model`) · 0257 (TypeSafe suggestion discipline)

## Problem

When a lane turn ends, the human has to invent the next prompt from scratch. Nothing in Krypton reads a finished turn and proposes what to send next: ghost text (0285) is a local n-gram over past prompts, the prompt queue (0136) assumes the human already knows, and the only model that ever sees the transcript is the expensive lane agent itself.

## Solution

A per-harness **sidecar**: a cheap model post-processes the turn that just ended on the **active** lane. It reaches that model **the same way a lane does — through an ACP backend subprocess** (`claude`, `codex`, `omp`, …), so it needs **no API key**: the backend CLI's own login is the credential.

The engine is task-agnostic. It bounds the payload, makes one deadline-limited call, parses strictly, and owns every cost guard. *What* to ask the model is an **`AssistTask`**: one file declaring a system prompt, a payload builder, a strict parser, and its own extra gate. v1 registers exactly one task — `next-prompt`, which returns at most three suggested next prompts as a numbered strip above the draft line. `Cmd+1..3` loads one **into the composer** (never sends it), `Cmd+0` dismisses, `Cmd+/` asks again. Default `mode = "off"` because the call spends the same subscription quota the lane agents spend.

> Later additions: the `grammar` task (`'panel'` surface, addendum below) and the `follow-up` task (`'transcript'` surface, spec 323 — [0323](0323-harness-follow-up-actions.md)). The `next-prompt` task described below was removed on 2026-10-23; the last addendum says what remains.

No new Rust and no new Tauri command: `AcpClient` already does spawn → `initialize` → `session/new` → `session/set_model` → `session/prompt` → `dispose`. The request guards (deadline, single-flight, stale-drop, circuit breaker) come from the TypeSafe suggestion path (0257), implemented client-side.

## Research

**`AcpClient` is usable headlessly today.** `spawn(backendId, cwd, mcpServers, junie, cline, remoteRuntimeId)` (`src/acp/client.ts:86-107`), `initializeOnly()` (`:144`), `sessionNew()` (`:155`), `setLaneModel(modelId)` (`:184`), `onEvent(cb)` (`:191`), `prompt(blocks)` (`:199`), `cancel()` (`:229`), `dispose()` (`:266`). Nothing in it touches a lane or the view, and the session picker already spawns a non-lane client (`acp-harness-view.ts:10045-10100`) — but **nothing in the repo prompts headlessly**, which is the gap this spec fills. `acp_spawn` injects `cached_login_env()` and never reads an API key.

**Assistant text and turn end.** Text arrives as `session/update` → `agent_message_chunk` → `{ type: 'message_chunk', text, content }` (`client.ts:294-296`, `:465-474`); `thought_chunk` is a separate event and is excluded. Per the ACP spec the `session/prompt` **response** is the turn-end signal — `await client.prompt(...)` resolving *is* the end of the turn (`client.ts:199-215`). A `{ type: 'stop' }` event carrying a `reason` means the subprocess died.

**Model choice.** The model is never a `session/new` field; `setLaneModel` issues `session/set_model` and throws when the agent rejects the id (`acp.rs:2287-2322`). claude-agent-acp resolves the aliases `haiku` / `sonnet` / `opus` (`docs/0126:37-48`), so `model = "haiku"` is a one-word cheap-model switch. Backends that advertise no model state reject every id — those want `model = ""`.

**Nothing answers a permission request.** `session/request_permission` parks a oneshot with no timeout (`acp.rs:1585-1621`); `fs/write_text_file` and `elicitation/create` park the same way. A headless caller that ignores them hangs `prompt()` forever, so the fence below is structural, not politeness. `mcpServers: []` removes Krypton's own tools but not the backend's — there is no permission mode to ask for.

**The repo's guard vocabulary for a cheap suggestion model** is spec 0257: `src/acp/timeline-capture.ts:331-368` (generation counter, cancel-previous, clamped debounce, stale-result drop, silent `.catch`) over `src-tauri/src/typesafe.rs:196-295` (per-attempt + overall deadline, retry cap, fingerprinted circuit breaker, byte caps, `enabled` gate, `mode = off|shadow|suggest`). A suggestion is never auto-applied there; the user picks.

**Turn end** is `finishTurn(lane, stopReason, reason?)` (`acp-harness-view.ts:8444`). Line `8452` — `this.liveVoiceCtl.onTurnEnd(...)` — is the last point where every pointer is still set: `sealStreaming` has drained markdown (`:8445`), and the clearing block (`:8463-8483`) has not run. `lane.lastTurnUsage` is already consumed by `recordTurnUsage` at `:8451`.

**Keys.** Alt (Option) chords do not reach Krypton reliably, so they are not used. `Ctrl+1..4` is taken by the macOS *Switch to Desktop N* shortcuts (`com.apple.symbolichotkeys` ids 118–121, enabled on the dev machine), which macOS consumes before the webview. Bare `Cmd+digit`, `Cmd+0` and `Cmd+/` are unclaimed: the input router binds no `Cmd+digit` (workspace focus-by-index is leader-mode `1..9`), there is no menu accelerator or zoom hotkey on them, and the ticket picker's `Cmd+1..3` (spec 203) is a modal owner that runs earlier in `onKeyDown`. `Ctrl+Enter` is **not** free — the submit branch matches `Enter && !shiftKey`.

### Alternatives rejected

- **Extracting the Claude Code OAuth token.** `usage.rs:243-264` already reads `~/.claude/.credentials.json` and the `Claude Code-credentials` keychain entry, and the token's scopes include `user:inference`. Measured on this machine: the live token expires in **2 hours** and the on-disk copy was 114 days stale. Krypton cannot refresh it without rotating the refresh token Claude Code itself holds, so the feature would work only for a couple of hours after the user last ran Claude Code — and it would still spend the same quota ACP spends.
- **A Rust `assist.rs` modelled on `typesafe.rs`.** It would hand-roll a vendor API and still need a credential to put in it. ACP needs neither.
- **Asking the main lane** (inject a `#`-style prompt). Costs main-model tokens, pollutes the transcript, and blocks the lane the human wants free.
- **`AgentController.prompt()`.** A full agent loop — skills, tools, session persistence, context transforms — for one JSON classification.
- **A rail card.** `#panels hide` (0251) hides the rail, and the rail is lane *state*; a next-prompt proposal is an input affordance and belongs next to the input.

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| Warp | *Active AI → Prompt Suggestions*: an LLM reads the most recent block and shows a banner chip; `Ctrl+Enter` auto-populates the input **and runs it** in Agent Mode. Billed outside the AI limits, toggled in Settings → Agents → Active AI, secret-redaction regexes applied to anything sent | Closest match. Warp executes; we only prefill |
| VS Code Copilot Chat | `ChatFollowupProvider.provideFollowups(result, context, token)` → `ChatFollowup { prompt, label }`, rendered after every request. Docs: *"Follow-ups should be written as questions or directions, not just concise commands"* | The `label` + `prompt` pair is adopted verbatim, including the phrasing rule |
| Zed | A family of optional auxiliary-model settings — `commit_message_model`, `thread_summary_model`, `compaction_model` (`crates/settings_content/src/agent.rs:296-312`) — each falling back to the default model when unset | Adopted: `[acp_harness.assist] backend` + `model` name an ACP backend and the id handed to `session/set_model`; an empty `model` keeps the backend's own default |
| ChatGPT | "Follow Up" suggestion chips after each response (rolled out May 2025); the loudest public feedback was a request for an off switch | Why the default is `off` and why `#assist off` exists |
| Claude Code · Codex CLI · Gemini CLI | No next-prompt suggestion surface at all | The terminal-agent field is empty here |

**Krypton delta.** Keyboard-only: numbered accept keys, no clickable chips. Never auto-sends — Warp runs the suggestion, we load it into the draft so the human edits first. Default off, because unlike Warp (vendor-subsidised) this spends the user's own key per turn. Scoped to the active lane only; background lanes never trigger a call.

## Affected Files

| File | Change |
|------|--------|
| `src/acp/assist/types.ts` | **New.** The contract only: `AssistTask`, `AssistContext`, `AssistBudget`, `AssistAction`, `AssistFailure`. No task logic, no transport |
| `src/acp/assist/acp-completion.ts` | **New.** `AcpAssistSession` — one warm, fenced ACP session: no MCP servers, permissions declined, writes refused, questions cancelled |
| `src/acp/assist/engine.ts` | **New.** `AssistEngine.run(task, ctx, cfg)` — abort + deadline, byte caps, failure mapping, breaker. The transport is injected, so the engine knows nothing about ACP |
| `src/acp/assist/registry.ts` | **New.** `ASSIST_TASKS` — the one line a new task adds (now `[nextPrompt, followUp, grammar]`; `follow-up` added by spec 323) |
| `src/acp/assist/config.ts` | **New.** `resolveAssistConfig(config, taskId)` — global defaults ← per-task override, clamps, opaque `options` passthrough |
| `src/acp/assist/tasks/next-prompt.ts` | **New.** The only task v1 ships |
| `src/acp/harness-assist-controller.ts` | **New.** `HarnessAssistController` — per lane × task state, trigger gates, sequencing, cooldown, `stripProps` |
| `src/acp/harness-view-host.ts` | **New** `HarnessAssistHost` (`projectDir`, `remoteRuntimeId`, `invalidate`, `setDraft`) |
| `src/acp/acp-harness-view.ts` | Controller field beside `:1329`; `assistHost()` beside `:15291`; `onTurnEnd` call beside `:8452`; `Cmd+Digit`/`Cmd+Slash` branch in `onKeyDown`; `assist` prop in `renderComposer` `:12339`; `#assist` in `runHashCommand`; teardown in `activateLane` `:14699`, `closeLane` `:10201`, respawn `:10464`/`:10529`, `dispose` `:4702` |
| `src/acp/components/assist-strip/` | **New.** `index.ts`, `assist-strip.css`, `assist-strip.test.ts` |
| `src/acp/components/registry.ts` | Import + entry beside `peer-strip` (`:56`, `:147`) |
| `src/acp/components/composer/index.ts` | `private readonly assist = new AssistStrip()`; `ComposerDraftProps.assist`; child order between `peer` and `liveVoice` (`:193-203`); `updateChildren` |
| `src/acp/hash-commands.ts` + `hash-commands.test.ts` | `#assist` in `HASH_COMMANDS` **and** `commandMeta()` (`category: 'agent'`) |
| `src/config.ts` · `src-tauri/src/config.rs` | `AcpHarnessAssistConfig` under `[acp_harness.assist]`, TS mirror |
| `docs/0004-architecture.md` · `docs/0005-data-flow.md` · `docs/0006-configuration.md` · `docs/README.md` | Module, turn-end flow, config keys, index row |

## Design

### Data structures

```ts
// src/acp/assist/types.ts — the contract. Nothing here knows about prompts.
export interface AssistContext {           // built once per request by the controller
  readonly laneId: string; readonly laneName: string; readonly backendId: string;
  readonly modelName: string | null; readonly projectDir: string | null;
  readonly stopReason: StopReason;
  readonly turn: readonly HarnessTranscriptItem[];   // this turn's items, oldest first
  readonly plan: readonly PlanEntry[] | null;
  readonly queuedPrompts: number; readonly draft: string;
}

export interface AssistBudget {
  readonly maxInputChars: number;
  readonly timeoutMs: number;      // no output-token knob: ACP has none
}
export type AssistMode = 'off' | 'manual' | 'auto';

/** Resolved per run: the mode, the ACP target, the budget, and the task's own
 *  scalar knobs from `[acp_harness.assist.tasks.<id>]`. A task ships its
 *  `Partial` as `defaults`; `resolveAssistConfig` fills the rest. */
export interface AssistTaskConfig extends AssistBudget {
  readonly mode: AssistMode;
  readonly backendId: string;                // ACP backend id; no API key anywhere
  readonly modelId: string | undefined;      // "" in TOML ⇒ keep the backend default
  readonly options: Readonly<Record<string, string | number | boolean>>;
}
export type AssistTaskDefaults = Partial<AssistTaskConfig>;

/** One suggestion row — the only shape the `strip` surface paints. */
export interface AssistAction { readonly label: string; readonly prompt: string }  // 1..48 / 8..240 chars

export type AssistFailure = 'no-backend' | 'no-model'       // hard: retrying cannot help
  | 'timeout' | 'unavailable' | 'invalid';                  // soft: feeds the breaker

export interface AssistTask<T> {
  readonly id: string;             // `#assist <id>` and the TOML key
  readonly summary: string;        // one line, listed by bare `#assist`
  readonly surface: 'strip' | 'panel' | 'transcript';  // which component paints `T` ('panel' — grammar addendum; 'transcript' — spec 323)
  readonly onTurnEnd: boolean;     // eligible for the automatic trigger
  readonly defaults: AssistTaskDefaults;        // mode/backend/budget this task wants
  /** The task's own gate, on top of the engine's. Default: always eligible. */
  eligible?(ctx: AssistContext, cfg: AssistTaskConfig): boolean;
  system(cfg: AssistTaskConfig): string;
  payload(ctx: AssistContext, budget: AssistBudget): string;
  /** Strict parse. `null` means the model did not answer ⇒ `'invalid'`. */
  parse(raw: string, cfg: AssistTaskConfig, ctx: AssistContext): T | null;  // `ctx` added by spec 323; tasks may ignore it
}

/** v1 had one surface; the grammar addendum added 'panel' and spec 323 added
 *  'transcript' (FollowUpRail). Each surface brings its own component. */
export type RegisteredAssistTask = StripAssistTask | PanelAssistTask | TranscriptAssistTask;
```

```ts
// src/acp/assist/engine.ts — the guards. The call itself is injected.
export type AssistCompletion = (call: { system: string; user: string; backendId: string;
  modelId: string | undefined; signal: AbortSignal;
  ready(): void }) => Promise<string>;   // setup done — the deadline restarts for the call
export type AssistRun<T> = { ok: true; value: T } | { ok: false; reason: AssistFailure };

export class AssistEngine {
  constructor(complete: AssistCompletion, now?: () => number);
  run<T>(task: AssistTask<T>, ctx: AssistContext, cfg: AssistTaskConfig): Promise<AssistRun<T>>;
  cancel(): void;                          // abort in flight, bump the generation
  cooldownUntil(taskId: string): number;   // 0 when closed · clearCooldown(id) re-arms
}
```

```ts
// src/acp/assist/acp-completion.ts — the transport. One warm, fenced session.
export class AcpAssistSession {
  //            cwd ↓                remote harness ↓          tests ↓
  constructor(deps: { projectDir(): string | null; remoteRuntimeId(): string | null; spawn?: AcpSpawn });
  readonly complete: AssistCompletion;  // bound, so it can be passed as a value
  dispose(): Promise<void>;             // SIGTERM the subprocess
}
```

```ts
// src/acp/harness-assist-controller.ts — spec 275: plain class, no base class.
// Per lane × task it keeps `{ state, turnSeqByTask }`.
export type AssistState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'pending'; readonly taskId: string }
  | { readonly kind: 'ready'; readonly taskId: string; readonly actions: readonly AssistAction[] }
  | { readonly kind: 'failed'; readonly taskId: string; readonly reason: AssistFailure };

export class HarnessAssistController {
  // A null engine means "own the ACP session" — the app path. Tests inject an
  // engine over a stub transport, so no subprocess is ever spawned.
  constructor(host: HarnessAssistHost, tasks?: readonly RegisteredAssistTask[], engine?: AssistEngine | null);
  onTurnEnd(lane: HarnessLane, stopReason: StopReason): void;  // every eligible task, in registry order
  request(lane: HarnessLane, taskId?: string): void;           // Cmd+/ · `#assist [task] now`
  accept(lane: HarnessLane, index: number): boolean;           // Cmd+1..3 — strip surface
  dismiss(lane: HarnessLane): boolean;                         // Cmd+0
  stripProps(lane: HarnessLane): { state: AssistState };       // read by renderComposer
  setMode(taskId: string | null, mode: AssistMode): void;      // null ⇒ every task
  resetLane(laneId: string): void; onLaneGone(lane: HarnessLane): void; dispose(): void;
}
```

`HarnessAssistHost` (`src/acp/harness-view-host.ts`) extends `HarnessViewHost` with exactly four members: `projectDir`, `remoteRuntimeId`, `invalidate(region)` and `setDraft(lane, text, cursor)`. The controller gets no other door into the view.

### Configuration

```toml
[acp_harness.assist]                      # defaults every task inherits
mode = "off"              # off | manual | auto
backend = "claude"        # ACP backend id — the credential is that CLI's own login
model = "haiku"           # id/alias for session/set_model; "" keeps the backend default
timeout_ms = 8000         # clamp 1_000..20_000; the model call's window — setup gets its own
max_input_chars = 6000    # clamp 500..20_000

[acp_harness.assist.tasks.next-prompt]    # per-task override; every key optional
mode = "auto"
backend = "codex"
count = 3                 # task-specific knob — Rust never sees its meaning
```

**Rust holds no task knowledge.** `AcpHarnessAssistConfig` carries the five generic fields plus `tasks: HashMap<String, AssistTaskOverride>`; `AssistTaskOverride` carries the same five as `Option`s plus `#[serde(flatten)] options: toml::value::Table`, which reaches the frontend as a plain JSON object of scalars. `resolveAssistConfig(config, taskId)` merges `task.defaults` ← global ← override, clamps the generic fields in TS (the `debounceMs` clamp precedent), and hands `options` to the task, which reads only the keys it knows and ignores the rest. A new task therefore needs **no `config.rs` change**.

There is nothing else to set up: no `[[agent.models]]` preset, no `api_key_env`, no environment variable. If `claude` runs in a terminal, the sidecar runs.

### The shipped task — `next-prompt`

`src/acp/assist/tasks/next-prompt.ts` is the whole feature-specific surface: `{ id: 'next-prompt', surface: 'strip', onTurnEnd: true, defaults: { mode: 'off', options: { count: 3 } } }`, plus the four functions below. The engine and the session supply everything else.

`system(cfg)`:

> You read the last turn of a coding agent and propose what the human should ask next. Reply with JSON only: `{"suggestions":[{"label":"…","prompt":"…"}]}`. At most N entries, ordered by usefulness. `label` is at most 48 characters, lower case, no trailing period. `prompt` is one or two sentences the human could send verbatim, phrased as a direction or a question. Propose concrete next work — verify, extend, fix, or ask about something the turn left open. Never propose work the turn already finished. No prose outside the JSON.

`payload(ctx, budget)`, hard-capped at `budget.maxInputChars`:

```
project: krypton
lane: OMP-1 (omp · claude-opus-5)
stop: end_turn
tools: read×4, edit×2, execute×1
plan: [in_progress] wire the controller / [pending] write the test
--- user asked ---
<last user prompt, head-truncated to 25% of the budget>
--- agent replied ---
<last assistant text, TAIL-truncated to 60% of the budget>
```

Tool entries are **kinds and counts only** — `ToolPayload` carries no tool name, and its `subject` / `command` are arguments, so they never leave the machine. The assistant text is tail-kept because conclusions live at the end; the user prompt is head-kept because intent lives at the start. Both truncations append ` …[truncated]`.

`eligible(ctx)` — `ctx.queuedPrompts === 0`: if the human already queued what comes next, a proposal is noise. This gate is the task's, not the engine's; a future summary task would not want it.

`parse(raw, cfg, ctx)` (next-prompt ignores `ctx`) strips a leading ```` ```json ```` fence, takes the outermost `{…}`, `JSON.parse`s it, then per entry: trim, collapse whitespace in `label`, drop entries failing the length bounds, cap at `cfg.options.count`. Zero valid entries ⇒ `null` ⇒ `'invalid'`. **No retry** — the next turn is the next chance.

The transport, identical for every task (`AcpAssistSession.complete`): reuse the warm session when `backendId`/`modelId` match, else `spawn(backendId, projectDir, [], null, null, remoteRuntimeId)` → `initializeOnly()` → `sessionNew()` → `setLaneModel(modelId)`, then `ready()`: the engine's first `timeout_ms` window bounds that setup and `ready()` opens a fresh one for the call, so a cold start (≈2.5 s for `claude-agent-acp`) never eats the model's budget; an abort that already fired during setup skips the prompt. Then one `prompt([{ type: 'text', text: system + '\n\n' + payload }])` — ACP has no system-prompt channel, so the two are concatenated — raced against the engine's `AbortSignal`, which calls `session/cancel` and rejects. A stop reason other than `end_turn` is `'unavailable'`. **The fence:** `permission_request` → `respondPermission(id, null)`, `fs_write_pending` → `respondFsWrite(id, false)`, `ask_user_question` / `elicitation_request` → `cancel()`. A `stop` event carrying a `reason` means the subprocess died, so the client is dropped and the next turn respawns.

### Trigger rules

`onTurnEnd` runs a registered task only when **all** hold. Gates 1–9 are the controller's and apply to every task; 10 is the task's own.

1. the task's resolved `mode === 'auto'` and `task.onTurnEnd`;
2. `lane.id === host.activeLaneId`;
3. `stopReason === 'end_turn'` (never `cancelled` / `refusal` / `max_tokens` / `max_turn_requests`);
4. the turn produced an assistant transcript item of ≥ 40 characters;
5. `lane.pendingPermissions.length === 0 && lane.pendingQuestions.length === 0`;
6. `lane.activeSystemLabel == null` — a system/inter-lane turn is not the human's thread;
7. this `lane.turnSeq` has not been run **for this task**;
8. no active cooldown for this task;
9. the view is not disposed;
10. `task.eligible?.(ctx, cfg) !== false`.

`request(lane, taskId?)` (`Cmd+/`, `#assist [task] now`) accepts `mode` `'manual'` as well as `'auto'` and skips gates 3 and 7, so a manual ask always re-asks. It refuses with `flashChip('assist: off')` when the resolved mode is `off`, and still honours the cooldown and gates 2, 4, 5, 6, 10.

**Single flight and breaker.** The engine holds one `AbortController` and one monotonic generation: a new run aborts the previous one, and the abort reaches the wire as `session/cancel`. The controller holds an `epoch` that only `cancel()` bumps (lane switch, close, respawn, dispose), captured when a run is queued, so a cancel drops work that has not started yet as well as the answer in flight; a reply whose epoch, `lane.spawnEpoch` or active lane no longer matches is dropped silently (`timeline-capture.ts:331-368` discipline). Soft failures (`timeout`, `unavailable`, `invalid`) increment a per-task counter; 3 in a row ⇒ 5-minute cooldown and one `flashChip`. Hard failures (`no-backend`, `no-model`) ⇒ immediate 10-minute cooldown, since retrying cannot help. Any success resets the counter, and `#assist [task] auto|manual` clears the cooldown.

### Extending

Adding a task is one file plus one line:

1. `src/acp/assist/tasks/<id>.ts` — export an `AssistTask`: `id`, `summary`, `surface`, `onTurnEnd`, `defaults`, `system()`, `payload()`, `parse()`, optional `eligible()`.
2. `src/acp/assist/registry.ts` — one entry in `ASSIST_TASKS`.
3. Optional `[acp_harness.assist.tasks.<id>]` in TOML.

Nothing else moves: the engine, the guards, the breaker, the keys, the hash command and the config merge are all derived from the registry. No Rust change, no new Tauri command, no new component.

Two limits are deliberate. A task **cannot bring its own transport** — every task goes through the one fenced ACP session, which is what makes the cost guards and the permission fence unavoidable rather than per-task discipline. A task **cannot invent a surface**: a result the strip cannot paint needs a new `surface` variant plus its own component, reviewed like any other UI (specs 301/302).

> Spec 323 ([0323](0323-harness-follow-up-actions.md)) used exactly this path: it added the `transcript` surface variant with its own component, `FollowUpRail`.

**Sequencing.** When a turn ends the controller runs eligible tasks **sequentially in registry order**, one call in flight harness-wide; a lane switch or a new turn aborts the chain. Registering five tasks therefore costs five serial calls per turn, never five parallel ones.

### Keybindings

| Key | Context | Action |
|-----|---------|--------|
| `Cmd+1` `Cmd+2` `Cmd+3` (`e.code === 'Digit1'…`) | harness focus, suggestions ready | Load suggestion *N* into the draft via `setDraft`; strip clears. Ignored with `flashChip('assist: clear the draft first')` when `lane.draft.trim() !== ''` |
| `Cmd+0` (`Digit0`) | strip visible | Dismiss for this turn |
| `Cmd+/` (`Slash`) | harness focus | Re-run the default task now |

The branch sits in `onKeyDown` **after** the pre-emptive modal owners (`:4186-4305`, so pickers and the dictation session keep every key) and **before** the editing/printable chain (`:4441`). All three match on `e.code` with `e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey`.

### Hash command

`#assist [task] [off | manual | auto | now]` — `HASH_COMMANDS` entry plus `commandMeta()` entry `{ category: 'agent', badges: [] }` (the drift test at `hash-commands.test.ts:170-174` asserts the key sets match). Dispatch mirrors `#panels` verbatim (`acp-harness-view.ts:10805-10820`): clear the draft, validate the argument, flash usage on anything else. The task token is optional and validated against `ASSIST_TASKS`, so the roster entry never changes when a task is added. Bare `#assist` lists every registered task with its `summary`, resolved mode and last failure. Modes set here are **session-scoped**; TOML is the startup default.

### UI

New component `src/acp/components/assist-strip/`, block `acp-harness__assist`, mounted as a `Composer` child between `peer` and `liveVoice` in the `syncOrder` list (`composer/index.ts:193-203`) — the same ownership model as `PeerStrip`, whose `composer.above` layout row is declarative only.

```
cmd+1  run the failing test
cmd+2  check the fs_write_review path
cmd+3  ask why the breaker fires twice
cmd+0 dismiss · cmd+/ again
```

- `kind: 'ready'` → one row per suggestion, a two-column grid: the whole chord (`cmd+N`) in `--acp-lane-accent`, then `label`, which wraps under its own column. No `text-overflow: ellipsis` — a prompt is a sentence, and the clipped end was the part that said what it does.
- `kind: 'pending'` → one dim row `assist · thinking…`.
- `kind: 'idle' | 'failed'` → `this.el.hidden = true`; failures speak once through `flashChip`, never as a permanent row. `stripProps()` maps a dismissed lane to `{ kind: 'idle' }`, so dismissal is not a second hidden-state input.
- The legend is `cmd+0 dismiss · cmd+/ again`. `cmd+1-3 use` is not in it: each row spells its own key, so the mapping is local to the row the human is reading.

`readDeps()` returns `[state.kind, labels.join('\u0000')]`, derived in `update()` before `super.update()` — the `PeerStrip` pattern, so nothing clock-derived or identity-unstable reaches the dependency tuple. Plain `Component`, not `LiveComponent`: no streaming, no seal.

Styling follows `DESIGN.md` (the harness is Krypton Dark; `DESIGN.amber.md` is the agent view, `DESIGN.binance.md` is browser surfaces): 0px interior pane, no corner brackets, and the muted-foreground treatment of `peer-strip.css`. It does **not** take that sheet's `0.74em`: the strip is read and acted on, so it is sized `var(--krypton-font-size, 13px)` — the user's `[font] size` — like `tool-row.css` and `permission-row.css`, and hierarchy is carried by colour alpha alone. `assist-strip.test.ts` holds that contract (no `N.NNem` font-size survives in the sheet) because jsdom applies no stylesheet. The sheet is one `@layer krypton.component` block plus `.acp-harness__assist[hidden] { display: none; }`, and declares only `acp-harness__assist*` selectors, as `styles-ownership.test.ts` requires.

### Data flow

```
1. lane turn ends → finishTurn(lane, stopReason)            acp-harness-view.ts:8444
2. :8452 → assistCtl.onTurnEnd(lane, stopReason)            (beside liveVoiceCtl.onTurnEnd)
3. gates 1–10 pass → state 'pending', host.invalidate('composer')
4. task.payload(ctx, budget)                  — bounded by max_input_chars
5. AcpAssistSession: warm session reused, else acp_spawn(mcp=[]) → initialize →
   session/new → session/set_model (own timeout_ms window) → ready() restarts the
   deadline → one session/prompt raced against it
6. task.parse(raw, cfg, ctx) → AssistRun<T>   — null ⇒ 'invalid', feeds the breaker
7. ok ⇒ state 'ready' → host.invalidate('composer')
8. commitRegion('composer') → renderComposer :12339 → Composer.update({ assist })
9. Cmd+2 → assistCtl.accept(lane, 1) → host.setDraft(lane, prompt, prompt.length)
          → setDraft resets ghost/history/palettes and flushes the composer region
10. human edits, presses Enter — the sidecar never sends
```

## Edge Cases

- **Lane switch, close, or respawn while in flight** — abort the controller, drop the reply on the `generation`/`laneId` check, clear that lane's state (`activateLane` `:14699`, `closeLane` `:10201`, `resetLane` from `:10464`/`:10529`).
- **The backend does not start** (not installed, not logged in) — `failed('no-backend')`, one `flashChip('assist: backend did not start')`, 10-minute cooldown.
- **The backend rejects the model id** (it advertises no model state) — `setLaneModel` throws ⇒ `no-model`, the half-built session is disposed, same flash-once treatment. `model = ""` is the fix.
- **The agent asks for a permission, a file write, or a question** — declined / refused / cancelled by the fence. It never reaches the human: a one-shot that wants a tool has already gone wrong, and an unanswered request would hang the turn forever.
- **The subprocess dies mid-turn** — the `stop` event carries a `reason`, the client is dropped, the prompt rejection maps to `unavailable`, and the next turn respawns.
- **Draft not empty on accept** — refuse with a flash rather than clobber typed text. `Cmd+0` then `Cmd+N` is the explicit path.
- **Dictation session live** — the pre-emptive branch at `:4186-4192` swallows every key, including `Cmd+N`. Intended: finish or abort dictation first.
- **Transcript focus (command mode)** — accept still works; `setDraft` moves focus to the text field, matching `editQueuedPrompt` (`:11437`).
- **Model returns prose, fenced JSON, or four entries** — parser strips fences, takes the outermost object, caps at `count`; unparseable ⇒ `invalid`, counts toward the breaker.
- **Suggestion contains newlines** — `label` collapses whitespace; `prompt` keeps newlines, truncated at 240 characters.
- **Remote runtime lanes (0247)** — `remoteRuntimeId` is passed to `acp_spawn`, so the sidecar's backend starts on the same remote runtime as the lanes and the transcript text does not travel to a third host.
- **Zen mode (0080) / `#panels hide` (0251)** — both leave the composer mounted (`HARNESS_PINNED_SURFACES`), so the strip is unaffected by either.

## Testing

- `src/acp/assist/engine.test.ts` — the engine against a **fake task** (`id: 'test'`, echo parser): deadline abort, single-flight supersede, stale reply dropped after a lane switch, soft-failure breaker at three, hard-failure cooldown, failure mapping. No real task is imported.
- `src/acp/assist/acp-completion.test.ts` — the transport against a **fake `AcpClient`**: spawn once / set model / collect text, warm reuse, respawn on a backend change, the permission-write-question fence, abort → `session/cancel` with the subprocess kept, non-`end_turn` ⇒ `unavailable`, spawn failure ⇒ `no-backend`, rejected model ⇒ `no-model` with the half-built session disposed, death-then-respawn, and dispose.
- `src/acp/assist/tasks/next-prompt.test.ts` — payload budget split and truncation markers; tools as name×count with no arguments; `parse` against fenced JSON, trailing prose, wrong types, over-long fields, more than `count` entries, zero valid entries; `eligible` false when prompts are queued.
- `src/acp/assist/registry.test.ts` — ids unique, every id a valid `#assist` token, every `defaults` within the config clamps.
- `src/acp/harness-assist-controller.test.ts` — the ten gates as a table; per-task turn-seq dedupe; manual bypass; sequential ordering with two fake tasks; `accept` refusing a dirty draft. The injected `AssistCompletion` keeps every case offline.
- `src/acp/components/assist-strip/assist-strip.test.ts` — hidden when idle/failed/dismissed, one row per action, index markers, dependency tuple stable across `paint()`.
- `hash-commands.test.ts` and `styles-ownership.test.ts` must stay green unchanged.

## Out of Scope

Turn recaps or summaries (no second task ships here — the registry is the place to add one later); auto-sending a suggestion; suggestions for background or non-active lanes; streaming; token metering, WAL rows, or cost display (ADR-0018/0019 — Krypton does not price tokens); a Rust-side client; per-task transports; a second result surface; user-defined tasks or prompt text in TOML; extracting a vendor API key from another app's credential store; secret redaction of outbound payload; a loopback `/assist` page; a rail card; teaching a task tools or file reads.

## Resources

- [Warp — Active AI Recommendations](https://docs.warp.dev/agents/local-agents/active-ai/) — Prompt Suggestions UX, `Ctrl+Enter` accept-and-run, the settings toggle, and the "not billed against AI limits" framing that shaped the accept-but-don't-send decision.
- [VS Code — Chat Participant API](https://code.visualstudio.com/api/extension-guides/ai/chat) — `ChatFollowupProvider` / `ChatFollowup { prompt, label }` and the phrasing rule adopted in the system prompt.
- Zed, `crates/settings_content/src/agent.rs:296-312` (local checkout) — `commit_message_model` / `thread_summary_model` / `compaction_model`: the optional auxiliary-model setting that falls back to the default model.
- [Disable or Customize the "Follow Up" Suggestions](https://community.openai.com/t/disable-or-customize-the-follow-up-suggestions/1254246) — ChatGPT's follow-up chips and the demand for an off switch; evidence for `mode = "off"` by default.
- `src/acp/client.ts:86-278` and `src-tauri/src/acp.rs:1585-1621, 2287-2322` — the headless spawn/prompt/dispose surface, the `session/set_model` request, and the permission bridge that parks forever when nobody answers.
- `src-tauri/src/usage.rs:243-264, 430-434` — how Krypton already reads Claude Code's OAuth token for the usage meter; the evidence behind rejecting key extraction as this feature's transport.

## Addendum — `grammar` task

A second registered task, `grammar` (`src/acp/assist/tasks/grammar.ts`), reviews the English of every prompt the human sends. It is the first task with `onUserPrompt: true` and the first with `surface: 'panel'`. `sendUserPrompt` calls `HarnessAssistController.onUserPrompt(lane)` right after the user row is appended, so the check runs while the lane works and needs no assistant reply. The user-prompt trigger skips the `MIN_ASSISTANT_CHARS` and `activeSystemLabel` gates.

- Eligible only for English prose of ≥3 words; `/` and `#` commands are skipped. Thai and other non-Latin prompts are skipped too, as are prompts that are mostly code, paths or URLs.
- The model replies `{"ok":true}` or `{"ok":false,"corrected":"…","fixes":["wrong → right"]}`, parsed into `AssistCheck { corrected: string | null; fixes }`.
- The result has its own surface: `GrammarPanel` (`src/acp/components/grammar-panel/`). It is a right-rail card in the thought card's family, mounted in the `grammar` layout entry (`rail.top`, order 40, under the thought card) only while the active lane has a review. Its state is per lane (`AssistPanelState`).
  - `pending` — header `GRAMMAR · CHECKING` and the checked prompt, dimmed.
  - fixes — header `GRAMMAR · N FIXES`, the `wrong → right` list, the corrected prompt, and the legend `cmd+g use · cmd+0 dismiss`.
  - clean — `GRAMMAR · OK` and `✓ no grammar issues`. It unmounts after `ASSIST_PANEL_OK_HIDE_MS` (4 s).
- `Cmd+G` loads the corrected text into the empty composer and closes the panel; it never re-sends. `Cmd+0` closes the panel. `#panels hide` hides the panel with the rest of the rail, and `#panels hide grammar` (or the window-titlebar grammar toggle, spec 320) hides it alone; while it is hidden neither `Cmd+G` nor `Cmd+0` acts on it.
- Default `mode = "off"`. Enable it with `#assist grammar auto`, or persist it in config:

```toml
[acp_harness.assist.tasks.grammar]
mode = "auto"
```

## Addendum — `follow-up` task (spec 323)

A third registered task, `follow-up` (`src/acp/assist/tasks/follow-up.ts`), is the first with `surface: 'transcript'`; see [0323](0323-harness-follow-up-actions.md) and [0327](0327-harness-follow-up-prompts.md) for the full design. On turn end Krypton extracts candidates from the last assistant reply's markdown (shell fences, inline code spans that are a URL or have more than one word, http(s) URLs); for `run`/`open` the model only picks candidate numbers and writes labels, and the target text always comes from the candidate. Since 0327 the model may also write a `prompt` for the lane — a step the reply offered that continues from the finished work, never an offer to redo it — so every finished reply makes one call. The result is stored on the reply (`HarnessTranscriptItem.followUps`) and painted by `FollowUpRail` under it; clicking a button or typing its `f`-hint label runs it (`run` → a terminal tab, `open` → the OS browser, `prompt` → sent to the lane, queued when busy), and a prompt card's paste icon or `Shift`+hint inserts it into the composer. Skipped on a remote harness.

- **Privacy.** The payload is only the last assistant reply text plus candidates that are substrings of it — no tool arguments — so it stays within this spec's payload rule.
- Default `mode = "off"`; option `count` 1..3 (default 3), set via `#assist follow-up auto|manual|off|now` or `[acp_harness.assist.tasks.follow-up]`.

## Addendum — `next-prompt` removed (2026-10-23)

User, 2026-10-23: "I want to remove assist next prompt feature from app, because we already include in follow up feature". Follow-up prompts ([0327](0327-harness-follow-up-prompts.md)) put the next message for the lane under the reply that offered it, with send and paste options, so the composer strip duplicated them.

Removed:

- `src/acp/assist/tasks/next-prompt.ts` and its test. `ASSIST_TASKS` is now `[followUp, grammar]`.
- The `'strip'` surface: `StripAssistTask`, `AssistAction` and `AssistState` in `assist/types.ts`. `RegisteredAssistTask` is `PanelAssistTask | TranscriptAssistTask`.
- `AssistContext.stopReason`, `plan`, `queuedPrompts` and `draft`, which only `next-prompt` read.
- `src/acp/components/assist-strip/` and its `Composer` child, prop and registry entry.
- From `HarnessAssistController`: `accept`, `dismiss`, `stripProps` and `runStrip`, plus the per-lane strip state. The per-lane turn-seq dedupe stays, in `turnSeqs`.
- From the view: the `Cmd+1..3` accept keys and the strip half of `Cmd+0`.

Kept: `Cmd+0` closes the grammar panel, and `Cmd+/` re-asks the first registered task, which is now `follow-up`. `#assist [task] off|manual|auto|now` is unchanged. A `[acp_harness.assist.tasks.next-prompt]` table in an existing config still parses and is never read (0006).
