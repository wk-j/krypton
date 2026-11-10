// Spec 381 — Messages: what the agent writes and thinks, and what the user sent.

import { imageBlock, item } from './fixtures';
import type { GalleryEntry } from './types';

const PROSE = [
  'The decoder now reads the exit code from `terminal_exit`, so a failed command shows its code once.',
  '',
  'Two things changed:',
  '',
  '- the **Claude** adapter drops its `Exit code N` line when the code matches;',
  '- the line stays when the exit is unknown, because the well is then the only place it appears.',
].join('\n');

const CODE = [
  'The fix is one function in `generic.ts`:',
  '',
  '```ts',
  'export function dropExitLine(sections, exit, pattern) {',
  '  return sections.map((section) => {',
  '    const match = exit === null ? null : pattern.exec(section.text);',
  '    return match && Number(match[1]) === exit',
  '      ? { label: section.label, text: section.text.slice(match[0].length) }',
  '      : section;',
  '  });',
  '}',
  '```',
].join('\n');

const TABLE = [
  'Supply matrix, as declared today:',
  '',
  '| Field | claude | codex | grok |',
  '|-------|--------|-------|------|',
  '| exit | unverified | unverified | unverified |',
  '| subagents | unverified | unverified | no |',
  '| turnState | no | unverified | no |',
].join('\n');

const FENCES = [
  'The data flow, drawn:',
  '',
  '```svg',
  '<svg viewBox="0 0 240 60" xmlns="http://www.w3.org/2000/svg">',
  '  <rect x="4" y="14" width="64" height="32" rx="4" fill="none" stroke="var(--accent, #0cf)"/>',
  '  <text x="36" y="34" text-anchor="middle" font-size="11" fill="var(--fg, #ccc)">wire</text>',
  '  <path d="M70 30 H166" stroke="var(--muted, #888)" marker-end="url(#a)"/>',
  '  <rect x="170" y="14" width="64" height="32" rx="4" fill="none" stroke="var(--success, #3c6)"/>',
  '  <text x="202" y="34" text-anchor="middle" font-size="11" fill="var(--fg, #ccc)">view</text>',
  '</svg>',
  '```',
  '',
  '```mermaid',
  'graph LR',
  '  wire --> decoder --> view',
  '```',
].join('\n');

export const MESSAGE_ENTRIES: readonly GalleryEntry[] = [
  {
    id: 'message-agent',
    title: 'Agent message',
    group: 'messages',
    summary: 'Assistant text as markdown: prose, code, tables, diagram fences, images, and the live stream.',
    components: ['assistant-row', 'image-strip'],
    scenario: null,
    states: [
      { label: 'prose', inputs: [item({ kind: 'assistant', text: PROSE })] },
      { label: 'code fence', inputs: [item({ kind: 'assistant', text: CODE })] },
      { label: 'table', inputs: [item({ kind: 'assistant', text: TABLE })] },
      { label: 'svg and mermaid fences', inputs: [item({ kind: 'assistant', text: FENCES })] },
      {
        label: 'image',
        inputs: [item({ kind: 'assistant', text: 'Here is the screenshot I took:', imageBlocks: [imageBlock] })],
      },
      {
        label: 'streaming',
        streaming: true,
        inputs: [item({ kind: 'assistant', text: 'Reading the adapter sources first, then I will check the decoder' })],
      },
    ],
  },
  {
    id: 'message-thought',
    title: 'Thought',
    group: 'messages',
    summary: 'Reasoning text: clamped to a few lines, with the effort meter beside the label.',
    components: ['thought-row'],
    scenario: null,
    states: [
      { label: 'short', inputs: [item({ kind: 'thought', text: 'The exit code is already in the readout.' })] },
      {
        label: 'clamped',
        inputs: [
          item({
            kind: 'thought',
            text: [
              'The user wants the duplicate line gone, but only when it really is a duplicate.',
              'If the exit is unknown the line is the only place the code appears, so it has to stay.',
              'The pattern must anchor on the first line; a later line is real output.',
              'Codex never sends this line, so only the Claude adapter declares it.',
              'Tests: terminal output, content text, unknown exit, mismatched exit, a later line, Codex.',
            ].join('\n'),
          }),
        ],
      },
      {
        label: 'high effort',
        inputs: [
          item({
            kind: 'thought',
            text: Array.from(
              { length: 30 },
              (_, index) => `Step ${index + 1}: weigh where the restatement arrives and what the row already shows.`,
            ).join('\n'),
          }),
        ],
      },
      {
        label: 'streaming',
        streaming: true,
        inputs: [item({ kind: 'thought', text: 'Checking whether the line arrives in terminal output or in content' })],
      },
    ],
  },
  {
    id: 'message-user',
    title: 'User prompt',
    group: 'messages',
    summary: 'What the user sent, as the lane echoes it.',
    components: ['user-row', 'image-strip'],
    scenario: null,
    states: [
      { label: 'text', inputs: [item({ kind: 'user', text: 'Run the shell command `echo boom; exit 3`, then tell me its exit code.' })] },
      { label: 'image', inputs: [item({ kind: 'user', text: 'Why does this row show the code twice?', imageBlocks: [imageBlock] })] },
    ],
  },
];
