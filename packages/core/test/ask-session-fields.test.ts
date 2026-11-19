import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import type { BudgetEstimate, ChatAuditSummary, ChatResponse } from '@studianda/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  readDocumentChatSessions,
  writeDocumentChatSessions
} from '../src/document-chat-sessions.js';
import { clearRouteCache } from '../src/question-route.js';
import { resetReadingCompactionBackoff } from '../src/reading-session-context.js';
import { SecretStore } from '../src/secrets.js';
import { buildServer } from '../src/server.js';
import { Store } from '../src/store.js';

/**
 * `chat_session_id` / `reading_chapter_index` 的 **HTTP 接线测试**（先红后绿）。
 *
 * 背景：两个 ask 路由用显式字段白名单组装 `answerQuestion` 入参，客户端一直在发这两个字段，
 * 但路由把它们丢了——"完整会话/摘要压缩/审计继承"与"用户选的章"在 HTTP 上不可达。
 * 本文件即该缺口的回归测试（先红后绿）。
 *
 * 本文件只从 HTTP 入口验证行为，不直接调 `answerQuestion` 或 `prepareReadingSessionContext`：
 * 1. 带 `chat_session_id`（stream + 非 stream）：服务端完整会话进入模型提示词（>3 轮），
 *    且"客户端已先落库的本轮用户消息"不会在历史里重复出现；
 * 2. 不带：与现状完全一致（只用客户端 history，不读会话、不写摘要）；
 * 3. 无效 session id：200 + 明确提示，不报 500；
 * 4. 两个会话交替提问：上下文不互相串；
 * 5. 超预算会话：HTTP 上触发压缩并写回 `document_chat_sessions.context_summary`；
 * 6. 续读复用：带 session 时从 `messages.audit_summary` 继承审计摘要（HTTP 上生效）；
 * 7. 带 `reading_chapter_index`：预算闸门按该章估算，真实阅读也按该章。
 *
 * 模型服务全程 `vi.stubGlobal('fetch')` 模拟并记录请求消息，不联网；样张 PDF 运行时生成。
 */

const token = 'ask-session-fields-token';
const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-ask-session-fields-'));
const store = new Store(dataDir);
const secrets = new SecretStore();
const server = buildServer({ token, version: 'test-version', store, secrets });

const ANSWER_TEXT = '会话字段接线测试：模型返回的正文。';
/** 与两个样张正文都不重合的问题，避免被本机术语命中等分支干扰。 */
const CURRENT_QUESTION = '这篇文献的作者用了什么训练方法？';
/** 续读复用轮：上一轮已保存的回答正文与它的审计摘要（claims=5 不可能从复用响应重算）。 */
const REUSED_ANSWER = '上一轮已保存的回答正文：这句话被原样复用。';
const REUSED_AUDIT_SUMMARY: ChatAuditSummary = {
  claims: 5,
  supported: 2,
  inference: 1,
  unsupported: 2,
  heading: 0,
  claim_types: { DOCUMENT_INTERPRETATION: 3, HISTORICAL_FACT: 2 },
  source_changed: 1,
  invalid_citations: 1
};

let sessionDocId = '';
let chapterBookId = '';
/** 3 页著作的目录：第 1 章 = 第 1 页，第 2 章 = 第 2–3 页。 */
const STRUCTURE_NODES = [
  { title: 'Chapter one', page: 1, level: 1, origin: '测试', endPage: 1, parent: null },
  { title: 'Chapter two', page: 2, level: 1, origin: '测试', endPage: 2, parent: null }
];

interface RecordedModelCall {
  system: string;
  /** 最后一条 user 消息：阅读材料/审计材料（历史会作为 prior 排在它前面）。 */
  material: string;
  messages: Array<{ role: string; content: string }>;
}

let modelCalls: RecordedModelCall[] = [];

function headers(): Record<string, string> {
  return { 'x-studianda-token': token };
}

function jsonResponse(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
}

/** 系统提示里出现 QUESTION_ROUTE 时返回问题路由 JSON（短文献本机短路时用不到）。 */
const QUESTION_ROUTE_REPLY = JSON.stringify({
  document: true,
  search: false,
  reason: '阅读文献',
  reply: '',
  reading: 'document',
  confidence: 0.95,
  pages: [],
  queries: [],
  dimensions: [{ code: 'D1', label: '概念界定' }]
});

/** 从 READING_BATCH 的批次材料里取第一段原文，作为模型「逐字摘引」返回。 */
function quoteFromMaterial(user: string): string {
  const match = /\[1\][^\n]*\n([^\n]{4,})/.exec(user);
  return (match?.[1] ?? '').trim().slice(0, 60);
}

/** 从 READING_AUDIT 材料里取一条已给原文，作为 supported 的逐字证据。 */
function firstAuditEvidence(user: string): { source: number; quote: string } | null {
  const start = user.indexOf('{');
  if (start < 0) return null;
  try {
    const parsed = JSON.parse(user.slice(start)) as {
      evidence_index?: unknown;
      verified_quotes?: unknown;
    };
    const list = Array.isArray(parsed.verified_quotes)
      ? parsed.verified_quotes
      : Array.isArray(parsed.evidence_index)
        ? parsed.evidence_index
        : [];
    for (const row of list) {
      if (!row || typeof row !== 'object') continue;
      const item = row as { source?: unknown; quote?: unknown };
      if (typeof item.quote === 'string' && item.quote.trim().length >= 4) {
        return {
          source: typeof item.source === 'number' ? item.source : 1,
          quote: item.quote.trim().slice(0, 120)
        };
      }
    }
  } catch {
    // 材料不是 JSON：按没有证据处理。
  }
  return null;
}

/** 安装模型 mock：记录每次请求的消息（含 prior 历史），并返回可解析的结构。 */
function installModelMock(): void {
  modelCalls = [];
  vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
    const raw = init?.body ? String(init.body) : '';
    const body = raw ? (JSON.parse(raw) as { messages?: unknown }) : {};
    const messages = (Array.isArray(body.messages) ? body.messages : []).map((item) => {
      const row = item as { role?: unknown; content?: unknown };
      return { role: String(row.role ?? ''), content: String(row.content ?? '') };
    });
    const system = messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n');
    const material =
      [...messages].reverse().find((message) => message.role === 'user')?.content ?? '';
    modelCalls.push({ system, material, messages });
    let content = ANSWER_TEXT;
    if (system.includes('QUESTION_ROUTE')) {
      content = QUESTION_ROUTE_REPLY;
    } else if (system.includes('READING_BATCH')) {
      const quote = quoteFromMaterial(material);
      content = JSON.stringify({
        analysis: '本批要点：文献围绕该问题给出了论述。',
        evidence: quote ? [{ source: 1, quote, dimension: 'D1' }] : [],
        dimension_hits: quote ? ['D1'] : [],
        no_relevant_evidence: !quote
      });
    } else if (system.includes('READING_AUDIT')) {
      const evidence = firstAuditEvidence(material);
      content = JSON.stringify({
        claims: [
          {
            claim: 1,
            verdict: 'supported',
            reason: '原文支持',
            claim_type: 'DOCUMENT_INTERPRETATION',
            evidence_standard: 'GROUNDED',
            evidence: evidence ? [evidence] : []
          }
        ]
      });
    } else if (system.includes('早期上下文')) {
      // 会话摘要压缩请求（READING_SESSION_CONTEXT 的系统提示）。
      content = '早期摘要：用户关注测量口径与数据来源。';
    }
    return jsonResponse(content);
  });
}

/** 所有模型请求里出现过的消息（含 prior 历史）。 */
function allModelMessages(): Array<{ role: string; content: string }> {
  return modelCalls.flatMap((call) => call.messages);
}

function promptContains(text: string): boolean {
  return allModelMessages().some((message) => message.content.includes(text));
}

/** 内容与给定文本完全相同的 user 消息出现次数（当前问题重复进入历史的直接判据）。 */
function exactUserMessageCount(text: string): number {
  return allModelMessages().filter(
    (message) => message.role === 'user' && message.content.trim() === text.trim()
  ).length;
}

interface SseEvent {
  event: string;
  data: string;
}

function parseSse(body: string): SseEvent[] {
  return body
    .split('\n\n')
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => ({
      event: /^event: (.+)$/m.exec(chunk)?.[1] ?? '',
      data: /^data: (.+)$/m.exec(chunk)?.[1] ?? ''
    }))
    .filter((item) => Boolean(item.event));
}

async function postStream(payload: Record<string, unknown>): Promise<{
  statusCode: number;
  contentType: string;
  body: string;
  events: SseEvent[];
  result?: ChatResponse;
  error?: { message?: string; status?: number };
}> {
  const response = await server.inject({
    method: 'POST',
    url: '/api/v1/chat/ask/stream',
    headers: headers(),
    payload
  });
  const body = String(response.body ?? '');
  const events = parseSse(body);
  const resultEvent = events.find((event) => event.event === 'result');
  const errorEvent = events.find((event) => event.event === 'error');
  return {
    statusCode: response.statusCode,
    contentType: String(response.headers['content-type'] ?? ''),
    body,
    events,
    ...(resultEvent ? { result: JSON.parse(resultEvent.data) as ChatResponse } : {}),
    ...(errorEvent
      ? { error: JSON.parse(errorEvent.data) as { message?: string; status?: number } }
      : {})
  };
}

interface AskJsonBody extends ChatResponse {
  needs_confirmation?: boolean;
  budget?: BudgetEstimate;
}

async function postJson(payload: Record<string, unknown>): Promise<{
  statusCode: number;
  contentType: string;
  body: AskJsonBody;
}> {
  const response = await server.inject({
    method: 'POST',
    url: '/api/v1/chat/ask',
    headers: headers(),
    payload
  });
  return {
    statusCode: response.statusCode,
    contentType: String(response.headers['content-type'] ?? ''),
    body: response.json() as AskJsonBody
  };
}

// ---------------------------------------------------------------------------
// 会话数据构造：把"客户端已落库"的状态直接写进 store（ask 路由本身不写消息）。
// ---------------------------------------------------------------------------

function ensureSession(sessionId: string, title: string): void {
  const existing = readDocumentChatSessions(store, sessionDocId);
  if (existing.some((session) => session.id === sessionId)) return;
  writeDocumentChatSessions(store, sessionDocId, [
    ...existing,
    { id: sessionId, title, created: 'x', updated: 'x' }
  ]);
}

function seedTurns(sessionId: string, count: number, prefix: string): void {
  for (let index = 1; index <= count; index += 1) {
    store.addMessage({
      documentId: sessionDocId,
      role: 'user',
      content: `${prefix}第${index}问：数据从哪里来`,
      metadata: { sessionId }
    });
    store.addMessage({
      documentId: sessionDocId,
      role: 'assistant',
      content: `${prefix}第${index}答：文中用调查题项测量`,
      metadata: { sessionId }
    });
  }
}

/** 模拟客户端在发 ask 之前已经把本轮用户消息落库（去重护栏要处理的场景）。 */
function persistCurrentQuestion(sessionId: string, question: string): void {
  store.addMessage({
    documentId: sessionDocId,
    role: 'user',
    content: question,
    metadata: { sessionId }
  });
}

/**
 * 造一个「全部页已读完但任务还没被销掉」的续读任务：`answerWithReading()` 会走复用分支，
 * 不重新调用模型（响应里没有 audit），审计结论只能从会话历史的 `messages.audit_summary` 复制。
 */
function saveReusedReadingTask(taskId: string, question: string): void {
  store.saveReadingTask(
    taskId,
    {
      question,
      selection: '',
      documentId: sessionDocId,
      plan: { breadth: 'document', reason: '测试', origin: '规则', pages: [], queries: [], dimensions: [] },
      pagesRead: [1, 2],
      findings: [],
      answer: REUSED_ANSWER,
      sources: [],
      unread_pages: []
    },
    [sessionDocId]
  );
}

async function importSampleDocument(name: string, pageTexts: string[]): Promise<string> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let index = 0; index < pageTexts.length; index += 1) {
    const page = pdf.addPage([300, 400]);
    page.drawText(`${name} page ${index + 1}`, { x: 20, y: 40, size: 10, font });
  }
  const file = path.join(dataDir, name);
  writeFileSync(file, await pdf.save());
  const document = await store.importDocument(file, undefined, true);
  for (let index = 0; index < pageTexts.length; index += 1) {
    await store.savePageTextEdit(document.id, index + 1, pageTexts[index]!);
  }
  return document.id;
}

beforeAll(async () => {
  process.env.STUDIANDA_MODEL_BASE_URL = 'https://model.example.com/v1';
  process.env.STUDIANDA_MODEL_NAME = 'chat-model';
  process.env.STUDIANDA_MODEL_API_KEY = 'k-1';
  sessionDocId = await importSampleDocument('session.pdf', [
    '模型训练需要大量数据，本文讨论训练方法。',
    '第二页：数据质量决定模型效果。'
  ]);
  chapterBookId = await importSampleDocument('book.pdf', [
    '第一章原文：训练方法讨论。',
    '第二章原文：测量口径与数据来源。',
    '第二章续页：附录给出编码方式。'
  ]);
  store.updateDocument(chapterBookId, { docType: 'book' });
  expect(store.getDocument(chapterBookId)?.docCategory).toBe('book');
}, 120_000);

beforeEach(() => {
  clearRouteCache();
  resetReadingCompactionBackoff();
  installModelMock();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  clearRouteCache();
  store.deleteSettings(['reading.budget_pages', 'reading.budget_tokens']);
});

afterAll(async () => {
  await server.close();
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.STUDIANDA_MODEL_BASE_URL;
  delete process.env.STUDIANDA_MODEL_NAME;
  delete process.env.STUDIANDA_MODEL_API_KEY;
});

// ---------------------------------------------------------------------------
// 1. stream 路由
// ---------------------------------------------------------------------------

describe('stream /chat/ask/stream：chat_session_id', () => {
  it('带 chat_session_id：服务端完整会话进入提示词（>3 轮），本轮问题不重复进历史', async () => {
    const sessionId = 'stream-full';
    ensureSession(sessionId, '完整会话');
    seedTurns(sessionId, 5, 'S');
    persistCurrentQuestion(sessionId, CURRENT_QUESTION);

    const { statusCode, result, error } = await postStream({
      question: CURRENT_QUESTION,
      documentId: sessionDocId,
      chat_session_id: sessionId,
      // 客户端只带最近 1 轮：服务端不读会话时，第 1 轮不可能出现在提示词里。
      history: [
        { question: 'S第5问：数据从哪里来', answer: 'S第5答：文中用调查题项测量' }
      ],
      source_policy: 'document_only'
    });

    expect(error).toBeUndefined();
    expect(statusCode).toBe(200);
    expect(result?.answer).toContain(ANSWER_TEXT);
    // 完整会话：第 1 轮远超客户端最近 3 轮窗口，只有服务端读会话才会进提示词。
    expect(promptContains('S第1问')).toBe(true);
    // 客户端带来的兜底历史仍然生效。
    expect(promptContains('S第5问')).toBe(true);
    // 去重护栏：本轮问题只作为材料出现，不能再作为一条 user 历史重复出现。
    expect(exactUserMessageCount(CURRENT_QUESTION)).toBe(0);
  });

  it('不带 chat_session_id：与现状一致（只用客户端 history，不读会话、不写摘要）', async () => {
    const sessionId = 'stream-legacy';
    ensureSession(sessionId, '遗留会话');
    seedTurns(sessionId, 5, 'L');
    persistCurrentQuestion(sessionId, CURRENT_QUESTION);

    const { statusCode, result } = await postStream({
      question: CURRENT_QUESTION,
      documentId: sessionDocId,
      history: [{ question: 'L第5问：数据从哪里来', answer: 'L第5答：文中用调查题项测量' }],
      source_policy: 'document_only'
    });

    expect(statusCode).toBe(200);
    expect(result?.answer).toContain(ANSWER_TEXT);
    // 不读服务端会话：会话里的早期轮次不会进入任何模型提示词。
    expect(promptContains('L第1问')).toBe(false);
    // 客户端历史照旧生效。
    expect(promptContains('L第5问')).toBe(true);
    expect(
      readDocumentChatSessions(store, sessionDocId).find((session) => session.id === sessionId)
        ?.contextSummary
    ).toBeUndefined();
  });

  it('无效 chat_session_id：200 + 明确提示，不报 500，回退客户端历史', async () => {
    const { statusCode, result, error } = await postStream({
      question: CURRENT_QUESTION,
      documentId: sessionDocId,
      chat_session_id: 'no-such-session',
      history: [{ question: 'H第1问：数据从哪里来', answer: 'H第1答：文中用调查题项测量' }],
      source_policy: 'document_only'
    });

    expect(error).toBeUndefined();
    expect(statusCode).toBe(200);
    expect(result?.answer).toContain(ANSWER_TEXT);
    expect(result?.notice ?? '').toContain('没有找到该阅读会话');
    expect(promptContains('H第1问')).toBe(true);
  });

  it('两个会话交替提问：上下文不互相串', async () => {
    ensureSession('iso-a', 'A 会话');
    seedTurns('iso-a', 3, 'A会');
    ensureSession('iso-b', 'B 会话');
    seedTurns('iso-b', 3, 'B会');

    const first = await postStream({
      question: CURRENT_QUESTION,
      documentId: sessionDocId,
      chat_session_id: 'iso-a',
      source_policy: 'document_only'
    });
    expect(first.statusCode).toBe(200);
    expect(promptContains('A会第1问')).toBe(true);
    expect(promptContains('B会第1问')).toBe(false);

    modelCalls = [];
    const second = await postStream({
      question: '这篇文献的数据可靠吗？',
      documentId: sessionDocId,
      chat_session_id: 'iso-b',
      source_policy: 'document_only'
    });
    expect(second.statusCode).toBe(200);
    expect(promptContains('B会第1问')).toBe(true);
    // A 会话的历史不出现在 B 会话的回答请求里。
    expect(promptContains('A会第1问')).toBe(false);
  });

  it('超预算会话：HTTP 上触发压缩并写回 context_summary', async () => {
    const sessionId = 'stream-summary';
    ensureSession(sessionId, '摘要会话');
    seedTurns(sessionId, 12, 'C');
    persistCurrentQuestion(sessionId, CURRENT_QUESTION);

    const { statusCode, result } = await postStream({
      question: CURRENT_QUESTION,
      documentId: sessionDocId,
      chat_session_id: sessionId,
      source_policy: 'document_only'
    });

    expect(statusCode).toBe(200);
    const saved = readDocumentChatSessions(store, sessionDocId).find(
      (session) => session.id === sessionId
    );
    expect(saved?.contextSummary ?? '').toContain('早期摘要');
    expect(saved?.summaryUpto ?? 0).toBeGreaterThan(0);
    expect(result?.notice ?? '').toContain('压缩');
    // 摘要进入最终回答的提示词（而不仅是落库）。
    expect(promptContains('早期摘要')).toBe(true);
  });

  it('续读复用：带 session 时从 messages.audit_summary 继承审计摘要', async () => {
    const sessionId = 'stream-reuse';
    ensureSession(sessionId, '复用会话');
    const taskId = 'http-reuse-task';
    store.addMessage({
      documentId: sessionDocId,
      role: 'user',
      content: '模型训练方法是什么？',
      metadata: { sessionId }
    });
    store.addMessage({
      documentId: sessionDocId,
      role: 'assistant',
      content: REUSED_ANSWER,
      auditSummary: REUSED_AUDIT_SUMMARY,
      metadata: { sessionId }
    });
    saveReusedReadingTask(taskId, '模型训练方法是什么？');

    const { statusCode, result } = await postStream({
      question: '模型训练方法是什么？',
      documentId: sessionDocId,
      taskId,
      chat_session_id: sessionId,
      source_policy: 'document_only'
    });

    expect(statusCode).toBe(200);
    expect(result?.reused_answer).toBe(true);
    expect(result?.answer).toBe(REUSED_ANSWER);
    // claims=5 只可能来自复制：复用响应里没有 audit，重算只能是 0。
    expect(result?.audit_summary).toEqual(REUSED_AUDIT_SUMMARY);

    // 回归：同一复用轮不带 chat_session_id 时不继承（旧行为），且不报错。
    modelCalls = [];
    const legacy = await postStream({
      question: '模型训练方法是什么？',
      documentId: sessionDocId,
      taskId,
      source_policy: 'document_only'
    });
    expect(legacy.statusCode).toBe(200);
    expect(legacy.result?.reused_answer).toBe(true);
    expect(legacy.result?.audit_summary).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 2. 非 stream 路由
// ---------------------------------------------------------------------------

describe('非 stream /chat/ask：chat_session_id', () => {
  it('带 chat_session_id：服务端完整会话进入提示词，本轮问题不重复', async () => {
    const sessionId = 'json-full';
    ensureSession(sessionId, '完整会话');
    seedTurns(sessionId, 5, 'J');
    persistCurrentQuestion(sessionId, CURRENT_QUESTION);

    const { statusCode, body } = await postJson({
      question: CURRENT_QUESTION,
      documentId: sessionDocId,
      chat_session_id: sessionId,
      history: [{ question: 'J第5问：数据从哪里来', answer: 'J第5答：文中用调查题项测量' }],
      source_policy: 'document_only'
    });

    expect(statusCode).toBe(200);
    expect(body.answer).toContain(ANSWER_TEXT);
    expect(promptContains('J第1问')).toBe(true);
    expect(exactUserMessageCount(CURRENT_QUESTION)).toBe(0);
  });

  it('不带 chat_session_id：与现状一致', async () => {
    const sessionId = 'json-legacy';
    ensureSession(sessionId, '遗留会话');
    seedTurns(sessionId, 5, 'K');
    persistCurrentQuestion(sessionId, CURRENT_QUESTION);

    const { statusCode, body } = await postJson({
      question: CURRENT_QUESTION,
      documentId: sessionDocId,
      history: [{ question: 'K第5问：数据从哪里来', answer: 'K第5答：文中用调查题项测量' }],
      source_policy: 'document_only'
    });

    expect(statusCode).toBe(200);
    expect(body.answer).toContain(ANSWER_TEXT);
    expect(promptContains('K第1问')).toBe(false);
    expect(promptContains('K第5问')).toBe(true);
  });

  it('无效 chat_session_id：200 + 提示，不报 500', async () => {
    const { statusCode, body } = await postJson({
      question: CURRENT_QUESTION,
      documentId: sessionDocId,
      chat_session_id: 'missing-json-session',
      history: [{ question: 'M第1问：数据从哪里来', answer: 'M第1答' }],
      source_policy: 'document_only'
    });

    expect(statusCode).toBe(200);
    expect(body.answer).toContain(ANSWER_TEXT);
    expect(body.notice ?? '').toContain('没有找到该阅读会话');
  });
});

// ---------------------------------------------------------------------------
// 3. reading_chapter_index
// ---------------------------------------------------------------------------

describe('reading_chapter_index：预算闸门与真实阅读按同一章', () => {
  beforeEach(() => {
    vi.spyOn(store, 'getStructure').mockResolvedValue(STRUCTURE_NODES as never);
  });

  it('stream：闸门按用户选的章估算，与自动选章（整本）不同', async () => {
    store.updateSettings({ 'reading.budget_pages': '1' });

    const auto = await postStream({
      question: '这本书讲了什么？',
      documentId: chapterBookId,
      reading_scope: 'document',
      source_policy: 'document_only'
    });
    expect(auto.statusCode).toBe(200);
    expect(auto.contentType).toContain('application/json');
    const autoBody = JSON.parse(auto.body) as AskJsonBody;
    expect(autoBody.needs_confirmation).toBe(true);
    // 没有显式章节：自动选章不裁剪，按整本 3 页估。
    expect(autoBody.budget?.pages).toBe(3);
    expect(autoBody.budget?.scope).toBe('document');

    const chapter = await postStream({
      question: '这本书讲了什么？',
      documentId: chapterBookId,
      reading_scope: 'document',
      reading_chapter_index: 2,
      source_policy: 'document_only'
    });
    expect(chapter.statusCode).toBe(200);
    expect(chapter.contentType).toContain('application/json');
    const chapterBody = JSON.parse(chapter.body) as AskJsonBody;
    expect(chapterBody.needs_confirmation).toBe(true);
    // 显式第 2 章 = 第 2–3 页：只按这 2 页估。
    expect(chapterBody.budget?.pages).toBe(2);
    expect(chapterBody.budget?.scope).toBe('local');
  });

  it('stream：显式章节透传到 answerQuestion，真实阅读按该章', async () => {
    store.updateSettings({ 'reading.budget_pages': '2' });

    const { statusCode, contentType, result } = await postStream({
      question: '这本书讲了什么？',
      documentId: chapterBookId,
      reading_scope: 'document',
      reading_chapter_index: 2,
      source_policy: 'document_only'
    });

    expect(statusCode).toBe(200);
    expect(contentType).toContain('text/event-stream');
    expect(result?.answer).toContain(ANSWER_TEXT);
    expect(result?.chapter?.index).toBe(2);
    expect(result?.chapter_total).toBe(2);
  });

  it('非 stream：显式章节透传到 answerQuestion，真实阅读按该章', async () => {
    store.updateSettings({ 'reading.budget_pages': '2' });

    const { statusCode, body } = await postJson({
      question: '这本书讲了什么？',
      documentId: chapterBookId,
      reading_scope: 'document',
      reading_chapter_index: 2,
      source_policy: 'document_only'
    });

    expect(statusCode).toBe(200);
    expect(body.answer).toContain(ANSWER_TEXT);
    expect(body.chapter?.index).toBe(2);
    expect(body.chapter_total).toBe(2);
  });
});
