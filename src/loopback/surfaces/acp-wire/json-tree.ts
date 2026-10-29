// Spec 288 — the readable payload view: a one-line digest of the fields that
// name what an ACP message is about, then a collapsible tree that skips the
// JSON-RPC envelope (already in the metadata list).

import { el } from '../../../ui/dom';
import type { ElChild } from '../../../ui/dom';

const DIGEST_KEYS = ['sessionUpdate', 'title', 'kind', 'status', 'stopReason', 'toolCallId'] as const;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export function digest(o: Json): HTMLElement | null {
  const got = new Map<string, string>();
  const walk = (x: Json, depth: number): void => {
    if (!x || typeof x !== 'object' || depth > 3) return;
    for (const [k, v] of Object.entries(x)) {
      if (!got.has(k) && typeof v === 'string' && (DIGEST_KEYS as readonly string[]).includes(k)) got.set(k, v);
      walk(v, depth + 1);
    }
  };
  walk(o, 0);
  const parts: HTMLElement[] = DIGEST_KEYS.filter((k) => got.has(k)).map((k) =>
    el('span', {}, el('span', { class: 'lb-muted', text: k }), ` ${got.get(k)}`),
  );
  const err = o && typeof o === 'object' && !Array.isArray(o) ? o.error : null;
  if (err && typeof err === 'object' && !Array.isArray(err)) {
    parts.unshift(
      el('span', { class: 'lb-acp-wire__red', text: `error ${String(err.code ?? '')}: ${String(err.message ?? '')}` }),
    );
  }
  return parts.length ? el('div', { class: 'lb-acp-wire__digest' }, ...parts) : null;
}

/** Root keys minus the envelope (jsonrpc/method/id). `clipLong`: fold long strings behind "show all". */
export function jsonTree(o: Json, clipLong: boolean): HTMLElement {
  const box = el('div', { class: 'lb-acp-wire__payload' });
  if (!o || typeof o !== 'object' || Array.isArray(o)) {
    box.append(node(null, o, 0, clipLong));
    return box;
  }
  const keys = Object.keys(o).filter((k) => k !== 'jsonrpc' && k !== 'method' && k !== 'id');
  if (!keys.length) box.append(el('span', { class: 'lb-muted', text: 'no params' }));
  for (const k of keys) box.append(node(k, o[k], 0, clipLong));
  return box;
}

function row(key: ElChild, value: ElChild): HTMLElement {
  return el('div', { class: 'lb-acp-wire__jv-row' }, key, value);
}

function node(label: string | null, v: Json, depth: number, clipLong: boolean): HTMLElement {
  const k = label == null ? null : el('span', { class: 'lb-acp-wire__jv-k', text: label });
  if (v === null) return row(k, el('span', { class: 'lb-acp-wire__jv-nul', text: 'null' }));
  if (typeof v === 'object') {
    const arr = Array.isArray(v);
    const entries: [string, Json][] = arr ? v.map((c, i) => [`[${i}]`, c]) : Object.entries(v);
    const n = entries.length;
    if (!n) return row(k, el('span', { class: 'lb-muted', text: arr ? '[ ]' : '{ }' }));
    const type = !arr && typeof (v as Record<string, Json>).type === 'string' ? (v as Record<string, Json>).type : null;
    const details = el(
      'details',
      { class: 'lb-acp-wire__jv-n', attrs: { open: !(depth > 0 && n > 40) } },
      el(
        'summary',
        {},
        k,
        type ? el('span', { class: 'lb-acp-wire__jv-t', text: ` ${String(type)}` }) : null,
        el('span', { class: 'lb-muted', text: ` ${n}${arr ? ' item' : ' key'}${n === 1 ? '' : 's'}` }),
      ),
      el('div', { class: 'lb-acp-wire__jv-c' }, ...entries.map(([c, x]) => node(c, x, depth + 1, clipLong))),
    );
    return details;
  }
  if (typeof v === 'string') {
    if (!v.includes('\n') && v.length <= 100) return row(k, el('span', { text: v }));
    const lines = v.split('\n').length;
    const long = clipLong && (lines > 14 || v.length > 1400);
    const text = el('div', { class: ['lb-acp-wire__jv-text', long && 'lb-acp-wire__jv-text--clip'], text: v });
    const more = long ? el('button', { class: 'lb-acp-wire__jv-more', attrs: { type: 'button' }, text: 'show all' }) : null;
    more?.addEventListener('click', () => {
      more.textContent = text.classList.toggle('lb-acp-wire__jv-text--clip') ? 'show all' : 'collapse';
    });
    return el(
      'div',
      { class: 'lb-acp-wire__jv-blk' },
      k,
      el('span', {
        class: 'lb-muted',
        text: `${lines} line${lines === 1 ? '' : 's'} · ${v.length.toLocaleString()} chars`,
      }),
      text,
      more,
    );
  }
  return row(k, el('span', { class: 'lb-acp-wire__jv-num', text: String(v) }));
}

export type { Json };
