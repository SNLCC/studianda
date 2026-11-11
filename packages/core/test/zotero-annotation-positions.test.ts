import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PDFDocument, StandardFonts, degrees } from 'pdf-lib';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { SecretStore } from '../src/secrets.js';
import { Store } from '../src/store.js';
import {
  normalizeZoteroRects,
  zoteroPositionData
} from '../src/zotero-annotations.js';
import { importZoteroAnnotations } from '../src/zotero.js';

/**
 * Zotero 自带坐标（annotationPosition.rects）→ 本应用 rects 的换算与导入：
 * - rect 是 PDF 用户空间、左下原点 [left, bottom, right, top]；
 * - 本应用 rects 是 0..1、左上原点；
 * - 有 Zotero 坐标时不再依赖文本层逐字定位（中文 PDF 文本层与摘引常有空格/标点差异）；
 * - 旋转页 / 坏坐标安全回退文本定位，再失败才页级。
 * 全程 mock fetch，不联网。
 */

const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-zotero-position-'));
const store = new Store(dataDir);
const secrets = new SecretStore();
let pdfPath = '';

beforeAll(async () => {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  // 第 1 页：标准 A4（与用户真实样本同尺寸）。
  const page1 = pdf.addPage([595.28, 841.89]);
  page1.drawText('Evidence sentence for Zotero positions', { x: 40, y: 540, size: 12, font });
  // 第 2 页：非标准大页（1000 x 1624），用于验证按每页实际尺寸换算。
  const page2 = pdf.addPage([1000, 1624]);
  page2.drawText('Nonstandard page text', { x: 60, y: 1400, size: 14, font });
  // 第 3 页：旋转 90 度，坐标换算必须安全回退。
  const page3 = pdf.addPage([1000, 1624]);
  page3.setRotation(degrees(90));
  page3.drawText('Rotated page text', { x: 60, y: 1400, size: 14, font });
  pdfPath = path.join(dataDir, 'fixture.pdf');
  writeFileSync(pdfPath, await pdf.save());
});

afterAll(() => {
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

interface MockResult {
  status?: number;
  body?: unknown;
}

function mockFetch(handler: (url: string) => MockResult): string[] {
  const urls: string[] = [];
  vi.stubGlobal('fetch', async (input: unknown) => {
    const url = String(input);
    urls.push(url);
    const result = handler(url);
    return new Response(result.body === undefined ? null : JSON.stringify(result.body), {
      status: result.status ?? 200,
      headers: new Headers({ 'content-type': 'application/json' })
    });
  });
  return urls;
}

async function makeZoteroDocument(key: string): Promise<string> {
  const document = await store.importZoteroDocument({
    identity: `local:users:0:${key}:${pdfPath}`,
    title: `zotero positions ${key}`,
    author: '',
    externalPath: pdfPath
  });
  return document.id;
}

/** 模拟 Zotero 附件 children：批注挂在附件下。 */
function mockAttachmentAnnotations(key: string, rows: unknown[]): string[] {
  return mockFetch((url) => {
    if (url.includes(`/items/${key}/children`)) return { body: rows };
    // 附件条目（用于找父条目笔记）：给一个没有 parentItem 的对象，笔记部分降级但不影响批注。
    if (url.includes(`/items/${key}?format=json`)) {
      return { body: { data: { itemType: 'attachment' } } };
    }
    return { body: [] };
  });
}

function annotationRow(input: {
  key: string;
  pageIndex: number;
  rects?: number[][];
  text?: string;
  comment?: string;
  type?: string;
}): Record<string, unknown> {
  return {
    key: input.key,
    data: {
      itemType: 'annotation',
      annotationType: input.type ?? 'highlight',
      annotationText: input.text ?? '',
      annotationComment: input.comment ?? '',
      annotationColor: '#ffd400',
      annotationPosition: JSON.stringify({
        pageIndex: input.pageIndex,
        ...(input.rects ? { rects: input.rects } : {})
      })
    }
  };
}

describe('Zotero rects → 应用 rects 纯函数', () => {
  it('用户真实样本：595.28x841.89 / rotation 0 得到约 [0.1478,0.5253,0.5363,0.5376]', () => {
    const data = {
      annotationPosition: JSON.stringify({
        pageIndex: 0,
        rects: [[88.011, 389.265, 319.241, 399.643]]
      })
    };
    const position = zoteroPositionData(data);
    expect(position.pageIndex).toBe(0);
    expect(position.rects).toEqual([[88.011, 389.265, 319.241, 399.643]]);
    const result = normalizeZoteroRects(position.rects, {
      width: 595.28,
      height: 841.89,
      rotation: 0
    });
    expect(result.ok).toBe(true);
    expect(result.rects).toHaveLength(1);
    const [x1, y1, x2, y2] = result.rects[0]!;
    expect(x1).toBeCloseTo(0.14784807, 6);
    expect(y1).toBeCloseTo(0.52530259, 6);
    expect(x2).toBeCloseTo(0.53628713, 6);
    expect(y2).toBeCloseTo(0.53762962, 6);
    // 左上原点：top < bottom 的归一化 y，框内 y1 < y2。
    expect(y1!).toBeLessThan(y2!);
  });

  it('多点 rects 逐条换算、保持顺序，并按该页实际尺寸（1000x1624）换算', () => {
    const data = {
      annotationPosition: JSON.stringify({
        pageIndex: 13,
        rects: [
          [347.438, 641.75, 847, 668],
          [81, 594.75, 847.002, 621],
          [83, 548.75, 847, 575]
        ]
      })
    };
    const position = zoteroPositionData(data);
    expect(position.rects).toHaveLength(3);
    const result = normalizeZoteroRects(position.rects, {
      width: 1000,
      height: 1624,
      rotation: 0
    });
    expect(result.ok).toBe(true);
    expect(result.rects).toHaveLength(3);
    for (const rect of result.rects) {
      expect(rect).toHaveLength(4);
      expect(rect[0]!).toBeGreaterThanOrEqual(0);
      expect(rect[0]!).toBeLessThan(rect[2]!);
      expect(rect[1]!).toBeGreaterThanOrEqual(0);
      expect(rect[1]!).toBeLessThan(rect[3]!);
      expect(rect[2]!).toBeLessThanOrEqual(1);
      expect(rect[3]!).toBeLessThanOrEqual(1);
    }
    // 多点按从上到下排列：归一化后 top（y1）依次递增。
    expect(result.rects[0]![1]!).toBeLessThan(result.rects[1]![1]!);
    expect(result.rects[1]![1]!).toBeLessThan(result.rects[2]![1]!);
  });

  it('缺失 / 无法解析 / 格式不正确的坐标都返回空 rects 并说明原因', () => {
    expect(zoteroPositionData({}).rects).toEqual([]);
    expect(zoteroPositionData({}).reason).toContain('没有记录位置');
    expect(zoteroPositionData({ annotationPosition: '{bad json' }).rects).toEqual([]);
    expect(zoteroPositionData({ annotationPosition: '{bad json' }).reason).toContain('无法解析');
    expect(
      zoteroPositionData({
        annotationPosition: JSON.stringify({ pageIndex: 0, rects: [[1, 2, 3]] })
      }).rects
    ).toEqual([]);
    // 面积为零 / NaN 的矩形换算不出有效框。
    expect(
      normalizeZoteroRects([[0, 0, 0, 0]], { width: 595, height: 842, rotation: 0 }).ok
    ).toBe(false);
    expect(
      normalizeZoteroRects([[0, 0, 10, 10]], { width: 0, height: 0, rotation: 0 }).ok
    ).toBe(false);
  });

  it('rotation ≠ 0 时不猜坐标：ok=false 并给出原因', () => {
    const result = normalizeZoteroRects([[88.011, 389.265, 319.241, 399.643]], {
      width: 595.28,
      height: 841.89,
      rotation: 90
    });
    expect(result.ok).toBe(false);
    expect(result.rects).toEqual([]);
    expect(result.reason).toContain('旋转');
  });
});

describe('Zotero 坐标导入', () => {
  it('优先按坐标生成高亮/下划线，content 保留；坏坐标回退文本定位；旋转页回退', async () => {
    const key = 'ATTCHP01';
    const documentId = await makeZoteroDocument(key);
    const rows = [
      // 坐标有效，但文本层里没有这段文字：按旧逻辑会退化成页级；现在必须用坐标。
      annotationRow({
        key: 'ANNOTP01',
        pageIndex: 0,
        rects: [[88.011, 389.265, 319.241, 399.643]],
        text: '这段文字不存在于 PDF 文本层',
        comment: '坐标批注内容'
      }),
      // 坐标无效：回退文本逐字定位（这段文字在 PDF 文本层里）。
      annotationRow({
        key: 'ANNOTP02',
        pageIndex: 0,
        rects: [[1, 2, 3]],
        text: 'Evidence sentence',
        comment: '坏坐标回退文本定位'
      }),
      // 非标准尺寸页（1000x1624）：按该页实际尺寸换算。
      annotationRow({
        key: 'ANNOTP03',
        pageIndex: 1,
        rects: [[81, 594.75, 847.002, 621]],
        text: 'Nonstandard page text',
        comment: '非标准页坐标'
      }),
      // 旋转页：坐标不可用，安全回退文本定位。
      annotationRow({
        key: 'ANNOTP04',
        pageIndex: 2,
        rects: [[100, 200, 300, 220]],
        text: 'Rotated page text',
        comment: '旋转页'
      })
    ];
    mockAttachmentAnnotations(key, rows);

    const preview = await importZoteroAnnotations(
      store,
      secrets,
      documentId,
      false,
      'http://local.example/api'
    );
    expect(preview.total).toBe(4);
    expect(preview.wouldImport).toBe(4);
    expect(preview.imported).toBe(0);
    expect(preview.positioned).toBe(2);
    expect(preview.repositioned).toBe(0);
    expect(preview.message).toContain('2 条按 Zotero 坐标定位');
    const positionedItem = preview.items.find((item) => item.zoteroKey === 'ANNOTP01');
    expect(positionedItem?.action).toBe('would-import');
    expect(positionedItem?.reason).toContain('Zotero 坐标');
    expect(store.listAnnotations(documentId)).toHaveLength(0);

    const imported = await importZoteroAnnotations(
      store,
      secrets,
      documentId,
      true,
      'http://local.example/api'
    );
    expect(imported.imported).toBe(4);
    expect(imported.positioned).toBe(2);
    // 坏坐标 / 旋转页各回退一次：命中文本或落到页级，都不能算坐标定位。
    expect(imported.located + imported.pageLevel).toBe(2);

    const annotations = store.listAnnotations(documentId);
    expect(annotations).toHaveLength(4);

    const byKey = new Map(store.annotationExternalIndex(documentId));
    const coordAnnotation = annotations.find((row) => row.id === byKey.get('ANNOTP01')!.id)!;
    expect(coordAnnotation.page).toBe(1);
    expect(coordAnnotation.style).toBe('highlight');
    expect(coordAnnotation.content).toBe('坐标批注内容');
    expect(coordAnnotation.quote).toBe('这段文字不存在于 PDF 文本层');
    const coordRects = JSON.parse(coordAnnotation.rects) as number[][];
    expect(coordRects).toHaveLength(1);
    expect(coordRects[0]![0]).toBeCloseTo(0.14784807, 6);
    expect(coordRects[0]![1]).toBeCloseTo(0.52530259, 6);
    expect(coordRects[0]![2]).toBeCloseTo(0.53628713, 6);
    expect(coordRects[0]![3]).toBeCloseTo(0.53762962, 6);

    const nonstandard = annotations.find((row) => row.id === byKey.get('ANNOTP03')!.id)!;
    const nonstandardRects = JSON.parse(nonstandard.rects) as number[][];
    expect(nonstandard.page).toBe(2);
    expect(nonstandardRects[0]![0]).toBeCloseTo(0.081, 6);
    expect(nonstandardRects[0]![1]).toBeCloseTo(0.617611, 5);
    expect(nonstandardRects[0]![2]).toBeCloseTo(0.847002, 5);
    expect(nonstandardRects[0]![3]).toBeCloseTo(0.633774, 5);

    const fallback = annotations.find((row) => row.id === byKey.get('ANNOTP02')!.id)!;
    expect(fallback.rects).not.toBe('[]');
    expect(JSON.parse(fallback.rects) as number[][]).not.toEqual([[1, 2, 3]]);
    expect(fallback.content).toBe('坏坐标回退文本定位');
    // 旋转页那条仍会写入，只是不用坐标。
    expect(byKey.has('ANNOTP04')).toBe(true);
  });

  it('旧数据只有页级位置时按坐标升级 rects/style，保留用户改过的 content/color，不新增重复批注', async () => {
    const key = 'ATTCHP02';
    const documentId = await makeZoteroDocument(key);
    const legacy = store.createAnnotation({
      documentId,
      page: 1,
      quote: '',
      content: '用户改过的批注内容',
      rects: '[]',
      color: 'green',
      style: 'page',
      externalKey: 'ANNOTUP1'
    });
    mockAttachmentAnnotations(key, [
      annotationRow({
        key: 'ANNOTUP1',
        pageIndex: 0,
        rects: [[88.011, 389.265, 319.241, 399.643]],
        text: 'Zotero 原文摘引',
        comment: 'Zotero 里的原始说明'
      })
    ]);

    const preview = await importZoteroAnnotations(
      store,
      secrets,
      documentId,
      false,
      'http://local.example/api'
    );
    expect(preview.repositioned).toBe(1);
    expect(preview.wouldImport).toBe(0);
    expect(preview.message).toContain('升级位置');
    expect(preview.items.find((item) => item.zoteroKey === 'ANNOTUP1')?.action).toBe(
      'update-position'
    );
    // 预览不写库。
    expect(store.listAnnotations(documentId)[0]!.rects).toBe('[]');
    expect(store.listAnnotations(documentId)[0]!.style).toBe('page');

    const imported = await importZoteroAnnotations(
      store,
      secrets,
      documentId,
      true,
      'http://local.example/api'
    );
    expect(imported.imported).toBe(0);
    expect(imported.repositioned).toBe(1);
    expect(imported.skippedExisting).toBe(0);
    expect(imported.message).toContain('1 条页级批注升级了位置');

    const annotations = store.listAnnotations(documentId);
    expect(annotations).toHaveLength(1);
    expect(annotations[0]!.id).toBe(legacy.id);
    expect(annotations[0]!.style).toBe('highlight');
    expect(annotations[0]!.rects).not.toBe('[]');
    const rects = JSON.parse(annotations[0]!.rects) as number[][];
    expect(rects[0]![0]).toBeCloseTo(0.14784807, 6);
    // 用户改过的内容与颜色必须保留。
    expect(annotations[0]!.content).toBe('用户改过的批注内容');
    expect(annotations[0]!.color).toBe('green');

    // 再导入一次：已经有位置，按已存在跳过，不重复升级。
    const again = await importZoteroAnnotations(
      store,
      secrets,
      documentId,
      true,
      'http://local.example/api'
    );
    expect(again.imported).toBe(0);
    expect(again.repositioned).toBe(0);
    expect(again.skippedExisting).toBe(1);
    expect(store.listAnnotations(documentId)).toHaveLength(1);
  });

  it('已有位置的批注保持 skip-existing，不会被覆盖', async () => {
    const key = 'ATTCHP03';
    const documentId = await makeZoteroDocument(key);
    store.createAnnotation({
      documentId,
      page: 1,
      quote: '原有摘引',
      content: '原有内容',
      rects: JSON.stringify([[0.1, 0.1, 0.2, 0.2]]),
      color: 'blue',
      style: 'underline',
      externalKey: 'ANNOTOK1'
    });
    mockAttachmentAnnotations(key, [
      annotationRow({
        key: 'ANNOTOK1',
        pageIndex: 0,
        rects: [[88.011, 389.265, 319.241, 399.643]],
        text: '新的摘引',
        comment: '新的说明'
      })
    ]);

    const imported = await importZoteroAnnotations(
      store,
      secrets,
      documentId,
      true,
      'http://local.example/api'
    );
    expect(imported.imported).toBe(0);
    expect(imported.repositioned).toBe(0);
    expect(imported.skippedExisting).toBe(1);
    const annotations = store.listAnnotations(documentId);
    expect(annotations).toHaveLength(1);
    expect(annotations[0]!.rects).toBe(JSON.stringify([[0.1, 0.1, 0.2, 0.2]]));
    expect(annotations[0]!.style).toBe('underline');
    expect(annotations[0]!.content).toBe('原有内容');
  });

  it('已删除的导入批注保持"已存在"语义：不升级位置、不重复导入', async () => {
    const key = 'ATTCHP04';
    const documentId = await makeZoteroDocument(key);
    const created = store.createAnnotation({
      documentId,
      page: 1,
      quote: '',
      content: '用户删掉的旧批注',
      rects: '[]',
      color: 'yellow',
      style: 'page',
      externalKey: 'ANNOTDEL1'
    });
    store.deleteAnnotation(created.id);
    // 软删除的行仍按 external_key 计入已存在。
    expect([...store.annotationExternalKeys(documentId)]).toEqual(['ANNOTDEL1']);
    mockAttachmentAnnotations(key, [
      annotationRow({
        key: 'ANNOTDEL1',
        pageIndex: 0,
        rects: [[88.011, 389.265, 319.241, 399.643]],
        text: '被删掉的摘引',
        comment: '被删掉的说明'
      })
    ]);

    const imported = await importZoteroAnnotations(
      store,
      secrets,
      documentId,
      true,
      'http://local.example/api'
    );
    expect(imported.imported).toBe(0);
    expect(imported.repositioned).toBe(0);
    expect(imported.skippedExisting).toBe(1);
    // 未复活、未重复写入。
    expect(store.listAnnotations(documentId)).toHaveLength(0);
  });
});
