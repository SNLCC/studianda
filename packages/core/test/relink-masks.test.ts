import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store } from '../src/store.js';

const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-relink-masks-'));
const store = new Store(dataDir);
let docWithMask = '';
let docWithAnnotation = '';

afterAll(() => {
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

async function makePdf(
  file: string,
  pages: Array<{ header: boolean; body?: boolean }>,
  bodyText = 'BODY TEXT'
): Promise<void> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const spec of pages) {
    const page = pdf.addPage([300, 400]);
    if (spec.header) {
      page.drawText('HEADER LINE', { x: 20, y: 370, size: 12, font });
    }
    page.drawText(bodyText, { x: 20, y: 200, size: 12, font });
  }
  writeFileSync(file, await pdf.save());
}

beforeAll(async () => {
  const first = path.join(dataDir, 'first.pdf');
  await makePdf(first, [{ header: true }, { header: false }]);
  const imported = await store.importDocument(first);
  docWithMask = imported.id;
  // 屏蔽页 1 顶部 18%：页眉应当从正文与检索里消失。
  await store.addPageMask(docWithMask, {
    page: 1,
    x0: 0,
    y0: 0,
    x1: 1,
    y1: 0.18
  });
  const masked = store.listChunks(docWithMask).filter((chunk) => chunk.page === 1);
  expect(masked.some((chunk) => chunk.text.includes('HEADER'))).toBe(false);
  expect(masked.some((chunk) => chunk.text.includes('BODY'))).toBe(true);

  const second = path.join(dataDir, 'second.pdf');
  await makePdf(second, [{ header: true }, { header: false }], 'ANNOTATED BODY');
  // 两份样张文字/结构相同，字节可能仅差生成时间；重复检测命中时直接确认继续。
  const other = await store.importDocument(second, undefined, true);
  docWithAnnotation = other.id;
  store.createAnnotation({
    documentId: docWithAnnotation,
    page: 2,
    quote: 'BODY TEXT',
    content: '第 2 页批注',
    rects: '[[0.1,0.4,0.5,0.5]]',
    color: 'yellow',
    style: 'highlight'
  });
}, 120_000);

describe('relink 重建索引', () => {
  it('保留页遮罩：重新连接后页眉不会回到正文/检索', async () => {
    const replacement = path.join(dataDir, 'replacement.pdf');
    await makePdf(replacement, [{ header: true }, { header: false }, { header: false }]);

    const result = await store.relinkDocument(docWithMask, replacement);
    expect(result.page_count_before).toBe(2);
    expect(result.page_count_after).toBe(3);
    expect(result.annotations_out_of_range).toBe(0);
    expect(result.warning).toContain('页数由 2 页变为 3 页');

    const pageOne = store.listChunks(docWithMask).filter((chunk) => chunk.page === 1);
    expect(pageOne.some((chunk) => chunk.text.includes('HEADER'))).toBe(false);
    expect(pageOne.some((chunk) => chunk.text.includes('BODY'))).toBe(true);
  });

  it('页数变少时报告越界批注数量与提示', async () => {
    const onePage = path.join(dataDir, 'one-page.pdf');
    await makePdf(onePage, [{ header: false }]);

    const result = await store.relinkDocument(docWithAnnotation, onePage);
    expect(result.page_count_before).toBe(2);
    expect(result.page_count_after).toBe(1);
    expect(result.annotations_out_of_range).toBe(1);
    expect(result.warning).toContain('1 条批注');
    // 批注本身保留（页码可能已错位），由用户核对。
    expect(store.listAnnotations(docWithAnnotation)).toHaveLength(1);
  });
});
