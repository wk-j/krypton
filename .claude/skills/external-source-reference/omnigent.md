# Omnigent Reference

Local repo: `/Users/wk/Source/omnigent`.

Use this when Krypton work needs prior art for multi-agent orchestration, Polly-style
task splitting, cross-vendor review, Debby-style paired model brainstorming, Scribe-style
research/review flows, native coding-agent harnesses, native terminal bridges, model
routing, cost/profile selection, or resume/session lifecycle behavior.

## What It Is

Omnigent is a Python agent orchestration system with configurable agents, skills, native
coding-agent harnesses, terminal bridges, and example supervisor agents. The relevant
prior-art examples for Krypton are:

- **Polly** — a supervisor that decomposes coding work into sub-agent tasks, gives each
  implementer its own worktree/PR, and runs independent cross-vendor review.
- **Debby** — a two-headed brainstorming partner that fans every question to Claude and
  GPT responders, then synthesizes agreement and disagreement.
- **Scribe** — a writing/research workflow with researcher/reviewer agents and document
  authoring skills.

## Entry Points

| Area | Files |
|------|-------|
| CLI and setup | `omnigent/cli.py`, `omnigent/__main__.py`, `omnigent/cli_auth.py`, `omnigent/cli_diagnostics.py` |
| Native coding-agent roster | `omnigent/native_coding_agents.py`, `omnigent/harness_aliases.py`, `omnigent/_wrapper_labels.py` |
| Native server harness | `omnigent/native_server_harness.py`, `omnigent/native_server_transport.py` |
| Terminal/session lifecycle | `omnigent/native_terminal.py`, `omnigent/session_lifecycle.py`, `omnigent/resume_dispatch.py`, `omnigent/_native_resume_hint.py` |
| Codex native | `omnigent/codex_native.py`, `omnigent/codex_native_bridge.py`, `omnigent/codex_native_forwarder.py`, `omnigent/codex_native_hook.py`, `omnigent/codex_native_state.py`, `omnigent/codex_native_app_server.py` |
| Claude native | `omnigent/claude_native.py`, `omnigent/claude_native_bridge.py`, `omnigent/claude_native_forwarder.py`, `omnigent/claude_native_hook.py`, `omnigent/claude_native_status.py` |
| Cursor native | `omnigent/cursor_native.py`, `omnigent/cursor_native_bridge.py`, `omnigent/cursor_native_forwarder.py`, `omnigent/cursor_native_usage.py` |
| Pi native | `omnigent/pi_native.py`, `omnigent/pi_native_bridge.py`, `omnigent/pi_native_credentials.py`, `omnigent/pi_native_resume.py` |
| Other native harnesses | `omnigent/opencode_native*.py`, `omnigent/qwen_native*.py`, `omnigent/kimi_native*.py`, `omnigent/goose_native*.py`, `omnigent/hermes_native*.py`, `omnigent/antigravity_native*.py`, `omnigent/kiro_native*.py` |
| Models/cost/profile | `omnigent/model_catalog.py`, `omnigent/model_override.py`, `omnigent/reasoning_effort.py`, `omnigent/cost_plan.py`, `omnigent/native_cost_popup.py` |
| Polly example | `examples/polly/config.yaml`, `examples/polly/agents/*/config.yaml`, `examples/polly/skills/fanout/SKILL.md`, `examples/polly/skills/cross-review/SKILL.md`, `examples/polly/skills/investigate/SKILL.md` |
| Debby example | `examples/debby/config.yaml`, `examples/debby/agents/*/config.yaml`, `examples/debby/skills/debate/SKILL.md` |
| Scribe example | `examples/scribe/config.yaml`, `examples/scribe/agents/*/config.yaml`, `examples/scribe/skills/*/SKILL.md` |

## Commands

```sh
uv run omnigent --help
uv run omnigent run examples/polly
uv run omnigent run examples/debby
uv run omnigent run examples/scribe
uv run pytest
```

## Patterns To Study

### Polly-style orchestration

Start with `examples/polly/config.yaml`. It defines a supervisor that never writes code
itself for coding tasks, performs a CLI roster preflight, delegates implementation,
exploration, and review via `sys_session_send`, and requires cross-vendor review before
the human merges. Its skills under `examples/polly/skills/` are the closest prior art
for Krypton's `#polly`, fanout, investigate, and cross-review behavior.

Krypton `#polly` currently adapts only the supervisor contract: it still runs over live
ACP lanes in a shared project worktree and does not implement Omnigent's per-worker
worktrees, PR registry, or `claude_code`/`codex`/`pi` roster. See
`docs/164-polly-orchestration.md` before treating Omnigent mechanics as Krypton
requirements.

### Native coding-agent harnesses

`omnigent/native_coding_agents.py` is the roster of supported native TUI agents and their
stable labels. For transport-driven native-server behavior, read
`omnigent/native_server_harness.py` and `omnigent/native_server_transport.py`, then the
specific `*_native_bridge.py`, `*_native_forwarder.py`, and `*_native_state.py` files for
the agent being compared.

### Multi-perspective synthesis

`examples/debby/config.yaml` shows a lightweight supervisor that always fans a prompt to
two different responders and presents both viewpoints before synthesis. Use it for
brainstorm/debate UX and orchestration prompt prior art.

### Research and authoring workflows

`examples/scribe/config.yaml` plus its skills show a non-coding research/review/document
pipeline. Use it when designing agent-authored documentation flows or review loops that
are not PR implementation loops.

## Cautions

- Treat this repo as read-only prior art for Krypton work.
- Confirm behavior against source before relying on this reference; the project is active
  and the checked-out HEAD can move.
- Omnigent and Krypton use different runtimes and tool surfaces. Copy patterns and
  contracts, not implementation details, unless the surrounding architecture matches.
