import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRawStream,
  decodePDFRawStream,
  degrees,
  type PDFPage
} from 'pdf-lib';
import { AI_ANSWER_COPY_SUFFIX, type AnnotationRecord } from '@studianda/shared';
import { describe, expect, it } from 'vitest';
import {
  buildAnnotatedPdf,
  imageWatermarkPlacement,
  type AnnotatedPdfOptions
} from '../src/annotated-pdf.js';

/**
 * 带批注 PDF 的 AI 标识：Info 元数据之外，还要把水印**烧进像素**（图片 XObject），
 * 不能是页脚文字（选中即可删）。这里验证：含 AI 内容时每页都有图片水印、纯用户内容
 * 完全不加；水印条渲染/嵌入失败时 fail-closed 拒绝产出。
 */

const AI_TEXT = `模型生成的回答正文。${AI_ANSWER_COPY_SUFFIX}`;

function annotation(overrides: Partial<AnnotationRecord> = {}): AnnotationRecord {
  return {
    id: 'ann-1',
    documentId: 'doc-1',
    page: 1,
    quote: '原文一句',
    content: AI_TEXT,
    rects: '[]',
    color: 'yellow',
    style: 'page',
    created: '',
    ...overrides
  };
}

interface PageSpec {
  width: number;
  height: number;
  rotation?: number;
}

/** 造一份多页 PDF（不同尺寸/旋转），默认两页 600x800。 */
async function makePdf(
  specs: PageSpec[] = [
    { width: 600, height: 800 },
    { width: 600, height: 800 }
  ]
): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  for (const spec of specs) {
    const page = pdf.addPage([spec.width, spec.height]);
    if (spec.rotation) page.setRotation(degrees(spec.rotation));
  }
  return pdf.save();
}

function xObjectsOf(pdf: PDFDocument, index: number): PDFDict | null {
  const resources = pdf.getPage(index).node.Resources();
  if (!(resources instanceof PDFDict)) return null;
  return resources.lookupMaybe(PDFName.of('XObject'), PDFDict) ?? null;
}

interface ImageXObject {
  width: number;
  height: number;
}

/** 页面资源字典里的图片 XObject（/Subtype /Image），用来验证“烧进像素”的图片真的贴上了。 */
function imageObjectsOf(pdf: PDFDocument, index: number): ImageXObject[] {
  const xobjects = xObjectsOf(pdf, index);
  if (!xobjects) return [];
  const images: ImageXObject[] = [];
  for (const key of xobjects.keys()) {
    const object = xobjects.lookup(key);
    if (!(object instanceof PDFRawStream)) continue;
    const subtype = object.dict.lookupMaybe(PDFName.of('Subtype'), PDFName);
    if (subtype?.asString() !== '/Image') continue;
    images.push({
      width: object.dict.lookup(PDFName.of('Width'), PDFNumber).asNumber(),
      height: object.dict.lookup(PDFName.of('Height'), PDFNumber).asNumber()
    });
  }
  return images;
}

function infoOf(pdf: PDFDocument): PDFDict {
  return pdf.context.lookup(pdf.context.trailerInfo.Info, PDFDict);
}

/** 取页面内容流原文（保存时内容流被 Flate 压缩，先解码再读 `cm` 矩阵）。 */
function contentStreamText(page: PDFPage): string {
  const decode = (stream: PDFRawStream): string =>
    new TextDecoder().decode(decodePDFRawStream(stream).decode());
  const contents = page.node.Contents();
  if (contents instanceof PDFRawStream) return decode(contents);
  if (contents instanceof PDFArray) {
    const parts: string[] = [];
    for (let index = 0; index < contents.size(); index += 1) {
      const stream = contents.lookupMaybe(index, PDFRawStream);
      if (stream) parts.push(decode(stream));
    }
    return parts.join('\n');
  }
  throw new Error('页面没有内容流');
}

function matricesOf(content: string): number[][] {
  return [...content.matchAll(/([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) cm/g)].map(
    (match) => match.slice(1, 7).map((value) => Number(value))
  );
}

/** 依次左乘内容流里的所有 `cm`，得到图片局部单位方块 → 用户空间的最终变换矩阵。 */
function composeMatrices(matrices: number[][]): number[] {
  const multiply = (left: number[], right: number[]): number[] => [
    left[0]! * right[0]! + left[2]! * right[1]!,
    left[1]! * right[0]! + left[3]! * right[1]!,
    left[0]! * right[2]! + left[2]! * right[3]!,
    left[1]! * right[2]! + left[3]! * right[3]!,
    left[0]! * right[4]! + left[2]! * right[5]! + left[4]!,
    left[1]! * right[4]! + left[3]! * right[5]! + left[5]!
  ];
  return matrices.reduce((current, next) => multiply(current, next), [1, 0, 0, 1, 0, 0]);
}

/** 用变换矩阵把图片局部坐标 (x,y) 投到用户空间。 */
function transformPoint(matrix: number[], x: number, y: number): [number, number] {
  return [
    matrix[0]! * x + matrix[2]! * y + matrix[4]!,
    matrix[1]! * x + matrix[3]! * y + matrix[5]!
  ];
}

describe('带批注 PDF：AI 内容烧像素水印', () => {
  it('含 AI 内容时页数不变、每页多一个图片 XObject、页面尺寸与旋转不变', async () => {
    const original = await makePdf([
      { width: 600, height: 800 },
      { width: 842, height: 595 },
      { width: 300, height: 400, rotation: 90 }
    ]);
    const before = new Uint8Array(original);

    const result = await buildAnnotatedPdf(original, [annotation()]);
    expect(result.placed).toBe(1);
    // 原文件字节没被改动（只产出副本）。
    expect(original).toEqual(before);

    const output = await PDFDocument.load(result.bytes);
    expect(output.getPageCount()).toBe(3);
    const sizes: Array<[number, number]> = [
      [600, 800],
      [842, 595],
      [300, 400]
    ];
    for (let index = 0; index < 3; index += 1) {
      const size = output.getPage(index).getSize();
      expect([size.width, size.height]).toEqual(sizes[index]);
      // 每页恰好一个图片 XObject（同一张水印条，按页面尺寸分别缩放）。
      const images = imageObjectsOf(output, index);
      expect(images).toHaveLength(1);
      // 3x 渲染后的窄条：高 108px，宽大于高，且不是页面截图级的大图。
      expect(images[0]!.height).toBe(108);
      expect(images[0]!.width).toBeGreaterThan(images[0]!.height);
    }
    // AI 元数据仍按原路径写入 Info。
    expect(infoOf(output).lookup(PDFName.of('AIGC'), PDFHexString).decodeText()).toBe('true');
    expect(infoOf(output).lookup(PDFName.of('AITool'), PDFHexString).decodeText()).toBe(
      'Studianda'
    );
  });

  it('纯手写批注不加水印图片、不写 AIGC、页数不变', async () => {
    const result = await buildAnnotatedPdf(await makePdf(), [
      annotation({ content: '自己写的批注，没有 AI 标识。' })
    ]);
    expect(result.placed).toBe(1);

    const output = await PDFDocument.load(result.bytes);
    expect(output.getPageCount()).toBe(2);
    for (let index = 0; index < output.getPageCount(); index += 1) {
      expect(xObjectsOf(output, index)).toBeNull();
      expect(imageObjectsOf(output, index)).toHaveLength(0);
    }
    expect(infoOf(output).has(PDFName.of('AIGC'))).toBe(false);
  });

  it('实际绘制矩阵：水印宽约页宽 24%、贴右下角（600x800 页面）', async () => {
    const result = await buildAnnotatedPdf(await makePdf([{ width: 600, height: 800 }]), [
      annotation()
    ]);
    const output = await PDFDocument.load(result.bytes);
    const image = imageObjectsOf(output, 0)[0]!;
    const matrix = composeMatrices(matricesOf(contentStreamText(output.getPage(0))));
    const pageWidth = 600;
    const pageHeight = 800;
    const margin = Math.min(pageWidth, pageHeight) * 0.03;
    const expectedWidth = pageWidth * 0.24;
    // drawImage 依次写 translate/rotate/scale/skew 的 cm；合成后 a/c 即图片局部轴。
    expect(matrix[0]).toBeCloseTo(expectedWidth, 6);
    expect(matrix[1]).toBe(0);
    expect(matrix[2]).toBe(0);
    expect(matrix[3]).toBeCloseTo((expectedWidth * image.height) / image.width, 6);
    // 宽度在需求要求的 22–28% 内。
    expect(matrix[0]! / pageWidth).toBeGreaterThanOrEqual(0.22);
    expect(matrix[0]! / pageWidth).toBeLessThanOrEqual(0.28);
    // 右下角：右边距 = 下边距 = 3% 短边。
    expect(matrix[4]).toBeCloseTo(pageWidth - margin - expectedWidth, 6);
    expect(matrix[5]).toBeCloseTo(margin, 6);
  });

  it('旋转 90° 页面：实际矩阵把水印正立放到视觉右下角（原始页右上角）', async () => {
    const result = await buildAnnotatedPdf(await makePdf([{ width: 600, height: 800, rotation: 90 }]), [
      annotation()
    ]);
    const output = await PDFDocument.load(result.bytes);
    const image = imageObjectsOf(output, 0)[0]!;
    const matrix = composeMatrices(matricesOf(contentStreamText(output.getPage(0))));
    // 90° 逆时针：图片局部 +x 指向用户空间 +y（视觉右）。
    expect((Math.atan2(matrix[1]!, matrix[0]!) * 180) / Math.PI).toBeCloseTo(90, 6);
    const corners = [
      transformPoint(matrix, 0, 0),
      transformPoint(matrix, 1, 0),
      transformPoint(matrix, 0, 1),
      transformPoint(matrix, 1, 1)
    ];
    const xs = corners.map(([x]) => x);
    const ys = corners.map(([, y]) => y);
    const margin = Math.min(600, 800) * 0.03;
    // 视觉宽 = 800，水印视觉宽度 = 192；旋转后用户空间 bbox 的 y 跨度是 192、x 跨度是图片高度。
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(800 * 0.24, 6);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(
      (800 * 0.24 * image.height) / image.width,
      6
    );
    // 视觉右下角 = 原始页右上角，仍留边距。
    expect(Math.max(...xs)).toBeCloseTo(600 - margin, 6);
    expect(Math.max(...ys)).toBeCloseTo(800 - margin, 6);
  });

  it('水印条生成失败：抛“拒绝导出”错误且不产出副本（fail-closed）', async () => {
    const original = await makePdf();
    const before = new Uint8Array(original);
    const options: AnnotatedPdfOptions = {
      renderWatermarkStrip: async () => {
        throw new Error('模拟字体/编码失败');
      }
    };

    let failure: unknown;
    try {
      await buildAnnotatedPdf(original, [annotation()], options);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    // 可区分：是「AI 标识未能写入，拒绝导出」，而不是普通文件级 409。
    expect(message).toContain('拒绝导出未标识的 AI 内容');
    expect(message).toContain('图片水印标识未能写入');
    expect(message).toContain('模拟字体/编码失败');
    expect(message).not.toContain('原文件未改动');
    // 原文件字节依然没被改动（根本没走到保存）。
    expect(original).toEqual(before);
  });

  it('水印条不是合法 PNG（embed 失败）：同样拒绝导出', async () => {
    const original = await makePdf();
    const options: AnnotatedPdfOptions = {
      renderWatermarkStrip: async () => new Uint8Array([1, 2, 3, 4])
    };

    let failure: unknown;
    try {
      await buildAnnotatedPdf(original, [annotation()], options);
    } catch (error) {
      failure = error;
    }
    const message = failure instanceof Error ? failure.message : String(failure);
    expect(message).toContain('拒绝导出未标识的 AI 内容');
    expect(message).toContain('水印图片嵌入失败');
  });
});

describe('水印落位：按页面实际尺寸与 /Rotate 计算', () => {
  const image = { width: 720, height: 108 };
  const box = { left: 20, bottom: 30, width: 600, height: 800 };
  const margin = Math.max(4, Math.min(box.width, box.height) * 0.03);

  it.each([0, 90, 180, 270])('%i°：水印在视觉右下角、不越界、视觉宽度占页宽 24%%', (rotation) => {
    const placement = imageWatermarkPlacement(box, rotation, image.width, image.height);
    const [left, bottom, right, top] = placement.bounds;
    const swapped = rotation === 90 || rotation === 270;
    const visualWidth = swapped ? box.height : box.width;
    const visualHeight = swapped ? box.width : box.height;
    // 始终在可见区域内，且四边都留出边距。
    expect(left).toBeGreaterThanOrEqual(box.left + margin - 1e-6);
    expect(bottom).toBeGreaterThanOrEqual(box.bottom + margin - 1e-6);
    expect(right).toBeLessThanOrEqual(box.left + box.width - margin + 1e-6);
    expect(top).toBeLessThanOrEqual(box.bottom + box.height - margin + 1e-6);
    // 视觉宽度 = 页面可视宽度的 24%，纵横比与 PNG 一致。
    const visualStripWidth = swapped ? top - bottom : right - left;
    const visualStripHeight = swapped ? right - left : top - bottom;
    expect(visualStripWidth).toBeCloseTo(visualWidth * 0.24, 6);
    expect(visualStripHeight).toBeCloseTo((visualWidth * 0.24 * image.height) / image.width, 6);
    expect(visualStripWidth).toBeLessThanOrEqual(visualWidth - margin * 2);
    expect(visualStripHeight).toBeLessThanOrEqual(visualHeight - margin * 2);
    // 视觉右下角：页面旋转后对应不同的原始角落。
    if (rotation === 0) {
      expect(right).toBeCloseTo(box.left + box.width - margin, 6);
      expect(bottom).toBeCloseTo(box.bottom + margin, 6);
    } else if (rotation === 90) {
      expect(right).toBeCloseTo(box.left + box.width - margin, 6);
      expect(top).toBeCloseTo(box.bottom + box.height - margin, 6);
    } else if (rotation === 180) {
      expect(left).toBeCloseTo(box.left + margin, 6);
      expect(top).toBeCloseTo(box.bottom + box.height - margin, 6);
    } else {
      expect(left).toBeCloseTo(box.left + margin, 6);
      expect(bottom).toBeCloseTo(box.bottom + margin, 6);
    }
  });

  it('页面有 CropBox 偏移时按可见区域定位，不按 0 起算', () => {
    const placement = imageWatermarkPlacement(box, 0, image.width, image.height);
    expect(placement.bounds[2]).toBeCloseTo(box.left + box.width - margin, 6);
    expect(placement.bounds[1]).toBeCloseTo(box.bottom + margin, 6);
    expect(placement.rotate).toBe(0);
  });

  it('极扁页面按可用高度收窄，水印不越出页面', () => {
    const flat = { left: 0, bottom: 0, width: 1000, height: 30 };
    const placement = imageWatermarkPlacement(flat, 0, image.width, image.height);
    const [, bottom, right, top] = placement.bounds;
    expect(right).toBeLessThanOrEqual(flat.width);
    expect(bottom).toBeGreaterThanOrEqual(0);
    expect(top).toBeLessThanOrEqual(flat.height);
    expect(placement.width).toBeLessThan(1000 * 0.24);
    expect(placement.height).toBeLessThanOrEqual(flat.height);
  });
});
