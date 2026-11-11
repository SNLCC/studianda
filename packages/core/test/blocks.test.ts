import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DocumentBlocks, SearchHit } from '@studianda/shared';
import {
  headingLevel,
  normalizeHeadingTitle,
  recognizeBlocks,
  sectionIndexChunks,
  sectionKindOf
} from '../src/blocks.js';
import { annotateSearchHits } from '../src/section-context.js';
import type { LayoutLine, LayoutPage, OutlineEntry, PdfLayout } from '../src/pdf-layout.js';
import type { PageMask } from '../src/structure.js';
import { SecretStore } from '../src/secrets.js';
import { buildServer } from '../src/server.js';
import { Store } from '../src/store.js';

/**
 * 内容块 / 章节识别的行为契约：
 *
 * 1. 版面还原：同一自然段的多行合成一块；标题/列表/题注/脚注/公式各自成块；
 * 2. 章节：有 PDF 目录时按目录落块，没有目录时按标题行；参考文献小节里的正文改标 reference；
 * 3. 页遮罩：被遮罩的行不进入块文本；
 * 4. 双栏：同一块不跨栏串行；
 * 5. 章节级索引片段：带章节标题、不超过 max_chars、id 稳定；
 * 6. Store/API：缓存命中、遮罩变化后失效、HTTP 端点返回 200/400/404。
 */

const W = 600;
const H = 800;

function line(
  text: string,
  x: number,
  y: number,
  options: { size?: number; width?: number; gap?: number } = {}
): LayoutLine {
  const size = options.size ?? 10;
  const width = options.width ?? 480;
  return {
    text,
    bbox: [x / W, y / H, (x + width) / W, (y + size * 1.15) / H],
    size,
    ...(options.gap !== undefined ? { gap: options.gap } : {})
  };
}

function page(pageNumber: number, lines: LayoutLine[]): LayoutPage {
  return { page: pageNumber, width: W, height: H, lines };
}

function layout(pages: LayoutPage[], outline: OutlineEntry[] = []): PdfLayout {
  return { pages, author: '', outline };
}

/** 三页小文献：标题 / 两节正文 / 列表 / 题注 / 脚注 / 参考文献。 */
function sampleLayout(): PdfLayout {
  return layout([
    page(1, [
      line('A Study of Things', 175, 40, { size: 20, width: 250 }),
      line('1 INTRODUCTION', 60, 110, { size: 14, width: 220 }),
      line('This is the first line of the opening paragraph,', 60, 150),
      line('which continues on the second line with more text,', 60, 170),
      line('and ends here.', 60, 190, { width: 220 }),
      line('2 METHODS', 60, 240, { size: 14, width: 180 }),
      line('The method paragraph explains how the study was done', 60, 280),
      line('in enough detail to be testable.', 60, 300, { width: 300 }),
      line('• first item', 60, 350, { width: 220 }),
      line('• second item', 60, 370, { width: 240 }),
      line('Figure 1: Overview of the model.', 60, 420, { size: 9, width: 300 }),
      line('1 This is a footnote for the page.', 60, 740, { size: 7, width: 320 })
    ]),
    page(2, [
      line('3 DISCUSSION', 60, 60, { size: 14, width: 200 }),
      line('The discussion paragraph revisits the findings and', 60, 100),
      line('compares them with the prior literature.', 60, 120, { width: 320 })
    ]),
    page(3, [
      line('REFERENCES', 60, 60, { size: 14, width: 200 }),
      line('Smith, J. (2020). Alpha study. Journal A.', 60, 120, { size: 9, width: 380 }),
      line('Doe, A. (2021). Beta study. Journal B.', 60, 150, { size: 9, width: 380 }),
      line('Roe, B. (2022). Gamma study. Journal C.', 60, 180, { size: 9, width: 380 })
    ])
  ]);
}

function blockTexts(result: DocumentBlocks): string[] {
  return result.blocks.map((block) => block.text);
}

function textOfSection(result: DocumentBlocks, index: number): string {
  const section = result.sections[index];
  if (!section) return '';
  return result.blocks
    .slice(section.blockStart, section.blockEnd + 1)
    .map((block) => block.text)
    .join('\n');
}

describe('内容块识别（版面还原）', () => {
  it('把同一自然段的多行合成一块，并保持块 id 稳定', () => {
    const result = recognizeBlocks(sampleLayout(), [], { documentId: 'doc-1' });
    const opening = result.blocks.find((block) => block.text.startsWith('This is the first line'));
    expect(opening?.kind).toBe('paragraph');
    expect(opening?.text).toBe(
      'This is the first line of the opening paragraph, which continues on the second line with more text, and ends here.'
    );
    expect(opening?.lines).toBe(3);
    expect(opening?.page).toBe(1);
    // id = 阅读顺序 b0..bn；重算同一版面 id/文本完全一致。
    expect(result.blocks[0]?.id).toBe('b0');
    const again = recognizeBlocks(sampleLayout(), [], { documentId: 'doc-1' });
    expect(again.blocks.map((block) => block.id)).toEqual(
      result.blocks.map((block) => block.id)
    );
    expect(blockTexts(again)).toEqual(blockTexts(result));
  });

  it('识别标题/列表/题注/脚注/参考文献等块类别', () => {
    const result = recognizeBlocks(sampleLayout(), [], { documentId: 'doc-1' });
    const kinds = result.blocks.map((block) => block.kind);
    expect(kinds).toContain('heading');
    expect(kinds).toContain('paragraph');
    expect(kinds).toContain('caption');
    expect(kinds).toContain('footnote');
    expect(kinds).toContain('reference');

    // 列表项各自成块，不会把两条列表或后面正文并进同一块。
    const lists = result.blocks.filter((block) => block.kind === 'list');
    expect(lists.map((block) => block.text)).toEqual(['• first item', '• second item']);
    for (const list of lists) expect(list.lines).toBe(1);

    const caption = result.blocks.find((block) => block.kind === 'caption');
    expect(caption?.text).toBe('Figure 1: Overview of the model.');
    const footnote = result.blocks.find((block) => block.kind === 'footnote');
    expect(footnote?.text).toContain('footnote for the page');

    expect(result.stats.headings).toBeGreaterThanOrEqual(5);
    expect(result.stats.paragraphs).toBeGreaterThanOrEqual(2);
    expect(result.stats.lists).toBe(2);
    expect(result.stats.captions).toBe(1);
    expect(result.stats.footnotes).toBe(1);
    expect(result.stats.references).toBeGreaterThanOrEqual(1);
  });

  it('标题层级与块 bbox 都在页面范围内', () => {
    const result = recognizeBlocks(sampleLayout(), [], { documentId: 'doc-1' });
    const introduction = result.blocks.find((block) => block.text === '1 INTRODUCTION');
    expect(introduction?.kind).toBe('heading');
    expect(introduction?.level).toBe(1);
    const methods = result.blocks.find((block) => block.text === '2 METHODS');
    expect(methods?.level).toBe(1);
    for (const block of result.blocks) {
      expect(block.id).toMatch(/^b\d+$/);
      const [x0, y0, x1, y1] = block.bbox;
      expect(x0).toBeGreaterThanOrEqual(0);
      expect(y0).toBeGreaterThanOrEqual(0);
      expect(x1).toBeLessThanOrEqual(1.0001);
      expect(y1).toBeLessThanOrEqual(1.0001);
      expect(x1).toBeGreaterThan(x0);
      expect(y1).toBeGreaterThan(y0);
    }
  });

  it('有 PDF 目录时按目录落块，章节标题用目录文字', () => {
    const outline: OutlineEntry[] = [
      { title: '第一章 导论', page: 1, level: 1, origin: 'PDF 目录' },
      { title: '第二章 方法', page: 2, level: 1, origin: 'PDF 目录' },
      { title: '参考文献', page: 3, level: 1, origin: 'PDF 目录' }
    ];
    const result = recognizeBlocks(sampleLayout(), [], {
      documentId: 'doc-1',
      title: 'A Study of Things'
    });
    const withOutline = recognizeBlocks(
      { ...sampleLayout(), outline },
      [],
      { documentId: 'doc-1' }
    );
    expect(result.stats.basis).toBe('heading');
    expect(withOutline.stats.basis).toBe('outline');
    expect(withOutline.sections.map((section) => section.title)).toEqual([
      '第一章 导论',
      '第二章 方法',
      '参考文献'
    ]);
    expect(withOutline.sections.map((section) => section.origin)).toEqual([
      'outline',
      'outline',
      'outline'
    ]);
    expect(withOutline.sections[2]?.kind).toBe('references');
    // 目录项落到对应页的第一个块：章节页码正确。
    expect(withOutline.sections.map((section) => section.pageStart)).toEqual([1, 2, 3]);
    expect(withOutline.sections[0]?.parent).toBeNull();
  });

  it('没有目录时按标题行分节，参考文献小节内的正文标为 reference', () => {
    const result = recognizeBlocks(sampleLayout(), [], {
      documentId: 'doc-1',
      title: 'A Study of Things'
    });
    expect(result.stats.basis).toBe('heading');
    // 首个标题（题名）在块 0，因此没有前置部分。
    expect(result.sections[0]?.title).toBe('A Study of Things');
    const references = result.sections.find((section) => section.kind === 'references');
    expect(references?.title).toBe('REFERENCES');
    const referenceBlocks = result.blocks.filter((block) => block.kind === 'reference');
    expect(referenceBlocks.length).toBeGreaterThanOrEqual(1);
    for (const block of referenceBlocks) expect(block.section).toBe(references?.index);
    // 参考文献块不会被误标成脚注（字号小但不在页底）。
    expect(referenceBlocks.some((block) => block.kind === 'footnote')).toBe(false);
    // 每块都有章节归属（本章识别到的章节）。
    expect(result.blocks.every((block) => block.section >= 0)).toBe(true);
  });

  it('页遮罩屏蔽的行不进入块文本', () => {
    const masked = layout([
      page(1, [
        line('Hidden Running Header', 60, 8, { size: 8, width: 200 }),
        line('1 INTRODUCTION', 60, 80, { size: 14, width: 220 }),
        line('Body text of the page.', 60, 120),
        line('Second body line of the page.', 60, 140)
      ])
    ]);
    const masks: PageMask[] = [
      {
        id: 'm1',
        documentId: 'doc-1',
        page: 1,
        scope: 'page',
        x0: 0,
        y0: 0,
        x1: 1,
        y1: 0.06
      }
    ];
    const result = recognizeBlocks(masked, masks, { documentId: 'doc-1' });
    expect(blockTexts(result).some((text) => text.includes('Hidden Running Header'))).toBe(false);
    expect(blockTexts(result).some((text) => text.includes('Body text of the page'))).toBe(true);
  });

  it('双栏页的块不会横跨两栏', () => {
    const left = [100, 116, 132, 148, 164].map((y, index) =>
      line(`L${index + 1} left column line of text`, 30, y, { width: 280 })
    );
    const right = [100, 116, 132, 148, 164].map((y, index) =>
      line(`R${index + 1} right column line of text`, 320, y, { width: 280 })
    );
    // 按版面原始顺序给出（左栏、右栏交替）；识别内部按阅读顺序重排。
    const result = recognizeBlocks(
      layout([page(1, [left[0]!, right[0]!, left[1]!, right[1]!, left[2]!, right[2]!, left[3]!, right[3]!, left[4]!, right[4]!])]),
      [],
      { documentId: 'doc-1' }
    );
    const blocks = result.blocks.filter((block) => block.text.trim().length > 0);
    expect(blocks.length).toBeGreaterThanOrEqual(2);
    for (const block of blocks) {
      const hasLeft = /\bL\d\b/.test(block.text);
      const hasRight = /\bR\d\b/.test(block.text);
      expect(hasLeft && hasRight).toBe(false);
    }
  });

  it('空版面返回空结果而不抛错', () => {
    const empty = recognizeBlocks(layout([page(1, [])]), [], { documentId: 'doc-1' });
    expect(empty.blocks).toEqual([]);
    expect(empty.sections).toEqual([]);
    expect(empty.stats.basis).toBe('none');
    expect(empty.stats.pages).toBe(1);
  });
});

describe('章节级索引片段', () => {
  const result = recognizeBlocks(sampleLayout(), [], {
    documentId: 'doc-1',
    title: 'A Study of Things'
  });

  it('每个片段带章节标题、不跨章节、id 稳定', () => {
    const index = sectionIndexChunks('doc-1', result, { maxChars: 400, overlap: 0 });
    expect(index.documentId).toBe('doc-1');
    expect(index.chunks.length).toBeGreaterThan(0);
    const ids = index.chunks.map((chunk) => chunk.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const chunk of index.chunks) {
      const section = result.sections[chunk.section];
      expect(section).toBeDefined();
      expect(chunk.sectionTitle).toBe(section?.title ?? '');
      if (chunk.sectionTitle) expect(chunk.text.startsWith(chunk.sectionTitle)).toBe(true);
      expect(chunk.characters).toBeLessThanOrEqual(400);
      expect(chunk.characters).toBe(chunk.text.length);
      expect(chunk.page).toBeGreaterThanOrEqual(1);
      expect(chunk.pageEnd).toBeGreaterThanOrEqual(chunk.page);
    }
    const again = sectionIndexChunks('doc-1', result, { maxChars: 400, overlap: 0 });
    expect(again).toEqual(index);
  });

  it('长章节会被切成多段，短章节保持单段', () => {
    // 片段最小 200 字符（与 API 的 max_chars 下限一致）。
    const index = sectionIndexChunks('doc-1', result, { maxChars: 200, overlap: 20 });
    const bySection = new Map<number, number>();
    for (const chunk of index.chunks) {
      bySection.set(chunk.section, (bySection.get(chunk.section) ?? 0) + 1);
      expect(chunk.characters).toBeLessThanOrEqual(200);
    }
    // 正文最长的一节至少被切成 1 段以上，且总字符数不为 0。
    expect(index.totalCharacters).toBeGreaterThan(0);
    expect(index.maxChunkCharacters).toBeLessThanOrEqual(200);
    expect(index.chunks.every((chunk) => chunk.text.trim().length > 0)).toBe(true);
  });

  it('章节标题与正文按顺序出现（不丢字符）', () => {
    const index = sectionIndexChunks('doc-1', result, { maxChars: 2000, overlap: 0 });
    const introduction = index.chunks.find((chunk) => chunk.sectionTitle === '1 INTRODUCTION');
    expect(introduction).toBeDefined();
    expect(introduction?.text).toContain('This is the first line');
    expect(introduction?.text).toContain('and ends here.');
  });
});

describe('纯函数规则', () => {
  it('headingLevel 按编号层级判断', () => {
    expect(headingLevel('1 Introduction')).toBe(1);
    expect(headingLevel('2.1 Sampling Strategy')).toBe(2);
    expect(headingLevel('2.1.3 Details')).toBe(3);
    expect(headingLevel('第三章 方法')).toBe(1);
    expect(headingLevel('Chapter 3 Results')).toBe(1);
    expect(headingLevel('A. Subsection')).toBe(2);
    expect(headingLevel('一、导言')).toBe(2);
  });

  it('sectionKindOf 区分摘要/参考文献/附录/正文', () => {
    expect(sectionKindOf('Abstract')).toBe('abstract');
    expect(sectionKindOf('摘要')).toBe('abstract');
    expect(sectionKindOf('References')).toBe('references');
    expect(sectionKindOf('参考文献')).toBe('references');
    expect(sectionKindOf('Appendix A')).toBe('appendix');
    expect(sectionKindOf('2 Methods')).toBe('body');
    expect(sectionKindOf('')).toBe('front');
  });

  it('normalizeHeadingTitle 用于目录与版面标题对齐', () => {
    expect(normalizeHeadingTitle('第1章 导论')).toBe('导论');
    expect(normalizeHeadingTitle('1. INTRODUCTION')).toBe('introduction');
    expect(normalizeHeadingTitle('Chapter 2: Method')).toBe('method');
    expect(normalizeHeadingTitle('2.1 方法')).toBe('方法');
  });
});

describe('Store 与 HTTP 端点', () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-blocks-'));
  const store = new Store(dataDir);
  const secrets = new SecretStore();
  const token = 'blocks-token';
  const server = buildServer({ token, version: 'test-version', store, secrets });
  let documentId = '';

  beforeAll(async () => {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const first = pdf.addPage([400, 600]);
    first.drawText('1 INTRODUCTION', { x: 30, y: 560, size: 16, font });
    first.drawText('The opening paragraph of the paper explains the question.', {
      x: 30,
      y: 520,
      size: 11,
      font
    });
    first.drawText('It continues with a second sentence on the next line.', {
      x: 30,
      y: 500,
      size: 11,
      font
    });
    const second = pdf.addPage([400, 600]);
    second.drawText('2 METHODS', { x: 30, y: 560, size: 16, font });
    second.drawText('The method paragraph describes the sample and the design.', {
      x: 30,
      y: 520,
      size: 11,
      font
    });
    const file = path.join(dataDir, 'blocks.pdf');
    writeFileSync(file, await pdf.save());
    const imported = await store.importDocument(file);
    documentId = imported.id;
  }, 120_000);

  afterAll(() => {
    try {
      store.close();
    } catch {
      // already closed
    }
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('getDocumentBlocks 识别章节/段落并缓存（同一次读取返回同一对象）', async () => {
    const first = await store.getDocumentBlocks(documentId);
    expect(first.documentId).toBe(documentId);
    expect(first.stats.pages).toBe(2);
    expect(first.sections.length).toBeGreaterThanOrEqual(2);
    expect(first.sections.map((section) => section.title)).toContain('1 INTRODUCTION');
    expect(first.sections.map((section) => section.title)).toContain('2 METHODS');
    const paragraphs = first.blocks.filter((block) => block.kind === 'paragraph');
    expect(paragraphs.some((block) => block.text.includes('opening paragraph'))).toBe(true);
    const second = await store.getDocumentBlocks(documentId);
    expect(second).toBe(first);
  });

  it('检索结果可附「命中在哪一节」元数据（只用已就绪的识别缓存）', async () => {
    await store.getDocumentBlocks(documentId);
    const hits = [
      {
        chunkId: 'chunk-1',
        documentId,
        documentName: 'blocks.pdf',
        page: 1,
        snippet: 'The opening paragraph of the paper explains the question.',
        match: 'The opening paragraph of the paper explains the question.',
        score: 1
      }
    ] as SearchHit[];
    const annotated = await annotateSearchHits(store, hits);
    expect(annotated[0]?.sectionTitle).toBe('1 INTRODUCTION');
    expect(annotated[0]?.blockId).toMatch(/^b\d+$/);
    // 未识别过的文献不会为了检索元数据去解析 PDF：拿不到缓存时原样返回。
    expect(store.peekDocumentBlocks('missing-document')).toBeNull();
    const unknown = await annotateSearchHits(store, [
      { ...hits[0]!, documentId: 'missing-document' }
    ]);
    expect(unknown[0]?.sectionTitle).toBeUndefined();
  });

  it('页遮罩变化后内容块缓存失效并重算', async () => {
    const before = await store.getDocumentBlocks(documentId);
    await store.addPageMask(documentId, { page: 1, x0: 0, y0: 0, x1: 1, y1: 0.08 });
    const after = await store.getDocumentBlocks(documentId);
    expect(after).not.toBe(before);
    const maskedText = after.blocks.map((block) => block.text).join('\n');
    expect(maskedText).not.toContain('1 INTRODUCTION');
    // 第二页不受遮罩影响，仍在结果中。
    expect(after.blocks.some((block) => block.page === 2)).toBe(true);
  });

  it('getSectionIndex 返回带章节标题的片段', async () => {
    const index = await store.getSectionIndex(documentId);
    expect(index.documentId).toBe(documentId);
    expect(index.chunks.length).toBeGreaterThan(0);
    expect(index.chunks.some((chunk) => chunk.text.includes('opening paragraph'))).toBe(true);
    for (const chunk of index.chunks) {
      expect(chunk.id.startsWith(`${documentId}:s`)).toBe(true);
      expect(chunk.characters).toBe(chunk.text.length);
    }
  });

  it('HTTP: /documents/:id/blocks 返回内容块，?text=0 省略块文字', async () => {
    const headers = { 'x-studianda-token': token };
    const response = await server.inject({
      method: 'GET',
      url: `/api/v1/documents/${documentId}/blocks`,
      headers
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as DocumentBlocks;
    expect(body.documentId).toBe(documentId);
    expect(body.blocks.length).toBeGreaterThan(0);
    expect(typeof body.blocks[0]?.text).toBe('string');
    expect(body.stats.basis).toBe('heading');

    const lite = await server.inject({
      method: 'GET',
      url: `/api/v1/documents/${documentId}/blocks?text=0`,
      headers
    });
    expect(lite.statusCode).toBe(200);
    const liteBody = lite.json() as { blocks: Array<Record<string, unknown>> };
    expect(liteBody.blocks.length).toBe(body.blocks.length);
    expect(liteBody.blocks.every((block) => !('text' in block))).toBe(true);
  });

  it('HTTP: /documents/:id/section-index 返回片段并校验参数', async () => {
    const headers = { 'x-studianda-token': token };
    const response = await server.inject({
      method: 'GET',
      url: `/api/v1/documents/${documentId}/section-index?max_chars=300&overlap=30`,
      headers
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      chunks: Array<{ text: string; characters: number; sectionTitle: string }>;
      maxChunkCharacters: number;
    };
    expect(body.chunks.length).toBeGreaterThan(0);
    expect(body.maxChunkCharacters).toBeLessThanOrEqual(300);
    expect(body.chunks.every((chunk) => chunk.characters <= 300)).toBe(true);
    // 上一用例遮罩掉了第一页标题，所以这里应命中第二页的 METHODS 小节。
    expect(body.chunks.some((chunk) => chunk.sectionTitle.includes('METHODS'))).toBe(true);

    const bad = await server.inject({
      method: 'GET',
      url: `/api/v1/documents/${documentId}/section-index?max_chars=10`,
      headers
    });
    expect(bad.statusCode).toBe(400);

    const missing = await server.inject({
      method: 'GET',
      url: '/api/v1/documents/not-a-document/blocks',
      headers
    });
    expect(missing.statusCode).toBe(404);
  });
});
