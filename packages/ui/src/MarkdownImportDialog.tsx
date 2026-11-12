import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import type React from 'react';
import type {
  MarkdownImportItem,
  MarkdownImportJob,
  MarkdownImportReport,
  MarkdownImportReportPage,
  MarkdownScanSearchResult,
  MarkdownScanTreePage,
  MarkdownSelectionInput,
  MarkdownSelectionResult,
  MarkdownTreeEntry,
  MarkdownVaultScan
} from '@studianda/shared';
import {
  allMarkdownPaths,
  buildMarkdownTree,
  countSelectedFiles,
  filterMarkdownTree,
  folderSelectionState,
  setFolderSelected,
  type MarkdownTreeFolder
} from './markdown-tree.js';
import { MarkdownScanTree } from './MarkdownScanTree.js';
import {
  emptySelection,
  fileChecked,
  filterMissingPathsForWarning,
  folderCheckState,
  selectAll,
  toSelectionInput,
  toggleFileSelection,
  toggleFolderSelection,
  isReportMissingError,
  type MarkdownSelectionState
} from './markdown-virtual.js';

export interface MarkdownImportDialogProps {
  /** 扫描结果（vault 名/路径、Markdown 笔记、附件清单）。 */
  scan: MarkdownVaultScan;
  /** 关闭弹窗；导入完成时带上报告，供上层刷新/选中。 */
  onClose(report?: MarkdownImportReport | null): void;
  /** 启动后台导入任务。 */
  onStartImport(input: { vaultPath: string; files: string[] }): Promise<MarkdownImportJob>;
  /** 轮询后台导入状态。 */
  onGetImportStatus(): Promise<MarkdownImportJob>;
  /** 取消后台导入。 */
  onCancelImport(): Promise<MarkdownImportJob>;
  /** 初始任务状态（主要便于测试/恢复弹窗状态，默认 null 表示尚未开始）。 */
  initialJob?: MarkdownImportJob | null;
  /** 父级状态读取失败提示（卡片同源）。 */
  statusError?: string;
  onRetryStatus?(): void;
  /** 懒加载扫描树（按目录分页）；提供时不再依赖完整 scan.notes。 */
  getMarkdownScanTree?(
    vaultPath: string,
    parent: string,
    offset: number,
    limit: number
  ): Promise<MarkdownScanTreePage>;
  /** 服务端解析选择（全选/文件夹/文件/排除）。 */
  resolveMarkdownSelection?(input: MarkdownSelectionInput): Promise<MarkdownSelectionResult>;
  /** 报告明细分页。 */
  getMarkdownImportReportPage?(offset: number, limit: number): Promise<MarkdownImportReportPage>;
  /** 服务端搜索扫描结果（按路径/文件名）；offset 分页。 */
  searchMarkdownScan?(
    vaultPath: string,
    query: string,
    limit: number,
    offset?: number
  ): Promise<MarkdownScanSearchResult>;
  /** 扫描树不可用时重新扫描（由父级执行）。 */
  onRescan?(): void;
}

/** 轮询失败退避：0.5s、1s、2s、4s…（最多 8s，最多重试 5 次）。 */
const MAX_STATUS_RETRIES = 5;
function retryDelayMs(attempt: number): number {
  return Math.min(8000, 500 * 2 ** Math.max(0, attempt));
}

/** 导入阶段中文标签。 */
export function markdownImportPhaseLabel(phase: MarkdownImportJob['phase']): string {
  switch (phase) {
    case 'scanning':
      return '扫描文件';
    case 'importing':
      return '导入笔记';
    case 'resolving':
      return '解析链接';
    case 'finalizing':
      return '写入索引';
    default:
      return '准备中';
  }
}

/** 导入进度百分比（0–100；done 视作 100）。 */
export function markdownImportPercent(
  job: Pick<MarkdownImportJob, 'status' | 'done' | 'total'>
): number {
  if (job.status === 'done') return 100;
  if (!Number.isFinite(job.total) || job.total <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((job.done / job.total) * 100)));
}

/** 结果缺失/损坏：resultMissing 或 error 含「损坏/缺失」。 */
function isMissingResult(job: MarkdownImportJob | null): boolean {
  if (!job) return false;
  if (job.resultMissing) return true;
  const message = job.error ?? '';
  return message.includes('损坏') || message.includes('缺失');
}

/** 结果过期提示（仅当存在上次成功结果时）。 */
export function markdownImportStaleHint(job: MarkdownImportJob | null): string {
  if (!job?.resultCompletedAt) return '';
  const last = job.lastAttemptStatus;
  const stale =
    job.resultStale ||
    last === 'error' ||
    (last as string) === 'failed' ||
    last === 'cancelled' ||
    last === 'interrupted';
  if (!stale) return '';
  const time = new Date(job.resultCompletedAt).toLocaleString();
  const lastLabel =
    last === 'error' || (last as string) === 'failed'
      ? '失败'
      : last === 'cancelled'
        ? '取消'
        : last === 'interrupted'
          ? '中断'
          : '';
  return `上次成功结果：${time}；最近一次尝试${lastLabel ? `已${lastLabel}` : '未成功'}。`;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/**
 * Markdown 选定导入弹窗：文件树多选、搜索过滤、后台导入进度/取消与导入报告。
 *
 * 只导入 Markdown 笔记；引用的图片自动复制（过大自动压缩），PDF/音频等附件会复制到本地、
 * 点击时用系统程序打开。
 */
export function MarkdownImportDialog({
  scan,
  onClose,
  onStartImport,
  onGetImportStatus,
  onCancelImport,
  initialJob = null,
  statusError = '',
  onRetryStatus,
  getMarkdownScanTree,
  resolveMarkdownSelection,
  getMarkdownImportReportPage,
  searchMarkdownScan,
  onRescan
}: MarkdownImportDialogProps): React.JSX.Element {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [job, setJob] = useState<MarkdownImportJob | null>(initialJob);
  const [startError, setStartError] = useState('');
  const [cancelling, setCancelling] = useState(false);
  const [pollRetryNonce, setPollRetryNonce] = useState(0);
  const [pollExhausted, setPollExhausted] = useState(false);
  // 懒加载树 + 服务端选择。
  const [selection, setSelection] = useState<MarkdownSelectionState>(emptySelection());
  const [resolvedFiles, setResolvedFiles] = useState<string[]>([]);
  const [resolvedCount, setResolvedCount] = useState(0);
  const [resolving, setResolving] = useState(false);
  const [selectionError, setSelectionError] = useState('');
  const [missingFiles, setMissingFiles] = useState<string[]>([]);
  const [treeLoaded, setTreeLoaded] = useState({ loaded: 0, total: 0 });
  // 服务端搜索。
  const [searchEntries, setSearchEntries] = useState<MarkdownTreeEntry[]>([]);
  const [searchTotal, setSearchTotal] = useState(0);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [searchLoadingMore, setSearchLoadingMore] = useState(false);
  const [searchMoreError, setSearchMoreError] = useState('');
  const searchRequestIdRef = useRef(0);
  const reportedMissingRef = useRef<Set<string>>(new Set());
  // 报告缺失重导前校验。
  const [reimportWarning, setReimportWarning] = useState('');
  const [reimportError, setReimportError] = useState('');
  const [reimporting, setReimporting] = useState(false);
  // 报告缺失。
  const [reportMissing, setReportMissing] = useState(false);
  // 报告明细分页。
  const [reportItems, setReportItems] = useState<MarkdownImportItem[]>([]);
  const [reportTotal, setReportTotal] = useState(0);
  const [reportLoading, setReportLoading] = useState(false);
  const [reportError, setReportError] = useState('');

  const tree = useMemo(() => buildMarkdownTree(scan.notes), [scan.notes]);
  const visibleTree = useMemo(() => filterMarkdownTree(tree, search), [tree, search]);
  const selectedCount = countSelectedFiles(selected);
  const allSelected = tree.filePaths.length > 0 && selectedCount === tree.filePaths.length;
  const running = job?.status === 'running';
  const lazyMode = Boolean(getMarkdownScanTree);
  const effectiveCount = resolveMarkdownSelection ? resolvedCount : selectedCount;
  const effectiveFiles = resolveMarkdownSelection ? resolvedFiles : [...selected];

  // 稳定回调：扫描树把这些回调存在 ref 里，但保持引用稳定可进一步避免父级 render 触发重复加载。
  const loadScanPage = useCallback(
    (parent: string, offset: number, limit: number) => {
      if (!getMarkdownScanTree) {
        return Promise.reject(new Error('当前运行环境不支持读取扫描树'));
      }
      return getMarkdownScanTree(scan.vaultPath, parent, offset, limit);
    },
    [getMarkdownScanTree, scan.vaultPath]
  );
  const handleScanTreeLoaded = useCallback((loaded: number, total: number) => {
    setTreeLoaded((current) =>
      current.loaded === loaded && current.total === total ? current : { loaded, total }
    );
  }, []);

  // 服务端解析选择（300ms debounce；失败提示可重试）。
  useEffect(() => {
    if (!resolveMarkdownSelection) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      setResolving(true);
      resolveMarkdownSelection(toSelectionInput(scan.vaultPath, selection))
        .then((result) => {
          if (cancelled) return;
          setResolvedFiles(result.files);
          setResolvedCount(result.count);
          const missing = result.missingFiles ?? [];
          const newlyMissing = filterMissingPathsForWarning(missing, selection).filter(
            (path) => !reportedMissingRef.current.has(path)
          );
          for (const path of missing) reportedMissingRef.current.add(path);
          if (missing.length === 0) {
            setMissingFiles([]);
          } else if (newlyMissing.length > 0) {
            setMissingFiles(newlyMissing);
          }
          if (missing.length > 0) {
            // 从本地选择中移除已不存在的路径，避免后续反复 resolve 出同样警告。
            const gone = new Set(missing);
            setSelection((current) => ({
              ...current,
              files: new Set([...current.files].filter((path) => !gone.has(path))),
              folders: new Set([...current.folders].filter((path) => !gone.has(path))),
              excludedFiles: new Set(
                [...current.excludedFiles].filter((path) => !gone.has(path))
              ),
              excludedFolders: new Set(
                [...current.excludedFolders].filter((path) => !gone.has(path))
              )
            }));
          }
          setSelectionError('');
        })
        .catch((error: unknown) => {
          if (cancelled) return;
          setResolvedCount(0);
          setSelectionError(
            `整理选择失败：${error instanceof Error ? error.message : String(error)}`
          );
        })
        .finally(() => {
          if (!cancelled) setResolving(false);
        });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [selection, resolveMarkdownSelection, scan.vaultPath]);

  // 服务端搜索：300ms debounce，首次 limit 100/offset 0；requestId/querySnapshot 丢弃旧响应。
  useEffect(() => {
    if (!searchMarkdownScan) {
      setSearchEntries([]);
      setSearchTotal(0);
      return;
    }
    const query = search.trim();
    if (!query) {
      setSearchEntries([]);
      setSearchTotal(0);
      setSearchError('');
      return;
    }
    let active = true;
    const requestId = ++searchRequestIdRef.current;
    const timer = setTimeout(() => {
      setSearching(true);
      setSearchMoreError('');
      searchMarkdownScan(scan.vaultPath, query, 100, 0)
        .then((result) => {
          if (!active || requestId !== searchRequestIdRef.current) return;
          if (search.trim() !== query) return;
          setSearchEntries(result.entries);
          setSearchTotal(result.total);
          setSearchError('');
        })
        .catch(() => {
          if (!active || requestId !== searchRequestIdRef.current) return;
          setSearchEntries([]);
          setSearchTotal(0);
          setSearchError('搜索暂不可用，已回退到已加载列表内搜索。');
        })
        .finally(() => {
          if (active && requestId === searchRequestIdRef.current) setSearching(false);
        });
    }, 300);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [search, searchMarkdownScan, scan.vaultPath]);

  const loadMoreSearch = (): void => {
    if (!searchMarkdownScan || searching || searchLoadingMore) return;
    const querySnapshot = search.trim();
    const requestId = searchRequestIdRef.current;
    const offset = searchEntries.length;
    setSearchLoadingMore(true);
    setSearchMoreError('');
    searchMarkdownScan(scan.vaultPath, querySnapshot, 100, offset)
      .then((result) => {
        if (requestId !== searchRequestIdRef.current) return;
        if (search.trim() !== querySnapshot) return;
        setSearchEntries((current) => {
          const seen = new Set(current.map((entry) => entry.path));
          const appended = result.entries.filter((entry) => !seen.has(entry.path));
          return [...current, ...appended];
        });
        setSearchTotal(result.total);
      })
      .catch((error: unknown) => {
        if (requestId !== searchRequestIdRef.current) return;
        setSearchMoreError(
          `加载更多搜索结果失败：${error instanceof Error ? error.message : String(error)}`
        );
      })
      .finally(() => setSearchLoadingMore(false));
  };

  /** 报告缺失/损坏后重新导入：先用 resolve 校验 job.input.files，只导入仍存在的文件。 */
  const reimportFromInput = async (): Promise<void> => {
    const input = job?.input;
    if (!input) return;
    setReimportWarning('');
    setReimportError('');
    setReimporting(true);
    try {
      let files = input.files;
      if (resolveMarkdownSelection) {
        const resolved = await resolveMarkdownSelection({
          vaultPath: input.vaultPath,
          files
        });
        files = resolved.files;
        if (resolved.missingFiles && resolved.missingFiles.length > 0) {
          setReimportWarning(
            `${resolved.missingFiles.length} 个文件已不在扫描结果中，将只导入仍存在的 ${files.length} 篇。`
          );
        }
        if (files.length === 0) {
          setReimportError('原来的文件都已不存在，无法重新导入。');
          return;
        }
      }
      await onStartImport({ vaultPath: input.vaultPath, files });
    } catch (error) {
      setReimportError(
        `重新导入失败：${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      setReimporting(false);
    }
  };

  // 报告明细分页：首次 100 条；无分页 API 时回退本地 notes 前 100 条。
  useEffect(() => {
    const doneReport =
      job?.status === 'done' && !isMissingResult(job) ? job.report : null;
    if (!doneReport) {
      setReportItems([]);
      setReportTotal(0);
      return;
    }
    let cancelled = false;
    setReportLoading(true);
    setReportError('');
    setReportMissing(false);
    if (getMarkdownImportReportPage) {
      getMarkdownImportReportPage(0, 100)
        .then((page) => {
          if (cancelled) return;
          setReportItems(page.items);
          setReportTotal(page.total);
        })
        .catch((error: unknown) => {
          if (cancelled) return;
          if (isReportMissingError(error)) {
            setReportMissing(true);
            setReportItems([]);
            setReportTotal(0);
            setReportLoading(false);
            return;
          }
          setReportItems(doneReport.notes.slice(0, 100));
          setReportTotal(doneReport.notes.length);
          setReportError(
            `加载报告明细失败：${error instanceof Error ? error.message : String(error)}`
          );
        })
        .finally(() => {
          if (!cancelled) setReportLoading(false);
        });
    } else {
      setReportItems(doneReport.notes.slice(0, 100));
      setReportTotal(doneReport.notes.length);
      setReportLoading(false);
    }
    return () => {
      cancelled = true;
    };
  }, [job, getMarkdownImportReportPage]);

  const loadMoreReportItems = (): void => {
    if (!getMarkdownImportReportPage || reportLoading) return;
    setReportLoading(true);
    setReportError('');
    getMarkdownImportReportPage(reportItems.length, 100)
      .then((page) => {
        setReportItems((current) => [...current, ...page.items]);
        setReportTotal(page.total);
      })
      .catch((error: unknown) =>
        setReportError(
          `加载更多失败：${error instanceof Error ? error.message : String(error)}`
        )
      )
      .finally(() => setReportLoading(false));
  };

  // running 时每 600ms 轮询状态；done/error/cancelled 后停止。
  useEffect(() => {
    if (!job || job.status !== 'running') return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    const poll = async (): Promise<void> => {
      try {
        const next = await onGetImportStatus();
        if (cancelled) return;
        failures = 0;
        setPollExhausted(false);
        setStartError('');
        setJob(next);
        if (next.status === 'running') timer = setTimeout(poll, 600);
      } catch (error) {
        if (cancelled) return;
        failures += 1;
        if (failures > MAX_STATUS_RETRIES) {
          setPollExhausted(true);
          setStartError(
            `读取导入进度失败：${error instanceof Error ? error.message : String(error)}`
          );
          return;
        }
        setStartError(`状态查询失败，正在重试…（${failures}/${MAX_STATUS_RETRIES}）`);
        timer = setTimeout(poll, retryDelayMs(failures - 1));
      }
    };
    timer = setTimeout(poll, 500);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [job?.status, pollRetryNonce]);

  const retryPolling = (): void => {
    setPollExhausted(false);
    setStartError('');
    setPollRetryNonce((value) => value + 1);
  };

  const startImport = async (): Promise<void> => {
    const files = resolveMarkdownSelection ? resolvedFiles : [...selected];
    if (files.length === 0) return;
    setStartError('');
    try {
      const next = await onStartImport({
        vaultPath: scan.vaultPath,
        files
      });
      setJob(next);
    } catch (error) {
      setStartError(
        `启动导入失败：${error instanceof Error ? error.message : String(error)}`
      );
    }
  };

  const cancelImport = async (): Promise<void> => {
    setCancelling(true);
    setStartError('');
    try {
      const next = await onCancelImport();
      setJob(next);
    } catch (error) {
      setStartError(
        `取消导入失败：${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      setCancelling(false);
    }
  };

  const toggleFile = (relativePath: string): void => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(relativePath)) next.delete(relativePath);
      else next.add(relativePath);
      return next;
    });
  };

  const toggleFolder = (folder: MarkdownTreeFolder): void => {
    const state = folderSelectionState(folder, selected);
    setSelected((current) => setFolderSelected(folder, current, state !== 'all'));
  };

  const toggleLazyFile = (path: string): void => {
    setSelection((current) => toggleFileSelection(current, path));
  };
  const toggleLazyFolder = (path: string): void => {
    setSelection((current) => toggleFolderSelection(current, path));
  };
  const selectAllLazy = (): void => setSelection(selectAll());
  const clearLazy = (): void => setSelection(emptySelection());

  const handleSearchChange = (event: ChangeEvent<HTMLInputElement>): void => {
    setSearch(event.target.value);
  };

  const renderNodes = (folder: MarkdownTreeFolder): React.JSX.Element => (
    <ul className="kr-markdown-tree__list">
      {folder.children.map((child) => {
        if (child.type === 'file') {
          const checked = selected.has(child.relativePath);
          return (
            <li key={`file:${child.relativePath}`} className="kr-markdown-tree__item">
              <label
                className="kr-markdown-tree__file"
                style={{ paddingLeft: `${child.name ? (folder.depth + 1) * 14 : 0}px` }}
                title={child.relativePath}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggleFile(child.relativePath)}
                  aria-label={`选择 ${child.relativePath}`}
                />
                <span>{child.name}</span>
              </label>
            </li>
          );
        }
        const state = folderSelectionState(child, selected);
        return (
          <li key={`folder:${child.path}`} className="kr-markdown-tree__item">
            <label
              className="kr-markdown-tree__folder"
              style={{ paddingLeft: `${(child.depth - 1) * 14}px` }}
              title={child.path}
            >
              <input
                type="checkbox"
                checked={state === 'all'}
                ref={(element) => {
                  if (element) element.indeterminate = state === 'some';
                }}
                onChange={() => toggleFolder(child)}
                aria-label={`选择文件夹 ${child.path}`}
              />
              <span>{child.name}</span>
              <small className="kr-muted">
                {child.filePaths.length} 篇
                {state === 'some' ? ' · 部分选中' : ''}
              </small>
            </label>
            {child.children.length > 0 ? renderNodes(child) : null}
          </li>
        );
      })}
    </ul>
  );

  const report =
    job?.status === 'done' && !isMissingResult(job) ? job.report : null;
  const percent = job ? markdownImportPercent(job) : 0;

  return (
    <div
      className="kr-modal-backdrop"
      role="presentation"
      onClick={() => {
        if (!running) onClose();
      }}
    >
      <div
        className="kr-modal kr-markdown-modal"
        role="dialog"
        aria-modal="true"
        aria-label="导入 Markdown 笔记"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !running) onClose();
        }}
      >
        <div className="kr-markdown-modal__head">
          <div>
            <h2>导入 Markdown 笔记</h2>
            <p className="kr-muted">
              {scan.vaultName || '（未命名文件夹）'} · {scan.vaultPath}
            </p>
          </div>
          <button
            type="button"
            className="kr-link-button"
            onClick={() => onClose()}
            disabled={running}
          >
            关闭
          </button>
        </div>

        {statusError ? (
          <p className="kr-job-status-error" role="alert">
            {statusError}
            {onRetryStatus ? (
              <button type="button" className="kr-link-button" onClick={onRetryStatus}>
                重试
              </button>
            ) : null}
          </p>
        ) : null}

        {reportMissing && report ? (
          <div className="kr-markdown-cancelled">
            <p>导入报告缺失，请重新导入。</p>
            <p className="kr-muted">报告文件缺失/损坏，不展示空白明细。</p>
            {reimportWarning ? (
              <p className="kr-markdown-warning">{reimportWarning}</p>
            ) : null}
            {reimportError ? (
              <p className="kr-page-error" role="alert">
                {reimportError}
              </p>
            ) : null}
            <div className="kr-markdown-modal__footer">
              <span className="kr-muted">重新导入会按 core 去重/跳过规则处理。</span>
              <div className="kr-markdown-modal__footer-actions">
                <button type="button" onClick={() => onClose()}>
                  关闭
                </button>
                {job?.input ? (
                  <button
                    type="button"
                    className="kr-primary"
                    onClick={() => void reimportFromInput()}
                    disabled={reimporting}
                  >
                    {reimporting ? '校验中…' : '重新导入'}
                  </button>
                ) : null}
              </div>
            </div>
          </div>
        ) : report ? (
          <div className="kr-markdown-report">
            {markdownImportStaleHint(job) ? (
              <p className="kr-muted">{markdownImportStaleHint(job)}</p>
            ) : null}
            <p className="kr-markdown-report__summary">
              导入完成：共请求 {report.requested} 篇，导入 {report.imported}、更新{' '}
              {report.updated}、跳过 {report.skipped}、失败 {report.failed}；复制图片{' '}
              {report.imagesCopied} 张、复制其他附件 {report.attachmentsCopied} 个、重写链接{' '}
              {report.linksRewritten} 条、未解析链接 {report.unresolvedLinks} 条、跳过附件{' '}
              {report.skippedAttachments} 个。
            </p>
            {report.failed > 0 ? (
              <p className="kr-page-error" role="alert">
                有 {report.failed} 篇导入失败，请查看下方明细后重试。
              </p>
            ) : null}
            <details className="kr-markdown-report__details" open>
              <summary>
                每篇结果（已显示 {reportItems.length}/{reportTotal || report.notes.length}）
              </summary>
              <ul>
                {reportItems.map((item) => (
                  <li key={item.relativePath}>
                    <span className={`kr-markdown-report__status is-${item.status}`}>
                      {item.status === 'imported'
                        ? '导入'
                        : item.status === 'updated'
                          ? '更新'
                          : item.status === 'skipped'
                            ? '跳过'
                            : '失败'}
                    </span>
                    {item.relativePath}
                    {item.message ? <span className="kr-muted"> · {item.message}</span> : null}
                  </li>
                ))}
              </ul>
              {reportLoading ? <p className="kr-muted">正在加载明细…</p> : null}
              {reportError ? (
                <p className="kr-page-error" role="alert">
                  {reportError}
                  <button
                    type="button"
                    className="kr-link-button"
                    onClick={loadMoreReportItems}
                  >
                    重试
                  </button>
                </p>
              ) : null}
              {getMarkdownImportReportPage && reportItems.length < reportTotal ? (
                <button
                  type="button"
                  className="kr-link-button"
                  onClick={loadMoreReportItems}
                  disabled={reportLoading}
                >
                  加载更多（{reportItems.length}/{reportTotal}）
                </button>
              ) : null}
            </details>
            {report.warnings.length > 0 ? (
              <details className="kr-markdown-report__details">
                <summary>警告（{report.warnings.length}）</summary>
                <ul>
                  {report.warnings.map((warning, index) => (
                    <li key={`${index}-${warning}`}>{warning}</li>
                  ))}
                </ul>
              </details>
            ) : null}
            <div className="kr-markdown-modal__footer">
              <span className="kr-muted">
                关闭后会自动刷新独立笔记列表，并选中第一条新导入的笔记。
              </span>
              <button
                type="button"
                className="kr-primary"
                onClick={() => onClose(report)}
              >
                完成
              </button>
            </div>
          </div>
        ) : job && isMissingResult(job) ? (
          <div className="kr-markdown-cancelled">
            <p>任务已完成，但结果文件缺失/损坏。</p>
            <p className="kr-muted">不会展示空的导入报告；可以重新导入上次选择的文件。</p>
            <div className="kr-markdown-modal__footer">
              <span className="kr-muted">重新导入会按 core 去重/跳过规则处理。</span>
              <div className="kr-markdown-modal__footer-actions">
                <button type="button" onClick={() => onClose()}>
                  关闭
                </button>
                {job.input ? (
                  <button
                    type="button"
                    className="kr-primary"
                    onClick={() => void onStartImport(job.input!)}
                  >
                    重新导入
                  </button>
                ) : null}
              </div>
            </div>
          </div>
        ) : job?.status === 'running' ? (
          <div className="kr-markdown-progress" role="status">
            {startError ? (
              <p className="kr-page-error" role="alert">
                {startError}
                {pollExhausted ? (
                  <button type="button" className="kr-link-button" onClick={retryPolling}>
                    重试状态
                  </button>
                ) : null}
              </p>
            ) : null}
            <p className="kr-markdown-progress__count" aria-live="polite">
              {markdownImportPhaseLabel(job.phase)}：已处理 <strong>{job.done}</strong>
              {job.total > 0 ? ` / ${job.total}` : ''} 篇（{percent}%）
            </p>
            <progress
              className="kr-markdown-progress__bar"
              value={Math.min(job.done, Math.max(1, job.total))}
              max={Math.max(1, job.total)}
              aria-label="导入进度"
            />
            <p className="kr-markdown-progress__path" title={job.currentPath}>
              当前文件：{job.currentPath || '—'}
            </p>
            <div className="kr-markdown-modal__footer">
              <span className="kr-muted">导入在后台进行，不会阻塞其他操作。</span>
              <button
                type="button"
                onClick={() => void cancelImport()}
                disabled={cancelling}
              >
                {cancelling ? '取消中…' : '取消导入'}
              </button>
            </div>
          </div>
        ) : job?.status === 'interrupted' ? (
          <div className="kr-markdown-cancelled">
            <p>上次导入任务因进程重启中断。</p>
            <p className="kr-muted">
              已导入的部分可能保留；重启后不会续跑，请返回选择后重新导入。
            </p>
            <div className="kr-markdown-modal__footer">
              <span className="kr-muted">重新导入时只会处理仍可读取的文件。</span>
              <div className="kr-markdown-modal__footer-actions">
                <button type="button" onClick={() => onClose()}>
                  关闭
                </button>
                <button
                  type="button"
                  className="kr-primary"
                  onClick={() => setJob(null)}
                >
                  返回选择
                </button>
              </div>
            </div>
          </div>
        ) : job?.status === 'cancelled' ? (
          <div className="kr-markdown-cancelled">
            <p>导入已取消。</p>
            <p className="kr-muted">已导入的部分会保留；可以返回选择后重新导入。</p>
            <div className="kr-markdown-modal__footer">
              <span className="kr-muted">返回选择不会清空已勾选文件。</span>
              <div className="kr-markdown-modal__footer-actions">
                <button type="button" onClick={() => onClose()}>
                  关闭
                </button>
                <button
                  type="button"
                  className="kr-primary"
                  onClick={() => setJob(null)}
                >
                  返回选择
                </button>
              </div>
            </div>
          </div>
        ) : (
          <>
            <div className="kr-markdown-modal__summary">
              <p className="kr-muted kr-markdown-modal__stats">
                发现 {scan.notes.length} 篇 Markdown 笔记、{scan.attachments.length} 个附件
                {scan.attachments.length > 0
                  ? `（共 ${formatBytes(
                      scan.attachments.reduce((total, item) => total + (item.sizeBytes || 0), 0)
                    )}）`
                  : ''}
                。
              </p>
              <p className="kr-markdown-modal__hint">
                图片自动复制（过大自动压缩）；PDF/音频等附件会复制到本地并在点击时用系统程序打开。
              </p>
              <p className="kr-markdown-modal__guide">
                第 1 步：搜索或展开文件夹，勾选要导入的笔记；第 2 步：点右下角「导入选中」。
              </p>
              <details className="kr-markdown-modal__legal">
                <summary>隐私与合规说明</summary>
                <p className="kr-muted">
                  只导入 Markdown 笔记与本地附件；不会修改或删除原文件夹中的文件。
                </p>
                <p className="kr-muted">
                  请仅导入您拥有合法权利或已获授权的本地笔记与附件；导入内容仅保存在本机，不会上传到
                  Studianda 服务器。因导入内容产生的第三方权利、保密或伦理责任由导入者承担。
                </p>
                <p className="kr-muted">
                  本机数据文件与导出备份均为明文，未内置加密；敏感资料请自行使用磁盘加密或系统账户隔离。
                </p>
              </details>
            </div>
            <label className="kr-markdown-modal__search">
              <input
                type="search"
                value={search}
                onChange={handleSearchChange}
                placeholder="按路径或文件名搜索（只过滤显示，不影响已选）"
                aria-label="搜索笔记文件"
              />
            </label>
            <div className="kr-markdown-modal__tools">
              <button
                type="button"
                onClick={() => {
                  if (lazyMode) selectAllLazy();
                  else setSelected(new Set(allMarkdownPaths(tree)));
                }}
                disabled={lazyMode ? treeLoaded.total === 0 : scan.notes.length === 0 || allSelected}
              >
                全选所有
              </button>
              <button
                type="button"
                onClick={() => {
                  if (lazyMode) clearLazy();
                  else setSelected(new Set());
                }}
                disabled={lazyMode ? effectiveCount === 0 : selectedCount === 0}
              >
                清空
              </button>
              <span className="kr-markdown-modal__selected" role="status">
                已选 <strong>{effectiveCount}</strong> 篇
                {search.trim()
                  ? lazyMode
                    ? `（搜索只覆盖已加载的 ${treeLoaded.loaded}/${treeLoaded.total} 项）`
                    : `（搜索过滤中，共 ${scan.notes.length} 篇）`
                  : ''}
              </span>
            </div>
            {resolving ? <p className="kr-muted">正在整理选择…</p> : null}
            {selectionError ? (
              <p className="kr-page-error" role="alert">
                {selectionError}
                <button
                  type="button"
                  className="kr-link-button"
                  onClick={() => setSelection((current) => ({ ...current }))}
                >
                  重试
                </button>
              </p>
            ) : null}
            {missingFiles.length > 0 ? (
              <p className="kr-markdown-warning" role="status">
                {missingFiles.length} 个路径已不在扫描结果中，已忽略：
                {missingFiles.slice(0, 5).join('、')}
                {missingFiles.length > 5 ? ' 等' : ''}
                <button
                  type="button"
                  className="kr-link-button"
                  onClick={() => {
                    reportedMissingRef.current.clear();
                    setMissingFiles([]);
                  }}
                >
                  重置提示
                </button>
              </p>
            ) : null}
            {search.trim() && searchMarkdownScan ? (
              <div className="kr-markdown-search">
                {searching ? <p className="kr-muted">正在搜索…</p> : null}
                {searchError ? (
                  <p className="kr-page-error" role="alert">
                    {searchError}
                  </p>
                ) : null}
                {searchTotal > 0 || searchEntries.length > 0 ? (
                  <>
                    <p className="kr-muted">
                      搜索结果：{searchTotal} 项（已显示 {searchEntries.length} 项）
                    </p>
                    <ul className="kr-markdown-search__list">
                      {searchEntries.map((entry) => {
                        const checked =
                          entry.kind === 'file'
                            ? fileChecked(selection, entry.path)
                            : folderCheckState(selection, entry.path, [], []) === 'checked';
                        return (
                          <li key={entry.path} className="kr-markdown-search__item">
                            <label title={entry.path}>
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() =>
                                  entry.kind === 'file'
                                    ? toggleLazyFile(entry.path)
                                    : toggleLazyFolder(entry.path)
                                }
                              />
                              <span>
                                {entry.kind === 'folder' ? '📁 ' : ''}
                                {entry.path}
                              </span>
                            </label>
                          </li>
                        );
                      })}
                    </ul>
                    {searchMoreError ? (
                      <p className="kr-page-error" role="alert">
                        {searchMoreError}
                        <button
                          type="button"
                          className="kr-link-button"
                          onClick={loadMoreSearch}
                        >
                          重试
                        </button>
                      </p>
                    ) : null}
                    {searchEntries.length < searchTotal ? (
                      <button
                        type="button"
                        className="kr-link-button"
                        onClick={loadMoreSearch}
                        disabled={searchLoadingMore}
                      >
                        {searchLoadingMore
                          ? '加载中…'
                          : `加载更多（${searchEntries.length}/${searchTotal}）`}
                      </button>
                    ) : null}
                  </>
                ) : !searching && !searchError ? (
                  <p className="kr-muted">没有匹配的扫描结果。</p>
                ) : null}
                {searchEntries.length === 0 && searchError && lazyMode ? (
                  <MarkdownScanTree
                    vaultPath={scan.vaultPath}
                    getPage={loadScanPage}
                    selection={selection}
                    keyword={search}
                    onToggleFile={toggleLazyFile}
                    onToggleFolder={toggleLazyFolder}
                    onLoadedChange={handleScanTreeLoaded}
                    onClose={onClose}
                    onRescan={onRescan}
                  />
                ) : null}
              </div>
            ) : lazyMode ? (
              <MarkdownScanTree
                vaultPath={scan.vaultPath}
                getPage={loadScanPage}
                selection={selection}
                keyword={search}
                onToggleFile={toggleLazyFile}
                onToggleFolder={toggleLazyFolder}
                onLoadedChange={handleScanTreeLoaded}
                onClose={onClose}
                onRescan={onRescan}
              />
            ) : scan.notes.length === 0 ? (
              <p className="kr-muted kr-markdown-modal__empty">
                这个文件夹里没有找到 Markdown 笔记，无法导入。
              </p>
            ) : visibleTree.children.length === 0 ? (
              <p className="kr-muted kr-markdown-modal__empty">没有匹配搜索条件的文件。</p>
            ) : (
              <div className="kr-markdown-tree">{renderNodes(visibleTree)}</div>
            )}
            {startError ? (
              <p className="kr-page-error" role="alert">
                {startError}
                <button
                  type="button"
                  className="kr-link-button"
                  onClick={() => void startImport()}
                  disabled={selectedCount === 0}
                >
                  重试
                </button>
              </p>
            ) : null}
            {job?.status === 'error' ? (
              <p className="kr-page-error" role="alert">
                导入失败：{job.error || '未知错误'}
                <button
                  type="button"
                  className="kr-link-button"
                  onClick={() => void startImport()}
                  disabled={selectedCount === 0}
                >
                  重试
                </button>
              </p>
            ) : null}
            <div className="kr-markdown-modal__footer">
              <span className="kr-muted">
                {effectiveCount > 0
                  ? '导入在后台进行，不会阻塞其他操作，可随时取消。'
                  : '先在上方勾选要导入的 Markdown 笔记。'}
              </span>
              <div className="kr-markdown-modal__footer-actions">
                <button type="button" onClick={() => onClose()}>
                  取消
                </button>
                <button
                  type="button"
                  className="kr-primary kr-markdown-modal__import-button"
                  disabled={
                    effectiveCount === 0 || resolving || Boolean(selectionError) || running
                  }
                  onClick={() => void startImport()}
                >
                  {resolving ? '整理中…' : `导入选中的 ${effectiveCount} 篇笔记`}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
