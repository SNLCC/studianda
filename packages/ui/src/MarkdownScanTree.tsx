import { useEffect, useMemo, useRef, useState } from 'react';
import type React from 'react';
import type { MarkdownScanTreePage, MarkdownTreeEntry } from '@studianda/shared';
import {
  computeVirtualWindow,
  fileChecked,
  flattenMarkdownTree,
  folderCheckState,
  isScanTreeUnavailableError,
  type MarkdownLazyRow,
  type MarkdownSelectionState
} from './markdown-virtual.js';

const PAGE_SIZE = 200;
const ROW_HEIGHT = 26;
const VIEWPORT_HEIGHT = 340;

export interface MarkdownScanTreeProps {
  vaultPath: string;
  getPage(parent: string, offset: number, limit: number): Promise<MarkdownScanTreePage>;
  selection: MarkdownSelectionState;
  keyword: string;
  onToggleFile(path: string): void;
  onToggleFolder(path: string): void;
  /** 已加载条目数/总数（用于“加载更多后搜索”提示）。 */
  onLoadedChange?(loaded: number, total: number): void;
  /** 扫描结果不可用（409）时的关闭/重新扫描入口。 */
  onClose?(): void;
  onRescan?(): void;
}

interface FolderPage {
  entries: MarkdownTreeEntry[];
  total: number;
  loading: boolean;
  error: string;
}

/** 首次加载根目录第一页；展开文件夹时按需加载并缓存。 */
async function loadPage(
  vaultPath: string,
  parent: string,
  offset: number,
  getPage: MarkdownScanTreeProps['getPage']
): Promise<MarkdownScanTreePage> {
  return getPage(parent, offset, PAGE_SIZE);
}

/**
 * 懒加载 + 固定行高虚拟列表的 Markdown 扫描树。
 * 仅渲染视口内行；展开/勾选/折叠/本地搜索均基于已加载内容。
 */
export function MarkdownScanTree({
  vaultPath,
  getPage,
  selection,
  keyword,
  onToggleFile,
  onToggleFolder,
  onLoadedChange,
  onClose,
  onRescan
}: MarkdownScanTreeProps): React.JSX.Element {
  const [root, setRoot] = useState<FolderPage>({
    entries: [],
    total: 0,
    loading: true,
    error: ''
  });
  const [unavailable, setUnavailable] = useState(false);
  const [pages, setPages] = useState<Map<string, FolderPage>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [scrollTop, setScrollTop] = useState(0);
  const [hint, setHint] = useState('');
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // 回调放进 ref：父组件每次 render 传入新的内联函数时不会重新加载整棵树（否则会无限重载）。
  const getPageRef = useRef(getPage);
  getPageRef.current = getPage;
  const onLoadedChangeRef = useRef(onLoadedChange);
  onLoadedChangeRef.current = onLoadedChange;
  const lastLoadedRef = useRef<{ loaded: number; total: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setRoot({ entries: [], total: 0, loading: true, error: '' });
    loadPage(vaultPath, '', 0, (...args) => getPageRef.current(...args))
      .then((page) => {
        if (cancelled) return;
        setUnavailable(false);
        setRoot({ entries: page.entries, total: page.total, loading: false, error: '' });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        if (isScanTreeUnavailableError(error)) {
          setUnavailable(true);
          setRoot({ entries: [], total: 0, loading: false, error: '' });
          return;
        }
        setRoot({
          entries: [],
          total: 0,
          loading: false,
          error: `加载扫描树失败：${error instanceof Error ? error.message : String(error)}`
        });
      });
    return () => {
      cancelled = true;
    };
  }, [vaultPath]);

  const loadedRoot = useMemo(
    () => new Map<string, MarkdownTreeEntry[]>([['', root.entries]]),
    [root.entries]
  );
  const loadedMap = useMemo(() => {
    const map = new Map(loadedRoot);
    for (const [parent, page] of pages) map.set(parent, page.entries);
    return map;
  }, [loadedRoot, pages]);

  const rows = useMemo(
    () => flattenMarkdownTree(root.entries, loadedMap, expanded, keyword),
    [root.entries, loadedMap, expanded, keyword]
  );
  const window = computeVirtualWindow(
    rows.length,
    ROW_HEIGHT,
    scrollTop,
    VIEWPORT_HEIGHT
  );
  const visibleRows = rows.slice(window.start, window.end);

  const loadedCount = root.entries.length;
  useEffect(() => {
    // 去重：已上报过相同数字就不再触发父级 setState，避免「子组件通知 → 父级 render」循环。
    const previous = lastLoadedRef.current;
    if (previous && previous.loaded === loadedCount && previous.total === root.total) return;
    lastLoadedRef.current = { loaded: loadedCount, total: root.total };
    onLoadedChangeRef.current?.(loadedCount, root.total);
  }, [loadedCount, root.total]);

  const loadFolder = (path: string): void => {
    const existing = pages.get(path);
    if (existing && (existing.loading || existing.entries.length >= existing.total)) return;
    setPages((current) => {
      const next = new Map(current);
      const previous = next.get(path);
      next.set(path, {
        entries: previous?.entries ?? [],
        total: previous?.total ?? 0,
        loading: true,
        error: ''
      });
      return next;
    });
    loadPage(vaultPath, path, existing?.entries.length ?? 0, (...args) =>
      getPageRef.current(...args)
    )
      .then((page) => {
        setPages((current) => {
          const next = new Map(current);
          const previous = next.get(path);
          const entries = [...(previous?.entries ?? []), ...page.entries];
          next.set(path, { entries, total: page.total, loading: false, error: '' });
          return next;
        });
      })
      .catch((error: unknown) => {
        setPages((current) => {
          const next = new Map(current);
          next.set(path, {
            entries: current.get(path)?.entries ?? [],
            total: current.get(path)?.total ?? 0,
            loading: false,
            error: `加载文件夹失败：${
              error instanceof Error ? error.message : String(error)
            }`
          });
          return next;
        });
      });
  };

  const toggleExpand = (row: MarkdownLazyRow): void => {
    if (!row.expandable) return;
    const path = row.entry.path;
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
    const page = pages.get(path);
    if (!page || page.entries.length === 0) loadFolder(path);
  };

  const folderState = (path: string): 'checked' | 'partial' | 'unchecked' => {
    const page = pages.get(path);
    const entries = page?.entries ?? [];
    return folderCheckState(
      selection,
      path,
      entries.filter((entry) => entry.kind === 'file').map((entry) => entry.path),
      entries.filter((entry) => entry.kind === 'folder').map((entry) => entry.path)
    );
  };

  const renderRow = (row: MarkdownLazyRow): React.JSX.Element => {
    const { entry, depth } = row;
    if (entry.kind === 'file') {
      return (
        <label
          className="kr-markdown-lazy__row"
          style={{ paddingLeft: `${8 + depth * 14}px` }}
          title={entry.path}
        >
          <input
            type="checkbox"
            checked={fileChecked(selection, entry.path)}
            onChange={() => onToggleFile(entry.path)}
            aria-label={`选择 ${entry.path}`}
          />
          <span className="kr-markdown-lazy__name">{entry.name}</span>
        </label>
      );
    }
    const state = folderState(entry.path);
    const page = pages.get(entry.path);
    return (
      <div
        className="kr-markdown-lazy__row kr-markdown-lazy__row--folder"
        style={{ paddingLeft: `${8 + depth * 14}px` }}
        title={entry.path}
      >
        <button
          type="button"
          className="kr-markdown-lazy__caret"
          aria-expanded={row.expanded}
          onClick={() => toggleExpand(row)}
        >
          {row.expanded ? '▾' : '▸'}
        </button>
        <input
          type="checkbox"
          checked={state === 'checked'}
          ref={(element) => {
            if (element) element.indeterminate = state === 'partial';
          }}
          onChange={() => onToggleFolder(entry.path)}
          aria-label={`选择文件夹 ${entry.path}`}
        />
        <button
          type="button"
          className="kr-markdown-lazy__name kr-link-button"
          onClick={() => toggleExpand(row)}
        >
          {entry.name}
        </button>
        <small className="kr-muted">
          {entry.noteCount ?? entry.childCount ?? ''}
          {page?.loading ? ' · 加载中…' : ''}
          {page?.error ? ' · 加载失败' : ''}
        </small>
      </div>
    );
  };

  return (
    <div className="kr-markdown-lazy">
      {unavailable ? (
        <div className="kr-markdown-lazy__unavailable" role="alert">
          <p>扫描结果不可用，请先完成扫描。</p>
          <div className="kr-markdown-modal__footer-actions">
            {onClose ? (
              <button type="button" onClick={onClose}>
                关闭
              </button>
            ) : null}
            {onRescan ? (
              <button type="button" className="kr-primary" onClick={onRescan}>
                重新扫描
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
      {root.loading ? <p className="kr-muted">正在加载扫描树…</p> : null}
      {root.error ? (
        <p className="kr-page-error" role="alert">
          {root.error}
          <button
            type="button"
            className="kr-link-button"
            onClick={() => {
              setRoot((current) => ({ ...current, loading: true, error: '' }));
              loadPage(vaultPath, '', 0, (...args) => getPageRef.current(...args))
                .then((page) =>
                  setRoot({
                    entries: page.entries,
                    total: page.total,
                    loading: false,
                    error: ''
                  })
                )
                .catch((error: unknown) =>
                  setRoot((current) => ({
                    ...current,
                    loading: false,
                    error: `加载扫描树失败：${
                      error instanceof Error ? error.message : String(error)
                    }`
                  }))
                );
            }}
          >
            重试
          </button>
        </p>
      ) : null}
      {!root.loading && !root.error ? (
        <>
          {keyword.trim() && loadedCount < root.total ? (
            <p className="kr-muted kr-markdown-lazy__hint">
              当前只搜索已加载的 {loadedCount}/{root.total} 项；加载更多文件夹后搜索。
            </p>
          ) : null}
          <div
            ref={scrollRef}
            className="kr-markdown-lazy__viewport"
            style={{ height: `${VIEWPORT_HEIGHT}px` }}
            onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
          >
            <div
              className="kr-markdown-lazy__spacer"
              style={{ height: `${rows.length * ROW_HEIGHT}px` }}
            >
              <div style={{ transform: `translateY(${window.paddingTop}px)` }}>
                {visibleRows.map((row) => (
                  <div key={`${row.parent}:${row.entry.path}`} style={{ height: ROW_HEIGHT }}>
                    {renderRow(row)}
                  </div>
                ))}
              </div>
            </div>
          </div>
          {root.entries.length < root.total ? (
            <button
              type="button"
              className="kr-link-button"
              onClick={() => {
                setHint('');
                loadPage(vaultPath, '', root.entries.length, (...args) =>
                  getPageRef.current(...args)
                )
                  .then((page) =>
                    setRoot((current) => ({
                      ...current,
                      entries: [...current.entries, ...page.entries],
                      total: page.total
                    }))
                  )
                  .catch((error: unknown) =>
                    setHint(
                      `加载更多失败：${error instanceof Error ? error.message : String(error)}`
                    )
                  );
              }}
            >
              加载更多（已加载 {root.entries.length}/{root.total}）
            </button>
          ) : null}
          {hint ? <p className="kr-page-error">{hint}</p> : null}
        </>
      ) : null}
    </div>
  );
}
