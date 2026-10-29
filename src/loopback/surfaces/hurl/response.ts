// Spec 227 — the response pane: `hurl --include` output split into exchanges
// (status line, headers, body) and painted as Pretty / Raw / Headers.

import { stripAnsi } from '../../../hurl-ansi';
import { el } from '../../../ui/dom';
import { emptyState, keyValue } from '../../kit';

export type ResponseView = 'pretty' | 'raw' | 'headers';

export interface Exchange {
  readonly status: string;
  readonly headers: [string, string][];
  body: string;
}

export interface ResponseState {
  readonly running: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly view: ResponseView;
}

export function combinedOutput(stdout: string, stderr: string): string {
  return stdout + (stderr ? `\n${stderr}` : '');
}

export function parseExchanges(text: string): Exchange[] {
  const list: Exchange[] = [];
  let cur: Exchange | null = null;
  let mode: 'headers' | 'body' = 'headers';
  for (const line of stripAnsi(text).split('\n')) {
    const status = line.match(/^HTTP(?:\/[0-9.]+)? [0-9]{3}/);
    if (status) {
      if (cur) list.push(cur);
      cur = { status: status[0], headers: [], body: '' };
      mode = 'headers';
      continue;
    }
    if (!cur) continue;
    if (mode === 'headers') {
      if (line.trim() === '') {
        mode = 'body';
        continue;
      }
      const colon = line.indexOf(':');
      if (colon > 0) cur.headers.push([line.slice(0, colon).trim(), line.slice(colon + 1).trim()]);
      continue;
    }
    cur.body += (cur.body ? '\n' : '') + line;
  }
  if (cur) list.push(cur);
  return list;
}

export function prettyBody(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw.trim()), null, 2);
  } catch {
    return raw;
  }
}

/** What `y` copies: the raw text in Raw view, else the first exchange's body. */
export function copyableBody(state: ResponseState): string {
  const all = combinedOutput(state.stdout, state.stderr);
  if (state.view === 'raw') return stripAnsi(all);
  const first = parseExchanges(state.stdout)[0];
  return prettyBody(first ? first.body : all);
}

function exchangeNode(ex: Exchange, withBody: boolean): HTMLElement {
  const code = parseInt(ex.status.replace(/^.* /, ''), 10);
  const tone = withBody ? (code >= 200 && code < 300 ? 'ok' : 'bad') : null;
  return el(
    'article',
    { class: 'lb-hurl__exchange' },
    el('div', { class: ['lb-hurl__status', tone && `lb-hurl__status--${tone}`], text: ex.status }),
    keyValue(ex.headers.map(([name, value]) => [name, value] as const)),
    withBody ? el('pre', { class: 'lb-hurl__body', text: prettyBody(ex.body) }) : null,
  );
}

export function renderResponse(state: ResponseState): Node[] {
  const { running, stdout, stderr, view } = state;
  if (running && !stdout && !stderr) return [emptyState('Running hurl --color --pretty --include…')];
  if (!stdout && !stderr) return [emptyState('No cached response. Press Enter to run.')];
  const all = combinedOutput(stdout, stderr);
  if (view === 'raw') return [el('pre', { class: 'lb-hurl__raw', text: stripAnsi(all) })];
  const exchanges = parseExchanges(stdout || all);
  if (view === 'headers') {
    if (exchanges.length === 0) return [emptyState('No HTTP headers in this output.')];
    return exchanges.map((ex) => exchangeNode(ex, false));
  }
  if (exchanges.length === 0) return [el('pre', { class: 'lb-hurl__body', text: stripAnsi(all) })];
  return exchanges.map((ex) => exchangeNode(ex, true));
}
