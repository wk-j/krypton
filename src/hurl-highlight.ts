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
}

function findJsonBlocks(src: string): Region[] {
  const out: Region[] = [];
  const len = src.length;
  let i = 0;
  while (i < len) {
    const ch = src[i];
    if (ch === '{' || ch === '[') {
      const open = ch;
      const close = ch === '{' ? '}' : ']';
      let depth = 1;
      let j = i + 1;
      let inStr = false;
      let escape = false;
      while (j < len && depth > 0) {
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

export function highlightHurl(source: string): string {
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
    regions.push({
      start: vm.index,
      end: vm.index + vm[0].length,
      cls: 'hurl-token--var',
    });
  }

  regions.sort((a, b) => a.start - b.start || a.end - b.end);

  // Resolve overlaps — outer wins when encountered first, drop inner until past
  const out: string[] = [];
  let cursor = 0;
  const stack: Region[] = [];

  const emit = (from: number, to: number): void => {
    if (from >= to) return;
    const top = stack[stack.length - 1];
    if (top) {
      out.push(`<span class="hurl-token ${top.cls}">${escapeHtml(source.slice(from, to))}</span>`);
    } else {
      out.push(escapeHtml(source.slice(from, to)));
    }
  };

  for (const r of regions) {
    const top = stack[stack.length - 1];
    if (top && r.start < top.end) continue;
    emit(cursor, r.start);
    cursor = r.start;
    stack.push(r);
    emit(cursor, r.end);
    cursor = r.end;
    stack.pop();
  }
  emit(cursor, source.length);
  return out.join('');
}
