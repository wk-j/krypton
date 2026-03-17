# Sound Engine Silence Bug — Root Cause Analysis & Fix Spec

> Status: Draft
> Date: 2026-03-17
> Milestone: M8 — Polish (bug fix)

## Problem

After running Krypton for an extended period (typically 1-4 hours), all sound effects stop playing. The app remains fully functional otherwise — terminal input/output, window management, and all keybindings work — but every sound (keypresses, UI events, terminal bell) goes permanently silent. Restarting the app is the only recovery.

Two prior mitigations (doc 21: context recycling at 50k sounds; doc 25: buffer caching to reduce node pressure) reduced the frequency of this bug but did not eliminate it. The root cause is a set of interacting lifecycle flaws in the `SoundEngine` class.

## Root Cause Analysis

Four interacting issues cause the silence. They are listed in order of probability — the first is the most common trigger in real-world use.

### 1. `AudioContext.resume()` promise never settles — `resuming` flag stuck forever (Primary)

**Location:** `src/sound.ts:1204-1208` and `src/sound.ts:1232-1236`

When macOS suspends the `AudioContext` (display sleep, audio device change, audio session interruption by another app), the engine calls `this.ctx.resume()`:

```typescript
if (this.ctx.state === 'suspended' && !this.resuming) {
  this.resuming = true;
  this.ctx.resume()
    .catch(() => {})
    .finally(() => { this.resuming = false; });
}
```

In WKWebView (Tauri's macOS WebView), `resume()` can return a Promise that **never settles** when the underlying audio session is interrupted without restoration. When this happens:

- `this.resuming` stays `true` forever — the `.finally()` callback never runs.
- `ensureContext()` sees `this.ctx` is non-null and returns immediately (line 1202-1210), never recreating the context.
- The `statechange` handler (line 1232) also checks `!this.resuming`, so it will never attempt another resume either.
- All subsequent `play()` / `playKeypress()` calls create nodes on the frozen context and call `source.start()`, but no audio reaches the speakers.
- The engine has no way to detect this — it believes it is working correctly.

**Why prior fixes didn't help:** Doc 21 added the `statechange` listener and `resuming` guard, but these are the exact mechanisms that become stuck. Doc 25's buffer cache reduces node count but doesn't address context suspension.

### 2. `warmCache()` not awaited during context recycling — empty cache + stale closures

**Location:** `src/sound.ts:1314` (caller) and `src/sound.ts:1428` (callee)

`warmCache()` is `async` but called fire-and-forget from `maybeRecycleContext()`:

```typescript
// Line 1314 — no await
this.warmCache();
```

This creates two problems:

**a) Empty cache window:** `warmCache()` synchronously clears the cache (`bufferCache.clear()`, `typingLetterPool = []`) at line 1429-1431, then asynchronously re-renders ~22 sounds via `OfflineAudioContext.startRendering()`. During this window (potentially hundreds of milliseconds), every sound falls through to the live synthesis fallback.

**b) Concurrent cache corruption:** If a second `warmCache()` is triggered before the first completes (e.g., rapid recycling, or a theme switch during recycling), the first continues writing entries into `bufferCache` and `typingLetterPool` while the second has already cleared them. The result is a partially populated cache with entries from two different rendering sessions.

**c) Stale ghost-signal buffers:** `prerenderGhostSignalSound()` calls `theme.createSounds(proxy, noiseBuffer)` where `proxy` wraps a new `OfflineAudioContext`. But `theme.createSounds()` is invoked fresh each call, which is fine. However, if the `AudioContext` used for `sampleRate` lookup at line 1365 is the old (now-closing) context, the rendered buffers may have a mismatched sample rate.

### 3. `statechange` handler doesn't invalidate ghost-signal closures

**Location:** `src/sound.ts:1221-1238` (handler) and `src/sound.ts:1064-1075` (live fallback)

When the `statechange` listener detects a `closed` context, it nulls `this.ctx`, `this.masterGain`, `this.compressor`, `this.ghostSignalCtx`, and `this.ghostSignalGain`. But it does **not** update `this.activeTheme.sounds` — the wrapped ghost-signal functions still hold closure references to the now-dead `realCtx` and `gsGain`:

```typescript
// From activateGhostSignalTheme() — these are captured in closures:
const realCtx = this.ctx;        // <- becomes dead after close
const gsGain = this.ctx.createGain(); // <- node on dead context
```

If `play()` is called before `activateGhostSignalTheme()` re-runs on the new context, the live fallback path at line 1064 calls `fn()`, which creates nodes on the dead `realCtx`, producing silence or throwing.

### 4. No audio output health check — engine cannot detect functional silence

**Location:** `src/sound.ts:723-738` (diagnostic test)

The diagnostic `testNode` check (line 723-738) only verifies that `ctx.createOscillator()` doesn't throw. It connects a silent oscillator (`gain.value = 0`) and considers the test passed. This cannot distinguish between:
- A healthy context producing audible output
- A suspended context that accepts nodes but never processes them
- A context where the underlying audio device is disconnected

Without output verification, the engine reports `testNode=ok` while the user hears nothing.

## Solution

Fix all four issues with targeted changes to `SoundEngine`:

1. **Resume timeout:** Add a timeout on `ctx.resume()`. If the promise doesn't settle within 3 seconds, force-recycle the context.
2. **Cache warming guard:** Track `warmCache()` invocations with a generation counter to discard stale renders. Use the new context's sample rate, not the old one.
3. **Closure invalidation:** After `statechange` nulls the context, also set `activeTheme.sounds` to an empty record so stale closures are never called.
4. **Output health probe:** Replace the silent test oscillator with an `AnalyserNode` probe that detects whether audio is actually flowing through the master output.

## Affected Files

| File | Change |
|------|--------|
| `src/sound.ts` | Fix resume timeout, cache warming guard, closure invalidation, output health probe |

## Design

### 1. Resume Timeout

Add a `resumeTimer` field. When `resume()` is called, start a timeout. If the promise hasn't settled in 3 seconds, force-reset the context:

```typescript
private resumeTimer: ReturnType<typeof setTimeout> | null = null;
private static readonly RESUME_TIMEOUT_MS = 3000;

// In ensureContext() and statechange handler, replace the resume block:
private attemptResume(): void {
  if (!this.ctx || this.ctx.state !== 'suspended' || this.resuming) return;
  this.resuming = true;

  // Safety: if resume() never settles, force-recycle after timeout
  this.resumeTimer = setTimeout(() => {
    if (this.resuming) {
      console.warn('[SoundEngine] resume() timed out — recycling context');
      this.resuming = false;
      this.forceRecycleContext();
    }
  }, SoundEngine.RESUME_TIMEOUT_MS);

  this.ctx.resume()
    .catch(() => {})
    .finally(() => {
      this.resuming = false;
      if (this.resumeTimer) {
        clearTimeout(this.resumeTimer);
        this.resumeTimer = null;
      }
    });
}
```

`forceRecycleContext()` is the existing `maybeRecycleContext()` body extracted into an unconditional method (no threshold check).

### 2. Cache Warming Generation Guard

Add a generation counter. Each `warmCache()` call increments it. Pre-render callbacks check the counter before writing to the cache — if it changed, discard the result:

```typescript
private cacheGeneration = 0;

private async warmCache(): Promise<void> {
  const gen = ++this.cacheGeneration;
  this.bufferCache.clear();
  this.typingLetterPool = [];
  this.typingLetterIndex = 0;

  // Use current context's sample rate (after recycling, this is the new context)
  const sampleRate = this.ctx?.sampleRate ?? 44100;

  try {
    if (this.activeTheme.type === 'ghost-signal' && this.activeTheme.theme) {
      const theme = this.activeTheme.theme;
      for (const [key, dur] of Object.entries(SoundEngine.GS_SOUND_DURATIONS)) {
        if (this.cacheGeneration !== gen) return; // superseded
        if (key === 'TYPING_LETTER') continue;
        try {
          const cached = await this.prerenderGhostSignalSound(theme, key, dur);
          if (this.cacheGeneration !== gen) return; // superseded
          this.bufferCache.set(`gs:${key}`, cached);
        } catch { /* skip */ }
      }
      for (let i = 0; i < SoundEngine.TYPING_LETTER_POOL_SIZE; i++) {
        if (this.cacheGeneration !== gen) return; // superseded
        try {
          this.typingLetterPool.push(
            await this.prerenderGhostSignalSound(theme, 'TYPING_LETTER', 0.04),
          );
        } catch { /* skip */ }
      }
    }
    // ... patch-based path with same gen checks ...
  } catch (err) {
    console.error('[SoundEngine] Cache warming failed:', err);
  }
}
```

### 3. Closure Invalidation on Context Death

In the `statechange` handler, after nulling context references, also invalidate the ghost-signal sound functions:

```typescript
if (this.ctx.state === 'closed') {
  this.ctx = null;
  this.masterGain = null;
  this.compressor = null;
  this.ghostSignalCtx = null;
  this.ghostSignalGain = null;
  this.contextSoundCount = 0;
  this.resuming = false;
  if (this.resumeTimer) {
    clearTimeout(this.resumeTimer);
    this.resumeTimer = null;
  }
  // Invalidate stale ghost-signal closures so live fallback
  // doesn't call functions bound to the dead context
  if (this.activeTheme.type === 'ghost-signal') {
    this.activeTheme = {
      type: 'ghost-signal',
      sounds: {},
      theme: this.activeTheme.theme,
    };
  }
}
```

The empty `sounds: {}` means live fallback calls will no-op (`fn` will be `undefined`). The next `ensureContext()` + `activateGhostSignalTheme()` will repopulate them.

### 4. Output Health Probe

Replace the silent test oscillator in `logDiag()` with an `AnalyserNode` check that verifies audio actually flows:

```typescript
// In logDiag(), replace the testNode block:
if (ctx && ctx.state === 'running' && this.compressor) {
  try {
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    this.compressor.connect(analyser);

    // Inject a 1-sample impulse through the graph
    const impulse = ctx.createBuffer(1, 1, ctx.sampleRate);
    impulse.getChannelData(0)[0] = 0.5;
    const src = ctx.createBufferSource();
    src.buffer = impulse;
    const testGain = ctx.createGain();
    testGain.gain.value = 0.001; // inaudible
    src.connect(testGain);
    testGain.connect(this.compressor);
    src.start();

    // Check after one render quantum (~2.9ms at 44100 Hz)
    setTimeout(() => {
      const data = new Float32Array(analyser.frequencyBinCount);
      analyser.getFloatTimeDomainData(data);
      const hasSignal = data.some(v => Math.abs(v) > 0.00001);
      if (!hasSignal) {
        console.warn('[SoundEngine:diag] OUTPUT PROBE FAILED — no signal detected, recycling');
        this.forceRecycleContext();
      }
      try { analyser.disconnect(); src.disconnect(); testGain.disconnect(); } catch {}
    }, 50);
  } catch (err) {
    extraInfo += ` probe=FAIL(${err})`;
  }
}
```

This is run every 30 seconds by the existing diagnostic interval. If the probe fails, the context is force-recycled.

### 5. Extract `forceRecycleContext()`

Refactor recycling into two methods:

```typescript
/** Increment counter and recycle if threshold reached */
private maybeRecycleContext(): void {
  this.contextSoundCount++;
  if (this.contextSoundCount < SoundEngine.CONTEXT_RECYCLE_THRESHOLD) return;
  this.forceRecycleContext();
}

/** Unconditionally recycle the AudioContext */
private forceRecycleContext(): void {
  const oldCtx = this.ctx;
  this.ctx = null;
  this.masterGain = null;
  this.compressor = null;
  this.ghostSignalCtx = null;
  this.ghostSignalGain = null;
  this.contextSoundCount = 0;
  this.resuming = false;
  if (this.resumeTimer) {
    clearTimeout(this.resumeTimer);
    this.resumeTimer = null;
  }

  if (oldCtx) {
    setTimeout(() => { oldCtx.close().catch(() => {}); }, 3000);
  }

  this.ensureContext();

  if (this.activeTheme.type === 'ghost-signal' && this.activeTheme.theme) {
    this.activateGhostSignalTheme(this.activeTheme.theme);
  }

  this.warmCache(); // async — live fallback until ready
}
```

### Data Flow (Recovery Scenario)

```
1. macOS suspends AudioContext (display sleep / device change)
2. statechange fires → attemptResume() called
3. ctx.resume() promise hangs (WKWebView audio session interrupted)
4. After 3 seconds, resumeTimer fires
5. forceRecycleContext():
   a. Old context saved, all references nulled
   b. Ghost-signal closures invalidated (sounds = {})
   c. ensureContext() creates fresh AudioContext + master chain
   d. activateGhostSignalTheme() creates new proxy + wrapped functions
   e. warmCache() starts pre-rendering buffers (async)
   f. Old context closed after 3s grace period
6. Next sound → cache miss → live fallback on new healthy context → audio works
7. warmCache() completes → subsequent sounds use cached buffers
```

```
Alternative: periodic health probe catches silent context
1. Audio stops for unknown reason (context appears "running")
2. 30-second diagnostic interval fires → logDiag()
3. Output probe injects impulse, reads AnalyserNode → no signal detected
4. forceRecycleContext() → same recovery as above
```

## Edge Cases

| Case | Handling |
|------|----------|
| `resume()` settles normally | `resumeTimer` cleared by `.finally()` — no forced recycle |
| `resume()` settles just before timeout | Timer cleared; no double-recycle |
| Multiple suspend/resume cycles in quick succession | `attemptResume()` checks `this.resuming` — only one in-flight at a time; timeout catches stuck ones |
| `warmCache()` called twice rapidly | Generation counter causes first call to abandon writes |
| `statechange` fires `closed` during `warmCache()` | Generation counter causes warmCache to bail; closures invalidated |
| Probe false positive (momentary silence) | Probe only fires every 30s; a single false recycle is harmless (3s grace period protects in-flight sounds) |
| Probe runs after context already recycled | `this.compressor` is null → probe skipped |
| `forceRecycleContext()` called while `warmCache()` is running | Generation counter invalidates the in-flight warmCache |

## Out of Scope

- Replacing Web Audio API with a Rust-side audio engine
- AudioWorklet-based synthesis
- Reducing the 30-second diagnostic interval (already a reasonable balance)
- Handling multiple audio output devices simultaneously
- Persisting audio state across app restarts
