# Agent Check Command — Implementation Spec

> Status: Implemented
> Date: 2026-05-11
> Milestone: Agent UX

## Problem

After the pi-agent edits files, users need a fast validation loop without remembering each project's check command or manually pasting failures back into the agent.

## Solution

Add `/check` to AgentView. It detects a narrow project check command from the current `projectDir`, runs it through the existing `run_command` IPC, renders the output inline, and stores failing output so the user can press `f` or run `/fixcheck` to send the failure back to the agent.

## Detection Order

The detector intentionally chooses narrow checks before broader commands:

1. `package.json` with `scripts.check` -> `npm run check`
2. `package.json` with `scripts.typecheck` -> `npm run typecheck`
3. `package.json` with `scripts.test` -> `npm test`
4. `Cargo.toml` -> `cargo check`
5. `go.mod` -> `go test ./...`

If none match, `/check` prints "No check command detected" and does not run anything.

## Affected Files

| File | Change |
|------|--------|
| `src/agent/agent-view.ts` | Add `/check`, `/fixcheck`, project check detection, check output rendering, and `f` shortcut for sending failures back to the agent. |
| `src/styles/agent.css` | Add compact check failure action styling. |
| `docs/42-pi-agent-integration.md` | Document check commands. |
| `docs/02-functional-requirements.md` | Add check command requirements. |
| `docs/04-architecture.md` | Document AgentView validation loop. |
| `docs/05-data-flow.md` | Add check command data flow. |
| `docs/PROGRESS.md` | Add recent landing. |

## Data Flow

```
1. User types /check.
2. AgentView reads project marker files via read_file.
3. AgentView selects the first matching command in the detection order.
4. AgentView invokes run_command(program, args, cwd = projectDir).
5. Success renders shell-style output.
6. Failure renders shell-style error output and stores a fix prompt.
7. User presses f or runs /fixcheck.
8. AgentView sends the stored failure prompt to AgentController.
```

## Keybindings

| Key | Context | Action |
|-----|---------|--------|
| `f` | Last `/check` failed and agent is idle | Send failure output to the agent. |

## Out of Scope

- Configurable check command.
- Running build commands automatically.
- Parsing check output into structured diagnostics.
- Auto-fixing without user action.

## Resources

- Internal: `docs/42-pi-agent-integration.md`
