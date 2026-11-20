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

  it('按 MCP client 隔离：指定 agent 优先，缺失回退默认 grant', async () => {
    await server.inject({
      method: 'PUT',
      url: '/api/v1/agent/scope',
      headers: headers(),
      payload: { kind: 'library', caps: ['read'] }
    });
    await server.inject({
      method: 'PUT',
      url: '/api/v1/agent/scope',
      headers: headers(),
      payload: {
        kind: 'documents',
        documentIds: ['dsh-doc'],
        caps: ['read', 'write'],
        agentName: 'dsh'
      }
    });

    const scoped = await server.inject({
      method: 'GET',
      url: '/api/v1/agent/scope?agent=dsh',
      headers: headers()
    });
    expect((scoped.json() as AgentScope).documentIds).toEqual(['dsh-doc']);

    const fallback = await server.inject({
      method: 'GET',
      url: '/api/v1/agent/scope?agent=claude-code',
      headers: headers()
    });
    expect((fallback.json() as AgentScope).kind).toBe('library');

    const defaultScope = await server.inject({
      method: 'GET',
      url: '/api/v1/agent/scope',
      headers: headers()
    });
    expect((defaultScope.json() as AgentScope).kind).toBe('library');

    await server.inject({
      method: 'DELETE',
      url: '/api/v1/agent/scope?agent=dsh',
      headers: headers()
    });
    const dshAfter = await server.inject({
      method: 'GET',
      url: '/api/v1/agent/scope?agent=dsh',
      headers: headers()
    });
    expect((dshAfter.json() as AgentScope).kind).toBe('library');
    await server.inject({ method: 'DELETE', url: '/api/v1/agent/scope', headers: headers() });
  });

  it('scope 写 agent_grants 表，不再写 settings', async () => {
    const put = await server.inject({
      method: 'PUT',
      url: '/api/v1/agent/scope',
      headers: headers(),
      payload: { kind: 'library', caps: ['read', 'write'] }
    });
    expect(put.statusCode).toBe(200);
    const grant = store.getActiveAgentGrant();
    expect(grant).toMatchObject({ kind: 'library', caps: ['read', 'write'] });
    expect(store.getSettings()['agent.scope']).toBeUndefined();
    await server.inject({ method: 'DELETE', url: '/api/v1/agent/scope', headers: headers() });
    expect(store.getActiveAgentGrant()).toBeNull();
  });

  it('旧 settings.agent.scope 下次启动迁入表并删除旧键', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'studianda-agent-scope-migrate-'));
    try {
      const first = new Store(dir);
      first.updateSettings({
        'agent.scope': JSON.stringify({
          kind: 'documents',
          documentIds: ['doc-1'],
          page: 3,
          selection: '原文',
          caps: ['read'],
          expiresAt: null
        })
      });
      first.close();
      const second = new Store(dir);
      try {
        expect(second.getActiveAgentGrant()).toMatchObject({
          kind: 'documents',
          documentIds: ['doc-1'],
          page: 3,
          selection: '原文',
          caps: ['read']
        });
        expect(second.getSettings()['agent.scope']).toBeUndefined();
      } finally {
        second.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
