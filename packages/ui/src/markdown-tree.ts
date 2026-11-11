import type { MarkdownVaultFile } from '@studianda/shared';

/** Markdown 文件树：文件夹 / Markdown 文件。 */
export interface MarkdownTreeFile {
  type: 'file';
  relativePath: string;
  name: string;
}

export interface MarkdownTreeFolder {
  type: 'folder';
  /** 相对库根的目录路径；根节点为空串。 */
  path: string;
  name: string;
  depth: number;
  children: MarkdownTreeNode[];
  /** 该文件夹（含子文件夹）下所有 Markdown 文件路径。 */
  filePaths: string[];
}

export type MarkdownTreeNode = MarkdownTreeFile | MarkdownTreeFolder;

export type MarkdownSelectionState = 'all' | 'some' | 'none';

function sortNodes(nodes: MarkdownTreeNode[]): MarkdownTreeNode[] {
  return [...nodes].sort((left, right) => {
    if (left.type !== right.type) return left.type === 'folder' ? -1 : 1;
    return left.name.localeCompare(right.name, 'zh-Hans-CN');
  });
}

/**
 * 按相对路径把扫描结果构造成文件树；文件夹优先、名称排序。
 * 纯函数，便于测试。
 */
export function buildMarkdownTree(notes: MarkdownVaultFile[]): MarkdownTreeFolder {
  const root: MarkdownTreeFolder = {
    type: 'folder',
    path: '',
    name: '',
    depth: 0,
    children: [],
    filePaths: []
  };
  const folders = new Map<string, MarkdownTreeFolder>([['', root]]);
  const ensureFolder = (path: string): MarkdownTreeFolder => {
    const existing = folders.get(path);
    if (existing) return existing;
    const segments = path.split('/');
    const parentPath = segments.slice(0, -1).join('/');
    const parent = ensureFolder(parentPath);
    const folder: MarkdownTreeFolder = {
      type: 'folder',
      path,
      name: segments[segments.length - 1] ?? path,
      depth: segments.length,
      children: [],
      filePaths: []
    };
    folders.set(path, folder);
    parent.children.push(folder);
    return folder;
  };

  for (const note of notes) {
    const segments = note.relativePath.split('/').filter(Boolean);
    const fileName = segments[segments.length - 1] ?? note.name ?? note.relativePath;
    const folderPath = segments.slice(0, -1).join('/');
    const folder = ensureFolder(folderPath);
    folder.children.push({
      type: 'file',
      relativePath: note.relativePath,
      name: fileName
    });
  }

  // 自底向上汇总 filePaths 并排序。
  const finalize = (folder: MarkdownTreeFolder): string[] => {
    const paths: string[] = [];
    folder.children = sortNodes(folder.children);
    for (const child of folder.children) {
      if (child.type === 'file') paths.push(child.relativePath);
      else paths.push(...finalize(child));
    }
    folder.filePaths = paths;
    return paths;
  };
  finalize(root);
  return root;
}

/** 过滤文件树（按相对路径包含关键词），保留命中文件的父文件夹。 */
export function filterMarkdownTree(
  folder: MarkdownTreeFolder,
  keyword: string
): MarkdownTreeFolder {
  const query = keyword.trim().toLowerCase();
  if (!query) return folder;
  const filter = (current: MarkdownTreeFolder): MarkdownTreeFolder | null => {
    const children: MarkdownTreeNode[] = [];
    for (const child of current.children) {
      if (child.type === 'file') {
        if (child.relativePath.toLowerCase().includes(query)) children.push(child);
      } else {
        const filtered = filter(child);
        if (filtered) children.push(filtered);
      }
    }
    if (children.length === 0 && current.path !== '') return null;
    return {
      ...current,
      children,
      filePaths: current.filePaths.filter((path) => path.toLowerCase().includes(query))
    };
  };
  const filteredRoot = filter(folder) ?? { ...folder, children: [], filePaths: [] };
  return filteredRoot;
}

/** 文件夹选择状态：全部选中 / 部分选中（半选）/ 未选中。 */
export function folderSelectionState(
  folder: MarkdownTreeFolder,
  selected: ReadonlySet<string>
): MarkdownSelectionState {
  if (folder.filePaths.length === 0) return 'none';
  let count = 0;
  for (const path of folder.filePaths) if (selected.has(path)) count += 1;
  if (count === 0) return 'none';
  return count === folder.filePaths.length ? 'all' : 'some';
}

/** 切换文件夹下全部文件的选择；返回新的 Set（不修改入参）。 */
export function setFolderSelected(
  folder: MarkdownTreeFolder,
  selected: ReadonlySet<string>,
  next: boolean
): Set<string> {
  const result = new Set(selected);
  for (const path of folder.filePaths) {
    if (next) result.add(path);
    else result.delete(path);
  }
  return result;
}

/** 文件树里全部 Markdown 路径。 */
export function allMarkdownPaths(folder: MarkdownTreeFolder): string[] {
  return [...folder.filePaths];
}

/** 已选中的文件数（可只统计当前过滤结果之外的路径）。 */
export function countSelectedFiles(selected: ReadonlySet<string>): number {
  return selected.size;
}
