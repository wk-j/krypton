# View Protocol — Implementation Spec

> Status: Draft (post-grill v2)
> Date: 2026-05-18
> Milestone: Post-M-current infrastructure

## Problem

Krypton hosts ~12 distinct view types (shell, agent, ACP harness, vault, webview, file manager, markdown, diff, context, hurl, pencil, music). Each view stores state on its own class fields and there is **no standard way for views to talk to each other or to the chrome**. The compositor pulls *progress* on demand but nothing else. Concretely:

- Chrome cannot reflect a view's busy/error state in corner accents (spec 104 needs this).
- A view cannot ask "open this file in diff view" without hard-coding a reference to the other view.
- Sound engine cannot react to "any view errored" without subscribing to a dozen different APIs.
- HUD numerics cannot show view-specific metrics without the compositor knowing every view type.

The pattern that wants to exist is **pub/sub over a typed bus**, with views as both publishers and subscribers.

## Solution

Introduce a single in-process TypeScript event bus — `ViewBus` — with two message channels:

1. **Signal** — broadcast state from one view (`view:state`, `view:throughput`, etc.). Many subscribers, fire-and-forget. Namespace = the source.
2. **Intent** — directed request (`diff:open-file`, `agent:add-context`, `pane:open`). Namespace = the intended receiver. Subscribers filter by kind only; the bus has no addressing logic.

Query/response is **not** in v1 (deferred to v2 — current use cases are covered by signals + intents).

Views implement a small lifecycle interface (`mountToBus` / `unmountFromBus`). The compositor calls these in the pane lifecycle. Chrome, sound engine, and inter-view features are all bus subscribers — no view holds a reference to another view, and `compositor` becomes a subscriber for `pane:*` intents rather than a god-object API.

The bus is **frontend-only**. Rust events are translated into bus signals by a dedicated `pty-bridge` module.

## Research

Findings (from `docs/104-chrome-signal-upgrades.md` research pass and follow-ups):

- **No content-type discriminator on `KryptonWindow`** — it lives on `Pane.contentType` (`src/types.ts:110`). Addressing operates at the pane level.
- **Per-view state on class instances** — `AgentView`, `VaultContentView`, `WebviewContentView`, `FileManagerView`, `AcpHarnessView`.
- **Existing upward signal: `pty-progress` only.** The bus generalizes this pattern.
- **ACP harness already has** a status enum `'starting' | 'idle' | 'busy' | 'needs_permission' | 'error' | 'stopped'` (`acp-harness-view.ts:51`) — informed the `SignalState` vocabulary.
- **Two existing callback channels** in compositor (`onFocusChange`, `onRelayout`) cover layout transitions. Kept; bridged to bus.
- **No global event bus today.** Greenfield within the frontend.

Alternatives ruled out:
- **Reactive store (Zustand / Valtio)** — adds a framework dep; CLAUDE.md forbids frontend frameworks.
- **`EventTarget` / `CustomEvent` on `window`** — loses type safety.
- **Push everything through Tauri events** — wasteful IPC for frontend-only coordination.
- **Per-window scoped buses** — cross-window features (sound, debug overlay) would walk a registry; one global bus is simpler at the volumes involved.
- **Compositor methods as the standard channel** — that's ad-hoc API surface, not a protocol; rejected during grill.

## Prior Art

| System | Pattern | Notes |
|--------|---------|-------|
| VS Code | `EventEmitter<T>` events + `vscode.commands.executeCommand(id, args)` | Two-channel: events + commands. Closest analogue |
| Atom | Atom services + `atom.commands.add()` | Services typed, commands string |
| Emacs | Hooks + `funcall` | Loose typing, same two-channel |
| Neovim | Autocmd + `nvim_call_function` RPC | Events broadcast, RPC addressed |
| tmux | `display-message` / `run-shell` / hooks | Hooks = signals, run-shell = intent |
| GTK signals | `g_signal_connect` + `g_action_activate` | Per-object events + actions |

**Krypton delta** — we adopt the VS Code two-channel split but **encode the receiver in the intent's `kind`** (e.g. `diff:open-file`) rather than carrying a `target` field. The bus stays addressing-free; the kind *is* the address. No surveyed system does this — the deliberate divergence keeps the bus dumb and the protocol grep-able.

## Affected Files

| File | Change |
|------|--------|
| `src/view-bus.ts` *(new)* | `ViewBus` class — publish/subscribe, depth guard, error handling |
| `src/view-bus-types.ts` *(new)* | Closed discriminated unions for `SignalKind`, `IntentKind`, and their payloads |
| `src/pty-bridge.ts` *(new)* | Tauri `pty-output` / `pty-exit` / `pty-progress` / `process-changed` → bus signals; EMA throttle |
| `src/main.ts` | Boot bus, boot pty-bridge, wire compositor↔bus |
| `src/types.ts` | Add `viewId: string` to `Pane`; export `ViewAddress` |
| `src/compositor.ts` | (a) generate `viewId` on pane create; (b) `mountToBus` / `unmountFromBus` calls; (c) `addressFromSession(sessionId): ViewAddress \| null`; (d) bridge `onFocusChange`/`onRelayout` → bus signals; (e) subscribe `pane:*` intents to handle open/focus/close |
| `src/agent/agent-view.ts` | Emit `view:state`, `view:throughput`, `view:metrics`; subscribe `agent:add-context` |
| `src/acp/acp-harness-view.ts` | Map lane status → `view:state`; emit `view:metrics`; subscribe `agent:add-context` |
| `src/vault-view.ts` | Emit `view:state` on save |
| `src/webview-view.ts` | Emit `view:state`/`view:metrics`; subscribe `webview:navigate` |
| `src/file-manager.ts` | Emit `view:state`/`view:metrics`; publish `diff:open-file` on Enter |
| `src/sound.ts` | Subscribe `view:state` filter `err` → play error pack (1/s debounce per source) |
| `docs/PROGRESS.md` | Track bus + per-view adapters |
| `docs/04-architecture.md` | New section: "View Protocol" |
| `docs/05-data-flow.md` | New diagram: file-manager Enter → diff view |

## Design

### Core Types

```ts
// src/view-bus-types.ts

export type SignalState =
  | 'normal' | 'busy' | 'ok' | 'warn' | 'err' | 'special' | 'needs_attention';

export type SignalKind =
  | 'view:state'           // value: SignalState
  | 'view:throughput'      // value: number (bytes/s, tokens/s, …; units context-dependent)
  | 'view:metrics'         // value: Record<string, string | number>
  | 'view:exit'            // value: { code: number | null }
  | 'view:progress'        // value: { state: ProgressPhase; pct: number | null }
  | 'view:cwd'             // value: { cwd: string } — OSC 7 cwd report (terminals, via pty-bridge)
  | 'system:focus-change'  // value: { windowId: WindowId | null }
  | 'system:relayout';     // value: {}

export type IntentKind =
  | 'pane:open'            // payload: { type: PaneContentType; path?: string }
  | 'pane:focus'           // payload: { viewId: string }
  | 'pane:close'           // payload: { viewId: string }
  | 'diff:open-file'       // payload: { path: string }
  | 'markdown:open-file'   // payload: { path: string }
  | 'webview:navigate'     // payload: { url: string }
  | 'agent:add-context'    // payload: { text: string; mime?: string }
  | 'sound:play';          // payload: { name: string }

export interface ViewAddress {
  viewId: string;          // stable runtime UUID
  role: PaneContentType;
  windowId: WindowId;
  tabId: TabId;
  paneId: PaneId;
}

export interface Signal<K extends SignalKind = SignalKind> {
  kind: K;
  source: ViewAddress | SystemSource;
  value: SignalValue<K>;
  ts: number;
}

export interface Intent<K extends IntentKind = IntentKind> {
  kind: K;
  source: ViewAddress;
  payload: IntentPayload<K>;
  ts: number;
}
```

`SignalValue<K>` and `IntentPayload<K>` are mapped types — full TS strictness, no `any`. Vocabulary is **closed**: adding a kind requires editing this file. No plugin/external extension in v1.

### Bus API

```ts
// src/view-bus.ts

export type Unsubscribe = () => void;

export class ViewBus {
  publishSignal<K extends SignalKind>(sig: Omit<Signal<K>, 'ts'>): void;
  publishIntent<K extends IntentKind>(intent: Omit<Intent<K>, 'ts'>): boolean;
  // ↑ returns true if any handler returned { consumed: true }

  onSignal<K extends SignalKind>(
    filter: { kind: K; sourceRole?: PaneContentType; sourceViewId?: string },
    cb: (s: Signal<K>) => void
  ): Unsubscribe;

  onIntent<K extends IntentKind>(
    filter: { kind: K },
    cb: (i: Intent<K>) => void | { consumed: boolean }
  ): Unsubscribe;

  snapshot(): { signals: Signal[]; intents: Intent[] };  // ring buffer (200), debug only
}
```

### Dispatch Semantics

- **Synchronous.** Handler runs on publisher's stack. Stack-trace continuity is the win; rate is controlled by publisher-side budget (`view:throughput` ≤ 5 Hz, `view:metrics` ≤ 1 Hz, `view:state`/`view:exit` event-driven).
- **Subscriber filter by `kind` only** (plus optional `sourceRole`/`sourceViewId` for signals). The bus is a dumb `Map<kind, Handler[]>`. No targeting logic.
- **Intent `consumed`** = "handler accepted responsibility" (not "completed"). `publishIntent` returns `true` if any handler returned `{ consumed: true }`. Publisher uses the boolean for fallback (e.g. file-manager publishes `diff:open-file`; if `false` → publishes `pane:open` for a new diff pane).

### Error Handling

```ts
for (const handler of handlers) {
  try { handler(message); }
  catch (err) {
    if (import.meta.env.DEV) throw err;            // surface bugs immediately in dev
    console.error('[ViewBus]', kind, err);         // log and continue in release
  }
}
```

- **Dev**: handler throw bubbles to publisher (instant feedback, real stack).
- **Release**: one subscriber's bug doesn't take down the rest. A terminal emulator runs for hours; resilience over fail-fast.
- A throwing handler is treated as **not consumed** for intents (return value is lost).

### Re-entrance Guard

```ts
private depth = 0;
private kindStack: string[] = [];
private static readonly MAX_DEPTH = 16;

dispatch(kind, handlers, msg) {
  if (this.depth >= ViewBus.MAX_DEPTH)
    throw new Error(`[ViewBus] depth ${this.depth} exceeded; stack: ${this.kindStack.join(' → ')}`);
  if (import.meta.env.DEV && this.kindStack.includes(kind))
    throw new Error(`[ViewBus] re-entrant publish of "${kind}"; stack: ${this.kindStack.join(' → ')} → ${kind}`);

  this.depth++; this.kindStack.push(kind);
  try { /* run handlers with the error handling above */ }
  finally { this.depth--; this.kindStack.pop(); }
}
```

- Depth cap **16** in both dev and release (cheap; cap > 16 is a bug).
- Kind-stack repeat detection **dev only** (catches direct A→A and indirect A→B→A loops).
- **Convention** (in code comments + this spec): a handler of kind X must not publish kind X. If a chain emit is genuinely needed (e.g. state busy → progress complete → state ok), use `queueMicrotask(() => bus.publish(...))` to start a fresh dispatch chain.

### View Lifecycle

```ts
export interface BusMountable {
  mountToBus(bus: ViewBus, address: ViewAddress): void;
  unmountFromBus(): void;
}
```

- Compositor calls `mountToBus` on pane create, `unmountFromBus` on pane destroy.
- Views store the `Unsubscribe` handles returned from `onSignal` / `onIntent` and invoke them all in `unmountFromBus` — no leaks.
- **viewId**:
  - Stable for the lifetime of the view instance.
  - **Same viewId** through tab move, window move, workspace switch (only `address.windowId`/`tabId` change in the registry; signal payloads carry a snapshot, subscribers re-lookup via `compositor.addressOf(viewId)` if they need live data).
  - **New viewId** when the pane's `contentType` is swapped in place (`unmountFromBus` old → `mountToBus` new).
  - **Not persisted.** Session restore yields fresh viewIds; use `paneId` or a content-specific key for persistent correlation.

### Compositor ↔ Bus Bridges

```ts
// system:focus-change / system:relayout — bridge existing callbacks (don't deprecate)
compositor.onFocusChange((id) =>
  bus.publishSignal({ kind: 'system:focus-change', source: SYSTEM, value: { windowId: id } })
);
compositor.onRelayout(() =>
  bus.publishSignal({ kind: 'system:relayout', source: SYSTEM, value: {} })
);

// compositor is a subscriber for pane:* — not a public API entry point
bus.onIntent({ kind: 'pane:open' },  (i) => { this.openPane(i.payload);  return { consumed: true }; });
bus.onIntent({ kind: 'pane:focus' }, (i) => { this.focusPane(i.payload.viewId); return { consumed: true }; });
bus.onIntent({ kind: 'pane:close' }, (i) => { this.closePane(i.payload.viewId); return { consumed: true }; });
```

### Rust → Bus (pty-bridge)

`src/pty-bridge.ts` subscribes existing Tauri events; **no new Rust events**.

```ts
export function startPtyBridge(bus: ViewBus, compositor: Compositor) {
  const ema = new Map<SessionId, ThroughputState>();

  listen<PtyOutput>('pty-output', (e) => {
    const addr = compositor.addressFromSession(e.payload.session_id);
    if (!addr) return;
    const tp = updateEma(ema, e.payload.session_id, e.payload.data.length);
    if (shouldEmit5Hz(tp)) {
      bus.publishSignal({ kind: 'view:throughput', source: addr, value: tp.bytesPerSec });
    }
  });

  listen<PtyExit>('pty-exit', (e) => { /* republish view:exit */ });
  listen<ProgressEvent>('pty-progress', (e) => { /* republish view:progress */ });
  listen<ProcessChanged>('process-changed', (e) => { /* republish view:metrics */ });
}
```

Rust stays outside the bus permanently. If Rust must one day *consume* intents (e.g. `pty:resize`), the same bridge module subscribes the bus and forwards via Tauri commands — same pattern, reverse direction.

### Sound Engine Integration

```ts
const lastPlay = new Map<string, number>();   // sourceViewId → ts
bus.onSignal({ kind: 'view:state' }, (s) => {
  if (s.value !== 'err') return;
  const key = (s.source as ViewAddress).viewId;
  const now = performance.now();
  if (now - (lastPlay.get(key) ?? 0) < 1000) return;
  lastPlay.set(key, now);
  soundEngine.play('error');
});
```

1/s debounce per source — prevents flood when a process spams errors.

### Data Flow Example (file-manager → diff view)

```
1. User presses Enter on changed file in file-manager
2. file-manager.ts: bus.publishIntent({ kind: 'diff:open-file', source: addr, payload: { path } })
3. ViewBus: dispatch synchronously to all 'diff:open-file' subscribers
4. Diff view (same or any window): loadFile(path); return { consumed: true }
5. publishIntent returns true → file-manager does nothing more
6. (alt) no diff view subscribed → returns false
   → file-manager: bus.publishIntent({ kind: 'pane:open', source: addr, payload: { type: 'diff', path } })
   → compositor consumes pane:open → opens diff pane
```

### Performance Budget

| Subscriber | Work per dispatch | Cost |
|-----------|---------------------|------|
| Chrome `data-signal` | dataset assign | <0.01 ms |
| Edge glow `setProperty` | CSS variable write | <0.01 ms |
| HUD text | `textContent =` | <0.05 ms |
| Sound check | map lookup + debounce | <0.01 ms |

Worst-case load: 50 panes × 5 Hz throughput = 250 dispatches/s × ~0.1 ms = **~2.5% CPU**. Well within budget. `state`/`exit` are event-driven (rare); `metrics` capped at 1 Hz.

**Subscriber convention**: no `offsetHeight`/`getBoundingClientRect` reads inside handlers (forces sync layout). Defer DOM heavy work via `requestAnimationFrame`.

### Testing Strategy

- **Vitest** unit tests in `src/view-bus.test.ts`:
  - publish → handler invoked synchronously
  - filter `sourceRole` / `sourceViewId` honored
  - intent `consumed` = at-least-one-handler-returns-true
  - handler throw in dev → bubbles; in release → logged + others run
  - depth cap → throws at 16
  - dev kind-stack repeat → throws
- **Bridge tests** in `pty-bridge.test.ts`:
  - mock Tauri `listen`, fire fake events, assert `bus.snapshot()`
  - EMA / 5 Hz rate budget
- **View adapter tests**: each view's `mountToBus` registers expected handlers; `unmountFromBus` unsubscribes all.

### Configuration

No user-facing config. Dev mode exposes `(window as any).__ViewBus = bus` for inspection and a debug overlay (ring-buffer view) togglable via leader-key chord.

## Edge Cases

- **Pane move tab→tab / window→window.** `viewId` unchanged; only registry address updates. Subscriptions intact.
- **Pane contentType swap in place** (shell → agent). `unmountFromBus` old (viewId₁ retired) → `mountToBus` new (viewId₂ fresh). Chrome state resets to `normal` for that window.
- **Session restore.** Fresh viewIds across the board. State is rebuilt by views as they mount.
- **Re-entrant publish** of the same kind. Dev: throws. Release: depth cap catches infinite loops at 16.
- **Subscriber throws.** Dev throws; release logs + continues with the remaining subscribers. Intent treated as not consumed.
- **Sound flood.** 1/s per source-viewId debounce.
- **High-throughput PTY** (`cat huge.log`). pty-bridge EMA + 5 Hz emit; no per-byte dispatch.
- **No diff view registered when file-manager Enter pressed.** `publishIntent` returns false; file-manager publishes `pane:open` as fallback; compositor handles it.
- **Memory.** Ring buffer 200 × ~200 B ≈ 40 KB. Handler maps are O(kinds × subscribers).

## Open Questions

None — resolved during grill.

## Out of Scope

- **Query/response channel.** Deferred to v2.
- **Cross-process / multi-OS-window bus.** Krypton is a single Tauri window.
- **Rust-side bus.** Rust stays Tauri-event-driven; pty-bridge translates.
- **Persistence.** Signals/intents are ephemeral.
- **Authentication / capability checks.** All views are trusted code in one process.
- **Plugin-extensible vocabulary.** Closed union in v1. Reopening this is a v2 architecture decision.
- **Migration of `onFocusChange` / `onRelayout`** away from compositor callbacks. Bridged but not removed.
- **Deprecation of compositor public methods** (`openPane`, etc.). They become thin wrappers that publish `pane:open` internally; full deprecation is a follow-up cleanup once all callers move to intents.

## Resources

- `docs/104-chrome-signal-upgrades.md` — chrome polish spec, the primary bus consumer
- `src/types.ts:110,168,199` — `PaneContentType`, `Pane`, `KryptonWindow`
- `src/compositor.ts:84,1236,1241` — `SessionLocation`, `onFocusChange`, `onRelayout`
- `src/progress-gauge.ts` — current OSC 9;4 implementation; model for `view:progress`
- `src/acp/acp-harness-view.ts:51` — lane status enum (informed `SignalState`)
- [VS Code Extension API — Events](https://code.visualstudio.com/api/references/vscode-api#Event) — two-channel pattern reference
- [VS Code Extension API — Commands](https://code.visualstudio.com/api/extension-guides/command) — directed-call reference
- N/A for external standards — internal protocol shaped by the codebase

## Changelog

- **v2 (post-grill)** — Removed `target` field from intents (kind-as-address). Added namespace convention (`<ns>:<name>`). Specified re-entrance guard (depth 16, dev kind-stack, microtask escape). Specified error handling (dev throw / release swallow). Added pty-bridge module, removed any proposed Rust-side bus. Specified viewId stability + swap semantics. Closed the vocabulary (typed union). Removed Query channel (v2).
- **v1 (initial draft)** — First pass with target/role/broadcast addressing, query channel, optional intent fallback chains.
