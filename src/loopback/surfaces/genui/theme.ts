// Spec 313 rev 3 — paint the stage with the running app's own theme.

import { themeCssProperties, themeScheme } from '../../../theme';
import type { FullTheme } from '../../../theme';
import { fetchJson } from '../../kit';

/** `theme.json` from the loopback server: the app's resolved theme and its font. */
interface GalleryThemePayload {
  readonly theme: FullTheme;
  readonly font: { readonly family: readonly string[] | string; readonly size: number; readonly line_height: number };
}

const THEME_URL = '/genui-gallery/theme.json';

/**
 * Apply the app's tokens — the same `themeCssProperties()` the window applies,
 * plus the `[font]` properties `Compositor.applyConfig` sets — so a preview is
 * the component as Krypton draws it. Returns the label the rail shows.
 */
export async function applyKryptonTheme(): Promise<string> {
  const payload = await fetchJson<GalleryThemePayload>(THEME_URL);
  const root = document.documentElement;
  for (const [name, value] of Object.entries(themeCssProperties(payload.theme))) {
    root.style.setProperty(name, value);
  }
  const families = Array.isArray(payload.font.family) ? payload.font.family : [payload.font.family as string];
  const stack = families.map((family) => `'${family}'`).join(', ');
  root.style.setProperty('--krypton-font-family', `${stack}, 'Fira Code', 'Cascadia Code', monospace`);
  root.style.setProperty('--krypton-font-size', `${payload.font.size}px`);
  root.style.setProperty('--krypton-chrome-font-size', `${Math.round(payload.font.size * 0.786)}px`);
  root.style.setProperty('--krypton-line-height', `${payload.font.line_height}`);
  root.style.setProperty('--krypton-content-line-height', `${payload.font.line_height}`);
  root.style.setProperty('--krypton-prose-line-height', `${payload.font.line_height}`);
  root.dataset.themeScheme = themeScheme(payload.theme);
  root.dataset.theme = payload.theme.name;
  root.dataset.chrome = payload.theme.chrome.style;
  const name = payload.theme.meta.display_name || payload.theme.name;
  return `${name} · ${families[0] ?? 'default'} ${payload.font.size}px`;
}
