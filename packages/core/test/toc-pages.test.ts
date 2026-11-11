import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ContentBlock, DocumentBlocks } from '@studianda/shared';
import { SecretStore } from '../src/secrets.js';
import { buildServer } from '../src/server.js';
import { Store } from '../src/store.js';
import {
  parseTocLine,
  parseTocLineEntries,
  parseTocPages,
  romanToNumber,
  tocNavigation,
  tocPageToken
} from '../src/toc-pages.js';
import type { LayoutLine, LayoutPage, PdfLayout } from '../src/pdf-layout.js';

/**
 * 「按目录页生成目录」的行为契约：
 *
 * 1. 目录页解析：`标题 ........ 页码` 行 → 标题 + 印刷页码；标题/年份等误判行要排除；
 * 2. 页码偏移：用正文标题块对齐印刷页码 → PDF 物理页码（书前有版权页时不是 1:1）；
 * 3. 没有正文块时按印刷页码原样映射；超出文献页数的条目跳过并提示；
 * 4. Store/HTTP：目录页设置持久化、预览接口、按目录页构建导航、清空设置回到标题规则。
 */

const W = 600;
const H = 800;

function line(text: string, x: number, y: number, width: number, size = 10): LayoutLine {
  return {
    text,
    bbox: [x / W, y / H, (x + width) / W, (y + size * 1.15) / H],
    size
  };
}

function page(pageNumber: number, lines: LayoutLine[]): LayoutPage {
  return { page: pageNumber, width: W, height: H, lines };
}

function headingBlock(id: string, pageNumber: number, text: string): ContentBlock {
  return {
    id,
    page: pageNumber,
    kind: 'heading',
    level: 1,
    section: -1,
    text,
    bbox: [0.05, 0.1, 0.6, 0.15],
    lines: 1
  };
}

function blocksOf(blocks: ContentBlock[]): DocumentBlocks {
  return {
    documentId: 'doc-1',
    sections: [],
    blocks,
    stats: {
      pages: 40,
      blocks: blocks.length,
      headings: blocks.length,
      paragraphs: 0,
      lists: 0,
      tables: 0,
      captions: 0,
      formulas: 0,
      footnotes: 0,
      references: 0,
      sections: 0,
      basis: 'heading'
    }
  };
}

function tocLayout(): PdfLayout {
  const pages: LayoutPage[] = [];
  for (let pageNumber = 1; pageNumber <= 40; pageNumber += 1) {
    pages.push(
      pageNumber === 3
        ? page(3, [
            line('目 录', 40, 40, 80, 14),
            line('第一章 导论 ......... 1', 40, 90, 400),
            line('第一节 研究背景 ....... 3', 60, 120, 400),
            line('第二章 方法 ......... 25', 40, 150, 400),
            line('如图 3', 40, 180, 200)
          ])
        : page(pageNumber, [])
    );
  }
  return { pages, author: '', outline: [] };
}

describe('parseTocLine', () => {
  it('解析引导点 + 页码的目录行', () => {
    expect(parseTocLine('第一章 导论 ......... 12')).toEqual({ title: '第一章 导论', page: 12 });
    expect(parseTocLine('2.1 抽样方法 ....... 45')).toEqual({ title: '2.1 抽样方法', page: 45 });
  });

  it('无引导点时只认靠右页码或编号开头的标题', () => {
    expect(parseTocLine('导论 3')).toBeNull();
    expect(parseTocLine('导论 3', { right: 0.9 })).toEqual({ title: '导论', page: 3 });
    expect(parseTocLine('第三章 结论 7')).toEqual({ title: '第三章 结论', page: 7 });
  });

  it('目录标题/无页码行/纯页码行不算条目', () => {
    expect(parseTocLine('目 录')).toBeNull();
    expect(parseTocLine('Contents')).toBeNull();
    expect(parseTocLine('12')).toBeNull();
    expect(parseTocLine('这是一行没有页码的说明文字')).toBeNull();
  });

  it('双栏目录被拼成一行时拆成多条', () => {
    const pieces = parseTocLineEntries('第一章 导论 ....... 1 第二章 方法 ....... 5');
    expect(pieces.map((piece) => piece.title)).toEqual(['第一章 导论', '第二章 方法']);
    expect(pieces.map((piece) => piece.token.value)).toEqual([1, 5]);
  });
});

describe('parseTocPages', () => {
  it('解析目录页并忽略无页码行，保留印刷页码', () => {
    const result = parseTocPages(tocLayout(), [], [3]);
    expect(result.pages).toEqual([3]);
    expect(result.entries.map((entry) => entry.title)).toEqual([
      '第一章 导论',
      '第一节 研究背景',
      '第二章 方法'
    ]);
    expect(result.entries.map((entry) => entry.printedPage)).toEqual([1, 3, 25]);
    expect(result.entries.map((entry) => entry.level)).toEqual([1, 1, 1]);
    // 「如图 3」这种没有引导点/不靠右/不编号的行被忽略，并给出如实提示。
    expect(result.warnings.join('')).toContain('没有解析出页码');
  });

  it('目录页无效时给出警告', () => {
    expect(parseTocPages(tocLayout(), [], []).warnings.length).toBeGreaterThan(0);
  });
});

/** 40 页版面，第 3 页放给定目录行；其余页空。 */
function layoutWithTocLines(tocLines: LayoutLine[]): PdfLayout {
  const pages: LayoutPage[] = [];
  for (let pageNumber = 1; pageNumber <= 40; pageNumber += 1) {
    pages.push(pageNumber === 3 ? page(3, tocLines) : page(pageNumber, []));
  }
  return { pages, author: '', outline: [] };
}

describe('折行标题 / 页码单独一行 / 双栏拼行 / 罗马数字页码', () => {
  it('标题折行、页码在第二行：拼成一条完整标题', () => {
    const result = parseTocPages(
      layoutWithTocLines([
        line('2.1 A Long Title That', 40, 100, 300),
        line('Wraps Across Two Lines ....... 45', 40, 130, 400)
      ]),
      [],
      [3]
    );
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.title).toBe('2.1 A Long Title That Wraps Across Two Lines');
    expect(result.entries[0]?.printedPage).toBe(45);
    expect(result.entries[0]?.pageKind).toBe('arabic');
  });

  it('标题一行、页码单独一行：配对成条目', () => {
    const result = parseTocPages(
      layoutWithTocLines([line('第三章 结论', 40, 100, 240), line('60', 520, 130, 40)]),
      [],
      [3]
    );
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.title).toBe('第三章 结论');
    expect(result.entries[0]?.printedPage).toBe(60);
  });

  it('罗马数字页码：保留标签，i=1、iii=3', () => {
    expect(romanToNumber('i')).toBe(1);
    expect(romanToNumber('iii')).toBe(3);
    expect(romanToNumber('xii')).toBe(12);
    expect(tocPageToken('iv')).toMatchObject({ value: 4, kind: 'roman', label: 'iv' });

    const result = parseTocPages(
      layoutWithTocLines([
        line('前言 ....... i', 40, 100, 300),
        line('致谢 ....... iii', 40, 130, 300)
      ]),
      [],
      [3]
    );
    expect(result.entries.map((entry) => entry.printedPageLabel)).toEqual(['i', 'iii']);
    expect(result.entries.map((entry) => entry.pageKind)).toEqual(['roman', 'roman']);
    expect(result.entries.map((entry) => entry.printedPage)).toEqual([1, 3]);
  });

  it('罗马页码单独估计偏移（i 对应物理第 5 页 → 偏移 4）', () => {
    const blocks = blocksOf([
      headingBlock('b0', 5, '前言'),
      headingBlock('b1', 7, '致谢')
    ]);
    const result = tocNavigation(
      layoutWithTocLines([
        line('前言 ....... i', 40, 100, 300),
        line('致谢 ....... iii', 40, 130, 300)
      ]),
      [],
      [3],
      40,
      blocks
    );
    expect(result.stats.romanEntries).toBe(2);
    expect(result.stats.romanOffset).toBe(4);
    expect(result.stats.romanOffsetConfidence).toBe(1);
    expect(result.nodes.map((node) => node.page)).toEqual([5, 7]);
  });

  it('双栏拼行：一行里的两条目录都进入条目', () => {
    const result = parseTocPages(
      layoutWithTocLines([
        line('第一章 导论 ....... 1 第二章 方法 ....... 5', 40, 100, 520)
      ]),
      [],
      [3]
    );
    expect(result.entries.map((entry) => entry.title)).toEqual(['第一章 导论', '第二章 方法']);
    expect(result.entries.map((entry) => entry.printedPage)).toEqual([1, 5]);
  });
});

describe('tocNavigation', () => {
  const blocks = blocksOf([
    headingBlock('b0', 8, '第一章 导论'),
    headingBlock('b1', 10, '第一节 研究背景'),
    headingBlock('b2', 32, '第二章 方法')
  ]);

  it('用正文标题估计印刷页码 → 物理页码的偏移', () => {
    const result = tocNavigation(tocLayout(), [], [3], 40, blocks);
    expect(result.stats.entries).toBe(3);
    expect(result.stats.offset).toBe(7);
    expect(result.stats.offsetConfidence).toBe(1);
    expect(result.nodes.map((node) => node.page)).toEqual([8, 10, 32]);
    expect(result.nodes.map((node) => node.label)).toEqual([
      '第一章 导论',
      '第一节 研究背景',
      '第二章 方法'
    ]);
    expect(result.warnings.join('')).not.toContain('没能用正文标题');
  });

  it('没有正文块时按印刷页码原样映射，并提示未对齐', () => {
    const result = tocNavigation(tocLayout(), [], [3], 40);
    expect(result.nodes.map((node) => node.page)).toEqual([1, 3, 25]);
    expect(result.stats.offset).toBe(0);
    expect(result.warnings.join('')).toContain('按目录原样给出');
  });

  it('超出文献页数的条目跳过并计数', () => {
    const result = tocNavigation(tocLayout(), [], [3], 4);
    // 印刷页 25 > 4，被跳过。
    expect(result.stats.skipped).toBeGreaterThanOrEqual(1);
    expect(result.nodes.every((node) => node.page <= 4)).toBe(true);
    expect(result.warnings.join('')).toContain('超出文献页数');
  });
});

describe('Store 与 HTTP：按目录页生成目录', () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-toc-'));
  const store = new Store(dataDir);
  const secrets = new SecretStore();
  const token = 'toc-pages-token';
  const server = buildServer({ token, version: 'test-version', store, secrets });
  let documentId = '';

  beforeAll(async () => {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    // 第 1 页：前置页（版权/序言），没有章节标题。
    const front = pdf.addPage([400, 600]);
    front.drawText('Front matter', { x: 30, y: 560, size: 12, font });
    // 第 2 页：印刷目录（页码从 1 开始，物理页差 2）。
    const toc = pdf.addPage([400, 600]);
    toc.drawText('CONTENTS', { x: 30, y: 560, size: 16, font });
    toc.drawText('1 Introduction ........ 1', { x: 30, y: 510, size: 11, font });
    toc.drawText('2 Methods ........ 5', { x: 30, y: 480, size: 11, font });
    // 第 3 页 = 印刷第 1 页；第 7 页 = 印刷第 5 页。
    const first = pdf.addPage([400, 600]);
    first.drawText('1 Introduction', { x: 30, y: 560, size: 16, font });
    first.drawText('Body of the introduction.', { x: 30, y: 520, size: 11, font });
    for (let pageNumber = 4; pageNumber <= 6; pageNumber += 1) {
      const filler = pdf.addPage([400, 600]);
      filler.drawText(`Filler page ${pageNumber}`, { x: 30, y: 560, size: 11, font });
    }
    const second = pdf.addPage([400, 600]);
    second.drawText('2 Methods', { x: 30, y: 560, size: 16, font });
    second.drawText('Body of the methods section.', { x: 30, y: 520, size: 11, font });
    const file = path.join(dataDir, 'toc-pages.pdf');
    writeFileSync(file, await pdf.save());
    const imported = await store.importDocument(file);
    documentId = imported.id;
  }, 120_000);

  afterAll(async () => {
    await server.close();
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('previewTocNavigation 解析目录页并给出页码偏移（不保存）', async () => {
    const preview = await store.previewTocNavigation(documentId, [2]);
    expect(preview.toc_pages).toEqual([2]);
    expect(preview.entries.length).toBe(2);
    expect(preview.stats.offset).toBe(2);
    expect(preview.stats.offsetConfidence).toBe(1);
    expect(preview.nodes.map((node) => node.page)).toEqual([3, 7]);
    // 预览不落设置。
    expect(store.getNavigationTocPages(documentId)).toEqual([]);
  });

  it('按目录页构建导航并持久化目录页设置；清空后回到标题规则', async () => {
    const status = await store.buildNavigation(documentId, true, { tocPages: [2] });
    expect(status.state).toBe('ready');
    expect(status.toc_pages).toEqual([2]);
    const nodes = store.listNavigation(documentId);
    expect(nodes.map((node) => node.label)).toEqual(['1 Introduction', '2 Methods']);
    expect(nodes.map((node) => node.page)).toEqual([3, 7]);

    // 目录页设置变化会让旧目录变 stale。
    store.setNavigationTocPages(documentId, [2, 3]);
    expect(store.navigationStatus(documentId).state).toBe('stale');

    const cleared = await store.buildNavigation(documentId, true, { tocPages: [] });
    expect(cleared.toc_pages).toEqual([]);
    expect(cleared.state).toBe('ready');
  });

  it('手动编辑目录保存后状态 ready/manual；改目录页设置后变 stale（可重新生成覆盖）', async () => {
    const saved = store.saveNavigation(documentId, [
      { page: 3, label: '手动条目一' },
      { page: 5, label: '手动条目二' }
    ]);
    expect(saved).toHaveLength(2);
    const status = store.navigationStatus(documentId);
    expect(status.state).toBe('ready');
    expect(status.manual).toBe(true);
    expect(store.listNavigation(documentId).map((node) => node.label)).toEqual([
      '手动条目一',
      '手动条目二'
    ]);

    // 内置目录落成本地副本：状态是「内置目录副本」，不是「手动编辑」。
    store.saveNavigation(
      documentId,
      [
        { page: 3, label: '内置一' },
        { page: 5, label: '内置二' }
      ],
      'materialized'
    );
    const materialized = store.navigationStatus(documentId);
    expect(materialized.state).toBe('ready');
    expect(materialized.materialized).toBe(true);
    expect(materialized.manual).toBe(false);

    store.setNavigationTocPages(documentId, [2, 3]);
    expect(store.navigationStatus(documentId).state).toBe('stale');
    const rebuilt = await store.buildNavigation(documentId, true, { tocPages: [] });
    expect(rebuilt.state).toBe('ready');
    expect(rebuilt.manual).toBe(false);
    expect(rebuilt.materialized).toBe(false);
  });

  it('HTTP: 目录页预览 + 按目录页生成 + 参数校验', async () => {
    const headers = { 'x-studianda-token': token };
    const preview = await server.inject({
      method: 'POST',
      url: `/api/v1/documents/${documentId}/navigation/toc-preview`,
      headers,
      payload: { toc_pages: [2] }
    });
    expect(preview.statusCode).toBe(200);
    const previewBody = preview.json() as {
      stats: { offset: number; entries: number };
      entries: Array<{ title: string; printedPage: number }>;
    };
    expect(previewBody.stats.entries).toBe(2);
    expect(previewBody.stats.offset).toBe(2);
    expect(previewBody.entries[0]?.title).toBe('1 Introduction');

    const build = await server.inject({
      method: 'POST',
      url: `/api/v1/documents/${documentId}/navigation`,
      headers,
      payload: { toc_pages: [2], rebuild: true }
    });
    expect(build.statusCode).toBe(200);
    expect((build.json() as { toc_pages: number[] }).toc_pages).toEqual([2]);
    const navigation = await server.inject({
      method: 'GET',
      url: `/api/v1/documents/${documentId}/navigation`,
      headers
    });
    expect((navigation.json() as Array<{ page: number }>).map((node) => node.page)).toEqual([3, 7]);

    const invalid = await server.inject({
      method: 'POST',
      url: `/api/v1/documents/${documentId}/navigation/toc-preview`,
      headers,
      payload: { toc_pages: ['x'] }
    });
    expect(invalid.statusCode).toBe(400);
    const empty = await server.inject({
      method: 'POST',
      url: `/api/v1/documents/${documentId}/navigation/toc-preview`,
      headers,
      payload: { toc_pages: [] }
    });
    expect(empty.statusCode).toBe(400);
  });

  it('HTTP: 启用本地目录后 /chapters 用本地目录分章（未启用时回退结构树）', async () => {
    const headers = { 'x-studianda-token': token };
    // 先按目录页构建并启用。
    await server.inject({
      method: 'POST',
      url: `/api/v1/documents/${documentId}/navigation`,
      headers,
      payload: { toc_pages: [2], rebuild: true }
    });
    await server.inject({
      method: 'PUT',
      url: `/api/v1/documents/${documentId}/navigation/enabled`,
      headers,
      payload: { enabled: true }
    });
    const enabled = await server.inject({
      method: 'GET',
      url: `/api/v1/documents/${documentId}/chapters`,
      headers
    });
    expect(enabled.statusCode).toBe(200);
    const enabledBody = enabled.json() as {
      source: string;
      chapters: Array<{ title: string; page: number; end_page: number }>;
    };
    expect(enabledBody.source).toBe('navigation');
    expect(enabledBody.chapters.map((chapter) => chapter.title)).toEqual([
      '1 Introduction',
      '2 Methods'
    ]);
    // 第一条目录项之前的前置页并入第一章。
    expect(enabledBody.chapters.map((chapter) => [chapter.page, chapter.end_page])).toEqual([
      [1, 6],
      [7, 7]
    ]);

    // 关掉后回退结构树（本 PDF 没有书签，结构树来自标题规则）。
    await server.inject({
      method: 'PUT',
      url: `/api/v1/documents/${documentId}/navigation/enabled`,
      headers,
      payload: { enabled: false }
    });
    const disabled = await server.inject({
      method: 'GET',
      url: `/api/v1/documents/${documentId}/chapters`,
      headers
    });
    expect((disabled.json() as { source: string }).source).toBe('structure');
  });
});
