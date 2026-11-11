import type { BudgetEstimate, DocumentCategory, ReadingPlanRecord } from '@studianda/shared';
import { cost, sourceText, type ReadingSource } from './reading.js';
import { planReading } from './reading-plan.js';
import type { Store } from './store.js';

/**
 * 发送前的预算闸门估算（只读，不调用模型、不写库、不改变阅读范围）。
 *
 * 口径分两种：
 * - **单轮口径**（`estimateTurnBudget`，闸门与 `/chat/budget` 默认用）：按"本轮实际会读的页"算——
 *   用 `reading.max_read_batches` 截断批次，只统计本轮会送进模型的原文。这样跨越页数上限、
 *   需要多轮"继续阅读"的著作不会被当成"一次读完整本"而反复弹确认。
 * - **范围口径**（`estimateBudget` / `estimateBudgetForScope`）：按计划范围内的全部页估算，
 *   保留给"整轮要读多少"的对照与既有测试。
 *
 * 阈值可以配置：`reading.budget_pages`（默认 20）、`reading.budget_tokens`（默认 60000）；
 * 非法/越界回退默认值，不抛错（设置是用户手填的字符串）。
 */
export interface BudgetThresholds {
  pages: number;
  tokens: number;
}

/** 默认确认阈值：20 页 / 60000 token。超阈值只要求确认，不拒绝。 */
export const DEFAULT_BUDGET_THRESHOLDS: BudgetThresholds = { pages: 20, tokens: 60_000 };
export const MIN_BUDGET_PAGES = 1;
export const MAX_BUDGET_PAGES = 3000;
export const MIN_BUDGET_TOKENS = 1_000;
export const MAX_BUDGET_TOKENS = 4_000_000;

export type BudgetScope = 'local' | 'document' | 'discovery';

const PAGE_FALLBACK_TOKENS = 1500;
const NOTE_BASE = '这是估算：实际读取范围与用量以本轮为准；确认后才会开始读取';
const METHOD_INDEXED =
  '按已索引文本的字符总量与中英比例估算（CJK 1.5 token/字，其他 0.3 token/字符）';
const METHOD_FALLBACK = '没有可用已索引文本：按每页约 1500 token 保守估算';
const METHOD_TURN = '按本轮实际会读的原文页逐页计数（CJK 1.5 token/字，其他 1 token/字符）';

function numberFrom(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function integerSetting(
  value: unknown,
  fallback: number,
  min: number,
  max: number
): number {
  const raw = numberFrom(value);
  if (raw === null) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(raw)));
}

/** 读阈值设置；坏值/缺省落回默认，不抛错。 */
export function budgetThresholds(
  settings?: Readonly<Record<string, unknown>> | null
): BudgetThresholds {
  const source = settings ?? {};
  return {
    pages: integerSetting(
      source['reading.budget_pages'],
      DEFAULT_BUDGET_THRESHOLDS.pages,
      MIN_BUDGET_PAGES,
      MAX_BUDGET_PAGES
    ),
    tokens: integerSetting(
      source['reading.budget_tokens'],
      DEFAULT_BUDGET_THRESHOLDS.tokens,
      MIN_BUDGET_TOKENS,
      MAX_BUDGET_TOKENS
    )
  };
}

export interface ScopeBudgetOptions {
  thresholds?: BudgetThresholds;
  /** 估算对应的范围标签；缺省按 plan.breadth。 */
  scope?: BudgetScope;
}

export interface TurnBudgetOptions extends ScopeBudgetOptions {
  /** 当前页（局部范围与页序起点）。 */
  page?: number;
  /** 单轮新增批次上限；默认 12，与 reading.max_read_batches 默认值一致。 */
  maxBatches?: number;
  /** 每批预算（token）；默认 6000，与 auto 深度一致。 */
  batchBudget?: number;
  overlap?: number;
  /** 文献分类：著作会额外说明"整篇分多轮"。 */
  documentCategory?: DocumentCategory;
}

function uniqueDocumentIds(documentIds: readonly unknown[]): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const raw of documentIds) {
    if (typeof raw !== 'string') continue;
    const id = raw.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function scopeOf(plan: ReadingPlanRecord): BudgetScope {
  if (plan.breadth === 'local') return 'local';
  if (plan.breadth === 'discovery') return 'discovery';
  return 'document';
}

function textStats(text: string): { characters: number; cjk: number } {
  let characters = 0;
  let cjk = 0;
  for (const char of text) {
    characters += 1;
    const code = char.codePointAt(0) ?? 0;
    if (
      (code >= 0x3040 && code <= 0x30ff) ||
      (code >= 0x3400 && code <= 0x9fff) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xac00 && code <= 0xd7af)
    ) {
      cjk += 1;
    }
  }
  return { characters, cjk };
}

/**
 * 跨文献/多文献范围的估算（范围口径）。
 *
 * - 页数：local → 计划页数；discovery → scope 内（存在的）文献页数之和；document → 第一篇文献页数。
 * - token：local 单篇按计划页的实际文本；其余汇总 scope 内全部 chunks 的字符与 CJK 字数后统一按比例估算；
 *   无文本按页数 × 1500 回退。
 * - documents：scope 去重后**实际存在**的文献数（不把已删除/不存在的 id 算进去）。
 */
export function estimateBudgetForScope(
  store: Store,
  plan: ReadingPlanRecord,
  documentIds: readonly string[],
  options: ScopeBudgetOptions = {}
): BudgetEstimate {
  const ids = uniqueDocumentIds(documentIds);
  if (ids.length === 0) throw new Error('没有可估算的文献');
  const documents = ids
    .map((id) => store.getDocument(id))
    .filter((document): document is NonNullable<ReturnType<Store['getDocument']>> =>
      Boolean(document)
    );
  if (documents.length === 0) throw new Error('文档不存在');
  const thresholds = options.thresholds ?? DEFAULT_BUDGET_THRESHOLDS;

  let pages = plan.pages.length;
  if (plan.breadth === 'discovery') {
    pages = documents.reduce((total, document) => total + document.pages, 0);
  } else if (plan.breadth === 'document') {
    pages = documents[0]!.pages;
  }

  let characters = 0;
  let cjk = 0;
  if (plan.breadth === 'local' && documents.length === 1) {
    // 局部范围：按计划页的实际文本估，不拿整篇 chunks 冒充本轮用量。
    const document = documents[0]!;
    const wanted = [...new Set(plan.pages)]
      .filter((page) => Number.isInteger(page) && page >= 1 && page <= document.pages)
      .slice(0, MAX_BUDGET_PAGES);
    for (const page of wanted) {
      const stats = textStats(store.getPageText(document.id, page));
      characters += stats.characters;
      cjk += stats.cjk;
    }
  } else {
    for (const document of documents) {
      const stats = store.chunkTextStats(document.id);
      characters += stats.characters;
      cjk += stats.cjk;
    }
  }
  const other = characters - cjk;
  const ratio = characters > 0 ? (cjk * 1.5 + other * 0.3) / characters : 0;
  let tokens = characters > 0 ? Math.trunc(characters * ratio) : 0;
  let method = METHOD_INDEXED;
  if (tokens <= 0) {
    tokens = pages * PAGE_FALLBACK_TOKENS;
    method = METHOD_FALLBACK;
  }
  const exceeded = pages > thresholds.pages || tokens > thresholds.tokens;
  return {
    pages,
    tokens,
    documents: documents.length,
    thresholds: { ...thresholds },
    exceeded,
    estimated: true,
    method,
    note: `${NOTE_BASE}。`,
    scope: options.scope ?? scopeOf(plan),
    total_pages: pages,
    max_batches: 0
  };
}

/** 单篇范围口径：保留原签名与返回字段，内部走 scope 版本（单元素）。 */
export function estimateBudget(
  store: Store,
  plan: ReadingPlanRecord,
  documentId: string,
  options: ScopeBudgetOptions = {}
): BudgetEstimate {
  return estimateBudgetForScope(store, plan, [documentId], options);
}

/**
 * **单轮口径**估算：按"本轮实际会读多少页"算。
 *
 * 闸门必须用这个口径：一部 300 页著作单轮只新增 `maxBatches` 批，用整本页数估会让每次提问都
 * 弹"预计读取 300 页"，提示与实际不符；20 页阈值也会因此失去意义。
 *
 * 计算方式：把计划切成批次（与真实阅读同一套 `planReading`/`splitSources`），取前 `maxBatches` 批，
 * 统计其中去重后的页数与该页原文 token。计划为空/整篇无可读文本时退回每页 1500 token 保守估算。
 */
export function estimateTurnBudget(
  store: Store,
  plan: ReadingPlanRecord,
  documentId: string,
  options: TurnBudgetOptions = {}
): BudgetEstimate {
  const document = store.getDocument(documentId);
  if (!document) throw new Error('文档不存在');
  const thresholds = options.thresholds ?? DEFAULT_BUDGET_THRESHOLDS;
  const scope = options.scope ?? scopeOf(plan);
  const page = integerSetting(options.page, 1, 1, MAX_BUDGET_PAGES);
  const maxBatches = integerSetting(options.maxBatches, 12, 1, 64);
  const batchBudget = integerSetting(options.batchBudget, 6000, 512, 4_000_000);
  const overlap = integerSetting(options.overlap, 1, 0, 8);

  let reading: ReturnType<typeof planReading>;
  try {
    reading = planReading(store, documentId, plan, page, batchBudget, overlap);
  } catch {
    // 切批失败（例如单页超出预算）不阻断提问：退回范围口径，让用户看到保守估算。
    return estimateBudget(store, plan, documentId, { thresholds, scope });
  }

  const turnRows: ReadingSource[] = [];
  const seenPages = new Set<number>();
  for (const group of reading.batches.slice(0, maxBatches)) {
    for (const [, source] of group) {
      if (seenPages.has(source.page)) continue;
      seenPages.add(source.page);
      turnRows.push(source);
    }
  }

  const scopePages =
    reading.pages.length > 0
      ? reading.pages.length
      : plan.breadth === 'document'
        ? document.pages
        : plan.pages.length;

  let pages = turnRows.length;
  let tokens = 0;
  let method = METHOD_TURN;
  if (turnRows.length > 0) {
    for (const row of turnRows) tokens += cost(sourceText(row, 1));
  } else {
    pages = Math.max(0, scopePages);
    tokens = pages * PAGE_FALLBACK_TOKENS;
    method = METHOD_FALLBACK;
  }

  const totalPages = scopePages > 0 ? scopePages : pages;
  const notes = [NOTE_BASE];
  if (totalPages > pages) {
    notes.push(
      `范围内共 ${totalPages} 页，本轮先读约 ${pages} 页，其余可点「继续阅读」接着读`
    );
  }
  if (scope === 'document') {
    notes.push(`单轮最多新增 ${maxBatches} 批阅读`);
  }
  if (options.documentCategory === 'book') {
    notes.push('这是著作：整篇会分多轮完成，建议按章节或「继续阅读」分轮进行');
  }

  const exceeded = pages > thresholds.pages || tokens > thresholds.tokens;
  return {
    pages,
    tokens,
    documents: 1,
    thresholds: { ...thresholds },
    exceeded,
    estimated: true,
    method,
    note: `${notes.join('；')}。`,
    scope,
    total_pages: totalPages,
    max_batches: maxBatches
  };
}
