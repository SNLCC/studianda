import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PDFDocument, StandardFonts, type PDFFont, type PDFPage } from 'pdf-lib';
import { afterAll, describe, expect, it } from 'vitest';
import { extractPdfLayout, type LayoutLine } from '../src/pdf-layout.js';

/**
 * 行合并（pdf-layout）的行为契约：
 *
 * 1. 上标脚注编号（字号小、基线略高、与主行水平相邻）必须并进同一行，不能拆成独立行；
 * 2. 行内阈值按字号比例：词间距/上标偏移小于 0.9×字号 时仍是同一行；
 * 3. 表格列/双栏这类大间距、以及正常的下一行（基线差≈行距）必须分行。
 *
 * 写死 2pt/20pt 时第 1 条会失败（句子断裂、上标被当成独立行，进而影响标题/内容块判定）。
 */

const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-pdf-lines-'));
let counter = 0;

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

async function render(
  draw: (page: PDFPage, font: PDFFont) => void
): Promise<LayoutLine[]> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([500, 700]);
  draw(page, font);
  const bytes = await pdf.save();
  writeFileSync(path.join(dataDir, `lines-${(counter += 1)}.pdf`), bytes);
  const layout = await extractPdfLayout(new Uint8Array(bytes));
  return layout.pages[0]?.lines ?? [];
}

describe('pdf-layout 行合并', () => {
  it('把上标脚注编号并进主行（基线偏移按主字号比例容忍）', async () => {
    const lines = await render((page, font) => {
      const main = 'The result appears in Ref.';
      const mainWidth = font.widthOfTextAtSize(main, 12);
      page.drawText(main, { x: 40, y: 500, size: 12, font });
      page.drawText('1', { x: 40 + mainWidth, y: 504, size: 7, font });
      const supWidth = font.widthOfTextAtSize('1', 7);
      page.drawText(', which agrees with prior work.', {
        x: 40 + mainWidth + supWidth,
        y: 500,
        size: 12,
        font
      });
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]?.text).toBe('The result appears in Ref.1, which agrees with prior work.');
    // 行字号取主字号，不能因为上标变小而把整行当小字。
    expect(lines[0]?.size).toBeGreaterThan(11);
  });

  it('大字号上的上标（偏移 9pt，超过写死的 2pt）同样并进同一行', async () => {
    const lines = await render((page, font) => {
      const main = 'A large title';
      const mainWidth = font.widthOfTextAtSize(main, 24);
      page.drawText(main, { x: 40, y: 400, size: 24, font });
      page.drawText('*', { x: 40 + mainWidth, y: 409, size: 12, font });
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]?.text).toBe('A large title*');
  });

  it('同一行内的普通词间距仍然是同一行', async () => {
    const lines = await render((page, font) => {
      const width = font.widthOfTextAtSize('alpha', 12);
      page.drawText('alpha', { x: 40, y: 500, size: 12, font });
      page.drawText('beta', { x: 40 + width + 3, y: 500, size: 12, font });
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]?.text.replace(/\s+/g, '')).toBe('alphabeta');
  });

  it('表格列的大空白记进 line.gap（供表格识别用），正常下一行分行', async () => {
    // 同一基线的大间距会被 PDF.js 表示成独立的空白 text item：空白本身不另起行，
    // 但要累计成 line.gap（表格列判定依赖它）；行内空白不会把词拆成两行。
    const lines = await render((page, font) => {
      page.drawText('Cell A', { x: 40, y: 500, size: 12, font });
      page.drawText('Cell B', { x: 320, y: 500, size: 12, font });
      page.drawText('next line', { x: 40, y: 486, size: 12, font });
    });
    expect(lines).toHaveLength(2);
    expect(lines[0]?.text).toBe('Cell A Cell B');
    expect(lines[0]?.gap ?? 0).toBeGreaterThan(0.03);
    expect(lines[1]?.text).toBe('next line');
  });
});
