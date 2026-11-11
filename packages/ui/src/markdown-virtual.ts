import type { MarkdownTreeEntry } from '@studianda/shared';

/** 扫描树不可用（409 或「请先扫描」类错误）。 */
export function isScanTreeUnavailableError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { status?: number; code?: string; message?: string };
  if (candidate.status === 409) return true;
  if (candidate.code === 'scan_missing' || candidate.code === 'no_scan') return true;
  const message = candidate.message ?? '';
  return message.includes('409') || message.includes('扫描结果不可用') || message.includes('请先扫描');
}

/** 导入报告缺失（404 或 result_missing）。 */
export function isReportMissingError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { status?: number; code?: string; message?: string };
  if (candidate.status === 404) return true;
  if (candidate.code === 'result_missing') return true;
  const message = candidate.message ?? '';
  return message.includes('result_missing') || message.includes('报告缺失');
}

/** 过滤 missing 警告：已选文件夹下的子文件不再单独提示（文件夹本身仍存在时）。 */
export function filterMissingPathsForWarning(
  missing: string[],
  selection: MarkdownSelectionState
): string[] {
  const folders = [...selection.folders];
  return missing.filter(
    (path) =>
      !folders.some(
        (folder) => folder === path || path.startsWith(`${folder}/`)
      )
  );
}

/** 固定行高虚拟列表的可见窗口。 */
export interface VirtualWindow {
  start: number;
  end: number;
  paddingTop: number;
  total: number;
}

/** 计算虚拟列表窗口（含 overscan），只渲染视口内行。纯函数。 */
export function computeVirtualWindow(
  rowCount: number,
  rowHeight: number,
  scrollTop: number,
  viewportHeight: number,
  overscan = 4
): VirtualWindow {
  if (rowCount <= 0 || rowHeight <= 0) {
    return { start: 0, end: 0, paddingTop: 0, total: Math.max(0, rowCount) };
  }
  const visible = Math.max(1, Math.ceil((viewportHeight || rowHeight) / rowHeight));
  const first = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const start = Math.min(first, Math.max(0, rowCount - 1));
  const end = Math.min(rowCount, start + visible + overscan * 2);
  return { start, end, paddingTop: start * rowHeight, total: rowCount };
}

/** 懒加载树的扁平显示行。 */
export interface MarkdownLazyRow {
  entry: MarkdownTreeEntry;
  parent: string;
  depth: number;
  expanded: boolean;
  expandable: boolean;
}

/**
 * 把已加载的树结点按展开状态展平；搜索只过滤已加载内容（不触发服务端搜索）。
 * 纯函数，便于测试虚拟化/懒加载。
 */
export function flattenMarkdownTree(
  rootEntries: MarkdownTreeEntry[],
  loaded: ReadonlyMap<string, MarkdownTreeEntry[]>,
  expanded: ReadonlySet<string>,
  keyword = '',
  depth = 0,
  parent = ''
): MarkdownLazyRow[] {
  const query = keyword.trim().toLowerCase();
  const rows: MarkdownLazyRow[] = [];
  const matches = (entry: MarkdownTreeEntry): boolean =>
    !query ||
    entry.name.toLowerCase().includes(query) ||
    entry.path.toLowerCase().includes(query);
  for (const entry of rootEntries) {
    const expandable = entry.kind === 'folder';
    if (!expandable) {
      if (matches(entry)) {
        rows.push({ entry, parent, depth, expanded: false, expandable: false });
      }
      continue;
    }
    const children = loaded.get(entry.path) ?? [];
    if (query) {
      // 搜索：只要已加载的下级有命中就保留父文件夹，并临时展开。
      const childRows = flattenMarkdownTree(
        children,
        loaded,
        expanded,
        query,
        depth + 1,
        entry.path
      );
      if (matches(entry) || childRows.length > 0) {
        rows.push({ entry, parent, depth, expanded: true, expandable: true });
        rows.push(...childRows);
      }
      continue;
    }
    const isExpanded = expanded.has(entry.path);
    rows.push({ entry, parent, depth, expanded: isExpanded, expandable: true });
    if (isExpanded) {
      rows.push(
        ...flattenMarkdownTree(children, loaded, expanded, '', depth + 1, entry.path)
      );
    }
  }
  return rows;
}

/** 选择状态：全选 + 排除，或逐文件夹/文件选择。 */
export interface MarkdownSelectionState {
  all: boolean;
  folders: Set<string>;
  files: Set<string>;
  excludedFolders: Set<string>;
  excludedFiles: Set<string>;
}

export function emptySelection(): MarkdownSelectionState {
  return {
    all: false,
    folders: new Set(),
    files: new Set(),
    excludedFolders: new Set(),
    excludedFiles: new Set()
  };
}

export function selectAll(): MarkdownSelectionState {
  return {
    all: true,
    folders: new Set(),
    files: new Set(),
    excludedFolders: new Set(),
    excludedFiles: new Set()
  };
}

/** 文件勾选状态。 */
export function fileChecked(selection: MarkdownSelectionState, path: string): boolean {
  return selection.all ? !selection.excludedFiles.has(path) : selection.files.has(path);
}

/** 文件夹勾选/半选状态（半选仅按已加载的直接子项近似）。 */
export function folderCheckState(
  selection: MarkdownSelectionState,
  folderPath: string,
  loadedFiles: string[],
  loadedFolders: string[]
): 'checked' | 'partial' | 'unchecked' {
  if (selection.all) {
    if (selection.excludedFolders.has(folderPath)) return 'unchecked';
    return 'checked';
  }
  if (selection.folders.has(folderPath)) return 'checked';
  const anyFile = loadedFiles.some((path) => selection.files.has(path));
  const anyFolder = loadedFolders.some((path) => selection.folders.has(path));
  return anyFile || anyFolder ? 'partial' : 'unchecked';
}

/** 切换文件选择。 */
export function toggleFileSelection(
  selection: MarkdownSelectionState,
  path: string
): MarkdownSelectionState {
  if (selection.all) {
    const excludedFiles = new Set(selection.excludedFiles);
    if (excludedFiles.has(path)) excludedFiles.delete(path);
    else excludedFiles.add(path);
    return { ...selection, excludedFiles };
  }
  const files = new Set(selection.files);
  if (files.has(path)) files.delete(path);
  else files.add(path);
  return { ...selection, files };
}

/** 切换文件夹选择。 */
export function toggleFolderSelection(
  selection: MarkdownSelectionState,
  path: string
): MarkdownSelectionState {
  if (selection.all) {
    const excludedFolders = new Set(selection.excludedFolders);
    if (excludedFolders.has(path)) excludedFolders.delete(path);
    else excludedFolders.add(path);
    return { ...selection, excludedFolders };
  }
  const folders = new Set(selection.folders);
  if (folders.has(path)) folders.delete(path);
  else folders.add(path);
  return { ...selection, folders };
}

/** 选择状态 → 服务端 resolve 参数。 */
export function toSelectionInput(
  vaultPath: string,
  selection: MarkdownSelectionState
): {
  vaultPath: string;
  all?: boolean;
  folders?: string[];
  files?: string[];
  excludedFolders?: string[];
  excludedFiles?: string[];
} {
  return {
    vaultPath,
    ...(selection.all ? { all: true } : {}),
    ...(selection.folders.size > 0 ? { folders: [...selection.folders] } : {}),
    ...(selection.files.size > 0 ? { files: [...selection.files] } : {}),
    ...(selection.excludedFolders.size > 0
      ? { excludedFolders: [...selection.excludedFolders] }
      : {}),
    ...(selection.excludedFiles.size > 0
      ? { excludedFiles: [...selection.excludedFiles] }
      : {})
  };
}
