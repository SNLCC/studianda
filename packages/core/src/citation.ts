import type { LayoutLine, LayoutPage } from './pdf-layout.js';
import { readingOrderLines, type PageMask } from './structure.js';

export interface LocatedQuote {
  bbox: [number, number, number, number];
  text: string;
}

const MIN_NEEDLE = 4;

/** 用于把一句话拆成可做逐字核对的短语。 */
const CLAUSE_SPLIT = /[，。；：、,.;:!?！？()（）[\]【】「」“”"'’‘\s]+/;

function normalize(text: string): { chars: string; positions: number[] } {
  const chars: string[] = [];
  const positions: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (/\s/.test(char)) continue;
    chars.push(char);
    positions.push(index);
  }
  return { chars: chars.join(''), positions };
}

function lineParts(pageText: string, start: number, end: number): string[] {
  const parts: string[] = [];
  let offset = 0;
  for (const line of pageText.split('\n')) {
    const lineStart = offset;
    const lineEnd = offset + line.length;
    offset = lineEnd + 1;
    if (lineEnd <= start || lineStart >= end) continue;
    const piece = line.slice(
      Math.max(start, lineStart) - lineStart,
      Math.min(end, lineEnd) - lineStart
    );
    if (piece.trim()) parts.push(piece);
  }
  return parts;
}

function matchRank(needle: string, haystack: string): number {
  if (!needle) return 0;
  if (needle === haystack) return 2;
  if (haystack.includes(needle)) return 1;
  return 0;
}

/** 摘引必须在页文本中逐字找到，再映射到行框；找不到不猜位置。 */
export function locateQuote(
  pageText: string,
  quote: string,
  lines: LayoutLine[],
  minNeedle = MIN_NEEDLE
): LocatedQuote[] {
  const normalized = normalize(pageText);
  const { chars: needle } = normalize(quote);
  if (needle.length < minNeedle) return [];
  const index = normalized.chars.indexOf(needle);
  if (index < 0) return [];
  const start = normalized.positions[index]!;
  const end = normalized.positions[index + needle.length - 1]! + 1;

  const prepared = lines
    .map((line) => ({ line, text: normalize(line.text).chars }))
    .filter((entry) => entry.text);
  if (prepared.length === 0) return [];

  const boxes: LocatedQuote[] = [];
  let cursor = 0;
  for (const piece of lineParts(pageText, start, end)) {
    const target = normalize(piece).chars;
    if (target.length < minNeedle) continue;
    let best: LayoutLine | null = null;
    let bestRank = 0;
    let bestIndex = cursor;
    const positions = [
      ...Array.from({ length: prepared.length - cursor }, (_, offset) => cursor + offset),
      ...Array.from({ length: cursor }, (_, offset) => offset)
    ];
    for (const position of positions) {
      const entry = prepared[position]!;
      const rank = matchRank(target, entry.text);
      if (rank > bestRank) {
        best = entry.line;
        bestRank = rank;
        bestIndex = position;
        if (rank === 2) break;
      }
    }
    if (!best) continue;
    boxes.push({ bbox: best.bbox, text: piece.slice(0, 200) });
    cursor = bestIndex;
  }
  return boxes;
}

export function locateQuoteOnPage(
  page: LayoutPage,
  quote: string,
  masks: PageMask[]
): LocatedQuote[] {
  const lines = readingOrderLines(page, masks);
  const pageText = lines.map((line) => line.text).join('\n');
  return locateQuote(pageText, quote, lines);
}

/**
 * 跨页找回的页序：从最近到最远、不含自身。
 * 只用于"记录页没找到"时按页查找已有文本，不改变逐字校验口径。
 */
export function searchOrder(page: number, total: number, maxPages = 60): number[] {
  const order: number[] = [];
  for (let candidate = 1; candidate <= total; candidate += 1) {
    if (candidate !== page) order.push(candidate);
  }
  order.sort((left, right) => Math.abs(left - page) - Math.abs(right - page) || left - right);
  return order.slice(0, Math.max(1, Math.min(maxPages, total)));
}

/**
 * 在页文本里找出正文这一句"用到的原文文字"，作为定位锚点。
 * 按标点/空白拆短语、从长到短、从整句逐步缩短，
 * 返回在原文里**逐字**重合的片段；改写表述找不到重合时返回空（宁可只给页码，不编位置）。
 */
export function lineAnchor(
  line: string,
  text: string,
  minimum = 8,
  limit = 200
): string {
  if (!text) return '';
  const normalized = normalize(text);
  const clauses = (line || '').split(CLAUSE_SPLIT).sort((left, right) => right.length - left.length);
  for (const clause of clauses) {
    const { chars: needle } = normalize(clause);
    if (needle.length < minimum) continue;
    for (let size = needle.length; size >= minimum; size -= 1) {
      const piece = needle.slice(0, size);
      const at = normalized.chars.indexOf(piece);
      if (at < 0) continue;
      const start = normalized.positions[at]!;
      const end = normalized.positions[at + size - 1]! + 1;
      return text.slice(start, end).slice(0, limit);
    }
  }
  return '';
}

export interface AnchorSource {
  page?: number;
  text?: string;
  quotes?: string[];
}

/**
 * 为"没有逐字摘引"的引用补定位锚点，按来源编号返回 `{n: 原文片段}`。
 * 只补同一行里 `[n]` 指到、且该来源还没有 quotes 的项。
 */
export function answerAnchors(
  answer: string,
  sources: AnchorSource[],
  minimum = 8,
  limit = 200
): Record<number, string> {
  const found: Record<number, string> = {};
  for (const line of (answer || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    for (const match of line.matchAll(/\[(\d+)\]/g)) {
      const number = Number(match[1]);
      if (!Number.isInteger(number) || number < 1 || number > sources.length) continue;
      if (found[number]) continue;
      const source = sources[number - 1]!;
      if (source.quotes && source.quotes.length > 0) continue;
      const anchor = lineAnchor(line, source.text ?? '', minimum, limit);
      if (anchor) found[number] = anchor;
    }
  }
  return found;
}
