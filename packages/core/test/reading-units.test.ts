import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type {
  ContentBlock,
  ContentBlockKind,
  DocumentBlocks,
  DocumentSection
} from '@studianda/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { checkIntegrity, decompose, pack } from '../src/reading-units.js';
import { planReadingWithStructure } from '../src/reading-plan.js';
import { Store } from '../src/store.js';

/** 测试口径：1 字符 = 1 单位，便于把预算写成可读的字符数。 */
const charCost = (text: string): number => text.length;

function makeBlock(index: number, page: number, text: string, kind: ContentBlockKind = 'paragraph'): ContentBlock {
  return {
    id: `b${index}`,
    page,
    kind,
    section: -1,
    text,
    bbox: [0.1, 0.1, 0.9, 0.12],
    lines: 1
  };
}

function makeSection(
  index: number,
  blockStart: number,
  blockEnd: number,
  title: string,
  parent: number | null,
  kind: 'body' | 'front' | 'references' = 'body'
): DocumentSection {
  return {
    index,
    title,
    level: parent === null ? 1 : 2,
    kind,
    origin: 'heading',
    pageStart: 1,
    pageEnd: 1,
    blockStart,
    blockEnd,
    parent
  };
}

/** 生成 blocks + sections，并回填每个块的 section 字段（与真实解析结果一致）。 */
function makeDoc(
  spec: Array<{ section: DocumentSection; blocks: string[] }>
): DocumentBlocks {
  const blocks: ContentBlock[] = [];
  const sections: DocumentSection[] = [];
  for (const entry of spec) {
    const start = blocks.length;
    entry.blocks.forEach((text) => blocks.push(makeBlock(blocks.length, 1, text)));
    const end = blocks.length - 1;
    for (let index = start; index <= end; index += 1) blocks[index]!.section = entry.section.index;
    sections.push({ ...entry.section, blockStart: start, blockEnd: end });
  }
  return {
    documentId: 'doc',
    blocks,
    sections,
    stats: {
      pages: 1,
      blocks: blocks.length,
      headings: 0,
      paragraphs: blocks.length,
      lists: 0,
      tables: 0,
      captions: 0,
      formulas: 0,
      footnotes: 0,
      references: 0,
      sections: sections.length
    }
  } as DocumentBlocks;
}

describe('checkIntegrity', () => {
  it('连续、自洽的 body 节通过', () => {
    const doc = makeDoc([
      { section: makeSection(0, 0, 0, '一', null), blocks: ['aa', 'bb'] },
      { section: makeSection(1, 0, 0, '二', null), blocks: ['cc', 'dd', 'ee'] }
    ]);
    expect(checkIntegrity(doc.blocks, doc.sections)).toEqual({ ok: true, issues: [] });
  });

  it('报出空洞、重叠与空节', () => {
    const doc = makeDoc([
      { section: makeSection(0, 0, 0, '一', null), blocks: ['aa', 'bb'] },
      { section: makeSection(1, 0, 0, '二', null), blocks: ['cc', 'dd', 'ee'] }
    ]);
    // 人为制造空洞：把第二节整体后移一个块，并让中间块不属于任何节。
    const holed = doc.sections.map((section) =>
      section.index === 1 ? { ...section, blockStart: 3, blockEnd: 4 } : section
    );
    holed[1]!.blockStart = 3;
    holed[1]!.blockEnd = 4;
    const holeIssues = checkIntegrity(doc.blocks.slice(0, 5), [
      { ...doc.sections[0]!, blockStart: 0, blockEnd: 1 },
      { ...doc.sections[1]!, blockStart: 3, blockEnd: 4 }
    ]);
    expect(holeIssues.ok).toBe(false);
    expect(holeIssues.issues.join('|')).toContain('空洞');

    const overlapIssues = checkIntegrity(doc.blocks, [
      { ...doc.sections[0]!, blockStart: 0, blockEnd: 2 },
      { ...doc.sections[1]!, blockStart: 2, blockEnd: 4 }
    ]);
    expect(overlapIssues.issues.join('|')).toContain('重叠');
  });

  it('首尾允许无归属（参考文献尾巴不是缺陷）', () => {
    const blocks = [0, 1, 2, 3].map((index) => makeBlock(index, 1, `p${index}`));
    blocks[0]!.section = 0;
    blocks[1]!.section = 0;
    const sections = [makeSection(0, 0, 1, '正文', null)];
    expect(checkIntegrity(blocks, sections).ok).toBe(true);
  });

  it('块的 section 字段与区间不一致要报出来', () => {
    const blocks = [0, 1].map((index) => makeBlock(index, 1, `p${index}`));
    blocks[0]!.section = 0;
    blocks[1]!.section = 7;
    const sections = [makeSection(0, 0, 1, '正文', null)];
    const report = checkIntegrity(blocks, sections);
    expect(report.ok).toBe(false);
    expect(report.issues.join('|')).toContain('不一致');
  });
});

describe('decompose', () => {
  it('装得下时一节一个单元，不重叠、不漏块', () => {
    const doc = makeDoc([
      { section: makeSection(0, 0, 0, '一', null), blocks: ['a'.repeat(50), 'b'.repeat(50)] },
      { section: makeSection(1, 0, 0, '二', null), blocks: ['c'.repeat(50)] }
    ]);
    const units = decompose(doc, { budget: 1000, cost: charCost });
    expect(units).toHaveLength(2);
    expect(units.every((unit) => unit.splitReason === undefined)).toBe(true);
    expect(units.map((unit) => [unit.blockStart, unit.blockEnd])).toEqual([
      [0, 1],
      [2, 2]
    ]);
  });

  it('超长且无子节时硬切，标记原因并让相邻单元重叠', () => {
    const doc = makeDoc([
      {
        section: makeSection(0, 0, 0, '长节', null),
        blocks: Array.from({ length: 6 }, (_, index) => `${index}`.padEnd(100, 'x'))
      }
    ]);
    const units = decompose(doc, { budget: 250, cost: charCost, overlapBlocks: 2 });
    expect(units.length).toBeGreaterThan(2);
    expect(units.every((unit) => unit.splitReason === 'no_substructure')).toBe(true);
    // 每个非首单元都与上一单元有重叠（重叠 2 块）。
    for (let index = 1; index < units.length; index += 1) {
      expect(units[index]!.blockStart).toBeLessThanOrEqual(units[index - 1]!.blockEnd);
    }
    expect(units.at(-1)!.blockEnd).toBe(5);
  });

  it('有子节时沿结构递归，切点落在子节边界', () => {
    const doc = makeDoc([
      { section: makeSection(0, 0, 0, '父', null), blocks: ['p'.repeat(40)] },
      { section: makeSection(1, 0, 0, '子一', 0), blocks: ['a'.repeat(120)] },
      { section: makeSection(2, 0, 0, '子二', 0), blocks: ['b'.repeat(120)] }
    ]);
    // 父节 40+120+120 = 280 > 200，两个子节各 120 ≤ 200。
    const units = decompose(doc, { budget: 200, cost: charCost });
    expect(units.every((unit) => unit.splitReason === undefined)).toBe(true);
    expect(units.map((unit) => unit.title)).toEqual(['父', '子一', '子二']);
    expect(units.map((unit) => [unit.blockStart, unit.blockEnd])).toEqual([
      [0, 0],
      [1, 1],
      [2, 2]
    ]);
  });

  it('没有任何节覆盖的尾部块不会被丢掉', () => {
    const doc = makeDoc([
      { section: makeSection(0, 0, 0, '正文', null), blocks: ['a'.repeat(20)] }
    ]);
    doc.blocks.push(makeBlock(1, 1, 'b'.repeat(20)), makeBlock(2, 1, 'c'.repeat(20)));
    const units = decompose(doc, { budget: 1000, cost: charCost });
    expect(units).toHaveLength(2);
    expect(units[1]!.blockStart).toBe(1);
    expect(units[1]!.blockEnd).toBe(2);
    expect(units[1]!.sectionIndex).toBe(-1);
  });
});

describe('pack', () => {
  it('装得下就是一条带', () => {
    const doc = makeDoc([
      { section: makeSection(0, 0, 0, '一', null), blocks: ['a'.repeat(50)] },
      { section: makeSection(1, 0, 0, '二', null), blocks: ['b'.repeat(50)] }
    ]);
    const units = decompose(doc, { budget: 1000, cost: charCost });
    const result = pack(units, 1000, { totalCharacters: 100 });
    expect(result.bands).toHaveLength(1);
    expect(result.coverage.readRatio).toBe(1);
  });

  it('装不下就多条带，且永不切开单元', () => {
    const doc = makeDoc([
      { section: makeSection(0, 0, 0, '一', null), blocks: ['a'.repeat(80)] },
      { section: makeSection(1, 0, 0, '二', null), blocks: ['b'.repeat(80)] },
      { section: makeSection(2, 0, 0, '三', null), blocks: ['c'.repeat(80)] }
    ]);
    const units = decompose(doc, { budget: 100, cost: charCost });
    const result = pack(units, 100);
    expect(result.bands.length).toBe(3);
    const packedUnits = result.bands.flatMap((band) => band.units);
    expect(packedUnits).toHaveLength(units.length);
    expect(packedUnits.map((unit) => unit.blockStart)).toEqual([0, 1, 2]);
    expect(result.bands.every((band) => band.cost <= 100)).toBe(true);
  });
});

describe('第 ④ 级：边界带交给模型裁决', () => {
  const blocks: ContentBlock[] = [
    makeBlock(0, 1, '甲'.repeat(300)),
    makeBlock(1, 2, '乙'.repeat(300)),
    makeBlock(2, 3, '丙'.repeat(300))
  ];
  const sections: DocumentSection[] = [
    { ...makeSection(0, 0, 0, '甲', null), pageStart: 1, pageEnd: 1 },
    { ...makeSection(1, 1, 1, '乙', null), pageStart: 2, pageEnd: 2 },
    { ...makeSection(2, 2, 2, '丙', null), pageStart: 3, pageEnd: 3 }
  ];
  blocks.forEach((block, index) => {
    block.section = index;
  });
  const doc = {
    documentId: 'doc',
    blocks,
    sections,
    stats: {
      pages: 3,
      blocks: 3,
      headings: 0,
      paragraphs: 3,
      lists: 0,
      tables: 0,
      captions: 0,
      formulas: 0,
      footnotes: 0,
      references: 0,
      sections: 3
    }
  } as DocumentBlocks;
  const fakeStore = {
    getDocumentBlocks: async () => doc,
    getDocument: () => ({ id: 'doc', name: 'doc', pages: 3 }),
    getPageText: (_id: string, page: number) =>
      blocks.filter((block) => block.page === page).map((block) => block.text).join('\n')
  } as unknown as Store;
  const plan = {
    breadth: 'document' as const,
    reason: 'test',
    origin: '规则' as const,
    pages: [],
    queries: [],
    dimensions: []
  };
  // 受控语义分：甲 1.0、乙 0.707（落在边界带）、丙 0。
  const embed = async (texts: string[]): Promise<number[][]> =>
    texts.map((_, index) =>
      index === 0 ? [1, 0, 0] : index === 1 ? [1, 0, 0] : index === 2 ? [0.5, 0.5, 0] : [0, 1, 0]
    );

  it('模型判 drop 的边界单元被排除，并如实换成裁决结果', async () => {
    const planned = await planReadingWithStructure(
      fakeStore,
      'doc',
      plan,
      1,
      500,
      1,
      '甲',
      embed,
      async () => '{"drop":[1]}'
    );
    const dropped = (planned.excluded ?? []).find((row) => row.title === '乙');
    expect(dropped).toBeTruthy();
    expect(dropped?.reason).toBe('verdict_model:drop');
    expect(planned.pruneDegraded ?? []).not.toContain('verdict_model_unavailable');
    // 甲（p1）保留、乙（p2）被裁决排除、丙（p3）字面判无关 → 只剩第 1 页。
    expect(planned.pages).toEqual([1]);
  });

  it('消歧调用失败时按"宁滥勿缺"保留边界单元', async () => {
    const planned = await planReadingWithStructure(
      fakeStore,
      'doc',
      plan,
      1,
      500,
      1,
      '甲',
      embed,
      async () => {
        throw new Error('model down');
      }
    );
    expect((planned.excluded ?? []).map((row) => row.title)).not.toContain('乙');
    expect(planned.pruneDegraded ?? []).toContain('verdict_model_failed');
    expect(planned.pages).toContain(2);
  });

  it('没传消歧回调时边界单元保留，并标不可用', async () => {
    const planned = await planReadingWithStructure(fakeStore, 'doc', plan, 1, 500, 1, '甲', embed);
    expect((planned.excluded ?? []).map((row) => row.title)).not.toContain('乙');
    expect(planned.pruneDegraded ?? []).toContain('verdict_model_unavailable');
    expect(planned.pages).toContain(2);
  });

  it('用户点「读完整篇」：装不下也不裁决，整篇读', async () => {
    const planned = await planReadingWithStructure(
      fakeStore,
      'doc',
      plan,
      1,
      500,
      1,
      '甲',
      embed,
      async () => '{"drop":[1]}',
      'full'
    );
    expect(planned.excluded ?? []).toHaveLength(0);
    expect(planned.pages).toEqual([1, 2, 3]);
  });

  it('用户点「只读相关部分」：装得下也先裁决', async () => {
    const planned = await planReadingWithStructure(
      fakeStore,
      'doc',
      plan,
      1,
      2000,
      1,
      '甲',
      embed,
      async () => '{"drop":[1]}',
      'prune'
    );
    // 整篇本来装得下；因为是"只读相关部分"，仍然跑了裁决并排掉了乙。
    expect((planned.excluded ?? []).map((row) => row.title)).toContain('乙');
    expect(planned.pages).toEqual([1]);
  });

  it('没点按钮时按材料推导：装得下就整篇读', async () => {
    const planned = await planReadingWithStructure(fakeStore, 'doc', plan, 1, 2000, 1, '甲', embed);
    expect(planned.excluded ?? []).toHaveLength(0);
    expect(planned.pruneDegraded ?? []).toHaveLength(0);
    expect(planned.pages).toEqual([1, 2, 3]);
  });

});

describe('结构完整性失败时的降级', () => {
  it('节区间有洞：按"整篇一节"硬切，并如实上报结构异常', async () => {
    const blocks = [
      makeBlock(0, 1, '甲'.repeat(300)),
      makeBlock(1, 2, '乙'.repeat(300)),
      makeBlock(2, 3, '丙'.repeat(300))
    ];
    blocks.forEach((block, index) => {
      block.section = index === 1 ? -1 : index;
    });
    // 第二节缺失 → 覆盖 1 号块的地方是空洞。
    const sections: DocumentSection[] = [
      { ...makeSection(0, 0, 0, '甲', null), pageStart: 1, pageEnd: 1 },
      { ...makeSection(1, 2, 2, '丙', null), pageStart: 3, pageEnd: 3 }
    ];
    const badDoc = {
      documentId: 'doc',
      blocks,
      sections,
      stats: {
        pages: 3,
        blocks: 3,
        headings: 0,
        paragraphs: 3,
        lists: 0,
        tables: 0,
        captions: 0,
        formulas: 0,
        footnotes: 0,
        references: 0,
        sections: 2
      }
    } as DocumentBlocks;
    const fake = {
      getDocumentBlocks: async () => badDoc,
      getDocument: () => ({ id: 'doc', name: 'doc', pages: 3 }),
      getPageText: (_id: string, page: number) =>
        blocks.filter((block) => block.page === page).map((block) => block.text).join('\n')
    } as unknown as Store;
    const planned = await planReadingWithStructure(
      fake,
      'doc',
      {
        breadth: 'document',
        reason: 'test',
        origin: '规则',
        pages: [],
        queries: [],
        dimensions: []
      },
      1,
      500
    );
    expect(planned.planDegraded).toBe('structure_integrity_failed');
    // 结构不可信仍然要能把整篇读出来（硬切），不能因此拒绝回答。
    expect(planned.fromUnits).toBe(true);
    expect(planned.pages).toEqual([1, 2, 3]);
    expect(planned.sources).toHaveLength(3);
  });
});

describe('真实 PDF：结构与单元', () => {
  const DEMO = path.resolve(
    import.meta.dirname,
    '../../../dev-notes/readme-capture/demo-pdf/out/demo-paper-01.pdf'
  );
  const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-reading-units-'));
  const store = new Store(dataDir);

  afterAll(() => {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('integrity 通过；大预算下整篇装成一条带', async () => {
    if (!existsSync(DEMO)) return;
    const doc = await store.importDocument(DEMO, 'units-demo', true);
    const blocks = await store.getDocumentBlocks(doc.id);
    expect(checkIntegrity(blocks.blocks, blocks.sections)).toEqual({ ok: true, issues: [] });
    const units = decompose(blocks, { budget: 100_000 });
    const result = pack(units, 100_000, {
      totalCharacters: blocks.blocks.reduce((total, block) => total + block.text.length, 0)
    });
    expect(result.bands).toHaveLength(1);
    expect(result.coverage.readRatio).toBe(1);
  });

  it('小预算下单元不跨节：切点要么在节边界，要么是同一节内的硬切', async () => {
    if (!existsSync(DEMO)) return;
    const doc = await store.importDocument(DEMO, 'units-demo-small', true);
    const blocks = await store.getDocumentBlocks(doc.id);
    const units = decompose(blocks, { budget: 400 });
    expect(units.length).toBeGreaterThan(1);
    for (const unit of units) {
      const owners = new Set<number>();
      for (let index = unit.blockStart; index <= unit.blockEnd; index += 1) {
        owners.add(blocks.blocks[index]?.section ?? -1);
      }
      // 一个单元只允许落在一个节里（硬切也发生在节内），绝不跨节拼接。
      expect(owners.size).toBe(1);
    }
  });

  it('整篇阅读走结构装带：页不重不漏，装得下就是一条带', async () => {
    if (!existsSync(DEMO)) return;
    const doc = await store.importDocument(DEMO, 'units-plan', true);
    const plan = {
      breadth: 'document' as const,
      reason: 'test',
      origin: '规则' as const,
      pages: [],
      queries: [],
      dimensions: []
    };

    // 预算按"一页略多一点"给：单元与带都只能按页装，页本身不能再拆。
    const tight = await planReadingWithStructure(store, doc.id, plan, 1, 2000);
    expect(tight.fromUnits).toBe(true);
    expect(tight.batchCount).toBeGreaterThan(1);
    // 每一页恰好出现在一条带里（不重复读、也不漏读）。
    const seen = tight.batches.flatMap((group) => group.map(([, source]) => source.page));
    expect(new Set(seen).size).toBe(seen.length);
    expect([...seen].sort((a, b) => a - b)).toEqual(
      Array.from({ length: doc.pages }, (_, index) => index + 1)
    );

    const loose = await planReadingWithStructure(store, doc.id, plan, 1, 100_000);
    expect(loose.fromUnits).toBe(true);
    expect(loose.batchCount).toBe(1);
    expect(loose.pages).toHaveLength(doc.pages);
  });

  it('装不下时先裁决：被排除的单元不进阅读页，三态账带块级依据', async () => {
    if (!existsSync(DEMO)) return;
    const doc = await store.importDocument(DEMO, 'units-plan-prune', true);
    const plan = {
      breadth: 'document' as const,
      reason: 'test',
      origin: '规则' as const,
      pages: [],
      queries: [],
      dimensions: []
    };
    const planned = await planReadingWithStructure(store, doc.id, plan, 1, 2000, 1, '史料范围 与 分析框架');
    expect(planned.fromUnits).toBe(true);
    const excluded = planned.excluded ?? [];
    expect(excluded.length).toBeGreaterThan(0);
    expect(planned.readRatio).toBeLessThan(1);
    // 排除的单元必须有块级依据与理由（可复核）。
    for (const row of excluded) {
      expect(row.reason.length).toBeGreaterThan(0);
      expect(Array.isArray(row.hits)).toBe(true);
    }
    // 页是最小阅读单位：被排除的单元若与保留单元共用页，那一页仍要读（不能只读半页），
    // 所以这里断言的是"装进去的字确实变少了"，而不是"某页一定不在阅读范围里"。
    expect(planned.readRatio!).toBeLessThan(1);
    // 结构装带的降级说明是如实记账，不能为空。
    expect(planned.pruneDegraded).toContain('semantic_unavailable');
  });

  it('配置了 embedding 时语义通道真的参与裁决', async () => {
    if (!existsSync(DEMO)) return;
    const doc = await store.importDocument(DEMO, 'units-plan-embed', true);
    const plan = {
      breadth: 'document' as const,
      reason: 'test',
      origin: '规则' as const,
      pages: [],
      queries: [],
      dimensions: []
    };
    let embedded = 0;
    const planned = await planReadingWithStructure(
      store,
      doc.id,
      plan,
      1,
      2000,
      1,
      '史料范围 与 分析框架',
      // 假向量：只用来证明"传了回调就会算、算过就不再标不可用"。
      async (texts) => {
        embedded = texts.length;
        return texts.map((_, index) => [index === 0 ? 1 : 0, index === 0 ? 0 : 1]);
      }
    );
    expect(embedded).toBeGreaterThan(1);
    expect(planned.pruneDegraded ?? []).not.toContain('semantic_unavailable');
    expect(planned.fromUnits).toBe(true);
  });

  it('没有配置 embedding 时如实标语义不可用（不假装算过）', async () => {
    if (!existsSync(DEMO)) return;
    const doc = await store.importDocument(DEMO, 'units-plan-no-embed', true);
    const plan = {
      breadth: 'document' as const,
      reason: 'test',
      origin: '规则' as const,
      pages: [],
      queries: [],
      dimensions: []
    };
    const planned = await planReadingWithStructure(store, doc.id, plan, 1, 2000, 1, '史料范围');
    expect(planned.pruneDegraded ?? []).toContain('semantic_unavailable');
  });

  it('局部阅读不走结构装带（选择哪些页的语义还没被接管）', async () => {
    if (!existsSync(DEMO)) return;
    const doc = await store.importDocument(DEMO, 'units-plan-local', true);
    const plan = {
      breadth: 'local' as const,
      reason: 'test',
      origin: '规则' as const,
      pages: [3],
      queries: [],
      dimensions: []
    };
    const planned = await planReadingWithStructure(store, doc.id, plan, 3, 2000);
    expect(planned.fromUnits).toBeUndefined();
    expect(planned.pages).toEqual([3]);
  });
});
