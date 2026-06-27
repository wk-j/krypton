// Service worker / broker (doc 176). Holds the control-API credentials fetched
// from the native host and performs the privileged loopback calls on behalf of
// the popup. The frontend stays the authority; this only forwards lane.list and
// lane.send over the existing control API.

const NATIVE_HOST = 'com.krypton.bridge';
let creds = null; // { url, token }

async function handshake() {
  const reply = await chrome.runtime.sendNativeMessage(NATIVE_HOST, { cmd: 'credentials' });
  if (!reply || reply.error) {
    throw new Error(nativeErrorMessage(reply && reply.error));
  }
  creds = { url: reply.url, token: reply.token };
  return creds;
}

function nativeErrorMessage(code) {
  switch (code) {
    case 'descriptor_missing':
    case 'krypton_not_running':
      return 'Krypton is not running';
    case 'descriptor_unreadable':
      return 'Could not read Krypton control descriptor';
    default:
      return 'Krypton bridge unavailable (is the app running?)';
  }
}

// POST a typed control operation. Re-handshakes once on a 401 (token rotated
// across a Krypton restart), then retries.
async function controlOp(operation, params, retried = false) {
  if (!creds) await handshake();
  const res = await fetch(`${creds.url}/operations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${creds.token}`,
    },
    body: JSON.stringify({
      operationId: crypto.randomUUID(),
      operation,
      params,
    }),
  });
  if (res.status === 401 && !retried) {
    creds = null;
    return controlOp(operation, params, true);
  }
  const body = await res.json().catch(() => null);
  if (!res.ok || !body || body.error) {
    const message = body && body.error ? body.error.message : `HTTP ${res.status}`;
    throw new Error(message);
  }
  return body.result;
}

// True when the failure is the native bridge / Krypton itself being unavailable
// (vs. a normal control-op error like unknown_harness). The GitHub issue card
// renders an explicit "offline" state for these rather than an error toast.
function isOfflineError(message) {
  if (!message) return false;
  return (
    message.includes('Krypton is not running') ||
    message.includes('Krypton bridge unavailable') ||
    message.includes('Could not read Krypton control descriptor') ||
    message.includes('native messaging host') ||
    message.includes('Native host') ||
    message.includes('Specified native messaging host not found') ||
    message.includes('Failed to fetch') ||
    message.includes('Could not establish connection')
  );
}

// One-shot message handler used by the popup (and the issue content script for
// non-streaming requests). Each branch maps a message to a control op; offline
// failures are flagged so the issue card can show its offline state.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.type) {
        case 'laneList': {
          const lanes = await controlOp('lane.list', {});
          sendResponse({ ok: true, lanes });
          break;
        }
        case 'send': {
          const result = await controlOp('lane.send', { lane: msg.lane, text: msg.text });
          sendResponse({ ok: true, result });
          break;
        }
        case 'dispatchIssue': {
          const result = await controlOp('github.dispatch-issue', msg.params || {});
          sendResponse({ ok: true, result });
          break;
        }
        case 'issueStatus': {
          const result = await controlOp('github.issue-status', { issueKey: msg.issueKey });
          sendResponse({ ok: true, result });
          break;
        }
        case 'listIssues': {
          const result = await controlOp('github.list-issues', {});
          sendResponse({ ok: true, result });
          break;
        }
        case 'unlinkIssue': {
          const result = await controlOp('github.unlink-issue', { issueKey: msg.issueKey });
          sendResponse({ ok: true, result });
          break;
        }
        case 'cancelLane': {
          const result = await controlOp('lane.cancel', { lane: msg.lane });
          sendResponse({ ok: true, result });
          break;
        }
        default:
          sendResponse({ ok: false, error: 'unknown message' });
      }
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      sendResponse({ ok: false, error, offline: isOfflineError(error) });
    }
  })();
  return true; // keep the channel open for the async response
});

// ───────────────────────── GitHub issue live relay ──────────────────────────
//
// Each GitHub issue tab opens a long-lived Port (name "github-issue") and tells
// us which issueKey it is watching — plus, once it has resolved a binding, which
// { harnessId, lane } that issue is bound to. We keep ONE SSE connection to
// /control/v1/events while any such port is open and fan matching frames out to
// the right ports: an `issue_status` frame (carries the full snapshot) matches by
// issueKey; a lane-scoped `status` frame matches by the watched { harnessId, lane }
// so unrelated lane activity no longer wakes every issue tab. On gap/disconnect the
// port re-snapshots, so the card never depends on having caught an event.

/** @type {Map<chrome.runtime.Port, { issueKey: string|null, harnessId: string|null, lane: string|null }>} */
const issuePorts = new Map();
let sse = null; // EventSource-like state: { abort, generation }
let sseGeneration = 0;
let sseBackoff = 0;

function portMatchesFrame(meta, frame) {
  if (!meta || !frame) return false;
  const payload = frame.payload;
  // issue_status frames carry the snapshot; match on its binding.issueKey.
  if (frame.kind === 'issue_status' && payload && payload.binding) {
    return payload.binding.issueKey === meta.issueKey;
  }
  // status frames are lane-scoped (no issueKey), so route them only to the port
  // whose bound lane matches. A port whose issue is still unbound has no lane yet,
  // so no status frame applies to it (its bound state arrives via issue_status).
  if (frame.kind === 'status') {
    return Boolean(meta.lane) && frame.harnessId === meta.harnessId && frame.lane === meta.lane;
  }
  return false;
}

function relayFrame(frame) {
  if (!frame || typeof frame !== 'object') return;
  const kind = frame.kind;
  if (kind !== 'issue_status' && kind !== 'status' && kind !== 'gap') return;
  for (const [port, meta] of issuePorts) {
    if (kind === 'gap') {
      try {
        port.postMessage({ type: 'resnapshot', reason: 'gap' });
      } catch {
        /* port closed */
      }
      continue;
    }
    if (!portMatchesFrame(meta, frame)) continue;
    try {
      if (kind === 'issue_status') {
        port.postMessage({ type: 'issueStatus', snapshot: frame.payload });
      } else {
        port.postMessage({ type: 'resnapshot', reason: 'status' });
      }
    } catch {
      /* port closed; cleanup happens on disconnect */
    }
  }
}

// Stream /control/v1/events via fetch (service workers have no EventSource).
// Reconnects with linear backoff on error; re-handshakes once on a 401.
async function openSse(retriedAuth = false) {
  const generation = ++sseGeneration;
  let controller;
  try {
    if (!creds) await handshake();
    controller = new AbortController();
    sse = { abort: () => controller.abort(), generation };
    const res = await fetch(`${creds.url}/events`, {
      headers: { Authorization: `Bearer ${creds.token}`, Accept: 'text/event-stream' },
      signal: controller.signal,
    });
    if (res.status === 401 && !retriedAuth) {
      creds = null;
      if (generation === sseGeneration) return openSse(true);
      return;
    }
    if (!res.ok || !res.body) {
      throw new Error(`SSE HTTP ${res.status}`);
    }
    sseBackoff = 0;
    // Notify ports the stream is (re)established so they re-snapshot.
    relayFrame({ kind: 'gap' });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (generation !== sseGeneration) {
        try {
          await reader.cancel();
        } catch {
          /* already gone */
        }
        return;
      }
      buffer += decoder.decode(value, { stream: true });
      // SSE frames are separated by a blank line; data lines carry our JSON.
      let sep;
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const chunk = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        for (const line of chunk.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (!data) continue;
          try {
            relayFrame(JSON.parse(data));
          } catch {
            /* malformed frame — skip */
          }
        }
      }
    }
  } catch (e) {
    if (controller && e && e.name === 'AbortError') return;
    // fall through to reconnect
  }
  // Reconnect unless superseded or no ports remain.
  if (generation !== sseGeneration || issuePorts.size === 0) return;
  sseBackoff = Math.min(sseBackoff + 1000, 10000);
  const delay = sseBackoff;
  setTimeout(() => {
    if (generation === sseGeneration && issuePorts.size > 0) openSse();
  }, delay);
}

function ensureSse() {
  if (sse) return;
  openSse();
}

function closeSse() {
  sseGeneration += 1; // invalidate any in-flight stream/reconnect
  if (sse && sse.abort) {
    try {
      sse.abort();
    } catch {
      /* ignore */
    }
  }
  sse = null;
  sseBackoff = 0;
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'github-issue') return;
  issuePorts.set(port, { issueKey: null, harnessId: null, lane: null });
  ensureSse();
  port.onMessage.addListener((msg) => {
    if (msg && msg.type === 'watch') {
      issuePorts.set(port, {
        issueKey: msg.issueKey || null,
        harnessId: msg.harnessId || null,
        lane: msg.lane || null,
      });
    }
  });
  port.onDisconnect.addListener(() => {
    issuePorts.delete(port);
    if (issuePorts.size === 0) closeSse();
  });
});
