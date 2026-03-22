# Config Flush Defaults — Implementation Spec

> Status: Implemented
> Date: 2026-03-22
> Milestone: N/A — Developer experience improvement

## Problem

When new configuration fields are added to the Rust `KryptonConfig` structs, existing users' `krypton.toml` files don't include those new keys. The user has no visibility into new options unless they read the changelog or docs. Serde's `#[serde(default)]` fills in defaults at runtime, but the file on disk stays stale.

## Solution

After loading and deserializing the config (which already merges defaults for missing fields via `#[serde(default)]`), serialize the fully-populated config back to disk. This "flushes" any new fields into the user's file with their default values. The flush runs on every startup and on every hot-reload, ensuring the file always reflects the complete schema.

## Affected Files

| File | Change |
|------|--------|
| `src-tauri/src/config.rs` | Add `flush_config()` function; call it after successful load in `load_config()` |

## Design

### New Function

```rust
/// Write the fully-populated config back to disk, adding any new
/// fields that were missing from the user's file.
fn flush_config(path: &PathBuf, config: &KryptonConfig) {
    match toml::to_string_pretty(config) {
        Ok(toml_str) => {
            let content = format!(
                "# Krypton configuration\n\
                 # See docs/06-configuration.md for full reference\n\n\
                 {toml_str}"
            );
            if let Err(e) = fs::write(path, &content) {
                log::error!("Failed to flush config to {}: {e}", path.display());
            } else {
                log::debug!("Flushed config to {}", path.display());
            }
        }
        Err(e) => {
            log::error!("Failed to serialize config for flush: {e}");
        }
    }
}
```

### Data Flow

1. `load_config()` reads and deserializes `krypton.toml` — serde fills missing fields with defaults
2. `flush_config()` serializes the complete config back to `krypton.toml`
3. The filesystem watcher sees the write and fires a change event
4. The debounce (300ms) coalesces the watcher event — since the config content is identical to what's in memory, the reload is a no-op in practice

### Changes to `load_config()`

After the successful `toml::from_str` parse, and after the parse-error fallback, call `flush_config(&path, &config)` before returning. This covers both cases:
- **Normal load**: flushes any newly-added default fields
- **Parse error fallback**: overwrites the broken file with valid defaults (recoverable)

The first-run path (`write_default_config`) stays unchanged — it already writes the full config.

### Watcher Re-trigger

`flush_config()` compares the serialized content against the existing file and only writes if they differ. This prevents triggering the filesystem watcher and avoids a hot-reload loop.

## Edge Cases

- **User comments in TOML**: `toml::to_string_pretty` does not preserve comments. User comments will be stripped on first flush. This is acceptable — the config file header directs users to the docs for reference.
- **Concurrent file edits**: If the user saves the file at the exact moment flush writes, the user's edit could be lost. The 300ms debounce + hot-reload will re-read and re-flush, so the window is extremely small and self-healing.
- **Parse error recovery**: When the file has syntax errors, flushing defaults overwrites the broken file. This is intentional — the user gets a working config instead of being stuck.
- **Filesystem permissions**: If the file is read-only, the flush logs an error and continues. The app still works with the in-memory config.

## Open Questions

None.

## Out of Scope

- Preserving user comments in TOML (would require a TOML-editing library like `toml_edit`)
- Selective/partial flush (only writing missing keys while preserving existing structure)
- UI notification when new config keys are added
