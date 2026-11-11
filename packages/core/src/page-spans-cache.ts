import { readFileSync, statSync } from 'node:fs';
import { extractPageSpans } from './pdf-layout.js';

/**
 * 页数据性能：
 * - 文本项（spans）提取要解析整份 PDF；同一页会被反复请求（缩放/滚动/重渲染），
 *   按「文件路径 + size + mtime + 页码」缓存结果，文件变化自动失效；
 * - 同时缓存最近一份 PDF 字节，避免翻页时每页都重新 readFileSync。
 *
 * 只缓存最近一个文件 + 最多 400 页，内存可控；命中率集中在"连续阅读同一篇文献"。
 */
const MAX_SPANS = 400;
const spanCache = new Map<string, Awaited<ReturnType<typeof extractPageSpans>>>();

let cachedPath = '';
let cachedStamp = '';
let cachedBytes: Uint8Array | null = null;

function pdfBytes(documentPath: string): Uint8Array {
  const stat = statSync(documentPath);
  const stamp = `${stat.size}:${stat.mtimeMs}`;
  if (cachedBytes && cachedPath === documentPath && cachedStamp === stamp) {
    return cachedBytes;
  }
  cachedBytes = new Uint8Array(readFileSync(documentPath));
  cachedPath = documentPath;
  cachedStamp = stamp;
  return cachedBytes;
}

export async function getPageSpans(
  documentPath: string,
  page: number
): Promise<Awaited<ReturnType<typeof extractPageSpans>>> {
  const stat = statSync(documentPath);
  const key = `${documentPath}|${stat.size}|${stat.mtimeMs}|${page}`;
  const hit = spanCache.get(key);
  if (hit) {
    // LRU：命中后移到队尾。
    spanCache.delete(key);
    spanCache.set(key, hit);
    return hit;
  }
  const info = await extractPageSpans(pdfBytes(documentPath), page);
  spanCache.set(key, info);
  while (spanCache.size > MAX_SPANS) {
    const oldest = spanCache.keys().next().value;
    if (oldest === undefined) break;
    spanCache.delete(oldest);
  }
  return info;
}
