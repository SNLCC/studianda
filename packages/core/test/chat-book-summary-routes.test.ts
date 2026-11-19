import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { PDFDocument } from 'pdf-lib';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BookSummaryPlan, BookSummaryResult } from '@studianda/shared';
import type { RunBookSummaryOptions } from '../src/book-summary.js';
import { BookSummaryRunner } from '../src/book-summary-runner.js';
import { registerChatBookSummaryRoutes } from '../src/server/chat-book-summary-routes.js';
import { DocumentRequestRegistry } from '../src/server/document-request-registry.js';
import { SecretStore } from '../src/secrets.js';
import { Store } from '../src/store.js';

/**
 * 4 条 book-summary 路由的行为保持测试（不经过 `buildServer`，直接把路由模块挂到裸实例上，
 * 生成计划与执行生成注入假实现，不调用模型）。
 *
 * 三条重点（对应拆分前的行为）：
 * 1. start 幂等：running 时只返回 `{ job }`，不带 plan、不是 409；
 * 2. cancel 不返回 404：文档不存在也返回 idle 视图；
 * 3. DELETE 顺序：先 abort 在途 run → 再删任务条目 → 再清摘要缓存。
 */

const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-book-summary-routes-'));

const PLAN: BookSummaryPlan = {
  document_id: 'doc',
  document_name: '测试文献',
  total_pages: 2,
  blocks: [{ index: 0, title: '第 1–2 页', page: 1, end_page: 2, pages: 2, cached: false }],
  cached: 0,
  total: 1,
  source: 'range',
  content_version: 'v1',
  estimate: { pending_blocks: 1, calls: 1, input_tokens: 10, output_tokens: 5, model: 'summary-model' },
  book_available: false
};

const RESULT: BookSummaryResult = {
  document_id: 'doc',
  kind: 'book',
  content: '全书摘要',
  model: 'summary-model',
  created: '2026-11-19T00:00:00.000Z',
  content_version: 'v1',
  merge_levels: 0,
  blocks: []
};

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface PendingRun {
  options: RunBookSummaryOptions;
  done: Deferred<BookSummaryResult>;
}

let store: Store;
let app: FastifyInstance;
let runner: BookSummaryRunner;
let runs: PendingRun[];
let planCalls: number;
let documentId = '';
let pdfFile = '';

function api(pathname: string): string {
  return `/api/v1${pathname}`;
}

function startUrl(id = documentId): string {
  return api(`/documents/${encodeURIComponent(id)}/book-summary/start`);
}

function cancelUrl(id = documentId): string {
  return api(`/documents/${encodeURIComponent(id)}/book-summary/cancel`);
}

function deleteUrl(id = documentId): string {
  return api(`/documents/${encodeURIComponent(id)}/book-summary`);
}

async function startSummary(): Promise<void> {
  const response = await app.inject({ method: 'POST', url: startUrl() });
  expect(response.statusCode).toBe(200);
  expect(runs).toHaveLength(1);
}

function abortError(): Error {
  const error = new Error('已取消');
  error.name = 'AbortError';
  return error;
}

async function settle(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 50; index += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error('等待状态收敛超时');
}

async function flush(turns = 3): Promise<void> {
  for (let index = 0; index < turns; index += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

beforeAll(async () => {
  const pdf = await PDFDocument.create();
  for (let index = 0; index < 2; index += 1) pdf.addPage([300, 400]);
  pdfFile = path.join(dataDir, 'book-summary-routes.pdf');
  writeFileSync(pdfFile, await pdf.save());
  process.env.STUDIANDA_MODEL_BASE_URL = 'https://model.example.com/v1';
  process.env.STUDIANDA_MODEL_NAME = 'summary-model';
  process.env.STUDIANDA_MODEL_API_KEY = 'test-key';
});

beforeEach(async () => {
  store = new Store(dataDir);
  const document = await store.importDocument(pdfFile, path.basename(pdfFile), true);
  documentId = document.id;
  runs = [];
  planCalls = 0;
  app = Fastify();
  const requests = new DocumentRequestRegistry();
  runner = new BookSummaryRunner({
    store,
    requests,
    plan: async (id, model) => {
      planCalls += 1;
      return { ...PLAN, document_id: id, estimate: { ...PLAN.estimate, model } };
    },
    run: (options) => {
      const done = deferred<BookSummaryResult>();
      runs.push({ options, done });
      return done.promise;
    }
  });
  registerChatBookSummaryRoutes(app, { store, secrets: new SecretStore(), runner });
  await app.ready();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await app.close();
  store.close();
});

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.STUDIANDA_MODEL_BASE_URL;
  delete process.env.STUDIANDA_MODEL_NAME;
  delete process.env.STUDIANDA_MODEL_API_KEY;
});

describe('GET /documents/:id/book-summary', () => {
  it('返回 plan / job / result / overview；文档不存在 404', async () => {
    const response = await app.inject({ method: 'GET', url: deleteUrl() });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      plan: { total: number };
      job: { status: string };
      result: unknown;
      overview: string;
    };
    expect(body.plan.total).toBeGreaterThan(0);
    expect(body.job.status).toBe('idle');
    expect(body.result).toBeNull();
    expect(body.overview).toContain('book-summary-routes.pdf');
    expect(body.overview).toContain('共 1 个部分');

    const missing = await app.inject({ method: 'GET', url: deleteUrl('missing-doc') });
    expect(missing.statusCode).toBe(404);
  });
});

describe('POST /documents/:id/book-summary/start（幂等）', () => {
  it('首次返回 plan + running job；running 时再次 start 只返回 { job }（不 409、不带 plan）', async () => {
    const first = await app.inject({ method: 'POST', url: startUrl() });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json() as {
      job: { status: string; total: number };
      plan: { total: number };
    };
    expect(firstBody.job.status).toBe('running');
    expect(firstBody.job.total).toBe(1);
    expect(firstBody.plan.total).toBe(1);
    expect(planCalls).toBe(1);
    expect(runs).toHaveLength(1);

    const second = await app.inject({ method: 'POST', url: startUrl() });
    // 不是 409，也不再启动第二个后台 run。
    expect(second.statusCode).toBe(200);
    const secondBody = second.json() as { job: { status: string }; plan?: unknown };
    expect(secondBody.job.status).toBe('running');
    expect(secondBody.plan).toBeUndefined();
    expect(planCalls).toBe(1);
    expect(runs).toHaveLength(1);

    runs[0]!.done.resolve(RESULT);
    await settle(() => runner.view(documentId).status === 'done');
  });

  it('未配置模型时 400（文案保持原样）', async () => {
    const baseUrl = process.env.STUDIANDA_MODEL_BASE_URL;
    const model = process.env.STUDIANDA_MODEL_NAME;
    delete process.env.STUDIANDA_MODEL_BASE_URL;
    delete process.env.STUDIANDA_MODEL_NAME;
    try {
      const response = await app.inject({ method: 'POST', url: startUrl() });
      expect(response.statusCode).toBe(400);
      expect((response.json() as { message: string }).message).toContain('配置会话模型');
    } finally {
      process.env.STUDIANDA_MODEL_BASE_URL = baseUrl;
      process.env.STUDIANDA_MODEL_NAME = model;
    }
  });
});

describe('POST /documents/:id/book-summary/cancel（不返回 404）', () => {
  it('文档不存在也返回 idle 视图（200）', async () => {
    const response = await app.inject({ method: 'POST', url: cancelUrl('missing-doc') });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      document_id: 'missing-doc',
      status: 'idle',
      done: 0,
      total: 0,
      phase: ''
    });
  });

  it('running：返回「正在取消」的 running 视图，终态由后台 run 写回 cancelled', async () => {
    await startSummary();
    const response = await app.inject({ method: 'POST', url: cancelUrl() });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { status: string; phase: string };
    expect(body.status).toBe('running');
    expect(body.phase).toBe('正在取消');
    expect(runs[0]!.options.signal?.aborted).toBe(true);

    runs[0]!.done.reject(abortError());
    await settle(() => runner.view(documentId).status === 'cancelled');
  });
});

describe('DELETE /documents/:id/book-summary（顺序：abort → 删条目 → 清缓存）', () => {
  it('先 abort 在途 run，再删条目，最后 resetBookSummary；旧 run 迟到结束不回写', async () => {
    await startSummary();
    const deleteSpy = vi.spyOn(store, 'deleteBookSummaries');
    let resetCallsAtAbort = -1;
    runs[0]!.options.signal?.addEventListener('abort', () => {
      resetCallsAtAbort = deleteSpy.mock.calls.length;
    });

    const response = await app.inject({ method: 'DELETE', url: deleteUrl() });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    // abort 发生在缓存清理之前（顺序反了会留下继续写库的孤儿 run）。
    expect(runs[0]!.options.signal?.aborted).toBe(true);
    expect(resetCallsAtAbort).toBe(0);
    expect(deleteSpy).toHaveBeenCalledTimes(1);

    const after = await app.inject({ method: 'GET', url: deleteUrl() });
    expect((after.json() as { job: { status: string } }).job.status).toBe('idle');

    runs[0]!.done.reject(abortError());
    await flush();
    expect(runner.view(documentId).status).toBe('idle');

    const missing = await app.inject({ method: 'DELETE', url: deleteUrl('missing-doc') });
    expect(missing.statusCode).toBe(404);
  });
});
