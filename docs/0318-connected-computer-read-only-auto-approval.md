# Connected Computer Read-Only Auto-Approval — Implementation Spec

> Status: Implemented (manual SSH smoke pending; see Verification)
> Date: 2026-10-21
> Milestone: ACP Harness — cross-computer commands (amends spec 311)

## Problem

Every `computer_exec` / `kryptonctl computer exec` call parks for a human `a`/`r` decision (spec 311 §Command gate). Inspection commands — `ls`, `cat`, `tail`, `df -h`, `ps aux | grep nginx`, `systemctl status app` — dominate remote use, so the user approves a stream of harmless commands one by one. The user wants Krypton to run read-only commands without asking.

## Solution

Add a fail-closed read-only classifier to the app-owned Rust gate in `ConnectedComputerManager::exec`. A command qualifies only when it parses completely in a small POSIX-sh subset (plain words, quotes, `|`, `&&`, `||`, `;`), every pipeline segment names a command from a fixed built-in table, every argument passes that command's option rules, and no word or the effective `cwd` points at a credential dotfile or device/kernel tree. A qualifying command skips the approval row and runs as the argv Krypton parsed, re-quoted, so what was classified is exactly what runs. Anything else — including anything the parser cannot read — takes today's approval path unchanged. Each profile carries `auto_approve_read_only` (default `true`) so a sensitive host can keep asking for every command.

## Research

- **Gate location.** `connected_computers.rs::exec` validates the request, then always inserts an `Approval` oneshot, emits `computer-command-approval`, and waits 120 s; `run_command` writes `cd '<cwd>' || exit 1\n` plus the raw command to remote `sh -s`. MCP (`hook_server.rs`) and CLI (`control.rs` ← `kryptonctl`) both call this one method, so one decision point covers every route. `kryptonctl` joins the words after `--` with spaces before sending, so both routes deliver one command string.
- **Agent-side permission stays as is.** `harness-permission-scan.ts` already auto-allows the `computer_exec` routing call; the human gate lives only in Rust (`computer-approval.ts` header). Classifying in Rust keeps lane permission modes, accept-all flags, Telegram turns and Polly/Salty out of the decision.
- **Spec 311 stance.** Its edge case says Krypton "does not pretend a shell command is safely classifiable from its first word". This design classifies the whole parsed command and every argument, not the first word, and every unknown falls back to the human.
- **Shell semantics.** POSIX §2.2 lists `| & ; < > ( ) $ \` \ " '` and whitespace as always special, and `* ? [ ] ^ ! # ~ = % { , }` as special in some contexts; inside double quotes only `$`, `` ` `` and `\` keep a special meaning. The accepted subset excludes every character whose meaning would differ between the remote shell and Krypton's parse.
- **Git and repo config.** Codex removed Git from its known-safe set because "repository configuration can cause even read-only Git commands to execute helpers" (`core.fsmonitor`, diff drivers, pagers). Git stays on the approval path here.
- **Docker.** Docker's global options (`-H`/`--host`, `--context`, `--config`) parse only before the subcommand: `docker ps -H …`, `docker ps --context x` and `docker logs --config …` fail with `unknown flag` (Docker CLI 27.4). `docker inspect` (`.Config.Env`) and `docker top` (host `ps` options) can print process environments, the same secret class the `ps` rule and the `/proc` guard exclude.
- **Alternatives ruled out.** (a) Prefix/regex rules authored by the user (Zed, Codex exec policy): the user asked for automatic read-only detection, not a rule language; can be added later. (b) Remembering past approvals of an exact command string: does not cover a new path or flag. (c) Passing the raw text to `sh -s` after classification: any parser mismatch would run something unclassified; re-quoting removes that class of bug.

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| Claude Code | A built-in, non-configurable set of read-only Bash commands (`ls`, `cat`, `echo`, `pwd`, `head`, `tail`, `grep`, `find`, `wc`, `which`, `diff`, `stat`, `du`, `cd`, read-only `git`) runs without a prompt. It still prompts for `ps` forms that can print environment variables (`ps auxe`), for `find`/`sort`/`sed` with unquoted globs, for `docker` aimed at another daemon, and for anything it cannot parse. Reads are limited to the working directories. | Matches: whole-command parse, per-command flag rules, `ps` environment rule, fail closed. Diverges: no `git`, no `cd`, no globs, because a remote host has no working-directory boundary. |
| OpenAI Codex CLI | `is_known_safe_command` allowlisted `cat`, `grep`, `head`, `ls`, `wc`, … plus `find` without `-exec`/`-delete`/`-fprint*`, `rg` without `--pre`/`--hostname-bin`/`-z`, and `sed -n {N\|M,N}p`; `bash -lc` scripts qualified when every plain command joined by `&&`, `\|\|`, `;`, `\|` was safe. Git was later removed (commit `3b45c29`), and in Aug 2026 the list was retired in favour of explicit exec-policy rules (commit `942af84`). | Option rules reused. Retirement noted: Krypton keeps a list because the user asked for automatic detection, but adds a per-host off switch and re-quotes the parsed argv. |
| Zed | `agent.tool_permissions` holds `always_allow` / `always_confirm` / `always_deny` regexes per tool. Terminal commands are parsed (brush-parser); every sub-command must match an allow pattern, and an unparseable command disables allow (`crates/agent/src/tool_permissions.rs`). | Matches: every segment must qualify; unparseable falls back to confirmation. |

**Krypton delta** — classification runs in the app-owned gate, not in the agent, and applies to a remote SSH host. Krypton executes the re-quoted argv it classified rather than the original text. The scope is a per-host profile setting, not a session mode.

## Affected Files

| File | Change |
|------|--------|
| `src-tauri/src/computer_read_only.rs` (new), `src-tauri/src/lib.rs` | Parser, command table, path rules, re-quoting; table-driven tests. |
| `src-tauri/src/connected_computers.rs` | `auto_approve_read_only` profile field (store + IPC); `exec` skips the approval park when the classifier returns a script; `run_command` takes the script to send. |
| `src-tauri/src/hook_server.rs`, `src/acp/acp-harness-view.ts` | `computer_exec` description and lane context guidance: read-only commands may run immediately; use `cwd`, not `cd`. |
| `src/connected-computers-view.ts`, `src/styles/connected-computers.css`, `src/connected-computers-view.test.ts` | Checkbox in the editor, setting row in the detail region, save round-trip test. |
| `docs/0311-…`, `docs/0004-architecture.md`, `docs/0005-data-flow.md`, `docs/0006-configuration.md`, `docs/0072-acp-harness-view.md`, `docs/README.md` | Replace "every command requires approval" with the new contract; index spec 318. |

## Design

### Data structures

```rust
// computer_read_only.rs
/// `Some(script)` when `command` qualifies; `script` is the re-quoted form to send to `sh -s`.
pub fn read_only_script(command: &str, cwd: Option<&str>) -> Option<String>;
```

```toml
[[computers]]
id = "prod-db"
host = "prod-db"
auto_approve_read_only = false   # optional; omitted means true
```

`ComputerProfile` gains `autoApproveReadOnly?: boolean` (TS) / `auto_approve_read_only: bool` (Rust, `#[serde(default = true)]`, written only when `false`). `schema_version` stays `1`: the key is optional and older files load unchanged.

### Accepted shell subset

1. One line: CR or LF anywhere → not read-only.
2. Tokens are words and the operators `|`, `&&`, `||`, `;`, separated by spaces or tabs. A word concatenates: unquoted runs of `A–Z a–z 0–9 _ . / , : = + @ % -` or non-ASCII; `'…'` with no `'` inside; `"…"` with no `"`, `$`, `` ` `` or `\` inside.
3. Any other unquoted character (`$ \` \ ( ) { } < > & * ? [ ] ~ # ! ^`, …) → not read-only. This excludes substitution, expansion, globs, redirection, background jobs, subshells and comments.
4. Every segment between operators is non-empty. Its first word must equal a table name exactly — no `/`, no `NAME=value` prefix.
5. Output: each word single-quoted (`'` → `'\''`), operators verbatim, joined by single spaces.

A "short flag `x`" below is the letter `x` anywhere in a word that starts with one `-` (e.g. `-uo`). This is deliberately conservative: an attached value containing `x` also matches and falls back to approval. A listed long option also matches any `--prefix` of it (`--outp=f`, `--recur`), because GNU `getopt_long` accepts unambiguous abbreviations.

### Command table

| Command | Read-only when |
|---------|----------------|
| `cat` `head` `tail` `wc` `ls` `pwd` `echo` `true` `false` `cut` `tr` `nl` `paste` `rev` `tac` `seq` `stat` `which` `whoami` `id` `uname` `df` `du` `free` `uptime` `nproc` `basename` `dirname` `realpath` `readlink` `cmp` `comm` `md5sum` `sha1sum` `sha256sum` `sha512sum` | any arguments |
| `grep` `egrep` `fgrep` | no short flag `r`/`R`/`d`; no `--recursive`, `--dereference-recursive`, `--directories` (`-d recurse` searches recursively, and its value may itself be abbreviated) |
| `diff` | no short flag `r`, no `--recursive` |
| `rg` | no `--pre`, `--hostname-bin`, `--search-zip`, short flag `z`; no `--hidden`, `--unrestricted`, short flag `.`, or two or more `u` across short-flag words (`-uu`, `-u -u`) |
| `find` | none of `-exec` `-execdir` `-ok` `-okdir` `-delete` `-fls` `-fprint` `-fprint0` `-fprintf` |
| `sort` | no short flag `o`, `--output`, `--compress-program` (bare or `=`) |
| `uniq` | at most one operand (a second operand is an output file) |
| `sed` | exactly `sed -n <N>p` or `sed -n <M>,<N>p`, optionally one file |
| `ps` | no `e` or `E` in any word except a `--long` option: `ps -e` prints process environments on BSD/macOS, `ps e`/`ps -E` elsewhere. `ps aux` qualifies; `ps -ef` asks |
| `date` | only `-u`, `--utc`, `-R`, or one `+FORMAT` word |
| `hostname` | no arguments, or exactly `-f` or `-s` |
| `systemctl` | first argument is `status`, `is-active`, `is-enabled`, `is-failed`, `list-units`, `list-unit-files`, `list-timers`, `show` or `cat`; no short flag `H`/`M`, no `--host`, `--machine` |
| `journalctl` | none of `--rotate`, `--vacuum-size`, `--vacuum-time`, `--vacuum-files`, `--flush`, `--sync`, `--relinquish-var`, `--smart-relinquish-var`, `--setup-keys`, `--update-catalog`, `--cursor-file` (bare or `=`) |
| `docker` | first argument is `ps`, `logs`, `stats`, `events`, `images`, `version`, `info` or `port` (so no global option precedes it); no short flag `H`/`c`, no `--host`, `--context`, `--config` anywhere |

Everything else — including `git`, `cd`, `env`, `printenv`, `awk`, `xargs`, `less`, `jq`, other `docker` subcommands (`inspect`, `top`, `exec`, `compose`, `container …`), `kubectl`, `file`, `tree` — takes the approval path.

### Path guard

Applied to the effective `cwd` and to every argument word, plus the part after each `=` in a word:

- Split on `/`, drop empty and `.` components. Any remaining component starting with `.` (`.ssh`, `.env`, `.aws`, `..`) → not read-only. Banning `..` keeps relative words lexically under the checked `cwd`.
- An absolute value whose first component is `dev`, `proc` or `sys` → not read-only (device opens can have side effects; `/proc/<pid>/environ` holds secrets). When `cwd` is `/` or unset (remote login home, unknown path), the same applies to a relative value's first component.

The guard is lexical: it reduces common credential and device reads but is not a confidentiality boundary (see Edge Cases).

### Data flow

```
1. Lane calls computer_exec / kryptonctl computer exec (unchanged routing + capability check).
2. exec(): existing validation (lane binding, length, NUL, timeout, connected target, absolute cwd).
3. If profile.auto_approve_read_only and read_only_script(command, cwd) = Some(script):
     skip the Approval insert, the computer-command-approval event and the 120 s wait.
   Else: today's approval path; on approval script = original command.
4. Common tail (unchanged): lane recheck, capacity 2/host 4/app, ssh -O check, run_command(script),
   bounded output, timeout/cancel → outcome unknown, no retry.
```

No new event or result field: the auto path is visible as the lane's own `computer_exec` / shell tool row with its exact command and output, and no `⚠ remote` row appears.

### UI changes

- Editor: a checkbox `Run read-only commands without asking`, after **Default directory**, in the existing `Tab`/`Shift+Tab` order; `Space` toggles (native). Checked for new profiles.
- Detail region: a `Read-only commands` row showing `Run without asking` or `Always ask`.
- Editing still requires disconnecting first (spec 311), so the setting never changes under an in-flight command.

### Agent guidance

`computer_exec` description and the lane context lines (MCP and `kryptonctl` variants) change from "each command requires separate user approval" to: read-only commands from Krypton's built-in list may run immediately when the computer allows it; any other command waits for the user's approval of the exact command; pass `cwd` (`--cwd`) instead of `cd`, and avoid redirection, `$`, globs and `~` so a read-only command qualifies.

## Edge Cases

- **Not recognized but harmless** (`git log`, `ls *.log`, `cd /srv && ls`): approval row as today; no regression.
- **Mixed pipeline** (`cat f | tee g`, `ls && rm x`): one non-qualifying segment sends the whole command to approval.
- **Quoted operators** (`grep 'a|b' f`, `echo "x;y"`): a literal word inside the argv; qualifies.
- **Lookalikes** (`lsx`, `/bin/ls`, `LD_PRELOAD=x cat f`, `'ls'x`): name mismatch → approval.
- **Long-running** (`tail -f`, `journalctl -f`, `docker logs -f`, `docker stats`/`docker events` without `--no-stream`/`--until`): runs until `timeoutSeconds` (≤ 600) with no prompt; output stays capped at 256 KiB per stream and the 2/host, 4/app cap still applies.
- **Confidentiality**: an auto-approved command can read, and return to the lane's model provider, any non-hidden file the SSH account can read (`/etc/*`, application config with passwords, logs), any container log `docker logs` can read, and `ps aux` shows other processes' arguments. Symlinks are not resolved. Set `auto_approve_read_only = false` on hosts where that is unacceptable.
- **Non-GNU hosts** (BSD, macOS, BusyBox): rules reject the union of known writing/exec/environment options (`ps -e`/`ps -E`, `hostname <name>`, `date <time>`); a missing tool fails as a normal non-zero exit.
- **Remote shell environment**: aliases do not exist in `sh -s`; functions, `PATH` and `~/.zshenv` on the remote host carry the same trust as a manually approved command.
- **Lane in `bypass` / accept-all / Telegram turn**: irrelevant; the decision is the profile setting plus the classifier, never a lane mode.

## Verification

- `computer_read_only.rs` table tests: accepted commands and their re-quoted output; every shell-syntax, lookalike, option and path-guard rejection above, including GNU long-option abbreviations (`sort --outp=`, `grep --recur`), and the Docker rules (listed subcommands qualify; `inspect`, `top`, `exec`, `compose`, management forms and `-H`/`--context`/`--config` in any position ask).
- `connected_computers.rs`: a sidecar without the key loads as `true`; `false` is written and reloads; the default is not written; `auto_approved_script` returns `None` for a `false` profile and for a non-qualifying command.
- `connected-computers-view.test.ts`: the checkbox sends `autoApproveReadOnly` on save (default `true`, cleared `false`) and survives a status-event refresh while editing.
- Smoke (throwaway, local `sh -s`): twelve qualifying commands (pipelines, `&&`/`||`/`;`, quoted `|`/`;`/`'`, empty word, `find -name '*.log'`, `sed -n`, `date +%Y`) produced identical exit code, stdout and stderr from the original text and from the re-quoted script.
- Pending: a manual two-computer SSH smoke through the running app (no SSH server was reachable from the development machine).

## Open Questions

None.

## Out of Scope

- User-authored allow/deny rules or "always allow this command" memory.
- Read-only forms of `git`, `kubectl`, `systemctl --user`, Docker subcommands outside the table (including `docker compose`), and `cd` tracking.
- Globs, `~`, variables, redirections (including `2>/dev/null`) in auto-approved commands.
- Any change to ACP tool-permission auto-allow, lane permission modes, or the manual approval row.

## Resources

- [Claude Code — Configure permissions, "Read-only commands"](https://code.claude.com/docs/en/permissions) — built-in read-only set, `ps` environment rule, glob/flag caveats, parse failure prompts.
- [Codex `is_safe_command.rs` @ 3b45c29](https://github.com/openai/codex/blob/3b45c29062ff0e76e71c91b6753290400e7fa8da/codex-rs/shell-command/src/command_safety/is_safe_command.rs) — allowlist and `find`/`rg`/`sed -n` option rules; plain-command parsing of `&& || ; |`.
- [Codex commit 3b45c29 "Stop treating Git commands as inherently safe"](https://github.com/openai/codex/commit/3b45c29062ff0e76e71c91b6753290400e7fa8da) — repo config can make read-only Git execute helpers.
- [Codex commit af04273 "Block unsafe git global options"](https://github.com/openai/codex/commit/af0427377898290356e47b9b3a3311083d9ed3fb) — how allowlists leaked through global options.
- [Codex commit 942af84 "Retire the untrusted approval policy"](https://github.com/openai/codex/commit/942af8447b1d1addc81fb3c3135293497d479a06) — known-safe list replaced by explicit exec-policy rules.
- Zed `crates/agent/src/tool_permissions.rs` (local `/Users/wk/Source/zed`) — per-tool regex rules; every parsed sub-command must match; unparseable disables allow.
- [POSIX.1-2024 Shell Command Language §2.2 Quoting](https://pubs.opengroup.org/onlinepubs/9799919799/utilities/V3_chap02.html) — always-special and context-special characters; what double quotes preserve.
