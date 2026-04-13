---
name: ghost-signal-theme
description: Register a new ghost-signal sound theme into Krypton. Use when the user wants to add a sound pack from the ghost-signal project. Triggers on "add sound theme", "new sound pack", "ghost-signal", or referencing a WAV directory to integrate.
---

## What I do

Automate the complete process of integrating a new ghost-signal sound theme into Krypton's sound engine. Ghost-signal themes export 17 WAV files with a fixed naming convention. This skill handles copying the files, registering the pack in both backend and frontend, updating documentation, and verifying the build.

## When to use me

Use this skill whenever:
- The user wants to add a new sound theme / sound pack
- The user references a ghost-signal theme directory containing WAV files
- The user asks to register or integrate a new set of sound WAVs

## When NOT to use me

Skip this skill for:
- Changing sound configuration (volume, enabled, per-event overrides) — that's just config editing
- Modifying the sound engine architecture (event mapping, overlap management, audio thread)
- Removing or renaming an existing sound pack

## Prerequisites

A ghost-signal theme directory must contain exactly these 17 WAV files:

```
APP_START.wav          LIMITER_OFF.wav        TAB_SLASH.wav
CLICK.wav              LIMITER_ON.wav         TYPING_BACKSPACE.wav
FEATURE_SWITCH_OFF.wav SWITCH_TOGGLE.wav      TYPING_ENTER.wav
FEATURE_SWITCH_ON.wav  TAB_CLOSE.wav          TYPING_LETTER.wav
HOVER.wav              TAB_INSERT.wav         TYPING_SPACE.wav
HOVER_UP.wav
IMPORTANT_CLICK.wav
```

If any files are missing, warn the user before proceeding — missing WAVs will cause silent failures for the corresponding events.

## Steps

### 1. Determine Pack Identity

Derive the pack ID and display name:
- **Pack ID**: kebab-case directory name (e.g., `holo-dash`, `neon-pulse`). This is used in config files and internal references.
- **Display name**: Title Case version (e.g., "Holo Dash", "Neon Pulse"). This appears in the command palette.

If the source path structure is `ghost-signal/<theme-name>/wav/`, use `<theme-name>` as the pack ID.

Ask the user to confirm the pack ID and display name if they aren't obvious from context.

### 2. Validate Source WAVs

Read the source directory listing and verify all 17 required WAV files are present. Report any missing files to the user.

### 3. Copy WAV Files

Copy the WAV files to Krypton's bundled sounds directory:

```
src-tauri/sounds/<pack-id>/
```

The `tauri.conf.json` resource glob (`sounds/**/*`) automatically picks up new subdirectories — no config change needed.

### 4. Register in Rust Backend

Edit `src-tauri/src/sound.rs` — add a new entry to the `available_packs()` function:

```rust
SoundPack {
    id: "<pack-id>".into(),
    display_name: "<Display Name>".into(),
},
```

Add it at the end of the existing `vec![]`, before the closing bracket.

### 5. Register in Frontend

Edit `src/sound.ts` — add a new entry to the `PACK_DISPLAY_NAMES` constant:

```typescript
'<pack-id>': '<Display Name>',
```

### 6. Update Documentation

Edit `docs/17-sound-themes.md`:

**Section 2 — Built-in Packs table**: Add a new row:

```markdown
| `<pack-id>` | `src-tauri/sounds/<pack-id>/` | <Brief description> |
```

**Section 8 — Configuration**: Update the `pack` field comment to list the new pack as a valid value.

**Section 9 — Affected Files table**: Add a new row for the pack directory:

```markdown
| `src-tauri/sounds/<pack-id>/` | 17 WAV files — <Display Name> pack (bundled as Tauri resource) |
```

### 7. Verify Build

Run both build checks to confirm nothing is broken:

```sh
cargo build              # from src-tauri/
npx tsc --noEmit         # from project root
```

Both must pass with no errors.

### 8. Report

Summarize what was done:
- Number of WAV files copied
- Pack ID and display name
- Files modified (sound.rs, sound.ts, docs/17-sound-themes.md)
- How to activate: command palette "Sound Theme" category, or `pack = "<pack-id>"` in `[sound]` config

## Files Modified

Every ghost-signal theme registration touches exactly these files:

| File | Change |
|------|--------|
| `src-tauri/sounds/<pack-id>/` | New directory with 17 WAV files |
| `src-tauri/src/sound.rs` | New entry in `available_packs()` |
| `src/sound.ts` | New entry in `PACK_DISPLAY_NAMES` |
| `docs/17-sound-themes.md` | Pack table, config example, affected files table |

## Checklist

Before declaring complete, verify:
- [ ] All 17 WAV files present in `src-tauri/sounds/<pack-id>/`
- [ ] `available_packs()` in `sound.rs` includes the new pack
- [ ] `PACK_DISPLAY_NAMES` in `sound.ts` includes the new pack
- [ ] `docs/17-sound-themes.md` updated (pack table, config, affected files)
- [ ] `cargo build` passes
- [ ] `npx tsc --noEmit` passes

## Anti-patterns

- Forgetting the frontend `PACK_DISPLAY_NAMES` entry — the command palette will show a raw ID instead of a display name
- Modifying `tauri.conf.json` resources — the `sounds/**/*` glob already covers all subdirectories
- Adding packs with inconsistent WAV file naming (lowercase, missing files) — the engine loads by exact name match
- Skipping the documentation update — the sound spec becomes stale
