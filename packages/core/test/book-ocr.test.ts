import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * 整本书 OCR 的任务流程：逐页识别、进度、去重启动、取消。
 * 逐页识别本身由 mock 代替（真实识别依赖 tesseract 语言包，别的用例已覆盖）。
 */
type RecognizePage = typeof import('../src/ocr.js').recognizePage;
const recognizePageMock = vi.fn<RecognizePage>();
recognizePageMock.mockImplementation(async (_store, _secrets, _documentId, page) => ({
  page,
  text: `第 ${page} 页的 OCR 文本`,
  lines: [],
  image: { width: 100, height: 100 },
  engine: 'mock-ocr'
}));

vi.mock('../src/ocr.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/ocr.js')>();
  return {
    ...actual,
    recognizePage: (...args: Parameters<RecognizePage>) => recognizePageMock(...args)
  };
});

import { saveParsingConfig } from '../src/parsing-config.js';
import { buildServer } from '../src/server.js';
import { SecretStore } from '../src/secrets.js';
import { Store } from '../src/store.js';
import type { BookOcrJobRecord } from '@studianda/shared';

const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-book-ocr-'));
const store = new Store(dataDir);
const secrets = new SecretStore();
const server = buildServer({ token: 'book-ocr-token', version: 'test', store, secrets });
let documentId = '';

const headers = { 'x-studianda-token': 'book-ocr-token' };
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function currentJob(): Promise<BookOcrJobRecord> {
  const response = await server.inject({
    method: 'GET',
    url: `/api/v1/documents/${documentId}/ocr/book`,
    headers
  });
  expect(response.statusCode).toBe(200);
  return response.json() as BookOcrJobRecord;
}

async function waitForState(states: string[], timeoutMs = 5000): Promise<BookOcrJobRecord> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = await currentJob();
    if (states.includes(job.state)) return job;
    if (Date.now() > deadline) throw new Error(`等待状态超时：${job.state}`);
    await delay(30);
  }
}

beforeAll(async () => {
  const pdf = await PDFDocument.create();
  for (let index = 0; index < 3; index += 1) pdf.addPage();
  const file = path.join(dataDir, 'book-fixture.pdf');
  writeFileSync(file, await pdf.save());
  const document = await store.importDocument(file);
  documentId = document.id;
  saveParsingConfig(store, secrets, { mode: 'local', service_url: '', auto_ocr: false });
});

afterAll(async () => {
  await server.close();
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('整本 OCR 任务', () => {
  it('启动后逐页识别到完成，重复启动返回同一个在途任务，并出现在全局任务清单里', async () => {
    recognizePageMock.mockClear();
    const started = await server.inject({
      method: 'POST',
      url: `/api/v1/documents/${documentId}/ocr/book/start`,
      headers,
      payload: {}
    });
    expect(started.statusCode).toBe(200);
    const job = started.json() as BookOcrJobRecord;
    expect(job.total).toBe(3);
    expect(['queued', 'running']).toContain(job.state);

    const done = await waitForState(['done', 'failed']);
    expect(done.state).toBe('done');
    expect(done.done + done.skipped).toBe(3);
    expect(done.failed).toBe(0);
    expect(recognizePageMock).toHaveBeenCalledTimes(3);

    // 已完成后再点开始会建一个新任务（允许重跑），但仍只保留一个按文献的最新任务。
    const again = await server.inject({
      method: 'POST',
      url: `/api/v1/documents/${documentId}/ocr/book/start`,
      headers,
      payload: {}
    });
    expect(again.statusCode).toBe(200);
    expect((again.json() as BookOcrJobRecord).id).not.toBe(job.id);

    const list = await server.inject({ method: 'GET', url: '/api/v1/ocr/book-jobs', headers });
    expect(list.statusCode).toBe(200);
    const jobs = (list.json() as { jobs: BookOcrJobRecord[] }).jobs;
    expect(jobs.some((item) => item.id === job.id)).toBe(true);
  });

  it('取消在途任务：进入已取消状态并停止继续识别', async () => {
    let startedResolve: (() => void) | null = null;
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });
    // 每页都挂住，等测试取消；取消信号必须能立刻结束这一页，任务收尾为 cancelled。
    recognizePageMock.mockImplementationOnce(
      async (_store, _secrets, _id, page, _scale, options) => {
        startedResolve?.();
        return new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true
          });
        });
      }
    );

    const startResponse = await server.inject({
      method: 'POST',
      url: `/api/v1/documents/${documentId}/ocr/book/start`,
      headers,
      payload: {}
    });
    expect(startResponse.statusCode).toBe(200);
    const job = startResponse.json() as BookOcrJobRecord;
    await started;

    const cancelResponse = await server.inject({
      method: 'POST',
      url: `/api/v1/documents/${documentId}/ocr/book/${job.id}/cancel`,
      headers
    });
    expect(cancelResponse.statusCode).toBe(200);
    const cancelled = await waitForState(['cancelled', 'failed']);
    expect(cancelled.state).toBe('cancelled');
  });
});
