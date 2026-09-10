// Krypton — Stage layout (spec 245)
// Pure geometry and ordering for the active window + recent-window shelf.

import type {
  NormalizedStageFrame,
  StagePlacement,
  WindowBounds,
  WindowId,
} from './types';

export const STAGE_MAX_VISIBLE_RECENTS = 5;
export const STAGE_MIN_SHELF_CARD_HEIGHT = 72;
export const STAGE_MIN_WINDOW_WIDTH = 320;
export const STAGE_MIN_WINDOW_HEIGHT = 120;

const STAGE_SHELF_WIDTH_RATIO = 0.16;
const STAGE_SHELF_MIN_WIDTH = 160;
const STAGE_SHELF_MAX_WIDTH = 232;
const STAGE_DEFAULT_WIDTH_RATIO = 0.78;
const STAGE_DEFAULT_HEIGHT_RATIO = 0.9;
const STAGE_MAX_SHELF_CARD_HEIGHT = 140;

export interface StageLayoutInput {
  order: WindowId[];
  frame: NormalizedStageFrame;
  viewportWidth: number;
  viewportHeight: number;
  gap: number;
  footerHeight: number;
  maxVisibleRecents?: number;
}

export interface StageLayoutResult {
  placements: StagePlacement[];
  frame: NormalizedStageFrame;
  frameBounds: WindowBounds;
  shelfWidth: number;
  visibleRecentCount: number;
}

export function defaultStageFrame(
  viewportWidth: number,
  viewportHeight: number,
  gap: number,
  footerHeight: number,
): NormalizedStageFrame {
  const usableH = Math.max(1, viewportHeight - footerHeight - gap * 2);
  const shelfWidth = stageShelfWidth(viewportWidth);
  const stageLeft = gap + shelfWidth + gap;
  const stageRight = viewportWidth - gap;
  const availableW = Math.max(1, stageRight - stageLeft);
  const width = Math.min(viewportWidth * STAGE_DEFAULT_WIDTH_RATIO, availableW);
  const height = Math.max(1, Math.round(usableH * STAGE_DEFAULT_HEIGHT_RATIO));
  const x = stageLeft + Math.max(0, (availableW - width) / 2);

  return {
    x: x / Math.max(1, viewportWidth),
    y: (1 - STAGE_DEFAULT_HEIGHT_RATIO) / 2,
    width: width / Math.max(1, viewportWidth),
    height: height / usableH,
  };
}

export function syncStageOrder(
  order: WindowId[],
  ids: WindowId[],
  focusedId: WindowId | null,
): WindowId[] {
  const live = new Set(ids);
  const seen = new Set<WindowId>();
  const next: WindowId[] = [];

  for (const id of order) {
    if (live.has(id) && !seen.has(id)) {
      seen.add(id);
      next.push(id);
    }
  }
  for (const id of ids) {
    if (!seen.has(id)) {
      seen.add(id);
      next.push(id);
    }
  }

  if (focusedId && live.has(focusedId)) return focusStage(next, focusedId);
  return next;
}

export function focusStage(order: WindowId[], id: WindowId): WindowId[] {
  if (!order.includes(id)) return order.slice();
  return [id, ...order.filter((candidate) => candidate !== id)];
}

export function rotateStageOrder(order: WindowId[], direction: 1 | -1): WindowId[] {
  if (order.length < 2) return order.slice();
  const next = order.slice();
  if (direction > 0) {
    const front = next.shift();
    if (front) next.push(front);
  } else {
    const back = next.pop();
    if (back) next.unshift(back);
  }
  return next;
}

export function computeStageLayout(input: StageLayoutInput): StageLayoutResult {
  const vw = Math.max(1, input.viewportWidth);
  const vh = Math.max(1, input.viewportHeight);
  const gap = Math.max(0, input.gap);
  const usableH = Math.max(1, vh - input.footerHeight - gap * 2);
  const requestedShelfWidth = input.order.length > 1 ? stageShelfWidth(vw) : 0;
  const canFitShelf = vw - requestedShelfWidth - gap * 3 >= STAGE_MIN_WINDOW_WIDTH;
  const shelfWidth = canFitShelf ? requestedShelfWidth : 0;
  const defaultFrame = defaultStageFrame(vw, vh, gap, input.footerHeight);
  const centerActive = (requestedShelfWidth > 0 && shelfWidth === 0)
    || (input.order.length === 1 && framesNearlyEqual(input.frame, defaultFrame, vw, usableH));
  const frameBounds = resolveFrame(input.frame, vw, usableH, gap, shelfWidth, centerActive);
  const frame = normalizeFrame(frameBounds, vw, usableH, gap);
  const recentCount = Math.max(0, input.order.length - 1);
  const requestedVisible = Math.min(
    input.maxVisibleRecents ?? STAGE_MAX_VISIBLE_RECENTS,
    recentCount,
  );
  const heightCapacity = shelfWidth > 0
    ? Math.floor((usableH + gap) / (STAGE_MIN_SHELF_CARD_HEIGHT + gap))
    : 0;
  const visibleRecentCount = Math.min(requestedVisible, heightCapacity);
  const targets = shelfTargets(
    visibleRecentCount,
    shelfWidth,
    frameBounds,
    usableH,
    gap,
  );

  const placements = input.order.map((id, index): StagePlacement => {
    if (index === 0) {
      return {
        id,
        role: 'active',
        baseBounds: { ...frameBounds },
        translateX: 0,
        translateY: 0,
        scale: 1,
        opacity: 1,
        zIndex: 100,
        shelfIndex: null,
      };
    }

    const target = targets[index - 1];
    if (!target) {
      return {
        id,
        role: 'hidden',
        baseBounds: { ...frameBounds },
        translateX: 0,
        translateY: 0,
        scale: 1,
        opacity: 0,
        zIndex: 0,
        shelfIndex: null,
      };
    }

    return {
      id,
      role: 'shelf',
      baseBounds: { ...frameBounds },
      translateX: target.x - frameBounds.x,
      translateY: target.y - frameBounds.y,
      scale: target.scale,
      opacity: Math.max(0.48, 0.76 - (index - 1) * 0.05),
      zIndex: 50 - index,
      shelfIndex: index - 1,
    };
  });

  return { placements, frame, frameBounds, shelfWidth, visibleRecentCount };
}

function resolveFrame(
  frame: NormalizedStageFrame,
  vw: number,
  usableH: number,
  gap: number,
  shelfWidth: number,
  centerActive: boolean,
): WindowBounds {
  const stageLeft = shelfWidth > 0 ? gap + shelfWidth + gap : gap;
  const stageRight = vw - gap;
  const maxWidth = Math.max(1, stageRight - stageLeft);
  const minWidth = Math.min(STAGE_MIN_WINDOW_WIDTH, maxWidth);
  const minHeight = Math.min(STAGE_MIN_WINDOW_HEIGHT, usableH);
  const width = clamp(frame.width * vw, minWidth, maxWidth);
  const height = clamp(frame.height * usableH, minHeight, usableH);
  const requestedX = centerActive
    ? (vw - width) / 2
    : frame.x * vw;
  const x = clamp(requestedX, stageLeft, Math.max(stageLeft, stageRight - width));
  const requestedY = gap + frame.y * usableH;
  const y = clamp(requestedY, gap, Math.max(gap, gap + usableH - height));

  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
  };
}

function framesNearlyEqual(
  left: NormalizedStageFrame,
  right: NormalizedStageFrame,
  vw: number,
  usableH: number,
): boolean {
  const xTolerance = 2 / vw;
  const yTolerance = 2 / usableH;
  return Math.abs(left.x - right.x) <= xTolerance
    && Math.abs(left.y - right.y) <= yTolerance
    && Math.abs(left.width - right.width) <= xTolerance
    && Math.abs(left.height - right.height) <= yTolerance;
}

function normalizeFrame(
  bounds: WindowBounds,
  vw: number,
  usableH: number,
  gap: number,
): NormalizedStageFrame {
  return {
    x: bounds.x / vw,
    y: (bounds.y - gap) / usableH,
    width: bounds.width / vw,
    height: bounds.height / usableH,
  };
}

function shelfTargets(
  count: number,
  shelfWidth: number,
  frame: WindowBounds,
  usableH: number,
  gap: number,
): Array<{ x: number; y: number; scale: number }> {
  if (count <= 0 || shelfWidth <= 0) return [];
  const cardMaxW = Math.max(1, shelfWidth - gap * 2);
  const cardMaxH = Math.min(
    STAGE_MAX_SHELF_CARD_HEIGHT,
    (usableH - gap * Math.max(0, count - 1)) / count,
  );
  const scale = Math.min(cardMaxW / frame.width, cardMaxH / frame.height, 1);
  const cardW = frame.width * scale;
  const cardH = frame.height * scale;
  const stackH = cardH * count + gap * Math.max(0, count - 1);
  const x = gap + (shelfWidth - cardW) / 2;
  let y = gap + Math.max(0, (usableH - stackH) / 2);
  const targets: Array<{ x: number; y: number; scale: number }> = [];

  for (let i = 0; i < count; i++) {
    targets.push({ x: Math.round(x), y: Math.round(y), scale });
    y += cardH + gap;
  }
  return targets;
}

function stageShelfWidth(viewportWidth: number): number {
  return clamp(
    Math.round(viewportWidth * STAGE_SHELF_WIDTH_RATIO),
    STAGE_SHELF_MIN_WIDTH,
    STAGE_SHELF_MAX_WIDTH,
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
