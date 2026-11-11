import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { SecretStore } from '../src/secrets.js';
import { Store } from '../src/store.js';
import {
  rank,
  localVectors,
  retrieve,
  clearRetrievalIndexCache,
  type ChunkRow
} from '../src/retrieval.js';
import {
  buildRetrievalIndex,
  localVectorsWithIndex,
  rankWithIndex
} from '../src/retrieval-index.js';

/**
 * 中文友好内存倒排索引：
 * - 排序/分数与全量 BM25/TF-IDF 逐值一致（不丢召回、不改变顺序）；
 * - 集成到 retrieve 后，索引缓存能跨查询复用，并在 chunks/派生数据变化后失效；
 * - 附带一个合成语料基准，记录索引路径相对全量路径的实测耗时（不做严格性能断言）。
 */

function closeTo(actual: number, expected: number, epsilon = 1e-9): void {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(epsilon);
}

const chunks: ChunkRow[] = [
  {
    id: 'a',
    documentId: 'doc-a',
    page: 1,
    name: '文献 A',
    text: '本地优先检索：价值信念在文中与单纯意见区分开。local retrieval value belief'
  },
  {
    id: 'b',
    documentId: 'doc-a',
    page: 2,
    name: '文献 A',
    text: '价值信念的测量口径见 §2，使用调查题项测量。measurement of value belief'
  },
  {
    id: 'c',
    documentId: 'doc-b',
    page: 1,
    name: '文献 B',
    text: '另一篇文献讨论 opinion 与 attitude，不直接讨论 value belief。'
  }
];

describe('内存倒排索引：与全量排序一致', () => {
  it('BM25 排序/分数与 rank() 完全一致', () => {
    const index = buildRetrievalIndex(chunks, 1)!;
    for (const query of ['价值信念', 'value belief', '测量口径', 'local retrieval']) {
      expect(rankWithIndex(query, index, 'doc-a', 1, 'close', 8)).toEqual(
        rank(query, chunks, 'doc-a', 1, 'close', 8)
      );
    }
  });

  it('本地 TF-IDF 余弦与 localVectors() 一致（含中文双字）', () => {
    const index = buildRetrievalIndex(chunks, 1)!;
    for (const query of ['价值信念', 'value belief', '测量口径']) {
      const indexed = localVectorsWithIndex(query, index, 8);
      const vectors = localVectors([query, ...chunks.map((chunk) => chunk.text)]);
      const queryVector = vectors[0]!;
      const exhaustive = chunks
        .map((chunk, index) => {
          const vector = vectors[index + 1]!;
          let score = 0;
          for (const [token, value] of queryVector) score += value * (vector.get(token) ?? 0);
          return { chunk, score };
        })
        .filter((row) => row.score > 0)
        .sort((left, right) => right.score - left.score)
        .slice(0, 8);
      expect(indexed.map((row) => row.id)).toEqual(exhaustive.map((row) => row.chunk.id));
      indexed.forEach((row, position) => {
        closeTo(row.score, exhaustive[position]!.score);
      });
    }
  });

  it('合成语料基准：索引路径结果一致，并记录冷/热耗时', () => {
    const synthetic: ChunkRow[] = [];
    for (let index = 0; index < 1500; index += 1) {
      const common = `第 ${index + 1} 段讨论价值信念的测量口径与本地检索优先策略。`;
      const english = `local retrieval value belief measurement paragraph ${index}`;
      const rare =
        index % 37 === 0
          ? '独特度量 uniquelymeasured 只在少数段落出现。'
          : '普通段落没有那个稀少术语。';
      synthetic.push({
        id: `s${index}`,
        documentId: `doc-${index % 20}`,
        page: (index % 200) + 1,
        name: `文献 ${index % 20}`,
        text: `${common} ${english} ${rare} ${'补充论述。'.repeat(6)}`
      });
    }
    const query = '独特度量 uniquelymeasured';
    const startedExhaustive = performance.now();
    const exhaustiveLexical = rank(query, synthetic, 'doc-1', 1, 'close', 8);
    const vectors = localVectors([query, ...synthetic.map((chunk) => chunk.text)]);
    const queryVector = vectors[0]!;
    const exhaustiveSemantic = synthetic
      .map((chunk, index) => {
        const vector = vectors[index + 1]!;
        let score = 0;
        for (const [token, value] of queryVector) score += value * (vector.get(token) ?? 0);
        return { chunk, score };
      })
      .filter((row) => row.score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, 8);
    const exhaustiveMs = performance.now() - startedExhaustive;

    const builtAt = performance.now();
    const index = buildRetrievalIndex(synthetic, 1)!;
    const buildMs = performance.now() - builtAt;
    const warmStarted = performance.now();
    const indexedLexical = rankWithIndex(query, index, 'doc-1', 1, 'close', 8);
    const indexedSemantic = localVectorsWithIndex(query, index, 8);
    const warmMs = performance.now() - warmStarted;

    expect(indexedLexical.map((row) => row.id)).toEqual(exhaustiveLexical.map((row) => row.id));
    expect(indexedSemantic.map((row) => row.id)).toEqual(exhaustiveSemantic.map((row) => row.chunk.id));
    console.log(
      `[retrieval-index] synthetic chunks=${synthetic.length} ` +
        `exhaustive=${exhaustiveMs.toFixed(1)}ms build=${buildMs.toFixed(1)}ms ` +
        `warm=${warmMs.toFixed(1)}ms（warm 不含建索引）`
    );
  });
});

describe('retrieve 索引缓存与失效', () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-retrieval-index-'));
  const store = new Store(dataDir);
  const secrets = new SecretStore();
  let documentId = '';
  let pageOne = '';

  afterEach(() => {
    clearRetrievalIndexCache();
  });

  afterAll(() => {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('首次检索建索引，重复检索命中缓存；页面文本修改后索引失效', async () => {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    for (let page = 1; page <= 4; page += 1) {
      const pdfPage = pdf.addPage([300, 400]);
      pdfPage.drawText(`page ${page} local retrieval value belief measurement`, {
        x: 20,
        y: 20,
        size: 9,
        font
      });
    }
    const file = path.join(dataDir, 'index.pdf');
    writeFileSync(file, await pdf.save());
    const document = await store.importDocument(file, undefined, true);
    documentId = document.id;
    pageOne = store.getPageText(documentId, 1);
    // 让第一页有可检索的中文正文（PDF 字体不嵌中文，用页面文本编辑注入）。
    await store.savePageTextEdit(
      documentId,
      1,
      '第一页：价值信念的测量口径是调查题项，本文讨论 value belief measurement。'
    );

    const first = await retrieve(store, secrets, '价值信念 测量口径', undefined, 1, 'close', 8);
    expect(first.length).toBeGreaterThan(0);
    expect(first[0]!.snippet).toContain('价值信念');
    const revisionAfterFirst = store.getRetrievalRevision();

    // 第二次（缓存命中）结果一致。
    const second = await retrieve(store, secrets, '价值信念 测量口径', undefined, 1, 'close', 8);
    expect(second).toEqual(first);

    // 修改页面文本：触发器递增 revision，索引必须重建，检索结果随之更新。
    await store.savePageTextEdit(
      documentId,
      1,
      '第一页已修改：现在讨论的是 opinion 与 attitude，不再出现旧主题词。'
    );
    expect(store.getRetrievalRevision()).toBeGreaterThan(revisionAfterFirst);
    const third = await retrieve(store, secrets, '价值信念 测量口径', undefined, 1, 'close', 8);
    const oldHits = third.filter((hit) => hit.snippet.includes('价值信念'));
    expect(oldHits).toHaveLength(0);
    const changed = await retrieve(store, secrets, 'opinion attitude', undefined, 1, 'close', 8);
    expect(changed.some((hit) => hit.snippet.includes('opinion'))).toBe(true);

    // 清缓存后（模拟首次冷查询）结果仍一致。
    clearRetrievalIndexCache();
    const cold = await retrieve(store, secrets, '价值信念 测量口径', undefined, 1, 'close', 8);
    expect(cold).toEqual(third);
  });
});
