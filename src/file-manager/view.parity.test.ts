// @vitest-environment happy-dom
//
// Spec 317 phase 0 — characterisation test. Written against the original
// `src/file-manager.ts` class (the `'../file-manager'` import resolved to that
// file while it existed) and kept unchanged after the move: the same import now
// resolves to `src/file-manager/index.ts`. The snapshots in
// `__snapshots__/view.parity.test.ts.snap` were recorded from the OLD class, so
// a green run here is the before/after parity proof.
//
// Class tokens are sorted before comparison: the old `patchCursor()` appended
// `--cursor` with `classList.add`, so its class *order* depended on patch
// history. Order has no visual effect; the set of classes is what is pinned.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fx = vi.hoisted(() => {
  const ROOT = '/home/u/proj';
  interface Spec { dir?: boolean; content?: string; size?: number; modified: number; link?: string; unreadable?: boolean }
  const TREE: Record<string, Spec> = {
    'src': { dir: true, modified: 100 },
    'src/main.ts': { content: 'export const x = 1;\n', modified: 110 },
    'src/util.ts': { content: 'export function f() { return 2; }\n', modified: 120 },
    '.env': { content: 'A=1\n', modified: 130 },
    '.hidden': { dir: true, modified: 135 },
    'SKILL.md': { content: '---\nname: s\ndescription: d\n---\n# Skill body\n', modified: 140 },
    'agent.md': {
      content: '---\nname: agent\ndescription: >\n  folded\n  text\nallowed-tools: Bash(git log:*) Read\nmodel: opus\n---\nBody **bold**\n',
      modified: 150,
    },
    'notes.md': { content: '---\ntitle: Notes\ntags: a, b\n---\nSome ![img](x.png) <text>\n', modified: 160 },
    'README.md': { content: '# Hello\n\n- item\n', modified: 170 },
    'index.ts': { content: 'const a: number = 1;\n', modified: 180 },
    'Makefile': { content: 'all:\n\techo hi\n', modified: 190 },
    'plain.txt': { content: 'just some words here\n', modified: 195 },
    'logo.png': { size: 2048, modified: 200 },
    'big.log': { size: 70000, modified: 210 },
    'huge.csv': { size: 2 * 1024 * 1024, modified: 0 },
    'medium.json': { size: 40 * 1024, modified: 220 },
    'link': { link: 'src/main.ts', content: 'linked\n', modified: 230 },
    'locked.ts': { size: 10, modified: 240, unreadable: true },
  };
  const log: Array<[string, unknown]> = [];
  const extra = new Set<string>();
  const entryFor = (rel: string) => {
    const s = TREE[rel];
    const name = rel.split('/').pop()!;
    return {
      name,
      path: `${ROOT}/${rel}`,
      is_dir: !!s.dir,
      is_symlink: !!s.link,
      size: s.dir ? 0 : (s.size ?? s.content?.length ?? 0),
      modified: s.modified,
      permissions: s.dir ? 'rwxr-xr-x' : 'rw-r--r--',
      symlink_target: s.link ? `${ROOT}/${s.link}` : null,
    };
  };
  const invoke = async (cmd: string, args: Record<string, unknown> = {}): Promise<unknown> => {
    log.push([cmd, JSON.parse(JSON.stringify(args))]);
    switch (cmd) {
      case 'get_env_var':
        return '/home/u';
      case 'list_directory': {
        const path = args.path as string;
        if (path !== ROOT && !path.startsWith(`${ROOT}/`)) throw new Error(`no such dir ${path}`);
        const relDir = path === ROOT ? '' : path.slice(ROOT.length + 1);
        if (relDir && !TREE[relDir]?.dir) throw new Error(`not a dir ${path}`);
        return Object.keys(TREE)
          .filter((rel) => {
            const parent = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
            if (parent !== relDir) return false;
            const name = rel.split('/').pop()!;
            return args.showHidden || !name.startsWith('.');
          })
          .map(entryFor);
      }
      case 'read_file': {
        const rel = (args.path as string).slice(ROOT.length + 1);
        const s = TREE[rel];
        if (!s || s.dir || s.unreadable || s.content === undefined) throw new Error('read failed');
        return s.content;
      }
      case 'write_file':
        extra.add(args.path as string);
        return null;
      case 'run_command':
        return '';
      case 'search_files':
        return Object.keys(TREE).filter((rel) => {
          if (TREE[rel].dir) return false;
          return args.showHidden || !rel.split('/').some((seg) => seg.startsWith('.'));
        });
      default:
        throw new Error(`unexpected command ${cmd}`);
    }
  };
  const ai = { instances: [] as Array<{ opts: Record<string, unknown>; host: HTMLElement | null; keys: string[]; closed: number }> };
  return { ROOT, TREE, log, invoke, ai };
});

vi.mock('@tauri-apps/api/core', () => ({ invoke: (cmd: string, args?: Record<string, unknown>) => fx.invoke(cmd, args) }));

vi.mock('../file-manager-ai', () => ({
  FileManagerAI: class {
    opts: Record<string, unknown>;
    host: HTMLElement | null = null;
    keys: string[] = [];
    closed = 0;
    constructor(opts: Record<string, unknown>) {
      this.opts = opts;
      fx.ai.instances.push(this);
    }
    open(host: HTMLElement): void { this.host = host; }
    close(): void { this.closed++; }
    onKeyDown(e: KeyboardEvent): boolean { this.keys.push(e.key); return true; }
  },
}));

import { FileManagerView } from '../file-manager';

// ─── harness ─────────────────────────────────────────────────────────

let rafQueue: Array<FrameRequestCallback | null> = [];
let container: HTMLElement;
const clipboardWrites: string[] = [];

const settle = async (): Promise<void> => {
  for (let i = 0; i < 60; i++) await Promise.resolve();
};

const flushRaf = (): void => {
  const q = rafQueue;
  rafQueue = [];
  for (const cb of q) cb?.(0);
};

const press = (view: FileManagerView, key: string, mods: { ctrl?: boolean; shift?: boolean } = {}): boolean =>
  view.onKeyDown(new KeyboardEvent('keydown', { key, ctrlKey: !!mods.ctrl, shiftKey: !!mods.shift }));

const norm = (root: Element): string => {
  const clone = root.cloneNode(true) as Element;
  for (const n of [clone, ...Array.from(clone.querySelectorAll('*'))]) {
    const c = n.getAttribute('class');
    if (c !== null) n.setAttribute('class', c.split(/\s+/).filter(Boolean).sort().join(' '));
  }
  return clone.outerHTML;
};

const q = (view: FileManagerView, sel: string): HTMLElement | null => view.element.querySelector(sel);
const statusText = (view: FileManagerView): string => q(view, '.krypton-file-manager__status')!.textContent ?? '';
const statusClass = (view: FileManagerView): string => q(view, '.krypton-file-manager__status')!.className;
const cursorName = (view: FileManagerView): string =>
  q(view, '.krypton-file-manager__item--cursor .krypton-file-manager__name')?.textContent ?? '';
// Smooth scrolling: rows live in `__list > __rows` and the window is overscanned.
const rowNames = (view: FileManagerView): string[] =>
  Array.from(view.element.querySelectorAll('.krypton-file-manager__list > .krypton-file-manager__rows > .krypton-file-manager__item'))
    .map((r) => r.querySelector('.krypton-file-manager__name')!.textContent ?? '');

const takeLog = (): Array<[string, unknown]> => fx.log.splice(0, fx.log.length);

const snap = (view: FileManagerView) => ({ dom: norm(view.element), log: takeLog() });

const open = async (): Promise<FileManagerView> => {
  const view = new FileManagerView(fx.ROOT, container);
  await settle();
  return view;
};

const cursorTo = (view: FileManagerView, name: string): void => {
  for (let i = 0; i < 40 && cursorName(view) !== name; i++) press(view, 'j');
  expect(cursorName(view)).toBe(name);
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  rafQueue = [];
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { rafQueue.push(cb); return rafQueue.length; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { rafQueue[id - 1] = null; });
  vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: (p: string) => (p === '--krypton-terminal-cell-height' ? '20px' : '') }));
  clipboardWrites.length = 0;
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: async (t: string) => { clipboardWrites.push(t); } },
  });
  fx.ai.instances.length = 0;
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  takeLog();
});

// ─── scenarios ───────────────────────────────────────────────────────

describe('FileManagerView parity (spec 317)', () => {
  it('ContentView surface', async () => {
    const view = await open();
    expect(view.type).toBe('file_manager');
    expect(view.element.parentElement).toBe(container);
    expect(view.getWorkingDirectory()).toBe(fx.ROOT);
    expect(typeof view.onResize).toBe('function');
    expect(typeof view.onClose).toBe('function');
    expect(typeof view.onOpenDiff).toBe('function');
    const v = view as unknown as Record<string, unknown>;
    expect(v.handlePaste).toBeUndefined();
    expect(v.onShow).toBeUndefined();
    expect(v.focusView).toBeUndefined();
    view.dispose();
  });

  it('initial render', async () => {
    const view = await open();
    expect(snap(view)).toMatchSnapshot();
    view.dispose();
  });

  it('j / k move and wrap', async () => {
    const view = await open();
    takeLog();
    const states: string[] = [];
    press(view, 'j'); states.push(norm(view.element));
    press(view, 'ArrowDown'); states.push(norm(view.element));
    press(view, 'k'); press(view, 'ArrowUp'); press(view, 'k'); // wraps to last
    states.push(norm(view.element));
    // quirk P1: the status bar is not re-rendered by cursor moves
    expect(statusText(view)).toContain('rwxr-xr-x');
    expect(states).toMatchSnapshot();
    expect(takeLog()).toEqual([]); // quirk P2: no preview load on cursor move
    vi.advanceTimersByTime(200);
    expect(takeLog()).toEqual([]);
    view.dispose();
  });

  it('virtual window, G, gg, ctrl+d, ctrl+u', async () => {
    const view = await open();
    view.onResize(800, 100); // 5 rows of 20px
    const states: string[] = [];
    states.push(norm(view.element));
    // Smooth scrolling: let any list glide land before each snapshot.
    const land = (): void => { for (let i = 0; i < 200 && rafQueue.some(Boolean); i++) flushRaf(); };
    for (let i = 0; i < 7; i++) press(view, 'j');
    land(); states.push(norm(view.element));
    press(view, 'G'); land(); states.push(norm(view.element));
    press(view, 'g'); press(view, 'g'); land(); states.push(norm(view.element));
    expect(press(view, 'd', { ctrl: true })).toBe(true); land(); states.push(norm(view.element));
    expect(press(view, 'u', { ctrl: true })).toBe(true); land(); states.push(norm(view.element));
    expect(press(view, 'd')).toBe(false);
    expect(press(view, 'u')).toBe(false);
    expect(states).toMatchSnapshot();
    view.dispose();
  });

  it('gg chord: 500 ms window, unbound key resets, bound key does not (P3)', async () => {
    const view = await open();
    press(view, 'j'); press(view, 'j');
    press(view, 'g'); vi.advanceTimersByTime(600); press(view, 'g');
    expect(cursorName(view)).not.toBe('src/'); // too slow
    press(view, 'g'); // armed again by the previous g → this one jumps
    expect(cursorName(view)).toBe('src/');
    press(view, 'j');
    press(view, 'g'); press(view, 'Z'); press(view, 'g');
    expect(cursorName(view)).not.toBe('src/'); // unbound key cleared the chord
    press(view, 'g'); press(view, 'd'); press(view, 'g'); // quirk P3
    expect(cursorName(view)).toBe('src/');
    view.dispose();
  });

  it('Space marks (D1) and v toggles all', async () => {
    const view = await open();
    press(view, ' ');
    const first = view.element.querySelectorAll('.krypton-file-manager__rows > .krypton-file-manager__item')[0];
    expect(first.querySelector('.krypton-file-manager__mark')!.textContent).toBe('\u25cf ');
    // D1 (approved deviation): the marked class is applied immediately, so the dot is visible.
    expect(first.classList.contains("krypton-file-manager__item--marked")).toBe(true);
    press(view, 'Escape');
    const states: string[] = [norm(view.element)];
    press(view, 'v'); states.push(norm(view.element));
    press(view, 'v'); states.push(norm(view.element));
    expect(states).toMatchSnapshot();
    view.dispose();
  });

  it('/ filter: type, Enter keeps, Escape clears', async () => {
    const view = await open();
    const states: string[] = [];
    press(view, '/'); states.push(norm(view.element));
    press(view, 'm'); press(view, 'd'); states.push(norm(view.element));
    press(view, 'Backspace'); press(view, 'd'); press(view, 'Enter'); states.push(norm(view.element));
    press(view, '/'); press(view, 'z'); press(view, 'q'); states.push(norm(view.element));
    press(view, 'Escape'); states.push(norm(view.element));
    expect(states).toMatchSnapshot();
    view.dispose();
  });

  it('sort: s cycles, shift+s reverses, S is unbound (P4)', async () => {
    const view = await open();
    const states: string[] = [];
    press(view, 's'); states.push(norm(view.element));
    press(view, 's'); states.push(norm(view.element));
    press(view, 's', { shift: true }); states.push(norm(view.element));
    expect(press(view, 'S', { shift: true })).toBe(false);
    states.push(norm(view.element));
    expect(states).toMatchSnapshot();
    view.dispose();
  });

  it('. toggles hidden files', async () => {
    const view = await open();
    takeLog();
    press(view, '.');
    await settle();
    expect(snap(view)).toMatchSnapshot();
    view.dispose();
  });

  it('f search: type, ctrl+j, Enter selects in its directory', async () => {
    const view = await open();
    takeLog();
    press(view, 'f');
    const states: string[] = [norm(view.element)];
    await settle();
    states.push(norm(view.element));
    press(view, 'm'); press(view, 't');
    states.push(norm(view.element)); // breadcrumb updated synchronously
    flushRaf();
    states.push(norm(view.element));
    press(view, 'j', { ctrl: true });
    states.push(norm(view.element));
    vi.advanceTimersByTime(80);
    await settle();
    states.push(norm(view.element));
    press(view, 'Enter');
    await settle();
    vi.advanceTimersByTime(80);
    await settle();
    states.push(norm(view.element));
    expect({ states, log: takeLog() }).toMatchSnapshot();
    view.dispose();
  });

  it('search Escape tears down; a pending rAF does nothing afterwards', async () => {
    const view = await open();
    press(view, 'f');
    await settle();
    press(view, 'x');
    press(view, 'Escape');
    flushRaf();
    vi.advanceTimersByTime(200);
    await settle();
    expect(snap(view)).toMatchSnapshot();
    view.dispose();
  });

  it('o previews each kind', async () => {
    const out: Record<string, string> = {};
    for (const name of ['src/', 'SKILL.md', 'agent.md', 'notes.md', 'README.md', 'index.ts', 'Makefile', 'plain.txt',
      'logo.png', 'big.log', 'huge.csv', 'locked.ts']) {
      const view = await open();
      takeLog();
      cursorTo(view, name);
      press(view, 'o');
      vi.advanceTimersByTime(80);
      await settle();
      out[name] = norm(q(view, '.krypton-file-manager__preview')!) + '\n' + JSON.stringify(takeLog());
      view.dispose();
    }
    expect(out).toMatchSnapshot();
  });

  it('l on a file previews; a second request for the same path is skipped', async () => {
    const view = await open();
    cursorTo(view, 'index.ts');
    takeLog();
    press(view, 'l');
    vi.advanceTimersByTime(80);
    await settle();
    press(view, 'o');
    vi.advanceTimersByTime(80);
    await settle();
    expect(takeLog()).toEqual([['read_file', { path: `${fx.ROOT}/index.ts` }]]);
    view.dispose();
  });

  it('w toggles the preview; H / L set flex', async () => {
    const view = await open();
    const states: string[] = [];
    press(view, 'w'); states.push(norm(view.element));
    press(view, 'w'); states.push(norm(view.element));
    press(view, 'H'); states.push(norm(view.element));
    press(view, 'L'); press(view, 'L'); states.push(norm(view.element));
    expect(states).toMatchSnapshot();
    view.dispose();
  });

  it('A / M / r prompts', async () => {
    const view = await open();
    takeLog();
    const states: string[] = [];
    press(view, 'A'); press(view, 'n'); press(view, 'x'); press(view, 'Backspace'); press(view, 'e');
    states.push(norm(view.element));
    press(view, 'Enter'); await settle(); states.push(norm(view.element));
    press(view, 'M'); press(view, 'd'); press(view, 'Enter'); await settle();
    cursorTo(view, 'index.ts');
    press(view, 'r'); states.push(norm(view.element));
    press(view, 'Backspace'); press(view, 'Backspace'); press(view, 'j'); press(view, 's'); press(view, 'Enter');
    await settle(); states.push(norm(view.element));
    press(view, 'A'); press(view, 'Escape'); states.push(norm(view.element));
    expect({ states, log: takeLog() }).toMatchSnapshot();
    view.dispose();
  });

  it('D → y deletes, D → n cancels, confirm swallows any key (P11)', async () => {
    const view = await open();
    takeLog();
    const states: string[] = [];
    cursorTo(view, 'index.ts');
    press(view, 'D'); states.push(norm(view.element));
    expect(press(view, 'n')).toBe(true); states.push(norm(view.element));
    // D1: the snapshot for this state was re-recorded after the move — the only
    // change is `--marked` on the two rows Space just marked (the dot is visible).
    press(view, ' '); press(view, ' ');
    press(view, 'D'); states.push(norm(view.element));
    press(view, 'y'); await settle(); states.push(norm(view.element));
    press(view, 'D'); press(view, 'j'); states.push(norm(view.element));
    expect({ states, log: takeLog() }).toMatchSnapshot();
    view.dispose();
  });

  it('y / x / p (copy in same dir gets a unique name)', async () => {
    const view = await open();
    takeLog();
    const states: string[] = [];
    press(view, 'p'); states.push(norm(view.element));
    cursorTo(view, 'index.ts');
    press(view, 'y'); states.push(norm(view.element));
    press(view, 'p'); await settle(); states.push(norm(view.element));
    cursorTo(view, 'plain.txt');
    press(view, 'x'); states.push(norm(view.element));
    vi.advanceTimersByTime(2000); states.push(norm(view.element));
    press(view, 'p'); await settle(); states.push(norm(view.element));
    expect({ states, log: takeLog() }).toMatchSnapshot();
    view.dispose();
  });

  it('Y copies the path without touching the status class (P7)', async () => {
    const view = await open();
    press(view, 'p'); // error tone: "Nothing in clipboard"
    expect(statusClass(view)).toContain('--error');
    cursorTo(view, 'index.ts');
    press(view, 'Y');
    await settle();
    expect(clipboardWrites).toEqual([`${fx.ROOT}/index.ts`]);
    expect(statusText(view)).toBe(`Copied: ${fx.ROOT}/index.ts`);
    expect(statusClass(view)).toBe('krypton-file-manager__status krypton-file-manager__status--error');
    vi.advanceTimersByTime(2000);
    expect(statusClass(view)).toBe('krypton-file-manager__status');
    view.dispose();
  });

  it('t / T track and diff', async () => {
    const view = await open();
    const diffs: Array<[string, string]> = [];
    view.onOpenDiff((d, t) => diffs.push([d, t]));
    takeLog();
    const states: string[] = [];
    press(view, 'T'); await settle(); await vi.dynamicImportSettled(); states.push(norm(view.element));
    cursorTo(view, 'src/');
    press(view, 't'); await settle(); states.push(norm(view.element));
    cursorTo(view, 'index.ts');
    press(view, 't'); await settle(); states.push(norm(view.element));
    vi.advanceTimersByTime(2000); states.push(norm(view.element));
    press(view, 'T'); await settle(); await vi.dynamicImportSettled(); await settle();
    expect({ states, diffs, log: takeLog() }).toMatchSnapshot();
    view.dispose();
  });

  it('i opens the AI overlay and delegates every key', async () => {
    const view = await open();
    press(view, 'i');
    await vi.dynamicImportSettled();
    await settle();
    expect(fx.ai.instances).toHaveLength(1);
    const ai = fx.ai.instances[0];
    expect(ai.host).toBe(view.element);
    expect(ai.opts.cwd).toBe(fx.ROOT);
    expect(Object.keys(ai.opts).sort()).toEqual(['cwd', 'getContext', 'onClose', 'onDone']);
    press(view, ' ');
    expect((ai.opts.getContext as () => unknown)()).toMatchSnapshot();
    press(view, 'q'); press(view, 'j'); press(view, 'Escape');
    expect(ai.keys).toEqual([' ', 'q', 'j', 'Escape']);
    takeLog();
    (ai.opts.onDone as () => void)();
    await settle();
    expect(takeLog()).toEqual([['list_directory', { path: fx.ROOT, showHidden: false }]]);
    (ai.opts.onClose as () => void)();
    expect(ai.closed).toBe(1);
    press(view, 'j');
    expect(ai.keys).toHaveLength(4);
    view.dispose();
  });

  it('q closes', async () => {
    const view = await open();
    const onClose = vi.fn();
    view.onClose(onClose);
    expect(press(view, 'q')).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
    view.dispose();
  });

  it('l / h / - / ~ navigation', async () => {
    const view = await open();
    takeLog();
    const states: string[] = [];
    press(view, 'l'); await settle(); states.push(norm(view.element));
    expect(view.getWorkingDirectory()).toBe(`${fx.ROOT}/src`);
    press(view, 'h'); await settle(); states.push(norm(view.element));
    press(view, '-'); await settle(); states.push(norm(view.element));
    press(view, '~'); await settle(); states.push(norm(view.element));
    press(view, 'h'); await settle(); states.push(norm(view.element)); // parent is outside initialCwd: guarded
    press(view, 'Backspace'); await settle();
    expect(view.getWorkingDirectory()).toBe(`${fx.ROOT}/src`.replace('/src', ''));
    expect({ states, log: takeLog() }).toMatchSnapshot();
    view.dispose();
  });

  it('onResize derives rows from --krypton-terminal-cell-height', async () => {
    const view = await open();
    // visibleRows + LIST_OVERSCAN (3) below; cursor is at the top so nothing above
    view.onResize(800, 140);
    expect(rowNames(view)).toHaveLength(7 + 3);
    view.onResize(800, 10);
    expect(rowNames(view)).toHaveLength(1 + 3);
    view.dispose();
  });

  it('dispose leaves no pending timer', async () => {
    const view = await open();
    cursorTo(view, 'index.ts');
    press(view, 'o');
    press(view, 'p'); // error → 3000 ms reset
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    view.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
});
