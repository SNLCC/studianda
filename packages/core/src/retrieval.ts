import type { SearchHit } from '@studianda/shared';
import { getEmbeddingConfig, semanticRank, type SemanticChunk } from './embeddings.js';
import { rerankDocuments } from './rerank.js';
import type { SecretStore } from './secrets.js';
import type { Store } from './store.js';
import { countTokens, tokens } from './retrieval-tokens.js';
import {
  buildRetrievalIndex,
  localVectorsWithIndex,
  rankWithIndex,
  type RetrievalIndex
} from './retrieval-index.js';
import {
  loadRetrievalTokenCache,
  saveRetrievalTokenCache
} from './retrieval-token-cache.js';

export { tokens } from './retrieval-tokens.js';

/** 本机向量：语料拟合 TF-IDF 稀疏向量。 */
export function localVectors(
  texts: string[],
  precomputedCounts?: Array<Map<string, number>>
): Array<Map<string, number>> {
  // retrieve 里同一批 chunks 已经为 BM25 数过词频，这里复用，避免一次检索把每个 chunk 数两遍。
  const counts = precomputedCounts ?? texts.map((text) => countTokens(text));
  const df = new Map<string, number>();
  for (const count of counts) {
    for (const token of count.keys()) df.set(token, (df.get(token) ?? 0) + 1);
  }
  return counts.map((count) => {
    const vector = new Map<string, number>();
    for (const [token, value] of count) {
      const idf = 1 + Math.log((1 + texts.length) / (1 + (df.get(token) ?? 0)));
      vector.set(token, (1 + Math.log(value)) * idf);
    }
    let norm = 0;
    for (const value of vector.values()) norm += value * value;
    norm = Math.sqrt(norm) || 1;
    for (const [token, value] of vector) vector.set(token, value / norm);
    return vector;
  });
}

function dot(left: Map<string, number>, right: Map<string, number>): number {
  let score = 0;
  for (const [token, value] of left) {
    score += value * (right.get(token) ?? 0);
  }
  return score;
}

export interface ChunkRow {
  id: string;
  documentId: string;
  page: number;
  text: string;
  name: string;
  derived?: boolean;
  translation?: boolean;
  sourceText?: string;
  segment?: number;
  edited?: boolean;
  translation_id?: string;
  engine?: string;
  warning?: string;
}

function rowsFor(store: Store, documentId?: string, documentIds?: string[]): ChunkRow[] {
  const names = new Map<string, string>();
  const rows = documentIds
    ? store.listChunks().filter((chunk) => documentIds.includes(chunk.documentId))
    : store.listChunks(documentId);
  return rows.map((chunk) => {
    let name = names.get(chunk.documentId);
    if (!name) {
      name = store.getDocument(chunk.documentId)?.name ?? '';
      names.set(chunk.documentId, name);
    }
    return { id: chunk.id, documentId: chunk.documentId, page: chunk.page, text: chunk.text, name };
  });
}

function derivedRows(store: Store, documentIds: string[]): ChunkRow[] {
  const names = new Map<string, string>();
  return store.listDerivedChunks(documentIds).map((chunk) => {
    let name = names.get(chunk.documentId);
    if (!name) {
      name = store.getDocument(chunk.documentId)?.name ?? '';
      names.set(chunk.documentId, name);
    }
    return {
      id: chunk.id,
      documentId: chunk.documentId,
      page: chunk.page,
      text: chunk.text,
      name,
      derived: chunk.derived,
      translation: chunk.translation,
      sourceText: chunk.sourceText,
      segment: chunk.segment,
      edited: chunk.edited,
      translation_id: chunk.translation_id,
      engine: chunk.engine
    };
  });
}

/** 检索排名：BM25 近似 + 页码邻近加权。 */
export function rank(
  query: string,
  chunks: ChunkRow[],
  documentId: string,
  page: number,
  mode: 'close' | 'wide',
  limit = 8,
  precomputedCounts?: Array<Map<string, number>>
): Array<ChunkRow & { score: number }> {
  const queryCounts = countTokens(query);
  if (queryCounts.size === 0 || chunks.length === 0) return [];
  // 同一批 chunks 的 token 计数在 retrieve 里还会被 localVectors 复用（见下）。
  const counts = precomputedCounts ?? chunks.map((chunk) => countTokens(chunk.text));
  const frequencies = new Map<string, number>();
  for (const count of counts) {
    for (const token of count.keys()) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
  }
  const results: Array<ChunkRow & { score: number }> = [];
  chunks.forEach((chunk, index) => {
    const count = counts[index] as Map<string, number>;
    let score = 0;
    for (const [token, value] of queryCounts) {
      const tf = count.get(token) ?? 0;
      if (!tf) continue;
      score +=
        (1 + Math.log(value)) *
        Math.log(1 + chunks.length / (1 + (frequencies.get(token) ?? 0))) *
        (tf / (tf + 1.2));
    }
    if (!score) return;
    const same = chunk.documentId === documentId;
    const proximity = same ? 1 / (1 + Math.abs(chunk.page - page)) : 0;
    score *= 1 + (mode === 'close' ? 0.4 : 0.12) * proximity + (same ? 0.08 : 0);
    results.push({ ...chunk, score: Math.round(score * 10000) / 10000 });
  });
  return results.sort((left, right) => right.score - left.score).slice(0, limit);
}

/** 本机重排：只调整顺序，保留原有 score 字段。 */
export function localRerank(
  query: string,
  chunks: Array<ChunkRow & { score: number }>,
  limit = 8
): Array<ChunkRow & { score: number }> {
  const terms = new Set(tokens(query));
  const scored = chunks.map((chunk, index) => {
    const chunkTokens = new Set(tokens(chunk.text));
    let covered = 0;
    for (const term of terms) if (chunkTokens.has(term)) covered += 1;
    const coverage = terms.size ? covered / terms.size : 0;
    const phrase =
      query.trim().length > 0 && chunk.text.toLowerCase().includes(query.trim().toLowerCase())
        ? 0.2
        : 0;
    return { chunk, order: coverage + phrase + 0.1 / (index + 1) };
  });
  scored.sort((left, right) => right.order - left.order);
  return scored.slice(0, limit).map(({ chunk }) => chunk);
}

function toHit(chunk: ChunkRow & { score: number }): SearchHit {
  return {
    chunkId: chunk.id,
    documentId: chunk.documentId,
    documentName: chunk.name,
    page: chunk.page,
    snippet: chunk.text.slice(0, 240),
    score: chunk.score,
    derived: chunk.derived,
    translation: chunk.translation,
    sourceText: chunk.sourceText,
    segment: chunk.segment,
    edited: chunk.edited,
    translation_id: chunk.translation_id,
    engine: chunk.engine,
    warning: chunk.warning
  };
}

/** 检索索引缓存：按「作用域 + 检索版本」缓存；最多保留 2 个作用域，并共享 150 万条目预算。 */
interface RetrievalIndexCacheEntry {
  revision: number | string;
  chunks: ChunkRow[];
  index: RetrievalIndex;
  entries: number;
}

const retrievalIndexCache = new Map<string, RetrievalIndexCacheEntry>();
const RETRIEVAL_INDEX_CACHE_SCOPES = 2;
const RETRIEVAL_INDEX_CACHE_MAX_ENTRIES = 1_500_000;

/** 测试/调试用：清空检索索引缓存（不清 DB）。 */
export function clearRetrievalIndexCache(): void {
  retrievalIndexCache.clear();
}

function scopeCacheKey(
  store: Store,
  documentId: string | undefined,
  scopeDocumentIds: string[] | undefined,
  includeDerived: boolean
): string {
  return `${store.dataDir}|${documentId ?? ''}|${(scopeDocumentIds ?? [])
    .slice()
    .sort()
    .join(',')}|${includeDerived ? 1 : 0}`;
}

/**
 * 计算作用域对应的检索版本：
 * - 单篇文献：该文献版本；
 * - 显式多文献 scope：所选文献版本按 id 排序拼接（只受这些文献影响）；
 * - 全库：全局版本。
 * 测试/外部 store 桩没有版本方法时返回 -1（调用方据此关闭缓存）。
 */
export function retrievalRevisionForScope(
  store: Store,
  documentId?: string,
  scopeDocumentIds?: string[]
): number | string {
  if (documentId && !(scopeDocumentIds && scopeDocumentIds.length > 0)) {
    if (typeof store.getDocumentRetrievalRevision !== 'function') return -1;
    return store.getDocumentRetrievalRevision(documentId);
  }
  if (scopeDocumentIds && scopeDocumentIds.length > 0) {
    if (typeof store.getDocumentRetrievalRevisions !== 'function') return -1;
    const revisions = store.getDocumentRetrievalRevisions(scopeDocumentIds);
    return [...scopeDocumentIds]
      .slice()
      .sort()
      .map((id) => `${id}:${revisions[id] ?? 0}`)
      .join('|');
  }
  return typeof store.getRetrievalRevision === 'function' ? store.getRetrievalRevision() : -1;
}

/**
 * 预热单篇文献的检索索引（打开文献后在后台调用，减少第一问的冷启动分词）。
 *
 * 返回缓存的 token 条目数；文献不存在/索引超上限/嵌入模式不适合本地索引时返回 0。
 * 只使用本地内存索引，不持久化、不跨进程；重复调用命中缓存时直接返回。
 */
export function warmRetrievalIndex(store: Store, documentId: string): number {
  if (!documentId || !store.getDocument(documentId)) return 0;
  const includeDerived = true;
  const cacheKey = scopeCacheKey(store, documentId, undefined, includeDerived);
  const revision = retrievalRevisionForScope(store, documentId);
  if (revision === -1) return 0;
  const cached = retrievalIndexCache.get(cacheKey);
  if (cached && cached.revision === revision) return cached.entries;
  const chunks = rowsFor(store, documentId, undefined);
  const derived = derivedRows(store, [documentId]);
  const allChunks = [
    ...chunks,
    ...derived.filter((row) => !chunks.some((chunk) => chunk.id === row.id))
  ];
  if (allChunks.length === 0) return 0;
  const built = buildIndexWithDiskCache(store, cacheKey, revision, allChunks);
  if (!built) return 0;
  retrievalIndexCache.set(cacheKey, {
    revision,
    chunks: allChunks,
    index: built,
    entries: built.entries
  });
  evictRetrievalIndexCache(cacheKey);
  return built.entries;
}

function evictRetrievalIndexCache(protectedKey: string): void {
  for (;;) {
    const totalEntries = [...retrievalIndexCache.values()].reduce(
      (sum, entry) => sum + entry.entries,
      0
    );
    if (
      retrievalIndexCache.size <= RETRIEVAL_INDEX_CACHE_SCOPES &&
      totalEntries <= RETRIEVAL_INDEX_CACHE_MAX_ENTRIES
    ) {
      return;
    }
    const oldest = retrievalIndexCache.keys().next().value as string | undefined;
    if (oldest === undefined || oldest === protectedKey) return;
    retrievalIndexCache.delete(oldest);
  }
}

/**
 * 建索引时优先读磁盘 token 缓存；缺失的 chunk 当场分词，构建完成后异步回写缓存。
 *
 * 缓存文件只存 token 词频、不存正文；revision/正文 hash 不匹配会自动重新分词。
 */
function buildIndexWithDiskCache(
  store: Store,
  cacheKey: string,
  revision: number | string,
  chunks: ChunkRow[]
): RetrievalIndex | null {
  const cachedTokens = loadRetrievalTokenCache({
    dataDir: store.dataDir,
    cacheKey,
    revision,
    chunks
  });
  const built = buildRetrievalIndex(chunks, revision, cachedTokens ?? undefined);
  if (!built) return null;
  if (!cachedTokens || cachedTokens.size < chunks.length) {
    // 不阻塞当前回答：写盘放在下一个事件循环；失败只影响下次冷启动速度。
    setImmediate(() => {
      try {
        saveRetrievalTokenCache({
          dataDir: store.dataDir,
          cacheKey,
          revision,
          chunks,
          tokenCounts: built.tokenCounts
        });
      } catch {
        // 缓存写入失败不影响检索
      }
    });
  }
  return built;
}

export async function retrieve(
  store: Store,
  secrets: SecretStore,
  query: string,
  documentId?: string,
  page = 1,
  mode: 'close' | 'wide' = 'close',
  limit = 20,
  options: {
    selection?: string;
    scopeDocumentIds?: string[];
    includeDerived?: boolean;
  } = {}
): Promise<SearchHit[]> {
  const queryText = options.selection?.trim()
    ? `${query}\n${options.selection}`
    : query;
  const config = getEmbeddingConfig(store, secrets);
  const includeDerived = options.includeDerived !== false;
  const cacheKey = scopeCacheKey(store, documentId, options.scopeDocumentIds, includeDerived);
  // 测试/外部注入的 store 桩可能没有版本号：此时不启用索引缓存，行为退回优化前。
  const revision = retrievalRevisionForScope(store, documentId, options.scopeDocumentIds);
  const cacheable = revision !== -1 && typeof store.dataDir === 'string';
  const cached = cacheable && !config.enabled ? retrievalIndexCache.get(cacheKey) : undefined;
  let allChunks: ChunkRow[];
  let index: RetrievalIndex | null = null;
  if (cached && cached.revision === revision) {
    // 命中索引缓存：不再读 chunks/派生行，也不再逐 chunk 分词。
    allChunks = cached.chunks;
    index = cached.index;
  } else {
    const chunks = rowsFor(
      store,
      options.scopeDocumentIds ? undefined : documentId,
      options.scopeDocumentIds
    );
    const derivedDocumentIds = options.scopeDocumentIds ?? (documentId ? [documentId] : []);
    const derived = includeDerived ? derivedRows(store, derivedDocumentIds) : [];
    allChunks = [
      ...chunks,
      ...derived.filter((row) => !chunks.some((chunk) => chunk.id === row.id))
    ];
    if (allChunks.length === 0) return [];
    if (cacheable && !config.enabled) {
      const built = buildIndexWithDiskCache(store, cacheKey, revision, allChunks);
      if (built) {
        index = built;
        retrievalIndexCache.set(cacheKey, {
          revision,
          chunks: allChunks,
          index: built,
          entries: built.entries
        });
        // 同时限制作用域数量与总 token 条目数，避免多个大索引叠加占内存。
        evictRetrievalIndexCache(cacheKey);
      }
    }
  }
  if (allChunks.length === 0) return [];

  let lexical: Array<ChunkRow & { score: number }>;
  let semantic: Array<ChunkRow & { score: number }> = [];
  let retrievalWarning = '';
  if (index) {
    lexical = rankWithIndex(queryText, index, documentId ?? '', page, mode, limit);
    semantic = localVectorsWithIndex(queryText, index, limit);
  } else {
    // 外部 embedding 或索引超出内存上限：退回原全量排序（行为与优化前一致）。
    const chunkCounts = allChunks.map((chunk) => countTokens(chunk.text));
    lexical = rank(queryText, allChunks, documentId ?? '', page, mode, limit, chunkCounts);
    if (!config.enabled) {
      const vectors = localVectors(
        [queryText, ...allChunks.map((chunk) => chunk.text)],
        [countTokens(queryText), ...chunkCounts]
      );
      const queryVector = vectors[0] as Map<string, number>;
      semantic = allChunks
        .map((chunk, index) => ({
          ...chunk,
          score: dot(queryVector, vectors[index + 1] as Map<string, number>)
        }))
        .filter((chunk) => chunk.score > 0)
        .sort((left, right) => right.score - left.score)
        .slice(0, limit);
    }
  }
  if (config.enabled) {
    try {
      const semanticChunks: SemanticChunk[] = allChunks.map((chunk) => ({
        id: chunk.id,
        text: chunk.text,
        documentId: chunk.documentId,
        page: chunk.page
      }));
      const ranked = await semanticRank(
        store,
        secrets,
        queryText,
        semanticChunks,
        documentId ?? '',
        page,
        mode,
        limit
      );
      semantic = ranked.map((item) => ({
        ...(allChunks.find((chunk) => chunk.id === item.id) as ChunkRow),
        score: item.score
      }));
    } catch {
      retrievalWarning =
        '外部语义检索暂不可用，已使用本地关键词；局部阅读将扩大原文范围。';
    }
  }

  // Reciprocal-rank fusion。
  const merged = new Map<string, ChunkRow & { score: number }>();
  for (const ranking of [semantic, lexical]) {
    ranking.forEach((row, index) => {
      const existing = merged.get(row.id);
      if (!existing) merged.set(row.id, { ...row, score: 0 });
      const current = merged.get(row.id) as ChunkRow & { score: number };
      current.score += 1 / (60 + index + 1);
    });
  }
  let results = [...merged.values()].sort((left, right) => right.score - left.score);

  const rerankOrder = await rerankDocuments(
    store,
    secrets,
    queryText,
    results.map((row) => row.text)
  );
  if (rerankOrder) {
    const head = rerankOrder
      .map((index) => results[index])
      .filter((row): row is ChunkRow & { score: number } => Boolean(row));
    const seen = new Set(head.map((row) => row.id));
    results = [...head, ...results.filter((row) => !seen.has(row.id))];
  } else {
    results = localRerank(queryText, results, limit);
  }

  return results.slice(0, Math.max(1, limit)).map((row) => ({
    ...toHit({
      ...row,
      score: Math.round(row.score * 10000) / 10000,
      warning: retrievalWarning || row.warning
    }),
    // 命中行锚点：前端据此高亮命中文字，而不是只显示 chunk 开头。
    match: matchedExcerpt(row.text, queryText)
  }));
}

/**
 * 命中词所在的整行摘录：
 * 先按原样大小写不敏感匹配；查询被换行/空格拆开时，去掉空白后再定位。
 * 没命中时退回首行，只做前缀截断，不编造上下文。
 */
export function matchedExcerpt(text: string, query: string, limit = 240): string {
  const source = text ?? '';
  const needle = (query ?? '').trim();
  let span: [number, number] | null = null;
  if (needle) {
    const lowerSource = source.toLowerCase();
    const index = lowerSource.indexOf(needle.toLowerCase());
    if (index >= 0) {
      span = [index, index + needle.length];
    } else {
      const squashed = needle.replace(/\s+/g, '');
      if (squashed) {
        const positions: number[] = [];
        for (let index = 0; index < source.length; index += 1) {
          if (!/\s/u.test(source[index]!)) positions.push(index);
        }
        const squashedSource = positions.map((position) => source[position]!.toLowerCase()).join('');
        const squashedIndex = squashedSource.indexOf(squashed.toLowerCase());
        if (squashedIndex >= 0) {
          const start = positions[squashedIndex]!;
          const end = positions[Math.min(squashedIndex + squashed.length, positions.length) - 1]! + 1;
          span = [start, end];
        }
      }
    }
  }
  if (span) {
    const [start, end] = span;
    const left = source.lastIndexOf('\n', start - 1);
    const right = source.indexOf('\n', end);
    const lineStart = left < 0 ? 0 : left + 1;
    const lineEnd = right < 0 ? source.length : right;
    const excerpt = source.slice(lineStart, lineEnd).trim();
    if (excerpt.length <= limit) return excerpt;
    const centre = Math.floor((start + end) / 2) - lineStart;
    const half = Math.floor(limit / 2);
    return source
      .slice(lineStart + Math.max(0, centre - half), lineStart + centre + half)
      .trim();
  }
  return (source.split(/\r?\n/)[0] ?? '').trim().slice(0, limit);
}
