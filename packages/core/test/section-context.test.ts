import { describe, expect, it } from 'vitest';
import type {
  ContentBlock,
  DocumentBlocks,
  DocumentSection,
  DocumentSectionIndex
} from '@studianda/shared';
import { locateBlockSection, locateSectionContext } from '../src/section-context.js';

/**
 * 命中片段定位的行为契约（库内检索问答用）：
 *
 * 1. 命中词在哪个块里，就取那个块所在章节的索引片段（带章节标题）；
 * 2. 跨章节、跨页的命中各取各的片段，不混；
 * 3. 命中词与页面上的块都对不上 → 返回 null（调用方退回整页原文）；
 * 4. 没有章节时退回块文字；没有块时返回 null。
 */

function block(
  id: string,
  page: number,
  kind: ContentBlock['kind'],
  text: string,
  section: number
): ContentBlock {
  return {
    id,
    page,
    kind,
    section,
    text,
    bbox: [0.05, 0.1, 0.95, 0.2],
    lines: 1
  };
}

function section(
  index: number,
  title: string,
  blockStart: number,
  blockEnd: number
): DocumentSection {
  return {
    index,
    title,
    level: 1,
    kind: 'body',
    origin: 'heading',
    pageStart: 1,
    pageEnd: 2,
    blockStart,
    blockEnd,
    parent: null
  };
}

function fixture(): { document: DocumentBlocks; index: DocumentSectionIndex } {
  const blocks: ContentBlock[] = [
    block('b0', 1, 'heading', '1 INTRODUCTION', 0),
    block('b1', 1, 'paragraph', 'This paragraph explains the value belief definition.', 0),
    block('b2', 1, 'heading', '2 METHODS', 1),
    block('b3', 1, 'paragraph', 'The sample design is described in this paragraph.', 1),
    block('b4', 2, 'paragraph', 'The conclusion revisits the value belief construct.', 1)
  ];
  const document: DocumentBlocks = {
    documentId: 'doc-1',
    sections: [section(0, '1 INTRODUCTION', 0, 1), section(1, '2 METHODS', 2, 4)],
    blocks,
    stats: {
      pages: 2,
      blocks: blocks.length,
      headings: 2,
      paragraphs: 3,
      lists: 0,
      tables: 0,
      captions: 0,
      formulas: 0,
      footnotes: 0,
      references: 0,
      sections: 2,
      basis: 'heading'
    }
  };
  const index: DocumentSectionIndex = {
    documentId: 'doc-1',
    chunks: [
      {
        id: 'doc-1:s0:0',
        documentId: 'doc-1',
        section: 0,
        sectionTitle: '1 INTRODUCTION',
        level: 1,
        page: 1,
        pageEnd: 1,
        text: '1 INTRODUCTION\nThis paragraph explains the value belief definition.',
        characters: 66
      },
      {
        id: 'doc-1:s1:0',
        documentId: 'doc-1',
        section: 1,
        sectionTitle: '2 METHODS',
        level: 1,
        page: 1,
        pageEnd: 2,
        text: '2 METHODS\nThe sample design is described in this paragraph.\nThe conclusion revisits the value belief construct.',
        characters: 110
      }
    ],
    totalCharacters: 176,
    maxChunkCharacters: 110
  };
  return { document, index };
}

describe('locateSectionContext', () => {
  it('命中段落在哪一节，就返回那一节的索引片段', () => {
    const { document, index } = fixture();
    const context = locateSectionContext(
      { documentId: 'doc-1', page: 1, match: 'value belief definition' },
      document,
      index
    );
    expect(context).not.toBeNull();
    expect(context?.sectionIndex).toBe(0);
    expect(context?.sectionTitle).toBe('1 INTRODUCTION');
    expect(context?.blockId).toBe('b1');
    expect(context?.text).toContain('This paragraph explains the value belief definition.');
    expect(context?.text.startsWith('1 INTRODUCTION')).toBe(true);
    expect(context?.page).toBe(1);
    expect(context?.pageEnd).toBe(1);
  });

  it('同一页不同章节的命中各取各的片段', () => {
    const { document, index } = fixture();
    const context = locateSectionContext(
      { documentId: 'doc-1', page: 1, match: 'The sample design is described' },
      document,
      index
    );
    expect(context?.sectionIndex).toBe(1);
    expect(context?.sectionTitle).toBe('2 METHODS');
    expect(context?.text).not.toContain('value belief definition.');
  });

  it('命中第二页时返回该页所在章节片段，pageEnd 覆盖到片段末页', () => {
    const { document, index } = fixture();
    const context = locateSectionContext(
      { documentId: 'doc-1', page: 2, match: 'value belief construct' },
      document,
      index
    );
    expect(context?.sectionIndex).toBe(1);
    expect(context?.page).toBe(2);
    expect(context?.pageEnd).toBe(2);
    expect(context?.text).toContain('conclusion revisits the value belief construct');
  });

  it('命中词与页面上的块都不重合时返回 null（调用方退回整页）', () => {
    const { document, index } = fixture();
    expect(
      locateSectionContext(
        { documentId: 'doc-1', page: 1, match: 'completely unrelated zzz token' },
        document,
        index
      )
    ).toBeNull();
  });

  it('页面上没有块时返回 null', () => {
    const { document, index } = fixture();
    expect(
      locateSectionContext(
        { documentId: 'doc-1', page: 9, match: 'value belief' },
        document,
        index
      )
    ).toBeNull();
  });

  it('没有章节时退回块文字，章节下标为 -1', () => {
    const { document } = fixture();
    const withoutSections: DocumentBlocks = {
      ...document,
      sections: [],
      blocks: document.blocks.map((item) => ({ ...item, section: -1 }))
    };
    const context = locateSectionContext(
      { documentId: 'doc-1', page: 1, match: 'value belief definition' },
      withoutSections,
      undefined
    );
    expect(context?.sectionIndex).toBe(-1);
    expect(context?.sectionTitle).toBe('');
    expect(context?.text).toBe('This paragraph explains the value belief definition.');
  });

  it('只有 heading 的页面没有可用正文块 → null', () => {
    const { document } = fixture();
    const onlyHeading: DocumentBlocks = {
      ...document,
      blocks: [document.blocks[0]!]
    };
    expect(
      locateSectionContext({ documentId: 'doc-1', page: 1, match: 'x' }, onlyHeading, undefined)
    ).toBeNull();
  });

  it('snippet 兜底：没有 match 时也能定位', () => {
    const { document, index } = fixture();
    const context = locateSectionContext(
      {
        documentId: 'doc-1',
        page: 1,
        snippet: 'The sample design is described in this paragraph.'
      },
      document,
      index
    );
    expect(context?.sectionIndex).toBe(1);
  });
});

describe('locateBlockSection（只给块/章节元数据，不取片段正文）', () => {
  it('返回命中块与所属章节', () => {
    const { document } = fixture();
    const found = locateBlockSection(
      { documentId: 'doc-1', page: 1, match: 'value belief definition' },
      document
    );
    expect(found?.block.id).toBe('b1');
    expect(found?.block.kind).toBe('paragraph');
    expect(found?.section?.title).toBe('1 INTRODUCTION');
  });

  it('没有正文块时返回 null', () => {
    const { document } = fixture();
    const onlyHeading: DocumentBlocks = { ...document, blocks: [document.blocks[0]!] };
    expect(
      locateBlockSection({ documentId: 'doc-1', page: 1, match: 'value belief' }, onlyHeading)
    ).toBeNull();
  });

  it('块没有章节时 section 为 undefined', () => {
    const { document } = fixture();
    const withoutSections: DocumentBlocks = {
      ...document,
      sections: [],
      blocks: document.blocks.map((item) => ({ ...item, section: -1 }))
    };
    const found = locateBlockSection(
      { documentId: 'doc-1', page: 1, match: 'value belief definition' },
      withoutSections
    );
    expect(found?.block.id).toBe('b1');
    expect(found?.section).toBeUndefined();
  });
});
