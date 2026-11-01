# Native Output Pager Hints (fish) — Implementation Spec

> Status: Implemented
> Date: 2026-11-02
> Milestone: M8 — Polish
> Builds on: [0351](./0351-native-command-output.md) (command blocks, native diff card) · [0352](./0352-native-git-status.md)

## Problem

User, 2026-11-02: "git diff is not working in native view at all, you have to check how tern handle this issue."

A plain `git diff` goes through a pager: `less` by default, or delta. The pager owns what lands in the terminal:
- `less -FRX` (git exports `LESS=FRX`) shows one page on the normal screen. Quitting it with `q` before the end kills git with SIGPIPE (`D;141`).
- What the 0351 card can read is then at best one page of the diff. A page that starts mid-hunk is no diff at all.
- The re-run fallback (0351) adds IPC, a process check and a second git run, and it cannot help an SSH pane.

## Solution

Do what Tern does: keep the diff out of the pager. Krypton ships a fish script that, for the run of a plain `git diff`, exports `GIT_PAGER=cat` and then puts everything back. The whole unified diff then lands in the terminal, and the 0351 buffer path renders it (all files, exit 0). Fish loads the script through `XDG_DATA_DIRS` → `vendor_conf.d`, the way kitty and Tern load their shell integration. Only fish panes, and only while `[native_output] enabled`.

## Research

Tern 0.9.9 (`/Applications/Tern.app`, `so.stencil.tern`; read from the binary's embedded shell scripts):
- Its integration scripts are kitty's (`_ksi_*`, `KITTY_SHELL_INTEGRATION`, `KITTY_FISH_XDG_DATA_DIR`). For fish, Tern puts its directory into `XDG_DATA_DIRS`, so `vendor_conf.d/tern-integration.fish` is sourced at startup.
- With `TERN_LENSES=1`, `__ksi_hints` returns `NAME value` pairs for a command line:
  - `git diff` (unless `GIT_EXTERNAL_DIFF` / `diff.external` / `--no-ext-diff` say otherwise) and `git log|show|branch|tag|stash|reflog|blame|shortlog|grep|ls-files|ls-tree` → `GIT_PAGER cat`;
  - `gh` → `GH_PAGER`, `man` → `MANPAGER`, …
  - lines with `[|;&<>]` get nothing, and `git -p` keeps its pager.
- `__ksi_hint` (on `fish_preexec`) exports each pair, recording what it replaced (`x` exported / `s` set / `u` unset). `__ksi_unhint` (on `fish_postexec`) restores it. Tern then reads the printed output ("lens").
- In fish's `share/config.fish`, vendor conf dirs are `$XDG_DATA_DIRS/fish/vendor_conf.d`, or `$__fish_data_dir/vendor_conf.d` when the variable is unset, plus the build's extra dir, which is always kept.
- Measured in a PTY with the user's login env and git's default pager:
  - `git diff`, then `q` → `D;141` with 36 rows of one page;
  - with the hint → `D;0`, 2 204 rows, all 21 files.

## Prior Art

| App | Implementation |
|-----|---------------|
| Tern | Per-command pager hints from shell integration (`TERN_LENSES`), output read from the terminal |
| kitty | Shell integration loaded via `XDG_DATA_DIRS` / `ENV` / `ZDOTDIR`; the script removes its dir again |

**Krypton delta:** only `git diff` gets a hint, because it is the only output Krypton renders from the buffer; `git status` is re-run as porcelain (0352). Only fish is covered: it is Krypton's shell, and it emits OSC 133 natively.

## Affected Files

| File | Change |
|------|--------|
| `src-tauri/shell-integration/fish/vendor_conf.d/krypton-native-output.fish` | New. XDG cleanup, `__krypton_native_hints`, preexec hint / postexec unhint |
| `src-tauri/src/shell_integration.rs` | New. `native_output_env(shell, inherited_xdg)`: writes the script under `~/.config/krypton/runtime/shell-integration/` and returns the env |
| `src-tauri/src/pty.rs` | `spawn(…, native_output)` adds that env after the login env |
| `src-tauri/src/commands.rs` | `spawn_pty` passes `[native_output] enabled`; SSH clone passes `false` |

## Design

The env a fish pane gets when `[native_output] enabled`:

| Variable | Value |
|---|---|
| `XDG_DATA_DIRS` | `<runtime>/shell-integration:<inherited>`, or `<runtime>/shell-integration:/usr/local/share:/usr/share` when the login env had none |
| `KRYPTON_FISH_XDG_DATA_DIR` | `<runtime>/shell-integration` |
| `KRYPTON_XDG_DATA_DIRS_UNSET` | `1` only when it was unset |
| `KRYPTON_NATIVE_OUTPUT` | `1` |

The script, sourced at fish startup:
1. Removes its directory from `XDG_DATA_DIRS`, or unsets the variable if it was unset, then erases the `KRYPTON_*` variables. Programs started from the pane see the user's own value.
2. Non-interactive shells stop there.
3. `__krypton_native_hints "<line>"` prints `GIT_PAGER cat` only when all of these hold:
   - the line has no `| ; & < >`;
   - after `sudo/env/time/command/nice/nohup` and `NAME=value` words, the program is `git`;
   - after git's options (`-C x`, `-c x`), the subcommand is `diff`, and there was no `-p`/`--paginate`;
   - there is no external diff driver.
4. On `fish_preexec` the hint is exported and the old state is recorded; on `fish_postexec` it is restored.

Raw view now shows git's own coloured diff instead of delta's, as in Tern. The rows are the diff itself.

## Edge Cases

- **zsh/bash, SSH and remote shells:** no hint. The 0351 buffer path still renders a plain diff that reaches the screen, and the local re-run still covers a paged diff.
- **`git -p diff`, `git diff | less`, `git diff > f`:** left alone.
- **difftastic (`diff.external`):** left alone; its output is not a unified diff.
- **A user `GIT_PAGER`:** replaced for the run, then restored to the exact prior state (checked: exported `less` comes back exported).
- **`[native_output] enabled` changed:** applies to panes opened afterwards; open panes keep the env they started with.
- **Very long diffs:** all rows go to scrollback (10 000 by default). A diff longer than the scrollback loses its first marker, so it has no card (0351).

## Verification

- `cargo test shell_integration`: only fish gets the env; it prepends to an inherited value; an unset value is marked for the script; the script is installed once and a stale copy is replaced.
- PTY smoke (throwaway), fish 4.2.1 with the user's login env and the integration directory in `XDG_DATA_DIRS`:
  - the hook loaded, `XDG_DATA_DIRS` was unset again and the flag erased;
  - `git diff` gave `D;0` with 2 204 rows and 21 `diff --git` headers, and `GIT_PAGER` was restored;
  - `git -p diff` stayed in less;
  - with an inherited `/opt/x/share`, `XDG_DATA_DIRS` came back as `/opt/x/share`, and an exported `GIT_PAGER=less` came back exported.
- Not exercised: the installed app (no screen access for the agent).

## Resources

- Tern 0.9.9 binary, embedded `tern-integration` fish/zsh/bash scripts (`__ksi_hints`, `__ksi_hint`, `__ksi_unhint`, `TERN_LENSES`).
- fish 4.2.1 `share/config.fish` — vendor conf dir computation from `XDG_DATA_DIRS`.
- kitty shell integration — `KITTY_FISH_XDG_DATA_DIR` loading and cleanup pattern.
