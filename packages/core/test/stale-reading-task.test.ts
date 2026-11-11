import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { answerQuestion } from '../src/chat.js';
import { SecretStore } from '../src/secrets.js';
import { Store } from '../src/store.js';

/**
 * 真实 E2E 踩到：继续阅读的任务读完会被删除；界面旧消息再点「继续阅读」时带着同一个
 * taskId 重发，若被当成一次新的单篇阅读，就会用当前文献重读、并可能因输出上限报错。
 * 这里固定：任务不存在时如实说明，不重新读文献。
 */

const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-stale-task-'));
const store = new Store(dataDir);
const secrets = new SecretStore();

afterAll(() => {
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('继续阅读任务不存在', () => {
  it('带过期 taskId 时如实说明，不触发阅读或模型调用', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    try {
      const result = await answerQuestion(store, secrets, {
        question: '这两篇文献分别讨论什么？',
        documentId: 'missing-document',
        taskId: 'task-that-was-already-deleted'
      });
      expect(result.answer).toBeNull();
      expect(result.notice ?? '').toContain('进度已不存在');
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
