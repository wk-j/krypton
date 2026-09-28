// Krypton — Keyboard overlay Web Worker (spec 271)
// Renders the ghost-hands keyboard on an OffscreenCanvas so heavy pty-output
// on the main thread cannot stall it. The main thread only posts resolved,
// already-unmasked key codes plus size/style/config changes.

import { KeyboardOverlayDriver, type OverlayMessage } from './keyboard-overlay-model';

const driver = new KeyboardOverlayDriver();

self.onmessage = (e: MessageEvent<OverlayMessage>) => {
  driver.handle(e.data);
  if (e.data.type === 'dispose') self.close();
};
