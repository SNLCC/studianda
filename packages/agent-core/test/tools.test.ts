import { describe, expect, it } from 'vitest';
import { AskJobManager, ScopeError, executeTool, type CoreApi } from '../src/index.js';

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

function routedApi(routes: Record<string, unknown>) {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const api = {
    request: async (method: string, path: string, body?: unknown) => {
      calls.push({ method, path, body });
      const key = `${method} ${path}`;
      if (!(key in routes)) throw new Error(`unexpected request: ${key}`);
      return routes[key];
    }
  } as unknown as CoreApi;
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

describe('Agent MCP-only 扩展：search 与笔记/批注生命周期', () => {
  it('检索结果按 documents scope 过滤', async () => {
    const { api, calls } = routedApi({
      'GET /library-search?q=web': [
        { kind: 'document', id: 'doc-1', documentId: 'doc-1', title: 'A' },
        { kind: 'document', id: 'doc-2', documentId: 'doc-2', title: 'B' }
      ]
    });
    const result = (await executeTool(
      'library',
      { action: 'search', query: 'web', limit: 10 },
      { scope: { kind: 'documents', documentIds: ['doc-1'] }, api }
    )) as { hits: Array<{ documentId: string }> };
    expect(calls[0]?.path).toBe('/library-search?q=web');
    expect(result.hits.map((hit) => hit.documentId)).toEqual(['doc-1']);
  });

  it('更新笔记：先校验归属，再 PATCH 内容', async () => {
    const { api, calls } = routedApi({
      'GET /documents/doc-1/notes': [{ id: 'n1' }],
      'PATCH /notes/n1': { id: 'n1', content: '新正文' }
    });
    await executeTool(
      'notes',
      { action: 'update', document_id: 'doc-1', note_id: 'n1', content: '新正文' },
      { scope: { kind: 'library', caps: ['read', 'write'] }, api, agentName: 'DSH' }
    );
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      'GET /documents/doc-1/notes',
      'PATCH /notes/n1'
    ]);
    expect(calls[1]?.body).toEqual({ content: '新正文' });
  });

  it('删除笔记走软删除；恢复批注查回收站', async () => {
    const notes = routedApi({
      'GET /documents/doc-1/notes': [{ id: 'n1' }],
      'DELETE /notes/n1': undefined
    });
    const deleted = (await executeTool(
      'notes',
      { action: 'delete', document_id: 'doc-1', note_id: 'n1' },
      { scope: { kind: 'library', caps: ['read', 'write'] }, api: notes.api }
    )) as { deleted: boolean };
    expect(deleted.deleted).toBe(true);

    const annotations = routedApi({
      'GET /documents/doc-1/annotations?trash=true': [{ id: 'a1' }],
      'POST /annotations/a1/restore': { ok: true }
    });
    await executeTool(
      'annotations',
      { action: 'restore', document_id: 'doc-1', annotation_id: 'a1' },
      { scope: { kind: 'library', caps: ['read', 'write'] }, api: annotations.api }
    );
    expect(annotations.calls[1]?.method).toBe('POST');
  });

  it('只读范围不能更新笔记，且不发任何请求', async () => {
    const { api, calls } = routedApi({});
    await expect(
      executeTool(
        'notes',
        { action: 'update', document_id: 'doc-1', note_id: 'n1', content: 'x' },
        { scope: { kind: 'library', caps: ['read'] }, api }
      )
    ).rejects.toBeInstanceOf(ScopeError);
    expect(calls).toHaveLength(0);
  });
});

describe('organize 扩展：文件夹 / 项目 / 排序 / 回收站', () => {
  it('创建文献文件夹（全库 + 写）', async () => {
    const { api, calls } = routedApi({
      'POST /folders': { id: 'f1', name: '新文件夹' }
    });
    const result = await executeTool(
      'organize',
      { action: 'folder_create', folder_name: '新文件夹' },
      { scope: { kind: 'library', caps: ['read', 'write'] }, api }
    );
    expect((result as { id: string }).id).toBe('f1');
    expect(calls[0]?.body).toEqual({ name: '新文件夹' });
  });

  it('项目批量加文献逐篇调用，先校验 scope', async () => {
    const { api, calls } = routedApi({
      'POST /projects/p1/documents': { ok: true }
    });
    const result = (await executeTool(
      'organize',
      {
        action: 'project_add_documents',
        project_id: 'p1',
        document_ids: ['doc-1', 'doc-2']
      },
      {
        scope: { kind: 'documents', documentIds: ['doc-1', 'doc-2'], caps: ['read', 'write'] },
        api
      }
    )) as { changed: number };
    expect(result.changed).toBe(2);
    expect(calls.map((call) => call.body)).toEqual([
      { documentId: 'doc-1' },
      { documentId: 'doc-2' }
    ]);
  });

  it('排序与软删除文献', async () => {
    const move = routedApi({
      'POST /documents/doc-1/move': { id: 'doc-1' }
    });
    await executeTool(
      'organize',
      { action: 'reorder_documents', document_id: 'doc-1', after_id: 'doc-2' },
      { scope: { kind: 'library', caps: ['read', 'write'] }, api: move.api }
    );
    expect(move.calls[0]?.body).toEqual({ beforeId: null, afterId: 'doc-2' });

    const trash = routedApi({
      'DELETE /documents/doc-1': { ok: true }
    });
    await executeTool(
      'organize',
      { action: 'trash_document', document_id: 'doc-1' },
      { scope: { kind: 'library', caps: ['read', 'write'] }, api: trash.api }
    );
    expect(trash.calls[0]?.method).toBe('DELETE');
  });
});

describe('compute 异步任务', () => {
  it('启动全书摘要（write）与查询翻译进度（read）', async () => {
    const summary = routedApi({
      'POST /documents/doc-1/book-summary/start': { job: { status: 'running' } }
    });
    await executeTool(
      'compute',
      { action: 'start', kind: 'summary', document_id: 'doc-1' },
      {
        scope: { kind: 'documents', documentIds: ['doc-1'], caps: ['read', 'write'] },
        api: summary.api
      }
    );
    expect(summary.calls[0]?.path).toBe('/documents/doc-1/book-summary/start');

    const progress = routedApi({
      'GET /documents/doc-1/translation/progress': { done: 1, total: 8 }
    });
    const result = (await executeTool(
      'compute',
      { action: 'status', kind: 'translate', document_id: 'doc-1' },
      { scope: { kind: 'documents', documentIds: ['doc-1'], caps: ['read'] }, api: progress.api }
    )) as { done: number };
    expect(result.done).toBe(1);
  });

  it('只读范围不能启动生成任务', async () => {
    const { api, calls } = routedApi({});
    await expect(
      executeTool(
        'compute',
        { action: 'start', kind: 'summary', document_id: 'doc-1' },
        { scope: { kind: 'documents', documentIds: ['doc-1'], caps: ['read'] }, api }
      )
    ).rejects.toBeInstanceOf(ScopeError);
    expect(calls).toHaveLength(0);
  });

  it('ask 走异步 job：start 后可用 job_id 查结果', async () => {
    const { api } = routedApi({});
    const jobs = {
      start: async () => ({
        id: 'j1',
        state: 'running',
        createdAt: 'c',
        updatedAt: 'c'
      }),
      get: async () => ({
        id: 'j1',
        state: 'succeeded',
        createdAt: 'c',
        updatedAt: 'c',
        result: { answer: '回答' }
      }),
      cancel: async () => ({ id: 'j1', state: 'cancelled', createdAt: 'c', updatedAt: 'c' })
    } as unknown as AskJobManager;
    const started = (await executeTool(
      'compute',
      { action: 'start', kind: 'ask', document_id: 'doc-1', question: '这篇文章说什么？' },
      {
        scope: { kind: 'documents', documentIds: ['doc-1'], caps: ['read'] },
        api,
        agentName: 'dsh',
        jobs
      }
    )) as { id: string; state: string };
    expect(started.state).toBe('running');
    const status = (await executeTool(
      'compute',
      { action: 'status', kind: 'ask', document_id: 'doc-1', job_id: started.id },
      {
        scope: { kind: 'documents', documentIds: ['doc-1'], caps: ['read'] },
        api,
        agentName: 'dsh',
        jobs
      }
    )) as { state: string; result?: { answer?: string } };
    expect(status.state).toBe('succeeded');
    expect(status.result?.answer).toBe('回答');
  });

  it('OCR 任务要求 write，并传 documentId/pages', async () => {
    const { api } = routedApi({});
    let startedWith: unknown = null;
    const jobs = {
      startOcr: async (_api: unknown, input: unknown) => {
        startedWith = input;
        return { id: 'j2', state: 'running', createdAt: 'c', updatedAt: 'c' };
      }
    } as unknown as AskJobManager;
    const result = (await executeTool(
      'compute',
      { action: 'start', kind: 'ocr', document_id: 'doc-1', pages: [1, 2] },
      {
        scope: { kind: 'documents', documentIds: ['doc-1'], caps: ['read', 'write'] },
        api,
        agentName: 'dsh',
        jobs
      }
    )) as { id: string };
    expect(result.id).toBe('j2');
    expect(startedWith).toMatchObject({ documentId: 'doc-1', pages: [1, 2] });

    await expect(
      executeTool(
        'compute',
        { action: 'start', kind: 'ocr', document_id: 'doc-1' },
        {
          scope: { kind: 'documents', documentIds: ['doc-1'], caps: ['read'] },
          api,
          jobs
        }
      )
    ).rejects.toBeInstanceOf(ScopeError);
  });

  it('corpus_ask 校验每篇 scope 并交给 job 管理器', async () => {
    const { api } = routedApi({});
    let startedWith: unknown = null;
    const jobs = {
      startCorpusAsk: async (_api: unknown, input: unknown) => {
        startedWith = input;
        return { id: 'j3', state: 'running', createdAt: 'c', updatedAt: 'c' };
      }
    } as unknown as AskJobManager;
    const result = (await executeTool(
      'compute',
      {
        action: 'start',
        kind: 'corpus_ask',
        question: '共同点？',
        document_ids: ['doc-1', 'doc-2']
      },
      {
        scope: { kind: 'documents', documentIds: ['doc-1', 'doc-2'], caps: ['read'] },
        api,
        agentName: 'dsh',
        jobs
      }
    )) as { id: string };
    expect(result.id).toBe('j3');
    expect(startedWith).toMatchObject({
      documentId: 'doc-1',
      documentIds: ['doc-1', 'doc-2'],
      question: '共同点？'
    });

    await expect(
      executeTool(
        'compute',
        {
          action: 'start',
          kind: 'corpus_ask',
          question: 'q',
          document_ids: ['doc-1', 'doc-2']
        },
        {
          scope: { kind: 'documents', documentIds: ['doc-1'], caps: ['read'] },
          api,
          jobs
        }
      )
    ).rejects.toBeInstanceOf(ScopeError);
  });

  it('web_search 走 compute，不需要文档但需要 scope', async () => {    const { api, calls } = routedApi({
      'POST /web-search/search': { results: [] }
    });
    await executeTool(
      'compute',
      { action: 'web_search', kind: 'web_search', query: '韦伯 责任伦理' },
      {
        scope: { kind: 'documents', documentIds: ['doc-1'], caps: ['read'] },
        api
      }
    );
    expect(calls[0]?.path).toBe('/web-search/search');
    expect(calls[0]?.body).toEqual({ query: '韦伯 责任伦理' });
  });
});

describe('system 只读维护信息', () => {  it('health 任意 scope；backups/file_health 需要全库', async () => {
    const calls: Array<{ method: string; path: string }> = [];
    const api = {
      request: async (method: string, path: string) => {
        calls.push({ method, path });
        return { ok: true };
      }
    } as unknown as CoreApi;
    await executeTool('system', { action: 'health' }, { scope: { kind: 'none' }, api });
    await executeTool(
      'system',
      { action: 'backups' },
      { scope: { kind: 'library', caps: ['read'] }, api }
    );
    await executeTool(
      'system',
      { action: 'file_health' },
      { scope: { kind: 'library', caps: ['read'] }, api }
    );
    expect(calls.map((call) => call.path)).toEqual([
      '/health',
      '/backups',
      '/maintenance/file-health'
    ]);
    await expect(
      executeTool('system', { action: 'backups' }, { scope: { kind: 'none' }, api })
    ).rejects.toBeInstanceOf(ScopeError);
  });
});

describe('reading 扩展', () => {
  it('导航 / 译文摘要 / 流程列表', async () => {    const calls: Array<{ method: string; path: string }> = [];
    const api = {
      request: async (method: string, path: string) => {
        calls.push({ method, path });
        return { ok: true };
      }
    } as unknown as CoreApi;
    const scope = { kind: 'library' as const, caps: ['read'] };
    await executeTool(
      'reading',
      { action: 'navigation', document_id: 'doc-1' },
      { scope, api }
    );
    await executeTool(
      'reading',
      { action: 'translation', document_id: 'doc-1' },
      { scope, api }
    );
    await executeTool('reading', { action: 'flows' }, { scope, api });
    expect(calls.map((call) => call.path)).toEqual([
      '/documents/doc-1/navigation',
      '/documents/doc-1/translation/summary',
      '/flows'
    ]);
  });
});

describe('MCP progress 回调', () => {
  it('多页读取按页报告 done/total', async () => {
    const progress: Array<[number, number]> = [];
    const { api } = routedApi({
      'GET /documents/doc-1/pages/1/text': { page: 1, text: 'a', origin: 'native' },
      'GET /documents/doc-1/pages/2/text': { page: 2, text: 'b', origin: 'native' }
    });
    await executeTool(
      'library',
      { action: 'pages', document_id: 'doc-1', from: 1, to: 2 },
      {
        scope: { kind: 'library', caps: ['read'] },
        api,
        onProgress: (done, total) => progress.push([done, total])
      }
    );
    expect(progress).toEqual([
      [1, 2],
      [2, 2]
    ]);
  });
});

describe('独立笔记与参考文献', () => {
  it('create 省略 document_id 即独立笔记', async () => {
    const { api, calls } = routedApi({ 'POST /notes': { id: 'n1' } });
    await executeTool(
      'notes',
      { action: 'create', content: '独立想法' },
      { scope: { kind: 'library', caps: ['read', 'write'] }, api, agentName: 'dsh' }
    );
    expect(calls[0]?.body).toMatchObject({
      documentId: '',
      page: 0,
      content: '独立想法',
      origin: 'ai'
    });
  });

  it('update 独立笔记先查 /notes/standalone', async () => {
    const { api, calls } = routedApi({
      'GET /notes/standalone': [{ id: 'n1' }],
      'PATCH /notes/n1': { id: 'n1', content: '改' }
    });
    await executeTool(
      'notes',
      { action: 'update', note_id: 'n1', content: '改' },
      { scope: { kind: 'library', caps: ['read', 'write'] }, api }
    );
    expect(calls.map((call) => call.path)).toEqual([
      '/notes/standalone',
      '/notes/n1'
    ]);
  });

  it('reference_add 写入门参考文献条目', async () => {
    const { api, calls } = routedApi({
      'POST /documents/doc-1/references/entries': { id: 'r1' }
    });
    await executeTool(
      'organize',
      {
        action: 'reference_add',
        document_id: 'doc-1',
        entry: { title: '责任伦理', authors: ['韦伯'] }
      },
      {
        scope: { kind: 'documents', documentIds: ['doc-1'], caps: ['read', 'write'] },
        api
      }
    );
    expect(calls[0]?.body).toEqual({ title: '责任伦理', authors: ['韦伯'] });
  });
});
