# Sound Buffer Cache — Implementation Spec

> Status: Implemented
> Date: 2026-03-16
> Milestone: M8 — Polish (performance)

## Problem

Every `play()` and `playKeypress()` call synthesizes sound from scratch — creating 10-18 Web Audio nodes per invocation. At 5 keypresses/second this is 50-90 node lifecycle events per second. Over an 8-hour session that is 1.4-2.6 million node cycles, which degrades WebKit's `AudioContext` (doc 21). The current mitigation (recycling at 50k sounds) helps but doesn't address the root cause. Additionally, patch-based sounds allocate a fresh noise `AudioBuffer` with `Math.random()` data for every keypress. Ghost-signal themes have the same problem — each function creates 3-15 nodes per call.

## Solution

**Pre-render all sounds into cached `AudioBuffer`s using `OfflineAudioContext`.** Playback then requires only 2 nodes (`AudioBufferSourceNode` + `GainNode`) instead of 10-18. This applies to **both** theme types:

1. **Patch-based** (`krypton-cyber`) — Refactor `synthesize()` into a `buildSoundGraph()` that works with any `BaseAudioContext`. Pre-render each `SoundPatch` via `OfflineAudioContext`.

2. **Ghost-signal themes** — Each sound function already operates on a `ctx` parameter. During cache warming, create an `OfflineAudioContext`, build a proxy that redirects `ctx.destination` to it, invoke the sound function, and render. For `TYPING_LETTER` (which has random frequency variants), pre-render a pool of ~8 variants and cycle through them at playback.

Both paths converge on the same `playCached()` method: buffer source + gain node + compressor.

## Affected Files

| File | Change |
|------|--------|
| `src/sound.ts` | Add buffer cache, `prerenderPatch()`, `prerenderGhostSignal()`, `playCached()`, `warmCache()`, integrate into `play()`/`playKeypress()`, update `maybeRecycleContext()` and `loadTheme()` |

## Design

### Data Structures

```typescript
/** Cached pre-rendered sound buffer */
interface CachedBuffer {
  buffer: AudioBuffer;
  duration: number;  // seconds
}

/** New private fields on SoundEngine */
private bufferCache: Map<string, CachedBuffer> = new Map();

/** Pool of TYPING_LETTER variants for ghost-signal themes (round-robin) */
private typingLetterPool: CachedBuffer[] = [];
private typingLetterIndex = 0;

/** Number of TYPING_LETTER variants to pre-render per ghost-signal theme */
private static readonly TYPING_LETTER_POOL_SIZE = 8;
```

### Patch-Based Pre-Rendering

Refactor `synthesize()` so the node-building works with any `BaseAudioContext`:

```typescript
/**
 * Build the full sound graph for a patch on any audio context.
 * Used for both live playback (AudioContext) and offline pre-rendering (OfflineAudioContext).
 */
private buildSoundGraph(
  ctx: BaseAudioContext,
  patch: SoundPatch,
  volume: number,
  destination: AudioNode,
): { nodes: AudioNode[]; duration: number } {
  // ... same logic as current synthesize(), but:
  //   - uses the `ctx` param instead of `this.ctx!`
  //   - connects final output to `destination` instead of `this.compressor!`
  //   - returns nodes + computed duration instead of managing cleanup
}

private async prerenderPatch(patch: SoundPatch): Promise<CachedBuffer> {
  const env = patch.envelope;
  const duration = env.attack + env.decay + env.sustain * 0.1 + env.release + 0.05;
  const sampleRate = this.ctx?.sampleRate ?? 44100;
  const offline = new OfflineAudioContext(1, Math.ceil(sampleRate * duration), sampleRate);

  this.buildSoundGraph(offline, patch, 1.0, offline.destination);

  const rendered = await offline.startRendering();
  return { buffer: rendered, duration };
}
```

### Ghost-Signal Pre-Rendering

Each ghost-signal sound function calls `ctx.create*()` and connects to `ctx.destination`. To pre-render:

1. Create an `OfflineAudioContext` sized for the sound's duration (known from the theme's `meta.sounds` metadata, or a safe upper bound)
2. Build a proxy identical to the existing one in `activateGhostSignalTheme()`, but pointing at the offline context with `destination` → `offline.destination`
3. Invoke the sound function — it creates nodes on the offline context
4. Call `offline.startRendering()` to get the `AudioBuffer`

```typescript
private async prerenderGhostSignalSound(
  theme: GhostSignalTheme,
  soundKey: string,
  duration: number,
): Promise<CachedBuffer> {
  const sampleRate = this.ctx?.sampleRate ?? 44100;
  const offline = new OfflineAudioContext(
    1, Math.ceil(sampleRate * duration), sampleRate,
  );

  // Build a noise buffer helper for the offline context
  const noiseBuffer = (dur = 0.1): AudioBuffer => {
    const len = Math.ceil(sampleRate * dur);
    const buf = offline.createBuffer(1, len, sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  };

  // Proxy: redirect destination, bind create* to offline context
  const proxy = new Proxy(offline as unknown as AudioContext, {
    get(target, prop: string | symbol): unknown {
      if (prop === 'destination') return offline.destination;
      const val = Reflect.get(target, prop);
      if (typeof val === 'function') return (val as Function).bind(target);
      return val;
    },
  });

  // Create and invoke just this one sound function
  const allSounds = theme.createSounds(proxy, noiseBuffer);
  const fn = allSounds[soundKey];
  if (fn) fn();

  const rendered = await offline.startRendering();
  return { buffer: rendered, duration };
}
```

### Ghost-Signal Sound Durations

Each sound function has a known duration from the source code. These are encoded as a lookup:

```typescript
/** Max duration (seconds) for each ghost-signal sound key */
private static readonly GS_SOUND_DURATIONS: Record<string, number> = {
  HOVER: 0.08,
  HOVER_UP: 0.07,
  CLICK: 0.05,
  IMPORTANT_CLICK: 0.15,
  FEATURE_SWITCH_ON: 0.30,
  LIMITER_ON: 0.25,
  SWITCH_TOGGLE: 0.05,
  TAB_INSERT: 0.15,
  TAB_CLOSE: 0.12,
  TAB_SLASH: 0.20,
  TYPING_LETTER: 0.04,
  TYPING_BACKSPACE: 0.05,
  TYPING_ENTER: 0.10,
  TYPING_SPACE: 0.05,
  APP_START: 1.40,
};
```

These are conservative upper bounds. All 5 ghost-signal themes have similar durations since they share the same sound structure.

### TYPING_LETTER Variant Pool

`TYPING_LETTER` uses `Math.random()` for frequency variation (19 possible body frequencies, randomized noise center). To preserve this variety:

- Pre-render a pool of 8 variants. Each invocation of `prerenderGhostSignalSound()` for `TYPING_LETTER` naturally produces a different variant because `Math.random()` runs during offline rendering.
- At playback, cycle through the pool round-robin (no extra randomness needed — the pool itself provides variation).

```typescript
// During warmCache() for ghost-signal themes:
this.typingLetterPool = [];
for (let i = 0; i < SoundEngine.TYPING_LETTER_POOL_SIZE; i++) {
  this.typingLetterPool.push(
    await this.prerenderGhostSignalSound(theme, 'TYPING_LETTER', 0.04),
  );
}
this.typingLetterIndex = 0;
```

### Cached Playback (shared by both theme types)

```typescript
private playCached(cached: CachedBuffer, volume: number): void {
  const ctx = this.ctx!;
  const source = ctx.createBufferSource();
  source.buffer = cached.buffer;

  const gain = ctx.createGain();
  gain.gain.value = volume;

  source.connect(gain);
  gain.connect(this.compressor!);

  const soundId = this.trackSound(cached.duration * 1000 + 200);
  source.addEventListener('ended', () => {
    this.untrackSound(soundId);
    try { source.disconnect(); } catch {}
    try { gain.disconnect(); } catch {}
  }, { once: true });

  source.start();
}
```

### Cache Warming

```typescript
private async warmCache(): Promise<void> {
  this.bufferCache.clear();
  this.typingLetterPool = [];
  this.typingLetterIndex = 0;

  const sampleRate = this.ctx?.sampleRate ?? 44100;

  try {
    if (this.activeTheme.type === 'ghost-signal' && this.activeTheme.theme) {
      const theme = this.activeTheme.theme;

      // Pre-render all ghost-signal sounds
      for (const [key, durInfo] of Object.entries(SoundEngine.GS_SOUND_DURATIONS)) {
        if (key === 'TYPING_LETTER') continue;  // handled separately as pool
        const cached = await this.prerenderGhostSignalSound(theme, key, durInfo);
        this.bufferCache.set(`gs:${key}`, cached);
      }

      // Pre-render TYPING_LETTER pool
      for (let i = 0; i < SoundEngine.TYPING_LETTER_POOL_SIZE; i++) {
        this.typingLetterPool.push(
          await this.prerenderGhostSignalSound(theme, 'TYPING_LETTER', 0.04),
        );
      }
    } else {
      // Patch-based: pre-render all event patches + all keyboard patches
      for (const [, patch] of Object.entries(this.patches)) {
        if (!patch) continue;
        const key = SoundEngine.patchCacheKey(patch);
        if (!this.bufferCache.has(key)) {
          this.bufferCache.set(key, await this.prerenderPatch(patch));
        }
      }
      for (const [, patchSet] of Object.entries(KEYBOARD_PATCHES)) {
        for (const phase of ['press', 'release'] as const) {
          const patch = patchSet[phase];
          const key = SoundEngine.patchCacheKey(patch);
          if (!this.bufferCache.has(key)) {
            this.bufferCache.set(key, await this.prerenderPatch(patch));
          }
        }
      }
    }
  } catch (err) {
    console.error('[SoundEngine] Cache warming failed, using live synthesis:', err);
  }
}
```

### Integration into playKeypress()

Ghost-signal path:
```typescript
if (this.activeTheme.type === 'ghost-signal') {
  if (phase === 'release') return;

  if (soundId === 'TYPING_LETTER' && this.typingLetterPool.length > 0) {
    const cached = this.typingLetterPool[this.typingLetterIndex];
    this.typingLetterIndex = (this.typingLetterIndex + 1) % this.typingLetterPool.length;
    this.playCached(cached, this.config.volume);
  } else {
    const cached = this.bufferCache.get(`gs:${soundId}`);
    if (cached) {
      this.playCached(cached, this.config.volume);
    } else {
      // Fallback: live synthesis (cache not ready)
      const fn = sounds[soundId];
      if (fn) fn();
    }
  }
  this.totalSoundsPlayed++;
  this.maybeRecycleContext();
  return;
}
```

Patch-based path:
```typescript
const cacheKey = SoundEngine.patchCacheKey(basePatch);
const cached = this.bufferCache.get(cacheKey);
if (cached) {
  this.playCached(cached, volume * ampJitter);
} else {
  this.synthesize(patch, volume);
}
```

### Integration into play()

Ghost-signal path:
```typescript
const ghostSoundId = GHOST_SIGNAL_EVENT_MAP[event];
const cached = this.bufferCache.get(`gs:${ghostSoundId}`);
if (cached) {
  this.playCached(cached, this.config.volume);
} else {
  // Fallback: live synthesis
  const fn = this.activeTheme.sounds[ghostSoundId];
  if (fn) fn();
}
```

### Context Recycling Integration

`AudioBuffer` objects are **not** tied to a specific `AudioContext` — they can be replayed on any context with the same sample rate. Since sample rate typically doesn't change between context instances, the cache survives recycling. Only clear if sample rate differs:

```typescript
private maybeRecycleContext(): void {
  this.contextSoundCount++;
  if (this.contextSoundCount < SoundEngine.CONTEXT_RECYCLE_THRESHOLD) return;

  const oldSampleRate = this.ctx?.sampleRate;
  // ... existing null-out and recreate logic ...

  // Only invalidate cache if sample rate changed (extremely rare)
  if (this.ctx && this.ctx.sampleRate !== oldSampleRate) {
    this.warmCache();
  }
}
```

With caching, raise `CONTEXT_RECYCLE_THRESHOLD` from 50,000 to 500,000. Each cached playback creates only 2 nodes instead of ~15, so the effective node count at 500k sounds is equivalent to ~67k sounds under the old regime.

### Theme Switch Integration

In `loadTheme()`, after activating the new theme:
```typescript
this.warmCache();  // async — sounds fall back to live synthesis until ready
```

### Data Flow

```
1. App starts / theme loads → warmCache()
   Patch-based: each SoundPatch → OfflineAudioContext → AudioBuffer → cache
   Ghost-signal: each sound fn invoked on OfflineAudioContext → AudioBuffer → cache
                 TYPING_LETTER → 8 variants pre-rendered into pool

2. User presses key → playKeypress()
3. ensureContext() verifies ctx is alive
4. Cache lookup:
   Ghost-signal TYPING_LETTER → pool[index++ % 8] → playCached()
   Ghost-signal other → bufferCache.get('gs:KEY') → playCached()
   Patch-based → bufferCache.get(patchKey) → playCached()
   Cache miss → fallback to live synthesis (same as today)
5. playCached(): AudioBufferSourceNode + GainNode → compressor → master
   (2 nodes instead of 10-18)
6. contextSoundCount++ — recycle threshold now 500k
```

## Edge Cases

| Case | Handling |
|------|----------|
| Cache not yet warmed (first sounds after start) | Falls back to live synthesis — same as today |
| `OfflineAudioContext` constructor throws | Catch, leave cache empty, live synthesis fallback |
| `startRendering()` fails | Catch per-sound, skip that entry, live fallback for it |
| Context recycling | Cache survives if sample rate unchanged; re-warms only on rate change |
| Ghost-signal `TYPING_LETTER` pool exhausted | Round-robin cycles — pool never exhausts |
| Ghost-signal `FEATURE_SWITCH_ON` vs `FEATURE_SWITCH_OFF` | These are separate sound keys — each cached independently |
| Theme switch during cache warming | `warmCache()` clears and restarts — no stale entries |
| Volume/keyboard_volume changes at runtime | Applied at playback `GainNode` — cache unaffected |
| Ghost-signal sound fn calls `Math.random()` | Randomness baked into the pre-rendered buffer; pool provides variety for TYPING_LETTER |
| Different ghost-signal themes have different durations | `GS_SOUND_DURATIONS` uses conservative upper bounds; silent tail is harmless |

## Out of Scope

- Disk-based cache persistence across sessions
- AudioWorklet-based playback
- Dynamically adjusting pool size based on typing speed
- Pre-rendering with stereo (mono is sufficient — all sounds are mono or near-center pan)
