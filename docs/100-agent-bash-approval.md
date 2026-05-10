# Agent Bash Approval — Implementation Spec

> Status: Implemented
> Date: 2026-05-11
> Milestone: Agent UX

## Problem

After `write_file` gained approval, the pi-agent could still mutate the workspace through `bash` commands such as `rm`, `mv`, `sed -i`, `npm install`, or arbitrary scripts.

## Solution

Classify each agent `bash` command before execution. Clearly read-only commands run immediately; commands that can mutate files, change Git state, install dependencies, access the network, run arbitrary scripts, use output redirection, or are unknown are held behind an inline command review in `AgentView`.

## Detection Model

This is a conservative heuristic, not a shell sandbox. It biases toward asking.

- Auto-allow only commands in a read-only allowlist such as `ls`, `pwd`, `cat`, `rg`, `grep`, `find`, `head`, `tail`, `wc`, `git status`, `git diff`, `git log`, and `npm test`.
- Require approval for shell redirection and heredocs: `>`, `>>`, `&>`, `<<`.
- Require approval for known mutators: `rm`, `mv`, `cp`, `mkdir`, `touch`, `chmod`, `chown`, `ln`, `dd`, `tee`, `truncate`, `rsync`, `install`.
- Require approval for `sed -i`.
- Require approval for Git state-changing subcommands such as `checkout`, `reset`, `clean`, `commit`, `merge`, `rebase`, `pull`, `push`, `apply`.
- Require approval for package/network/dependency tools such as `npm` except `npm test`, `pnpm`, `yarn`, `pip`, `uv`, `cargo`, `go`, `brew`, `curl`, `wget`.
- Require approval for script runners such as `sh`, `bash`, `zsh`, `python`, `node`, `ruby`, `deno`, `bun`, `npx`, `tsx`.
- Require approval for commands not in the allowlist.

## Affected Files

| File | Change |
|------|--------|
| `src/agent/tools.ts` | Add `BashApprovalHandler` and command classifier; hold risky bash commands before IPC execution. |
| `src/agent/agent.ts` | Pass the bash approval handler into `createKryptonTools`. |
| `src/agent/agent-view.ts` | Render command review cards and resolve approvals via keyboard or buttons. |
| `src/styles/agent.css` | Add command review styling. |
| `docs/42-pi-agent-integration.md` | Document bash approval. |
| `docs/02-functional-requirements.md` | Add bash approval requirements. |
| `docs/04-architecture.md` | Document command gating in AgentView responsibilities. |
| `docs/05-data-flow.md` | Add shell approval data flow. |
| `docs/PROGRESS.md` | Add recent landing. |

## Keybindings

| Key | Context | Action |
|-----|---------|--------|
| `a` | Pending command review | Run the oldest pending command. |
| `r` | Pending command review | Block the oldest pending command. |
| `A` | Pending command review | Run this command and all later risky commands in the current turn. |
| `R` | Pending command review | Block this command and all later risky commands in the current turn. |
| `Ctrl+C` | Agent running | Reject pending writes and commands before aborting. |

## Edge Cases

- Safe commands connected by pipes are allowed if every segment is allowlisted.
- Any segment that is unknown or risky makes the whole command require approval.
- Rejected commands are not executed and return a tool error to the model.
- The classifier does not claim to parse all shell grammar; unknown syntax is treated as risky.

## Out of Scope

- A real OS sandbox.
- Per-command policy configuration.
- Gating manual `!` shell commands typed by the user.

## Resources

- Internal: `docs/99-agent-write-approval.md`
- Internal: `docs/89-acp-diff-preview.md`
