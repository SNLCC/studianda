import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentChangeApplyResult } from '@studianda/shared';
import { SecretStore } from '../src/secrets.js';
import { buildServer } from '../src/server.js';
import { Store } from '../src/store.js';

const TEST_PDF =
  process.env.STUDIANDA_TEST_PDF ?? path.resolve(import.meta.dirname, 'fixtures/sample-paper.pdf');
const token = 'agent-changes-token';
const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-agent-changes-'));
const store = new Store(dataDir);
const server = buildServer({ token, version: 'test', store, secrets: new SecretStore() });
let documentId = '';

beforeAll(async () => {
  documentId = (await store.importDocument(TEST_PDF)).id;
});

afterAll(async () => {
  await server.close();
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const headers = (): Record<string, string> => ({
  'x-studianda-token': token,
  'content-type': 'application/json'
});

describe('Agent 变更集（preview / apply / undo）', () => {
  it('标签：预览不写库，apply 后落库并记审计，undo 恢复', async () => {
    const payload = {
      action: 'tags' as const,
      items: [{ documentId, tags: ['agent', 'p1'] }]
    };
    const preview = await server.inject({
      method: 'POST',
      url: '/api/v1/agent/changes/preview',
      headers: headers(),
      payload
    });
    expect(preview.statusCode).toBe(200);
    const previewBody = preview.json() as { changed: number; items: Array<{ before: { tags: string[] } }> };
    expect(previewBody.changed).toBe(1);
    expect(previewBody.items[0]?.before.tags).toEqual([]);
    expect(store.getDocument(documentId)?.tags).toEqual([]);

    const applied = await server.inject({
      method: 'POST',
      url: '/api/v1/agent/changes/apply',
      headers: headers(),
      payload: { ...payload, agentName: 'DSH' }
    });
    expect(applied.statusCode).toBe(200);
    const result = applied.json() as AgentChangeApplyResult;
    expect(result.applied).toBe(1);
    expect(result.operationId).toBeTruthy();
    expect(store.getDocument(documentId)?.tags).toEqual(['agent', 'p1']);
    const operation = store.getAgentOperation(result.operationId);
    expect(operation?.status).toBe('applied');
    expect(operation?.agent_name).toBe('DSH');

    const history = await server.inject({
      method: 'GET',
      url: '/api/v1/agent/operations',
      headers: headers()
    });
    expect(history.statusCode).toBe(200);
    expect(
      (history.json() as Array<{ id: string; status: string }>).some(
        (row) => row.id === result.operationId && row.status === 'applied'
      )
    ).toBe(true);

    const undone = await server.inject({
      method: 'POST',
      url: '/api/v1/agent/changes/undo',
      headers: headers(),
      payload: { operationId: result.operationId }
    });
    expect(undone.statusCode).toBe(200);
    expect(store.getDocument(documentId)?.tags).toEqual([]);
    expect(store.getAgentOperation(result.operationId)?.status).toBe('undone');

    const again = await server.inject({
      method: 'POST',
      url: '/api/v1/agent/changes/undo',
      headers: headers(),
      payload: { operationId: result.operationId }
    });
    expect(again.statusCode).toBe(400);
  });

  it('题录：改标题可撤销回原标题', async () => {
    const original = store.getDocument(documentId)?.name ?? '';
    const applied = await server.inject({
      method: 'POST',
      url: '/api/v1/agent/changes/apply',
      headers: headers(),
      payload: {
        action: 'metadata',
        items: [{ documentId, metadata: { name: 'Agent 改过的标题' } }],
        agentName: 'Claude Code'
      }
    });
    const result = applied.json() as AgentChangeApplyResult;
    expect(store.getDocument(documentId)?.name).toBe('Agent 改过的标题');
    const undone = await server.inject({
      method: 'POST',
      url: '/api/v1/agent/changes/undo',
      headers: headers(),
      payload: { operationId: result.operationId }
    });
    expect(undone.statusCode).toBe(200);
    expect(store.getDocument(documentId)?.name).toBe(original);
  });

  it('批量上限与空/非法输入返回 400', async () => {
    const many = Array.from({ length: 21 }, (_, index) => ({
      documentId: `doc-${index}`,
      tags: []
    }));
    for (const payload of [
      { action: 'tags', items: many },
      { action: 'tags', items: [] },
      { action: 'unknown', items: [{ documentId, tags: [] }] },
      { action: 'tags', items: [{ documentId: 'missing', tags: [] }] }
    ]) {
      const response = await server.inject({
        method: 'POST',
        url: '/api/v1/agent/changes/preview',
        headers: headers(),
        payload
      });
      expect(response.statusCode, JSON.stringify(payload).slice(0, 80)).toBe(400);
    }
  });
});
