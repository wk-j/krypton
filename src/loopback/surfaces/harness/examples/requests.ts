// Spec 381 — Requests: what the agent asks the human before it goes on.

import type { PermissionOption } from '../../../../acp/types';
import { toolView } from './fixtures';
import type { GalleryEntry, GalleryInput, PermissionEvent } from './types';

const OPTIONS: PermissionOption[] = [
  { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
  { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
];

/** The decoded request, with the policy facts the decoder computes (spec 380 phase 2b). */
function permission(
  requestId: number,
  fields: Omit<PermissionEvent, 'type' | 'requestId' | 'options'>,
  resolved?: Extract<GalleryInput, { kind: 'permission' }>['resolved'],
): GalleryInput {
  return { kind: 'permission', event: { type: 'permission_request', requestId, options: OPTIONS, ...fields }, resolved };
}

const COMMAND_FIELDS: Omit<PermissionEvent, 'type' | 'requestId' | 'options'> = {
  view: toolView('perm-command', {
    kind: 'execute',
    status: 'pending',
    title: 'npm run build',
    subject: 'npm run build',
    command: 'npm run build',
    commandLine: 'npm run build',
  }),
  harnessTool: null,
  highRisk: false,
  argsPreview: 'description: Build the frontend',
  serverName: null,
};

export const REQUEST_ENTRIES: readonly GalleryEntry[] = [
  {
    id: 'request-permission',
    title: 'Permission',
    group: 'requests',
    summary: 'A tool call waiting for the human, and the decision recorded on it.',
    components: ['permission-row'],
    scenario: null,
    states: [
      { label: 'command', inputs: [permission(1, COMMAND_FIELDS)] },
      {
        label: 'edit',
        inputs: [permission(2, {
          view: toolView('perm-edit', {
            kind: 'edit',
            status: 'pending',
            title: 'Edit src/acp/adapters/claude.ts',
            subject: 'src/acp/adapters/claude.ts',
            modifiedPath: 'src/acp/adapters/claude.ts',
            locations: ['src/acp/adapters/claude.ts'],
          }),
          harnessTool: null,
          highRisk: false,
          argsPreview: 'file_path: src/acp/adapters/claude.ts · old_string: supplies…',
          serverName: null,
        })],
      },
      {
        label: 'MCP tool',
        inputs: [permission(3, {
          view: toolView('perm-mcp', {
            kind: 'other',
            status: 'pending',
            title: 'mcp__github__create_pull_request',
            subject: 'mcp__github__create_pull_request',
            mcp: { server: 'github', tool: 'create_pull_request' },
          }),
          harnessTool: null,
          highRisk: false,
          argsPreview: 'title: ACP lane adapters · base: master',
          serverName: 'github',
        })],
      },
      {
        label: 'high-risk command',
        inputs: [permission(4, {
          view: toolView('perm-risk', {
            kind: 'execute',
            status: 'pending',
            title: 'rm -rf dist build',
            subject: 'rm -rf dist build',
            command: 'rm -rf dist build',
            commandLine: 'rm -rf dist build',
          }),
          harnessTool: null,
          highRisk: true,
          argsPreview: '',
          serverName: null,
        })],
      },
      { label: 'resolved', inputs: [permission(5, COMMAND_FIELDS, { decision: 'accepted', label: '✓ approved once' })] },
    ],
  },
  {
    id: 'request-question',
    title: 'Question',
    group: 'requests',
    summary: 'A question with options the agent asked; the card the human answers on.',
    components: ['question-row'],
    scenario: null,
    states: [
      {
        label: 'single choice',
        inputs: [{
          kind: 'question',
          event: {
            type: 'ask_user_question',
            requestId: 10,
            questions: [{
              question: 'Which commit layout do you want?',
              options: [
                { label: 'One commit', description: 'Phase 3 and 4a together' },
                { label: 'Two commits', description: 'Split by phase with git add -p' },
              ],
            }],
          },
        }],
      },
      {
        label: 'multi-select',
        inputs: [{
          kind: 'question',
          event: {
            type: 'ask_user_question',
            requestId: 11,
            questions: [{
              question: 'Which backends should the fixtures cover?',
              multiSelect: true,
              options: [
                { label: 'claude', description: '' },
                { label: 'codex', description: '' },
                { label: 'grok', description: '' },
                { label: 'omp', description: '' },
              ],
            }],
          },
        }],
      },
      {
        label: 'answered',
        inputs: [{
          kind: 'question',
          event: {
            type: 'ask_user_question',
            requestId: 12,
            questions: [{ question: 'Run the contract test now?', options: [{ label: 'Yes', description: '' }, { label: 'Later', description: '' }] }],
          },
          resolved: { decision: 'accepted', label: 'Yes' },
        }],
      },
    ],
  },
  {
    id: 'request-elicitation',
    title: 'Form elicitation',
    group: 'requests',
    summary: 'An ACP form request (spec 279), shown on the same question card.',
    components: ['question-row'],
    scenario: null,
    states: [
      {
        label: 'form',
        inputs: [{
          kind: 'question',
          event: {
            type: 'elicitation_request',
            requestId: 20,
            message: 'Configure the fixture capture',
            requestedSchema: {
              type: 'object',
              properties: {
                backend: { type: 'string', title: 'Backend', enum: ['claude', 'codex', 'grok', 'omp'] },
                scrub: { type: 'boolean', title: 'Scrub home paths', description: 'Replace $HOME with ~ before saving.' },
              },
              required: ['backend'],
            },
          },
        }],
      },
    ],
  },
];
