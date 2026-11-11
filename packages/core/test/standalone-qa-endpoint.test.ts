import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatRequest, ChatResponse } from '@studianda/shared';
import { clearRouteCache } from '../src/question-route.js';
import { SecretStore } from '../src/secrets.js';
import { buildServer } from '../src/server.js';
import { Store } from '../src/store.js';

/**
 * 独立问答（没有 documentId）的 HTTP 端点行为：
 *
 * 1. `POST /api/v1/chat/ask` + `include_memory:true` → 200、`answer_mode='library'`，
 *    笔记/批注只出现在 `memory_sources`，绝不混入 `sources`；
 * 2. 不传 `include_memory` → 没有 memory_sources，最终回答请求体不含「用户笔记与批注」；
 * 3. 无 documentId、`reading_scope:'auto'`、`scope_documents:[id]` → 不是 `needs_confirmation`
 *    （库内检索只做命中页检索，不应触发跨文献精读的预算闸门）；
 * 4. `include_memory` 经 server 透传到 `answerQuestion`：最终回答的 user content 里出现
 *    「用户笔记与批注」。
 *
 * 全程用 vi.stubGlobal('fetch') 模拟模型服务，不联网；模型通过 env 配置
 * （STUDIANDA_MODEL_BASE_URL/NAME/API_KEY），因此每个用例前都要清 route 缓存。
 */

const token = 'standalone-qa-endpoint-token';
const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-qa-endpoint-'));
const store = new Store(dataDir);
const secrets = new SecretStore();
const server = buildServer({ token, version: 'test-version', store, secrets });

let firstDoc = '';
let secondDoc = '';
let annotationId = '';
let noteId = '';

function headers(): Record<string, string> {
  return { 'x-studianda-token': token };
}

interface Captured {
  routeBodies: Array<Record<string, unknown>>;
  answerBodies: Array<Record<string, unknown>>;
}

function modelResponse(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
}

/** 模型桩：QUESTION_ROUTE 一次判断 + 之后所有调用都当最终回答。 */
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

function answerUserText(captured: Captured, index = -1): string {
  const body = captured.answerBodies.at(index) ?? {};
  const messages = (body.messages ?? []) as Array<{ role: string; content: string }>;
  return messages.find((message) => message.role === 'user')?.content ?? '';
}

function answerSystemText(captured: Captured, index = -1): string {
  const body = captured.answerBodies.at(index) ?? {};
  const messages = (body.messages ?? []) as Array<{ role: string; content: string }>;
  return messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .join('\n');
}

async function ask(payload: Record<string, unknown>): Promise<{
  statusCode: number;
  body: ChatResponse & { budget?: unknown };
}> {
  const response = await server.inject({
    method: 'POST',
    url: '/api/v1/chat/ask',
    headers: headers(),
    payload
  });
  return { statusCode: response.statusCode, body: response.json() as ChatResponse & { budget?: unknown } };
}

beforeAll(async () => {
  const pdfOf = async (name: string, pages: number): Promise<string> => {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    for (let index = 0; index < pages; index += 1) {
      const page = pdf.addPage([300, 400]);
      page.drawText(`${name} ${index + 1}`, { x: 20, y: 20, size: 8, font });
    }
    const file = path.join(dataDir, name);
    writeFileSync(file, await pdf.save());
    const document = await store.importDocument(file, undefined, true);
    return document.id;
  };
  firstDoc = await pdfOf('qa-endpoint-first.pdf', 2);
  secondDoc = await pdfOf('qa-endpoint-second.pdf', 2);
  // 导入是懒解析：先完成一次解析，否则解析会在校订之后落库、把校订块盖掉（库检索也就搜不到）。
  await store.getPageLayout(firstDoc);
  await store.getPageLayout(secondDoc);
  await store.savePageTextEdit(
    firstDoc,
    1,
    '甲文献第一页：价值信念是本文的核心概念，作者给出了定义。'
  );
  await store.savePageTextEdit(firstDoc, 2, '甲文献第二页：补充价值信念的边界。');
  await store.savePageTextEdit(secondDoc, 1, '乙文献第一页：方法论部分讨论价值信念的测量。');
  await store.savePageTextEdit(secondDoc, 2, '乙文献第二页：结论。');
  annotationId = store.createAnnotation({
    documentId: firstDoc,
    page: 1,
    quote: '价值信念是本文的核心概念',
    content: '这里是我对价值信念定义的批注：注意作者区分了信念与态度。',
    color: 'yellow',
    style: 'highlight'
  }).id;
  noteId = store.createNote({
    documentId: secondDoc,
    page: 1,
    quote: '价值信念的测量',
    content: '笔记：乙文献的测量口径与甲文献不同，需要对照。'
  }).id;
  // 独立笔记：只有「全部文献」范围才应纳入。
  store.createNote({
    documentId: '',
    page: 0,
    content: '独立笔记：价值信念与态度、意见的区分，是我长期关注的问题。'
  });
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

describe('POST /api/v1/chat/ask：独立问答 + 笔记/批注', () => {
  it('无 documentId + include_memory:true → 200 / library，笔记批注只进 memory_sources', async () => {
    const captured: Captured = { routeBodies: [], answerBodies: [] };
    mockModel(captured);
    const { statusCode, body } = await ask({
      question: '价值信念的核心定义是什么',
      include_memory: true
    });
    expect(statusCode).toBe(200);
    expect(body.needs_confirmation).toBeUndefined();
    expect(body.answer_mode).toBe('library');
    expect(body.answer).toContain('库内检索回答');
    // 原文命中页是正式来源；笔记/批注绝不混入 sources。
    expect(body.sources.length).toBeGreaterThan(0);
    expect(body.sources.every((source) => !source.kind || source.kind === 'document')).toBe(
      true
    );
    expect(body.sources.every((source) => source.kind !== 'note' && source.kind !== 'annotation')).toBe(
      true
    );
    // 笔记/批注来源单独返回，带可跳转的记录 id。
    const memoryKinds = (body.memory_sources ?? []).map((source) => source.kind);
    expect(memoryKinds).toContain('note');
    expect(memoryKinds).toContain('annotation');
    expect(body.memory_sources?.find((source) => source.kind === 'annotation')?.memoryId).toBe(
      annotationId
    );
    expect(body.memory_sources?.find((source) => source.kind === 'note')?.memoryId).toBe(noteId);
    expect(body.memory_notice).toContain('笔记');
    // 最终回答请求材料里带「用户笔记与批注」，并明确不是原文证据。
    expect(answerUserText(captured)).toContain('用户笔记与批注');
    expect(answerUserText(captured)).toContain('不是文献原文');
    // 只有真的附带材料时才追加 MEMORY_RULES 规则段。
    expect(answerSystemText(captured)).toContain('本轮另附「用户笔记与批注」');
    expect(answerSystemText(captured)).toContain('笔记/批注是用户自己的记录');
  });

  it('不传 include_memory → 没有 memory_sources，回答请求体不含「用户笔记与批注」', async () => {
    const captured: Captured = { routeBodies: [], answerBodies: [] };
    mockModel(captured);
    const { statusCode, body } = await ask({ question: '价值信念的核心定义是什么' });
    expect(statusCode).toBe(200);
    expect(body.answer_mode).toBe('library');
    expect(body.memory_sources).toBeUndefined();
    expect(body.memory_notice).toBeUndefined();
    expect(answerUserText(captured)).not.toContain('用户笔记与批注');
    // 没有附带材料时不追加 MEMORY_RULES 规则段。
    expect(answerSystemText(captured)).not.toContain('本轮另附「用户笔记与批注」');
  });

  it('无 documentId + reading_scope:auto + scope_documents → 不走跨文献预算闸门', async () => {
    const captured: Captured = { routeBodies: [], answerBodies: [] };
    mockModel(captured);
    const { statusCode, body } = await ask({
      question: '价值信念的测量口径',
      reading_scope: 'auto',
      scope_documents: [firstDoc],
      include_memory: false
    } satisfies Partial<ChatRequest>);
    expect(statusCode).toBe(200);
    // 库内检索只做命中页检索：不是 200+needs_confirmation，也没有 budget 估算。
    expect(body.needs_confirmation).not.toBe(true);
    expect(body.budget).toBeUndefined();
    expect(body.answer_mode).toBe('library');
    expect(body.answer).toContain('库内检索回答');
    // 范围限制真的生效：来源只来自指定文献。
    expect(body.sources.length).toBeGreaterThan(0);
    expect(body.sources.every((source) => source.documentId === firstDoc)).toBe(true);
  });

  it('include_memory 经 server 透传：最终回答 user content 含「用户笔记与批注」', async () => {
    const captured: Captured = { routeBodies: [], answerBodies: [] };
    mockModel(captured);
    const { statusCode, body } = await ask({
      question: '价值信念的核心定义是什么',
      include_memory: true
    });
    expect(statusCode).toBe(200);
    // 透传证据：memory_sources 由 answerQuestion 生成（server 漏传时这里会是 undefined）。
    expect((body.memory_sources ?? []).length).toBeGreaterThan(0);
    const user = answerUserText(captured);
    expect(user).toContain('用户笔记与批注');
    expect(user).toContain('价值信念');
    expect(answerSystemText(captured)).toContain('本轮另附「用户笔记与批注」');
  });

  it('语音直接提问可以没有文字问题（audio 直接作为输入，不再 400）', async () => {
    // 独立问答页的 directAudio 路径会发送 question:'' + audio；服务端不应按"问题为空"拒绝。
    const captured: Captured = { routeBodies: [], answerBodies: [] };
    mockModel(captured);
    const { statusCode, body } = await ask({
      question: '',
      audio: { data: 'ZmFrZS1hdWRpbw==', mimeType: 'audio/webm', filename: 'speech.webm' }
    });
    expect(statusCode).toBe(200);
    expect(body.answer).toBe('库内检索回答：价值信念在甲文献中给出了定义。[1]');
    // 全模态路径不经过问题路由：只有最终回答那一次模型调用。
    expect(captured.routeBodies).toHaveLength(0);
    expect(captured.answerBodies).toHaveLength(1);
  });
});
