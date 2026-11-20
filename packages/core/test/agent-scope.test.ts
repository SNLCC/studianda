import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { AgentScope } from '@studianda/shared';
import { SecretStore } from '../src/secrets.js';
import { buildServer } from '../src/server.js';
import { Store } from '../src/store.js';

const token = 'agent-scope-token';
const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-agent-scope-'));
const store = new Store(dataDir);
const server = buildServer({ token, version: 'test', store, secrets: new SecretStore() });

afterAll(async () => {
  await server.close();
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const headers = (): Record<string, string> => ({ 'x-studianda-token': token });

describe('Agent 共享范围（settings 单一活跃 scope）', () => {
  it('默认 none；设置 documents 后读回；删除后回到 none', async () => {
    const initial = await server.inject({ method: 'GET', url: '/api/v1/agent/scope', headers: headers() });
    expect(initial.statusCode).toBe(200);
    expect((initial.json() as AgentScope).kind).toBe('none');

    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const put = await server.inject({
      method: 'PUT',
      url: '/api/v1/agent/scope',
      headers: headers(),
      payload: {
        kind: 'documents',
        documentIds: ['doc-1', 'doc-2', 'doc-1'],
        page: 12,
        selection: '选文',
        caps: ['read'],
        expiresAt
      }
    });
    expect(put.statusCode).toBe(200);
    const saved = put.json() as AgentScope;
    expect(saved).toMatchObject({
      kind: 'documents',
      documentIds: ['doc-1', 'doc-2'],
      page: 12,
      selection: '选文',
      caps: ['read'],
      expiresAt
    });

    const read = await server.inject({ method: 'GET', url: '/api/v1/agent/scope', headers: headers() });
    expect(read.json()).toEqual(saved);

    const cleared = await server.inject({ method: 'DELETE', url: '/api/v1/agent/scope', headers: headers() });
    expect((cleared.json() as AgentScope).kind).toBe('none');
  });

  it('library 默认 caps=read；非法输入返回 400', async () => {
    const ok = await server.inject({
      method: 'PUT',
      url: '/api/v1/agent/scope',
      headers: headers(),
      payload: { kind: 'library' }
    });
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as AgentScope).caps).toEqual(['read']);

    for (const payload of [
      { kind: 'unknown' },
      { kind: 'documents', documentIds: [] },
      { kind: 'library', expiresAt: new Date(Date.now() - 1000).toISOString() },
      { kind: 'library', caps: ['delete'] }
    ]) {
      const response = await server.inject({
        method: 'PUT',
        url: '/api/v1/agent/scope',
        headers: headers(),
        payload
      });
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
    }
  });
});
