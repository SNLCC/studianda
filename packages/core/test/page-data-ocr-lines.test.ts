import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { afterAll, describe, expect, it, vi } from 'vitest';

// 旧 OCR 页补框会触发真实 Tesseract：测试里把它替换成 no-op，只验证 page-data 路由逻辑。
vi.mock('../src/ocr.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/ocr.js')>();
  return { ...actual, ensureOcrBoxes: vi.fn(async () => undefined) };
});

import { ensureOcrBoxes, renderPdfPage } from '../src/ocr.js';
import { SecretStore } from '../src/secrets.js';
import { buildServer } from '../src/server.js';
import { Store } from '../src/store.js';

const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-page-data-ocr-'));
const store = new Store(dataDir);
const secrets = new SecretStore();
const token = 'page-data-ocr-token';
const server = buildServer({ token, version: 'test-version', store, secrets });

afterAll(async () => {
  await server.close();
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

async function makePdf(
  name: string,
  size: [number, number] = [400, 600]
): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`page-data-ocr-${name}`);
  pdf.addPage(size);
  const bytes = await pdf.save();
  writeFileSync(path.join(dataDir, name), bytes);
  return bytes;
}

async function pageData(documentId: string): Promise<{
  lines: Array<{ text: string; bbox: number[] }>;
  spans?: Array<{ text: string; bbox: number[] }>;
}> {
  const response = await server.inject({
    method: 'GET',
    url: `/api/v1/documents/${documentId}/pages/1`,
    headers: { 'x-studianda-token': token }
  });
  expect(response.statusCode).toBe(200);
  return response.json() as {
    lines: Array<{ text: string; bbox: number[] }>;
    spans?: Array<{ text: string; bbox: number[] }>;
  };
}

describe('page-data 旧 OCR 行框', () => {
  it('无行框时触发一次补识别；补出 boxes 后返回归一化 lines 并按遮罩过滤', async () => {
    const bytes = await makePdf('blank-ocr.pdf');
    const file = path.join(dataDir, 'blank-ocr.pdf');
    const document = await store.importDocument(file);
    expect(bytes.byteLength).toBeGreaterThan(0);

    // 旧 OCR 页：有整页文本但没有行框（cacheOcrPage 传空数组 → boxes='[]'）。
    store.cacheOcrPage(document.id, 1, '旧 OCR 文本', []);
    const empty = await pageData(document.id);
    expect(empty.lines).toEqual([]);
    expect(empty.spans).toEqual([]);
    expect(ensureOcrBoxes).toHaveBeenCalledTimes(1);

    // 模拟补出 OCR 行框（归一化页面坐标）。
    store.cacheOcrPage(document.id, 1, '旧 OCR 文本', [
      { text: '第一行 OCR', bbox: [0.1, 0.1, 0.8, 0.16] },
      { text: '第二行 OCR', bbox: [0.1, 0.3, 0.8, 0.36] }
    ]);
    await store.addPageMask(document.id, {
      page: 1,
      x0: 0,
      y0: 0.2,
      x1: 1,
      y1: 0.45
    });
    const filtered = await pageData(document.id);
    expect(filtered.lines.map((line) => line.text)).toEqual(['第一行 OCR']);
    expect(filtered.lines[0]!.bbox).toEqual([0.1, 0.1, 0.8, 0.16]);
    expect(filtered.spans).toEqual([]);
    // 已有可用行框后不再重复补识别。
    expect(ensureOcrBoxes).toHaveBeenCalledTimes(1);
  });
});

describe('视觉读页渲染 1800 长边上限', () => {
  it('超大页长边缩到 1800，普通页保持 2 倍渲染', async () => {
    await makePdf('huge-visual.pdf', [3000, 4000]);
    const huge = await store.importDocument(path.join(dataDir, 'huge-visual.pdf'));
    const hugePage = await renderPdfPage(huge.id, 1, store, 2, 'visual');
    expect(Math.max(hugePage.width, hugePage.height)).toBeLessThanOrEqual(1800);

    await makePdf('normal-visual.pdf', [400, 600]);
    const normal = await store.importDocument(path.join(dataDir, 'normal-visual.pdf'));
    const normalPage = await renderPdfPage(normal.id, 1, store, 2, 'visual');
    expect(normalPage.width).toBe(800);
    expect(normalPage.height).toBe(1200);
  });
});
