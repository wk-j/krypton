import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Mode, ProgressState } from './types';
import {
  abbreviatePath,
  composeRoleTitle,
  formatBytesPerSec,
  hintFor,
  modeLabel,
  progressText,
  stripCwdToken,
  tokenIsCwd,
} from './workspace-footer-format';

const env = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env;
let savedHome: string | undefined;

beforeEach(() => {
  savedHome = env.HOME;
  env.HOME = '/home/me';
});
afterEach(() => {
  env.HOME = savedHome;
});

describe('abbreviatePath', () => {
  it('abbreviates HOME and macOS user homes', () => {
    expect(abbreviatePath(null)).toBeNull();
    expect(abbreviatePath('/home/me')).toBe('~');
    expect(abbreviatePath('/home/me/src/x')).toBe('~/src/x');
    expect(abbreviatePath('/Users/other/Source')).toBe('~/Source');
    expect(abbreviatePath('/Users/other')).toBe('~');
    expect(abbreviatePath('/tmp/a')).toBe('/tmp/a');
  });
});

describe('tokenIsCwd / stripCwdToken', () => {
  it('matches exact and shell-abbreviated cwd tokens', () => {
    expect(tokenIsCwd('/home/me/Source/krypton', '/home/me/Source/krypton')).toBe(true);
    expect(tokenIsCwd('~/Source/krypton', '/home/me/Source/krypton')).toBe(true);
    expect(tokenIsCwd('~/S/krypton', '/home/me/Source/krypton')).toBe(true);
    expect(tokenIsCwd('~/S/kry', '/home/me/Source/krypton')).toBe(false);
    expect(tokenIsCwd('/tmp/a', '/home/me/Source/krypton')).toBe(false);
    expect(tokenIsCwd('anything', null)).toBe(false);
  });

  it('drops only the cwd token from a title', () => {
    expect(stripCwdToken('zsh ~/S/krypton', '/home/me/Source/krypton')).toBe('zsh');
    expect(stripCwdToken('vim /tmp/a', '/home/me/Source/krypton')).toBe('vim /tmp/a');
    expect(stripCwdToken('MD // foo', '/home/me')).toBe('MD // foo');
  });
});

describe('composeRoleTitle', () => {
  it('drops the role prefix when the title already names it', () => {
    expect(composeRoleTitle('acp_harness', 'ACP Harness', null)).toBe('ACP Harness');
  });

  it('prefixes the role and strips the cwd', () => {
    expect(composeRoleTitle('terminal', 'zsh ~/S/krypton', '/home/me/Source/krypton')).toBe('terminal zsh');
    expect(composeRoleTitle('terminal', '~', '/home/me')).toBe('terminal');
  });

  it('labels missing and quick-terminal roles', () => {
    expect(composeRoleTitle(null, '', null)).toBe('no focus');
    expect(composeRoleTitle('quick_terminal', '', null)).toBe('quick terminal');
  });
});

describe('formatBytesPerSec', () => {
  it('scales B/K/M', () => {
    expect(formatBytesPerSec(999)).toBe('999B/s');
    expect(formatBytesPerSec(1500)).toBe('1.5K/s');
    expect(formatBytesPerSec(2_500_000)).toBe('2.5M/s');
  });
});

describe('progressText', () => {
  it('formats pct, indeterminate, and hidden', () => {
    expect(progressText(null)).toBeNull();
    expect(progressText({ state: ProgressState.Hidden, pct: 50 })).toBeNull();
    expect(progressText({ state: ProgressState.Indeterminate, pct: null })).toBe('…');
    expect(progressText({ state: ProgressState.Indeterminate, pct: 41.6 })).toBe('42%');
  });
});

describe('modeLabel', () => {
  it('upper-snakes camelCase modes', () => {
    expect(modeLabel(Mode.Normal)).toBe(Mode.Normal.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase());
  });
});

describe('hintFor', () => {
  it('prioritises mode, then role, then music', () => {
    expect(hintFor(Mode.Compositor, 'acp_harness', true)).toBe('n new · h/j/k/l focus · ? details');
    expect(hintFor(Mode.Resize, null, false)).toBe('arrows adjust · Esc cancel');
    expect(hintFor(Mode.CommandPalette, null, false)).toBe('Esc close');
    expect(hintFor(Mode.Normal, 'acp_harness', true)).toBe('Cmd+P lanes · #cancel running');
    expect(hintFor(Mode.Normal, null, true)).toBe('Cmd+Shift+M music');
    expect(hintFor(Mode.Normal, null, false)).toBe('Leader v select · Cmd+O files · Cmd+Shift+G git');
  });
});
