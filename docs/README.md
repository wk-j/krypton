# Docs

Implementation specs (`NN-name.md`) and architectural decisions (`adr/`).
Numbers are assigned in order; gaps were never used. `08-open-questions.md` and `09-glossary.md` do not exist.

## Start here

| Doc | What |
|-----|------|
| [04-architecture.md](./04-architecture.md) | System architecture, DOM, modules |
| [05-data-flow.md](./05-data-flow.md) | Keypress, resize, IPC, ACP flows |
| [06-configuration.md](./06-configuration.md) | TOML config reference |
| [07-milestones.md](./07-milestones.md) | Original M0–M9 phase plan |

## Specs (211)

| # | Spec |
|---|------|
| 1 | [Introduction](./01-introduction.md) |
| 2 | [Functional Requirements](./02-functional-requirements.md) |
| 3 | [Non-Functional Requirements](./03-non-functional-requirements.md) |
| 4 | [Architecture Overview](./04-architecture.md) |
| 5 | [Data Flow](./05-data-flow.md) |
| 6 | [Configuration File Format](./06-configuration.md) |
| 7 | [Milestones](./07-milestones.md) |
| 10 | [Theme Specification](./10-theme-specification.md) |
| 11 | [Selection Mode](./11-selection-mode.md) |
| 12 | [Hint Mode](./12-hint-mode.md) |
| 13 | [Tabs & Panes](./13-tabs-and-panes.md) |
| 14 | [Pinned Windows](./14-pinned-windows.md) |
| 15 | [Command Palette](./15-command-palette.md) |
| 16 | [Terminal Post-Processing Shaders](./16-terminal-shaders.md) |
| 17 | [Sound Engine — Specification](./17-sound-themes.md) |
| 18 | [Progress Bar](./18-progress-bar.md) |
| 19 | [3D Perspective Depth](./19-3d-perspective.md) |
| 20 | [Context-Aware Extensions](./20-context-extensions.md) |
| 22 | [Overlay Dashboards](./22-overlay-dashboards.md) |
| 28 | [SSH Session Multiplexing](./28-ssh-session-multiplexing.md) |
| 29 | [Visual Chrome Polish — Terminal Glow, Tab Styling, Selection Effects](./29-visual-chrome-polish.md) |
| 30 | [Claude Code Hook Support](./30-claude-code-hooks.md) |
| 34 | [Background Animations — Flame, Brainwave, Matrix](./34-background-animations.md) |
| 37 | [Quick Terminal Animation Styles](./37-quick-terminal-animations.md) |
| 38 | [Diff View Window](./38-diff-view-window.md) |
| 39 | [Markdown Viewer Window](./39-markdown-viewer.md) |
| 40 | [Notification Overlay](./40-notification-overlay.md) |
| 41 | [Stark HUD Toast Redesign](./41-stark-hud-toasts.md) |
| 42 | [Pi-Agent Integration](./42-pi-agent-integration.md) |
| 43 | [Pi Session Format](./43-pi-session-format.md) |
| 44 | [Agent Skill Auto-Detection](./44-agent-skill-auto-detection.md) |
| 44 | [MP3 Player](./44-mp3-player.md) |
| 45 | [Agent Context Window](./45-agent-context-window.md) |
| 46 | [Agent Inline Diff View](./46-agent-inline-diff.md) |
| 47 | [Profiler HUD](./47-profiler-panel.md) |
| 48 | [OffscreenCanvas Animations](./48-offscreen-canvas-animations.md) |
| 50 | [Inline AI](./50-inline-ai.md) |
| 51 | [Agent Context Compaction](./51-agent-context-compaction.md) |
| 52 | [File Manager Window](./52-file-manager.md) |
| 53 | [Agent Model Configuration](./53-ollama-provider-support.md) |
| 54 | [Agent Runtime Model Switching](./54-agent-model-switching.md) |
| 55 | [File Manager AI Assistant](./55-file-manager-ai.md) |
| 56 | [Compositor Split](./56-compositor-split.md) |
| 57 | [Fuzzy File Search](./57-fuzzy-file-search.md) |
| 58 | [Depth / Z-Stack Layout Mode](./58-depth-zstack-layout.md) |
| 59 | [Obsidian Vault Window](./59-obsidian-vault-window.md) |
| 60 | [File Age Bar](./60-file-age-bar.md) |
| 61 | [Smart Prompt Dialog](./61-smart-prompt-dialog.md) |
| 62 | [Agent Image Attachment](./62-agent-image-attachment.md) |
| 63 | [Screen Capture Routing](./63-screen-capture-prompt.md) |
| 64 | [Matrix Animation CPU Burn — Investigation & Remediation Plan](./64-matrix-animation-cpu-burn.md) |
| 65 | [Hurl Client Window](./65-hurl-client-window.md) |
| 66 | [Invisible Window: Root Cause & Recovery](./66-invisible-window-recovery.md) |
| 67 | [Matrix Glyph Atlas — Permanent Fix for `fillText` CPU Burn](./67-matrix-glyph-atlas.md) |
| 68 | [Quick File Search Dialog](./68-quick-file-search.md) |
| 69 | [ACP Agent Window](./69-acp-agent-support.md) |
| 70 | [Variable Font & OpenType Feature Support](./70-variable-font-features.md) |
| 71 | [Pencil Window (Excalidraw Editor)](./71-pencil-window.md) |
| 72 | [ACP Harness View](./72-acp-harness-view.md) |
| 73 | [ACP Harness MCP Memory](./73-acp-harness-mcp-memory.md) |
| 74 | [ACP Harness Skill Discoverability](./74-acp-harness-skill-invocation.md) |
| 75 | [ACP Harness Lane-Owned Memory](./75-acp-harness-lane-memory.md) |
| 76 | [ACP Harness Memory Persistence](./76-acp-harness-memory-persistence.md) |
| 77 | [Infrastructure Deduplication](./77-infrastructure-deduplication.md) |
| 78 | [Vault View Load Performance](./78-vault-view-perf.md) |
| 79 | [ACP Harness Fresh Session Commands](./79-acp-harness-fresh-session-commands.md) |
| 80 | [ACP Harness Zen Mode](./80-acp-harness-zen-mode.md) |
| 81 | [Global Copy-on-Select](./81-global-copy-on-select.md) |
| 82 | [Global Hint Mode for DOM Views](./82-global-hint-mode.md) |
| 83 | [Shared `.mcp.json` for ACP Harness Lanes](./83-acp-shared-mcp-config.md) |
| 84 | [Pi-1 Lane (pi-acp Adapter)](./84-acp-pi-lane.md) |
| 85 | [Contextual Leader Keys](./85-contextual-leader-keys.md) |
| 86 | [Droid-1 Lane (Factory Droid Native ACP)](./86-acp-droid-lane.md) |
| 87 | [Extended ACP Session Updates (Slash Commands & Mode)](./87-acp-extended-session-updates.md) |
| 88 | [ACP fs/* Activity Surface](./88-acp-fs-activity-surface.md) |
| 89 | [ACP Diff Preview & Gated Writes](./89-acp-diff-preview.md) |
| 90 | [ACP Harness Plan Tracking](./90-acp-plan-tracking.md) |
| 91 | [ACP Lane Resource Metrics](./91-acp-lane-resource-metrics.md) |
| 92 | [ACP Harness Lane Picker](./92-acp-lane-picker.md) |
| 93 | [ACP Harness Text Animation (per-line stagger reveal)](./93-acp-harness-text-animation.md) |
| 94 | [ACP Harness Render Performance](./94-acp-harness-render-performance.md) |
| 95 | [ACP Harness Scroll Stability](./95-acp-harness-scroll-stability.md) |
| 96 | [ACP Built-In Memory Auto-Approval](./96-acp-built-in-memory-auto-approval.md) |
| 97 | [ACP Harness Session List and Resume](./97-acp-harness-session-resume.md) |
| 98 | [ACP Harness On-Demand Memory](./98-acp-harness-memory-on-demand.md) |
| 99 | [Agent Write Approval](./99-agent-write-approval.md) |
| 100 | [Agent Bash Approval](./100-agent-bash-approval.md) |
| 101 | [Agent Check Command](./101-agent-check-command.md) |
| 102 | [Webview Windows](./102-webview-windows.md) |
| 103 | [ACP Harness Transcript Visible Window](./103-acp-harness-transcript-window.md) |
| 104 | [Chrome Signal Upgrades](./104-chrome-signal-upgrades.md) |
| 105 | [View Protocol](./105-view-protocol.md) |
| 106 | [Peering — Inter-Lane Messaging](./106-inter-lane-messaging.md) |
| 107 | [ACP Harness Transcript Readability](./107-acp-harness-transcript-readability.md) |
| 108 | [Overall UI Improvements — Concept Backlog](./108-overall-ui-improvements.md) |
| 109 | [ACP Contextual Lane Peek](./109-acp-contextual-lane-peek.md) |
| 110 | [Context-Aware Command Palette](./110-context-aware-command-palette.md) |
| 111 | [ACP Harness Right Rail](./111-harness-right-rail.md) |
| 112 | [ACP Review Lane Mode](./112-acp-review-lane-mode.md) |
| 113 | [Cursor Lane (Cursor Agent Native ACP)](./113-acp-cursor-lane.md) |
| 113 | [ACP Brainstorm Lane Mode](./113-brainstorm-lane-mode.md) |
| 114 | [ACP Harness Streaming Performance Audit & Fixes](./114-acp-harness-streaming-perf.md) |
| 115 | [Mention Fan-Out](./115-mention-fanout.md) |
| 116 | [Soft Awaiting Peer](./116-soft-awaiting-peer.md) |
| 117 | [Streaming Markdown Rendering for Assistant Rows](./117-streaming-markdown.md) |
| 118 | [ACP Peer Activity UI](./118-acp-peer-activity-ui.md) |
| 119 | [Junie Lane (JetBrains Junie CLI Native ACP)](./119-acp-junie-lane.md) |
| 120 | [Harness Inter-Lane Transcript UX](./120-harness-inter-lane-ux.md) |
| 121 | [Workspace Status Bar](./121-workspace-status-bar.md) |
| 122 | [Oh My Pi Lane (OMP Native ACP)](./122-acp-omp-lane.md) |
| 123 | [ACP Provider Error Rendering](./123-acp-provider-error-rendering.md) |
| 124 | [ACP Harness Directive Management](./124-acp-harness-directive-management.md) |
| 125 | [Lane Rail Disambiguation](./125-lane-rail-disambiguation.md) |
| 126 | [ACP Lane Model Selection](./126-acp-lane-model-selection.md) |
| 127 | [ACP Lane Model Picker](./127-acp-lane-model-picker.md) |
| 128 | [Attention Triage](./128-attention-triage.md) |
| 129 | [Directive-Bound Triage Grant](./129-directive-triage-grant.md) |
| 130 | [Default Attention Triage](./130-default-attention-triage.md) |
| 131 | [Visual Asset Generation Brief — Theme · Logo · Character · Sprite](./131-visual-asset-generation-brief.md) |
| 132 | [Krypton Brand Glyph](./132-krypton-brand-glyph.md) |
| 133 | [Harness HTML Artifacts](./133-harness-html-artifacts.md) |
| 134 | [Artifact Default Styling](./134-artifact-default-styling.md) |
| 135 | [Grok Lane (xAI Grok Build Native ACP)](./135-acp-grok-lane.md) |
| 136 | [ACP Harness Prompt Queue](./136-acp-harness-prompt-queue.md) |
| 137 | [Markdown Viewer — In-Doc Search, Heading Hints, Image Fix, Focus Indicator, Re-select Guard](./137-markdown-viewer-search-hints-images.md) |
| 138 | [Weight-Dynamic Attention Gauge](./138-attention-gauge-weight-dynamic.md) |
| 139 | [User-Triggered Memory Handoff](./139-default-memory-handoff.md) |
| 140 | [Approval Gate Safety](./140-approval-gate-safety.md) |
| 141 | [Cross-Harness Peering — `peer_send` Across Harness Views](./141-cross-harness-peering.md) |
| 142 | [Active-Lane → Window Accent](./142-active-lane-window-accent.md) |
| 143 | [peer_send Auto-Accept](./143-peer-send-auto-accept.md) |
| 144 | [Harness `#wiki` Command](./144-harness-wiki-command.md) |
| 145 | [Simplify `#review` — Agent-Orchestrated Multi-Reviewer (Diff or Design Doc)](./145-harness-design-review-panel.md) |
| 146 | [Review Quality Matrix](./146-review-quality-matrix.md) |
| 147 | [Persistent Permission Mode (incl. full Bypass)](./147-persistent-permission-mode.md) |
| 148 | [Lane Goal — Focus Scope](./148-lane-goal-focus-scope.md) |
| 149 | [Artifact Inline Feedback](./149-artifact-inline-feedback.md) |
| 150 | [Copilot Lane (GitHub Copilot CLI Native ACP)](./150-acp-copilot-lane.md) |
| 151 | [Subscription Credit Usage View](./151-subscription-usage-view.md) |
| 152 | [Cursor Real Usage in the Credit View](./152-cursor-real-usage.md) |
| 153 | [Window AI Credit Status](./153-window-ai-credit-status.md) |
| 154 | [Harness Controller CLI](./154-harness-controller-cli.md) |
| 155 | [Live Working Diff](./155-live-working-diff.md) |
| 156 | [Lane Activity Ticker](./156-lane-activity-ticker.md) |
| 157 | [Harness Concise Mode](./157-harness-concise-mode.md) |
| 158 | [Diff Review Comments](./158-diff-review-comments.md) |
| 159 | [Cline ACP Lane](./159-acp-cline-lane.md) |
| 160 | [Diff Review Priority](./160-diff-review-priority.md) |
| 161 | [Directive Management Without Dedicated MCP Tools](./161-directive-tools-on-demand.md) |
| 162 | [Review Priority Roll-up — footer indicator + summon overlay](./162-review-priority-roll-up.md) |
| 163 | [Generic Directives](./163-generic-directives.md) |
| 164 | [`#polly` — Any-Lane Orchestrator + Two-Worker Cap](./164-polly-orchestration.md) |
| 165 | [Scope Memory to Handoff Only](./165-memory-handoff-only.md) |
| 166 | [#polly Always Emits a Live Plan](./166-polly-live-plan.md) |
| 167 | [`#debby` — Two-Headed Brainstorming Orchestration](./167-debby-brainstorming.md) |
| 168 | [Harness Lane Monitor (Live Web Dashboard)](./168-harness-lane-monitor.md) |
| 169 | [Dashboard Resource Status](./169-dashboard-resource-status.md) |
| 170 | [Artifact Gallery (Loopback Web Endpoint)](./170-artifact-gallery-endpoint.md) |
| 171 | [Docs Browser (Loopback Markdown Renderer)](./171-docs-browser.md) |
| 172 | [Docs Browser Inline Feedback](./172-docs-browser-inline-feedback.md) |
| 173 | [Artifact Gallery — Disk Rehydration on Startup](./173-gallery-disk-rehydration.md) |
| 174 | [Docs Browser Artifact Export](./174-docs-browser-artifact-export.md) |
| 175 | [Harness Web Control API](./175-harness-web-control-api.md) |
| 176 | [Harness Browser Extension](./176-harness-browser-extension.md) |
| 177 | [Harness Extension — Obsidian-grade Content Extraction](./177-harness-extension-content-extraction.md) |
| 178 | [GitHub Issue Fixing](./178-github-issue-fixing.md) |
| 179 | [YouTube Transcript Extraction](./179-youtube-transcript-extraction.md) |
| 180 | [Orchestrator Console](./180-orchestrator-console.md) |
| 181 | [Orchestrator Console — Permission Action](./181-orchestrator-console-permission-action.md) |
| 182 | [Orchestrator Console — Prompt the Seat](./182-orchestrator-console-seat-prompt.md) |
| 183 | [Attention Triage — Acknowledge Sends Feedback](./183-attention-acknowledge-feedback.md) |
| 184 | [Orchestrator Console — Global Permission Queue](./184-orchestrator-console-global-permission-queue.md) |
| 185 | [`/commands` — Built-in Hash-Command Reference Page](./185-hash-command-reference-page.md) |
| 186 | [`/tools` — Built-in MCP Tool Reference Page](./186-mcp-tool-reference-page.md) |
| 187 | [Claude Fable Weekly Usage Meter](./187-claude-fable-weekly-usage.md) |
| 188 | [Oscilloscope Header Band](./188-oscilloscope-header-band.md) |
| 189 | [Oscilloscope Band in Content Windows (Agent / ACP / Harness)](./189-oscilloscope-harness-band.md) |
| 190 | [issue_progress Auto-Bind](./190-issue-progress-auto-bind.md) |
| 191 | [Composable Verbs + GitHub-Issue Verb Set](./191-composable-verbs-github-issue-toolset.md) |
| 192 | [GitHub Issue Analysis Viewer](./192-issue-analysis-viewer.md) |
| 193 | [Grok Subscription Usage Meter](./193-grok-usage-meter.md) |
| 194 | [Working-Ticket Picker & Active-Ticket Pin](./194-working-ticket-picker.md) |
| 195 | [`#salty` — Model-Tiered Orchestration Workflow](./195-salty-tiered-orchestration.md) |
| 196 | [`#draw` — tldraw Offline Local-Agent Command](./196-tldraw-local-agent-command.md) |
| 197 | [`#draw` Document-Script Support](./197-tldraw-document-script-support.md) |
| 198 | [Terminal Control Session Monitor:](./198-termctrl-session-monitor.md) |
| 199 | [Cancel Escalation → Force-Restart for Hung ACP Lanes](./199-cancel-escalation-force-restart.md) |
| 200 | [Telegram Harness Controller](./200-telegram-harness-controller.md) |
| 201 | [Telegram Rich Responses](./201-telegram-rich-responses.md) |
| 202 | [Telegram Lane Picker](./202-telegram-lane-picker.md) |
| 203 | [Ticket Picker Actions](./203-ticket-picker-actions.md) |
| 204 | [ACP Harness view file split](./204-harness-view-split.md) |
| 205 | [Krypton Raycast Extension](./205-raycast-extension.md) |
| 206 | [Assistant Response Resources](./206-assistant-response-resources.md) |
| 207 | [Assistant Reference Git State](./207-assistant-reference-git-state.md) |
| 208 | [Harness Live Assist Window](./208-harness-live-assist-mode.md) |
| 209 | [Live Assist Compact Activity](./209-live-assist-compact-activity.md) |
| 210 | [Quick Overview Dialog](./210-quick-overview-dialog.md) |
| 211 | [Review Board — a composable, lane-authored review surface](./211-review-board.md) |
| 212 | [Xenon — Central Resource Server](./212-xenon-resource-server.md) |
| 213 | [Backend Link Indicator](./213-backend-link-indicator.md) |
| 214 | [LLM Usage Statistics](./214-llm-usage-statistics.md) |
| 215 | [Stacked Lane Visual Hierarchy](./215-stacked-lane-hierarchy.md) |
| 216 | [Lane Thought Slot](./216-workspace-thought-field.md) |
| 217 | [`#reviews` — a self-contained review page](./217-review-archive-self-contained.md) |
| 218 | [Window Status Bar Lane Strip](./218-window-lane-strip.md) |
| 219 | [Window Project Badge](./219-window-project-badge.md) |
| 220 | [Window Diff Stat](./220-window-diff-stat.md) |
| 221 | [Harness Status Line Redundancy Removal](./221-harness-status-line-density.md) |
| 222 | [Harness Engineering Coach](./222-harness-engineering-coach.md) |
| 223 | [Developer Daily Note](./223-developer-daily-note.md) |
| 224 | [Publish the Daily Note to Xenon](./224-daily-note-publish.md) |
| 225 | [Daily Brief — One Written Day per File](./225-daily-brief.md) |
| 226 | [Titlebar Session Mark](./226-titlebar-tail-zoom.md) |
| 228 | [ACP fs Image / Binary Reads](./228-acp-fs-image-reads.md) |

## ADRs (20)

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

## Also

- [prototypes/](./prototypes/) — HTML design comparisons
- [wiki/](./wiki/) — code wiki
- [concepts/](./concepts/) — notes that are not specs
- [adr/](./adr/) — architectural decision records
- [images/](./images/) — screenshots
