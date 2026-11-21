/**
 * 阅读页浮层的窗口定位。
 *
 * 阅读区用 transform 缩放整页内容（画布 + 文本层 + 批注框）。这带来两个问题：
 * 1. 页面内 `position: fixed` 的元素会以缩放后的页面框为包含块，弹窗跟着文献一起放大缩小；
 * 2. 选区快捷菜单若按页面 CSS 像素写 left/top，缩放后就会和原文错位。
 *
 * 所以浮层统一挂到应用 portal 根（窗口层），再用页面元素在窗口中的实际矩形
 * （`getBoundingClientRect()` 已经包含 transform 和滚动）把「页面归一化锚点」
 * 换算成窗口坐标。滚动、窗口缩放、阅读区缩放都会触发重新换算；
 * 浮层自身尺寸不参与页面 transform，因此始终保持界面字号。
 */
import { useEffect, useLayoutEffect, useState, type RefObject } from 'react';

export interface RectLike {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

/**
 * 页面内归一化锚点（0–1）→ 窗口坐标。
 *
 * `pageRect` 必须是页面元素当前的 `getBoundingClientRect()`：缩放后它已经变大/变小，
 * 这里不再乘缩放系数，否则会二次缩放。
 */
export function pageAnchorToViewport(
  pageRect: RectLike,
  anchor: Point,
  offset: Point = { x: 0, y: 0 }
): Point {
  return {
    x: pageRect.left + anchor.x * pageRect.width + offset.x,
    y: pageRect.top + anchor.y * pageRect.height + offset.y
  };
}

/**
 * 把 fixed 浮窗夹回视口：宽高用元素实际尺寸量，避免摘引、输入框内容多时下半截出屏。
 * 浮窗比视口还大时优先保证左上角可见（此时可拖动/滚动查看）。
 */
export function clampFixedBox(
  x: number,
  y: number,
  width: number,
  height: number,
  viewport: Size,
  margin = 8
): Point {
  const maxX = Math.max(margin, viewport.width - width - margin);
  const maxY = Math.max(margin, viewport.height - height - margin);
  return {
    x: Math.max(margin, Math.min(x, maxX)),
    y: Math.max(margin, Math.min(y, maxY))
  };
}

/**
 * 页面在窗口中的位置/尺寸变化计数。
 *
 * 只在浮层打开时订阅：阅读页可能同时挂几百页，常驻全局监听会拖慢滚动。
 * 阅读区缩放只改滚动容器上的 `--kr-preview-zoom` 和 class，不会触发 scroll，
 * 所以额外用 MutationObserver 盯这两个属性。
 */
export function useViewportRevision(
  active: boolean,
  container: HTMLElement | null,
  observedElement?: HTMLElement | null
): number {
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!active) return undefined;
    let frame = 0;
    const bump = (): void => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        setRevision((value) => value + 1);
      });
    };
    container?.addEventListener('scroll', bump, { passive: true });
    window.addEventListener('resize', bump);
    let observer: MutationObserver | null = null;
    if (container && typeof MutationObserver !== 'undefined') {
      observer = new MutationObserver(bump);
      observer.observe(container, { attributes: true, attributeFilter: ['style', 'class'] });
    }
    // 阅读区变宽/变窄（窗口缩放、侧栏开合）会改页面布局尺寸，页面矩形随之变化。
    let resizeObserver: ResizeObserver | null = null;
    if (observedElement && typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(bump);
      resizeObserver.observe(observedElement);
    }
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      container?.removeEventListener('scroll', bump);
      window.removeEventListener('resize', bump);
      observer?.disconnect();
      resizeObserver?.disconnect();
    };
  }, [active, container, observedElement]);
  return revision;
}

/**
 * 归一化页面锚点 → 窗口坐标；滚动/缩放/窗口尺寸变化时自动重算。
 * `anchor` 为 null 或 `active` 为 false 时返回 null。
 */
export function useAnchoredViewportPoint(
  active: boolean,
  container: HTMLElement | null,
  pageElement: HTMLElement | null,
  anchor: Point | null,
  offset: Point = { x: 0, y: 0 }
): Point | null {
  const revision = useViewportRevision(active, container, pageElement);
  const [point, setPoint] = useState<Point | null>(null);
  const offsetX = offset.x;
  const offsetY = offset.y;
  useLayoutEffect(() => {
    if (!active || !anchor || !pageElement || !pageElement.isConnected) {
      setPoint(null);
      return;
    }
    const rect = pageElement.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const next = pageAnchorToViewport(rect, anchor, { x: offsetX, y: offsetY });
    setPoint((current) =>
      current && current.x === next.x && current.y === next.y ? current : next
    );
  }, [active, anchor, pageElement, offsetX, offsetY, revision]);
  return point;
}

/**
 * 把窗口坐标浮层夹回视口内；浮层尺寸变化（换行、提示文字变长）和窗口缩放都会重算。
 */
export function useClampedFixedPoint(
  active: boolean,
  desired: Point | null,
  elementRef: RefObject<HTMLElement | null>,
  fallbackSize: Size
): Point | null {
  const [point, setPoint] = useState<Point | null>(null);
  const [revision, setRevision] = useState(0);
  const fallbackWidth = fallbackSize.width;
  const fallbackHeight = fallbackSize.height;
  useLayoutEffect(() => {
    if (!active || !desired) {
      setPoint(null);
      return;
    }
    const width = elementRef.current?.offsetWidth || fallbackWidth;
    const height = elementRef.current?.offsetHeight || fallbackHeight;
    const next = clampFixedBox(desired.x, desired.y, width, height, {
      width: window.innerWidth,
      height: window.innerHeight
    });
    setPoint((current) =>
      current && current.x === next.x && current.y === next.y ? current : next
    );
  }, [active, desired, elementRef, fallbackWidth, fallbackHeight, revision]);

  useEffect(() => {
    if (!active) return undefined;
    let frame = 0;
    const bump = (): void => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        setRevision((value) => value + 1);
      });
    };
    window.addEventListener('resize', bump);
    let observer: ResizeObserver | null = null;
    if (elementRef.current && typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(bump);
      observer.observe(elementRef.current);
    }
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      window.removeEventListener('resize', bump);
      observer?.disconnect();
    };
  }, [active, elementRef]);

  return point;
}
