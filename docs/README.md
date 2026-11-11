# Docs

Implementation specs (`NNNN-name.md`, four-digit zero-padded) and architectural decisions (`adr/`).
Numbers are assigned in order; gaps were never used. `0008-open-questions.md` and `0009-glossary.md` do not exist.
290 and 291 were renumbered from duplicate 44 and 113 when the prefixes went four-digit.

## Start here

| Doc | What |
|-----|------|
| [0004-architecture.md](./0004-architecture.md) | System architecture, DOM, modules |
| [0005-data-flow.md](./0005-data-flow.md) | Keypress, resize, IPC, ACP flows |
| [0006-configuration.md](./0006-configuration.md) | TOML config reference |
| [0007-milestones.md](./0007-milestones.md) | Original M0–M9 phase plan |

## Latest 20 specs

Listed by spec number. Older specs remain in this directory.

| # | Spec |
|---|------|
| 369 | [Keycap Shortcuts](./0369-keycap-shortcuts.md) |
| 370 | [OMP Background Subagent Jobs](./0370-harness-omp-background-jobs.md) |
| 371 | [Harness Notice Rows](./0371-harness-notice-rows.md) |
| 372 | [Prompt Dialog → Harness Lanes](./0372-prompt-dialog-harness-lanes.md) |
| 373 | [Prompt Dialog Typewriter Slip](./0373-prompt-dialog-typewriter-slip.md) |
| 374 | [Harness Lane Stats Toggle](./0374-harness-lane-stats-toggle.md) |
| 375 | [Commit Browser](./0375-commit-browser.md) |
| 376 | [Commit Explainer Background Job](./0376-commit-explainer-background-job.md) |
| 377 | [Commit Explainer Job Strip](./0377-commit-explainer-job-strip.md) |
| 378 | [Codex Guardian Review Row](./0378-codex-guardian-review-row.md) |
| 379 | [Connected Transcript Sources](./0379-connected-transcript-sources.md) |
| 380 | [ACP Lane Adapters](./0380-acp-lane-adapters.md) |
| 381 | [Harness Component Gallery](./0381-harness-component-gallery.md) |
| 382 | [Recessed Shortcut Keycaps](./0382-recessed-shortcut-keycaps.md) |
| 383 | [Tool Name Readouts](./0383-tool-name-readouts.md) |
| 384 | [Visible Background Task Strip](./0384-visible-background-task-strip.md) |
| 385 | [Connected Computer Command Bypass](./0385-connected-computer-command-bypass.md) |
| 386 | [Harness Remote Command Component](./0386-harness-remote-command-component.md) |
| 387 | [Harness System Command Components](./0387-harness-system-command-components.md) |
| 388 | [ACP Lane Model and Effort Memory](./0388-acp-lane-model-effort-memory.md) |

## ADRs (31)

| # | Decision |
|---|----------|
| 1 | [Attention triage is a non-blocking, self-reported router — not a gatekeeper, observer, or blocker](./adr/0001-attention-triage-self-reported-router.md) |
| 2 | [HTML artifacts open in the OS browser, not an in-app webview](./adr/0002-html-artifacts-open-in-os-browser.md) |
| 3 | [Code wiki lives in the target repo as markdown, not in the harness memory store](./adr/0003-code-wiki-lives-in-target-repo-not-harness-memory.md) |
| 4 | [The review quality matrix is an observation, not a score](./adr/0004-review-matrix-observation-not-score.md) |
| 5 | [Harness Controller uses authenticated loopback HTTP](./adr/0005-harness-controller-uses-authenticated-loopback-http.md) |
| 6 | [Harness Controller ships as `kryptonctl`](./adr/0006-harness-controller-ships-as-kryptonctl.md) |
| 7 | [Frontend remains the authority for harness control](./adr/0007-frontend-remains-authority-for-harness-control.md) |
| 8 | [The Diff Window refreshes on lane quiet points, not file watching](./adr/0008-diff-window-refreshes-on-lane-quiet-points.md) |
| 9 | [Diff review priority is lane-self-reported and may only fold, never hide or reorder](./adr/0009-diff-review-priority-is-lane-self-reported.md) |
| 10 | [Docs browser serves repo markdown over token-less loopback by path](./adr/0010-docs-browser-serves-repo-markdown-over-tokenless-loopback.md) |
| 11 | [Orchestrator is a privileged lane role with an acting console](./adr/0011-orchestrator-privileged-lane-and-acting-console.md) |
| 12 | [Verb composition is inline token substitution, resolved once into a single prompt — not a workflow engine](./adr/0012-verb-composition-is-inline-token-substitution.md) |
| 13 | [Telegram Controller has full harness authority](./adr/0013-telegram-controller-has-full-harness-authority.md) |
| 14 | [Telegram control is authorized by user and chat allowlists](./adr/0014-telegram-control-authorized-by-user-and-chat-allowlists.md) |
| 15 | [Telegram Bot Token lives in the OS credential vault](./adr/0015-telegram-bot-token-lives-in-os-credential-vault.md) |
| 16 | [Harness-generated resources publish to Xenon; Xenon never controls Krypton](./adr/0016-generated-resources-publish-to-xenon.md) |
| 17 | [The backend link indicator is coloured by fault, unlike the review depth gauges](./adr/0017-backend-link-is-coloured-by-fault.md) |
| 18 | [LLM usage is priced by Xenon at read time, not by Krypton](./adr/0018-llm-usage-is-priced-by-xenon-not-krypton.md) |
| 19 | [Per-turn usage is streamed telemetry, not a published resource](./adr/0019-usage-is-telemetry-not-a-published-resource.md) |
| 20 | [The status-bar diff stat polls; the Diff Window still does not](./adr/0020-diff-stat-polls-diff-window-does-not.md) |
| 21 | [Review-till-pass rounds are harness-sequenced; plain `#review` stays agent-orchestrated](./adr/0021-review-loop-rounds-are-harness-sequenced.md) |
| 22 | [Handoffs are the one resource Krypton pulls from Xenon, and only on a human command](./adr/0022-handoffs-are-the-one-resource-pulled-from-xenon.md) |
| 23 | [A handoff belongs to a work thread, not a lane](./adr/0023-a-handoff-belongs-to-a-work-thread-not-a-lane.md) |
| 24 | [Lessons are global rules the harness holds and injects into every lane](./adr/0024-lessons-are-global-harness-held-rules.md) |
| 25 | [The Rails verifier is a harness-owned background checker, separate from attention triage](./adr/0025-rails-verifier-is-a-harness-owned-background-checker.md) |
| 26 | [The loopback app shell holds a session capability in localStorage](./adr/0026-loopback-app-session-capability-in-local-storage.md) |
| 27 | [No surface marks state with a left-edge accent rail](./adr/0027-no-left-edge-accent-rails.md) |
| 28 | [The loopback app is written in React; the Tauri app frontend stays framework-free](./adr/0028-loopback-app-uses-react.md) |
| 29 | [Rails scans every lockfile for known vulnerabilities as a manual check](./adr/0029-rails-scans-changed-lockfiles-for-known-vulnerabilities.md) |
| 30 | [The console faceplate is Krypton's one in-app visual identity](./adr/0030-console-faceplate-is-the-base-identity.md) |
| 31 | [The UI reads only canonical lane events; adapters own the ACP wire](./adr/0031-ui-reads-only-canonical-lane-events.md) |

## Also

- [prototypes/](./prototypes/) — HTML design comparisons
- [wiki/](./wiki/) — code wiki
- [concepts/](./concepts/) — notes that are not specs
- [adr/](./adr/) — architectural decision records
- [images/](./images/) — screenshots
