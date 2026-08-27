// Convert a Hurl source file to POSIX curl, substituting {{vars}} from a
// selected *.env map. Inlined into src/acp/artifact-hurl.html — keep in sync.

const METHODS = new Set([
  'GET',
  'POST',
  'PUT',
  'DELETE',
  'PATCH',
  'HEAD',
  'OPTIONS',
  'CONNECT',
  'TRACE',
  'LINK',
  'UNLINK',
]);

const SECTION_ALIAS: Record<string, string> = {
  QueryStringParams: 'Query',
  FormParams: 'Form',
  MultipartFormData: 'Multipart',
};

const BOOL_FLAGS: Record<string, string> = {
  insecure: '-k',
  location: '-L',
  compressed: '--compressed',
  http2: '--http2',
  http3: '--http3',
  ipv4: '-4',
  ipv6: '-6',
  'path-as-is': '--path-as-is',
};

const VALUE_FLAGS: Record<string, string> = {
  proxy: '-x',
  user: '-u',
  'unix-socket': '--unix-socket',
  'max-time': '--max-time',
  'connect-timeout': '--connect-timeout',
  cacert: '--cacert',
  cert: '--cert',
  key: '--key',
};

export interface HurlCurlOptions {
  /** Directory of the .hurl file; used to resolve `file,name;` and multipart files. */
  fileDir?: string;
}

export interface HurlCurlResult {
  curl: string;
  unresolved: string[];
  requestCount: number;
}

interface Kv {
  name: string;
  value: string;
}

interface MultipartField {
  name: string;
  value?: string;
  filename?: string;
}

interface Body {
  kind: 'json' | 'text' | 'raw' | 'file' | 'base64' | 'hex';
  value: string;
  filename?: string;
}

interface RequestEntry {
  method: string;
  url: string;
  headers: Kv[];
  query: Kv[];
  form: Kv[];
  multipart: MultipartField[];
  cookies: Kv[];
  basicAuth: { user: string; pass: string } | null;
  options: Record<string, string>;
  variables: Record<string, string>;
  body: Body | null;
}

export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function joinFileDir(dir: string | undefined, file: string): string {
  if (!dir) return file;
  if (file.startsWith('/') || /^[A-Za-z]:[\\/]/.test(file)) return file;
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/';
  return dir.replace(/[\\/]+$/, '') + sep + file.replace(/^[\\/]+/, '');
}

function newUuid(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function substitute(
  text: string,
  vars: Record<string, string>,
  unresolved: string[],
): string {
  return text.replace(/\{\{([^}]*)\}\}/g, (match, inner: string) => {
    const name = inner.trim();
    if (!name) return match;
    if (Object.prototype.hasOwnProperty.call(vars, name)) return vars[name];
    if (name === 'newUuid') return newUuid();
    if (name === 'newDate') return new Date().toISOString();
    if (!unresolved.includes(name)) unresolved.push(name);
    return match;
  });
}

function matchMethod(line: string): { method: string; url: string } | null {
  const m = line.match(/^([A-Z]+)\s+(\S.*)$/);
  if (!m || !METHODS.has(m[1])) return null;
  return { method: m[1], url: m[2].trim() };
}

function isHttpResponse(line: string): boolean {
  return /^HTTP(?:\/[0-9.]+)?\s+[0-9]{3}/.test(line);
}

function sectionName(line: string): string | null {
  const m = line.match(/^\[([A-Za-z]+)\]\s*$/);
  if (!m) return null;
  return SECTION_ALIAS[m[1]] ?? m[1];
}

function splitKv(line: string): Kv | null {
  const c = line.indexOf(':');
  if (c < 0) return null;
  const name = line.slice(0, c).trim();
  if (!name) return null;
  return { name, value: line.slice(c + 1).trim() };
}

function emptyEntry(method: string, url: string): RequestEntry {
  return {
    method,
    url,
    headers: [],
    query: [],
    form: [],
    multipart: [],
    cookies: [],
    basicAuth: null,
    options: {},
    variables: {},
    body: null,
  };
}

function collectJson(lines: string[], start: number): { text: string; end: number } {
  const text = lines.slice(start).join('\n');
  let i = 0;
  while (i < text.length && text[i] !== '{') i++;
  let depth = 0;
  let inStr = false;
  let escape = false;
  for (let j = i; j < text.length; j++) {
    if (!inStr && text[j] === '{' && text[j + 1] === '{') {
      const endVar = text.indexOf('}}', j + 2);
      j = endVar < 0 ? text.length - 1 : endVar + 1;
      continue;
    }
    const c = text[j];
    if (inStr) {
      if (escape) escape = false;
      else if (c === '\\') escape = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') {
      inStr = true;
    } else if (c === '{') {
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0) {
        const json = text.slice(i, j + 1);
        const consumed = text.slice(0, j + 1).split('\n').length;
        return { text: json, end: start + consumed };
      }
    }
  }
  return { text: text.slice(i), end: lines.length };
}

function collectUntilSemi(
  lines: string[],
  start: number,
  prefix: string,
): { payload: string; end: number } {
  let acc = lines[start].trim().slice(prefix.length);
  let k = start;
  while (!acc.includes(';') && k + 1 < lines.length) {
    k++;
    acc += lines[k].trim();
  }
  const semi = acc.indexOf(';');
  return { payload: semi >= 0 ? acc.slice(0, semi) : acc, end: k + 1 };
}

function parseMultipartValue(value: string): MultipartField {
  const m = value.match(/^file,([^;]+);(?:\s*.*)?$/);
  if (m) return { name: '', filename: m[1].trim() };
  return { name: '', value };
}

/** Body is last in a Hurl request — it can follow headers or any [Section]. */
function consumeBody(
  lines: string[],
  i: number,
  trimmed: string,
  entry: RequestEntry,
): { i: number; mode: string } | null {
  if (trimmed.startsWith('```')) {
    const lang = trimmed.slice(3).trim();
    const kind = lang === 'raw' ? 'raw' : lang === 'json' ? 'json' : 'text';
    entry.body = { kind, value: '' };
    return { i: i + 1, mode: 'multiline' };
  }
  if (trimmed.startsWith('`') && trimmed.endsWith('`') && trimmed.length >= 2) {
    entry.body = { kind: 'text', value: trimmed.slice(1, -1) };
    return { i: i + 1, mode: 'skip' };
  }
  if (trimmed.startsWith('{') && !trimmed.startsWith('{{')) {
    const json = collectJson(lines, i);
    entry.body = { kind: 'json', value: json.text };
    return { i: json.end, mode: 'skip' };
  }
  if (trimmed.startsWith('<?xml') || /^<[A-Za-z/]/.test(trimmed)) {
    const xml: string[] = [];
    let k = i;
    while (k < lines.length) {
      const t = lines[k].trim();
      if (matchMethod(t) || isHttpResponse(t) || sectionName(t)) break;
      xml.push(lines[k]);
      k++;
    }
    entry.body = { kind: 'text', value: xml.join('\n') };
    return { i: k, mode: 'skip' };
  }
  if (trimmed.startsWith('file,')) {
    const got = collectUntilSemi(lines, i, 'file,');
    entry.body = { kind: 'file', value: '', filename: got.payload.trim() };
    return { i: got.end, mode: 'skip' };
  }
  if (trimmed.startsWith('base64,')) {
    const got = collectUntilSemi(lines, i, 'base64,');
    entry.body = { kind: 'base64', value: got.payload };
    return { i: got.end, mode: 'skip' };
  }
  if (trimmed.startsWith('hex,')) {
    const got = collectUntilSemi(lines, i, 'hex,');
    entry.body = { kind: 'hex', value: got.payload };
    return { i: got.end, mode: 'skip' };
  }
  return null;
}

function parseEntries(source: string): RequestEntry[] {
  const lines = source.split(/\r?\n/);
  const entries: RequestEntry[] = [];
  let i = 0;
  while (i < lines.length) {
    const m = matchMethod(lines[i].trim());
    if (!m) {
      i++;
      continue;
    }
    const entry = emptyEntry(m.method, m.url);
    i++;
    let mode = 'head';
    while (i < lines.length) {
      if (matchMethod(lines[i].trim())) break;
      const raw = lines[i];
      const trimmed = raw.trim();
      if (mode === 'multiline') {
        if (trimmed === '```') {
          const body = entry.body;
          if (body && body.value && !body.value.endsWith('\n')) body.value += '\n';
          mode = 'skip';
          i++;
          continue;
        }
        const body = entry.body;
        if (body) body.value += (body.value ? '\n' : '') + raw;
        i++;
        continue;
      }
      if (!trimmed || trimmed.startsWith('#')) {
        i++;
        continue;
      }
      if (isHttpResponse(trimmed)) {
        mode = 'skip';
        i++;
        continue;
      }
      const sec = sectionName(trimmed);
      if (sec) {
        if (
          sec === 'Asserts' ||
          sec === 'Captures' ||
          sec === 'Filters' ||
          sec === 'skip'
        ) {
          mode = 'skip';
        } else {
          mode = sec;
        }
        i++;
        continue;
      }
      if (mode === 'skip') {
        i++;
        continue;
      }
      const body = consumeBody(lines, i, trimmed, entry);
      if (body) {
        i = body.i;
        mode = body.mode;
        continue;
      }
      if (mode === 'head') {
        const header = splitKv(trimmed);
        if (header) entry.headers.push(header);
        i++;
        continue;
      }
      const kv = splitKv(trimmed);
      if (!kv) {
        i++;
        continue;
      }
      if (mode === 'Query') entry.query.push(kv);
      else if (mode === 'Form') entry.form.push(kv);
      else if (mode === 'Cookies') entry.cookies.push(kv);
      else if (mode === 'BasicAuth') entry.basicAuth = { user: kv.name, pass: kv.value };
      else if (mode === 'Multipart') {
        const field = parseMultipartValue(kv.value);
        field.name = kv.name;
        entry.multipart.push(field);
      } else if (mode === 'Options') {
        if (kv.name === 'variable') {
          const eq = kv.value.indexOf('=');
          if (eq > 0) {
            entry.variables[kv.value.slice(0, eq).trim()] = kv.value.slice(eq + 1).trim();
          }
        } else {
          entry.options[kv.name] = kv.value;
        }
      }
      i++;
    }
    entries.push(entry);
  }
  return entries;
}

function optionTruthy(value: string): boolean {
  const v = value.trim().toLowerCase();
  return v === 'true' || v === 'yes' || v === 'on';
}

function appendQuery(url: string, pairs: Kv[]): string {
  if (!pairs.length) return url;
  const hash = url.indexOf('#');
  const base = hash >= 0 ? url.slice(0, hash) : url;
  const frag = hash >= 0 ? url.slice(hash) : '';
  const q = pairs
    .map((p) => `${encodeURIComponent(p.name)}=${encodeURIComponent(p.value)}`)
    .join('&');
  const join = base.includes('?') ? '&' : '?';
  return base + join + q + frag;
}

function decodeBase64(s: string): Uint8Array | null {
  const compact = s.replace(/\s+/g, '');
  if (!compact) return new Uint8Array();
  try {
    if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(compact, 'base64'));
    const bin = atob(compact);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function decodeHex(s: string): Uint8Array | null {
  const compact = s.replace(/\s+/g, '');
  if (compact.length % 2 !== 0 || /[^0-9a-fA-F]/.test(compact)) return null;
  const out = new Uint8Array(compact.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(compact.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function buildCurl(
  req: RequestEntry,
  vars: Record<string, string>,
  fileDir: string | undefined,
  unresolved: string[],
): string {
  const local: Record<string, string> = { ...vars, ...req.variables };
  const sub = (s: string): string => substitute(s, local, unresolved);

  const query = req.query.map((q) => ({ name: sub(q.name), value: sub(q.value) }));
  const url = appendQuery(sub(req.url), query);

  const args: string[] = ['curl'];

  for (const [name, flag] of Object.entries(BOOL_FLAGS)) {
    if (optionTruthy(req.options[name] ?? '')) args.push(flag);
  }
  for (const [name, flag] of Object.entries(VALUE_FLAGS)) {
    if (name === 'user') continue;
    const val = req.options[name];
    if (val) args.push(flag, shQuote(sub(val)));
  }

  const user = req.options.user ? sub(req.options.user) : req.basicAuth
    ? `${sub(req.basicAuth.user)}:${sub(req.basicAuth.pass)}`
    : '';
  if (user) args.push('-u', shQuote(user));

  const hasPayload = !!(req.body || req.form.length || req.multipart.length);
  if (req.method !== 'GET' || hasPayload) args.push('-X', shQuote(req.method));

  let hasContentType = false;
  for (const h of req.headers) {
    const name = sub(h.name);
    const value = sub(h.value);
    if (name.toLowerCase() === 'content-type') hasContentType = true;
    args.push('-H', shQuote(`${name}: ${value}`));
  }
  if (req.cookies.length) {
    const cookie = req.cookies.map((c) => `${sub(c.name)}=${sub(c.value)}`).join('; ');
    args.push('-H', shQuote(`Cookie: ${cookie}`));
  }

  if (req.body) {
    emitBody(req.body, args, fileDir, sub, unresolved, hasContentType);
  } else if (req.multipart.length) {
    for (const f of req.multipart) {
      if (f.filename) {
        args.push('--form', shQuote(`${sub(f.name)}=@${joinFileDir(fileDir, sub(f.filename))}`));
      } else {
        args.push('--form', shQuote(`${sub(f.name)}=${sub(f.value ?? '')}`));
      }
    }
  } else if (req.form.length) {
    for (const f of req.form) {
      args.push('--data-urlencode', shQuote(`${sub(f.name)}=${sub(f.value)}`));
    }
  }

  args.push(shQuote(url));
  return args.join(' ');
}

function emitBody(
  body: Body,
  args: string[],
  fileDir: string | undefined,
  sub: (s: string) => string,
  unresolved: string[],
  hasContentType: boolean,
): void {
  if (body.kind === 'file' && body.filename) {
    args.push('--data-binary', `@${shQuote(joinFileDir(fileDir, sub(body.filename)))}`);
    return;
  }
  if (body.kind === 'base64' || body.kind === 'hex') {
    const bytes = body.kind === 'base64' ? decodeBase64(body.value) : decodeHex(body.value);
    const text = bytes ? bytesToUtf8(bytes) : null;
    if (text == null) {
      const tag = body.kind === 'base64' ? 'body:base64' : 'body:hex';
      if (!unresolved.includes(tag)) unresolved.push(tag);
      return;
    }
    args.push('--data-binary', shQuote(text));
    return;
  }
  const raw = body.kind === 'raw';
  const text = raw ? body.value : sub(body.value);
  if (body.kind === 'json' && !hasContentType) {
    args.push('-H', shQuote('Content-Type: application/json'));
  }
  args.push('--data-binary', shQuote(text));
}

export interface HurlCliFlags {
  verbose?: boolean;
  veryVerbose?: boolean;
}

/** POSIX `hurl [--verbose|--very-verbose] [--variables-file env] file`. */
export function hurlCliCommand(
  filePath: string,
  variablesFile?: string | null,
  flags?: HurlCliFlags,
): string {
  const args = ['hurl'];
  if (flags?.veryVerbose) args.push('--very-verbose');
  else if (flags?.verbose) args.push('--verbose');
  if (variablesFile) args.push('--variables-file', shQuote(variablesFile));
  args.push(shQuote(filePath));
  return args.join(' ');
}

export function hurlToCurl(
  source: string,
  vars: Record<string, string>,
  opts?: HurlCurlOptions,
): HurlCurlResult {
  const unresolved: string[] = [];
  const entries = parseEntries(source);
  const runningVars: Record<string, string> = { ...vars };
  const curls: string[] = [];
  for (const entry of entries) {
    Object.assign(runningVars, entry.variables);
    curls.push(buildCurl(entry, runningVars, opts?.fileDir, unresolved));
  }
  return {
    curl: curls.join('\n\n'),
    unresolved,
    requestCount: entries.length,
  };
}
