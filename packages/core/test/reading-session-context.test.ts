import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { readDocumentChatSessions, writeDocumentChatSessions } from '../src/document-chat-sessions.js';
import {
  prepareReadingSessionContext,
  resetReadingCompactionBackoff,
  READING_CONTEXT_KEEP_PAIRS
} from '../src/reading-session-context.js';
import type { ReadingChatConfig } from '../src/reading-chat.js';
import { Store } from '../src/store.js';

/**
 * 阅读伙伴会话摘要压缩：
 * - 有 sessionId 时读会话完整消息，超预算把较早轮次压缩进会话摘要；
 * - 摘要写回 settings 会话清单，并记录 summaryUpto；
 * - 摘要只作为上下文提示，不会混进 history/sources（本模块只返回 history+summary 字符串）。
 */

const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-reading-context-'));
const store = new Store(dataDir);
const config: ReadingChatConfig = {
  baseUrl: 'http://127.0.0.1:9/v1',
  apiKey: 'k',
  model: 'mock'
};
let documentId = '';

beforeAll(async () => {
  const pdf = await PDFDocument.create();
  pdf.addPage([200, 300]);
  const file = path.join(dataDir, 'context.pdf');
  writeFileSync(file, await pdf.save());
  const document = await store.importDocument(file, undefined, true);
  documentId = document.id;
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetReadingCompactionBackoff();
});

afterAll(() => {
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function seedPairs(sessionId: string, count: number): void {
  for (let index = 1; index <= count; index += 1) {
    store.addMessage({
      documentId,
      role: 'user',
      content: `第 ${index} 个问题：${'价值信念的测量口径是什么？'.repeat(6)}`,
      metadata: { sessionId }
    });
    store.addMessage({
      documentId,
      role: 'assistant',
      content: `第 ${index} 个回答：${'文中用调查题项测量，并在附录给出编码方式。'.repeat(8)}`,
      metadata: { sessionId }
    });
  }
}

describe('阅读会话上下文压缩', () => {
  it('未超预算：完整带回最近轮次，不调用模型、不产生摘要', async () => {
    const sessionId = 'small';
    seedPairs(sessionId, 3);
    writeDocumentChatSessions(store, documentId, [
      { id: sessionId, title: '小会话', created: 'x', updated: 'x' }
    ]);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const prepared = await prepareReadingSessionContext({
      store,
      config,
      documentId,
      sessionId
    });
    expect(prepared.history).toHaveLength(3);
    expect(prepared.summary).toBe('');
    expect(prepared.compactedTurns).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(
      readDocumentChatSessions(store, documentId).find((s) => s.id === sessionId)?.contextSummary
    ).toBeUndefined();
  });

  it('超预算：压缩较早轮次，摘要写回会话记录，后续不重复压缩', async () => {
    const sessionId = 'big';
    seedPairs(sessionId, 12);
    writeDocumentChatSessions(store, documentId, [
      { id: sessionId, title: '大会话', created: 'x', updated: 'x' }
    ]);
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '早期摘要：用户关注测量口径。' } }] })
    }));
    vi.stubGlobal('fetch', fetchMock);

    const prepared = await prepareReadingSessionContext({
      store,
      config,
      documentId,
      sessionId
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(prepared.compactedTurns).toBeGreaterThan(0);
    expect(prepared.history.length).toBeLessThanOrEqual(READING_CONTEXT_KEEP_PAIRS);
    expect(prepared.summary).toContain('早期摘要');
    expect(prepared.notice).toContain('摘要');
    const saved = readDocumentChatSessions(store, documentId).find((s) => s.id === sessionId)!;
    expect(saved.contextSummary).toContain('早期摘要');
    expect(saved.summaryUpto).toBeGreaterThan(0);

    // 已压缩的部分不会再进入 history；在没有新增轮次时也不会再次调用压缩模型。
    const again = await prepareReadingSessionContext({
      store,
      config,
      documentId,
      sessionId
    });
    expect(again.compactedTurns).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(again.summary).toContain('早期摘要');
  });

  it('压缩期间历史被修改：丢弃摘要写回，只使用最近轮次', async () => {
    const sessionId = 'race';
    seedPairs(sessionId, 12);
    writeDocumentChatSessions(store, documentId, [
      { id: sessionId, title: '并发会话', created: 'x', updated: 'x' }
    ]);
    const firstUser = store.listMessages(documentId, { sessionId })[0]!;
    const fetchMock = vi.fn(async () => {
      // 模拟另一个窗口在模型压缩期间编辑了第一条用户消息（其后的消息被删除）。
      store.editDocumentUserMessage(documentId, firstUser.id, '压缩期间被改的问题', sessionId);
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: '不应写回的旧摘要' } }] })
      } as unknown as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
    const prepared = await prepareReadingSessionContext({
      store,
      config,
      documentId,
      sessionId
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(prepared.compactedTurns).toBe(0);
    expect(prepared.summary).toBe('');
    expect(prepared.notice).toContain('丢弃');
    expect(
      readDocumentChatSessions(store, documentId).find((s) => s.id === sessionId)?.contextSummary
    ).toBeUndefined();
  });

  it('压缩失败：退回最近轮次 + 旧摘要并给提示，5 分钟内不重试', async () => {
    const sessionId = 'failing';
    seedPairs(sessionId, 12);
    writeDocumentChatSessions(store, documentId, [
      { id: sessionId, title: '失败会话', created: 'x', updated: 'x' }
    ]);
    const fetchMock = vi.fn(async () => {
      throw new Error('模型不可用');
    });
    vi.stubGlobal('fetch', fetchMock);
    const prepared = await prepareReadingSessionContext({
      store,
      config,
      documentId,
      sessionId
    });
    expect(prepared.compactedTurns).toBe(0);
    expect(prepared.history.length).toBeLessThanOrEqual(READING_CONTEXT_KEEP_PAIRS);
    expect(prepared.notice).toContain('压缩失败');
    expect(
      readDocumentChatSessions(store, documentId).find((s) => s.id === sessionId)?.contextSummary
    ).toBeUndefined();

    const retry = await prepareReadingSessionContext({
      store,
      config,
      documentId,
      sessionId
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(retry.notice).toContain('刚失败过');
  });

  it('没有 sessionId：退回客户端带来的最近 N 轮（旧行为）', async () => {
    const prepared = await prepareReadingSessionContext({
      store,
      config,
      documentId,
      fallbackHistory: [{ question: '上一问', answer: '上一答' }]
    });
    expect(prepared.history).toEqual([{ question: '上一问', answer: '上一答' }]);
    expect(prepared.summary).toBe('');
  });
});
