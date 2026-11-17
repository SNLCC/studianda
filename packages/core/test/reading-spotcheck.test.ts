import type { ContentBlock, DocumentBlocks, DocumentSection } from '@studianda/shared';
import { describe, expect, it } from 'vitest';
import { planReadingWithStructure } from '../src/reading-plan.js';
import { spotcheckNotice } from '../src/reading-chat.js';
import type { Store } from '../src/store.js';

/**
 * 排除抽检：对"已判不读"的单元做一次薄读复核。
 *
 * 夹具固定 15 个单页单元，融合分是设计出来的（字面 + 余弦各占一半）：
 * - 1 个相关（页 1，字面命中 + 余弦 1）；
 * - 5 个被排除（页 2–6，融合分 0.10–0.14，低于阈值下限 0.16）；
 * - 3 个边界带（页 7–9，0.20–0.24）；
 * - 6 个保留（页 10–15，0.26–0.48）。
 *
 * 这套分布保证：阈值 = 0.20（15×0.35 取整到第 5 个），下限 0.16、上限 0.24 ——
 * 于是"排除 5 / 边界 3"是确定的，可以断言抽检抽了几节、恢复了几节。
 */

const FILLER = '丙';

function makeBlock(index: number, page: number, text: string): ContentBlock {
  return {
    id: `b${index}`,
    page,
    kind: 'paragraph',
    section: index,
    text,
    bbox: [0.1, 0.1, 0.9, 0.12],
    lines: 1
  };
}

const FUSED = [1.0, 0.1, 0.11, 0.12, 0.13, 0.14, 0.2, 0.22, 0.24, 0.26, 0.3, 0.4, 0.42, 0.45, 0.48];

function fixture(): { store: Store; plan: Parameters<typeof planReadingWithStructure>[2]; embed: (texts: string[]) => Promise<number[][]> } {
  const blocks: ContentBlock[] = FUSED.map((_, index) =>
    // 无关单元故意超过 150 字：薄读载荷只取首段 + 末段，两者都要出现。
    makeBlock(index, index + 1, index === 0 ? '甲乙'.repeat(50) : FILLER.repeat(200))
  );
  const sections: DocumentSection[] = FUSED.map((_, index) => ({
    index,
    title: `节${index + 1}`,
    level: 1,
    kind: 'body',
    origin: 'heading',
    pageStart: index + 1,
    pageEnd: index + 1,
    blockStart: index,
    blockEnd: index,
    parent: null
  }));
  const document = {
    documentId: 'doc',
    blocks,
    sections,
    stats: {
      pages: blocks.length,
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
  const store = {
    getDocumentBlocks: async () => document,
    getDocument: () => ({ id: 'doc', name: 'doc', pages: blocks.length }),
    getPageText: (_id: string, page: number) => blocks[page - 1]?.text ?? ''
  } as unknown as Store;
  // 单位向量：与查询的余弦 = 2×目标融合分（相关那节取 1）。
  const embed = async (texts: string[]): Promise<number[][]> =>
    texts.map((_, index) => {
      if (index === 0) return [1, 0];
      const cosine = index === 1 ? 1 : Math.min(1, FUSED[index - 1]! * 2);
      return [cosine, Math.sqrt(Math.max(0, 1 - cosine * cosine))];
    });
  const plan = {
    breadth: 'document' as const,
    reason: 'test',
    origin: '规则' as const,
    pages: [] as number[],
    queries: [] as string[],
    dimensions: [] as Array<{ code: string; label: string }>
  };
  return { store, plan, embed };
}

const EXCLUDED_PAGES = [2, 3, 4, 5, 6];
const BAND_PAGES = [7, 8, 9];

describe('排除抽检（计划层）', () => {
  it('一次调用同时做边界带裁决与抽检，命中的已排除单元被救回', async () => {
    const { store, plan, embed } = fixture();
    const calls: Array<{ instruction: string; material: string }> = [];
    const planned = await planReadingWithStructure(
      store,
      'doc',
      plan,
      1,
      500,
      1,
      '甲乙',
      embed,
      async (instruction, material) => {
        calls.push({ instruction, material });
        // 边界带三节全保留，抽检命中前两节（页 6、页 5）。
        return '{"keep":[1,2,3],"rescue":[1,2]}';
      }
    );
    // 一次调用做完两段，不额外付费。
    expect(calls).toHaveLength(1);
    expect(calls[0]!.instruction).toContain('READING_VERDICT');
    expect(calls[0]!.instruction).toContain('rescue');
    expect(calls[0]!.instruction).toContain('第二段是**本轮已判为不读**');
    expect(calls[0]!.material).toContain('第二段：本轮已判为不读');
    expect(calls[0]!.material).toContain('首段：');
    expect(calls[0]!.material).toContain('末段：');

    expect(planned.spotcheck).toEqual({ checked: 5, rescued: 2, capped: 0 });
    // 恢复的单元重新进阅读页（页 5、6），边界带三页全部保留。
    expect(planned.pages).toEqual(expect.arrayContaining([5, 6, ...BAND_PAGES]));
    // 剩下三节仍按原判排除，且不再标"未经复核"。
    expect((planned.excluded ?? []).map((row) => row.pages[0]).sort((a, b) => a - b)).toEqual([2, 3, 4]);
    expect(planned.pruneDegraded ?? []).not.toContain('spotcheck_parse_failed');
    expect(planned.pruneDegraded ?? []).not.toContain('spotcheck_failed');
    expect(planned.pruneDegraded ?? []).not.toContain('spotcheck_unavailable');
    // 恢复的页确实读到了（页文本进 sources）。
    expect(planned.sources.map((source) => source.page)).toEqual(expect.arrayContaining([5, 6]));
  });

  it('模型只答了边界带那一段：抽检算失败，排除维持原判并如实标降级', async () => {
    const { store, plan, embed } = fixture();
    const planned = await planReadingWithStructure(
      store,
      'doc',
      plan,
      1,
      500,
      1,
      '甲乙',
      embed,
      async () => '{"keep":[1,2,3]}'
    );
    expect(planned.pruneDegraded ?? []).toContain('spotcheck_parse_failed');
    expect(planned.spotcheck).toBeUndefined();
    expect((planned.excluded ?? []).map((row) => row.pages[0]).sort((a, b) => a - b)).toEqual(
      EXCLUDED_PAGES
    );
    // 边界带仍然按模型裁决保留（一条调用里两段互不影响）。
    expect(planned.pages).toEqual(expect.arrayContaining(BAND_PAGES));
  });

  it('没有复核回调：不抽检，并明确标"未经抽检"而不是静默', async () => {
    const { store, plan, embed } = fixture();
    const planned = await planReadingWithStructure(store, 'doc', plan, 1, 500, 1, '甲乙', embed);
    expect(planned.pruneDegraded ?? []).toContain('spotcheck_unavailable');
    expect(planned.spotcheck).toBeUndefined();
    expect((planned.excluded ?? []).map((row) => row.pages[0]).sort((a, b) => a - b)).toEqual(
      EXCLUDED_PAGES
    );
    // 边界带按"宁滥勿缺"全部保留。
    expect(planned.pages).toEqual(expect.arrayContaining(BAND_PAGES));
  });

  it('抽检恢复有上限：超出部分转成"未读"，既不算已读也不算无关', async () => {
    const { store, plan, embed } = fixture();
    const planned = await planReadingWithStructure(
      store,
      'doc',
      plan,
      1,
      500,
      1,
      '甲乙',
      embed,
      async () => '{"keep":[1,2,3],"rescue":[1,2,3,4,5]}'
    );
    expect(planned.spotcheck).toEqual({ checked: 5, rescued: 3, capped: 2 });
    expect(planned.pruneDegraded ?? []).toContain('spotcheck_rescue_capped');
    // 恢复上限 3：只读页 6、5、4；页 3、2 不再算"排除"（否则等于声称它们无关）。
    expect(planned.pages).toEqual(expect.arrayContaining([6, 5, 4]));
    expect(planned.pages).not.toContain(3);
    expect(planned.pages).not.toContain(2);
    expect(planned.excluded ?? []).toHaveLength(0);
  });
});

describe('抽检通知', () => {
  it('恢复了几节要说，没抽成也要说', () => {
    expect(
      spotcheckNotice({ spotcheck: { checked: 5, rescued: 2, capped: 0 } })
    ).toContain('已抽检 5 个被判为不读的单元，其中 2 个复核后发现误判');
    expect(spotcheckNotice({ spotcheck: { checked: 4, rescued: 0, capped: 0 } })).toContain(
      '未发现明显误判'
    );
    expect(
      spotcheckNotice({ spotcheck: { checked: 5, rescued: 3, capped: 2 } })
    ).toContain('超出本轮恢复上限');
    expect(spotcheckNotice({ pruneDegraded: ['spotcheck_unavailable'] })).toContain(
      '未经抽检'
    );
    expect(spotcheckNotice({ pruneDegraded: ['spotcheck_failed'] })).toContain('抽检调用失败');
    expect(spotcheckNotice({ pruneDegraded: ['spotcheck_parse_failed'] })).toContain(
      '按原判保留'
    );
    // 没抽检、也没降级：不产生噪音。
    expect(spotcheckNotice({})).toBe('');
  });
});

describe('抽检与结构化装带', () => {
  it('恢复的单元计入 readRatio，抽检结果也能进 reading_plan 账（fromUnits 路径）', async () => {
    const { store, plan, embed } = fixture();
    const planned = await planReadingWithStructure(
      store,
      'doc',
      plan,
      1,
      500,
      1,
      '甲乙',
      embed,
      async () => '{"keep":[1,2,3],"rescue":[1,2]}'
    );
    expect(planned.fromUnits).toBe(true);
    // 恢复两节后，已读字符数应当比未恢复时更多（同一份文档、同一套分数）。
    const baseline = await planReadingWithStructure(
      store,
      'doc',
      plan,
      1,
      500,
      1,
      '甲乙',
      embed,
      async () => '{"keep":[1,2,3],"rescue":[]}'
    );
    expect(planned.readRatio).toBeGreaterThan(baseline.readRatio ?? 0);
  });
});
