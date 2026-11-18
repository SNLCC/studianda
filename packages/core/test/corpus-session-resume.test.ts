import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessageRecord } from '@studianda/shared';
import { SecretStore } from '../src/secrets.js';
import { buildServer } from '../src/server.js';
import { Store } from '../src/store.js';

/**
 * 跨文献会话的「继续阅读」链路（路由级）：
 *
 * - `POST /corpus-sessions/:id/ask` 接受可选 `taskId`，把它透传给 `answerWithCorpus()`；
 *   未读完时响应用单篇同一口径的 `taskId` + `unread_pages`（+ `deferred_documents`）报告剩余页；
 * - 带 `taskId` 续问只补未读页：第二轮交给模型的批次材料里不能再出现第一轮已读页；
 * - `taskId` 必须由本会话产生、范围与会话快照一致，否则 400 且不落任何消息；
 * - 全部读完后任务被销掉，再带同一个 `taskId` 时明确返回上一轮完整回答（`reused_answer`）
 *   并说明无需续读；复用轮次的 `audit_summary` 从原消息复制（复制而非重算），响应与落库都非 NULL；
 * - SSE（`Accept: text/event-stream`）路径同样带 `taskId`/`unread_pages`/`audit_summary`，
 *   事件类型仍只有 stage/progress/error/result。
 *
 * 模型服务全程 `vi.stubGlobal('fetch')` 模拟，不联网；页文本直接写库，避免 PDF 文本抽取差异。
 */

const token = 'corpus-session-resume-token';
const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-corpus-session-resume-'));
const store = new Store(dataDir);
const server = buildServer({ token, version: 'test-version', store, secrets: new SecretStore() });
const headers = { 'x-studianda-token': token };

let documentA = '';
let documentB = '';

/** 第一轮只读一页、第二轮读完的页文本：单页成本 < 700 预算，两页合计 > 700，一轮最多 1 批。 */
const PAGE_FILLER = 'content '.repeat(45);
const PAGE_TEXT_A = `甲页标记。${PAGE_FILLER}`;
const PAGE_TEXT_B = `乙页标记。${PAGE_FILLER}`;

interface ModelState {
  batchMaterials: string[];
  calls: { batch: number; synthesis: number; audit: number };
}

function jsonResponse(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
}

/** 从批次材料里取第一段原文，作为模型"逐字摘引"返回（保证能通过核验）。 */
function quoteFromMaterial(user: string): string {
  const match = /\[1\][^\n]*\n([^\n]{4,})/.exec(user);
  return (match?.[1] ?? '').trim().slice(0, 60);
}

/** 从审计材料里取一条已给原文，作为 supported 的逐字证据。 */
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

/** 跨文献管线用到的模型调用（逐批阅读 / 综合 / 审计）统一走本地 mock，并记录批次材料。 */
function installModelMock(): ModelState {
  const state: ModelState = {
    batchMaterials: [],
    calls: { batch: 0, synthesis: 0, audit: 0 }
  };
  vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as { messages?: unknown }) : {};
    const messages = (body.messages ?? []) as Array<{ role: string; content: string }>;
    const system = messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n');
    const user = messages.find((message) => message.role === 'user')?.content ?? '';
    let content = '';
    if (system.includes('READING_BATCH')) {
      state.calls.batch += 1;
      state.batchMaterials.push(user);
      const quote = quoteFromMaterial(user);
      content = JSON.stringify({
        analysis: '本批要点：文献围绕该问题给出了论述。',
        evidence: quote ? [{ source: 1, quote, dimension: 'D1' }] : [],
        dimension_hits: quote ? ['D1'] : [],
        no_relevant_evidence: !quote
      });
    } else if (system.includes('READING_AUDIT')) {
      state.calls.audit += 1;
      const evidence = firstAuditEvidence(user);
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
    } else {
      state.calls.synthesis += 1;
      content = '跨文献回答：这批文献给出了相关论述。';
    }
    return jsonResponse(content);
  });
  return state;
}

async function importPdf(name: string): Promise<string> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([300, 400]);
  page.drawText(name, { x: 20, y: 20, size: 8, font });
  const file = path.join(dataDir, name);
  writeFileSync(file, await pdf.save());
  const document = await store.importDocument(file, undefined, true);
  return document.id;
}

async function createSession(documentIds: string[]): Promise<string> {
  const response = await server.inject({
    method: 'POST',
    url: '/api/v1/corpus-sessions',
    headers,
    payload: { documentIds }
  });
  expect(response.statusCode).toBe(200);
  const session = (response.json() as { session?: { id?: string } }).session;
  expect(session?.id).toBeTruthy();
  return String(session!.id);
}

type AskBody = Record<string, unknown> & { statusCode?: number };

/** 追问一次（默认 JSON；传 accept 时走 SSE 并返回原始事件流文本）。 */
async function ask(
  sessionId: string,
  options: { taskId?: string; accept?: string; question?: string } = {}
) {
  const response = await server.inject({
    method: 'POST',
    url: `/api/v1/corpus-sessions/${encodeURIComponent(sessionId)}/ask`,
    headers: { ...headers, ...(options.accept ? { accept: options.accept } : {}) },
    payload: {
      question: options.question ?? '模型',
      ...(options.taskId ? { taskId: options.taskId } : {})
    }
  });
  return response;
}

function jsonOf(response: Awaited<ReturnType<typeof ask>>): AskBody {
  return { statusCode: response.statusCode, ...(response.json() as Record<string, unknown>) };
}

/** 解析 SSE 事件流：返回事件名与 result 对象；只允许 stage/progress/error/result。 */
function parseEvents(raw: string): { event: string; data?: Record<string, unknown> }[] {
  const events: { event: string; data?: Record<string, unknown> }[] = [];
  for (const block of raw.split('\n\n')) {
    if (!block.trim()) continue;
    const lines = block.split('\n');
    const eventLine = lines.find((line) => line.startsWith('event: '));
    const dataLine = lines.find((line) => line.startsWith('data: '));
    expect(eventLine).toBeTruthy();
    const event = eventLine!.slice('event: '.length).trim();
    const data = dataLine ? (JSON.parse(dataLine.slice('data: '.length)) as Record<string, unknown>) : undefined;
    events.push({ event, data });
  }
  return events;
}

function resultOf(events: { event: string; data?: Record<string, unknown> }[]): AskBody {
  const result = [...events].reverse().find((entry) => entry.event === 'result');
  expect(result?.data).toBeTruthy();
  return result!.data as AskBody;
}

beforeAll(async () => {
  process.env.STUDIANDA_MODEL_BASE_URL = 'https://model.example.com/v1';
  process.env.STUDIANDA_MODEL_NAME = 'chat-model';
  process.env.STUDIANDA_MODEL_API_KEY = 'k-1';
  // 单批预算压到 700：两页必然超一轮上限，一轮最多 1 批，于是第一轮只读第一篇的一页。
  process.env.STUDIANDA_READING_BUDGET = '700';
  documentA = await importPdf('corpus-resume-a.pdf');
  documentB = await importPdf('corpus-resume-b.pdf');
  store.savePageTextEdit(documentA, 1, PAGE_TEXT_A);
  store.savePageTextEdit(documentB, 1, PAGE_TEXT_B);
  store.updateSettings({ 'reading.max_read_batches': '1' });
}, 120_000);

beforeEach(() => {
  installModelMock();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await server.close();
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.STUDIANDA_MODEL_BASE_URL;
  delete process.env.STUDIANDA_MODEL_NAME;
  delete process.env.STUDIANDA_MODEL_API_KEY;
  delete process.env.STUDIANDA_READING_BUDGET;
});

describe('跨文献会话继续阅读', () => {
  it('首问未读完 → 带 taskId 续问只补未读；两轮 assistant 落库且审计摘要非 NULL', async () => {
    const sessionId = await createSession([documentA, documentB]);

    const firstState = installModelMock();
    const first = jsonOf(await ask(sessionId));
    expect(first.statusCode).toBe(200);
    expect(first.reading_scope).toBe('corpus');
    // 与单篇同一口径：未读完时带任务编号 + 剩余页（扁平 unread_pages + 按文献 deferred_documents）。
    const taskId = String(first.taskId ?? '');
    expect(taskId).toBeTruthy();
    const firstUnread = Array.isArray(first.unread_pages) ? (first.unread_pages as number[]) : [];
    expect(firstUnread.length).toBeGreaterThan(0);
    expect(first.deferred_documents).toMatchObject({ [documentB]: [1] });
    expect(String(first.notice ?? '')).toContain('继续阅读');
    expect(firstState.calls.batch).toBe(1);

    const secondState = installModelMock();
    const second = jsonOf(await ask(sessionId, { taskId }));
    expect(second.statusCode).toBe(200);
    expect(second.taskId).toBe(taskId);
    expect(second.answer).toBeTruthy();
    // 第二轮把剩余页读完：不再报告剩余页，任务在库层销掉。
    expect(second.unread_pages ?? []).toEqual([]);
    expect(store.loadReadingTask(taskId)).toBeNull();
    // 只补未读：第二轮交给模型的材料里不能出现第一轮已读页的标记。
    expect(secondState.batchMaterials.length).toBeGreaterThan(0);
    for (const material of secondState.batchMaterials) {
      expect(material).not.toContain('甲页标记');
    }
    expect(secondState.batchMaterials.some((material) => material.includes('乙页标记'))).toBe(true);

    // 两轮各落 user/assistant：第二条 assistant 的 audit_summary 非 NULL（审计摘要进响应+落库）。
    const messages = store.listCorpusSessionMessages(sessionId);
    expect(messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant'
    ]);
    const assistants = messages.filter((message) => message.role === 'assistant');
    expect(assistants).toHaveLength(2);
    expect(assistants[0]!.metadata.taskId).toBe(taskId);
    expect(assistants[1]!.metadata.taskId).toBe(taskId);
    expect(assistants[1]!.auditSummary).toMatchObject({ claims: 1, supported: 1, unsupported: 0 });
    expect(assistants[1]!.auditSummary).toEqual(second.audit_summary);
  });

  it('全部读完后再带 taskId：返回上一轮完整回答并说明无需续读，审计摘要复制而非重算', async () => {
    const sessionId = await createSession([documentA, documentB]);
    const first = jsonOf(await ask(sessionId));
    const taskId = String(first.taskId ?? '');
    expect(taskId).toBeTruthy();
    const second = jsonOf(await ask(sessionId, { taskId }));
    expect(second.statusCode).toBe(200);
    expect(second.unread_pages ?? []).toEqual([]);
    const secondAnswer = String(second.answer ?? '');
    const secondSummary = second.audit_summary as Record<string, unknown>;
    expect(secondSummary).toMatchObject({ claims: 1, supported: 1 });

    // 任务已销掉（读完了）：再带同一 taskId 必须行为明确，而不是重新读一遍。
    const thirdState = installModelMock();
    const third = jsonOf(await ask(sessionId, { taskId }));
    expect(third.statusCode).toBe(200);
    expect(third.reused_answer).toBe(true);
    expect(third.taskId).toBe(taskId);
    expect(third.answer).toBe(secondAnswer);
    expect(String(third.notice ?? '')).toContain('进度已不存在');
    // 没有重新调用模型/读原文。
    expect(thirdState.calls.batch).toBe(0);
    expect(thirdState.calls.synthesis).toBe(0);
    expect(thirdState.calls.audit).toBe(0);
    // 复用轮次的审计摘要 = 被复用原消息的摘要（复制而非重算；重算只会是 0）。
    expect(third.audit_summary).toEqual(secondSummary);

    const messages = store.listCorpusSessionMessages(sessionId);
    expect(messages).toHaveLength(6);
    const thirdAssistant = messages.filter((message) => message.role === 'assistant').at(-1)!;
    expect(thirdAssistant.content).toBe(secondAnswer);
    expect(thirdAssistant.auditSummary).toEqual(secondSummary);
    expect(thirdAssistant.auditSummary).toEqual(third.audit_summary);
  });

  it('任务仍在但已无未读页（中断残留）→ answerWithCorpus 复用分支真实触发，审计摘要同样复制', async () => {
    const sessionId = await createSession([documentA, documentB]);
    const first = jsonOf(await ask(sessionId));
    const taskId = String(first.taskId ?? '');
    expect(taskId).toBeTruthy();
    const firstAnswer = String(first.answer ?? '');
    const firstSummary = first.audit_summary as Record<string, unknown>;
    expect(firstSummary).toMatchObject({ claims: 1, supported: 1 });

    // 复现「批次已读完但任务还没被销掉」的中断残留：把任务改成全部页已读、回答已保存。
    const saved = store.loadReadingTask<Record<string, unknown>>(taskId)!;
    store.saveReadingTask(
      taskId,
      {
        ...saved.payload,
        pagesRead: [1],
        unread_pages: [],
        readByDocument: { [documentA]: [1], [documentB]: [1] },
        deferredByDocument: {},
        answer: firstAnswer
      },
      [documentA, documentB]
    );

    const reusedState = installModelMock();
    const reused = jsonOf(await ask(sessionId, { taskId }));
    expect(reused.statusCode).toBe(200);
    expect(reused.reused_answer).toBe(true);
    expect(reused.answer).toBe(firstAnswer);
    expect(String(reused.notice ?? '')).toContain('没有需要补读的页');
    // 复用分支不再调用模型：本轮审计摘要只能从被复用的原消息复制。
    expect(reusedState.calls.batch).toBe(0);
    expect(reusedState.calls.synthesis).toBe(0);
    expect(reusedState.calls.audit).toBe(0);
    expect(reused.audit_summary).toEqual(firstSummary);
    expect(store.loadReadingTask(taskId)).toBeNull();

    const messages = store.listCorpusSessionMessages(sessionId);
    expect(messages).toHaveLength(4);
    const lastAssistant = messages.at(-1)!;
    expect(lastAssistant.role).toBe('assistant');
    expect(lastAssistant.auditSummary).toEqual(firstSummary);
    expect(lastAssistant.auditSummary).toEqual(reused.audit_summary);
  });

  it('taskId 属于别的会话（范围相同）→ 400，且不落消息', async () => {
    const owner = await createSession([documentA, documentB]);
    const taskId = String(jsonOf(await ask(owner)).taskId ?? '');
    expect(taskId).toBeTruthy();

    const other = await createSession([documentA, documentB]);
    const response = await ask(other, { taskId });
    expect(response.statusCode).toBe(400);
    const body = response.json() as { error?: string; message?: string };
    expect(body.error).toBe('bad_request');
    expect(String(body.message ?? '')).toContain('不属于该会话');
    expect(store.listCorpusSessionMessages(other)).toEqual([]);
    // 原任务不受影响，仍可继续读。
    expect(store.loadReadingTask(taskId)).not.toBeNull();
  });

  it('taskId 范围与会话快照不一致 → 400，且不落消息', async () => {
    const wider = await createSession([documentA, documentB]);
    const taskId = String(jsonOf(await ask(wider)).taskId ?? '');
    expect(taskId).toBeTruthy();

    const narrower = await createSession([documentA]);
    const response = await ask(narrower, { taskId });
    expect(response.statusCode).toBe(400);
    const body = response.json() as { message?: string };
    expect(String(body.message ?? '')).toContain('范围');
    expect(store.listCorpusSessionMessages(narrower)).toEqual([]);
  });

  it('不存在 / 非跨文献的 taskId → 400，且不触发阅读', async () => {
    const sessionId = await createSession([documentA]);
    const state = installModelMock();

    const unknown = await ask(sessionId, { taskId: 'no-such-task' });
    expect(unknown.statusCode).toBe(400);
    expect(String((unknown.json() as { message?: string }).message ?? '')).toContain('不存在');

    // 单篇阅读任务（payload 没有 kind='corpus'）不能接到跨文献会话上续读。
    store.saveReadingTask(
      'single-document-task',
      {
        question: '模型',
        selection: '',
        documentId: documentA,
        plan: { breadth: 'document', reason: '', origin: '规则', pages: [], queries: [], dimensions: [] },
        pagesRead: [],
        findings: [],
        answer: '',
        sources: [],
        unread_pages: [1]
      },
      [documentA]
    );
    try {
      const single = await ask(sessionId, { taskId: 'single-document-task' });
      expect(single.statusCode).toBe(400);
      expect(String((single.json() as { message?: string }).message ?? '')).toContain(
        '不是跨文献续读任务'
      );
      expect(state.calls.batch).toBe(0);
      expect(state.calls.synthesis).toBe(0);
      expect(store.listCorpusSessionMessages(sessionId)).toEqual([]);
    } finally {
      store.deleteReadingTask('single-document-task');
    }
  });

  it('SSE 路径带 taskId 与未读页；续问与复用都只走 stage/progress/error/result 事件', async () => {
    const sessionId = await createSession([documentA, documentB]);
    const firstResponse = await ask(sessionId, { accept: 'text/event-stream' });
    expect(firstResponse.statusCode).toBe(200);
    expect(firstResponse.headers['content-type']).toContain('text/event-stream');
    const firstEvents = parseEvents(firstResponse.body);
    expect(new Set(firstEvents.map((entry) => entry.event))).not.toContain('error');
    for (const entry of firstEvents) {
      expect(['stage', 'progress', 'error', 'result']).toContain(entry.event);
    }
    const first = resultOf(firstEvents);
    const taskId = String(first.taskId ?? '');
    expect(taskId).toBeTruthy();
    expect((Array.isArray(first.unread_pages) ? first.unread_pages : []).length).toBeGreaterThan(0);
    expect(first.audit_summary).toBeTruthy();

    const secondResponse = await ask(sessionId, { taskId, accept: 'text/event-stream' });
    expect(secondResponse.statusCode).toBe(200);
    const secondEvents = parseEvents(secondResponse.body);
    for (const entry of secondEvents) {
      expect(['stage', 'progress', 'error', 'result']).toContain(entry.event);
    }
    expect(secondEvents.some((entry) => entry.event === 'error')).toBe(false);
    const second = resultOf(secondEvents);
    expect(second.taskId).toBe(taskId);
    expect(second.unread_pages ?? []).toEqual([]);
    expect(second.audit_summary).toBeTruthy();

    // 读完后复用轮：同样只发 result（不是 error），并带回复制的审计摘要。
    const thirdResponse = await ask(sessionId, { taskId, accept: 'text/event-stream' });
    expect(thirdResponse.statusCode).toBe(200);
    const thirdEvents = parseEvents(thirdResponse.body);
    expect(thirdEvents.some((entry) => entry.event === 'error')).toBe(false);
    const third = resultOf(thirdEvents);
    expect(third.reused_answer).toBe(true);
    expect(third.audit_summary).toEqual(second.audit_summary);

    const messages: ChatMessageRecord[] = store.listCorpusSessionMessages(sessionId);
    expect(messages.filter((message) => message.role === 'assistant')).toHaveLength(3);
    expect(messages.at(-1)!.auditSummary).toEqual(second.audit_summary);
  });
});
