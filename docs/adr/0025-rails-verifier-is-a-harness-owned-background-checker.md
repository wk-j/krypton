# ADR-0025 — The Rails verifier is a harness-owned background checker, separate from attention triage

> Status: Accepted
> Date: 2026-10-27
> Spec: `docs/0337-rails-verifier.md`

## Context

`/grill-with-docs` leaves decisions in `docs/adr/` and terms in `CONTEXT.md`, but nothing checked the code written afterwards against them. The user asked for "a verifier or architecture test, as an assistant AI that runs in the background, checks the grill ADRs, and reports errors or anomalies back to the user".

ADR-0001 had rejected an "independent observer LLM watching all lane streams" and a "deterministic floor" for **judgement items**, and it accepted that pure self-report leaves "no automatic safety net". A background checker reverses that last consequence. This ADR records how far, and why ADR-0001's reasons still hold.

## Decision

1. **Harness-owned, not lane-owned.** Each local harness runs one Rails verifier. It starts at harness quiet points: debounced after a lane goes busy → idle, and only once no lane is busy or waiting for permission. It never runs inside a lane turn, never blocks a lane, never edits code, and never sends anything to a lane by itself. The human sends findings with `#rails send` or `s` in the Rails dock.
2. **Two steps, verdict in code.**
   - The **check step** runs the commands the project declares in `.krypton/rails.toml`. It is deterministic and costs no tokens.
   - The **judge step** is a cheap headless model (the spec 306 transport, fenced) that may cite only the `## Rails` bullets and glossary entries the harness sent it.
   - A failed check is `check_failed` whatever the model says, and a finding without a cited rule is dropped. This follows ADR-0021: the harness, not an agent, decides pass or fail.
3. **Separate from attention triage.** Rails findings are never judgement items. They live in their own surface: the Rails dock, a second tab in the Active Ticket dock's place, plus the footer. ADR-0001 still governs triage unchanged.
4. **Declared and trusted.** Rails exist only where the project declares them. Commands in a repo file run only after `#rails trust` approves that exact file content (a SHA-256 kept in `~/.config/krypton/rails-trust.toml`), and the gate is enforced in Rust.
5. **Evidence, not alarm.** Only a failed check is coloured, as a fault under ADR-0017. Model findings are neutral evidence under ADR-0004: no score, no ranking, no alarm colour.

## Considered Options

- **Raise attention items from the checker.** Rejected: it contradicts ADR-0001 item 1, and a second source of items would flood the demand queue.
- **Extend `#review pass` only.** Rejected: it is human-triggered and spends whole lanes, and the user asked for background checking.
- **Inject ADRs into every lane's policy (spec 289).** Rejected: that is advice, not a check, and it costs tokens on every policy resend.
- **Auto-detect check commands** (Empryo `detectProfile`). Rejected: it guesses per repo, and an undeclared rule cannot be enforced or reviewed in git.
- **Auto-send findings to the lane.** Rejected: a cheap judge can be wrong, which is the ADR-0001 risk. The human stays in the loop with one keystroke.

## Consequences

- **ADR-0001's reasons still hold.**
  - No latency is added before work reaches the human, because runs start only when lanes are idle.
  - No new orchestration seat exists, because the verifier is a controller inside the harness view (ADR-0007), not a lane.
  - The mis-judging risk is narrowed to declared rules. A judge-only rule can still be misjudged; enforced rules (`check:<name>`) cannot.
- **Accepted cost:** one more fenced backend process per harness, disposed after 10 minutes without a run, and model tokens for every changed working tree once a project trusts its manifest. `[acp_harness.rails] mode = "off"` or `#rails off` stops it.
- **Accepted risk: a stale result.** A lane may write while a run is in flight. The run is then marked `stale` and re-run at the next quiet point; it is never presented as current.
- **Machine-local.** The run ledger lives in `.krypton/rails/runs/` of the project and is not published to Xenon. Remote harnesses do not get the verifier.

## Rails

Applies to: `src/acp/harness-rails-controller.ts`, `src/acp/rails/**`, `src/acp/components/rails-dock/**`, `src-tauri/src/rails.rs`, `src/workspace-footer-rails.ts`

- The verdict is computed in code: any `fail` or `timeout` check makes the run `check_failed` whatever the judge returns, and a judge finding whose `rule` is not an id the harness sent is dropped. `check:rails-verdict`
- `rails_run_check` re-hashes `.krypton/rails.toml` and refuses with `untrusted` unless that exact content is in the trust store; the gate lives in Rust, not in the frontend. `check:rails-trust-gate`
- The verifier never sends findings to a lane by itself; only `#rails send` and `s` in the Rails dock deliver a `[rails]` envelope.
- Rails findings never become attention items; rails code never raises a judgement item or writes the demand queue.
- Only a failed check is coloured, as a fault; model findings carry no score, no ranking and no alarm colour.
- The verifier never edits project files; its only writes are the run ledger under `.krypton/rails/` and the trust store.
