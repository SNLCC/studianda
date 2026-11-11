import type { DocumentChapter, ReadingPlanRecord } from '@studianda/shared';
import type { StructureNode } from './structure.js';
import type { Store } from './store.js';

/**
 * 本地目录（doc_navigation）→ 章区间：与 `chapterOutline` 同一个"章"的语义。
 *
 * 本地目录可以是「按目录页生成/按标题规则生成/手动编辑」的结果；只有 2 条以上有效节点才算分章。
 * 第一条之前的页（封面/前言）并入第一章，避免"从第 1 页读"语义丢失。
 */
export function chapterOutlineFromNavigation(
  nodes: readonly { page: number; label: string; kind?: string }[],
  totalPages: number
): ChapterRange[] {
  if (!Array.isArray(nodes) || nodes.length < 2) return [];
  if (!Number.isInteger(totalPages) || totalPages < 2) return [];
  const seen = new Set<number>();
  const valid = nodes
    .filter(
      (node) =>
        Number.isInteger(node.page) && node.page >= 1 && node.page <= totalPages && node.label.trim()
    )
    .sort((left, right) => left.page - right.page)
    .filter((node) => {
      if (seen.has(node.page)) return false;
      seen.add(node.page);
      return true;
    })
    .slice(0, MAX_CHAPTERS);
  if (valid.length < 2) return [];
  const chapters: ChapterRange[] = [];
  valid.forEach((node, index) => {
    const next = valid[index + 1];
    const start = index === 0 ? 1 : node.page;
    const end = next ? Math.max(start, next.page - 1) : totalPages;
    if (end < start) return;
    chapters.push({
      title: node.label.replace(/\s+/g, ' ').trim().slice(0, TITLE_LIMIT) || `第 ${index + 1} 节`,
      page: start,
      endPage: Math.min(totalPages, end),
      level: 1,
      index: index + 1
    });
  });
  return chapters;
}

/**
 * 读本地目录：只有 `ready + enabled` 才返回（与规划门禁一致）；否则返回空数组，
 * 调用方回退到结构树（PDF 书签/标题规则），保持旧行为。
 */
export async function chaptersFromLocalNavigation(
  store: Store,
  documentId: string,
  totalPages: number
): Promise<ChapterRange[]> {
  try {
    if (
      typeof store.navigationStatus !== 'function' ||
      typeof store.planningNavigation !== 'function'
    ) {
      return [];
    }
    const status = store.navigationStatus(documentId);
    if (!status || status.state !== 'ready' || !status.enabled) return [];
    return chapterOutlineFromNavigation(store.planningNavigation(documentId), totalPages);
  } catch {
    return [];
  }
}

/**
 * 局部阅读规划用：把请求页扩展到本地目录里的「所在章」（并集用，不替代结构树）。
 *
 * 只返回目录节点覆盖到的章页；调用方再与结构树 `expandSections` 的结果取并集，
 * 保证"目录接入只可能多读、不会少读"。
 */
export function navigationSectionPages(
  nodes: readonly { page: number; label: string; kind?: string }[],
  pages: readonly number[],
  totalPages: number
): number[] {
  const chapters = chapterOutlineFromNavigation(nodes, totalPages);
  if (chapters.length === 0) return [];
  const result = new Set<number>();
  for (const page of pages) {
    const chapter = chapters.find((item) => page >= item.page && page <= item.endPage);
    if (!chapter) continue;
    for (let target = chapter.page; target <= chapter.endPage; target += 1) {
      result.add(target);
    }
  }
  return [...result].sort((left, right) => left - right);
}

/**
 * 著作的"章节计划"：不把整本书一次性丢给模型，而是用目录把阅读拆成章。
 *
 * 规则（全部确定性，不调模型、不联网）：
 * - 只有**单篇著作**、且本轮计划被判成 `document`、且用户没有显式选"整篇"时才改写；
 * - 目录来源：启用的本地目录优先（`chaptersFromLocalNavigation`），否则
 *   `store.getStructure`（内嵌书签 / 标题规则）；不足 2 章就放弃改写，按原计划读；
 * - 选章顺序：问题术语命中章节标题 → 当前页所在章 → 第一张未读章（默认第一章）；
 * - 改写结果是 `local` 计划 + 明确的页码范围，后续的分批、证据、覆盖台账、继续阅读全部沿用现有链路。
 *
 * 这样"整本书精读"仍在：读完一章，未读页进入「继续阅读」，一轮一轮读完；区别只是每轮有章界，
 * 提示里能说清"读的是第几章"，而不是一轮默默吃掉前 70 页。
 */
export interface ChapterRange {
  /** 章标题（已截断，仅用于展示）。 */
  title: string;
  /** 起始页（第一章从第 1 页起，把封面/前言并进第一章，避免漏读）。 */
  page: number;
  /** 结束页（含）。 */
  endPage: number;
  /** 目录层级（同级为章）。 */
  level: number;
  /** 章序号（从 1 开始，按页序）。 */
  index: number;
}

const TITLE_LIMIT = 60;
const MAX_CHAPTERS = 80;
const TERM_LIMIT = 12;

/** 从问题/选文里取可用于匹配章标题的中文二字片段或英文词。 */
export function chapterTerms(text: string, limit = TERM_LIMIT): string[] {
  const found: string[] = [];
  const source = text ?? '';
  const matches = source.match(/[\u3400-\u9fff]+|[A-Za-z][A-Za-z0-9_-]{1,}/g) ?? [];
  const push = (term: string): void => {
    if (term.length < 2 || found.includes(term) || found.length >= limit) return;
    found.push(term);
  };
  for (const raw of matches) {
    if (/^[\x00-\x7f]/.test(raw)) {
      push(raw.toLowerCase());
      continue;
    }
    // 中文取二字片段：整段与标题未必逐字相同（"社会资本与" vs "社会资本"），
    // 用二字片段做包含匹配，比切长片段稳。
    const chars = [...raw];
    for (let index = 0; index + 1 < chars.length; index += 1) {
      push(`${chars[index]}${chars[index + 1]}`);
    }
  }
  return found;
}

/**
 * 目录 → 章区间。只取最浅一层作为"章"；若第一章之前还有页（封面/前言/版权页），并入第一章，
 * 保证"从第 1 页开始读"的语义不丢。
 */
export function chapterOutline(
  tree: readonly StructureNode[],
  totalPages: number
): ChapterRange[] {
  if (!Array.isArray(tree) || tree.length === 0) return [];
  if (!Number.isInteger(totalPages) || totalPages < 2) return [];
  const valid = tree.filter(
    (node) =>
      Number.isInteger(node.page) && node.page >= 1 && node.page <= totalPages && typeof node.title === 'string'
  );
  if (valid.length < 2) return [];
  const minLevel = Math.min(...valid.map((node) => node.level ?? 1));
  const top = valid
    .filter((node) => (node.level ?? 1) === minLevel)
    .sort((left, right) => left.page - right.page)
    .slice(0, MAX_CHAPTERS);
  if (top.length < 2) return [];
  const chapters: ChapterRange[] = [];
  top.forEach((node, index) => {
    const next = top[index + 1];
    const start = index === 0 ? 1 : node.page;
    const end = next ? Math.max(start, next.page - 1) : totalPages;
    if (end < start) return;
    chapters.push({
      title: (node.title ?? '').replace(/\s+/g, ' ').trim().slice(0, TITLE_LIMIT) || `第 ${index + 1} 节`,
      page: start,
      endPage: Math.min(totalPages, end),
      level: node.level ?? 1,
      index: index + 1
    });
  });
  return chapters;
}

/**
 * 选章：问题术语命中章标题优先；否则当前页所在章；再否则第一张未读章（默认第一章）。
 * `readPages` 用于"继续阅读"时跳过已读章（可选）。
 */
export function pickChapter(
  chapters: readonly ChapterRange[],
  question: string,
  selection: string,
  page: number,
  readPages: readonly number[] = []
): ChapterRange | null {
  if (chapters.length === 0) return null;
  const terms = chapterTerms(`${question}\n${selection}`);
  if (terms.length > 0) {
    const scored = chapters
      .map((chapter) => ({
        chapter,
        score: terms.filter((term) => chapter.title.toLowerCase().includes(term.toLowerCase()))
          .length
      }))
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score || left.chapter.page - right.chapter.page);
    if (scored[0]) return scored[0].chapter;
  }
  const read = new Set(readPages);
  const containing = chapters.find(
    (chapter) => page >= chapter.page && page <= chapter.endPage && !read.has(chapter.page)
  );
  if (containing) return containing;
  return chapters.find((chapter) => !read.has(chapter.page)) ?? chapters[0]!;
}

export interface ChapterResolution {
  plan: ReadingPlanRecord;
  /** 本轮确实按章时的章信息；未按章为 null。 */
  chapter: ChapterRange | null;
  /** 全书章数（未按章为 0）。 */
  total: number;
}

/** 章信息转成可进响应/接口的记录（只用于展示与"下一章"）。 */
export function chapterRecord(chapter: ChapterRange): DocumentChapter {
  return {
    index: chapter.index,
    title: chapter.title,
    page: chapter.page,
    end_page: chapter.endPage,
    level: chapter.level
  };
}

/**
 * 解析"这一轮读哪一章"：
 * - 用户显式给了 `chapterIndex` → 按索引取章（优先于自动选章）；
 * - 否则仅当 `scope=auto` 且计划是 `document`（著作）时，按问题术语/当前页自动选章；
 * - 不满足条件、非著作、目录不足 2 章时原样返回，`chapter` 为 null。
 */
export async function resolveChapterReading(
  store: Store,
  documentId: string | undefined,
  plan: ReadingPlanRecord,
  options: {
    scope: 'auto' | 'local' | 'document' | 'corpus';
    page: number;
    question: string;
    selection: string;
    chapterIndex?: number;
  }
): Promise<ChapterResolution> {
  const autoBook = options.scope === 'auto' && plan.breadth === 'document';
  if (!documentId || (options.chapterIndex == null && !autoBook)) {
    return { plan, chapter: null, total: 0 };
  }
  const document = store.getDocument(documentId);
  if (!document || document.docCategory !== 'book') {
    return { plan, chapter: null, total: 0 };
  }
  // 启用的本地目录优先；没有/未启用/过期时回退结构树（保持旧行为）。
  let chapters = await chaptersFromLocalNavigation(store, documentId, document.pages);
  if (chapters.length < 2) {
    let tree: StructureNode[] = [];
    try {
      tree = await store.getStructure(documentId);
    } catch {
      return { plan, chapter: null, total: 0 };
    }
    chapters = chapterOutline(tree, document.pages);
  }
  if (chapters.length < 2) return { plan, chapter: null, total: 0 };
  const chapter =
    options.chapterIndex != null
      ? chapters.find((item) => item.index === options.chapterIndex) ?? null
      : pickChapter(chapters, options.question, options.selection, options.page);
  if (!chapter) return { plan, chapter: null, total: 0 };
  const pages = Array.from(
    { length: chapter.endPage - chapter.page + 1 },
    (_, offset) => chapter.page + offset
  );
  const explicit = options.chapterIndex != null;
  return {
    plan: {
      ...plan,
      breadth: 'local',
      pages,
      reason: explicit
        ? `用户指定：第 ${chapter.index}/${chapters.length} 章 ${chapter.title}（第 ${chapter.page}–${chapter.endPage} 页）`
        : `著作按章阅读：${chapter.title}（第 ${chapter.page}–${chapter.endPage} 页，第 ${chapter.index}/${chapters.length} 章）`,
      origin: '规则'
    },
    chapter,
    total: chapters.length
  };
}

/**
 * 继续阅读时对齐到章界：按上一次读过的章定位，接着读**下一章**（只含未读页），
 * 而不是一次把剩余所有页都塞进本轮。返回 null 时调用方保留原来的"继续未读页"行为。
 */
export interface ChapterContinue {
  plan: ReadingPlanRecord;
  chapter: ChapterRange;
  total: number;
  pages: number[];
}

export async function nextChapterContinuePlan(
  store: Store,
  documentId: string,
  priorPlan: ReadingPlanRecord,
  unreadPages: readonly number[]
): Promise<ChapterContinue | null> {
  const document = store.getDocument(documentId);
  if (!document || document.docCategory !== 'book') return null;
  // 与 resolveChapterReading 同一口径：启用的本地目录优先，否则结构树。
  let chapters = await chaptersFromLocalNavigation(store, documentId, document.pages);
  if (chapters.length < 2) {
    let tree: StructureNode[] = [];
    try {
      tree = await store.getStructure(documentId);
    } catch {
      return null;
    }
    chapters = chapterOutline(tree, document.pages);
  }
  if (chapters.length < 2) return null;
  // 当前章：与上次计划页重叠最多的一章；没有（例如上次是整篇计划）就按第一个未读页定位。
  const priorPages = new Set(priorPlan.pages);
  let current: ChapterRange | undefined;
  let bestOverlap = 0;
  for (const chapter of chapters) {
    let overlap = 0;
    for (let page = chapter.page; page <= chapter.endPage; page += 1) {
      if (priorPages.has(page)) overlap += 1;
    }
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      current = chapter;
    }
  }
  if (!current && unreadPages.length > 0) {
    const first = unreadPages[0]!;
    current = chapters.find(
      (chapter) => chapter.page <= first && first <= chapter.endPage
    );
  }
  // 只有"上次确实读过某一章"才从它的下一章继续；上次是整篇/无章页时，
  // 从第一个还有未读页的章开始（通常就是第一章），不能跳章。
  const startIndex = bestOverlap > 0 && current ? current.index : 0;
  for (const chapter of chapters) {
    if (chapter.index <= startIndex) continue;
    const pages = unreadPages
      .filter((page) => page >= chapter.page && page <= chapter.endPage)
      .sort((left, right) => left - right);
    if (pages.length === 0) continue;
    return {
      plan: {
        ...priorPlan,
        breadth: 'local',
        pages,
        reason: `继续阅读：第 ${chapter.index}/${chapters.length} 章 ${chapter.title}（第 ${chapter.page}–${chapter.endPage} 页）`,
        origin: '规则'
      },
      chapter,
      total: chapters.length,
      pages
    };
  }
  return null;
}

/**
 * 把 `document` 计划改写成"按章阅读"计划；不满足条件时原样返回。
 *
 * 只在 `scope === 'auto'` 时改写：用户显式选"整篇"（reading_scope=document）就是解锁入口，
 * 不能再被自动拆成章。需要章信息（响应/UI）时用 `resolveChapterReading`。
 */
export async function bookChapterPlan(
  store: Store,
  documentId: string | undefined,
  plan: ReadingPlanRecord,
  scope: 'auto' | 'local' | 'document' | 'corpus',
  page: number,
  question: string,
  selection: string
): Promise<ReadingPlanRecord> {
  const resolved = await resolveChapterReading(store, documentId, plan, {
    scope,
    page,
    question,
    selection
  });
  return resolved.plan;
}
