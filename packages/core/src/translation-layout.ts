export const FURNITURE_MARGIN = 0.095;
export const NOTE_ZONE = 0.14;
export const SHORT_NOTE_CHARS = 60;

const FURNITURE_PATTERNS = [
  /^\s*[-–—]?\s*\d{1,4}\s*[-–—]?\s*$/,
  /(?:第\s*)?[0-9０-９一二三四五六七八九十]{1,3}\s*[卷期](?:\s|$)/,
  /(?:vol\.?|no\.?|issue)\s*\d/i,
  /(?:journal|transactions|proceedings)\s+of\b/i,
  /^\s*(?:received|accepted|published)\b.*\d{4}/i,
  /^\s*(?:doi|https?:\/\/|www\.)/i,
  /^\s*[ivxlcdm]{1,7}\s*$/i
];
const NOTE_PATTERNS = [
  /^\s*(?:\d{1,2}|[*†‡§¶])\s*(?:corresponding|e-?mail|作者|通讯作者)/i,
  /^\s*(?:基金|资助|收稿日期|录用日期|作者简介|通信作者)/,
  /^\s*(?:https?:\/\/|www\.|doi[:\s])/i,
  /^\s*(?:图|表|fig(?:ure)?|table)\s*\.?\s*\d/i
];

export type SegmentKind = 'body' | 'furniture' | 'note';
export type SegmentColumn = 'full' | 'left' | 'right';

export function segmentKind(
  text: string,
  box: number[] | null | undefined,
  pageHeight: number,
  pageFont = 0,
  segmentFont = 0
): SegmentKind {
  const stripped = (text ?? '').trim();
  if (!stripped || !box || !pageHeight) return 'body';
  const compact = stripped.replace(/\s+/g, ' ');
  const [, y0, , y1] = box;
  if (y1 === undefined || y0 === undefined) return 'body';
  if (y1 <= FURNITURE_MARGIN) {
    // 只有页眉特征（期刊名/卷期/页码等）或极短行才算页眉：
    // 长标题也可能贴着页顶，不能因为它靠近页顶就整段跳过翻译。
    const headerLike = compact.length <= 60 && FURNITURE_PATTERNS.some((pattern) => pattern.test(compact));
    if (headerLike || compact.length <= 20) return 'furniture';
  }
  if (y0 >= 1 - NOTE_ZONE) {
    const smaller = Boolean(pageFont && segmentFont && segmentFont <= pageFont * 0.88);
    if (
      compact.length <= SHORT_NOTE_CHARS ||
      smaller ||
      NOTE_PATTERNS.some((pattern) => pattern.test(compact))
    ) {
      return 'note';
    }
  }
  return 'body';
}

export function columnOf(box: number[] | null | undefined): SegmentColumn {
  if (!box) return 'full';
  const x0 = box[0] ?? 0;
  const x1 = box[2] ?? 0;
  if (x0 <= 0.12 && x1 >= 0.88) return 'full';
  if (x1 <= 0.56) return 'left';
  if (x0 >= 0.44) return 'right';
  return 'full';
}

function pageSpans(pageData?: {
  spans?: unknown[];
  characters?: unknown[];
}): Array<Record<string, unknown>> {
  const spans = pageData?.spans ?? pageData?.characters ?? [];
  return spans as Array<Record<string, unknown>>;
}

export function medianSize(
  spans: Array<Record<string, unknown>>,
  box: number[] | null,
  pageWidth: number,
  pageHeight: number
): number {
  if (!spans || !pageWidth || !pageHeight) return 0;
  const sizes: number[] = [];
  for (const span of spans) {
    const glyph = (span.bbox as number[] | undefined) ?? [];
    const size = span.size;
    if (
      glyph.length !== 4 ||
      typeof size !== 'number' ||
      Number.isNaN(size) ||
      size <= 0
    ) {
      continue;
    }
    const left = glyph[0]! / pageWidth;
    const top = glyph[1]! / pageHeight;
    const right = glyph[2]! / pageWidth;
    const bottom = glyph[3]! / pageHeight;
    if (box && !(right > box[0]! && left < box[2]! && bottom > box[1]! && top < box[3]!)) {
      continue;
    }
    sizes.push(size);
  }
  if (sizes.length === 0) return 0;
  sizes.sort((a, b) => a - b);
  return sizes[Math.floor(sizes.length / 2)]!;
}

export function bodyFontSize(
  pageData: Record<string, unknown> | undefined,
  segments: Array<Record<string, unknown>>,
  boxes: Array<number[] | null>,
  pageWidth: number,
  pageHeight: number
): number {
  const spans = pageSpans(pageData);
  const sizes: number[] = [];
  const count = Math.min(segments.length, boxes.length);
  for (let index = 0; index < count; index += 1) {
    const row = segments[index]!;
    const box = boxes[index];
    if (row.kind !== 'body' || !box) continue;
    const size = medianSize(spans, box, pageWidth, pageHeight);
    if (size) sizes.push(size);
  }
  if (sizes.length === 0) return 0;
  sizes.sort((a, b) => a - b);
  return sizes[Math.floor(sizes.length / 2)]!;
}

export function decorateSegments(
  segments: Array<Record<string, unknown>>,
  boxes: Array<number[] | null>,
  pageData?: { width?: number; height?: number; spans?: unknown[]; characters?: unknown[] }
): { body_line_height: number; body_font_size: number; columns: number } {
  const pageHeight = pageData?.height ?? 0;
  const pageWidth = pageData?.width ?? 0;
  const heights: number[] = [];
  const count = Math.min(segments.length, boxes.length);
  for (let index = 0; index < count; index += 1) {
    const box = boxes[index];
    if (!box || !pageHeight) continue;
    const lineHeight = (box[3]! - box[1]!) * pageHeight;
    if (lineHeight) heights.push(lineHeight);
  }
  heights.sort((a, b) => a - b);
  const bodySize = heights.length > 0 ? heights[Math.floor(heights.length / 2)]! : 0;
  const spans = pageSpans(pageData);
  const pageFont = medianSize(spans, null, pageWidth, pageHeight);
  for (let index = 0; index < count; index += 1) {
    const row = segments[index]!;
    const box = boxes[index] ?? null;
    row.column = columnOf(box);
    row.kind = segmentKind(
      String(row.source || row.text || ''),
      box,
      pageHeight,
      pageFont,
      medianSize(spans, box, pageWidth, pageHeight)
    );
  }
  const left = segments.filter((row) => row.kind === 'body' && row.column === 'left').length;
  const right = segments.filter((row) => row.kind === 'body' && row.column === 'right').length;
  const bodyFont = bodyFontSize(pageData as Record<string, unknown> | undefined, segments, boxes, pageWidth, pageHeight);
  return {
    body_line_height: Math.round(bodySize * 100) / 100,
    body_font_size: Math.round(bodyFont * 100) / 100,
    columns: left >= 2 && right >= 2 ? 2 : 1
  };
}
