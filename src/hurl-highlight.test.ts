import { describe, it, expect } from 'vitest';
import { highlightHurl } from './hurl-highlight';

const strip = (html: string): string =>
  html
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

describe('highlightHurl — plain rendering', () => {
  it('escapes HTML entities in plain text', () => {
    const html = highlightHurl('<script>&"');
    expect(html).toContain('&lt;script&gt;&amp;&quot;');
    expect(html).not.toContain('<script>');
  });

  it('returns empty string for empty input', () => {
    expect(highlightHurl('')).toBe('');
  });

  it('leaves source intact when stripped of markup', () => {
    const src = 'GET https://example.com\nHTTP 200\n';
    expect(strip(highlightHurl(src))).toBe(src);
  });
});

describe('highlightHurl — variable rendering (no vars)', () => {
  it('wraps a single {{var}} in a --var span', () => {
    const html = highlightHurl('url: {{host}}');
    expect(html).toContain('class="hurl-token hurl-token--var"');
    expect(html).toContain('{{host}}');
  });

  it('wraps two adjacent vars each in their own span', () => {
    const html = highlightHurl('{{a}}{{b}}');
    const matches = html.match(/hurl-token--var/g) ?? [];
    expect(matches).toHaveLength(2);
    expect(strip(html)).toBe('{{a}}{{b}}');
  });

  it('does not duplicate text around vars', () => {
    const src = 'x {{a}} y {{b}} z';
    expect(strip(highlightHurl(src))).toBe(src);
  });
});

describe('highlightHurl — variable resolution', () => {
  const vars = { host: 'api.example.com', id: '42' };

  it('substitutes a known var with its value', () => {
    const html = highlightHurl('url: {{host}}', vars);
    expect(html).toContain('class="hurl-token hurl-token--resolved"');
    expect(html).toContain('api.example.com');
    expect(html).not.toContain('{{host}}');
  });

  it('marks unknown vars as unresolved (keeps template text)', () => {
    const html = highlightHurl('{{missing}}', vars);
    expect(html).toContain('class="hurl-token hurl-token--unresolved"');
    expect(html).toContain('{{missing}}');
  });

  it('keeps adjacent non-duplicated text around resolved vars', () => {
    const src = 'prefix {{host}} suffix';
    const html = highlightHurl(src, vars);
    expect(strip(html)).toBe('prefix api.example.com suffix');
  });

  it('resolves multiple vars independently', () => {
    const html = highlightHurl('{{host}}/item/{{id}}', vars);
    expect(strip(html)).toBe('api.example.com/item/42');
  });

  it('handles name with surrounding whitespace in template', () => {
    const html = highlightHurl('{{ host }}', vars);
    expect(strip(html)).toBe('api.example.com');
  });

  it('does not duplicate when two vars are back-to-back', () => {
    const html = highlightHurl('{{host}}{{id}}', vars);
    expect(strip(html)).toBe('api.example.com42');
  });

  it('adds a title attribute with name = value', () => {
    const html = highlightHurl('{{host}}', vars);
    expect(html).toContain('title="host = api.example.com"');
  });
});

describe('highlightHurl — vars inside JSON bodies', () => {
  const vars = { scan_id: '12345', name: 'alice' };

  it('renders a var nested inside a JSON object', () => {
    const src = '{ "scanId": {{scan_id}} }';
    const html = highlightHurl(src, vars);
    expect(strip(html)).toBe('{ "scanId": 12345 }');
    expect(html).toContain('hurl-token--resolved');
    expect(html).toContain('hurl-token--json');
  });

  it('renders unresolved var inside JSON without duplicating surrounding braces', () => {
    const src = '{ "x": {{missing}} }';
    const html = highlightHurl(src);
    expect(strip(html)).toBe(src);
  });

  it('does not treat {{var}} at the start of a line as a JSON block', () => {
    const html = highlightHurl('{{host}}', { host: 'ok' });
    expect(strip(html)).toBe('ok');
    expect(html).not.toContain('hurl-token--json');
  });

  it('renders vars correctly when adjacent inside JSON', () => {
    const src = '{ "a": {{scan_id}}, "b": {{name}} }';
    const html = highlightHurl(src, vars);
    expect(strip(html)).toBe('{ "a": 12345, "b": alice }');
  });

  it('handles nested JSON objects with vars', () => {
    const src = '{ "outer": { "inner": {{scan_id}} } }';
    const html = highlightHurl(src, vars);
    expect(strip(html)).toBe('{ "outer": { "inner": 12345 } }');
  });

  it('preserves JSON-style tinting around a var split', () => {
    const src = '{ "k": {{scan_id}} }';
    const html = highlightHurl(src, vars);
    const jsonSpans = html.match(/class="hurl-token hurl-token--json"/g) ?? [];
    expect(jsonSpans.length).toBeGreaterThanOrEqual(2);
  });
});

describe('highlightHurl — HTTP methods and status lines', () => {
  it('highlights GET at line start', () => {
    const html = highlightHurl('GET https://example.com');
    expect(html).toContain('hurl-token--method');
    expect(strip(html)).toBe('GET https://example.com');
  });

  it('does not highlight GET mid-line', () => {
    const html = highlightHurl('# GET note');
    expect(html).not.toContain('hurl-token--method');
  });

  it('highlights HTTP 200 status lines', () => {
    const html = highlightHurl('HTTP 200');
    expect(html).toContain('hurl-token--status');
  });

  it('highlights HTTP/1.1 404 status lines', () => {
    const html = highlightHurl('HTTP/1.1 404');
    expect(html).toContain('hurl-token--status');
  });
});

describe('highlightHurl — comments', () => {
  it('highlights full-line comments', () => {
    const html = highlightHurl('# this is a comment\nGET /');
    expect(html).toContain('hurl-token--comment');
  });

  it('preserves text after comment', () => {
    const src = '# hello\nGET /';
    expect(strip(highlightHurl(src))).toBe(src);
  });

  it('does not duplicate var text on comment lines when the line has no var', () => {
    const src = '# just a comment';
    expect(strip(highlightHurl(src))).toBe(src);
  });
});

describe('highlightHurl — realistic hurl file', () => {
  const src = [
    '# Keycloak login',
    'POST {{keycloak_url}}/token',
    '[FormParams]',
    'client_id: {{client_id}}',
    'grant_type: password',
    '',
    'HTTP 200',
    '[Asserts]',
    'jsonpath "$.access_token" exists',
  ].join('\n');

  it('round-trips plain text with no vars map', () => {
    expect(strip(highlightHurl(src))).toBe(src);
  });

  it('round-trips with resolved vars', () => {
    const html = highlightHurl(src, {
      keycloak_url: 'https://auth.example',
      client_id: 'my-app',
    });
    expect(strip(html)).toBe(src
      .replace('{{keycloak_url}}', 'https://auth.example')
      .replace('{{client_id}}', 'my-app'));
  });

  it('each var token appears exactly once in unresolved mode', () => {
    const html = highlightHurl(src);
    const varMatches = html.match(/\{\{keycloak_url\}\}/g) ?? [];
    const idMatches = html.match(/\{\{client_id\}\}/g) ?? [];
    expect(varMatches).toHaveLength(1);
    expect(idMatches).toHaveLength(1);
  });
});

describe('highlightHurl — JSON body with var regression', () => {
  it('does NOT render the var twice when inside a JSON body (regression)', () => {
    const src = '{ "scanId": {{id}} }';
    const html = highlightHurl(src);
    const matches = html.match(/\{\{id\}\}/g) ?? [];
    expect(matches).toHaveLength(1);
  });

  it('does NOT render a var twice side-by-side (regression for {{a}}{{a}})', () => {
    const src = '{{host}}{{host}}';
    const html = highlightHurl(src);
    expect(strip(html)).toBe('{{host}}{{host}}');
  });
});
