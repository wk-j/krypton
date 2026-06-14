import { describe, expect, it } from 'vitest';

import {
  dedupeByName,
  toClaudeMcpFile,
  toClineMcpFile,
  type ClaudeMcpFile,
} from './mcp-bridge';
import type { AcpMcpServerDescriptor } from './types';

describe('toClaudeMcpFile', () => {
  it('round-trips stdio servers to object env shape', () => {
    const servers: AcpMcpServerDescriptor[] = [{
      name: 'ctx',
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'tool'],
      env: [{ name: 'TOKEN', value: 'secret' }],
    }];
    const file = toClaudeMcpFile(servers);
    expect(file.mcpServers?.ctx).toEqual({
      command: 'npx',
      args: ['-y', 'tool'],
      env: { TOKEN: 'secret' },
    });
  });

  it('writes http remote without type field (Junie doc shape)', () => {
    const servers: AcpMcpServerDescriptor[] = [{
      name: 'krypton-harness-memory',
      type: 'http',
      url: 'http://127.0.0.1:9999/mcp/harness/h1/lane/Junie-1',
      headers: [],
    }];
    const file = toClaudeMcpFile(servers);
    expect(file.mcpServers?.['krypton-harness-memory']).toEqual({
      url: 'http://127.0.0.1:9999/mcp/harness/h1/lane/Junie-1',
    });
  });

  it('dedupe keeps first name when merging lists', () => {
    const a: AcpMcpServerDescriptor[] = [{
      name: 'x',
      type: 'http',
      url: 'http://a',
      headers: [],
    }];
    const b: AcpMcpServerDescriptor[] = [{
      name: 'x',
      type: 'http',
      url: 'http://b',
      headers: [],
    }];
    const merged = dedupeByName(a, b)[0];
    expect(merged.type === 'http' && merged.url).toBe('http://a');
  });
});

describe('toClineMcpFile', () => {
  it('tags an http server as streamableHttp (not the SSE default)', () => {
    // cline 3.0.24 defaults a URL-only entry to SSE; the harness memory server
    // is streamable HTTP, so the explicit type is required for it to connect.
    const servers: AcpMcpServerDescriptor[] = [{
      name: 'krypton-harness-memory',
      type: 'http',
      url: 'http://127.0.0.1:9999/mcp/harness/h1/lane/Cline-1',
      headers: [],
    }];
    const file = toClineMcpFile(servers);
    expect(file.mcpServers['krypton-harness-memory']).toEqual({
      type: 'streamableHttp',
      url: 'http://127.0.0.1:9999/mcp/harness/h1/lane/Cline-1',
    });
  });

  it('tags an sse server as sse and a stdio server as stdio', () => {
    const servers: AcpMcpServerDescriptor[] = [
      { name: 'evt', type: 'sse', url: 'http://sse', headers: [] },
      { name: 'ctx', type: 'stdio', command: 'npx', args: ['-y', 't'], env: [] },
    ];
    const file = toClineMcpFile(servers);
    expect(file.mcpServers.evt).toEqual({ type: 'sse', url: 'http://sse' });
    expect(file.mcpServers.ctx).toEqual({ type: 'stdio', command: 'npx', args: ['-y', 't'] });
  });
});

describe('ClaudeMcpFile JSON', () => {
  it('serializes mcpServers root key', () => {
    const parsed = JSON.parse(JSON.stringify(toClaudeMcpFile([]))) as ClaudeMcpFile;
    expect(parsed.mcpServers).toEqual({});
  });
});
