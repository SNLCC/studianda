import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { orderPageLines } from './structure.js';

export interface LayoutLine {
  text: string;
  /** 归一化页面坐标 0..1，左上原点。 */
  bbox: [number, number, number, number];
  /** PDF 文本项高度（pt），用于翻译版面字号估计。 */
  size?: number;
  /**
   * 同一行内最大的空白项宽度（归一化页面宽度 0..1）。
   *
   * 普通词间距只有 0.3%–1%；表格单元格之间的空白通常 ≥3%，
   * 翻译组段时用它把表格行和正文行区分开，避免把表格内容拼进段落。
   */
  gap?: number;
}

export interface LayoutPage {
  page: number;
  width: number;
  height: number;
  lines: LayoutLine[];
}

export interface OutlineEntry {
  title: string;
  page: number;
  level: number;
  origin: string;
}

export interface PdfLayout {
  pages: LayoutPage[];
  author: string;
  outline: OutlineEntry[];
}

/** 拿不到 item 字号时的兜底字号（pt），只用于算行合并阈值。 */
const MIN_LINE_SIZE = 6;
/** 同一行的基线容差下限（pt）：上标/不同字体混排的垂直偏移通常 2–4pt。 */
const MIN_BASELINE_TOLERANCE = 2;
/** 同一行的基线容差（主字号比例）：0.5×字号 ≈ 上标最大抬高量。 */
const BASELINE_TOLERANCE_RATIO = 0.5;
/** 同一行的水平间距下限（pt）。 */
const MIN_LINE_GAP = 2;
/**
 * 同一行的水平间距阈值（主字号比例）。
 *
 * 普通词间距只有 0.1–0.3em，中文/两端对齐 PDF 偶尔到 0.5em；表格列间距、
 * 双栏栏沟通常 ≥1em，用它把「同一行」和「跳到下一栏/下一行」分开。
 */
const LINE_GAP_RATIO = 0.9;

/**
 * 页面行阅读顺序（保留旧导出签名）。
 *
 * 统一实现在 `structure.orderPageLines`：双栏时左栏整栏在前、右栏在后，
 * 跨栏行作为分割点；单栏/无法判定时按 y,x 稳定排序。
 * `LayoutLine.bbox` 是**归一化**坐标（0..1），因此这里固定按 pageWidth=1 判断栏宽；
 * `pageWidth` 参数只为兼容既有调用/测试保留，不再参与阈值计算。
 */
export function orderTwoColumnLines(
  lines: LayoutLine[],
  pageWidth: number
): LayoutLine[] {
  void pageWidth;
  return orderPageLines(lines, 1);
}

export async function extractPdfLayout(
  bytes: Uint8Array,
  onProgress?: (done: number, total: number) => void
): Promise<PdfLayout> {
  const loadingTask = getDocument({
    data: new Uint8Array(bytes),
    disableFontFace: true,
    useSystemFonts: true
  });
  const pdf = await loadingTask.promise;
  let author = '';
  try {
    const metadata = await pdf.getMetadata();
    const info = metadata.info as { Author?: unknown } | undefined;
    if (info && typeof info.Author === 'string') author = info.Author.trim().slice(0, 200);
  } catch {
    author = '';
  }

  const pages: LayoutPage[] = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const lines: LayoutLine[] = [];
    let current:
      | {
          text: string;
          x0: number;
          y0: number;
          x1: number;
          y1: number;
          baseline: number;
          size: number;
          gap: number;
          ended: boolean;
        }
      | null = null;

    const pushCurrent = (): void => {
      if (!current) return;
      const text = current.text.replace(/\s+/g, ' ').trim();
      if (text) {
        // 用 viewport.convertToViewportPoint 换算（旋转 90/180/270 页的坐标轴会互换），
        // 手写 `height - y` 会把旋转页 bbox 落到页外；与 store.parsePdf 保持同一口径。
        const corners = [
          viewport.convertToViewportPoint(current.x0, current.y0),
          viewport.convertToViewportPoint(current.x1, current.y1)
        ];
        const width = viewport.width || 1;
        const height = viewport.height || 1;
        lines.push({
          text,
          bbox: [
            Math.min(corners[0]![0], corners[1]![0]) / width,
            Math.min(corners[0]![1], corners[1]![1]) / height,
            Math.max(corners[0]![0], corners[1]![0]) / width,
            Math.max(corners[0]![1], corners[1]![1]) / height
          ],
          size: current.size,
          ...(current.gap > 0 ? { gap: current.gap } : {})
        });
      }
      current = null;
    };

    for (const item of content.items) {
      if (!('str' in item) || !item.str) continue;
      const [, , , , x, y] = item.transform as [number, number, number, number, number, number];
      const width = item.width ?? 0;
      const height = item.height ?? 0;
      // 纯空白项只用来记录行内列间距（表格列），不应单独起行：
      // 中文/表格 PDF 常把空白做成独立 item，且它的 transform 可能带偏移。
      if (!item.str.trim()) {
        if (current) {
          current.text += ' ';
          current.gap = Math.max(current.gap, width / (viewport.width || 1));
          current.x1 = Math.max(current.x1, x + width);
          current.ended = current.ended || Boolean(item.hasEOL);
        }
        continue;
      }
      // 阈值按字号比例（pt）：写死的 2pt/20pt 会把上标脚注编号（基线略高、字号小）
      // 和中文词间距（普遍比西文大）拆成独立行，句子断裂后还会被误判成标题。
      // 主字号取当前行与当前 item 的较大者，避免把上标自身的字号当基准。
      const referenceSize = Math.max(current?.size ?? 0, height, MIN_LINE_SIZE);
      const baselineTolerance = Math.max(
        MIN_BASELINE_TOLERANCE,
        referenceSize * BASELINE_TOLERANCE_RATIO
      );
      const gapTolerance = Math.max(MIN_LINE_GAP, referenceSize * LINE_GAP_RATIO);
      const startsNewLine =
        current == null ||
        current.ended ||
        Math.abs(current.baseline - y) > baselineTolerance ||
        x - current.x1 > gapTolerance;
      if (startsNewLine) {
        pushCurrent();
        current = { text: '', x0: x, y0: y, x1: x + width, y1: y + height, baseline: y, size: height, gap: 0, ended: false };
      }
      const line = current as NonNullable<typeof current>;
      line.text += item.str;
      line.x0 = Math.min(line.x0, x);
      line.y0 = Math.min(line.y0, y);
      line.x1 = Math.max(line.x1, x + width);
      line.y1 = Math.max(line.y1, y + height);
      line.size = Math.max(line.size, height);
      line.ended = Boolean(item.hasEOL);
    }
    pushCurrent();
    pages.push({
      page: pageNumber,
      width: viewport.width,
      height: viewport.height,
      lines: orderTwoColumnLines(lines, viewport.width)
    });
    onProgress?.(pageNumber, pdf.numPages);
  }

  const outline: OutlineEntry[] = [];
  try {
    const raw = await pdf.getOutline();
    const walk = async (items: unknown[], level: number): Promise<void> => {
      for (const value of items) {
        if (!value || typeof value !== 'object') continue;
        const item = value as { title?: unknown; dest?: unknown; items?: unknown[] };
        if (Array.isArray(item.items)) await walk(item.items, level + 1);
        if (typeof item.title !== 'string' || item.dest == null) continue;
        try {
          const dest =
            typeof item.dest === 'string' ? await pdf.getDestination(item.dest) : item.dest;
          if (!Array.isArray(dest) || dest.length === 0) continue;
          const index = await pdf.getPageIndex(dest[0] as Parameters<typeof pdf.getPageIndex>[0]);
          outline.push({ title: item.title, page: index + 1, level, origin: 'PDF 目录' });
        } catch {
          // 无法解析的目录项跳过，不影响页面文本
        }
      }
    };
    await walk((raw ?? []) as unknown[], 1);
    outline.sort((left, right) => left.page - right.page);
  } catch {
    // 没有目录
  }

  await loadingTask.destroy();
  return { pages, author, outline };
}

export interface PageSpan {
  text: string;
  /** 归一化页面坐标 0..1，左上原点。 */
  bbox: [number, number, number, number];
  size?: number;
}

/**
 * 单页文本片段：
 * 返回比"合并后的行"更细的文本项及其归一化 bbox，以及 viewport 的旋转矩阵。
 *
 * 注意：PDF.js 不暴露逐字符框，这里给的是**文本项粒度**（通常词/片段）；
 * 需要真正逐字符框的场景（如逐字选区）仍需 OCR 行框。
 */
export async function extractPageSpans(
  bytes: Uint8Array,
  pageNumber: number
): Promise<{
  width: number;
  height: number;
  spans: PageSpan[];
  rotationMatrix: number[];
}> {
  const loadingTask = getDocument({
    data: bytes,
    disableFontFace: true,
    useSystemFonts: true
  });
  const pdf = await loadingTask.promise;
  try {
    if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > pdf.numPages) {
      throw new Error('页码超出范围');
    }
    const page = await pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });
    const width = viewport.width || 1;
    const height = viewport.height || 1;
    const content = await page.getTextContent();
    const spans: PageSpan[] = [];
    for (const item of content.items) {
      if (!('str' in item) || !item.str.trim()) continue;
      const transform = item.transform as [number, number, number, number, number, number];
      const x = transform[4];
      const y = transform[5];
      const itemWidth = item.width ?? 0;
      const itemHeight = item.height ?? 0;
      const corners = [
        viewport.convertToViewportPoint(x, y),
        viewport.convertToViewportPoint(x + itemWidth, y + itemHeight)
      ];
      spans.push({
        text: item.str,
        bbox: [
          Math.min(corners[0]![0], corners[1]![0]) / width,
          Math.min(corners[0]![1], corners[1]![1]) / height,
          Math.max(corners[0]![0], corners[1]![0]) / width,
          Math.max(corners[0]![1], corners[1]![1]) / height
        ],
        size: itemHeight
      });
    }
    return {
      width,
      height,
      spans,
      rotationMatrix: [...(viewport.transform as unknown as number[])]
    };
  } finally {
    await loadingTask.destroy();
  }
}
