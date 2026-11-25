import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store } from '../src/store.js';
import { SecretStore } from '../src/secrets.js';
import { buildServer } from '../src/server.js';

/**
 * 批注原文（quote）允许用户修改：框选批注自动 OCR 写入的原文可能是错的，
 * 校对后要能落库，批注条目与检索都读修改后的文字。
 */
const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-annotation-quote-'));
const store = new Store(dataDir);
const secrets = new SecretStore();
const server = buildServer({ token: 'quote-token', version: 'test', store, secrets });
let documentId = '';
let annotationId = '';

beforeAll(async () => {
  const pdf = await PDFDocument.create();
  pdf.addPage();
  const file = path.join(dataDir, 'quote-fixture.pdf');
  writeFileSync(file, await pdf.save());
  const document = await store.importDocument(file);
  documentId = document.id;
  const annotation = store.createAnnotation({
    documentId,
    page: 1,
    quote: '',
    content: '框选批注',
    rects: JSON.stringify([[0.1, 0.1, 0.5, 0.4]]),
    color: 'yellow',
    style: 'region'
  });
  annotationId = annotation.id;
});

afterAll(async () => {
  await server.close();
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('修改批注原文', () => {
  it('store：只改 quote，其它字段与附件引用逻辑不受影响', () => {
    const updated = store.updateAnnotation(annotationId, { quote: 'OCR 识别错的原文 → 人工校对后' });
    expect(updated?.quote).toBe('OCR 识别错的原文 → 人工校对后');
    expect(updated?.content).toBe('框选批注');
  });

  it('HTTP PATCH /annotations/:id 接受 quote', async () => {
    const response = await server.inject({
      method: 'PATCH',
      url: `/api/v1/annotations/${annotationId}`,
      headers: { 'x-studianda-token': 'quote-token' },
      payload: { quote: '再次校对后的原文' }
    });
    expect(response.statusCode).toBe(200);
    expect((response.json() as { quote?: string }).quote).toBe('再次校对后的原文');
    expect(
      store.listAnnotations(documentId).find((item) => item.id === annotationId)?.quote
    ).toBe('再次校对后的原文');
  });
});
