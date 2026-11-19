import type { IncomingMessage } from 'node:http';
import { ServerResponse, request as httpRequest } from 'node:http';
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
 * `/api/v1/chat/ask/stream` 的**特征化测试**（characterization tests）：
 * 在把这条 SSE 路由从 `server.ts` 搬到 `server/chat-routes.ts` 之前先冻结现有行为。
 *
 * 覆盖五类：
 * 1. 正常流：stage/progress 若干 → 恰好一个 result 收尾；事件里没有正文增量；
 * 2. 客户端中途断开：服务端不崩、无 unhandledRejection、doc 轮次锁释放；
 * 3. 499 路径：断开后服务端是否尝试写 `error` 事件/`raw.end()`——按**实测行为**断言；
 * 4. 预算确认分支：200 纯 JSON、不 hijack、content-type 不是 event-stream；
 * 5. 注册/注销：断开后 `request.raw` 的 aborted / `reply.raw` 的 close 监听器不泄漏。
 *
 * 模型服务全程 `vi.stubGlobal('fetch')` 模拟，不联网；样张 PDF 由 pdf-lib 运行时生成。
 * 断开相关用例用**真实 HTTP 连接**（hijack/close/aborted 只在真实 socket 上有意义），
 * 其余用例用 `server.inject`。
 *
 * 这是基线测试：**只断言实测行为**，不修生产代码；若行为可疑，在报告里单独列出。
 */

const token = 'chat-stream-token';
const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-stream-sse-'));
const store = new Store(dataDir);
const secrets = new SecretStore();
const server = buildServer({ token, version: 'test-version', store, secrets });

/** 正常流的模型回答正文；用来断言它只出现在 result 事件里。 */
const ANSWER_TEXT = 'SSE 基线回答：模型训练依赖数据，本文给出了训练方法。';

let documentId = '';
let appPort = 0;
/** 模型调用延迟（毫秒）：断开用例用它保证回答还在途中就能切断连接。 */
let modelDelayMs = 0;

/** 真实 HTTP 请求的 IncomingMessage/ServerResponse 捕获（inject 不经过它们）。 */
interface CapturedRequest {
  req: IncomingMessage;
  res: ServerResponse;
  abortedBaseline: number;
  closeBaseline: number;
}
const captured: CapturedRequest[] = [];
/** 最近一条真实请求：ServerResponse.prototype 探针用它过滤目标响应。 */
let lastCaptured: CapturedRequest | undefined;

function headers(): Record<string, string> {
  return { 'x-studianda-token': token };
}

function jsonResponse(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
}

interface ModelMessage {
  role: string;
  content: string;
}

/** 系统提示里出现 QUESTION_ROUTE 时返回问题路由 JSON（文献很短时本机短路，可能用不到）。 */
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

/** 安装模型 mock：路由 / 逐批阅读 / 审计 / 综合回答各返回可解析的结构。 */
function installModelMock(): void {
  vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
    const signal = init?.signal ?? undefined;
    if (modelDelayMs > 0 || signal?.aborted) {
      await new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
          return;
        }
        const timer = setTimeout(resolve, modelDelayMs);
        signal?.addEventListener(
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
    const raw = init?.body ? String(init.body) : '';
    const body = raw ? (JSON.parse(raw) as { messages?: unknown }) : {};
    const messages = (body.messages ?? []) as ModelMessage[];
    const system = messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n');
    const user = messages.find((message) => message.role === 'user')?.content ?? '';
    let content = ANSWER_TEXT;
    if (system.includes('QUESTION_ROUTE')) {
      content = QUESTION_ROUTE_REPLY;
    } else if (system.includes('READING_BATCH')) {
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
    }
    return jsonResponse(content);
  });
}

async function importTestDocument(): Promise<string> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let index = 0; index < 2; index += 1) {
    const page = pdf.addPage([300, 400]);
    page.drawText(`stream sse page ${index + 1}`, { x: 20, y: 40, size: 10, font });
  }
  const file = path.join(dataDir, 'stream-sse.pdf');
  writeFileSync(file, await pdf.save());
  const document = await store.importDocument(file, undefined, true);
  await store.savePageTextEdit(document.id, 1, '模型训练需要大量数据，本文讨论训练方法。');
  await store.savePageTextEdit(document.id, 2, '第二页：数据质量决定模型效果。');
  return document.id;
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
  payload: Record<string, unknown>
): Promise<{ statusCode: number; contentType: string; events: SseEvent[]; body: string }> {
  const response = await server.inject({
    method: 'POST',
    url: '/api/v1/chat/ask/stream',
    headers: headers(),
    payload
  });
  const body = String(response.body ?? '');
  return {
    statusCode: response.statusCode,
    contentType: String(response.headers['content-type'] ?? ''),
    events: parseSse(body),
    body
  };
}

/**
 * 真实 HTTP 连接：收到第一条 `event: stage` 后立刻销毁响应（模拟用户关窗口/取消）。
 * 返回断开前收到的数据；超时上限 5s，不依赖固定睡眠。
 */
function askStreamThenAbort(payload: Record<string, unknown>): Promise<string> {
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
        path: '/api/v1/chat/ask/stream',
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
            // 先断开再 resolve：服务端此时仍在回答中。
            response.destroy();
            finish(data);
          }
        });
        response.on('end', () => finish(data));
        response.on('error', (error) => fail(error));
      }
    );
    request.on('error', (error) => fail(error));
    request.end(JSON.stringify(payload));
  });
}

/** 反复重试直到轮次锁被释放（rewind 不再 409）；超时上限 5s。 */
async function waitForLockRelease(): Promise<void> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const rewind = await server.inject({
      method: 'POST',
      url: `/api/v1/documents/${encodeURIComponent(documentId)}/messages/rewind`,
      headers: headers(),
      payload: {}
    });
    if (rewind.statusCode === 200) return;
    if (Date.now() >= deadline) {
      throw new Error(`轮次锁未在 5s 内释放（rewind 返回 ${rewind.statusCode}）`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** 等一个宏任务，让 finally/close 回调里排队的 microtask 先跑完。 */
function nextMacrotask(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

beforeAll(async () => {
  process.env.STUDIANDA_MODEL_BASE_URL = 'https://model.example.com/v1';
  process.env.STUDIANDA_MODEL_NAME = 'chat-model';
  process.env.STUDIANDA_MODEL_API_KEY = 'k-1';
  documentId = await importTestDocument();
  // 断开用例需要真实 HTTP 连接；其它用例仍用 server.inject。
  await server.listen({ port: 0, host: '127.0.0.1' });
  const address = server.server.address();
  appPort = typeof address === 'object' && address ? address.port : 0;
  expect(appPort).toBeGreaterThan(0);
  // 在 Fastify 自己的 request 监听器之后注册：捕获每个真实请求的 IncomingMessage/ServerResponse。
  server.server.on('request', (req, res) => {
    const entry: CapturedRequest = {
      req,
      res,
      abortedBaseline: req.listenerCount('aborted'),
      closeBaseline: res.listenerCount('close')
    };
    captured.push(entry);
    lastCaptured = entry;
  });
}, 120_000);

beforeEach(() => {
  modelDelayMs = 0;
  clearRouteCache();
  installModelMock();
});

afterEach(() => {
  vi.unstubAllGlobals();
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

describe('SSE 正常流', () => {
  it('事件顺序为 stage/progress 若干 → 恰好一个 result 收尾，且事件不含正文增量', async () => {
    const { statusCode, contentType, events, body } = await askStream({
      question: '这篇文献讲了什么？',
      documentId,
      page: 1,
      source_policy: 'document_only'
    });
    expect(statusCode).toBe(200);
    expect(contentType).toContain('text/event-stream');
    expect(events.length).toBeGreaterThan(1);

    // ① 只有 progress/stage/audit/result；正常流不能出现 error。
    for (const event of events) {
      expect(['progress', 'stage', 'audit', 'result']).toContain(event.event);
    }

    // ② 恰好一个 result，且必须是最后一个事件（正文一次性下发后才结束）。
    const resultIndexes = events.flatMap((event, index) =>
      event.event === 'result' ? [index] : []
    );
    expect(resultIndexes).toHaveLength(1);
    expect(resultIndexes[0]).toBe(events.length - 1);
    // result 之后连接结束：body 以完整事件块收尾。
    expect(body.endsWith('\n\n')).toBe(true);

    // ③ 先有阶段/进度，再有 result；progress 形状是 {done,total}，stage 形状是 {text}。
    const beforeResult = events.slice(0, -1);
    expect(beforeResult.some((event) => event.event === 'stage')).toBe(true);
    expect(beforeResult.some((event) => event.event === 'progress')).toBe(true);
    for (const event of beforeResult.filter((item) => item.event === 'stage')) {
      expect(Object.keys(JSON.parse(event.data) as Record<string, unknown>).sort()).toEqual(['text']);
    }
    for (const event of beforeResult.filter((item) => item.event === 'progress')) {
      const payload = JSON.parse(event.data) as { done?: unknown; total?: unknown };
      expect(Object.keys(payload).sort()).toEqual(['done', 'total']);
      expect(typeof payload.done).toBe('number');
      expect(typeof payload.total).toBe('number');
      expect(payload.total as number).toBeGreaterThan(0);
      expect(payload.done as number).toBeLessThanOrEqual(payload.total as number);
    }
    // audit 事件（实测存在且形状为 {claims:[...]}）——只出现在核对完成后、result 之前。
    const auditEvents = events.filter((event) => event.event === 'audit');
    expect(auditEvents.length).toBeGreaterThan(0);
    expect(JSON.parse(auditEvents[0]!.data)).toHaveProperty('claims');

    // ④ 不存在正文增量类事件名。
    expect(events.some((event) => event.event === 'delta')).toBe(false);
    expect(events.some((event) => event.event === 'token')).toBe(false);
    expect(events.some((event) => event.event === 'content')).toBe(false);

    // ⑤ 正文只经 result 一次性下发：任何事件都不带正文增量键；
    //    进度/阶段事件的 data 不含最终回答（audit 事件例外：实测 claim.text 会带核验后的
    //    论断文字，这不是增量流，属于既有行为，只在这里如实记录、不做限制）。
    const result = JSON.parse(events.at(-1)!.data) as {
      answer?: unknown;
      sources?: unknown;
    };
    expect(typeof result.answer).toBe('string');
    expect((result.answer as string).length).toBeGreaterThan(0);
    for (const event of events.slice(0, -1)) {
      const payload = JSON.parse(event.data) as Record<string, unknown>;
      for (const bodyKey of ['answer', 'content', 'delta', 'token', 'answer_delta', 'text_delta']) {
        expect(Object.keys(payload)).not.toContain(bodyKey);
      }
      if (event.event === 'stage' || event.event === 'progress') {
        expect(event.data).not.toContain(ANSWER_TEXT);
        expect(event.data).not.toContain(result.answer as string);
      }
    }
  }, 30_000);
});

describe('SSE 客户端中途断开', () => {
  it('断开不崩、无 unhandledRejection，doc 轮次锁会释放', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      modelDelayMs = 300;
      const received = await askStreamThenAbort({
        question: '这篇文献讲了什么？',
        documentId,
        page: 1,
        source_policy: 'document_only'
      });
      expect(received).toContain('event: stage');

      // 断开后服务端察觉取消 → 释放锁；随后同一文档的 rewind 能拿到锁（不是 409）。
      await waitForLockRelease();
      await nextMacrotask();
      expect(unhandled).toEqual([]);

      // 服务端仍能正常处理请求（没有崩溃）。
      modelDelayMs = 0;
      const followUp = await askStream({
        question: '断线后继续问：这篇文献讲了什么？',
        documentId,
        page: 1,
        source_policy: 'document_only'
      });
      expect(followUp.statusCode).toBe(200);
      expect(followUp.contentType).toContain('text/event-stream');
      expect(followUp.events.at(-1)?.event).toBe('result');
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  }, 30_000);

  it('499 路径：断开后服务端确实尝试写 error{status:499}，并在 finally 里 raw.end()', async () => {
    const writes: string[] = [];
    const originalWrite = ServerResponse.prototype.write;
    const originalEnd = ServerResponse.prototype.end;
    let endedCapturedResponse = 0;

    const patchedWrite = function (
      this: ServerResponse,
      chunk: unknown,
      ...rest: unknown[]
    ): boolean {
      writes.push(String(chunk));
      return Reflect.apply(originalWrite, this, [chunk, ...rest]) as boolean;
    } as unknown as typeof ServerResponse.prototype.write;
    const patchedEnd = function (this: ServerResponse, ...args: unknown[]): ServerResponse {
      // 只统计被断开的那条响应：node 内部也可能对别的响应调用 end()。
      if (lastCaptured && this === lastCaptured.res) endedCapturedResponse += 1;
      return Reflect.apply(originalEnd, this, args) as ServerResponse;
    } as unknown as typeof ServerResponse.prototype.end;

    ServerResponse.prototype.write = patchedWrite;
    ServerResponse.prototype.end = patchedEnd;
    try {
      modelDelayMs = 300;
      const received = await askStreamThenAbort({
        question: '这篇文献讲了什么？',
        documentId,
        page: 1,
        source_policy: 'document_only'
      });
      expect(received).toContain('event: stage');
      expect(lastCaptured).toBeDefined();

      await waitForLockRelease();
      await nextMacrotask();

      // 客户端侧收不到（socket 已销毁），只能观测服务端**是否尝试写**。
      // 实测行为：确实尝试写且只尝试一次 `event: error`，payload 为
      // {"message":"已取消阅读","status":499}；不会在取消之后再发 result。
      const errorChunks = writes.filter((chunk) => chunk.includes('event: error'));
      expect(errorChunks).toHaveLength(1);
      expect(errorChunks[0]).toContain('"status":499');
      expect(errorChunks[0]).toContain('"message":"已取消阅读"');
      expect(writes.some((chunk) => chunk.includes('event: result'))).toBe(false);
      // 实测行为：finally 里确实调用了被断开响应的 raw.end()。
      expect(endedCapturedResponse).toBeGreaterThan(0);
    } finally {
      ServerResponse.prototype.write = originalWrite;
      ServerResponse.prototype.end = originalEnd;
    }
  }, 30_000);

  it('断开后 request.raw 的 aborted / reply.raw 的 close 监听器不泄漏（回到请求开始时基线）', async () => {
    modelDelayMs = 300;
    const received = await askStreamThenAbort({
      question: '这篇文献讲了什么？',
      documentId,
      page: 1,
      source_policy: 'document_only'
    });
    expect(received).toContain('event: stage');
    await waitForLockRelease();
    await nextMacrotask();

    const target = captured.at(-1);
    expect(target).toBeDefined();
    // 路由在 finally 里 off('aborted') / off('close')；实测两条计数都精确回到请求开始时的基线。
    expect(target!.req.listenerCount('aborted')).toBe(target!.abortedBaseline);
    expect(target!.res.listenerCount('close')).toBe(target!.closeBaseline);
  }, 30_000);
});

describe('预算确认分支（needs_confirmation）', () => {
  it('返回 200 纯 JSON、不 hijack、content-type 不是 event-stream', async () => {
    // 把页数阈值压到 1 页：2 页文献的整篇范围必然超阈值 → 预算确认分支。
    store.updateSettings({ 'reading.budget_pages': '1' });
    try {
      const { statusCode, contentType, body } = await askStream({
        question: '这篇文献讲了什么？',
        documentId,
        reading_scope: 'document',
        source_policy: 'document_only'
      });
      expect(statusCode).toBe(200);
      // 纯 JSON：不是 SSE，也没有 hijack 的 text/event-stream 头。
      expect(contentType).toContain('application/json');
      expect(contentType).not.toContain('text/event-stream');
      expect(body.startsWith('event:')).toBe(false);
      expect(body).not.toContain('event: result');

      const parsed = JSON.parse(body) as {
        needs_confirmation?: unknown;
        answer?: unknown;
        sources?: unknown;
        metadata?: unknown;
        budget?: { exceeded?: unknown };
      };
      expect(parsed.needs_confirmation).toBe(true);
      expect(parsed.answer).toBe('');
      expect(parsed.sources).toEqual([]);
      expect(parsed.metadata).toEqual({});
      expect(parsed.budget?.exceeded).toBe(true);
    } finally {
      store.deleteSettings(['reading.budget_pages']);
    }
  }, 30_000);
});
