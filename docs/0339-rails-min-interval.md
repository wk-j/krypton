# Rails Minimum Interval — Implementation Spec

> Status: Implemented
> Date: 2026-10-28
> Milestone: ACP Harness — architecture conformance
> Builds on: 337 (Rails verifier, trigger and debounce) · ADR-0025

## Problem

The Rails verifier runs once after every lane turn that changes the working tree. Each run spends every declared check plus one judge model call. When a lane works in short turns, the runs come close together. On 2026-10-28 the `tantalum` harness recorded 7 auto runs. Two pairs started 98 s apart (12:06 / 12:08) and 33 s apart (21:11 / 21:12), and the second pair was committed 51 s later. `debounce_ms` cannot space these runs out: it is capped at 60 s, and it only waits for quiet after the *last* idle.

## Solution

Add `min_interval_ms` to `[acp_harness.rails]`: the shortest time between the start of the newest recorded run and the start of the next **auto** run. When the debounce fires inside that window, the controller **holds** the run instead of dropping it, and starts it once when the window ends, if the harness is quiet then. Default `0` keeps today's behaviour. Manual runs (`#rails now`, `r`) ignore the hold.

## Research

- **Trigger today** (`harness-rails-controller.ts:325-350`). Every lane busy → idle calls `arm()`, which (re)starts one `debounceTimer` holding one `armedTrigger`. `onDebounce()` returns if a run is in flight, the mode is not `auto`, or a lane is busy or needs permission. Otherwise it calls `startRun()`. Then `run()` stops on a clean tree (`:401`) or an unchanged fingerprint (`:433`), so the cost is paid only when the tree changed.
- **Run start time is already persisted.** Each `RailsRunRecord` has `startedAt`. The controller holds the newest 20 records in `history` (newest first), loaded from the ledger at mount and re-read after each of its own runs. A hold based on `history[0].startedAt` therefore survives an app restart with no new state.
- **Rust types the table.** `AcpHarnessRailsConfig` (`src-tauri/src/config.rs:800`) is a typed `serde` struct, and the frontend reads the re-serialized struct. So a key missing from the struct never reaches `resolveRailsConfig`, and Rust needs the field.
- **Clamps live in the frontend** (`src/acp/rails/config.ts`, `readClamped`), so an out-of-range value is corrected, not rejected.
- **Alternatives ruled out:**
  - **Raise the `debounce_ms` cap.** A 10-minute debounce delays even a lone turn by 10 minutes, and it keeps sliding while lanes work, so a busy harness may never run. A minimum interval caps the rate and still runs promptly after a long quiet gap.
  - **Drop a run inside the window.** The last turn's change would go unchecked until some later turn, while the dock shows an older result and nothing pending. So the run is held, not dropped.
  - **A per-hour run budget.** More state, and the user's complaint is about runs being too close together, not about a total.
  - **Count only auto runs.** A manual run has just checked the same tree at the same cost, so an auto run right after it adds the least value. Every recorded run counts.

## Prior Art

| App | Implementation | Notes |
|---|---|---|
| lodash `_.throttle(func, wait, { leading, trailing })` | Invokes at most once per `wait`. With `trailing`, calls during the wait collapse into one call at the end, with the last arguments. | Adopted: hold, then run once with the latest trigger. |
| watchexec `--debounce`, `--on-busy-update=queue` | Debounce waits for quiet. `queue` runs once more after the current run if events arrived during it. | Krypton already has both (debounce, stale re-arm). Neither caps the rate. |
| GitHub Actions `concurrency` | At most one running and one pending job per group; a newer pending job replaces the older one. | Same shape: one held trigger, and the latest lane's trigger wins. |

**Krypton delta:** no terminal or editor spaces a background AI judge. This is a throttle with a trailing edge, gated by Krypton's existing quiet-point rule.

## Affected Files

| File | Change |
|---|---|
| `src-tauri/src/config.rs` | `AcpHarnessRailsConfig.min_interval_ms: u64`, default `0`; the two rails config tests assert the default and that the key reaches the `get_config` JSON |
| `src/config.ts` | `AcpHarnessRailsConfig.min_interval_ms?: number`; clamp in the doc comment |
| `src/acp/rails/types.ts` | `RailsConfig.minIntervalMs`; `RailsProgress` gains `held` |
| `src/acp/rails/config.ts` (+ test) | `RAILS_LIMITS.minIntervalMs`; read with `readClamped` |
| `src/acp/rails/track.ts` (+ test) | `autoRunHoldMs(history, minIntervalMs, now)` |
| `src/acp/harness-rails-controller.ts` (+ test) | Hold in `onDebounce`; `#rails manual` clears a hold |
| `src/acp/components/rails-dock/index.ts` | `progressText` case `held` |
| `docs/0337-rails-verifier.md`, `docs/0005-data-flow.md`, `docs/0006-configuration.md`, `docs/adr/0025-…md`, `docs/README.md` | Flow step, config row and block, stale-rerun wording, index |

## Design

### Data Structures

```ts
// rails/config.ts
RAILS_LIMITS.minIntervalMs = { min: 0, max: 3_600_000, fallback: 0 };

// rails/types.ts
interface RailsConfig { /* … */ readonly minIntervalMs: number }
type RailsProgress = /* … */ | { readonly kind: 'held'; readonly until: number };

// rails/track.ts — ms an auto run must still wait; 0 = may start now.
export function autoRunHoldMs(history: readonly RailsRunRecord[], minIntervalMs: number, now: number): number;
```

`autoRunHoldMs` returns `0` when `minIntervalMs` is `0`, when `history` is empty, or when `history[0].startedAt` does not parse. Otherwise it returns `min(minIntervalMs, max(0, started + minIntervalMs - now))`. The `min` caps the hold when `startedAt` is in the future (the clock moved back).

### Data Flow

Step 2 of spec 337 gains a hold; every other step is unchanged.

```
1. Lane busy → idle → arm(trigger): (re)start debounceTimer for debounce_ms.
2. onDebounce: a run in flight, mode ≠ auto, or a lane busy / needs_permission → return
   (a shown `held` line goes back to idle). The next busy → idle re-arms.
2a. hold = autoRunHoldMs(history, min_interval_ms, now)
    hold > 0 → keep armedTrigger, debounceTimer = setTimeout(onDebounce, hold),
               progress { kind: 'held', until: now + hold }, return.
    hold = 0 → startRun(trigger) (step 3 onward, unchanged).
```

- **One timer.** The hold reuses `debounceTimer` and `armedTrigger`. A busy → idle during the hold re-arms the debounce, which replaces the held timer. When that debounce fires, step 2a recomputes the same end of window. A held run therefore starts once, at `max(window end, last idle + debounce_ms)`, with the latest trigger.
- **Stale re-run.** Step 8's re-arm goes through step 2a, so a stale run's re-run also waits for the window.
- **Manual runs** (`#rails now`, `r`) call `startRun` directly and never hold. Once recorded, a manual run becomes `history[0]`, so a pending hold recomputes its end from it.
- **Mode.** `#rails off` already cancels (`clearDebounce`, progress idle). `#rails manual` now also clears a pending hold: `clearDebounce()`, plus progress idle if it was `held`.

Example, with `min_interval_ms = 600000` on the 21:11 / 21:12 pair: 21:11:46 runs. At 21:12:19 the run is held until 21:21:46. The lane commits at 21:13:10, so the held run meets a clean tree and records nothing: 2 runs become 1.

### UI Changes

The dock head's static progress line shows `auto run held until 21:21 · min interval`, using `localHhMm` as `cooling` does. There is no countdown and no animation. The footer is unchanged: `footerSignal` treats `held` like `cooling` and shows the latest verdict.

### Configuration

```toml
[acp_harness.rails]
min_interval_ms = 0      # 0 = off; 0..3_600_000; spaces the start of auto runs
```

Table row in `0006`: `min_interval_ms` · int · `0` · "Shortest time from the start of the newest recorded run (auto or manual) to the start of the next auto run, clamped to 0–3600000. A run due inside the window is held and starts once when it ends, if the harness is quiet. `#rails now` ignores it." The value is applied when the harness mounts and on `#rails off | manual | auto`, as the other rails keys are.

## Edge Cases

- **No runs yet, or `min_interval_ms = 0`:** no hold; behaviour is exactly spec 337.
- **Runs that record nothing** (clean tree, unchanged fingerprint, paused, busy, cancelled) do not count: they spent no check or judge time.
- **The tree is clean or unchanged when a hold ends:** the existing stops apply and nothing is recorded.
- **A run in flight when the held timer fires:** returns as the debounce does today. That run either covered the tree or goes stale and re-arms.
- **A lane busy when the held timer fires:** return to idle. The lane's own busy → idle re-arms, and step 2a finds the window over.
- **Config changed during a hold:** `#rails auto` reloads the config. When the timer fires, step 2a recomputes with the new value and holds again or starts.
- **App restart:** `history` comes from the ledger at mount, so the window holds across restarts. Mount itself never starts a run.
- **Two harness views on one root:** each view measures from the newest run in the ledger it has read (at mount and after each of its own runs). A run by the other view since then is not seen, so the two can start closer than the window. Accepted: this is rare, and the per-root check lock (`busy`) still prevents two check runs at once.
- **`min_interval_ms` below `debounce_ms`:** a hold is shorter than the debounce, so the setting has no visible effect.

## Open Questions

None.

## Out of Scope

- Changing the `min_interval_ms = 0` default, or the `debounce_ms` range.
- Counting runs per hour, or scoping checks to changed paths.
- Holding manual runs, or a dock key to skip a hold (`r` already starts a run now).
- Any change to which turns trigger a run, or to the fingerprint and clean-tree stops.

## Resources

- [lodash `throttle`](https://lodash.info/doc/throttle): at-most-once per `wait`, with a trailing-edge call that carries the last arguments. This is the hold-not-drop shape.
- [watchexec(1)](https://github.com/watchexec/watchexec/blob/main/doc/watchexec.1.md): `--debounce` waits for quiet; `--on-busy-update=queue` runs once more after a busy run. Krypton already has both.
- [GitHub Actions: control concurrency](https://docs.github.com/actions/writing-workflows/choosing-what-your-workflow-does/control-the-concurrency-of-workflows-and-jobs): one running plus one pending per group, the newer pending replaces the older. This is the one-held-trigger shape.
