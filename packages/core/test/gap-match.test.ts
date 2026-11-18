import { describe, expect, it } from 'vitest';
import {
  gapPageHits,
  gapSearchTerms,
  gapSelectionPages,
  mergeGapCandidates
} from '../src/gap-match.js';
import type { ChunkRow } from '../src/retrieval.js';
import type { Store } from '../src/store.js';

function chunk(page: number, text: string): ChunkRow {
  return { id: `chunk-${page}-${text.length}`, documentId: 'doc', page, text, name: '' };
}

describe('缺口检索：问题术语提取', () => {
  it('中文按整词取出，英文词去重且忽略大小写', () => {
    expect(gapSearchTerms('叙事策略')).toEqual(['叙事策略']);
    expect(gapSearchTerms('value VALUE belief', ['belief'])).toEqual(['value', 'belief']);
  });

  it('单字与空查询词不进结果', () => {
    expect(gapSearchTerms('的 a', ['x', '信念'])).toEqual(['信念']);
  });

  it('问题术语与规划查询词合并，重复项只留一个', () => {
    expect(gapSearchTerms('价值信念', ['价值信念', '测量工具'])).toEqual([
      '价值信念',
      '测量工具'
    ]);
  });
});

describe('缺口检索：词项覆盖率判定', () => {
  it('中文换一种断句仍然命中（原先 includes 会漏判）', () => {
    // 术语「叙事策略」分词为 叙事 / 事策 / 策略；正文没有连续四字，但覆盖 2/3。
    const hits = gapPageHits(
      [chunk(3, '本文讨论叙事的时间结构，并分析其策略选择。')],
      ['叙事策略']
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]?.page).toBe(3);
    expect(hits[0]?.terms).toEqual(['叙事策略']);
    expect(hits[0]?.coverage).toBeCloseTo(2 / 3, 6);
  });

  it('只撞上一个二字词不算命中（避免整页共用一个词就判相关）', () => {
    const hits = gapPageHits([chunk(4, '本文讨论叙事的时间结构。')], ['叙事策略']);
    expect(hits).toEqual([]);
  });

  it('刚好覆盖一半时仍不命中', () => {
    // 术语「叙事学」分词为 叙事 / 事学，只有 1/2 覆盖。
    expect(gapPageHits([chunk(5, '这是一段关于叙事的讨论。')], ['叙事学'])).toEqual([]);
  });

  it('连续原文照旧命中', () => {
    const hits = gapPageHits([chunk(6, '第 6 页讨论叙事策略的三种类型。')], ['叙事策略']);
    expect(hits.map((hit) => hit.page)).toEqual([6]);
  });

  it('英文按词命中，不因大小写失配', () => {
    const hits = gapPageHits([chunk(7, 'The VALUE BELIEF scale is used.')], ['value belief']);
    expect(hits.map((hit) => hit.page)).toEqual([7]);
  });
});

describe('缺口检索：排序与聚合', () => {
  it('命中词项更多的页排在前面，同分按页码', () => {
    const chunks = [
      chunk(10, '只提到测量工具。'),
      chunk(11, '同时讨论价值信念与测量工具。'),
      chunk(12, '只提到价值信念。')
    ];
    const hits = gapPageHits(chunks, ['价值信念', '测量工具']);
    expect(hits[0]?.page).toBe(11);
    // 10 与 12 各命中一个词项、覆盖率相同，按页码升序。
    expect(hits.slice(1).map((hit) => hit.page)).toEqual([10, 12]);
  });

  it('同一页的多个 chunk 合并成一条页记录', () => {
    const hits = gapPageHits(
      [chunk(20, '价值信念的定义。'), chunk(20, '测量工具的来源。')],
      ['价值信念', '测量工具']
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]?.terms).toEqual(['价值信念', '测量工具']);
  });

  it('空 chunks 或空术语直接返回空', () => {
    expect(gapPageHits([], ['价值信念'])).toEqual([]);
    expect(gapPageHits([chunk(1, '正文')], [])).toEqual([]);
  });
});

describe('缺口检索：候选页合并与语义兜底', () => {
  it('词法在前、语义补空档、同名去重、按上限截断', () => {
    expect(mergeGapCandidates([3, 1], [1, 7, 9], 3)).toEqual([3, 1, 7]);
    expect(mergeGapCandidates([], [5, 4], 2)).toEqual([5, 4]);
    expect(mergeGapCandidates([2], [], 4)).toEqual([2]);
  });

  it('词法已命中时不走语义分支', async () => {
    const fake = {
      listChunks: () => [
        { id: 'c1', documentId: 'doc', page: 3, text: '这里有价值信念的讨论。' }
      ],
      getPageText: () => ''
    } as unknown as Store;
    const result = await gapSelectionPages(fake, undefined, 'doc', ['价值信念'], {
      pages: [1, 2, 3]
    });
    expect(result.semantic).toBe(false);
    expect(result.pages).toEqual([3]);
  });

  it('没有密钥时不做语义兜底，返回空候选', async () => {
    const fake = {
      listChunks: () => [],
      getPageText: () => ''
    } as unknown as Store;
    const result = await gapSelectionPages(fake, undefined, 'doc', ['价值信念'], {
      pages: [1, 2]
    });
    expect(result).toEqual({ pages: [], semantic: false });
  });
});
