import type { LayoutLine, LayoutPage, OutlineEntry, PdfLayout } from './pdf-layout.js';
import { looksLikeReferenceText } from './references.js';

export interface PageMask {
  id: string;
  documentId: string;
  page: number;
  scope: 'page' | 'all' | 'odd' | 'even' | 'range' | 'exclude';
  rangeStart?: number;
  rangeEnd?: number;
  excludePages?: number[];
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface StructureNode extends OutlineEntry {
  endPage: number;
  parent: number | null;
}

export function overlaps(
  bbox: [number, number, number, number],
  masks: Array<Pick<PageMask, 'x0' | 'y0' | 'x1' | 'y1'>>
): boolean {
  const [x0, y0, x1, y1] = bbox;
  return masks.some(
    (mask) => x0 < mask.x1 && x1 > mask.x0 && y0 < mask.y1 && y1 > mask.y0
  );
}

export function maskApplies(mask: PageMask, page: number): boolean {
  const scope = mask.scope || (mask.page === 0 ? 'all' : 'page');
  if (scope === 'page') return mask.page === page;
  if (scope === 'all') return true;
  if (scope === 'odd') return page % 2 === 1;
  if (scope === 'even') return page % 2 === 0;
  if (scope === 'range') {
    const start = mask.rangeStart ?? 1;
    const end = mask.rangeEnd ?? Number.MAX_SAFE_INTEGER;
    return page >= start && page <= end;
  }
  if (scope === 'exclude') return !(mask.excludePages ?? []).includes(page);
  return false;
}

export function masksForPage(masks: PageMask[], page: number): PageMask[] {
  return masks.filter((mask) => maskApplies(mask, page));
}

export function visibleLines(page: LayoutPage, masks: PageMask[]): LayoutLine[] {
  const applicable = masksForPage(masks, page.page);
  return page.lines.filter((line) => !overlaps(line.bbox, applicable));
}

export interface BboxLine {
  bbox: [number, number, number, number];
}

/**
 * 页面行的**唯一**阅读顺序实现（PDF 抽行、引用定位、chunks 生成共用）。
 *
 * 规则：
 * - 先判双栏：左栏 = 右边界 < 页宽×0.55 且 ≥4 行；右栏 = 左边界 > 页宽×0.45 且 ≥4 行；
 *   并要求左栏最右 < 右栏最左（否则视为单栏/无法判定）。
 * - 双栏：横跨两栏的行（既不属于左也不属于右）作为**分割点**；按 y 升序遍历分割点，
 *   先输出其上方的带（带内按 `x0 > 页宽×0.45` 分栏——左栏在前、右栏在后，栏内 y,x），
 *   再输出分割行本身；最后输出剩余带。因此跨栏标题在页首时最先输出，且不会把标题
 *   下方的右栏文字排到标题之前。
 * - 单栏/无效页宽：退回 y,x 稳定排序。
 *
 * `pageWidth` 与 bbox 必须同一坐标空间：归一化 bbox 传 1，页面点坐标传页宽。
 */
export function orderPageLines<T extends BboxLine>(
  lines: T[],
  pageWidth = 1
): T[] {
  const validWidth = Number.isFinite(pageWidth) && pageWidth > 0;
  const width = validWidth ? pageWidth : 1;
  const byPosition = (left: T, right: T): number =>
    left.bbox[1] - right.bbox[1] || left.bbox[0] - right.bbox[0];
  if (!validWidth) return [...lines].sort(byPosition);
  const left = lines.filter((line) => line.bbox[2] < width * 0.55);
  const right = lines.filter((line) => line.bbox[0] > width * 0.45);
  const twoColumns =
    left.length >= 4 &&
    right.length >= 4 &&
    Math.max(...left.map((line) => line.bbox[2])) < Math.min(...right.map((line) => line.bbox[0]));
  if (!twoColumns) return [...lines].sort(byPosition);

  const wide = lines.filter((line) => !left.includes(line) && !right.includes(line));
  const separators = [...wide].sort(
    (leftLine, rightLine) =>
      leftLine.bbox[1] - rightLine.bbox[1] || leftLine.bbox[0] - rightLine.bbox[0]
  );
  const remaining = new Set(lines);
  const ordered: T[] = [];
  const takeBand = (limit: number): void => {
    // 整带按“左栏(0) → 右栏(1)，再 y、x”排序；
    // 这样同一条带里不会把右栏文字排到左栏前面。
    const band = [...remaining].filter((line) => line.bbox[1] < limit);
    band.sort(
      (upper, lower) =>
        (upper.bbox[0] > width * 0.45 ? 1 : 0) - (lower.bbox[0] > width * 0.45 ? 1 : 0) ||
        upper.bbox[1] - lower.bbox[1] ||
        upper.bbox[0] - lower.bbox[0]
    );
    for (const line of band) {
      if (remaining.delete(line)) ordered.push(line);
    }
  };
  for (const separator of separators) {
    takeBand(separator.bbox[1]);
    if (remaining.delete(separator)) ordered.push(separator);
  }
  takeBand(Number.POSITIVE_INFINITY);
  return ordered;
}

/** 保守双栏阅读顺序（可见行 → 统一排序）。 */
export function readingOrderLines(page: LayoutPage, masks: PageMask[] = []): LayoutLine[] {
  return orderPageLines(visibleLines(page, masks), 1);
}

export function pageLabel(lines: LayoutLine[], limit = 80): string {
  const line = lines
    .map((item) => item.text.replace(/\s+/g, ' ').trim())
    .find(Boolean);
  return line ? line.slice(0, limit) : '';
}

/** 章节词标题（Abstract / 参考文献 / 结论 …）：整行是这些词，或「词 + 短副标题」。 */
const SECTION_WORD =
  /^(?:abstract|introduction|background|related\s+work|literature\s+review|methods?|methodology|materials?\s+and\s+methods?|experimental\s+(?:setup|results?)|results?|discussion|conclusions?|limitations|future\s+work|acknowledg(?:e)?ments?|references|bibliography|works\s+cited|appendix|摘要|引言|前言|绪论|导论|背景|方法|研究方法|材料与方法|结果|讨论|结论|局限性|致谢|参考文献|引用文献|参考资料|附录)(?:\s*[:：—–-].{0,40})?$/i;

/** 作者/单位/邮箱这类首页装饰行：即使居中、字号偏大也不该当成章节标题。 */
const AUTHOR_OR_AFFILIATION =
  /(?:\bauthors?\b|corresponding\s+author|作者|@|大学|学院|研究院|研究所|university|college|institute|department|laborator)/i;

export function heading(
  text: string,
  size?: number,
  bodySize?: number
): { title: string; level: number } | null {
  const line = text.trim();
  if (!line || line.length > 120) return null;
  // 纯日期、页码、标点残片不应当成为目录标题。
  if (!/[\p{L}\u3400-\u9fff]/u.test(line)) return null;
  if (/^\d{4}\s*[-/.]\s*\d{1,2}/.test(line)) return null;
  // 作者/单位行（带逗号、邮箱）不是标题，哪怕带编号。
  if (/(?:[,，]|@)/.test(line) && AUTHOR_OR_AFFILIATION.test(line)) return null;
  // 纯书目条目（"[1] Smith, J. (2020)…"）是参考文献，不是章节标题：
  // 否则文末参考文献会被拆进目录、内容块也会把条目当标题。
  if (looksLikeReferenceText(line)) return null;

  // 中文章节：第一章 / 第一节 / 一、 / （一） / 1、 / 1．
  const cjkChapter = line.match(/^第([一二三四五六七八九十百千\d]+)([章节节篇部])/);
  if (cjkChapter) return { title: line, level: cjkChapter[2] === '章' ? 1 : 2 };
  const cjkOrdered = line.match(/^[一二三四五六七八九十百千]{1,4}[、.．)）]\s*(?=[\u4e00-\u9fffA-Z])/);
  if (cjkOrdered) return { title: line, level: 2 };
  const cjkParen = line.match(/^[（(][一二三四五六七八九十百千]{1,4}[)）]\s*(?=[\u4e00-\u9fffA-Z])/);
  if (cjkParen) return { title: line, level: 3 };

  // 阿拉伯数字编号：1 / 1.1 / 1.1.1；分隔符支持 . ． 、 ) ） 或纯空格（"1 引言"）。
  const numbered = line.match(/^(\d+(?:[.．]\d+){0,3})(?:[.．、)）]\s*|\s+)(?=[A-Z\u4e00-\u9fff])/);
  const chapter = line.match(/^(?:chapter|section|part)\s+[ivxlcdm\d]+\b/i);
  if (numbered || chapter) {
    // "1 This is a whole sentence of body text…" 这种只有空格、没有编号分隔符的长行
    // 更可能是正文里的编号列表项，不当标题。
    const explicitSeparator = /^\d+(?:[.．]\d+)*[.．、)）]/.test(line);
    if (!explicitSeparator && !chapter && line.length > 60) return null;
    // “1 Department of A, University…” 这类编号作者行不是小节标题：
    // 没有 1./1.1 这种显式编号、字号又不比正文大时，按普通正文处理。
    const explicitNumber = /^\d+(?:[.．]\d+){0,3}[.．、)）]/.test(line);
    const looksLikeAffiliation =
      !explicitNumber &&
      (line.includes(',') || line.split(/\s+/).length > 7) &&
      size != null &&
      bodySize != null &&
      size <= bodySize * 1.04;
    if (looksLikeAffiliation) return null;
    if (numbered?.[1]) {
      return { title: line, level: numbered[1].split(/[.．]/).length };
    }
    return { title: line, level: 1 };
  }
  // 常见的罗马数字/字母编号小节标题（如 "I. INTRODUCTION"、"A. System Overview"）。
  const roman = line.match(/^[IVXLC]{1,6}\.\s+(?:[A-Z][A-Za-z]|[\u4e00-\u9fff])/);
  if (roman) return { title: line, level: 1 };
  const lettered = line.match(/^[A-Z]\.\s+(?:[A-Z][a-z]|[\u4e00-\u9fff])/);
  if (lettered) return { title: line, level: 2 };
  if (SECTION_WORD.test(line)) {
    return { title: line, level: 1 };
  }
  return null;
}

/**
 * 全篇正文字号中位数（pt）。
 *
 * 单页中位数在"封面/版权页只有少数大字号行"或"整页都是标题"时会把正文字号带偏，
 * 所以标题判定统一对比全篇中位数（页面自己的中位数只在没有字号时兜底）。
 * 只统计有实际宽度的行，避免页码/孤立符号拉低中位数。
 */
export function documentBodySize(
  layout: PdfLayout,
  masks: PageMask[] = [],
  marginNoise?: Set<string>
): number | undefined {
  const sizes: number[] = [];
  for (const page of layout.pages) {
    for (const line of visibleLines(page, masks)) {
      if (typeof line.size !== 'number' || !(line.size > 0)) continue;
      if (line.bbox[2] - line.bbox[0] <= 0.12) continue;
      if (marginNoise?.has(line.text.replace(/\s+/g, ' ').trim())) continue;
      sizes.push(line.size);
    }
  }
  if (sizes.length === 0) return undefined;
  sizes.sort((left, right) => left - right);
  return sizes[Math.floor(sizes.length / 2)];
}

export function sectionTree(
  entries: Array<Partial<OutlineEntry> & { title: string; page: number; level?: number }>,
  total: number
): StructureNode[] {
  const rows = entries
    .filter((entry) => entry.page >= 1 && entry.page <= total)
    .map((entry) => ({ ...entry, level: Math.max(1, entry.level ?? 1) }))
    .sort((left, right) => left.page - right.page);
  const result: StructureNode[] = [];
  const stack: number[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    while (stack.length > 0 && result[stack[stack.length - 1]!]!.level >= row.level) {
      stack.pop();
    }
    const next = rows.slice(index + 1).find((candidate) => (candidate.level ?? 1) <= row.level);
    result.push({
      title: row.title,
      page: row.page,
      level: row.level,
      origin: row.origin ?? '标题规则（可能不完整）',
      endPage: next?.page ?? total,
      parent: stack.length ? stack[stack.length - 1]! : null
    });
    stack.push(index);
  }
  return result;
}

/**
 * 把局部页码扩展到所在章节：
 * - 命中标题覆盖页：读其父节（有父节时），保留兄弟小节的限定条件；
 * - 落在标题覆盖不到的地方：取最近的后继标题并上溯父节，范围钳制在“该页 + 相邻一节”，
 *   不因为一次局部提问退回通读全书；
 * - 没有目录时保守返回全篇（无法确定论证边界）。
 */
export function expandSections(
  pages: number[],
  tree: StructureNode[],
  total: number
): Set<number> {
  if (tree.length === 0) return new Set(Array.from({ length: total }, (_, index) => index + 1));
  const expanded = new Set<number>();
  for (const page of pages) {
    const matches = tree.filter((node) => node.page <= page && page <= node.endPage);
    if (matches.length === 0) {
      const following = tree.filter((node) => node.page >= page);
      let node =
        following.length > 0
          ? following.reduce((left, right) => (left.page <= right.page ? left : right))
          : tree[tree.length - 1]!;
      if (node.parent !== null) node = tree[node.parent]!;
      const start = Math.max(1, Math.min(page, node.page) - 1);
      const end = Math.min(total, Math.max(node.endPage, page) + 1);
      for (let candidate = start; candidate <= end; candidate += 1) expanded.add(candidate);
      continue;
    }
    let node = matches.reduce((best, candidate) =>
      candidate.level > best.level ||
      (candidate.level === best.level && candidate.page > best.page)
        ? candidate
        : best
    );
    if (node.parent !== null) node = tree[node.parent]!;
    const start = Math.max(1, node.page - 1);
    const end = Math.min(total, node.endPage + 1);
    for (let candidate = start; candidate <= end; candidate += 1) expanded.add(candidate);
  }
  return expanded;
}

/** 页眉/页脚等跨页重复的边距文字，不应进入标题候选（内容块识别也用它排除页眉行）。 */
export function repeatedMarginTexts(layout: PdfLayout): Set<string> {
  const counts = new Map<string, number>();
  for (const page of layout.pages) {
    const seen = new Set<string>();
    for (const line of page.lines) {
      if (line.bbox[1] > 0.12 && line.bbox[3] < 0.9) continue;
      const text = line.text.replace(/\s+/g, ' ').trim();
      if (text.length < 2 || text.length > 80 || seen.has(text)) continue;
      seen.add(text);
      counts.set(text, (counts.get(text) ?? 0) + 1);
    }
  }
  // 2 页以内的短文没有"重复 3 次"的机会：页眉/页脚在两页都出现就该排除。
  const threshold =
    layout.pages.length <= 2 ? 2 : Math.max(3, Math.ceil(layout.pages.length * 0.3));
  return new Set(
    [...counts.entries()].filter(([, count]) => count >= threshold).map(([text]) => text)
  );
}

export function documentStructure(layout: PdfLayout, masks: PageMask[]): StructureNode[] {
  if (layout.outline.length > 0) {
    return sectionTree(layout.outline, layout.pages.length);
  }
  const marginNoise = repeatedMarginTexts(layout);
  // 全篇正文字号中位数：单页中位数在封面/标题页会严重偏大，导致正文页的标题判定失真。
  const documentSize = documentBodySize(layout, masks, marginNoise);
  const entries: Array<{ title: string; page: number; level: number; origin: string }> = [];
  for (const page of layout.pages) {
    const lines = visibleLines(page, masks).filter(
      (line) => !marginNoise.has(line.text.replace(/\s+/g, ' ').trim())
    );
    const sizes = lines
      .map((line) => line.size)
      .filter((size): size is number => typeof size === 'number' && size > 0)
      .sort((left, right) => left - right);
    const pageSize = sizes.length > 0 ? sizes[Math.floor(sizes.length / 2)] : undefined;
    // 优先全篇中位数；全篇没有字号信息时退回本页中位数。
    const bodySize = documentSize ?? pageSize;
    const maxSize = sizes.length > 0 ? sizes[sizes.length - 1] : undefined;
    for (const line of lines) {
      let item = heading(line.text, line.size, bodySize);
      // 版面标题：字号接近本页最大、水平居中、位于页面上部。
      const centered =
        line.bbox[0] + line.bbox[2] > 0.7 &&
        line.bbox[0] + line.bbox[2] < 1.3 &&
        line.bbox[2] - line.bbox[0] < 0.86;
      const looksLikeAuthor =
        /[,，]/.test(line.text) &&
        /(大学|学院|研究院|研究所|系|@|university|college|institute)/i.test(line.text);
      if (
        !item &&
        maxSize != null &&
        bodySize != null &&
        line.size != null &&
        line.size >= maxSize * 0.98 &&
        line.size >= bodySize * 1.18 &&
        centered &&
        line.bbox[1] < 0.4 &&
        line.text.trim().length >= 3 &&
        !looksLikeAuthor
      ) {
        item = { title: line.text.trim(), level: 1 };
      }
      // 跨栏标题：整行宽、字号略大于正文，通常横跨左右栏。
      const fullWidth = line.bbox[2] - line.bbox[0] > 0.62;
      if (
        !item &&
        fullWidth &&
        bodySize != null &&
        line.size != null &&
        line.size >= bodySize * 1.22 &&
        line.text.trim().length >= 3 &&
        line.text.trim().length <= 90 &&
        !looksLikeAuthor
      ) {
        item = { title: line.text.trim(), level: 1 };
      }
      // 非首页/非居中的大字号章节标题；作者与单位行单独排除。
      if (
        !item &&
        bodySize != null &&
        line.size != null &&
        line.size >= bodySize * 1.3 &&
        line.text.trim().length >= 3 &&
        line.text.trim().length <= 90 &&
        !looksLikeAuthor
      ) {
        item = { title: line.text.trim(), level: 1 };
      }
      if (item) entries.push({ ...item, page: page.page, origin: '标题规则（可能不完整）' });
    }
  }
  return sectionTree(entries, layout.pages.length);
}

export interface VisualNode {
  kind: 'figure' | 'table' | 'equation';
  page: number;
  caption: string;
}

export function visualNodes(layout: PdfLayout, masks: PageMask[]): VisualNode[] {
  const nodes: VisualNode[] = [];
  for (const page of layout.pages) {
    for (const line of visibleLines(page, masks)) {
      const text = line.text.replace(/\s+/g, ' ').trim();
      if (!text) continue;
      if (/^(?:fig(?:ure)?\.?|table|图|表)\s*[\d一二三四五六七八九十]/i.test(text)) {
        nodes.push({
          kind: /^(?:fig|图)/i.test(text) ? 'figure' : 'table',
          page: page.page,
          caption: text.slice(0, 300)
        });
      } else if (/[=∑∫√≈≤≥]/.test(text)) {
        nodes.push({ kind: 'equation', page: page.page, caption: text.slice(0, 300) });
      }
    }
  }
  return nodes;
}

/**
 * 本地目录的节点表：
 * - 章节标题按页去重，同一页只保留层级最高（level 最小）的一个 `section`；
 * - 没有章节标题的页，用**遮罩后**首行生成 `page` 节点（不能拿页眉/页码，那靠 masks 过滤）；
 * - 没有文字的页不生成节点；同页 section 优先于 page；section 以页码、层序稳定排序。
 * 这里不调用模型，只做本机版式规则。
 */
export function navigationNodes(
  layout: PdfLayout,
  masks: PageMask[]
): Array<{ page: number; kind: string; label: string }> {
  const tree = documentStructure(layout, masks);
  // 同一页可能有多个标题（章 + 节落在同页）：只保留层级最高（level 最小）的一个；
  // 相等层级保留先出现的那个，结果与树的顺序无关。
  const sections = new Map<number, { level: number; label: string }>();
  for (const node of tree) {
    if (!Number.isInteger(node.page) || node.page < 1) continue;
    const label = pageLabel([{ text: node.title, bbox: [0, 0, 1, 1] }]);
    if (!label) continue;
    const level = Math.max(1, node.level ?? 1);
    const current = sections.get(node.page);
    if (!current || level < current.level) {
      sections.set(node.page, { level, label });
    }
  }
  const rows: Array<{ page: number; kind: string; label: string }> = [];
  for (const page of [...sections.keys()].sort((left, right) => left - right)) {
    rows.push({ page, kind: 'section', label: sections.get(page)!.label });
  }
  // 没有章节标题的页：用遮罩后首行作为页面标签（与 page_label 同口径：压缩空白、限长）。
  for (const page of layout.pages) {
    if (sections.has(page.page)) continue;
    const label = pageLabel(visibleLines(page, masks).filter((line) => line.text.trim()));
    if (!label) continue;
    rows.push({ page: page.page, kind: 'page', label });
  }
  // 首页既没有 section 也没有 page 标签时，才用首页字号最大的有意义行兜底；
  // 已有 section/page 的页不重复添加（对齐"目录只负责跳转"的旧兜底，且避免重复条目）。
  const firstPage = layout.pages[0];
  if (firstPage && !rows.some((row) => row.page === 1)) {
    const marginNoise = repeatedMarginTexts(layout);
    const lines = visibleLines(firstPage, masks)
      .filter((line) => /[\p{L}\u3400-\u9fff]/u.test(line.text))
      .filter((line) => !marginNoise.has(line.text.replace(/\s+/g, ' ').trim()))
      .sort((left, right) => (right.size ?? 0) - (left.size ?? 0));
    const title = lines[0];
    if (title) {
      rows.push({
        page: 1,
        kind: 'title',
        label: title.text.replace(/\s+/g, ' ').trim().slice(0, 120)
      });
    }
  }
  const kindOrder = (kind: string): number => (kind === 'section' ? 0 : kind === 'page' ? 1 : 2);
  rows.sort((left, right) => left.page - right.page || kindOrder(left.kind) - kindOrder(right.kind));
  return rows;
}

const SENTENCE_END = new Set(['。', '！', '？', '…', '!', '?', '.']);
const TRAILING_CLOSERS = new Set(['”', '’', '"', "'", '）', ')', '】', '」', '』', '》', '>', ']']);
const LIST_OR_HEADING =
  /^\s*(?:[•·▪◦*\-–—]|\(?\d{1,3}[.)、]|[一二三四五六七八九十]{1,3}[、.)]|第[一二三四五六七八九十百\d]{1,4}[章节条]|(?:fig(?:ure)?|table|图|表|式)\s*[\d一二三四五六七八九十])/i;

/** 行尾是否真句末：先剥掉收尾引号/括号，避免把“…”当成句子结束。 */
export function endsSentenceLine(line: string): boolean {
  let trimmed = (line ?? '').trimEnd();
  while (trimmed && TRAILING_CLOSERS.has(trimmed[trimmed.length - 1]!)) {
    trimmed = trimmed.slice(0, -1).trimEnd();
  }
  return trimmed.length > 0 && SENTENCE_END.has(trimmed[trimmed.length - 1]!);
}

function needsSpace(left: string, right: string): boolean {
  const tail = left[left.length - 1] ?? '';
  const head = right[0] ?? '';
  return /[A-Za-z0-9]/.test(tail) && /[A-Za-z0-9]/.test(head);
}

/**
 * 把扫描/排版造成的硬换行合并成自然段。
 * 只用于展示与选文；页面阅读文本保留逐行结构，引用定位依赖行框。
 */
export function reflowLines(text: string): string {
  const paragraphs: string[] = [];
  let buffer = '';
  for (const raw of String(text ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')) {
    const line = raw.trim();
    if (!line) {
      if (buffer) {
        paragraphs.push(buffer);
        buffer = '';
      }
      continue;
    }
    if (!buffer) {
      buffer = line;
      continue;
    }
    if (endsSentenceLine(buffer) || LIST_OR_HEADING.test(line)) {
      paragraphs.push(buffer);
      buffer = line;
      continue;
    }
    if (heading(buffer)) {
      paragraphs.push(buffer);
      buffer = line;
      continue;
    }
    if (buffer.endsWith('-') && /[A-Za-z]/.test(line[0] ?? '')) {
      buffer += line;
    } else if (needsSpace(buffer, line)) {
      buffer += ` ${line}`;
    } else {
      buffer += line;
    }
  }
  if (buffer) paragraphs.push(buffer);
  return paragraphs.join('\n\n');
}

export interface TextQuality {
  /** 替换字符/私用区/控制/代理字符占比 > 2% 即判可疑。 */
  suspect: boolean;
  bad_ratio: number;
  characters: number;
}

/**
 * 文本质量判定。
 *
 * 中文旧排版、私有区字体、部分扫描件文本层会出现"有文字但不可读"的页：替换字符
 * U+FFFD、私用区 (Co)、控制字符 (Cc)、孤立代理 (Cs) 占比超过 2% 即视为疑似解析异常，
 * 由调用方决定是否触发 OCR，或在报告里如实标出。
 */
export function textQuality(text: string): TextQuality {
  const characters = [...(text ?? '')].filter((char) => !/\s/u.test(char));
  if (characters.length === 0) return { suspect: false, bad_ratio: 0, characters: 0 };
  const bad = characters.filter(
    (char) => char === '\uFFFD' || /[\p{Co}\p{Cc}\p{Cs}]/u.test(char)
  ).length;
  const ratio = bad / characters.length;
  return {
    suspect: ratio > 0.02,
    bad_ratio: Math.round(ratio * 10000) / 10000,
    characters: characters.length
  };
}

