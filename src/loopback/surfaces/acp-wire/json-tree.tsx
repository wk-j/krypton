// Spec 288 — the readable payload view: a one-line digest of the fields that
// name what an ACP message is about, then a collapsible tree that skips the
// JSON-RPC envelope (already in the metadata list).
// Spec 361: React components; `<details>` keep their own open state.

import { useState } from 'react';
import type { JSX, ReactNode } from 'react';

const DIGEST_KEYS = ['sessionUpdate', 'title', 'kind', 'status', 'stopReason', 'toolCallId'] as const;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export function Digest({ value: o }: { readonly value: Json }): JSX.Element | null {
  const got = new Map<string, string>();
  const walk = (x: Json, depth: number): void => {
    if (!x || typeof x !== 'object' || depth > 3) return;
    for (const [k, v] of Object.entries(x)) {
      if (!got.has(k) && typeof v === 'string' && (DIGEST_KEYS as readonly string[]).includes(k)) got.set(k, v);
      walk(v, depth + 1);
    }
  };
  walk(o, 0);
  const parts: JSX.Element[] = DIGEST_KEYS.filter((k) => got.has(k)).map((k) => (
    <span key={k}>
      <span className="lb-muted">{k}</span>
      {` ${got.get(k)}`}
    </span>
  ));
  const err = o && typeof o === 'object' && !Array.isArray(o) ? o.error : null;
  if (err && typeof err === 'object' && !Array.isArray(err)) {
    parts.unshift(
      <span key="error" className="lb-acp-wire__red">
        {`error ${String(err.code ?? '')}: ${String(err.message ?? '')}`}
      </span>,
    );
  }
  return parts.length ? <div className="lb-acp-wire__digest">{parts}</div> : null;
}

/** Root keys minus the envelope (jsonrpc/method/id). `clipLong`: fold long strings behind "show all". */
export function JsonTree({ value: o, clipLong }: { readonly value: Json; readonly clipLong: boolean }): JSX.Element {
  if (!o || typeof o !== 'object' || Array.isArray(o)) {
    return (
      <div className="lb-acp-wire__payload">
        <JsonNode label={null} value={o} depth={0} clipLong={clipLong} />
      </div>
    );
  }
  const keys = Object.keys(o).filter((k) => k !== 'jsonrpc' && k !== 'method' && k !== 'id');
  return (
    <div className="lb-acp-wire__payload">
      {keys.length ? null : <span className="lb-muted">no params</span>}
      {keys.map((k) => (
        <JsonNode key={k} label={k} value={o[k]} depth={0} clipLong={clipLong} />
      ))}
    </div>
  );
}

interface NodeProps {
  readonly label: string | null;
  readonly value: Json;
  readonly depth: number;
  readonly clipLong: boolean;
}

function Row({ k, children }: { readonly k: ReactNode; readonly children: ReactNode }): JSX.Element {
  return (
    <div className="lb-acp-wire__jv-row">
      {k}
      {children}
    </div>
  );
}

function JsonNode({ label, value: v, depth, clipLong }: NodeProps): JSX.Element {
  const k = label == null ? null : <span className="lb-acp-wire__jv-k">{label}</span>;
  if (v === null) {
    return (
      <Row k={k}>
        <span className="lb-acp-wire__jv-nul">null</span>
      </Row>
    );
  }
  if (typeof v === 'object') {
    const arr = Array.isArray(v);
    const entries: [string, Json][] = arr ? v.map((c, i) => [`[${i}]`, c]) : Object.entries(v);
    const n = entries.length;
    if (!n) {
      return (
        <Row k={k}>
          <span className="lb-muted">{arr ? '[ ]' : '{ }'}</span>
        </Row>
      );
    }
    const type = !Array.isArray(v) && typeof v.type === 'string' ? v.type : null;
    return (
      <details className="lb-acp-wire__jv-n" open={!(depth > 0 && n > 40)}>
        <summary>
          {k}
          {type ? <span className="lb-acp-wire__jv-t">{` ${type}`}</span> : null}
          <span className="lb-muted">{` ${n}${arr ? ' item' : ' key'}${n === 1 ? '' : 's'}`}</span>
        </summary>
        <div className="lb-acp-wire__jv-c">
          {entries.map(([c, x]) => (
            <JsonNode key={c} label={c} value={x} depth={depth + 1} clipLong={clipLong} />
          ))}
        </div>
      </details>
    );
  }
  if (typeof v === 'string') {
    if (!v.includes('\n') && v.length <= 100) {
      return (
        <Row k={k}>
          <span>{v}</span>
        </Row>
      );
    }
    return <TextBlock k={k} text={v} clipLong={clipLong} />;
  }
  return (
    <Row k={k}>
      <span className="lb-acp-wire__jv-num">{String(v)}</span>
    </Row>
  );
}

/** A multi-line or long string; long ones start clipped behind "show all". */
function TextBlock({ k, text, clipLong }: { readonly k: ReactNode; readonly text: string; readonly clipLong: boolean }): JSX.Element {
  const lines = text.split('\n').length;
  const long = clipLong && (lines > 14 || text.length > 1400);
  const [clipped, setClipped] = useState(long);
  return (
    <div className="lb-acp-wire__jv-blk">
      {k}
      <span className="lb-muted">{`${lines} line${lines === 1 ? '' : 's'} · ${text.length.toLocaleString()} chars`}</span>
      <div className={clipped ? 'lb-acp-wire__jv-text lb-acp-wire__jv-text--clip' : 'lb-acp-wire__jv-text'}>{text}</div>
      {long ? (
        <button className="lb-acp-wire__jv-more" type="button" onClick={(): void => setClipped((c) => !c)}>
          {clipped ? 'show all' : 'collapse'}
        </button>
      ) : null}
    </div>
  );
}

export type { Json };
