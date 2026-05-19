// Krypton — LaneBus.
// Typed event emitter for ACP harness lane lifecycle.
// Subscribers (coordinator, badge renderer) react to status transitions
// without polling. Spec 106.

import type { LaneBusEvent } from './types';

type Handler = (event: LaneBusEvent) => void;

export class LaneBus {
  private handlers = new Set<Handler>();

  subscribe(handler: Handler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  emit(event: LaneBusEvent): void {
    for (const handler of this.handlers) {
      try {
        handler(event);
      } catch (e) {
        // A bad subscriber must not break the rest of the bus.
        console.error('LaneBus subscriber threw', e);
      }
    }
  }
}
