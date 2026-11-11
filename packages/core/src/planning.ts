import { DEFAULT_DIMENSIONS } from './coverage.js';

export type ReadingBreadth = 'document' | 'local' | 'discovery';

export interface ReadingPlan {
  breadth: ReadingBreadth;
  reason: string;
  origin: '规则' | '模型规划' | '保守回退';
  pages: number[];
  queries: string[];
  dimensions: Array<{ code: string; label: string }>;
}

/** 覆盖维度上限：与 Planner 指令里的「最多 6 条」一致（DIMENSION_LIMIT）。 */
const DIMENSION_LIMIT = 6;
/** 维度名称字数容差：提示词要求不超过 6 个字，这里给一倍容错；再长就视为模型没按要求给。 */
const DIMENSION_LABEL_MAX = 12;
const WHOLE_DOCUMENT = /全文|全篇|整篇|全书|整本|整体|通读|论证脉络|(?:论文|文献|文章|本文|这篇|该文|本研究).{0,6}(?:结构|脉络|框架|主线|论证|论点|大纲|行文)|(?:章节|小节|段落).{0,4}(?:结构|安排|组织)|全部.{0,8}文献|所有.{0,8}文献|\b(entire|whole|overall|structure|outline|argument|all documents)\b/i;
const EXPLICIT_PAGES = /第\s*(\d+)\s*(?:[—–\-至到]\s*(\d+)\s*)?页|\bpages?\s+(\d+)(?:\s*[-–]\s*(\d+))?/i;
const SELECTION_EXPLAIN = /解释|翻译|这段|此处|这里|选中|\b(explain|translate|this|selected)\b/i;
const CURRENT_PAGE = /当前页|这一页|本页|\b(current page|this page)\b/i;

/**
 * 把 Planner 返回的覆盖维度清洗成可信清单。
 *
 * 维度清单只是「要检查哪些方面」的记账口径，不是对原文内容的断言，因此格式不对**不该**让整次
 * 提问失败；但也绝不能把模型自造的编号带进台账——码只认 `D+数字`，词表外/重复/过长的条目一律丢弃。
 */
export function normalizeDimensions(
  raw: unknown
): Array<{ code: string; label: string }> {
  const rows = Array.isArray(raw) ? raw : [];
  const result: Array<{ code: string; label: string }> = [];
  const seen = new Set<string>();
  for (const item of rows) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const value = item as { code?: unknown; label?: unknown };
    if (typeof value.code !== 'string' || typeof value.label !== 'string') continue;
    const code = value.code.trim();
    const label = value.label.trim();
    if (!/^D\d+$/.test(code)) continue;
    if (label.length === 0 || label.length > DIMENSION_LABEL_MAX) continue;
    if (seen.has(code)) continue;
    seen.add(code);
    result.push({ code, label });
    if (result.length >= DIMENSION_LIMIT) break;
  }
  return result;
}

/**
 * 维度清单为空时退回一组通用维度。
 *
 * **空清单不等于「不用检查」**：没有可记账的维度，覆盖台账就只能写「未逐批记账」，
 * 用户也看不出「哪些方面没找到」。默认维度代表「要完整回答这个问题应当核对哪些方面」，
 * 不是断言原文一定有这些内容。
 */
export function withDefaultDimensions(plan: ReadingPlan): ReadingPlan {
  const dimensions = normalizeDimensions(plan.dimensions);
  if (dimensions.length > 0) return { ...plan, dimensions };
  // 复制一份再交出：默认维度是共享常量，调用方就地改它会把后续所有提问一起改坏。
  return { ...plan, dimensions: DEFAULT_DIMENSIONS.map((dimension) => ({ ...dimension })) };
}

/**
 * 规则前置部分：显式范围优先；规则判断不出时返回 null，由调用方走模型规划或保守回退。
 */
export function planFromRules(query: string, selection = ''): ReadingPlan | null {
  if (WHOLE_DOCUMENT.test(query)) {
    return {
      breadth: 'document',
      reason: '问题要求完整或整体阅读',
      origin: '规则',
      pages: [],
      queries: [],
      dimensions: []
    };
  }
  const explicit = query.match(EXPLICIT_PAGES);
  if (explicit) {
    const start = Number(explicit[1] ?? explicit[3]);
    const end = Number(explicit[2] ?? explicit[4] ?? start);
    if (Number.isInteger(start) && Number.isInteger(end) && start >= 1 && end >= start && end <= 3000) {
      return {
        breadth: 'local',
        reason: '问题明确指定页码',
        origin: '规则',
        pages: Array.from({ length: end - start + 1 }, (_, index) => start + index),
        queries: [],
        dimensions: []
      };
    }
  }
  if (selection.trim() && SELECTION_EXPLAIN.test(query)) {
    return {
      breadth: 'local',
      reason: '解释选文，读取连续邻页',
      origin: '规则',
      pages: [],
      queries: [],
      dimensions: []
    };
  }
  if (CURRENT_PAGE.test(query)) {
    return {
      breadth: 'local',
      reason: '问题明确指向当前页',
      origin: '规则',
      pages: [],
      queries: [],
      dimensions: []
    };
  }
  return null;
}

export function conservativePlan(): ReadingPlan {
  return {
    breadth: 'document',
    reason: '范围不确定，保守读取完整文献',
    origin: '保守回退',
    pages: [],
    queries: [],
    dimensions: []
  };
}

/** 对模型返回的规划结果做合法性与页数收敛。 */
export function modelPlanToReadingPlan(input: unknown): ReadingPlan | null {
  if (!input || typeof input !== 'object') return null;
  const value = input as {
    breadth?: unknown;
    confidence?: unknown;
    reason?: unknown;
    pages?: unknown;
    queries?: unknown;
    dimensions?: unknown;
  };
  if (
    !['document', 'local', 'discovery'].includes(String(value.breadth)) ||
    typeof value.confidence !== 'number' ||
    value.confidence < 0.8
  ) {
    return null;
  }
  let breadth = value.breadth as ReadingBreadth;
  const rawPages = Array.isArray(value.pages) ? value.pages : [];
  const pages = [...new Set(rawPages.filter((page): page is number => Number.isInteger(page) && page >= 1 && page <= 3000))]
    .sort((left, right) => left - right)
    .slice(0, 8);
  if (breadth === 'local' && pages.length === 0) breadth = 'document';
  const queries = Array.isArray(value.queries)
    ? value.queries
        .filter((query): query is string => typeof query === 'string' && query.length > 0 && query.length <= 500)
        .slice(0, 3)
    : [];
  const dimensions = normalizeDimensions(value.dimensions);
  return {
    breadth,
    reason: String(value.reason ?? '模型判断').slice(0, 250),
    origin: '模型规划',
    pages,
    queries,
    dimensions
  };
}

export function planQuestion(
  query: string,
  selection: string,
  modelPlan?: unknown
): ReadingPlan {
  const plan =
    planFromRules(query, selection) ??
    (modelPlan ? modelPlanToReadingPlan(modelPlan) : null) ??
    conservativePlan();
  // 兜底只在这一处做：规则/模型/保守三条路都可能给不出维度清单，调用方不该各自再判一次。
  return withDefaultDimensions(plan);
}
