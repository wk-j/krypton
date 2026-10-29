import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  HASH_COMMANDS,
  buildCommandManifest,
  commandMeta,
  filteredHashCommands,
  hashPaletteVisible,
} from './hash-commands';

describe('hashPaletteVisible', () => {
  it('shows on a bare # at the start', () => {
    expect(hashPaletteVisible('#', false)).toBe(true);
  });

  it('shows while typing a command token', () => {
    expect(hashPaletteVisible('#rev', false)).toBe(true);
    expect(hashPaletteVisible('#new!', false)).toBe(true);
  });

  it('hides once a space (arguments) is typed', () => {
    expect(hashPaletteVisible('#review ', false)).toBe(false);
    expect(hashPaletteVisible('#recall what', false)).toBe(false);
  });

  it('hides when # is not at the start', () => {
    expect(hashPaletteVisible('see #review', false)).toBe(false);
    expect(hashPaletteVisible('', false)).toBe(false);
  });

  it('stays hidden when dismissed', () => {
    expect(hashPaletteVisible('#rev', true)).toBe(false);
  });
});

describe('filteredHashCommands', () => {
  it('returns every command for a bare #', () => {
    expect(filteredHashCommands('#')).toEqual(HASH_COMMANDS);
  });

  it('filters by case-insensitive prefix', () => {
    // Roster order, not alphabetical: `reviews` (spec 211's read-only browser
    // archive) is grouped with the other `surface` commands, well ahead of
    // `review` (the multi-reviewer workflow). Deliberately similar names for two
    // distinct commands, so the palette must list both.
    expect(filteredHashCommands('#RE').map((c) => c.name)).toEqual([
      'restart',
      'reviews',
      'resume',
      'recall',
      'review',
      'review-thread',
    ]);
  });

  it('matches the bang variant', () => {
    expect(filteredHashCommands('#new').map((c) => c.name)).toEqual(['new', 'new!']);
  });

  it('offers the review-thread command by its full prefix', () => {
    expect(filteredHashCommands('#review-thread').map((c) => c.name)).toEqual(['review-thread']);
  });

  it('returns nothing for an unknown prefix or non-palette draft', () => {
    expect(filteredHashCommands('#zzz')).toEqual([]);
    expect(filteredHashCommands('not a command')).toEqual([]);
  });
});

describe('autocomplete palette layout', () => {
  // Spec 301 phase 6: the three rules this asserts left the monolith for the
  // directories that own them — the command centre is shell chrome, the
  // palette is `InlinePalette`, the input line is `DraftLine`.
  it('keeps long palettes inside the Harness while preserving the input line', () => {
    expect(readFileSync(join(__dirname, '../styles/harness-shared.css'), 'utf8')).toMatch(
      /\.acp-harness__command-center\s*\{[^}]*max-height: 50%;[^}]*overflow: hidden;/s,
    );
    expect(
      readFileSync(join(__dirname, 'components/inline-palette/inline-palette.css'), 'utf8'),
    ).toMatch(
      /\.acp-harness__composer:not\(\.acp-harness__composer--permission\) \.acp-harness__slash-palette\s*\{[^}]*min-height: 0;[^}]*overflow-y: auto;/s,
    );
    expect(readFileSync(join(__dirname, 'components/draft-line/draft-line.css'), 'utf8')).toMatch(
      /\.acp-harness__composer:not\(\.acp-harness__composer--permission\) \.acp-harness__input-line\s*\{\s*flex: 0 0 auto;/,
    );
  });

  // "Keyboard selection stays visible after a rerender" used to be a grep of
  // `acp-harness-view.ts`. The call moved into the component, so the invariant
  // is now a DOM assertion:
  // components/inline-palette/inline-palette.test.ts
  // → 'keeps the newly selected row in view after a cursor move'.
});

// spec 185: the /commands reference page renders this manifest — coverage here
// is the drift guard (a command added without manifest metadata fails).
describe('buildCommandManifest', () => {
  const manifest = buildCommandManifest();
  const byName = new Map(manifest.map((e) => [e.name, e]));

  it('covers every palette command', () => {
    for (const c of HASH_COMMANDS) {
      expect(byName.has(c.name), `#${c.name} missing from manifest`).toBe(true);
    }
  });

  // Keep in sync with the console alias on the orchestrator entry.
  it('covers the console alias', () => {
    expect(byName.get('orchestrator')?.alias).toBe('console');
  });

  it('includes browser surfaces and the github-issue verbs in the palette roster', () => {
    const names = HASH_COMMANDS.map((c) => c.name);
    expect(names).toContain('docs');
    expect(names).toContain('panels');
    expect(names).toContain('timeline');
    expect(names).toContain('termctrl');
    expect(names).toContain('hurl');
    expect(names).toContain('dispatch-github-issue');
    expect(names).not.toContain('fix-issue');
    expect(byName.get('docs')?.badges).not.toContain('hidden');
    expect(byName.get('panels')?.category).toBe('surface');
    expect(byName.get('termctrl')?.category).toBe('surface');
    expect(byName.get('dispatch-github-issue')?.badges).not.toContain('hidden');
    expect(byName.get('dispatch-github-issue')?.alias).toBeUndefined();
    expect(HASH_COMMANDS.find((c) => c.name === 'ticket')?.args).toContain('owner/repo#123');
  });

  it('carries the real prompt template on every prompt-backed command', () => {
    const promptBacked = [
      'handoff', 'resume', 'wiki', 'recall',
      'directive', 'draw', 'review', 'polly', 'debby', 'dispatch-github-issue',
      'analyze-github-issue', 'fix-github-issue', 'tag-github-issue',
      'post-github-comment', 'attach-issue-artifact', 'handle-github-issue', 'rails',
    ];
    for (const name of promptBacked) {
      const prompt = byName.get(name)?.prompt ?? '';
      expect(prompt.length, `#${name} prompt is empty`).toBeGreaterThan(40);
    }
    expect(byName.get('resume')?.prompt).toContain('"<lane>"');
    expect(byName.get('polly')?.prompt).toContain('<task>');
    expect(byName.get('debby')?.prompt).toContain('<question>');
    expect(byName.get('draw')?.prompt).toContain('<drawing request>');
    expect(byName.get('dispatch-github-issue')?.prompt).toContain('<owner/repo#123>');
    // The composed verb's manifest prompt has its tokens resolved (spec 191).
    expect(byName.get('handle-github-issue')?.prompt).not.toContain('{{#');
    expect(byName.get('handle-github-issue')?.prompt).toContain('issue_progress');
  });

  it('assigns a category to every entry and anatomy to every workflow', () => {
    for (const e of manifest) {
      expect(['session', 'surface', 'agent']).toContain(e.category);
      if (e.badges.includes('workflow')) {
        expect(e.anatomy, `#${e.name} workflow lacks anatomy`).toBeTruthy();
        expect(e.lanes, `#${e.name} workflow lacks lane cost`).toBeTruthy();
      }
    }
  });

  // The manifest builder falls back to `session`/no-badge for an unknown name
  // (safe at runtime); this equality makes that fallback unreachable in a
  // shipped build — a roster entry without explicit metadata fails here.
  it('has explicit metadata for exactly the manifest name set', () => {
    const metaKeys = [...Object.keys(commandMeta())].sort();
    const manifestNames = manifest.map((e) => e.name).sort();
    expect(metaKeys).toEqual(manifestNames);
  });
});
