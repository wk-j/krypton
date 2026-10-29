// Krypton — ACP Harness View: built-in `#` commands in flight, per lane (spec 343).
//
// A command run lives from the moment a `#` command is submitted until the work
// it started has settled — harness-side IPC, the agent turn it injected, or the
// background loop it started. The lane head and the Zen rail read the visible
// runs so a lane never reads plain `idle` while a built-in is still working.
// Lane status is untouched: the status word says what the agent is doing, a run
// says what the harness is doing for that lane.

import { formatElapsed, truncateInline } from './harness-format';

/** A run younger than this is never shown, so instant commands do not flicker. */
export const COMMAND_RUN_REVEAL_MS = 500;

const RUN_TEXT_MAX = 28;

/** `#<command>` → subcommands whose arguments are secrets and must never be painted. */
const SECRET_ARGUMENTS: Readonly<Record<string, readonly string[]>> = {
  '#xenon': ['token'],
};

export interface CommandRunView {
  readonly id: number;
  /** Redacted, whitespace-collapsed command text, at most 28 chars: `#e2e run login`. */
  readonly text: string;
  /** `formatElapsed(now - startedAt)`: `2:14`. */
  readonly elapsed: string;
}

interface CommandRun {
  readonly id: number;
  readonly laneId: string;
  readonly text: string;
  readonly startedAt: number;
}

/** The label a run shows. `#xenon token <secret>` → `#xenon token`. */
export function commandRunText(commandText: string): string {
  const parts = commandText.trim().split(/\s+/);
  const secret = SECRET_ARGUMENTS[parts[0]];
  if (secret && parts.length > 2 && secret.includes(parts[1])) return `${parts[0]} ${parts[1]}`;
  return truncateInline(parts.join(' '), RUN_TEXT_MAX);
}

export class CommandRunTracker {
  private readonly runs = new Map<number, CommandRun>();
  private nextId = 1;

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** Runs in flight across every lane, revealed or not. */
  get size(): number {
    return this.runs.size;
  }

  begin(laneId: string, commandText: string): number {
    const id = this.nextId++;
    this.runs.set(id, { id, laneId, text: commandRunText(commandText), startedAt: this.now() });
    return id;
  }

  /** Removes the run. True when it was past the reveal delay, i.e. on screen. */
  end(id: number): boolean {
    const run = this.runs.get(id);
    if (!run) return false;
    this.runs.delete(id);
    return this.now() - run.startedAt >= COMMAND_RUN_REVEAL_MS;
  }

  dropLane(laneId: string): void {
    for (const [id, run] of this.runs) {
      if (run.laneId === laneId) this.runs.delete(id);
    }
  }

  /** The view is going away: every later `end()` is a no-op. */
  clear(): void {
    this.runs.clear();
  }

  hasLane(laneId: string): boolean {
    for (const run of this.runs.values()) {
      if (run.laneId === laneId) return true;
    }
    return false;
  }

  /** Runs at least COMMAND_RUN_REVEAL_MS old, oldest first. */
  visible(laneId: string): CommandRunView[] {
    const now = this.now();
    const out: CommandRunView[] = [];
    // Map iteration is insertion order and ids only grow, so this is oldest first.
    for (const run of this.runs.values()) {
      if (run.laneId !== laneId) continue;
      const age = now - run.startedAt;
      if (age < COMMAND_RUN_REVEAL_MS) continue;
      out.push({ id: run.id, text: run.text, elapsed: formatElapsed(age) });
    }
    return out;
  }
}
