import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import path from 'node:path';
import type { ChunkRow } from './retrieval.js';

/**
 * 检索索引的磁盘 token 缓存（原型）。
 *
 * 只缓存「每个 chunk 的 token 词频」，不缓存 chunk 正文；冷启动时仍需从 DB 读 chunks，
 * 但可以跳过逐 chunk 分词。文件按「作用域 + 检索版本」命名；加载时校验 revision 和每个
 * chunk 的文本 hash，任何不一致的 chunk 会被忽略（由调用方重新分词）。
 *
 * 该模块先用于体积/测速实验；是否接进运行时取决于基准结果。
 */

const CACHE_VERSION = 1;
const MAX_CACHE_ENTRIES = 1_000_000;
/** 单个作用域缓存文件上限：超过就不写/不读（避免冷启动解析超大 JSON 卡住）。 */
export const RETRIEVAL_TOKEN_CACHE_MAX_FILE_BYTES = 16 * 1024 * 1024;
/** 整个 cache/retrieval-index 目录的总预算，超过按 mtime 淘汰最旧文件。 */
export const RETRIEVAL_TOKEN_CACHE_MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const MAX_CACHE_FILES = 200;

export interface TokenCacheStats {
  file: string;
  bytes: number;
  entries: number;
}

/** 轻量文本 hash（djb2 + 长度），只用于缓存失效判断，不做安全用途。 */
export function retrievalTextHash(text: string): string {
  let hash = 5381;
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) + hash + text.charCodeAt(index)) | 0;
  }
  return `${(hash >>> 0).toString(36)}:${text.length}`;
}

function cacheFilePath(dataDir: string, cacheKey: string): string {
  const digest = createHash('sha1').update(cacheKey).digest('hex').slice(0, 24);
  return path.join(dataDir, 'cache', 'retrieval-index', `${digest}.json`);
}

interface SerializedCache {
  version: number;
  revision: string | number;
  entries: Array<{ id: string; hash: string; tokens: Array<[string, number]> }>;
}

/**
 * 保存 token 缓存；条目过多/无内容时不写。返回文件信息，未写返回 null。
 *
 * 同步写是为了原型测速简单；接进运行时前应改为异步/原子写并做体积上限策略。
 */
export function saveRetrievalTokenCache(options: {
  dataDir: string;
  cacheKey: string;
  revision: number | string;
  chunks: readonly ChunkRow[];
  tokenCounts: ReadonlyArray<Map<string, number>>;
  maxFileBytes?: number;
  maxTotalBytes?: number;
}): TokenCacheStats | null {
  const { dataDir, cacheKey, revision, chunks, tokenCounts } = options;
  if (chunks.length === 0 || chunks.length !== tokenCounts.length) return null;
  let entries = 0;
  for (const counts of tokenCounts) entries += counts.size;
  if (entries > MAX_CACHE_ENTRIES) return null;
  const serialized: SerializedCache = {
    version: CACHE_VERSION,
    revision,
    entries: chunks.map((chunk, index) => ({
      id: chunk.id,
      hash: retrievalTextHash(chunk.text),
      tokens: [...tokenCounts[index]!.entries()]
    }))
  };
  const file = cacheFilePath(dataDir, cacheKey);
  mkdirSync(path.dirname(file), { recursive: true });
  const payload = JSON.stringify(serialized);
  const bytes = Buffer.byteLength(payload, 'utf8');
  if (bytes > (options.maxFileBytes ?? RETRIEVAL_TOKEN_CACHE_MAX_FILE_BYTES)) {
    // 文件太大就不写；下次仍会重新分词，而不是让冷启动读一个巨型 JSON。
    return null;
  }
  const staging = `${file}.tmp`;
  writeFileSync(staging, payload, 'utf8');
  renameSync(staging, file);
  pruneRetrievalTokenCache(
    dataDir,
    options.maxTotalBytes ?? RETRIEVAL_TOKEN_CACHE_MAX_TOTAL_BYTES
  );
  return { file, bytes, entries };
}

/**
 * 清理 token 缓存目录：按 mtime 从新到旧保留，超过总字节预算/文件数就删除最旧；
 * 同时清掉崩溃留下的 .tmp。返回删除文件数与当前目录总字节数。
 */
export function pruneRetrievalTokenCache(
  dataDir: string,
  maxTotalBytes = RETRIEVAL_TOKEN_CACHE_MAX_TOTAL_BYTES
): { removed: number; bytes: number } {
  const folder = path.join(dataDir, 'cache', 'retrieval-index');
  let names: string[];
  try {
    names = readdirSync(folder);
  } catch {
    return { removed: 0, bytes: 0 };
  }
  const entries: Array<{ name: string; size: number; mtime: number }> = [];
  for (const name of names) {
    if (!name.endsWith('.json') && !name.endsWith('.tmp')) continue;
    try {
      const stat = statSync(path.join(folder, name));
      entries.push({ name, size: stat.size, mtime: stat.mtimeMs });
    } catch {
      // 文件刚被别处删除：跳过
    }
  }
  entries.sort((left, right) => right.mtime - left.mtime);
  let total = 0;
  let kept = 0;
  let removed = 0;
  for (const entry of entries) {
    const isTmp = entry.name.endsWith('.tmp');
    // 至少保留最新一份有效缓存：即使它本身超过总预算，也胜过一份都不留（功能退回重新分词）。
    if (!isTmp && kept === 0) {
      total += entry.size;
      kept += 1;
      continue;
    }
    const withinBudget = kept < MAX_CACHE_FILES && total + entry.size <= maxTotalBytes && !isTmp;
    if (withinBudget) {
      total += entry.size;
      kept += 1;
      continue;
    }
    try {
      unlinkSync(path.join(folder, entry.name));
      removed += 1;
    } catch {
      // 忽略删除失败（权限/竞态）
    }
  }
  return { removed, bytes: total };
}

/**
 * 读取 token 缓存；revision 不匹配/文件损坏/无命中返回 null。
 * 返回 Map<chunkId, tokenCounts>；调用方可按 id 取用，缺失的 chunk 重新分词。
 */
export function loadRetrievalTokenCache(options: {
  dataDir: string;
  cacheKey: string;
  revision: number | string;
  chunks: readonly ChunkRow[];
  maxFileBytes?: number;
}): Map<string, Map<string, number>> | null {
  const { dataDir, cacheKey, revision, chunks } = options;
  const file = cacheFilePath(dataDir, cacheKey);
  if (!existsSync(file)) return null;
  try {
    // 超大文件不读：宁可重新分词，也不让冷启动被巨型 JSON 卡住/爆内存。
    if (
      statSync(file).size >
      (options.maxFileBytes ?? RETRIEVAL_TOKEN_CACHE_MAX_FILE_BYTES)
    ) {
      return null;
    }
  } catch {
    return null;
  }
  let parsed: SerializedCache;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8')) as SerializedCache;
  } catch {
    return null;
  }
  if (parsed.version !== CACHE_VERSION || String(parsed.revision) !== String(revision)) {
    return null;
  }
  const cached = new Map<string, { hash: string; tokens: Map<string, number> }>();
  for (const entry of parsed.entries) {
    if (!entry || typeof entry.id !== 'string' || !Array.isArray(entry.tokens)) continue;
    cached.set(entry.id, {
      hash: typeof entry.hash === 'string' ? entry.hash : '',
      tokens: new Map(entry.tokens)
    });
  }
  const result = new Map<string, Map<string, number>>();
  for (const chunk of chunks) {
    const entry = cached.get(chunk.id);
    if (!entry) continue;
    if (entry.hash !== retrievalTextHash(chunk.text)) continue;
    result.set(chunk.id, entry.tokens);
  }
  return result.size > 0 ? result : null;
}
