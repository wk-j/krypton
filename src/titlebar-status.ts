// Krypton — Titlebar view status badge (spec 247).
// Pure DOM builder/patcher for the one text badge a content view contributes
// to the titlebar of the window hosting it (today: the remote Harness's SSH
// host). The compositor owns the window chrome and calls `syncTitlebarStatus`
// whenever the focused pane's badge changes; this module only renders and
// dispatches clicks.

import type { TitlebarStatus } from './types';

const BADGE_CLASS = 'krypton-window__view-status';
const TEXT_CLASS = 'krypton-window__view-status-text';
const TOGGLES_CLASS = 'krypton-window__view-toggles';
const SVG_NS = 'http://www.w3.org/2000/svg';

/** Latest activation callback per badge, so its one listener always calls the newest one. */
const activateByBadge = new WeakMap<HTMLElement, () => void>();
/** Render key of each badge; unchanged key → no DOM writes. */
const keyByBadge = new WeakMap<HTMLElement, string>();

function childWithClass(end: HTMLElement, cls: string): HTMLElement | null {
  for (const child of Array.from(end.children)) {
    if (child instanceof HTMLElement && child.classList.contains(cls)) return child;
  }
  return null;
}

function createBadge(): HTMLButtonElement {
  const badge = document.createElement('button');
  badge.type = 'button';
  badge.tabIndex = -1;
  badge.className = BADGE_CLASS;

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'krypton-window__view-status-icon');
  svg.setAttribute('aria-hidden', 'true');
  svg.appendChild(document.createElementNS(SVG_NS, 'use'));
  const dot = document.createElement('span');
  dot.className = 'krypton-window__view-status-dot';
  dot.setAttribute('aria-hidden', 'true');
  const text = document.createElement('span');
  text.className = TEXT_CLASS;
  badge.append(svg, dot, text);

  // Keep DOM focus where it is (the composer). No stopPropagation: the
  // window's own mousedown must still focus the window.
  badge.addEventListener('mousedown', (e: MouseEvent): void => {
    e.preventDefault();
  });
  badge.addEventListener('click', (): void => {
    if (badge.getAttribute('aria-disabled') === 'true') return;
    activateByBadge.get(badge)?.();
  });
  return badge;
}

/**
 * Render `status` in the titlebar `end` cluster, right after the spec 320
 * toggle cluster (which `syncTitlebarToggles` keeps first), else as the first
 * child — so neither sync ever moves the other's node. `null` removes the
 * badge. Writes the DOM only when a visible prop changes.
 */
export function syncTitlebarStatus(
  end: HTMLElement,
  status: TitlebarStatus | null,
  onActivate: () => void,
): void {
  let badge = childWithClass(end, BADGE_CLASS);
  if (!status) {
    badge?.remove();
    return;
  }

  if (!badge) badge = createBadge();
  const toggles = childWithClass(end, TOGGLES_CLASS);
  if (toggles) {
    if (toggles.nextElementSibling !== badge) toggles.after(badge);
  } else if (end.firstElementChild !== badge) {
    end.prepend(badge);
  }
  activateByBadge.set(badge, onActivate);

  const key = JSON.stringify([status.icon, status.text, status.tone, status.title, status.actionable === true]);
  if (keyByBadge.get(badge) === key) return;
  keyByBadge.set(badge, key);

  badge.dataset.tone = status.tone;
  // aria-disabled, not `disabled`: the badge stays an ordinary hover target
  // for its tooltip in every state; the click handler checks the attribute.
  badge.setAttribute('aria-disabled', status.actionable === true ? 'false' : 'true');
  badge.title = status.title;
  badge.setAttribute('aria-label', status.title);
  badge.querySelector('use')?.setAttribute('href', `#${status.icon}`);
  const text = badge.querySelector(`.${TEXT_CLASS}`);
  if (text) text.textContent = status.text;
}
