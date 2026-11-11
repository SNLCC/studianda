import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { recognizeRegion } from '../src/ocr.js';
import { saveParsingConfig } from '../src/parsing-config.js';
import { SecretStore } from '../src/secrets.js';
import { Store } from '../src/store.js';

const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-region-ocr-'));
const store = new Store(dataDir);
const secrets = new SecretStore();
const originalFetch = globalThis.fetch;
let documentId = '';

const REGION = { x0: 0.1, y0: 0.1, x1: 0.6, y1: 0.4 };
const VISION_TEXT = '图 1 数据\n单位为 %';

/** 查询本页 visual 空间中、指定 text 的 chunk（原生文本块也写 visual 空间，需按文本区分）。 */
function rawVisualChunks(matchText: string): Array<{ text: string; bbox: string; bbox_space: string }> {
  const db = (store as unknown as { db: DatabaseSync }).db;
  return db
    .prepare(
      `SELECT text, bbox, bbox_space FROM chunks
       WHERE document_id = ? AND page = 1 AND bbox_space = 'visual' AND text = ? ORDER BY rowid`
    )
    .all(documentId, matchText) as unknown as Array<{
    text: string;
    bbox: string;
    bbox_space: string;
  }>;
}

/** mock 一次视觉/自定义服务调用，返回调用次数与最后一次请求体。 */
function mockJsonResponse(payload: unknown): { calls: () => number; body: () => string } {
  let calls = 0;
  let body = '';
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    calls += 1;
    body = typeof init?.body === 'string' ? init.body : '';
    return {
      ok: true,
      status: 200,
      json: async () => payload
    } as unknown as Response;
  }) as typeof fetch;
  return { calls: () => calls, body: () => body };
}

function pngSize(dataUrl: string): { width: number; height: number } {
  const buffer = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

beforeAll(async () => {
  const pdf = await PDFDocument.create();
  pdf.setTitle('region-ocr-fixture');
  pdf.setAuthor('Studianda test');
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([400, 600]);
  page.drawText('Region OCR fixture body', { x: 40, y: 540, size: 12, font });
  const file = path.join(dataDir, 'fixture.pdf');
  writeFileSync(file, await pdf.save());
  documentId = (await store.importDocument(file)).id;
  // 环境变量覆盖：给无界面运行/调试用；测试用它给 vision 一个（不会真正连上的）地址。
  process.env.STUDIANDA_MODEL_BASE_URL = 'http://127.0.0.1:9/v1';
  saveParsingConfig(store, secrets, { mode: 'vision', model: 'vis-model', allow_remote: true });
});

afterAll(() => {
  delete process.env.STUDIANDA_MODEL_BASE_URL;
  globalThis.fetch = originalFetch;
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('region OCR', () => {
  it('crops the selected region, recognizes it with the vision model and stores a visual chunk', async () => {
    expect(rawVisualChunks(VISION_TEXT)).toHaveLength(0);
    const mock = mockJsonResponse({
      choices: [{ message: { content: VISION_TEXT } }]
    });

    const result = await recognizeRegion(store, secrets, documentId, 1, REGION);

    expect(mock.calls()).toBe(1);
    const body = mock.body();
    expect(body).toContain('只转录选区可见文字');
    expect(body).toContain('"max_tokens":4096');
    const match = body.match(/data:image\/png;base64,([^"]+)/);
    expect(match).toBeTruthy();
    // 发出去的是裁剪后的选区（400x600 页面 ×2 渲染；选区 0.5×0.3 → 400×360）。
    expect(pngSize(`data:image/png;base64,${match![1]}`)).toEqual({
      width: 400,
      height: 360
    });

    expect(result.text).toBe(VISION_TEXT);
    expect(result.textReflowed).not.toContain('\n');
    expect(result.textReflowed).toContain('图 1 数据');
    expect(result.bbox).toEqual([0.1, 0.1, 0.6, 0.4]);
    expect(result.engine).toBe('vision');

    const chunks = rawVisualChunks(VISION_TEXT);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ text: VISION_TEXT, bbox_space: 'visual' });
    expect(JSON.parse(chunks[0]!.bbox)).toEqual([0.1, 0.1, 0.6, 0.4]);
    // 区域文字进入 FTS，可以被检索命中。
    expect(store.search('单位为', documentId).some((hit) => hit.page === 1)).toBe(true);
    // 区域识别不写 page_edits（不影响整页文本）。
    expect(store.getPageEdit(documentId, 1)).toBeNull();
  });

  it('does not insert the same visual chunk twice', () => {
    const before = rawVisualChunks(VISION_TEXT).length;
    expect(store.addVisualChunk(documentId, 1, VISION_TEXT, [0.1, 0.1, 0.6, 0.4])).toBe(false);
    expect(rawVisualChunks(VISION_TEXT)).toHaveLength(before);

    expect(store.addVisualChunk(documentId, 1, '另一块区域文字', null)).toBe(true);
    expect(rawVisualChunks('另一块区域文字')).toHaveLength(1);
    expect(store.addVisualChunk(documentId, 1, '另一块区域文字', null)).toBe(false);
  });

  it('rejects invalid regions and out-of-range pages before rendering', async () => {
    await expect(
      recognizeRegion(store, secrets, documentId, 1, { x0: 0.5, y0: 0.1, x1: 0.5, y1: 0.4 })
    ).rejects.toThrow('请选择有效区域');
    await expect(
      recognizeRegion(store, secrets, documentId, 1, { x0: 0.1, y0: 0.4, x1: 0.6, y1: 0.2 })
    ).rejects.toThrow('请选择有效区域');
    await expect(
      recognizeRegion(store, secrets, documentId, 9, REGION)
    ).rejects.toThrow('页码超出范围');
  });

  it('rejects an empty recognition result', async () => {
    mockJsonResponse({ choices: [{ message: { content: '   \n  ' } }] });
    await expect(
      recognizeRegion(store, secrets, documentId, 1, { x0: 0.2, y0: 0.2, x1: 0.4, y1: 0.3 })
    ).rejects.toThrow('此区域未识别到文字');
  });

  it('recognizes a cropped region with a custom /parse service', async () => {
    saveParsingConfig(store, secrets, {
      mode: 'custom',
      service_url: 'http://127.0.0.1:9/parse',
      allow_remote: true
    });
    const mock = mockJsonResponse({ text: '自定义区域文字' });
    try {
      const result = await recognizeRegion(store, secrets, documentId, 1, {
        x0: 0.2,
        y0: 0.5,
        x1: 0.5,
        y1: 0.6
      });
      expect(mock.calls()).toBe(1);
      expect(result.engine).toBe('custom');
      expect(result.text).toBe('自定义区域文字');
      expect(mock.body()).toBe(''); // FormData 请求体不是 JSON 字符串
    } finally {
      saveParsingConfig(store, secrets, { mode: 'vision', model: 'vis-model', allow_remote: true });
    }
  });

  it('rejects MinerU modes for region OCR', async () => {
    saveParsingConfig(store, secrets, {
      mode: 'mineru_online',
      allow_remote: true,
      service_key: 'online-token'
    });
    try {
      await expect(
        recognizeRegion(store, secrets, documentId, 1, REGION)
      ).rejects.toThrow('区域识别暂不支持当前识别方式');
    } finally {
      saveParsingConfig(store, secrets, { mode: 'vision', model: 'vis-model', allow_remote: true });
    }
  });

  it('requires an existing document before writing a visual chunk', () => {
    expect(() => store.addVisualChunk('missing-document', 1, 'x', null)).toThrow('文档不存在');
  });
});
