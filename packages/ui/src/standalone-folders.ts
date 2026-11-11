import type { NoteRecord } from '@studianda/shared';

/** 独立笔记的文件夹层级（按 NoteRecord.folderPath 分组，'' = 根目录）。 */
export interface StandaloneFolder {
  path: string;
  name: string;
  /** 直接位于该文件夹的笔记。 */
  notes: NoteRecord[];
  children: StandaloneFolder[];
  /** 该文件夹及子文件夹下的笔记总数。 */
  totalCount: number;
}

function noteFolderPath(note: NoteRecord): string {
  return (note.folderPath ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}

function sortNotes(notes: NoteRecord[]): NoteRecord[] {
  return [...notes].sort(
    (left, right) => new Date(right.created).getTime() - new Date(left.created).getTime()
  );
}

/**
 * 按 folderPath 构造文件夹树；没有 folderPath 的旧笔记归到根目录。
 * `folderPaths` 可传入服务端的虚拟文件夹（含空文件夹），用于显示尚无笔记的目录。
 * 纯函数，便于 SSR/冒烟测试。
 */
export function buildStandaloneFolderTree(
  notes: NoteRecord[],
  folderPaths: string[] = []
): StandaloneFolder {
  const root: StandaloneFolder = {
    path: '',
    name: '根目录',
    notes: [],
    children: [],
    totalCount: 0
  };
  const folders = new Map<string, StandaloneFolder>([['', root]]);
  const ensureFolder = (path: string): StandaloneFolder => {
    const existing = folders.get(path);
    if (existing) return existing;
    const segments = path.split('/').filter(Boolean);
    const parentPath = segments.slice(0, -1).join('/');
    const parent = ensureFolder(parentPath);
    const folder: StandaloneFolder = {
      path,
      name: segments[segments.length - 1] ?? path,
      notes: [],
      children: [],
      totalCount: 0
    };
    folders.set(path, folder);
    parent.children.push(folder);
    return folder;
  };

  for (const note of notes) {
    ensureFolder(noteFolderPath(note)).notes.push(note);
  }
  // 服务端虚拟文件夹（可能为空）：即使没有笔记也要显示。
  for (const path of folderPaths) {
    const normalized = (path ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (normalized) ensureFolder(normalized);
  }

  const finalize = (folder: StandaloneFolder): number => {
    folder.notes = sortNotes(folder.notes);
    folder.children.sort((left, right) => left.name.localeCompare(right.name, 'zh-Hans-CN'));
    let total = folder.notes.length;
    for (const child of folder.children) total += finalize(child);
    folder.totalCount = total;
    return total;
  };
  finalize(root);
  return root;
}

function noteMatchesKeyword(note: NoteRecord, keyword: string): boolean {
  return (
    (note.content ?? '').toLowerCase().includes(keyword) ||
    (note.folderPath ?? '').toLowerCase().includes(keyword)
  );
}

/**
 * 搜索过滤文件夹树：保留命中笔记所在的父文件夹；无命中返回 null。
 * keyword 为空时原样返回。
 */
export function filterStandaloneFolderTree(
  folder: StandaloneFolder,
  keyword: string
): StandaloneFolder | null {
  const query = keyword.trim().toLowerCase();
  if (!query) return folder;
  const notes = folder.notes.filter((note) => noteMatchesKeyword(note, query));
  const children: StandaloneFolder[] = [];
  for (const child of folder.children) {
    const filtered = filterStandaloneFolderTree(child, query);
    if (filtered) children.push(filtered);
  }
  if (notes.length === 0 && children.length === 0) return null;
  const totalCount =
    notes.length + children.reduce((total, child) => total + child.totalCount, 0);
  return { ...folder, notes, children, totalCount };
}

/** 文件夹及子文件夹下的所有笔记（按当前排序）。 */
export function collectFolderNotes(folder: StandaloneFolder): NoteRecord[] {
  return [
    ...folder.notes,
    ...folder.children.flatMap((child) => collectFolderNotes(child))
  ];
}

/** 文件夹树中所有目录路径（含空文件夹）。 */
export function collectFolderPaths(folder: StandaloneFolder): string[] {
  return folder.children.flatMap((child) => [child.path, ...collectFolderPaths(child)]);
}

/** 按标签筛选笔记：selected 为空返回全部；否则命中任一标签。 */
export function filterStandaloneNotesByTags(
  notes: NoteRecord[],
  selectedTags: ReadonlySet<string>
): NoteRecord[] {
  if (selectedTags.size === 0) return notes;
  return notes.filter((note) =>
    (note.tags ?? []).some((tag) => selectedTags.has(tag))
  );
}
