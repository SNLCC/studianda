const COLOR_BY_HEX: Record<string, string> = {
  '#ffd400': 'yellow',
  '#ff6666': 'pink',
  '#5fb236': 'green',
  '#2ea8e5': 'blue',
  '#a28ae5': 'purple',
  '#e56eee': 'pink',
  '#f19837': 'orange',
  '#aaaaaa': 'yellow'
};

const STYLE_BY_TYPE: Record<string, string> = {
  highlight: 'highlight',
  underline: 'underline',
  note: 'margin',
  text: 'margin'
};

const TYPE_LABELS: Record<string, string> = {
  highlight: '高亮',
  underline: '下划线',
  note: '便签',
  text: '文字批注',
  image: '区域截图',
  ink: '手写墨迹'
};

export const MAX_ZOTERO_IMPORT = 500;

/** Zotero 笔记（itemType=note）允许写入 notes 表的单条正文长度上限之外的报告预览长度。 */
export const NOTE_REPORT_PREVIEW = 500;

/**
 * 解码 Zotero 笔记 HTML 里会实际出现的字符实体。
 *
 * Zotero 的 `data.note` 是富文本 HTML（`<p>`/`<strong>`/`<span>` 等），文字内容
 * 以 HTML 实体转义。这里只做一次解码（不循环解码，避免把 `&amp;lt;` 还原成 `<`）。
 */
function decodeHtmlEntities(text: string): string {
  const named: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
    '#39': "'"
  };
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, rawEntity: string) => {
    const entity = String(rawEntity).toLowerCase();
    const known = named[entity];
    if (known !== undefined) return known;
    if (entity.startsWith('#x')) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    if (entity.startsWith('#')) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return whole;
  });
}

const NOTE_SCRIPT_STYLE = /<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const NOTE_COMMENT = /<!--[\s\S]*?-->/g;
// 块级标签与 <br> 一律换行：Zotero 笔记的段落/列表/表格靠这些标签分隔。
const NOTE_BLOCK_TAG =
  /<\/?(?:p|div|br|li|ul|ol|h[1-6]|tr|td|th|thead|tbody|table|blockquote|pre|section|article|header|footer|figure|figcaption|hr)\b[^>]*>/gi;
const NOTE_REMAINING_TAG = /<[^>]*>/g;

/**
 * 把 Zotero 笔记 HTML 转成纯文本。
 *
 * 规则（不新增依赖，也不伪造内容）：
 * 1. 去掉 script/style/注释；
 * 2. 块级标签 → 换行；
 * 3. 其余标签直接去掉；
 * 4. 解码 `&amp;` `&lt;` `&gt;` `&quot;` `&#39;` `&nbsp;`（以及数字实体）；
 * 5. 每行压缩连续空白、去掉行首尾空白，丢弃空行，其余行用 `\n` 连接。
 */
export function zoteroNoteText(html: string): string {
  let text = String(html ?? '');
  if (!text) return '';
  text = text.replace(NOTE_SCRIPT_STYLE, ' ');
  text = text.replace(NOTE_COMMENT, '');
  text = text.replace(NOTE_BLOCK_TAG, '\n');
  text = text.replace(NOTE_REMAINING_TAG, '');
  text = decodeHtmlEntities(text);
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t\u00a0\f\v]+/g, ' ').trim())
    .filter((line) => line.length > 0)
    .join('\n');
}

export interface ZoteroNoteCandidate {
  ok: boolean;
  reason: string;
  zoteroKey: string;
  /** HTML 转纯文本后的完整正文（写入 notes.content）。 */
  content: string;
}

/**
 * 把 Zotero 笔记条目（`data.note` 为 HTML）映射成可写入 notes 表的候选。
 * 空笔记（只有标签/空白）标为 ok=false，由调用方计入 skippedEmpty。
 */
export function mapZoteroNote(raw: Record<string, unknown>): ZoteroNoteCandidate {
  const data = raw && typeof raw === 'object' ? raw : {};
  const zoteroKey = String(data.key ?? data.itemKey ?? '');
  const content = zoteroNoteText(String(data.note ?? ''));
  if (!content) {
    return { ok: false, reason: '这条笔记没有可导入的文字（正文为空）', zoteroKey, content: '' };
  }
  return { ok: true, reason: '', zoteroKey, content };
}

export function paletteColor(value: unknown): { color: string; unknown: boolean } {
  let raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return { color: 'yellow', unknown: false };
  if (!raw.startsWith('#')) raw = `#${raw}`;
  const known = COLOR_BY_HEX[raw];
  return known ? { color: known, unknown: false } : { color: 'yellow', unknown: true };
}

export function zoteroAttachmentKey(identity: string): string {
  for (const part of String(identity ?? '').split(':').reverse()) {
    if (part.length === 8 && part === part.toUpperCase() && /^[A-Z0-9]+$/.test(part)) {
      return part;
    }
  }
  return '';
}

/** 解析 `annotationPosition`（字符串或对象）；失败时返回原因。 */
function parseZoteroPosition(data: Record<string, unknown>): {
  position: Record<string, unknown> | null;
  reason: string;
} {
  const raw = data.annotationPosition;
  if (!raw) return { position: null, reason: '这条批注没有记录位置' };
  let parsed: unknown;
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return { position: null, reason: '这条批注的位置数据无法解析' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { position: null, reason: '这条批注的位置数据无法解析' };
  }
  return { position: parsed as Record<string, unknown>, reason: '' };
}

/** 页面几何：PDF 用户空间宽高（CropBox 优先，回退 MediaBox）与旋转角度。 */
export interface ZoteroPageGeometry {
  width: number;
  height: number;
  /** 页旋转角度（0/90/180/270）；非 0 时本应用不按坐标换算。 */
  rotation: number;
}

/** annotationPosition 里解析出的原始坐标（PDF 用户空间、左下原点、[left,bottom,right,top]）。 */
export interface ZoteroPositionData {
  pageIndex: number | null;
  rects: Array<[number, number, number, number]>;
  reason: string;
}

/**
 * 解析 Zotero 的 `annotationPosition.rects`（PDF 用户空间矩形）。
 *
 * rects 缺失/格式不对时返回空数组并给出原因；调用方据此回退文本定位，
 * 而不是把整条批注当成错误。
 */
export function zoteroPositionData(data: Record<string, unknown>): ZoteroPositionData {
  const parsed = parseZoteroPosition(data);
  if (!parsed.position) return { pageIndex: null, rects: [], reason: parsed.reason };
  const index = Number(parsed.position.pageIndex);
  const pageIndex = Number.isInteger(index) ? index : null;
  const raw = parsed.position.rects;
  if (!Array.isArray(raw) || raw.length === 0) {
    return { pageIndex, rects: [], reason: '这条批注没有可用的坐标' };
  }
  const rects: Array<[number, number, number, number]> = [];
  for (const item of raw) {
    if (!Array.isArray(item) || item.length !== 4) continue;
    const values = item.map(Number);
    if (!values.every((value) => Number.isFinite(value))) continue;
    rects.push([values[0]!, values[1]!, values[2]!, values[3]!]);
  }
  return {
    pageIndex,
    rects,
    reason: rects.length > 0 ? '' : '这条批注的坐标数据无效'
  };
}

export interface NormalizedZoteroRects {
  ok: boolean;
  /** 本应用需要的 rects：0..1、左上原点、viewport 视觉方向。 */
  rects: number[][];
  reason: string;
}

/**
 * 把 Zotero 的用户空间矩形换算成本应用的归一化矩形。
 *
 * Zotero 的 rect 是 PDF 用户空间（左下原点）的 [left, bottom, right, top]；
 * 本应用 rects 是 0..1、左上原点：[x1/W, 1-y2/H, x2/W, 1-y1/H]。
 * W/H 取该页 CropBox（无 CropBox 时 MediaBox）宽高，因此不同页尺寸都能换算。
 *
 * rotation ≠ 0 的页面不猜旋转坐标：返回 ok=false，由调用方回退文本逐字定位。
 */
export function normalizeZoteroRects(
  rawRects: ReadonlyArray<readonly number[]>,
  geometry: ZoteroPageGeometry
): NormalizedZoteroRects {
  const width = Number(geometry.width);
  const height = Number(geometry.height);
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
    return { ok: false, rects: [], reason: '页面尺寸无效，无法换算 Zotero 坐标' };
  }
  const rotation = ((Math.round(Number(geometry.rotation) / 90) * 90) % 360 + 360) % 360;
  if (rotation !== 0) {
    return {
      ok: false,
      rects: [],
      reason: `页面旋转了 ${rotation} 度，暂不按 Zotero 坐标导入`
    };
  }
  const clamp = (value: number): number => Math.min(1, Math.max(0, value));
  const rects: number[][] = [];
  for (const raw of rawRects) {
    if (!Array.isArray(raw) || raw.length !== 4) continue;
    const values = raw.map(Number);
    if (!values.every((value) => Number.isFinite(value))) continue;
    const [x1, y1, x2, y2] = values as [number, number, number, number];
    const left = Math.min(x1, x2);
    const right = Math.max(x1, x2);
    const bottom = Math.min(y1, y2);
    const top = Math.max(y1, y2);
    const nx1 = clamp(left / width);
    const nx2 = clamp(right / width);
    const ny1 = clamp(1 - top / height);
    const ny2 = clamp(1 - bottom / height);
    if (!(nx2 - nx1 > 1e-6) || !(ny2 - ny1 > 1e-6)) continue;
    rects.push([nx1, ny1, nx2, ny2]);
  }
  if (rects.length === 0) {
    return { ok: false, rects: [], reason: 'Zotero 坐标无法换算成本应用位置' };
  }
  return { ok: true, rects, reason: '' };
}

export function zoteroAnnotationPage(
  data: Record<string, unknown>,
  totalPages: number
): { page: number | null; reason: string } {
  const parsed = parseZoteroPosition(data);
  if (!parsed.position) return { page: null, reason: parsed.reason };
  const index = Number(parsed.position.pageIndex);
  if (!Number.isInteger(index)) return { page: null, reason: '这条批注的位置数据无法解析' };
  const page = index + 1;
  if (page < 1) return { page: null, reason: '这条批注的页码无效' };
  if (totalPages > 0 && page > totalPages) {
    return {
      page: null,
      reason: `这条批注记在第 ${page} 页，但当前文献只有 ${totalPages} 页`
    };
  }
  return { page, reason: '' };
}

export interface ZoteroAnnotationCandidate {
  ok: boolean;
  category?: 'type' | 'empty' | 'page';
  reason: string;
  zoteroKey: string;
  type: string;
  page?: number;
  quote: string;
  comment: string;
  color?: string;
  unknownColor?: boolean;
  style?: string;
  sortIndex?: string;
}

export function mapZoteroAnnotation(
  raw: Record<string, unknown>,
  totalPages: number
): ZoteroAnnotationCandidate {
  const data = raw && typeof raw === 'object' ? raw : {};
  const kind = String(data.annotationType ?? '');
  const quote = String(data.annotationText ?? '').trim();
  const comment = String(data.annotationComment ?? '').trim();
  const zoteroKey = String(data.key ?? data.itemKey ?? '');
  const style = STYLE_BY_TYPE[kind];
  if (!style) {
    const label = TYPE_LABELS[kind] ?? (kind || '未知类型');
    return {
      ok: false,
      category: 'type',
      reason: `${label}没有可迁移的文字：${label}类标注无法复用`,
      zoteroKey,
      type: kind,
      quote,
      comment
    };
  }
  if (!quote && !comment) {
    return {
      ok: false,
      category: 'empty',
      reason: '这条标注既没有原文也没有批注内容',
      zoteroKey,
      type: kind,
      quote,
      comment
    };
  }
  const position = zoteroAnnotationPage(data, totalPages);
  if (position.page == null) {
    return {
      ok: false,
      category: 'page',
      reason: position.reason,
      zoteroKey,
      type: kind,
      quote,
      comment
    };
  }
  const color = paletteColor(data.annotationColor);
  return {
    ok: true,
    reason: '',
    zoteroKey,
    type: kind,
    page: position.page,
    quote: quote.slice(0, 12_000),
    comment: comment.slice(0, 20_000),
    color: color.color,
    unknownColor: color.unknown,
    style,
    sortIndex: String(data.annotationSortIndex ?? '')
  };
}
