// Spec 341 — the one transient status line ("copied", "run cancelled",
// "reconnecting…"). Pages used `flash()`, `flashStatus()` and `showBanner()`.
// Spec 361: `<Banner>` renders a state; `useBanner()` owns the show/hide timer.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { JSX } from 'react';

import './banner.css';

export type BannerTone = 'info' | 'ok' | 'error';

export interface BannerProps {
  readonly text?: string;
  /** Omitted: the bare `lb-banner` class (a banner that was never shown). */
  readonly tone?: BannerTone;
  readonly hidden?: boolean;
}

/** A static status line; pair with `useBanner()` for a flash. */
export function Banner({ text = '', tone, hidden = false }: BannerProps): JSX.Element {
  return (
    <div className={tone ? `lb-banner lb-banner--${tone}` : 'lb-banner'} role="status" aria-live="polite" hidden={hidden}>
      {text}
    </div>
  );
}

export interface BannerController {
  /** Spread onto `<Banner>`; `props.hidden` replaces reading `banner.el.hidden`. */
  readonly props: BannerProps;
  /** Show `text`; `ms` > 0 hides it again after that long. Stable across renders. */
  show(text: string, tone?: BannerTone, ms?: number): void;
  /** Hide (keeping text and tone, like the old banner). Stable across renders. */
  hide(): void;
}

const INITIAL: BannerProps = { text: '', hidden: true };

/** The old `Banner` class as a hook: starts hidden, one timer, cleared on unmount. */
export function useBanner(): BannerController {
  const [props, setProps] = useState<BannerProps>(INITIAL);
  const timer = useRef<number | undefined>(undefined);

  const hide = useCallback((): void => {
    window.clearTimeout(timer.current);
    setProps((prev) => (prev.hidden ? prev : { ...prev, hidden: true }));
  }, []);

  const show = useCallback(
    (text: string, tone: BannerTone = 'info', ms = 0): void => {
      window.clearTimeout(timer.current);
      setProps({ text, tone, hidden: false });
      if (ms > 0) timer.current = window.setTimeout(hide, ms);
    },
    [hide],
  );

  useEffect(() => () => window.clearTimeout(timer.current), []);

  return useMemo(() => ({ props, show, hide }), [props, show, hide]);
}
