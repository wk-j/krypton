// Spec 380 — Grok (`grok agent stdio`, backend id `grok`).
//
// Grok sends typed `rawOutput` (`ReadFile`, `Bash`, `GrepSearch`, …), prefixes
// Bash dumps with `exit: N`, wraps grep hits in `<workspace_result>` and
// numbers `read_file` lines `1→`. Before spec 380 these readers ran on every
// lane; they now run on Grok lanes only.

import { normalizeToolDump } from '../harness-tool-render';
import { UNVERIFIED_SUPPLIES, stringifyToolValue } from './generic';
import type { LaneAdapter } from './types';

/** Grok `rawOutput.type` variants seen on the ACP wire (107 krypton sessions).
 *  Unknown types fall through to the generic key walker. */
export const GROK_RAW_OUTPUT_TYPES = [
  'ReadFile',
  'GrepSearch',
  'SearchReplace',
  'Bash',
  'MCP',
  'ListDir',
  'SearchTool',
  'Todo',
  'TaskOutput',
  'WebFetch',
  'BackgroundTaskStarted',
  'Text',
  'KillTask',
  'ImageGen',
] as const;

type ToolDumpSection = { label: string; text: string };

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function dumpSection(label: string, text: string): ToolDumpSection[] {
  return text.trim() ? [{ label, text }] : [];
}

function nestedContent(value: unknown): string {
  const rec = asRecord(value);
  if (rec && typeof rec.content === 'string') return rec.content;
  return stringifyToolValue(value);
}

/** Format Grok `GrepSearch.file_matches` as path-header + `line:text` rows. */
export function formatGrokFileMatches(value: unknown): string {
  if (!Array.isArray(value) || value.length === 0) return '';
  const lines: string[] = [];
  for (const file of value) {
    const rec = asRecord(file);
    if (!rec) continue;
    const path = typeof rec.path === 'string' ? rec.path : '';
    if (!path || !Array.isArray(rec.matches)) continue;
    lines.push(path);
    for (const match of rec.matches) {
      const row = asRecord(match);
      if (!row) continue;
      const n = row.line_number;
      const text = typeof row.content === 'string' ? row.content : '';
      if (typeof n === 'number') lines.push(`${n}:${text}`);
    }
  }
  return lines.join('\n');
}

function mcpDumpText(output: unknown): string {
  const rec = asRecord(output);
  if (!rec) return stringifyToolValue(output);
  if (typeof rec.OkayOutput === 'string') return rec.OkayOutput;
  if (typeof rec.Error === 'string') return rec.Error;
  return stringifyToolValue(output);
}

/**
 * Pull the human-readable dump out of Grok's typed `rawOutput`.
 * Returns `[]` when the type is known but the card should use ACP `content`
 * (e.g. SearchReplace diffs). Returns `null` for unknown shapes so the
 * generic walker still runs.
 */
export function grokRawOutputSections(rawOutput: unknown): ToolDumpSection[] | null {
  const rec = asRecord(rawOutput);
  const type = rec && typeof rec.type === 'string' ? rec.type : '';
  if (!rec || !type) return null;
  switch (type) {
    case 'ReadFile': {
      if (typeof rec.FileNotFound === 'string') return dumpSection('message', rec.FileNotFound);
      const body = nestedContent(rec.FileContent);
      if (body) return dumpSection('content', body);
      return [];
    }
    case 'GrepSearch': {
      const hits = formatGrokFileMatches(rec.file_matches);
      if (hits) return dumpSection('stdout', hits);
      const stdout = stringifyToolValue(rec.stdout);
      return dumpSection('stdout', stdout);
    }
    case 'ListDir':
    case 'WebFetch':
      return dumpSection('content', nestedContent(rec.Content));
    case 'Bash': {
      const prompt = typeof rec.output_for_prompt === 'string' ? rec.output_for_prompt : '';
      return dumpSection('output', prompt.trim() ? prompt : stringifyToolValue(rec.output));
    }
    case 'MCP': {
      const text = mcpDumpText(rec.output);
      return dumpSection(rec.is_error ? 'error' : 'output', text);
    }
    case 'SearchTool':
      return dumpSection('content', stringifyToolValue(rec.content));
    case 'Todo': {
      const todos = asRecord(rec.TodosUpdated);
      const summary = todos && typeof todos.summary_for_prompt === 'string' ? todos.summary_for_prompt : '';
      return dumpSection('output', summary);
    }
    case 'SearchReplace':
      return [];
    case 'BackgroundTaskStarted': {
      const summary = typeof rec.summary === 'string' ? rec.summary : '';
      return dumpSection('output', summary);
    }
    case 'TaskOutput': {
      const result = asRecord(rec.Result);
      return dumpSection('output', result ? stringifyToolValue(result.output) : '');
    }
    case 'Text':
      return dumpSection('output', typeof rec.text === 'string' ? rec.text : stringifyToolValue(rec.text));
    case 'KillTask': {
      const result = asRecord(rec.Result);
      const message = result && typeof result.message === 'string' ? result.message : '';
      return dumpSection('output', message);
    }
    case 'ImageGen': {
      const path = typeof rec.path === 'string' ? rec.path : '';
      return dumpSection('output', path);
    }
    default:
      return null;
  }
}

export const grokAdapter: LaneAdapter = {
  id: 'grok',
  // No subagent card and no `turnState` hook on Grok lanes.
  supplies: { ...UNVERIFIED_SUPPLIES, subagents: 'no', turnState: 'no' },
  outputSections: grokRawOutputSections,
  cleanOutput: normalizeToolDump,
  exitPrefix: true,
};
