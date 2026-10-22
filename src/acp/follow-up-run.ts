// Krypton — spec 323: how a `run` follow-up action reaches a terminal.
//
// The tab spawns `/bin/sh -c FOLLOW_UP_SCRIPT krypton-follow-up <command>`.
// The command travels as `$1` and is never spliced into script text, so there
// is no quoting layer to get wrong. It runs in the user's own login shell
// (zsh, bash or fish syntax, whichever `$SHELL` is), and the wrapper then
// `exec`s that shell interactively: a PTY whose process exits closes its tab,
// so the output would otherwise vanish the moment the command finished.
//
// `trap : INT` — Ctrl+C stops the command, not the wrapper. A caught signal is
// reset to its default in children, whereas `trap '' INT` would be inherited
// and leave a dev server unkillable.

const FOLLOW_UP_SCRIPT = [
  'trap : INT',
  "printf '\\n$ %s\\n\\n' \"$1\"",
  '"${SHELL:-/bin/sh}" -lc "$1"',
  "printf '\\n[krypton] exit %s\\n' \"$?\"",
  'exec "${SHELL:-/bin/sh}" -l',
].join('\n');

/** `shellArgs` for `/bin/sh` that run `command`, then leave an interactive login shell. */
export function followUpShellArgs(command: string): string[] {
  return ['-c', FOLLOW_UP_SCRIPT, 'krypton-follow-up', command];
}
