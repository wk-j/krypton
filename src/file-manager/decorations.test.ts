// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';

import { ROW_CLASS_DECORATORS, ageFillStyle, recencyByPath, sizeClass } from './decorations';
import { fileTypeClass } from './file-type';
import { dir, entry } from './test-fixtures';

describe('fileTypeClass', () => {
  it.each([
    ['run.sh', 'script'], ['main.ts', 'code'], ['Makefile', 'code'], ['Dockerfile', 'code'],
    ['a.json', 'config'], ['.gitignore', 'config'], ['a.css', 'markup'], ['a.md', 'doc'],
    ['a.png', 'image'], ['a.mp4', 'media'], ['a.zip', 'archive'], ['a.csv', 'data'],
  ])('%s → %s', (name, family) => {
    expect(fileTypeClass(entry(name))).toBe(`krypton-file-manager__item--ft-${family}`);
  });

  it('is empty for unknown, directories and symlinks', () => {
    expect(fileTypeClass(entry('a.unknown'))).toBe('');
    expect(fileTypeClass(dir('src.ts'))).toBe('');
    expect(fileTypeClass(entry('a.ts', { is_symlink: true }))).toBe('');
    expect(ROW_CLASS_DECORATORS.map((d) => d(entry('a.unknown')))).toEqual([null]);
  });
});

describe('sizeClass', () => {
  it('uses the 100 KiB and 1 MiB thresholds; dirs → null', () => {
    expect(sizeClass(entry('a', { size: 100 * 1024 - 1 }))).toBeNull();
    expect(sizeClass(entry('a', { size: 100 * 1024 }))).toBe('krypton-file-manager__size--large');
    expect(sizeClass(entry('a', { size: 1024 * 1024 }))).toBe('krypton-file-manager__size--mega');
    expect(sizeClass(dir('d', { size: 5 * 1024 * 1024 }))).toBeNull();
  });
});

describe('recencyByPath', () => {
  it('ranks modified > 0 into 0..1 and memoises on identity', () => {
    const list = [entry('a', { modified: 30 }), entry('b', { modified: 10 }), entry('c', { modified: 0 }), entry('d', { modified: 20 })];
    const r = recencyByPath(list);
    expect([...r.entries()]).toEqual([['/r/b', 0], ['/r/d', 0.5], ['/r/a', 1]]);
    expect(recencyByPath(list)).toBe(r);
    expect(recencyByPath([...list])).not.toBe(r);
  });

  it('gives a single entry 0.5', () => {
    expect(recencyByPath([entry('a', { modified: 5 })]).get('/r/a')).toBe(0.5);
  });
});

describe('ageFillStyle', () => {
  it('reproduces the ramp', () => {
    expect(ageFillStyle(0)).toEqual({ width: '15%', background: 'hsl(10, 85%, 35%)', opacity: '0.4' });
    expect(ageFillStyle(1)).toEqual({ width: '100%', background: 'hsl(50, 100%, 60%)', opacity: '1' });
  });
});
