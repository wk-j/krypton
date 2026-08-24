import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  colorToRgb,
  contrastRatio,
  mixColors,
  relativeLuminance,
  rgbToHex,
  themeCssProperties,
  themeScheme,
  withAlpha,
  type FullTheme,
} from './theme';

function theme(overrides: {
  accent?: string;
  foreground?: string;
  background?: string;
  green?: string;
}): FullTheme {
  const accent = overrides.accent ?? '#0cf';
  const foreground = overrides.foreground ?? '#b0c4d8';
  const background = overrides.background ?? 'rgba(10, 10, 15, 0.5)';
  const green = overrides.green ?? '#0cf';
  return {
    name: 'fixture',
    meta: {
      display_name: 'Fixture',
      author: 'test',
      version: '1.0.0',
      description: '',
      license: 'MIT',
    },
    colors: {
      foreground,
      background,
      cursor: accent,
      selection: '#4f5b66',
      black: '#0a0a0f',
      red: '#ff3a5c',
      green,
      yellow: '#e8c547',
      blue: '#4a9eff',
      magenta: '#c77dff',
      cyan: accent,
      white: foreground,
      bright_black: '#2a4a6c',
      bright_red: '#ff5c7a',
      bright_green: '#33ddff',
      bright_yellow: '#ffd866',
      bright_blue: '#6ab4ff',
      bright_magenta: '#d9a0ff',
      bright_cyan: '#33ddff',
      bright_white: '#ffffff',
    },
    chrome: {
      style: 'cyberpunk',
      border: { width: 1, color: 'rgba(0, 200, 255, 0.3)', radius: 8 },
      shadow: { color: 'rgba(0, 200, 255, 0.07)', blur: 15, spread: 0, offset_x: 0, offset_y: 0 },
      backdrop: { color: 'rgba(6, 10, 18, 0.5)', blur: 12 },
      titlebar: {
        height: 28,
        background: 'transparent',
        text_color: 'rgba(0, 200, 255, 0.3)',
        font_size: 11,
        font_weight: 600,
        letter_spacing: 0.08,
        text_transform: 'uppercase',
        alignment: 'left',
      },
      status_dot: { size: 6, color: 'rgba(0, 200, 255, 0.25)', shape: 'square' },
      header_accent: {
        enabled: true,
        height: 6,
        color: 'rgba(0, 200, 255, 0.15)',
        margin_horizontal: 20,
        style: 'oscilloscope',
      },
      corner_accents: { enabled: true, size: 14, thickness: 2, color: 'rgba(0, 200, 255, 0.4)' },
      tabs: {
        height: 28,
        background: 'transparent',
        active_color: accent,
        inactive_color: 'rgba(0, 200, 255, 0.3)',
        font_size: 11,
      },
    },
    focused: {
      border_color: 'rgba(0, 200, 255, 0.5)',
      shadow_color: 'rgba(0, 200, 255, 0.12)',
      shadow_blur: 20,
      titlebar_text_color: accent,
      status_dot_color: accent,
      header_accent_color: 'rgba(0, 200, 255, 0.35)',
      corner_accent_color: accent,
      corner_accent_glow: 'rgba(0, 204, 255, 0.6)',
      label_color: accent,
    },
    workspace: { background: 'transparent', blur: 0 },
    ui: {
      command_palette: {
        background: 'rgba(6, 10, 18, 0.85)',
        border: 'rgba(0, 200, 255, 0.4)',
        text_color: foreground,
        highlight_color: accent,
        input_background: 'transparent',
        input_text_color: foreground,
        backdrop_blur: 16,
      },
      search: {
        background: 'rgba(6, 10, 18, 0.85)',
        text_color: foreground,
        match_color: '#ebcb8b',
        border: 'rgba(0, 200, 255, 0.4)',
      },
      mode_indicator: {
        background: 'rgba(0, 200, 255, 0.15)',
        text_color: accent,
        font_size: 11,
        position: 'bottom-center',
      },
      which_key: {
        background: 'rgba(6, 10, 18, 0.85)',
        border: 'rgba(0, 200, 255, 0.4)',
        title_color: accent,
        key_color: accent,
        label_color: 'rgba(0, 200, 255, 0.4)',
        separator_color: 'rgba(0, 200, 255, 0.2)',
        backdrop_blur: 16,
      },
      quick_terminal: {
        backdrop_blur: 20,
        background: 'rgba(6, 10, 18, 0.6)',
        shadow_color: 'rgba(0, 200, 255, 0.1)',
        shadow_blur: 30,
      },
      hints: {
        background: '#f4bf75',
        foreground: '#181818',
        matched_foreground: '#8a7444',
      },
    },
  };
}

describe('colorToRgb', () => {
  it('expands 3-digit hex used by krypton-dark (#0cf)', () => {
    expect(colorToRgb('#0cf')).toBe('0, 204, 255');
  });

  it('parses 6-digit hex', () => {
    expect(colorToRgb('#00C840')).toBe('0, 200, 64');
  });

  it('parses rgba() terminal backgrounds', () => {
    expect(colorToRgb('rgba(8, 8, 8, 0.92)')).toBe('8, 8, 8');
  });

  it('parses rgb()', () => {
    expect(colorToRgb('rgb(10, 10, 15)')).toBe('10, 10, 15');
  });

  it('drops the alpha nibble from 8-digit hex', () => {
    expect(colorToRgb('#00C84080')).toBe('0, 200, 64');
  });

  it('falls back to black on garbage', () => {
    expect(colorToRgb('not-a-color')).toBe('0, 0, 0');
  });
});

describe('rgbToHex / withAlpha', () => {
  it('round-trips an rgb triplet', () => {
    expect(rgbToHex('0, 200, 64')).toBe('#00c840');
  });

  it('rebuilds rgba from hex', () => {
    expect(withAlpha('#00C840', 0.35)).toBe('rgba(0, 200, 64, 0.35)');
  });
});

describe('themeCssProperties', () => {
  it('does not collapse #0cf accent to 0,0,0', () => {
    const props = themeCssProperties(theme({ accent: '#0cf' }));
    expect(props['--krypton-accent-rgb']).toBe('0, 204, 255');
    expect(props['--agent-primary-rgb']).toBe('0, 204, 255');
    expect(props['--agent-primary']).toBe('#0cf');
    expect(props['--krypton-border-radius']).toBe('8px');
  });

  it('drives agent and vault tokens from legacy-radiance green', () => {
    const props = themeCssProperties(
      theme({
        accent: '#00C840',
        foreground: '#C8E0D0',
        background: 'rgba(8, 8, 8, 0.92)',
        green: '#00C840',
      }),
    );
    expect(props['--krypton-accent-rgb']).toBe('0, 200, 64');
    expect(props['--agent-primary']).toBe('#00C840');
    expect(props['--agent-text']).toBe('#C8E0D0');
    expect(props['--agent-green']).toBe('#00C840');
    expect(props['--vault-primary']).toBe('#00C840');
    expect(props['--vault-primary-rgb']).toBe('0, 200, 64');
    expect(props['--krypton-window-accent']).toBe('#00C840');
    expect(props['--agent-accent']).toBe('#00C840');
    expect(props['--agent-user']).toBe('#00C840');
  });

  it('paints agent solid surfaces from chrome backdrop, not ANSI black', () => {
    const t = theme({ foreground: '#1c2c3c' });
    t.colors.black = '#1c2c3c';
    t.colors.cyan = '#007799';
    t.colors.green = '#0b7d6a';
    t.chrome.backdrop.color = 'rgba(6, 10, 18, 0.5)';
    const props = themeCssProperties(t);
    expect(themeScheme(t)).toBe('dark');
    expect(props['--agent-surface-solid']).toBe('rgba(6, 10, 18, 0.96)');
    expect(props['--agent-surface-mid']).toBe('rgba(6, 10, 18, 0.55)');
    expect(props['--krypton-bg-elev']).toBe('rgba(6, 10, 18, 0.92)');
    expect(props['--agent-text']).toBe('#1c2c3c');
    expect(props['--agent-accent']).toBe('#0b7d6a');
    expect(props['--agent-user']).toBe('#007799');
    expect(props['--agent-error']).toBe('#ff3a5c');
  });

  it('classifies frost chrome as a light scheme', () => {
    const t = theme({ foreground: '#1c2c3c' });
    t.chrome.backdrop.color = 'rgba(230, 239, 246, 0.90)';
    expect(themeScheme(t)).toBe('light');
    expect(relativeLuminance(t.chrome.backdrop.color)).toBeGreaterThan(0.8);
  });

  it('separates light rail from canvas and keeps ink contrast', () => {
    const t = theme({ foreground: '#1c2c3c', accent: '#007799' });
    t.colors.black = '#1c2c3c';
    t.chrome.backdrop.color = 'rgba(230, 239, 246, 0.90)';
    t.focused.corner_accent_color = '#007799';
    const props = themeCssProperties(t);
    expect(props['--krypton-scheme']).toBe('light');
    expect(props['--agent-surface-rail']).not.toBe(props['--agent-surface-canvas']);
    expect(props['--agent-surface-solid']).toBe('rgba(255, 255, 255, 0.94)');
    expect(props['--agent-surface-canvas']).toBe('rgba(255, 255, 255, 0.78)');
    expect(props['--agent-text']).toBe('#1c2c3c');
    expect(props['--agent-ghost']).toBe(props['--agent-surface-rail']);
    expect(contrastRatio(props['--agent-text'], '#ffffff')).toBeGreaterThanOrEqual(7);
    expect(contrastRatio(mixColors('#ffd166', '#1c2c3c', 0.28), '#f4f8fc')).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(mixColors('#8effb0', '#1c2c3c', 0.28), '#f4f8fc')).toBeGreaterThanOrEqual(4.5);
  });
});

describe('light scheme stylesheet', () => {
  const here = dirname(fileURLToPath(import.meta.url));

  it('is imported last so ink mixes beat neon-on-void alphas', () => {
    const index = readFileSync(join(here, 'styles/index.css'), 'utf8');
    const lastImport = [...index.matchAll(/@import '\.\/([^']+)';/g)].pop();
    expect(lastImport?.[1]).toBe('theme-scheme.css');
  });

  it('rewrites chrome and rail on html[data-theme-scheme=light]', () => {
    const css = readFileSync(join(here, 'styles/theme-scheme.css'), 'utf8');
    expect(css).toContain("html[data-theme-scheme='light'] .krypton-tab__title");
    expect(css).toContain("html[data-theme-scheme='light'] .acp-harness__rail");
    expect(css).toContain('--agent-surface-rail');
    expect(css).toContain('--krypton-backend-codex');
    expect(css).not.toMatch(/border-left:\s*[2-9]px/);
  });
});

describe('relativeLuminance / mixColors', () => {
  it('treats krypton-dark navy as near-black', () => {
    expect(relativeLuminance('rgba(6, 10, 18, 0.5)')).toBeLessThan(0.02);
  });

  it('mixes toward ink rather than washing to white', () => {
    const mixed = mixColors('#ffd166', '#1c2c3c', 0.28);
    expect(relativeLuminance(mixed)).toBeLessThan(relativeLuminance('#ffd166'));
    expect(relativeLuminance(mixed)).toBeGreaterThan(relativeLuminance('#1c2c3c'));
  });
});
