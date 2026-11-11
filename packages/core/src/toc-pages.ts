/**
 * 按「文献自带的目录页」生成导航。
 *
 * 很多书的 PDF 没有书签目录，但正文前印了一张目录页（标题 + 页码）。与其靠标题字号规则
 * 从几百页里猜章节，不如让用户在阅读器里指定**目录页范围**，直接解析这张目录：
 * - 从目录页行里取「标题 + 印刷页码」，支持折行标题、页码单独一行、罗马数字页码；
 * - 双栏目录里同一视觉行被文本层拼成「标题A … 12 标题B … 34」时，按引导点逐条拆开；
 * - 用正文标题块估计「印刷页码 → PDF 物理页码」的偏移（书前有版权页/序言时两者不同），
 *   阿拉伯数字与罗马数字页码分别估计；
 * - 生成导航节点（page/kind/label），供目录面板与阅读规划使用。
 *
 * 纯函数：不读数据库、不调模型。识别结果只是导航条目，不是原文证据。
 */
import type { DocumentBlocks } from '@studianda/shared';
import type { PdfLayout } from './pdf-layout.js';
import { normalizeHeadingTitle } from './blocks.js';
import {
  readingOrderLines,
  repeatedMarginTexts,
  type PageMask
} from './structure.js';

export type TocPageKind = 'arabic' | 'roman' | 'none';

export interface TocEntryDraft {
  /** 目录里的标题（去掉引导点/页码后的文字；折行标题会拼成一行）。 */
  title: string;
  /** 页码的数值：阿拉伯页码原值，罗马页码为序号（i=1, ii=2…）；解析不出时 null。 */
  printedPage: number | null;
  /** 页码标签原文（`12`、`xii`）；解析不出时为空。 */
  printedPageLabel: string;
  /** 页码类型。 */
  pageKind: TocPageKind;
  /** 标题层级（编号层级；无编号为 1）。 */
  level: number;
  /** 原始行文字（供界面核对；折行时是多行拼接）。 */
  raw: string;
}

export interface TocParseResult {
  pages: number[];
  entries: TocEntryDraft[];
  warnings: string[];
}

export interface TocOffsetEstimate {
  offset: number;
  confidence: number;
  matched: number;
  total: number;
}

export interface TocNavigationStats {
  entries: number;
  /** 阿拉伯页码条目的偏移（物理页 = 印刷页 + offset）。 */
  offset: number;
  offsetConfidence: number;
  /** 罗马数字页码条目数（前言 i/ii/iii 等）。 */
  romanEntries: number;
  /** 罗马页码条目的偏移（物理页 = 罗马序号 + offset）。 */
  romanOffset: number;
  romanOffsetConfidence: number;
  /** 最终生成、且落在 1..totalPages 内的节点数。 */
  nodes: number;
  /** 因页码超范围被跳过的条目数。 */
  skipped: number;
}

export interface TocNavigationResult {
  pages: number[];
  nodes: Array<{ page: number; kind: string; label: string }>;
  entries: TocEntryDraft[];
  stats: TocNavigationStats;
  warnings: string[];
}

const TOC_HEADING = /^(?:目\s*录|contents|table\s+of\s+contents)$/i;
const LEADER = /[.．·…。⋯]\s*$/;
const NUMBERED_START =
  /^(?:第[一二三四五六七八九十百千\d]+[章节篇部编卷]|chapter\s+\d+|part\s+[ivxlcdm\d]+|\d+(?:\.\d+){0,3}(?=[\s.、]|$)|[一二三四五六七八九十]{1,3}[、.)])/i;
const ROMAN_VALUES: Record<string, number> = {
  i: 1,
  v: 5,
  x: 10,
  l: 50,
  c: 100,
  d: 500,
  m: 1000
};

function normalizePages(pages: unknown, total: number): number[] {
  if (!Array.isArray(pages)) return [];
  const result = new Set<number>();
  for (const value of pages) {
    const page = Number(value);
    if (!Number.isFinite(page) || page < 1) continue;
    const integer = Math.trunc(page);
    if (total > 0 && integer > total) continue;
    result.add(integer);
  }
  return [...result].sort((left, right) => left - right);
}

/** 标题层级：`2.1` → 2，`第三章` → 1，`一、` → 2，无编号默认 1。 */
export function tocLevelOf(title: string): number {
  const numbered = title.match(/^(\d+(?:\.\d+){0,3})(?=[\s.、]|$)/);
  if (numbered?.[1]) return Math.min(4, numbered[1].split('.').length);
  if (/^第[一二三四五六七八九十百千\d]+[章节篇部编卷]/.test(title)) return 1;
  if (/^chapter\s+\d+/i.test(title) || /^part\s+[ivxlcdm\d]+/i.test(title)) return 1;
  if (/^[一二三四五六七八九十]{1,3}[、.)]/.test(title)) return 2;
  return 1;
}

/** 罗马数字 → 序号（i=1, ii=2, xii=12）；不是合法罗马数字返回 null。 */
export function romanToNumber(label: string): number | null {
  const text = label.trim().toLowerCase();
  if (!/^[ivxlcdm]{1,10}$/.test(text)) return null;
  let total = 0;
  let previous = 0;
  for (let index = text.length - 1; index >= 0; index -= 1) {
    const value = ROMAN_VALUES[text[index]!];
    if (value === undefined) return null;
    if (value < previous) total -= value;
    else {
      total += value;
      previous = value;
    }
  }
  return total > 0 && total <= 300 ? total : null;
}

interface PageToken {
  value: number;
  label: string;
  kind: 'arabic' | 'roman';
}

/** 目录里的页码 token：阿拉伯数字或罗马数字。 */
export function tocPageToken(text: string): PageToken | null {
  const raw = text.trim();
  if (!raw) return null;
  if (/^\d{1,4}$/.test(raw)) {
    const value = Number(raw);
    if (value < 1 || value > 2000) return null;
    return { value, label: raw, kind: 'arabic' };
  }
  if (/^[ivxlcdm]{1,10}$/i.test(raw)) {
    const value = romanToNumber(raw);
    if (value == null) return null;
    return { value, label: raw, kind: 'roman' };
  }
  return null;
}

/** 整行只有页码（用于「标题一行、页码下一行」的目录）。 */
export function parsePageOnlyLine(text: string): PageToken | null {
  return tocPageToken(text.trim());
}

interface ParsedTocPiece {
  title: string;
  token: PageToken;
}

function cleanTitle(text: string): string {
  return text
    .replace(/^[\s.．·…。⋯\-–—]+/, '')
    .replace(/[.．·…。⋯]+\s*$/, '')
    .trim();
}

function titleLike(text: string): boolean {
  const value = text.replace(/\s+/g, ' ').trim();
  if (value.length < 2 || value.length > 180) return false;
  if (TOC_HEADING.test(value)) return false;
  if (!/[\p{L}\u3400-\u9fff]/u.test(value)) return false;
  return true;
}

/**
 * 从一行（或一行里被拼起来的多栏内容）解析目录条目。
 *
 * 有引导点时按「标题…页码」逐条提取：这样双栏目录被文本层挤成
 * `标题A …… 12 标题B …… 34` 的一行也能拆成两条，而不是只取最后一个页码。
 */
export function parseTocLineEntries(
  text: string,
  options: { right?: number } = {}
): ParsedTocPiece[] {
  const raw = text.replace(/\s+/g, ' ').trim();
  if (!raw || raw.length > 400) return [];
  if (TOC_HEADING.test(raw)) return [];
  const pieces: ParsedTocPiece[] = [];
  const leaderEntry = /(.{1,180}?)\s*[.．·…。⋯]{2,}\s*(\d{1,4}|[ivxlcdm]{1,10})(?![\p{L}\p{N}])/giu;
  let match: RegExpExecArray | null;
  while ((match = leaderEntry.exec(raw)) !== null) {
    const title = cleanTitle(match[1] ?? '');
    const token = tocPageToken(match[2] ?? '');
    if (!title || !token || !titleLike(title)) continue;
    pieces.push({ title, token });
  }
  if (pieces.length > 0) return pieces;

  // 没有引导点：整行按「标题 + 末尾页码」解析（页码靠右或标题以章节编号开头才算）。
  const trailing = raw.match(/^(.*?)(\d{1,4})\s*$/);
  if (!trailing) return [];
  const before = trailing[1] ?? '';
  const titlePart = before.trim();
  const title = cleanTitle(titlePart);
  const token = tocPageToken(trailing[2] ?? '');
  if (!title || !token || !titleLike(title)) return [];
  const leader = LEADER.test(before);
  const rightAligned = typeof options.right === 'number' && options.right > 0.8;
  if (!leader && !rightAligned && !NUMBERED_START.test(title)) return [];
  return [{ title, token }];
}

/** 兼容旧调用：解析一行里第一个目录条目。 */
export function parseTocLine(
  text: string,
  options: { right?: number } = {}
): { title: string; page: number } | null {
  const [first] = parseTocLineEntries(text, options);
  return first ? { title: first.title, page: first.token.value } : null;
}

function entryOf(title: string, token: PageToken, raw: string): TocEntryDraft {
  return {
    title: title.replace(/\s+/g, ' ').trim(),
    printedPage: token.value,
    printedPageLabel: token.label,
    pageKind: token.kind,
    level: tocLevelOf(title),
    raw
  };
}

/** 解析目录页：折行标题、页码单独一行、双栏拼行都会尽量还原成条目。 */
export function parseTocPages(
  layout: PdfLayout,
  masks: PageMask[],
  pages: number[]
): TocParseResult {
  const selected = normalizePages(pages, layout.pages.length);
  const warnings: string[] = [];
  if (selected.length === 0) {
    return { pages: [], entries: [], warnings: ['没有指定有效的目录页。'] };
  }
  const marginNoise = repeatedMarginTexts(layout);
  const entries: TocEntryDraft[] = [];
  let pendingTitle: string | null = null;
  let pendingPage: PageToken | null = null;
  let ignored = 0;

  const flushPending = (): void => {
    if (pendingTitle && !pendingPage) {
      ignored += 1;
      pendingTitle = null;
    }
  };

  for (const pageNumber of selected) {
    const page = layout.pages.find((item) => item.page === pageNumber);
    if (!page) continue;
    const lines = readingOrderLines(page, masks).filter(
      (line) => !marginNoise.has(line.text.replace(/\s+/g, ' ').trim())
    );
    for (const line of lines) {
      const text = line.text.replace(/\s+/g, ' ').trim();
      if (!text) continue;
      if (TOC_HEADING.test(text)) continue;

      // 1) 整行只有页码：与上一行的标题配对（折行/分栏目录常见）。
      const pageOnly = parsePageOnlyLine(text);
      if (pageOnly) {
        if (pendingTitle) {
          entries.push(entryOf(pendingTitle, pageOnly, `${pendingTitle} … ${pageOnly.label}`));
          pendingTitle = null;
        } else {
          pendingPage = pageOnly;
        }
        continue;
      }

      // 2) 行内条目（可能一条或多条，双栏拼行会拆成多条）。
      const pieces = parseTocLineEntries(text, { right: line.bbox[2] });
      if (pieces.length > 0) {
        let first = true;
        for (const piece of pieces) {
          let title = piece.title;
          if (first && pendingTitle) {
            // 上一行是没有页码的标题（折行/分栏），拼回来一起当标题。
            title = `${pendingTitle} ${title}`.replace(/\s+/g, ' ').trim();
          }
          entries.push(entryOf(title, piece.token, text));
          first = false;
        }
        pendingTitle = null;
        pendingPage = null;
        continue;
      }

      // 3) 没有页码的标题行：暂存，等下一行的页码或折行标题。
      if (titleLike(text)) {
        if (pendingTitle) {
          // 连续多行标题：先看下一行是否继续；直接拼起来，遇到页码时收口。
          pendingTitle = `${pendingTitle} ${text}`.replace(/\s+/g, ' ').trim();
        } else {
          pendingTitle = text;
        }
        continue;
      }
      // 其它（装饰、纯符号）忽略。
      ignored += 1;
    }
  }
  flushPending();

  if (entries.length === 0) {
    warnings.push('目录页里没有识别到「标题 + 页码」条目，请确认目录页选择是否正确。');
  } else if (ignored > 0) {
    warnings.push(
      `目录页上有 ${ignored} 行没有解析出页码（可能是图表目录/说明行），已被忽略。`
    );
  }
  return { pages: selected, entries, warnings };
}

function voteOffset(
  entries: TocEntryDraft[],
  blocks: DocumentBlocks | undefined,
  tocPages: number[],
  kind: 'arabic' | 'roman'
): { estimate: TocOffsetEstimate; warning: string } {
  const scope = entries.filter((entry) => entry.pageKind === kind && entry.printedPage != null);
  const label = kind === 'roman' ? '罗马数字' : '阿拉伯数字';
  if (!blocks) {
    return {
      estimate: { offset: 0, confidence: 0, matched: 0, total: scope.length },
      warning: `没有正文内容块可用于对齐${label}页码，节点页码按目录原样给出。`
    };
  }
  const headings = blocks.blocks.filter(
    (block) => block.kind === 'heading' && !tocPages.includes(block.page)
  );
  if (headings.length === 0) {
    return {
      estimate: { offset: 0, confidence: 0, matched: 0, total: scope.length },
      warning: `正文没有识别到章节标题，无法对齐${label}页码。`
    };
  }
  const votes = new Map<number, number>();
  let matched = 0;
  for (const entry of scope) {
    const wanted = normalizeHeadingTitle(entry.title);
    if (!wanted || wanted.length < 2) continue;
    const candidate = headings.find((heading) => {
      const current = normalizeHeadingTitle(heading.text);
      if (!current) return false;
      return current === wanted || current.includes(wanted) || wanted.includes(current);
    });
    if (!candidate) continue;
    const delta = candidate.page - (entry.printedPage as number);
    if (Math.abs(delta) > 300) continue;
    votes.set(delta, (votes.get(delta) ?? 0) + 1);
    matched += 1;
  }
  if (votes.size === 0) {
    return {
      estimate: { offset: 0, confidence: 0, matched: 0, total: scope.length },
      warning:
        kind === 'roman'
          ? '罗马数字页码没能和正文标题对上，按「i=第1页」原样映射，建议核对。'
          : '没能用正文标题自动对齐印刷页码与 PDF 物理页码，节点页码按目录印刷页码给出。'
    };
  }
  let best = 0;
  let bestVotes = -1;
  for (const [delta, count] of votes) {
    if (count > bestVotes || (count === bestVotes && Math.abs(delta) < Math.abs(best))) {
      best = delta;
      bestVotes = count;
    }
  }
  const confidence =
    scope.length > 0 ? Math.round((bestVotes / scope.length) * 100) / 100 : 0;
  const warnings =
    confidence < 0.5
      ? [`只有 ${bestVotes}/${scope.length} 条${label}页码能在正文标题里对上，偏移（${best}）可能不准，建议核对。`]
      : [];
  return {
    estimate: { offset: best, confidence, matched, total: scope.length },
    warning: warnings[0] ?? ''
  };
}

/**
 * 用目录页生成导航节点。
 *
 * `blocks` 可选：传入已识别的正文内容块时，用标题块估计页码偏移；没有时按目录页码原样映射。
 */
export function tocNavigation(
  layout: PdfLayout,
  masks: PageMask[],
  tocPages: number[],
  totalPages: number,
  blocks?: DocumentBlocks
): TocNavigationResult {
  const parsed = parseTocPages(layout, masks, tocPages);
  const warnings = [...parsed.warnings];
  const arabic = voteOffset(parsed.entries, blocks, parsed.pages, 'arabic');
  const roman = voteOffset(parsed.entries, blocks, parsed.pages, 'roman');
  if (arabic.warning) warnings.push(arabic.warning);
  if (roman.warning && parsed.entries.some((entry) => entry.pageKind === 'roman')) {
    warnings.push(roman.warning);
  }

  const nodes: Array<{ page: number; kind: string; label: string }> = [];
  const seen = new Set<string>();
  let skipped = 0;
  for (const entry of parsed.entries) {
    if (entry.printedPage == null || entry.pageKind === 'none') {
      skipped += 1;
      continue;
    }
    const offset = entry.pageKind === 'roman' ? roman.estimate.offset : arabic.estimate.offset;
    const physical = entry.printedPage + offset;
    if (physical < 1 || physical > totalPages) {
      skipped += 1;
      continue;
    }
    const key = `${physical}\u0000${entry.title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    nodes.push({ page: physical, kind: 'section', label: entry.title });
  }
  nodes.sort((left, right) => left.page - right.page);
  if (skipped > 0) {
    warnings.push(`${skipped} 条目录条目的页码超出文献页数或无法解析，已跳过。`);
  }
  return {
    pages: parsed.pages,
    nodes,
    entries: parsed.entries,
    stats: {
      entries: parsed.entries.length,
      offset: arabic.estimate.offset,
      offsetConfidence: arabic.estimate.confidence,
      romanEntries: parsed.entries.filter((entry) => entry.pageKind === 'roman').length,
      romanOffset: roman.estimate.offset,
      romanOffsetConfidence: roman.estimate.confidence,
      nodes: nodes.length,
      skipped
    },
    warnings
  };
}

/** 供 Store 复用的目录页规整（校验 1..totalPages、去重排序）。 */
export function normalizeTocPages(pages: unknown, total: number): number[] {
  return normalizePages(pages, total);
}
