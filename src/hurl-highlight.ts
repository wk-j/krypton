// Minimal Hurl syntax highlighter. Recognizes HTTP methods, status lines,
// JSON blocks, {{variable}} templates, and comments.

const METHODS = new Set([
  'GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS',
  'CONNECT', 'TRACE', 'LINK', 'UNLINK',
]);

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

interface Region {
  start: number;
  end: number;
  cls: string;
  /** Override text to render in place of source.slice(start,end). */
  replace?: string;
  /** Extra data encoded into the span's title attribute. */
  title?: string;
}

function findJsonBlocks(src: string): Region[] {
  const out: Region[] = [];
  const len = src.length;
  let i = 0;
  while (i < len) {
    if (src[i] === '{' && src[i + 1] === '{') {
      const endVar = src.indexOf('}}', i + 2);
      i = endVar < 0 ? len : endVar + 2;
      continue;
    }
    const ch = src[i];
    if (ch === '{' || ch === '[') {
      const open = ch;
      const close = ch === '{' ? '}' : ']';
      let depth = 1;
      let j = i + 1;
      let inStr = false;
      let escape = false;
      while (j < len && depth > 0) {
        if (!inStr && src[j] === '{' && src[j + 1] === '{') {
          const endVar = src.indexOf('}}', j + 2);
          j = endVar < 0 ? len : endVar + 2;
          continue;
        }
        const c = src[j];
        if (inStr) {
          if (escape) {
            escape = false;
          } else if (c === '\\') {
            escape = true;
          } else if (c === '"') {
            inStr = false;
          }
        } else {
          if (c === '"') inStr = true;
          else if (c === open) depth++;
          else if (c === close) depth--;
        }
        j++;
      }
      if (depth === 0 && j - i > 4) {
        out.push({ start: i, end: j, cls: 'hurl-token--json' });
        i = j;
        continue;
      }
    }
    i++;
  }
  return out;
}

export function highlightHurl(source: string, vars?: Record<string, string>): string {
  const regions: Region[] = [];

  // Comments — full line starting with #
  const lines = source.split('\n');
  let offset = 0;
  for (const line of lines) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith('#')) {
      const startTrim = line.length - trimmed.length;
      regions.push({
        start: offset + startTrim,
        end: offset + line.length,
        cls: 'hurl-token--comment',
      });
    } else {
      // Method at line start
      const mm = line.match(/^([A-Z]+)\s+/);
      if (mm && METHODS.has(mm[1])) {
        regions.push({
          start: offset,
          end: offset + mm[1].length,
          cls: 'hurl-token--method',
        });
      }
      // Status line
      const sm = line.match(/^HTTP(?:\/[\d.]+)?\s+\d{3}/);
      if (sm) {
        regions.push({
          start: offset,
          end: offset + sm[0].length,
          cls: 'hurl-token--status',
        });
      }
    }
    offset += line.length + 1;
  }

  // JSON-ish blocks
  for (const r of findJsonBlocks(source)) {
    regions.push(r);
  }

  // {{var}} templates
  const varRe = /\{\{([^}]+)\}\}/g;
  let vm: RegExpExecArray | null;
  while ((vm = varRe.exec(source)) !== null) {
    const name = vm[1].trim();
    if (vars) {
      const value = vars[name];
      if (value !== undefined) {
        regions.push({
          start: vm.index,
          end: vm.index + vm[0].length,
          cls: 'hurl-token--resolved',
          replace: value,
          title: `${name} = ${value}`,
        });
      } else {
        regions.push({
          start: vm.index,
          end: vm.index + vm[0].length,
          cls: 'hurl-token--unresolved',
          title: `${name} (unresolved)`,
        });
      }
    } else {
      regions.push({
        start: vm.index,
        end: vm.index + vm[0].length,
        cls: 'hurl-token--var',
      });
    }
  }

  const isAtomic = (cls: string): boolean =>
    cls === 'hurl-token--var' || cls === 'hurl-token--resolved' || cls === 'hurl-token--unresolved';

  const atoms = regions.filter((r) => isAtomic(r.cls)).sort((a, b) => a.start - b.start);
  const containers = regions
    .filter((r) => !isAtomic(r.cls))
    .sort((a, b) => a.start - b.start);

  // Drop containers that overlap an earlier container.
  const kept: Region[] = [];
  let bound = 0;
  for (const c of containers) {
    if (c.start < bound) continue;
    kept.push(c);
    bound = c.end;
  }

  const out: string[] = [];

  const span = (r: Region, text: string): string => {
    const attr = r.title ? ` title="${escapeHtml(r.title)}"` : '';
    return `<span class="hurl-token ${r.cls}"${attr}>${escapeHtml(text)}</span>`;
  };

  const emitAtom = (a: Region): string => span(a, a.replace ?? source.slice(a.start, a.end));

  const emitContainerWithAtoms = (c: Region, inside: Region[]): void => {
    let cur = c.start;
    for (const a of inside) {
      if (a.start > cur) out.push(span(c, source.slice(cur, a.start)));
      out.push(emitAtom(a));
      cur = a.end;
    }
    if (cur < c.end) out.push(span(c, source.slice(cur, c.end)));
  };

  let cursor = 0;
  let ai = 0;
  for (const c of kept) {
    while (ai < atoms.length && atoms[ai].end <= c.start) {
      const a = atoms[ai];
      if (a.start >= cursor) {
        if (cursor < a.start) out.push(escapeHtml(source.slice(cursor, a.start)));
        out.push(emitAtom(a));
        cursor = a.end;
      }
      ai++;
    }
    if (cursor < c.start) out.push(escapeHtml(source.slice(cursor, c.start)));
    const inside: Region[] = [];
    while (ai < atoms.length && atoms[ai].end <= c.end) {
      if (atoms[ai].start >= c.start) inside.push(atoms[ai]);
      ai++;
    }
    emitContainerWithAtoms(c, inside);
    cursor = c.end;
  }
  while (ai < atoms.length) {
    const a = atoms[ai];
    if (a.start >= cursor) {
      if (cursor < a.start) out.push(escapeHtml(source.slice(cursor, a.start)));
      out.push(emitAtom(a));
      cursor = a.end;
    }
    ai++;
  }
  if (cursor < source.length) out.push(escapeHtml(source.slice(cursor)));

  return out.join('');
}
