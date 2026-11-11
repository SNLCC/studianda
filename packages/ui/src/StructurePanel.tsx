import { useMemo, useState, type JSX } from 'react';
import { createPortal } from 'react-dom';
import type { ContentBlockKind, DocumentBlocks } from '@studianda/shared';
import { getAppPortalRoot } from './portal-root.js';

/**
 * 结构 / 内容块浏览器（阅读器弹层）。
 *
 * 数据来自 `GET /documents/:id/blocks`：章节树 + 按阅读顺序切好的内容块。
 * 用途是"看清这篇文献由哪些章节/段落/图表/公式/脚注/参考文献组成"，
 * 点任意条目跳到对应页；不修改原文、不写回任何数据。
 */

const KIND_LABELS: Record<ContentBlockKind, string> = {
  heading: '标题',
  paragraph: '正文',
  list: '列表',
  caption: '题注',
  table: '表格',
  formula: '公式',
  footnote: '脚注',
  reference: '参考文献'
};

const SECTION_KIND_LABELS: Record<string, string> = {
  front: '前置',
  body: '正文',
  abstract: '摘要',
  references: '参考文献',
  appendix: '附录'
};

const KIND_FILTERS: Array<{ value: ContentBlockKind | 'all'; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'heading', label: '标题' },
  { value: 'paragraph', label: '正文' },
  { value: 'list', label: '列表' },
  { value: 'caption', label: '题注' },
  { value: 'table', label: '表格' },
  { value: 'formula', label: '公式' },
  { value: 'footnote', label: '脚注' },
  { value: 'reference', label: '参考文献' }
];

export interface StructurePanelProps {
  data?: DocumentBlocks | null;
  loading?: boolean;
  error?: string | null;
  currentPage: number;
  onOpenPage(page: number): void;
  onClose(): void;
}

export function StructurePanel({
  data,
  loading = false,
  error = null,
  currentPage,
  onOpenPage,
  onClose
}: StructurePanelProps): JSX.Element {
  const [tab, setTab] = useState<'sections' | 'blocks'>('sections');
  const [kind, setKind] = useState<ContentBlockKind | 'all'>('all');
  const [query, setQuery] = useState('');

  const blocks = useMemo(() => {
    if (!data) return [];
    const keyword = query.trim().toLowerCase();
    return data.blocks.filter(
      (block) =>
        (kind === 'all' || block.kind === kind) &&
        (keyword === '' || block.text.toLowerCase().includes(keyword))
    );
  }, [data, kind, query]);

  const sectionTitle = (index: number): string => {
    const section = data?.sections.find((item) => item.index === index);
    if (!section) return '';
    return section.title || '（前置部分）';
  };
  const currentSectionIndex =
    data?.sections.find(
      (section) => currentPage >= section.pageStart && currentPage <= section.pageEnd
    )?.index ?? -1;

  return createPortal(
    <div className="kr-root">
      <div
        className="kr-structure-overlay"
        role="dialog"
        aria-modal="true"
        aria-label="结构与内容块"
        onClick={(event) => {
          if (event.target === event.currentTarget) onClose();
        }}
      >
        <div className="kr-structure" onClick={(event) => event.stopPropagation()}>
          <header className="kr-structure__head">
            <div>
              <h2>结构与内容块</h2>
              <p>
                {data
                  ? `${data.stats.sections} 个章节 · ${data.stats.blocks} 个内容块 · ${data.stats.pages} 页`
                  : '正在读取版面结构…'}
              </p>
            </div>
            <button type="button" className="kr-secondary" onClick={onClose}>
              关闭
            </button>
          </header>

          <div className="kr-structure__tabs" role="tablist" aria-label="结构与内容块视图">
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'sections'}
              className={tab === 'sections' ? 'is-active' : ''}
              onClick={() => setTab('sections')}
            >
              章节
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'blocks'}
              className={tab === 'blocks' ? 'is-active' : ''}
              onClick={() => setTab('blocks')}
            >
              内容块
            </button>
          </div>

          {error ? (
            <p className="kr-page-error" role="alert">
              {error}
            </p>
          ) : null}
          {loading && !data ? <p className="kr-structure__hint">正在读取版面结构…</p> : null}

          <div className="kr-structure__body">
            {tab === 'sections' ? (
              data && data.sections.length > 0 ? (
                <ul className="kr-structure__sections">
                  {data.sections.map((section) => (
                    <li key={section.index}>
                      <button
                        type="button"
                        className={section.index === currentSectionIndex ? 'is-current' : ''}
                        onClick={() => onOpenPage(section.pageStart)}
                        title={`跳到第 ${section.pageStart} 页`}
                      >
                        <span className="kr-structure__section-title">
                          {section.title || '（前置部分）'}
                        </span>
                        <span className="kr-structure__section-meta">
                          {SECTION_KIND_LABELS[section.kind] ?? section.kind} · 第{' '}
                          {section.pageStart}
                          {section.pageEnd > section.pageStart ? `–${section.pageEnd}` : ''} 页
                          {section.blockStart <= section.blockEnd
                            ? ` · ${section.blockEnd - section.blockStart + 1} 块`
                            : ''}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="kr-structure__hint">
                  没有识别到章节（PDF 无书签且标题规则未命中）；可以切到「内容块」查看段落。
                </p>
              )
            ) : (
              <>
                <div className="kr-structure__filters">
                  <div className="kr-structure__kinds" role="group" aria-label="内容块类型">
                    {KIND_FILTERS.map((item) => (
                      <button
                        key={item.value}
                        type="button"
                        className={kind === item.value ? 'is-active' : ''}
                        onClick={() => setKind(item.value)}
                      >
                        {item.label}
                      </button>
                    ))}
                  </div>
                  <input
                    type="search"
                    value={query}
                    placeholder="筛选块文字…"
                    aria-label="筛选内容块文字"
                    onChange={(event) => setQuery(event.target.value)}
                  />
                </div>
                {blocks.length === 0 ? (
                  <p className="kr-structure__hint">
                    {data ? '没有符合条件的内容块。' : '正在读取版面结构…'}
                  </p>
                ) : (
                  <ol className="kr-structure__blocks">
                    {blocks.slice(0, 500).map((block) => (
                      <li key={block.id}>
                        <button
                          type="button"
                          className={block.page === currentPage ? 'is-current' : ''}
                          onClick={() => onOpenPage(block.page)}
                          title={`跳到第 ${block.page} 页`}
                        >
                          <span className={`kr-structure__kind is-${block.kind}`}>
                            {KIND_LABELS[block.kind] ?? block.kind}
                          </span>
                          <span className="kr-structure__block-text">
                            {block.text || '（空块）'}
                          </span>
                          <span className="kr-structure__block-meta">
                            第 {block.page} 页
                            {block.section >= 0
                              ? ` · ${sectionTitle(block.section)}`
                              : ''}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ol>
                )}
                {blocks.length > 500 ? (
                  <p className="kr-structure__hint">
                    仅显示前 500 个内容块；用类型/文字筛选可继续缩小范围。
                  </p>
                ) : null}
              </>
            )}
          </div>
        </div>
      </div>
    </div>,
    getAppPortalRoot()
  );
}
