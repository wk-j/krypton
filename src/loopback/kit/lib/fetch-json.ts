// Spec 341 — the one fetch wrapper. Loopback data is live state: never cached.

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    url: string,
  ) {
    super(`${url} → HTTP ${status}${body ? `: ${body.slice(0, 200)}` : ''}`);
    this.name = 'HttpError';
  }
}

async function request(url: string, init: RequestInit): Promise<Response> {
  const response = await fetch(url, { cache: 'no-store', ...init });
  if (!response.ok) {
    let body = '';
    try {
      body = await response.text();
    } catch {
      /* the status is the error */
    }
    throw new HttpError(response.status, body, url);
  }
  return response;
}

export async function fetchJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await request(url, init);
  return (await response.json()) as T;
}

export async function fetchText(url: string, init: RequestInit = {}): Promise<string> {
  const response = await request(url, init);
  return response.text();
}

export async function postJson<T>(url: string, body: unknown, init: RequestInit = {}): Promise<T> {
  const response = await request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    ...init,
  });
  const text = await response.text();
  return (text ? JSON.parse(text) : null) as T;
}
