# Sound Themes — Implementation Spec

> Status: Draft
> Date: 2026-03-12
> Milestone: M7 — Sound Effects

## Problem

Sound effects in Krypton are hardcoded as the single `krypton-cyber` pack using a patch-based synthesis model (oscillator definitions + filters + envelopes). Users cannot swap to a different sound aesthetic. Meanwhile, the [ghost-signal](https://github.com/wk-j/ghost-signal) project provides a library of Web Audio API sound themes with a different but compatible architecture: each theme is a JS module exporting `{ meta, createSounds }` where `createSounds(ctx, noiseBuffer)` returns an object of 16 fire-and-forget functions.

The goal is to make sound effects customizable like visual themes — users pick a sound theme from built-in options or install custom ones.

## Solution

Embed the four ghost-signal themes as built-in sound packs alongside `krypton-cyber`. Add a **sound theme adapter** that bridges ghost-signal's function-based sounds to Krypton's `SoundEngine.play(event)` API. Support loading custom sound themes from `~/.config/krypton/sounds/<name>/sounds.js`. The `pack` config key selects the active sound theme; hot-reload applies on change.

## Affected Files

| File | Change |
|------|--------|
| `src/sound.ts` | Add `SoundThemeAdapter` interface, ghost-signal event mapping, `loadSoundTheme()`, refactor `play()`/`playKeypress()` to delegate to active theme |
| `src/sound-themes/` | New directory: embedded ghost-signal theme modules (4 files) |
| `src/config.ts` | Add `sound_theme` to `SoundConfig` type (alias of `pack`), extend `KeyboardType` |
| `src-tauri/src/config.rs` | No Rust changes — sound themes are frontend-only |
| `src/compositor.ts` | Update `applyConfig` to trigger sound theme reload on pack change |
| `src/main.ts` | No changes — theme loading happens inside `SoundEngine.applyConfig()` |

## Design

### Sound Event Mapping

Ghost-signal defines 16 sounds. Krypton defines 30 `SoundEvent` values. The adapter maps Krypton events to ghost-signal sound IDs:

| Krypton Event | Ghost-Signal Sound | Rationale |
|---|---|---|
| `startup` | `IMPORTANT_CLICK` | System-level confirmation |
| `window.create` | `TAB_INSERT` | New element appearing |
| `window.close` | `TAB_CLOSE` | Element disappearing |
| `window.focus` | `HOVER` | Attention/proximity |
| `window.maximize` | `FEATURE_SWITCH_ON` | State toggle on |
| `window.restore` | `FEATURE_SWITCH_OFF` | State toggle off |
| `window.pin` | `LIMITER_ON` | Constraint engaged |
| `window.unpin` | `LIMITER_OFF` | Constraint released |
| `mode.enter` | `CLICK` | Discrete action |
| `mode.exit` | `HOVER_UP` | Stepping back |
| `quick_terminal.show` | `FEATURE_SWITCH_ON` | Toggle on |
| `quick_terminal.hide` | `FEATURE_SWITCH_OFF` | Toggle off |
| `workspace.switch` | `TAB_SLASH` | Navigation command |
| `command_palette.open` | `TAB_SLASH` | Command activation |
| `command_palette.close` | `HOVER_UP` | Dismissal |
| `command_palette.execute` | `IMPORTANT_CLICK` | Confirm action |
| `hint.activate` | `CLICK` | Initiate |
| `hint.select` | `IMPORTANT_CLICK` | Confirm selection |
| `hint.cancel` | `HOVER_UP` | Cancel/dismiss |
| `layout.toggle` | `SWITCH_TOGGLE` | Binary toggle |
| `swap.complete` | `CLICK` | Action complete |
| `resize.step` | `HOVER` | Incremental feedback |
| `move.step` | `HOVER` | Incremental feedback |
| `terminal.bell` | `IMPORTANT_CLICK` | Alert |
| `terminal.exit` | `TAB_CLOSE` | Process ended |
| `tab.create` | `TAB_INSERT` | New tab |
| `tab.close` | `TAB_CLOSE` | Tab removed |
| `tab.switch` | `CLICK` | Navigation |
| `tab.move` | `SWITCH_TOGGLE` | Reorder |
| `pane.split` | `TAB_INSERT` | New pane |
| `pane.close` | `TAB_CLOSE` | Pane removed |
| `pane.focus` | `HOVER` | Focus shift |

### Keyboard Sound Mapping

Ghost-signal provides 4 distinct typing sounds. The `playKeypress()` signature is extended to accept an optional `key` parameter:

```typescript
playKeypress(phase: 'press' | 'release', key?: string): void
```

The compositor passes `domEvent.key` from xterm.js's `onKey` callback:

```typescript
pane.terminal.onKey(({ domEvent }) => {
  this.sound.playKeypress('press', domEvent.key);
  setTimeout(() => this.sound.playKeypress('release', domEvent.key), 30 + Math.random() * 40);
});
```

When a ghost-signal theme is active, the key is routed to the correct typing sound:

| Key | Ghost-Signal Sound |
|---|---|
| `Backspace` | `TYPING_BACKSPACE` |
| `Enter` | `TYPING_ENTER` |
| ` ` (space) | `TYPING_SPACE` |
| Everything else | `TYPING_LETTER` |

Release phase is a no-op for ghost-signal themes (they have no release sounds). When a ghost-signal theme is active, the `keyboard_type` config is ignored — the theme provides its own typing sounds.

### Data Structures

```typescript
/** 
 * A ghost-signal compatible sound theme.
 * `createSounds(ctx, noiseBuffer)` returns an object of fire-and-forget functions.
 */
interface GhostSignalTheme {
  meta: {
    name: string;
    subtitle: string;
    colors: Record<string, string>;
    sounds: Record<string, { label: string; meta: string; desc: string }>;
  };
  createSounds: (
    ctx: AudioContext,
    noiseBuffer: (duration?: number) => AudioBuffer,
  ) => Record<string, () => void>;
}

/**
 * Resolved sound theme: either patch-based (krypton-native) or function-based (ghost-signal).
 */
type ActiveSoundTheme =
  | { type: 'patches'; patches: Record<string, SoundPatch> }
  | { type: 'ghost-signal'; sounds: Record<string, () => void>; theme: GhostSignalTheme };
```

### Built-in Theme Registry

The four ghost-signal themes are copied into `src/sound-themes/` as ES modules:

```
src/sound-themes/
  ghost-signal.ts    # re-export from adapted ghost-signal/sounds.js
  chill-city-fm.ts
  orbit-deck.ts
  mach-line.ts
```

Each file wraps the original `sounds.js` content into a TypeScript module exporting a `GhostSignalTheme` object. The `meta` and `createSounds` function are preserved verbatim.

A registry maps pack names to themes:

```typescript
const BUILT_IN_THEMES: Record<string, () => Promise<GhostSignalTheme>> = {
  'ghost-signal':  () => import('./sound-themes/ghost-signal').then(m => m.default),
  'chill-city-fm': () => import('./sound-themes/chill-city-fm').then(m => m.default),
  'orbit-deck':    () => import('./sound-themes/orbit-deck').then(m => m.default),
  'mach-line':     () => import('./sound-themes/mach-line').then(m => m.default),
};
```

Lazy imports via dynamic `import()` so only the active theme is loaded.

### Custom Theme Loading

Custom themes live at `~/.config/krypton/sounds/<name>/sounds.js`. Loading uses a dynamic `import()` with the Tauri `convertFileSrc()` API to create a valid URL from the filesystem path. The Tauri backend already has `asset:` protocol scope configured.

```typescript
async function loadCustomSoundTheme(name: string): Promise<GhostSignalTheme | null> {
  const basePath = await resolveConfigPath(`sounds/${name}/sounds.js`);
  const url = convertFileSrc(basePath);
  const module = await import(/* @vite-ignore */ url);
  return module.default;
}
```

### Refactored `play()` Flow

```
1. SoundEngine.play('window.create') called
2. Check enabled, cooldown, max concurrent — unchanged
3. If activeTheme.type === 'patches':
     → existing patch-based synthesis (unchanged)
4. If activeTheme.type === 'ghost-signal':
     → lookup event in EVENT_MAP → get ghost-signal sound ID
     → call activeTheme.sounds[soundId]()
     → (the function creates its own oscillators connected to ctx.destination)
```

For ghost-signal themes, the `SoundEngine` still owns the `AudioContext` and passes it to `createSounds()`. The master gain/compressor are bypassed since ghost-signal functions connect directly to `ctx.destination`. To integrate with the master volume, we insert a `GainNode` as `ctx.destination` override — but actually ghost-signal functions hardcode `ctx.destination`. The simplest correct approach: after `createSounds()`, the master volume is controlled by setting `ctx.destination` gain. Since `AudioContext.destination` is read-only, we instead monkey-patch the context's `destination` with a `GainNode`:

```typescript
// Create a volume-controlled context wrapper for ghost-signal themes
const masterGain = ctx.createGain();
masterGain.gain.value = config.volume;
masterGain.connect(ctx.destination);

// Create a proxy context where .destination points to masterGain
const proxyCtx = new Proxy(ctx, {
  get(target, prop) {
    if (prop === 'destination') return masterGain;
    const val = Reflect.get(target, prop);
    return typeof val === 'function' ? val.bind(target) : val;
  }
});

const sounds = theme.createSounds(proxyCtx, noiseBuffer);
```

This way ghost-signal functions that connect to `ctx.destination` actually connect to our gain node, giving us volume control without modifying the theme code.

### Configuration

No new config keys needed. Existing `[sound]` config already supports:

```toml
[sound]
pack = "ghost-signal"       # any built-in or custom theme name
# "krypton-cyber" = original patch-based
# "ghost-signal" | "chill-city-fm" | "orbit-deck" | "mach-line" = ghost-signal themes
# "<custom-name>" = loads from ~/.config/krypton/sounds/<custom-name>/sounds.js
```

When `pack` is a ghost-signal theme, `keyboard_type` is ignored (the theme's `TYPING_LETTER` is used for all keypress sounds).

### Hot-Reload

On `config-changed` event, `SoundEngine.applyConfig()` compares the new `pack` value to the current one. If changed, it calls `loadSoundTheme()` which resolves the new theme (built-in or custom) and swaps `activeTheme`. The old ghost-signal sound functions are dropped (GC cleans up).

### Command Palette Integration

Add a "Switch Sound Theme" action to the command palette that lists available themes. Selecting one updates the config and triggers reload. This mirrors the existing pattern for visual themes.

## Edge Cases

- **Invalid custom theme**: If `sounds.js` fails to import or doesn't export `{ meta, createSounds }`, fall back to `krypton-cyber` and log a warning.
- **Missing sound ID**: If a ghost-signal theme doesn't define a mapped sound (e.g., `SWITCH_TOGGLE` missing), the `play()` call silently no-ops for that event.
- **AudioContext suspension**: Ghost-signal functions assume `ctx` is running. The existing `ensureContext()` already handles resume.
- **Per-event volume overrides**: For ghost-signal themes, per-event volume overrides from `[sound.events]` are not supported (the functions don't accept volume params). The master volume still works via the proxy context.
- **Keyboard release sounds**: Ghost-signal has no key-release sounds. When a ghost-signal theme is active, `playKeypress('release', key)` is a no-op.
- **Key parameter backwards-compatible**: The `key` param is optional. Existing call sites that don't pass it still work — they default to `TYPING_LETTER` for ghost-signal themes and behave identically for patch-based themes (which ignore it).

## Out of Scope

- Creating new ghost-signal themes from within Krypton (use the ghost-signal project directly)
- Mixing sounds from different themes (e.g., keyboard from one, events from another)
- TOML-defined sound patches for custom themes (the existing M7 item; this spec uses JS modules instead)
- Modifying the ghost-signal `sounds.js` files (they're used as-is)
- Visual theme integration with ghost-signal's `meta.colors` (sound and visual themes are independent)
