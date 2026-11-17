import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ReadingPlanRecord } from '@studianda/shared';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { chatInputLimit, readingBatchBudget } from '../src/reading-chat.js';
import { planReading } from '../src/reading-plan.js';
import type { Store } from '../src/store.js';
import { Store as RealStore } from '../src/store.js';

/**
 * 单带预算必须由模型容量推导，而不是写死的 4000/6000/8000。
 *
 * 这组断言保护 P0 的核心改动：预算跟随 chatInputLimit 之后，
 * "装得下"的文献必须一次装配（batchCount === 1），装不下的才切带。
 */

const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-reading-budget-'));
const store = new RealStore(dataDir);

afterEach(() => {
  delete process.env.STUDIANDA_READING_BUDGET;
});

afterAll(() => {
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

/** 一页中文正文（约 800 字 ≈ 1200 token），用于构造"装得下/装不下"两种规模。 */
const PAGE_TEXT = '第'.repeat(0) + `${'论证与限定条件的说明。'.repeat(80)}`;

function fakeStore(pages: number): Store {
  return {
    getDocument: (id: string) => ({ id, name: 'doc', pages, docCategory: 'paper' }),
    getPageText: (id: string, page: number) =>
      page >= 1 && page <= pages ? `第 ${page} 页 ${PAGE_TEXT}` : ''
  } as unknown as Store;
}

function documentPlan(): ReadingPlanRecord {
  return {
    breadth: 'document',
    reason: 'test',
    origin: '规则',
    pages: [],
    queries: [],
    dimensions: []
  };
}

describe('readingBatchBudget', () => {
  it('跟随模型容量推导，不再是 6000 常量', () => {
    const limit = chatInputLimit(store);
    expect(limit).toBeGreaterThan(6000);
    expect(readingBatchBudget(store)).toBe(Math.floor(limit * 0.6));
    expect(readingBatchBudget(store)).toBeGreaterThan(6000 * 5);
  });

  it('环境变量只作测试/调试覆盖', () => {
    process.env.STUDIANDA_READING_BUDGET = '700';
    expect(readingBatchBudget(store)).toBe(700);
    process.env.STUDIANDA_READING_BUDGET = '-1';
    expect(readingBatchBudget(store)).toBe(Math.floor(chatInputLimit(store) * 0.6));
  });
});

describe('装得下就一次装配', () => {
  it('20 页文献在新预算下只需 1 带（旧 6000 预算要 4 带以上）', () => {
    const doc = fakeStore(20);
    const old = planReading(doc, 'd', documentPlan(), 1, 6000, 1);
    const now = planReading(doc, 'd', documentPlan(), 1, readingBatchBudget(store), 1);
    expect(old.batchCount).toBeGreaterThan(1);
    expect(now.batchCount).toBe(1);
    // 单带即"整段原文进最终回答的上下文"，没有蒸馏损失。
    expect(now.sources.length).toBe(20);
    expect(now.pages.length).toBe(20);
  });

  it('300 页文献仍然装不下，必须切带（但带数远小于旧预算）', () => {
    const doc = fakeStore(300);
    const old = planReading(doc, 'd', documentPlan(), 1, 6000, 1);
    const now = planReading(doc, 'd', documentPlan(), 1, readingBatchBudget(store), 1);
    expect(now.batchCount).toBeGreaterThan(1);
    expect(now.batchCount).toBeLessThan(old.batchCount / 3);
  });

  it('预算越大带数越少，且切带顺序稳定（前缀缓存的前提）', () => {
    const doc = fakeStore(120);
    const a = planReading(doc, 'd', documentPlan(), 1, 40_000, 1);
    const b = planReading(doc, 'd', documentPlan(), 1, 80_000, 1);
    expect(b.batchCount).toBeLessThanOrEqual(a.batchCount);
    // 同一预算重复计算结果一致（带划分确定性，否则前缀缓存永远不命中）。
    const again = planReading(doc, 'd', documentPlan(), 1, 40_000, 1);
    expect(again.batches.map((group) => group.map(([index]) => index))).toEqual(
      a.batches.map((group) => group.map(([index]) => index))
    );
  });
});
