/**
 * 阅读器工具栏 / 文献信息图标（原创绘制，不引用任何第三方图标库）。
 *
 * 规范：16×16 viewBox、描边 1.3、`currentColor`、圆角端点，与 DocumentList 里既有的图标风格一致。
 * 每个图形都按"这一操作在做什么"重新构思，没有复制 Lucide / Bootstrap Icons / Font Awesome 等图库的路径数据，
 * 因此不携带任何第三方图标许可证义务（见 legal/THIRD-PARTY.md）。
 */
import type { JSX } from 'react';

const base = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.3,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const
};

/** 返回：向左的折角。 */
export function IconBack(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M9.6 3.4 5 8l4.6 4.6" {...base} />
    </svg>
  );
}

/** 导航：左侧圆点 + 右侧三条目录项。 */
export function IconNav(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M5.6 4.6h7.2M5.6 8h7.2M5.6 11.4h7.2" {...base} />
      <circle cx="3.1" cy="4.6" r="0.9" fill="currentColor" />
      <circle cx="3.1" cy="8" r="0.9" fill="currentColor" />
      <circle cx="3.1" cy="11.4" r="0.9" fill="currentColor" />
    </svg>
  );
}

/** 结构：三层错位的内容块。 */
export function IconBlocks(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <rect x="2.4" y="2.6" width="11.2" height="3.2" rx="1" {...base} />
      <rect x="3.8" y="6.6" width="9.8" height="3.2" rx="1" {...base} />
      <rect x="5.2" y="10.6" width="8.4" height="2.8" rx="1" {...base} />
    </svg>
  );
}

/** 翻译：两个错位的对话气泡（原语言 → 目标语言）。 */export function IconTranslate(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M2.6 4.2h6.4v4.3H6l-1.9 1.5v-1.5H4.2a1.6 1.6 0 0 1-1.6-1.6V4.2Z" {...base} />
      <path d="M7.4 7.9h6v4.2h-1.5v1.3l-1.7-1.3H7.4V7.9Z" {...base} />
    </svg>
  );
}

/** 适合宽度：左右两条页边 + 双向箭头。 */
export function IconFitWidth(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3 4.2v7.6M13 4.2v7.6" {...base} />
      <path d="M5.4 8h5.2" {...base} />
      <path d="M6.7 6.5 5.2 8l1.5 1.5M9.3 6.5 10.8 8l-1.5 1.5" {...base} />
    </svg>
  );
}

/** 区域框选：四角框线 + 中间十字。 */
export function IconRegion(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M2.8 5.6V4.2a1.4 1.4 0 0 1 1.4-1.4h1.4M10.4 2.8h1.4a1.4 1.4 0 0 1 1.4 1.4v1.4M13.2 10.4v1.4a1.4 1.4 0 0 1-1.4 1.4h-1.4M5.6 13.2H4.2a1.4 1.4 0 0 1-1.4-1.4v-1.4" {...base} />
      <path d="M8 6.2v3.6M6.2 8h3.6" {...base} />
    </svg>
  );
}

/** 屏蔽区域：虚线框 + 一条斜杠。 */
export function IconMask(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3.4 3.4h9.2v9.2H3.4z" {...base} strokeDasharray="2.2 1.8" />
      <path d="M5.2 10.8 10.8 5.2" {...base} />
    </svg>
  );
}

/** 识别区域：取景框 + 两行文字。 */
export function IconOcr(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M2.8 6V4.4a1.6 1.6 0 0 1 1.6-1.6H6M10 2.8h1.6a1.6 1.6 0 0 1 1.6 1.6V6M13.2 10v1.6a1.6 1.6 0 0 1-1.6 1.6H10M6 13.2H4.4a1.6 1.6 0 0 1-1.6-1.6V10" {...base} />
      <path d="M5.4 6.9h5.2M5.4 9.5h3.4" {...base} />
    </svg>
  );
}

/** 导出：方框 + 向外箭头。 */
export function IconExport(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M6.4 3.4H4.2a1.6 1.6 0 0 0-1.6 1.6v6.8a1.6 1.6 0 0 0 1.6 1.6h6.8a1.6 1.6 0 0 0 1.6-1.6V9.6" {...base} />
      <path d="M9.2 3.2h3.6v3.6M12.8 3.2 8.4 7.6" {...base} />
    </svg>
  );
}

/** 阅读伙伴：摊开的双页书。 */
export function IconCompanion(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 4.6C6.7 3.6 5 3.2 3 3.4v8c2-.2 3.7.2 5 1.2 1.3-1 3-1.4 5-1.2v-8c-2-.2-3.7.2-5 1.2Z" {...base} />
      <path d="M8 4.6v8" {...base} />
    </svg>
  );
}

/** 文献信息：带穿孔的标签（编辑标题/作者/标签/分类与文件夹）。 */
export function IconTag(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3 2.9h4.6l5.5 5.5-4.6 4.6L3 7.5V2.9Z" {...base} />
      <circle cx="5.4" cy="5.3" r="0.85" fill="currentColor" />
    </svg>
  );
}
