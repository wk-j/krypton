// Spec 341 — the loopback surfaces, in one table. Home's tiles, the switcher
// and the shell title all read from here, so a new surface is one entry.

export type SurfaceId =
  | 'home'
  | 'dashboard'
  | 'gallery'
  | 'docs'
  | 'journal'
  | 'timeline'
  | 'analyses'
  | 'reviews'
  | 'commands'
  | 'tools'
  | 'genui'
  | 'termctrl'
  | 'acp-wire'
  | 'hurl'
  | 'e2e';

export type SurfaceGroup = 'monitor' | 'project' | 'reference';

/** One row of `GET /app/api/directory`. */
export interface ProjectEntry {
  readonly projectId: string;
  readonly name: string;
  readonly dir: string;
  /** Live harness ids on this project, numeric order. */
  readonly harnessIds: readonly string[];
  readonly lanes: { readonly total: number; readonly busy: number };
  readonly attention: number;
  readonly artifacts: { readonly live: number; readonly pending: number };
}

export interface Directory {
  readonly projects: readonly ProjectEntry[];
}

export interface ProjectCapabilities {
  readonly projectId: string;
  readonly hurl: string | null;
  readonly e2e: string | null;
}

/** `GET /app/api/<session>/capabilities`. Paths on this origin. */
export interface Capabilities {
  readonly termctrl: string;
  readonly acpWire: string;
  readonly projects: readonly ProjectCapabilities[];
}

/** `none`: no stored session; `expired`: the stored one was refused (Krypton restarted). */
export type SessionState = 'none' | 'valid' | 'expired';

export interface NavContext {
  readonly directory: Directory;
  readonly project: ProjectEntry | null;
  readonly capabilities: Capabilities | null;
  readonly session: SessionState;
}

export interface SurfaceDef {
  readonly id: SurfaceId;
  /** Sentence case, as the shell title and the Home tile show it. */
  readonly title: string;
  readonly summary: string;
  readonly group: SurfaceGroup;
  readonly scope: 'global' | 'project';
  readonly access: 'open' | 'capability';
  /** The URL for this context, or `null` when unavailable (see `availability`). */
  href(ctx: NavContext): string | null;
}

export type Availability = { readonly href: string } | { readonly href: null; readonly reason: string };

export const GROUP_TITLES: Readonly<Record<SurfaceGroup, string>> = {
  monitor: 'Monitor',
  project: 'Project',
  reference: 'Reference',
};

const NO_PROJECT = 'No open project — open a harness in Krypton';
const NO_SESSION = 'Open Krypton Home from Krypton (#home) to enable';

function harnessHref(path: string): (ctx: NavContext) => string | null {
  return (ctx) => {
    const harness = ctx.project?.harnessIds[0];
    return harness ? `${path}?harness=${encodeURIComponent(harness)}` : null;
  };
}

function projectCapability(ctx: NavContext, pick: (p: ProjectCapabilities) => string | null): string | null {
  const projectId = ctx.project?.projectId;
  if (!projectId || !ctx.capabilities) return null;
  const row = ctx.capabilities.projects.find((p) => p.projectId === projectId);
  return row ? pick(row) : null;
}

export const SURFACES: readonly SurfaceDef[] = [
  {
    id: 'home',
    title: 'Home',
    summary: 'Every loopback surface, by group',
    group: 'monitor',
    scope: 'global',
    access: 'open',
    href: () => '/',
  },
  {
    id: 'dashboard',
    title: 'Lane monitor',
    summary: 'Live lane status, attention flags and resources across harnesses',
    group: 'monitor',
    scope: 'global',
    access: 'open',
    href: () => '/dashboard',
  },
  {
    id: 'termctrl',
    title: 'Terminal Control',
    summary: 'Read-only screens and logs of named terminal sessions',
    group: 'monitor',
    scope: 'global',
    access: 'capability',
    href: (ctx) => ctx.capabilities?.termctrl ?? null,
  },
  {
    id: 'acp-wire',
    title: 'ACP wire',
    summary: 'ACP traffic profiler: messages, latency and payloads',
    group: 'monitor',
    scope: 'global',
    access: 'capability',
    href: (ctx) => ctx.capabilities?.acpWire ?? null,
  },
  {
    id: 'docs',
    title: 'Docs',
    summary: "The project's markdown, rendered",
    group: 'project',
    scope: 'project',
    access: 'open',
    href: harnessHref('/docs'),
  },
  {
    id: 'journal',
    title: 'Journal',
    summary: 'Daily notes under .krypton/journal',
    group: 'project',
    scope: 'project',
    access: 'open',
    href: harnessHref('/journal'),
  },
  {
    id: 'timeline',
    title: 'Timeline',
    summary: 'Requirements, decisions and outcomes over time',
    group: 'project',
    scope: 'project',
    access: 'open',
    href: harnessHref('/timeline'),
  },
  {
    id: 'analyses',
    title: 'Analyses',
    summary: 'Issue analysis bundles',
    group: 'project',
    scope: 'project',
    access: 'open',
    href: (ctx) => (ctx.project ? `/analyses?project=${encodeURIComponent(ctx.project.projectId)}` : null),
  },
  {
    id: 'reviews',
    title: 'Reviews',
    summary: 'Review Board archive',
    group: 'project',
    scope: 'project',
    access: 'open',
    href: harnessHref('/reviews'),
  },
  {
    id: 'gallery',
    title: 'Artifacts',
    summary: 'HTML artifacts lanes registered, by project',
    group: 'project',
    scope: 'global',
    access: 'open',
    href: () => '/gallery',
  },
  {
    id: 'hurl',
    title: 'Hurl',
    summary: "Run the project's .hurl files",
    group: 'project',
    scope: 'project',
    access: 'capability',
    href: (ctx) => projectCapability(ctx, (p) => p.hurl),
  },
  {
    id: 'e2e',
    title: 'E2E',
    summary: 'E2E cases, runs, checks and evidence',
    group: 'project',
    scope: 'project',
    access: 'capability',
    href: (ctx) => projectCapability(ctx, (p) => p.e2e),
  },
  {
    id: 'commands',
    title: 'Commands',
    summary: 'Built-in # commands and their prompts',
    group: 'reference',
    scope: 'global',
    access: 'open',
    href: () => '/commands',
  },
  {
    id: 'tools',
    title: 'MCP tools',
    summary: 'The harness MCP tool contracts',
    group: 'reference',
    scope: 'global',
    access: 'open',
    href: () => '/tools',
  },
  {
    id: 'genui',
    title: 'GenUI components',
    summary: 'Every GenUI component, live, with its source',
    group: 'reference',
    scope: 'global',
    access: 'open',
    href: () => '/genui-gallery',
  },
];

export function surfaceById(id: SurfaceId): SurfaceDef {
  const def = SURFACES.find((s) => s.id === id);
  if (!def) throw new Error(`unknown surface ${id}`);
  return def;
}

export function availability(def: SurfaceDef, ctx: NavContext): Availability {
  const href = def.href(ctx);
  if (href) return { href };
  if (def.scope === 'project' && !ctx.project) return { href: null, reason: NO_PROJECT };
  if (def.access === 'capability' && !ctx.capabilities) {
    return {
      href: null,
      reason: ctx.session === 'expired' ? 'Krypton restarted — reopen Home from Krypton (#home) to enable' : NO_SESSION,
    };
  }
  return { href: null, reason: 'Unavailable for this project' };
}

/**
 * Which project a page is about: its own `project=` / `harness=` parameter, the
 * capability path it was opened on (Hurl/E2E), the last pick, else the first.
 */
export function resolveProject(
  directory: Directory,
  capabilities: Capabilities | null,
  url: URL,
  remembered: string | null,
): ProjectEntry | null {
  const projects = directory.projects;
  if (projects.length === 0) return null;
  const projectParam = url.searchParams.get('project');
  if (projectParam) {
    const hit = projects.find((p) => p.projectId === projectParam);
    if (hit) return hit;
  }
  const harnessParam = url.searchParams.get('harness');
  if (harnessParam) {
    const hit = projects.find((p) => p.harnessIds.includes(harnessParam));
    if (hit) return hit;
  }
  if (capabilities) {
    const row = capabilities.projects.find(
      (p) => (p.hurl && url.pathname.startsWith(p.hurl)) || (p.e2e && url.pathname.startsWith(p.e2e)),
    );
    const hit = row && projects.find((p) => p.projectId === row.projectId);
    if (hit) return hit;
  }
  return projects.find((p) => p.projectId === remembered) ?? projects[0];
}
