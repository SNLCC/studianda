/**
 * 语料级（跨文献）两级召回的第一级：给候选文献排序。
 *
 * 这一层只决定"预算用尽时先读哪几篇"，**不是筛选器**：返回的永远是全部候选文献，
 * 只是顺序不同。当前文献永远第一，其余按"命中词数降序 → 名称 → id"排。
 * 排序信号只来自本机检索（chunks + 整页 OCR/校订），不调模型、不联网。
 */

/** 与问题术语提取同一口径的粗筛：中文连续段、英文单词（≥2 字符）。 */
const TERM = /[\u4e00-\u9fff]{2,}|[A-Za-z][A-Za-z0-9_-]{1,}/g;

export interface DiscoveryDocument {
  id: string;
  name: string;
}

export interface DiscoveryReport {
  ordered_ids: string[];
  scores: Record<string, number>;
  candidates: number;
  hit_documents: number;
  terms: string[];
  basis: string;
  note: string;
}

/** 从问题里取出可用于比对的候选术语（去重、保序、有上限）。 */
export function termsOf(query: string, limit = 12): string[] {
  const found: string[] = [];
  const text = query ?? '';
  for (const match of text.matchAll(TERM)) {
    const run = match[0];
    const term = /^[\x00-\x7f]/.test(run) ? run.toLowerCase() : run;
    if (term.length >= 2 && !found.includes(term)) found.push(term);
    if (found.length >= limit) break;
  }
  return found;
}

/** 每篇文献命中几个术语：`{文档 id: 命中数}`。 */
export function documentScores(
  terms: readonly string[],
  textsByDocument: Record<string, string>
): Record<string, number> {
  const wanted = [
    ...new Set((terms ?? []).filter((term): term is string => typeof term === 'string' && term.length >= 2))
  ];
  const scores: Record<string, number> = {};
  for (const [documentId, text] of Object.entries(textsByDocument ?? {})) {
    if (!documentId || !text) {
      scores[documentId] = 0;
      continue;
    }
    const lowered = text.toLowerCase();
    scores[documentId] = wanted.reduce(
      (total, term) => total + (lowered.includes(term.toLowerCase()) ? 1 : 0),
      0
    );
  }
  return scores;
}

/**
 * 按"当前文献优先 → 命中数降序 → 名称 → id"排序；**返回全部文献**。
 *
 * 调用方不得用这份顺序砍掉后面的文献：命中为 0 的文献同样在阅读范围内，只是排在后面。
 */
export function orderDocuments<T extends DiscoveryDocument>(
  documents: readonly T[],
  scores: Record<string, number>,
  currentId = ''
): T[] {
  return [...(documents ?? [])].sort((left, right) => {
    const currentDelta = (left.id === currentId ? 0 : 1) - (right.id === currentId ? 0 : 1);
    if (currentDelta !== 0) return currentDelta;
    const scoreDelta = (scores?.[right.id] ?? 0) - (scores?.[left.id] ?? 0);
    if (scoreDelta !== 0) return scoreDelta;
    const nameDelta = String(left.name ?? '').localeCompare(String(right.name ?? ''));
    if (nameDelta !== 0) return nameDelta;
    return String(left.id).localeCompare(String(right.id));
  });
}

/** 给报告的排序记录：为什么这样排、每篇命中多少、以及"这不是筛选"的说明。 */
export function discoveryReport(
  documents: readonly DiscoveryDocument[],
  scores: Record<string, number>,
  currentId = '',
  terms: readonly string[] = []
): DiscoveryReport {
  const ordered = orderDocuments(documents, scores, currentId);
  return {
    ordered_ids: ordered.map((document) => document.id),
    scores: Object.fromEntries(
      ordered.map((document) => [document.id, scores?.[document.id] ?? 0])
    ),
    candidates: ordered.length,
    hit_documents: ordered.filter((document) => (scores?.[document.id] ?? 0) > 0).length,
    terms: [...(terms ?? [])],
    basis: '本机词面命中数（当前文献优先）',
    note:
      '这一层只决定**先读哪几篇**，不决定读不读：命中为 0 的文献同样在阅读范围内，' +
      '只是排在后面；预算用完时点「继续阅读」仍会读到它们。'
  };
}
