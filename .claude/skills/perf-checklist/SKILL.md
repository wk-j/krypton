---
name: perf-checklist
description: Performance audit checklist for each window/view implementation. Run against a specific view or all views to identify rendering bottlenecks, leaked listeners, missing cleanup, and animation issues.
---

## What I do

Systematically audit the performance of each window/view implementation in Krypton. Each view is checked against a standard checklist covering DOM rendering, event lifecycle, animation, memory, and layout thrashing.

## When to use me

- Before shipping a new ContentView implementation
- When a view feels sluggish or CPU usage spikes
- Periodic health check across all views
- After major refactors to verify no regressions

## How to run

Audit a single view:
```
/perf-checklist agent-view
```

Audit all views:
```
/perf-checklist all
```

## View Registry

| View | File | Type | Renderer |
|------|------|------|----------|
| Terminal | `compositor.ts` | xterm.js canvas | GPU-composited |
| Agent Panel | `src/agent/agent-view.ts` | innerHTML + appendChild | IntersectionObserver virtualization |
| Agent Context | `src/agent/context-view.ts` | innerHTML | RAF-throttled streaming |
| File Manager | `src/file-manager.ts` | createElement + virtual scroll | Spacer-based virtualization |
| Markdown | `src/markdown-view.ts` | innerHTML | Regex parser |
| Vault | `src/vault-view.ts` | innerHTML | Custom markdown parser |
| Diff | `src/diff-view.ts` | diff2html library | Side-by-side/unified |
| Quick Terminal | `compositor.ts` | xterm.js canvas | Lazy init |
| Command Palette | `src/command-palette.ts` | innerHTML | Fuzzy filter |
| Dashboard | `src/dashboard.ts` | callback-based tabs | Tabbed overlay |
| Which-Key | `src/which-key.ts` | innerHTML | Transient overlay |
| Hint Mode | `src/hints.ts` | innerHTML | Regex + dimming |
| Inline AI | `src/inline-ai.ts` | innerHTML | Streaming output |
| Selection | `src/selection.ts` | Canvas | Char/line-wise |
| Notifications | `src/notification.ts` | innerHTML | Bottom-right bar |
| Profiler HUD | `src/profiler/profiler-hud.ts` | innerHTML | Debug overlay |
| Progress Gauge | `src/progress-gauge.ts` | SVG | Per-window arc |
| Cursor Trail | `src/cursor-trail.ts` | OffscreenCanvas | Web Worker + DOM fallback |
| Music Player | `src/music.ts` | Canvas FFT | Dashboard + mini-player |

## Checklist

For each view, check every item below. Mark PASS / FAIL / N/A with a one-line note.

### 1. DOM Rendering

- [ ] **No innerHTML in hot paths.** innerHTML on every keypress or scroll is a red flag. Acceptable for one-shot renders (opening a view, loading content). Prefer `textContent`, `createElement`, or incremental DOM patching for frequent updates.
- [ ] **Virtualization for long lists.** Any list that can exceed ~100 items should use virtual scrolling (spacer-based or IntersectionObserver). Check: does the view render all items or only the visible window?
- [ ] **Batch DOM writes.** Multiple sequential DOM mutations should be batched (documentFragment, single innerHTML, or RAF coalescing). Check for interleaved read/write (layout thrashing).
- [ ] **No forced reflows in loops.** Reading `offsetHeight`, `getBoundingClientRect`, `scrollTop` inside a loop that also writes to the DOM forces synchronous layout. Hoist reads before writes.
- [ ] **Minimal live NodeList usage.** `querySelectorAll` returns a static list (OK). `getElementsByClassName` returns a live HTMLCollection that re-queries on access. Prefer the static form or cache results.

### 2. Event Lifecycle

- [ ] **All listeners removed on dispose().** Every `addEventListener` must have a matching `removeEventListener` in `dispose()`. Check: paste, scroll, resize, mutation observers, intersection observers.
- [ ] **No anonymous arrow listeners.** Anonymous functions passed to `addEventListener` cannot be removed. Store the reference or use `AbortController`.
- [ ] **Intervals/timeouts cleared on dispose().** Every `setInterval` and `setTimeout` must be cleared. Check spinner intervals, debounce timers, polling loops.
- [ ] **Resize observer disconnected.** If the view creates a `ResizeObserver`, it must call `.disconnect()` on dispose.
- [ ] **Event delegation where appropriate.** A list of 200 items should use one listener on the container, not 200 listeners on individual items.

### 3. Animation & Transitions

- [ ] **No `backdrop-filter: blur()`.** Causes window freeze on transparent WKWebView on macOS. Use solid/semi-transparent backgrounds instead.
- [ ] **`will-change` only on animated elements.** `will-change: transform` promotes to GPU layer. Applied to static elements it wastes VRAM. Check that it's only on elements that actually animate.
- [ ] **Animations use WAAPI or CSS transitions.** JavaScript `requestAnimationFrame` loops for simple opacity/transform is wasteful when CSS transitions or WAAPI suffice.
- [ ] **No animation on hidden elements.** CSS animations (`@keyframes`) on `display: none` elements still run. Use `animation-play-state: paused` or remove the animation class.
- [ ] **Transition durations under 300ms for interactions.** Keyboard-triggered transitions (focus, select, mode switch) should feel instant. Long transitions block perceived responsiveness.

### 4. Memory & Cleanup

- [ ] **No detached DOM trees.** After `dispose()`, verify that `this.element` is removed from the document. Orphaned elements holding references prevent GC.
- [ ] **Large data released on dispose.** Arrays of entries, parsed markdown, highlighted HTML, cached content should be nulled or cleared.
- [ ] **No closure leaks in callbacks.** Event handlers or promises that capture `this` or large objects and outlive the view.
- [ ] **Tauri `listen()` unlisten on dispose.** Every `listen()` call returns an unlisten function. Must be called on dispose to stop receiving IPC events.
- [ ] **Web Workers terminated on dispose.** If the view spawns a Worker, call `worker.terminate()`.

### 5. Layout & Painting

- [ ] **Window positioning uses `transform: translate()`.** Per architecture constraint. Using `top`/`left` directly triggers layout. `transform` is compositor-only (GPU).
- [ ] **No layout thrashing on resize.** Reading layout properties (offsetWidth, getBoundingClientRect) then writing (style.width) in the same frame forces synchronous layout. Batch reads, then writes.
- [ ] **Scrollable containers have `overflow: hidden` or `auto`.** Missing overflow on containers with dynamic content can cause document-level reflow.
- [ ] **`contain: layout` or `contain: content` on isolated views.** CSS containment tells the browser the subtree doesn't affect outside layout, enabling paint optimizations.
- [ ] **Font loading doesn't cause FOUT reflow.** Custom fonts should be preloaded or use `font-display: block` to avoid layout shift on load.

### 6. Rendering Budget

- [ ] **Keypress-to-render < 16ms.** Measure with the profiler HUD or `performance.now()` around the key handler + render call. Target: one frame at 60fps.
- [ ] **Idle CPU < 1%.** No spinning RAF loops, no polling intervals when the view is idle. Check: does the view do anything when no input is happening?
- [ ] **Scroll performance at 60fps.** Virtual scroll or native scroll should not drop frames. Test with 1000+ items if applicable.
- [ ] **Preview/content load doesn't block input.** File reads, markdown parsing, syntax highlighting should be async or chunked. Check: can you navigate while a large file is loading?

### 7. Streaming Content (Agent/Context views)

- [ ] **RAF-gated render during streaming.** Multiple data events per frame should coalesce into one render via `requestAnimationFrame`.
- [ ] **Incremental DOM append, not full re-render.** Streaming text should append to the last element, not rebuild the entire message list.
- [ ] **Scroll-to-bottom is conditional.** Only auto-scroll if the user was already at the bottom. If they scrolled up to read, don't yank them down.
- [ ] **Token/byte counters update at most once per frame.** High-frequency counter updates cause unnecessary repaints.

## Reporting

After running the checklist, produce a table per view:

```
## <ViewName> — src/<file>.ts

| # | Check | Status | Note |
|---|-------|--------|------|
| 1.1 | No innerHTML in hot paths | PASS | One-shot on directory load |
| 1.2 | Virtualization | FAIL | Renders all sidebar items, no virtual scroll |
| ... | ... | ... | ... |

### Summary
- PASS: 18 / FAIL: 3 / N/A: 2
- Critical: [list any FAIL items that are likely to cause user-visible jank]
- Recommended fixes: [ordered by impact]
```

## Anti-patterns

- Don't run the checklist without reading the actual source code. Every check must reference specific line numbers.
- Don't mark N/A without justification. If a view has no list, say "N/A — no list rendering".
- Don't suggest fixes that violate architecture constraints (no CSS frameworks, no frontend frameworks, single native window, keyboard-first).
- Don't recommend premature optimization. A view with 20 items doesn't need virtual scrolling.
