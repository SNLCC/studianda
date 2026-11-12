import { describe, expect, it } from 'vitest';
import type { LayoutPage, PdfLayout } from '../src/pdf-layout.js';
import {
  documentBodySize,
  documentStructure,
  expandSections,
  heading,
  navigationNodes,
  orderPageLines,
  readingOrderLines,
  reflowLines,
  sectionTree,
  visibleLines,
  type PageMask
} from '../src/structure.js';
import { locateQuote } from '../src/citation.js';

describe('structure and citation parity helpers', () => {
  it('recognizes numbered headings and builds section ranges', () => {
    expect(heading('1 Introduction')).toMatchObject({ level: 1 });
    expect(heading('2.1 Methods')).toMatchObject({ level: 2 });
    expect(heading('I. INTRODUCTION')).toMatchObject({ level: 1 });
    expect(heading('A. System Overview')).toMatchObject({ level: 2 });
    expect(heading('2020 was a difficult year.')).toBeNull();
    expect(heading('1 Department of A, University, City, Country', 10, 10)).toBeNull();
    expect(heading('1 Introduction', 10, 10)).toMatchObject({ level: 1 });
    expect(heading('References')).toMatchObject({ level: 1 });
    expect(heading('普通正文行，不是标题。')).toBeNull();
    const tree = sectionTree(
      [
        { title: '1 Introduction', page: 1, level: 1 },
        { title: '1.1 Background', page: 2, level: 2 },
        { title: '2 Methods', page: 4, level: 1 }
      ],
      6
    );
    expect(tree[0]).toMatchObject({ page: 1, level: 1, endPage: 4, parent: null });
    expect(tree[1]).toMatchObject({ page: 2, level: 2, endPage: 4, parent: 0 });
  });

  it('keeps only the highest-level section on one page', () => {
    const layout: PdfLayout = {
      author: '',
      outline: [],
      pages: [
        {
          page: 1,
          width: 600,
          height: 800,
          lines: [
            { text: 'I. INTRODUCTION', bbox: [0.1, 0.1, 0.4, 0.12] },
            { text: 'Body text', bbox: [0.1, 0.14, 0.8, 0.16] },
            { text: 'II. RELATED WORK', bbox: [0.1, 0.4, 0.4, 0.42] },
            { text: 'More body text', bbox: [0.1, 0.44, 0.8, 0.46] }
          ]
        }
      ]
    };
    const nodes = navigationNodes(layout, []);
    expect(
      nodes.filter((node) => node.kind === 'section').map((node) => node.label)
    ).toEqual(['I. INTRODUCTION']);
  });

  it('expands a local page to its containing/nearest section without reading the whole book', () => {
    const tree = sectionTree(
      [
        { title: '1 Introduction', page: 1, level: 1 },
        { title: '1.1 Background', page: 2, level: 2 },
        { title: '2 Methods', page: 6, level: 1 }
      ],
      10
    );
    expect([...expandSections([2], tree, 10)].sort((a, b) => a - b)).toEqual([
      1, 2, 3, 4, 5, 6, 7
    ]);
    expect([...expandSections([4], tree, 10)].sort((a, b) => a - b)).toEqual([
      1, 2, 3, 4, 5, 6, 7
    ]);
    // 落在章节内：读所在节（page7 只命中 Methods）。
    expect([...expandSections([7], tree, 10)].sort((a, b) => a - b)).toEqual([
      5, 6, 7, 8, 9, 10
    ]);
    // 没有目录：无法确定边界，保守返回全篇。
    expect([...expandSections([3], [], 10)]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('reflows hard-wrapped OCR lines into paragraphs without breaking headings/figures', () => {
    expect(
      reflowLines(
        '3.1 Results\nThis is a long\nsentence split by scan\n\n下一段第一行\n第二行。\n'
      )
    ).toBe('3.1 Results\n\nThis is a long sentence split by scan\n\n下一段第一行第二行。');
    expect(reflowLines('图 1 示例\n1. 数据来源：作者整理')).toBe(
      '图 1 示例\n\n1. 数据来源：作者整理'
    );
    expect(reflowLines('inter-\nnational')).toBe('inter-national');
    expect(reflowLines('…“底线伦理”\n仍然延续这个判断。')).toBe(
      '…“底线伦理”仍然延续这个判断。'
    );
  });

  it('orders two-column lines left before right and locates a quote by line', () => {
    const page: LayoutPage = {
      page: 1,
      width: 600,
      height: 800,
      lines: [
        { text: 'Left top 1', bbox: [0.05, 0.1, 0.4, 0.13] },
        { text: 'Right top 1', bbox: [0.55, 0.1, 0.95, 0.13] },
        { text: 'Left top 2', bbox: [0.05, 0.15, 0.4, 0.18] },
        { text: 'Right top 2', bbox: [0.55, 0.15, 0.95, 0.18] },
        { text: 'Left bottom', bbox: [0.05, 0.2, 0.4, 0.23] },
        { text: 'Right bottom 1', bbox: [0.55, 0.2, 0.95, 0.23] },
        { text: 'Left final', bbox: [0.05, 0.25, 0.4, 0.28] },
        { text: 'Right bottom 2', bbox: [0.55, 0.25, 0.95, 0.28] }
      ]
    };
    expect(readingOrderLines(page).map((line) => line.text)).toEqual([
      'Left top 1',
      'Left top 2',
      'Left bottom',
      'Left final',
      'Right top 1',
      'Right top 2',
      'Right bottom 1',
      'Right bottom 2'
    ]);
    const ordered = readingOrderLines(page);
    const boxes = locateQuote(
      ordered.map((line) => line.text).join('\n'),
      'Left bottom',
      ordered
    );
    expect(boxes).toHaveLength(1);
    expect(boxes[0]?.bbox).toEqual([0.05, 0.2, 0.4, 0.23]);
    expect(locateQuote('Left top\nRight top', 'missing quote', ordered)).toEqual([]);
  });
});

describe('page masks filter normalized layout lines', () => {
  const page: LayoutPage = {
    page: 2,
    width: 1,
    height: 1,
    lines: [
      { text: '页眉噪声', bbox: [0, 0, 1, 0.08] },
      { text: '正文第一行', bbox: [0, 0.3, 1, 0.36] },
      { text: '页脚页码', bbox: [0, 0.95, 1, 0.99] }
    ]
  };

  it('drops lines intersecting a page-scoped mask and keeps the rest', () => {
    const masks: PageMask[] = [
      { id: 'm1', documentId: 'd', page: 2, scope: 'page', x0: 0, y0: 0, x1: 1, y1: 0.1 },
      { id: 'm2', documentId: 'd', page: 2, scope: 'page', x0: 0, y0: 0.9, x1: 1, y1: 1 }
    ];
    // 页号不同时规则不生效（与 OCR 行框读取口径一致）。
    expect(visibleLines(page, masks).map((line) => line.text)).toEqual(['正文第一行']);
    expect(visibleLines({ ...page, page: 3 }, masks).map((line) => line.text)).toEqual([
      '页眉噪声',
      '正文第一行',
      '页脚页码'
    ]);
  });

  it('honors all-page and excluded-page scopes', () => {
    const all: PageMask[] = [
      { id: 'm1', documentId: 'd', page: 0, scope: 'all', x0: 0, y0: 0, x1: 1, y1: 0.1 }
    ];
    expect(visibleLines(page, all).map((line) => line.text)).toEqual([
      '正文第一行',
      '页脚页码'
    ]);
    const excluded: PageMask[] = [
      {
        id: 'm2',
        documentId: 'd',
        page: 0,
        scope: 'exclude',
        excludePages: [2],
        x0: 0,
        y0: 0,
        x1: 1,
        y1: 1
      }
    ];
    expect(visibleLines(page, excluded)).toHaveLength(3);
    expect(visibleLines({ ...page, page: 1 }, excluded)).toHaveLength(0);
  });
});

describe('unified reading order (two columns + cross-column title)', () => {
  const twoColumnPage = (titleY?: number): LayoutPage => {
    const left = [0.2, 0.25, 0.3, 0.35].map((y, index) => ({
      text: `L${index + 1}`,
      bbox: [0.05, y, 0.4, y + 0.02] as [number, number, number, number]
    }));
    const right = [0.2, 0.25, 0.3, 0.35].map((y, index) => ({
      text: `R${index + 1}`,
      bbox: [0.55, y, 0.95, y + 0.02] as [number, number, number, number]
    }));
    const lines = [...left, ...right];
    if (titleY != null) {
      lines.unshift({
        text: 'Cross column title',
        bbox: [0.1, titleY, 0.9, titleY + 0.04]
      });
    }
    return { page: 1, width: 600, height: 800, lines };
  };

  it('orders a two-column page: whole left column first, then the right column', () => {
    expect(readingOrderLines(twoColumnPage()).map((line) => line.text)).toEqual([
      'L1',
      'L2',
      'L3',
      'L4',
      'R1',
      'R2',
      'R3',
      'R4'
    ]);
  });

  it('emits a full-width cross-column title before the columns', () => {
    const ordered = readingOrderLines(twoColumnPage(0.02));
    expect(ordered.map((line) => line.text)).toEqual([
      'Cross column title',
      'L1',
      'L2',
      'L3',
      'L4',
      'R1',
      'R2',
      'R3',
      'R4'
    ]);
  });

  it('keeps right-column text above a mid-page title before the title', () => {
    const page: LayoutPage = {
      page: 1,
      width: 600,
      height: 800,
      lines: [
        { text: 'L1', bbox: [0.05, 0.1, 0.4, 0.12] },
        { text: 'R1', bbox: [0.55, 0.1, 0.95, 0.12] },
        { text: 'L2', bbox: [0.05, 0.15, 0.4, 0.17] },
        { text: 'R2', bbox: [0.55, 0.15, 0.95, 0.17] },
        { text: 'Mid title', bbox: [0.1, 0.4, 0.9, 0.44] },
        { text: 'L3', bbox: [0.05, 0.6, 0.4, 0.62] },
        { text: 'R3', bbox: [0.55, 0.6, 0.95, 0.62] },
        { text: 'L4', bbox: [0.05, 0.65, 0.4, 0.67] },
        { text: 'R4', bbox: [0.55, 0.65, 0.95, 0.67] }
      ]
    };
    expect(readingOrderLines(page).map((line) => line.text)).toEqual([
      'L1',
      'L2',
      'R1',
      'R2',
      'Mid title',
      'L3',
      'L4',
      'R3',
      'R4'
    ]);
  });

  it('falls back to y,x order for single-column pages and invalid page width', () => {
    const lines = [
      { text: 'later', bbox: [0.1, 0.4, 0.9, 0.42] as [number, number, number, number] },
      { text: 'first', bbox: [0.1, 0.1, 0.9, 0.12] as [number, number, number, number] }
    ];
    expect(orderPageLines(lines).map((line) => line.text)).toEqual(['first', 'later']);
    expect(orderPageLines(lines, 0).map((line) => line.text)).toEqual(['first', 'later']);
    expect(
      readingOrderLines({ page: 1, width: 600, height: 800, lines }).map((line) => line.text)
    ).toEqual(['first', 'later']);
  });
});

describe('标题规则：中文编号与全篇字号基准', () => {
  it('识别中文章节编号（第一章/一、/（一）/1、/1．）与章节词', () => {
    expect(heading('第一章 绪论')).toMatchObject({ level: 1 });
    expect(heading('第二节 数据来源')).toMatchObject({ level: 2 });
    expect(heading('一、导言')).toMatchObject({ level: 2 });
    expect(heading('（一）研究背景')).toMatchObject({ level: 3 });
    expect(heading('(二) 数据与方法')).toMatchObject({ level: 3 });
    expect(heading('1、引言')).toMatchObject({ level: 1 });
    expect(heading('1．绪论')).toMatchObject({ level: 1 });
    expect(heading('1 引言', 10, 10)).toMatchObject({ level: 1 });
    expect(heading('2.1 研究方法')).toMatchObject({ level: 2 });
    expect(heading('摘要')).toMatchObject({ level: 1 });
    expect(heading('参考文献')).toMatchObject({ level: 1 });
    expect(heading('致谢')).toMatchObject({ level: 1 });
    expect(heading('本文认为这是普通正文。')).toBeNull();
  });

  it('排除作者单位、文献条目与正文长句', () => {
    expect(heading('1 北京大学计算机学院，北京 100871', 10, 10)).toBeNull();
    expect(heading('[1] Smith, J. (2020). Alpha study. Journal A.', 9, 10)).toBeNull();
    expect(
      heading('1 This is a whole body sentence that was hard wrapped by the layout engine', 10, 10)
    ).toBeNull();
  });

  it('用全篇正文字号中位数，而不是封面单页的大字号', () => {
    const layout: PdfLayout = {
      author: '',
      outline: [],
      pages: [
        {
          page: 1,
          width: 600,
          height: 800,
          lines: [
            { text: '封面大标题', bbox: [0.2, 0.1, 0.8, 0.16], size: 28 },
            { text: '作者：张三', bbox: [0.3, 0.2, 0.7, 0.24], size: 12 }
          ]
        },
        {
          page: 2,
          width: 600,
          height: 800,
          lines: [
            { text: '第一章 绪论', bbox: [0.1, 0.08, 0.4, 0.11], size: 14 },
            { text: '正文第一行要足够长，才能作为正文字号样本。', bbox: [0.1, 0.15, 0.9, 0.17], size: 10 },
            { text: '正文第二行同样比较长，继续提供正文字号样本。', bbox: [0.1, 0.19, 0.9, 0.21], size: 10 },
            { text: '正文第三行仍然比较长，避免中位数被标题带偏。', bbox: [0.1, 0.23, 0.9, 0.25], size: 10 },
            { text: '正文第四行用来凑够正文字号样本的数量。', bbox: [0.1, 0.27, 0.9, 0.29], size: 10 },
            { text: '正文第五行同样是十号字的正文内容。', bbox: [0.1, 0.31, 0.9, 0.33], size: 10 }
          ]
        }
      ]
    };
    expect(documentBodySize(layout)).toBe(10);
    expect(documentStructure(layout, []).map((node) => node.title)).toEqual([
      '封面大标题',
      '第一章 绪论'
    ]);
  });

  it('跨页重复的页眉文字不进入章节标题', () => {
    const header = '某某大学博士学位论文';
    const body = '正文内容放在页面中部，用来提供正文字号样本。';
    const makePages = (count: number): PdfLayout['pages'] =>
      [1, 2, 3, 4].slice(0, count).map((page) => ({
        page,
        width: 600,
        height: 800,
        lines: [
          { text: header, bbox: [0.3, 0.02, 0.7, 0.05], size: 14 },
          { text: body, bbox: [0.1, 0.3, 0.9, 0.33], size: 10 },
          { text: `${body}（续）`, bbox: [0.1, 0.35, 0.9, 0.38], size: 10 },
          { text: `${body}（再续）`, bbox: [0.1, 0.4, 0.9, 0.43], size: 10 }
        ]
      }));
    expect(documentStructure({ pages: makePages(4), author: '', outline: [] }, [])).toEqual([]);
    // 2 页短文里的重复页眉同样要排除（旧阈值 3 在 2 页文档上永远达不到）。
    expect(documentStructure({ pages: makePages(2), author: '', outline: [] }, [])).toEqual([]);
  });
});
