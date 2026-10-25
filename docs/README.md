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

## Specs (318)

| # | Spec |
|---|------|
| 1 | [Introduction](./0001-introduction.md) |
| 2 | [Functional Requirements](./0002-functional-requirements.md) |
| 3 | [Non-Functional Requirements](./0003-non-functional-requirements.md) |
| 4 | [Architecture Overview](./0004-architecture.md) |
| 5 | [Data Flow](./0005-data-flow.md) |
| 6 | [Configuration File Format](./0006-configuration.md) |
| 7 | [Milestones](./0007-milestones.md) |
| 10 | [Theme Specification](./0010-theme-specification.md) |
| 11 | [Selection Mode](./0011-selection-mode.md) |
| 12 | [Hint Mode](./0012-hint-mode.md) |
| 13 | [Tabs & Panes](./0013-tabs-and-panes.md) |
| 14 | [Pinned Windows](./0014-pinned-windows.md) |
| 15 | [Command Palette](./0015-command-palette.md) |
| 16 | [Terminal Post-Processing Shaders](./0016-terminal-shaders.md) |
| 17 | [Sound Engine — Specification](./0017-sound-themes.md) |
| 18 | [Progress Bar](./0018-progress-bar.md) |
| 19 | [3D Perspective Depth](./0019-3d-perspective.md) |
| 20 | [Context-Aware Extensions](./0020-context-extensions.md) |
| 22 | [Overlay Dashboards](./0022-overlay-dashboards.md) |
| 28 | [SSH Session Multiplexing](./0028-ssh-session-multiplexing.md) |
| 29 | [Visual Chrome Polish — Terminal Glow, Tab Styling, Selection Effects](./0029-visual-chrome-polish.md) |
| 30 | [Claude Code Hook Support](./0030-claude-code-hooks.md) |
| 34 | [Background Animations — Flame, Brainwave, Matrix](./0034-background-animations.md) |
| 37 | [Quick Terminal Animation Styles](./0037-quick-terminal-animations.md) |
| 38 | [Diff View Window](./0038-diff-view-window.md) |
| 39 | [Markdown Viewer Window](./0039-markdown-viewer.md) |
| 40 | [Notification Overlay](./0040-notification-overlay.md) |
| 41 | [Stark HUD Toast Redesign](./0041-stark-hud-toasts.md) |
| 42 | [Pi-Agent Integration](./0042-pi-agent-integration.md) |
| 43 | [Pi Session Format](./0043-pi-session-format.md) |
| 44 | [Agent Skill Auto-Detection](./0044-agent-skill-auto-detection.md) |
| 45 | [Agent Context Window](./0045-agent-context-window.md) |
| 46 | [Agent Inline Diff View](./0046-agent-inline-diff.md) |
| 47 | [Profiler HUD](./0047-profiler-panel.md) |
| 48 | [OffscreenCanvas Animations](./0048-offscreen-canvas-animations.md) |
| 50 | [Inline AI](./0050-inline-ai.md) |
| 51 | [Agent Context Compaction](./0051-agent-context-compaction.md) |
| 52 | [File Manager Window](./0052-file-manager.md) |
| 53 | [Agent Model Configuration](./0053-ollama-provider-support.md) |
| 54 | [Agent Runtime Model Switching](./0054-agent-model-switching.md) |
| 55 | [File Manager AI Assistant](./0055-file-manager-ai.md) |
| 56 | [Compositor Split](./0056-compositor-split.md) |
| 57 | [Fuzzy File Search](./0057-fuzzy-file-search.md) |
| 58 | [Depth / Z-Stack Layout Mode](./0058-depth-zstack-layout.md) |
| 59 | [Obsidian Vault Window](./0059-obsidian-vault-window.md) |
| 60 | [File Age Bar](./0060-file-age-bar.md) |
| 61 | [Smart Prompt Dialog](./0061-smart-prompt-dialog.md) |
| 62 | [Agent Image Attachment](./0062-agent-image-attachment.md) |
| 63 | [Screen Capture Routing](./0063-screen-capture-prompt.md) |
| 64 | [Matrix Animation CPU Burn — Investigation & Remediation Plan](./0064-matrix-animation-cpu-burn.md) |
| 65 | [Hurl Client Window](./0065-hurl-client-window.md) |
| 66 | [Invisible Window: Root Cause & Recovery](./0066-invisible-window-recovery.md) |
| 67 | [Matrix Glyph Atlas — Permanent Fix for `fillText` CPU Burn](./0067-matrix-glyph-atlas.md) |
| 68 | [Quick File Search Dialog](./0068-quick-file-search.md) |
| 69 | [ACP Agent Window](./0069-acp-agent-support.md) (window removed; ACP transport only) |
| 70 | [Variable Font & OpenType Feature Support](./0070-variable-font-features.md) |
| 71 | [Pencil Window (Excalidraw Editor)](./0071-pencil-window.md) |
| 72 | [ACP Harness View](./0072-acp-harness-view.md) |
| 73 | [ACP Harness MCP Memory](./0073-acp-harness-mcp-memory.md) |
| 74 | [ACP Harness Skill Discoverability](./0074-acp-harness-skill-invocation.md) |
| 75 | [ACP Harness Lane-Owned Memory](./0075-acp-harness-lane-memory.md) |
| 76 | [ACP Harness Memory Persistence](./0076-acp-harness-memory-persistence.md) |
| 77 | [Infrastructure Deduplication](./0077-infrastructure-deduplication.md) |
| 78 | [Vault View Load Performance](./0078-vault-view-perf.md) |
| 79 | [ACP Harness Fresh Session Commands](./0079-acp-harness-fresh-session-commands.md) |
| 80 | [ACP Harness Zen Mode](./0080-acp-harness-zen-mode.md) |
| 81 | [Global Copy-on-Select](./0081-global-copy-on-select.md) |
| 82 | [Global Hint Mode for DOM Views](./0082-global-hint-mode.md) |
| 83 | [Shared `.mcp.json` for ACP Harness Lanes](./0083-acp-shared-mcp-config.md) |
| 84 | [Pi-1 Lane (pi-acp Adapter)](./0084-acp-pi-lane.md) |
| 85 | [Contextual Leader Keys](./0085-contextual-leader-keys.md) |
| 86 | [Droid-1 Lane (Factory Droid Native ACP)](./0086-acp-droid-lane.md) |
| 87 | [Extended ACP Session Updates (Slash Commands & Mode)](./0087-acp-extended-session-updates.md) |
| 88 | [ACP fs/* Activity Surface](./0088-acp-fs-activity-surface.md) |
| 89 | [ACP Diff Preview & Gated Writes](./0089-acp-diff-preview.md) |
| 90 | [ACP Harness Plan Tracking](./0090-acp-plan-tracking.md) |
| 91 | [ACP Lane Resource Metrics](./0091-acp-lane-resource-metrics.md) |
| 92 | [ACP Harness Lane Picker](./0092-acp-lane-picker.md) |
| 93 | [ACP Harness Text Animation (per-line stagger reveal)](./0093-acp-harness-text-animation.md) |
| 94 | [ACP Harness Render Performance](./0094-acp-harness-render-performance.md) |
| 95 | [ACP Harness Scroll Stability](./0095-acp-harness-scroll-stability.md) |
| 96 | [ACP Built-In Memory Auto-Approval](./0096-acp-built-in-memory-auto-approval.md) |
| 97 | [ACP Harness Session List and Resume](./0097-acp-harness-session-resume.md) |
| 98 | [ACP Harness On-Demand Memory](./0098-acp-harness-memory-on-demand.md) |
| 99 | [Agent Write Approval](./0099-agent-write-approval.md) |
| 100 | [Agent Bash Approval](./0100-agent-bash-approval.md) |
| 101 | [Agent Check Command](./0101-agent-check-command.md) |
| 102 | [Webview Windows](./0102-webview-windows.md) |
| 103 | [ACP Harness Transcript Visible Window](./0103-acp-harness-transcript-window.md) |
| 104 | [Chrome Signal Upgrades](./0104-chrome-signal-upgrades.md) |
| 105 | [View Protocol](./0105-view-protocol.md) |
| 106 | [Peering — Inter-Lane Messaging](./0106-inter-lane-messaging.md) |
| 107 | [ACP Harness Transcript Readability](./0107-acp-harness-transcript-readability.md) |
| 108 | [Overall UI Improvements — Concept Backlog](./0108-overall-ui-improvements.md) |
| 109 | [ACP Contextual Lane Peek](./0109-acp-contextual-lane-peek.md) |
| 110 | [Context-Aware Command Palette](./0110-context-aware-command-palette.md) |
| 111 | [ACP Harness Right Rail](./0111-harness-right-rail.md) |
| 112 | [ACP Review Lane Mode](./0112-acp-review-lane-mode.md) |
| 113 | [Cursor Lane (Cursor Agent Native ACP)](./0113-acp-cursor-lane.md) |
| 114 | [ACP Harness Streaming Performance Audit & Fixes](./0114-acp-harness-streaming-perf.md) |
| 115 | [Mention Fan-Out](./0115-mention-fanout.md) |
| 116 | [Soft Awaiting Peer](./0116-soft-awaiting-peer.md) |
| 117 | [Streaming Markdown Rendering for Assistant Rows](./0117-streaming-markdown.md) |
| 118 | [ACP Peer Activity UI](./0118-acp-peer-activity-ui.md) |
| 119 | [Junie Lane (JetBrains Junie CLI Native ACP)](./0119-acp-junie-lane.md) |
| 120 | [Harness Inter-Lane Transcript UX](./0120-harness-inter-lane-ux.md) |
| 121 | [Workspace Status Bar](./0121-workspace-status-bar.md) |
| 122 | [Oh My Pi Lane (OMP Native ACP)](./0122-acp-omp-lane.md) |
| 123 | [ACP Provider Error Rendering](./0123-acp-provider-error-rendering.md) |
| 124 | [ACP Harness Directive Management](./0124-acp-harness-directive-management.md) |
| 125 | [Lane Rail Disambiguation](./0125-lane-rail-disambiguation.md) |
| 126 | [ACP Lane Model Selection](./0126-acp-lane-model-selection.md) |
| 127 | [ACP Lane Model Picker](./0127-acp-lane-model-picker.md) |
| 128 | [Attention Triage](./0128-attention-triage.md) |
| 129 | [Directive-Bound Triage Grant](./0129-directive-triage-grant.md) |
| 130 | [Default Attention Triage](./0130-default-attention-triage.md) |
| 131 | [Visual Asset Generation Brief — Theme · Logo · Character · Sprite](./0131-visual-asset-generation-brief.md) |
| 132 | [Krypton Brand Glyph](./0132-krypton-brand-glyph.md) |
| 133 | [Harness HTML Artifacts](./0133-harness-html-artifacts.md) |
| 134 | [Artifact Default Styling](./0134-artifact-default-styling.md) |
| 135 | [Grok Lane (xAI Grok Build Native ACP)](./0135-acp-grok-lane.md) |
| 136 | [ACP Harness Prompt Queue](./0136-acp-harness-prompt-queue.md) |
| 137 | [Markdown Viewer — In-Doc Search, Heading Hints, Image Fix, Focus Indicator, Re-select Guard](./0137-markdown-viewer-search-hints-images.md) |
| 138 | [Weight-Dynamic Attention Gauge](./0138-attention-gauge-weight-dynamic.md) |
| 139 | [User-Triggered Memory Handoff](./0139-default-memory-handoff.md) |
| 140 | [Approval Gate Safety](./0140-approval-gate-safety.md) |
| 141 | [Cross-Harness Peering — `peer_send` Across Harness Views](./0141-cross-harness-peering.md) |
| 142 | [Active-Lane → Window Accent](./0142-active-lane-window-accent.md) |
| 143 | [peer_send Auto-Accept](./0143-peer-send-auto-accept.md) |
| 144 | [Harness `#wiki` Command](./0144-harness-wiki-command.md) |
| 145 | [Simplify `#review` — Agent-Orchestrated Multi-Reviewer (Diff or Design Doc)](./0145-harness-design-review-panel.md) |
| 146 | [Review Quality Matrix](./0146-review-quality-matrix.md) |
| 147 | [Persistent Permission Mode (incl. full Bypass)](./0147-persistent-permission-mode.md) |
| 148 | [Lane Goal — Focus Scope](./0148-lane-goal-focus-scope.md) (removed 2026-09-01 — duplicated the Active Ticket panel) |
| 149 | [Artifact Inline Feedback](./0149-artifact-inline-feedback.md) |
| 150 | [Copilot Lane (GitHub Copilot CLI Native ACP)](./0150-acp-copilot-lane.md) |
| 151 | [Subscription Credit Usage View](./0151-subscription-usage-view.md) |
| 152 | [Cursor Real Usage in the Credit View](./0152-cursor-real-usage.md) |
| 153 | [Window AI Credit Status](./0153-window-ai-credit-status.md) |
| 154 | [Harness Controller CLI](./0154-harness-controller-cli.md) |
| 155 | [Live Working Diff](./0155-live-working-diff.md) |
| 156 | [Lane Activity Ticker](./0156-lane-activity-ticker.md) |
| 157 | [Harness Concise Mode](./0157-harness-concise-mode.md) |
| 158 | [Diff Review Comments](./0158-diff-review-comments.md) |
| 159 | [Cline ACP Lane](./0159-acp-cline-lane.md) |
| 160 | [Diff Review Priority](./0160-diff-review-priority.md) |
| 161 | [Directive Management Without Dedicated MCP Tools](./0161-directive-tools-on-demand.md) |
| 162 | [Review Priority Roll-up — footer indicator + summon overlay](./0162-review-priority-roll-up.md) |
| 163 | [Generic Directives](./0163-generic-directives.md) |
| 164 | [`#polly` — Any-Lane Orchestrator + Two-Worker Cap](./0164-polly-orchestration.md) |
| 165 | [Scope Memory to Handoff Only](./0165-memory-handoff-only.md) |
| 166 | [#polly Always Emits a Live Plan](./0166-polly-live-plan.md) |
| 167 | [`#debby` — Two-Headed Brainstorming Orchestration](./0167-debby-brainstorming.md) |
| 168 | [Harness Lane Monitor (Live Web Dashboard)](./0168-harness-lane-monitor.md) |
| 169 | [Dashboard Resource Status](./0169-dashboard-resource-status.md) |
| 170 | [Artifact Gallery (Loopback Web Endpoint)](./0170-artifact-gallery-endpoint.md) |
| 171 | [Docs Browser (Loopback Markdown Renderer)](./0171-docs-browser.md) |
| 172 | [Docs Browser Inline Feedback](./0172-docs-browser-inline-feedback.md) |
| 173 | [Artifact Gallery — Disk Rehydration on Startup](./0173-gallery-disk-rehydration.md) |
| 174 | [Docs Browser Artifact Export](./0174-docs-browser-artifact-export.md) |
| 175 | [Harness Web Control API](./0175-harness-web-control-api.md) |
| 176 | [Harness Browser Extension](./0176-harness-browser-extension.md) |
| 177 | [Harness Extension — Obsidian-grade Content Extraction](./0177-harness-extension-content-extraction.md) |
| 178 | [GitHub Issue Fixing](./0178-github-issue-fixing.md) |
| 179 | [YouTube Transcript Extraction](./0179-youtube-transcript-extraction.md) |
| 180 | [Orchestrator Console](./0180-orchestrator-console.md) |
| 181 | [Orchestrator Console — Permission Action](./0181-orchestrator-console-permission-action.md) |
| 182 | [Orchestrator Console — Prompt the Seat](./0182-orchestrator-console-seat-prompt.md) |
| 183 | [Attention Triage — Acknowledge Sends Feedback](./0183-attention-acknowledge-feedback.md) |
| 184 | [Orchestrator Console — Global Permission Queue](./0184-orchestrator-console-global-permission-queue.md) |
| 185 | [`/commands` — Built-in Hash-Command Reference Page](./0185-hash-command-reference-page.md) |
| 186 | [`/tools` — Built-in MCP Tool Reference Page](./0186-mcp-tool-reference-page.md) |
| 187 | [Claude Fable Weekly Usage Meter](./0187-claude-fable-weekly-usage.md) |
| 188 | [Oscilloscope Header Band](./0188-oscilloscope-header-band.md) |
| 189 | [Oscilloscope Band in Content Windows (Agent / ACP / Harness)](./0189-oscilloscope-harness-band.md) |
| 190 | [issue_progress Auto-Bind](./0190-issue-progress-auto-bind.md) |
| 191 | [Composable Verbs + GitHub-Issue Verb Set](./0191-composable-verbs-github-issue-toolset.md) |
| 192 | [GitHub Issue Analysis Viewer](./0192-issue-analysis-viewer.md) |
| 193 | [Grok Subscription Usage Meter](./0193-grok-usage-meter.md) |
| 194 | [Working-Ticket Picker & Active-Ticket Pin](./0194-working-ticket-picker.md) |
| 195 | [`#salty` — Model-Tiered Orchestration Workflow](./0195-salty-tiered-orchestration.md) |
| 196 | [`#draw` — tldraw Offline Local-Agent Command](./0196-tldraw-local-agent-command.md) |
| 197 | [`#draw` Document-Script Support](./0197-tldraw-document-script-support.md) |
| 198 | [Terminal Control Session Monitor:](./0198-termctrl-session-monitor.md) |
| 199 | [Cancel Escalation → Force-Restart for Hung ACP Lanes](./0199-cancel-escalation-force-restart.md) |
| 200 | [Telegram Harness Controller](./0200-telegram-harness-controller.md) |
| 201 | [Telegram Rich Responses](./0201-telegram-rich-responses.md) |
| 202 | [Telegram Lane Picker](./0202-telegram-lane-picker.md) |
| 203 | [Ticket Picker Actions](./0203-ticket-picker-actions.md) |
| 204 | [ACP Harness view file split](./0204-harness-view-split.md) |
| 205 | [Krypton Raycast Extension](./0205-raycast-extension.md) |
| 206 | [Assistant Response Resources](./0206-assistant-response-resources.md) |
| 207 | [Assistant Reference Git State](./0207-assistant-reference-git-state.md) |
| 208 | [Harness Live Assist Window](./0208-harness-live-assist-mode.md) |
| 209 | [Live Assist Compact Activity](./0209-live-assist-compact-activity.md) |
| 210 | [Quick Overview Dialog](./0210-quick-overview-dialog.md) |
| 211 | [Review Board — a composable, lane-authored review surface](./0211-review-board.md) |
| 212 | [Xenon — Central Resource Server](./0212-xenon-resource-server.md) |
| 213 | [Backend Link Indicator](./0213-backend-link-indicator.md) |
| 214 | [LLM Usage Statistics](./0214-llm-usage-statistics.md) |
| 215 | [Stacked Lane Visual Hierarchy](./0215-stacked-lane-hierarchy.md) |
| 216 | [Lane Thought Slot](./0216-workspace-thought-field.md) |
| 217 | [`#reviews` — a self-contained review page](./0217-review-archive-self-contained.md) |
| 218 | [Window Status Bar Lane Strip](./0218-window-lane-strip.md) |
| 219 | [Window Project Badge](./0219-window-project-badge.md) |
| 220 | [Window Diff Stat](./0220-window-diff-stat.md) |
| 221 | [Harness Status Line Redundancy Removal](./0221-harness-status-line-density.md) |
| 222 | [Harness Engineering Coach](./0222-harness-engineering-coach.md) |
| 223 | [Developer Daily Note](./0223-developer-daily-note.md) |
| 224 | [Publish the Daily Note to Xenon](./0224-daily-note-publish.md) |
| 225 | [Daily Brief — One Written Day per File](./0225-daily-brief.md) |
| 226 | [Titlebar Session Mark](./0226-titlebar-tail-zoom.md) |
| 227 | [Hurl Web Client](./0227-hurl-web-client.md) |
| 228 | [ACP fs Image / Binary Reads](./0228-acp-fs-image-reads.md) |
| 229 | [Grok `ask_user_question` ACP Client Method](./0229-grok-ask-user-question.md) |
| 230 | [Xenon Review Source Excerpts](./0230-xenon-review-excerpts.md) |
| 231 | [Lane Peek Action HUD](./0231-lane-peek-action-hud.md) (removed) |
| 232 | [Thought Teletype HUD](./0232-thought-teletype-hud.md) |
| 233 | [4px Container Radius](./0233-four-pixel-container-radius.md) (superseded by 234) |
| 234 | [8px Container Radius](./0234-eight-pixel-container-radius.md) |
| 235 | [Harness Tool Output Palette](./0235-harness-tool-output-palette.md) |
| 236 | [Workspace Footer Kind Palette](./0236-workspace-footer-kind-palette.md) |
| 237 | [Hurl Web Client — Copy as curl](./0237-hurl-copy-curl.md) |
| 238 | [Local Ticket Bundles](./0238-local-ticket-bundles.md) |
| 239 | [Agent Ticket Management](./0239-agent-ticket-management.md) |
| 240 | [Harness Transcript Annotation](./0240-harness-transcript-annotation.md) |
| 241 | [Scroll Tiling Layout (niri-style)](./0241-scroll-tiling-layout.md) |
| 242 | [`#ticket github` Browser Opener](./0242-ticket-github-browser-opener.md) |
| 243 | [Diff View Smooth Keyboard Scrolling](./0243-diff-view-smooth-scrolling.md) |
| 244 | [Review Board Chapters and Review Map](./0244-review-board-chapters.md) |
| 245 | [Stage Layout (macOS Stage Manager-inspired)](./0245-stage-layout.md) |
| 246 | [ACP Harness Dictation](./0246-harness-dictation.md) |
| 247 | [Remote ACP Harness via SSH Runtime](./0247-remote-acp-harness.md) |
| 248 | [Layout Switcher Popup](./0248-layout-switcher-popup.md) |
| 249 | [Harness Prompt-Cache Hit Rate](./0249-harness-cache-hit-rate.md) |
| 250 | [Harness Usage Visual Summary](./0250-usage-visual-summary.md) |
| 251 | [Harness Panel Visibility Command](./0251-harness-panel-visibility-command.md) |
| 252 | [ACP Harness Composer Soft Bloom](./0252-harness-composer-soft-bloom.md) |
| 253 | [Project Decision & Requirement Timeline](./0253-project-decision-requirement-timeline.md) |
| 254 | [Automatic Timeline Suggestions](./0254-automatic-timeline-suggestions.md) |
| 255 | [Natural-Language Timeline Recording](./0255-natural-language-timeline-recording.md) |
| 256 | [Thai Timeline Language](./0256-thai-timeline-language.md) |
| 257 | [TypeSafe Timeline Topic Suggestions](./0257-typesafe-timeline-topic-suggestions.md) |
| 258 | [TypeSafe API Call Metrics](./0258-typesafe-api-call-metrics.md) |
| 259 | [Publish Project Timeline to Xenon](./0259-timeline-xenon-publishing.md) |
| 260 | [Ticket Map](./0260-ticket-map.md) |
| 261 | [Timeline Reading and Stable Topic Identity](./0261-timeline-reading-and-topic-identity.md) |
| 262 | [Agent-Side Timeline Topic Discovery](./0262-agent-timeline-topic-discovery.md) |
| 263 | [Timeline Topic Merge and Undo](./0263-timeline-topic-merge.md) |
| 264 | [Xenon Timeline UI Parity](./0264-xenon-timeline-ui-parity.md) |
| 265 | [Artifact Gallery Project Grouping](./0265-artifact-gallery-project-grouping.md) |
| 266 | [Timeline Decision Trace and Conflict Review](./0266-timeline-decision-trace-and-conflicts.md) |
| 267 | [Timeline Conflicts Completed by the Lane Agent](./0267-timeline-conflicts-by-agent.md) |
| 268 | [Browser Extension Active Ticket Sync](./0268-browser-extension-active-ticket-sync.md) |
| 269 | [Review Board Auto-Push to Xenon](./0269-review-auto-push-xenon.md) |
| 270 | [Review Threads Without Worktrees](./0270-review-threads-without-worktrees.md) |
| 271 | [Keyboard Overlay (Ghost Hands)](./0271-keyboard-overlay.md) |
| 272 | [Wheel Layout (arc navigation wheel)](./0272-wheel-layout.md) |
| 273 | [Wheel Live Previews](./0273-wheel-live-previews.md) |
| 274 | [Wheel Ghost Eye (active card)](./0274-wheel-ghost-eye.md) |
| 275 | [ACP Harness view feature controllers](./0275-harness-view-controllers.md) |
| 276 | [Review Till Pass (`#review pass`)](./0276-review-till-pass.md) |
| 277 | [Review Pass on the Lane Monitor](./0277-review-pass-dashboard.md) |
| 278 | [ACP Harness Mid-Turn Steering](./0278-acp-harness-steering.md) |
| 279 | [ACP Form Elicitation (Agent Options Dialogs)](./0279-acp-elicitation-options.md) |
| 280 | [Harness Live Voice (`#live`)](./0280-harness-live-voice.md) |
| 281 | [ACP Harness Inline Images](./0281-harness-inline-images.md) |
| 282 | [ACP Harness Subagent Cards](./0282-harness-subagent-cards.md) |
| 283 | [ACP Harness SVG Fence Preview](./0283-harness-svg-fence-preview.md) |
| 284 | [Program Status Protocol (OSC 7501)](./0284-program-status-osc7501.md) |
| 285 | [ACP Harness Word Autocomplete (Ghost Text)](./0285-harness-word-autocomplete.md) |
| 286 | [ACP Harness Reference Thumbnails](./0286-harness-reference-thumbnails.md) |
| 287 | [ACP Antigravity Lane](./0287-acp-antigravity-lane.md) |
| 288 | [ACP Wire Profiler](./0288-acp-wire-profiler.md) |
| 289 | [Lane Context Delta](./0289-lane-context-delta.md) |
| 290 | [MP3 Player](./0290-mp3-player.md) |
| 291 | [ACP Brainstorm Lane Mode](./0291-brainstorm-lane-mode.md) |
| 292 | [ACP Harness Inline HTML Visuals](./0292-harness-inline-html-visuals.md) |
| 293 | [Global Handoff Resume](./0293-global-handoff-resume.md) |
| 294 | [ACP Harness Mermaid Fence Preview](./0294-harness-mermaid-fence-preview.md) |
| 295 | [GitHub Release Automation](./0295-github-release-automation.md) |
| 296 | [Open to Side: Content Panes in Splits](./0296-open-to-side-split.md) |
| 297 | [Pane Drag and Drop](./0297-pane-drag-and-drop.md) |
| 298 | [Global Lane Lessons](./0298-global-lane-lessons.md) |
| 299 | [Lesson Store Pressure and Consolidation](./0299-lesson-store-pressure-and-consolidation.md) |
| 300 | [Review Board Is Opt-In](./0300-review-board-opt-in.md) |
| 301 | [Harness UI Components](./0301-harness-ui-components.md) |
| 302 | [Harness Component Catalog](./0302-harness-component-catalog.md) |
| 303 | [Themeable Component Tokens](./0303-themeable-component-tokens.md) |
| 304 | [Manual Window Accent Color](./0304-manual-window-accent.md) |
| 305 | [Background Task Monitor](./0305-background-task-monitor.md) |
| 306 | [Harness Assist — cheap-model turn sidecar](./0306-harness-assist-sidecar.md) |
| 307 | [Interactive Handoff Picker](./0307-handoff-picker.md) |
| 308 | [ACP Harness Generative UI](./0308-harness-generative-ui.md) |
| 309 | [ACP Harness Generative UI Catalog](./0309-harness-genui-catalog.md) |
| 310 | [ACP Harness Generative UI — Inline Panel](./0310-harness-genui-inline-panel.md) |
| 311 | [Connected Computer Commands from ACP Harness](./0311-connected-computer-commands.md) |
| 312 | [ACP Harness `#ui` Preflight and Repair](./0312-harness-genui-preflight-repair.md) |
| 313 | [GenUI Component Gallery (Loopback Page)](./0313-genui-component-gallery.md) |
| 314 | [Harness Live Voice: Hold Left Option to Talk](./0314-harness-live-push-to-talk.md) |
| 315 | [Harness Execution Inspector](./0315-harness-execution-inspector.md) |
| 316 | [LLM-Managed Timeline](./0316-llm-managed-timeline.md) |
| 317 | [File Manager Components](./0317-file-manager-components.md) |
| 318 | [Connected Computer Read-Only Auto-Approval](./0318-connected-computer-read-only-auto-approval.md) |
| 319 | [Harness Execution Inspector Dialog](./0319-harness-execution-inspector-dialog.md) |
| 320 | [Harness Titlebar Panel Toggles](./0320-harness-titlebar-panel-toggles.md) |
| 321 | [Light Scheme Legibility](./0321-light-scheme-legibility.md) |
| 322 | [ACP Backend Update Check](./0322-acp-backend-update-check.md) |
| 323 | [Harness Follow-up Actions](./0323-harness-follow-up-actions.md) |
| 324 | [Harness Cell-Grid Box Drawing](./0324-harness-cell-grid-box-drawing.md) |
| 325 | [Harness Zen Rail Merged Tab](./0325-harness-zen-rail-merged-tab.md) |
| 326 | [Cell Grid for All Output](./0326-cell-grid-for-all-output.md) |
| 327 | [Harness Follow-up Prompts](./0327-harness-follow-up-prompts.md) |
| 328 | [Harness E2E Commands](./0328-harness-e2e-commands.md) |
| 329 | [Harness E2E Browser Explorer](./0329-harness-e2e-browser-explorer.md) |
| 330 | [Terminal Control Monitor Full Log View](./0330-termctrl-monitor-full-log.md) |
| 331 | [Ticket Panel Hides via the Titlebar Toggle](./0331-ticket-panel-titlebar-hide.md) |
| 332 | [Lane Context Trim](./0332-lane-context-trim.md) |

## ADRs (24)

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

## Also

- [prototypes/](./prototypes/) — HTML design comparisons
- [wiki/](./wiki/) — code wiki
- [concepts/](./concepts/) — notes that are not specs
- [adr/](./adr/) — architectural decision records
- [images/](./images/) — screenshots
