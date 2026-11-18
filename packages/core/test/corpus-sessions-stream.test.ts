import { request as httpRequest } from 'node:http';
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
 * 跨文献追问（`POST /api/v1/corpus-sessions/:id/ask`）的 SSE 进度流。
 *
 * 设计约束：精读回答必须经审计（逐字核验/缺证替换/页码裁剪）才可示人，所以 SSE 只允许
 * `stage` / `progress` / `error` / `result` 四类事件，**任何阶段都不下发正文增量**；
 * 正文只出现在审计完成后的单个 `result` 事件里（结构与一次性 JSON 完全一致）。
 *
 * 覆盖：
 * 1. 事件顺序 stage…→result；事件里不含正文/正文增量；result 与 JSON 模式键集合一致；
 * 2. 失败只发 error 不发 result，并如实落一条失败消息；
 * 3. 客户端中途断开不崩、并发锁会释放（真实 HTTP 连接，不是 inject）。
 *
 * 模型服务全程 `vi.stubGlobal('fetch')` 模拟，不联网；样张 PDF 由 pdf-lib 运行时生成。
 */

const token = 'corpus-stream-token';
const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-corpus-stream-'));
const store = new Store(dataDir);
const server = buildServer({ token, version: 'test-version', store, secrets: new SecretStore() });

let documentA = '';
let documentB = '';
let appPort = 0;
/** 模型调用延迟（毫秒）：断开测试用它在回答未结束时切断连接。 */
let modelDelayMs = 0;
/** 模型服务失败开关：验证「只发 error 不发 result」。 */
let modelFailure = false;

const headers = { 'x-studianda-token': token };
const streamHeaders = { ...headers, accept: 'text/event-stream' };

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
    // 材料不是 JSON（或半截）：按没有证据处理。
  }
  return null;
}

/** 跨文献管线用到的三类模型调用（逐批阅读 / 综合 / 审计）统一走本地 mock。 */
function installModelMock(): void {
  vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
    if (modelDelayMs > 0) {
      // 模拟真实 fetch：请求在途时 abort 立刻以 AbortError 失败（断开测试依赖这一点）。
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, modelDelayMs);
        init?.signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          },
          { once: true }
        );
      });
    }
    if (modelFailure) throw new Error('模型服务不可用');
    const raw = init?.body ? String(init.body) : '';
    const body = raw ? (JSON.parse(raw) as { messages?: unknown }) : {};
    const messages = (body.messages ?? []) as Array<{ role: string; content: string }>;
    const system = messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n');
    const user = messages.find((message) => message.role === 'user')?.content ?? '';
    let content = '';
    if (system.includes('READING_BATCH')) {
      const quote = quoteFromMaterial(user);
      content = JSON.stringify({
        analysis: '本批要点：文献围绕该问题给出了论述。',
        evidence: quote ? [{ source: 1, quote, dimension: 'D1' }] : [],
        dimension_hits: quote ? ['D1'] : [],
        no_relevant_evidence: !quote
      });
    } else if (system.includes('READING_AUDIT')) {
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
      content = '跨文献回答：这批文献给出了相关论述。';
    }
    return jsonResponse(content);
  });
}

async function importPdf(name: string, pages: number): Promise<string> {
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

async function askStream(
  sessionId: string,
  question: string
): Promise<{ statusCode: number; contentType: string; events: SseEvent[]; body: string }> {
  const response = await server.inject({
    method: 'POST',
    url: `/api/v1/corpus-sessions/${encodeURIComponent(sessionId)}/ask`,
    headers: streamHeaders,
    payload: { question }
  });
  const body = String(response.body ?? '');
  return {
    statusCode: response.statusCode,
    contentType: String(response.headers['content-type'] ?? ''),
    events: parseSse(body),
    body
  };
}

/** 真实 HTTP 连接：收到第一个阶段事件后立刻断开（模拟用户关窗口/取消）。 */
function askStreamThenAbort(sessionId: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const finish = (data: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(data);
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    const timer = setTimeout(() => fail(new Error('5s 内没有收到 SSE 阶段事件')), 5_000);
    const request = httpRequest(
      {
        host: '127.0.0.1',
        port: appPort,
        path: `/api/v1/corpus-sessions/${encodeURIComponent(sessionId)}/ask`,
        method: 'POST',
        headers: {
          'x-studianda-token': token,
          'content-type': 'application/json',
          accept: 'text/event-stream'
        }
      },
      (response) => {
        let data = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          data += chunk;
          if (data.includes('event: stage')) {
            // 先断开，再让 resolve 生效：服务端此时仍在回答中。
            response.destroy();
            finish(data);
          }
        });
        response.on('end', () => finish(data));
        response.on('error', (error) => fail(error));
      }
    );
    request.on('error', (error) => fail(error));
    request.end(JSON.stringify({ question: '中断测试' }));
  });
}

beforeAll(async () => {
  process.env.STUDIANDA_MODEL_BASE_URL = 'https://model.example.com/v1';
  process.env.STUDIANDA_MODEL_NAME = 'chat-model';
  process.env.STUDIANDA_MODEL_API_KEY = 'k-1';
  documentA = await importPdf('corpus-stream-a.pdf', 2);
  documentB = await importPdf('corpus-stream-b.pdf', 2);
  store.savePageTextEdit(documentA, 1, '甲文献第一页：讨论模型的定义。');
  store.savePageTextEdit(documentA, 2, '甲文献第二页：补充说明。');
  store.savePageTextEdit(documentB, 1, '乙文献第一页：也讨论模型训练。');
  store.savePageTextEdit(documentB, 2, '乙文献第二页：结论。');
  // 断开测试需要真实 HTTP 连接；其它用例仍用 server.inject。
  await server.listen({ port: 0, host: '127.0.0.1' });
  const address = server.server.address();
  appPort = typeof address === 'object' && address ? address.port : 0;
  expect(appPort).toBeGreaterThan(0);
}, 120_000);

beforeEach(() => {
  modelDelayMs = 0;
  modelFailure = false;
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
});

describe('跨文献追问 SSE 只推进度', () => {
  it('事件顺序 stage…→result；事件里不含任何正文增量，result 与 JSON 模式同构', async () => {
    const sessionId = await createSession([documentA, documentB]);
    const { statusCode, contentType, events } = await askStream(sessionId, '模型训练');
    expect(statusCode).toBe(200);
    expect(contentType).toContain('text/event-stream');
    expect(events.length).toBeGreaterThan(1);

    // ① 只有一个 result，且必须是最后一个事件（审计完成后才一次性下发）。
    const resultIndexes = events.flatMap((event, index) => (event.event === 'result' ? [index] : []));
    expect(resultIndexes).toHaveLength(1);
    expect(resultIndexes[0]).toBe(events.length - 1);
    // ② 开头就是阶段进度，不是正文。
    expect(events[0]!.event).toBe('stage');
    expect(events.slice(0, -1).some((event) => event.event === 'progress')).toBe(true);

    // ③ 禁止的增量正文事件名一个都不能出现。
    for (const forbidden of ['delta', 'token', 'content', 'answer', 'chunk', 'message']) {
      expect(events.some((event) => event.event === forbidden)).toBe(false);
    }

    // ④ 阶段文字含「读第几篇 / 综合 / 核对论断」，且「核对」在 result 之前。
    const stages = events
      .filter((event) => event.event === 'stage')
      .map((event) => (JSON.parse(event.data) as { text?: string }).text ?? '');
    expect(stages.some((text) => /正在读取第 \d+\/\d+ 篇/.test(text))).toBe(true);
    expect(stages).toContain('正在综合回答');
    expect(stages).toContain('正在核对论断与原文');
    expect(events.findIndex((event) => event.event === 'result')).toBeGreaterThan(
      stages.indexOf('正在核对论断与原文')
    );

    // ⑤ progress 形状是 {done,total,unit}，不携带正文。
    const progressEvents = events
      .filter((event) => event.event === 'progress')
      .map((event) => JSON.parse(event.data) as { done?: unknown; total?: unknown; unit?: unknown });
    expect(progressEvents.length).toBeGreaterThan(0);
    for (const item of progressEvents) {
      expect(typeof item.done).toBe('number');
      expect(typeof item.total).toBe('number');
      expect(item.total as number).toBeGreaterThan(0);
      expect(item.unit).toBe('批');
    }

    // ⑥ 正文只在 result 里：非 result 事件的 data 既没有正文键，也不含正文串。
    const result = JSON.parse(events.at(-1)!.data) as Record<string, unknown>;
    const answerText = result.answer;
    expect(typeof answerText).toBe('string');
    expect(answerText as string).toContain('跨文献回答');
    for (const event of events.slice(0, -1)) {
      const payload = JSON.parse(event.data) as Record<string, unknown>;
      for (const bodyKey of ['answer', 'content', 'delta', 'text_delta', 'answer_delta']) {
        expect(Object.keys(payload)).not.toContain(bodyKey);
      }
      expect(event.data).not.toContain(answerText as string);
      // 正文的任何实质片段都不能出现在进度事件里。
      expect(event.data).not.toContain('跨文献回答');
    }

    // ⑦ 与原来的一次性 JSON 行为同构：同一会话再问一次，键集合必须一致。
    const json = await server.inject({
      method: 'POST',
      url: `/api/v1/corpus-sessions/${encodeURIComponent(sessionId)}/ask`,
      headers,
      payload: { question: '模型训练' }
    });
    expect(json.statusCode).toBe(200);
    expect(String(json.headers['content-type'] ?? '')).toContain('application/json');
    const jsonBody = json.json() as Record<string, unknown>;
    expect(Object.keys(result).sort()).toEqual(Object.keys(jsonBody).sort());
    // 两种模式的正文都由审计后的回答落库，口径一致。
    expect(jsonBody.answer).toBe(result.answer);
    const messages = store.listCorpusSessionMessages(sessionId) as ChatMessageRecord[];
    expect(messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant'
    ]);
    expect(messages[1]!.content).toBe(result.answer);
  });

  it('失败时只发 error 不发 result，并如实落一条失败消息', async () => {
    const sessionId = await createSession([documentA]);
    modelFailure = true;
    const { statusCode, events } = await askStream(sessionId, '模型训练');
    expect(statusCode).toBe(200);
    expect(events.some((event) => event.event === 'result')).toBe(false);
    const errors = events.filter((event) => event.event === 'error');
    expect(errors).toHaveLength(1);
    expect(events.at(-1)!.event).toBe('error');
    const message = (JSON.parse(errors[0]!.data) as { message?: string }).message ?? '';
    expect(message.length).toBeGreaterThan(0);
    expect(message).toMatch(/[\u4e00-\u9fa5]/);

    // 失败如实落库：不伪造成功回答。
    const last = store.listCorpusSessionMessages(sessionId).at(-1)!;
    expect(last.role).toBe('assistant');
    expect(last.content).toContain('回答未完成：');
    expect(last.metadata.failed).toBe(true);
    expect(last.content).toContain(message);
  });

  it('客户端中途断开不崩溃，并发锁会释放', async () => {
    const sessionId = await createSession([documentA]);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      modelDelayMs = 200;
      const received = await askStreamThenAbort(sessionId);
      expect(received).toContain('event: stage');
      // 服务端察觉断开 → 取消本轮 → 释放锁；之后同一会话可以正常继续追问。
      modelDelayMs = 0;
      let followUpStatus = 0;
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const followUp = await server.inject({
          method: 'POST',
          url: `/api/v1/corpus-sessions/${encodeURIComponent(sessionId)}/ask`,
          headers,
          payload: { question: '断线后继续问' }
        });
        followUpStatus = followUp.statusCode;
        if (followUpStatus !== 409) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(followUpStatus).toBe(200);
      expect(unhandled).toEqual([]);
      // 断开的一轮没有伪造成功回答：只有「断开后继续问」那条落库的 assistant 回答。
      const assistantMessages = store
        .listCorpusSessionMessages(sessionId)
        .filter((message) => message.role === 'assistant');
      expect(assistantMessages).toHaveLength(1);
      expect(assistantMessages[0]!.metadata.failed).toBeUndefined();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
