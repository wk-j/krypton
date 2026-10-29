// Spec 341 — where the shell gets its navigation context: the tokenless
// project directory, plus capability paths when this browser holds a session.

import { resolveProject } from '../../surfaces';
import type { Capabilities, Directory, NavContext, SessionState } from '../../surfaces';
import { fetchJson, HttpError } from './fetch-json';
import { clearSessionToken, readSessionToken } from './session';

/** The last project picked in the switcher; not sensitive (ids are path hashes). */
export const PROJECT_STORAGE_KEY = 'krypton.loopback.project';

export const EMPTY_CONTEXT: NavContext = {
  directory: { projects: [] },
  project: null,
  capabilities: null,
  session: 'none',
};

export function readRememberedProject(): string | null {
  try {
    return localStorage.getItem(PROJECT_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function rememberProject(projectId: string): void {
  try {
    localStorage.setItem(PROJECT_STORAGE_KEY, projectId);
  } catch {
    /* storage disabled: the URL still carries the project */
  }
}

async function loadCapabilities(): Promise<{ capabilities: Capabilities | null; session: SessionState }> {
  const token = readSessionToken();
  if (!token) return { capabilities: null, session: 'none' };
  try {
    return { capabilities: await fetchJson<Capabilities>(`/app/api/${token}/capabilities`), session: 'valid' };
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) {
      // Krypton restarted: the stored capability is gone for good.
      clearSessionToken();
      return { capabilities: null, session: 'expired' };
    }
    return { capabilities: null, session: 'none' };
  }
}

export async function loadNavContext(url: URL = new URL(location.href)): Promise<NavContext> {
  const [directory, caps] = await Promise.all([
    fetchJson<Directory>('/app/api/directory').catch((): Directory => ({ projects: [] })),
    loadCapabilities(),
  ]);
  return {
    directory,
    capabilities: caps.capabilities,
    session: caps.session,
    project: resolveProject(directory, caps.capabilities, url, readRememberedProject()),
  };
}
