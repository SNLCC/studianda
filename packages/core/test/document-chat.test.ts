import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearRouteCache } from '../src/question-route.js';
import { SecretStore } from '../src/secrets.js';
import { buildServer } from '../src/server.js';
import { Store } from '../src/store.js';

/**
 * 阅读页（按文献）的对话数据能力：
 *
 * 1. `rewindDocumentMessagesTail` 只删「最后一条 user 之后」的助手消息，返回最后用户问题；
 * 2. `POST /api/v1/documents/:id/messages/rewind` 同口径（重新生成前清掉旧回答）；
 * 3. 同一文献并发提问：第二个请求返回 409（服务端按文献加并发锁）。
 *
 * 模型服务全程用 `vi.stubGlobal('fetch')` 模拟，不联网；样张 PDF 由 pdf-lib 运行时生成。
 */

const token = 'document-chat-token';
const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-doc-chat-'));
const store = new Store(dataDir);
const secrets = new SecretStore();
const server = buildServer({ token, version: 'test-version', store, secrets });
const documentId = { value: '' };

function headers(): Record<string, string> {
  return { 'x-studianda-token': token };
}

function jsonResponse(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
}

beforeAll(async () => {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let index = 0; index < 2; index += 1) {
    const page = pdf.addPage([300, 400]);
    page.drawText(`doc-chat ${index + 1}`, { x: 20, y: 20, size: 8, font });
  }
  const file = path.join(dataDir, 'doc-chat.pdf');
  writeFileSync(file, await pdf.save());
  const document = await store.importDocument(file, undefined, true);
  documentId.value = document.id;
  process.env.STUDIANDA_MODEL_BASE_URL = 'https://model.example.com/v1';
  process.env.STUDIANDA_MODEL_NAME = 'chat-model';
  process.env.STUDIANDA_MODEL_API_KEY = 'k-1';
});

beforeEach(() => {
  clearRouteCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearRouteCache();
});

afterAll(async () => {
  await server.close();
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.STUDIANDA_MODEL_BASE_URL;
  delete process.env.STUDIANDA_MODEL_NAME;
  delete process.env.STUDIANDA_MODEL_API_KEY;
});

describe('阅读页消息重新生成（数据层）', () => {
  it('只删除最后一条用户消息之后的助手消息，返回最后用户问题', () => {
    const id = documentId.value;
    store.addMessage({ documentId: id, role: 'user', content: '问题一' });
    store.addMessage({ documentId: id, role: 'assistant', content: '回答一' });
    store.addMessage({ documentId: id, role: 'user', content: '问题二' });
    store.addMessage({ documentId: id, role: 'assistant', content: '回答二' });
    store.addMessage({ documentId: id, role: 'assistant', content: '回答未完成：失败' });

    const rewind = store.rewindDocumentMessagesTail(id);
    expect(rewind.content).toBe('问题二');
    expect(rewind.removed).toBe(2);
    expect(store.listMessages(id).map((message) => message.content)).toEqual([
      '问题一',
      '回答一',
      '问题二'
    ]);

    // 再次 rewind：最后一条已经是用户问题，没有可删的助手消息。
    expect(store.rewindDocumentMessagesTail(id)).toEqual({ content: '问题二', removed: 0 });
    // 没有用户消息的文献不可重新生成。
    expect(store.rewindDocumentMessagesTail('missing-doc')).toEqual({
      content: null,
      removed: 0
    });
  });

  it('POST /documents/:id/messages/rewind 返回最后问题并删除旧回答', async () => {
    const id = documentId.value;
    // 清掉上一条用例留下的消息，构造干净的一轮。
    store.deleteMessages(id);
    store.addMessage({ documentId: id, role: 'user', content: '重新生成问题' });
    store.addMessage({ documentId: id, role: 'assistant', content: '旧回答' });
    const response = await server.inject({
      method: 'POST',
      url: `/api/v1/documents/${encodeURIComponent(id)}/messages/rewind`,
      headers: headers()
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, content: '重新生成问题', removed: 1 });
    const listed = await server.inject({
      method: 'GET',
      url: `/api/v1/documents/${encodeURIComponent(id)}/messages`,
      headers: headers()
    });
    expect((listed.json() as Array<{ content: string }>).map((row) => row.content)).toEqual([
      '重新生成问题'
    ]);
  });

  it('同一文献并发提问：第二个请求返回 409', async () => {
    vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
      const body = init?.body
        ? (JSON.parse(String(init.body)) as Record<string, unknown>)
        : {};
      const messages = (body.messages ?? []) as Array<{ role: string; content: string }>;
      const system = messages
        .filter((message) => message.role === 'system')
        .map((message) => message.content)
        .join('\n');
      if (system.includes('QUESTION_ROUTE')) {
        return jsonResponse(
          '{"document":true,"search":false,"reason":"阅读文献","reply":"","reading":"document"}'
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
      return jsonResponse('慢回答');
    });
    const id = documentId.value;
    const first = server.inject({
      method: 'POST',
      url: '/api/v1/chat/ask',
      headers: headers(),
      payload: { question: '并发阅读问题一', documentId: id }
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    const second = await server.inject({
      method: 'POST',
      url: '/api/v1/chat/ask',
      headers: headers(),
      payload: { question: '并发阅读问题二', documentId: id }
    });
    expect(second.statusCode).toBe(409);
    // 危险写操作与提问共用同一把锁：回答在飞时也不允许 rewind / 编辑 / 分支删除。
    const pendingUser = store.addMessage({ documentId: id, role: 'user', content: '旧问题' });
    const rewind = await server.inject({
      method: 'POST',
      url: `/api/v1/documents/${encodeURIComponent(id)}/messages/rewind`,
      headers: headers(),
      payload: { sessionId: 'legacy' }
    });
    expect(rewind.statusCode).toBe(409);
    const edit = await server.inject({
      method: 'PATCH',
      url: `/api/v1/documents/${encodeURIComponent(id)}/messages/${pendingUser.id}`,
      headers: headers(),
      payload: { content: '改问题', sessionId: 'legacy' }
    });
    expect(edit.statusCode).toBe(409);
    const remove = await server.inject({
      method: 'DELETE',
      url: `/api/v1/documents/${encodeURIComponent(id)}/messages/${pendingUser.id}`,
      headers: headers(),
      payload: { sessionId: 'legacy' }
    });
    expect(remove.statusCode).toBe(409);
    await first;
  });

  it('编辑 user 消息 / 从某轮分支删除（HTTP）', async () => {
    const id = documentId.value;
    store.deleteMessages(id);
    store.addMessage({ documentId: id, role: 'user', content: '问题一' });
    store.addMessage({ documentId: id, role: 'assistant', content: '回答一' });
    const edited = store.addMessage({ documentId: id, role: 'user', content: '问题二' });
    store.addMessage({ documentId: id, role: 'assistant', content: '回答二' });

    const patch = await server.inject({
      method: 'PATCH',
      url: `/api/v1/documents/${encodeURIComponent(id)}/messages/${edited.id}`,
      headers: headers(),
      payload: { content: '改后的问题二' }
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json()).toEqual({ ok: true, removed: 1 });
    expect(store.listMessages(id).map((message) => message.content)).toEqual([
      '问题一',
      '回答一',
      '改后的问题二'
    ]);

    const removed = await server.inject({
      method: 'DELETE',
      url: `/api/v1/documents/${encodeURIComponent(id)}/messages/${edited.id}`,
      headers: headers(),
      payload: {}
    });
    expect(removed.statusCode).toBe(200);
    expect((removed.json() as { ok: boolean; removed: number }).removed).toBe(1);
    expect(store.listMessages(id).map((message) => message.content)).toEqual([
      '问题一',
      '回答一'
    ]);

    // 编辑 assistant 消息 / 不存在的消息 → 404。
    const assistantId = store.listMessages(id)[1]!.id;
    const badEdit = await server.inject({
      method: 'PATCH',
      url: `/api/v1/documents/${encodeURIComponent(id)}/messages/${assistantId}`,
      headers: headers(),
      payload: { content: '不允许改助手' }
    });
    expect(badEdit.statusCode).toBe(404);
    const missing = await server.inject({
      method: 'DELETE',
      url: `/api/v1/documents/${encodeURIComponent(id)}/messages/999999`,
      headers: headers(),
      payload: {}
    });
    expect(missing.statusCode).toBe(404);
  });
});
