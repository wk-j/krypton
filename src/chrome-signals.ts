// Chrome subscribers for the ViewBus.
// Consumes view:state and view:throughput signals and writes them onto the
// existing DOM as CSS custom properties / data-attributes. No per-view code
// here — every view that publishes the standard signals participates for free.
// See docs/104-chrome-signal-upgrades.md and docs/105-view-protocol.md.

import type { Compositor } from './compositor';
import type { ViewBus } from './view-bus';
import { type SignalState, type ViewAddress } from './view-bus-types';

/** Throughput → edge-glow intensity. 0 B/s ≈ 0.3, 16 KB/s+ ≈ 1.2. */
function intensityFor(bytesPerSec: number): number {
  const raw = 0.3 + bytesPerSec / 16384;
  return Math.max(0.3, Math.min(1.2, raw));
}

function isViewSource(source: unknown): source is ViewAddress {
  return typeof source === 'object' && source !== null && 'viewId' in source;
}

export function startChromeSignals(bus: ViewBus, compositor: Compositor): void {
  // Last-known state per viewId. Window chrome reflects the *focused* pane.
  const stateByView = new Map<string, SignalState>();

  const writeWindowFromFocus = (): void => {
    const viewId = compositor.getFocusedViewId();
    if (!viewId) return;
    const address = compositor.addressOf(viewId);
    if (!address) return;
    const winEl = compositor.getWindowElement(address.windowId);
    if (!winEl) return;
    const state = stateByView.get(viewId) ?? 'normal';
    if (state === 'normal') {
      delete winEl.dataset.signal;
    } else {
      winEl.dataset.signal = state;
    }
  };

  bus.onSignal({ kind: 'view:state' }, (s) => {
    if (!isViewSource(s.source)) return;
    stateByView.set(s.source.viewId, s.value);
    if (s.source.viewId === compositor.getFocusedViewId()) {
      writeWindowFromFocus();
    }
  });

  bus.onSignal({ kind: 'view:throughput' }, (s) => {
    if (!isViewSource(s.source)) return;
    const paneEl = compositor.getPaneElement(s.source.viewId);
    if (!paneEl) return;
    paneEl.style.setProperty(
      '--krypton-glow-intensity',
      intensityFor(s.value).toFixed(2),
    );
  });

  bus.onSignal({ kind: 'view:exit' }, (s) => {
    if (!isViewSource(s.source)) return;
    // Clear the pane's edge-glow back to default when the session ends.
    const paneEl = compositor.getPaneElement(s.source.viewId);
    paneEl?.style.removeProperty('--krypton-glow-intensity');
    // Drop the cached state so future focus changes don't read stale data.
    stateByView.delete(s.source.viewId);
    if (s.source.viewId === compositor.getFocusedViewId()) {
      writeWindowFromFocus();
    }
  });

  bus.onSignal({ kind: 'system:focus-change' }, writeWindowFromFocus);
}
