// Spec 301 phase 4 moved the lane head, the stats line and the slash palette
// into the `lane-head`, `lane-stats` and `inline-palette` components; their
// markup is asserted against the components now. What is tested here is the
// vocabulary this module still owns: which advertised commands a draft matches
// (`slashPaletteVisible` / `filteredSlashCommands`) and which prompts are bare
// agent command turns (`isAgentSlashCommand`, spec 279).
import { describe, expect, it } from 'vitest';

import {
  filteredSlashCommands,
  isAgentSlashCommand,
  slashPaletteVisible,
} from './harness-lane-chrome';
import type { HarnessLane } from './harness-view-types';

function makeLane(overrides: Partial<HarnessLane> = {}): HarnessLane {
  return {
    id: 'lane-1',
    backendId: 'claude',
    displayName: 'Claude-1',
    status: 'idle',
    draft: '',
    availableCommands: [],
    slashPaletteDismissed: false,
    slashPaletteIndex: 0,
    ...overrides,
  } as unknown as HarnessLane;
}

describe('slash palette — Codex skills', () => {
  const availableCommands = [
    { name: 'status', description: 'Display session status.' },
    { name: '$grill-with-docs', description: 'Stress-test a document.' },
    { name: '$grilling', description: 'Stress-test an idea.' },
  ];

  it('matches a Codex skill without requiring the dollar marker', () => {
    const lane = makeLane({ draft: '/grill-with-d', availableCommands });

    expect(slashPaletteVisible(lane)).toBe(true);
    expect(filteredSlashCommands(lane).map((command) => command.name)).toEqual([
      '$grill-with-docs',
    ]);
  });

  it('matches a Codex skill when the dollar marker is typed explicitly', () => {
    const lane = makeLane({ draft: '/$grill', availableCommands });

    expect(slashPaletteVisible(lane)).toBe(true);
    expect(filteredSlashCommands(lane).map((command) => command.name)).toEqual([
      '$grill-with-docs',
      '$grilling',
    ]);
  });

  it('keeps ordinary ACP slash commands unchanged', () => {
    const lane = makeLane({ draft: '/sta', availableCommands });

    expect(filteredSlashCommands(lane).map((command) => command.name)).toEqual(['status']);
  });

  it('keeps filtering namespaced OMP commands past the colon', () => {
    const lane = makeLane({
      draft: '/skill:gri',
      availableCommands: [
        { name: 'skillful', description: 'Toggle skill listing' },
        { name: 'skill:grilling', description: 'Grill the user.' },
        { name: 'skill:grill-me', description: 'Interview.' },
        { name: 'skill:triage', description: 'Triage.' },
      ],
    });

    expect(slashPaletteVisible(lane)).toBe(true);
    expect(filteredSlashCommands(lane).map((command) => command.name)).toEqual([
      'skill:grilling',
      'skill:grill-me',
    ]);
  });

  it('keeps filtering namespaced OMP skills past the slash, but not paths', () => {
    const availableCommands = [
      { name: 'skill:grilling', description: 'Grill the user.' },
      { name: 'skill:figma/figma-use', description: 'Use Figma.' },
    ];
    const lane = makeLane({ draft: '/skill:figma/fig', availableCommands });

    expect(slashPaletteVisible(lane)).toBe(true);
    expect(filteredSlashCommands(lane).map((command) => command.name)).toEqual([
      'skill:figma/figma-use',
    ]);
    expect(slashPaletteVisible(makeLane({ draft: '/Users/wk', availableCommands }))).toBe(false);
    expect(slashPaletteVisible(makeLane({ draft: '/skill:a/b/c', availableCommands }))).toBe(false);
  });
});

describe('isAgentSlashCommand — spec 279 bare command turns', () => {
  const commands = [
    { name: 'review', description: 'Review changes.' },
    { name: '$grill-with-docs', description: 'Stress-test a document.' },
  ];

  it('recognises an advertised command, with or without arguments', () => {
    expect(isAgentSlashCommand('/review', commands)).toBe(true);
    expect(isAgentSlashCommand('/review uncommitted changes', commands)).toBe(true);
    expect(isAgentSlashCommand('/$grill-with-docs docs/279.md', commands)).toBe(true);
  });

  it('keeps paths, unknown commands, and mid-text slashes as ordinary prompts', () => {
    expect(isAgentSlashCommand('/Users/wk/Source/krypton is broken', commands)).toBe(false);
    expect(isAgentSlashCommand('/reviewer', commands)).toBe(false);
    expect(isAgentSlashCommand('please run /review', commands)).toBe(false);
    expect(isAgentSlashCommand('/review', [])).toBe(false);
  });
});
