import { describe, expect, it } from 'vitest';
import {
  PDFArray,
  PDFBool,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRef,
  degrees
} from 'pdf-lib';
import type { AnnotationRecord } from '@studianda/shared';
import { buildAnnotatedPdf } from '../src/annotated-pdf.js';

function annotation(overrides: Partial<AnnotationRecord>): AnnotationRecord {
  return {
    id: 'ann-1',
    documentId: 'doc-1',
    page: 1,
    quote: '原文一句',
    content: '批注一句',
    rects: '',
    color: 'yellow',
    style: 'highlight',
    created: '',
    ...overrides
  };
}

/** 两页 600x800 PDF；第一页可按需设置 /Rotate。 */
async function makePdf(rotation = 0): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.addPage([600, 800]);
  pdf.addPage([600, 800]);
  if (rotation) pdf.getPage(0).setRotation(degrees(rotation));
  return pdf.save();
}

function annotsOf(pdf: PDFDocument, index: number): PDFArray | null {
  const value = pdf.getPage(index).node.lookup(PDFName.of('Annots'));
  return value instanceof PDFArray ? value : null;
}

function dictOf(annots: PDFArray, index: number): PDFDict {
  return annots.lookup(index, PDFDict);
}

function refOf(annots: PDFArray, index: number): PDFRef {
  const entry = annots.get(index);
  if (!(entry instanceof PDFRef)) throw new Error(`annots[${index}] 不是间接引用`);
  return entry;
}

function pageRefOf(pdf: PDFDocument, index: number): PDFRef {
  return pdf.getPage(index).ref;
}

/** 读取字典里的间接引用字段（例如 /P、/Popup、/Parent）并返回对象号字符串。 */
function refText(dict: PDFDict, key: string): string {
  const value = dict.get(PDFName.of(key));
  if (!(value instanceof PDFRef)) throw new Error(`${key} 不是间接引用`);
  return value.toString();
}

function subtypeOf(dict: PDFDict): string {
  return dict.lookup(PDFName.of('Subtype'), PDFName).asString();
}

/** /T、/NM、/M、/CreationDate、/Contents、/RC 都是 PDFHexString。 */
function textOf(dict: PDFDict, key: string): string {
  return dict.lookup(PDFName.of(key), PDFHexString).decodeText();
}

function numbersOf(dict: PDFDict, key: string): number[] {
  const array = dict.lookup(PDFName.of(key), PDFArray);
  const values: number[] = [];
  for (let index = 0; index < array.size(); index += 1) {
    values.push(array.lookup(index, PDFNumber).asNumber());
  }
  return values;
}

describe('annotated PDF export', () => {
  it('merges every rect of a highlight into one annotation with one QuadPoints array', async () => {
    const rects: Array<[number, number, number, number]> = [
      [0.1, 0.1, 0.5, 0.14],
      [0.1, 0.15, 0.4, 0.19]
    ];
    const result = await buildAnnotatedPdf(await makePdf(), [
      annotation({ rects: JSON.stringify(rects), style: 'highlight' })
    ]);

    expect(result.placed).toBe(1);
    expect(result.unplaced).toBe(0);
    expect(result.unplacedReasons).toEqual({});
    expect(result.byStyle).toMatchObject({ highlight: 1 });

    const output = await PDFDocument.load(result.bytes);
    const annots = annotsOf(output, 0);
    // 带文字的批注会额外写入一个 /Popup 弹出批注对象，所以 /Annots 里是 2 项。
    expect(annots?.size()).toBe(2);
    const dict = dictOf(annots!, 0);
    expect(subtypeOf(dict)).toBe('/Highlight');

    // 两个 rect → 一条 QuadPoints（每个 rect 8 个数）。
    const quad = numbersOf(dict, 'QuadPoints');
    expect(quad).toHaveLength(16);
    // 页面 600x800，y 轴翻转：上= (1-0.1)*800=720，下=(1-0.14)*800=688。
    expect(quad.slice(0, 8)).toEqual([60, 720, 300, 720, 60, 688, 300, 688]);
    expect(quad.slice(8, 16)).toEqual([60, 680, 240, 680, 60, 648, 240, 648]);

    // Rect 是全部矩形的并集。
    expect(numbersOf(dict, 'Rect')).toEqual([60, 648, 300, 720]);
  });

  it('skips rotated pages and reports rotated_page', async () => {
    const result = await buildAnnotatedPdf(await makePdf(90), [
      annotation({ rects: JSON.stringify([[0.1, 0.1, 0.5, 0.2]]), style: 'highlight' })
    ]);

    expect(result.placed).toBe(0);
    expect(result.unplaced).toBe(1);
    expect(result.unplacedReasons).toMatchObject({ rotated_page: 1 });
    expect(result.pagesWithRotation).toEqual([1]);
    expect(result.unplacedDetails?.[0]).toMatchObject({ id: 'ann-1', reason: 'rotated_page' });

    const output = await PDFDocument.load(result.bytes);
    expect(annotsOf(output, 0)).toBeNull();
  });

  it('writes margin and page annotations as Text notes with quote and comment', async () => {
    const result = await buildAnnotatedPdf(await makePdf(), [
      annotation({ page: 2, rects: '[]', style: 'margin', quote: '原文摘录', content: '我的批注' }),
      annotation({ id: 'ann-2', page: 2, rects: '[]', style: 'page', quote: '整页原文', content: '' })
    ]);

    expect(result.placed).toBe(2);
    expect(result.byStyle).toEqual({ margin: 1, page: 1 });

    const output = await PDFDocument.load(result.bytes);
    const annots = annotsOf(output, 1);
    expect(annots?.size()).toBe(2);
    const first = dictOf(annots!, 0);
    expect(subtypeOf(first)).toBe('/Text');
    // 没有 rects 的 margin/page 批注回退到页面右上角（600x800，边距 8、便签 20）。
    expect(numbersOf(first, 'Rect')).toEqual([572, 772, 592, 792]);
    expect(refText(first, 'P')).toBe(pageRefOf(output, 1).toString());
    const contents = textOf(first, 'Contents');
    expect(contents).toContain('原文：原文摘录');
    expect(contents).toContain('批注：我的批注');
    // 便签同样是原生批注：作者、唯一名与富文本都在。
    expect(textOf(first, 'T')).toBe('勘读 · Studianda');
    expect(textOf(first, 'NM')).toBe('ann-1');
    expect(textOf(first, 'RC')).toContain('原文：原文摘录');
  });

  it('anchors margin notes beside the paragraph rect instead of the top-right corner', async () => {
    const result = await buildAnnotatedPdf(await makePdf(), [
      annotation({
        rects: JSON.stringify([
          [0.1, 0.2, 0.5, 0.24],
          [0.1, 0.25, 0.42, 0.29]
        ]),
        style: 'margin',
        quote: '段落原文',
        content: '段落批注'
      })
    ]);

    expect(result.placed).toBe(1);
    expect(result.byStyle).toEqual({ margin: 1 });

    const output = await PDFDocument.load(result.bytes);
    const dict = dictOf(annotsOf(output, 0)!, 0);
    expect(subtypeOf(dict)).toBe('/Text');
    // 段落首行 PDF 矩形 [60,608,300,640]；便签贴在首行右侧页边距：
    // left = 300+8 = 308，bottom = 640-20 = 620。
    expect(numbersOf(dict, 'Rect')).toEqual([308, 620, 328, 640]);
    // 不再固定在页面右上角 [572,772,592,792]。
    expect(numbersOf(dict, 'Rect')).not.toEqual([572, 772, 592, 792]);
    expect(refText(dict, 'P')).toBe(pageRefOf(output, 0).toString());
  });

  it('reports page_out_of_range and rejects invalid rect data', async () => {
    const result = await buildAnnotatedPdf(await makePdf(), [
      annotation({ page: 9, rects: '[]', style: 'page' }),
      annotation({ id: 'ann-2', page: 1, rects: JSON.stringify([[0, 0, 1.2, 0.5]]) })
    ]);

    expect(result.placed).toBe(0);
    expect(result.unplaced).toBe(2);
    expect(result.unplacedReasons).toMatchObject({ page_out_of_range: 1, invalid_rect: 1 });
    expect(result.message).toContain('没有批注能写入副本');
  });

  it('reports empty annotations instead of writing a blank note', async () => {
    const result = await buildAnnotatedPdf(await makePdf(), [
      annotation({ rects: '[]', style: 'page', quote: '', content: '' })
    ]);

    expect(result.placed).toBe(0);
    expect(result.unplacedReasons).toMatchObject({ empty_annotation: 1 });
  });

  it('reads a JSON rects string with valid rects and keeps underline subtype', async () => {
    const result = await buildAnnotatedPdf(await makePdf(), [
      annotation({ rects: JSON.stringify([[0.2, 0.2, 0.6, 0.24]]), style: 'underline' })
    ]);
    expect(result.placed).toBe(1);
    const output = await PDFDocument.load(result.bytes);
    const dict = dictOf(annotsOf(output, 0)!, 0);
    expect(subtypeOf(dict)).toBe('/Underline');
    expect(numbersOf(dict, 'QuadPoints')).toHaveLength(8);
  });

  it('writes complete native highlight annotations with contents, metadata and a linked Popup', async () => {
    const result = await buildAnnotatedPdf(await makePdf(), [
      annotation({
        rects: JSON.stringify([[0.1, 0.1, 0.5, 0.14]]),
        style: 'highlight',
        created: '2026-11-04T13:18:37.000Z'
      })
    ]);
    expect(result.placed).toBe(1);
    expect(result.byStyle).toEqual({ highlight: 1 });

    const output = await PDFDocument.load(result.bytes);
    const annots = annotsOf(output, 0)!;
    expect(annots.size()).toBe(2);
    const mark = dictOf(annots, 0);
    const popup = dictOf(annots, 1);
    const markRef = refOf(annots, 0);
    const popupRef = refOf(annots, 1);

    // 高亮标识本体不变。
    expect(subtypeOf(mark)).toBe('/Highlight');
    expect(numbersOf(mark, 'QuadPoints')).toEqual([60, 720, 300, 720, 60, 688, 300, 688]);
    expect(numbersOf(mark, 'Rect')).toEqual([60, 688, 300, 720]);

    // 批注与 popup 都带 /P 页面引用（Edge/PDFium 等按它确认批注归属页）。
    expect(refText(mark, 'P')).toBe(pageRefOf(output, 0).toString());
    expect(refText(popup, 'P')).toBe(pageRefOf(output, 0).toString());

    // 作者、唯一名、时间：注释列表里能看到是谁、什么时候标的。
    expect(textOf(mark, 'T')).toBe('勘读 · Studianda');
    expect(textOf(mark, 'NM')).toBe('ann-1');
    expect(textOf(mark, 'M')).toBe('D:20261104131837');
    expect(textOf(mark, 'CreationDate')).toBe('D:20261104131837');

    // 纯文本 /Contents 保留「原文 / 批注」，/RC 是供支持富文本的阅读器用的简单 XHTML。
    const contents = textOf(mark, 'Contents');
    expect(contents).toContain('原文：原文一句');
    expect(contents).toContain('批注：批注一句');
    const rc = textOf(mark, 'RC');
    expect(rc.startsWith('<body xmlns="http://www.w3.org/1999/xhtml">')).toBe(true);
    expect(rc).toContain('原文：原文一句');
    expect(rc).toContain('批注：批注一句');

    // 批注 /Popup 指向 popup；popup 也在同一页 /Annots 中，/Parent 回指批注。
    expect(mark.get(PDFName.of('Popup'))).toBeInstanceOf(PDFRef);
    expect((mark.get(PDFName.of('Popup')) as PDFRef).toString()).toBe(popupRef.toString());
    expect(popupRef.toString()).not.toBe(markRef.toString());
    expect(subtypeOf(popup)).toBe('/Popup');
    expect(popup.get(PDFName.of('Parent'))).toBeInstanceOf(PDFRef);
    expect((popup.get(PDFName.of('Parent')) as PDFRef).toString()).toBe(markRef.toString());
    expect(popup.lookup(PDFName.of('Open'), PDFBool).asBoolean()).toBe(false);

    // popup 是页面内一个正尺寸矩形，且靠近命中区域（右侧偏移或贴边）。
    const popupRect = numbersOf(popup, 'Rect');
    expect(popupRect).toHaveLength(4);
    expect(popupRect[2]).toBeGreaterThan(popupRect[0]!);
    expect(popupRect[3]).toBeGreaterThan(popupRect[1]!);
    expect(popupRect[0]).toBeGreaterThanOrEqual(0);
    expect(popupRect[2]).toBeLessThanOrEqual(600);
    expect(popupRect[1]).toBeGreaterThanOrEqual(0);
    expect(popupRect[3]).toBeLessThanOrEqual(800);
  });

  it('writes Contents from quote alone (no empty comment part) and still adds a Popup', async () => {
    const result = await buildAnnotatedPdf(await makePdf(), [
      annotation({
        rects: JSON.stringify([[0.1, 0.1, 0.5, 0.14]]),
        style: 'underline',
        quote: '只有原文',
        content: '',
        created: ''
      })
    ]);
    expect(result.placed).toBe(1);

    const output = await PDFDocument.load(result.bytes);
    const annots = annotsOf(output, 0)!;
    expect(annots.size()).toBe(2);
    const mark = dictOf(annots, 0);
    expect(subtypeOf(mark)).toBe('/Underline');
    const contents = textOf(mark, 'Contents');
    expect(contents).toBe('原文：只有原文');
    expect(contents).not.toContain('批注：');
    const rc = textOf(mark, 'RC');
    expect(rc).toContain('原文：只有原文');
    expect(rc).not.toContain('批注：');
    expect(dictOf(annots, 1)).toBeDefined();
    // created 为空：解析不出时间就不写 /M 与 /CreationDate。
    expect(mark.has(PDFName.of('M'))).toBe(false);
    expect(mark.has(PDFName.of('CreationDate'))).toBe(false);
  });

  it('keeps pure highlights without text free of empty Contents/RC/Popup', async () => {
    const result = await buildAnnotatedPdf(await makePdf(), [
      annotation({
        rects: JSON.stringify([[0.1, 0.1, 0.5, 0.14]]),
        style: 'highlight',
        quote: '',
        content: '',
        created: ''
      })
    ]);
    expect(result.placed).toBe(1);

    const output = await PDFDocument.load(result.bytes);
    const annots = annotsOf(output, 0)!;
    expect(annots.size()).toBe(1);
    const mark = dictOf(annots, 0);
    expect(subtypeOf(mark)).toBe('/Highlight');
    expect(mark.has(PDFName.of('Contents'))).toBe(false);
    expect(mark.has(PDFName.of('RC'))).toBe(false);
    expect(mark.has(PDFName.of('Popup'))).toBe(false);
    // 唯一名与作者仍写上，阅读器注释列表能识别这是一条批注。
    expect(textOf(mark, 'NM')).toBe('ann-1');
    expect(textOf(mark, 'T')).toBe('勘读 · Studianda');
    expect(refText(mark, 'P')).toBe(pageRefOf(output, 0).toString());
  });

  it('strips Markdown from user comments in Contents/RC but keeps the quote verbatim', async () => {
    const result = await buildAnnotatedPdf(await makePdf(), [
      annotation({
        rects: JSON.stringify([[0.1, 0.1, 0.5, 0.14]]),
        style: 'highlight',
        quote: '原文 **不是 Markdown** 保持',
        content:
          '## 我的结论\n\n**重点**：这段很重要，见 `code`。\n\n<c:#b23b2e>颜色</c>\n\n::: center\n居中批注\n:::'
      }),
      annotation({
        id: 'ann-2',
        page: 2,
        rects: '[]',
        style: 'page',
        quote: '整页原文',
        content: '**便签批注**'
      })
    ]);
    expect(result.placed).toBe(2);

    const output = await PDFDocument.load(result.bytes);
    const mark = dictOf(annotsOf(output, 0)!, 0);
    const contents = textOf(mark, 'Contents');
    // quote 是 PDF 原文：其中的 ** 保持不动。
    expect(contents).toContain('原文：原文 **不是 Markdown** 保持');
    // 用户批注清洗成纯文本：标题、加粗、行内代码标记都不出现。
    expect(contents).toContain('批注：');
    expect(contents).toContain('我的结论');
    expect(contents).toContain('重点');
    expect(contents).toContain('这段很重要');
    expect(contents).toContain('code');
    expect(contents).toContain('颜色');
    expect(contents).toContain('居中批注');
    expect(contents).not.toContain('##');
    expect(contents).not.toContain('**重点**');
    expect(contents).not.toContain('`code`');
    // 颜色/对齐扩展语法也不能出现在 PDF 原生批注里。
    expect(contents).not.toContain('<c:');
    expect(contents).not.toContain(':::');
    const rc = textOf(mark, 'RC');
    expect(rc).toContain('原文：原文 **不是 Markdown** 保持');
    expect(rc).not.toContain('##');
    expect(rc).not.toContain('**重点**');
    expect(rc).not.toContain('<c:');
    expect(rc).not.toContain(':::');

    // 整页便签同样清洗批注正文。
    const note = dictOf(annotsOf(output, 1)!, 0);
    expect(subtypeOf(note)).toBe('/Text');
    const noteContents = textOf(note, 'Contents');
    expect(noteContents).toContain('批注：便签批注');
    expect(noteContents).not.toContain('**');
  });

  it('preserves a pre-existing AIGC marker and legacy keys instead of overwriting or cleaning them', async () => {
    const base = await PDFDocument.create();
    base.addPage([600, 800]);
    base.setTitle('source');
    const sourceInfo = base.context.lookup(base.context.trailerInfo.Info, PDFDict);
    const existing = JSON.stringify({
      AIGC: {
        Label: '1',
        ContentProducer: 'OtherTool',
        ProduceID: 'other-produce-id',
        ReservedCode1: '',
        ContentPropagator: 'OtherTool',
        PropagateID: 'other-propagate-id',
        ReservedCode2: ''
      }
    });
    sourceInfo.set(PDFName.of('AIGC'), PDFHexString.fromText(existing));
    sourceInfo.set(PDFName.of('AIGenerated'), PDFHexString.fromText('legacy-marker'));
    const original = await base.save();

    const result = await buildAnnotatedPdf(original, [
      annotation({ rects: '[]', style: 'page', quote: '原文', content: '批注' })
    ]);
    expect(result.placed).toBe(1);

    const output = await PDFDocument.load(result.bytes);
    const info = output.context.lookup(output.context.trailerInfo.Info, PDFDict);
    // 第三方/旧版本已有 AIGC：原样保留，不追加第二份、不覆盖。
    expect(info.lookup(PDFName.of('AIGC'), PDFHexString).decodeText()).toBe(existing);
    // 旧版本的非标准键也不清洗，避免“导出即去标识”。
    expect(info.lookup(PDFName.of('AIGenerated'), PDFHexString).decodeText()).toBe('legacy-marker');
  });

  it('does not add AIGC metadata, a notice page, or change the original PDF', async () => {
    const base = await PDFDocument.create();
    base.addPage([600, 800]);
    base.setKeywords(['machine learning', 'translation']);
    const original = await base.save();
    const before = new Uint8Array(original);

    const result = await buildAnnotatedPdf(original, [
      annotation({ rects: '[]', style: 'page', quote: '整页原文', content: '批注' })
    ]);
    expect(result.placed).toBe(1);
    // 原文件字节没有被改动（只生成副本）。
    expect(original).toEqual(before);

    const output = await PDFDocument.load(result.bytes);
    expect(output.getPageCount()).toBe(1);
    const info = output.context.lookup(output.context.trailerInfo.Info);
    expect(info).toBeInstanceOf(PDFDict);
    const dict = info as PDFDict;
    expect(dict.has(PDFName.of('AIGC'))).toBe(false);
    // 原有关键词保留。
    const keywords = dict.lookup(PDFName.of('Keywords'), PDFHexString).decodeText();
    expect(keywords).toContain('machine learning');
    expect(keywords).toContain('translation');
  });
});
