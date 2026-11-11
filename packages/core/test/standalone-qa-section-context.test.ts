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
 * 库内检索问答 → 命中片段（结构/内容块识别）的端到端契约：
 *
 * 1. 命中页的命中段落在哪一节，就把"章节标题 + 章节片段"作为上下文（不是整页原文）；
 * 2. 来源带 `sectionTitle`，提示词如实标注「命中片段」，并说明不是已读全文；
 * 3. 用户校订过的页不能拿 PDF 文本层的旧块当依据，退回整页原文；
 * 4. 模型调用次数不变（问题路由 1 次 + 回答 1 次）。
 *
 * 全程 `vi.stubGlobal('fetch')` 模拟模型服务，不联网。
 */

const token = 'section-context-qa-token';
const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-section-context-'));
const store = new Store(dataDir);
const secrets = new SecretStore();
const server = buildServer({ token, version: 'test-version', store, secrets });

let documentId = '';

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
    return modelResponse('库内检索回答：价值信念在该节给出定义。[1]');
  });
}

function answerUserText(captured: Captured): string {
  const body = captured.answerBodies.at(-1) ?? {};
  const messages = (body.messages ?? []) as Array<{ role: string; content: string }>;
  return messages.find((message) => message.role === 'user')?.content ?? '';
}

function answerSystemText(captured: Captured): string {
  const body = captured.answerBodies.at(-1) ?? {};
  const messages = (body.messages ?? []) as Array<{ role: string; content: string }>;
  return messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .join('\n');
}

async function ask(payload: Partial<ChatRequest>): Promise<{
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

beforeAll(async () => {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const first = pdf.addPage([400, 600]);
  first.drawText('1 INTRODUCTION', { x: 30, y: 560, size: 16, font });
  first.drawText('The value belief construct is defined in this section.', {
    x: 30,
    y: 520,
    size: 11,
    font
  });
  first.drawText('It distinguishes belief from attitude and opinion.', {
    x: 30,
    y: 500,
    size: 11,
    font
  });
  first.drawText('The definition is used throughout the paper.', {
    x: 30,
    y: 480,
    size: 11,
    font
  });
  const second = pdf.addPage([400, 600]);
  second.drawText('2 METHODS', { x: 30, y: 560, size: 16, font });
  second.drawText('The sample design is described in this section.', {
    x: 30,
    y: 520,
    size: 11,
    font
  });
  const file = path.join(dataDir, 'section-context.pdf');
  writeFileSync(file, await pdf.save());
  const imported = await store.importDocument(file);
  documentId = imported.id;
  // 导入是懒解析：先完成一次版面解析，后面读内容块/检索都基于同一份版面。
  await store.getPageLayout(documentId);
  process.env.STUDIANDA_MODEL_BASE_URL = 'https://model.example.com/v1';
  process.env.STUDIANDA_MODEL_NAME = 'chat-model';
  process.env.STUDIANDA_MODEL_API_KEY = 'k-1';
}, 120_000);

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

describe('库内检索问答的命中片段', () => {
  it('命中段落 -> 所在章节片段：来源带章节标题，提示词标注命中片段且不是全文', async () => {
    const captured: Captured = { routeBodies: [], answerBodies: [] };
    mockModel(captured);
    const { statusCode, body } = await ask({
      question: 'What is the value belief definition?',
      reading_scope: 'auto',
      scope_documents: [documentId]
    });
    expect(statusCode).toBe(200);
    expect(body.answer_mode).toBe('library');
    expect(body.sources.length).toBeGreaterThan(0);
    const firstPage = body.sources.find((item) => item.page === 1);
    expect(firstPage?.sectionTitle).toContain('INTRODUCTION');
    expect(firstPage?.documentId).toBe(documentId);
    expect(firstPage?.snippet).toContain('value belief construct');
    // 章节片段带章节标题一起进入来源文字。
    expect(firstPage?.snippet).toContain('1 INTRODUCTION');
    // 每一节的来源只覆盖自己这一节，不把另一节的正文混进来。
    expect(firstPage?.snippet).not.toContain('sample design is described');
    const secondPage = body.sources.find((item) => item.page === 2);
    if (secondPage) {
      expect(secondPage.sectionTitle).toContain('METHODS');
      expect(secondPage.snippet).not.toContain('value belief construct');
    }
    // 提示词如实说明"命中片段，不是已读全文"。
    const user = answerUserText(captured);
    expect(user).toContain('命中片段');
    expect(user).toContain('1 INTRODUCTION');
    expect(user).toContain('It distinguishes belief from attitude and opinion.');
    expect(answerSystemText(captured)).toContain('只根据给出的检索原文片段');
    expect(body.notice).toContain('段落/章节片段');
    // 点来源可精确跳到命中行：locate 是原文里逐字存在的那一行，quote-locate 能标出框。
    expect(firstPage?.locate).toBeTruthy();
    expect(firstPage?.locate).toContain('value belief');
    const located = await server.inject({
      method: 'POST',
      url: `/api/v1/documents/${documentId}/quote-locate`,
      headers: headers(),
      payload: { page: 1, quote: firstPage?.locate }
    });
    expect(located.statusCode).toBe(200);
    const locatedBody = located.json() as { boxes: unknown[] };
    expect(locatedBody.boxes.length).toBeGreaterThan(0);
    // 问题路由 1 次 + 回答 1 次，没有因为片段定位多调模型。
    expect(captured.routeBodies).toHaveLength(1);
    expect(captured.answerBodies).toHaveLength(1);
  });

  it('检索结果列表可拿到「命中在哪一节」（sectionTitle/blockId，不触发 PDF 解析）', async () => {
    // 上面的问答已经让内容块缓存就绪；这里检索结果应直接带章节元数据。
    const response = await server.inject({
      method: 'GET',
      url: `/api/v1/search?q=${encodeURIComponent('value belief')}&documentId=${documentId}&limit=5`,
      headers: headers()
    });
    expect(response.statusCode).toBe(200);
    const hits = response.json() as Array<{
      page: number;
      sectionTitle?: string;
      blockId?: string;
    }>;
    expect(hits.length).toBeGreaterThan(0);
    const first = hits.find((hit) => hit.page === 1);
    expect(first?.sectionTitle).toBe('1 INTRODUCTION');
    expect(first?.blockId).toMatch(/^b\d+$/);
  });

  it('用户校订过的页退回整页原文，不拿 PDF 文本层的旧块当依据', async () => {
    await store.savePageTextEdit(
      documentId,
      1,
      'Edited page: the value belief definition was corrected by the user.'
    );
    const captured: Captured = { routeBodies: [], answerBodies: [] };
    mockModel(captured);
    const { statusCode, body } = await ask({
      question: 'What is the value belief definition?',
      reading_scope: 'auto',
      scope_documents: [documentId]
    });
    expect(statusCode).toBe(200);
    expect(body.sources.length).toBeGreaterThan(0);
    const source = body.sources[0]!;
    // 校订页的块与校订正文可能不一致：必须退回整页（来源不带章节标题）。
    expect(source.sectionTitle).toBeUndefined();
    expect(source.snippet).toContain('Edited page');
    const user = answerUserText(captured);
    expect(user).toContain('整页原文');
    expect(user).toContain('Edited page');
    // 校订后的页不再出现 PDF 文本层的旧句子。
    expect(user).not.toContain('It distinguishes belief from attitude');
  });
});
