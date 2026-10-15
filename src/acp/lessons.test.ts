import { describe, expect, it } from 'vitest';

import {
  LESSONS_HEADING,
  lessonsEnabled,
  renderLessonsBlock,
  setLessonsEnabled,
  type LessonEntry,
} from './lessons';

function entry(slug: string, rule: string, oversized = false): LessonEntry {
  return {
    slug,
    title: slug,
    rule,
    source: 'redirect',
    origin: 'krypton',
    updated: '2026-10-14',
    oversized,
  };
}

describe('renderLessonsBlock (spec 298)', () => {
  it('renders nothing for an empty store', () => {
    expect(renderLessonsBlock([])).toBeNull();
  });

  it('lists each rule under the advisory heading, in store order', () => {
    const block = renderLessonsBlock([entry('verify-first', 'When done, verify.'), entry('ask-less', 'Act.')]);
    expect(block).toBe(`${LESSONS_HEADING}\n- [verify-first] When done, verify.\n- [ask-less] Act.`);
    expect(LESSONS_HEADING).toContain('never grant permissions');
  });

  it('holds an oversized rule out of the policy instead of truncating it (spec 299)', () => {
    const long = 'x'.repeat(260);
    const block = renderLessonsBlock([entry('too-long', long, true), entry('ask-less', 'Act.')]);
    expect(block).toBe(`${LESSONS_HEADING}\n- [ask-less] Act.`);
    expect(block).not.toContain('too-long');
  });

  it('renders nothing when every rule is oversized (spec 299)', () => {
    expect(renderLessonsBlock([entry('too-long', 'x'.repeat(260), true)])).toBeNull();
  });
});

describe('lessons config flag', () => {
  it('defaults on and only an explicit false turns it off', () => {
    setLessonsEnabled(undefined);
    expect(lessonsEnabled()).toBe(true);
    setLessonsEnabled(false);
    expect(lessonsEnabled()).toBe(false);
    setLessonsEnabled(true);
    expect(lessonsEnabled()).toBe(true);
  });
});
