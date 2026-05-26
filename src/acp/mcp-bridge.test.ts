import { describe, expect, it } from 'vitest';

import {
  dedupeByName,
  toClaudeMcpFile,
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

describe('ClaudeMcpFile JSON', () => {
  it('serializes mcpServers root key', () => {
    const parsed = JSON.parse(JSON.stringify(toClaudeMcpFile([]))) as ClaudeMcpFile;
    expect(parsed.mcpServers).toEqual({});
  });
});
