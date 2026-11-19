import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessageRecord } from '@studianda/shared';
import { SecretStore } from '../src/secrets.js';
import { buildServer } from '../src/server.js';
import { DocumentRequestRegistry } from '../src/server/document-request-registry.js';
import { Store } from '../src/store.js';

/**
 * 跨篇会话追问在途时彻底删除其中一篇文献 → 本轮必须中止（§6 R8 缺口）。
 *
 * 语义选择 A（中止整轮，而不是跳过该篇继续答）的依据见路由实现注释：
 * 本轮开始时已把每页原文快照进内存、证据来自这些快照，删除后继续读/综合会产出引用
 * 已删文献的 answer + sources；最终 audit 虽会重读库，但库缺失时回退到内存 snippet，
 * 仍按已删原文核验，等于静默给出一份引用已删文献的回答。
 *
 * 覆盖（真实 HTTP SSE 连接；模型全程 stub fetch；PDF 由 pdf-lib 运行时生成）：
 * 1. 在途删其中一篇：本轮中止，error{status:409,error:conflict} + 专属中文文案，
 *    绝不发 result；documentRequests 登记归零；轮次锁释放（activeAsks 清空）；
 * 2. 删与范围**无关**的文献：本轮不受影响，照常 result（防误中止）；
 * 3. 中止后同一会话重新发一轮：正常出回答（不会被残留锁/残留登记挡住）；
 * 4. 非流式 JSON 追问在途删文献：同样是 409/conflict，而不是客户端取消的 499/cancelled。
 */

const token = 'corpus-purge-abort-token';
const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-corpus-purge-abort-'));
const store = new Store(dataDir);
const secrets = new SecretStore();
const server = buildServer({ token, version: 'test-version', store, secrets });

let appPort = 0;
/** 每次模型调用统一延迟，保证删除发生时请求确实阻塞在模型请求里。 */
let modelDelayMs = 0;
/** 本轮已发生的模型调用次数。 */
let modelCalls = 0;
/** 模型调用拿到的 signal：确认 purge 的 abort 真的传到了回答链路。 */
const modelSignals: AbortSignal[] = [];
let documentCounter = 0;

const headers = { 'x-studianda-token': token };
const streamHeaders = { ...headers, accept: 'text/event-stream' };

/** 通过 prototype 探针抓到的真实登记表实例（buildServer 不对外暴露）。 */
let requestRegistry: DocumentRequestRegistry | null = null;
const originalTrack = DocumentRequestRegistry.prototype.track;

function requestsOf(): DocumentRequestRegistry {
  if (!requestRegistry) {
    throw new Error('尚未捕获 DocumentRequestRegistry 实例：请求没有登记在途状态');
  }
  return requestRegistry;
}

function abortError(): Error {
  const error = new Error('aborted');
  error.name = 'AbortError';
  return error;
}

function jsonResponse(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
}

function quoteFromMaterial(user: string): string {
  const match = /\[1\][^\n]*\n([^\n]{4,})/.exec(user);
  return (match?.[1] ?? '').trim().slice(0, 60);
}

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
    modelCalls += 1;
    const signal = init?.signal ?? undefined;
    if (signal) modelSignals.push(signal);
    if (modelDelayMs > 0 || signal?.aborted) {
      await new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
          reject(abortError());
          return;
        }
        const timer = setTimeout(resolve, modelDelayMs);
        signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(abortError());
          },
          { once: true }
        );
      });
    }
    const raw = init?.body ? String(init.body) : '';
    const body = raw ? (JSON.parse(raw) as { messages?: unknown }) : {};
    const messages = (body.messages ?? []) as Array<{ role: string; content: string }>;
    const system = messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n');
    // 取**最后一条** user 消息：会话历史会作为 prior 一并放进请求，材料永远在最后。
    const user = [...messages].reverse().find((message) => message.role === 'user')?.content ?? '';
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

/** 生成 2 页样张（每篇内容唯一，避免 store 的 sha256 重复导入判定）。 */
async function createDocument(label: string): Promise<{ id: string; name: string }> {
  documentCounter += 1;
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const pageNumber of [1, 2]) {
    const page = pdf.addPage([300, 400]);
    page.drawText(`${label} page ${pageNumber} #${documentCounter}`, {
      x: 20,
      y: 40,
      size: 10,
      font
    });
  }
  const file = path.join(dataDir, `doc-${documentCounter}-${label}.pdf`);
  writeFileSync(file, await pdf.save());
  const document = await store.importDocument(file, undefined, true);
  store.savePageTextEdit(document.id, 1, `${label}：模型训练需要大量数据，本文讨论训练方法。`);
  store.savePageTextEdit(document.id, 2, `${label}：第二页讨论数据质量与训练效果。`);
  return { id: document.id, name: document.name };
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

function purgeRequest(documentId: string, name: string) {
  return {
    method: 'POST' as const,
    url: `/api/v1/documents/${encodeURIComponent(documentId)}/purge`,
    headers,
    payload: { confirmName: name }
  };
}

/** 非流式追问（JSON），供「轮次锁/重发」用例使用。 */
function askJson(sessionId: string, question: string) {
  return server.inject({
    method: 'POST',
    url: `/api/v1/corpus-sessions/${encodeURIComponent(sessionId)}/ask`,
    headers,
    payload: { question }
  });
}

async function waitFor(check: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`${label}（等待 ${timeoutMs}ms 超时）`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
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

interface StreamRun {
  data: string;
}

/**
 * 起一条真实的跨篇追问 SSE 连接；收到第一条 `stage`（服务端已进入逐批阅读、模型请求在途）
 * 后执行 `trigger`（删除动作），然后等连接由服务端收尾。返回全部 SSE 文本。
 */
async function runStreamAndTrigger(
  sessionId: string,
  question: string,
  trigger: () => Promise<void>
): Promise<StreamRun> {
  let triggerPromise: Promise<void> | null = null;
  let timer: NodeJS.Timeout | null = null;
  const run = await new Promise<StreamRun>((resolve, reject) => {
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
          if (!triggerPromise && data.includes('event: stage')) {
            // 服务端先写出 stage、再发起模型请求；这里触发删除，请求确定在途。
            triggerPromise = trigger();
          }
        });
        response.on('end', () => {
          if (timer) clearTimeout(timer);
          if (!triggerPromise) {
            reject(new Error('连接在收到 event: stage 前就结束了，无法验证在途删除'));
            return;
          }
          resolve({ data });
        });
        response.on('error', (error) => {
          if (timer) clearTimeout(timer);
          reject(error);
        });
      }
    );
    request.on('error', (error) => {
      if (timer) clearTimeout(timer);
      reject(error);
    });
    timer = setTimeout(() => {
      request.destroy();
      reject(new Error('15s 内连接没有结束：删除没有中止在途回答'));
    }, 15_000);
    request.end(JSON.stringify({ question }));
  });
  // 连接已由服务端收尾，再等删除动作完全完成。
  await triggerPromise;
  return run;
}

beforeAll(async () => {
  process.env.STUDIANDA_MODEL_BASE_URL = 'https://model.example.com/v1';
  process.env.STUDIANDA_MODEL_NAME = 'chat-model';
  process.env.STUDIANDA_MODEL_API_KEY = 'k-1';
  // 在任何请求前装探针：抓 buildServer 内部真实创建的登记表实例（只读 pending() 观测）。
  vi.spyOn(DocumentRequestRegistry.prototype, 'track').mockImplementation(function (
    this: DocumentRequestRegistry,
    documentIds: readonly (string | undefined)[],
    controller: AbortController
  ) {
    requestRegistry = this;
    return originalTrack.call(this, documentIds, controller);
  });
  await server.listen({ port: 0, host: '127.0.0.1' });
  const address = server.server.address();
  appPort = typeof address === 'object' && address ? address.port : 0;
  expect(appPort).toBeGreaterThan(0);
}, 120_000);

beforeEach(() => {
  modelDelayMs = 0;
  modelCalls = 0;
  modelSignals.length = 0;
  installModelMock();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  vi.restoreAllMocks();
  await server.close();
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.STUDIANDA_MODEL_BASE_URL;
  delete process.env.STUDIANDA_MODEL_NAME;
  delete process.env.STUDIANDA_MODEL_API_KEY;
});

describe('跨篇追问在途时彻底删除文献', () => {
  it('读到首条 stage 后删其中一篇：本轮中止（409/conflict）、登记归零、轮次锁释放', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const first = await createDocument('abort-a');
      const second = await createDocument('abort-b');
      const sessionId = await createSession([first.id, second.id]);
      modelDelayMs = 800;

      let pendingAtPurge = 0;
      let busyDuringFlight = 0;
      let signalAtPurge: AbortSignal | undefined;
      const stream = await runStreamAndTrigger(sessionId, '模型训练', async () => {
        // 删除前：同一个 controller 按当前会话范围登记在两篇文献下。
        pendingAtPurge = requestsOf().pending();
        expect(requestsOf().pending(first.id)).toBe(1);
        expect(requestsOf().pending(second.id)).toBe(1);
        signalAtPurge = modelSignals.at(-1);
        expect(signalAtPurge).toBeDefined();
        expect(signalAtPurge?.aborted).toBe(false);
        // 本轮在途时，同一会话再发一轮被轮次锁挡住（activeAsks 正占用）。
        busyDuringFlight = (await askJson(sessionId, '在途时插一轮')).statusCode;
        expect(busyDuringFlight).toBe(409);

        store.deleteDocument(second.id);
        const purge = await server.inject(purgeRequest(second.id, second.name));
        expect(purge.statusCode).toBe(200);
      });

      expect(pendingAtPurge).toBe(2);
      // purge 的 abort 真的沿 signal 传到了在途模型请求。
      expect(signalAtPurge?.aborted).toBe(true);
      expect(stream.data).toContain('event: stage');
      const events = parseSse(stream.data);
      // 中止：绝不发 result（没有可审计的正文），只发一条 error。
      expect(events.some((event) => event.event === 'result')).toBe(false);
      const errorEvent = events.find((event) => event.event === 'error');
      expect(errorEvent).toBeDefined();
      const errorPayload = JSON.parse(errorEvent!.data) as Record<string, unknown>;
      expect(errorPayload.status).toBe(409);
      expect(errorPayload.error).toBe('conflict');
      expect(errorPayload.message).toBe('所选文献已被删除，本轮回答已中止');
      expect(errorPayload.deleted_document_ids).toEqual([second.id]);

      // 失败如实落库（与既有失败路径同口径，便于重开会话时看到中止原因）。
      const failed = store.listCorpusSessionMessages(sessionId).at(-1) as ChatMessageRecord;
      expect(failed.role).toBe('assistant');
      expect(failed.metadata.failed).toBe(true);
      expect(failed.content).toContain('所选文献已被删除，本轮回答已中止');

      // 登记归零：否则该文献后续 purge 会 abort 一个已结束的 controller。
      await waitFor(() => requestsOf().pending() === 0, 'documentRequests 未归零');
      expect(requestsOf().pending(second.id)).toBe(0);

      // activeAsks 已清空：同一会话立刻能再发一轮（若残留会一直 409 busy）。
      modelDelayMs = 0;
      let followUpStatus = 0;
      for (let attempt = 0; attempt < 50; attempt += 1) {
        followUpStatus = (await askJson(sessionId, '中止后继续问')).statusCode;
        if (followUpStatus !== 409) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(followUpStatus).toBe(200);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  }, 30_000);

  it('删除与本次范围无关的文献：本轮不受影响，照常出 result', async () => {
    const first = await createDocument('scope-a');
    const second = await createDocument('scope-b');
    const unrelated = await createDocument('unrelated-c');
    const sessionId = await createSession([first.id, second.id]);
    modelDelayMs = 250;

    let signalAtPurge: AbortSignal | undefined;
    const stream = await runStreamAndTrigger(sessionId, '模型训练', async () => {
      // 无关文献不在本次登记范围里。
      expect(requestsOf().pending(unrelated.id)).toBe(0);
      signalAtPurge = modelSignals.at(-1);
      expect(signalAtPurge?.aborted).toBe(false);
      store.deleteDocument(unrelated.id);
      const purge = await server.inject(purgeRequest(unrelated.id, unrelated.name));
      expect(purge.statusCode).toBe(200);
    });

    // 无关文献的 purge 不该 abort 本轮：signal 不受影响，连接照常以 result 收尾。
    expect(signalAtPurge?.aborted).toBe(false);
    const events = parseSse(stream.data);
    expect(events.some((event) => event.event === 'error')).toBe(false);
    const resultEvent = events.find((event) => event.event === 'result');
    expect(resultEvent).toBeDefined();
    expect(events.at(-1)!.event).toBe('result');
    const result = JSON.parse(resultEvent!.data) as { answer?: unknown };
    expect(typeof result.answer).toBe('string');
    expect(result.answer as string).toContain('跨文献回答');

    await waitFor(() => requestsOf().pending() === 0, 'documentRequests 未归零');
    await waitFor(() => requestsOf().pending(unrelated.id) === 0, '无关文献不应有登记');
  }, 30_000);

  it('中止后同一会话重新发一轮：正常出回答，不被残留状态挡住', async () => {
    const first = await createDocument('retry-a');
    const second = await createDocument('retry-b');
    const sessionId = await createSession([first.id, second.id]);
    modelDelayMs = 600;

    const stream = await runStreamAndTrigger(sessionId, '模型训练', async () => {
      store.deleteDocument(second.id);
      const purge = await server.inject(purgeRequest(second.id, second.name));
      expect(purge.statusCode).toBe(200);
    });
    expect(parseSse(stream.data).some((event) => event.event === 'error')).toBe(true);
    await waitFor(() => requestsOf().pending() === 0, 'documentRequests 未归零');

    modelDelayMs = 0;
    let response: Awaited<ReturnType<typeof askJson>> | null = null;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      response = await askJson(sessionId, '删完之后重新提问');
      if (response.statusCode !== 409) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(response?.statusCode).toBe(200);
    const body = response!.json() as Record<string, unknown>;
    expect(typeof body.answer).toBe('string');
    expect(body.answer as string).toContain('跨文献回答');
    // 范围按当前库状态解析：已删文献被跳过并在响应里报告（快照不改写）。
    expect(body.skipped_document_ids).toEqual([second.id]);
    // 新一轮正常落库：最后一条 assistant 不是失败占位。
    const last = store.listCorpusSessionMessages(sessionId).at(-1) as ChatMessageRecord;
    expect(last.role).toBe('assistant');
    expect(last.metadata.failed).toBeUndefined();
    expect(last.content).toContain('跨文献回答');

    await waitFor(() => requestsOf().pending() === 0, 'documentRequests 未归零');
  }, 30_000);

  it('非流式 JSON 追问在途删文献：409/conflict，且与客户端取消的 499/cancelled 区分', async () => {
    const first = await createDocument('json-a');
    const second = await createDocument('json-b');
    const sessionId = await createSession([first.id, second.id]);
    modelDelayMs = 600;

    const inflight = askJson(sessionId, '模型训练');
    await waitFor(
      () =>
        modelCalls > 0 &&
        requestRegistry !== null &&
        requestRegistry.pending(first.id) === 1 &&
        requestRegistry.pending(second.id) === 1,
      '非流式请求没有进入在途登记 / 模型调用'
    );
    const signalAtPurge = modelSignals.at(-1);
    expect(signalAtPurge?.aborted).toBe(false);

    store.deleteDocument(second.id);
    const purge = await server.inject(purgeRequest(second.id, second.name));
    expect(purge.statusCode).toBe(200);
    expect(signalAtPurge?.aborted).toBe(true);

    const response = await inflight;
    expect(response.statusCode).toBe(409);
    const body = JSON.parse(String(response.body)) as Record<string, unknown>;
    expect(body.error).toBe('conflict');
    expect(body.message).toBe('所选文献已被删除，本轮回答已中止');
    expect((body.details as { deleted_document_ids?: unknown }).deleted_document_ids).toEqual([
      second.id
    ]);
    // 与客户端断连（499 + cancelled）区分开。
    expect(body.error).not.toBe('cancelled');

    await waitFor(() => requestsOf().pending() === 0, 'documentRequests 未归零');
  }, 30_000);
});
