// Spec 301 — the component kernel.
//
// Two mechanisms replace the hand-maintained scar tissue in the harness view:
//
//   1. Props equality replaces `transcriptRenderSignature()`. Every component
//      declares `readDeps()` next to the `paint()` it guards. The method is
//      abstract on purpose — a default of `Object.values(next)` would be
//      reference equality over props, which is wrong for every payload the
//      harness mutates in place, and its failure mode (a silently stale row) is
//      exactly what forgetting a field in the signature does today.
//   2. `LiveComponent.seal()` is the ONLY live -> static transition. It
//      re-derives every wrapper class from state, so a class like
//      `acp-harness__msg--streaming` can never be left behind by name.
//
// The layer order statement is imported here (not only from index.css) because
// this module is a dependency of every component sheet's module: whichever CSS
// bundle the browser parses first, `@layer krypton.base, krypton.component, …`
// has already been declared.
import '../styles/layers.css';

export type Disposer = () => void;

/** Listener / timer / observer lifetime, in the VS Code `DisposableStore` shape. */
export class DisposableBag {
  private readonly disposers: Disposer[] = [];
  private disposed = false;

  add(disposer: Disposer): void {
    if (this.disposed) {
      disposer();
      return;
    }
    this.disposers.push(disposer);
  }

  listen<T extends EventTarget>(
    target: T,
    type: string,
    handler: EventListenerOrEventListenerObject,
    options?: AddEventListenerOptions,
  ): void {
    target.addEventListener(type, handler, options);
    this.add(() => target.removeEventListener(type, handler, options));
  }

  interval(ms: number, handler: () => void): void {
    const id = setInterval(handler, ms);
    this.add(() => clearInterval(id));
  }

  timeout(ms: number, handler: () => void): void {
    const id = setTimeout(handler, ms);
    this.add(() => clearTimeout(id));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    while (this.disposers.length > 0) {
      const disposer = this.disposers.pop();
      if (disposer) disposer();
    }
  }
}

export function sameDeps(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!Object.is(a[i], b[i])) return false;
  }
  return true;
}

const DEV = import.meta.env?.DEV === true;

/**
 * Owns one node, updates it in place, and disposes what it attached.
 *
 * `update()` is the whole diff: compare the dependency tuple, paint only when it
 * moved. A component is free to mount sub-components and call their `update()`
 * from its own `paint()`; late async state (Git refs, thumbnails, usage) should
 * instead `update()` the owning sub-component directly so the parent row is
 * never touched.
 */
export abstract class Component<P> {
  readonly el: HTMLElement;
  protected readonly bag = new DisposableBag();
  private deps: readonly unknown[] | null = null;
  private disposed = false;

  constructor(el: HTMLElement) {
    this.el = el;
  }

  /** True once `update()` has painted at least once. */
  get painted(): boolean {
    return this.deps !== null;
  }

  update(next: P): void {
    const d = this.readDeps(next);
    if (this.deps !== null && sameDeps(this.deps, d)) return;
    this.deps = d;
    this.paint(next);
    if (DEV) {
      const after = this.readDeps(next);
      if (!sameDeps(d, after)) {
        console.error(
          `[ui] ${this.constructor.name}.readDeps() is not stable across paint() — ` +
            'a dep is derived from state that paint() mutates, which makes every ' +
            'later update a forced repaint.',
        );
      }
    }
  }

  /** Store the current deps WITHOUT painting. Used by `LiveComponent.seal()`. */
  protected resync(next: P): void {
    this.deps = this.readDeps(next);
  }

  /** Force the next `update()` to paint, whatever the deps say. */
  protected invalidateDeps(): void {
    this.deps = null;
  }

  /**
   * The values `paint()` reads. ABSTRACT on purpose — see the file header.
   */
  protected abstract readDeps(next: P): readonly unknown[];

  protected abstract paint(next: P): void;

  /**
   * Re-derive every class this component's state implies. Called by `paint()`
   * and, critically, by `LiveComponent.seal()` — so no transition can leave a
   * stale class behind (CLAUDE.md constraint 10).
   */
  protected abstract syncClasses(next: P): void;

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.onDispose();
    this.bag.dispose();
  }

  protected onDispose(): void {
    /* subclasses tear down owned sub-components / parsers here */
  }
}

/**
 * A row the agent is still writing into.
 *
 * `live` starts true, but a subclass family where only some kinds stream (the
 * transcript rows) constructs the static ones with `live = false`: `seal()`
 * then returns early and `appendChunk()` never runs, so one base class can
 * serve both without a parallel hierarchy.
 */
export abstract class LiveComponent<P> extends Component<P> {
  private live: boolean;

  constructor(el: HTMLElement, live = true) {
    super(el);
    this.live = live;
  }

  get isLive(): boolean {
    return this.live;
  }

  /**
   * Live rows still take structural updates — only the text the agent is
   * appending is owned by `appendChunk()`. A tool row's status, exit code and
   * expand state must keep painting while it runs.
   */
  update(next: P): void {
    super.update(next);
    if (this.live) this.appendChunk(next);
  }

  protected abstract appendChunk(next: P): void;

  /** Drain the parser / cache the markdown / keep the body node identity. */
  protected abstract onSeal(): void;

  /**
   * The ONLY live -> static transition. Re-derives classes from state, then
   * re-syncs deps so the next pass is a no-op.
   */
  seal(next: P): void {
    if (!this.live) return;
    this.live = false;
    this.onSeal();
    this.syncClasses(next);
    this.resync(next);
  }
}
