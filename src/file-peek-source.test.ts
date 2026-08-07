import { describe, expect, it } from 'vitest';

import { resolvePeekPath, stripFileUrl } from './file-peek-source';
import { extToLang, formatSize, isBinaryExtension, isMarkdownFile } from './file-preview';

describe('file peek — path resolution', () => {
  it('passes absolute paths through untouched', () => {
    expect(resolvePeekPath('/Users/wk/Source/krypton/src/hints.ts', '/tmp'))
      .toBe('/Users/wk/Source/krypton/src/hints.ts');
  });

  it('anchors a relative path on the pane cwd', () => {
    expect(resolvePeekPath('src/hints.ts', '/Users/wk/Source/krypton'))
      .toBe('/Users/wk/Source/krypton/src/hints.ts');
  });

  it('normalises a trailing slash on the cwd and a leading ./ on the path', () => {
    expect(resolvePeekPath('./src/hints.ts', '/Users/wk/Source/krypton//'))
      .toBe('/Users/wk/Source/krypton/src/hints.ts');
  });

  it('throws for a relative path when no pane exposes a working directory', () => {
    expect(() => resolvePeekPath('src/hints.ts', null)).toThrow(/no working directory/);
  });

  it('strips and decodes a file:// url, leaving other text alone', () => {
    expect(stripFileUrl('file:///tmp/my%20notes.md')).toBe('/tmp/my notes.md');
    expect(stripFileUrl('src/hints.ts')).toBe('src/hints.ts');
  });
});

describe('file peek — content classification', () => {
  it('maps extensions to highlight.js languages, including bare dotfiles', () => {
    expect(extToLang('src/hints.ts')).toBe('typescript');
    expect(extToLang('src-tauri/src/config.rs')).toBe('rust');
    expect(extToLang('krypton.toml')).toBe('ini');
    expect(extToLang('Makefile')).toBe('makefile');
    expect(extToLang('src-tauri/Dockerfile')).toBe('dockerfile');
    expect(extToLang('LICENSE')).toBeNull();
  });

  it('routes markdown and binary files away from the code renderer', () => {
    expect(isMarkdownFile('docs/210-quick-overview-dialog.md')).toBe(true);
    expect(isMarkdownFile('README.markdown')).toBe(true);
    expect(isMarkdownFile('src/hints.ts')).toBe(false);
    expect(isBinaryExtension('src-tauri/sounds/deep-glyph/boot.wav')).toBe(true);
    expect(isBinaryExtension('src/hints.ts')).toBe(false);
  });

  it('formats sizes for the header meta', () => {
    expect(formatSize(512)).toBe('512B');
    expect(formatSize(21_913)).toBe('21.4K');
    expect(formatSize(3_145_728)).toBe('3.0M');
  });
});
