import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
 * `budgetGate` → `track` 微窗口（设计文档 §6 R7 的入口侧变体）的特征化测试。
 *
 * 窗口是什么：`/chat/ask*` 的顺序是 `await budgetGate(body)`（可能 await 章节结构 I/O）
 * → `chatTurns.begin`（同步）→ `documentRequests.track`。闸门算完到登记之间，本请求
 * 还没有 AbortController 进登记表；若 purge 恰好在这个窗口完成，本请求收不到 abort，
 * 会继续为**已删除**的文献跑下去（"为已删文献开始回答"）。
 *
 * 实测结论（本文件固定）：
 * 1. **不会写坏数据**：`answerQuestion` 在真正阅读前的 `answerWithReading` 入口复查
 *    `store.getDocument`（reading-chat.ts:2582-2583），已删除时返回 null；本请求最终
 *    200 + `answer:null`（notice「完整阅读没有返回结果」），不写 messages / reading_tasks /
 *    checkpoints / selection_snapshots（下方用 spy 固定为 0 次调用）；
 * 2. 代价是**多一次模型调用**：复查之前，`routeQuestion` 已按 QUESTION_ROUTE 发过一次
 *    路由模型请求（`shortCircuitRoute` 因文献不存在返回 null，没能短路掉它）；
 * 3. 清理仍然完整：轮次锁释放、`documentRequests` 归零、服务端不崩、无 unhandledRejection。
 *
 * 因此该窗口判为**数据无害、仅多一次路由调用**，不为它加 `track` 前复查：复查会多一次
 * 同步 DB 读，却消不掉那次路由模型调用；要消掉只能把 track 前移到闸门前，那会把
 * `needs_confirmation` 分支也纳入在途登记、改变其语义（见 chat-routes.ts 的注释）。
 *
 * 触发方式：`ChatTurnRegistry.prototype.begin` 是闸门之后、track 之前的**同步**调用点，
 * 在探针里先做一次真实 purge（软删除 → purgeDocument）再调用原 begin —— 正是该窗口，
 * 不依赖 sleep 赌时序。模型全程 `vi.stubGlobal('fetch')` 模拟，不联网。
 */

const token = 'chat-budget-window-token';
const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-budget-window-'));
const store = new Store(dataDir);
const secrets = new SecretStore();
const server = buildServer({ token, version: 'test-version', store, secrets });

/** `buildServer` 内部创建的登记表实例（prototype 探针只读观测，不修改生产代码）。 */
let requestRegistry: DocumentRequestRegistry | null = null;
let turnRegistry: ChatTurnRegistry | null = null;
const originalTrack = DocumentRequestRegistry.prototype.track;
const originalBegin = ChatTurnRegistry.prototype.begin;

/** 在 begin 里执行一次的 purge（模拟 purge 恰好落在 budgetGate → track 窗口）。 */
let purgeInWindow: (() => void) | null = null;
/** 窗口目标：只有这篇文献的 begin 才触发 purge。 */
let windowDocumentId: string | null = null;
let windowTurnKey: string | null = null;

/** 本轮请求登记进 documentRequests 的 controller（用来断言它没被 purge abort 到）。 */
const trackedControllers: AbortController[] = [];

let modelCalls = 0;
const modelSystems: string[] = [];
let documentCounter = 0;

/** 晚写库计数：窗口里的 purge 之后，本请求不能再有这些写。 */
let lateWrites: string[] = [];

function headers(): Record<string, string> {
  return { 'x-studianda-token': token };
}

function jsonResponse(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
}

/** 模型 mock：路由返回可解析结构；其余调用返回普通回答。 */
function installModelMock(): void {
  vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
    modelCalls += 1;
    const raw = init?.body ? String(init.body) : '';
    const body = raw
      ? (JSON.parse(raw) as { messages?: Array<{ role: string; content: string }> })
      : {};
    const system = (body.messages ?? [])
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n');
    modelSystems.push(system);
    if (system.includes('QUESTION_ROUTE')) {
      return jsonResponse(
        JSON.stringify({
          document: true,
          search: false,
          reason: '阅读文献',
          reply: '',
          reading: 'document',
          confidence: 0.95,
          pages: [],
          queries: [],
          dimensions: [{ code: 'D1', label: '概念界定' }]
        })
      );
    }
    return jsonResponse('回答');
  });
}

async function createDocument(label: string): Promise<{ id: string; name: string }> {
  documentCounter += 1;
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([300, 400]);
  page.drawText(`${label} page ${documentCounter}`, { x: 20, y: 40, size: 10, font });
  const file = path.join(dataDir, `doc-${documentCounter}-${label}.pdf`);
  writeFileSync(file, await pdf.save());
  const document = await store.importDocument(file, undefined, true);
  await store.savePageTextEdit(document.id, 1, '模型训练需要大量数据，本文讨论训练方法。');
  return { id: document.id, name: document.name };
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

function armPurgeInWindow(document: { id: string; name: string }): void {
  windowDocumentId = document.id;
  windowTurnKey = chatTurnKeyOf(document.id);
  // 与 `POST /documents/:id/purge` 相同的数据效果：软删除 → 彻底删除。
  // 路由的 abortDocumentRequests(id) 在这条请求上无效果（此刻它还没 track），
  // 这正是窗口的定义；直接调 store 与走 purge 路由对本请求等价。
  purgeInWindow = () => {
    store.deleteDocument(document.id);
    store.purgeDocument(document.id, document.name);
  };
}

beforeAll(async () => {
  process.env.STUDIANDA_MODEL_BASE_URL = 'https://model.example.com/v1';
  process.env.STUDIANDA_MODEL_NAME = 'chat-model';
  process.env.STUDIANDA_MODEL_API_KEY = 'k-1';
  // 抓真实登记表实例 + 记录本请求的 controller（只读观测）。
  vi.spyOn(DocumentRequestRegistry.prototype, 'track').mockImplementation(function (
    this: DocumentRequestRegistry,
    documentIds: readonly (string | undefined)[],
    controller: AbortController
  ) {
    requestRegistry = this;
    if (windowDocumentId && documentIds.includes(windowDocumentId)) {
      trackedControllers.push(controller);
    }
    return originalTrack.call(this, documentIds, controller);
  });
  // 窗口注入点：闸门之后、track 之前的同步 CAS 调用。
  vi.spyOn(ChatTurnRegistry.prototype, 'begin').mockImplementation(function (
    this: ChatTurnRegistry,
    key: string | null
  ) {
    turnRegistry = this;
    if (purgeInWindow && windowTurnKey !== null && key === windowTurnKey) {
      const runPurge = purgeInWindow;
      purgeInWindow = null;
      runPurge();
    }
    return originalBegin.call(this, key);
  });
  // 晚写库探针：窗口 purge 之后，这三个写入口一次都不应被本请求调用。
  const originalSaveReadingTask = store.saveReadingTask.bind(store);
  const originalSaveCheckpoint = store.saveCheckpoint.bind(store);
  const originalSaveSelectionSnapshot = store.saveSelectionSnapshot.bind(store);
  vi.spyOn(store, 'saveReadingTask').mockImplementation((...args) => {
    lateWrites.push('saveReadingTask');
    return originalSaveReadingTask(...args);
  });
  vi.spyOn(store, 'saveCheckpoint').mockImplementation((...args) => {
    lateWrites.push('saveCheckpoint');
    return originalSaveCheckpoint(...args);
  });
  vi.spyOn(store, 'saveSelectionSnapshot').mockImplementation((...args) => {
    lateWrites.push('saveSelectionSnapshot');
    return originalSaveSelectionSnapshot(...args);
  });
});

beforeEach(() => {
  modelCalls = 0;
  modelSystems.length = 0;
  trackedControllers.length = 0;
  lateWrites = [];
  purgeInWindow = null;
  windowDocumentId = null;
  windowTurnKey = null;
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

function askPayload(documentId: string): Record<string, unknown> {
  return {
    question: '这篇文献讲了什么？',
    documentId,
    page: 1,
    source_policy: 'document_only'
  };
}

describe('budgetGate → track 微窗口（purge 落在窗口里）', () => {
  it('非流式 /chat/ask：不写坏数据、仅多一次路由模型调用、锁与登记表都归零', async () => {
    const document = await createDocument('window-nonstream');
    armPurgeInWindow(document);

    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/chat/ask',
      headers: headers(),
      payload: askPayload(document.id)
    });

    // ① 文献在闸门之后、track 之前已被彻底删除。
    expect(store.getDocument(document.id)).toBe(null);
    // ② 实测返回：200 + answer:null（不是崩溃/500），notice 明说完整阅读没有返回结果。
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      answer?: unknown;
      sources?: unknown;
      notice?: unknown;
      needs_confirmation?: unknown;
    };
    expect(body.answer).toBe(null);
    expect(body.sources).toEqual([]);
    expect(String(body.notice ?? '')).toContain('完整阅读没有返回结果');
    expect(body.needs_confirmation).toBeUndefined();
    // ③ 代价只有一次模型调用，且是复查发生之前的路由判断（QUESTION_ROUTE）。
    expect(modelCalls).toBe(1);
    expect(modelSystems).toHaveLength(1);
    expect(modelSystems[0]).toContain('QUESTION_ROUTE');
    // ④ 数据面：本请求没有在 purge 之后写 messages/reading_tasks/checkpoints/选区快照。
    expect(lateWrites).toEqual([]);
    expect(store.listMessages(document.id)).toEqual([]);
    expect(store.listDocumentChatSessions(document.id)).toEqual([]);
    // ⑤ 清理：轮次锁释放、documentRequests 归零。
    expect(requestRegistry).not.toBeNull();
    expect(requestRegistry!.pending(document.id)).toBe(0);
    expect(requestRegistry!.pending()).toBe(0);
    expect(turnRegistry).not.toBeNull();
    expect(turnRegistry!.activeKeys()).not.toContain(chatTurnKeyOf(document.id));
    // ⑥ 窗口存在性证据：本请求的 controller 是在 purge 之后才登记的，因此没被 abort。
    expect(trackedControllers).toHaveLength(1);
    expect(trackedControllers[0]!.signal.aborted).toBe(false);
  }, 30_000);

  it('流式 /chat/ask/stream：SSE 正常收尾（result.answer=null）、不崩、无 unhandledRejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const document = await createDocument('window-stream');
      armPurgeInWindow(document);

      const response = await server.inject({
        method: 'POST',
        url: '/api/v1/chat/ask/stream',
        headers: headers(),
        payload: askPayload(document.id)
      });

      expect(store.getDocument(document.id)).toBe(null);
      expect(response.statusCode).toBe(200);
      expect(String(response.headers['content-type'] ?? '')).toContain('text/event-stream');
      const events = parseSse(String(response.body ?? ''));
      // 实测：先 stage、再 result；没有 error 事件（不是取消，是"没有可读文献"）。
      expect(events.some((event) => event.event === 'stage')).toBe(true);
      expect(events.some((event) => event.event === 'error')).toBe(false);
      const results = events.filter((event) => event.event === 'result');
      expect(results).toHaveLength(1);
      const result = JSON.parse(results[0]!.data) as { answer?: unknown; notice?: unknown };
      expect(result.answer).toBe(null);
      expect(String(result.notice ?? '')).toContain('完整阅读没有返回结果');

      // 同样只有一次路由模型调用；数据面无晚写。
      expect(modelCalls).toBe(1);
      expect(modelSystems[0]).toContain('QUESTION_ROUTE');
      expect(lateWrites).toEqual([]);
      expect(store.listMessages(document.id)).toEqual([]);

      // 清理与服务端存活。
      await new Promise((resolve) => setImmediate(resolve));
      expect(requestRegistry).not.toBeNull();
      expect(requestRegistry!.pending(document.id)).toBe(0);
      expect(requestRegistry!.pending()).toBe(0);
      expect(turnRegistry!.activeKeys()).not.toContain(chatTurnKeyOf(document.id));
      const health = await server.inject({
        method: 'GET',
        url: '/api/v1/health',
        headers: headers()
      });
      expect(health.statusCode).toBe(200);
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  }, 30_000);
});
