import { describe, expect, it } from 'vitest';
import {
  bookChapterPlan,
  chapterOutline,
  chapterOutlineFromNavigation,
  chapterTerms,
  navigationSectionPages,
  nextChapterContinuePlan,
  pickChapter,
  resolveChapterReading
} from '../src/chapters.js';
import type { StructureNode } from '../src/structure.js';
import type { Store } from '../src/store.js';
import type { ReadingPlanRecord } from '@studianda/shared';

function node(
  title: string,
  page: number,
  level: number,
  endPage: number,
  parent: number | null = null
): StructureNode {
  return { title, page, level, origin: '测试', endPage, parent };
}

function documentPlan(
  patch: Partial<ReadingPlanRecord> = {}
): ReadingPlanRecord {
  return {
    breadth: 'document',
    reason: 'test',
    origin: '规则',
    pages: [],
    queries: [],
    dimensions: [],
    ...patch
  };
}

const TREE: StructureNode[] = [
  node('第一章 社会资本', 1, 1, 20),
  node('第二章 公民参与', 21, 1, 60),
  node('第三章 结论', 61, 1, 100)
];

describe('chapterTerms', () => {
  it('中文取二字片段、英文取整词，去重并限量', () => {
    expect(chapterTerms('社会资本与 social capital 的关系')).toEqual([
      '社会',
      '会资',
      '资本',
      '本与',
      'social',
      'capital',
      '的关',
      '关系'
    ]);
  });
});

describe('chapterOutline', () => {
  it('按最浅一层目录切章；第一章从第 1 页起', () => {
    const chapters = chapterOutline(TREE, 100);
    expect(chapters.map((chapter) => [chapter.page, chapter.endPage])).toEqual([
      [1, 20],
      [21, 60],
      [61, 100]
    ]);
    expect(chapters.map((chapter) => chapter.index)).toEqual([1, 2, 3]);
    expect(chapters[0]?.title).toBe('第一章 社会资本');
  });

  it('目录第一项不在第 1 页时，把封面/前言并入第一章', () => {
    const chapters = chapterOutline(
      [node('导论', 5, 1, 29), node('正文', 30, 1, 80)],
      80
    );
    expect(chapters[0]).toMatchObject({ page: 1, endPage: 29 });
    expect(chapters[1]).toMatchObject({ page: 30, endPage: 80 });
  });

  it('忽略更深层级，只把顶层当章', () => {
    const chapters = chapterOutline(
      [
        node('第一章', 1, 1, 50),
        node('1.1 小节', 10, 2, 20),
        node('第二章', 51, 1, 100)
      ],
      100
    );
    expect(chapters).toHaveLength(2);
    expect(chapters[1]).toMatchObject({ page: 51, endPage: 100 });
  });

  it('目录不足两章或页数不足时返回空（不做章节计划）', () => {
    expect(chapterOutline([], 100)).toEqual([]);
    expect(chapterOutline([node('唯一', 1, 1, 100)], 100)).toEqual([]);
    expect(chapterOutline(TREE, 1)).toEqual([]);
  });
});

describe('pickChapter', () => {
  const chapters = chapterOutline(TREE, 100);

  it('问题术语命中章标题时选该章', () => {
    const picked = pickChapter(chapters, '社会资本这一章说了什么？', '', 1);
    expect(picked?.title).toBe('第一章 社会资本');
  });

  it('命中不足时按当前页定位所在章', () => {
    const picked = pickChapter(chapters, '主要论点是什么？', '', 55);
    expect(picked?.index).toBe(2);
  });

  it('无法定位时从第一章开始', () => {
    const picked = pickChapter(chapters, '整体论证', '', 1);
    expect(picked?.index).toBe(1);
  });
});

describe('nextChapterContinuePlan（继续阅读按章对齐）', () => {
  function fakeStore(category: string, tree: StructureNode[] = TREE): Store {
    return {
      getDocument: () => ({ id: 'doc', pages: 100, docCategory: category }),
      getStructure: async () => tree
    } as unknown as Store;
  }
  const allPages = Array.from({ length: 100 }, (_, index) => index + 1);

  it('读完第一章后继续阅读只指向第二章（只含未读页）', async () => {
    const chapterPlan = documentPlan({
      breadth: 'local',
      pages: Array.from({ length: 20 }, (_, index) => index + 1)
    });
    const next = await nextChapterContinuePlan(
      fakeStore('book'),
      'doc',
      chapterPlan,
      allPages.slice(20)
    );
    expect(next?.chapter.index).toBe(2);
    expect(next?.pages).toEqual(Array.from({ length: 40 }, (_, index) => index + 21));
    expect(next?.plan.reason).toContain('继续阅读：第 2/3 章');
  });

  it('跳过已经读完的章，指向下一张未读章', async () => {
    const chapterPlan = documentPlan({
      breadth: 'local',
      pages: Array.from({ length: 20 }, (_, index) => index + 1)
    });
    // 第二章（21–60）也已读过：只剩 61–100 未读。
    const next = await nextChapterContinuePlan(
      fakeStore('book'),
      'doc',
      chapterPlan,
      allPages.slice(60)
    );
    expect(next?.chapter.index).toBe(3);
  });

  it('上次是整篇计划（无章页）时从第一章未读页续读', async () => {
    const next = await nextChapterContinuePlan(fakeStore('book'), 'doc', documentPlan(), allPages);
    expect(next?.chapter.index).toBe(1);
    expect(next?.pages[0]).toBe(1);
  });

  it('非著作或没有目录时不改写（返回 null，保留原继续阅读）', async () => {
    expect(
      await nextChapterContinuePlan(fakeStore('paper'), 'doc', documentPlan(), allPages)
    ).toBeNull();
    expect(
      await nextChapterContinuePlan(fakeStore('book', []), 'doc', documentPlan(), allPages)
    ).toBeNull();
  });
});

describe('bookChapterPlan', () => {
  function fakeStore(category: string, tree: StructureNode[] = TREE): Store {
    return {
      getDocument: () => ({ id: 'doc', pages: 100, docCategory: category }),
      getStructure: async () => tree
    } as unknown as Store;
  }

  it('著作 + auto + 整篇计划 → 改写成按章阅读', async () => {
    const plan = await bookChapterPlan(
      fakeStore('book'),
      'doc',
      documentPlan(),
      'auto',
      1,
      '社会资本讲了什么？',
      ''
    );
    expect(plan.breadth).toBe('local');
    expect(plan.pages).toEqual(
      Array.from({ length: 20 }, (_, index) => index + 1)
    );
    expect(plan.reason).toContain('著作按章阅读');
    expect(plan.reason).toContain('第 1/3 章');
  });

  it('显式 reading_scope=document 是解锁入口，不改写', async () => {
    const plan = await bookChapterPlan(
      fakeStore('book'),
      'doc',
      documentPlan(),
      'document',
      1,
      '整本讲什么？',
      ''
    );
    expect(plan.breadth).toBe('document');
    expect(plan.reason).toBe('test');
  });

  it('论文与无目录著作保持原计划', async () => {
    const paper = await bookChapterPlan(
      fakeStore('paper'),
      'doc',
      documentPlan(),
      'auto',
      1,
      '全文讲了什么？',
      ''
    );
    expect(paper.breadth).toBe('document');
    const noToc = await bookChapterPlan(
      fakeStore('book', []),
      'doc',
      documentPlan(),
      'auto',
      1,
      '全文讲了什么？',
      ''
    );
    expect(noToc.breadth).toBe('document');
  });
});

describe('启用的本地目录参与章规划（并集/回退）', () => {
  const NAV = [
    { page: 10, label: '甲章', kind: 'section' },
    { page: 50, label: '乙章', kind: 'section' }
  ];

  function navStore(options: {
    enabled?: boolean;
    state?: 'ready' | 'stale' | 'missing';
    nav?: Array<{ page: number; label: string; kind?: string }>;
    tree?: StructureNode[];
  } = {}): Store {
    return {
      getDocument: () => ({ id: 'doc', pages: 100, docCategory: 'book' }),
      getStructure: async () => options.tree ?? TREE,
      navigationStatus: () => ({
        state: options.state ?? 'ready',
        enabled: options.enabled ?? true
      }),
      planningNavigation: () => options.nav ?? NAV
    } as unknown as Store;
  }

  it('本地目录 → 章区间：第一条之前的页并入第一章', () => {
    const chapters = chapterOutlineFromNavigation(NAV, 100);
    expect(chapters.map((chapter) => [chapter.page, chapter.endPage, chapter.title])).toEqual([
      [1, 49, '甲章'],
      [50, 100, '乙章']
    ]);
  });

  it('局部页按本地目录章节扩展（并集用）', () => {
    expect(navigationSectionPages(NAV, [12], 100)).toEqual(
      Array.from({ length: 49 }, (_, index) => index + 1)
    );
    expect(navigationSectionPages(NAV, [60], 100)).toEqual(
      Array.from({ length: 51 }, (_, index) => index + 50)
    );
    expect(navigationSectionPages([], [12], 100)).toEqual([]);
  });

  it('启用时选章优先用本地目录；未启用/过期时回退结构树', async () => {
    const enabled = await resolveChapterReading(navStore(), 'doc', documentPlan(), {
      scope: 'auto',
      page: 1,
      question: '讲讲乙章',
      selection: '',
      chapterIndex: 2
    });
    expect(enabled.chapter?.title).toBe('乙章');
    expect(enabled.plan.pages).toEqual(
      Array.from({ length: 51 }, (_, index) => index + 50)
    );

    const disabled = await resolveChapterReading(
      navStore({ enabled: false }),
      'doc',
      documentPlan(),
      { scope: 'auto', page: 1, question: '讲讲乙章', selection: '', chapterIndex: 2 }
    );
    // 回退结构树：第二章 21–60。
    expect(disabled.chapter?.title).toBe('第二章 公民参与');
    expect(disabled.plan.pages[0]).toBe(21);
    expect(disabled.plan.pages.at(-1)).toBe(60);

    const stale = await resolveChapterReading(
      navStore({ state: 'stale' }),
      'doc',
      documentPlan(),
      { scope: 'auto', page: 1, question: '讲讲乙章', selection: '', chapterIndex: 2 }
    );
    expect(stale.chapter?.title).toBe('第二章 公民参与');
  });

  it('本地目录不足 2 章时回退结构树', async () => {
    const resolved = await resolveChapterReading(
      navStore({ nav: [{ page: 10, label: '唯一章', kind: 'section' }] }),
      'doc',
      documentPlan(),
      { scope: 'auto', page: 1, question: '讲讲第二章', selection: '', chapterIndex: 2 }
    );
    expect(resolved.chapter?.title).toBe('第二章 公民参与');
  });
});
