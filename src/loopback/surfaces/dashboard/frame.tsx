// Specs 168/361 — the lane monitor's one animation-frame loop. The canvases
// redraw and the second-resolution counters re-read the clock on every frame;
// that work is imperative (a draw, a `textContent`), so a ticking counter
// never re-renders the card it sits in.

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { JSX, ReactNode } from 'react';

import { useLatest } from '../../kit';
import { FittedCanvas } from './canvas';

type FrameCallback = (now: number) => void;

interface FrameClock {
  subscribe(callback: FrameCallback): () => void;
  /** Run the rAF loop until the returned function stops it. */
  start(): () => void;
}

function createFrameClock(): FrameClock {
  const callbacks = new Set<FrameCallback>();
  return {
    subscribe(callback) {
      callbacks.add(callback);
      return () => {
        callbacks.delete(callback);
      };
    },
    start() {
      let frameId = 0;
      const frame = (): void => {
        const now = Date.now();
        for (const callback of callbacks) callback(now);
        frameId = requestAnimationFrame(frame);
      };
      frameId = requestAnimationFrame(frame);
      return () => cancelAnimationFrame(frameId);
    },
  };
}

const FrameContext = createContext<FrameClock | null>(null);

/** One rAF loop for everything below it, running while mounted. */
export function FrameProvider({ children }: { readonly children: ReactNode }): JSX.Element {
  const [clock] = useState(createFrameClock);
  useEffect(() => clock.start(), [clock]);
  return <FrameContext.Provider value={clock}>{children}</FrameContext.Provider>;
}

/** Call `callback(now)` on every animation frame (the latest render's closure). */
export function useFrame(callback: FrameCallback): void {
  const clock = useContext(FrameContext);
  const latest = useLatest(callback);
  useEffect(() => clock?.subscribe((now) => latest.current(now)), [clock, latest]);
}

export interface LiveTextProps {
  readonly tag?: 'span' | 'div';
  readonly className?: string;
  /** The text at `now`; rendered once, then rewritten on every frame. */
  text(now: number): string;
}

/** A label that keeps counting between polls (elapsed since, age of, turn time). */
export function LiveText({ tag = 'span', className, text }: LiveTextProps): JSX.Element {
  const node = useRef<HTMLElement | null>(null);
  const setNode = useCallback((next: HTMLElement | null): void => {
    node.current = next;
  }, []);
  useFrame((now) => {
    const current = node.current;
    if (!current) return;
    const next = text(now);
    if (current.textContent !== next) current.textContent = next;
  });
  const initial = text(Date.now());
  return tag === 'div' ? (
    <div ref={setNode} className={className}>
      {initial}
    </div>
  ) : (
    <span ref={setNode} className={className}>
      {initial}
    </span>
  );
}

export interface FrameCanvasProps {
  readonly className: string;
  /** Fixed CSS height in px; the width follows the layout. */
  readonly height: number;
  draw(canvas: FittedCanvas, now: number): void;
}

/** A `FittedCanvas` redrawn by `draw` on every animation frame. */
export function FrameCanvas({ className, height, draw }: FrameCanvasProps): JSX.Element {
  const node = useRef<HTMLCanvasElement>(null);
  const fitted = useRef<FittedCanvas | null>(null);
  useFrame((now) => {
    const current = node.current;
    if (!current) return;
    if (fitted.current?.el !== current) fitted.current = new FittedCanvas(current, height);
    draw(fitted.current, now);
  });
  return <canvas ref={node} className={className} style={{ height: `${height}px` }} />;
}
