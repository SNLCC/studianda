import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { afterAll, describe, expect, it } from 'vitest';
import { Store } from '../src/store.js';

const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-page-edit-'));
const store = new Store(dataDir);

afterAll(() => {
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

/** 用 pdf-lib 造一份 PDF：每页一段 ASCII 文本（空串=空白页），并写入唯一标题避免导入去重。 */
async function makePdf(name: string, pages: string[]): Promise<string> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`page-edit-${name}`);
  pdf.setAuthor('Studianda test');
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const text of pages) {
    const page = pdf.addPage([400, 600]);
    if (text) page.drawText(text, { x: 40, y: 540, size: 12, font });
  }
  const file = path.join(dataDir, name);
  writeFileSync(file, await pdf.save());
  return file;
}

function rawChunks(
  page: number,
  documentId: string
): Array<{ text: string; bbox: string; bbox_space: string }> {
  const db = (store as unknown as { db: DatabaseSync }).db;
  return db
    .prepare(
      'SELECT text, bbox, bbox_space FROM chunks WHERE document_id = ? AND page = ? ORDER BY rowid'
    )
    .all(documentId, page) as unknown as Array<{
    text: string;
    bbox: string;
    bbox_space: string;
  }>;
}

describe('page text edit keeps chunks and search index in sync', () => {
  it('rebuilds the edited page chunks and FTS rows', async () => {
    const file = await makePdf('edit.pdf', [
      'Original retrieval sentence',
      'Second page about embeddings'
    ]);
    const document = await store.importDocument(file);
    expect(rawChunks(1, document.id).map((chunk) => chunk.text).join(' ')).toContain(
      'Original retrieval sentence'
    );

    await store.savePageTextEdit(document.id, 1, 'Corrected text about gravitational waves');

    const chunks = rawChunks(1, document.id);
    const joined = chunks.map((chunk) => chunk.text).join('\n');
    expect(joined).toContain('gravitational waves');
    expect(joined).not.toContain('Original retrieval');
    // 没有 OCR 行框时按 1600 字平铺、bbox='null'。
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.bbox).toBe('null');
    expect(chunks[0]?.bbox_space).toBe('visual');
    expect(store.getPageText(document.id, 1)).toBe('Corrected text about gravitational waves');

    // 检索索引必须跟着变：新词命中，旧词不再命中第 1 页。
    expect(store.search('gravitational', document.id).some((hit) => hit.page === 1)).toBe(true);
    expect(
      store.search('Original retrieval', document.id).some((hit) => hit.page === 1)
    ).toBe(false);
  });

  it('uses saved OCR line boxes to write chunk bboxes', async () => {
    const file = await makePdf('lines.pdf', ['']);
    const document = await store.importDocument(file);
    store.cacheOcrPage(document.id, 1, '第一条识别行\n第二条识别行', [
      { text: '第一条识别行', confidence: 0.9, bbox: [0.1, 0.1, 0.9, 0.16] },
      { text: '第二条识别行', confidence: 0.9, bbox: [0.1, 0.2, 0.9, 0.26] }
    ]);
    await store.savePageTextEdit(document.id, 1, '第一条识别行\n第二条识别行');

    const layout = await store.getPageLayout(document.id, 1);
    const chunks = rawChunks(1, document.id);
    expect(chunks).toHaveLength(2);
    const box = JSON.parse(chunks[0]!.bbox) as number[];
    expect(box).toHaveLength(4);
    // chunks 的 bbox 是页面坐标；用同一套页面尺寸能换算回归一化行框。
    expect(box[0]! / layout.width).toBeCloseTo(0.1, 5);
    expect(box[1]! / layout.height).toBeCloseTo(0.1, 5);
    expect(box[2]! / layout.width).toBeCloseTo(0.9, 5);
    expect(box[3]! / layout.height).toBeCloseTo(0.16, 5);
    expect(chunks.every((chunk) => chunk.bbox_space === 'visual')).toBe(true);
  });

  it('keeps OCR/edited bbox=null chunks when masks rebuild the index', async () => {
    const file = await makePdf('mask.pdf', ['Header line noise here\nBody evidence sentence']);
    const document = await store.importDocument(file);
    await store.savePageTextEdit(document.id, 1, 'Edited page text about reversibility');

    await store.addPageMask(document.id, {
      page: 1,
      x0: 0,
      y0: 0,
      x1: 1,
      y1: 0.08
    });

    const chunks = rawChunks(1, document.id);
    expect(chunks.some((chunk) => chunk.text.includes('reversibility'))).toBe(true);
    expect(chunks.some((chunk) => chunk.bbox === 'null')).toBe(true);
    // 校订文字不会被遮罩重建时按原 PDF span 重写掉，检索仍然命中。
    expect(store.search('reversibility', document.id).some((hit) => hit.page === 1)).toBe(true);
  });
});

describe('OCR page text stays reversible through masks', () => {
  it('filters OCR lines on read and restores them after the mask is deleted', async () => {
    const file = await makePdf('ocr.pdf', ['']);
    const document = await store.importDocument(file);
    store.cacheOcrPage(document.id, 1, 'Header noise line\nBody evidence line', [
      { text: 'Header noise line', confidence: 0.9, bbox: [0, 0, 1, 0.08] },
      { text: 'Body evidence line', confidence: 0.9, bbox: [0, 0.3, 1, 0.4] }
    ]);

    await store.addPageMask(document.id, { page: 1, x0: 0, y0: 0, x1: 1, y1: 0.1 });
    expect(store.getPageText(document.id, 1)).toBe('Body evidence line');

    const mask = store.listPageMasks(document.id)[0]!;
    await store.removePageMask(document.id, mask.id);
    expect(store.getPageText(document.id, 1)).toContain('Header noise line');
    expect(store.getPageText(document.id, 1)).toContain('Body evidence line');
  });

  it('returns the stored text when a user correction has no line boxes', async () => {
    const file = await makePdf('user.pdf', ['']);
    const document = await store.importDocument(file);
    await store.savePageTextEdit(document.id, 1, '用户校订后的正文');
    expect(store.getPageText(document.id, 1)).toBe('用户校订后的正文');
  });
});
