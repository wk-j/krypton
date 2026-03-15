# Sound Engine Resilience — Implementation Spec

> Status: Implemented
> Date: 2026-03-15
> Milestone: M8 — Polish (bug fix)

## Problem

After running Krypton for extended periods (hours), sound effects stop playing entirely. Users hear nothing — no keypress sounds, no UI event sounds. The issue does not recover until the app is restarted.

## Root Cause Analysis

Two interacting issues cause this:

### 1. AudioContext degradation (primary)

Each keypress creates 10-18 Web Audio nodes (oscillators, gains, filters) for press+release. At 5 characters/second, that's 50-90 node create/destroy cycles per second — over an 8-hour session, **1.4–2.6 million node lifecycle events**. WebKit's `AudioContext` (used by Tauri's WKWebView on macOS) accumulates internal state from these cycles and eventually enters a degraded state where new sounds fail silently.

The ghost-signal proxy cleanup (600ms `setTimeout` → `node.disconnect()`) correctly releases nodes, but the `AudioContext` itself retains internal bookkeeping that grows over time.

### 2. AudioContext state not monitored (secondary)

`ensureContext()` calls `ctx.resume()` on `suspended` state, but:
- The `resume()` Promise result is ignored (fire-and-forget)
- There is no `statechange` event listener — the engine never detects if the context transitions to `closed` or becomes permanently suspended (e.g., after macOS display sleep)
- If the context becomes non-functional, `this.ctx` remains non-null, so `ensureContext()` is a no-op and all subsequent `synthesize()` calls produce silence

## Solution

Add **AudioContext health monitoring and automatic recycling** to `SoundEngine`:

1. **State listener**: Listen for `statechange` events on the `AudioContext`. If the context enters `closed` state, null it out so the next `ensureContext()` recreates it.
2. **Proactive recycling**: After a configurable number of sounds (default: 50,000), create a fresh `AudioContext`, migrate the master chain, and close the old one. This prevents WebKit degradation.
3. **Await resume**: Make `ensureContext()` aware of pending resume operations to avoid synthesizing into a suspended context.

## Affected Files

| File | Change |
|------|--------|
| `src/sound.ts` | Add `statechange` listener, sound counter, context recycling logic, resume-aware guard |

## Design

### Data Structures

Add to `SoundEngine` private fields:

```typescript
/** Number of sounds played on the current AudioContext instance */
private contextSoundCount = 0;

/** Threshold: recycle AudioContext after this many sounds */
private static readonly CONTEXT_RECYCLE_THRESHOLD = 50_000;

/** Flag: context is currently being resumed (avoid double-resume) */
private resuming = false;
```

### AudioContext State Listener

In `ensureContext()`, after creating the `AudioContext`, attach a `statechange` listener:

```typescript
this.ctx.addEventListener('statechange', () => {
  if (!this.ctx) return;
  if (this.ctx.state === 'closed') {
    // Context is dead — null everything so next ensureContext() recreates
    this.ctx = null;
    this.masterGain = null;
    this.compressor = null;
    this.ghostSignalCtx = null;
    this.ghostSignalGain = null;
    this.contextSoundCount = 0;
  } else if (this.ctx.state === 'suspended' && !this.resuming) {
    this.resuming = true;
    this.ctx.resume()
      .catch(() => { /* best-effort */ })
      .finally(() => { this.resuming = false; });
  }
});
```

### Context Recycling

After each successful `play()` or `playKeypress()` call, increment `contextSoundCount`. When it exceeds `CONTEXT_RECYCLE_THRESHOLD`, recycle:

```typescript
private maybeRecycleContext(): void {
  this.contextSoundCount++;
  if (this.contextSoundCount < SoundEngine.CONTEXT_RECYCLE_THRESHOLD) return;

  const oldCtx = this.ctx;

  // Null out references so ensureContext() creates a fresh context
  this.ctx = null;
  this.masterGain = null;
  this.compressor = null;
  this.ghostSignalCtx = null;
  this.ghostSignalGain = null;
  this.contextSoundCount = 0;

  // Close old context after a grace period (let in-flight sounds finish)
  if (oldCtx) {
    setTimeout(() => {
      oldCtx.close().catch(() => {});
    }, 3000);
  }

  // Recreate immediately so the next sound works
  this.ensureContext();

  // Re-activate ghost-signal theme if one was active
  if (this.activeTheme.type === 'ghost-signal' && this.activeTheme.theme) {
    this.activateGhostSignalTheme(this.activeTheme.theme);
  }
}
```

### Updated ensureContext()

```typescript
private ensureContext(): void {
  if (this.ctx) {
    if (this.ctx.state === 'suspended' && !this.resuming) {
      this.resuming = true;
      this.ctx.resume()
        .catch(() => {})
        .finally(() => { this.resuming = false; });
    }
    return;
  }

  try {
    this.ctx = new AudioContext();
    this.contextSoundCount = 0;

    // State monitoring
    this.ctx.addEventListener('statechange', () => {
      if (!this.ctx) return;
      if (this.ctx.state === 'closed') {
        this.ctx = null;
        this.masterGain = null;
        this.compressor = null;
        this.ghostSignalCtx = null;
        this.ghostSignalGain = null;
        this.contextSoundCount = 0;
      } else if (this.ctx.state === 'suspended' && !this.resuming) {
        this.resuming = true;
        this.ctx.resume()
          .catch(() => {})
          .finally(() => { this.resuming = false; });
      }
    });

    if (this.ctx.state === 'suspended') {
      this.resuming = true;
      this.ctx.resume()
        .catch(() => {})
        .finally(() => { this.resuming = false; });
    }

    // Master channel: compressor -> gain -> destination
    this.compressor = this.ctx.createDynamicsCompressor();
    this.compressor.threshold.value = -3;
    this.compressor.knee.value = 10;
    this.compressor.ratio.value = 8;
    this.compressor.attack.value = 0.003;
    this.compressor.release.value = 0.1;

    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = this.config.volume;

    this.compressor.connect(this.masterGain);
    this.masterGain.connect(this.ctx.destination);
  } catch {
    this.ctx = null;
    this.masterGain = null;
    this.compressor = null;
  }
}
```

### Integration Points

In `playKeypress()`, after the sound is dispatched (both patch-based and ghost-signal paths):
```typescript
this.maybeRecycleContext();
```

In `play()`, after `this.synthesize(patch, eventVolume)`:
```typescript
this.maybeRecycleContext();
```

### Data Flow

```
1. User presses key → playKeypress() called
2. ensureContext() verifies ctx is alive and running
3. Sound is synthesized (patch-based) or invoked (ghost-signal)
4. contextSoundCount incremented
5. If count >= 50,000:
   a. Old AudioContext saved to variable
   b. All references nulled
   c. ensureContext() creates fresh AudioContext + master chain
   d. Ghost-signal theme re-activated if applicable
   e. Old context closed after 3s grace period
6. Next sound plays on the fresh context — no audible gap
```

## Edge Cases

| Case | Handling |
|------|----------|
| Context recycling during active sound | 3s grace period before `close()` lets in-flight sounds finish |
| Ghost-signal theme active during recycle | Theme is re-activated with fresh proxy context |
| `AudioContext()` constructor throws | Silent degradation — same as current behavior |
| `close()` on old context throws | `.catch(() => {})` swallows the error |
| Rapid recycling (shouldn't happen) | Counter resets to 0 on recycle, needs another 50k sounds |
| macOS display sleep suspends context | `statechange` handler auto-resumes; if resume fails, next `ensureContext()` recreates |
| Context enters `closed` from external cause | `statechange` handler nulls everything; next sound recreates |
| Theme switch during recycling | `loadTheme()` calls `activateGhostSignalTheme()` which calls `ensureContext()` — works correctly since recycling ensures a live context |

## Out of Scope

- Changing the node-per-sound architecture (e.g., pre-built audio graphs with pooled nodes)
- Reducing node count per keypress sound
- AudioWorklet-based synthesis
- Sound effect file caching (`.wav`/`.mp3`)
