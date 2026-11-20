import { describe, expect, it } from 'vitest';
import { AskJobManager, type CoreApi } from '../src/index.js';

function fakeJobsApi() {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const state: {
    status: string;
    result?: unknown;
    error?: string;
    chatResolve: (value: unknown) => void;
    chatReject: (error: Error) => void;
  } = {
    status: 'running',
    chatResolve: () => undefined,
    chatReject: () => undefined
  };
  let chatStarted = false;
  const chat = () =>
    new Promise((resolve, reject) => {
      state.chatResolve = resolve;
      state.chatReject = reject;
      chatStarted = true;
    });
  const snapshot = () => ({
    id: 'j1',
    status: state.status,
    created: '2026-01-01T00:00:00.000Z',
    updated: '2026-01-01T00:00:00.000Z',
    ...(state.result !== undefined ? { result: state.result } : {}),
    ...(state.error !== undefined ? { error: state.error } : {})
  });
  const api = {
    request: async (
      method: string,
      path: string,
      body?: unknown,
      options?: { signal?: AbortSignal }
    ) => {
      calls.push({ method, path, body });
      if (method === 'POST' && path === '/agent/jobs') {
        return { id: 'j1', status: 'running', created: '2026-01-01T00:00:00.000Z' };
      }
      if (method === 'POST' && path === '/chat/ask') {
        const promise = chat();
        options?.signal?.addEventListener('abort', () => state.chatReject(new Error('aborted')));
        return promise;
      }
      if (method === 'POST' && path === '/agent/jobs/j1/finish') {
        const update = body as { status: string; result?: unknown; error?: string };
        state.status = update.status;
        state.result = update.result;
        state.error = update.error;
        return snapshot();
      }
      if (method === 'POST' && path === '/agent/jobs/j1/cancel') {
        state.status = 'cancelled';
        return snapshot();
      }
      if (method === 'GET' && path.startsWith('/agent/jobs/j1?')) {
        return snapshot();
      }
      if (method === 'GET' && path.startsWith('/agent/jobs?')) {
        return [snapshot()];
      }
      throw new Error(`unexpected request: ${method} ${path}`);
    }
  } as unknown as CoreApi;
  return { api, calls, state, chatStarted: () => chatStarted };
}

describe('AskJobManager（Core 持久化）', () => {
  it('start 落 Core job；完成时 finish=succeeded，status 可查结果', async () => {
    const manager = new AskJobManager();
    const { api, calls, state } = fakeJobsApi();
    const started = await manager.start(
      api,
      { documentId: 'doc-1', question: '这篇文章说什么？', page: 2 },
      'dsh'
    );
    expect(started.id).toBe('j1');
    expect(started.state).toBe('running');
    expect(calls[0]?.path).toBe('/agent/jobs');
    expect(calls[0]?.body).toMatchObject({ kind: 'ask', agentName: 'dsh', documentId: 'doc-1' });

    state.chatResolve({ answer: '回答', sources: [] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const finish = calls.find((call) => call.path === '/agent/jobs/j1/finish');
    expect(finish?.body).toMatchObject({ status: 'succeeded' });
    const done = await manager.get(api, 'j1', 'dsh');
    expect(done.state).toBe('succeeded');
    expect(done.result).toMatchObject({ answer: '回答' });
  });

  it('needs_confirmation 写为独立状态', async () => {
    const manager = new AskJobManager();
    const { api, calls, state } = fakeJobsApi();
    await manager.start(api, { documentId: 'doc-1', question: 'q' }, 'dsh');
    state.chatResolve({ needs_confirmation: true, answer: '' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      calls.find((call) => call.path === '/agent/jobs/j1/finish')?.body
    ).toMatchObject({ status: 'needs_confirmation' });
  });

  it('cancel 走 Core cancel 并中止本地请求', async () => {
    const manager = new AskJobManager();
    const { api, calls } = fakeJobsApi();
    await manager.start(api, { documentId: 'doc-1', question: 'q' }, 'dsh');
    const cancelled = await manager.cancel(api, 'j1', 'dsh');
    expect(cancelled.state).toBe('cancelled');
    expect(calls.some((call) => call.path === '/agent/jobs/j1/cancel')).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it('OCR 任务跳过已有 OCR/文本页，只识别缺页并落结果', async () => {    const calls: Array<{ path: string; body?: unknown }> = [];
    const api = {
      request: async (method: string, path: string, body?: unknown) => {
        calls.push({ path, body });
        if (method === 'POST' && path === '/agent/jobs') {
          return { id: 'j2', status: 'running', created: 'c', updated: 'c' };
        }
        if (method === 'GET' && path === '/documents/doc-1') return { pages: 3 };
        if (method === 'GET' && path === '/documents/doc-1/pages/1/text') {
          return { text: '', origin: 'native' };
        }
        if (method === 'GET' && path === '/documents/doc-1/pages/2/text') {
          return { text: '已有文本', origin: 'native' };
        }
        if (method === 'GET' && path === '/documents/doc-1/pages/3/text') {
          return { text: '已有 OCR', origin: 'ocr' };
        }
        if (method === 'POST' && path === '/documents/doc-1/ocr/pages/1') {
          return { text: '识别结果' };
        }
        if (method === 'POST' && path === '/agent/jobs/j2/finish') return { id: 'j2' };
        throw new Error(`unexpected request: ${method} ${path}`);
      }
    } as unknown as CoreApi;
    const manager = new AskJobManager();
    await manager.startOcr(api, { documentId: 'doc-1' }, 'dsh');
    await new Promise((resolve) => setTimeout(resolve, 0));
    const finish = calls.find((call) => call.path === '/agent/jobs/j2/finish');
    expect(finish?.body).toMatchObject({
      status: 'succeeded',
      result: { done: [1], skipped: [2, 3] }
    });
  });

  it('corpus_ask 透传 projectId 与 reading_scope=corpus', async () => {
    const calls: Array<{ path: string; body?: unknown }> = [];
    const api = {
      request: async (method: string, path: string, body?: unknown) => {
        calls.push({ path, body });
        if (method === 'POST' && path === '/agent/jobs') {
          return { id: 'j3', status: 'running', created: 'c', updated: 'c' };
        }
        if (method === 'POST' && path === '/chat/ask') return { answer: '跨文献回答' };
        if (method === 'POST' && path === '/agent/jobs/j3/finish') return { id: 'j3' };
        throw new Error(`unexpected request: ${method} ${path}`);
      }
    } as unknown as CoreApi;
    const manager = new AskJobManager();
    await manager.startCorpusAsk(
      api,
      { documentId: 'doc-1', question: '两篇的共同点？', projectId: 'p1' },
      'dsh'
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls[0]?.body).toMatchObject({ kind: 'corpus_ask', project_id: 'p1' });
    expect(calls.find((call) => call.path === '/chat/ask')?.body).toMatchObject({
      documentId: 'doc-1',
      projectId: 'p1',
      reading_scope: 'corpus'
    });
  });
});
