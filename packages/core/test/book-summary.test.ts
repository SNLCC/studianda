import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bookSummaryPlan,
  documentContentVersion,
  planBookSummaryBlocks,
  readCachedBookSummary,
  resetBookSummary,
  runBookSummary
} from '../src/book-summary.js';
import { Store } from '../src/store.js';

/**
 * 全书摘要（Phase 2）：分层 + 缓存复用。
 *
 * - 分块：目录/结构树优先，没有就按固定页区间切；
 * - 已缓存且内容版本一致的分块不重复调用模型；
 * - 多块时逐级合并成全书摘要；
 * - 文档内容变化后缓存失效、只重算变化的部分。
 */

const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-book-summary-'));

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

let store: Store;

beforeEach(() => {
  store = new Store(dataDir);
});

afterEach(() => {
  store.close();
  vi.unstubAllGlobals();
});

async function makeDocument(totalPages: number, texts: Record<number, string>): Promise<string> {
  const pdf = await PDFDocument.create();
  for (let index = 0; index < totalPages; index += 1) pdf.addPage([595, 842]);
  const file = path.join(dataDir, `doc-${Math.random().toString(36).slice(2)}.pdf`);
  writeFileSync(file, await pdf.save());
  // 空白页 PDF 内容相同，需显式允许重复导入（第三参=true）。
  const document = await store.importDocument(file, `${path.basename(file)}.pdf`, true);
  for (const [page, text] of Object.entries(texts)) {
    await store.savePageTextEdit(document.id, Number(page), text);
  }
  return document.id;
}

function config() {
  return { baseUrl: 'https://model.test/v1', apiKey: 'k', model: 'summary-model' };
}

function mockModel(): Array<Record<string, unknown>> {
  const bodies: Array<Record<string, unknown>> = [];
  vi.stubGlobal('fetch', async (_input: unknown, init?: RequestInit) => {
    bodies.push(init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {});
    return new Response(
      JSON.stringify({ choices: [{ message: { content: '本章摘要内容' }, finish_reason: 'stop' }] }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  });
  return bodies;
}

describe('分块计划', () => {
  it('没有目录时按页区间切块，并覆盖全书页', async () => {
    const documentId = await makeDocument(45, { 1: '第一段', 21: '第二段', 41: '第三段' });
    const { blocks, source } = await planBookSummaryBlocks(store, documentId);
    expect(source).toBe('range');
    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toMatchObject({ page: 1, endPage: 20 });
    expect(blocks[1]).toMatchObject({ page: 21, endPage: 40 });
    expect(blocks[2]).toMatchObject({ page: 41, endPage: 45 });
  });

  it('分块页区间连续无缝', async () => {
    const documentId = await makeDocument(60, {});
    const { blocks } = await planBookSummaryBlocks(store, documentId);
    for (let index = 1; index < blocks.length; index += 1) {
      expect(blocks[index]!.page).toBe(blocks[index - 1]!.endPage + 1);
    }
    expect(blocks[blocks.length - 1]!.endPage).toBe(60);
  });
});

describe('分层生成与缓存复用', () => {
  it('首次生成：单块只调用一次，再跑复用缓存不再调用模型', async () => {
    const documentId = await makeDocument(3, { 1: '第一段原文', 2: '第二段原文' });
    const bodies = mockModel();
    const planBefore = await bookSummaryPlan(store, documentId, 'summary-model');
    expect(planBefore.estimate.pending_blocks).toBe(1);
    expect(planBefore.book_available).toBe(false);

    const first = await runBookSummary({ store, config: config(), documentId });
    expect(first.kind).toBe('book');
    expect(first.content).toContain('本章摘要');
    expect(bodies).toHaveLength(1);
    expect(readCachedBookSummary(store, documentId)?.content).toContain('本章摘要');

    const planAfter = await bookSummaryPlan(store, documentId, 'summary-model');
    expect(planAfter.cached).toBe(1);
    expect(planAfter.estimate.pending_blocks).toBe(0);
    expect(planAfter.estimate.calls).toBe(0);
    expect(planAfter.book_available).toBe(true);

    const second = await runBookSummary({ store, config: config(), documentId });
    expect(bodies).toHaveLength(1); // 仍然只有第一次那一次调用
    expect(second.content).toBe(first.content);
  });

  it('多块时逐级合并：每块一次 + 合并一次，然后缓存', async () => {
    const documentId = await makeDocument(45, { 1: '甲', 21: '乙', 41: '丙' });
    const bodies = mockModel();
    const result = await runBookSummary({ store, config: config(), documentId });
    // 3 个分块 + 1 次合并（3 块不超过合并组上限 8）。
    expect(bodies).toHaveLength(4);
    expect(result.merge_levels).toBe(1);
    expect(result.blocks).toHaveLength(3);
    expect(result.blocks.every((block) => block.cached)).toBe(true);
  });

  it('内容变化后缓存失效：只重算受影响的分块', async () => {
    const documentId = await makeDocument(45, { 1: '甲', 21: '乙', 41: '丙' });
    mockModel();
    await runBookSummary({ store, config: config(), documentId });
    const versionBefore = documentContentVersion(store, documentId);

    await store.savePageTextEdit(documentId, 1, '甲（用户校订后）');
    expect(documentContentVersion(store, documentId)).not.toBe(versionBefore);

    const plan = await bookSummaryPlan(store, documentId, 'summary-model');
    expect(plan.book_available).toBe(false);
    // 块级版本：只有第 1–20 页这一块变了，其余两块继续复用。
    expect(plan.cached).toBe(2);
    expect(plan.estimate.pending_blocks).toBe(1);
  });

  it('cachedOnly：没有缓存时明确报错，不调用模型', async () => {
    const documentId = await makeDocument(3, { 1: '原文' });
    const bodies = mockModel();
    await expect(
      runBookSummary({ store, config: config(), documentId, cachedOnly: true })
    ).rejects.toThrow('没有摘要缓存');
    expect(bodies).toHaveLength(0);
  });

  it('清空缓存后 plan 回到全新状态', async () => {
    const documentId = await makeDocument(3, { 1: '原文' });
    mockModel();
    await runBookSummary({ store, config: config(), documentId });
    resetBookSummary(store, documentId);
    const plan = await bookSummaryPlan(store, documentId, 'summary-model');
    expect(plan.cached).toBe(0);
    expect(plan.book_available).toBe(false);
  });
});

describe('成本估算', () => {
  it('已缓存的分块不计入待生成调用；合并调用按层计', async () => {
    const documentId = await makeDocument(25, { 1: '甲', 21: '乙' });
    mockModel();
    const before = await bookSummaryPlan(store, documentId, 'summary-model');
    expect(before.estimate.calls).toBeGreaterThan(before.estimate.pending_blocks);
    await runBookSummary({ store, config: config(), documentId });
    const after = await bookSummaryPlan(store, documentId, 'summary-model');
    expect(after.estimate.pending_blocks).toBe(0);
    expect(after.estimate.calls).toBe(0);
    expect(after.estimate.model).toBe('summary-model');
  });
});
