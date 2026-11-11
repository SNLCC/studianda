import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DocumentChatSessionRecord } from '@studianda/shared';
import { readDocumentChatSessions, writeDocumentChatSessions } from '../src/document-chat-sessions.js';
import { SecretStore } from '../src/secrets.js';
import { buildServer } from '../src/server.js';
import { Store } from '../src/store.js';

/**
 * 阅读伙伴多会话（不改表结构）：
 * - 会话清单存在 settings（JSON），随数据目录备份；
 * - 消息归属靠 metadata.sessionId；没有 sessionId 的旧消息归到 legacy；
 * - DELETE 会话会删掉该会话消息并从清单移除。
 */

const token = 'doc-chat-sessions-token';
const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-doc-chat-sessions-'));
const store = new Store(dataDir);
const server = buildServer({
  token,
  version: 'test-version',
  store,
  secrets: new SecretStore()
});
let documentId = '';

const headers = { 'x-studianda-token': token };

beforeAll(async () => {
  const pdf = await PDFDocument.create();
  pdf.addPage([200, 300]);
  const file = path.join(dataDir, 'sessions.pdf');
  writeFileSync(file, await pdf.save());
  const document = await store.importDocument(file, undefined, true);
  documentId = document.id;
});

afterAll(async () => {
  await server.close();
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('阅读伙伴会话清单与消息归属', () => {
  it('会话清单保存/读取（settings JSON，字段被规整）', async () => {
    const sessions: DocumentChatSessionRecord[] = [
      {
        id: 's1',
        title: '会话一',
        created: '2026-01-01T00:00:00.000Z',
        updated: '2026-01-01T00:00:00.000Z',
        contextSummary: '早期摘要：用户关注测量口径。',
        summaryUpto: 12
      },
      { id: 's2', title: '会话二', created: '2026-01-02T00:00:00.000Z', updated: '2026-01-02T00:00:00.000Z' }
    ];
    const saved = await server.inject({
      method: 'PUT',
      url: `/api/v1/documents/${encodeURIComponent(documentId)}/chat-sessions`,
      headers,
      payload: { sessions }
    });
    expect(saved.statusCode).toBe(200);
    expect((saved.json() as { sessions: DocumentChatSessionRecord[] }).sessions).toHaveLength(2);
    expect(
      (saved.json() as { sessions: DocumentChatSessionRecord[] }).sessions.find(
        (session) => session.id === 's1'
      )
    ).toMatchObject({ contextSummary: '早期摘要：用户关注测量口径。', summaryUpto: 12 });

    const listed = await server.inject({
      method: 'GET',
      url: `/api/v1/documents/${encodeURIComponent(documentId)}/chat-sessions`,
      headers
    });
    expect(listed.statusCode).toBe(200);
    expect(
      (listed.json() as { sessions: DocumentChatSessionRecord[] }).sessions.map((s) => s.id)
    ).toEqual(['s1', 's2']);
    // 清单落在 document_chat_sessions 表（随备份），不再写 settings JSON。
    expect(store.listDocumentChatSessions(documentId).map((s) => s.id)).toEqual(['s1', 's2']);
    expect(store.getSettings()[`doc-chat.sessions.${documentId}`]).toBeUndefined();
  });

  it('消息按 sessionId 过滤；没有 sessionId 的旧消息归到 legacy', async () => {
    store.deleteMessages(documentId);
    store.addMessage({ documentId, role: 'user', content: '旧消息无会话' });
    store.addMessage({
      documentId,
      role: 'assistant',
      content: 'legacy 新消息',
      metadata: { sessionId: 'legacy' }
    });
    store.addMessage({
      documentId,
      role: 'user',
      content: 's1 的问题',
      metadata: { sessionId: 's1' }
    });
    store.addMessage({
      documentId,
      role: 'assistant',
      content: 's1 的回答',
      metadata: { sessionId: 's1' }
    });
    store.addMessage({
      documentId,
      role: 'user',
      content: 's2 的问题',
      metadata: { sessionId: 's2' }
    });

    const s1 = await server.inject({
      method: 'GET',
      url: `/api/v1/documents/${encodeURIComponent(documentId)}/messages?sessionId=s1`,
      headers
    });
    expect((s1.json() as Array<{ content: string }>).map((m) => m.content)).toEqual([
      's1 的问题',
      's1 的回答'
    ]);

    const legacy = await server.inject({
      method: 'GET',
      url: `/api/v1/documents/${encodeURIComponent(documentId)}/messages?sessionId=legacy`,
      headers
    });
    expect((legacy.json() as Array<{ content: string }>).map((m) => m.content)).toEqual([
      '旧消息无会话',
      'legacy 新消息'
    ]);

    const all = await server.inject({
      method: 'GET',
      url: `/api/v1/documents/${encodeURIComponent(documentId)}/messages`,
      headers
    });
    expect((all.json() as unknown[]).length).toBe(5);
  });

  it('删除会话：删消息并从清单移除；legacy 只删没有 sessionId 的旧消息', async () => {
    const deleted = await server.inject({
      method: 'DELETE',
      url: `/api/v1/documents/${encodeURIComponent(documentId)}/chat-sessions/s1`,
      headers,
      payload: {}
    });
    expect(deleted.statusCode).toBe(200);
    const payload = deleted.json() as {
      ok: boolean;
      removed: number;
      sessions: DocumentChatSessionRecord[];
    };
    expect(payload.ok).toBe(true);
    expect(payload.removed).toBe(2);
    expect(payload.sessions.map((s) => s.id)).toEqual(['s2']);
    expect(store.listMessages(documentId).map((m) => m.content)).toEqual([
      '旧消息无会话',
      'legacy 新消息',
      's2 的问题'
    ]);

    const deletedLegacy = await server.inject({
      method: 'DELETE',
      url: `/api/v1/documents/${encodeURIComponent(documentId)}/chat-sessions/legacy`,
      headers,
      payload: {}
    });
    expect((deletedLegacy.json() as { removed: number }).removed).toBe(2);
    expect(store.listMessages(documentId).map((m) => m.content)).toEqual(['s2 的问题']);
  });

  it('消息级操作按 sessionId 限定：只删/改该会话，不碰其它会话', async () => {
    store.deleteMessages(documentId);
    store.addMessage({
      documentId,
      role: 'user',
      content: 's1 问题一',
      metadata: { sessionId: 's1' }
    });
    store.addMessage({
      documentId,
      role: 'assistant',
      content: 's1 回答一',
      metadata: { sessionId: 's1' }
    });
    store.addMessage({
      documentId,
      role: 'user',
      content: 's2 问题',
      metadata: { sessionId: 's2' }
    });
    store.addMessage({
      documentId,
      role: 'assistant',
      content: 's2 回答',
      metadata: { sessionId: 's2' }
    });
    const s1User2 = store.addMessage({
      documentId,
      role: 'user',
      content: 's1 问题二',
      metadata: { sessionId: 's1' }
    });
    store.addMessage({
      documentId,
      role: 'assistant',
      content: 's1 回答二',
      metadata: { sessionId: 's1' }
    });

    // 重新生成 s1：只删 s1 最后一条 user 之后的 s1 回答，s2 消息不受影响。
    const rewind = await server.inject({
      method: 'POST',
      url: `/api/v1/documents/${encodeURIComponent(documentId)}/messages/rewind`,
      headers,
      payload: { sessionId: 's1' }
    });
    expect(rewind.statusCode).toBe(200);
    expect((rewind.json() as { content: string; removed: number }).content).toBe('s1 问题二');
    expect((rewind.json() as { removed: number }).removed).toBe(1);
    expect(store.listMessages(documentId, { sessionId: 's2' })).toHaveLength(2);

    // 编辑 s1 的用户消息：只删 s1 内其后的消息。
    const edit = await server.inject({
      method: 'PATCH',
      url: `/api/v1/documents/${encodeURIComponent(documentId)}/messages/${s1User2.id}`,
      headers,
      payload: { content: 's1 改后问题二', sessionId: 's1' }
    });
    expect(edit.statusCode).toBe(200);
    expect(store.listMessages(documentId, { sessionId: 's2' })).toHaveLength(2);
    expect(
      store.listMessages(documentId, { sessionId: 's1' }).map((m) => m.content)
    ).toContain('s1 改后问题二');
  });

  it('编辑/删除到被摘要覆盖的消息时清掉会话摘要', async () => {
    store.deleteMessages(documentId);
    const user1 = store.addMessage({
      documentId,
      role: 'user',
      content: '被摘要覆盖的问题',
      metadata: { sessionId: 'sum' }
    });
    store.addMessage({
      documentId,
      role: 'assistant',
      content: '被摘要覆盖的回答',
      metadata: { sessionId: 'sum' }
    });
    store.addMessage({
      documentId,
      role: 'user',
      content: '未被摘要覆盖的问题',
      metadata: { sessionId: 'sum' }
    });
    writeDocumentChatSessions(store, documentId, [
      {
        id: 'sum',
        title: '摘要会话',
        created: 'x',
        updated: 'x',
        contextSummary: '旧摘要（覆盖到第一轮）',
        summaryUpto: user1.id
      }
    ]);

    const edited = await server.inject({
      method: 'PATCH',
      url: `/api/v1/documents/${encodeURIComponent(documentId)}/messages/${user1.id}`,
      headers,
      payload: { content: '改后的问题', sessionId: 'sum' }
    });
    expect(edited.statusCode).toBe(200);
    const sessions = readDocumentChatSessions(store, documentId);
    expect(sessions[0]!.contextSummary).toBeUndefined();
    expect(sessions[0]!.summaryUpto ?? 0).toBe(0);
  });

  it('客户端整表保存只带标题时不清空摘要；显式带空摘要才清', () => {
    store.deleteMessages(documentId);
    store.saveDocumentChatSessions(documentId, [
      {
        id: 'preserve',
        title: '保留摘要',
        created: '2026-01-01T00:00:00.000Z',
        updated: '2026-01-01T00:00:00.000Z',
        contextSummary: '早期摘要',
        summaryUpto: 9
      }
    ]);
    // 客户端刷新后整表保存（只有标题/时间，没有 contextSummary 字段）。
    store.saveDocumentChatSessions(documentId, [
      {
        id: 'preserve',
        title: '改名后',
        created: '2026-01-01T00:00:00.000Z',
        updated: '2026-01-02T00:00:00.000Z'
      }
    ]);
    expect(store.listDocumentChatSessions(documentId)[0]).toMatchObject({
      title: '改名后',
      contextSummary: '早期摘要',
      summaryUpto: 9
    });
    // 显式带 contextSummary: undefined（服务端清摘要）才清空。
    store.saveDocumentChatSessions(documentId, [
      {
        id: 'preserve',
        title: '改名后',
        created: '2026-01-01T00:00:00.000Z',
        updated: '2026-01-02T00:00:00.000Z',
        contextSummary: undefined,
        summaryUpto: 0
      }
    ]);
    expect(store.listDocumentChatSessions(documentId)[0]!.contextSummary).toBeUndefined();
  });

  it('transcript_version 条件写摘要：消息变了就拒绝旧版本写入', () => {
    store.deleteMessages(documentId);
    store.saveDocumentChatSessions(documentId, [
      { id: 'cas', title: 'CAS', created: 'x', updated: 'x' }
    ]);
    const initial = store.listDocumentChatSessions(documentId).find((s) => s.id === 'cas')!;
    expect(initial.transcriptVersion).toBe(0);
    store.addMessage({
      documentId,
      role: 'user',
      content: '新增消息让版本递增',
      metadata: { sessionId: 'cas' }
    });
    const afterMessage = store.listDocumentChatSessions(documentId).find((s) => s.id === 'cas')!;
    expect(afterMessage.transcriptVersion).toBeGreaterThan(0);

    // 旧版本（压缩开始时的 0）写回失败。
    expect(
      store.compareAndSetDocumentChatSessionSummary(documentId, 'cas', 0, '旧摘要', 1)
    ).toBe(false);
    expect(
      store.listDocumentChatSessions(documentId).find((s) => s.id === 'cas')?.contextSummary
    ).toBeUndefined();

    // 当前版本写回成功。
    expect(
      store.compareAndSetDocumentChatSessionSummary(
        documentId,
        'cas',
        afterMessage.transcriptVersion ?? 0,
        '新摘要',
        1
      )
    ).toBe(true);
    expect(store.listDocumentChatSessions(documentId).find((s) => s.id === 'cas')).toMatchObject({
      contextSummary: '新摘要',
      summaryUpto: 1,
      transcriptVersion: afterMessage.transcriptVersion
    });
  });

  it('细粒度 create/update：不改整张清单，PATCH 标题不碰摘要', async () => {
    store.deleteMessages(documentId);
    const created = await server.inject({
      method: 'POST',
      url: `/api/v1/documents/${encodeURIComponent(documentId)}/chat-sessions`,
      headers,
      payload: {
        session: {
          id: 'fine',
          title: '细粒度会话',
          created: '2026-02-01T00:00:00.000Z',
          updated: '2026-02-01T00:00:00.000Z',
          contextSummary: '已有摘要',
          summaryUpto: 4
        }
      }
    });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({ id: 'fine', contextSummary: '已有摘要' });

    const renamed = await server.inject({
      method: 'PATCH',
      url: `/api/v1/documents/${encodeURIComponent(documentId)}/chat-sessions/fine`,
      headers,
      payload: { title: '改名后的细粒度会话', updated: '2026-02-02T00:00:00.000Z' }
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()).toMatchObject({
      title: '改名后的细粒度会话',
      contextSummary: '已有摘要',
      summaryUpto: 4
    });
    expect(store.listDocumentChatSessions(documentId).find((s) => s.id === 'fine')).toMatchObject({
      title: '改名后的细粒度会话',
      contextSummary: '已有摘要'
    });

    const missing = await server.inject({
      method: 'PATCH',
      url: `/api/v1/documents/${encodeURIComponent(documentId)}/chat-sessions/nope`,
      headers,
      payload: { title: 'x' }
    });
    expect(missing.statusCode).toBe(404);
  });

  it('消息分页与会话内搜索', async () => {
    store.deleteMessages(documentId);
    for (let index = 1; index <= 5; index += 1) {
      store.addMessage({
        documentId,
        role: index % 2 === 1 ? 'user' : 'assistant',
        content:
          index === 3
            ? '第三条包含关键词 价值信念 的测量口径讨论'
            : `第 ${index} 条普通消息`,
        metadata: { sessionId: 'page' }
      });
    }
    // 另一个会话的消息不应该出现在当前会话分页/搜索里。
    store.addMessage({
      documentId,
      role: 'user',
      content: '别的会话也提到 价值信念',
      metadata: { sessionId: 'other' }
    });

    const latest = await server.inject({
      method: 'GET',
      url: `/api/v1/documents/${encodeURIComponent(documentId)}/messages/page?sessionId=page&limit=3`,
      headers
    });
    expect(latest.statusCode).toBe(200);
    const latestPayload = latest.json() as { messages: Array<{ content: string }>; hasMore: boolean };
    expect(latestPayload.messages.map((message) => message.content)).toEqual([
      '第三条包含关键词 价值信念 的测量口径讨论',
      '第 4 条普通消息',
      '第 5 条普通消息'
    ]);
    expect(latestPayload.hasMore).toBe(true);

    const earlier = await server.inject({
      method: 'GET',
      url: `/api/v1/documents/${encodeURIComponent(
        documentId
      )}/messages/page?sessionId=page&limit=3&before=${store.listMessages(documentId, { sessionId: 'page' })[2]!.id}`,
      headers
    });
    const earlierPayload = earlier.json() as { messages: Array<{ content: string }>; hasMore: boolean };
    expect(earlierPayload.messages.map((message) => message.content)).toEqual([
      '第 1 条普通消息',
      '第 2 条普通消息'
    ]);
    expect(earlierPayload.hasMore).toBe(false);

    const search = await server.inject({
      method: 'GET',
      url: `/api/v1/documents/${encodeURIComponent(
        documentId
      )}/messages/search?sessionId=page&q=${encodeURIComponent('价值信念')}`,
      headers
    });
    expect(search.statusCode).toBe(200);
    const searchPayload = search.json() as {
      matches: Array<{ id: number; snippet: string; role: string }>;
      total: number;
    };
    expect(searchPayload.total).toBe(1);
    expect(searchPayload.matches).toHaveLength(1);
    expect(searchPayload.matches[0]!.snippet).toContain('价值信念');
    expect(searchPayload.matches[0]!.role).toBe('user');
  });
});
