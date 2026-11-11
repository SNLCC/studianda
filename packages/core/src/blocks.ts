/**
 * 文献内容块 / 章节识别。
 *
 * 目的：把"按行切出来的文本"还原成**可引用的单位**——章节标题、自然段、列表项、
 * 图表题注、公式、脚注、参考文献条目——供导航、引用锚定与问答索引使用。
 *
 * 与 `structure.ts` 的分工：
 * - `structure.documentStructure` 只给"标题在**哪一页**"（页码粒度的目录/章节树）；
 * - 这里给出"标题在页面的**哪个位置**、正文被切成哪些块、块属于哪一节"（版面粒度）。
 *
 * 段落边界复用 `@studianda/shared` 的 `paragraphGroups`（阅读区批注也用同一套规则），
 * 所以界面里选中的"一段"与问答索引里的"一块"是同一段文字。
 *
 * 全部是纯函数：输入 `PdfLayout`（页面行 + 归一化 bbox）与页遮罩，输出内容块与章节；
 * 不读数据库、不调模型、不联网。识别结果**不是**新的原文证据：块的 text 就是版面上
 * 同一段文字，块只是给它一个可引用的单位与位置。
 */
import { paragraphGroups, type ParagraphLine } from '@studianda/shared';
import type {
  ContentBlock,
  ContentBlockKind,
  DocumentBlocks,
  DocumentBlocksStats,
  DocumentSection,
  DocumentSectionIndex,
  DocumentSectionKind,
  SectionIndexChunk
} from '@studianda/shared';
import type { LayoutLine, PdfLayout } from './pdf-layout.js';
import {
  heading,
  readingOrderLines,
  repeatedMarginTexts,
  type PageMask
} from './structure.js';
import { looksLikeReferenceText } from './references.js';

export interface RecognizeOptions {
  documentId?: string;
  /** 文档标题：仅用于没有标题的"前置部分"（封面/版权页等）的展示，不参与判定。 */
  title?: string;
}

/** 列表项起始标记：项目符号，或"编号/字母 + 大写字母/汉字的后续内容"（避免把句中 "(3) write…" 当列表）。 */
const LIST_MARKER =
  /^(?:[•·▪◦‣※*+\-–—]\s+|(?:[\[(]?[0-9]{1,3}[.)\]]|[a-zA-Z][.)])\s+(?:[A-Z\u4e00-\u9fff]))/;

/** 图表题注 / 数据来源行。 */
const CAPTION_LINE =
  /^(?:fig(?:ure)?\.?\s*[0-9IVXLC]|table\s*[0-9IVXLC]|图\s*[0-9一二三四五六七八九十]|表\s*[0-9一二三四五六七八九十]|source\s*[:：]|资料来源\s*[:：])/i;

/** 作者/单位/邮箱这类首页装饰行：即使居中、字号偏大也不该当成章节标题。 */
const AUTHOR_OR_AFFILIATION =
  /(?:\bauthors?\b|\bcorresponding\s+author\b|作者|@|大学|学院|研究院|研究所|university|college|institute|department|laborator|school\s+of)/i;

/** 明显的数学/公式符号。 */
const FORMULA_SYMBOL = /[=∑∫√≈≤≥∞∂∇±×÷≠∈⊂⊆∪∩∀∃→←↔]/;

const REFERENCE_TITLE =
  /^(?:references?|bibliography|works\s+cited|literature\s+cited|参考文献|引用文献|参考资料)$/i;
const APPENDIX_TITLE = /^(?:appendix|appendices|附录)$/i;
const ABSTRACT_TITLE = /^(?:abstract|摘要)$/i;

const DEFAULT_BODY_SIZE = 0.012;

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

/**
 * 标题层级：`2.1 Methods` → 2，`第三章`/`Chapter 3`/`I.` → 1，`A.`/`一、` → 2。
 *
 * 只按文字编号判断，不看字号；字号只影响"是不是标题"（见 `heading` 与居中/放大规则）。
 */
export function headingLevel(text: string): number {
  const line = text.trim();
  const numbered = line.match(/^(\d+(?:\.\d+){0,3})[.)]?[\s、]+/);
  if (numbered?.[1]) return Math.min(4, numbered[1].split('.').length);
  if (
    /^(?:第[一二三四五六七八九十百千\d]+[章节节]|chapter\s+\d+|section\s+\d+|part\s+[ivxlcdm\d]+)/i.test(
      line
    )
  ) {
    return 1;
  }
  if (/^[IVXLC]{1,6}\.\s+\S/.test(line)) return 1;
  if (/^[A-Z]\.\s+[A-Z][a-z]/.test(line)) return 2;
  if (/^[一二三四五六七八九十]{1,4}[、.)）]\s*/.test(line)) return 2;
  return 1;
}

/** 小节类别：摘要 / 参考文献 / 附录 / 正文（空标题视为前置部分）。 */
export function sectionKindOf(title: string): DocumentSectionKind {
  const text = title.replace(/\s+/g, ' ').trim();
  if (!text) return 'front';
  if (ABSTRACT_TITLE.test(text)) return 'abstract';
  if (REFERENCE_TITLE.test(text)) return 'references';
  if (APPENDIX_TITLE.test(text)) return 'appendix';
  if (/^(?:appendix|appendices|附录)\b/i.test(text)) return 'appendix';
  if (/^(?:references?|bibliography|works\s+cited|参考文献)\b/i.test(text)) return 'references';
  return 'body';
}

/**
 * 归一化标题文本，用于把 PDF 目录项与版面上的标题行对上：
 * 去编号、去标点空白、统一大小写。
 */
export function normalizeHeadingTitle(text: string): string {
  return text
    .toLowerCase()
    .replace(
      /^(?:第[一二三四五六七八九十百千\d]+[章节节]|chapter\s+[ivxlcdm\d]+|section\s+[ivxlcdm\d]+|part\s+[ivxlcdm\d]+)/i,
      ''
    )
    .replace(/^[\s\d.)、:：\-–—]+/, '')
    .replace(/[\s\p{P}\p{S}]/gu, '');
}

function isListLine(text: string): boolean {
  return LIST_MARKER.test(text.trim());
}

function isCaptionLine(text: string): boolean {
  return CAPTION_LINE.test(text.trim());
}

function isFormulaLine(text: string): boolean {
  const line = text.trim();
  if (!line || line.length > 160) return false;
  const symbols = line.match(FORMULA_SYMBOL)?.length ?? 0;
  if (symbols < 2) return false;
  // 正文句子也可能含 1–2 个数学符号；要求符号密度高、连续词少。
  const words = line.match(/[A-Za-z\u4e00-\u9fff]{2,}/g)?.length ?? 0;
  return symbols >= 2 && words <= 6;
}

interface Geometry {
  left: number;
  top: number;
  right: number;
  bottom: number;
  /** 归一化字号（页面高度占比）。 */
  size: number;
  /** 行内最大空白（表格列间距），无则 0。 */
  gap: number;
}

/** 把一组行拆成多个块：列表项必须各自成块，不能把后面正文并进列表里。 */
function splitGroup(group: ParagraphLine[]): ParagraphLine[][] {
  const parts: ParagraphLine[][] = [];
  let current: ParagraphLine[] = [];
  for (const line of group) {
    if (current.length > 0 && isListLine(line.text)) {
      parts.push(current);
      current = [];
    }
    current.push(line);
  }
  if (current.length > 0) parts.push(current);
  return parts;
}

function groupText(lines: ParagraphLine[]): string {
  let output = '';
  for (const line of lines) {
    const text = line.text.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    if (!output) {
      output = text;
      continue;
    }
    const previous = output.slice(-1);
    const next = text.charAt(0);
    const cjk = /[\u2e80-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/;
    output +=
      output.endsWith('-') || cjk.test(previous) || cjk.test(next) ? text : ` ${text}`;
  }
  return output.trim();
}

function classifyGroup(
  lines: ParagraphLine[],
  gaps: number[],
  bodySize: number,
  pageMaxSize: number
): { kind: ContentBlockKind; level?: number } {
  const text = groupText(lines);
  if (!text) return { kind: 'paragraph' };
  const first = lines[0] as ParagraphLine;
  const last = lines[lines.length - 1] as ParagraphLine;
  const single = lines.length === 1;

  // 0) 作者/单位行：居中、字号偏大也排除，不当作章节起点。
  const comma = text.includes(',') || text.includes('，');
  const authorWord = /\bauthors?\b|corresponding\s+author|@|作者/i.test(text);
  const smallSize = bodySize > 0 && first.size <= bodySize * 1.06;
  const explicitNumber = /^\d+(?:\.\d+){0,3}[.)]/.test(text);
  if (
    single &&
    !explicitNumber &&
    AUTHOR_OR_AFFILIATION.test(text) &&
    (comma || authorWord || smallSize)
  ) {
    return { kind: 'paragraph' };
  }

  // 1) 标题：文字规则（`heading`）或版面迹象（字号明显大、居中短行）。
  const strongHeading = heading(text, first.size, bodySize);
  if (single) {
    const centered =
      first.right - first.left < 0.55 &&
      Math.abs((first.left + first.right) / 2 - 0.5) < 0.055;
    // 居中短行只有在"本页最大字号"量级时才是标题（避免作者/副标题/页眉被当成章节）。
    const titleSized = pageMaxSize <= 0 || first.size >= pageMaxSize * 0.98;
    const looksHeading =
      strongHeading !== null ||
      (centered && titleSized && first.size >= bodySize * 1.18) ||
      first.size > bodySize * 1.3;
    // 带书目标志的长行（"1. Smith, J. Journal A, 2020…"）是页下注引用，不是章节标题。
    const citationLine = looksLikeReferenceText(text) && text.length > 30;
    if (looksHeading && !citationLine) {
      return { kind: 'heading', level: strongHeading?.level ?? headingLevel(text) };
    }
  }

  // 2) 题注 / 公式：即使多行也各自独立。
  if (isCaptionLine(text)) return { kind: 'caption' };
  if (single && isFormulaLine(text)) return { kind: 'formula' };

  // 3) 表格行：行内出现明显列间距（`LayoutLine.gap` 记录行内最大空白宽度）。
  if (gaps.some((gap) => gap >= 0.03)) {
    const tableLike = single || gaps.filter((gap) => gap >= 0.03).length >= lines.length / 2;
    if (tableLike) return { kind: 'table' };
  }

  // 4) 页下注的书目式引用：编号 + 书目内容，先于"列表项"识别（否则 "1. Smith…" 会被当列表）。
  if (single && looksLikeReferenceText(text) && first.size < bodySize * 0.92 && last.bottom > 0.7) {
    return { kind: 'footnote' };
  }

  // 5) 列表项：以项目符号/编号开头（编号标题已在上面识别掉了）。
  if (isListLine(text)) return { kind: 'list' };

  // 6) 脚注：字号明显小于正文、贴近页底、且是短块。
  if (lines.length <= 3 && bodySize > 0 && first.size < bodySize * 0.88 && last.bottom > 0.8) {
    return { kind: 'footnote' };
  }

  return { kind: 'paragraph' };
}

interface Boundary {
  block: number;
  title: string;
  level: number;
}

/** 用 PDF 书签目录生成章节边界：把每个目录项落到页面上最像它的块。 */
function outlineBoundaries(layout: PdfLayout, blocks: ContentBlock[]): Boundary[] {
  if (layout.outline.length === 0 || blocks.length === 0) return [];
  const byPage = new Map<number, number[]>();
  blocks.forEach((block, index) => {
    const list = byPage.get(block.page);
    if (list) list.push(index);
    else byPage.set(block.page, [index]);
  });
  const used = new Set<number>();
  const boundaries: Boundary[] = [];
  for (const entry of layout.outline) {
    const candidates = byPage.get(entry.page) ?? [];
    if (candidates.length === 0) continue;
    const wanted = normalizeHeadingTitle(entry.title);
    let found = -1;
    if (wanted) {
      found =
        candidates.find((index) => normalizeHeadingTitle(blocks[index]!.text) === wanted) ?? -1;
      if (found < 0) {
        found =
          candidates.find((index) => {
            const current = normalizeHeadingTitle(blocks[index]!.text);
            if (!current || current.length < 2) return false;
            return current.includes(wanted) || wanted.includes(current);
          }) ?? -1;
      }
    }
    if (found < 0) {
      found = candidates.find((index) => blocks[index]!.kind === 'heading') ?? candidates[0]!;
    }
    if (used.has(found)) continue;
    used.add(found);
    boundaries.push({
      block: found,
      title: entry.title.trim() || blocks[found]!.text,
      level: Math.max(1, Math.trunc(entry.level ?? 1))
    });
  }
  return boundaries.sort((left, right) => left.block - right.block);
}

/** 没有目录时，用识别出的标题块当章节边界。 */
function headingBoundaries(blocks: ContentBlock[]): Boundary[] {
  const boundaries: Boundary[] = [];
  blocks.forEach((block, index) => {
    if (block.kind !== 'heading') return;
    boundaries.push({
      block: index,
      title: block.text.trim(),
      level: Math.max(1, Math.trunc(block.level ?? 1))
    });
  });
  return boundaries;
}

function sectionsFromBoundaries(
  blocks: ContentBlock[],
  boundaries: Boundary[],
  origin: 'outline' | 'heading',
  fallbackTitle: string
): DocumentSection[] {
  if (boundaries.length === 0) return [];
  const sections: DocumentSection[] = [];
  // 首个标题之前的块（封面、版权页、题名/摘要）单独成"前置部分"。
  if (boundaries[0]!.block > 0) {
    sections.push({
      index: 0,
      title: fallbackTitle.trim(),
      level: 0,
      kind: 'front',
      origin,
      pageStart: blocks[0]!.page,
      pageEnd: blocks[boundaries[0]!.block - 1]!.page,
      blockStart: 0,
      blockEnd: boundaries[0]!.block - 1,
      parent: null
    });
  }
  const stack: number[] = [];
  boundaries.forEach((boundary, position) => {
    const nextBlock =
      position + 1 < boundaries.length ? boundaries[position + 1]!.block : blocks.length;
    while (stack.length > 0) {
      const top = sections[stack[stack.length - 1]!];
      if (!top || top.level < boundary.level) break;
      stack.pop();
    }
    const index = sections.length;
    sections.push({
      index,
      title: boundary.title,
      level: boundary.level,
      kind: sectionKindOf(boundary.title),
      origin,
      pageStart: blocks[boundary.block]!.page,
      pageEnd: blocks[Math.max(boundary.block, nextBlock - 1)]!.page,
      blockStart: boundary.block,
      blockEnd: nextBlock - 1,
      parent: stack.length > 0 ? stack[stack.length - 1]! : null
    });
    stack.push(index);
  });
  return sections;
}

/**
 * 识别整篇文献的内容块与章节。
 *
 * 输入 `masks` 与 `getStructure` 同口径：遮罩掉的区域不参与识别，也不会出现在块文本里。
 * 行序与 `structure.readingOrderLines` 一致：双栏页按"左栏整栏 → 右栏"识别，
 * 因此段落不会横跨两栏串行。
 */
export function recognizeBlocks(
  layout: PdfLayout,
  masks: PageMask[] = [],
  options: RecognizeOptions = {}
): DocumentBlocks {
  const marginNoise = repeatedMarginTexts(layout);
  const blocks: ContentBlock[] = [];

  for (const page of layout.pages) {
    const pageHeight = page.height > 0 ? page.height : 1;
    const lines = readingOrderLines(page, masks).filter(
      (line) => !marginNoise.has(line.text.replace(/\s+/g, ' ').trim())
    );
    if (lines.length === 0) continue;

    const geometries = new Map<LayoutLine, Geometry>();
    const paragraphLines: ParagraphLine[] = [];
    for (const line of lines) {
      const size =
        typeof line.size === 'number' && line.size > 0 ? line.size / pageHeight : 0;
      const geometry: Geometry = {
        left: line.bbox[0],
        top: line.bbox[1],
        right: line.bbox[2],
        bottom: line.bbox[3],
        size,
        gap: line.gap ?? 0
      };
      geometries.set(line, geometry);
      paragraphLines.push({
        text: line.text,
        left: geometry.left,
        top: geometry.top,
        right: geometry.right,
        bottom: geometry.bottom,
        size
      });
    }
    const bodySize =
      median(
        [...geometries.values()]
          .filter((geometry) => geometry.right - geometry.left > 0.12 && geometry.size > 0)
          .map((geometry) => geometry.size)
      ) || DEFAULT_BODY_SIZE;
    // 缺字号的行（OCR 页可能没有字号）用页面正文字号兜底，避免整页被判成"小字脚注"。
    for (const geometry of geometries.values()) {
      if (geometry.size <= 0) geometry.size = bodySize;
    }
    for (const line of paragraphLines) {
      if (line.size <= 0) line.size = bodySize;
    }

    const aspect = page.height > 0 && page.width > 0 ? page.height / page.width : 1.414;
    const pageMaxSize = Math.max(
      0,
      ...[...geometries.values()].map((geometry) => geometry.size)
    );
    const groups = paragraphGroups(paragraphLines, aspect);
    const lineIndex = new Map<ParagraphLine, number>();
    paragraphLines.forEach((line, index) => lineIndex.set(line, index));

    for (const group of groups) {
      for (const part of splitGroup(group.lines)) {
        const text = groupText(part);
        if (!text) continue;
        const gaps = part.map((line) => {
          const index = lineIndex.get(line);
          const original = index === undefined ? undefined : lines[index];
          return original ? (geometries.get(original)?.gap ?? 0) : 0;
        });
        const classified = classifyGroup(part, gaps, bodySize, pageMaxSize);
        blocks.push({
          id: `b${blocks.length}`,
          page: page.page,
          kind: classified.kind,
          ...(classified.level !== undefined ? { level: classified.level } : {}),
          section: -1,
          text,
          bbox: [
            Math.min(...part.map((line) => line.left)),
            Math.min(...part.map((line) => line.top)),
            Math.max(...part.map((line) => line.right)),
            Math.max(...part.map((line) => line.bottom))
          ],
          lines: part.length
        });
      }
    }
  }

  // 章节边界：优先 PDF 目录；目录为空/对不上时退回版面标题规则。
  const outline = outlineBoundaries(layout, blocks);
  const basis: 'outline' | 'heading' | 'none' =
    outline.length > 0
      ? 'outline'
      : blocks.some((block) => block.kind === 'heading')
        ? 'heading'
        : 'none';
  const boundaries = outline.length > 0 ? outline : headingBoundaries(blocks);
  const sections = sectionsFromBoundaries(
    blocks,
    boundaries,
    basis === 'outline' ? 'outline' : 'heading',
    options.title ?? ''
  );

  // 回填每块所属章节；参考文献小节里的正文块改标为 reference。
  sections.forEach((section) => {
    for (let index = section.blockStart; index <= section.blockEnd; index += 1) {
      const block = blocks[index];
      if (!block) continue;
      block.section = section.index;
      if (section.kind === 'references' && block.kind !== 'heading' && block.kind !== 'caption') {
        block.kind = 'reference';
      }
    }
  });

  const stats: DocumentBlocksStats = {
    pages: layout.pages.length,
    blocks: blocks.length,
    headings: 0,
    paragraphs: 0,
    lists: 0,
    tables: 0,
    captions: 0,
    formulas: 0,
    footnotes: 0,
    references: 0,
    sections: sections.length,
    basis
  };
  for (const block of blocks) {
    if (block.kind === 'heading') stats.headings += 1;
    else if (block.kind === 'paragraph') stats.paragraphs += 1;
    else if (block.kind === 'list') stats.lists += 1;
    else if (block.kind === 'table') stats.tables += 1;
    else if (block.kind === 'caption') stats.captions += 1;
    else if (block.kind === 'formula') stats.formulas += 1;
    else if (block.kind === 'footnote') stats.footnotes += 1;
    else if (block.kind === 'reference') stats.references += 1;
  }

  return {
    documentId: options.documentId ?? '',
    sections,
    blocks,
    stats
  };
}

export interface SectionIndexOptions {
  /** 单片段最大字符数（含章节标题前缀），默认 1200。 */
  maxChars?: number;
  /** 相邻片段重叠字符数（避免答案刚好被切在片段边界上），默认 120。 */
  overlap?: number;
}

/**
 * 章节级索引片段：把"章节标题 + 连续正文"切成问答检索单元。
 *
 * 与按行/按页切分相比：
 * - 片段带章节标题（模型能知道这句话出自哪一节）；
 * - 片段不跨章节，避免把"方法"和"结果"拼进同一个检索单元；
 * - 片段跨页时保留起止页，引用定位仍能回到原文页。
 *
 * 这是**索引材料**，不是原文证据；命中后仍应回到原页逐字核对（与 `derived` 来源同口径）。
 */
export function sectionIndexChunks(
  documentId: string,
  document: DocumentBlocks,
  options: SectionIndexOptions = {}
): DocumentSectionIndex {
  const maxChars = Math.max(200, Math.trunc(options.maxChars ?? 1200));
  const overlap = Math.min(
    Math.max(0, Math.trunc(options.overlap ?? 120)),
    Math.floor(maxChars / 3)
  );
  const chunks: SectionIndexChunk[] = [];
  const docId = documentId || document.documentId;

  for (const section of document.sections) {
    const pieces: Array<{ text: string; page: number }> = [];
    for (let index = section.blockStart; index <= section.blockEnd; index += 1) {
      const block = document.blocks[index];
      if (!block) continue;
      if (block.kind === 'heading') continue;
      const text = block.text.trim();
      if (!text) continue;
      pieces.push({ text, page: block.page });
    }
    if (pieces.length === 0) continue;

    // 章节标题作为片段前缀；过长标题按 maxChars 的一半截断，保证"前缀 + 正文 ≤ maxChars"。
    const titleLimit = Math.max(20, Math.floor(maxChars / 2));
    const titleText =
      section.title.length > titleLimit
        ? `${section.title.slice(0, titleLimit)}…`
        : section.title;
    const prefix = titleText ? `${titleText}\n` : '';
    const bodyLimit = Math.max(60, maxChars - prefix.length);
    let part = 0;
    let current: string[] = [];
    let carryText = '';
    let startPage = 0;
    let endPage = 0;

    const flush = (hasMore: boolean): void => {
      if (current.length === 0) return;
      // 只有"重叠尾段"、后面没有新内容时不要再产出一个片段（避免重复内容）。
      if (current.length === 1 && current[0] === carryText) {
        current = [];
        return;
      }
      const body = current.join('\n\n').trim();
      current = [];
      carryText = '';
      if (!body) return;
      const text = `${prefix}${body}`.trim();
      if (!text) return;
      chunks.push({
        id: `${docId}:s${section.index}:${part}`,
        documentId: docId,
        section: section.index,
        sectionTitle: section.title,
        level: section.level,
        page: startPage || section.pageStart,
        pageEnd: endPage || startPage || section.pageStart,
        text,
        characters: text.length
      });
      part += 1;
      if (overlap > 0 && body.length > overlap) {
        const tail = body.slice(-overlap).trim();
        if (tail && tail.length < bodyLimit / 2) {
          carryText = tail;
          if (hasMore) current = [tail];
        }
      }
    };

    for (const piece of pieces) {
      let remaining = piece.text;
      while (remaining.length > 0) {
        if (current.length === 0) startPage = piece.page;
        endPage = piece.page;
        const used = current.join('\n\n').length;
        const room = bodyLimit - used - (current.length > 0 ? 2 : 0);
        if (room <= 0) {
          flush(true);
          if (current.length === 0) startPage = piece.page;
          endPage = piece.page;
          continue;
        }
        if (remaining.length <= room) {
          current.push(remaining);
          remaining = '';
          break;
        }
        current.push(remaining.slice(0, room));
        remaining = remaining.slice(room).trimStart();
        flush(true);
      }
    }
    flush(false);
  }

  const totalCharacters = chunks.reduce((sum, chunk) => sum + chunk.characters, 0);
  const maxChunkCharacters = chunks.reduce(
    (max, chunk) => Math.max(max, chunk.characters),
    0
  );
  return {
    documentId: docId,
    chunks,
    totalCharacters,
    maxChunkCharacters
  };
}
