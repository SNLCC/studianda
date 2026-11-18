import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFRef,
  degrees,
  type PDFPage
} from 'pdf-lib';
import {
  looksLikeAiContent,
  markdownPlainText,
  type AnnotationRecord,
  type ImageWatermarkKind
} from '@studianda/shared';
import {
  AI_EXPORT_REFUSED_MESSAGE,
  AI_EXPORT_REFUSED_PHRASE,
  isAiExportRefused
} from './export-marker.js';
import { renderWatermarkStrip } from './watermark.js';

export interface AnnotatedPdfUnplacedDetail {
  id: string;
  page: number | null;
  reason: string;
  detail: string;
}

/**
 * `buildAnnotatedPdf` 的可注入依赖。
 *
 * 生产路径全部用默认实现；`renderWatermarkStrip` 只为测试保留——用来模拟
 * 「水印条生成失败 / 生成的不是合法 PNG」并验证 fail-closed 真的拒绝产出，而不是形同虚设。
 */
export interface AnnotatedPdfOptions {
  /** 可选：注入水印条渲染函数（默认用 core 的 `renderWatermarkStrip`，scale=3）。 */
  renderWatermarkStrip?: (kind: ImageWatermarkKind) => Promise<Uint8Array>;
}

export interface AnnotatedPdfResult {
  bytes: Uint8Array;
  placed: number;
  unplaced: number;
  unplacedReasons: Record<string, number>;
  /** 写入副本的批注按 style 计数（可选字段，兼容旧调用方）。 */
  byStyle?: Record<string, number>;
  /** 前 50 条未写入明细（不含正文），便于界面如实说明原因。 */
  unplacedDetails?: AnnotatedPdfUnplacedDetail[];
  /** 一句给用户看的中文结论；不含原文或批注文字。 */
  message?: string;
  /** 这份 PDF 里带 /Rotate 的页码（1 基）。 */
  pagesWithRotation?: number[];
}

const COLORS: Record<string, [number, number, number]> = {
  yellow: [0.922, 0.78, 0.263],
  green: [0.455, 0.729, 0.416],
  blue: [0.4, 0.667, 0.859],
  pink: [0.898, 0.549, 0.675],
  purple: [0.69, 0.514, 0.824],
  orange: [0.937, 0.667, 0.341]
};
const DEFAULT_COLOR = COLORS.yellow!;
const KNOWN_STYLES = new Set(['highlight', 'underline', 'margin', 'region', 'page']);
const NOTE_SIZE = 20;
const NOTE_GAP = 8;
const POPUP_WIDTH = 320;
const POPUP_HEIGHT = 160;
const POPUP_GAP = 8;
const TITLE = '勘读 · Studianda';
const DETAIL_LIMIT = 50;

/**
 * 含 AI 内容的带批注 PDF：页脚「烧进像素」的图片水印参数。
 *
 * 批注里粘贴的 AI 内容可能是回答、译文或视觉识别文本，统一用 shared 的
 * `generated` 文案（「AI 生成 · 勘读 Studianda」），不猜测具体来源类型。
 */
const AI_WATERMARK_KIND: ImageWatermarkKind = 'generated';
/** 水印条宽度占页面可视宽度的比例（需求要求 22–28%）。 */
const AI_WATERMARK_PAGE_WIDTH_RATIO = 0.24;
/** 距页面可见边缘的留白比例（按短边算），避免贴边被裁切。 */
const AI_WATERMARK_MARGIN_RATIO = 0.03;
/** 贴到页面上的不透明度；图片本身仍有半透明底带，叠起来约 0.5。 */
const AI_WATERMARK_OPACITY = 0.85;
/** 水印条按 3x 渲染：嵌入的是高清位图，缩放/打印后文字边缘仍清楚。 */
const AI_WATERMARK_STRIP_SCALE = 3;

/**
 * 文件级失败（加密/损坏/占用/读写失败）统一包成中文：server 的 409 映射靠
 * `/未改动|写入|打开|占用|加密|锁定/` 识别，pdf-lib 的英文原文会漏判成 400。
 * 参数/批注级错误（某一条写不进去）仍按 unplaced 如实统计，不抛异常。
 */
const EXPORT_FAILURE_PREFIX = '导出批注 PDF 失败：原文件未改动';

function exportFailureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  if (lower.includes('encrypt') || lower.includes('password')) {
    return '文件已加密，无法写入批注副本';
  }
  if (
    lower.includes('no pdf header') ||
    lower.includes('invalid pdf') ||
    lower.includes('unexpected') ||
    lower.includes('parse')
  ) {
    return 'PDF 文件损坏或不是有效 PDF';
  }
  if (lower.includes('enoent') || lower.includes('no such file')) {
    return '找不到原文件';
  }
  if (
    lower.includes('eacces') ||
    lower.includes('eperm') ||
    lower.includes('ebusy') ||
    lower.includes('locked') ||
    lower.includes('permission')
  ) {
    return '文件被占用或没有读写权限';
  }
  return message.trim().slice(0, 200) || '无法读取或写入 PDF';
}

/** 把文件级失败包成中文错误；参数/内部错误仍走原样抛出。 */
function fileLevelExportError(error: unknown): Error {
  const wrapped = new Error(`${EXPORT_FAILURE_PREFIX}（${exportFailureReason(error)}）`);
  wrapped.name = 'AnnotatedPdfExportError';
  return wrapped;
}

/**
 * 含 AI 内容的带批注 PDF 必须把图片水印真的写进每一页；任何一步（渲染水印条、
 * embedPng、按页面尺寸贴图、写后核验）失败都拒绝产出。
 *
 * 文案保留 `AI_EXPORT_REFUSED_PHRASE`，server 据此映射 4xx 明确错误，而不是
 * 笼统的 409「原文件未改动」；同时点明是「图片水印标识未能写入」。
 */
function aiWatermarkRefused(detail: string, error: unknown): Error {
  const reason = error instanceof Error ? error.message : String(error);
  const refused = new Error(
    `${AI_EXPORT_REFUSED_PHRASE}：含 AI 生成内容，但图片水印标识未能写入（${detail}：` +
      `${reason.trim().slice(0, 180)}）；为避免产出无标识文件，已中止导出。`
  );
  refused.name = 'AiExportRefusedError';
  return refused;
}

/** 给用户看的未写入原因（REASON_TEXT）。 */
const REASON_TEXT: Record<string, string> = {
  rotated_page: '页面有旋转，归一化坐标与 PDF 用户空间对不上，未写入副本，请核对',
  page_out_of_range: '页码超出这份 PDF 的页数',
  invalid_page: '页码不是有效数字',
  invalid_rect: '批注位置无效（不是 0..1 内的矩形）',
  empty_annotation: '批注没有文字内容，便签没有正文可写',
  write_failed: '写入这一条时出错，已跳过'
};

interface VisibleBox {
  left: number;
  bottom: number;
  width: number;
  height: number;
}

type PdfRect = [number, number, number, number];

function toHex(content: string): PDFHexString {
  return PDFHexString.fromText(content.slice(0, 4000));
}

/** 把 rects 字符串解析成 0..1 的归一化矩形；坏数据返回 null（这一条不写入）。 */
function rectsOf(raw: string): PdfRect[] | null {
  if (!raw || !raw.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const rects: PdfRect[] = [];
  for (const item of parsed) {
    if (!Array.isArray(item) || item.length !== 4) return null;
    const values = item as unknown[];
    if (!values.every((value) => typeof value === 'number' && Number.isFinite(value))) return null;
    const [x0, y0, x1, y1] = values as [number, number, number, number];
    if (!(0 <= x0 && x0 < x1 && x1 <= 1 && 0 <= y0 && y0 < y1 && y1 <= 1)) return null;
    rects.push([x0, y0, x1, y1]);
  }
  return rects;
}

/** 老数据的 style 可能是空串或未知值：有位置按高亮、没位置按整页便签。 */
function effectiveStyle(style: string, rects: PdfRect[]): string {
  const value = style.trim().toLowerCase();
  if (KNOWN_STYLES.has(value)) return value;
  return rects.length > 0 ? 'highlight' : 'page';
}

function pageNumberOf(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  return null;
}

/**
 * 用户批注/笔记正文：存储是 Markdown（`**加粗**`、`# 标题` 等），写进 PDF 原生批注前
 * 清成纯文本，否则阅读器的注释面板会原样显示 Markdown 标记。原文 quote 是 PDF 原文，保持不动。
 */
function commentText(annotation: AnnotationRecord): string {
  return markdownPlainText(annotation.content ?? '').trim();
}

/** 便签正文：原文在前、批注文字在后。 */
function noteText(annotation: AnnotationRecord): string {
  const quote = annotation.quote.trim();
  const content = commentText(annotation);
  if (quote && content) return `原文：${quote}\n\n批注：${content}`;
  if (quote) return `原文：${quote}`;
  return content;
}

/** 归一化页码的 /Rotate 角度；读不出来按"旋转未知"返回 null。 */
function rotationOf(page: PDFPage): number | null {
  try {
    const rotation = page.getRotation();
    const angle = rotation.type === 'degrees' ? rotation.angle : (rotation.angle * 180) / Math.PI;
    const normalized = Math.round(angle) % 360;
    return normalized < 0 ? normalized + 360 : normalized;
  } catch {
    return null;
  }
}

/** 页面可见区域：用 CropBox（与 pdfium get_size 一致），坏页面框返回 null。 */
function visibleBoxOf(page: PDFPage): VisibleBox | null {
  try {
    const crop = page.getCropBox();
    const { x, y, width, height } = crop;
    if (![x, y, width, height].every((value) => Number.isFinite(value))) return null;
    if (width <= 0 || height <= 0) return null;
    return { left: x, bottom: y, width, height };
  } catch {
    return null;
  }
}

/** 归一化矩形（左上原点）→ PDF 用户空间 [left, bottom, right, top]。 */
function pdfRect(box: VisibleBox, rect: PdfRect): PdfRect {
  const [x0, y0, x1, y1] = rect;
  return [
    box.left + x0 * box.width,
    box.bottom + (1 - y1) * box.height,
    box.left + x1 * box.width,
    box.bottom + (1 - y0) * box.height
  ];
}

export interface WatermarkPlacement {
  /** `page.drawImage` 的 x（图片局部原点的用户空间坐标）。 */
  x: number;
  y: number;
  /** 图片在版面视觉方向上的宽/高（pt）。 */
  width: number;
  height: number;
  /** 逆时针旋转角：0 / 90 / 180 / 270。 */
  rotate: number;
  /** 图片在用户空间的轴对齐包围盒 [left, bottom, right, top]，供核验用。 */
  bounds: PdfRect;
}

/**
 * 计算图片水印在页面上的贴图位置（纯函数，便于单测）。
 *
 * 页面尺寸用**可见区域**（CropBox），并按 `/Rotate` 换成视觉方向：
 * 90°/270° 时视觉宽高互换，水印仍落在**视觉右下角**且文字正立。
 * 返回的 `rotate` 是给 pdf-lib 的逆时针角度（pdf-lib 的 `rotate` 以图片左下角为轴）。
 */
export function imageWatermarkPlacement(
  box: { left: number; bottom: number; width: number; height: number },
  rotation: number,
  imageWidth: number,
  imageHeight: number
): WatermarkPlacement {
  if (!(imageWidth > 0) || !(imageHeight > 0)) {
    throw new Error('水印图片尺寸不合法');
  }
  if (!(box.width > 0) || !(box.height > 0)) {
    throw new Error('页面可见区域不合法');
  }
  if (!Number.isFinite(rotation)) {
    throw new Error('页面旋转角度不合法');
  }
  // /Rotate 必须是 90 的倍数；不是就拒绝（fail-closed），不要硬猜方向。
  const angle = ((Math.round(rotation) % 360) + 360) % 360;
  if (angle % 90 !== 0) {
    throw new Error('页面旋转角度不合法');
  }
  const swapped = angle === 90 || angle === 270;
  const visualWidth = swapped ? box.height : box.width;
  const visualHeight = swapped ? box.width : box.height;
  const margin = Math.max(4, Math.min(visualWidth, visualHeight) * AI_WATERMARK_MARGIN_RATIO);
  const aspect = imageHeight / imageWidth;
  // 宽度取页面可视宽度的 24%，纵横比由 PNG 决定；极扁页面再按可用高度收窄，避免越界。
  const width = Math.min(
    visualWidth * AI_WATERMARK_PAGE_WIDTH_RATIO,
    Math.max(1, visualHeight - margin * 2) / aspect
  );
  const height = width * aspect;
  const right = box.left + box.width;
  const top = box.bottom + box.height;

  switch (angle) {
    case 0: {
      const x = right - margin - width;
      const y = box.bottom + margin;
      return { x, y, width, height, rotate: 0, bounds: [x, y, x + width, y + height] };
    }
    case 90: {
      // 视觉右下角 = 原始页右上角；图片局部 +x 转到用户空间 +y，局部 +y 转到 -x。
      const x = right - margin;
      const y = top - margin - width;
      return {
        x,
        y,
        width,
        height,
        rotate: 90,
        bounds: [x - height, y, x, y + width]
      };
    }
    case 180: {
      // 视觉右下角 = 原始页左上角；整张图倒转 180°。
      const x = box.left + margin + width;
      const y = top - margin;
      return {
        x,
        y,
        width,
        height,
        rotate: 180,
        bounds: [box.left + margin, y - height, x, y]
      };
    }
    default: {
      // 270°：视觉右下角 = 原始页左下角；图片局部 +x 转到用户空间 -y。
      const x = box.left + margin;
      const y = box.bottom + margin + width;
      return {
        x,
        y,
        width,
        height,
        rotate: 270,
        bounds: [x, y - width, x + height, y]
      };
    }
  }
}

/** 页面资源里的 /XObject 数量（画图片水印前后各数一次，用于写后核验）。 */
function xObjectCount(page: PDFPage): number {
  const resources = page.node.Resources();
  if (!(resources instanceof PDFDict)) return 0;
  const xobjects = resources.lookupMaybe(PDFName.of('XObject'), PDFDict);
  return xobjects ? xobjects.keys().length : 0;
}

/**
 * 把 AI 图片水印条贴到**每一页**右下角（按页面实际 CropBox 尺寸与 /Rotate 计算）。
 *
 * fail-closed：渲染、embed、逐页贴图任一失败都抛「拒绝导出」错误；
 * 贴完再逐页核验 /XObject 数量确实 +1，防止某页静默漏写。
 */
async function addAiWatermarkToEveryPage(
  pdf: PDFDocument,
  renderStrip: (kind: ImageWatermarkKind) => Promise<Uint8Array>
): Promise<void> {
  let strip: Uint8Array;
  try {
    strip = await renderStrip(AI_WATERMARK_KIND);
  } catch (error) {
    throw aiWatermarkRefused('水印条渲染失败', error);
  }
  if (!(strip instanceof Uint8Array) || strip.byteLength === 0) {
    throw aiWatermarkRefused('水印条为空', new Error('renderWatermarkStrip 返回空字节'));
  }
  let image;
  try {
    image = await pdf.embedPng(strip);
  } catch (error) {
    throw aiWatermarkRefused('水印图片嵌入失败', error);
  }

  const pages = pdf.getPages();
  const before = pages.map((page) => xObjectCount(page));
  try {
    pages.forEach((page, index) => {
      const box = visibleBoxOf(page);
      if (!box) throw new Error(`第 ${index + 1} 页的可见区域不合法`);
      const rotation = rotationOf(page);
      if (rotation === null) throw new Error(`第 ${index + 1} 页的旋转角度无法确定`);
      const placement = imageWatermarkPlacement(box, rotation, image.width, image.height);
      page.drawImage(image, {
        x: placement.x,
        y: placement.y,
        width: placement.width,
        height: placement.height,
        rotate: degrees(placement.rotate),
        opacity: AI_WATERMARK_OPACITY
      });
    });
  } catch (error) {
    throw aiWatermarkRefused('水印未写入每一页', error);
  }

  pages.forEach((page, index) => {
    const expected = (before[index] ?? 0) + 1;
    if (xObjectCount(page) !== expected) {
      throw aiWatermarkRefused(
        `第 ${index + 1} 页水印核验失败`,
        new Error(`/XObject 数量应为 ${expected}`)
      );
    }
  });
}

/** /QuadPoints 顺序：上左、上右、下左、下右。 */
function quadPoints(rect: PdfRect): number[] {
  const [left, bottom, right, top] = rect;
  return [left, top, right, top, left, bottom, right, bottom];
}

function noteRect(box: VisibleBox): PdfRect {
  return [
    box.left + box.width - NOTE_GAP - NOTE_SIZE,
    box.bottom + box.height - NOTE_GAP - NOTE_SIZE,
    box.left + box.width - NOTE_GAP,
    box.bottom + box.height - NOTE_GAP
  ];
}

/**
 * 段落批注（margin）的便签锚点。
 *
 * PDF 没有「段落批注」这种原生标注类型，最接近的做法仍是用 /Text 便签，但把它锚定在
 * 段落首行右侧的页边距内，而不是永远画在页面右上角。有 rects 时用第一行（段落首行）
 * 的 PDF 矩形定位；没有 rects 时由调用方回退到右上角 noteRect()。
 * 返回值始终是页面内的正尺寸矩形。
 */
function anchoredNoteRect(box: VisibleBox, line: PdfRect): PdfRect {
  const pageRight = box.left + box.width;
  const pageTop = box.bottom + box.height;
  const maxLeft = Math.max(box.left, pageRight - NOTE_GAP - NOTE_SIZE);
  const left = Math.min(Math.max(line[2] + NOTE_GAP, box.left), maxLeft);
  const maxBottom = Math.max(box.bottom, pageTop - NOTE_GAP - NOTE_SIZE);
  const bottom = Math.min(Math.max(line[3] - NOTE_SIZE, box.bottom), maxBottom);
  return [left, bottom, left + NOTE_SIZE, bottom + NOTE_SIZE];
}

/**
 * /Popup 弹出框：优先贴在命中区域右侧；右边放不下就挪到左侧，再不行贴页面边缘，
 * 始终是页面内一个正尺寸矩形（部分阅读器对越界/零尺寸 popup 直接不显示）。
 */
function popupRect(box: VisibleBox, bounds: PdfRect): PdfRect {
  const pageLeft = box.left;
  const pageBottom = box.bottom;
  const pageRight = box.left + box.width;
  const pageTop = box.bottom + box.height;
  const width = Math.min(POPUP_WIDTH, box.width);
  const height = Math.min(POPUP_HEIGHT, box.height);
  let left = bounds[2] + POPUP_GAP;
  if (left + width > pageRight) left = bounds[0] - POPUP_GAP - width;
  if (left < pageLeft) left = Math.max(pageLeft, pageRight - width);
  let bottom = bounds[3] - height;
  if (bottom < pageBottom) bottom = pageBottom;
  if (bottom + height > pageTop) bottom = Math.max(pageBottom, pageTop - height);
  return [left, bottom, Math.min(left + width, pageRight), Math.min(bottom + height, pageTop)];
}

/** annotation.created（ISO 或 SQLite 的 UTC 时间串）→ PDF 日期 D:YYYYMMDDHHmmss；解析失败返回 null。 */
function pdfDateOf(value: string): string | null {
  const raw = value.trim();
  if (!raw) return null;
  // SQLite CURRENT_TIMESTAMP 是 "YYYY-MM-DD HH:MM:SS"（UTC，无时区标记），先转成 ISO 再按 UTC 解析。
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(raw)
    ? raw.replace(' ', 'T')
    : raw;
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(normalized);
  const time = Date.parse(hasZone ? normalized : `${normalized}Z`);
  if (!Number.isFinite(time)) return null;
  const date = new Date(time);
  const pad = (part: number): string => String(part).padStart(2, '0');
  return `D:${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(
    date.getUTCHours()
  )}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;
}

/** /T、/NM、/M、/CreationDate：阅读器注释列表里的作者、唯一名与时间。 */
function identityOf(annotation: AnnotationRecord): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    T: toHex(TITLE),
    NM: toHex(annotation.id)
  };
  const date = pdfDateOf(annotation.created ?? '');
  if (date) {
    fields.M = toHex(date);
    fields.CreationDate = toHex(date);
  }
  return fields;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** /RC 简单 XHTML 富文本：段落与 /Contents 的「原文 / 批注」一致；无文字返回 null。 */
function richTextOf(annotation: AnnotationRecord): string | null {
  const quote = annotation.quote.trim();
  const content = commentText(annotation);
  const paragraphs: string[] = [];
  if (quote) paragraphs.push(`原文：${quote}`);
  if (content) paragraphs.push(`批注：${content}`);
  if (paragraphs.length === 0) return null;
  const html = paragraphs
    .map((paragraph) => `<p>${escapeXml(paragraph).replace(/\r?\n/g, '<br />')}</p>`)
    .join('');
  return `<body xmlns="http://www.w3.org/1999/xhtml">${html}</body>`;
}

function messageOf(
  placed: number,
  unplaced: number,
  total: number,
  reasons: Record<string, number>
): string {
  if (!total) return '这份文献还没有批注；已生成一份未改动的副本，原文件未改动。';
  if (!unplaced) return `已把 ${placed} 条批注写入副本；原文件未改动。`;
  const detail = Object.entries(reasons)
    .map(([key, count]) => `${REASON_TEXT[key] ?? key} ${count} 条`)
    .join('、');
  if (placed) {
    return `已写入 ${placed} 条批注；${unplaced} 条未写入（${detail}）；原文件未改动。`;
  }
  return `没有批注能写入副本：${unplaced} 条未写入（${detail}）；原文件未改动。`;
}

/**
 * 批注里是否含「AI 内容」。
 *
 * 判定「字段优先、文本兜底」：
 * - `origin === 'ai'`：系统把 AI 译文/识别结果写进批注时落的来源字段，即使用户删掉
 *   正文里的标识文字仍然可靠（这正是只靠文本判断的盲区）；
 * - 文本兜底：迁移前的老批注没有 origin 字段，用户从「复制回答 / 复制译文 / 复制识别
 *   文本」粘进来的内容会带「不得删除、篡改或隐匿本标识」的标识文字，命中任一标记
 *   仍按 AI 内容处理。
 */
function hasAiContentInAnnotations(annotations: AnnotationRecord[]): boolean {
  return annotations.some(
    (annotation) => annotation.origin === 'ai' || looksLikeAiContent(annotation.content)
  );
}

/**
 * 取（必要时创建）Info 字典。`PDFDocument.getInfoDict()` 在本版本是私有方法，这里走
 * trailer 的 /Info 引用；原文件没有 Info 时新建一个并写回 trailer。
 */
function ensureInfoDict(pdf: PDFDocument): PDFDict {
  const context = pdf.context;
  const current = context.trailerInfo.Info;
  if (current instanceof PDFDict) return current;
  if (current instanceof PDFRef) {
    const existing = context.lookup(current, PDFDict);
    if (existing instanceof PDFDict) return existing;
  }
  const dict = context.obj({}) as PDFDict;
  context.trailerInfo.Info = context.register(dict);
  return dict;
}

/**
 * 给含 AI 内容的带批注 PDF 写入机器可读的 AI 元数据（Info 字典自定义键）。
 *
 * 只在批注确实带 AI 标识时才写，纯手写批注不加；已有同名键（第三方或旧版本写入的
 * `AIGC`）一律保留，不覆盖、不清洗，避免变成"导出即去标识"。
 */
function markAiMetadata(pdf: PDFDocument): void {
  const info = ensureInfoDict(pdf);
  const setOnce = (key: string, value: string): void => {
    const name = PDFName.of(key);
    if (!info.has(name)) info.set(name, PDFHexString.fromText(value));
  };
  setOnce('AIGC', 'true');
  setOnce('AIGenerated', 'true');
  setOnce('AITool', 'Studianda');
  setOnce('AIContent', 'annotations contain AI-generated text pasted by the user');
}

/** Info 字典里是否已带可识别的 AI 标识（用于导出前核验，不只看“调用过写入”）。 */
function aiMetadataMarked(pdf: PDFDocument): boolean {
  const current = pdf.context.trailerInfo.Info;
  const info =
    current instanceof PDFDict
      ? current
      : current instanceof PDFRef
        ? pdf.context.lookup(current, PDFDict)
        : null;
  if (!(info instanceof PDFDict)) return false;
  return ['AIGC', 'AIGenerated', 'AITool'].every((key) => info.has(PDFName.of(key)));
}

/**
 * 导出前的 fail-closed 核验：含 AI 内容时必须确认 AI 元数据真的写进了 Info 字典。
 *
 * 导出为测试与调用方都保留这个检查：只写一次 `markAiMetadata` 就相信它成功，
 * 正是“写失败/漏写仍产出文件”的漏洞来源。核验不过抛中文拒绝错误，不产出 bytes。
 * 导出以便单测直接验证核验逻辑。
 */
export function assertAiMetadataWritten(pdf: PDFDocument): void {
  if (!aiMetadataMarked(pdf)) throw new Error(AI_EXPORT_REFUSED_MESSAGE);
}

/** 生成带批注的 PDF 副本；原文件字节不改。文件级失败包成中文 409 话术。 */
export async function buildAnnotatedPdf(
  original: Uint8Array | null | undefined,
  annotations: AnnotationRecord[],
  options: AnnotatedPdfOptions = {}
): Promise<AnnotatedPdfResult> {
  if (!original || !(original instanceof Uint8Array) || original.byteLength === 0) {
    throw fileLevelExportError(new Error('没有读到原文件内容'));
  }
  let pdf: PDFDocument;
  try {
    pdf = await PDFDocument.load(original, { updateMetadata: false });
  } catch (error) {
    throw fileLevelExportError(error);
  }
  const context = pdf.context;
  const pages = pdf.getPages();
  const reasons: Record<string, number> = {};
  const byStyle: Record<string, number> = {};
  const unplacedDetails: AnnotatedPdfUnplacedDetail[] = [];
  let placed = 0;
  let unplaced = 0;

  /** 把一个已登记的间接对象追加进页面 /Annots。 */
  const appendAnnot = (pageIndex: number, ref: PDFRef): void => {
    const page = pages[pageIndex];
    if (!page) throw new Error('page');
    const existing = page.node.lookup(PDFName.of('Annots'));
    if (existing instanceof PDFArray) existing.push(ref);
    else page.node.set(PDFName.of('Annots'), context.obj([ref]));
  };

  const addAnnotation = (pageIndex: number, dictionary: Record<string, unknown>): void => {
    const ref = context.register(
      context.obj(dictionary as unknown as Parameters<typeof context.obj>[0])
    );
    appendAnnot(pageIndex, ref);
  };

  const skip = (annotation: AnnotationRecord, reason: string, detail: string): void => {
    unplaced += 1;
    reasons[reason] = (reasons[reason] ?? 0) + 1;
    if (unplacedDetails.length < DETAIL_LIMIT) {
      unplacedDetails.push({
        id: annotation.id,
        page: pageNumberOf(annotation.page),
        reason,
        detail
      });
    }
  };

  const pagesWithRotation: number[] = [];
  pages.forEach((page, index) => {
    const rotation = rotationOf(page);
    if (rotation) pagesWithRotation.push(index + 1);
  });

  for (const annotation of annotations) {
    const pageNumber = pageNumberOf(annotation.page);
    if (pageNumber === null) {
      skip(annotation, 'invalid_page', '页码字段不是整数');
      continue;
    }
    if (pageNumber < 1 || pageNumber > pages.length) {
      skip(annotation, 'page_out_of_range', `第 ${pageNumber} 页不在 1..${pages.length} 之间`);
      continue;
    }
    const page = pages[pageNumber - 1]!;
    const rotation = rotationOf(page);
    if (rotation === null) {
      skip(annotation, 'rotated_page', `第 ${pageNumber} 页的旋转信息无法读取，无法确认坐标方向`);
      continue;
    }
    // 旋转页的归一化坐标来自"视觉方向"，与 PDF 用户空间对不上，硬画会错位：
    // 不写入，如实计入 unplaced。
    if (rotation !== 0) {
      skip(annotation, 'rotated_page', `第 ${pageNumber} 页旋转了 ${rotation}°，归一化坐标无法可靠映射`);
      continue;
    }
    const box = visibleBoxOf(page);
    if (!box) {
      skip(annotation, 'write_failed', `第 ${pageNumber} 页的页面尺寸不合法`);
      continue;
    }
    const rects = rectsOf(annotation.rects ?? '');
    if (rects === null) {
      skip(annotation, 'invalid_rect', '位置数据不是 0..1 内的有效矩形');
      continue;
    }
    const style = effectiveStyle(annotation.style ?? '', rects);
    const color = COLORS[(annotation.color ?? '').trim().toLowerCase()] ?? DEFAULT_COLOR;
    const text = noteText(annotation);

    // 整页批注、段落侧线，以及"有文字但没位置"的批注：写成便签（Text）。
    if (style === 'page' || style === 'margin' || rects.length === 0) {
      if (!text) {
        skip(annotation, 'empty_annotation', '没有原文也没有批注文字');
        continue;
      }
      try {
        // 段落批注：PDF 没有原生「段落批注」类型，带 rects 时把 /Text 便签锚在段落首行
        // 右侧页边距内（最接近的原生效果）；page 批注或没有 rects 时才回退右上角。
        const anchor = rects.length > 0 ? anchoredNoteRect(box, pdfRect(box, rects[0]!)) : null;
        const dictionary: Record<string, unknown> = {
          Type: 'Annot',
          Subtype: 'Text',
          Rect: anchor ?? noteRect(box),
          Contents: toHex(text),
          C: color,
          Name: 'Note',
          F: 4,
          // Edge/PDFium 及部分阅读器按 /P 把批注挂到页面上；缺了它个别阅读器会忽略批注。
          P: page.ref,
          ...identityOf(annotation)
        };
        const rc = richTextOf(annotation);
        if (rc) dictionary.RC = toHex(rc);
        addAnnotation(pageNumber - 1, dictionary);
      } catch (error) {
        skip(annotation, 'write_failed', `写入时出错（${errorName(error)}）`);
        continue;
      }
      placed += 1;
      byStyle[style] = (byStyle[style] ?? 0) + 1;
      continue;
    }

    // 高亮 / 下划线 / 区域框选：**全部** rects 合成一条标注的 /QuadPoints
    // （只用 rects[0] 会让多行高亮缺段）。
    try {
      const converted = rects.map((rect) => pdfRect(box, rect));
      const bounds: PdfRect = [
        Math.min(...converted.map((rect) => rect[0])),
        Math.min(...converted.map((rect) => rect[1])),
        Math.max(...converted.map((rect) => rect[2])),
        Math.max(...converted.map((rect) => rect[3]))
      ];
      const quad = converted.flatMap((rect) => quadPoints(rect));
      const subtype = style === 'underline' ? 'Underline' : 'Highlight';
      const dictionary: Record<string, unknown> = {
        Type: 'Annot',
        Subtype: subtype,
        Rect: bounds,
        QuadPoints: quad,
        C: color,
        CA: subtype === 'Underline' ? 0.8 : 0.4,
        F: 4,
        // 原生批注应带 /P 页面引用；Edge/PDFium 等按它确认批注归属页。
        P: page.ref,
        ...identityOf(annotation)
      };
      if (text) {
        dictionary.Contents = toHex(text);
        const rc = richTextOf(annotation);
        if (rc) dictionary.RC = toHex(rc);
      }
      // 有文字时补一个 /Popup 弹出批注：批注 /Popup 指向它、它 /Parent 回指批注，
      // 两者都登记进页面 /Annots。缺了它，很多阅读器只会画出高亮/下划线，点开没有内容。
      const markRef = context.register(
        context.obj(dictionary as unknown as Parameters<typeof context.obj>[0])
      );
      if (text) {
        const popupRef = context.register(
          context.obj({
            Type: 'Annot',
            Subtype: 'Popup',
            Rect: popupRect(box, bounds),
            Open: false,
            Parent: markRef,
            // popup 同样需要 /P；页面 /Annots 里也保留它（PDF 规范要求页面上所有批注都在 /Annots 中）。
            P: page.ref
          } as unknown as Parameters<typeof context.obj>[0])
        );
        context.lookup(markRef, PDFDict).set(PDFName.of('Popup'), popupRef);
        appendAnnot(pageNumber - 1, markRef);
        appendAnnot(pageNumber - 1, popupRef);
      } else {
        appendAnnot(pageNumber - 1, markRef);
      }
    } catch (error) {
      skip(annotation, 'write_failed', `写入时出错（${errorName(error)}）`);
      continue;
    }
    placed += 1;
    byStyle[style] = (byStyle[style] ?? 0) + 1;
  }

  let bytes: Uint8Array;
  try {
    // 批注里若含 AI 回答/译文（带复制标识），副本一并写入 AI 元数据与页脚图片水印，
    // 与 Markdown 导出口径一致。显式标识是「烧进像素」的图片对象，不是可选中删除的文本。
    // 写入后必须核验元数据与逐页图片都真的存在：写不进就拒绝产出（fail-closed），
    // 绝不生成无标识副本。
    if (hasAiContentInAnnotations(annotations)) {
      await addAiWatermarkToEveryPage(
        pdf,
        options.renderWatermarkStrip ??
          ((kind) => renderWatermarkStrip(kind, { scale: AI_WATERMARK_STRIP_SCALE }))
      );
      markAiMetadata(pdf);
      assertAiMetadataWritten(pdf);
    }
    bytes = await pdf.save({ useObjectStreams: false });
  } catch (error) {
    // 拒绝导出是明确的产品决定：保留原中文文案，不包成“文件级失败”。
    if (isAiExportRefused(error)) throw error;
    throw fileLevelExportError(error);
  }
  return {
    bytes,
    placed,
    unplaced,
    unplacedReasons: reasons,
    byStyle,
    unplacedDetails,
    message: messageOf(placed, unplaced, annotations.length, reasons),
    pagesWithRotation
  };
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}
