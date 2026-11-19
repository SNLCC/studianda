import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearRouteCache } from '../src/question-route.js';
import { SecretStore } from '../src/secrets.js';
import { buildServer } from '../src/server.js';
import { ChatTurnRegistry, chatTurnKeyOf } from '../src/server/chat-turn-registry.js';
import { DocumentRequestRegistry } from '../src/server/document-request-registry.js';
import { Store } from '../src/store.js';

/**
 * 彻底删除文献时，在途的**问答请求**（`/chat/ask/stream` 与 `/chat/ask`）是否被中止的
 * 特征化测试。既有的 `purge-cancel-jobs.test.ts` 只覆盖整篇翻译任务；本文件补上 chat。
 *
 * 断言口径（先测后修：**只按实测行为断言，不为了让测试变绿而弱化**）：
 * 1. 流式请求在途时删文献：连接由服务端收尾（error{status:499} + end）、不崩、无
 *    unhandledRejection、`DocumentRequestRegistry` 里该文献登记归零、轮次锁释放；
 * 2. 删后无残留：`messages` / `document_chat_sessions` 里该文献没有（新的）行；
 * 3. 非流式 `/chat/ask`：同样在途删除，按实测记录它与流式的差异。
 *
 * 观测手段：`buildServer` 把两个注册表作为闭包内部对象创建、不对外暴露，因此测试在
 * `DocumentRequestRegistry.prototype.track` / `ChatTurnRegistry.prototype.begin` 上挂
 * 探针抓取**真实实例**（只读调用 `pending()` / `activeKeys()`），不改生产代码。
 *
 * 模型全程 `vi.stubGlobal('fetch')` 模拟：第一次模型调用挂起在可控延迟里，删除发生在
 * 请求确实阻塞于模型调用时（服务端已写出第一条 `stage` 之后），因此 "在途" 是确定的，
 * 不依赖固定睡眠赌时序。样张 PDF 由 pdf-lib 运行时生成，不联网。
 */

const token = 'purge-cancel-chat-token';
const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-purge-chat-'));
const store = new Store(dataDir);
const secrets = new SecretStore();
const server = buildServer({ token, version: 'test-version', store, secrets });

/** 真实 HTTP 连接（hijack / close / abort 只在真实 socket 上有意义）监听端口。 */
let appPort = 0;
/** 模型调用延迟：让请求在删除发生时确实还阻塞在模型请求里。 */
let modelDelayMs = 0;
/** 本轮测试里发生过的模型调用次数（用来确认请求已经走到模型调用）。 */
let modelCalls = 0;
/** 模型调用收到的 signal（用来确认 purge 的 abort 真的传到了 answerQuestion 的 fetch）。 */
const modelSignals: AbortSignal[] = [];

/** 通过 prototype 探针抓到的真实注册表实例（由 buildServer 创建后注入各路由）。 */
let requestRegistry: DocumentRequestRegistry | null = null;
let turnRegistry: ChatTurnRegistry | null = null;
const originalTrack = DocumentRequestRegistry.prototype.track;
const originalBegin = ChatTurnRegistry.prototype.begin;

let documentCounter = 0;

function headers(): Record<string, string> {
  return { 'x-studianda-token': token };
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

/** 安装模型 mock：路由 / 逐批阅读 / 审计各返回可解析结构；延迟由 `modelDelayMs` 控制。 */
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
    const body = raw
      ? (JSON.parse(raw) as { messages?: Array<{ role: string; content: string }> })
      : {};
    const messages = body.messages ?? [];
    const system = messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n');
    const user = messages.find((message) => message.role === 'user')?.content ?? '';
    let content = '模型回答';
    if (system.includes('QUESTION_ROUTE')) {
      content = JSON.stringify({
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
    } else if (system.includes('READING_BATCH')) {
      const quote = quoteFromMaterial(user);
      content = JSON.stringify({
        analysis: '本批要点：文献围绕该问题给出了论述。',
        evidence: quote ? [{ source: 1, quote, dimension: 'D1' }] : [],
        dimension_hits: quote ? ['D1'] : [],
        no_relevant_evidence: !quote
      });
    } else if (system.includes('READING_AUDIT')) {
      content = JSON.stringify({
        claims: [
          {
            claim: 1,
            verdict: 'supported',
            reason: '原文支持',
            claim_type: 'DOCUMENT_INTERPRETATION',
            evidence_standard: 'GROUNDED',
            evidence: []
          }
        ]
      });
    }
    return jsonResponse(content);
  });
}

async function waitFor(check: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`${label}（等待 ${timeoutMs}ms 超时）`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** 等一个宏任务，让 finally / close 回调里排队的 microtask 先跑完。 */
function nextMacrotask(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function requestsOf(): DocumentRequestRegistry {
  if (!requestRegistry) throw new Error('尚未捕获 DocumentRequestRegistry 实例：请求没有登记在途状态');
  return requestRegistry;
}

function turnsOf(): ChatTurnRegistry {
  if (!turnRegistry) throw new Error('尚未捕获 ChatTurnRegistry 实例：请求没有占用轮次锁');
  return turnRegistry;
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
  const document = await store.importDocument(file);
  await store.savePageTextEdit(document.id, 1, '模型训练需要大量数据，本文讨论训练方法。');
  await store.savePageTextEdit(document.id, 2, '第二页：数据质量决定模型效果。');
  return { id: document.id, name: document.name };
}

/** 预置"上一轮问答已落库"的历史（模拟真实界面在提问前已写入 user 消息、并有会话行）。 */
function seedHistory(documentId: string): void {
  const sessionId = 'session-1';
  store.createDocumentChatSession(documentId, {
    id: sessionId,
    title: '历史会话',
    created: new Date().toISOString(),
    updated: new Date().toISOString()
  });
  store.addMessage({
    documentId,
    role: 'user',
    content: '上一轮的提问',
    metadata: { sessionId }
  });
  store.addMessage({
    documentId,
    role: 'assistant',
    content: '上一轮的回答',
    metadata: { sessionId }
  });
}

function streamPayload(documentId: string): Record<string, unknown> {
  return {
    question: '这篇文献讲了什么？',
    documentId,
    page: 1,
    source_policy: 'document_only'
  };
}

function askPayload(documentId: string): Record<string, unknown> {
  return {
    question: '这篇文献讲了什么？',
    documentId,
    page: 1,
    source_policy: 'document_only'
  };
}

function purgeRequest(documentId: string, name: string) {
  return {
    method: 'POST' as const,
    url: `/api/v1/documents/${encodeURIComponent(documentId)}/purge`,
    headers: headers(),
    payload: { confirmName: name }
  };
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
  ended: boolean;
}

/**
 * 起一条真实的流式问答连接，收到第一条 `stage` 后执行 `trigger`（在途删除），
 * 然后等连接由服务端结束。返回服务端写出的全部 SSE 文本。
 * 超时上限 8s；`trigger` 的 promise 会等连接结束后一起 await。
 */
async function runStreamAndTrigger(
  payload: Record<string, unknown>,
  trigger: () => Promise<void>
): Promise<StreamRun> {
  let triggerPromise: Promise<void> | null = null;
  let timer: NodeJS.Timeout | null = null;
  const stream = await new Promise<StreamRun>((resolve, reject) => {
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
          if (!triggerPromise && data.includes('event: stage')) {
            // 服务端先写出 stage、再进入阅读链路；这里触发删除，请求确定在途。
            triggerPromise = trigger();
          }
        });
        response.on('end', () => {
          if (timer) clearTimeout(timer);
          if (!triggerPromise) {
            reject(new Error('连接在收到 event: stage 前就结束了，无法验证在途删除'));
            return;
          }
          resolve({ data, ended: true });
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
      reject(new Error('8s 内连接没有结束：删除没有中止在途回答'));
    }, 8_000);
    request.end(JSON.stringify(payload));
  });
  // 连接已由服务端收尾，再等删除动作完全完成。
  await triggerPromise;
  return stream;
}

beforeAll(async () => {
  process.env.STUDIANDA_MODEL_BASE_URL = 'https://model.example.com/v1';
  process.env.STUDIANDA_MODEL_NAME = 'chat-model';
  process.env.STUDIANDA_MODEL_API_KEY = 'k-1';
  // 在发起任何请求之前装探针：抓取 buildServer 内部真实创建的注册表实例（只读观测）。
  vi.spyOn(DocumentRequestRegistry.prototype, 'track').mockImplementation(function (
    this: DocumentRequestRegistry,
    documentIds: readonly (string | undefined)[],
    controller: AbortController
  ) {
    requestRegistry = this;
    return originalTrack.call(this, documentIds, controller);
  });
  vi.spyOn(ChatTurnRegistry.prototype, 'begin').mockImplementation(function (
    this: ChatTurnRegistry,
    key: string | null
  ) {
    turnRegistry = this;
    return originalBegin.call(this, key);
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
  clearRouteCache();
  installModelMock();
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearRouteCache();
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

describe('彻底删除文献时中止在途的问答请求', () => {
  it('流式 /chat/ask/stream 在途时删文献：连接被中止、登记归零、轮次锁释放', async () => {
    modelDelayMs = 800;
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const document = await createDocument('stream');
      const turnKey = chatTurnKeyOf(document.id);
      expect(turnKey).not.toBeNull();

      let purgeStatusCode = 0;
      let pendingAtPurge = 0;
      let signalAtPurge: AbortSignal | undefined;
      const stream = await runStreamAndTrigger(streamPayload(document.id), async () => {
        // 删除前先确认：请求确实登记在该文献名下、并且正阻塞在模型调用里。
        pendingAtPurge = requestsOf().pending(document.id);
        expect(pendingAtPurge).toBe(1);
        expect(requestsOf().pending()).toBe(1);
        signalAtPurge = modelSignals.at(-1);
        expect(signalAtPurge).toBeDefined();
        expect(signalAtPurge?.aborted).toBe(false);

        store.deleteDocument(document.id);
        const purge = await server.inject(purgeRequest(document.id, document.name));
        purgeStatusCode = purge.statusCode;
      });

      expect(purgeStatusCode).toBe(200);
      expect(stream.ended).toBe(true);
      expect(stream.data).toContain('event: stage');
      // ① 连接由服务端收尾：收到 499 取消事件，且绝不会再收到 result（回答没有完成）。
      const events = parseSse(stream.data);
      expect(events.some((event) => event.event === 'result')).toBe(false);
      const errorEvent = events.find((event) => event.event === 'error');
      expect(errorEvent).toBeDefined();
      const errorPayload = JSON.parse(errorEvent!.data) as { message?: unknown; status?: unknown };
      expect(errorPayload.status).toBe(499);
      expect(errorPayload.message).toBe('已取消阅读');
      // ② abort 真的传到了 answerQuestion 的模型调用（fetch 的 signal 被中止）。
      expect(signalAtPurge?.aborted).toBe(true);

      // ③ 该文献的在途登记归零（若仍登记，后续 purge/清空数据还会 abort 一个死请求）。
      await waitFor(() => requestsOf().pending(document.id) === 0, 'documentRequests 未归零');
      expect(requestsOf().pending(document.id)).toBe(0);
      expect(requestsOf().pending()).toBe(0);

      // ④ 轮次锁释放（直接读注册表；随后 rewind 走 404 而不是 409，不被锁拦住）。
      await waitFor(() => !turnsOf().activeKeys().includes(turnKey!), '轮次锁未释放');
      expect(turnsOf().activeKeys()).not.toContain(turnKey);
      const rewind = await server.inject({
        method: 'POST',
        url: `/api/v1/documents/${encodeURIComponent(document.id)}/messages/rewind`,
        headers: headers(),
        payload: {}
      });
      expect(rewind.statusCode).not.toBe(409);
      // 文档已彻底删除，rewind 的 404 来自文献存在性检查（不是轮次锁）。
      expect(rewind.statusCode).toBe(404);

      // ⑤ 服务端没崩：健康检查正常；没有 unhandledRejection。
      const health = await server.inject({ method: 'GET', url: '/api/v1/health', headers: headers() });
      expect(health.statusCode).toBe(200);
      await nextMacrotask();
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  }, 30_000);

  it('删后无残留数据：messages / document_chat_sessions 里没有该文献的新行', async () => {
    modelDelayMs = 800;
    const document = await createDocument('residual');
    // 模拟真实界面：提问前 user/assistant 历史消息与会话行已在库里。
    seedHistory(document.id);
    expect(store.listMessages(document.id)).toHaveLength(2);
    expect(store.listDocumentChatSessions(document.id)).toHaveLength(1);

    const stream = await runStreamAndTrigger(streamPayload(document.id), async () => {
      store.deleteDocument(document.id);
      const purge = await server.inject(purgeRequest(document.id, document.name));
      expect(purge.statusCode).toBe(200);
    });

    // 回答被中止：客户端拿不到 result，也就不会把 assistant 消息写回来。
    expect(stream.data).toContain('event: stage');
    const events = parseSse(stream.data);
    expect(events.some((event) => event.event === 'result')).toBe(false);
    expect(events.some((event) => event.event === 'error')).toBe(true);

    // 等 abort 后的收尾链路彻底跑完，再查库：任何"abort 后仍写库"都会在这里暴露。
    await waitFor(() => requestsOf().pending(document.id) === 0, 'documentRequests 未归零');
    await new Promise((resolve) => setTimeout(resolve, 150));
    await nextMacrotask();

    expect(store.getDocument(document.id)).toBe(null);
    // 直接查表（store 按 document_id 查），不是只看 HTTP：没有残留行，也没有新行。
    expect(store.listMessages(document.id)).toEqual([]);
    expect(store.listDocumentChatSessions(document.id)).toEqual([]);
  }, 30_000);

  it('非流式 /chat/ask 在途时删文献：按实测记录行为（应为 499 cancelled + 无残留）', async () => {
    modelDelayMs = 800;
    const document = await createDocument('nonstream');
    seedHistory(document.id);

    const inflight = server.inject({
      method: 'POST',
      url: '/api/v1/chat/ask',
      headers: headers(),
      payload: askPayload(document.id)
    });
    // 等请求真的登记 + 阻塞在模型调用里，再删除。
    await waitFor(
      () => modelCalls > 0 && requestRegistry !== null && requestRegistry.pending(document.id) === 1,
      '非流式请求没有进入在途登记 / 模型调用'
    );
    const signalAtPurge = modelSignals.at(-1);
    expect(signalAtPurge).toBeDefined();
    expect(signalAtPurge?.aborted).toBe(false);

    store.deleteDocument(document.id);
    const purge = await server.inject(purgeRequest(document.id, document.name));
    expect(purge.statusCode).toBe(200);
    expect(signalAtPurge?.aborted).toBe(true);

    // 实测行为：abort 传导到 answerQuestion → AbortError → 499 + cancelled（与流式同口径）。
    const response = await inflight;
    expect(response.statusCode).toBe(499);
    const body = JSON.parse(String(response.body)) as { error?: unknown; message?: unknown };
    expect(body.error).toBe('cancelled');
    expect(body.message).toBe('请求已取消');

    await waitFor(() => requestsOf().pending(document.id) === 0, 'documentRequests 未归零');
    await waitFor(() => !turnsOf().activeKeys().includes(chatTurnKeyOf(document.id)!), '轮次锁未释放');
    expect(store.getDocument(document.id)).toBe(null);
    expect(store.listMessages(document.id)).toEqual([]);
    expect(store.listDocumentChatSessions(document.id)).toEqual([]);
  }, 30_000);

  it.skip('删除后立刻用同一 id 重新导入/新建：importDocument 生成新 uuid，旧 id 不可复用（跳过）', () => {
    // 结论：`store.importDocument` 每次都生成新的 uuid（见 store/documents.ts 的 id 生成），
    // 没有「新文档复用旧 id」的入口，因此不存在"删掉再建同 id 把在途请求接回来"的场景。
    // 该场景在真实数据模型里不可达，跳过；若以后引入 id 复用，需要重新评估在途 abort 语义。
  });
});
