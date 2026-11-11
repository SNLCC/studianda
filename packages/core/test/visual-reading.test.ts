import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { saveParsingConfig } from '../src/parsing-config.js';
import { SecretStore } from '../src/secrets.js';
import { Store } from '../src/store.js';
import {
  parseVisualRecord,
  selectVisualPages,
  visualReadingConfig,
  visualReadingSupplement
} from '../src/visual-reading.js';

const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-visual-reading-'));
const store = new Store(dataDir);
const secrets = new SecretStore();
const originalFetch = globalThis.fetch;
let documentId = '';
let documentSha = '';

const RECORD = {
  transcription: '表 1：各组的均值与标准差。',
  elements: [{ kind: 'table', description: '不同分组的统计结果' }],
  uncertainties: ['右下角数字略模糊']
};

/** 4 页 PDF：1 图题、2 表题、3 纯正文、4 含公式符号。 */
async function makePdf(): Promise<string> {
  const pdf = await PDFDocument.create();
  pdf.setTitle('visual-reading-fixture');
  pdf.setAuthor('Studianda test');
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const pages = [
    'Figure 1: trend chart of the results',
    'Table 1: measured values by group',
    'Plain body text without any captions',
    'E = mc2 sum over values'
  ];
  for (const text of pages) {
    const page = pdf.addPage([400, 600]);
    page.drawText(text, { x: 40, y: 540, size: 12, font });
  }
  const file = path.join(dataDir, 'fixture.pdf');
  writeFileSync(file, await pdf.save());
  return file;
}

beforeAll(async () => {
  const file = await makePdf();
  documentId = (await store.importDocument(file)).id;
  documentSha = store.getDocument(documentId)!.sha256;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('visual reading config', () => {
  it('is disabled by default, parses and clamps settings', () => {
    const defaults = visualReadingConfig(store, secrets);
    expect(defaults).toMatchObject({
      enabled: false,
      useOcrModel: true,
      maxPages: 8,
      profile: null,
      warning: ''
    });

    store.updateSettings({ 'reading.visual_max_pages': '0' });
    expect(visualReadingConfig(store, secrets).maxPages).toBe(1);
    store.updateSettings({ 'reading.visual_max_pages': '99' });
    expect(visualReadingConfig(store, secrets).maxPages).toBe(32);
    store.updateSettings({ 'reading.visual_max_pages': 'abc' });
    expect(visualReadingConfig(store, secrets).maxPages).toBe(8);
    store.updateSettings({ 'reading.visual_use_ocr_model': 'false' });
    expect(visualReadingConfig(store, secrets).useOcrModel).toBe(false);

    store.updateSettings({ 'reading.visual_enabled': 'true' });
    const enabledWithoutModel = visualReadingConfig(store, secrets);
    expect(enabledWithoutModel.enabled).toBe(true);
    expect(enabledWithoutModel.profile).toBeNull();
    expect(enabledWithoutModel.warning).toContain('视觉模型');
  });

  it('resolves the visual reading model from model services routing', () => {
    store.updateSettings({
      'model.services': JSON.stringify([
        {
          id: 'conn-vision',
          name: '视觉平台',
          platform: 'custom',
          baseUrl: 'http://127.0.0.1:9/v1',
          models: [
            { id: 'vis-1', name: 'vis-1', capabilities: ['vision'], source: 'manual', enabled: true }
          ]
        }
      ]),
      'model.routing': JSON.stringify({ vision: { connectionId: 'conn-vision', model: 'vis-1' } })
    });
    const config = visualReadingConfig(store, secrets);
    expect(config.profile).toEqual({
      baseUrl: 'http://127.0.0.1:9/v1',
      apiKey: '',
      model: 'vis-1',
      connectionId: 'conn-vision',
      // 未登记官方最大输出 → 沿用视觉读页任务上限（与改动前一致）。
      maxTokens: 2048
    });
    expect(config.warning).toBe('');
  });

  it('reuses the OCR vision connection when asked to', () => {
    store.updateSettings({ 'reading.visual_use_ocr_model': 'true' });
    saveParsingConfig(store, secrets, {
      mode: 'vision',
      connection_id: 'conn-vision',
      model: 'ocr-vision',
      allow_remote: true
    });
    const config = visualReadingConfig(store, secrets);
    expect(config.profile).toMatchObject({
      baseUrl: 'http://127.0.0.1:9/v1',
      model: 'ocr-vision',
      connectionId: 'conn-vision'
    });
    // 还原为"从模型服务取视觉读页模型"，不影响后续缓存键断言。
    saveParsingConfig(store, secrets, { mode: 'local' });
    store.updateSettings({ 'reading.visual_use_ocr_model': 'false' });
  });
});

describe('visual page selection', () => {
  it('only keeps pages that actually have visual nodes', async () => {
    expect(await selectVisualPages(store, documentId, [1, 2, 3, 4], 8)).toEqual([1, 2, 4]);
    expect(await selectVisualPages(store, documentId, [3], 8)).toEqual([]);
    expect(await selectVisualPages(store, documentId, [1, 2, 4], 1)).toEqual([1]);
    expect(await selectVisualPages(store, documentId, [1, 2, 4], 2)).toEqual([1, 2]);
  });
});

describe('parseVisualRecord', () => {
  it('accepts valid objects and JSON wrapped in extra text', () => {
    expect(parseVisualRecord(RECORD)).toEqual(RECORD);
    expect(
      parseVisualRecord(`模型说明…${JSON.stringify(RECORD)}…结束`)
    ).toEqual(RECORD);
  });

  it('rejects missing fields, wrong shapes and oversized records', () => {
    expect(parseVisualRecord('不是 JSON')).toBeNull();
    expect(parseVisualRecord({ transcription: 1, elements: [], uncertainties: [] })).toBeNull();
    expect(parseVisualRecord({ transcription: 'x', elements: 'bad', uncertainties: [] })).toBeNull();
    expect(parseVisualRecord({ transcription: 'x', elements: [], uncertainties: {} })).toBeNull();
    expect(
      parseVisualRecord({ transcription: 'x'.repeat(60_001), elements: [], uncertainties: [] })
    ).toBeNull();
    // 元素字段坏掉时过滤掉该条，而不是整页失败。
    expect(
      parseVisualRecord({
        transcription: 'ok',
        elements: [{ kind: 'table', description: '统计表' }, { kind: 'figure' }],
        uncertainties: ['模糊', 42]
      })
    ).toEqual({
      transcription: 'ok',
      elements: [{ kind: 'table', description: '统计表' }],
      uncertainties: ['模糊']
    });
  });
});

describe('visual reading supplement', () => {
  it('returns an empty supplement when disabled', async () => {
    store.updateSettings({ 'reading.visual_enabled': 'false' });
    const result = await visualReadingSupplement(store, secrets, documentId, [1]);
    expect(result).toEqual({ enabled: false, pages: [], warnings: [], sources: [] });
    store.updateSettings({ 'reading.visual_enabled': 'true' });
  });

  it('uses the cache without calling the model', async () => {
    store.saveVisualCache(documentId, 1, 'vis-1', documentSha, RECORD);
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      throw new Error('fetch should not be called');
    }) as typeof fetch;

    const result = await visualReadingSupplement(store, secrets, documentId, [1]);
    expect(calls).toBe(0);
    expect(result.enabled).toBe(true);
    expect(result.pages).toEqual([{ page: 1, ...RECORD }]);
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]).toMatchObject({
      documentId,
      page: 1,
      sourceType: 'visual_model'
    });
    expect(result.sources[0]?.snippet).toContain('派生资料，不是逐字核验原文');
  });

  it('calls the model on a cache miss, validates JSON and caches the result', async () => {
    let calls = 0;
    let body = '';
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      calls += 1;
      body = String(init?.body ?? '');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify(RECORD) } }]
        })
      } as unknown as Response;
    }) as typeof fetch;

    const result = await visualReadingSupplement(store, secrets, documentId, [2]);
    expect(calls).toBe(1);
    expect(body).toContain('READING_VISION');
    expect(body).toContain('data:image/png;base64,');
    expect(body).toContain('"temperature":0');
    expect(result.pages).toEqual([{ page: 2, ...RECORD }]);
    expect(store.getVisualCache(documentId, 2, 'vis-1', documentSha)).toEqual(RECORD);
  });

  it('skips a failing page with a warning instead of failing the run', async () => {
    globalThis.fetch = (async () =>
      ({ ok: false, status: 500, json: async () => ({}) }) as unknown as Response) as typeof fetch;
    const result = await visualReadingSupplement(store, secrets, documentId, [4]);
    expect(result.pages).toEqual([]);
    expect(result.sources).toEqual([]);
    expect(result.warnings.join('\n')).toContain('第 4 页视觉解读失败');
  });

  it('throws AbortError when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      visualReadingSupplement(store, secrets, documentId, [1], controller.signal)
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('purges the visual cache together with the document', () => {
    store.saveVisualCache(documentId, 1, 'vis-1', documentSha, RECORD);
    expect(store.getVisualCache(documentId, 1, 'vis-1', documentSha)).toEqual(RECORD);
    const name = store.getDocument(documentId)!.name;
    store.deleteDocument(documentId);
    store.purgeDocument(documentId, name);
    expect(store.getVisualCache(documentId, 1, 'vis-1', documentSha)).toBeNull();
    expect(store.getDocument(documentId)).toBeNull();
  });
});
