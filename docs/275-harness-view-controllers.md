# Spec 275 — ACP Harness view feature controllers

**Status:** implemented (phase 1: dictation, timeline, tickets)
**Scope:** move feature state and behavior out of the `AcpHarnessView` class into per-feature
controller classes. No behavior change, no public interface change.

## Problem

Spec 204 moved the non-class helpers out of `src/acp/acp-harness-view.ts`, leaving "the class plus its
imports" at 12,032 lines. Features kept landing inside the class, and by this spec the file was back
at **16,665 lines** — ~15.5k of it one class with ~530 methods and ~93 private fields. Every feature's
state was reachable from every method, so nothing stated which parts of the view a feature depends on.

## Pattern

A controller is a plain class that **owns its feature's state** and receives a narrow **host**:

```
AcpHarnessView ──builds──▶ HarnessXHost (closures over the view)
       │                          ▲
       └──owns──▶ HarnessXController ─ uses only host.*
```

- Host contracts live in `src/acp/harness-view-host.ts` (`HarnessViewHost` base + one interface per
  controller). The view builds each host in a private `xHost()` method from getters/arrow closures, so
  the view's members stay `private` and the contract is the complete list of what a feature needs.
- The view holds `private readonly xCtl = new HarnessXController(this.xHost())` and delegates; other
  view code reads controller state through `this.xCtl.<field>`.
- A controller that listens to backend events exposes `subscribe()` / `dispose()`; a controller that
  owns DOM exposes `mount*()` and removes its listeners in `dispose()`.

## Extracted (phase 1)

| Module | Lines | Owns |
|---|---|---|
| `harness-view-host.ts` | 66 | Host contracts (base, dictation, timeline, ticket). |
| `harness-dictation-controller.ts` | 229 | Spec 246 speech session, composer preview patching, start/stop/finish/abort. Host: 8 members. |
| `harness-timeline-controller.ts` | 344 | Specs 253–267 `#timeline` dispatch, capture/review sheet, pending-suggestion count, automatic-suggestion flag, `acp-timeline-suggestion` listener. Host: 10 members. |
| `harness-ticket-controller.ts` | 1110 | Specs 194/238/239 active ticket + legacy snapshot, worker binding, pointer persist gate, `#ticket` picker dialog, ticket dock, progress/worker listeners. Host: 17 members. |
| `harness-ticket-helpers.ts` | 114 | Pure ticket picker/dock helpers and `controlError`, shared by view and controller without an import cycle; re-exported from the view so existing import sites keep working. |

`acp-harness-view.ts`: 16,665 → **15,045** lines.

## Deferred

- **Orchestrator console (spec 180)** — skipped in phase 1. Its methods touch ~25 distinct view members
  (lane cancel/close/restart/activate, permission answering, triage and review-priority stores,
  coordinator, lane bus, modal state). A host that wide restates the view instead of narrowing it;
  extract it after lane lifecycle has its own boundary.
- Review (38 methods), lane lifecycle, scroll/follow, composer, peek state.

## Testing

Tests that drove feature methods through `AcpHarnessView.prototype` now drive the controller
prototypes with a flat double that serves as its own host (`selfHost`), or give a prototype-backed
view double a controller (`withTicketCtl`). Source-text assertions read the controller file that now
holds the code.
