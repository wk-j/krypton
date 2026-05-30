# Krypton

Keyboard-driven terminal emulator (Rust + Tauri + xterm.js) with a cyberpunk aesthetic. A single fullscreen transparent native window hosts DOM-based terminal "windows" and an ACP harness that drives multiple AI agent lanes in parallel.

## Language

**Workspace**:
A virtual desktop — a full-screen arrangement of terminal windows.
_Avoid_: desktop, screen

**Window**:
A DOM-based terminal instance with custom chrome. Never a native OS window.
_Avoid_: pane (a pane is a split *inside* a window), tab

**Lane**:
One ACP agent session inside the harness. Carries a `HarnessLaneStatus` (`starting | idle | busy | needs_permission | awaiting_peer | error | stopped`), an inbox, and optionally a bound directive.
_Avoid_: agent (ambiguous — could mean the backend process or the pi-agent), thread

### Attention

**Attention triage**:
The act of distilling, from the activity of many lanes, the specific items that genuinely require the human's judgement — and surfacing them in one place for batched review. The human's attention is treated as the single serial bottleneck (the GIL of the agent fleet); triage exists to spend that bottleneck only on judgement, never to interrupt or "capture" the human's focus.
_Avoid_: extract attention (directional ambiguity — sounds like grabbing the human's focus), notify, alert

**Judgement item**:
The unit of attention triage. A single, specific decision extracted from within a lane's work that genuinely requires the human's judgement (e.g. "approve this auth-schema change", "pick a direction at this architectural fork") — *not* a whole lane and *not* a whole turn. The boring, machine-verifiable 80% of a turn never becomes a judgement item.
_Avoid_: task, todo, alert, notification, review request (a review request is a lane-to-lane peer message; a judgement item targets the human)

**Demand queue**:
The set of open judgement items — the things that actively call for the human's attention. Triage is a *router*, not a *gatekeeper*: the demand queue ranks what to look at first, it never decides on the human's behalf that something needn't be looked at.

**Silent pile**:
Every completed turn that produced no judgement item, plus any judgement item a lane has *self-resolved* (retracted because it answered its own question). Reviewable on demand but never demanding. A silent or self-resolved entry means "the machine handled it," *not* "auto-approved and discarded" — nothing leaves the system, it only stops demanding attention. The pile is how the human keeps the lock without being interrupted.

**Backpressure gauge**:
The single ambient signal of the triage UI: a static count of open judgement items (queue depth). It exists so the human can scale the agent fleet to their own review rate — the consumer seeing the producer's backlog — *not* to announce activity. It shows depth, never live motion; it does not blink, pulse, or alert.
_Avoid_: notification badge, alert count

**Triage grant** (spec 129):
A directive property (`triage_equipped`) that lets any lane *spawned* with that directive call `attention_flag` from its first turn — the per-lane opt-in sourced from a role rather than a keystroke. A *spawn-time default*, not live reconfiguration: flipping it does not retroactively equip a running lane.
_Avoid_: triage permission (a manual override can supersede it, so it is a default not a hard permission), enable triage (the feature is always on; the grant is per-lane)

**Manual equip** (spec 129):
The runtime `Leader '` override of a lane's triage grant. Wins over the directive-sourced grant until the lane is closed or a new directive is assigned (which clears the override). The means to equip a lane that has no directive, or to overrule the one it carries.

**Lane peek heat**:
The existing *deterministic* score that ranks lanes by activity (tools / tokens / peer / process) plus an alert boost (error > needs_permission > pendingShell > awaiting_peer). The pre-LLM baseline that attention triage builds on or replaces.
_Avoid_: priority, importance score
