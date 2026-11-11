import type React from 'react';
import type { DocumentCategoryCounts } from '@studianda/shared';

/** 文献库分栏：全部 / 著作 / 论文 / 其他（其他含未分类类型）。 */
export type LibraryCategoryFilter = 'all' | 'book' | 'paper' | 'other';

export interface LibraryTypeFilterOption {
  value: string;
  label: string;
  count: number;
}

export interface LibraryFiltersProps {
  category: LibraryCategoryFilter;
  /** 当前范围（已叠加搜索/标签）的分栏数量；「其他」= other + unknown。 */
  counts: DocumentCategoryCounts;
  onCategoryChange(category: LibraryCategoryFilter): void;
  /** 当前类型筛选（Zotero itemType 原值）；空串 = 全部类型。 */
  typeFilter: string;
  /** 当前范围里实际出现的具体类型（含数量），由上层按当前文件夹/搜索算出。 */
  typeOptions: LibraryTypeFilterOption[];
  onTypeFilterChange(value: string): void;
}

const CATEGORY_TABS: Array<{ value: LibraryCategoryFilter; label: string; title: string }> = [
  { value: 'all', label: '全部', title: '当前范围内的全部文献' },
  { value: 'book', label: '著作', title: '图书、图书章节、百科/词典条目等' },
  { value: 'paper', label: '论文', title: '期刊/会议论文、学位论文、报告、预印本等' },
  { value: 'other', label: '其他', title: '网页、手稿、数据集等，以及未分类类型的文献' }
];

function categoryCount(
  counts: DocumentCategoryCounts,
  category: LibraryCategoryFilter
): number {
  switch (category) {
    case 'book':
      return counts.book;
    case 'paper':
      return counts.paper;
    case 'other':
      // 「其他」分栏同时收纳 other 与 unknown（未分类类型），保持 tab 数量与列表一致。
      return counts.other + counts.unknown;
    default:
      return counts.total;
  }
}

/**
 * 文献库的分类/类型筛选条。
 *
 * 只负责渲染与回调，不持有状态、不做过滤：文件夹范围、搜索、标签、排序由上层组合，
 * 这样回收站、文件夹内以及搜索结果可以复用同一套分栏而不互相打架。
 */
export function LibraryFilters({
  category,
  counts,
  onCategoryChange,
  typeFilter,
  typeOptions,
  onTypeFilterChange
}: LibraryFiltersProps): React.JSX.Element {
  return (
    <div className="kr-library-filters" role="group" aria-label="按文献分类筛选">
      <div className="kr-library-filters__tabs" role="tablist" aria-label="文献分栏">
        {CATEGORY_TABS.map((tab) => {
          const active = category === tab.value;
          const count = categoryCount(counts, tab.value);
          return (
            <button
              key={tab.value}
              type="button"
              role="tab"
              aria-selected={active}
              className={active ? 'is-active' : ''}
              title={tab.title}
              onClick={() => onCategoryChange(tab.value)}
            >
              {tab.label}
              <small>{count}</small>
            </button>
          );
        })}
      </div>
      <label className="kr-library-filters__type">
        类型
        <select
          value={typeFilter}
          onChange={(event) => onTypeFilterChange(event.target.value)}
          title="按具体文献类型（Zotero 条目类型）筛选"
        >
          <option value="">全部类型</option>
          {typeOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}（{option.count}）
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
