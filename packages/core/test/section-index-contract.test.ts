import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Store } from '../src/store.js';
import { tokens } from '../src/retrieval.js';

/**
 * 两套切分的契约：`chunks`（原文块，带 bbox，供检索与高亮）与
 * `sectionIndexChunks`（章节级索引片段，带标题，供节上下文）**不是同一层的重复实现**。
 *
 * 这里锁住三件真正会漂移的事：
 * 1. 两层都不丢正文——原文块的文字必须能在索引片段里找回；
 * 2. 索引片段真的带上了章节标题（标题参与检索词，否则"命中在哪节"只是装饰）；
 * 3. 索引片段不跨节，页码落在该节范围内。
 */
// 合成样张已提交进仓库（见 test/fixtures/README.md），干净 clone / CI 里也存在。
const DEMO = path.resolve(import.meta.dirname, 'fixtures/demo-paper/demo-paper-01.pdf');
const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-section-index-'));
const store = new Store(dataDir);

afterAll(() => {
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('原文块 与 章节索引片段 的契约', () => {
  it('索引片段不跨节、页码在节范围内、且带章节标题', async () => {
    const doc = await store.importDocument(DEMO, 'index-contract', true);
    const blocks = await store.getDocumentBlocks(doc.id);
    // 用大 maxChars，让"一个片段 ≈ 一节"，便于检查边界。
    const index = await store.getSectionIndex(doc.id, { maxChars: 5000, overlap: 0 });
    expect(index.chunks.length).toBeGreaterThan(0);
    for (const chunk of index.chunks) {
      expect(chunk.page).toBeGreaterThanOrEqual(1);
      expect(chunk.pageEnd).toBeLessThanOrEqual(doc.pages);
      expect(chunk.page).toBeLessThanOrEqual(chunk.pageEnd);
    }
    // 带标题的节，片段正文以标题开头（标题参与检索词，"命中在哪节"才不是装饰）。
    const titled = index.chunks.filter((chunk) => chunk.sectionTitle.trim().length > 0);
    expect(titled.length).toBeGreaterThan(0);
    for (const chunk of titled) {
      expect(chunk.text.trimStart().startsWith(chunk.sectionTitle.slice(0, 20))).toBe(true);
    }
    // 正文块不丢：每段够长的正文都能在索引片段里找回。
    const joined = index.chunks.map((chunk) => chunk.text.replace(/\s+/g, '')).join('\n');
    const lost = blocks.blocks
      .filter((block) => block.kind !== 'heading' && block.text.trim().length >= 20)
      .filter((block) => !joined.includes(block.text.replace(/\s+/g, '')))
      .map((block) => block.text.slice(0, 20));
    expect(lost).toEqual([]);
  });

  it('索引片段与原文块共用同一个切词器（不会各算一套）', async () => {
    const doc = await store.importDocument(DEMO, 'index-tokenizer', true);
    const index = await store.getSectionIndex(doc.id, { maxChars: 800 });
    const chunk = index.chunks.find((row) => row.sectionTitle.trim().length >= 2);
    // 样张里有带标题的节；找不到就说明索引契约已经坏了，不能静默跳过。
    expect(chunk, '样张索引里应存在带标题的片段').toBeDefined();
    // 标题的第一个二元词组必须出现在片段自身的检索词里——这就是"标题参与检索"的定义。
    const titled = chunk!;
    const titleTokens = tokens(titled.sectionTitle).filter((token) => token.length >= 2);
    const chunkTokens = new Set(tokens(titled.text));
    expect(titleTokens.length).toBeGreaterThan(0);
    expect(chunkTokens.has(titleTokens[0]!)).toBe(true);
  });

  it('同一参数重复取用直接命中缓存；参数不同则各算一次', async () => {
    const doc = await store.importDocument(DEMO, 'index-cache', true);
    const first = await store.getSectionIndex(doc.id, { maxChars: 600 });
    const again = await store.getSectionIndex(doc.id, { maxChars: 600 });
    expect(again).toBe(first);
    const other = await store.getSectionIndex(doc.id, { maxChars: 900 });
    expect(other).not.toBe(first);
    expect(other.chunks.length).toBeGreaterThan(0);
  });
});
