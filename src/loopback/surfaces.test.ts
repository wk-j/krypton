import { describe, expect, it } from 'vitest';

import { availability, resolveProject, surfaceById } from './surfaces';
import type { Capabilities, Directory, NavContext, ProjectEntry } from './surfaces';

function project(projectId: string, harnessIds: string[]): ProjectEntry {
  return {
    projectId,
    name: projectId,
    dir: `/src/${projectId}`,
    harnessIds,
    lanes: { total: 0, busy: 0 },
    attention: 0,
    artifacts: { live: 0, pending: 0 },
  };
}

const alpha = project('project-a', ['hm-1']);
const beta = project('project-b', ['hm-2', 'hm-10']);
const directory: Directory = { projects: [alpha, beta] };
const caps: Capabilities = {
  termctrl: '/termctrl/t',
  acpWire: '/acp-wire/w',
  projects: [
    { projectId: 'project-a', hurl: '/hurl/ha', e2e: null },
    { projectId: 'project-b', hurl: '/hurl/hb', e2e: '/e2e/eb' },
  ],
};

const at = (path: string): URL => new URL(path, 'http://127.0.0.1:8765');

describe('resolveProject', () => {
  it('prefers the page parameter, then the capability path, then the last pick', () => {
    expect(resolveProject(directory, null, at('/analyses?project=project-b'), 'project-a')).toBe(beta);
    expect(resolveProject(directory, null, at('/docs?harness=hm-10'), 'project-a')).toBe(beta);
    expect(resolveProject(directory, caps, at('/e2e/eb'), 'project-a')).toBe(beta);
    expect(resolveProject(directory, null, at('/dashboard'), 'project-b')).toBe(beta);
    expect(resolveProject(directory, null, at('/dashboard'), 'gone')).toBe(alpha);
    expect(resolveProject({ projects: [] }, caps, at('/docs?harness=hm-1'), null)).toBeNull();
  });
});

describe('availability', () => {
  const ctx = (over: Partial<NavContext>): NavContext => ({
    directory,
    project: alpha,
    capabilities: caps,
    session: 'valid',
    ...over,
  });

  it('builds project links from the selected project', () => {
    expect(availability(surfaceById('docs'), ctx({ project: beta }))).toEqual({ href: '/docs?harness=hm-2' });
    expect(availability(surfaceById('analyses'), ctx({}))).toEqual({ href: '/analyses?project=project-a' });
    expect(availability(surfaceById('hurl'), ctx({ project: beta }))).toEqual({ href: '/hurl/hb' });
  });

  it('names why a surface cannot open', () => {
    expect(availability(surfaceById('docs'), ctx({ project: null })).href).toBeNull();
    expect(availability(surfaceById('termctrl'), ctx({ capabilities: null, session: 'none' }))).toEqual({
      href: null,
      reason: 'Open Krypton Home from Krypton (#home) to enable',
    });
    const expired = availability(surfaceById('termctrl'), ctx({ capabilities: null, session: 'expired' }));
    expect(expired.href === null && expired.reason).toMatch(/^Krypton restarted/);
    expect(availability(surfaceById('e2e'), ctx({}))).toEqual({ href: null, reason: 'Unavailable for this project' });
    expect(availability(surfaceById('dashboard'), ctx({ project: null, capabilities: null }))).toEqual({
      href: '/dashboard',
    });
  });
});
