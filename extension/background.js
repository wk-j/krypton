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

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === 'laneList') {
        const lanes = await controlOp('lane.list', {});
        sendResponse({ ok: true, lanes });
      } else if (msg.type === 'send') {
        const result = await controlOp('lane.send', { lane: msg.lane, text: msg.text });
        sendResponse({ ok: true, result });
      } else {
        sendResponse({ ok: false, error: 'unknown message' });
      }
    } catch (e) {
      sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  })();
  return true; // keep the channel open for the async response
});
