// Spec 302 §1.2 — `Spinner` (live).
//
// The braille cell the harness paints while something is running: the lane
// symbol (`harness-lane-chrome.ts:626-640`), the in-flight tool glyph
// (`harness-tool-render.ts:29-45`) and the composer prompt
// (`acp-harness-view.ts:13284-13287`). When the work ends the span drops the
// `acp-harness__spinner` class and shows a terminal glyph instead (✓ / ✗ at the
// tool call sites, the first frame at the composer prompt, nothing on an idle
// lane).
//
// The frame counter lives HERE, in the module, and `tickAllSpinners()` writes
// it into every mounted spinner. That is what the old design achieved with
// `SPINNER_FRAMES` + a view-held counter + a `querySelectorAll('.acp-harness__spinner')`
// re-apply per tick, plus the `liveSpinnerGlyph` module global in
// `harness-tool-render.ts:32-39` that re-seeded a rebuilt glyph at the live
// frame. A spinner built here never snaps back to frame 0, because a parent
// repaint does not rebuild it: it is a component with a stable node, and a
// structural update whose deps did not move writes nothing at all. The seed
// global is therefore unnecessary for this component (deleting it belongs to
// the lane that owns that file).
//
// Frames are advanced by JS, never by a CSS `@keyframes`: an animation restarts
// whenever its host element is recreated, which is the stutter this design was
// introduced to remove.

import './spinner.css';

import { LiveComponent } from '../../../ui/component';
import { el } from '../../../ui/dom';
import type { ComponentDef } from '../types';

export const SPINNER_FRAMES: readonly string[] = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** Every spinner that has been constructed and not yet disposed. */
const mounted = new Set<Spinner>();

let frame = 0;

/** The frame every running spinner is currently showing. */
export function currentSpinnerGlyph(): string {
  return SPINNER_FRAMES[frame];
}

/**
 * Advance the shared counter and write the new frame into every mounted
 * spinner. One call per interval tick, from whoever owns the timer.
 */
export function tickAllSpinners(): void {
  frame = (frame + 1) % SPINNER_FRAMES.length;
  const glyph = SPINNER_FRAMES[frame];
  for (const spinner of mounted) spinner.tick(glyph);
}

export interface SpinnerProps {
  readonly running: boolean;
  /** Shown once `running` is false. Omitted → the span goes empty. */
  readonly terminalGlyph?: string;
}

export class Spinner extends LiveComponent<SpinnerProps> {
  /** The glyph lives in one text node for the component's whole life: ten
   *  writes a second must not churn nodes under a streaming transcript. */
  private readonly glyphNode = document.createTextNode('');
  private running = false;

  constructor() {
    super(el('span'));
    this.el.appendChild(this.glyphNode);
    mounted.add(this);
  }

  /**
   * Called by `tickAllSpinners()`. Writing the glyph here rather than through
   * `paint()` is the point of the component being live: the frame is not a
   * dependency, so a tick never counts as a structural change.
   */
  tick(glyph: string): void {
    if (!this.running) return;
    this.write(glyph);
  }

  update(next: SpinnerProps): void {
    super.update(next);
    // The terminal glyph IS the live -> static transition for this component.
    if (!next.running) this.seal(next);
  }

  protected readDeps(next: SpinnerProps): readonly unknown[] {
    return [next.running, next.terminalGlyph];
  }

  protected syncClasses(next: SpinnerProps): void {
    if (next.running) this.el.className = 'acp-harness__spinner';
    else this.el.removeAttribute('class');
  }

  protected paint(next: SpinnerProps): void {
    this.running = next.running;
    this.syncClasses(next);
    this.write(next.running ? currentSpinnerGlyph() : next.terminalGlyph ?? '');
  }

  protected appendChunk(next: SpinnerProps): void {
    if (!next.running) return;
    this.write(currentSpinnerGlyph());
  }

  protected onSeal(): void {
    this.running = false;
  }

  protected onDispose(): void {
    mounted.delete(this);
  }

  private write(glyph: string): void {
    if (this.glyphNode.data !== glyph) this.glyphNode.data = glyph;
  }
}

export const def: ComponentDef = { id: 'spinner', blocks: ['acp-harness__spinner'] };
