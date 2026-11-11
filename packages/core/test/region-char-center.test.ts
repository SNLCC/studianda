import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PDFDocument, StandardFonts, degrees } from 'pdf-lib';
import { afterAll, describe, expect, it } from 'vitest';
import { regionTextFromLayer } from '../src/ocr.js';
import { Store } from '../src/store.js';

const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-region-char-center-'));
const store = new Store(dataDir);

afterAll(() => {
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const WORD = 'ABCDEFGHIJ';

// 口径说明：PDF.js 6.4.299 公开的 `TextItem` 只有 str/dir/transform/width/height/fontName/hasEOL
// （见 node_modules/pdfjs-dist/types/src/display/api.d.ts:310-336），没有逐字符 advance。
// 本文件验证当前“item.width 按字符数均分”的近似行为，并显式记录引擎限制造成的边界偏差；
// 要拿到真实字符框需要换 PDF 引擎（如 PyMuPDF/mupdf-js）。

async function makeTextPdf(
  file: string,
  options: { rotate?: number; fontSize?: number; text?: string } = {}
): Promise<{ textWidth: number; charWidths: number[] }> {
  const text = options.text ?? WORD;
  const pdf = await PDFDocument.create();
  pdf.setTitle(`region-char-${options.rotate ?? 0}-${file}`);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const fontSize = options.fontSize ?? 20;
  const page = pdf.addPage([400, 600]);
  page.drawText(text, { x: 30, y: 540, size: fontSize, font });
  if (options.rotate) page.setRotation(degrees(options.rotate));
  writeFileSync(file, await pdf.save());
  return {
    textWidth: font.widthOfTextAtSize(text, fontSize),
    charWidths: [...text].map((char) => font.widthOfTextAtSize(char, fontSize))
  };
}

describe('区域 OCR 文本层字符中心切分', () => {
  it('窄选区只返回被覆盖的字符，不再整词纳入', async () => {
    const file = path.join(dataDir, 'narrow.pdf');
    const { textWidth } = await makeTextPdf(file);
    const document = await store.importDocument(file);
    // 选区从词中间开始：只覆盖后 5 个字符（字符中心 >= 词宽 55%）。
    const startX = (30 + textWidth * 0.55) / 400;
    const text = await regionTextFromLayer(store, document.id, 1, {
      x0: startX,
      y0: 0,
      x1: 0.95,
      y1: 1
    });
    // 字宽不等，具体边界字符可能差一个；关键是只返回被覆盖的后缀、不再整词带出。
    expect(text.length).toBeGreaterThan(0);
    expect(text.length).toBeLessThan(WORD.length);
    expect(WORD.endsWith(text)).toBe(true);
    expect(text).not.toBe(WORD);
  });

  it('同一 item 内宽窄字符混排时，uniform 近似与真实字符中心存在已知偏差（引擎限制）', async () => {
    // 'WIDEAAiiii' 里 W/I/D/E 与 i 的 advance 差异大；真实字符框能拿到逐字符位置，
    // 这里只能把 item 总宽均分，因此同一个窄选区边界会选出不同起始字符。
    const mixed = 'WIDEAAiiii';
    const file = path.join(dataDir, 'mixed-width.pdf');
    const { textWidth, charWidths } = await makeTextPdf(file, { text: mixed });
    const document = await store.importDocument(file);
    const totalWidth = charWidths.reduce((sum, width) => sum + width, 0);
    // 用标准 Helvetica 字宽算出每个字符的真实中心（PDF.js item.width 同源的近似真值）。
    let consumed = 0;
    const actualCenters = charWidths.map((width) => {
      const center = (consumed + width / 2) / totalWidth;
      consumed += width;
      return center;
    });
    expect(totalWidth).toBeCloseTo(textWidth, 1);
    // 选区从第 4 个字符 'E' 的真实中心开始：真实字符框会从 E 开始，uniform 近似会从更后面开始。
    const boundaryPageX = (30 + actualCenters[3]! * textWidth) / 400;
    const step = textWidth / mixed.length;
    const uniformStart = Array.from(
      { length: mixed.length },
      (_, index) => (30 + (index + 0.5) * step) / 400
    ).findIndex((center) => center >= boundaryPageX);
    expect(uniformStart).toBeGreaterThan(3);

    const text = await regionTextFromLayer(store, document.id, 1, {
      x0: boundaryPageX,
      y0: 0,
      x1: 0.95,
      y1: 1
    });
    expect(text).toBe(mixed.slice(uniformStart));
    // 真实字符框会返回 EAAiiii；这里因引擎限制跳过更多字符 —— 不声称已对齐。
    expect(text).not.toBe(mixed.slice(3));
  });

  it('普通整段选区行为不变，返回完整文本', async () => {
    const file = path.join(dataDir, 'full.pdf');
    await makeTextPdf(file);
    const document = await store.importDocument(file);
    const text = await regionTextFromLayer(store, document.id, 1, {
      x0: 0,
      y0: 0,
      x1: 1,
      y1: 1
    });
    expect(text).toBe(WORD);
  });

  it('完全不相交的选区返回空（交给渲染 OCR 回退）', async () => {
    const file = path.join(dataDir, 'miss.pdf');
    await makeTextPdf(file);
    const document = await store.importDocument(file);
    const text = await regionTextFromLayer(store, document.id, 1, {
      x0: 0,
      y0: 0.8,
      x1: 1,
      y1: 0.95
    });
    expect(text).toBe('');
  });

  it('旋转页仍按归一化视觉坐标取字符（不崩溃且能取到文本）', async () => {
    const file = path.join(dataDir, 'rotated.pdf');
    await makeTextPdf(file, { rotate: 90 });
    const document = await store.importDocument(file);
    const text = await regionTextFromLayer(store, document.id, 1, {
      x0: 0,
      y0: 0,
      x1: 1,
      y1: 1
    });
    expect(text).toBe(WORD);
  });
});
