import type {
  ContentBlock,
  ContentBlockKind,
  DocumentBlocks,
  DocumentSection,
  DocumentSectionKind
} from '@studianda/shared';
import { describe, expect, it } from 'vitest';
import { decompose } from '../src/reading-units.js';
import {
  excludedPages,
  exclusionSummary,
  MAX_RESCUE_UNITS,
  MAX_SPOTCHECK_UNITS,
  parseSpotcheck,
  parseVerdict,
  pruneUnits,
  reviewRequest,
  spotCheckCandidates
} from '../src/reading-prune.js';

const charCost = (text: string): number => text.length;

function makeBlock(index: number, page: number, text: string): ContentBlock {
  return {
    id: `b${index}`,
    page,
    kind: 'paragraph' as ContentBlockKind,
    section: -1,
    text,
    bbox: [0.1, 0.1, 0.9, 0.12],
    lines: 1
  };
}

function makeSection(
  index: number,
  title: string,
  parent: number | null,
  kind: DocumentSectionKind = 'body'
): DocumentSection {
  return {
    index,
    title,
    level: parent === null ? 1 : 2,
    kind,
    origin: 'heading',
    pageStart: 1,
    pageEnd: 1,
    blockStart: 0,
    blockEnd: 0,
    parent
  };
}

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

describe('pruneUnits', () => {
  it('排除与问题无关的节，保留命中的节', () => {
    const doc = makeDoc([
      {
        section: makeSection(0, '制度变迁', null),
        blocks: ['制度变迁 的 路径 依赖 与 渐进 改革。'.repeat(4)]
      },
      {
        section: makeSection(1, '水稻栽培', null),
        blocks: ['水稻 栽培 需要 充足 的 灌溉 与 育秧 时间。'.repeat(4)]
      },
      {
        section: makeSection(2, '结论', null),
        blocks: ['结论 部分 总结 全文 的 论点 与 局限。'.repeat(4)]
      }
    ]);
    const units = decompose(doc, { budget: 10_000, cost: charCost });
    const result = pruneUnits({
      units,
      blocks: doc.blocks,
      sections: doc.sections,
      query: '制度变迁 的 路径 依赖 是 什么'
    });
    expect(result.kept.map((unit) => unit.title)).toContain('制度变迁');
    expect(result.excluded.map((row) => row.unit.title)).toContain('水稻栽培');
    expect(result.byReason['lexical:no_terms']).toBeGreaterThan(0);
  });

  it('结构排除：参考文献默认不读，但被问到时字面抢救', () => {
    const doc = makeDoc([
      { section: makeSection(0, '正文', null), blocks: ['论证 主体 在 这里 展开。'.repeat(4)] },
      {
        section: makeSection(1, '参考文献', null, 'references'),
        blocks: ['Smith 2019 制度变迁 的 路径 依赖 研究。'.repeat(4)]
      }
    ]);
    const units = decompose(doc, { budget: 10_000, cost: charCost });

    const unrelated = pruneUnits({
      units,
      blocks: doc.blocks,
      sections: doc.sections,
      query: '论证 主体 是什么'
    });
    expect(unrelated.excluded.map((row) => row.unit.title)).toContain('参考文献');
    expect(unrelated.excluded[0]!.reason).toContain('structural');

    const wanted = pruneUnits({
      units,
      blocks: doc.blocks,
      sections: doc.sections,
      query: '制度变迁 的 路径 依赖 研究'
    });
    expect(wanted.kept.map((unit) => unit.title)).toContain('参考文献');
  });

  it('只有一个单元时不排除（否则等于拒绝回答）', () => {
    const doc = makeDoc([
      { section: makeSection(0, '唯一', null), blocks: ['与 问题 完全 无关 的 内容。'] }
    ]);
    const units = decompose(doc, { budget: 10_000, cost: charCost });
    const result = pruneUnits({
      units,
      blocks: doc.blocks,
      sections: doc.sections,
      query: '制度变迁'
    });
    expect(result.kept).toHaveLength(1);
    expect(result.excluded).toHaveLength(0);
  });

  it('没有可用查询词时不做字面排除（宁滥勿缺），并如实标记降级', () => {
    const doc = makeDoc([
      { section: makeSection(0, '一', null), blocks: ['甲 乙 丙。'] },
      { section: makeSection(1, '二', null), blocks: ['丁 戊 己。'] }
    ]);
    const units = decompose(doc, { budget: 10_000, cost: charCost });
    const result = pruneUnits({
      units,
      blocks: doc.blocks,
      sections: doc.sections,
      query: ''
    });
    expect(result.degraded).toContain('no_query_terms');
    expect(result.kept).toHaveLength(2);
    expect(result.excluded).toHaveLength(0);
  });

  it('语义通道召回字面为零的单元（同义/跨语言）', () => {
    const doc = makeDoc([
      { section: makeSection(0, '制度', null), blocks: ['制度 变迁 的 路径 依赖。'.repeat(3)] },
      { section: makeSection(1, 'English', null), blocks: ['Institutional change is path dependent.'.repeat(3)] },
      { section: makeSection(2, '无关', null), blocks: ['水稻 栽培 与 育秧 时间。'.repeat(3)] }
    ]);
    const units = decompose(doc, { budget: 10_000, cost: charCost });
    // 语义分：第二节（英文同义表达）与问题最像；第一节字面命中；第三节无关。
    const semanticScores = new Map<number, number>([
      [0, 0.55],
      [1, 0.82],
      [2, 0.05]
    ]);
    const result = pruneUnits({
      units,
      blocks: doc.blocks,
      sections: doc.sections,
      query: '制度 变迁 的 路径 依赖',
      semanticScores
    });
    // 字面通道对英文节得分为 0，靠语义分被抬出"明确无关"区（进边界带或直接保留）。
    expect(result.excluded.map((row) => row.unit.title)).not.toContain('English');
    expect(result.kept.map((unit) => unit.title)).toContain('制度');
    expect(result.excluded.map((row) => row.unit.title)).toContain('无关');
    // 真的算过语义，就不该再报"语义不可用"。
    expect(result.degraded).not.toContain('semantic_unavailable');
  });

  it('边界带单独交出：既不判读也不判弃，等第 ④ 级裁决', () => {
    // 三个单元都没有字面命中，只用语义分构造出"高 / 中 / 低"三档：
    // 中档落在阈值 ±20% 内 → 进边界带；高档保留；低档排除。
    const doc = makeDoc([
      { section: makeSection(0, '甲', null), blocks: ['内容甲。'.repeat(3)] },
      { section: makeSection(1, '乙', null), blocks: ['内容乙。'.repeat(3)] },
      { section: makeSection(2, '丙', null), blocks: ['内容丙。'.repeat(3)] }
    ]);
    const units = decompose(doc, { budget: 10_000, cost: charCost });
    const result = pruneUnits({
      units,
      blocks: doc.blocks,
      sections: doc.sections,
      query: '完全 不 出现 的 术语',
      semanticScores: new Map([
        [0, 0.9],
        [1, 0.5],
        [2, 0.1]
      ])
    });
    expect(result.ambiguous.map((row) => row.unit.title)).toEqual(['乙']);
    expect(result.kept.map((unit) => unit.title)).toEqual(['甲']);
    expect(result.excluded.map((row) => row.unit.title)).toEqual(['丙']);
  });

  it('排除有上限：不会因为阈值把整本排掉', () => {
    const spec = Array.from({ length: 6 }, (_, index) => ({
      section: makeSection(index, `节${index}`, null),
      blocks: [`第${index}节 的 内容 与 主题 无关。`]
    }));
    const doc = makeDoc(spec);
    const units = decompose(doc, { budget: 10_000, cost: charCost });
    const result = pruneUnits({
      units,
      blocks: doc.blocks,
      sections: doc.sections,
      query: '完全 不 出现 的 术语'
    });
    expect(result.kept.length).toBeGreaterThanOrEqual(Math.ceil(units.length * 0.2));
    expect(result.kept.length + result.excluded.length).toBe(units.length);
  });
});

describe('第 ④ 级：边界带模型消歧', () => {
  it('解析 keep/drop；编号越界与非法值一律忽略', () => {
    expect(parseVerdict('{"keep":[1,3],"drop":[2]}', 3)).toEqual({
      keep: new Set([0, 2]),
      drop: new Set([1])
    });
    // 混在文字里的 JSON 也能取出来。
    expect(parseVerdict('结果是 {"drop":[2]} 就这样', 3)?.drop.has(1)).toBe(true);
    // 越界编号与非法值被丢弃。
    const parsed = parseVerdict('{"keep":[9,"x",2],"drop":[]}', 3);
    expect([...parsed!.keep]).toEqual([1]);
    // 解析不出来 / 两个数组都空 → null（调用方按"全保留"处理）。
    expect(parseVerdict('not json', 3)).toBeNull();
    expect(parseVerdict('{"keep":[],"drop":[]}', 3)).toBeNull();
  });

  it('复核载荷只含标题 + 首段/末段 + 命中词（不把整节塞给模型）', () => {
    const units = [
      {
        sectionIndex: 0,
        title: '制度变迁',
        blockStart: 0,
        blockEnd: 0,
        pagesFrom: 1,
        pagesTo: 1,
        cost: 10,
        characters: 900
      }
    ];
    const blocks = [makeBlock(0, 1, '制度 变迁 的 路径 依赖。'.repeat(40))];
    const { instruction, material } = reviewRequest({
      question: '制度变迁是什么',
      band: [{ unit: units[0]!, hits: ['制度', '变迁'] }],
      spot: [{ unit: units[0]!, hits: [] }],
      blocks
    });
    expect(material).toContain('制度变迁是什么');
    expect(material).toContain('标题：制度变迁');
    expect(material).toContain('命中词：制度、变迁');
    expect(material).toContain('第二段：本轮已判为不读');
    // 首段/末段各截到 150 字：载荷是"薄样本"，不是原文。
    const head = material.split('首段：')[1]!.split('\n')[0]!;
    expect(head.length).toBeLessThanOrEqual(150);
    const tail = material.split('末段：')[1]!.split('\n')[0]!;
    expect(tail.length).toBeLessThanOrEqual(150);
    expect(instruction).toContain('READING_VERDICT');
    expect(instruction).toContain('拿不准就放进 keep');
    expect(instruction).toContain('rescue');
    // 只有一个段时，另一段的键与说明都不该出现（别让模型去答不存在的那段）。
    const bandOnly = reviewRequest({
      question: '制度变迁是什么',
      band: [{ unit: units[0]!, hits: [] }],
      spot: [],
      blocks
    });
    expect(bandOnly.instruction).not.toContain('rescue');
    expect(bandOnly.material).not.toContain('第二段');
    const spotOnly = reviewRequest({
      question: '制度变迁是什么',
      band: [],
      spot: [{ unit: units[0]!, hits: [] }],
      blocks
    });
    expect(spotOnly.instruction).toContain('rescue');
    expect(spotOnly.instruction).not.toContain('"drop"');
    expect(spotOnly.material).not.toContain('第一段');
  });
});

describe('排除抽检', () => {
  const unit = (blockStart: number, title: string) => ({
    sectionIndex: blockStart,
    title,
    blockStart,
    blockEnd: blockStart,
    pagesFrom: blockStart + 1,
    pagesTo: blockStart + 1,
    cost: 10,
    characters: 100
  });
  const excludedRow = (blockStart: number, score: number, reason: string) => ({
    unit: unit(blockStart, `节${blockStart}`),
    score,
    hits: [],
    reason
  });

  it('只抽"可能判错"的理由，按分数从高到低取前 N 个（结构排除与刚判 drop 的不抽）', () => {
    const rows = [
      excludedRow(0, 0.1, 'relevance_below_threshold'),
      excludedRow(1, 0.4, 'relevance_below_threshold'),
      excludedRow(2, 0.2, 'verdict_model:drop'),
      excludedRow(3, 0.9, 'structural:references'),
      excludedRow(4, 0, 'lexical:no_terms')
    ];
    const picked = spotCheckCandidates(rows);
    expect(picked.map((row) => row.unit.blockStart)).toEqual([1, 0, 4]);
    expect(MAX_SPOTCHECK_UNITS).toBeGreaterThanOrEqual(picked.length);
    // 上限生效，且同分按块起点排序（确定性）。
    const capped = spotCheckCandidates(rows, 2);
    expect(capped.map((row) => row.unit.blockStart)).toEqual([1, 0]);
    expect(MAX_RESCUE_UNITS).toBeLessThanOrEqual(MAX_SPOTCHECK_UNITS);
  });

  it('抽检解析：没有 rescue 键 = 解析失败，不能当成"全部保持排除"的默认值', () => {
    // 模型只答了边界带那一段：这轮抽检等于没做，必须如实标失败。
    expect(parseSpotcheck('{"keep":[1],"drop":[]}', 3)).toBeNull();
    expect(parseSpotcheck('not json', 3)).toBeNull();
    expect(parseSpotcheck('{"rescue":"1"}', 3)).toBeNull();
    // 空数组是合法结果：明确表示"没有明显误判"。
    expect([...parseSpotcheck('{"rescue":[]}', 3)!]).toEqual([]);
    // 越界与非法值忽略。
    expect([...parseSpotcheck('混在文字里 {"rescue":[2,9,"x"]} 结束', 3)!]).toEqual([1]);
  });
});

describe('排除的记账', () => {
  it('被排除单元覆盖的页不算"未读"，并能给出一句可读说明', () => {
    const units = [
      {
        sectionIndex: 0,
        title: '甲',
        blockStart: 0,
        blockEnd: 1,
        pagesFrom: 1,
        pagesTo: 2,
        cost: 10,
        characters: 10
      },
      {
        sectionIndex: 1,
        title: '乙',
        blockStart: 2,
        blockEnd: 3,
        pagesFrom: 3,
        pagesTo: 4,
        cost: 10,
        characters: 10
      }
    ];
    const pages = excludedPages([
      { unit: units[1]!, score: 0, hits: [], reason: 'lexical:no_terms' }
    ]);
    expect(pages).toEqual([3, 4]);
    expect(exclusionSummary([{ unit: units[1]!, score: 0, hits: [], reason: 'lexical:no_terms' }])).toContain(
      '已排除 1 个单元'
    );
  });
});
