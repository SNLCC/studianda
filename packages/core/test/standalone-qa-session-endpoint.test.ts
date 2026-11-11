import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatResponse, QaSessionDetail, QaSessionRecord } from '@studianda/shared';
import { clearRouteCache } from '../src/question-route.js';
import { SecretStore } from '../src/secrets.js';
import { buildServer } from '../src/server.js';
import { Store } from '../src/store.js';

/**
 * 独立问答多会话的 HTTP 行为：
 *
 * 1. 不带 qa_session_id 提问 → 服务端自动建会话并在响应里返回 id，本轮问答落库（含整轮
 *    ChatResponse），标题取第一条问题；
 * 2. 带 qa_session_id 追问 → 第二轮模型请求里能看到上一轮问答（完整历史，不是最近 N 轮）；
 * 3. 「继续阅读」重发（taskId）不会重复记一条用户消息；
 * 4. 会话 REST：列表/新建/重命名/打开/删除/导入 + 不存在时 404/400；
 * 5. 会话历史与会话内消息按本机数据库持久化（同一 server 重启前后仍可读）。
 *
 * 全程用 vi.stubGlobal('fetch') 模拟模型服务，不联网。
 */

const token = 'standalone-qa-session-token';
const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-qa-session-endpoint-'));
const store = new Store(dataDir);
const secrets = new SecretStore();
const server = buildServer({ token, version: 'test-version', store, secrets });

interface Captured {
  routeBodies: Array<Record<string, unknown>>;
  answerBodies: Array<Record<string, unknown>>;
}

function headers(): Record<string, string> {
  return { 'x-studianda-token': token };
}

function modelResponse(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
}

function mockModel(captured: Captured): void {
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
      captured.routeBodies.push(body);
      return modelResponse(
        JSON.stringify({
          document: true,
          search: false,
          reason: '库内检索问答',
          reply: '',
          reading: 'document'
        })
      );
    }
    captured.answerBodies.push(body);
    return modelResponse('库内检索回答：价值信念在甲文献中给出了定义。[1]');
  });
}

function answerMessages(captured: Captured, index = -1): Array<{ role: string; content: string }> {
  const body = captured.answerBodies.at(index) ?? {};
  return (body.messages ?? []) as Array<{ role: string; content: string }>;
}

async function ask(payload: Record<string, unknown>): Promise<{
  statusCode: number;
  body: ChatResponse;
}> {
  const response = await server.inject({
    method: 'POST',
    url: '/api/v1/chat/ask',
    headers: headers(),
    payload
  });
  return { statusCode: response.statusCode, body: response.json() as ChatResponse };
}

async function createSession(title = ''): Promise<QaSessionRecord> {
  const response = await server.inject({
    method: 'POST',
    url: '/api/v1/qa/sessions',
    headers: headers(),
    payload: { title }
  });
  return response.json() as QaSessionRecord;
}

async function getSession(id: string): Promise<QaSessionDetail> {
  const response = await server.inject({
    method: 'GET',
    url: `/api/v1/qa/sessions/${encodeURIComponent(id)}`,
    headers: headers()
  });
  return response.json() as QaSessionDetail;
}

beforeAll(async () => {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let index = 0; index < 2; index += 1) {
    const page = pdf.addPage([300, 400]);
    page.drawText(`qa-session ${index + 1}`, { x: 20, y: 20, size: 8, font });
  }
  const file = path.join(dataDir, 'qa-session.pdf');
  writeFileSync(file, await pdf.save());
  const document = await store.importDocument(file, undefined, true);
  // 导入是懒解析：先完成一次解析，再写校订文字，库内检索才能命中这些文字。
  await store.getPageLayout(document.id);
  await store.savePageTextEdit(
    document.id,
    1,
    '甲文献第一页：价值信念是本文的核心概念，作者给出了定义。'
  );
  await store.savePageTextEdit(document.id, 2, '甲文献第二页：补充价值信念的边界。');

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

describe('独立问答多会话：提问与落库', () => {
  it('不带会话 id 提问：自动建会话、标题取首问、本轮问答落库', async () => {
    const captured: Captured = { routeBodies: [], answerBodies: [] };
    mockModel(captured);
    const { statusCode, body } = await ask({ question: '价值信念的核心定义是什么' });
    expect(statusCode).toBe(200);
    expect(body.qa_session_id).toBeTruthy();
    expect(body.qa_context).toEqual({
      messages: 1,
      summary_used: false,
      compacted: 0,
      dropped: 0
    });

    const detail = await server.inject({
      method: 'GET',
      url: `/api/v1/qa/sessions/${encodeURIComponent(body.qa_session_id!)}`,
      headers: headers()
    });
    const session = detail.json() as QaSessionDetail;
    expect(detail.statusCode).toBe(200);
    expect(session.session.title).toBe('价值信念的核心定义是什么');
    expect(session.messages).toHaveLength(2);
    expect(session.messages[0]?.role).toBe('user');
    expect(session.messages[0]?.content).toBe('价值信念的核心定义是什么');
    expect(session.messages[1]?.role).toBe('assistant');
    expect(session.messages[1]?.answered).toBe(true);
    expect(session.messages[1]?.response?.answer).toContain('库内检索回答');
    expect(session.session.messageCount).toBe(2);
  });

  it('带会话 id 追问：第二轮模型请求能看到上一轮问答（完整历史）', async () => {
    const captured: Captured = { routeBodies: [], answerBodies: [] };
    mockModel(captured);
    const first = await ask({ question: '第一个问题：价值信念的定义' });
    expect(first.statusCode).toBe(200);
    const sessionId = first.body.qa_session_id!;
    expect(sessionId).toBeTruthy();

    const second = await ask({
      question: '第二个问题：那它的测量口径呢',
      qa_session_id: sessionId
    });
    expect(second.statusCode).toBe(200);
    expect(second.body.qa_session_id).toBe(sessionId);
    expect(captured.answerBodies).toHaveLength(2);
    // 第二轮的库内检索回答请求里，system 之后先有上一轮的 user/assistant 原文。
    const messages = answerMessages(captured, -1);
    expect(messages.map((message) => message.role)).toEqual([
      'system',
      'user',
      'assistant',
      'user'
    ]);
    expect(messages[1]?.content).toContain('第一个问题');
    expect(messages[2]?.content).toContain('库内检索回答');
    expect(messages[3]?.content).toContain('第二个问题');
    // 追问检索结合了上文（检索用，不是证据），并在 notice 里如实说明。
    expect(second.body.notice).toContain('结合了本会话上文的指代信息');
    // 历史里的旧引用编号必须被明确隔离，不能当本轮引用。
    const system = messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n');
    expect(system).toContain('历史轮次的回答里可能出现');
    expect(system).toContain('不能当作本轮引用');

    const detail = await server.inject({
      method: 'GET',
      url: `/api/v1/qa/sessions/${encodeURIComponent(sessionId)}`,
      headers: headers()
    });
    const session = detail.json() as QaSessionDetail;
    expect(session.messages).toHaveLength(4);
  });

  it('语音追问会带上本会话更早的文字轮次（不再从零开始）', async () => {
    const captured: Captured = { routeBodies: [], answerBodies: [] };
    mockModel(captured);
    const first = await ask({ question: 'value belief 的核心定义是什么' });
    const sessionId = first.body.qa_session_id!;
    const audio = await ask({
      question: '',
      qa_session_id: sessionId,
      audio: { data: 'ZmFrZS1hdWRpbw==', mimeType: 'audio/webm', filename: 'speech.webm' }
    });
    expect(audio.statusCode).toBe(200);
    expect(audio.body.answer).toContain('库内检索回答');
    expect(audio.body.notice).toContain('带入本会话更早轮次的文字记录');
    const audioBody = captured.answerBodies.at(-1)!;
    const messages = (audioBody.messages ?? []) as Array<{ role: string; content: unknown }>;
    expect(messages.map((message) => message.role)).toEqual([
      'system',
      'user',
      'assistant',
      'user'
    ]);
    expect(String(messages[1]?.content)).toContain('value belief');
    expect(String(messages[2]?.content)).toContain('库内检索回答');
    expect(Array.isArray(messages[3]?.content)).toBe(true);
  });

  it('「继续阅读」重发（taskId）不会重复记一条用户消息', async () => {
    const captured: Captured = { routeBodies: [], answerBodies: [] };
    mockModel(captured);
    const first = await ask({ question: '需要继续阅读的问题' });
    const sessionId = first.body.qa_session_id!;
    const continued = await ask({
      question: '需要继续阅读的问题',
      qa_session_id: sessionId,
      taskId: 'no-such-task'
    });
    expect(continued.statusCode).toBe(200);
    const detail = await server.inject({
      method: 'GET',
      url: `/api/v1/qa/sessions/${encodeURIComponent(sessionId)}`,
      headers: headers()
    });
    const session = detail.json() as QaSessionDetail;
    // 原有一轮 user + assistant；续读失败只追加一条未回答的助手占位，不再追加用户问题。
    expect(session.messages.filter((message) => message.role === 'user')).toHaveLength(1);
    expect(session.messages).toHaveLength(3);
    expect(session.messages[2]?.answered).toBe(false);
  });

  it('带不存在的会话 id 提问：400，不会静默新建另一个会话', async () => {
    const captured: Captured = { routeBodies: [], answerBodies: [] };
    mockModel(captured);
    const before = store.listQaSessions().length;
    const { statusCode } = await ask({
      question: '会话不存在时的问题',
      qa_session_id: 'no-such-session'
    });
    expect(statusCode).toBe(400);
    expect(store.listQaSessions().length).toBe(before);
  });
});

describe('独立问答会话 REST', () => {
  it('新建/列表/重命名/打开/删除', async () => {
    const created = await server.inject({
      method: 'POST',
      url: '/api/v1/qa/sessions',
      headers: headers(),
      payload: { title: '手动会话' }
    });
    expect(created.statusCode).toBe(200);
    const session = created.json() as QaSessionRecord;
    expect(session.title).toBe('手动会话');

    const listed = await server.inject({
      method: 'GET',
      url: '/api/v1/qa/sessions',
      headers: headers()
    });
    expect(listed.statusCode).toBe(200);
    expect((listed.json() as QaSessionRecord[]).some((item) => item.id === session.id)).toBe(true);

    const renamed = await server.inject({
      method: 'PATCH',
      url: `/api/v1/qa/sessions/${encodeURIComponent(session.id)}`,
      headers: headers(),
      payload: { title: '改过的标题' }
    });
    expect(renamed.statusCode).toBe(200);
    expect((renamed.json() as QaSessionRecord).title).toBe('改过的标题');

    const pinned = await server.inject({
      method: 'PATCH',
      url: `/api/v1/qa/sessions/${encodeURIComponent(session.id)}`,
      headers: headers(),
      payload: { pinned: true }
    });
    expect(pinned.statusCode).toBe(200);
    expect((pinned.json() as QaSessionRecord).pinned).toBe(true);
    const pinnedList = await server.inject({
      method: 'GET',
      url: '/api/v1/qa/sessions',
      headers: headers()
    });
    expect((pinnedList.json() as QaSessionRecord[])[0]!.id).toBe(session.id);

    const detail = await server.inject({
      method: 'GET',
      url: `/api/v1/qa/sessions/${encodeURIComponent(session.id)}`,
      headers: headers()
    });
    expect(detail.statusCode).toBe(200);
    expect((detail.json() as QaSessionDetail).messages).toEqual([]);

    const deleted = await server.inject({
      method: 'DELETE',
      url: `/api/v1/qa/sessions/${encodeURIComponent(session.id)}`,
      headers: headers()
    });
    expect(deleted.statusCode).toBe(200);
    expect((deleted.json() as { ok: boolean }).ok).toBe(true);

    const missing = await server.inject({
      method: 'GET',
      url: `/api/v1/qa/sessions/${encodeURIComponent(session.id)}`,
      headers: headers()
    });
    expect(missing.statusCode).toBe(404);
  });

  it('旧 localStorage 历史导入：消息按顺序落库', async () => {
    const created = await server.inject({
      method: 'POST',
      url: '/api/v1/qa/sessions',
      headers: headers(),
      payload: { title: '旧版问答记录' }
    });
    const session = created.json() as QaSessionRecord;
    const imported = await server.inject({
      method: 'POST',
      url: `/api/v1/qa/sessions/${encodeURIComponent(session.id)}/import`,
      headers: headers(),
      payload: {
        messages: [
          { role: 'user', content: '旧问题一' },
          { role: 'assistant', content: '旧回答一', answered: true },
          { role: 'user', content: '旧问题二' }
        ]
      }
    });
    expect(imported.statusCode).toBe(200);
    const detail = imported.json() as QaSessionDetail;
    expect(detail.messages.map((message) => message.content)).toEqual([
      '旧问题一',
      '旧回答一',
      '旧问题二'
    ]);
    expect(detail.messages[1]?.answered).toBe(true);
    expect(detail.session.messageCount).toBe(3);

    const badSession = await server.inject({
      method: 'POST',
      url: '/api/v1/qa/sessions/no-such-session/import',
      headers: headers(),
      payload: { messages: [{ role: 'user', content: 'x' }] }
    });
    expect(badSession.statusCode).toBe(404);
  });
});

describe('独立问答会话：重新生成、搜索与分页、并发保护', () => {
  it('重新生成：替换最后一轮助手消息，不重复记用户消息', async () => {
    const captured: Captured = { routeBodies: [], answerBodies: [] };
    mockModel(captured);
    const first = await ask({ question: '第一个问题：价值信念的定义' });
    const sessionId = first.body.qa_session_id!;
    await ask({ question: '第二个问题：那测量口径呢', qa_session_id: sessionId });
    const before = await getSession(sessionId);
    expect(before.messages).toHaveLength(4);
    const answerCallsBefore = captured.answerBodies.length;

    const regenerated = await ask({
      question: '第二个问题：那测量口径呢',
      qa_session_id: sessionId,
      qa_regenerate: true
    });
    expect(regenerated.statusCode).toBe(200);
    expect(regenerated.body.qa_session_id).toBe(sessionId);
    const after = await getSession(sessionId);
    // 消息条数不变：最后一轮 assistant 被替换，而不是再追加一轮 user+assistant。
    expect(after.messages).toHaveLength(4);
    expect(after.messages.filter((message) => message.role === 'user')).toHaveLength(2);
    expect(after.messages.filter((message) => message.role === 'assistant')).toHaveLength(2);
    expect(after.messages.at(-1)?.answered).toBe(true);
    expect(captured.answerBodies.length).toBe(answerCallsBefore + 1);

    // 没有会话 id / 没有可重生成轮次 → 400。
    const noSession = await ask({ question: '随便问问', qa_regenerate: true });
    expect(noSession.statusCode).toBe(400);
    const emptySession = await createSession('空会话');
    const empty = await ask({
      question: '没有历史',
      qa_session_id: emptySession.id,
      qa_regenerate: true
    });
    expect(empty.statusCode).toBe(400);
  });

  it('会话搜索（标题/消息内容）与历史分页路由', async () => {
    const session = await createSession('搜索目标会话-unique');
    await server.inject({
      method: 'POST',
      url: `/api/v1/qa/sessions/${encodeURIComponent(session.id)}/import`,
      headers: headers(),
      payload: {
        messages: [
          { role: 'user', content: '第一条消息' },
          { role: 'assistant', content: '第一条回答', answered: true },
          { role: 'user', content: '第二条消息里有独特检索词' },
          { role: 'assistant', content: '第二条回答', answered: true }
        ]
      }
    });

    const byTitle = await server.inject({
      method: 'GET',
      url: '/api/v1/qa/sessions?q=%E6%90%9C%E7%B4%A2%E7%9B%AE%E6%A0%87',
      headers: headers()
    });
    expect((byTitle.json() as QaSessionRecord[]).some((item) => item.id === session.id)).toBe(true);

    const byContent = await server.inject({
      method: 'GET',
      url: '/api/v1/qa/sessions?q=%E7%8B%AC%E7%89%B9%E6%A3%80%E7%B4%A2%E8%AF%8D',
      headers: headers()
    });
    expect((byContent.json() as QaSessionRecord[]).some((item) => item.id === session.id)).toBe(true);

    const latest = await server.inject({
      method: 'GET',
      url: `/api/v1/qa/sessions/${encodeURIComponent(session.id)}?limit=2`,
      headers: headers()
    });
    const latestDetail = latest.json() as QaSessionDetail;
    expect(latestDetail.messages.map((message) => message.content)).toEqual([
      '第二条消息里有独特检索词',
      '第二条回答'
    ]);
    expect(latestDetail.hasMore).toBe(true);

    const earlier = await server.inject({
      method: 'GET',
      url: `/api/v1/qa/sessions/${encodeURIComponent(session.id)}?limit=2&before=${latestDetail.messages[0]!.id}`,
      headers: headers()
    });
    const earlierDetail = earlier.json() as QaSessionDetail;
    expect(earlierDetail.messages.map((message) => message.content)).toEqual([
      '第一条消息',
      '第一条回答'
    ]);
    expect(earlierDetail.hasMore).toBe(false);
  });

  it('同一会话并发提问：第二个请求返回 409（不会让 user/assistant 交错落库）', async () => {
    vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
      const body = init?.body
        ? (JSON.parse(String(init.body)) as Record<string, unknown>)
        : {};
      const messages = (body.messages ?? []) as Array<{ role: string; content: string }>;
      const system = messages
        .filter((message) => message.role === 'system')
        .map((message) => message.content)
        .join('\n');
      if (system.includes('QUESTION_ROUTE')) return modelResponse('{"document":true,"search":false,"reason":"库内检索问答","reply":"","reading":"document"}');
      await new Promise((resolve) => setTimeout(resolve, 250));
      return modelResponse('慢回答');
    });
    const session = await createSession('并发会话');
    const first = server.inject({
      method: 'POST',
      url: '/api/v1/chat/ask',
      headers: headers(),
      payload: { question: '并发问题一：价值信念的定义', qa_session_id: session.id }
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    const second = await ask({
      question: '并发问题二：价值信念的测量',
      qa_session_id: session.id
    });
    expect(second.statusCode).toBe(409);
    // 导入历史/删除会话等危险写操作与提问共用同一把锁。
    const importWhileAsking = await server.inject({
      method: 'POST',
      url: `/api/v1/qa/sessions/${encodeURIComponent(session.id)}/import`,
      headers: headers(),
      payload: { messages: [{ role: 'user', content: '在飞时导入' }] }
    });
    expect(importWhileAsking.statusCode).toBe(409);
    const deleteWhileAsking = await server.inject({
      method: 'DELETE',
      url: `/api/v1/qa/sessions/${encodeURIComponent(session.id)}`,
      headers: headers(),
      payload: {}
    });
    expect(deleteWhileAsking.statusCode).toBe(409);
    const firstResponse = await first;
    expect(firstResponse.statusCode).toBe(200);
    const detail = await getSession(session.id);
    // 只落了一轮（user+assistant），没有交错或重复。
    expect(detail.messages.map((message) => message.role)).toEqual(['user', 'assistant']);
  });

  it('编辑用户消息 / 从某轮分支删除（HTTP）', async () => {
    const session = await createSession('编辑分支会话');
    await server.inject({
      method: 'POST',
      url: `/api/v1/qa/sessions/${encodeURIComponent(session.id)}/import`,
      headers: headers(),
      payload: {
        messages: [
          { role: 'user', content: '问题一' },
          { role: 'assistant', content: '回答一', answered: true },
          { role: 'user', content: '问题二' },
          { role: 'assistant', content: '回答二', answered: true }
        ]
      }
    });
    const before = await getSession(session.id);
    const user2 = before.messages.filter((message) => message.role === 'user')[1]!;
    const assistant1 = before.messages.filter((message) => message.role === 'assistant')[0]!;

    const patch = await server.inject({
      method: 'PATCH',
      url: `/api/v1/qa/sessions/${encodeURIComponent(session.id)}/messages/${user2.id}`,
      headers: headers(),
      payload: { content: '改后的问题二' }
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json()).toEqual({ ok: true, removed: 1 });
    const edited = await getSession(session.id);
    expect(edited.messages.map((message) => message.content)).toEqual([
      '问题一',
      '回答一',
      '改后的问题二'
    ]);

    const removed = await server.inject({
      method: 'DELETE',
      url: `/api/v1/qa/sessions/${encodeURIComponent(session.id)}/messages/${user2.id}`,
      headers: headers(),
      payload: {}
    });
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toEqual({ ok: true, removed: 1 });
    const after = await getSession(session.id);
    expect(after.messages.map((message) => message.content)).toEqual(['问题一', '回答一']);

    // 编辑助手消息 / 不存在的消息 → 404。
    const badEdit = await server.inject({
      method: 'PATCH',
      url: `/api/v1/qa/sessions/${encodeURIComponent(session.id)}/messages/${assistant1.id}`,
      headers: headers(),
      payload: { content: '不允许' }
    });
    expect(badEdit.statusCode).toBe(404);
    const missing = await server.inject({
      method: 'DELETE',
      url: `/api/v1/qa/sessions/${encodeURIComponent(session.id)}/messages/999999`,
      headers: headers(),
      payload: {}
    });
    expect(missing.statusCode).toBe(404);
  });
});

