import { createHash } from 'node:crypto';
import type {
  BookSummaryBlock,
  BookSummaryEstimate,
  BookSummaryPlan,
  BookSummaryResult
} from '@studianda/shared';
import { callChatModel, type ReadingChatConfig } from './reading-chat.js';
import { chapterOutline, chaptersFromLocalNavigation, type ChapterRange } from './chapters.js';
import { cost } from './reading.js';
import type { BookSummaryRow, Store } from './store.js';

/**
 * 全书摘要：分层生成 + 持久缓存 + 增量复用。
 *
 * - 分块优先用书籍目录（章）；没有目录时按固定页区间切（每 20 页）；
 * - 已缓存且内容版本一致的分块**不再调用模型**（只看已读内容不重复付费）；
 * - 每块摘要控制得很短（约 400 token），再逐级合并（每 8 块一层）成全书摘要；
 * - 合并结果按内容版本缓存：文档没变时再问「概括全书」几乎零成本；
 * - 所有调用都走 `task=true`：由「分析模型」承接（低思考深度），不占写作模型的回答预算。
 */

/** 摘要提示词版本：改了提示词就换号，旧缓存自动视为过期。 */
export const BOOK_SUMMARY_PROMPT_VERSION = 1;

const SUMMARY_SYSTEM =
  '你是学术文献的摘要助手。用户会给你一本书中某一章（或某一段页区间）的原文。' +
  '请输出该部分的中文摘要：先用一句话概括主旨，再列出 3–6 条要点，保留关键概念、论证与结论；' +
  '只依据给出的原文，不要编造原文没有的内容，不要做全书评价，不要输出与摘要无关的说明。' +
  '不要整段复制原文：以概括为主，必要的引用不超过一两句短句；不要输出可替代原文的长段内容。' +
  '输出不要用 Markdown 标题，直接用短段落与编号要点。';

const CHUNK_SYSTEM =
  '你是学术文献的摘要助手。下面是一章原文的一个分段。请概括这一分段的要点，' +
  '保留关键概念与结论；只依据原文，不要编造，也不要评价；不要整段复制原文，必要引用不超过一两句短句。' +
  '输出 2–5 条要点。';

const MERGE_SYSTEM =
  '你是学术文献的摘要助手。下面给出同一本书不同章节（或不同部分）的摘要。' +
  '请合并成一份连贯的中文全书摘要：先写一段总述（研究问题、核心论点与全书结构），' +
  '再按部分列出要点，并保留页码范围（写成“第 X–Y 页”）；只依据给出的摘要，不要编造，' +
  '不要整段复制摘要或原文，不要输出与摘要无关的说明。输出不要用 Markdown 标题。';

const BLOCK_MERGE_SYSTEM =
  '你是学术文献的摘要助手。下面给出同一章不同分段的摘要。请合并成本章摘要：' +
  '先用一句话概括本章主旨，再列 3–6 条要点；只依据给出的摘要，不要编造，不要整段复制。';

const SUMMARY_MAX_TOKENS = 420;
const MERGE_MAX_TOKENS = 900;
const FINAL_MERGE_MAX_TOKENS = 1500;
/** 单次送入模型的原文材料上限（token 估算口径）。 */
const CHUNK_TOKEN_BUDGET = 9000;
const MERGE_GROUP = 8;
const FALLBACK_BLOCK_PAGES = 20;
const MAX_BLOCKS = 120;
const TITLE_LIMIT = 60;

export interface SummaryBlockSpec {
  index: number;
  title: string;
  page: number;
  endPage: number;
  key: string;
}

function rangeBlocks(pages: number): SummaryBlockSpec[] {
  const blocks: SummaryBlockSpec[] = [];
  for (let start = 1; start <= pages; start += FALLBACK_BLOCK_PAGES) {
    const endPage = Math.min(pages, start + FALLBACK_BLOCK_PAGES - 1);
    blocks.push({
      index: blocks.length + 1,
      title: `第 ${start}–${endPage} 页`,
      page: start,
      endPage,
      key: `${start}-${endPage}`
    });
  }
  return blocks;
}

/** 补齐目录缺口（前言/附录等没有目录项的页），保证全书页都被覆盖。 */
function fillGaps(blocks: SummaryBlockSpec[], pages: number): SummaryBlockSpec[] {
  const sorted = [...blocks]
    .filter((block) => block.endPage >= block.page)
    .sort((left, right) => left.page - right.page);
  const filled: SummaryBlockSpec[] = [];
  let nextPage = 1;
  for (const block of sorted) {
    const start = Math.max(block.page, nextPage);
    if (start > nextPage) {
      const endPage = start - 1;
      filled.push({
        index: 0,
        title: `第 ${nextPage}–${endPage} 页`,
        page: nextPage,
        endPage,
        key: `${nextPage}-${endPage}`
      });
    }
    if (block.endPage >= start) {
      filled.push({
        ...block,
        page: start,
        key: `${start}-${block.endPage}`
      });
      nextPage = block.endPage + 1;
    }
    if (nextPage > pages) break;
  }
  if (nextPage <= pages) {
    filled.push({
      index: 0,
      title: `第 ${nextPage}–${pages} 页`,
      page: nextPage,
      endPage: pages,
      key: `${nextPage}-${pages}`
    });
  }
  return filled.map((block, index) => ({ ...block, index: index + 1 })).slice(0, MAX_BLOCKS);
}

/**
 * 分块计划：本地目录优先，其次结构树，最后按固定页区间切。
 * 只读本地结构，不调用模型。
 */
export async function planBookSummaryBlocks(
  store: Store,
  documentId: string
): Promise<{ blocks: SummaryBlockSpec[]; source: 'navigation' | 'structure' | 'range' }> {
  const document = store.getDocument(documentId);
  if (!document) throw new Error('文献不存在');
  const pages = document.pages;
  if (!Number.isInteger(pages) || pages < 1) {
    return { blocks: [], source: 'range' };
  }
  let chapters: ChapterRange[] = [];
  try {
    chapters = await chaptersFromLocalNavigation(store, documentId, pages);
  } catch {
    chapters = [];
  }
  let source: 'navigation' | 'structure' | 'range' = 'range';
  if (chapters.length >= 2) {
    source = 'navigation';
  } else {
    try {
      const tree = await store.getStructure(documentId);
      chapters = chapterOutline(tree, pages);
      if (chapters.length >= 2) source = 'structure';
    } catch {
      chapters = [];
    }
  }
  if (chapters.length < 2) {
    return { blocks: rangeBlocks(pages), source: 'range' };
  }
  const blocks = chapters.map((chapter) => ({
    index: chapter.index,
    title: chapter.title.replace(/\s+/g, ' ').trim().slice(0, TITLE_LIMIT) || `第 ${chapter.index} 章`,
    page: chapter.page,
    endPage: chapter.endPage,
    key: `${chapter.page}-${chapter.endPage}`
  }));
  return { blocks: fillGaps(blocks, pages), source };
}

/**
 * 文档内容版本：页数与每页文本的哈希。
 *
 * 只用于判断摘要缓存是否还有效；不在任何地方当作文献原文或证据。
 */
export function documentContentVersion(store: Store, documentId: string): string {
  const document = store.getDocument(documentId);
  if (!document) return '';
  const hash = createHash('sha256');
  hash.update(`${document.pages}:${document.sha256 ?? ''}\n`);
  for (let page = 1; page <= document.pages; page += 1) {
    const text = store.getPageText(documentId, page);
    hash.update(`${page}:${text.length}:${text}\n`);
  }
  return hash.digest('hex').slice(0, 32);
}

function cachedBlockMap(
  store: Store,
  documentId: string,
  blocks: SummaryBlockSpec[]
): Map<string, BookSummaryRow> {
  const rows = store.listBookSummaries(documentId).filter(
    (row) => row.scope === 'block' && row.promptVersion === BOOK_SUMMARY_PROMPT_VERSION
  );
  const byKey = new Map(rows.map((row) => [row.blockKey, row]));
  const map = new Map<string, BookSummaryRow>();
  for (const block of blocks) {
    const row = byKey.get(block.key);
    if (!row) continue;
    // 块级版本：只有这一块的内容变了才重算，其它块继续复用。
    if (row.contentVersion !== blockContentVersion(store, documentId, block)) continue;
    map.set(block.key, row);
  }
  return map;
}

/** 单个分块（章/页区间）的内容版本：只受该范围内页面文本影响。 */
function blockContentVersion(
  store: Store,
  documentId: string,
  block: SummaryBlockSpec
): string {
  const hash = createHash('sha256');
  hash.update(`${documentId}:${block.page}-${block.endPage}\n`);
  for (let page = block.page; page <= block.endPage; page += 1) {
    const text = store.getPageText(documentId, page);
    hash.update(`${page}:${text.length}:${text}\n`);
  }
  return hash.digest('hex').slice(0, 32);
}

function bookRowOf(
  store: Store,
  documentId: string,
  contentVersion: string
): BookSummaryRow | null {
  for (const row of store.listBookSummaries(documentId)) {
    if (row.scope !== 'book') continue;
    if (row.contentVersion !== contentVersion) continue;
    if (row.promptVersion !== BOOK_SUMMARY_PROMPT_VERSION) continue;
    return row;
  }
  return null;
}

function blockTextCost(store: Store, documentId: string, block: SummaryBlockSpec): number {
  let total = 0;
  for (let page = block.page; page <= block.endPage; page += 1) {
    total += cost(store.getPageText(documentId, page));
  }
  return total;
}

function blockCallCount(textCost: number): number {
  const chunks = Math.max(1, Math.ceil(textCost / CHUNK_TOKEN_BUDGET));
  return chunks + (chunks > 1 ? 1 : 0);
}

function mergeCallCount(blocks: number): number {
  let calls = 0;
  let count = blocks;
  while (count > 1) {
    const next = Math.ceil(count / MERGE_GROUP);
    calls += next;
    count = next;
  }
  return calls;
}

function toBlockSummary(block: SummaryBlockSpec, cached?: BookSummaryRow): BookSummaryBlock {
  return {
    index: block.index,
    title: block.title,
    page: block.page,
    end_page: block.endPage,
    pages: block.endPage - block.page + 1,
    cached: Boolean(cached),
    ...(cached ? { summary: cached.content } : {})
  };
}

function estimateFor(
  store: Store,
  documentId: string,
  blocks: SummaryBlockSpec[],
  cached: Map<string, BookSummaryRow>,
  model: string,
  bookAvailable: boolean
): BookSummaryEstimate {
  const pending = blocks.filter((block) => !cached.has(block.key));
  let calls = 0;
  let inputTokens = 0;
  for (const block of pending) {
    const textCost = blockTextCost(store, documentId, block);
    const blockCalls = blockCallCount(textCost);
    calls += blockCalls;
    inputTokens += textCost + blockCalls * 600;
  }
  // 已缓存全书摘要且没有缺失分块：无需任何模型调用（直接复用缓存）。
  const merges = pending.length === 0 && bookAvailable ? 0 : mergeCallCount(blocks.length);
  calls += merges;
  inputTokens += merges * (blocks.length * SUMMARY_MAX_TOKENS + 800);
  const outputTokens =
    pending.reduce(
      (sum, block) =>
        sum + blockCallCount(blockTextCost(store, documentId, block)) * SUMMARY_MAX_TOKENS,
      0
    ) + merges * MERGE_MAX_TOKENS;
  return {
    pending_blocks: pending.length,
    calls,
    input_tokens: Math.round(inputTokens),
    output_tokens: Math.round(outputTokens),
    model
  };
}

/** 生成前的计划与成本估算：已缓存的分块不重复调用模型。 */
export async function bookSummaryPlan(
  store: Store,
  documentId: string,
  model: string
): Promise<BookSummaryPlan> {
  const document = store.getDocument(documentId);
  if (!document) throw new Error('文献不存在');
  const { blocks, source } = await planBookSummaryBlocks(store, documentId);
  const contentVersion = documentContentVersion(store, documentId);
  const cached = cachedBlockMap(store, documentId, blocks);
  const bookRow = bookRowOf(store, documentId, contentVersion);
  const rows = blocks.map((block) => toBlockSummary(block, cached.get(block.key)));
  return {
    document_id: documentId,
    document_name: document.name,
    total_pages: document.pages,
    blocks: rows,
    cached: rows.filter((row) => row.cached).length,
    total: rows.length,
    source,
    content_version: contentVersion,
    estimate: estimateFor(store, documentId, blocks, cached, model, Boolean(bookRow)),
    book_available: Boolean(bookRow)
  };
}

/** 仅用目录/页区间拼出的轻量概览（不调用模型）。 */
export function outlineOverview(documentName: string, blocks: BookSummaryBlock[]): string {
  const lines = blocks.map(
    (block) => `- ${block.title}（第 ${block.page}–${block.end_page} 页）`
  );
  return (
    `《${documentName}》共 ${blocks.length} 个部分：\n${lines.join('\n')}\n\n` +
    '以上只是基于目录/页区间的结构概览，尚未逐章阅读原文；需要更准确的内容请生成全书摘要。'
  );
}

export interface RunBookSummaryOptions {
  store: Store;
  config: ReadingChatConfig;
  documentId: string;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number, phase: string) => void;
  /** 只用缓存：缺分块时直接报错，不调用模型（用于“只读缓存”的问答）。 */
  cachedOnly?: boolean;
}

interface BlockContent {
  title: string;
  page: number;
  endPage: number;
  content: string;
}

function chunksByCost(
  rows: Array<{ page: number; text: string }>,
  budget: number
): Array<Array<{ page: number; text: string }>> {
  const chunks: Array<Array<{ page: number; text: string }>> = [];
  let current: Array<{ page: number; text: string }> = [];
  let used = 0;
  for (const row of rows) {
    const size = cost(row.text) + 20;
    if (current.length > 0 && used + size > budget) {
      chunks.push(current);
      current = [];
      used = 0;
    }
    current.push(row);
    used += size;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function materialOfBlock(
  documentName: string,
  block: SummaryBlockSpec,
  rows: Array<{ page: number; text: string }>
): string {
  const body = rows.map((row) => `第 ${row.page} 页\n${row.text}`).join('\n\n');
  return `文献：《${documentName}》\n部分：${block.title}（第 ${block.page}–${block.endPage} 页）\n\n${body}`;
}

function abortError(): Error {
  const error = new Error('已取消');
  error.name = 'AbortError';
  return error;
}

async function askSummary(
  config: ReadingChatConfig,
  system: string,
  material: string,
  maxTokens: number,
  signal: AbortSignal | undefined,
  phase: string
): Promise<string> {
  return callChatModel(
    config,
    system,
    material,
    maxTokens,
    signal,
    undefined,
    undefined,
    undefined,
    phase,
    [],
    true
  );
}

/**
 * 运行全书摘要：已缓存分块直接复用；缺失分块逐块生成（超长章内部分段再合并），
 * 最后按层合并成一份全书摘要并缓存。中断后重跑只补缺失分块。
 */
export async function runBookSummary(options: RunBookSummaryOptions): Promise<BookSummaryResult> {
  const { store, config, documentId, signal, onProgress, cachedOnly } = options;
  const document = store.getDocument(documentId);
  if (!document) throw new Error('文献不存在');
  const { blocks } = await planBookSummaryBlocks(store, documentId);
  if (blocks.length === 0) throw new Error('这篇文献没有可摘要的页面');
  const contentVersion = documentContentVersion(store, documentId);
  const cached = cachedBlockMap(store, documentId, blocks);
  const doneBlocks: BlockContent[] = [];
  let done = 0;
  const model = config.model;
  const now = (): string => new Date().toISOString();

  for (const block of blocks) {
    if (signal?.aborted) throw abortError();
    const saved = cached.get(block.key);
    if (saved) {
      doneBlocks.push({
        title: block.title,
        page: block.page,
        endPage: block.endPage,
        content: saved.content
      });
      done += 1;
      onProgress?.(done, blocks.length, `复用第 ${done}/${blocks.length} 部分缓存`);
      continue;
    }
    if (cachedOnly) {
      throw new Error(
        `还有 ${blocks.length - done} 个部分没有摘要缓存；请先生成全书摘要。`
      );
    }
    const rows: Array<{ page: number; text: string }> = [];
    for (let page = block.page; page <= block.endPage; page += 1) {
      const text = store.getPageText(documentId, page);
      if (text.trim()) rows.push({ page, text });
    }
    if (rows.length === 0) {
      doneBlocks.push({ title: block.title, page: block.page, endPage: block.endPage, content: '' });
      done += 1;
      onProgress?.(done, blocks.length, `跳过无文字的第 ${block.index} 部分`);
      continue;
    }
    onProgress?.(done, blocks.length, `正在摘要：${block.title}`);
    const chunks = chunksByCost(rows, CHUNK_TOKEN_BUDGET);
    let content: string;
    if (chunks.length === 1) {
      content = await askSummary(
        config,
        SUMMARY_SYSTEM,
        materialOfBlock(document.name, block, rows),
        SUMMARY_MAX_TOKENS,
        signal,
        `摘要：${block.title}`
      );
    } else {
      const parts: string[] = [];
      for (let index = 0; index < chunks.length; index += 1) {
        parts.push(
          await askSummary(
            config,
            CHUNK_SYSTEM,
            materialOfBlock(document.name, block, chunks[index]!),
            SUMMARY_MAX_TOKENS,
            signal,
            `摘要：${block.title}（分段 ${index + 1}/${chunks.length}）`
          )
        );
      }
      content = await askSummary(
        config,
        BLOCK_MERGE_SYSTEM,
        `文献：《${document.name}》\n部分：${block.title}（第 ${block.page}–${block.endPage} 页）\n\n` +
          parts.map((part, index) => `分段 ${index + 1} 摘要：\n${part}`).join('\n\n'),
        SUMMARY_MAX_TOKENS,
        signal,
        `合并：${block.title}`
      );
    }
    if (signal?.aborted) throw abortError();
    const row: BookSummaryRow = {
      documentId,
      scope: 'block',
      blockKey: block.key,
      title: block.title,
      pagesFrom: block.page,
      pagesTo: block.endPage,
      content,
      model,
      contentVersion: blockContentVersion(store, documentId, block),
      promptVersion: BOOK_SUMMARY_PROMPT_VERSION,
      level: 0,
      created: now(),
      updated: now()
    };
    store.saveBookSummary(row);
    doneBlocks.push({
      title: block.title,
      page: block.page,
      endPage: block.endPage,
      content
    });
    done += 1;
    onProgress?.(done, blocks.length, `完成第 ${done}/${blocks.length} 部分：${block.title}`);
  }

  // 逐级合并：每 8 个下层摘要合并成 1 个上层摘要，直到只剩一份全书摘要。
  let level = 0;
  let current = doneBlocks;
  while (current.length > 1) {
    if (signal?.aborted) throw abortError();
    const next: BlockContent[] = [];
    for (let start = 0; start < current.length; start += MERGE_GROUP) {
      const group = current.slice(start, start + MERGE_GROUP);
      const material =
        `文献：《${document.name}》\n以下是第 ${level + 1} 层的摘要，请合并：\n\n` +
        group
          .map(
            (item) =>
              `【${item.title}（第 ${item.page}–${item.endPage} 页）】\n${item.content}`
          )
          .join('\n\n');
      onProgress?.(
        done,
        blocks.length,
        `正在合并第 ${level + 2} 层（${Math.floor(start / MERGE_GROUP) + 1}/${Math.ceil(current.length / MERGE_GROUP)}）`
      );
      const merged = await askSummary(
        config,
        MERGE_SYSTEM,
        material,
        level === 0 ? MERGE_MAX_TOKENS : FINAL_MERGE_MAX_TOKENS,
        signal,
        `合并摘要第 ${level + 1} 层`
      );
      next.push({
        title: `第 ${group[0]!.page}–${group[group.length - 1]!.endPage} 页`,
        page: group[0]!.page,
        endPage: group[group.length - 1]!.endPage,
        content: merged
      });
    }
    current = next;
    level += 1;
  }

  const content = current[0]?.content ?? '';
  const result: BookSummaryResult = {
    document_id: documentId,
    kind: 'book',
    content,
    model,
    created: now(),
    content_version: contentVersion,
    merge_levels: level,
    blocks: blocks.map((block) => {
      const row = cached.get(block.key) ?? null;
      const produced = doneBlocks.find(
        (item) => item.page === block.page && item.endPage === block.endPage
      );
      return {
        ...toBlockSummary(block, row ?? undefined),
        cached: true,
        ...(produced ? { summary: produced.content } : {})
      };
    })
  };
  store.saveBookSummary({
    documentId,
    scope: 'book',
    blockKey: '',
    title: document.name,
    pagesFrom: 1,
    pagesTo: document.pages,
    content,
    model,
    contentVersion,
    promptVersion: BOOK_SUMMARY_PROMPT_VERSION,
    level,
    created: now(),
    updated: now()
  });
  onProgress?.(blocks.length, blocks.length, '全书摘要已完成');
  return result;
}

/** 读取已缓存的全书摘要（内容版本匹配才算）。 */
export function readCachedBookSummary(
  store: Store,
  documentId: string
): BookSummaryResult | null {
  const document = store.getDocument(documentId);
  if (!document) return null;
  const contentVersion = documentContentVersion(store, documentId);
  const row = bookRowOf(store, documentId, contentVersion);
  if (!row) return null;
  const rows = store.listBookSummaries(documentId);
  const blockRows = rows
    .filter((item) => item.scope === 'block')
    .sort((left, right) => left.pagesFrom - right.pagesFrom);
  return {
    document_id: documentId,
    kind: 'book',
    content: row.content,
    model: row.model,
    created: row.created,
    content_version: contentVersion,
    merge_levels: row.level,
    blocks: blockRows.map((item) => ({
      index: 0,
      title: item.title,
      page: item.pagesFrom,
      end_page: item.pagesTo,
      pages: item.pagesTo - item.pagesFrom + 1,
      cached: true,
      summary: item.content
    }))
  };
}

/** 清空某篇文献的摘要缓存（重新生成前调用）。 */
export function resetBookSummary(store: Store, documentId: string): void {
  store.deleteBookSummaries(documentId);
}
