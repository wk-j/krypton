import { describe, expect, it } from 'vitest';

import {
  LANE_IMAGE_BUDGET,
  createBytesImage,
  createLaneImageState,
  disposeImages,
  findImagePaths,
  resolveImagePath,
  retainImage,
  scanValueForImagePaths,
} from './harness-images';
import type { HarnessImage } from './harness-view-types';

const PNG_BASE64 = btoa('\x89PNG\r\n\x1a\nrest-of-file');

describe('findImagePaths', () => {
  it('finds download destinations and redirects in shell commands', () => {
    const cmd = 'curl -sL -H "Authorization: token $(gh auth token)" https://github.com/user-attachments/assets/abc -o /tmp/issue-42.png && gh x >~/Desktop/b.jpg';
    expect(findImagePaths(cmd).paths).toEqual(['/tmp/issue-42.png', '~/Desktop/b.jpg']);
  });

  it('reads key=value flags and quoted paths with spaces', () => {
    expect(findImagePaths(`magick in.png --output=/tmp/out.webp "/tmp/my shot.png"`).paths)
      .toEqual(['/tmp/out.webp', '/tmp/my shot.png']);
  });

  it('keeps prose apostrophes literal and trims sentence punctuation', () => {
    const prose = "Here's the screenshot (saved to `/tmp/issue-42.png`). It's also in docs/img/a.gif.";
    expect(findImagePaths(prose).paths).toEqual(['/tmp/issue-42.png', 'docs/img/a.gif']);
  });

  it('ignores bare names, URLs, globs, variables, and markdown image syntax', () => {
    const text = 'shot.png https://x.dev/a.png /tmp/*.png $HOME/a.png ![alt](/tmp/inline.png) [l](/tmp/link.png)';
    expect(findImagePaths(text).paths).toEqual([]);
  });

  it('caps results and reports the overflow', () => {
    const text = Array.from({ length: 11 }, (_, i) => `/tmp/f${i}.png`).join(' ');
    const scan = findImagePaths(text);
    expect(scan.paths).toHaveLength(8);
    expect(scan.overflow).toBe(3);
  });
});

describe('scanValueForImagePaths', () => {
  it('accepts a whole string value as one path even with spaces, and walks nested values', () => {
    const rawInput = { file_path: '/Users/me/Desktop/Screen Shot 1.png', nested: [{ command: 'cp a /tmp/b.png' }] };
    expect(scanValueForImagePaths(rawInput).paths).toEqual(['/Users/me/Desktop/Screen Shot 1.png', '/tmp/b.png']);
  });
});

describe('resolveImagePath', () => {
  it('normalizes file URIs, keeps ~/ for Rust, and joins relative paths to the project', () => {
    expect(resolveImagePath('file:///tmp/a%20b.png', null)).toBe('/tmp/a b.png');
    expect(resolveImagePath('~/x.png', '/repo')).toBe('~/x.png');
    expect(resolveImagePath('./docs/../img/a.png', '/repo')).toBe('/repo/img/a.png');
    expect(resolveImagePath('img/a.png', null)).toBeNull();
    expect(resolveImagePath('/tmp/a.txt', null)).toBeNull();
  });
});

describe('createBytesImage', () => {
  it('trusts magic bytes over the declared mime and refuses non-images', () => {
    const png = createBytesImage('row', 'agent', { data: PNG_BASE64, mimeType: 'image/jpeg' }, 0, null);
    expect(png.state).toBe('live');
    expect(png.mimeType).toBe('image/png');
    const svg = createBytesImage('row', 'agent', { data: btoa('<svg onload="x"/>'), mimeType: 'image/svg+xml' }, 1, null);
    expect(svg.state).toBe('rejected');
    expect(svg.objectUrl).toBeNull();
    disposeImages(createLaneImageState(), [png]);
  });
});

describe('retainImage', () => {
  it('releases the oldest live images once the lane budget is exceeded', () => {
    const state = createLaneImageState();
    const make = (id: string, bytes: number): HarnessImage => ({
      ...createBytesImage(id, 'tool', { data: PNG_BASE64, mimeType: 'image/png' }, 0, null),
      bytes,
    });
    const first = make('a', LANE_IMAGE_BUDGET / 2);
    const second = make('b', LANE_IMAGE_BUDGET / 2);
    const third = make('c', 1024);
    expect(retainImage(state, first)).toEqual([]);
    expect(retainImage(state, second)).toEqual([]);
    expect(retainImage(state, third)).toEqual([first]);
    expect(first.state).toBe('released');
    expect(first.objectUrl).toBeNull();
    expect(state.bytes).toBe(LANE_IMAGE_BUDGET / 2 + 1024);
    disposeImages(state, [second, third]);
    expect(state.bytes).toBe(0);
  });
});
