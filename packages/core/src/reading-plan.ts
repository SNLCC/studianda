import type { ReadingPlan } from './planning.js';
import { batches, splitSources, type ReadingSource } from './reading.js';
import type { Store } from './store.js';

export interface PlannedReading {
  pages: number[];
  sources: ReadingSource[];
  batches: Array<Array<[number, ReadingSource]>>;
  batchCount: number;
  multiPass: boolean;
}

/** 把规划结果变成实际阅读来源：document=全页，local=指定页/当前页。 */
export function sourcesForPlan(
  store: Store,
  documentId: string,
  plan: ReadingPlan,
  currentPage = 1
): ReadingSource[] {
  const document = store.getDocument(documentId);
  if (!document) throw new Error('文档不存在');
  let pages: number[];
  if (plan.breadth === 'document') {
    pages = Array.from({ length: document.pages }, (_, index) => index + 1);
  } else {
    const requested = plan.pages.filter((page) => page >= 1 && page <= document.pages);
    pages = requested.length > 0 ? requested : [Math.min(Math.max(1, currentPage), document.pages)];
  }
  return pages
    .sort((left, right) => left - right)
    .map((page) => ({
      document_id: documentId,
      page,
      name: document.name,
      text: store.getPageText(documentId, page)
    }))
    .filter((source) => source.text.trim().length > 0);
}

/** 规划 -> 切页 -> 连续批次；不调用模型。 */
export function planReading(
  store: Store,
  documentId: string,
  plan: ReadingPlan,
  currentPage = 1,
  budget = 6000,
  overlap = 1
): PlannedReading {
  const rawSources = sourcesForPlan(store, documentId, plan, currentPage);
  const pages = rawSources.map((source) => source.page);
  const sources = splitSources(rawSources, budget);
  const groups = batches(sources, budget, overlap);
  return {
    pages,
    sources,
    batches: groups,
    batchCount: groups.length,
    multiPass: groups.length > 1
  };
}
