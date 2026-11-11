/**
 * 参考文献识别：文末参考文献列表 + 页面底部脚注式引用。
 *
 * 目标：阅读时能查到"这条引用指的是哪篇文献"。输入是已经识别好的内容块
 * （`DocumentBlocks`），输出是结构化条目（作者/年份/标题/出处，尽力解析、解析不出就留空）
 * 与页面内引用标记（`[1]`、`[1–3]`、`(Smith, 2020)`…）及其指向。
 *
 * 这是**结构化识别**，不是新的原文证据：条目 `raw` 就是版面上的同一段文字；
 * 解析字段只是帮助显示，不参与引用核验。识别不出/解析不出时留空或不做猜测。
 */
import type {
  ContentBlock,
  DocumentBlocks,
  DocumentReferences,
  ReferenceCitation,
  ReferenceEntry,
  ReferenceEntryInput
} from '@studianda/shared';

/** 文末条目的编号样式：`[1]`、`(1)`、`1.`、`①`；脚注还常见 `*`/`†`。 */
const LABEL_PATTERNS: RegExp[] = [
  /^\s*\[(\d{1,3})\]\s*/,
  /^\s*\((\d{1,3})\)\s*/,
  /^\s*(\d{1,3})[.)、]\s*/,
  /^\s*([\u2460-\u2473])\s*/,
  /^\s*([*†‡])\s*/
];

const CIRCLED_START = 0x2460;
const CIRCLED_END = 0x2473;

/** 脚注里的书目特征：年份 + 出版信息/书名号/文献类型标识。 */
const FOOTNOTE_YEAR = /(?:19|20)\d{2}/;
const FOOTNOTE_BOOK = /《[^》]{2,140}》/;
const FOOTNOTE_PUBLISHER =
  /(?:出版社|印书馆|书局|学报|期刊|杂志|出版|Press|Journal|Vol\.?|No\.?|pp?\.|页|版社)/i;
const FOOTNOTE_TYPE = /\[[JMDCRSN]\]/i;
/** 英文条目常见的「姓, 名首字母.」作者样式。 */
const WESTERN_AUTHOR = /^[A-Z][A-Za-zÀ-ÿ'’\-]{1,30},\s*[A-Z][A-Za-zÀ-ÿ'’\-]?\./;

/**
 * 这段文字像不像一条参考文献（用于把"编号 + 书目"的脚注从标题/正文里分出来）。
 *
 * 只做保守判断：有文献类型标识，或「年份 + 出版信息/书名号」，或「西文作者 + 年份」。
 */
export function looksLikeReferenceText(text: string): boolean {
  const value = text.replace(/\s+/g, ' ').trim();
  if (value.length < 12 || value.length > 1200) return false;
  if (FOOTNOTE_TYPE.test(value)) return true;
  const year = FOOTNOTE_YEAR.test(value);
  if (!year) return false;
  if (FOOTNOTE_BOOK.test(value) || FOOTNOTE_PUBLISHER.test(value)) return true;
  return WESTERN_AUTHOR.test(value.replace(/^\s*(?:\[\d{1,3}\]|[\u2460-\u2473]|\d{1,3}[.)、])\s*/, ''));
}

/** 判断一个脚注块是否其实是"脚注式参考文献"（而不是普通说明注）。 */
export function looksLikeFootnoteReference(text: string): boolean {
  return looksLikeReferenceText(text);
}

function normalizeLabel(raw: string): string {
  const circled = raw.codePointAt(0);
  if (circled !== undefined && circled >= CIRCLED_START && circled <= CIRCLED_END) {
    return String(circled - CIRCLED_START + 1);
  }
  return raw.trim();
}

/** 从条目开头取编号；没有编号返回空标签。 */
function splitLabel(text: string): { label: string; rest: string } {
  for (const pattern of LABEL_PATTERNS) {
    const match = text.match(pattern);
    if (match?.[1]) {
      return { label: normalizeLabel(match[1]), rest: text.slice(match[0].length).trim() };
    }
  }
  return { label: '', rest: text.trim() };
}

/**
 * 一个块里挤了多条条目时按编号切开（常见于文末列表被段落识别合并）。
 *
 * 只认 `[n]`/`①` 这类不会与年份混淆的标记；`1.` 编号是否切开交给块边界
 * （参考文献条目的段落边界通常已经是分开的），避免把 "Vol. 12. pp. 45" 误切。
 */
function splitMergedEntries(text: string): string[] {
  const marker = /(?:\[\d{1,3}\]|[\u2460-\u2473])/g;
  const positions: number[] = [];
  let match: RegExpExecArray | null;
  while ((match = marker.exec(text)) !== null) {
    if (match.index > 0) positions.push(match.index);
  }
  if (positions.length === 0) return [text];
  const parts: string[] = [];
  let start = 0;
  for (const position of positions) {
    const part = text.slice(start, position).trim();
    if (part) parts.push(part);
    start = position;
  }
  const tail = text.slice(start).trim();
  if (tail) parts.push(tail);
  return parts;
}

function firstMatch(text: string, pattern: RegExp): string {
  const match = text.match(pattern);
  return match ? match[0].trim() : '';
}

/** 尽力解析条目字段：解析不出就留空，不猜。 */
export function parseReferenceFields(raw: string): {
  authors: string;
  year: string;
  title: string;
  venue: string;
} {
  const text = raw.replace(/\s+/g, ' ').trim();
  const year = firstMatch(text, /(?:19|20)\d{2}/);

  // GB/T 7714 风格：作者. 题名[J]. 刊名, 年, 卷(期): 页.
  // 先于"年份位置切作者"处理：这类条目的年份在末尾，按年份切会把整条当作者。
  const gbt = text.match(/^(.{1,160}?)[.．]\s*(.{2,200}?)\s*\[([JMDCRSN])\]\s*[.．]?\s*(.*)$/i);
  if (gbt) {
    const type = (gbt[3] ?? '').toUpperCase();
    const authors = (gbt[1] ?? '').trim();
    const title = (gbt[2] ?? '').trim();
    const rest = (gbt[4] ?? '').trim();
    const venue =
      type === 'J' || type === 'C' || type === 'D'
        ? (rest.match(/^([^,，;；]{2,80})/)?.[1] ?? '').trim()
        : '';
    return { authors, year, title, venue };
  }

  // 中文条目：作者：《书名》，出版地：出版社，年份，页码。
  const bookMatch = text.match(/《([^》]{1,140})》/);
  if (bookMatch?.[1]) {
    const title = bookMatch[1].trim();
    const before = text.slice(0, bookMatch.index ?? 0).replace(/[：:，,.\s]+$/, '');
    // 作者：书名号之前、最后一个中文/英文姓名段。
    const authors = before.split(/[：:，,]/).map((part) => part.trim()).filter(Boolean).pop() ?? '';
    const after = text.slice((bookMatch.index ?? 0) + bookMatch[0].length);
    const venue = after
      .replace(/^[，,。.\s]+/, '')
      .split(/[，,。]/)
      .map((part) => part.trim())
      .filter((part) => part && !/^\d{4}/.test(part) && !/^第?\d/.test(part))[0] ?? '';
    return { authors, year, title, venue };
  }

  // 英文/GB-T 条目。
  let authors = '';
  let title = '';
  let venue = '';

  if (year) {
    const index = text.indexOf(year);
    authors = text.slice(0, index).replace(/[（(.,;:\s]+$/, '').trim();
    const afterYear = text.slice(index + year.length).replace(/^[a-z]?[\s)\].,;:]+/, '');
    // 形如 "Title. Journal, 12(3), 45-67."：标题到第一个句末点。
    const titleMatch = afterYear.match(/^(.{2,200}?)(?:\.\s|[.]$|\[[JMDCRSN]\])/);
    title = (titleMatch?.[1] ?? '').trim();
    if (titleMatch) {
      const rest = afterYear.slice(titleMatch[0].length).replace(/^\[[JMDCRSN]\]\s*[.，,]?\s*/i, '');
      venue = (rest.match(/^([^,，;；]{2,80})/)?.[1] ?? '').trim();
    }
  }

  if (!title) {
    // 兜底：取第一个较长片段当标题（例如 "Smith, J. Alpha study." 没有年份）。
    const segments = text.split(/[.。]\s*/).map((part) => part.trim()).filter(Boolean);
    if (segments.length >= 2) title = segments[1] ?? '';
  }

  return { authors, year, title, venue };
}

interface RawCitation {
  raw: string;
  label: string;
  index: number;
}

const NUMERIC_CITATION = /\[(\d{1,3}(?:\s*[,，、\-–—~至]\s*\d{1,3})*)\]/g;
const AUTHOR_YEAR_CITATION =
  /\(\s*([A-Z][A-Za-zÀ-ÿ'’\-]{1,30})(?:\s+(?:et\s+al\.?|and\s+[A-Z][A-Za-zÀ-ÿ'’\-]{1,30}))?\s*,\s*((?:19|20)\d{2}[a-z]?)\s*\)/g;
const CJK_AUTHOR_YEAR_CITATION =
  /[（(]\s*([\u4e00-\u9fff]{2,6})\s*[，,]\s*((?:19|20)\d{2}[a-z]?)\s*[）)]/g;

/** 展开 `1,3-5` 这类数字引用为单个标签。 */
function expandNumericLabels(body: string): string[] {
  const labels: string[] = [];
  for (const part of body.split(/[,，、]/)) {
    const range = part.match(/^(\d{1,3})\s*[-–—~至]\s*(\d{1,3})$/);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      if (end >= start && end - start <= 20) {
        for (let value = start; value <= end; value += 1) labels.push(String(value));
      }
      continue;
    }
    const single = part.trim().match(/^\d{1,3}$/);
    if (single) labels.push(single[0]);
  }
  return labels;
}

function scanCitations(text: string): RawCitation[] {
  const found: RawCitation[] = [];
  let match: RegExpExecArray | null;
  NUMERIC_CITATION.lastIndex = 0;
  while ((match = NUMERIC_CITATION.exec(text)) !== null) {
    for (const label of expandNumericLabels(match[1] ?? '')) {
      found.push({ raw: `[${label}]`, label, index: match.index });
    }
  }
  for (const pattern of [AUTHOR_YEAR_CITATION, CJK_AUTHOR_YEAR_CITATION]) {
    pattern.lastIndex = 0;
    while ((match = pattern.exec(text)) !== null) {
      const surname = (match[1] ?? '').trim();
      const year = (match[2] ?? '').trim();
      if (!surname || !year) continue;
      found.push({ raw: match[0], label: `${surname} ${year}`, index: match.index });
    }
  }
  return found.sort((left, right) => left.index - right.index);
}

function snippetAround(text: string, index: number, length: number, limit = 120): string {
  const start = Math.max(0, index - Math.floor(limit / 2));
  const end = Math.min(text.length, index + length + Math.floor(limit / 2));
  return `${start > 0 ? '…' : ''}${text.slice(start, end).trim()}${
    end < text.length ? '…' : ''
  }`;
}

function resolveCitation(
  label: string,
  entries: ReferenceEntry[]
): ReferenceEntry[] {
  if (/^\d{1,3}$/.test(label)) {
    // 方括号数字编号只对应文末列表；页下注的 ①② 是另一套编号，不能混用。
    return entries.filter((entry) => entry.kind === 'end' && entry.label === label);
  }
  // author-year：先按姓名 + 年份精确匹配，再退回年份 + 原文包含姓氏。
  const space = label.lastIndexOf(' ');
  const surname = label.slice(0, space).trim().toLowerCase();
  const year = label.slice(space + 1).trim().toLowerCase();
  const exact = entries.filter(
    (entry) =>
      entry.year.toLowerCase() === year &&
      (entry.authors.toLowerCase().includes(surname) ||
        entry.raw.toLowerCase().includes(surname))
  );
  if (exact.length > 0) return exact;
  return entries.filter(
    (entry) => entry.year.toLowerCase().startsWith(year) && entry.raw.toLowerCase().includes(surname)
  );
}

function entryOfBlock(
  block: ContentBlock,
  kind: 'end' | 'footnote',
  sectionTitle: string,
  raw: string,
  label: string,
  index: number
): ReferenceEntry {
  const fields = parseReferenceFields(raw);
  return {
    id: `r${index}`,
    kind,
    source: 'recognized',
    label,
    raw,
    authors: fields.authors,
    year: fields.year,
    title: fields.title,
    venue: fields.venue,
    page: block.page,
    pageEnd: block.page,
    blockId: block.id,
    bbox: block.bbox,
    sectionTitle
  };
}

/**
 * 识别整篇文献的参考文献条目与页面内引用标记。
 *
 * - 文末列表：章节识别已把「参考文献/References…」小节里的块标成 `reference`；
 * - 页下注：内容是书目（有年份 + 出版信息/书名号/文献类型）的 `footnote` 块；
 * - 引用标记：正文块里的 `[1]`、`[1–3]`、`(Smith, 2020)`、`（张三，2020）`，
 *   能解析到条目的给 `entryIds`，解析不到就给空数组（不猜）。
 */
export function recognizeReferences(
  documentId: string,
  document: DocumentBlocks,
  version = ''
): DocumentReferences {
  const entries: ReferenceEntry[] = [];
  const citations: Record<string, ReferenceCitation[]> = {};
  const seenCitations = new Set<string>();

  const sectionTitleOf = (block: ContentBlock): string => {
    if (block.section < 0) return '';
    return document.sections.find((section) => section.index === block.section)?.title ?? '';
  };

  for (const block of document.blocks) {
    const text = block.text.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const isEndEntry = block.kind === 'reference';
    const isFootnoteEntry = block.kind === 'footnote' && looksLikeFootnoteReference(text);
    if (isEndEntry || isFootnoteEntry) {
      const kind: 'end' | 'footnote' = isEndEntry ? 'end' : 'footnote';
      const sectionTitle = sectionTitleOf(block);
      for (const piece of splitMergedEntries(text)) {
        const { label, rest } = splitLabel(piece);
        const raw = rest || piece;
        if (!raw.trim()) continue;
        entries.push(entryOfBlock(block, kind, sectionTitle, raw, label, entries.length));
      }
      continue;
    }
    if (block.kind === 'heading') continue;
    // 正文/列表/题注/普通脚注里的引用标记。
    for (const citation of scanCitations(text)) {
      const page = block.page;
      const key = `${page}\u0000${citation.label}\u0000${block.id}`;
      if (seenCitations.has(key)) continue;
      seenCitations.add(key);
      const list = citations[String(page)] ?? [];
      list.push({
        page,
        text: snippetAround(text, citation.index, citation.raw.length),
        label: citation.label,
        entryIds: [],
        blockId: block.id,
        bbox: block.bbox
      });
      citations[String(page)] = list;
    }
  }

  // 回填引用 → 条目
  let totalCitations = 0;
  let resolved = 0;
  for (const page of Object.keys(citations)) {
    for (const citation of citations[page] ?? []) {
      const matched = resolveCitation(citation.label, entries);
      citation.entryIds = matched.map((entry) => entry.id);
      totalCitations += 1;
      if (citation.entryIds.length > 0) resolved += 1;
    }
    citations[page]!.sort((left, right) => left.label.localeCompare(right.label));
  }

  return {
    documentId,
    version,
    entries,
    citations,
    stats: {
      pages: document.stats.pages,
      endEntries: entries.filter((entry) => entry.kind === 'end').length,
      footnoteEntries: entries.filter((entry) => entry.kind === 'footnote').length,
      manualEntries: 0,
      editedEntries: 0,
      citations: totalCitations,
      resolvedCitations: resolved,
      unresolvedCitations: totalCitations - resolved,
      staleEdits: 0
    }
  };
}

// ---------------------------------------------------------------------------
// 用户编辑：识别结果之上的覆盖层（修改 / 删除 / 新增）
// ---------------------------------------------------------------------------

/** 一条用户编辑记录（持久化在 `reference_edits` 表里，value 为 JSON）。 */
export interface ReferenceEditRecord {
  entryId: string;
  kind: 'override' | 'add' | 'delete';
  /** 记录编辑时的识别版本；版本不一致的编辑视为失效（不套用，如实计数）。 */
  stamp: string;
  patch?: ReferenceEntryInput;
  entry?: ReferenceEntryInput;
}

const TEXT_LIMITS: Record<keyof ReferenceEntryInput, number> = {
  label: 40,
  raw: 2000,
  authors: 200,
  year: 10,
  title: 300,
  venue: 200,
  page: 10,
  kind: 10
};

function cleanText(value: unknown, limit: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, limit) : '';
}

/** 规整用户输入：去多余空白、限长；非法字段忽略（不写入脏数据）。 */
export function sanitizeReferenceInput(input: unknown): ReferenceEntryInput {
  const source = (input ?? {}) as Record<string, unknown>;
  const result: ReferenceEntryInput = {};
  for (const key of ['label', 'raw', 'authors', 'year', 'title', 'venue'] as const) {
    if (source[key] === undefined) continue;
    const cleaned = cleanText(source[key], TEXT_LIMITS[key]);
    if (cleaned !== undefined) result[key] = cleaned;
  }
  if (source.page !== undefined) {
    const page = Number(source.page);
    if (Number.isFinite(page) && page >= 1) result.page = Math.max(1, Math.trunc(page));
  }
  if (source.kind === 'end' || source.kind === 'footnote' || source.kind === 'manual') {
    result.kind = source.kind;
  }
  return result;
}

function overrideEntry(entry: ReferenceEntry, patch: ReferenceEntryInput): ReferenceEntry {
  const next: ReferenceEntry = { ...entry, edited: true };
  if (patch.label !== undefined) next.label = patch.label;
  if (patch.raw !== undefined) next.raw = patch.raw;
  for (const key of ['authors', 'year', 'title', 'venue'] as const) {
    if (patch[key] !== undefined) next[key] = patch[key] as string;
  }
  // 只改了原文、没单独改作者/年份/标题/出处时，按新原文重新解析一遍。
  if (
    patch.raw !== undefined &&
    patch.authors === undefined &&
    patch.year === undefined &&
    patch.title === undefined &&
    patch.venue === undefined
  ) {
    const fields = parseReferenceFields(next.raw);
    next.authors = fields.authors;
    next.year = fields.year;
    next.title = fields.title;
    next.venue = fields.venue;
  }
  return next;
}

function manualEntry(entryId: string, input: ReferenceEntryInput): ReferenceEntry {
  const page = Math.max(1, Math.trunc(input.page ?? 1));
  const raw = (input.raw ?? '').trim();
  const parsed = raw ? parseReferenceFields(raw) : { authors: '', year: '', title: '', venue: '' };
  return {
    id: entryId,
    kind: input.kind ?? 'end',
    source: 'manual',
    label: (input.label ?? '').trim(),
    raw,
    authors: input.authors ?? parsed.authors,
    year: input.year ?? parsed.year,
    title: input.title ?? parsed.title,
    venue: input.venue ?? parsed.venue,
    page,
    pageEnd: page,
    blockId: '',
    // 手动条目没有版面位置：跳转按页，高亮整页。
    bbox: [0, 0, 1, 1],
    sectionTitle: ''
  };
}

function recount(entries: ReferenceEntry[], citations: Record<string, ReferenceCitation[]>, staleEdits: number): DocumentReferences['stats'] {
  let citationsTotal = 0;
  let resolved = 0;
  for (const page of Object.keys(citations)) {
    for (const citation of citations[page] ?? []) {
      citationsTotal += 1;
      if (citation.entryIds.length > 0) resolved += 1;
    }
  }
  return {
    pages: 0,
    endEntries: entries.filter((entry) => entry.kind === 'end').length,
    footnoteEntries: entries.filter((entry) => entry.kind === 'footnote').length,
    manualEntries: entries.filter((entry) => entry.source === 'manual').length,
    editedEntries: entries.filter((entry) => entry.edited).length,
    citations: citationsTotal,
    resolvedCitations: resolved,
    unresolvedCitations: citationsTotal - resolved,
    staleEdits
  };
}

/**
 * 把用户编辑套用到识别结果上：
 * - `override`：按条目 id 覆盖字段（找不到就忽略）；
 * - `delete`：隐藏该识别条目；
 * - `add`：新增一条手动条目（`u…` id）；
 * - 编辑版本与当前识别版本不一致 → 视为失效（`staleEdits` 计数并提示），不静默乱套。
 *
 * 套用后**重新解析**页面内引用 → 条目的指向，保证编辑后的编号/年份能影响引用解析。
 */
export function applyReferenceEdits(
  recognized: DocumentReferences,
  edits: ReferenceEditRecord[],
  version: string
): DocumentReferences {
  const editsForCurrent = edits.filter((edit) => !version || !edit.stamp || edit.stamp === version);
  const staleEdits = edits.length - editsForCurrent.length;
  const overrides = new Map<string, ReferenceEntryInput>();
  const deleted = new Set<string>();
  const additions: ReferenceEditRecord[] = [];
  for (const edit of editsForCurrent) {
    if (edit.kind === 'override' && edit.patch) overrides.set(edit.entryId, edit.patch);
    else if (edit.kind === 'delete') deleted.add(edit.entryId);
    else if (edit.kind === 'add') additions.push(edit);
  }

  const entries: ReferenceEntry[] = [];
  for (const entry of recognized.entries) {
    if (deleted.has(entry.id)) continue;
    const patch = overrides.get(entry.id);
    entries.push(patch ? overrideEntry(entry, patch) : entry);
  }
  for (const edit of additions) {
    if (deleted.has(edit.entryId)) continue;
    if (edit.entry) entries.push(manualEntry(edit.entryId, edit.entry));
  }
  entries.sort((left, right) => left.page - right.page);

  const citations: Record<string, ReferenceCitation[]> = {};
  for (const page of Object.keys(recognized.citations)) {
    citations[page] = (recognized.citations[page] ?? []).map((citation) => ({
      ...citation,
      entryIds: resolveCitation(citation.label, entries).map((entry) => entry.id)
    }));
  }

  const stats = recount(entries, citations, staleEdits);
  stats.pages = recognized.stats.pages;
  return {
    documentId: recognized.documentId,
    version: recognized.version || version,
    entries,
    citations,
    stats
  };
}
