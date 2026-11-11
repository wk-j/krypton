import { describe, expect, it } from 'vitest';

import { SystemCommandRow } from './index';
import { createTranscriptRow, rowKindFor } from '../transcript/rows';
import type { RowProps } from '../transcript-row';
import type { HarnessTranscriptItem, SystemCommandPayload } from '../../harness-view-types';

function item(systemCommand: SystemCommandPayload): HarnessTranscriptItem {
  return { id: 'command-1', kind: 'system', text: 'portable text stays intact', systemCommand };
}

function props(next: HarnessTranscriptItem): RowProps {
  return { item: next, isNew: false, streaming: false, lane: null, projectDir: null, resolveLocalImages: false };
}

function mount(payload: SystemCommandPayload): SystemCommandRow {
  const next = props(item(payload));
  const row = createTranscriptRow(next);
  row.update(next);
  expect(row).toBeInstanceOf(SystemCommandRow);
  return row as SystemCommandRow;
}

function cells(row: SystemCommandRow): string[][] {
  return [...row.el.querySelectorAll('tbody tr')].map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent ?? ''));
}

describe('SystemCommandRow', () => {
  it('presents MCP endpoint, semantic headings, lane counts and the list meaning without parsing fallback text', () => {
    const row = mount({ command: 'mcp', endpoint: 'http://localhost/mcp/ชื่อเลน', warning: null, lanes: [
      { name: 'ชื่อเลน', initialized: 2, listed: 0, called: 4, lastSeenAt: null },
    ] });
    expect(row.el.querySelector('.acp-harness__msg-label')?.textContent).toBe('sys');
    expect(row.el.querySelector('.acp-harness__system-command-kind')?.textContent).toBe('mcp');
    expect(row.el.querySelector('.acp-harness__system-command-endpoint')?.textContent).toContain('http://localhost/mcp/ชื่อเลน');
    expect([...row.el.querySelectorAll('th')].map((th) => [th.getAttribute('scope'), th.textContent])).toEqual([
      ['col', 'Lane'], ['col', 'Init'], ['col', 'List'], ['col', 'Call'], ['col', 'Last'],
    ]);
    expect(cells(row)).toEqual([['— ชื่อเลน', '2', '0', '4', '—']]);
    expect(row.el.textContent).toContain('never queried this lane');
    expect(row.el.textContent).not.toContain('portable text');
  });

  it('shows MCP unavailable reason and continuation without suggesting any lane statistics', () => {
    const row = mount({ command: 'mcp', endpoint: null, warning: 'server unavailable', lanes: [] });
    expect(row.el.querySelector('.acp-harness__system-command-warning')?.textContent).toContain('server unavailable');
    expect(row.el.textContent).toContain('lanes continue without');
    expect(row.el.querySelector('table')).toBeNull();
  });

  it('shows the BG empty state without a table', () => {
    const row = mount({ command: 'bg', capturedAt: 10_000, tasks: [] });
    expect(row.el.querySelector('.acp-harness__msg-label')?.textContent).toBe('sys');
    expect(row.el.querySelector('.acp-harness__system-command-kind')?.textContent).toBe('bg');
    expect(row.el.textContent).toContain('no background tasks on this lane');
    expect(row.el.querySelector('table')).toBeNull();
  });

  it('shows BG state, snapshot elapsed, full command and output path in task table', () => {
    const row = mount({ command: 'bg', capturedAt: 65_000, tasks: [
      { id: 'bg-1', state: 'running', startedAt: 5_000, endedAt: null, bytes: 2048, command: 'npm run ตรวจสอบ --long-command', outputPath: '/tmp/output file.log' },
      { id: 'bg-2', state: 'exited', startedAt: 3_000, endedAt: 8_000, bytes: 0, command: 'echo done', outputPath: '/tmp/done.log' },
    ] });
    expect([...row.el.querySelectorAll('th')].map((th) => th.textContent)).toEqual(['Task', 'State', 'Elapsed', 'Output', 'Command', 'Output file']);
    expect(cells(row)).toEqual([
      ['bg-1', 'running', '1:00', '2 KB', 'npm run ตรวจสอบ --long-command', '/tmp/output file.log'],
      ['bg-2', 'exited', '0:05', '0 B', 'echo done', '/tmp/done.log'],
    ]);
    expect(row.el.querySelector('.acp-harness__system-command-scroll table')).not.toBeNull();
  });

  it('shows one assist task with mode, full summary and pause duration at the row snapshot', () => {
    const next = item({ command: 'assist', task: { id: 'assist-1', mode: 'manual', summary: 'สรุป long summary', pausedUntil: 180_000 } });
    next.createdAt = 60_000;
    const row = createTranscriptRow(props(next));
    row.update(props(next));
    expect(row.el.querySelector('.acp-harness__msg-label')?.textContent).toBe('sys');
    expect(row.el.querySelector('.acp-harness__system-command-kind')?.textContent).toBe('assist');
    expect(row.el.querySelector('.acp-harness__system-command-task-id')?.textContent).toBe('assist-1');
    expect(row.el.querySelector('.acp-harness__system-command-mode')?.textContent).toBe('manual');
    expect(row.el.querySelector('.acp-harness__system-command-summary')?.textContent).toBe('สรุป long summary');
    expect(row.el.textContent).toContain('Paused for 2:00');
    expect(row.el.querySelector('table')).toBeNull();
  });

  it('keeps notice, usage, directive diff, hidden indicator, and non-system items ahead of typed commands', () => {
    const command: SystemCommandPayload = { command: 'bg', capturedAt: 0, tasks: [] };
    expect(rowKindFor({ ...item(command), usage: {} as HarnessTranscriptItem['usage'] })).toBe('usage');
    expect(rowKindFor({ ...item(command), notice: { source: 'triage', subject: 'subject', tone: 'info' } })).toBe('notice');
    expect(rowKindFor({ ...item(command), diff: { title: 'x', unified: '+x' } })).toBe('directiveDiff');
    expect(rowKindFor({ ...item(command), id: '__hidden_indicator__' })).toBe('text');
    expect(rowKindFor({ ...item(command), kind: 'shell' })).toBe('text');
    expect(rowKindFor({ id: 'plain', kind: 'system', text: 'first\nsecond' })).toBe('text');
    const plain = { id: 'plain', kind: 'system' as const, text: 'first\nsecond' };
    const plainRow = createTranscriptRow(props(plain));
    plainRow.update(props(plain));
    expect(plainRow.el.querySelector('.acp-harness__msg-label')?.textContent).toBe('sys');
    expect(plainRow.el.querySelector('.acp-harness__msg-body')?.textContent).toBe('first\nsecond');
    const notice = { ...item(command), notice: { source: 'triage' as const, subject: 'Needs review', tone: 'attention' as const } };
    const noticeRow = createTranscriptRow(props(notice));
    noticeRow.update(props(notice));
    expect(noticeRow.el.querySelector('.acp-harness__msg-label')?.textContent).toBe('triage');
    expect(noticeRow.el.textContent).toContain('Needs review');
    expect(noticeRow.el.querySelector('.acp-harness__system-command')).toBeNull();
  });
});
