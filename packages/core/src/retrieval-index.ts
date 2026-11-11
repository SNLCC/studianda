import type { ChunkRow } from './retrieval.js';
import { countTokens } from './retrieval-tokens.js';

/**
 * 中文友好的内存倒排索引（按 chunk 建 token → postings）。
 *
 * 为什么不用 SQLite FTS5 直接代替：现有 FTS5 用 trigram，中文双字查询（2 字）匹配不到；
 * unicode61 又把中文按单字切分，和检索的实际 token（中文双字 + 英文词）不一致。
 * 因此这里复用项目自己的分词器建倒排表，保证「中文双字」也能命中的同时**不改变召回/排序**：
 *
 * - 词表与 BM25/本地 TF-IDF 完全复用同一份 token 计数（不引入近似）；
 * - 候选集 = 至少含一个 query token 的 chunk（对 BM25/TF-IDF 来说，不含 query token 的
 *   chunk 分数必为 0，会被原逻辑过滤，所以候选集不丢正分结果）；
 * - document frequency 仍按全量 chunk 算（不是只在候选集里算），排序与原来逐值一致。
 */

export interface RetrievalPosting {
  chunk: number;
  tf: number;
}

export interface RetrievalIndex {
  /** 建索引时的 store 检索版本（单篇/多篇/全局的语义见 retrieval.ts）；用于缓存失效。 */
  revision: number | string;
  chunks: ChunkRow[];
  /** token → 含该 token 的 chunk 下标与词频。 */
  postings: Map<string, RetrievalPosting[]>;
  /** 每个 chunk 的 token 词频（候选 chunk 计算 TF-IDF 向量范数用）。 */
  tokenCounts: Map<string, number>[];
  /** 索引总条目数（token 出现次数去重后），用于内存上限判断。 */
  entries: number;
}

/** 单个索引最多容纳的去重 token 条目数；超过就不缓存，退回全量排序（控制内存）。 */
export const RETRIEVAL_INDEX_MAX_ENTRIES = 1_000_000;

export function buildRetrievalIndex(
  chunks: ChunkRow[],
  revision: number | string,
  precomputedTokenCounts?: ReadonlyMap<string, Map<string, number>>
): RetrievalIndex | null {
  const postings = new Map<string, RetrievalPosting[]>();
  const tokenCounts: Map<string, number>[] = [];
  let entries = 0;
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index]!;
    const counts = precomputedTokenCounts?.get(chunk.id) ?? countTokens(chunk.text);
    tokenCounts.push(counts);
    entries += counts.size;
    if (entries > RETRIEVAL_INDEX_MAX_ENTRIES) return null;
    for (const [token, tf] of counts) {
      const list = postings.get(token);
      if (list) list.push({ chunk: index, tf });
      else postings.set(token, [{ chunk: index, tf }]);
    }
  }
  return { revision, chunks, postings, tokenCounts, entries };
}

/** 用倒排索引复现 retrieval.rank 的 BM25 近似 + 页码邻近加权。 */
export function rankWithIndex(
  query: string,
  index: RetrievalIndex,
  documentId: string,
  page: number,
  mode: 'close' | 'wide',
  limit = 8
): Array<ChunkRow & { score: number }> {
  const queryCounts = countTokens(query);
  if (queryCounts.size === 0 || index.chunks.length === 0) return [];
  const candidates = new Set<number>();
  for (const token of queryCounts.keys()) {
    const postings = index.postings.get(token);
    if (!postings) continue;
    for (const posting of postings) candidates.add(posting.chunk);
  }
  const total = index.chunks.length;
  const results: Array<ChunkRow & { score: number }> = [];
  for (const chunkIndex of candidates) {
    const chunk = index.chunks[chunkIndex]!;
    const counts = index.tokenCounts[chunkIndex]!;
    let score = 0;
    for (const [token, value] of queryCounts) {
      const tf = counts.get(token) ?? 0;
      if (!tf) continue;
      const df = index.postings.get(token)?.length ?? 0;
      score +=
        (1 + Math.log(value)) *
        Math.log(1 + total / (1 + df)) *
        (tf / (tf + 1.2));
    }
    if (!score) continue;
    const same = chunk.documentId === documentId;
    const proximity = same ? 1 / (1 + Math.abs(chunk.page - page)) : 0;
    score *= 1 + (mode === 'close' ? 0.4 : 0.12) * proximity + (same ? 0.08 : 0);
    results.push({ ...chunk, score: Math.round(score * 10000) / 10000 });
  }
  return results.sort((left, right) => right.score - left.score).slice(0, limit);
}

/**
 * 用倒排索引复现 retrieval.localVectors 的 TF-IDF 余弦（只算正分候选）。
 *
 * 向量拟合时语料是 `[query, ...chunks]`，因此 query 里出现的 token 的 df 要 +1；
 * chunk 向量范数用该 chunk 的完整词频（不是只在 query token 上算），保证余弦值一致。
 */
export function localVectorsWithIndex(
  query: string,
  index: RetrievalIndex,
  limit = 8
): Array<ChunkRow & { score: number }> {
  const queryCounts = countTokens(query);
  if (queryCounts.size === 0 || index.chunks.length === 0) return [];
  const total = index.chunks.length + 1;
  const dfOf = (token: string): number =>
    (index.postings.get(token)?.length ?? 0) + (queryCounts.has(token) ? 1 : 0);
  const queryVector = new Map<string, number>();
  let queryNorm = 0;
  for (const [token, count] of queryCounts) {
    const idf = 1 + Math.log((1 + total) / (1 + dfOf(token)));
    const weight = (1 + Math.log(count)) * idf;
    queryVector.set(token, weight);
    queryNorm += weight * weight;
  }
  queryNorm = Math.sqrt(queryNorm) || 1;
  const candidates = new Set<number>();
  for (const token of queryCounts.keys()) {
    const postings = index.postings.get(token);
    if (!postings) continue;
    for (const posting of postings) candidates.add(posting.chunk);
  }
  const results: Array<ChunkRow & { score: number }> = [];
  for (const chunkIndex of candidates) {
    const counts = index.tokenCounts[chunkIndex]!;
    let dot = 0;
    for (const [token, weight] of queryVector) {
      const tf = counts.get(token) ?? 0;
      if (!tf) continue;
      const idf = 1 + Math.log((1 + total) / (1 + dfOf(token)));
      dot += weight * (1 + Math.log(tf)) * idf;
    }
    if (dot <= 0) continue;
    let norm = 0;
    for (const [token, tf] of counts) {
      const idf = 1 + Math.log((1 + total) / (1 + dfOf(token)));
      const weight = (1 + Math.log(tf)) * idf;
      norm += weight * weight;
    }
    const score = dot / (queryNorm * (Math.sqrt(norm) || 1));
    if (score <= 0) continue;
    results.push({ ...index.chunks[chunkIndex]!, score });
  }
  return results.sort((left, right) => right.score - left.score).slice(0, limit);
}
