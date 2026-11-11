import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { afterAll, describe, expect, it } from 'vitest';
import type { ChunkRow } from '../src/retrieval.js';
import { retrieve } from '../src/retrieval.js';
import { buildRetrievalIndex, rankWithIndex } from '../src/retrieval-index.js';
import { countTokens } from '../src/retrieval-tokens.js';
import { SecretStore } from '../src/secrets.js';
import { Store } from '../src/store.js';
import {
  loadRetrievalTokenCache,
  pruneRetrievalTokenCache,
  retrievalTextHash,
  saveRetrievalTokenCache
} from '../src/retrieval-token-cache.js';

/**
 * 检索 token 磁盘缓存原型：
 * - 保存/加载 roundtrip、revision/正文 hash 失效；
 * - 合成 1500 chunks 对比「重新分词」与「读磁盘缓存」的冷启动耗时/文件体积。
 */

const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-token-cache-'));
afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

function syntheticChunks(count: number): ChunkRow[] {
  const chunks: ChunkRow[] = [];
  for (let index = 0; index < count; index += 1) {
    const text =
      `第 ${index + 1} 段讨论价值信念的测量口径与本地检索优先策略。` +
      `local retrieval value belief measurement paragraph ${index}。` +
      '补充论述。'.repeat(6);
    chunks.push({
      id: `chunk-${index}`,
      documentId: `doc-${index % 20}`,
      page: (index % 200) + 1,
      name: `文献 ${index % 20}`,
      text
    });
  }
  return chunks;
}

describe('检索 token 磁盘缓存', () => {
  it('roundtrip 保留每个 chunk 的词频；revision 或正文变化时失效', () => {
    const chunks = syntheticChunks(20);
    const counts = chunks.map((chunk) => countTokens(chunk.text));
    const saved = saveRetrievalTokenCache({
      dataDir,
      cacheKey: 'roundtrip',
      revision: 1,
      chunks,
      tokenCounts: counts
    })!;
    expect(saved.entries).toBeGreaterThan(0);

    const loaded = loadRetrievalTokenCache({
      dataDir,
      cacheKey: 'roundtrip',
      revision: 1,
      chunks
    })!;
    expect(loaded.size).toBe(chunks.length);
    expect(loaded.get('chunk-0')).toEqual(counts[0]);

    // revision 变了：整份缓存失效。
    expect(
      loadRetrievalTokenCache({ dataDir, cacheKey: 'roundtrip', revision: 2, chunks })
    ).toBeNull();

    // 正文 hash 变了：只丢弃该 chunk，其它可继续用。
    const edited = chunks.map((chunk) =>
      chunk.id === 'chunk-0' ? { ...chunk, text: `${chunk.text} 已修改` } : chunk
    );
    const partial = loadRetrievalTokenCache({
      dataDir,
      cacheKey: 'roundtrip',
      revision: 1,
      chunks: edited
    });
    expect(partial?.has('chunk-0')).toBe(false);
    expect(partial?.has('chunk-1')).toBe(true);
    expect(retrievalTextHash(chunks[0]!.text)).not.toBe(retrievalTextHash(edited[0]!.text));
  });

  it('合成语料基准：读缓存 vs 重新分词（仅记录耗时/体积，不设严格阈值）', () => {
    const chunks = syntheticChunks(1500);
    const tokenizeStarted = performance.now();
    const freshCounts = chunks.map((chunk) => countTokens(chunk.text));
    const tokenizeMs = performance.now() - tokenizeStarted;
    const saveStarted = performance.now();
    const saved = saveRetrievalTokenCache({
      dataDir,
      cacheKey: 'benchmark',
      revision: 1,
      chunks,
      tokenCounts: freshCounts
    })!;
    const saveMs = performance.now() - saveStarted;

    const loadStarted = performance.now();
    const loaded = loadRetrievalTokenCache({
      dataDir,
      cacheKey: 'benchmark',
      revision: 1,
      chunks
    })!;
    const buildStarted = performance.now();
    const cachedIndex = buildRetrievalIndex(chunks, 1, loaded);
    const cachedBuildMs = performance.now() - loadStarted;
    const freshIndex = buildRetrievalIndex(chunks, 1);
    const freshBuildMs = performance.now() - buildStarted;

    expect(cachedIndex).not.toBeNull();
    expect(freshIndex).not.toBeNull();
    const query = '价值信念 测量口径';
    expect(rankWithIndex(query, cachedIndex!, 'doc-1', 1, 'close', 8)).toEqual(
      rankWithIndex(query, freshIndex!, 'doc-1', 1, 'close', 8)
    );
    console.log(
      `[token-cache] chunks=${chunks.length} tokenize=${tokenizeMs.toFixed(1)}ms ` +
        `save=${saveMs.toFixed(1)}ms file=${(saved.bytes / 1024 / 1024).toFixed(1)}MB ` +
        `load+build=${cachedBuildMs.toFixed(1)}ms freshBuild=${freshBuildMs.toFixed(1)}ms`
    );
  });

  it('retrieve 冷查询会写缓存；重启 Store 后仍能命中构建', async () => {
    const storeDir = mkdtempSync(path.join(tmpdir(), 'studianda-token-cache-store-'));
    let documentId = '';
    try {
      const first = new Store(storeDir);
      try {
        const pdf = await PDFDocument.create();
        const font = await pdf.embedFont(StandardFonts.Helvetica);
        const page = pdf.addPage([300, 400]);
        page.drawText('local retrieval value belief measurement', {
          x: 20,
          y: 20,
          size: 9,
          font
        });
        const file = path.join(storeDir, 'cache.pdf');
        writeFileSync(file, await pdf.save());
        documentId = (await first.importDocument(file, undefined, true)).id;
        await first.savePageTextEdit(
          documentId,
          1,
          '第一页：价值信念的测量口径与本地检索优先策略。local retrieval value belief'
        );
        const secrets = new SecretStore();
        const hits = await retrieve(first, secrets, '价值信念 测量口径', documentId, 1, 'close', 8);
        expect(hits.length).toBeGreaterThan(0);
        // 缓存写入放在 setImmediate，等它落盘。
        await new Promise((resolve) => setTimeout(resolve, 150));
        const cacheDir = path.join(storeDir, 'cache', 'retrieval-index');
        expect(existsSync(cacheDir)).toBe(true);
        expect(readdirSync(cacheDir).some((name) => name.endsWith('.json'))).toBe(true);
      } finally {
        first.close();
      }

      const reopened = new Store(storeDir);
      try {
        const hits = await retrieve(
          reopened,
          new SecretStore(),
          '价值信念 测量口径',
          documentId,
          1,
          'close',
          8
        );
        expect(hits.length).toBeGreaterThan(0);
      } finally {
        reopened.close();
      }
    } finally {
      rmSync(storeDir, { recursive: true, force: true });
    }
  });

  it('单文件超过字节上限不写；读取时超过上限也不读', () => {
    const chunks = syntheticChunks(20);
    const counts = chunks.map((chunk) => countTokens(chunk.text));
    expect(
      saveRetrievalTokenCache({
        dataDir,
        cacheKey: 'too-big',
        revision: 1,
        chunks,
        tokenCounts: counts,
        maxFileBytes: 64
      })
    ).toBeNull();

    const saved = saveRetrievalTokenCache({
      dataDir,
      cacheKey: 'size-check',
      revision: 1,
      chunks,
      tokenCounts: counts
    });
    expect(saved).not.toBeNull();
    expect(
      loadRetrievalTokenCache({
        dataDir,
        cacheKey: 'size-check',
        revision: 1,
        chunks,
        maxFileBytes: 64
      })
    ).toBeNull();
  });

  it('目录总预算按 mtime 淘汰旧作用域，保留最新缓存', () => {
    const chunks = syntheticChunks(10);
    const counts = chunks.map((chunk) => countTokens(chunk.text));
    const first = saveRetrievalTokenCache({
      dataDir,
      cacheKey: 'budget-old',
      revision: 1,
      chunks,
      tokenCounts: counts
    })!;
    const second = saveRetrievalTokenCache({
      dataDir,
      cacheKey: 'budget-new',
      revision: 1,
      chunks,
      tokenCounts: counts
    })!;
    // 不依赖两次写入的 mtime 恰好不同：显式把旧缓存改旧、新缓存改新再淘汰。
    const oldTime = new Date(Date.now() - 60_000);
    utimesSync(first.file, oldTime, oldTime);
    const newTime = new Date();
    utimesSync(second.file, newTime, newTime);
    const pruned = pruneRetrievalTokenCache(dataDir, first.bytes + 10);
    expect(
      loadRetrievalTokenCache({ dataDir, cacheKey: 'budget-new', revision: 1, chunks })
    ).not.toBeNull();
    expect(pruned.bytes).toBeLessThanOrEqual(first.bytes + 10);
  });

  it('缓存文件数有界：文献很多时只保留最近 200 份，不无限增长', () => {
    const manyDir = mkdtempSync(path.join(tmpdir(), 'studianda-token-cache-many-'));
    try {
      const folder = path.join(manyDir, 'cache', 'retrieval-index');
      mkdirSync(folder, { recursive: true });
      const base = Date.now() - 1_000_000;
      for (let index = 0; index < 210; index += 1) {
        const file = path.join(folder, `many-${index}.json`);
        writeFileSync(file, '{"version":1}');
        // 让 mtime 严格递增，确保淘汰顺序可预期。
        utimesSync(file, new Date(base + index * 1000), new Date(base + index * 1000));
      }
      const pruned = pruneRetrievalTokenCache(manyDir, Number.MAX_SAFE_INTEGER);
      expect(pruned.removed).toBe(10);
      const remaining = readdirSync(folder).filter((name) => name.endsWith('.json'));
      expect(remaining).toHaveLength(200);
      expect(remaining.includes('many-209.json')).toBe(true);
      expect(remaining.includes('many-0.json')).toBe(false);
    } finally {
      rmSync(manyDir, { recursive: true, force: true });
    }
  });
});
