import { useEffect, useRef, useState } from 'react';
import type React from 'react';
import { markdownJobFingerprint } from '@studianda/shared';
import type {
  AnnotationRecord,
  BacklinkRecord,
  DocumentSummary,
  MarkdownInternalTarget,
  MarkdownImportDuplicatePreview,
  NoteFolderRecord,
  NoteRecord,
  MarkdownImportJob,
  MarkdownImportReport,
  MarkdownImportReportPage,
  MarkdownJobSnapshot,
  MarkdownScanJob,
  MarkdownScanSearchResult,
  MarkdownScanTreePage,
  MarkdownSelectionInput,
  MarkdownSelectionResult,
  MarkdownVaultScan
} from '@studianda/shared';
import { Backlinks, type BacklinkTarget } from './Backlinks.js';
import { MarkdownEditor, type MarkdownImageUpload } from './MarkdownEditor.js';
import { MarkdownImportDialog } from './MarkdownImportDialog.js';
import { confirmPurgeNote } from './note-purge.js';
import { resolveConfirm, type ConfirmAction } from './dialog-utils.js';
import {
  buildStandaloneFolderTree,
  collectFolderNotes,
  collectFolderPaths,
  filterStandaloneFolderTree,
  filterStandaloneNotesByTags,
  type StandaloneFolder
} from './standalone-folders.js';

export interface StandaloneNotesViewProps {
  /** 独立笔记列表（documentId=''），由 app 传入 api.listStandaloneNotes 的结果。 */
  notes: NoteRecord[];
  loading?: boolean;
  error?: string;
  creating?: boolean;
  saving?: boolean;
  deleting?: boolean;
  selectedId: string | null;
  /** 内部引用弹窗的文献列表。 */
  documents?: DocumentSummary[];
  loadAnnotations?(documentId: string): Promise<AnnotationRecord[]>;
  loadNotes?(documentId: string): Promise<NoteRecord[]>;
  /** 图片上传器（studianda-asset 资源）。 */
  uploadImage?: MarkdownImageUpload;
  loadBacklinks?(target: BacklinkTarget): Promise<BacklinkRecord[]>;
  onOpenBacklink?(backlink: BacklinkRecord): void;
  onOpenInternal?(target: MarkdownInternalTarget): void;
  /** 点击 studianda-asset: 附件链接时回调（app 用 adapter.openNoteAsset）。 */
  onOpenAsset?(url: string): void | Promise<void>;
  onSelect(id: string): void;
  onCreate(): void;
  onSave(id: string, content: string): void;
  /** 软删除：移入回收站（可恢复）。 */
  onDelete(id: string): void;
  /** 从回收站恢复。 */
  onRestore(id: string): void;
  /** 彻底删除独立笔记（不可恢复，同时回收只被它引用的图片资源）。 */
  onPurge(id: string): void;
  /** 确认框实现（宿主注入；默认浏览器原生 confirm）。 */
  confirmAction?: ConfirmAction;
  /** 回收站中的独立笔记（按需加载）。 */
  trashNotes?: NoteRecord[];
  trashLoading?: boolean;
  /** 切换回收站视图：上层据此按需请求 trash 列表。 */
  onTrashChange?(showTrash: boolean): void;
  /** 初始是否显示回收站（默认 false，主要便于测试/恢复视图状态）。 */
  defaultShowTrash?: boolean;
  /** 选择 Markdown 库目录（取消返回 null）；不提供表示当前环境不支持。 */
  onPickMarkdownVault?(): Promise<string | null>;
  /** 扫描 Markdown 库（兼容 fallback；优先使用后台扫描）。 */
  scanMarkdownVault?(vaultPath: string): Promise<MarkdownVaultScan>;
  /** 启动后台扫描（app 包装 api.startMarkdownScan）。 */
  startMarkdownScan?(vaultPath: string): Promise<MarkdownScanJob>;
  /** 轮询扫描状态。 */
  getMarkdownScanStatus?(): Promise<MarkdownScanJob>;
  /** 取消扫描。 */
  cancelMarkdownScan?(): Promise<MarkdownScanJob>;
  /** 读取上次导入状态（用于恢复 running/done/interrupted 提示）。 */
  getMarkdownImportStatus?(): Promise<MarkdownImportJob>;
  /** 一次性读取扫描+导入完整状态（终态优先使用，失败回退两次 status）。 */
  getMarkdownJobs?(): Promise<MarkdownJobSnapshot>;
  /** 一次读取任务摘要（lite，不含完整 scan/report）；终态优先使用。 */
  getMarkdownJobsSummary?(): Promise<MarkdownJobSnapshot>;
  /** 按目录分页读取扫描树（懒加载）。 */
  getMarkdownScanTree?(
    vaultPath: string,
    parent: string,
    offset: number,
    limit: number
  ): Promise<MarkdownScanTreePage>;
  /** 服务端解析选择。 */
  resolveMarkdownSelection?(input: MarkdownSelectionInput): Promise<MarkdownSelectionResult>;
  /** 导入报告明细分页。 */
  getMarkdownImportReportPage?(offset: number, limit: number): Promise<MarkdownImportReportPage>;
  /** 服务端搜索扫描结果。 */
  searchMarkdownScan?(
    vaultPath: string,
    query: string,
    limit: number,
    offset?: number
  ): Promise<MarkdownScanSearchResult>;
  /** 服务端虚拟文件夹列表（含空文件夹）。 */
  folders?: NoteFolderRecord[];
  /** 全部笔记标签（用于顶部筛选）。 */
  tags?: string[];
  onCreateFolder?(path: string): void;
  onRenameFolder?(from: string, to: string): void;
  onDeleteFolder?(path: string): void;
  onMoveNote?(noteId: string, folderPath: string): void | Promise<void>;
  /**
   * 列表内拖拽排序：按 ids 顺序持久化 folderPath 内的手动顺序
   * （app 包装 api.reorderStandaloneNotes；'' = 根目录）。
   */
  onReorderNotes?(folderPath: string, ids: string[]): Promise<void> | void;
  /** 批量移入回收站（app 包装 api.batchDeleteStandaloneNotes）。 */
  onBatchDeleteNotes?(ids: string[]): Promise<void> | void;
  /** 批量移动到指定文件夹（app 包装 api.batchMoveStandaloneNotes；'' = 根目录）。 */
  onBatchMoveNotes?(ids: string[], folderPath: string): Promise<void> | void;
  /** 重命名保存：改写正文第一行标题后保存（app 复用 api.updateNote）。 */
  onRenameNote?(id: string, content: string): Promise<void> | void;
  /** 保存笔记标签（app 包装 api.setNoteTags），成功后刷新列表与标签查询。 */
  onSetTags?(noteId: string, tags: string[]): Promise<void>;
  /** 初始扫描任务（主要便于测试/恢复界面）。 */
  initialScanJob?: MarkdownScanJob | null;
  /** 初始文件夹内联编辑状态（主要便于测试）。 */
  initialFolderEditor?:
    | { mode: 'create'; parent: string }
    | { mode: 'rename'; path: string }
    | null;
  initialFolderDelete?: string | null;
  /** 初始上次导入任务与提示（主要便于测试/恢复界面）。 */
  initialRestoredImportJob?: MarkdownImportJob | null;
  initialImportRestoreNotice?: string;
  /** SSE 实时任务快照订阅；不可用/失败时回退轮询。 */
  subscribeMarkdownJobs?(
    handler: (snapshot: MarkdownJobSnapshot) => void,
    options?: { onError?: (error: Event) => void; onOpen?: () => void }
  ): () => void;
  /** 启动后台导入任务（app 包装 api.startMarkdownImport）。 */
  startMarkdownImport?(input: {
    vaultPath: string;
    files: string[];
    /** 重复笔记策略：更新已有 / 跳过已有（默认 update，保持旧行为）。 */
    duplicatePolicy?: 'update' | 'skip';
  }): Promise<MarkdownImportJob>;
  /** 预览本次选择里此前已导入过的笔记（按资料库路径+相对路径识别）。 */
  previewMarkdownImportDuplicates?(input: {
    vaultPath: string;
    files: string[];
  }): Promise<MarkdownImportDuplicatePreview>;
  /** 轮询后台导入状态（app 包装 api.getMarkdownImportStatus）。 */
  getMarkdownImportStatus?(): Promise<MarkdownImportJob>;
  /** 取消后台导入（app 包装 api.cancelMarkdownImport）。 */
  cancelMarkdownImport?(): Promise<MarkdownImportJob>;
  /** 关闭导入报告后回调：app 用于刷新列表并选中第一条新导入笔记。 */
  onMarkdownImported?(report: MarkdownImportReport): void;
  onRetry?(): void;
}

/** 状态轮询失败后的最大重试次数与退避上限。 */
export const STATUS_POLL_MAX_RETRIES = 5;

/** 状态轮询失败退避：0.5s、1s、2s、4s…（最多 8s）。 */
export function statusPollRetryDelayMs(attempt: number): number {
  return Math.min(8000, 500 * 2 ** Math.max(0, attempt));
}

/**
 * 任务结果过期提示：只有存在上次成功结果时才显示；
 * resultStale 或最近一次尝试为失败（error/failed）/取消/中断时提示旧结果时间。
 */
export function markdownJobStaleHint(job: {
  resultCompletedAt?: string | null;
  resultStale?: boolean;
  lastAttemptStatus?: string;
}): string {
  if (!job.resultCompletedAt) return '';
  const last = job.lastAttemptStatus;
  const stale =
    job.resultStale ||
    last === 'error' ||
    last === 'failed' ||
    last === 'cancelled' ||
    last === 'interrupted';
  if (!stale) return '';
  const time = new Date(job.resultCompletedAt).toLocaleString();
  const lastLabel =
    last === 'error' || last === 'failed'
      ? '失败'
      : last === 'cancelled'
        ? '取消'
        : last === 'interrupted'
          ? '中断'
          : '';
  return `上次成功结果：${time}；最近一次尝试${lastLabel ? `已${lastLabel}` : '未成功'}。`;
}

/** 结果缺失/损坏：resultMissing 或 error 含「损坏/缺失」时视为缺失。 */
export function isMarkdownResultMissing(job: {
  status?: string;
  resultMissing?: boolean;
  error?: string;
}): boolean {
  if (job.resultMissing) return true;
  const message = job.error ?? '';
  return message.includes('损坏') || message.includes('缺失');
}

/** 合并 lite 快照：只更新进度字段，保留已有完整 scan/report。 */
export function mergeLiteMarkdownJob<
  T extends { scan?: MarkdownVaultScan | null; report?: MarkdownImportReport | null }
>(previous: T | null, next: T): T {
  return {
    ...next,
    scan: next.scan ?? previous?.scan ?? null,
    report: next.report ?? previous?.report ?? null
  };
}

/** 任务终态（兼容旧数据里的 failed）。 */
export function isMarkdownJobTerminal(status: string): boolean {
  return (
    status === 'done' ||
    status === 'error' ||
    status === 'failed' ||
    status === 'cancelled' ||
    status === 'interrupted'
  );
}

/**
 * 已关闭终态任务的指纹（本机 localStorage）：关闭扫描/导入任务卡后，
 * 页面挂载/窗口 focus/10s 兜底轮询/SSE 恢复都不会再把同一终态卡片弹回来。
 */
const DISMISSED_MARKDOWN_JOBS_KEY = 'studianda.markdown.dismissedJobs';

type MarkdownJobKind = 'scan' | 'import';

type DismissedMarkdownJobs = Partial<Record<MarkdownJobKind, string>>;

/** 读取已关闭任务指纹；localStorage 不可用/内容损坏时按未关闭处理。 */
export function readDismissedMarkdownJobs(): DismissedMarkdownJobs {
  try {
    const raw = window.localStorage.getItem(DISMISSED_MARKDOWN_JOBS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const result: DismissedMarkdownJobs = {};
    if (typeof parsed.scan === 'string' && parsed.scan) result.scan = parsed.scan;
    if (typeof parsed.import === 'string' && parsed.import) result.import = parsed.import;
    return result;
  } catch {
    return {};
  }
}

function writeDismissedMarkdownJobs(value: DismissedMarkdownJobs): void {
  try {
    window.localStorage.setItem(DISMISSED_MARKDOWN_JOBS_KEY, JSON.stringify(value));
  } catch {
    // 只影响「关闭后不再弹回」，不影响任务本身。
  }
}

/**
 * 独立笔记可编辑标题：取内容第一个非空行，去掉常见 Markdown 标记与内部引用语法（不截断）。
 * 重命名输入框用它回填，避免把 40 字截断的展示标题写回正文。
 */
export function standaloneNoteTitleRaw(content: string): string {
  const lines = (content ?? '').replace(/\r\n?/g, '\n').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    return trimmed
      .replace(/^\s*#{1,6}\s+/, '')
      .replace(/^\s*>\s?/, '')
      .replace(/^\s*[-*+]\s+\[[ xX]\]\s+/, '')
      .replace(/^\s*([-*+]|\d+[.)])\s+/, '')
      .replace(/[*_~=+`]{1,3}/g, '')
      .replace(/<c:#[0-9a-fA-F]{3,8}>|<\/c>/g, '')
      .replace(/\[\[([^\]]*)\]\]/g, (_match, raw: string) => {
        const separator = raw.indexOf('|');
        const label = separator >= 0 ? raw.slice(separator + 1).trim() : '';
        return label || '内部引用';
      })
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/\s+/g, ' ')
      .trim();
  }
  return '';
}

/**
 * 独立笔记标题：取内容第一个非空行，去掉常见 Markdown 标记与内部引用语法，截断到 40 字。
 * 导出为纯函数便于 SSR/冒烟测试。
 */
export function standaloneNoteTitle(content: string): string {
  const plain = standaloneNoteTitleRaw(content);
  if (!plain) return '（未命名笔记）';
  return plain.length > 40 ? `${plain.slice(0, 40)}…` : plain;
}

/**
 * 重命名笔记：只改写正文第一个非空行，保留它的 `#` 标题层级（以及空行结构）。
 * 若正文没有非空行则直接写入标题。空标题原样返回 content（调用方据此判断不提交）。
 * 纯函数，便于审查/测试。
 */
export function renameNoteFirstLine(content: string, nextTitle: string): string {
  const title = (nextTitle ?? '').replace(/\s+/g, ' ').trim();
  if (!title) return content;
  const normalized = (content ?? '').replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  const index = lines.findIndex((line) => line.trim().length > 0);
  if (index < 0) return title;
  const firstLine = lines[index] ?? '';
  const heading = firstLine.match(/^(\s*)(#{1,6})(\s*)/);
  const prefix = heading ? `${heading[1]}${heading[2]} ` : '';
  lines[index] = `${prefix}${title}`;
  return lines.join('\n');
}

/**
 * 拖拽排序：把 draggedId 插到 targetId 前/后（targetId 为 null/找不到时追加到末尾）。
 * 返回新的 id 顺序；纯函数，便于审查/测试。
 */
export function reorderNoteIds(
  ids: string[],
  draggedId: string,
  targetId: string | null,
  position: 'before' | 'after'
): string[] {
  const without = ids.filter((id) => id !== draggedId);
  if (!targetId) return [...without, draggedId];
  const targetIndex = without.indexOf(targetId);
  if (targetIndex < 0) return [...without, draggedId];
  const insertAt = position === 'before' ? targetIndex : targetIndex + 1;
  return [...without.slice(0, insertAt), draggedId, ...without.slice(insertAt)];
}

/**
 * 按给定顺序（服务端 manual_order）排列文件夹树里的笔记。
 *
 * `buildStandaloneFolderTree` 为兼容旧数据仍按创建时间排序，这里用 notes 数组的
 * 顺序覆盖，使拖拽排序结果能立即显示（不依赖 core 返回的排序细节）。
 * 纯函数。
 */
export function orderFolderTreeNotes(
  folder: StandaloneFolder,
  order: ReadonlyMap<string, number>
): StandaloneFolder {
  const rank = (note: NoteRecord): number => order.get(note.id) ?? Number.MAX_SAFE_INTEGER;
  return {
    ...folder,
    notes: [...folder.notes].sort((left, right) => rank(left) - rank(right)),
    children: folder.children.map((child) => orderFolderTreeNotes(child, order))
  };
}

/** 笔记所在文件夹路径（规范化；'' = 根目录）。 */
function noteFolderPath(note: Pick<NoteRecord, 'folderPath'>): string {
  return (note.folderPath ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}

/** 笔记栏收起状态的本机持久化 key。 */
export const STANDALONE_SIDEBAR_COLLAPSED_KEY = 'studianda.notes.sidebarCollapsed';

/** 读取笔记栏收起状态；localStorage 不可用/内容损坏时用默认值。 */
export function readStandaloneSidebarCollapsed(defaultCollapsed: boolean): boolean {
  try {
    const raw = window.localStorage.getItem(STANDALONE_SIDEBAR_COLLAPSED_KEY);
    if (raw === 'true') return true;
    if (raw === 'false') return false;
  } catch {
    // localStorage 不可用（隐私模式/受限环境）时退回默认值。
  }
  return defaultCollapsed;
}

/** 写入笔记栏收起状态；失败只影响下次默认值，不影响当前交互。 */
export function writeStandaloneSidebarCollapsed(collapsed: boolean): void {
  try {
    window.localStorage.setItem(STANDALONE_SIDEBAR_COLLAPSED_KEY, collapsed ? 'true' : 'false');
  } catch {
    // 忽略：仅影响下次是否记住。
  }
}

/**
 * 「移动到…」下拉里代表根目录的哨兵值：真实文件夹路径不允许以 / 开头，
 * 所以用 '/' 区分「根目录」与其他空值。
 */
const ROOT_FOLDER_OPTION_VALUE = '/';

/** 把「移动到…」下拉值转成文件夹路径（哨兵 '/' → 根目录 ''）。 */
export function folderOptionToPath(value: string): string {
  return value === ROOT_FOLDER_OPTION_VALUE ? '' : value;
}


/**
 * 独立笔记本地搜索：标题（首行）与全文内容，大小写不敏感；空关键词返回全部。
 * 导出为纯函数便于测试。
 */
export function filterStandaloneNotes(notes: NoteRecord[], keyword: string): NoteRecord[] {
  const query = keyword.trim().toLowerCase();
  if (!query) return notes;
  return notes.filter(
    (note) =>
      standaloneNoteTitle(note.content).toLowerCase().includes(query) ||
      note.content.toLowerCase().includes(query)
  );
}

/**
 * 独立笔记工作区：左侧笔记列表 + 右侧 Markdown 编辑器；每条笔记下方可展开反向链接。
 *
 * 未保存内容按笔记 id 存在组件本地 drafts 里：切换笔记不会丢草稿，保存按钮只在有改动时可用。
 */
export function StandaloneNotesView({
  notes,
  loading = false,
  error = '',
  creating = false,
  saving = false,
  deleting = false,
  selectedId,
  documents = [],
  loadAnnotations,
  loadNotes,
  uploadImage,
  loadBacklinks,
  onOpenBacklink,
  onOpenInternal,
  onOpenAsset,
  onSelect,
  onCreate,
  onSave,
  onDelete,
  onRestore,
  onPurge,
  confirmAction,
  trashNotes = [],
  trashLoading = false,
  onTrashChange,
  defaultShowTrash = false,
  onPickMarkdownVault,
  scanMarkdownVault,
  startMarkdownScan,
  getMarkdownScanStatus,
  cancelMarkdownScan,
  getMarkdownImportStatus,
  getMarkdownJobs,
  getMarkdownJobsSummary,
  getMarkdownScanTree,
  resolveMarkdownSelection,
  getMarkdownImportReportPage,
  searchMarkdownScan,
  folders = [],
  tags = [],
  onCreateFolder,
  onRenameFolder,
  onDeleteFolder,
  onMoveNote,
  onReorderNotes,
  onBatchDeleteNotes,
  onBatchMoveNotes,
  onRenameNote,
  onSetTags,
  initialScanJob = null,
  initialFolderEditor = null,
  initialFolderDelete = null,
  initialRestoredImportJob = null,
  initialImportRestoreNotice = '',
  subscribeMarkdownJobs,
  startMarkdownImport,
  previewMarkdownImportDuplicates,
  cancelMarkdownImport,
  onMarkdownImported,
  onRetry
}: StandaloneNotesViewProps): React.JSX.Element {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [search, setSearch] = useState('');
  const [showTrash, setShowTrash] = useState(defaultShowTrash);
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(new Set());
  const [tagFilter, setTagFilter] = useState<Set<string>>(new Set());
  const [folderMessage, setFolderMessage] = useState('');
  const [folderEditor, setFolderEditor] = useState<
    | { mode: 'create'; parent: string; value: string; error: string }
    | { mode: 'rename'; path: string; value: string; error: string; merging: boolean }
    | null
  >(
    initialFolderEditor
      ? initialFolderEditor.mode === 'create'
        ? { mode: 'create', parent: initialFolderEditor.parent, value: '', error: '' }
        : {
            mode: 'rename',
            path: initialFolderEditor.path,
            value: initialFolderEditor.path,
            error: '',
            merging: false
          }
      : null
  );
  const [folderDelete, setFolderDelete] = useState<string | null>(initialFolderDelete);
  const [dragNoteId, setDragNoteId] = useState<string | null>(null);
  const [dragTarget, setDragTarget] = useState<string | null>(null);
  // 列表内拖拽排序：目标笔记 + 插入位置（before/after）。
  const [dragTargetNote, setDragTargetNote] = useState<{
    id: string;
    position: 'before' | 'after';
  } | null>(null);
  // 多选批量操作。
  const [selectedNoteIds, setSelectedNoteIds] = useState<Set<string>>(new Set());
  const [batchBusy, setBatchBusy] = useState(false);
  const [noteActionNotice, setNoteActionNotice] = useState('');
  // 重命名（改写正文第一行；Enter 保存 / Esc 取消）。
  const [renamingNote, setRenamingNote] = useState<{
    id: string;
    value: string;
    error: string;
  } | null>(null);
  // 左侧笔记文件夹栏收起/展开（localStorage 持久化；窄屏默认收起并作为抽屉）。
  const [narrowNotesLayout, setNarrowNotesLayout] = useState(
    () =>
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(max-width: 1100px)').matches
  );
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() =>
    readStandaloneSidebarCollapsed(
      typeof window !== 'undefined' &&
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(max-width: 1100px)').matches
    )
  );
  const [tagInput, setTagInput] = useState('');
  const [tagError, setTagError] = useState('');
  const [tagSaving, setTagSaving] = useState(false);
  const [tagEditorOpen, setTagEditorOpen] = useState(false);
  const [markdownScan, setMarkdownScan] = useState<MarkdownVaultScan | null>(null);
  const [markdownDialogOpen, setMarkdownDialogOpen] = useState(false);
  const [markdownBusy, setMarkdownBusy] = useState<'picking' | 'scanning' | null>(null);
  const [markdownError, setMarkdownError] = useState('');
  // 用户关闭过的终态任务指纹（本机持久化）：挂载/轮询/SSE 恢复时跳过，避免卡片自动弹回。
  // 用 useState 惰性初始化只读一次 localStorage（组件高频重渲染时不做同步 IO）。
  const [initialDismissedJobs] = useState<DismissedMarkdownJobs>(() =>
    readDismissedMarkdownJobs()
  );
  const dismissedJobsRef = useRef<DismissedMarkdownJobs>(initialDismissedJobs);
  const [scanJob, setScanJob] = useState<MarkdownScanJob | null>(() => {
    if (
      initialScanJob &&
      isMarkdownJobTerminal(initialScanJob.status) &&
      dismissedJobsRef.current.scan === markdownJobFingerprint(initialScanJob)
    ) {
      return null;
    }
    return initialScanJob;
  });
  const [scanRetryNonce, setScanRetryNonce] = useState(0);
  const [scanPollExhausted, setScanPollExhausted] = useState(false);
  const autoRestartedScanRef = useRef(false);
  const autoRestartedImportRef = useRef(false);
  const autoRecoveryRunningRef = useRef(false);
  const pendingAutoImportInputRef = useRef<{ vaultPath: string; files: string[] } | null>(null);
  const sseAvailableRef = useRef(false);
  const sseLastEventRef = useRef(0);
  const jobsRunningRef = useRef(false);
  const [sseFallback, setSseFallback] = useState(!subscribeMarkdownJobs);
  const [sseNotice, setSseNotice] = useState('');
  const [statusFetchError, setStatusFetchError] = useState('');
  const [fullResultError, setFullResultError] = useState('');
  const fullResultRetryRef = useRef<(() => void) | null>(null);
  const [restoredImportJob, setRestoredImportJob] = useState<MarkdownImportJob | null>(() => {
    if (
      initialRestoredImportJob &&
      isMarkdownJobTerminal(initialRestoredImportJob.status) &&
      dismissedJobsRef.current.import === markdownJobFingerprint(initialRestoredImportJob)
    ) {
      return null;
    }
    return initialRestoredImportJob;
  });
  const [importRestoreNotice, setImportRestoreNotice] = useState(initialImportRestoreNotice);
  const scanJobRef = useRef<MarkdownScanJob | null>(scanJob);
  const importJobRef = useRef<MarkdownImportJob | null>(restoredImportJob);
  scanJobRef.current = scanJob;
  importJobRef.current = restoredImportJob;
  jobsRunningRef.current =
    scanJob?.status === 'running' || restoredImportJob?.status === 'running';

  /** 写入状态并同步 ref，避免连续异步事件读到旧快照。 */
  const commitScanJob = (next: MarkdownScanJob | null): void => {
    scanJobRef.current = next;
    setScanJob(next);
  };
  const commitImportJob = (next: MarkdownImportJob | null): void => {
    importJobRef.current = next;
    setRestoredImportJob(next);
  };
  const rememberDismissedJob = (
    kind: MarkdownJobKind,
    job: MarkdownScanJob | MarkdownImportJob
  ): void => {
    if (!isMarkdownJobTerminal(job.status)) return;
    const next = { ...dismissedJobsRef.current, [kind]: markdownJobFingerprint(job) };
    dismissedJobsRef.current = next;
    writeDismissedMarkdownJobs(next);
  };
  const clearDismissedJob = (kind: MarkdownJobKind): void => {
    if (!dismissedJobsRef.current[kind]) return;
    const next = { ...dismissedJobsRef.current };
    delete next[kind];
    dismissedJobsRef.current = next;
    writeDismissedMarkdownJobs(next);
  };
  const isDismissedJob = (
    kind: MarkdownJobKind,
    job: MarkdownScanJob | MarkdownImportJob
  ): boolean =>
    isMarkdownJobTerminal(job.status) &&
    dismissedJobsRef.current[kind] === markdownJobFingerprint(job);
  /** 应用扫描任务状态：终态且已被用户关闭 → 保持隐藏；新任务（running）→ 清除关闭标记。 */
  const applyScanJob = (incoming: MarkdownScanJob): void => {
    const merged = mergeLiteMarkdownJob(scanJobRef.current, incoming);
    if (!isMarkdownJobTerminal(merged.status)) {
      if (merged.status === 'running') clearDismissedJob('scan');
      commitScanJob(merged);
      return;
    }
    commitScanJob(isDismissedJob('scan', merged) ? null : merged);
  };
  const applyImportJob = (incoming: MarkdownImportJob): void => {
    const merged = mergeLiteMarkdownJob(importJobRef.current, incoming);
    if (!isMarkdownJobTerminal(merged.status)) {
      if (merged.status === 'running') clearDismissedJob('import');
      commitImportJob(merged);
      return;
    }
    commitImportJob(isDismissedJob('import', merged) ? null : merged);
  };
  const selectedNote = notes.find((note) => note.id === selectedId) ?? null;
  const draft = selectedNote ? (drafts[selectedNote.id] ?? selectedNote.content) : '';
  const dirty = selectedNote ? draft !== selectedNote.content : false;

  // 切换笔记时收起标签输入，避免把上一条的编辑状态带到下一条。
  useEffect(() => {
    setTagEditorOpen(false);
    setTagInput('');
    setRenamingNote(null);
  }, [selectedId]);

  // 收起/展开状态持久化到本机（下次进入笔记工作区沿用）。
  useEffect(() => {
    writeStandaloneSidebarCollapsed(sidebarCollapsed);
  }, [sidebarCollapsed]);

  // 窄屏（<1100px）：侧栏改为覆盖式抽屉；进入窄屏时默认收起一次，用户展开后可用。
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia('(max-width: 1100px)');
    const onChange = (): void => {
      setNarrowNotesLayout(media.matches);
      if (media.matches) setSidebarCollapsed(true);
    };
    setNarrowNotesLayout(media.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  // 笔记被删除/过滤后清理已不存在的选中项，避免批量操作作用到幽灵 id。
  useEffect(() => {
    setSelectedNoteIds((current) => {
      if (current.size === 0) return current;
      const known = new Set(notes.map((note) => note.id));
      const next = new Set([...current].filter((id) => known.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [notes]);

  // 本地搜索：标题（首行）/全文内容/文件夹路径，大小写不敏感；不影响草稿与选中状态。
  // 顶部标签筛选优先于文件夹/搜索（标签为 OR 匹配）。
  const tagFilteredNotes = filterStandaloneNotesByTags(notes, tagFilter);
  // notes 由 app 按 core 的 folder_path, manual_order, created 顺序给出；
  // 这里覆盖 helper 的默认创建时间排序，让拖拽排序结果立即可见。
  const noteOrderIndex = new Map(tagFilteredNotes.map((note, index) => [note.id, index]));
  const fullFolderTree = orderFolderTreeNotes(
    buildStandaloneFolderTree(
      tagFilteredNotes,
      folders.map((folder) => folder.path)
    ),
    noteOrderIndex
  );
  const folderTree = filterStandaloneFolderTree(fullFolderTree, search);
  const scanPercent =
    scanJob && scanJob.total > 0
      ? Math.min(100, Math.round((scanJob.done / scanJob.total) * 100))
      : 0;
  const allFolderPaths = collectFolderPaths(fullFolderTree);
  const knownFolderPaths = new Set(allFolderPaths);
  // 当前筛选（标签 + 搜索）下的全部笔记：批量「全选当前筛选结果」用。
  const visibleFilteredNotes = folderTree ? collectFolderNotes(folderTree) : [];
  const allVisibleSelected =
    visibleFilteredNotes.length > 0 &&
    visibleFilteredNotes.every((note) => selectedNoteIds.has(note.id));
  const someVisibleSelected = visibleFilteredNotes.some((note) =>
    selectedNoteIds.has(note.id)
  );

  const toggleTag = (tag: string): void => {
    setTagFilter((current) => {
      const next = new Set(current);
      if (next.has(tag)) next.delete(tag);
      else next.add(tag);
      return next;
    });
  };

  const validateNewFolderPath = (path: string, isRenameFrom?: string): string => {
    if (!path) return '文件夹路径不能为空。';
    if (path.startsWith('/') || path.endsWith('/')) return '文件夹路径不能以 / 开头或结尾。';
    if (path.includes('\\')) return '文件夹路径请使用 / 分隔。';
    const segments = path.split('/');
    if (segments.some((segment) => !segment.trim() || segment === '.' || segment === '..')) {
      return '文件夹路径包含非法片段。';
    }
    if (knownFolderPaths.has(path) && path !== isRenameFrom) return '同名文件夹已存在。';
    return '';
  };

  const openCreateFolderEditor = (parentPath = ''): void => {
    if (!onCreateFolder) return;
    setFolderMessage('');
    setFolderEditor({ mode: 'create', parent: parentPath, value: '', error: '' });
  };

  const openRenameFolderEditor = (path: string): void => {
    if (!onRenameFolder) return;
    setFolderMessage('');
    setFolderEditor({ mode: 'rename', path, value: path, error: '', merging: false });
  };

  const submitFolderEditor = (): void => {
    if (!folderEditor) return;
    if (folderEditor.mode === 'create') {
      const path = (folderEditor.parent
        ? `${folderEditor.parent}/${folderEditor.value}`
        : folderEditor.value
      )
        .replace(/\\/g, '/')
        .replace(/^\/+|\/+$/g, '')
        .trim();
      const message = validateNewFolderPath(path);
      if (message) {
        setFolderEditor({ ...folderEditor, error: message });
        return;
      }
      onCreateFolder?.(path);
      setFolderEditor(null);
      return;
    }
    const normalized = folderEditor.value
      .replace(/\\/g, '/')
      .replace(/^\/+|\/+$/g, '')
      .trim();
    const message = validateNewFolderPath(normalized, folderEditor.path);
    if (message) {
      setFolderEditor({ ...folderEditor, error: message });
      return;
    }
    if (normalized === folderEditor.path) {
      setFolderEditor(null);
      return;
    }
    // 目标已存在：明确提示这是合并（core 用 rename 合并到目标）。
    if (knownFolderPaths.has(normalized)) {
      setFolderEditor({ ...folderEditor, value: normalized, merging: true, error: '' });
      return;
    }
    onRenameFolder?.(folderEditor.path, normalized);
    setFolderEditor(null);
  };

  const confirmFolderMerge = (): void => {
    if (!folderEditor || folderEditor.mode !== 'rename') return;
    onRenameFolder?.(folderEditor.path, folderEditor.value);
    setFolderEditor(null);
  };

  const confirmDeleteFolder = (): void => {
    if (!folderDelete || !onDeleteFolder) return;
    onDeleteFolder(folderDelete);
    setFolderDelete(null);
  };

  const moveNoteToFolder = (noteId: string, folderPath: string): void => {
    if (!onMoveNote) return;
    const note = notes.find((item) => item.id === noteId);
    if (note && noteFolderPath(note) === folderPath) return;
    setNoteActionNotice('');
    Promise.resolve(onMoveNote(noteId, folderPath)).catch((error: unknown) => {
      setNoteActionNotice(
        `移动笔记失败：${error instanceof Error ? error.message : String(error)}`
      );
    });
    setFolderMessage('');
  };

  /** 某文件夹内的全部笔记 id（按服务端顺序；不受搜索/标签筛选影响）。 */
  const folderNoteIds = (folderPath: string): string[] =>
    notes.filter((note) => noteFolderPath(note) === folderPath).map((note) => note.id);

  /** 列表内拖拽落点：同文件夹调序；跨文件夹先移动再调序，失败回滚由 app mutation 负责。 */
  const dropNoteOnNote = async (
    target: NoteRecord,
    position: 'before' | 'after'
  ): Promise<void> => {
    const draggedId = dragNoteId;
    setDragNoteId(null);
    setDragTarget(null);
    setDragTargetNote(null);
    if (!draggedId || draggedId === target.id) return;
    const dragged = notes.find((note) => note.id === draggedId);
    if (!dragged) return;
    const targetFolder = noteFolderPath(target);
    const nextIds = reorderNoteIds(folderNoteIds(targetFolder), draggedId, target.id, position);
    if (nextIds.length === 0) return;
    setNoteActionNotice('');
    try {
      if (noteFolderPath(dragged) !== targetFolder) {
        // 跨文件夹拖动：先 move 再 reorder，保证服务端顺序作用于正确的文件夹。
        await onMoveNote?.(draggedId, targetFolder);
      }
      await onReorderNotes?.(targetFolder, nextIds);
    } catch (error) {
      setNoteActionNotice(
        `调整笔记顺序失败：${error instanceof Error ? error.message : String(error)}`
      );
    }
  };

  const toggleNoteSelection = (noteId: string): void => {
    setSelectedNoteIds((current) => {
      const next = new Set(current);
      if (next.has(noteId)) next.delete(noteId);
      else next.add(noteId);
      return next;
    });
  };

  const selectAllVisibleNotes = (): void => {
    setSelectedNoteIds(new Set(visibleFilteredNotes.map((note) => note.id)));
  };

  const clearNoteSelection = (): void => {
    setSelectedNoteIds(new Set());
  };

  const batchDeleteSelected = async (): Promise<void> => {
    if (!onBatchDeleteNotes || selectedNoteIds.size === 0 || batchBusy) return;
    const ids = [...selectedNoteIds];
    if (!resolveConfirm(confirmAction)(`将选中的 ${ids.length} 篇笔记移入回收站？可恢复。`)) {
      return;
    }
    setBatchBusy(true);
    setNoteActionNotice('');
    try {
      await onBatchDeleteNotes(ids);
      setSelectedNoteIds(new Set());
      setNoteActionNotice(`已将 ${ids.length} 篇笔记移入回收站。`);
    } catch (error) {
      setNoteActionNotice(
        `批量移入回收站失败：${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      setBatchBusy(false);
    }
  };

  const batchMoveSelected = async (folderPath: string): Promise<void> => {
    if (!onBatchMoveNotes || selectedNoteIds.size === 0 || batchBusy) return;
    const ids = [...selectedNoteIds];
    setBatchBusy(true);
    setNoteActionNotice('');
    try {
      await onBatchMoveNotes(ids, folderPath);
      setSelectedNoteIds(new Set());
      setNoteActionNotice(
        `已将 ${ids.length} 篇笔记移动到${folderPath ? `「${folderPath}」` : '根目录'}。`
      );
    } catch (error) {
      setNoteActionNotice(
        `批量移动失败：${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      setBatchBusy(false);
    }
  };

  const beginRenameNote = (note: NoteRecord): void => {
    // 重命名输入框渲染在左侧列表项里：栏收起时先展开，避免点了没反应。
    setSidebarCollapsed(false);
    // 当前笔记有未保存草稿时以草稿为基准，避免重命名把草稿内容覆盖掉。
    const base = note.id === selectedId ? (drafts[note.id] ?? note.content) : note.content;
    setRenamingNote({
      id: note.id,
      value: standaloneNoteTitleRaw(base),
      error: ''
    });
  };

  const cancelRenameNote = (): void => {
    setRenamingNote(null);
  };

  /**
   * 提交重命名：基于当前草稿（若这条笔记正在编辑）改写正文第一行，
   * 保留标题层级；空标题不提交；保存成功后清空重命名状态。
   */
  const commitRenameNote = async (): Promise<void> => {
    if (!renamingNote) return;
    const note = notes.find((item) => item.id === renamingNote.id);
    if (!note) {
      setRenamingNote(null);
      return;
    }
    const title = renamingNote.value.trim();
    if (!title) {
      setRenamingNote((current) =>
        current ? { ...current, error: '标题不能为空。' } : current
      );
      return;
    }
    const base = note.id === selectedId ? (drafts[note.id] ?? note.content) : note.content;
    const next = renameNoteFirstLine(base, title);
    if (next === base) {
      setRenamingNote(null);
      return;
    }
    if (note.id === selectedId) {
      setDrafts((current) => ({ ...current, [note.id]: next }));
    }
    setRenamingNote(null);
    setNoteActionNotice('');
    try {
      const saveRename = onRenameNote ?? onSave;
      await Promise.resolve(saveRename(note.id, next));
    } catch (error) {
      setNoteActionNotice(
        `重命名失败：${error instanceof Error ? error.message : String(error)}`
      );
    }
  };

  const saveNoteTags = async (tags: string[]): Promise<void> => {
    if (!selectedNote || !onSetTags) return;
    setTagSaving(true);
    setTagError('');
    try {
      await onSetTags(selectedNote.id, tags);
      setTagInput('');
    } catch (error) {
      // 不做乐观更新：失败时界面保持服务端旧标签。
      setTagError(
        `保存标签失败：${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      setTagSaving(false);
    }
  };

  const addTag = (): void => {
    if (!selectedNote) return;
    const raw = tagInput.trim();
    if (!raw) return;
    if ((selectedNote.tags ?? []).includes(raw)) {
      setTagInput('');
      return;
    }
    void saveNoteTags([...(selectedNote.tags ?? []), raw]);
  };

  const removeTag = (tag: string): void => {
    if (!selectedNote) return;
    void saveNoteTags((selectedNote.tags ?? []).filter((item) => item !== tag));
  };

  const cancelRestoredImport = async (): Promise<void> => {
    if (!cancelMarkdownImport) return;
    try {
      const job = await cancelMarkdownImport();
      applyImportJob(job);
      setImportRestoreNotice(
        job.status === 'cancelled' ? '上次导入已取消。' : `导入任务状态：${job.status}`
      );
    } catch (error) {
      setImportRestoreNotice(
        `取消导入失败：${error instanceof Error ? error.message : String(error)}`
      );
    }
  };

  const isFolderCollapsed = (path: string): boolean =>
    !search.trim() && collapsedFolders.has(path);

  const toggleFolderCollapsed = (path: string): void => {
    setCollapsedFolders((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const updateDraft = (value: string): void => {
    if (!selectedNote) return;
    setDrafts((current) => ({ ...current, [selectedNote.id]: value }));
  };

  const save = (): void => {
    if (!selectedNote || !dirty || saving) return;
    onSave(selectedNote.id, draft);
  };

  const remove = (): void => {
    if (!selectedNote) return;
    onDelete(selectedNote.id);
  };

  const purge = (id: string): void => {
    if (confirmPurgeNote(confirmAction)) onPurge(id);
  };

  const toggleTrash = (next: boolean): void => {
    setShowTrash(next);
    onTrashChange?.(next);
  };

  const beginMarkdownImport = async (): Promise<void> => {
    if (!onPickMarkdownVault) {
      setMarkdownError('当前运行环境不支持选择笔记文件夹，请在桌面应用中使用导入功能。');
      return;
    }
    if (!startMarkdownScan && !scanMarkdownVault) {
      setMarkdownError('当前运行环境不支持扫描笔记库。');
      return;
    }
    setMarkdownError('');
    setMarkdownScan(null);
    setMarkdownBusy('picking');
    try {
      const vaultPath = await onPickMarkdownVault();
      if (!vaultPath) return; // 用户取消，不报错
      setMarkdownBusy('scanning');
      // 手动启动优先：清空自动队列，避免并行自动任务。
      pendingAutoImportInputRef.current = null;
      autoRecoveryRunningRef.current = true;
      // 手动扫描也检查上次未完成的导入：扫描终态后继续排队导入。
      try {
        if (getMarkdownJobs) {
          const snapshot = await getMarkdownJobs();
          if (
            snapshot.importJob.status === 'interrupted' &&
            snapshot.importJob.input
          ) {
            pendingAutoImportInputRef.current = snapshot.importJob.input;
          }
        } else if (getMarkdownImportStatus) {
          const importJob = await getMarkdownImportStatus();
          if (importJob.status === 'interrupted' && importJob.input) {
            pendingAutoImportInputRef.current = importJob.input;
          }
        }
      } catch {
        // 状态不可读时不影响手动扫描。
      }
      if (startMarkdownScan && getMarkdownScanStatus) {
        const job = await startMarkdownScan(vaultPath);
        applyScanJob(job);
        if (job.status === 'done' && job.scan) {
          setMarkdownScan(job.scan);
          setMarkdownDialogOpen(true);
          // 扫描完成、选择弹窗已经打开：用户随后关闭弹窗时，任务卡不应再自动
          // 出现（原来的恢复轮询会把 done 卡片反复弹回来）。这里记一次已关闭。
          rememberDismissedJob('scan', job);
          commitScanJob(null);
        } else if (job.status === 'error') {
          setMarkdownError(`扫描失败：${job.error || '未知错误'}`);
          commitScanJob(null);
        }
      } else if (scanMarkdownVault) {
        // 兼容旧 core：没有后台扫描时退回同步扫描。
        const scan = await scanMarkdownVault(vaultPath);
        setMarkdownScan(scan);
        setMarkdownDialogOpen(true);
      }
    } catch (error) {
      setMarkdownError(
        `扫描笔记文件夹失败：${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      setMarkdownBusy(null);
    }
  };

  // 扫描任务 running 时 600ms 轮询；done 后打开选择弹窗。
  useEffect(() => {
    if (!scanJob || scanJob.status !== 'running' || !getMarkdownScanStatus) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    const poll = async (): Promise<void> => {
      try {
        const job = await getMarkdownScanStatus();
        if (cancelled) return;
        failures = 0;
        setScanPollExhausted(false);
        setMarkdownError('');
        applyScanJob(job);
        if (job.status === 'running') {
          timer = setTimeout(poll, 600);
          return;
        }
        if (job.status === 'done') {
          if (job.scan) {
            setMarkdownScan(job.scan);
            setMarkdownDialogOpen(true);
            // 选择弹窗打开后，done 任务卡就不必再露出；记住已关闭，避免 focus/
            // 10s 兜底轮询/重进页面时又弹回来。
            rememberDismissedJob('scan', job);
          } else {
            setMarkdownError('扫描完成但没有返回结果，请重试。');
          }
          commitScanJob(null);
          return;
        }
        if (job.status === 'cancelled') {
          setMarkdownError('扫描已取消。');
          commitScanJob(null);
          return;
        }
        if (job.status === 'interrupted') {
          setMarkdownError('上次扫描任务因进程重启中断，请重新选择目录。');
          commitScanJob(null);
          return;
        }
        if (job.status === 'error') {
          setMarkdownError(`扫描失败：${job.error || '未知错误'}`);
          commitScanJob(null);
        }
      } catch (error) {
        if (cancelled) return;
        failures += 1;
        if (failures > STATUS_POLL_MAX_RETRIES) {
          setScanPollExhausted(true);
          setMarkdownError(
            `读取扫描进度失败：${error instanceof Error ? error.message : String(error)}`
          );
          return;
        }
        setMarkdownError(
          `状态查询失败，正在重试…（${failures}/${STATUS_POLL_MAX_RETRIES}）`
        );
        timer = setTimeout(poll, statusPollRetryDelayMs(failures - 1));
      }
    };
    timer = setTimeout(poll, 500);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [scanJob?.status, scanRetryNonce]);

  const retryScanStatus = (): void => {
    setScanPollExhausted(false);
    setMarkdownError('');
    setScanRetryNonce((value) => value + 1);
  };

  /** 终态取状态：优先摘要（lite，不拉完整 /jobs），失败回退完整/两次 status。 */
  const fetchFullMarkdownJobs = async (): Promise<void> => {
    if (getMarkdownJobsSummary) {
      try {
        const snapshot = await getMarkdownJobsSummary();
        applyScanJob(snapshot.scanJob);
        applyImportJob(snapshot.importJob);
        setStatusFetchError('');
        return;
      } catch {
        // 回退完整 /jobs 或两次 status
      }
    }
    if (getMarkdownJobs) {
      try {
        const snapshot = await getMarkdownJobs();
        applyScanJob(snapshot.scanJob);
        applyImportJob(snapshot.importJob);
        setStatusFetchError('');
        return;
      } catch {
        // 回退到两次 status 请求
      }
    }
    let scanOk = false;
    let importOk = false;
    let scanError = '';
    let importError = '';
    let lastError = '';
    if (getMarkdownScanStatus) {
      try {
        const job = await getMarkdownScanStatus();
        applyScanJob(job);
        scanOk = true;
      } catch (error) {
        scanError = error instanceof Error ? error.message : String(error);
        lastError = scanError;
      }
    }
    if (getMarkdownImportStatus) {
      try {
        const job = await getMarkdownImportStatus();
        applyImportJob(job);
        importOk = true;
      } catch (error) {
        importError = error instanceof Error ? error.message : String(error);
        lastError = importError;
      }
    }
    const anyAttempted = Boolean(getMarkdownScanStatus || getMarkdownImportStatus);
    if (anyAttempted && (!scanOk || !importOk)) {
      const failed: string[] = [];
      if (getMarkdownScanStatus && !scanOk) failed.push('扫描任务');
      if (getMarkdownImportStatus && !importOk) failed.push('导入任务');
      setStatusFetchError(
        `任务状态读取失败（${failed.join('、')}）${
          lastError ? `：${lastError}` : '，请重试'
        }。`
      );
    } else if (anyAttempted) {
      setStatusFetchError('');
    }
  };

  const retryStatusFetch = (): void => {
    setStatusFetchError('');
    void fetchFullMarkdownJobs();
  };

  const cancelCurrentScan = async (): Promise<void> => {
    if (!cancelMarkdownScan || !scanJob) return;
    try {
      const job = await cancelMarkdownScan();
      if (job.status !== 'running') {
        setMarkdownError(
          job.status === 'cancelled'
            ? '扫描已取消。'
            : `扫描未完成：${job.error || job.status}`
        );
        // 用户主动取消：记住该终态，避免下次轮询/重进页面又弹出取消卡片。
        rememberDismissedJob('scan', job);
        commitScanJob(null);
        return;
      }
      applyScanJob(job);
    } catch (error) {
      setMarkdownError(
        `取消扫描失败：${error instanceof Error ? error.message : String(error)}`
      );
    }
  };

  // 视图挂载 / 窗口 focus 时刷新上次任务状态；自动恢复按队列串行（先扫描后导入）。
  const refreshJobStatuses = async (): Promise<void> => {
    let scanResult: MarkdownScanJob | null = null;
    let importResult: MarkdownImportJob | null = null;
    if (getMarkdownScanStatus) {
      try {
        scanResult = await getMarkdownScanStatus();
      } catch {
        // 忽略
      }
    }
    if (getMarkdownImportStatus) {
      try {
        importResult = await getMarkdownImportStatus();
      } catch {
        // 忽略
      }
    }

    if (scanResult && scanResult.status !== 'idle') {
      applyScanJob(scanResult);
      if (scanResult.status === 'running') {
        autoRecoveryRunningRef.current = true;
      } else if (isMarkdownJobTerminal(scanResult.status)) {
        autoRecoveryRunningRef.current = false;
      }
      if (scanResult.status === 'interrupted' && !isDismissedJob('scan', scanResult)) {
        setMarkdownError('上次扫描任务因进程重启中断。');
      }
    }
    if (importResult && importResult.status !== 'idle') {
      applyImportJob(importResult);
      if (importResult.status === 'running') {
        autoRecoveryRunningRef.current = true;
        setImportRestoreNotice('上次导入任务仍在运行，可查看进度或取消。');
      } else if (importResult.status === 'done' && importResult.report) {
        if (!isDismissedJob('import', importResult)) {
          setImportRestoreNotice(
            `上次导入完成：导入 ${importResult.report.imported} 篇、更新 ${importResult.report.updated} 篇。`
          );
        }
      } else if (importResult.status === 'interrupted') {
        if (!isDismissedJob('import', importResult)) {
          setImportRestoreNotice('上次导入任务因进程重启中断。');
        }
      }
    }

    // 已被用户关闭的终态任务不再自动恢复（用户明确不想继续）。
    const scanInterrupted =
      scanResult?.status === 'interrupted' &&
      scanResult.input?.vaultPath &&
      !isDismissedJob('scan', scanResult);
    const importInterrupted =
      importResult?.status === 'interrupted' &&
      importResult.input &&
      !isDismissedJob('import', importResult);
    if (importInterrupted && !pendingAutoImportInputRef.current) {
      pendingAutoImportInputRef.current = importResult!.input ?? null;
    }

    // 1) 先自动恢复扫描（如果同时中断，导入先排队）。
    if (
      scanInterrupted &&
      !autoRestartedScanRef.current &&
      !autoRecoveryRunningRef.current &&
      startMarkdownScan
    ) {
      autoRestartedScanRef.current = true;
      autoRecoveryRunningRef.current = true;
      setMarkdownError('检测到中断，正在自动重新开始上次扫描…');
      try {
        applyScanJob(await startMarkdownScan(scanResult!.input!.vaultPath));
      } catch (error) {
        autoRecoveryRunningRef.current = false;
        setMarkdownError(
          `自动重新开始扫描失败：${error instanceof Error ? error.message : String(error)}`
        );
      }
      return;
    }

    // 2) 扫描终态后，自动启动排队的导入。
    if (
      scanResult &&
      isMarkdownJobTerminal(scanResult.status) &&
      autoRestartedScanRef.current &&
      pendingAutoImportInputRef.current &&
      !autoRestartedImportRef.current &&
      !autoRecoveryRunningRef.current &&
      startMarkdownImport
    ) {
      const input = pendingAutoImportInputRef.current;
      pendingAutoImportInputRef.current = null;
      autoRestartedImportRef.current = true;
      autoRecoveryRunningRef.current = true;
      setImportRestoreNotice('检测到中断，正在自动重新开始上次导入…');
      try {
        applyImportJob(await startMarkdownImport(input));
      } catch (error) {
        autoRecoveryRunningRef.current = false;
        setImportRestoreNotice(
          `自动重新开始导入失败：${error instanceof Error ? error.message : String(error)}`
        );
      }
      return;
    }

    // 3) 只有导入中断（或扫描不需要自动恢复）时直接自动恢复导入。
    if (importInterrupted && !autoRestartedImportRef.current && !autoRecoveryRunningRef.current) {
      if (!startMarkdownImport) return;
      autoRestartedImportRef.current = true;
      autoRecoveryRunningRef.current = true;
      setImportRestoreNotice('检测到中断，正在自动重新开始上次导入…');
      try {
        applyImportJob(await startMarkdownImport(importResult!.input!));
      } catch (error) {
        autoRecoveryRunningRef.current = false;
        setImportRestoreNotice(
          `自动重新开始导入失败：${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  };

  useEffect(() => {
    void refreshJobStatuses();
    const onFocus = (): void => {
      void refreshJobStatuses();
    };
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') void refreshJobStatuses();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  // SSE 不可用/中断时的 10s 兜底轮询；onOpen 恢复后停止。
  useEffect(() => {
    if (!sseFallback) return;
    const timer = setInterval(() => {
      void refreshJobStatuses();
    }, 10_000);
    return () => clearInterval(timer);
  }, [sseFallback]);

  // SSE 实时任务快照：事件到达即更新两张任务卡片；onError 立即回退轮询，onOpen 恢复。
  useEffect(() => {
    if (!subscribeMarkdownJobs) {
      setSseFallback(true);
      return;
    }
    let unsubscribe: (() => void) | undefined;
    try {
      unsubscribe = subscribeMarkdownJobs(
        (snapshot) => {
          sseLastEventRef.current = Date.now();
          setSseFallback(false);
          setSseNotice('');
          // SSE 事件一律按 lite 合并：只更新进度，保留已有 scan/report；已关闭终态不弹回。
          applyScanJob(snapshot.scanJob);
          applyImportJob(snapshot.importJob);
          // terminal/interrupted（含 lite 终态）立即读取完整结果与 input。
          const forceFull =
            Boolean(snapshot.terminal) ||
            snapshot.scanJob.status === 'interrupted' ||
            snapshot.importJob.status === 'interrupted' ||
            (snapshot.lite &&
              (isMarkdownJobTerminal(snapshot.scanJob.status) ||
                isMarkdownJobTerminal(snapshot.importJob.status)));
          if (forceFull) {
            void fetchFullMarkdownJobs();
          }
        },
        {
          onOpen: () => {
            sseAvailableRef.current = true;
            sseLastEventRef.current = Date.now();
            setSseFallback(false);
            setSseNotice('');
          },
          onError: () => {
            sseAvailableRef.current = false;
            setSseFallback(true);
            setSseNotice('实时连接已达上限/中断，已切换轮询。');
          }
        }
      );
    } catch {
      setSseFallback(true);
      setSseNotice('实时连接已达上限/中断，已切换轮询。');
    }
    return () => {
      unsubscribe?.();
    };
  }, []);

  // running 时 10s 无 SSE 事件视为静默失效，回退轮询并提示。
  useEffect(() => {
    if (!subscribeMarkdownJobs) return;
    const timer = setInterval(() => {
      const running =
        jobsRunningRef.current || scanJob?.status === 'running' || restoredImportJob?.status === 'running';
      if (!running) return;
      if (sseAvailableRef.current && Date.now() - sseLastEventRef.current > 10_000) {
        sseAvailableRef.current = false;
        setSseFallback(true);
        setSseNotice('实时连接中断，已切换轮询。');
      }
    }, 3000);
    return () => clearInterval(timer);
  }, [scanJob?.status, restoredImportJob?.status]);

  // 扫描终态时显式触发排队的自动导入（手动扫描也会继续未完成导入）。
  useEffect(() => {
    if (!scanJob || !isMarkdownJobTerminal(scanJob.status)) return;
    const input = pendingAutoImportInputRef.current;
    if (!input) {
      autoRecoveryRunningRef.current = false;
      return;
    }
    if (autoRestartedImportRef.current || !startMarkdownImport) return;
    autoRecoveryRunningRef.current = true;
    pendingAutoImportInputRef.current = null;
    autoRestartedImportRef.current = true;
    void (async () => {
      // 排队期间状态可能已变化；启动前重新校验，避免用过期 input 多跑一次。
      if (getMarkdownImportStatus) {
        try {
          const current = await getMarkdownImportStatus();
          if (current && current.status !== 'interrupted') {
            autoRecoveryRunningRef.current = false;
            setImportRestoreNotice('上次导入状态已变化，已跳过自动重开。');
            return;
          }
        } catch {
          // 状态查询失败仍按原队列尝试，启动失败会显示错误。
        }
      }
      setImportRestoreNotice('扫描完成，继续上次未完成的导入…');
      try {
        const job = await startMarkdownImport(input);
        applyImportJob(job);
      } catch (error) {
        autoRecoveryRunningRef.current = false;
        setImportRestoreNotice(
          `自动重新开始导入失败：${error instanceof Error ? error.message : String(error)}`
        );
      }
    })();
  }, [scanJob?.status, getMarkdownImportStatus, startMarkdownImport]);

  const restartInterruptedScan = async (): Promise<void> => {
    let input = scanJob?.input;
    if (!input?.vaultPath && getMarkdownScanStatus) {
      try {
        const job = await getMarkdownScanStatus();
        applyScanJob(job);
        input = job.input;
      } catch {
        // 使用现有状态
      }
    }
    if (!startMarkdownScan || !input?.vaultPath) return;
    pendingAutoImportInputRef.current = null;
    autoRecoveryRunningRef.current = true;
    try {
      setMarkdownError('');
      const job = await startMarkdownScan(input.vaultPath);
      applyScanJob(job);
    } catch (error) {
      autoRecoveryRunningRef.current = false;
      setMarkdownError(
        `重新开始扫描失败：${error instanceof Error ? error.message : String(error)}`
      );
    }
  };

  const restartInterruptedImport = async (): Promise<void> => {
    let input = restoredImportJob?.input;
    if (!input && getMarkdownImportStatus) {
      try {
        const job = await getMarkdownImportStatus();
        applyImportJob(job);
        input = job.input;
      } catch {
        // 使用现有状态
      }
    }
    if (!startMarkdownImport || !input) return;
    pendingAutoImportInputRef.current = null;
    autoRecoveryRunningRef.current = true;
    try {
      const job = await startMarkdownImport(input);
      applyImportJob(job);
      setImportRestoreNotice('已重新开始上次导入。');
    } catch (error) {
      autoRecoveryRunningRef.current = false;
      setImportRestoreNotice(
        `重新开始导入失败：${error instanceof Error ? error.message : String(error)}`
      );
    }
  };

  const openRestoredImport = async (): Promise<void> => {
    setFullResultError('');
    let job = restoredImportJob;
    if (job && job.status === 'done' && !job.report && getMarkdownImportStatus) {
      try {
        job = await getMarkdownImportStatus();
        applyImportJob(job!);
      } catch (error) {
        setFullResultError(
          `读取完整导入结果失败：${
            error instanceof Error ? error.message : String(error)
          }`
        );
        fullResultRetryRef.current = () => void openRestoredImport();
        return;
      }
    }
    const report = job?.report ?? null;
    const vaultPath = report?.vaultPath ?? '';
    setMarkdownScan({
      vaultPath,
      vaultName: '',
      notes: [],
      attachments: []
    });
    setMarkdownDialogOpen(true);
  };

  const openScanSelection = async (): Promise<void> => {
    setFullResultError('');
    let job = scanJob;
    if (job && job.status === 'done' && !job.scan && getMarkdownScanStatus) {
      try {
        job = await getMarkdownScanStatus();
        applyScanJob(job!);
      } catch (error) {
        setFullResultError(
          `读取完整扫描结果失败：${
            error instanceof Error ? error.message : String(error)
          }`
        );
        fullResultRetryRef.current = () => void openScanSelection();
        return;
      }
    }
    if (job?.scan) {
      setMarkdownScan(job.scan);
      setMarkdownDialogOpen(true);
    }
  };

  const closeMarkdownDialog = (report?: MarkdownImportReport | null): void => {
    setMarkdownDialogOpen(false);
    setMarkdownScan(null);
    setMarkdownError('');
    if (!report) return;
    setImportRestoreNotice(
      `上次导入完成：导入 ${report.imported} 篇、更新 ${report.updated} 篇${
        (report.skippedExisting ?? 0) > 0 ? `、跳过已存在 ${report.skippedExisting} 篇` : ''
      }。`
    );
    onMarkdownImported?.(report);
    // 用报告生成的任务卡只作兜底；优先读取服务端完整状态（含 input/完成时间），
    // 这样「关闭卡片」记下的指纹与之后的轮询/SSE 完全一致，不会被再次弹回。
    const fallbackJob: MarkdownImportJob = {
      status: 'done',
      phase: 'finalizing',
      total: report.requested,
      done: report.requested,
      currentPath: '',
      report,
      error: ''
    };
    if (!getMarkdownImportStatus) {
      applyImportJob(fallbackJob);
      return;
    }
    void getMarkdownImportStatus()
      .then((job) => applyImportJob(job && job.status !== 'idle' ? job : fallbackJob))
      .catch(() => applyImportJob(fallbackJob));
  };

  const renderFolderInlineEditor = (
    mode: 'create' | 'rename',
    targetPath: string,
    parentPath = ''
  ): React.JSX.Element | null => {
    if (!folderEditor) return null;
    if (mode === 'create') {
      if (folderEditor.mode !== 'create' || folderEditor.parent !== parentPath) return null;
    } else if (folderEditor.mode !== 'rename' || folderEditor.path !== targetPath) {
      return null;
    }
    const value = folderEditor.value;
    const error = folderEditor.error;
    const merging = folderEditor.mode === 'rename' && folderEditor.merging;
    return (
      <div className="kr-standalone__inline-editor">
        <input
          autoFocus
          value={value}
          aria-label={mode === 'create' ? '新文件夹名' : '新文件夹路径'}
          placeholder="文件夹名（可含 / 多级）"
          onChange={(event) =>
            setFolderEditor(
              folderEditor.mode === 'create'
                ? { ...folderEditor, value: event.target.value, error: '' }
                : {
                    ...folderEditor,
                    value: event.target.value,
                    error: '',
                    merging: false
                  }
            )
          }
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              submitFolderEditor();
            } else if (event.key === 'Escape') {
              event.preventDefault();
              setFolderEditor(null);
            }
          }}
        />
        {merging ? (
          <span className="kr-standalone__inline-warning">
            目标文件夹已存在，确认会「合并到目标文件夹」；同路径笔记会共存，不会自动合并内容。
          </span>
        ) : null}
        {error ? <span className="kr-page-error">{error}</span> : null}
        {merging ? (
          <button type="button" className="kr-primary" onClick={confirmFolderMerge}>
            确认合并
          </button>
        ) : (
          <button type="button" className="kr-primary" onClick={submitFolderEditor}>
            确定
          </button>
        )}
        <button type="button" onClick={() => setFolderEditor(null)}>
          取消
        </button>
      </div>
    );
  };

  const renderNoteItem = (note: NoteRecord): React.JSX.Element => {
    const title = standaloneNoteTitle(note.content);
    const isActive = note.id === selectedId;
    const checked = selectedNoteIds.has(note.id);
    const isRenaming = renamingNote?.id === note.id;
    const dropBefore = dragTargetNote?.id === note.id && dragTargetNote.position === 'before';
    const dropAfter = dragTargetNote?.id === note.id && dragTargetNote.position === 'after';
    const currentFolder = noteFolderPath(note);
    const moveTargets = allFolderPaths.filter((path) => path !== currentFolder);
    return (
      <li
        key={note.id}
        className={`kr-standalone__item${checked ? ' is-selected' : ''}${
          dropBefore ? ' is-drop-before' : ''
        }${dropAfter ? ' is-drop-after' : ''}`}
        draggable={Boolean(onMoveNote || onReorderNotes) && !isRenaming}
        onDragStart={(event) => {
          setDragNoteId(note.id);
          setDragTargetNote(null);
          event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData('text/plain', note.id);
        }}
        onDragEnd={() => {
          setDragNoteId(null);
          setDragTarget(null);
          setDragTargetNote(null);
        }}
        onDragOver={(event) => {
          if (!dragNoteId || dragNoteId === note.id) return;
          event.preventDefault();
          event.stopPropagation();
          event.dataTransfer.dropEffect = 'move';
          const rect = event.currentTarget.getBoundingClientRect();
          const position: 'before' | 'after' =
            event.clientY > rect.top + rect.height / 2 ? 'after' : 'before';
          setDragTarget(null);
          setDragTargetNote({ id: note.id, position });
        }}
        onDragLeave={(event) => {
          if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
          setDragTargetNote((current) => (current?.id === note.id ? null : current));
        }}
        onDrop={(event) => {
          if (!dragNoteId) return;
          event.preventDefault();
          event.stopPropagation();
          const rect = event.currentTarget.getBoundingClientRect();
          const position: 'before' | 'after' =
            event.clientY > rect.top + rect.height / 2 ? 'after' : 'before';
          void dropNoteOnNote(note, position);
        }}
      >
        <div className="kr-standalone__item-row">
          <input
            type="checkbox"
            className="kr-standalone__select"
            checked={checked}
            aria-label={`选择笔记 ${title}`}
            onChange={() => toggleNoteSelection(note.id)}
          />
          {isRenaming ? (
            <span className="kr-standalone__rename">
              <input
                autoFocus
                value={renamingNote?.value ?? ''}
                aria-label="重命名笔记（改写正文第一行标题）"
                placeholder="笔记标题"
                onChange={(event) =>
                  setRenamingNote((current) =>
                    current ? { ...current, value: event.target.value, error: '' } : current
                  )
                }
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    void commitRenameNote();
                  } else if (event.key === 'Escape') {
                    event.preventDefault();
                    cancelRenameNote();
                  }
                }}
                onBlur={() => {
                  if (renamingNote?.error) return;
                  cancelRenameNote();
                }}
              />
              {renamingNote?.error ? (
                <span className="kr-page-error">{renamingNote.error}</span>
              ) : null}
            </span>
          ) : (
            <button
              type="button"
              className={`kr-standalone__open${isActive ? ' is-active' : ''}`}
              title={title}
              onClick={() => onSelect(note.id)}
            >
              <span className="kr-standalone__title">{title}</span>
              <small>
                {new Date(note.created).toLocaleDateString()} ·{' '}
                {note.content.replace(/\s+/g, '').length} 字
                {note.folderPath ? ` · ${note.folderPath}` : ''}
              </small>
              {(note.tags ?? []).length > 0 ? (
                <span className="kr-standalone__tags">
                  {(note.tags ?? []).map((tag) => (
                    <span key={tag} className="kr-standalone__tag">
                      {tag}
                    </span>
                  ))}
                </span>
              ) : null}
            </button>
          )}
          {!isRenaming ? (
            <span className="kr-standalone__item-actions">
              {onMoveNote ? (
                <select
                  className="kr-standalone__item-move"
                  value=""
                  title="移动到…"
                  aria-label={`移动笔记 ${title} 到文件夹`}
                  onChange={(event) => {
                    const target = event.target.value;
                    if (!target) return;
                    moveNoteToFolder(note.id, folderOptionToPath(target));
                  }}
                >
                  <option value="">移动到…</option>
                  {currentFolder ? (
                    <option value={ROOT_FOLDER_OPTION_VALUE}>根目录</option>
                  ) : null}
                  {moveTargets.map((path) => (
                    <option key={path} value={path}>
                      {path}
                    </option>
                  ))}
                </select>
              ) : null}
              <button
                type="button"
                className="kr-standalone__icon-btn"
                title="重命名（改写正文第一行标题）"
                aria-label={`重命名笔记 ${title}`}
                onClick={() => beginRenameNote(note)}
              >
                ✎
              </button>
              <button
                type="button"
                className="kr-standalone__icon-btn"
                title="移入回收站（可恢复）"
                aria-label={`将笔记 ${title} 移入回收站`}
                disabled={deleting}
                onClick={() => onDelete(note.id)}
              >
                移除
              </button>
            </span>
          ) : null}
        </div>
        {loadBacklinks ? (
          <Backlinks
            target={{ kind: 'note', documentId: '', id: note.id }}
            loadBacklinks={loadBacklinks}
            onOpenBacklink={onOpenBacklink}
          />
        ) : null}
      </li>
    );
  };

  const renderFolder = (folder: StandaloneFolder, depth: number): React.JSX.Element => {
    const collapsed = isFolderCollapsed(folder.path);
    const renameEditor = renderFolderInlineEditor('rename', folder.path);
    const dropActive = dragTarget === folder.path;
    const childCreateEditor = renderFolderInlineEditor('create', '', folder.path);
    return (
      <li
        key={`folder:${folder.path}`}
        className={`kr-standalone__folder${dropActive ? ' is-drop-target' : ''}`}
        onDragOver={(event) => {
          if (!dragNoteId) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'move';
          setDragTargetNote(null);
          setDragTarget(folder.path);
        }}
        onDragLeave={(event) => {
          if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
          setDragTarget((current) => (current === folder.path ? null : current));
        }}
        onDrop={(event) => {
          event.preventDefault();
          event.stopPropagation();
          const noteId = dragNoteId || event.dataTransfer.getData('text/plain');
          if (noteId) moveNoteToFolder(noteId, folder.path);
          setDragNoteId(null);
          setDragTarget(null);
          setDragTargetNote(null);
        }}
      >
        {renameEditor ? (
          renameEditor
        ) : (
          <div
            className="kr-standalone__folder-row"
            style={{ paddingLeft: `${depth * 14}px` }}
          >
            <button
              type="button"
              className="kr-standalone__folder-head"
              aria-expanded={!collapsed}
              onClick={() => toggleFolderCollapsed(folder.path)}
              title={folder.path}
            >
              <span className="kr-standalone__folder-caret" aria-hidden="true">
                {collapsed ? '▸' : '▾'}
              </span>
              <span className="kr-standalone__folder-name">{folder.name}</span>
              <small className="kr-muted">{folder.totalCount} 篇</small>
            </button>
            <span className="kr-standalone__folder-actions">
              {onCreateFolder ? (
                <button
                  type="button"
                  title="新建子文件夹"
                  aria-label={`在 ${folder.path} 下新建子文件夹`}
                  onClick={() => openCreateFolderEditor(folder.path)}
                >
                  ＋
                </button>
              ) : null}
              {onRenameFolder ? (
                <button
                  type="button"
                  title="重命名文件夹"
                  aria-label={`重命名 ${folder.path}`}
                  onClick={() => openRenameFolderEditor(folder.path)}
                >
                  ✎
                </button>
              ) : null}
              {onDeleteFolder ? (
                <button
                  type="button"
                  title="删除文件夹"
                  aria-label={`删除 ${folder.path}`}
                  onClick={() => setFolderDelete(folder.path)}
                >
                  ×
                </button>
              ) : null}
            </span>
          </div>
        )}
        {folderDelete === folder.path ? (
          <div className="kr-standalone__inline-confirm" role="alert">
            <span>
              删除文件夹「{folder.path}」后，其中笔记会移到上一级/根目录，子文件夹会上移一级。
              {folder.totalCount > 0
                ? `（该文件夹及子文件夹共 ${folder.totalCount} 篇笔记，不会丢失。）`
                : '（当前没有笔记。）'}
            </span>
            <button type="button" className="kr-primary" onClick={confirmDeleteFolder}>
              删除
            </button>
            <button type="button" onClick={() => setFolderDelete(null)}>
              取消
            </button>
          </div>
        ) : null}
        {collapsed ? null : (
          <ul className="kr-standalone__sublist">
            {childCreateEditor}
            {folder.notes.map(renderNoteItem)}
            {folder.children.map((child) => renderFolder(child, depth + 1))}
          </ul>
        )}
      </li>
    );
  };

  return (
    <section
      className="kr-standalone"
      aria-label="独立笔记"
      onKeyDown={(event) => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
          event.preventDefault();
          save();
        }
      }}
    >
      <header className="kr-standalone__head">
        <span
          className="kr-muted kr-standalone__hint"
          title="删除的笔记/批注会进入回收站，可恢复或彻底删除；只有彻底删除才会清理仅被它引用的图片。"
        >
          删除的笔记/批注会进入回收站，可恢复或彻底删除；只有彻底删除才会清理仅被它引用的图片。
        </span>
        <div className="kr-standalone__head-actions">
          <button
            type="button"
            className="kr-ghost kr-standalone__sidebar-toggle"
            aria-expanded={!sidebarCollapsed}
            aria-controls="kr-standalone-sidebar"
            title={sidebarCollapsed ? '展开笔记文件夹栏' : '收起笔记文件夹栏'}
            onClick={() => setSidebarCollapsed((current) => !current)}
          >
            {sidebarCollapsed ? '展开笔记列表' : '收起笔记列表'}
          </button>
          <button
            type="button"
            className={`kr-ghost${scanJob?.status === 'running' ? ' is-busy' : ''}`}
            onClick={() => void beginMarkdownImport()}
            disabled={markdownBusy !== null || scanJob?.status === 'running'}
            title="选择笔记文件夹并导入 Markdown 笔记（图片会自动复制，其他附件会复制为本地附件）"
          >
            {markdownBusy === 'picking'
              ? '选择目录…'
              : scanJob?.status === 'running'
                ? `正在扫描…（已扫描 ${scanJob.done} 个文件）`
                : markdownBusy === 'scanning'
                  ? '正在扫描…'
                  : '导入 Markdown 笔记'}
          </button>
          <button type="button" className="kr-primary" onClick={onCreate} disabled={creating}>
            {creating ? '新建中…' : '+ 新建笔记'}
          </button>
        </div>
      </header>
      {markdownError ? (
        <p className="kr-page-error" role="alert">
          {markdownError}
          {scanPollExhausted ? (
            <button type="button" className="kr-link-button" onClick={retryScanStatus}>
              重试状态
            </button>
          ) : null}
          <button
            type="button"
            className="kr-link-button"
            onClick={() => {
              setMarkdownError('');
              setScanPollExhausted(false);
            }}
          >
            关闭
          </button>
        </p>
      ) : null}
      {sseNotice ? (
        <p className="kr-job-stream-notice" role="status">
          {sseNotice}
        </p>
      ) : null}
      {statusFetchError ? (
        <p className="kr-job-status-error" role="alert">
          {statusFetchError}
          <button type="button" className="kr-link-button" onClick={retryStatusFetch}>
            重试
          </button>
          <button
            type="button"
            className="kr-link-button"
            onClick={() => setStatusFetchError('')}
            aria-label="忽略状态读取错误"
          >
            忽略
          </button>
        </p>
      ) : null}
      {fullResultError ? (
        <p className="kr-job-status-error" role="alert">
          {fullResultError}
          <button
            type="button"
            className="kr-link-button"
            onClick={() => fullResultRetryRef.current?.()}
          >
            重试
          </button>
        </p>
      ) : null}
      {scanJob && scanJob.status !== 'idle' ? (
        <div
          className={`kr-job-card kr-job-card--scan is-${scanJob.status}${
            scanJob.status === 'running' ? ' is-prominent' : ''
          }`}
          role="status"
          aria-live={scanJob.status === 'running' ? 'polite' : 'off'}
        >
          <div className="kr-job-card__head">
            <strong>扫描任务</strong>
            <span className="kr-muted">
              {scanJob.status === 'running'
                ? '运行中'
                : scanJob.status === 'done'
                  ? '已完成'
                  : scanJob.status === 'interrupted'
                    ? '因重启中断'
                    : scanJob.status === 'cancelled'
                      ? '已取消'
                      : '失败'}
            </span>
            {scanJob.status !== 'running' ? (
              <button
                type="button"
                className="kr-link-button"
                onClick={() => {
                  rememberDismissedJob('scan', scanJob);
                  commitScanJob(null);
                  setMarkdownError('');
                  setScanPollExhausted(false);
                }}
              >
                关闭
              </button>
            ) : null}
          </div>
          {scanJob.status === 'running' ? (
            <>
              <p className="kr-job-card__count">
                已扫描 <strong>{scanJob.done}</strong> 个文件
                {scanJob.total > 0 ? `（共 ${scanJob.total} 个，${scanPercent}%）` : '（总数统计中…）'}
              </p>
              <progress
                className="kr-job-card__progress"
                value={
                  scanJob.total > 0
                    ? Math.min(scanJob.done, Math.max(1, scanJob.total))
                    : undefined
                }
                max={scanJob.total > 0 ? Math.max(1, scanJob.total) : undefined}
                aria-label="扫描笔记库进度"
              />
              <p className="kr-job-card__path" title={scanJob.currentPath}>
                当前：{scanJob.currentPath || '准备中'}
              </p>
              {scanJob.input?.vaultPath ? (
                <p className="kr-muted kr-job-card__vault" title={scanJob.input.vaultPath}>
                  文件夹：{scanJob.input.vaultPath}
                </p>
              ) : null}
              <div className="kr-job-card__actions">
                <button
                  type="button"
                  onClick={() => void cancelCurrentScan()}
                  disabled={!cancelMarkdownScan}
                >
                  取消扫描
                </button>
              </div>
            </>
          ) : scanJob.status === 'done' || isMarkdownResultMissing(scanJob) ? (
            isMarkdownResultMissing(scanJob) ? (
              <p className="kr-page-error" role="alert">
                任务已完成，但结果文件缺失/损坏。
                {scanJob.input && startMarkdownScan ? (
                  <button
                    type="button"
                    className="kr-link-button"
                    onClick={() => void restartInterruptedScan()}
                  >
                    重新扫描
                  </button>
                ) : null}
              </p>
            ) : (
              <p>
                扫描完成：{scanJob.scan?.notes.length ?? scanJob.total ?? 0} 篇 Markdown、
                {scanJob.scan?.attachments.length ?? 0} 个附件。
                <button
                  type="button"
                  className="kr-link-button"
                  onClick={() => void openScanSelection()}
                >
                  查看选择
                </button>
              </p>
            )
          ) : (
            <p className="kr-page-error" role="alert">
              {scanJob.status === 'interrupted'
                ? '上次扫描任务因进程重启中断。'
                : scanJob.status === 'cancelled'
                  ? '扫描已取消。'
                  : `扫描失败：${scanJob.error || '未知错误'}`}
              {scanJob.input && startMarkdownScan ? (
                <button
                  type="button"
                  className="kr-link-button"
                  onClick={() => void restartInterruptedScan()}
                >
                  重新开始上次扫描
                </button>
              ) : null}
            </p>
          )}
          {markdownJobStaleHint(scanJob) ? (
            <p className="kr-muted">{markdownJobStaleHint(scanJob)}</p>
          ) : null}
        </div>
      ) : null}
      {restoredImportJob && restoredImportJob.status !== 'idle' ? (
        <div
          className={`kr-job-card kr-job-card--import is-${restoredImportJob.status}${
            restoredImportJob.status === 'running' ? ' is-prominent' : ''
          }`}
          role="status"
          aria-live={restoredImportJob.status === 'running' ? 'polite' : 'off'}
        >
          <div className="kr-job-card__head">
            <strong>导入任务</strong>
            <span className="kr-muted">
              {restoredImportJob.status === 'running'
                ? '运行中'
                : restoredImportJob.status === 'done'
                  ? '已完成'
                  : restoredImportJob.status === 'interrupted'
                    ? '因重启中断'
                    : restoredImportJob.status === 'cancelled'
                      ? '已取消'
                      : '失败'}
            </span>
            {restoredImportJob.status !== 'running' ? (
              <button
                type="button"
                className="kr-link-button"
                onClick={() => {
                  rememberDismissedJob('import', restoredImportJob);
                  commitImportJob(null);
                  setImportRestoreNotice('');
                }}
              >
                关闭
              </button>
            ) : null}
          </div>
          {importRestoreNotice ? <p className="kr-muted">{importRestoreNotice}</p> : null}
          {restoredImportJob.status === 'running' ? (
            <>
              <p className="kr-job-card__count">
                已处理 <strong>{restoredImportJob.done}</strong>
                {restoredImportJob.total > 0 ? ` / ${restoredImportJob.total}` : ''} 篇
                {restoredImportJob.total > 0
                  ? `（${Math.round(
                      (restoredImportJob.done / restoredImportJob.total) * 100
                    )}%）`
                  : ''}
              </p>
              <progress
                className="kr-job-card__progress"
                value={Math.min(
                  restoredImportJob.done,
                  Math.max(1, restoredImportJob.total)
                )}
                max={Math.max(1, restoredImportJob.total)}
                aria-label="导入笔记进度"
              />
              {restoredImportJob.currentPath ? (
                <p className="kr-job-card__path" title={restoredImportJob.currentPath}>
                  当前：{restoredImportJob.currentPath}
                </p>
              ) : null}
              <div className="kr-job-card__actions">
                <button
                  type="button"
                  onClick={() => void openRestoredImport()}
                >
                  查看导入进度
                </button>
                {cancelMarkdownImport ? (
                  <button
                    type="button"
                    onClick={() => void cancelRestoredImport()}
                  >
                    取消导入
                  </button>
                ) : null}
              </div>
            </>
          ) : restoredImportJob.status === 'done' || isMarkdownResultMissing(restoredImportJob) ? (
            isMarkdownResultMissing(restoredImportJob) ? (
              <p className="kr-page-error" role="alert">
                任务已完成，但结果文件缺失/损坏。
                {restoredImportJob.input && startMarkdownImport ? (
                  <button
                    type="button"
                    className="kr-link-button"
                    onClick={() => void restartInterruptedImport()}
                  >
                    重新导入
                  </button>
                ) : null}
              </p>
            ) : (
              <p>
                上次导入完成：
                {restoredImportJob.report
                  ? `导入 ${restoredImportJob.report.imported} 篇、更新 ${restoredImportJob.report.updated} 篇${
                      (restoredImportJob.report.skippedExisting ?? 0) > 0
                        ? `、跳过已存在 ${restoredImportJob.report.skippedExisting} 篇`
                        : ''
                    }。`
                  : '结果已生成。'}
                <button
                  type="button"
                  className="kr-link-button"
                  onClick={() => void openRestoredImport()}
                >
                  查看上次导入
                </button>
              </p>
            )
          ) : (
            <p className="kr-page-error" role="alert">
              {restoredImportJob.status === 'interrupted'
                ? '上次导入任务因进程重启中断。'
                : restoredImportJob.status === 'cancelled'
                  ? '导入已取消。'
                  : `导入失败：${restoredImportJob.error || '未知错误'}`}
              {restoredImportJob.input && startMarkdownImport ? (
                <button
                  type="button"
                  className="kr-link-button"
                  onClick={() => void restartInterruptedImport()}
                >
                  重新开始上次导入
                </button>
              ) : null}
            </p>
          )}
          {markdownJobStaleHint(restoredImportJob) ? (
            <p className="kr-muted">{markdownJobStaleHint(restoredImportJob)}</p>
          ) : null}
        </div>
      ) : null}

      <div
        className={`kr-standalone__body${
          sidebarCollapsed ? ' is-sidebar-collapsed' : ''
        }${narrowNotesLayout && !sidebarCollapsed ? ' is-drawer-open' : ''}`}
      >
        {narrowNotesLayout && !sidebarCollapsed ? (
          <button
            type="button"
            className="kr-standalone__sidebar-backdrop"
            aria-label="收起笔记文件夹栏"
            onClick={() => setSidebarCollapsed(true)}
          />
        ) : null}
        {sidebarCollapsed ? null : (
        <div className="kr-standalone__sidebar" id="kr-standalone-sidebar">
          <div className="kr-standalone__sidebar-head">
            <span className="kr-standalone__sidebar-label">笔记文件夹</span>
            <div className="kr-standalone__sidebar-actions">
              <button
                type="button"
                className="kr-ghost"
                aria-expanded={true}
                aria-controls="kr-standalone-sidebar"
                onClick={() => setSidebarCollapsed(true)}
                title="收起笔记文件夹栏，让编辑器占满宽度"
              >
                收起
              </button>
              {onCreateFolder ? (
                <button
                  type="button"
                  className="kr-ghost"
                  onClick={() => openCreateFolderEditor('')}
                  title="新建文件夹（可含 / 多级）"
                >
                  新建文件夹
                </button>
              ) : null}
              <button
                type="button"
                className="kr-ghost"
                onClick={() => toggleTrash(!showTrash)}
                aria-pressed={showTrash}
                title="查看已移入回收站的独立笔记"
              >
                {showTrash ? '返回笔记' : '回收站'}
              </button>
            </div>
          </div>
          {folderMessage ? (
            <p className="kr-page-error" role="alert">
              {folderMessage}
            </p>
          ) : null}
          {!showTrash ? renderFolderInlineEditor('create', '', '') : null}
          {!showTrash && dragNoteId ? (
            <div
              className={`kr-standalone__drop-root${
                dragTarget === '' ? ' is-drop-target' : ''
              }`}
              onDragOver={(event) => {
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
                setDragTargetNote(null);
                setDragTarget('');
              }}
              onDragLeave={() =>
                setDragTarget((current) => (current === '' ? null : current))
              }
              onDrop={(event) => {
                event.preventDefault();
                event.stopPropagation();
                const noteId = dragNoteId || event.dataTransfer.getData('text/plain');
                if (noteId) moveNoteToFolder(noteId, '');
                setDragNoteId(null);
                setDragTarget(null);
                setDragTargetNote(null);
              }}
            >
              拖到此处移动到根目录
            </div>
          ) : null}
          {showTrash ? (
            <div className="kr-standalone__trash">
              {trashLoading ? (
                <p className="kr-muted kr-standalone__hint">正在读取回收站…</p>
              ) : trashNotes.length === 0 ? (
                <div className="kr-standalone__empty">
                  <p>回收站为空。</p>
                  <p className="kr-muted">移入回收站的独立笔记会显示在这里。</p>
                </div>
              ) : (
                <ul className="kr-standalone__list">
                  {trashNotes.map((note) => {
                    const title = standaloneNoteTitle(note.content);
                    return (
                      <li key={note.id} className="kr-standalone__item">
                        <div className="kr-standalone__open kr-standalone__open--trash" title={title}>
                          <span className="kr-standalone__title">{title}</span>
                          <small>已移入回收站 · {new Date(note.created).toLocaleDateString()}</small>
                        </div>
                        <div className="kr-standalone__trash-actions">
                          <button type="button" onClick={() => onRestore(note.id)}>
                            恢复
                          </button>
                          <button
                            type="button"
                            onClick={() => purge(note.id)}
                            title="彻底删除这条独立笔记（不可恢复，并回收只被它引用的图片资源）"
                          >
                            彻底删除
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          ) : loading ? (
            <p className="kr-muted kr-standalone__hint">正在读取独立笔记…</p>
          ) : error ? (
            <p className="kr-page-error" role="alert">
              {error}
              {onRetry ? (
                <button type="button" className="kr-link-button" onClick={onRetry}>
                  重试
                </button>
              ) : null}
            </p>
          ) : notes.length === 0 && folders.length === 0 ? (
            <div className="kr-standalone__empty">
              <p>还没有独立笔记。</p>
              <p className="kr-muted">点右上角「新建笔记」记录不依附文献的想法。</p>
            </div>
          ) : (
            <>
              <label className="kr-standalone__search">
                <input
                  type="search"
                  value={search}
                  placeholder="搜索独立笔记标题或内容"
                  aria-label="搜索独立笔记"
                  onChange={(event) => setSearch(event.target.value)}
                />
              </label>
              {tags.length > 0 ? (
                <div className="kr-standalone__tag-filter" role="group" aria-label="按标签筛选笔记">
                  <span className="kr-standalone__tag-filter-label">标签</span>
                  {tags.map((tag) => (
                    <button
                      key={tag}
                      type="button"
                      className={`kr-standalone__tag-filter-item${
                        tagFilter.has(tag) ? ' is-active' : ''
                      }`}
                      aria-pressed={tagFilter.has(tag)}
                      onClick={() => toggleTag(tag)}
                    >
                      {tag}
                    </button>
                  ))}
                  {tagFilter.size > 0 ? (
                    <button
                      type="button"
                      className="kr-link-button"
                      onClick={() => setTagFilter(new Set())}
                    >
                      清除标签筛选
                    </button>
                  ) : null}
                </div>
              ) : null}
              {noteActionNotice ? (
                <p className="kr-muted kr-standalone__action-notice" role="status">
                  {noteActionNotice}
                  <button
                    type="button"
                    className="kr-link-button"
                    onClick={() => setNoteActionNotice('')}
                    aria-label="忽略操作提示"
                  >
                    忽略
                  </button>
                </p>
              ) : null}
              <div
                className={`kr-standalone__bulkbar${selectedNoteIds.size > 0 ? ' is-active' : ''}`}
                role="toolbar"
                aria-label="笔记多选与批量操作"
              >
                <label className="kr-standalone__bulk-all" title="全选当前筛选结果">
                  <input
                    type="checkbox"
                    checked={allVisibleSelected}
                    ref={(element) => {
                      if (element) element.indeterminate = someVisibleSelected && !allVisibleSelected;
                    }}
                    aria-label="全选当前筛选结果"
                    onChange={() =>
                      allVisibleSelected ? clearNoteSelection() : selectAllVisibleNotes()
                    }
                  />
                  全选
                </label>
                <span className="kr-muted">已选 {selectedNoteIds.size} 篇</span>
                {selectedNoteIds.size > 0 ? (
                  <>
                    {onBatchMoveNotes ? (
                      <select
                        className="kr-standalone__bulk-move"
                        value=""
                        aria-label={`批量移动已选 ${selectedNoteIds.size} 篇笔记`}
                        title="批量移动到…"
                        disabled={batchBusy}
                        onChange={(event) => {
                          const target = event.target.value;
                          if (!target) return;
                          void batchMoveSelected(folderOptionToPath(target));
                        }}
                      >
                        <option value="">移动到…</option>
                        <option value={ROOT_FOLDER_OPTION_VALUE}>根目录</option>
                        {allFolderPaths.map((path) => (
                          <option key={path} value={path}>
                            {path}
                          </option>
                        ))}
                      </select>
                    ) : null}
                    {onBatchDeleteNotes ? (
                      <button
                        type="button"
                        className="kr-standalone__bulk-delete"
                        disabled={batchBusy}
                        title="批量移入回收站（可恢复）"
                        onClick={() => void batchDeleteSelected()}
                      >
                        {batchBusy ? '处理中…' : `移入回收站（${selectedNoteIds.size}）`}
                      </button>
                    ) : null}
                    <button type="button" onClick={clearNoteSelection} disabled={batchBusy}>
                      取消选择
                    </button>
                  </>
                ) : (
                  <span className="kr-muted kr-standalone__bulk-hint">
                    勾选笔记可批量移动或删除；拖动笔记可调整顺序。
                  </span>
                )}
              </div>
              {!folderTree || folderTree.totalCount === 0 ? (
                <div className="kr-standalone__empty">
                  <p>没有匹配的独立笔记。</p>
                  <p className="kr-muted">换个关键词，或清除搜索查看全部笔记。</p>
                  <button
                    type="button"
                    className="kr-ghost"
                    onClick={() => setSearch('')}
                  >
                    清除搜索
                  </button>
                </div>
              ) : (
                <ul className="kr-standalone__list">
                  {folderTree?.notes.map(renderNoteItem)}
                  {folderTree?.children.map((child) => renderFolder(child, 0))}
                </ul>
              )}
            </>
          )}
        </div>
        )}

        <div className="kr-standalone__editor">
          {showTrash ? (
            <div className="kr-standalone__placeholder">
              <p>回收站中的独立笔记不可编辑。</p>
              <p className="kr-muted">可在左侧「恢复」回笔记列表，或「彻底删除」并回收仅被它引用的图片。</p>
            </div>
          ) : selectedNote ? (
            <>
              <div className="kr-standalone__editor-head">
                <span
                  className="kr-standalone__editor-title"
                  title={standaloneNoteTitle(selectedNote.content)}
                >
                  {standaloneNoteTitle(selectedNote.content)}
                </span>
                <div className="kr-standalone__head-tools">
                  {onMoveNote ? (
                    <label className="kr-standalone__move" title="把这条笔记移动到其他文件夹">
                      文件夹
                      <select
                        value={noteFolderPath(selectedNote)}
                        onChange={(event) =>
                          moveNoteToFolder(selectedNote.id, event.target.value)
                        }
                      >
                        <option value="">根目录</option>
                        {allFolderPaths.map((path) => (
                          <option key={path} value={path}>
                            {path}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : (
                    <span
                      className="kr-muted kr-standalone__folder-badge"
                      title="这条笔记所在的文件夹（导入 Markdown 时保留层级）"
                    >
                      文件夹：{selectedNote.folderPath || '根目录'}
                    </span>
                  )}
                  <button
                    type="button"
                    className="kr-ghost kr-standalone__rename-trigger"
                    onClick={() => beginRenameNote(selectedNote)}
                    title="重命名：改写正文第一行标题（保留 # 层级）"
                  >
                    重命名
                  </button>
                  <span className="kr-standalone__tags">
                    {(selectedNote.tags ?? []).slice(0, 2).map((tag) => (
                      <span key={tag} className="kr-standalone__tag">
                        {tag}
                        {onSetTags ? (
                          <button
                            type="button"
                            className="kr-standalone__tag-remove"
                            aria-label={`移除标签 ${tag}`}
                            onClick={() => removeTag(tag)}
                            disabled={tagSaving}
                          >
                            ×
                          </button>
                        ) : null}
                      </span>
                    ))}
                    {(selectedNote.tags ?? []).length > 2 ? (
                      <span
                        className="kr-standalone__tag-more"
                        title={`其余标签：${(selectedNote.tags ?? []).slice(2).join('、')}`}
                      >
                        +{(selectedNote.tags ?? []).length - 2}
                      </span>
                    ) : null}
                  </span>
                  {onSetTags ? (
                    tagEditorOpen ? (
                      <input
                        className="kr-standalone__tag-input"
                        value={tagInput}
                        placeholder="新标签"
                        aria-label="添加标签"
                        autoFocus
                        disabled={tagSaving}
                        onChange={(event) => setTagInput(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            event.preventDefault();
                            addTag();
                            setTagEditorOpen(false);
                          } else if (event.key === 'Escape') {
                            event.preventDefault();
                            setTagInput('');
                            setTagEditorOpen(false);
                          }
                        }}
                        onBlur={() => {
                          if (tagInput.trim()) addTag();
                          setTagEditorOpen(false);
                        }}
                      />
                    ) : (
                      <button
                        type="button"
                        className="kr-ghost kr-standalone__tag-add"
                        onClick={() => setTagEditorOpen(true)}
                        title="为这条笔记添加标签"
                      >
                        + 标签
                      </button>
                    )
                  ) : null}
                  <span
                    className={`kr-standalone__state${dirty ? ' is-dirty' : ''}`}
                    role="status"
                  >
                    {dirty ? '未保存' : '已保存'}
                  </span>
                  <button
                    type="button"
                    className="kr-primary"
                    onClick={save}
                    disabled={!dirty || saving}
                    title="保存独立笔记（Ctrl+S）"
                  >
                    {saving ? '保存中…' : '保存'}
                  </button>
                  <button
                    type="button"
                    className="kr-ghost kr-standalone__trash"
                    onClick={remove}
                    disabled={deleting}
                    title="移入回收站（可恢复）"
                  >
                    {deleting ? '移动中…' : '移入回收站'}
                  </button>
                </div>
              </div>
              {tagError ? (
                <p className="kr-page-error kr-standalone__tag-error" role="alert">
                  {tagError}
                </p>
              ) : null}
              <MarkdownEditor
                key={selectedNote.id}
                value={draft}
                onChange={updateDraft}
                documents={documents}
                loadAnnotations={loadAnnotations}
                loadNotes={loadNotes}
                standaloneNotes={notes}
                uploadImage={uploadImage}
                onOpenInternal={onOpenInternal}
                onOpenAsset={onOpenAsset}
                rows={14}
                placeholder="写点想法…支持 Markdown、内部引用与图片"
                ariaLabel="独立笔记内容"
              />
            </>
          ) : (
            <div className="kr-standalone__placeholder">
              <p>选择左侧笔记开始编辑，或新建一条独立笔记。</p>
              {notes.length === 0 && !loading && !error ? (
                <p className="kr-muted">独立笔记不依附文献，适合记零散想法；支持 Markdown 与内部引用。</p>
              ) : null}
            </div>
          )}
        </div>
      </div>
      {markdownDialogOpen && markdownScan ? (
        <MarkdownImportDialog
          scan={markdownScan}
          initialJob={restoredImportJob}
          statusError={statusFetchError}
          onRetryStatus={retryStatusFetch}
          getMarkdownScanTree={getMarkdownScanTree}
          resolveMarkdownSelection={resolveMarkdownSelection}
          getMarkdownImportReportPage={getMarkdownImportReportPage}
          searchMarkdownScan={searchMarkdownScan}
          onRescan={() => {
            closeMarkdownDialog();
            void beginMarkdownImport();
          }}
          onClose={closeMarkdownDialog}
          onStartImport={(input) =>
            startMarkdownImport
              ? startMarkdownImport(input)
              : Promise.reject(new Error('当前运行环境不支持后台导入'))
          }
          previewMarkdownImportDuplicates={previewMarkdownImportDuplicates}
          onGetImportStatus={() =>
            getMarkdownImportStatus
              ? getMarkdownImportStatus()
              : Promise.reject(new Error('当前运行环境不支持读取导入进度'))
          }
          onCancelImport={() =>
            cancelMarkdownImport
              ? cancelMarkdownImport()
              : Promise.reject(new Error('当前运行环境不支持取消导入'))
          }
        />
      ) : null}
    </section>
  );
}


