import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SecretStore } from '../src/secrets.js';
import { buildServer } from '../src/server.js';
import { Store } from '../src/store.js';
import {
  anchorTranslationSelection,
  lookupTranslationSegments
} from '../src/translation-service.js';
import { sourceHash } from '../src/translation-engine.js';

const token = 'translation-anchor-token';
const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-translation-anchor-'));
const store = new Store(dataDir);
const secrets = new SecretStore();
const server = buildServer({ token, version: 'test-version', store, secrets });
let documentId = '';

const SEG0_SOURCE = 'The model works well. It is stable.';
const SEG0_TEXT = '模型运行良好。它很稳定。';
const SEG1_SOURCE = 'Another paragraph here.';
const SEG1_TEXT = '另一个段落在这里。这里还有第二句。';
const SEG2_SOURCE = 'Unrelated source not in pdf.';
const SEG2_TEXT = '无关译文。';

function headers(): Record<string, string> {
  return { 'x-studianda-token': token };
}

function row(
  segment: number,
  source: string,
  text: string
): {
  id: string;
  documentId: string;
  page: number;
  segment: number;
  source: string;
  sourceHash: string;
  text: string;
  engine: string;
  service: string;
  terms: string;
  unknownTerms: string;
  coverage: number;
  edited: boolean;
  origin: string;
  previousText: string;
  previousOrigin: string;
} {
  return {
    id: `seg-${segment}`,
    documentId,
    page: 1,
    segment,
    source,
    sourceHash: sourceHash(source),
    text,
    engine: 'remote',
    service: 'tr-model',
    terms: '[]',
    unknownTerms: '[]',
    coverage: 0,
    edited: false,
    origin: 'machine',
    previousText: '',
    previousOrigin: ''
  };
}

beforeAll(async () => {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([420, 594]);
  // 只画英文原文（标准字体不支持中文）：用于验证 bbox 定位成功与失败。
  page.drawText(SEG0_SOURCE, { x: 32, y: 520, size: 9 });
  page.drawText(SEG1_SOURCE, { x: 32, y: 490, size: 9 });
  const file = path.join(dataDir, 'anchor.pdf');
  writeFileSync(file, await pdf.save());
  const imported = await store.importDocument(file);
  documentId = imported.id;
  store.saveTranslationSegments([
    row(0, SEG0_SOURCE, SEG0_TEXT),
    row(1, SEG1_SOURCE, SEG1_TEXT),
    row(2, SEG2_SOURCE, SEG2_TEXT)
  ]);
  store.saveTranslationPage({
    documentId,
    page: 1,
    sourceHash: 'hash',
    engine: 'remote',
    status: 'done',
    error: '',
    done: 3,
    total: 3,
    updated: new Date().toISOString()
  });
}, 120_000);

afterAll(async () => {
  await server.close();
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('anchorTranslationSelection', () => {
  it('maps a whole selected translation back to the whole source segment', async () => {
    const result = await anchorTranslationSelection(store, documentId, 1, SEG0_TEXT);
    expect(result.matched).toBe(true);
    expect(result.exact).toBe(true);
    expect(result.segment).toBe(0);
    expect(result.quote).toBe(SEG0_SOURCE);
    expect(result.source).toBe(SEG0_SOURCE);
    expect(result.translated).toBe(SEG0_TEXT);
    expect(result.bbox).not.toBeNull();
    expect(result.located).toBe(true);
    expect(result.fallback).toBe(false);
    const [x0, y0, x1, y1] = result.bbox!;
    expect(x1).toBeGreaterThan(x0);
    expect(y1).toBeGreaterThan(y0);
  });

  it('maps a single selected translated sentence to the matching source sentence', async () => {
    const result = await anchorTranslationSelection(store, documentId, 1, '它很稳定。');
    expect(result.matched).toBe(true);
    expect(result.exact).toBe(true);
    expect(result.segment).toBe(0);
    expect(result.quote).toBe('It is stable.');
    expect(result.bbox).not.toBeNull();
  });

  it('reports exact=false when sentence counts differ instead of inventing text', async () => {
    const result = await anchorTranslationSelection(store, documentId, 1, SEG1_TEXT);
    expect(result.matched).toBe(true);
    expect(result.exact).toBe(false);
    expect(result.segment).toBe(1);
    expect(result.quote).toBe(SEG1_SOURCE);
  });

  it('returns matched=false for text that is not in any stored translation', async () => {
    const result = await anchorTranslationSelection(store, documentId, 1, '这句译文不存在');
    expect(result.matched).toBe(false);
    expect(result.exact).toBe(false);
    expect(result.bbox).toBeNull();
    expect(result.quote).toBe('这句译文不存在');
    expect(result.segment).toBeUndefined();
  });

  it('honours the explicit segment filter', async () => {
    const result = await anchorTranslationSelection(
      store,
      documentId,
      1,
      '它很稳定。',
      1
    );
    expect(result.matched).toBe(true);
    expect(result.segment).toBe(1);
    // 选文不在第一段的译文里 → 无法句级对齐，保留选文并标 exact=false。
    expect(result.exact).toBe(false);
    expect(result.quote).toBe('它很稳定。');
    // 选文定位不到时退回整段 source 的框（fallback=true），不会变成整页批注。
    expect(result.fallback).toBe(true);
    expect(result.bbox).not.toBeNull();
  });

  it('keeps matched=true with bbox=null when the page has no locatable box', async () => {
    const result = await anchorTranslationSelection(store, documentId, 1, '无关译文。', 2);
    expect(result.matched).toBe(true);
    expect(result.segment).toBe(2);
    expect(result.quote).toBe(SEG2_SOURCE);
    expect(result.located).toBe(false);
    expect(result.bbox).toBeNull();
  });
});

describe('lookupTranslationSegments', () => {
  it('finds a segment by source text', async () => {
    const hits = lookupTranslationSegments(store, documentId, 1, 'It is stable');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ segment: 0, match: 'source' });
  });

  it('finds a segment by long enough translated text', async () => {
    const hits = lookupTranslationSegments(store, documentId, 1, '模型运行良好');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ segment: 0, match: 'translation' });
  });

  it('returns an empty list for empty or unknown quotes', () => {
    expect(lookupTranslationSegments(store, documentId, 1, '  ')).toEqual([]);
    expect(lookupTranslationSegments(store, documentId, 1, '完全没有的词语')).toEqual([]);
  });
});

describe('HTTP endpoints', () => {
  it('POST /translation/anchor returns the mapping (200)', async () => {
    const response = await server.inject({
      method: 'POST',
      url: `/api/v1/documents/${documentId}/translation/anchor`,
      headers: headers(),
      payload: { page: 1, excerpt: '它很稳定。' }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      matched: true,
      exact: true,
      segment: 0,
      quote: 'It is stable.'
    });
  });

  it('POST /translation/anchor validates input', async () => {
    const empty = await server.inject({
      method: 'POST',
      url: `/api/v1/documents/${documentId}/translation/anchor`,
      headers: headers(),
      payload: { page: 1, excerpt: '  ' }
    });
    expect(empty.statusCode).toBe(400);

    const badPage = await server.inject({
      method: 'POST',
      url: `/api/v1/documents/${documentId}/translation/anchor`,
      headers: headers(),
      payload: { page: 0, excerpt: 'x' }
    });
    expect(badPage.statusCode).toBe(400);

    const tooLong = await server.inject({
      method: 'POST',
      url: `/api/v1/documents/${documentId}/translation/anchor`,
      headers: headers(),
      payload: { page: 1, excerpt: 'x'.repeat(5001) }
    });
    expect(tooLong.statusCode).toBe(400);

    const missingDoc = await server.inject({
      method: 'POST',
      url: '/api/v1/documents/missing-doc/translation/anchor',
      headers: headers(),
      payload: { page: 1, excerpt: 'x' }
    });
    expect(missingDoc.statusCode).toBe(404);
  });

  it('GET /translation/lookup returns matches and validates page', async () => {
    const ok = await server.inject({
      method: 'GET',
      url: `/api/v1/documents/${documentId}/translation/lookup?page=1&quote=${encodeURIComponent(
        'It is stable'
      )}`,
      headers: headers()
    });
    expect(ok.statusCode).toBe(200);
    const body = ok.json() as { matches: Array<{ segment: number; match: string }> };
    expect(body.matches).toHaveLength(1);
    expect(body.matches[0]).toMatchObject({ segment: 0, match: 'source' });

    const badPage = await server.inject({
      method: 'GET',
      url: `/api/v1/documents/${documentId}/translation/lookup?page=0&quote=x`,
      headers: headers()
    });
    expect(badPage.statusCode).toBe(400);
  });
});
