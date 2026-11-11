import { describe, expect, it } from 'vitest';
import { DEFAULT_DIMENSIONS } from '../src/coverage.js';
import {
  conservativePlan,
  normalizeDimensions,
  planFromRules,
  planQuestion,
  withDefaultDimensions
} from '../src/planning.js';

/**
 * 默认覆盖维度。
 *
 * 为什么要有这一层：维度清单空着时，覆盖台账只能说「未逐批记账」，
 * 用户看不出「哪些方面找到了、哪些方面没找到」。但兜底也不能把模型乱写的编号带进台账。
 */

const MODEL_PLAN = {
  breadth: 'document',
  confidence: 0.95,
  reason: '模型判断',
  pages: [],
  queries: []
};

describe('normalizeDimensions', () => {
  it('保留合法维度；词表外的码一律丢弃', () => {
    expect(
      normalizeDimensions([
        { code: 'D1', label: '概念界定' },
        { code: 'X1', label: '自造维度' },
        { code: 'D2', label: '理论依据' },
        'D3'
      ])
    ).toEqual([
      { code: 'D1', label: '概念界定' },
      { code: 'D2', label: '理论依据' }
    ]);
  });

  it('同一编号只留第一次（去重）', () => {
    expect(normalizeDimensions([
      { code: 'D1', label: '概念界定' },
      { code: 'D1', label: '另一个名字' }
    ])).toEqual([{ code: 'D1', label: '概念界定' }]);
  });

  it('最多 6 条', () => {
    const raw = Array.from({ length: 8 }, (_, index) => ({
      code: `D${index + 1}`,
      label: `方面${index + 1}`
    }));
    const dimensions = normalizeDimensions(raw);
    expect(dimensions).toHaveLength(6);
    expect(dimensions.map((dimension) => dimension.code)).toEqual(['D1', 'D2', 'D3', 'D4', 'D5', 'D6']);
  });

  it('空 label 或过长 label 丢弃；6 个字左右保留', () => {
    expect(
      normalizeDimensions([
        { code: 'D1', label: '' },
        { code: 'D2', label: '   ' },
        { code: 'D3', label: '概'.repeat(20) },
        { code: 'D4', label: '作者最终立场' }
      ])
    ).toEqual([{ code: 'D4', label: '作者最终立场' }]);
  });

  it('非数组输入返回空清单（不抛错：维度只是记账口径）', () => {
    expect(normalizeDimensions(undefined)).toEqual([]);
    expect(normalizeDimensions('D1')).toEqual([]);
    expect(normalizeDimensions({ code: 'D1', label: '概念界定' })).toEqual([]);
  });
});

describe('withDefaultDimensions', () => {
  it('空清单退回 coverage.DEFAULT_DIMENSIONS', () => {
    const plan = withDefaultDimensions(conservativePlan());
    expect(plan.dimensions).toEqual(DEFAULT_DIMENSIONS);
    expect(plan.dimensions.map((dimension) => dimension.code)).toEqual(['D1', 'D2', 'D3', 'D4', 'D5', 'D6']);
  });

  it('已有维度时原样保留（不与默认维度混在一起）', () => {
    const plan = withDefaultDimensions({
      ...conservativePlan(),
      dimensions: [{ code: 'D3', label: '限定条件' }]
    });
    expect(plan.dimensions).toEqual([{ code: 'D3', label: '限定条件' }]);
  });

  it('返回的是副本：改返回值不会污染共享常量或下一次调用', () => {
    const before = DEFAULT_DIMENSIONS[0]?.label;
    const first = withDefaultDimensions(conservativePlan());
    first.dimensions[0]!.label = '改过的标签';
    expect(DEFAULT_DIMENSIONS[0]?.label).toBe(before);
    const second = withDefaultDimensions(conservativePlan());
    expect(second.dimensions[0]?.label).toBe(before);
    expect(first.dimensions).not.toBe(second.dimensions);
  });
});

describe('planQuestion 统一兜底默认维度', () => {
  it('规则规划（如“请通读全文”）也带默认维度', () => {
    expect(planFromRules('请通读全文并总结')?.dimensions).toEqual([]);
    const plan = planQuestion('请通读全文并总结', '');
    expect(plan.origin).toBe('规则');
    expect(plan.breadth).toBe('document');
    expect(plan.dimensions).toEqual(DEFAULT_DIMENSIONS);
  });

  it('模型给了 2 条维度就保留那 2 条，不被默认维度覆盖', () => {
    const plan = planQuestion('作者如何论证价值信念', '', {
      ...MODEL_PLAN,
      dimensions: [
        { code: 'D1', label: '概念界定' },
        { code: 'D3', label: '限定条件' }
      ]
    });
    expect(plan.origin).toBe('模型规划');
    expect(plan.dimensions).toEqual([
      { code: 'D1', label: '概念界定' },
      { code: 'D3', label: '限定条件' }
    ]);
  });

  it('模型没给维度时退回默认维度（不是“不用检查”）', () => {
    const plan = planQuestion('作者如何论证价值信念', '', MODEL_PLAN);
    expect(plan.origin).toBe('模型规划');
    expect(plan.dimensions).toEqual(DEFAULT_DIMENSIONS);
  });

  it('模型给的非法/重复维度先清洗，清空后再兜底', () => {
    const plan = planQuestion('作者如何论证价值信念', '', {
      ...MODEL_PLAN,
      dimensions: [{ code: 'Q1', label: '自造维度' }]
    });
    expect(plan.dimensions).toEqual(DEFAULT_DIMENSIONS);
  });

  it('保守回退同样带默认维度', () => {
    const plan = planQuestion('你好呀', '');
    expect(plan.origin).toBe('保守回退');
    expect(plan.dimensions).toEqual(DEFAULT_DIMENSIONS);
  });
});
