import { describe, expect, it } from 'vitest';
import { ScopeError, executeTool, type CoreApi } from '../src/index.js';

function fakeApi() {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const api: CoreApi = {
    request: async (method, path, body) => {
      calls.push({ method, path, body });
      return { ok: true };
    }
  };
  return { api, calls };
}

describe('Agent 写工具（notes / annotations create）', () => {
  it('写笔记：origin=ai、agentName 与 documentId 一并传给 Core', async () => {
    const { api, calls } = fakeApi();
    await executeTool(
      'notes',
      { action: 'create', document_id: 'doc-1', page: 3, quote: '原文', content: '笔记正文' },
      { scope: { kind: 'library', caps: ['read', 'write'] }, api, agentName: 'DSH' }
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.path).toBe('/notes');
    expect(calls[0]?.body).toMatchObject({
      documentId: 'doc-1',
      page: 3,
      quote: '原文',
      content: '笔记正文',
      origin: 'ai',
      agentName: 'DSH'
    });
  });

  it('写批注：page 必填，origin=ai；颜色/样式可传', async () => {
    const { api, calls } = fakeApi();
    await executeTool(
      'annotations',
      { action: 'create', document_id: 'doc-1', page: 2, content: '批注', color: 'green' },
      { scope: { kind: 'documents', documentIds: ['doc-1'], caps: ['read', 'write'] }, api, agentName: 'Claude Code' }
    );
    expect(calls[0]?.path).toBe('/annotations');
    expect(calls[0]?.body).toMatchObject({
      documentId: 'doc-1',
      page: 2,
      content: '批注',
      color: 'green',
      style: 'highlight',
      origin: 'ai',
      agentName: 'Claude Code'
    });
  });

  it('只读范围时写入被拒绝，且不发请求', async () => {
    const { api, calls } = fakeApi();
    await expect(
      executeTool(
        'notes',
        { action: 'create', document_id: 'doc-1', content: 'x' },
        { scope: { kind: 'library', caps: ['read'] }, api, agentName: 'DSH' }
      )
    ).rejects.toBeInstanceOf(ScopeError);
    expect(calls).toHaveLength(0);
  });

  it('范围外文献写批注被拒绝', async () => {
    const { api } = fakeApi();
    await expect(
      executeTool(
        'annotations',
        { action: 'create', document_id: 'doc-2', page: 1, content: 'x' },
        { scope: { kind: 'documents', documentIds: ['doc-1'], caps: ['read', 'write'] }, api }
      )
    ).rejects.toBeInstanceOf(ScopeError);
  });
});
