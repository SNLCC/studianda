import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PDFDocument, StandardFonts, degrees } from 'pdf-lib';
import { afterAll, describe, expect, it } from 'vitest';
import { Store, parsePdf } from '../src/store.js';

/**
 * 真实 PDF 样张（pdf-lib 生成）解析回归：
 * - 双栏页：跨栏标题 + 左 5 行 + 右 5 行，验证 chunks 阅读顺序；
 * - 旋转页：setRotation(90)，只要求不崩溃/页数正确/文本可取（旋转坐标如实记录）；
 * - 长文档：24 页，每页至少一个 chunk 且文本覆盖该页标记。
 *
 * 这些样张是"真实 PDF 文件"，但文字仍由 pdf-lib 排版，不是扫描件/真实双栏论文；
 * 真实论文的行合并/字号差异可能触发与合成 bbox 单测不同的行为（见报告）。
 */

const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-pdf-fixtures-'));
const store = new Store(dataDir);

afterAll(() => {
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

async function makeTwoColumnPdf(): Promise<string> {
  const pdf = await PDFDocument.create();
  pdf.setTitle('fixture-two-column-real');
  pdf.setAuthor('Studianda fixture');
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const pageNumber of [1, 2]) {
    const page = pdf.addPage([600, 800]);
    page.drawText(
      `TWO-COLUMN HEADER PAGE ${pageNumber} SPANS BOTH COLUMNS COMPLETELY`,
      { x: 50, y: 760, size: 14, font }
    );
    for (let line = 1; line <= 5; line += 1) {
      page.drawText(`LEFT${pageNumber}-${line} short left column text`, {
        x: 50,
        y: 700 - (line - 1) * 16,
        size: 12,
        font
      });
    }
    for (let line = 1; line <= 5; line += 1) {
      page.drawText(`RIGHT${pageNumber}-${line} short right column text`, {
        x: 360,
        y: 700 - (line - 1) * 16,
        size: 12,
        font
      });
    }
  }
  const file = path.join(dataDir, 'two-column.pdf');
  writeFileSync(file, await pdf.save());
  return file;
}

async function makeRotatedPdf(): Promise<string> {
  const pdf = await PDFDocument.create();
  pdf.setTitle('fixture-rotated-real');
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([500, 700]);
  page.setRotation(degrees(90));
  page.drawText('ROTATED-MARKER text on a rotated page', { x: 60, y: 600, size: 14, font });
  const file = path.join(dataDir, 'rotated.pdf');
  writeFileSync(file, await pdf.save());
  return file;
}

async function makeLongPdf(): Promise<string> {
  const pdf = await PDFDocument.create();
  pdf.setTitle('fixture-long-real');
  pdf.setAuthor('Studianda fixture');
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const pages = 24;
  for (let index = 1; index <= pages; index += 1) {
    const page = pdf.addPage([600, 800]);
    page.drawText(`LONG-PAGE-${index} unique heading for page ${index}`, {
      x: 50,
      y: 740,
      size: 13,
      font
    });
    page.drawText(`LONG-BODY-${index} body sentence ${index} for coverage check`, {
      x: 50,
      y: 700,
      size: 11,
      font
    });
  }
  const file = path.join(dataDir, 'long.pdf');
  writeFileSync(file, await pdf.save());
  return file;
}

function chunkTexts(
  chunks: Array<{ page: number; text: string }>,
  page: number
): string[] {
  return chunks.filter((chunk) => chunk.page === page).map((chunk) => chunk.text);
}

describe('真实 PDF 样张解析', () => {
  it(
    'orders two-column pages as header → whole left column → whole right column',
    async () => {
      const file = await makeTwoColumnPdf();
      const parsed = await parsePdf(new Uint8Array(readFileSync(file)));
      expect(parsed.pages).toBe(2);
      // 真实 PDF.js 行确实进入了双栏分支：跨栏标题横跨两栏、左栏最右 < 右栏最左。
      const page1 = parsed.chunks
        .filter((chunk) => chunk.page === 1)
        .map((chunk) => ({ text: chunk.text, bbox: JSON.parse(chunk.bbox) as number[] }));
      const headerBox = page1.find((chunk) => chunk.text.includes('HEADER PAGE 1'))?.bbox;
      const leftBoxes = page1.filter((chunk) => chunk.text.includes('LEFT1-'));
      const rightBoxes = page1.filter((chunk) => chunk.text.includes('RIGHT1-'));
      expect(headerBox).toBeDefined();
      expect(headerBox![2]).toBeGreaterThan(600 * 0.55);
      expect(headerBox![0]).toBeLessThan(600 * 0.45);
      expect(Math.max(...leftBoxes.map((chunk) => chunk.bbox[2]!))).toBeLessThan(600 * 0.55);
      expect(Math.min(...rightBoxes.map((chunk) => chunk.bbox[0]!))).toBeGreaterThan(600 * 0.45);
      expect(Math.max(...leftBoxes.map((chunk) => chunk.bbox[2]!))).toBeLessThan(
        Math.min(...rightBoxes.map((chunk) => chunk.bbox[0]!))
      );
      for (const pageNumber of [1, 2]) {
        const texts = chunkTexts(parsed.chunks, pageNumber);
        const headerIndex = texts.findIndex((text) => text.includes(`HEADER PAGE ${pageNumber}`));
        const leftIndexes = [1, 2, 3, 4, 5].map((line) =>
          texts.findIndex((text) => text.includes(`LEFT${pageNumber}-${line} `))
        );
        const rightIndexes = [1, 2, 3, 4, 5].map((line) =>
          texts.findIndex((text) => text.includes(`RIGHT${pageNumber}-${line} `))
        );
        expect(headerIndex).toBeGreaterThanOrEqual(0);
        expect(leftIndexes.every((index) => index >= 0)).toBe(true);
        expect(rightIndexes.every((index) => index >= 0)).toBe(true);
        // 标题在左栏之前；左栏 5 行整体在右栏 5 行之前；栏内保持自上而下。
        for (const index of leftIndexes) expect(index).toBeGreaterThan(headerIndex);
        for (let line = 1; line < 5; line += 1) {
          expect(leftIndexes[line]!).toBeGreaterThan(leftIndexes[line - 1]!);
          expect(rightIndexes[line]!).toBeGreaterThan(rightIndexes[line - 1]!);
        }
        expect(Math.max(...leftIndexes)).toBeLessThan(Math.min(...rightIndexes));
      }

      // Store 导入后 chunks 的 rowid 顺序与解析顺序一致（页内同样是标题→左→右）。
      const document = await store.importDocument(file);
      expect(document.pages).toBe(2);
      const stored = store.listChunks(document.id);
      for (const pageNumber of [1, 2]) {
        expect(chunkTexts(stored, pageNumber)).toEqual(chunkTexts(parsed.chunks, pageNumber));
      }
    },
    30_000
  );

  it(
    'parses a rotated page without throwing, with the page count and text intact',
    async () => {
      const file = await makeRotatedPdf();
      const parsed = await parsePdf(new Uint8Array(readFileSync(file)));
      expect(parsed.pages).toBe(1);
      const texts = chunkTexts(parsed.chunks, 1);
      expect(texts.length).toBeGreaterThan(0);
      expect(texts.join('\n')).toContain('ROTATED-MARKER');
      // 旋转页的 bbox 也必须是页面内坐标：页 500x700 旋转 90° 后视口为 700x500。
      // 这里防止回退到“手写 viewport.height - y”的越界实现（历史上 y 会变成负数）。
      for (const chunk of parsed.chunks) {
        const bbox = JSON.parse(chunk.bbox) as number[];
        expect(bbox).toHaveLength(4);
        expect(bbox.every((value) => Number.isFinite(value))).toBe(true);
        expect(bbox[0]).toBeGreaterThanOrEqual(0);
        expect(bbox[1]).toBeGreaterThanOrEqual(0);
        expect(bbox[2]).toBeLessThanOrEqual(701);
        expect(bbox[3]).toBeLessThanOrEqual(501);
      }
      const document = await store.importDocument(file);
      expect(document.pages).toBe(1);
      expect(store.listChunks(document.id).map((chunk) => chunk.text).join('\n')).toContain(
        'ROTATED-MARKER'
      );
    },
    30_000
  );

  it(
    'indexes every page of a 24-page document with its page marker',
    async () => {
      const file = await makeLongPdf();
      const parsed = await parsePdf(new Uint8Array(readFileSync(file)));
      expect(parsed.pages).toBe(24);
      const expectedPages = Array.from({ length: 24 }, (_, index) => index + 1);
      for (const pageNumber of expectedPages) {
        const texts = chunkTexts(parsed.chunks, pageNumber);
        expect(texts.length).toBeGreaterThanOrEqual(1);
        expect(texts.join('\n')).toContain(`LONG-PAGE-${pageNumber} `);
        expect(texts.join('\n')).toContain(`LONG-BODY-${pageNumber} `);
      }
      // 所有 24 页都有 chunk（总数至少 24，远小于 24*2 才说明有页丢了）。
      expect(parsed.chunks.length).toBeGreaterThanOrEqual(24);
    },
    60_000
  );
});
