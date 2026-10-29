// Spec 341 — the session capability the shell uses to link token-gated
// surfaces. localStorage, not a cookie: storage is scoped to this origin
// including the port; a cookie for 127.0.0.1 is sent to every local port
// (RFC 6265 §8.5). ADR 0026 records the same-origin trade-off.

export const SESSION_STORAGE_KEY = 'krypton.loopback.session';

export function readSessionToken(): string | null {
  try {
    const token = localStorage.getItem(SESSION_STORAGE_KEY);
    return token && /^[0-9a-f]{32}$/.test(token) ? token : null;
  } catch {
    return null;
  }
}

export function storeSessionToken(token: string): void {
  try {
    localStorage.setItem(SESSION_STORAGE_KEY, token);
  } catch {
    /* storage disabled: the shell stays limited */
  }
}

export function clearSessionToken(): void {
  try {
    localStorage.removeItem(SESSION_STORAGE_KEY);
  } catch {
    /* nothing stored */
  }
}

/** `/app/session/<token>` → token. */
export function sessionTokenFromPath(pathname: string): string | null {
  const match = /^\/app\/session\/([0-9a-f]{32})\/?$/.exec(pathname);
  return match ? match[1] : null;
}

/** Same rule as the server's `valid_next_path`: a path on this origin. */
export function isSameOriginPath(path: string): boolean {
  return (
    path.startsWith('/') &&
    !path.startsWith('//') &&
    !path.includes('\\') &&
    // eslint-disable-next-line no-control-regex
    !/[\u0000-\u001f\u007f]/.test(path)
  );
}
