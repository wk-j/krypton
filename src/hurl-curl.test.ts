import { describe, expect, it } from 'vitest';

import { hurlCliCommand, hurlToCurl, joinFileDir, shQuote } from './hurl-curl';

describe('shQuote', () => {
  it('wraps in single quotes and escapes embedded quotes', () => {
    expect(shQuote('abc')).toBe("'abc'");
    expect(shQuote("it's")).toBe("'it'\\''s'");
  });
});

describe('joinFileDir', () => {
  it('joins relative files under the hurl directory', () => {
    expect(joinFileDir('/proj/hurl', 'data.bin')).toBe('/proj/hurl/data.bin');
  });

  it('keeps absolute paths', () => {
    expect(joinFileDir('/proj/hurl', '/tmp/x.bin')).toBe('/tmp/x.bin');
  });
});

describe('hurlToCurl', () => {
  it('emits a bare GET without -X', () => {
    const r = hurlToCurl('GET https://example.org\n', {});
    expect(r.requestCount).toBe(1);
    expect(r.curl).toBe("curl 'https://example.org'");
    expect(r.unresolved).toEqual([]);
  });

  it('inlines env variables into URL, headers, and JSON body', () => {
    const src = [
      'POST {{host}}/api/login',
      'Authorization: Bearer {{token}}',
      '{',
      '  "email": "{{email}}",',
      '  "n": {{count}}',
      '}',
      '',
    ].join('\n');
    const r = hurlToCurl(src, {
      host: 'https://api.example.com',
      token: 'abc',
      email: 'a@b.c',
      count: '3',
    });
    expect(r.unresolved).toEqual([]);
    expect(r.curl).toContain("-X 'POST'");
    expect(r.curl).toContain("-H 'Authorization: Bearer abc'");
    expect(r.curl).toContain("-H 'Content-Type: application/json'");
    expect(r.curl).toContain('"email": "a@b.c"');
    expect(r.curl).toContain('"n": 3');
    expect(r.curl.endsWith("'https://api.example.com/api/login'")).toBe(true);
  });

  it('leaves templates when no env is selected', () => {
    const r = hurlToCurl('GET {{host}}/health\n', {});
    expect(r.curl).toBe("curl '{{host}}/health'");
    expect(r.unresolved).toEqual(['host']);
  });

  it('appends encoded query params without dropping the URL query', () => {
    const src = [
      'GET https://example.org/q?keep=1',
      '[Query]',
      'a: 1',
      'b: two words',
      '',
    ].join('\n');
    const r = hurlToCurl(src, {});
    expect(r.curl).toBe("curl 'https://example.org/q?keep=1&a=1&b=two%20words'");
  });

  it('emits form fields as --data-urlencode', () => {
    const src = [
      'POST https://example.org/form',
      '[Form]',
      'name: John Doe',
      'token: {{token}}',
      '',
    ].join('\n');
    const r = hurlToCurl(src, { token: 't1' });
    expect(r.curl).toContain("--data-urlencode 'name=John Doe'");
    expect(r.curl).toContain("--data-urlencode 'token=t1'");
    expect(r.curl).toContain("-X 'POST'");
  });

  it('resolves multipart files against fileDir', () => {
    const src = [
      'POST https://example.org/upload',
      '[Multipart]',
      'field1: value1',
      'file: file,data.bin;',
      '',
    ].join('\n');
    const r = hurlToCurl(src, {}, { fileDir: '/proj/hurl' });
    expect(r.curl).toContain("--form 'field1=value1'");
    expect(r.curl).toContain("--form 'file=@/proj/hurl/data.bin'");
  });

  it('maps BasicAuth to -u', () => {
    const src = ['GET https://example.org/auth', '[BasicAuth]', 'bob: secret', ''].join('\n');
    const r = hurlToCurl(src, {});
    expect(r.curl).toContain("-u 'bob:secret'");
  });

  it('maps boolean and value options to curl flags', () => {
    const src = [
      'GET https://example.org/opt',
      '[Options]',
      'insecure: true',
      'location: true',
      'compressed: true',
      'proxy: 127.0.0.1:8888',
      '',
    ].join('\n');
    const r = hurlToCurl(src, {});
    expect(r.curl.startsWith('curl -k -L --compressed -x ')).toBe(true);
    expect(r.curl).toContain("-x '127.0.0.1:8888'");
    expect(r.curl).not.toContain('-X');
  });

  it('joins cookies into one header', () => {
    const src = [
      'GET https://example.org/',
      '[Cookies]',
      'theme: light',
      'sid: {{sid}}',
      '',
    ].join('\n');
    const r = hurlToCurl(src, { sid: 's1' });
    expect(r.curl).toContain("-H 'Cookie: theme=light; sid=s1'");
  });

  it('emits one curl per entry, separated by a blank line', () => {
    const src = ['GET https://example.org/a', '', 'GET https://example.org/b', ''].join('\n');
    const r = hurlToCurl(src, {});
    expect(r.requestCount).toBe(2);
    expect(r.curl).toBe("curl 'https://example.org/a'\n\ncurl 'https://example.org/b'");
  });

  it('skips HTTP responses, asserts, and captures', () => {
    const src = [
      'GET https://example.org',
      'HTTP 200',
      '[Captures]',
      'id: jsonpath "$.id"',
      '[Asserts]',
      'status == 200',
      '',
    ].join('\n');
    const r = hurlToCurl(src, {});
    expect(r.curl).toBe("curl 'https://example.org'");
    expect(r.unresolved).toEqual([]);
  });

  it('applies [Options] variable to this entry and the next', () => {
    const src = [
      'GET https://{{host}}/one',
      '[Options]',
      'variable: host=api.test',
      '',
      'GET https://{{host}}/two',
      '',
    ].join('\n');
    const r = hurlToCurl(src, {});
    expect(r.curl).toBe("curl 'https://api.test/one'\n\ncurl 'https://api.test/two'");
    expect(r.unresolved).toEqual([]);
  });

  it('does not substitute templates inside a raw fenced body', () => {
    const src = [
      'POST https://example.org/api',
      '```raw',
      '{ "name": "{{ name }}" }',
      '```',
      '',
    ].join('\n');
    const r = hurlToCurl(src, { name: 'Ada' });
    expect(r.curl).toContain("{ \"name\": \"{{ name }}\" }");
    expect(r.unresolved).toEqual([]);
  });

  it('emits file bodies as --data-binary @path', () => {
    const src = ['POST https://example.org/bin', 'file,data.bin;', ''].join('\n');
    const r = hurlToCurl(src, {}, { fileDir: '/proj' });
    expect(r.curl).toContain("--data-binary @'/proj/data.bin'");
  });

  it('does not duplicate Content-Type when the source already has it', () => {
    const src = [
      'POST https://example.org',
      'Content-Type: application/json',
      '{',
      '  "ok": true',
      '}',
      '',
    ].join('\n');
    const r = hurlToCurl(src, {});
    expect(r.curl.match(/Content-Type/g)?.length).toBe(1);
  });

  it('records unresolved capture names and still copies', () => {
    const src = ['GET https://example.org/{{id}}', 'X-CSRF: {{csrf_token}}', ''].join('\n');
    const r = hurlToCurl(src, { id: '7' });
    expect(r.curl).toContain("'https://example.org/7'");
    expect(r.curl).toContain("-H 'X-CSRF: {{csrf_token}}'");
    expect(r.unresolved).toEqual(['csrf_token']);
  });

  it('evaluates newUuid and newDate at copy time', () => {
    const src = ['GET https://example.org/{{newUuid}}?t={{newDate}}', ''].join('\n');
    const r = hurlToCurl(src, {});
    expect(r.unresolved).toEqual([]);
    expect(r.curl).not.toContain('{{newUuid}}');
    expect(r.curl).not.toContain('{{newDate}}');
    expect(r.curl).toMatch(
      /curl 'https:\/\/example\.org\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\?t=\d{4}-\d{2}-\d{2}T/,
    );
  });

  it('quotes apostrophes in header values', () => {
    const src = ['GET https://example.org', "X-Name: O'Brien", ''].join('\n');
    const r = hurlToCurl(src, {});
    expect(r.curl).toContain("-H 'X-Name: O'\\''Brien'");
  });

  it('returns an empty command when there is no request', () => {
    const r = hurlToCurl('# just a comment\n', {});
    expect(r.requestCount).toBe(0);
    expect(r.curl).toBe('');
  });

  it('prefers a JSON body over a sibling [Form] section', () => {
    const src = [
      'POST https://example.org',
      '[Form]',
      'a: 1',
      '{',
      '  "b": 2',
      '}',
      '',
    ].join('\n');
    const r = hurlToCurl(src, {});
    expect(r.curl).toContain('--data-binary');
    expect(r.curl).not.toContain('--data-urlencode');
  });
});

describe('hurlCliCommand', () => {
  it('copies the file alone when no env is selected', () => {
    expect(hurlCliCommand('api/login.hurl')).toBe("hurl 'api/login.hurl'");
  });

  it('adds --variables-file for the selected env', () => {
    expect(hurlCliCommand('api/login.hurl', 'dev.env')).toBe(
      "hurl --variables-file 'dev.env' 'api/login.hurl'",
    );
  });

  it('ignores an empty env path', () => {
    expect(hurlCliCommand('x.hurl', '')).toBe("hurl 'x.hurl'");
    expect(hurlCliCommand('x.hurl', null)).toBe("hurl 'x.hurl'");
  });

  it('includes the active verbose flag', () => {
    expect(hurlCliCommand('x.hurl', 'dev.env', { verbose: true })).toBe(
      "hurl --verbose --variables-file 'dev.env' 'x.hurl'",
    );
    expect(hurlCliCommand('x.hurl', null, { veryVerbose: true })).toBe(
      "hurl --very-verbose 'x.hurl'",
    );
  });

  it('quotes spaces in paths', () => {
    expect(hurlCliCommand('my files/a.hurl', 'my env/dev.env')).toBe(
      "hurl --variables-file 'my env/dev.env' 'my files/a.hurl'",
    );
  });
});
