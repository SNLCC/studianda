import { describe, expect, it } from 'vitest';
import { AskJobManager, type CoreApi } from '../src/index.js';

function pendingApi() {
  const calls: Array<{ path: string; body?: unknown; signal?: AbortSignal; resolve: (value: unknown) => void; reject: (error: Error) => void }> = [];
  const api = {
    request: (
      _method: string,
      path: string,
      body?: unknown,
      options?: { signal?: AbortSignal }
    ) =>
      new Promise((resolve, reject) => {
        calls.push({ path, body, signal: options?.signal, resolve, reject });
        options?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })
  } as unknown as CoreApi;
  return { api, calls };
}

describe('AskJobManager（MCP ask 异步任务）', () => {
  it('start 返回 running；完成后 status 拿到结果', async () => {
    const manager = new AskJobManager();
    const { api, calls } = pendingApi();
    const started = manager.start(
      api,
      { documentId: 'doc-1', question: '这篇文章说什么？', page: 2 },
      'dsh'
    );
    expect(started.state).toBe('running');
    expect(manager.get(started.id, 'dsh')?.state).toBe('running');
    expect(calls[0]?.path).toBe('/chat/ask');
    expect(calls[0]?.body).toMatchObject({ documentId: 'doc-1', question: '这篇文章说什么？', page: 2 });

    calls[0]!.resolve({ answer: '回答', sources: [] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const done = manager.get(started.id, 'dsh');
    expect(done?.state).toBe('succeeded');
    expect(done?.result).toMatchObject({ answer: '回答' });
  });

  it('cancel 中止请求，状态保持 cancelled', async () => {
    const manager = new AskJobManager();
    const { api } = pendingApi();
    const started = manager.start(api, { documentId: 'doc-1', question: 'q' }, 'dsh');
    const cancelled = manager.cancel(started.id, 'dsh');
    expect(cancelled?.state).toBe('cancelled');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(manager.get(started.id, 'dsh')?.state).toBe('cancelled');
  });

  it('job 按 client 隔离；并发上限生效', () => {
    const manager = new AskJobManager();
    const { api } = pendingApi();
    const job = manager.start(api, { documentId: 'doc-1', question: 'q' }, 'dsh');
    expect(manager.get(job.id, 'claude')).toBeNull();
    expect(manager.cancel(job.id, 'claude')).toBeNull();
    for (let index = 0; index < 3; index += 1) {
      manager.start(api, { documentId: 'doc-1', question: `q${index}` }, 'dsh');
    }
    expect(() =>
      manager.start(api, { documentId: 'doc-1', question: 'overflow' }, 'dsh')
    ).toThrow('同时最多');
    for (const snapshot of manager.list('dsh')) manager.cancel(snapshot.id, 'dsh');
  });
});
