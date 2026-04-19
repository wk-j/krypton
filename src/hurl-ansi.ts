// Minimal SGR ANSI to HTML converter for hurl output.
// Handles 8/16 color, 256-color, truecolor, bold, dim, reset. Other escape
// sequences (cursor moves, mode toggles, etc.) are stripped silently.

const BASIC_FG: Record<number, string> = {
  30: '#000000', 31: '#cd3131', 32: '#0dbc79', 33: '#e5e510',
  34: '#2472c8', 35: '#bc3fbc', 36: '#11a8cd', 37: '#e5e5e5',
  90: '#666666', 91: '#f14c4c', 92: '#23d18b', 93: '#f5f543',
  94: '#3b8eea', 95: '#d670d6', 96: '#29b8db', 97: '#ffffff',
};

const BASIC_BG: Record<number, string> = {
  40: '#000000', 41: '#cd3131', 42: '#0dbc79', 43: '#e5e510',
  44: '#2472c8', 45: '#bc3fbc', 46: '#11a8cd', 47: '#e5e5e5',
  100: '#666666', 101: '#f14c4c', 102: '#23d18b', 103: '#f5f543',
  104: '#3b8eea', 105: '#d670d6', 106: '#29b8db', 107: '#ffffff',
};

interface Style {
  fg: string | null;
  bg: string | null;
  bold: boolean;
  dim: boolean;
}

function emptyStyle(): Style {
  return { fg: null, bg: null, bold: false, dim: false };
}

function styleToAttr(s: Style): string {
  const parts: string[] = [];
  if (s.fg) parts.push(`color:${s.fg}`);
  if (s.bg) parts.push(`background:${s.bg}`);
  if (s.bold) parts.push('font-weight:700');
  if (s.dim) parts.push('opacity:0.6');
  return parts.join(';');
}

function styleEmpty(s: Style): boolean {
  return s.fg === null && s.bg === null && !s.bold && !s.dim;
}

function xterm256(n: number): string {
  if (n < 16) {
    const basic = BASIC_FG[n < 8 ? 30 + n : 90 + (n - 8)];
    return basic ?? '#ffffff';
  }
  if (n < 232) {
    const c = n - 16;
    const r = Math.floor(c / 36);
    const g = Math.floor((c % 36) / 6);
    const b = c % 6;
    const toHex = (v: number): string => {
      const n8 = v === 0 ? 0 : 55 + v * 40;
      return n8.toString(16).padStart(2, '0');
    };
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
  }
  const gray = 8 + (n - 232) * 10;
  const hx = gray.toString(16).padStart(2, '0');
  return `#${hx}${hx}${hx}`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function applySgr(style: Style, params: number[]): Style {
  const s: Style = { ...style };
  for (let i = 0; i < params.length; i++) {
    const p = params[i];
    if (p === 0) {
      s.fg = null;
      s.bg = null;
      s.bold = false;
      s.dim = false;
    } else if (p === 1) {
      s.bold = true;
    } else if (p === 2) {
      s.dim = true;
    } else if (p === 22) {
      s.bold = false;
      s.dim = false;
    } else if ((p >= 30 && p <= 37) || (p >= 90 && p <= 97)) {
      s.fg = BASIC_FG[p] ?? null;
    } else if ((p >= 40 && p <= 47) || (p >= 100 && p <= 107)) {
      s.bg = BASIC_BG[p] ?? null;
    } else if (p === 39) {
      s.fg = null;
    } else if (p === 49) {
      s.bg = null;
    } else if (p === 38 || p === 48) {
      const mode = params[i + 1];
      if (mode === 5 && params.length > i + 2) {
        const col = xterm256(params[i + 2]);
        if (p === 38) s.fg = col; else s.bg = col;
        i += 2;
      } else if (mode === 2 && params.length > i + 4) {
        const r = params[i + 2];
        const g = params[i + 3];
        const b = params[i + 4];
        const col = `rgb(${r},${g},${b})`;
        if (p === 38) s.fg = col; else s.bg = col;
        i += 4;
      }
    }
  }
  return s;
}

export function ansiToHtml(text: string): string {
  const out: string[] = [];
  let style = emptyStyle();
  let spanOpen = false;
  const re = /\x1b\[([0-9;?]*)([A-Za-z])/g;
  let lastIndex = 0;
  let m: RegExpExecArray | null;

  const openIfNeeded = (): void => {
    if (spanOpen) return;
    if (styleEmpty(style)) return;
    out.push(`<span style="${styleToAttr(style)}">`);
    spanOpen = true;
  };
  const closeIfOpen = (): void => {
    if (spanOpen) {
      out.push('</span>');
      spanOpen = false;
    }
  };

  while ((m = re.exec(text)) !== null) {
    const chunk = text.slice(lastIndex, m.index);
    if (chunk) {
      openIfNeeded();
      out.push(escapeHtml(chunk));
    }
    const [, rawParams, final] = m;
    if (final === 'm') {
      const params = rawParams
        .split(';')
        .filter((s) => s.length > 0)
        .map((s) => parseInt(s, 10) || 0);
      if (params.length === 0) params.push(0);
      closeIfOpen();
      style = applySgr(style, params);
    }
    lastIndex = re.lastIndex;
  }

  const tail = text.slice(lastIndex);
  if (tail) {
    openIfNeeded();
    out.push(escapeHtml(tail));
  }
  closeIfOpen();
  return out.join('');
}
