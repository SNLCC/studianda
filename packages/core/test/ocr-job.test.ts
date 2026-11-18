import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const createWorkerMock = vi.fn();
vi.mock('tesseract.js', () => ({
  createWorker: (...args: unknown[]) => createWorkerMock(...args)
}));

import { ocrEnginePoolStats, shutdownOcrEnginePool } from '../src/ocr.js';
import { ocrRenderWorkerStats, shutdownOcrRenderWorkers } from '../src/ocr-worker.js';
import { saveParsingConfig } from '../src/parsing-config.js';
import { buildServer } from '../src/server.js';
import { SecretStore } from '../src/secrets.js';
import { Store } from '../src/store.js';

const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-ocr-job-'));
const langDir = mkdtempSync(path.join(tmpdir(), 'studianda-ocr-job-langs-'));
const store = new Store(dataDir);
const secrets = new SecretStore();
const server = buildServer({
  token: 'ocr-job-token',
  version: 'test',
  store,
  secrets
});
const previousLangPath = process.env.STUDIANDA_OCR_LANG_PATH;
const previousWorkers = process.env.STUDIANDA_OCR_WORKERS;
let documentId = '';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

beforeAll(async () => {
  // 假语言数据（>100KB）让 ensureOcrLanguageData 通过；识别由 mock 完成（真实语言包本机没有）。
  for (const lang of ['eng', 'chi_sim']) {
    writeFileSync(path.join(langDir, `${lang}.traineddata`), Buffer.alloc(200_000, 1));
  }
  process.env.STUDIANDA_OCR_LANG_PATH = langDir;
  process.env.STUDIANDA_OCR_WORKERS = '2';
  saveParsingConfig(store, secrets, { mode: 'local', service_url: '', auto_ocr: false });
});

afterAll(async () => {
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
});

function headers(): Record<string, string> {
  return { 'x-studianda-token': 'ocr-job-token' };
}

function startJob(): Promise<{ jobId: string }> {
  return server
    .inject({
      method: 'POST',
      url: `/api/v1/documents/${documentId}/ocr/start`,
      headers: headers(),
      payload: { page: 1, x0: 0.1, y0: 0.1, x1: 0.6, y1: 0.4 }
    })
    .then((response) => {
      expect(response.statusCode).toBe(200);
      return response.json() as { jobId: string };
    });
}

async function jobState(jobId: string): Promise<{ state: string; result?: unknown; progress: number }> {
  const response = await server.inject({
    method: 'GET',
    url: `/api/v1/documents/${documentId}/ocr/jobs/${jobId}`,
    headers: headers()
  });
  expect(response.statusCode).toBe(200);
  return response.json() as { state: string; result?: unknown; progress: number };
}

describe('POST /api/v1/documents/:id/ocr/start', () => {
  it('creates a document fixture', async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage();
    const file = path.join(dataDir, 'ocr-fixture.pdf');
    writeFileSync(file, await pdf.save());
    const document = await store.importDocument(file);
    documentId = document.id;
    expect(documentId).toBeTruthy();
  });

  it('validates page and coordinates before creating a job', async () => {
    const badPage = await server.inject({
      method: 'POST',
      url: `/api/v1/documents/${documentId}/ocr/start`,
      headers: headers(),
      payload: { page: 0, x0: 0, y0: 0, x1: 10, y1: 10 }
    });
    expect(badPage.statusCode).toBe(400);

    const badCoords = await server.inject({
      method: 'POST',
      url: `/api/v1/documents/${documentId}/ocr/start`,
      headers: headers(),
      payload: { page: 1, x0: 'a', y0: 0, x1: 10, y1: 10 }
    });
    expect(badCoords.statusCode).toBe(400);
  });

  it('returns 404 for unknown document and unknown job', async () => {
    const missingDoc = await server.inject({
      method: 'POST',
      url: '/api/v1/documents/nope/ocr/start',
      headers: headers(),
      payload: { page: 1, x0: 0, y0: 0, x1: 10, y1: 10 }
    });
    expect(missingDoc.statusCode).toBe(404);

    const missingJob = await server.inject({
      method: 'GET',
      url: `/api/v1/documents/${documentId}/ocr/jobs/nope`,
      headers: headers()
    });
    expect(missingJob.statusCode).toBe(404);
  });

  it('取消能中断正在识别的页：状态 cancelled、无结果/无缓存/无残留，之后可恢复', async () => {
    let startedResolve: (() => void) | null = null;
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });
    const hungEngine = {
      recognize: vi.fn(() => {
        startedResolve?.();
        // 永不 settle：模拟很慢的一页识别。取消必须能立刻结束它，而不是等它跑完再丢弃结果。
        return new Promise<never>(() => undefined);
      }),
      terminate: vi.fn(async () => undefined)
    };
    createWorkerMock.mockImplementationOnce(async () => hungEngine);

    const { jobId } = await startJob();
    await started;

    // 识别进行中，轻量轮询路由仍要及时响应（主线程没有被识别/取图占住）。
    const pollStart = performance.now();
    const running = await jobState(jobId);
    const pollMs = performance.now() - pollStart;
    expect(running.state).toBe('running');
    expect(pollMs).toBeLessThan(300);

    const cancelled = await server.inject({
      method: 'POST',
      url: `/api/v1/documents/${documentId}/ocr/jobs/${jobId}/cancel`,
      headers: headers()
    });
    expect(cancelled.statusCode).toBe(200);

    let record = await jobState(jobId);
    const deadline = Date.now() + 10_000;
    while (record.state === 'running' || record.state === 'cancelling') {
      if (Date.now() > deadline) throw new Error('取消后任务未在 10 秒内结束');
      await delay(20);
      record = await jobState(jobId);
    }
    expect(record.state).toBe('cancelled');
    expect(record.result).toBeUndefined();
    expect(record.progress).toBe(0);
    // 正在识别的 tesseract 实例被终止；取图 worker 不再忙；取消的页不落缓存。
    expect(hungEngine.terminate).toHaveBeenCalled();
    expect(ocrEnginePoolStats().instances).toBe(0);
    expect(ocrRenderWorkerStats().busy).toBe(0);
    expect(store.getPageEdit(documentId, 1)).toBeNull();
    // 本实现不在磁盘落临时页面图；取消后数据目录不应出现临时文件残留。
    expect(readdirSync(dataDir).filter((name) => /\.(png|tmp|part)$/i.test(name))).toEqual([]);

    // 取消之后池能恢复：新任务换新实例并正常完成。
    createWorkerMock.mockImplementation(async () => ({
      recognize: vi.fn(async () => ({
        data: {
          text: '恢复后的区域文字',
          blocks: [
            {
              paragraphs: [
                {
                  lines: [
                    {
                      text: '恢复后的区域文字',
                      confidence: 90,
                      bbox: { x0: 10, y0: 10, x1: 200, y1: 40 }
                    }
                  ]
                }
              ]
            }
          ]
        }
      })),
      terminate: vi.fn(async () => undefined)
    }));
    const second = await startJob();
    let secondRecord = await jobState(second.jobId);
    const secondDeadline = Date.now() + 10_000;
    while (secondRecord.state === 'running' || secondRecord.state === 'queued') {
      if (Date.now() > secondDeadline) throw new Error('恢复后的任务未在 10 秒内完成');
      await delay(20);
      secondRecord = await jobState(second.jobId);
    }
    expect(secondRecord.state).toBe('done');
    expect((secondRecord.result as { text?: string } | undefined)?.text).toContain(
      '恢复后的区域文字'
    );
  }, 60_000);
});
