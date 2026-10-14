# ADR-0024 — Lessons are global rules the harness holds and injects into every lane

> Status: Accepted
> Date: 2026-10-14
> Spec: `docs/0298-global-lane-lessons.md`

## Context

A harness lane forgets a correction when its session ends, and no other lane ever sees it. The same mistake comes back in the next session, in another backend, and in another project. Native agent memories don't close this gap. Claude Code's auto memory is per repo and Claude-only. Codex memories are off by default and Codex-only. Cursor removed its Memories UI. Krypton's own durable stores are per project: handoffs (spec 165, ADR-0023) and the code wiki (ADR-0003). The user asked for lessons that apply to every project and every lane.

## Decision

A **lesson** is a one-line behavioural rule that a lane writes at a correction point. Krypton holds lessons in one global store and injects them into every lane.

1. **Global store outside any repo.** The store is `~/.config/krypton/lessons/`, holding one markdown file per lesson, a `retired/` folder, and a generated `INDEX.md`. It sits next to `krypton.toml` and `acp-harness.toml`.
2. **The harness writes, through MCP tools.** `lesson_record` and `lesson_retire` are Rust-only bus tools and are auto-allowed. Lanes cannot use their own file tools here, because their sandboxes block or prompt on writes outside the project (Codex `workspace-write`, Claude Code).
3. **Injected, not fetched.** The active set rides the lane policy (spec 289) of every lane, including lanes that cannot write. A change alters the policy hash, so every lane picks it up on its next turn.
4. **Correction-gated, self-reported, live at once.** Lanes write at redirects, at reviewer blockers, when the human corrects them, and on `#lesson`. There is no human approval step (ADR-0001). Every write shows in the lane transcript.
5. **Bounded.** At most 30 active lessons, each with a rule of ≤ 240 chars. When the store is full, a new slug is refused, so the lane must update or retire before it can add.

## Considered Options

- **Repo markdown, as the code wiki does (ADR-0003).** Rejected because a repo file is not global. ADR-0003's "discipline, not storage" holds for per-project knowledge. Lessons are cross-project by definition, so the harness has to own the store.
- **The handoff store (`handoff_set`).** Rejected because spec 165 scopes memory to handoffs, with no exceptions.
- **Native agent memories.** Rejected because they are per backend and mostly per repo; no lane could learn from another lane's correction.
- **On-demand `lesson_get` / `lesson_list`.** Rejected because a rule the agent never reads changes nothing. Claude Code and Copilot also inject memories at session start.
- **Human approval before a lesson goes live.** Rejected because it turns the feature into manual work. The human reads lessons and can delete them, which matches the self-report model of ADR-0001.
- **Copilot-style citations verified at use.** Rejected because they suit code facts, which drift with the code. Lessons are rules about how to work and carry no citations that could go stale.
- **Scoring lanes by lessons recorded.** Rejected under ADR-0004: no scores, no ranking.

## Consequences

- **Accepted risk: a poisoned lesson persists across projects.** Repo content could prompt-inject a lane into recording a harmful "lesson," which would then reach every project. Mitigations:
  - the policy frames lessons as advice that never grants permission;
  - approval gates (spec 140) are unchanged;
  - every write shows in the transcript;
  - sizes and count are capped;
  - the files are plain markdown a human can audit and delete.
  There is no automatic safety net, by the same reasoning as ADR-0001.
- **Accepted risk: over-general or wrong rules.** A lane may generalize from one mistake. Mitigations:
  - the tool contract forbids project-specific facts;
  - the cap forces consolidation;
  - `lesson_retire` exists, and the policy tells lanes to retire a lesson the human contradicts.
- **Policy cost.** At most about 8k chars, sent only when the policy is (re)sent: a new session, a lesson change, compaction, or every 20 turns.
- **Machine-local.** The store does not sync across machines and is not published to Xenon. Remote lanes write to the local machine's store through the forwarded hook server.
- **No filesystem watcher.** Hand edits apply on the next refresh (harness start, `#lessons`, or any lesson write).
