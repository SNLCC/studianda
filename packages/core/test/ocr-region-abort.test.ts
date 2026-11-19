import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OcrJobRecord } from '@studianda/shared';

const createWorkerMock = vi.fn();
vi.mock('tesseract.js', () => ({
  createWorker: (...args: unknown[]) => createWorkerMock(...args)
}));

import { shutdownOcrEnginePool } from '../src/ocr.js';
import { shutdownOcrRenderWorkers } from '../src/ocr-worker.js';
import { saveParsingConfig } from '../src/parsing-config.js';
import { buildServer } from '../src/server.js';
import { DocumentRequestRegistry } from '../src/server/document-request-registry.js';
import { SecretStore } from '../src/secrets.js';
import { Store } from '../src/store.js';

/**
 * 区域 OCR 后台任务（`POST /documents/:id/ocr/start`）在途时彻底删除文献的特征化测试。
 *
 * 缺口（先测后修）：区域 OCR 自己 new 了 AbortController，但没登记进 `documentRequests`，
 * 删文献时不会被中止，只靠事后 `addVisualChunk` 的「文档不存在」抛错收尾。
 *
 * 语义断言（本实现的取舍，理由见 ocr-routes.ts 里 `abortByServer` 注释）：
 * 1. 在途删**该文献**：purge 的 `abort(id)` 立刻中止识别（不是等识别跑完），任务记录落
 *    `state='failed' + error.code='document_deleted'`、中文文案说清「文献已删除」；
 *    **绝不落 `result`**，也不写任何派生行（`page_edits` / visual `chunks`）；
 * 2. 删**无关文献**：本轮不受影响，照常 `done` + 结果，且结果正常落检索索引（防误中止）；
 * 3. 中止后 `documentRequests.pending()` 归零（成功/失败/中止三条路径 finally 里 untrack）；
 * 4. 视觉路径不吃 signal：purge 之后才返回的识别结果必须丢弃，落库前不调用 addVisualChunk。
 *
 * 观测手段：`buildServer` 内部创建登记表，测试在 `DocumentRequestRegistry.prototype.track`
 * 上挂只读探针抓真实实例；样张 PDF 由 pdf-lib 运行时生成，tesseract 全程 mock（不联网）。
 */

const token = 'ocr-region-abort-token';
const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-ocr-region-abort-'));
const langDir = mkdtempSync(path.join(tmpdir(), 'studianda-ocr-region-abort-langs-'));
const store = new Store(dataDir);
const secrets = new SecretStore();
const server = buildServer({ token, version: 'test-version', store, secrets });

/** 通过 prototype 探针抓到的真实登记表实例（buildServer 不对外暴露）。 */
let requestRegistry: DocumentRequestRegistry | null = null;
const originalTrack = DocumentRequestRegistry.prototype.track;

const previousLangPath = process.env.STUDIANDA_OCR_LANG_PATH;
const previousWorkers = process.env.STUDIANDA_OCR_WORKERS;
const previousModelBaseUrl = process.env.STUDIANDA_MODEL_BASE_URL;
let documentCounter = 0;

function headers(): Record<string, string> {
  return { 'x-studianda-token': token };
}

function requestsOf(): DocumentRequestRegistry {
  if (!requestRegistry) {
    throw new Error('尚未捕获 DocumentRequestRegistry 实例：区域 OCR 没有登记在途状态');
  }
  return requestRegistry;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(check: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`${label}（等待 ${timeoutMs}ms 超时）`);
    await delay(10);
  }
}

function tesseractResult(text: string) {
  return {
    data: {
      text,
      blocks: [
        {
          paragraphs: [
            {
              lines: [
                {
                  text,
                  confidence: 90,
                  bbox: { x0: 10, y0: 10, x1: 200, y1: 40 }
                }
              ]
            }
          ]
        }
      ]
    }
  };
}

function fakeEngine(recognize: () => Promise<unknown>) {
  return {
    recognize: vi.fn(recognize),
    terminate: vi.fn(async () => undefined)
  };
}

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
  const file = path.join(dataDir, `fixture-${documentCounter}-${label}.pdf`);
  writeFileSync(file, await pdf.save());
  const document = await store.importDocument(file);
  return { id: document.id, name: document.name };
}

async function startJob(documentId: string): Promise<string> {
  const response = await server.inject({
    method: 'POST',
    url: `/api/v1/documents/${encodeURIComponent(documentId)}/ocr/start`,
    headers: headers(),
    payload: { page: 1, x0: 0.1, y0: 0.1, x1: 0.6, y1: 0.4 }
  });
  expect(response.statusCode).toBe(200);
  return (response.json() as { jobId: string }).jobId;
}

async function jobRecord(documentId: string, jobId: string): Promise<OcrJobRecord> {
  const response = await server.inject({
    method: 'GET',
    url: `/api/v1/documents/${encodeURIComponent(documentId)}/ocr/jobs/${encodeURIComponent(jobId)}`,
    headers: headers()
  });
  expect(response.statusCode).toBe(200);
  return response.json() as OcrJobRecord;
}

async function waitForJob(
  documentId: string,
  jobId: string,
  predicate: (record: OcrJobRecord) => boolean,
  label: string
): Promise<OcrJobRecord> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const record = await jobRecord(documentId, jobId);
    if (predicate(record)) return record;
    if (Date.now() >= deadline) {
      throw new Error(`${label}（等待 10s 超时，最后状态：${record.state}）`);
    }
    await delay(20);
  }
}

function purgeRequest(documentId: string, name: string) {
  return {
    method: 'POST' as const,
    url: `/api/v1/documents/${encodeURIComponent(documentId)}/purge`,
    headers: headers(),
    payload: { confirmName: name }
  };
}

function rawDb(): DatabaseSync {
  return (store as unknown as { db: DatabaseSync }).db;
}

function countRows(sql: string, documentId: string): number {
  const row = rawDb().prepare(sql).get(documentId) as { n?: number } | undefined;
  return Number(row?.n ?? 0);
}

/** `page_edits` 行数：区域 OCR 不应写整页文本。 */
function pageEditRows(documentId: string): number {
  return countRows('SELECT COUNT(*) AS n FROM page_edits WHERE document_id = ?', documentId);
}

/** 区域识别落库的唯一位置：`chunks` 里 bbox_space='visual' 的行。 */
function visualChunkRows(documentId: string): number {
  return countRows(
    "SELECT COUNT(*) AS n FROM chunks WHERE document_id = ? AND bbox_space = 'visual'",
    documentId
  );
}

beforeAll(async () => {
  // 假语言数据（>100KB）让 ensureOcrLanguageData 通过；识别由 mock 完成（真实语言包本机没有）。
  for (const lang of ['eng', 'chi_sim']) {
    writeFileSync(path.join(langDir, `${lang}.traineddata`), Buffer.alloc(200_000, 1));
  }
  process.env.STUDIANDA_OCR_LANG_PATH = langDir;
  process.env.STUDIANDA_OCR_WORKERS = '1';
  process.env.STUDIANDA_MODEL_BASE_URL = 'http://127.0.0.1:9/v1';
  saveParsingConfig(store, secrets, { mode: 'local', service_url: '', auto_ocr: false });
  // 在任何请求前装探针：抓 buildServer 内部真实创建的登记表实例（只读 pending() 观测）。
  vi.spyOn(DocumentRequestRegistry.prototype, 'track').mockImplementation(function (
    this: DocumentRequestRegistry,
    documentIds: readonly (string | undefined)[],
    controller: AbortController
  ) {
    requestRegistry = this;
    return originalTrack.call(this, documentIds, controller);
  });
});

beforeEach(() => {
  createWorkerMock.mockReset();
  // 默认引擎：正常返回一段区域文字（用例可用 mockImplementationOnce 覆盖）。
  createWorkerMock.mockImplementation(async () =>
    fakeEngine(async () => tesseractResult('默认区域文字'))
  );
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await shutdownOcrEnginePool();
  await shutdownOcrRenderWorkers();
});

afterAll(async () => {
  vi.restoreAllMocks();
  await shutdownOcrEnginePool();
  await shutdownOcrRenderWorkers();
  await server.close();
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(langDir, { recursive: true, force: true });
  if (previousLangPath === undefined) delete process.env.STUDIANDA_OCR_LANG_PATH;
  else process.env.STUDIANDA_OCR_LANG_PATH = previousLangPath;
  if (previousWorkers === undefined) delete process.env.STUDIANDA_OCR_WORKERS;
  else process.env.STUDIANDA_OCR_WORKERS = previousWorkers;
  if (previousModelBaseUrl === undefined) delete process.env.STUDIANDA_MODEL_BASE_URL;
  else process.env.STUDIANDA_MODEL_BASE_URL = previousModelBaseUrl;
});

describe('区域 OCR 在途时彻底删除文献', () => {
  it('在途删该文献：识别被中止、任务按 document_deleted 失败、无派生行、登记归零', async () => {
    const document = await createDocument('abort-self');
    let startedResolve: (() => void) | null = null;
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });
    const hungEngine = fakeEngine(() => {
      startedResolve?.();
      // 永不 settle：模拟很慢的一页识别。删除必须中止它，而不是等它跑完再丢弃结果。
      return new Promise<never>(() => undefined);
    });
    createWorkerMock.mockImplementationOnce(async () => hungEngine);

    const jobId = await startJob(document.id);
    await started;
    // 任务确实在途，且按文献登记（否则 purge 的 abort(id) 找不到它）。
    expect(requestsOf().pending(document.id)).toBe(1);
    expect((await jobRecord(document.id, jobId)).state).toBe('running');

    store.deleteDocument(document.id);
    const purge = await server.inject(purgeRequest(document.id, document.name));
    expect(purge.statusCode).toBe(200);
    // abort 沿 signal 传到正在识别的 tesseract 实例：挂起的识别被终止（不是等它跑完）。
    await waitFor(
      () => hungEngine.terminate.mock.calls.length > 0,
      'purge 的 abort 没有传到区域识别引擎'
    );

    const record = await waitForJob(
      document.id,
      jobId,
      (item) => item.state === 'failed' || item.state === 'cancelled',
      '中止后任务没有结束'
    );
    // 语义：明确失败并说清原因，不是静默 cancelled（那是用户点「取消」的语义）。
    expect(record.state).toBe('failed');
    expect(record.error?.code).toBe('document_deleted');
    expect(record.error?.message).toContain('文献已删除');
    expect(record.result).toBeUndefined();
    expect(record.progress).toBe(0);

    // 中止后登记归零（finally 里的 untrack 幂等，不留下死 controller）。
    await waitFor(() => requestsOf().pending(document.id) === 0, 'documentRequests 未归零');
    expect(requestsOf().pending()).toBe(0);

    // 唯一的数据副作用（检索索引）没有写入；区域 OCR 从不写 page_edits。
    expect(pageEditRows(document.id)).toBe(0);
    expect(visualChunkRows(document.id)).toBe(0);
  }, 60_000);

  it('删无关文献：在途区域识别不受影响，正常完成并返回结果', async () => {
    const target = await createDocument('target');
    const unrelated = await createDocument('unrelated');
    let startedResolve: (() => void) | null = null;
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });
    const releaseEngine: { call: ((value: unknown) => void) | null } = { call: null };
    const engine = fakeEngine(() => {
      startedResolve?.();
      return new Promise<unknown>((resolve) => {
        releaseEngine.call = resolve;
      });
    });
    createWorkerMock.mockImplementationOnce(async () => engine);

    const jobId = await startJob(target.id);
    await started;
    expect(requestsOf().pending(target.id)).toBe(1);
    expect(requestsOf().pending(unrelated.id)).toBe(0);

    // 删除一篇与本次识别无关的文献：本轮不能被打断（防误中止）。
    store.deleteDocument(unrelated.id);
    const purge = await server.inject(purgeRequest(unrelated.id, unrelated.name));
    expect(purge.statusCode).toBe(200);
    expect(requestsOf().pending(target.id)).toBe(1);
    expect((await jobRecord(target.id, jobId)).state).toBe('running');

    releaseEngine.call?.(tesseractResult('无关文献删除不影响本次区域识别'));
    const record = await waitForJob(
      target.id,
      jobId,
      (item) => item.state === 'done' || item.state === 'failed' || item.state === 'cancelled',
      '无关文献删除后本轮没有正常完成'
    );
    expect(record.state).toBe('done');
    expect(record.progress).toBe(100);
    expect(record.result?.text).toContain('无关文献删除不影响本次区域识别');
    // 正常路径照常落检索索引（证明不是「一律不写」换来的假绿）。
    expect(visualChunkRows(target.id)).toBeGreaterThan(0);
    expect(pageEditRows(target.id)).toBe(0);
    await waitFor(() => requestsOf().pending(target.id) === 0, 'documentRequests 未归零');
  }, 60_000);

  it('视觉路径晚到结果：中止后丢弃、不调用 addVisualChunk（不写检索索引）', async () => {
    const document = await createDocument('vision-late');
    saveParsingConfig(store, secrets, { mode: 'vision', model: 'vis-model', allow_remote: true });
    let fetchStartedResolve: (() => void) | null = null;
    const fetchStarted = new Promise<void>((resolve) => {
      fetchStartedResolve = resolve;
    });
    const releaseFetch: { call: ((response: Response) => void) | null } = { call: null };
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        fetchStartedResolve?.();
        return new Promise<Response>((resolve) => {
          releaseFetch.call = resolve;
        });
      })
    );

    // 记录 purge 之后是否还有人尝试写检索索引（写库前的中止守卫应拦住）。
    let purged = false;
    const writesAfterAbort: string[] = [];
    const originalAddVisualChunk = store.addVisualChunk.bind(store);
    const addSpy = vi
      .spyOn(store, 'addVisualChunk')
      .mockImplementation((documentId, page, text, bbox) => {
        if (purged) writesAfterAbort.push(text);
        return originalAddVisualChunk(documentId, page, text, bbox);
      });
    try {
      const jobId = await startJob(document.id);
      await fetchStarted;
      expect(requestsOf().pending(document.id)).toBe(1);

      store.deleteDocument(document.id);
      const purge = await server.inject(purgeRequest(document.id, document.name));
      expect(purge.statusCode).toBe(200);
      purged = true;

      // 视觉/自定义路径的 fetch 不吃 controller.signal：识别在中止之后才返回。
      releaseFetch.call?.({
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: 'LATE-REGION-TEXT' } }] })
      } as unknown as Response);

      const record = await waitForJob(
        document.id,
        jobId,
        (item) => item.state === 'failed' || item.state === 'cancelled',
        '中止后任务没有结束'
      );
      expect(record.state).toBe('failed');
      expect(record.error?.code).toBe('document_deleted');
      expect(record.error?.message).toContain('文献已删除');
      // 晚到结果被丢弃：既有文档已删，也没有任何东西被写回。
      expect(record.result).toBeUndefined();
      expect(writesAfterAbort).toEqual([]);
      expect(visualChunkRows(document.id)).toBe(0);
      expect(pageEditRows(document.id)).toBe(0);
      await waitFor(() => requestsOf().pending(document.id) === 0, 'documentRequests 未归零');
    } finally {
      addSpy.mockRestore();
      saveParsingConfig(store, secrets, { mode: 'local', service_url: '', auto_ocr: false });
    }
  }, 60_000);
});
