// Krypton — Perspective Mouse Coordinate Correction
// Corrects mouse coordinates for CSS perspective + rotateX/Y distortion.

/**
 * Inverse perspective projection via ray-plane intersection.
 *
 * Given a screen-space point (sx, sy) relative to the perspective center,
 * returns the corresponding local coordinates on the content surface before
 * the perspective + rotateX(tiltX) rotateY(tiltY) transform was applied.
 *
 * Model: camera at (0, 0, d), screen plane at z=0.
 * Content plane passes through origin, rotated by Rx(tiltX) then Ry(tiltY).
 */
function inversePerspectiveProjection(
  sx: number, sy: number,
  d: number,
  tiltXDeg: number, tiltYDeg: number,
): { x: number; y: number } {
  const tx = tiltXDeg * Math.PI / 180;
  const ty = tiltYDeg * Math.PI / 180;
  const cosTx = Math.cos(tx), sinTx = Math.sin(tx);
  const cosTy = Math.cos(ty), sinTy = Math.sin(ty);

  // Normal of rotated plane: Rx(tx) · Ry(ty) · [0,0,1]
  const n1 = sinTy * cosTx;
  const n2 = -sinTx;
  const n3 = cosTy * cosTx;

  // Ray from camera (0,0,d) through screen point (sx,sy,0):
  //   P(t) = (t·sx, t·sy, d·(1-t))
  // Intersect with plane n·P = 0:
  //   t = n3·d / (n3·d - n1·sx - n2·sy)
  const denom = n3 * d - n1 * sx - n2 * sy;
  if (Math.abs(denom) < 1e-6) return { x: sx, y: sy };
  const t = (n3 * d) / denom;

  // World-space intersection point
  const wx = t * sx;
  const wy = t * sy;
  const wz = d * (1 - t);

  // Inverse rotation: Ry(-ty) · Rx(-tx)
  // Step 1: Rx(-tx)
  const x1 = wx;
  const y1 = wy * cosTx + wz * sinTx;
  const z1 = -wy * sinTx + wz * cosTx;
  // Step 2: Ry(-ty)
  const lx = x1 * cosTy - z1 * sinTy;
  const ly = y1;
  return { x: lx, y: ly };
}

/**
 * Correct mouse coordinates for perspective tilt distortion.
 *
 * CSS perspective + rotateX/Y on .krypton-window__content creates a non-linear
 * mapping between screen coords and content-local coords. xterm.js assumes a
 * linear mapping (clientX - rect.left), so mouse selection lands on the wrong
 * cell. We intercept mouse events in the capture phase, compute the correct
 * local coordinates via inverse perspective projection (ray-plane intersection),
 * and re-dispatch a synthetic event with corrected clientX/clientY.
 */
export function installPerspectiveMouseFix(contentEl: HTMLElement): void {
  const perspEl = contentEl.parentElement!; // .krypton-window__perspective
  const CORRECTED = '__kryptonPerspCorrected';

  const eventTypes = [
    'mousedown', 'mousemove', 'mouseup',
    'click', 'dblclick', 'contextmenu',
  ];

  for (const type of eventTypes) {
    contentEl.addEventListener(type, (e: Event) => {
      const me = e as MouseEvent;
      if ((me as unknown as Record<string, unknown>)[CORRECTED]) return;

      // Read perspective depth from the wrapper's computed style
      const perspValue = getComputedStyle(perspEl).perspective;
      if (!perspValue || perspValue === 'none') return;
      const d = parseFloat(perspValue);
      if (!(d > 0)) return;

      // Read tilt angles from CSS custom properties (set on workspace)
      const ws = contentEl.closest('.krypton-workspace') as HTMLElement | null;
      const src = ws ? getComputedStyle(ws) : getComputedStyle(document.documentElement);
      const tiltX = parseFloat(src.getPropertyValue('--krypton-perspective-tilt-x')) || 0;
      const tiltY = parseFloat(src.getPropertyValue('--krypton-perspective-tilt-y')) || 0;
      if (tiltX === 0 && tiltY === 0) return;

      // Only correct events targeting xterm elements
      const target = me.target as Element;
      const xtermScreen = target.closest('.xterm-screen');
      if (!xtermScreen) return;

      // Perspective wrapper rect — the untransformed reference frame
      const wrapperRect = perspEl.getBoundingClientRect();
      const cx = wrapperRect.left + wrapperRect.width / 2;
      const cy = wrapperRect.top + wrapperRect.height / 2;

      // Screen coords relative to perspective center
      const sx = me.clientX - cx;
      const sy = me.clientY - cy;

      // Inverse perspective: find local content coords from screen coords
      const local = inversePerspectiveProjection(sx, sy, d, tiltX, tiltY);

      // Compute the xterm screen's untransformed offset within the content.
      // offsetLeft/offsetTop are layout-based and unaffected by CSS transforms.
      let xtermOffX = 0, xtermOffY = 0;
      let el = xtermScreen as HTMLElement;
      while (el && el !== contentEl) {
        xtermOffX += el.offsetLeft;
        xtermOffY += el.offsetTop;
        el = el.offsetParent as HTMLElement;
      }

      // Position within the xterm screen (untransformed, from xterm top-left)
      const correctX = local.x + wrapperRect.width / 2 - xtermOffX;
      const correctY = local.y + wrapperRect.height / 2 - xtermOffY;

      // xterm.js computes: clientX - distortedRect.left - paddingLeft = localX
      // So set clientX = distortedRect.left + correctX (padding handled by xterm)
      const xtermRect = xtermScreen.getBoundingClientRect();
      const correctedClientX = xtermRect.left + correctX;
      const correctedClientY = xtermRect.top + correctY;

      // Skip if correction is negligible
      const dx = correctedClientX - me.clientX;
      const dy = correctedClientY - me.clientY;
      if (dx * dx + dy * dy < 0.25) return;

      // Stop original and dispatch corrected event on the same target
      me.stopImmediatePropagation();
      me.preventDefault();

      const corrected = new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: correctedClientX,
        clientY: correctedClientY,
        screenX: me.screenX + dx,
        screenY: me.screenY + dy,
        button: me.button,
        buttons: me.buttons,
        detail: me.detail,
        ctrlKey: me.ctrlKey,
        altKey: me.altKey,
        shiftKey: me.shiftKey,
        metaKey: me.metaKey,
        view: me.view,
        relatedTarget: me.relatedTarget,
      });
      Object.defineProperty(corrected, CORRECTED, { value: true, enumerable: false });
      target.dispatchEvent(corrected);
    }, { capture: true });
  }
}
