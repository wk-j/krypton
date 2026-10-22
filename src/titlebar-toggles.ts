// Krypton — Titlebar view toggles (spec 320).
// Pure DOM builder/patcher for the icon toggle cluster a content view
// contributes to the titlebar of the window hosting it. The compositor owns
// the window chrome and calls `syncTitlebarToggles` whenever the focused
// pane's toggles change; this module only renders and dispatches clicks.

import type { TitlebarToggle } from './types';

const CLUSTER_CLASS = 'krypton-window__view-toggles';
const SVG_NS = 'http://www.w3.org/2000/svg';

/** Latest activation callback per cluster, so the one delegated listener
 *  always calls the newest one. */
const activateByCluster = new WeakMap<HTMLElement, (id: string) => void>();
/** Render key of each cluster's buttons; unchanged key → keep the nodes. */
const keyByCluster = new WeakMap<HTMLElement, string>();

function createCluster(): HTMLDivElement {
  const cluster = document.createElement('div');
  cluster.className = CLUSTER_CLASS;
  cluster.setAttribute('role', 'toolbar');
  cluster.setAttribute('aria-label', 'Panels');
  // Keep DOM focus where it is (the composer). No stopPropagation: the
  // window's own mousedown must still focus the window.
  cluster.addEventListener('mousedown', (e: MouseEvent): void => {
    e.preventDefault();
  });
  cluster.addEventListener('click', (e: MouseEvent): void => {
    const target = e.target;
    if (!(target instanceof Element)) return;
    const button = target.closest<HTMLButtonElement>('button[data-toggle-id]');
    if (!button || button.disabled || !cluster.contains(button)) return;
    const id = button.dataset.toggleId;
    if (id === undefined) return;
    activateByCluster.get(cluster)?.(id);
  });
  return cluster;
}

function buildButton(toggle: TitlebarToggle): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.tabIndex = -1;
  button.className = 'krypton-window__view-toggle';
  if (toggle.attention) button.classList.add('krypton-window__view-toggle--attention');
  button.dataset.toggleId = toggle.id;
  // spec 322: no `pressed` → a one-shot action button, not a toggle.
  if (toggle.pressed !== undefined) button.setAttribute('aria-pressed', toggle.pressed ? 'true' : 'false');
  button.setAttribute('aria-label', toggle.label);
  button.title = toggle.disabledReason ?? toggle.label;
  if (toggle.disabledReason !== undefined) button.disabled = true;

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'krypton-window__view-toggle-icon');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `#${toggle.icon}`);
  svg.appendChild(use);
  button.appendChild(svg);
  return button;
}

function buildSeparator(): HTMLSpanElement {
  const sep = document.createElement('span');
  sep.className = 'krypton-window__view-toggle-sep';
  sep.setAttribute('aria-hidden', 'true');
  return sep;
}

/**
 * Render `toggles` as the first child of the titlebar `end` cluster. An empty
 * list removes the cluster. Rebuilds only when the toggles' visible props
 * change, so repeated syncs keep button node identity.
 */
export function syncTitlebarToggles(
  end: HTMLElement,
  toggles: readonly TitlebarToggle[],
  onActivate: (id: string) => void,
): void {
  let cluster: HTMLElement | null = null;
  for (const child of Array.from(end.children)) {
    if (child instanceof HTMLElement && child.classList.contains(CLUSTER_CLASS)) {
      cluster = child;
      break;
    }
  }

  if (toggles.length === 0) {
    cluster?.remove();
    return;
  }

  if (!cluster) cluster = createCluster();
  if (end.firstElementChild !== cluster) end.prepend(cluster);
  activateByCluster.set(cluster, onActivate);

  const key = JSON.stringify(
    toggles.map((t) => [
      t.id,
      t.icon,
      t.label,
      t.pressed ?? null,
      t.attention === true,
      t.disabledReason ?? null,
      t.separatorBefore === true,
    ]),
  );
  if (keyByCluster.get(cluster) === key) return;
  keyByCluster.set(cluster, key);

  const nodes: HTMLElement[] = [];
  for (const toggle of toggles) {
    if (toggle.separatorBefore) nodes.push(buildSeparator());
    nodes.push(buildButton(toggle));
  }
  cluster.replaceChildren(...nodes);
}
