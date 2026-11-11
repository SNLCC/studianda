/**
 * 译文栏「版式」呈现：页面图像作底图，把每段译文放回原文位置。
 *
 * 数据来自 TranslationPagePayload：`segments[].lineBoxes`（逐行框，归一化 0..1，
 * 左上原点）+ `pageSize` / `bodyFontSize`。这里不改 PDF、也不写库：底图走现有的页图接口，
 * 译文是 HTML 覆盖层。
 *
 * 为什么按**行框**摆放而不是整段框：跨栏段落的整段框是「左栏底部 + 右栏顶部」的大矩形，
 * 会把中间的栏缝、图表一起盖住；按行框逐行遮原文、逐行排译文，才能保持原文版式。
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type React from 'react';
import type { CSSProperties } from 'react';
import type { TranslationSegmentRecord } from '@studianda/shared';

export interface TranslationLayoutViewProps {
  currentPage: number;
  pageSize?: { width: number; height: number } | null;
  segments: TranslationSegmentRecord[];
  /** 原文正文字号（pt）；缺失时回退到 10pt。 */
  bodyFontSize?: number;
  imageUrl: string | null;
  loading: boolean;
  error: string | null;
  highlightQuote?: string | null;
  onHoverSegment(source: string | null): void;
  onLocateSegment(source: string): void;
}

/** 放大倍数（相对「适合宽度」）；'fit' = 适合宽度。 */
type Zoom = 'fit' | number;
const ZOOM_STEPS = [1, 1.25, 1.5, 2, 3] as const;
const MIN_FONT_PX = 4;
const MAX_FONT_PX = 48;
const FALLBACK_BODY_PT = 10;

type Box = [number, number, number, number];

function normalizedText(value: string): string {
  return value.replace(/\s+/g, '').trim();
}

function validBox(box: TranslationSegmentRecord['bbox']): box is Box {
  return (
    Array.isArray(box) &&
    box.length === 4 &&
    box.every((value) => Number.isFinite(value)) &&
    box[2] > box[0] &&
    box[3] > box[1]
  );
}

/**
 * 行框/整段框的绝对定位样式。
 *
 * 向外扩 1–2px：PDF.js 的文本 bbox 高度约等于字号，原字的抗锯齿/上下伸出部分
 * 可能落在框外，恰好会从译文块底边露出一条虚线状的残影，所以遮罩要比 bbox 略大。
 */
function boxStyle(box: Box, expandX = 8, expandY = 3): CSSProperties {
  return {
    left: `calc(${box[0] * 100}% - ${expandX}px)`,
    top: `calc(${box[1] * 100}% - ${expandY}px)`,
    width: `calc(${(box[2] - box[0]) * 100}% + ${expandX * 2}px)`,
    height: `calc(${(box[3] - box[1]) * 100}% + ${expandY * 2}px)`
  };
}

/** 逐行译文的字号：按原文行高的中位值换算，保证同一段每行字号一致。 */
function lineFontPx(boxes: Box[], pageHeight: number, scale: number): number {
  const heights = boxes
    .map((box) => (box[3] - box[1]) * pageHeight * scale)
    .filter((height) => Number.isFinite(height) && height > 0)
    .sort((left, right) => left - right);
  const median = heights[Math.floor(heights.length / 2)] ?? 0;
  return Math.max(6, Math.min(MAX_FONT_PX, median * 0.9));
}

/** 在 canvas 上量宽，避免为了排版测量往 DOM 里塞隐藏节点。 */
function ensureMeasureContext(): CanvasRenderingContext2D | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  return canvas.getContext('2d');
}

/**
 * 把一段译文按原文行框逐行切开：每行放得下多少放多少，放不下的顺延到下一行。
 *
 * 中文按字断行；拉丁字母回退到最近的空格，避免把单词劈开。最后仍有剩余时
 * 追加到最后一行并在末尾标省略号（详细全文仍可在「逐段」里看）。
 */
function splitIntoLines(
  text: string,
  boxes: Box[],
  fontPx: number,
  fontFamily: string,
  pageWidth: number,
  scale: number,
  measure: CanvasRenderingContext2D
): { chunks: string[]; overflow: boolean } {
  measure.font = `${fontPx}px ${fontFamily}`;
  const chunks: string[] = [];
  let rest = text;
  for (const box of boxes) {
    const width = Math.max(8, (box[2] - box[0]) * pageWidth * scale - 4);
    let low = 0;
    let high = rest.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (measure.measureText(rest.slice(0, mid)).width <= width) low = mid;
      else high = mid - 1;
    }
    // 拉丁词不从中间断开：往回退到最近的空格。
    if (low > 0 && low < rest.length) {
      const before = rest[low - 1]!;
      const after = rest[low]!;
      if (/[A-Za-z0-9]/.test(before) && /[A-Za-z0-9]/.test(after)) {
        const space = rest.lastIndexOf(' ', low);
        if (space > 0) low = space;
      }
    }
    chunks.push(rest.slice(0, low));
    rest = rest.slice(low).replace(/^\s+/, '');
    if (!rest) break;
  }
  if (rest) {
    const last = chunks.length - 1;
    chunks[last] = `${chunks[last] ?? ''}${rest}`;
    return { chunks, overflow: true };
  }
  while (chunks.length < boxes.length) chunks.push('');
  return { chunks, overflow: false };
}

interface LineLayout {
  mode: 'lines';
  segment: TranslationSegmentRecord;
  boxes: Box[];
  fontPx: number;
  chunks: string[];
  overflow: boolean;
}

interface BlockLayout {
  mode: 'block';
  segment: TranslationSegmentRecord;
  box: Box;
}

type SegmentLayout = LineLayout | BlockLayout;

export function TranslationLayoutView({
  currentPage,
  pageSize,
  segments,
  bodyFontSize,
  imageUrl,
  loading,
  error,
  highlightQuote,
  onHoverSegment,
  onLocateSegment
}: TranslationLayoutViewProps): React.JSX.Element {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const pageRef = useRef<HTMLDivElement | null>(null);
  const highlightRef = useRef<HTMLDivElement | null>(null);
  const measureRef = useRef<CanvasRenderingContext2D | null>(null);
  const [viewportWidth, setViewportWidth] = useState(0);
  const [zoom, setZoom] = useState<Zoom>('fit');
  const [clippedBlocks, setClippedBlocks] = useState(0);
  const [fontFamily, setFontFamily] = useState('"Studianda Serif"');

  // 译文栏可以拖动调宽：跟随宽度变化重新算「适合宽度」的比例。
  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const update = (): void => setViewportWidth(element.clientWidth);
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // 量宽要和应用字体一致：从页图容器继承来的 computed font-family 取一次。
  useEffect(() => {
    const element = pageRef.current;
    if (!element) return;
    const family = window.getComputedStyle(element).fontFamily;
    if (family) setFontFamily(family);
  }, [imageUrl, currentPage]);

  const pageWidth = pageSize?.width && pageSize.width > 0 ? pageSize.width : 0;
  const pageHeight = pageSize?.height && pageSize.height > 0 ? pageSize.height : 0;
  const fitScale = pageWidth > 0 && viewportWidth > 0 ? viewportWidth / pageWidth : 0;
  const scale = fitScale > 0 ? fitScale * (zoom === 'fit' ? 1 : zoom) : 0;
  const displayWidth = pageWidth > 0 ? pageWidth * scale : 0;
  const displayHeight = pageHeight > 0 ? pageHeight * scale : 0;

  const withText = segments.filter((segment) => Boolean(segment.text?.trim()));
  const missing = segments.filter((segment) => !segment.text?.trim());

  // 逐行排版需要量宽：只在版面/缩放变化时重算，不随鼠标事件重排。
  const layouts = useMemo<SegmentLayout[]>(() => {
    if (scale <= 0 || pageWidth <= 0 || pageHeight <= 0) return [];
    const measure =
      measureRef.current ?? (measureRef.current = ensureMeasureContext());
    const result: SegmentLayout[] = [];
    for (const segment of withText) {
      const lineBoxes = (segment.lineBoxes ?? []).filter(validBox);
      if (lineBoxes.length > 0) {
        const fontPx = lineFontPx(lineBoxes, pageHeight, scale);
        const split = measure
          ? splitIntoLines(
              segment.text!.trim(),
              lineBoxes,
              fontPx,
              fontFamily,
              pageWidth,
              scale,
              measure
            )
          : { chunks: [segment.text!.trim()], overflow: false };
        result.push({
          mode: 'lines',
          segment,
          boxes: lineBoxes,
          fontPx,
          chunks: split.chunks,
          overflow: split.overflow
        });
        continue;
      }
      const fallbackBox = segment.bbox;
      if (validBox(fallbackBox)) {
        result.push({ mode: 'block', segment, box: fallbackBox });
      }
    }
    // withText 是每次渲染新建的数组，但 layouts 只应在版面/分段变化时重算；
    // segments 变化（翻译完成/翻页）会触发重算，量宽结果本身是纯函数。
    return result;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segments, scale, pageWidth, pageHeight, fontFamily]);

  const placedSegments = new Set(
    layouts.map((layout) => layout.segment.segment)
  );
  const unplaced = withText.filter((segment) => !placedSegments.has(segment.segment));
  const clipped =
    clippedBlocks + layouts.filter((layout) => layout.mode === 'lines' && layout.overflow).length;

  const normalizedQuote = normalizedText(highlightQuote ?? '');
  const isHighlighted = (segment: TranslationSegmentRecord): boolean => {
    if (normalizedQuote.length < 4) return false;
    const source = normalizedText(segment.source);
    return (
      source.length > 0 &&
      (source.includes(normalizedQuote) || normalizedQuote.includes(source))
    );
  };

  // 降级（没有逐行框、只有整段框）时，仍按整段框缩字号塞进去。
  useLayoutEffect(() => {
    const pageElement = pageRef.current;
    if (!pageElement || scale <= 0) {
      setClippedBlocks(0);
      return;
    }
    const base = Math.max(
      5,
      Math.min(
        MAX_FONT_PX,
        (bodyFontSize && bodyFontSize > 0 ? bodyFontSize : FALLBACK_BODY_PT) * scale
      )
    );
    let count = 0;
    const blocks = pageElement.querySelectorAll<HTMLElement>('[data-translation-block]');
    blocks.forEach((block) => {
      let size = base;
      block.classList.remove('is-clipped');
      block.style.fontSize = `${size}px`;
      let guard = 0;
      while (
        size > MIN_FONT_PX &&
        block.scrollHeight > block.clientHeight + 1 &&
        guard < 60
      ) {
        size = Math.max(MIN_FONT_PX, size - 0.5);
        block.style.fontSize = `${size}px`;
        guard += 1;
      }
      if (block.scrollHeight > block.clientHeight + 1) {
        block.classList.add('is-clipped');
        count += 1;
      }
    });
    setClippedBlocks(count);
  }, [layouts, scale, bodyFontSize, imageUrl]);

  useEffect(() => {
    if (!normalizedQuote) return;
    highlightRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [normalizedQuote, currentPage, imageUrl, zoom]);

  const stepZoom = (direction: 1 | -1): void => {
    const current = zoom === 'fit' ? 1 : zoom;
    const index = ZOOM_STEPS.findIndex((value) => Math.abs(value - current) < 0.001);
    const start = index < 0 ? 0 : index;
    const next = ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, Math.max(0, start + direction))];
    if (next !== undefined) setZoom(next);
  };

  const segmentHandlers = (segment: TranslationSegmentRecord) => ({
    title: `原文：${segment.source.slice(0, 300)}`,
    onMouseEnter: () => onHoverSegment(segment.source),
    onMouseLeave: () => onHoverSegment(null),
    onClick: () => onLocateSegment(segment.source)
  });

  return (
    <section className="kr-tl" aria-label={`第 ${currentPage} 页版式译文`}>
      <div className="kr-tl__toolbar">
        <span className="kr-tl__mode">版式</span>
        <button
          type="button"
          className={zoom === 'fit' ? 'is-active' : ''}
          aria-pressed={zoom === 'fit'}
          title="按译文栏宽度显示整页"
          onClick={() => setZoom('fit')}
        >
          适合宽度
        </button>
        <span className="kr-tl__zoom" aria-live="polite">
          {zoom === 'fit' ? '—' : `×${zoom}`}
        </span>
        <button
          type="button"
          aria-label="缩小"
          title="缩小"
          disabled={zoom === 'fit' || (typeof zoom === 'number' && zoom <= ZOOM_STEPS[0])}
          onClick={() => stepZoom(-1)}
        >
          −
        </button>
        <button
          type="button"
          aria-label="放大"
          title="放大（超过译文栏宽度时横向滚动）"
          disabled={typeof zoom === 'number' && zoom >= ZOOM_STEPS[ZOOM_STEPS.length - 1]!}
          onClick={() => stepZoom(1)}
        >
          ＋
        </button>
      </div>
      <div className="kr-tl__viewport" ref={viewportRef}>
        {loading ? <p className="kr-muted kr-tl__status">正在渲染页面图像…</p> : null}
        {error ? <p className="kr-page-error">{error}</p> : null}
        {!loading && !error && !imageUrl ? (
          <p className="kr-muted kr-tl__status">页面图像不可用。</p>
        ) : null}
        {imageUrl && (pageWidth <= 0 || pageHeight <= 0) ? (
          <p className="kr-muted kr-tl__status">
            本页还没有版面数据：先识别或翻译本页一次，再切回「版式」。
          </p>
        ) : null}
        {imageUrl && pageWidth > 0 && pageHeight > 0 && displayWidth > 0 ? (
          <div
            className="kr-tl__page"
            ref={pageRef}
            style={{
              width: `${displayWidth}px`,
              height: `${displayHeight}px`
            }}
          >
            <img src={imageUrl} alt={`第 ${currentPage} 页页面图像`} draggable={false} />
            {/* 遮罩层：先把原文每一行的行框盖成纸色，再画译文。
                遮罩可以比行框略大（盖住抗锯齿/伸出的笔画），因为译文在遮罩之后渲染，不会被盖住。 */}
            {layouts.map((layout) => {
              if (layout.mode === 'lines') {
                return layout.boxes.map((box, lineIndex) => (
                  <div
                    key={`translation-mask-${layout.segment.segment}-${lineIndex}`}
                    className="kr-tl__mask"
                    style={boxStyle(box, 10, 6)}
                  />
                ));
              }
              return (
                <div
                  key={`translation-mask-${layout.segment.segment}`}
                  className="kr-tl__mask"
                  style={boxStyle(layout.box, 8, 5)}
                />
              );
            })}
            {/* 译文层：逐行填回原文行框（行内已按框宽测量切好，不折行）。 */}
            {layouts.map((layout) => {
              const highlighted = isHighlighted(layout.segment);
              if (layout.mode === 'lines') {
                return layout.boxes.map((box, lineIndex) => (
                  <div
                    key={`translation-line-${layout.segment.segment}-${lineIndex}`}
                    data-translation-line
                    ref={highlighted && lineIndex === 0 ? highlightRef : undefined}
                    className={`kr-tl__line${highlighted ? ' is-highlighted' : ''}${
                      layout.overflow && lineIndex === layout.boxes.length - 1
                        ? ' is-clipped'
                        : ''
                    }`}
                    style={{ ...boxStyle(box, 0, 0), fontSize: `${layout.fontPx}px` }}
                    {...segmentHandlers(layout.segment)}
                  >
                    {layout.chunks[lineIndex] ?? ''}
                  </div>
                ));
              }
              return (
                <div
                  key={`translation-block-${layout.segment.segment}`}
                  data-translation-block
                  ref={highlighted ? highlightRef : undefined}
                  className={`kr-tl__block${highlighted ? ' is-highlighted' : ''}`}
                  style={boxStyle(layout.box, 0, 0)}
                  {...segmentHandlers(layout.segment)}
                >
                  {layout.segment.text}
                </div>
              );
            })}
          </div>
        ) : null}
      </div>
      <div className="kr-tl__notes">
        {clipped > 0 ? (
          <p className="kr-muted">
            有 {clipped} 段在原文行框里放不下，末尾已截断；需要完整译文请切到「逐段」。
          </p>
        ) : null}
        {missing.length > 0 ? (
          <p className="kr-muted">
            本页还有 {missing.length} 段没有译文（页眉/页脚/注释等按规则跳过）。
          </p>
        ) : null}
        {unplaced.length > 0 ? (
          <details className="kr-tl__unplaced">
            <summary>没有版面位置的段落（{unplaced.length}）</summary>
            <ul>
              {unplaced.map((segment) => (
                <li key={`unplaced-${segment.segment}`}>{segment.text}</li>
              ))}
            </ul>
          </details>
        ) : null}
        <p className="kr-muted kr-tl__hint">
          点击译文可跳回原文；表格、公式与图片保持原样。切到版式会自动加宽译文栏，可拖动分隔条调整，
          关掉右侧「阅读伙伴」能让阅读区更宽。
        </p>
      </div>
    </section>
  );
}
