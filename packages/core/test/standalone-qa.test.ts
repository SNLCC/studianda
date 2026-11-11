import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { answerQuestion } from '../src/chat.js';
import { clearRouteCache } from '../src/question-route.js';
import { SecretStore } from '../src/secrets.js';
import { Store } from '../src/store.js';

/**
 * 独立问答（没有 documentId）的核心行为：
 * - 默认走库内检索，不整库精读；
 * - 勾选 include_memory 时笔记/批注进入最终回答材料，但不进 sources、不参与引用编号；
 * - 未勾选时不纳入；显式范围无文献时如实说明。
 *
 * 全程用 vi.stubGlobal('fetch') 模拟模型，不联网。
 */

const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-qa-'));
const store = new Store(dataDir);
const secrets = new SecretStore();
let firstDoc = '';
let secondDoc = '';
let annotationId = '';
let noteId = '';
let standaloneNoteId = '';

afterAll(() => {
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.STUDIANDA_MODEL_BASE_URL;
  delete process.env.STUDIANDA_MODEL_NAME;
  delete process.env.STUDIANDA_MODEL_API_KEY;
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearRouteCache();
});

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
  firstDoc = await pdfOf('qa-first.pdf', 2);
  secondDoc = await pdfOf('qa-second.pdf', 2);
  // 导入是懒解析：先完成一次解析，否则解析会在校订之后落库、把校订块盖掉（库检索也就搜不到）。
  await store.getPageLayout(firstDoc);
  await store.getPageLayout(secondDoc);
  await store.savePageTextEdit(firstDoc, 1, '甲文献第一页：价值信念是本文的核心概念，作者给出了定义。');
  await store.savePageTextEdit(firstDoc, 2, '甲文献第二页：补充价值信念的边界。');
  await store.savePageTextEdit(secondDoc, 1, '乙文献第一页：方法论部分讨论价值信念的测量。');
  await store.savePageTextEdit(secondDoc, 2, '乙文献第二页：结论。');
  // 一条带批注正文的高亮 + 一条文献笔记 + 一条独立笔记：三种来源都要能进入问答材料。
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
  standaloneNoteId = store.createNote({
    documentId: '',
    page: 0,
    content: '独立笔记：价值信念与态度、意见的区分，是我长期关注的问题。'
  }).id;
  process.env.STUDIANDA_MODEL_BASE_URL = 'https://model.example.com/v1';
  process.env.STUDIANDA_MODEL_NAME = 'chat-model';
  process.env.STUDIANDA_MODEL_API_KEY = 'k-1';
});

interface Captured {
  routeBodies: Array<Record<string, unknown>>;
  answerBodies: Array<Record<string, unknown>>;
}

function mockModel(captured: Captured): void {
  vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    const messages = (body.messages ?? []) as Array<{ role: string; content: string }>;
    const system = messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n');
    if (system.includes('QUESTION_ROUTE')) {
      captured.routeBodies.push(body);
      const content = JSON.stringify({
        document: true,
        search: false,
        reason: '库内问答',
        reply: '',
        reading: 'document'
      });
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
    captured.answerBodies.push(body);
    const content = '库内检索回答：价值信念在甲文献中给出了定义。[1]';
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  });
}

function answerUserText(captured: Captured, index = 0): string {
  const body = captured.answerBodies[index] ?? {};
  const messages = (body.messages ?? []) as Array<{ role: string; content: string }>;
  return messages.find((message) => message.role === 'user')?.content ?? '';
}

describe('独立问答：库内检索 + 笔记/批注', () => {
  beforeEach(() => {
    clearRouteCache();
  });

  it('没有 documentId 时走库内检索，勾选后笔记/批注进入材料但不进 sources', async () => {
    const captured: Captured = { routeBodies: [], answerBodies: [] };
    mockModel(captured);
    const response = await answerQuestion(store, secrets, {
      question: '价值信念的核心定义是什么',
      include_memory: true
    });
    expect(response.answer_mode).toBe('library');
    expect(response.answer).toContain('库内检索回答');
    // 检索原文页作为正式来源；笔记/批注不混入 sources。
    expect(response.sources.length).toBeGreaterThan(0);
    expect(response.sources.every((source) => !source.kind || source.kind === 'document')).toBe(
      true
    );
    expect(response.memory_sources?.length).toBeGreaterThan(0);
    expect(response.memory_sources?.some((source) => source.kind === 'annotation')).toBe(true);
    expect(response.memory_sources?.some((source) => source.kind === 'note')).toBe(true);
    // 独立笔记在全库范围也纳入。
    expect(
      response.memory_sources?.some(
        (source) => source.kind === 'note' && source.documentId === ''
      )
    ).toBe(true);
    // 记忆来源带可跳转 id，不是伪来源。
    expect(
      response.memory_sources?.find((source) => source.kind === 'annotation')?.memoryId
    ).toBe(annotationId);
    expect(response.memory_notice).toContain('笔记');
    // 模型材料里带「用户笔记与批注」与规则，但引用编号仍只对应文献来源。
    const user = answerUserText(captured);
    expect(user).toContain('价值信念的核心定义是什么');
    expect(user).toContain('用户笔记与批注');
    expect(user).toContain('不是文献原文');
    const system = (
      (captured.answerBodies[0]?.messages ?? []) as Array<{ role?: string; content: string }>
    )
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n');
    expect(system).toContain('笔记/批注是用户自己的记录');
  });

  it('未勾选 include_memory 时不纳入笔记/批注', async () => {
    const captured: Captured = { routeBodies: [], answerBodies: [] };
    mockModel(captured);
    const response = await answerQuestion(store, secrets, {
      question: '价值信念的核心定义是什么'
    });
    expect(response.answer_mode).toBe('library');
    expect(response.memory_sources).toBeUndefined();
    expect(response.memory_notice).toBeUndefined();
    expect(answerUserText(captured)).not.toContain('用户笔记与批注');
  });

  it('跨文献范围只纳入所选文献的笔记/批注，不混入范围外文献', async () => {
    const captured: Captured = { routeBodies: [], answerBodies: [] };
    mockModel(captured);
    const response = await answerQuestion(store, secrets, {
      question: '价值信念的测量口径',
      scope_documents: [secondDoc],
      include_memory: true
    });
    expect(response.answer_mode).toBe('library');
    const ids = (response.memory_sources ?? []).map((source) => source.memoryId);
    expect(ids).toContain(noteId);
    expect(ids).not.toContain(annotationId);
    // 指定文献范围时不再纳入独立笔记（它不属于任何文献）。
    expect(ids).not.toContain(standaloneNoteId);
  });

  it('显式范围没有匹配文献时如实说明，不静默改成全库', async () => {
    const captured: Captured = { routeBodies: [], answerBodies: [] };
    mockModel(captured);
    const response = await answerQuestion(store, secrets, {
      question: '价值信念',
      scope_tags: ['不存在的标签'],
      include_memory: true
    });
    expect(response.answer).toBeNull();
    expect(response.sources).toEqual([]);
    expect(response.notice).toContain('没有匹配到任何文献');
    // 没有进入最终回答模型调用。
    expect(captured.answerBodies).toHaveLength(0);
  });

  it('模型未配置时也只返回检索片段与记忆来源，并如实说明', async () => {
    const saved = {
      base: process.env.STUDIANDA_MODEL_BASE_URL,
      model: process.env.STUDIANDA_MODEL_NAME
    };
    delete process.env.STUDIANDA_MODEL_BASE_URL;
    delete process.env.STUDIANDA_MODEL_NAME;
    try {
      const response = await answerQuestion(store, secrets, {
        question: '价值信念的核心定义是什么',
        include_memory: true
      });
      expect(response.answer).toBeNull();
      expect(response.sources.length).toBeGreaterThan(0);
      expect((response.memory_sources ?? []).length).toBeGreaterThan(0);
      expect(response.notice).toContain('尚未配置模型服务');
    } finally {
      if (saved.base) process.env.STUDIANDA_MODEL_BASE_URL = saved.base;
      if (saved.model) process.env.STUDIANDA_MODEL_NAME = saved.model;
    }
  });
});
