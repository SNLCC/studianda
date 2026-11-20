import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, describe, expect, it } from 'vitest';

const pkgDir = path.resolve(import.meta.dirname, '..');
const entry = path.join(pkgDir, 'dist', 'agent-bridge.mjs');
const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'studianda-bridge-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows 上偶发占用，忽略
    }
  }
});

async function connect(dataDir: string, env: Record<string, string> = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    env: { STUDIANDA_DATA_DIR: dataDir, ...env },
    stderr: 'pipe'
  });
  const client = new Client({ name: 'bridge-test', version: '0.0.0' });
  await client.connect(transport);
  return client;
}

function textOf(result: { content?: unknown }): string {
  return (result.content as Array<{ type: string; text?: string }> | undefined ?? [])
    .map((block) => block.text ?? '')
    .join('\n');
}

describe('agent-bridge（MCP stdio）', () => {
  it('初始化与 tools/list 不依赖 Core；无 Core 时读工具返回 core_unavailable', async () => {
    const dataDir = tempDir();
    const client = await connect(dataDir);

    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name);
    expect(names).toEqual(
      expect.arrayContaining(['scope', 'capabilities', 'library', 'notes', 'annotations', 'reading', 'system'])
    );

    const scope = await client.callTool({ name: 'scope', arguments: { action: 'get' } });
    expect(scope.isError).not.toBe(true);
    expect(textOf(scope)).toContain('"kind": "none"');

    const capabilities = await client.callTool({ name: 'capabilities', arguments: { action: 'list' } });
    expect(capabilities.isError).not.toBe(true);
    expect(textOf(capabilities)).toContain('"name": "library"');

    const result = await client.callTool({ name: 'library', arguments: { action: 'list', limit: 5 } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('core_unavailable');

    await client.close();
  });

  it('无共享范围时读正文与整理都返回 scope_denied', async () => {
    const dataDir = tempDir();
    const client = await connect(dataDir);
    const result = await client.callTool({
      name: 'library',
      arguments: { action: 'pages', document_id: 'doc-x', from: 1, to: 1 }
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('scope_denied');

    const organize = await client.callTool({
      name: 'organize',
      arguments: {
        action: 'preview',
        kind: 'tags',
        items: [{ documentId: 'doc-x', tags: ['a'] }]
      }
    });
    expect(organize.isError).toBe(true);
    expect(textOf(organize)).toContain('scope_denied');
    await client.close();
  });
});
