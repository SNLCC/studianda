import type { ReadingPlan } from './planning.js';
import { cost, batches, splitSources, type ReadingSource } from './reading.js';
import { checkIntegrity, decompose, pack } from './reading-units.js';
import {
  MAX_VERDICT_UNITS,
  parseVerdict,
  pruneUnits,
  unitText,
  verdictMaterial,
  VERDICT_INSTRUCTION,
  type ExcludedUnit
} from './reading-prune.js';
import { cosine } from './embeddings.js';
import type { Store } from './store.js';

/** 语义召回最多算多少个单元：再多的书也不该为了"选几节"付出几百次嵌入。 */
const MAX_SEMANTIC_UNITS = 300;
/** 单元送去做语义比较的文本长度：取开头一段，够表达主题即可。 */
const SEMANTIC_PREVIEW_CHARS = 1200;

export interface PlannedReading {
  pages: number[];
  sources: ReadingSource[];
  batches: Array<Array<[number, ReadingSource]>>;
  batchCount: number;
  multiPass: boolean;
  /** 带是否来自结构单元（`decompose`+`pack`）而不是按字符切。 */
  fromUnits?: boolean;
  /** 三态账的"排除"态：被裁决为不读的单元与其块级依据。 */
  excluded?: Array<{
    section: number;
    title: string;
    pages: [number, number];
    score: number;
    hits: string[];
    reason: string;
  }>;
  /** 已装入单元占全部单元的比例（0..1）；未启用结构装带时缺省。 */
  readRatio?: number;
  /** 裁决过程中的降级说明（如未启用语义通道）。 */
  pruneDegraded?: string[];
  /**
   * 结构装带没能生效的原因（降级必须可见，不能静默退回字符切）。
   * - `page_exceeds_budget`：单页原文就超过预算（超大字页/扫描页），按页装不下；
   * - `no_units`：解析不出可用单元；
   * - `page_text_mismatch`：页文本与块文本严重不一致（手工改页/OCR 覆盖），块的边界不可信；
   * - `structure_integrity_failed`：章节区间有洞/重叠/越界，已按"整篇一节"硬切，不做结构对齐。
   */
  planDegraded?:
    | 'page_exceeds_budget'
    | 'no_units'
    | 'page_text_mismatch'
    | 'structure_integrity_failed';
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

/**
 * 整篇阅读时优先按**结构单元**装带，而不是按字符硬切。
 *
 * 只对 `breadth === 'document'` 生效：局部阅读仍走 `planReading`（选择哪些页的语义还没被
 * 选择器接管，现在改它等于同时动两件事）。任何异常/结构不可用时静默退回 `planReading`——
 * 这条路径的价值是"切点对齐章节"，拿不到结构就别硬来，而不是让提问失败。
 *
 * 带仍然落在**页**上：证据核验与审计都以页文本为准（`getPageText`），
 * 用块文本当来源会让审计阶段的逐字比对和页面文本对不上。
 */
export async function planReadingWithStructure(
  store: Store,
  documentId: string,
  plan: ReadingPlan,
  currentPage = 1,
  budget = 6000,
  overlap = 1,
  query = '',
  /**
   * 语义嵌入回调：配置了 embedding 时应传（未配置时返回 null）。
   * 传了就参与裁决融合——同义/跨语言只有它能救回来。
   */
  embed?: (texts: string[]) => Promise<number[][] | null>,
  /**
   * 第 ④ 级消歧回调：边界带交给模型做二元裁决（keep/drop）。
   * 不传时边界带按"宁滥勿缺"保留，并在 `pruneDegraded` 里标 `verdict_model_unavailable`。
   */
  askVerdict?: (instruction: string, material: string) => Promise<string>,
  /**
   * 用户的显式策略（闸门里的两个按钮）：
   * - `full`：不裁决，整篇读（装不下就分轮）；
   * - `prune`：即使装得下也先裁决，只读相关部分。
   * 没给值时按材料推导（默认）。
   */
  force?: 'prune' | 'full'
): Promise<PlannedReading> {
  if (plan.breadth !== 'document') return planReading(store, documentId, plan, currentPage, budget, overlap);
  let document;
  try {
    document = await store.getDocumentBlocks(documentId);
  } catch {
    return planReading(store, documentId, plan, currentPage, budget, overlap);
  }
  if (!document || document.blocks.length === 0 || document.sections.length === 0) {
    return planReading(store, documentId, plan, currentPage, budget, overlap);
  }

  // 结构完整性校验：节区间有洞/重叠/越界时，**不猜也不修**——把整篇当成一个节交给硬切，
  // 并如实上报（结构坏的边界装带只会把无关页拼进同一带）。
  let structure = document;
  let integrityFailed = false;
  const integrity = checkIntegrity(document.blocks, document.sections);
  if (!integrity.ok) {
    integrityFailed = true;
    const lastPage = document.blocks[document.blocks.length - 1]?.page ?? 1;
    structure = {
      ...document,
      sections: [
        {
          index: 0,
          title: '',
          level: 0,
          kind: 'body',
          origin: 'heading',
          pageStart: document.blocks[0]?.page ?? 1,
          pageEnd: lastPage,
          blockStart: 0,
          blockEnd: document.blocks.length - 1,
          parent: null
        }
      ]
    };
  }

  const units = decompose(structure, { budget });
  if (units.length === 0) return planReading(store, documentId, plan, currentPage, budget, overlap);

  // 预算口径统一到**页**：下游真正送进模型的是页文本，按块成本打包会低估（页文本含页眉页脚等）。
  const pageCostCache = new Map<number, number>();
  const pageCostOf = (page: number): number => {
    const cached = pageCostCache.get(page);
    if (cached !== undefined) return cached;
    const size = cost(store.getPageText(documentId, page)) + 2;
    pageCostCache.set(page, size);
    return size;
  };
  const unitPages = (unit: { pagesFrom: number; pagesTo: number }): number[] => {
    const pages: number[] = [];
    for (let page = unit.pagesFrom; page <= unit.pagesTo; page += 1) pages.push(page);
    return pages;
  };
  const pagesCostOf = (pages: Iterable<number>): number => {
    let total = 0;
    for (const page of pages) total += pageCostOf(page);
    return total;
  };

  let kept = units;
  let excluded: ExcludedUnit[] = [];
  let pruneDegraded: string[] = [];
  const allUnitPages = new Set<number>();
  for (const unit of units) for (const page of unitPages(unit)) allUnitPages.add(page);
  const pagesCost = pagesCostOf(allUnitPages);
  const blockCost = units.reduce((total, unit) => total + unit.cost, 0);
  // 页文本与块文本严重不一致时，结构装带不可靠：块的边界是按版面算的，而真正送进模型的是页文本
  //（用户手工改过页、OCR 覆盖过页都会出现这种脱节）。此时退回按页字符切，别拿错位的边界装带。
  if (pagesCost > blockCost * 1.5 + 2000) {
    return {
      ...planReading(store, documentId, plan, currentPage, budget, overlap),
      planDegraded: 'page_text_mismatch'
    };
  }
  // 只有"装不下"时才需要裁决：装得下就整篇读，排除任何一节都是净损失。
  // 但用户显式选了"只读相关部分"时例外——他要的就是先筛。
  const shouldPrune = (pagesCost > budget || force === 'prune') && force !== 'full';
  if (shouldPrune && query.trim()) {
    let semanticScores: Map<number, number> | undefined;
    if (embed && units.length > 1 && units.length <= MAX_SEMANTIC_UNITS) {
      try {
        const texts = [
          query,
          ...units.map((unit) => unitText(document.blocks, unit).slice(0, SEMANTIC_PREVIEW_CHARS))
        ];
        const vectors = await embed(texts);
        if (vectors && vectors.length === texts.length && (vectors[0]?.length ?? 0) > 0) {
          const queryVector = vectors[0]!;
          semanticScores = new Map(
            units.map((_, index) => [index, cosine(queryVector, vectors[index + 1] ?? [])])
          );
        }
      } catch {
        // 语义通道失败不阻断：prune 会把它记为不可用，退回纯字面裁决。
        semanticScores = undefined;
      }
    }
    const pruned = pruneUnits({
      units,
      blocks: document.blocks,
      // 结构不可信时用上面那个"整篇一节"的替代结构：此时不该按 kind 做结构排除。
      sections: structure.sections,
      query,
      ...(semanticScores ? { semanticScores } : {})
    });
    if (pruned.excluded.length > 0 || pruned.ambiguous.length > 0) {
      kept = pruned.kept;
      excluded = pruned.excluded;
      pruneDegraded = pruned.degraded;
      // 第 ④ 级：边界带交给模型做二元裁决。没有消歧能力时按"宁滥勿缺"全部保留。
      const band = pruned.ambiguous.slice(0, MAX_VERDICT_UNITS);
      const overflow = pruned.ambiguous.slice(MAX_VERDICT_UNITS);
      kept = [...kept, ...overflow.map((row) => row.unit)];
      if (band.length > 0) {
        if (!askVerdict) {
          kept = [...kept, ...band.map((row) => row.unit)];
        } else {
          const hitsOf = new Map(band.map((row) => [row.unit, row.hits]));
          try {
            const raw = await askVerdict(
              VERDICT_INSTRUCTION,
              verdictMaterial(query, band.map((row) => row.unit), document.blocks, (unit) =>
                hitsOf.get(unit) ?? []
              )
            );
            const parsed = parseVerdict(raw, band.length);
            if (!parsed) {
              pruneDegraded.push('verdict_parse_failed');
              kept = [...kept, ...band.map((row) => row.unit)];
            } else {
              // 真的裁决过：去掉"消歧不可用"的标记，如实换成裁决结果。
              pruneDegraded = pruneDegraded.filter((item) => item !== 'verdict_model_unavailable');
              band.forEach((row, index) => {
                if (parsed.drop.has(index)) {
                  excluded = [
                    ...excluded,
                    { unit: row.unit, score: row.score, hits: row.hits, reason: 'verdict_model:drop' }
                  ];
                } else {
                  kept = [...kept, row.unit];
                }
              });
            }
          } catch {
            pruneDegraded.push('verdict_model_failed');
            kept = [...kept, ...band.map((row) => row.unit)];
          }
        }
      }
    }
  }
  const totalCharacters = units.reduce((total, unit) => total + unit.characters, 0);
  const keptCharacters = kept.reduce((total, unit) => total + unit.characters, 0);

  // 装带：按**页成本**累加，页只归第一条用到它的带（同一页不重复读）。
  // 单元顺序即文档顺序，所以带边界仍然落在结构单元的交界处。
  const claimed = new Set<number>();
  const bandPages: number[][] = [];
  let currentPages: number[] = [];
  let currentCost = 0;
  let oversized = false;
  const closeBand = (): void => {
    if (currentPages.length > 0) bandPages.push(currentPages);
    currentPages = [];
    currentCost = 0;
  };
  for (const unit of kept) {
    const fresh = unitPages(unit).filter((page) => !claimed.has(page));
    const addCost = pagesCostOf(fresh);
    if (currentPages.length > 0 && currentCost + addCost > budget) closeBand();
    // 一个单元（或单页）自己就超预算：按页装不下，交给上层降级处理。
    if (currentPages.length === 0 && addCost > budget * 1.1) oversized = true;
    for (const page of fresh) claimed.add(page);
    currentPages.push(...fresh);
    currentCost += addCost;
  }
  closeBand();
  const allPages = [...claimed].sort((left, right) => left - right);
  const name = store.getDocument(documentId)?.name ?? '';
  const sources: ReadingSource[] = allPages.map((page) => ({
    document_id: documentId,
    page,
    name,
    text: store.getPageText(documentId, page)
  }));
  const byPage = new Map(sources.map((source, index) => [source.page, [index + 1, source] as [number, ReadingSource]]));
  const groups = bandPages.map((pages) =>
    pages.map((page) => byPage.get(page)!).filter((row): row is [number, ReadingSource] => Boolean(row))
  );
  // 一页原文就超过预算时（超大字页），按页切会撑爆单次请求：退回字符切——
  // 但要记下原因，让上层能如实说明"这一轮没按章节边界装带"。
  if (oversized) {
    return { ...planReading(store, documentId, plan, currentPage, budget, overlap), planDegraded: 'page_exceeds_budget' };
  }
  if (groups.length === 0) {
    return { ...planReading(store, documentId, plan, currentPage, budget, overlap), planDegraded: 'no_units' };
  }
  return {
    pages: allPages,
    sources,
    batches: groups,
    batchCount: groups.length,
    multiPass: groups.length > 1,
    fromUnits: true,
    ...(integrityFailed ? { planDegraded: 'structure_integrity_failed' as const } : {}),
    ...(excluded.length > 0
      ? {
          excluded: excluded.map((row) => ({
            section: row.unit.sectionIndex,
            title: row.unit.title,
            pages: [row.unit.pagesFrom, row.unit.pagesTo] as [number, number],
            score: row.score,
            hits: row.hits,
            reason: row.reason
          }))
        }
      : {}),
    ...(totalCharacters > 0 ? { readRatio: keptCharacters / totalCharacters } : {}),
    ...(pruneDegraded.length > 0 ? { pruneDegraded } : {})
  };
}
