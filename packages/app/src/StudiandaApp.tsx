import { appDialogs, setAppDialogs, type AppDialogs } from './dialogs.js';
import { useElapsedSeconds } from './use-elapsed-seconds.js';
import { useDialogFocusTrap } from './use-dialog-focus-trap.js';
import { useAiCopyGuard } from './use-ai-copy-guard.js';
import { ApiRequestError, createApiClient, type ApiClient } from '@studianda/api-client';
import {
  AI_OCR_COPY_SUFFIX,
  API_ERROR_CODES,
  DOCUMENT_CATEGORY_LABELS,
  DOCUMENT_TYPE_OPTIONS,
  REFERENCE_GRAPH_ALL_NODE_LIMIT,
  documentCategoryOf,
  documentTypeLabel,
  withAiExportHeader,
  withAiNoteHeader,
  type DocumentCategory,
  type DocumentCategoryCounts,
  type FolderSummary
} from '@studianda/shared';
import type {
  AnnotationRecord,
  BacklinkRecord,
  BudgetEstimate,
  ChatMessageRecord,
  ChatResponse,
  ChatSource,
  DocumentChatSessionRecord,
  DocumentReferences,
  DocumentSummary,
  LibrarySearchKind,
  MarkdownInternalTarget,
  NoteRecord,
  NoteFolderRecord,
  ImportJobRecord,
  OcrJobRecord,
  ReadingTaskSummary,
  ReferenceEntry,
  ReferenceEntryInput,
  ReferenceGraphNode,
  ReferenceNodeKind,
  RuntimeInfo,
  SearchHit,
  TranslationJobRecord,
  TranslationPagePayload
} from '@studianda/shared';
import {
  ASSET_INDEX_ACK_STORAGE_KEY,
  shouldShowAssetIndexNotice
} from './asset-index-notice.js';
import { ZoteroBrowser } from './ZoteroBrowser.js';
import {
  IconBack,
  IconBlocks,
  IconCompanion,
  IconExport,
  IconFitWidth,
  IconMask,
  IconNav,
  IconOcr,
  IconRegion,
  IconTag,
  IconTranslate
} from './reader-icons.js';
import { DocumentInfoDialog, type DocumentInfoDraft } from './DocumentInfoDialog.js';
import {
  AnnotationPanel,
  Backlinks,
  BrandMark,
  ChatPanel,
  DocumentList,
  HealthCard,
  LibraryFilters,
  NotesPanel,
  OutlinePanel,
  ReferenceGraphView,
  ReferencePanel,
  StandaloneNotesView,
  StructurePanel,
  TranslationPanel,
  type ChatMessageView,
  type DocumentReorderTarget,
  type HealthState,
  type LibraryCategoryFilter,
  type LibrarySort,
  type LibraryTypeFilterOption,
  type LibraryView
} from '@studianda/ui';
import {
  QueryClient,
  QueryClientProvider,
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient
} from '@tanstack/react-query';
import { getDocument, GlobalWorkerOptions, Util, type PDFDocumentProxy } from 'pdfjs-dist';
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type JSX,
  type MouseEvent as ReactMouseEvent
} from 'react';
import type { RuntimeAdapter } from './runtime.js';
import { blobToWav, mediaRecordingSupport } from './runtime.js';

/** 桌面壳可选的独立译文窗口能力（其它壳不实现时按钮禁用）。 */
type AppRuntimeAdapter = RuntimeAdapter & {
  openTranslationWindow?(input: {
    documentId: string;
    page: number;
  }): Promise<{ ok: boolean; message?: string }>;
};
import { paragraphAt, type ParagraphLine } from '@studianda/shared';
import { QaView } from './QaView.js';
import { SettingsView } from './SettingsView.js';
import { useMediaQuery } from './use-media-query.js';
import {
  USAGE_NOTICE_VERSION,
  UsageNoticeDialog,
  hasAcknowledgedCurrentUsageNotice,
  hasReadCurrentUsageNotice,
  markAgeConfirmed,
  readAgeConfirmed,
  setUsageNoticeAcknowledged
} from './usage-notice.js';

function BooksIcon({ collapsed }: { collapsed: boolean }): JSX.Element {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true">
      {collapsed
        ? [3, 8, 13].map((y) => (
            <rect key={y} x="2" y={y} width="16" height="3.4" rx="0.8" fill="currentColor" />
          ))
        : [2, 8, 14].map((x) => (
            <rect key={x} x={x} y="2" width="3.4" height="16" rx="0.8" fill="currentColor" />
          ))}
    </svg>
  );
}

function SidebarNavIcon({
  name
}: {
  name: 'library' | 'qa' | 'trash' | 'zotero' | 'notes' | 'graph';
}): JSX.Element {
  // 侧栏导航图标：16×16、1.3 描边、currentColor，与 reader-icons 同一画法。
  // 全部为手绘基础图元（矩形/圆/直线），未复制任何第三方图标库 path 数据。
  if (name === 'library') {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="M3.2 2.6h2.2v10.8H3.2zM6.6 2.6h2.2v10.8H6.6z" fill="none" stroke="currentColor" strokeWidth="1.3" />
        <path d="M10.6 4.4l2.1-.5 1.6 9-2.1.5z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      </svg>
    );
  }
  if (name === 'qa') {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="M3 3.2h10v7.2H7.3L4.4 12.9v-2.5H3z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
        <path d="M5.6 6.1h4.8M5.6 8.2h3.4" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      </svg>
    );
  }
  if (name === 'trash') {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="M3.4 4.4h9.2M6.2 4.4V3h3.6v1.4M4.5 4.4l.6 8.4h5.8l.6-8.4" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
        <path d="M6.7 6.8v3.2M9.3 6.8v3.2" fill="none" stroke="currentColor" strokeWidth="1.2" />
      </svg>
    );
  }
  if (name === 'zotero') {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <rect x="2.8" y="4.2" width="9" height="8.4" rx="1.1" fill="none" stroke="currentColor" strokeWidth="1.3" />
        <path d="M5.2 2.6h7.9v7.9" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
        <path d="M5.4 6.6h4.8M5.4 8.8h3.4" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      </svg>
    );
  }
  if (name === 'notes') {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="M4 2.8h6.3l2 2v8.4H4z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
        <path d="M10.1 2.9v2.1H12M5.9 8h3.9M5.9 10.2h3.9" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="4" cy="11.3" r="1.7" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="12.1" cy="4.2" r="1.7" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="11.6" cy="11.6" r="1.4" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M5.5 10.2 10.6 5.5M5.3 11.8h4.9" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

function FolderRenameIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M3.4 12.3 4 9.9l6.4-6.4a1.1 1.1 0 0 1 1.5 0l.9.9a1.1 1.1 0 0 1 0 1.5l-6.4 6.4-3 .4Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <path d="m9.6 4.3 2 2" fill="none" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

function FolderDeleteIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M4.6 5.4h6.8l-.6 7.2H5.2l-.6-7.2Zm1.8 0V4h2.8v1.4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <path d="M2.9 4h10.2" fill="none" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

function LibrarySidebar({
  documents,
  selectedId,
  showTrash,
  showZotero,
  showStandaloneNotes,
  standaloneCount,
  showReferenceGraph,
  showQa,
  importing,
  folders,
  unfiledTotal,
  foldersLoading,
  foldersError,
  selectedFolderId,
  onSelectFolder,
  onCreateFolder,
  onRenameFolder,
  onDeleteFolder,
  onHome,
  onOpen,
  onToggleTrash,
  onZotero,
  onStandaloneNotes,
  onReferenceGraph,
  onQa,
  onImport,
  onSettings
}: {
  documents: DocumentSummary[];
  selectedId?: string;
  showTrash: boolean;
  showZotero: boolean;
  showStandaloneNotes: boolean;
  standaloneCount: number | null;
  showReferenceGraph: boolean;
  showQa: boolean;
  importing: boolean;
  folders: FolderSummary[];
  unfiledTotal: number | null;
  foldersLoading: boolean;
  foldersError: string;
  selectedFolderId: string | null;
  onSelectFolder(folderId: string): void;
  onCreateFolder(): void;
  onRenameFolder(folder: FolderSummary): void;
  onDeleteFolder(folder: FolderSummary): void;
  onHome(): void;
  onOpen(document: DocumentSummary): void;
  onToggleTrash(): void;
  onZotero(): void;
  onStandaloneNotes(): void;
  onReferenceGraph(): void;
  onQa(): void;
  onImport(): void;
  onSettings(): void;
}): JSX.Element {
  return (
    <aside className="kr-app-sidebar" aria-label="文献库导航">
      <div className="kr-app-sidebar__brand">
        <span className="kr-app-sidebar__mark">
          <BrandMark size={56} />
        </span>
        <span className="kr-app-sidebar__wordmark">
          <span className="kr-app-sidebar__title">勘读·Studianda</span>
          <small>本地 · 学术空间</small>
        </span>
      </div>
      <div className="kr-app-sidebar__label">我的空间</div>
      <button
        type="button"
        className={`kr-app-sidebar__nav${
          !showTrash &&
          !showZotero &&
          !showStandaloneNotes &&
          !showReferenceGraph &&
          !showQa &&
          selectedFolderId === null
            ? ' is-active'
            : ''
        }`}
        onClick={onHome}
        title="全部文献"
      >
        <span className="kr-app-sidebar__nav-main">
          <span className="kr-app-sidebar__nav-icon">
            <SidebarNavIcon name="library" />
          </span>
          <span className="kr-app-sidebar__nav-label">全部文献</span>
        </span>
        <b>{documents.length}</b>
      </button>
      <button
        type="button"
        className={`kr-app-sidebar__nav${showQa ? ' is-active' : ''}`}
        onClick={onQa}
        title="不依附任何文献，直接在整个文献库提问"
      >
        <span className="kr-app-sidebar__nav-main">
          <span className="kr-app-sidebar__nav-icon">
            <SidebarNavIcon name="qa" />
          </span>
          <span className="kr-app-sidebar__nav-label">会话</span>
        </span>
      </button>
      <button
        type="button"
        className={`kr-app-sidebar__nav${showTrash && !showZotero ? ' is-active' : ''}`}
        onClick={onToggleTrash}
        title="应用回收站"
      >
        <span className="kr-app-sidebar__nav-main">
          <span className="kr-app-sidebar__nav-icon">
            <SidebarNavIcon name="trash" />
          </span>
          <span className="kr-app-sidebar__nav-label">应用回收站</span>
        </span>
      </button>
      <button
        type="button"
        className={`kr-app-sidebar__nav${showZotero ? ' is-active' : ''}`}
        onClick={onZotero}
        title="从 Zotero 导入"
      >
        <span className="kr-app-sidebar__nav-main">
          <span className="kr-app-sidebar__nav-icon">
            <SidebarNavIcon name="zotero" />
          </span>
          <span className="kr-app-sidebar__nav-label">从 Zotero 导入</span>
        </span>
      </button>
      <button
        type="button"
        className={`kr-app-sidebar__nav${showStandaloneNotes ? ' is-active' : ''}`}
        onClick={onStandaloneNotes}
        title="独立笔记"
      >
        <span className="kr-app-sidebar__nav-main">
          <span className="kr-app-sidebar__nav-icon">
            <SidebarNavIcon name="notes" />
          </span>
          <span className="kr-app-sidebar__nav-label">独立笔记</span>
        </span>
        <b>{standaloneCount ?? '—'}</b>
      </button>
      <button
        type="button"
        className={`kr-app-sidebar__nav${showReferenceGraph ? ' is-active' : ''}`}
        onClick={onReferenceGraph}
        title="查看全库笔记/批注与文献之间的引用网络"
      >
        <span className="kr-app-sidebar__nav-main">
          <span className="kr-app-sidebar__nav-icon">
            <SidebarNavIcon name="graph" />
          </span>
          <span className="kr-app-sidebar__nav-label">关系图</span>
        </span>
      </button>
      <button
        type="button"
        className="kr-app-sidebar__import"
        onClick={onImport}
        disabled={importing}
      >
        {importing ? '导入中…' : '+ 导入 PDF 文献'}
      </button>
      <div className="kr-app-sidebar__label kr-app-sidebar__label--folders">
        <span>文件夹</span>
        <button
          type="button"
          className="kr-app-sidebar__folder-add"
          title="新建文件夹"
          aria-label="新建文件夹"
          onClick={onCreateFolder}
        >
          ＋
        </button>
      </div>
      <div className="kr-app-sidebar__folders">
        {foldersError ? (
          <p className="kr-muted kr-app-sidebar__folders-note">文件夹读取失败：{foldersError}</p>
        ) : null}
        {foldersLoading && !foldersError ? (
          <p className="kr-muted kr-app-sidebar__folders-note">正在读取文件夹…</p>
        ) : null}
        <ul>
          {folders.map((folder) => (
            <li className="kr-folder" key={folder.id}>
              <button
                type="button"
                className={`kr-folder__open${selectedFolderId === folder.id ? ' is-active' : ''}`}
                title={folder.name}
                onClick={() => onSelectFolder(folder.id)}
              >
                <span className="kr-folder__name">{folder.name}</span>
                <small className="kr-folder__count">{folder.counts.total}</small>
              </button>
              <span className="kr-folder__tools">
                <button
                  type="button"
                  className="kr-folder__tool"
                  title={`重命名「${folder.name}」`}
                  aria-label={`重命名文件夹 ${folder.name}`}
                  onClick={() => onRenameFolder(folder)}
                >
                  <FolderRenameIcon />
                </button>
                <button
                  type="button"
                  className="kr-folder__tool is-danger"
                  title={`删除「${folder.name}」（只移到未分类）`}
                  aria-label={`删除文件夹 ${folder.name}`}
                  onClick={() => onDeleteFolder(folder)}
                >
                  <FolderDeleteIcon />
                </button>
              </span>
            </li>
          ))}
          <li className="kr-folder">
            <button
              type="button"
              className={`kr-folder__open${selectedFolderId === '' ? ' is-active' : ''}`}
              title="未分类：不属于任何文件夹的文献"
              onClick={() => onSelectFolder('')}
            >
              <span className="kr-folder__name">未分类</span>
              <small className="kr-folder__count">{unfiledTotal ?? '—'}</small>
            </button>
          </li>
        </ul>
        {/* 「未分类」本身不是文件夹：只要已有未归档文献，就不要再显示「还没有文件夹」，
            否则读起来像"明明有文件夹却提示没有"。 */}
        {!foldersLoading && !foldersError && folders.length === 0 && (unfiledTotal ?? 0) === 0 ? (
          <p className="kr-muted kr-app-sidebar__folders-note">还没有文件夹，点「＋」新建。</p>
        ) : null}
      </div>
      <div className="kr-app-sidebar__label">文献库</div>
      <div className="kr-app-sidebar__list">
        {documents.length === 0 ? (
          <p className="kr-muted">还没有文献。</p>
        ) : (
          <ul>
            {documents.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  className={item.id === selectedId ? 'is-active' : ''}
                  title={item.name}
                  onClick={() => onOpen(item)}
                >
                  <span>{item.name}</span>
                  <small>
                    {item.pages} 页
                    {item.author ? ` · ${item.author}` : ''}
                  </small>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <p className="kr-app-sidebar__privacy">
        本机数据与备份未加密；敏感资料请自行加密磁盘或隔离账户。
      </p>
      <div className="kr-app-sidebar__footer">
        <span className="kr-app-sidebar__dot" />
        <span>文档保存在此设备</span>
        <button
          type="button"
          className="kr-app-sidebar__hint"
          title="未启用外部服务时全部在本机处理；启用后相应内容会发送到你选择的服务。"
          onClick={onSettings}
        >
          ?
        </button>
      </div>
    </aside>
  );
}


/**
 * 配置 pdf.js 的 worker 资源。
 *
 * worker 是宿主相关的静态资源（Vite 用 `?url`，其它打包器用各自方案），
 * 所以由宿主在挂载时传入，而不是在 app 包里写死 Vite 专属导入。
 * 未提供时 pdf.js 会退回 fake worker（性能差且可能警告），宿主应尽量提供。
 */
export function configurePdfWorker(workerUrl: string): void {
  if (workerUrl && GlobalWorkerOptions.workerSrc !== workerUrl) {
    GlobalWorkerOptions.workerSrc = workerUrl;
  }
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 5,
      retryDelay: (attempt) => Math.min(2000, 300 * (attempt + 1)),
      refetchOnWindowFocus: false
    }
  }
});

interface Selection {
  document: DocumentSummary;
  page?: number;
  quote?: string;
  /** 打开阅读页时默认展开的侧栏面板（会话来源里的笔记/批注据此直达）。 */
  panel?: 'annotations' | 'notes' | 'chat' | 'references';
}

/** 文件夹新建/重命名用应用内小弹窗（项目规范禁用 window.prompt）。 */
type FolderDialogState =
  | { mode: 'create' }
  | { mode: 'rename'; folder: FolderSummary };

/** 「编辑分类」草稿：卡片上一次改文献类型与所属文件夹。 */
interface ClassificationDraft {
  document: DocumentSummary;
  docType: string;
  folderId: string;
}

/** 按 docType 算分栏；旧数据没有 docType 时落到「未分类」。 */
function documentCategory(document: DocumentSummary): DocumentCategory {
  return document.docCategory ?? documentCategoryOf(document.docType);
}

// 文献库排序 / 视图持久化：刷新后保留；默认 = 默认排序（可拖拽）+ 卡片视图。
const LIBRARY_SORT_STORAGE_KEY = 'studianda.library.sort';
const LIBRARY_VIEW_STORAGE_KEY = 'studianda.library.view';

/** 关系图分页兜底的每页节点数（默认 all 全量模式不用它；仅超硬上限退回分页时按 500 一批）。 */
const REFERENCE_GRAPH_PAGE_SIZE = 500;

/** 字节数显示（彻底删除笔记时提示释放的图片资源大小）。 */
function formatByteSize(bytes: number): string {
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

const LIBRARY_SORTS: LibrarySort[] = [
  'manual',
  'recent',
  'title',
  'author',
  'progress',
  'pages'
];

function readLibrarySort(): LibrarySort {
  try {
    const stored = window.localStorage.getItem(LIBRARY_SORT_STORAGE_KEY);
    if (stored && (LIBRARY_SORTS as string[]).includes(stored)) return stored as LibrarySort;
  } catch {
    // 本地存储不可用时用默认值
  }
  return 'manual';
}

function readLibraryView(): LibraryView {
  try {
    const stored = window.localStorage.getItem(LIBRARY_VIEW_STORAGE_KEY);
    if (stored === 'card' || stored === 'list') return stored;
  } catch {
    // 本地存储不可用时用默认值
  }
  return 'card';
}

function useApi(runtime: RuntimeInfo | null): ApiClient | null {
  return useMemo(() => {
    if (!runtime) return null;
    return createApiClient({ baseUrl: `http://127.0.0.1:${runtime.port}`, token: runtime.token });
  }, [runtime]);
}

function RuntimeGate({ adapter }: { adapter: AppRuntimeAdapter }): JSX.Element {
  const runtimeQuery = useQuery<RuntimeInfo | null>({
    queryKey: ['runtime'],
    queryFn: () => adapter.getRuntime(),
    refetchInterval: (query) => (query.state.data ? false : 500)
  });

  const runtime = runtimeQuery.data ?? null;
  const api = useApi(runtime);

  let state: HealthState;
  if (runtimeQuery.isError) {
    state = { status: 'error', message: runtimeQuery.error.message };
  } else if (!runtime) {
    state = { status: 'connecting' };
  } else {
    state = { status: 'ok', version: runtime.version, apiVersion: 1 };
  }

  if (!api) {
    return (
      <HealthCard
        state={state}
        onRetry={() => {
          void runtimeQuery.refetch();
        }}
      />
    );
  }

  return <Workspace api={api} adapter={adapter} />;
}

function Workspace({ api, adapter }: { api: ApiClient; adapter: AppRuntimeAdapter }): JSX.Element {
  const [selected, setSelected] = useState<Selection | null>(null);
  const [metaEdit, setMetaEdit] = useState<{
    document: DocumentSummary;
    field: 'name' | 'author' | 'tags';
    title: string;
  } | null>(null);
  const [metaValue, setMetaValue] = useState('');
  const [metaTags, setMetaTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState('');
  const [metaError, setMetaError] = useState('');
  // 阅读页「文献信息」弹窗：编辑当前文献的标题/作者/标签/类型/文件夹。
  const [documentInfo, setDocumentInfo] = useState<DocumentSummary | null>(null);
  const [documentInfoError, setDocumentInfoError] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  // 使用须知弹窗：欢迎引导页与设置页共用同一个精简版说明（localStorage 只记已读版本）。
  const [usageNoticeOpen, setUsageNoticeOpen] = useState(false);
  // 当前版本须知的已读/已勾选确认状态：欢迎页要求先阅读并勾选，才能点「开始使用」。
  const [usageNoticeRead, setUsageNoticeRead] = useState(() => hasReadCurrentUsageNotice());
  const [noticeAcknowledged, setNoticeAcknowledged] = useState(() =>
    hasAcknowledgedCurrentUsageNotice()
  );
  // 年龄确认：首启未确认时「开始使用」保持禁用；同样只记本机 localStorage。
  const [ageConfirmed, setAgeConfirmed] = useState(() => readAgeConfirmed());
  const [showGuide, setShowGuide] = useState(() => {
    try {
      // 使用须知未勾选确认（含升级到新版本的用户）时强制重新展示引导页；
      // 确认过当前版本的，再按原来的「年龄确认 / 引导只显示一次」逻辑。
      if (!hasAcknowledgedCurrentUsageNotice()) return true;
      if (window.localStorage.getItem('studianda.guide.seen') !== 'yes') return true;
      return !readAgeConfirmed();
    } catch {
      return true;
    }
  });
  const [showTrash, setShowTrash] = useState(false);
  const [showZotero, setShowZotero] = useState(false);
  // 独立笔记工作区（不依附文献的 Markdown 笔记）。
  const [showStandaloneNotes, setShowStandaloneNotes] = useState(false);
  const [standaloneNoteId, setStandaloneNoteId] = useState<string | null>(null);
  // 全库引用关系图。
  const [showReferenceGraph, setShowReferenceGraph] = useState(false);
  const [referenceGraphOffset, setReferenceGraphOffset] = useState(0);
  // 全库节点数超过单页上限时，类型/关键字筛选在服务端先过滤再分页（空数组 = 不过滤）。
  const [referenceGraphKinds, setReferenceGraphKinds] = useState<ReferenceNodeKind[]>([]);
  const [referenceGraphSearch, setReferenceGraphSearch] = useState('');
  // 独立会话页（不依附任何文献，可直接在整个文献库提问）。
  const [showQa, setShowQa] = useState(false);
  // 文件夹：null = 全部文献；'' = 未分类；其它 = 真实文件夹 id。
  const [folderId, setFolderId] = useState<string | null>(null);
  const [categoryFilter, setCategoryFilter] = useState<LibraryCategoryFilter>('all');
  const [typeFilter, setTypeFilter] = useState('');
  const [folderDialog, setFolderDialog] = useState<FolderDialogState | null>(null);
  const [folderNameInput, setFolderNameInput] = useState('');
  const [folderDialogError, setFolderDialogError] = useState('');
  const [folderNotice, setFolderNotice] = useState('');
  const [classifyEdit, setClassifyEdit] = useState<ClassificationDraft | null>(null);
  const [classifyError, setClassifyError] = useState('');
  const [compactHeader, setCompactHeader] = useState(false);
  useEffect(() => {
    const body = document.querySelector('.kr-desktop__body');
    if (!body) return;
    const update = (): void => setCompactHeader(body.scrollTop > 72);
    body.addEventListener('scroll', update, { passive: true });
    update();
    return () => body.removeEventListener('scroll', update);
  }, []);
  // 断点 1100（§6.5）：窄窗默认折叠侧栏；用户在窄窗里手动展开是同档内的临时选择
  // （sidebarPref override），不会被后续 resize 立刻收回；只有跨过 1100 才恢复默认。
  const isNarrowSidebar = useMediaQuery('(max-width: 1100px)');
  const [sidebarPref, setSidebarPref] = useState<boolean | null>(null);
  // 只在真正跨过 1100 时清空 override：用 ref 记住上一档，避免 effect 因无关重渲染再跑一次
  // 就把用户刚展开的抽屉收回。
  const prevNarrowSidebarRef = useRef(isNarrowSidebar);
  useEffect(() => {
    if (prevNarrowSidebarRef.current === isNarrowSidebar) return;
    prevNarrowSidebarRef.current = isNarrowSidebar;
    setSidebarPref(null);
  }, [isNarrowSidebar]);
  const sidebarCollapsed = sidebarPref ?? isNarrowSidebar;
  const toggleSidebar = (): void => setSidebarPref(!sidebarCollapsed);
  // 窄窗抽屉：选完导航 / 打开文献就收起，不遮住正在看的内容。
  // 用「导航签名」做守卫：只有真的换了页面/文献才收起，resize 重渲染不动它。
  const navSignature = [
    showTrash ? '1' : '0',
    showZotero ? '1' : '0',
    showStandaloneNotes ? '1' : '0',
    showReferenceGraph ? '1' : '0',
    showQa ? '1' : '0',
    folderId ?? '',
    selected?.document.id ?? '',
    selected?.page ?? '',
    selected?.panel ?? ''
  ].join('|');
  const prevNavSignatureRef = useRef(navSignature);
  useEffect(() => {
    if (prevNavSignatureRef.current === navSignature) return;
    prevNavSignatureRef.current = navSignature;
    if (isNarrowSidebar) setSidebarPref(true);
  }, [navSignature, isNarrowSidebar]);
  // 抽屉遮罩可用 Esc 收起（与弹窗的 Esc 关闭互不冲突）。
  useEffect(() => {
    if (!isNarrowSidebar || sidebarCollapsed) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setSidebarPref(true);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isNarrowSidebar, sidebarCollapsed]);
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    try {
      const stored = Number(window.localStorage.getItem('studianda.sidebar.width'));
      // 品牌区现在是「图标 + 勘读·Studianda」：侧栏最窄 240 才放得下完整品牌名，
      // 旧版本存过的更窄宽度自动抬到 240。
      if (Number.isFinite(stored) && stored >= 220 && stored <= 520) {
        return Math.max(240, stored);
      }
    } catch {
      // 忽略不可用的本地存储
    }
    return 260;
  });
  const [sidebarResize, setSidebarResize] = useState<{
    startX: number;
    startWidth: number;
  } | null>(null);
  useEffect(() => {
    if (!sidebarResize) return;
    const move = (event: PointerEvent): void => {
      setSidebarWidth(
        Math.min(520, Math.max(240, sidebarResize.startWidth + event.clientX - sidebarResize.startX))
      );
    };
    const up = (): void => setSidebarResize(null);
    window.document.body.classList.add('kr-resizing-sidebar');
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
    return () => {
      window.document.body.classList.remove('kr-resizing-sidebar');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }, [sidebarResize]);
  useEffect(() => {
    if (sidebarCollapsed) return;
    try {
      window.localStorage.setItem('studianda.sidebar.width', String(sidebarWidth));
    } catch {
      // 本地存储不可用时只保留本次会话
    }
  }, [sidebarCollapsed, sidebarWidth]);
  const shellStyle = sidebarCollapsed
    ? undefined
    : ({ '--kr-sidebar-width': `${sidebarWidth}px` } as CSSProperties);
  const [searchTerm, setSearchTerm] = useState('');
  const deferredSearch = useDeferredValue(searchTerm.trim());
  const [scopeMode, setScopeMode] = useState<'all' | 'tags' | 'documents'>('all');  const [scopeTags, setScopeTags] = useState<string[]>([]);
  const [scopeDocuments, setScopeDocuments] = useState<string[]>([]);
  const [searchKinds, setSearchKinds] = useState<LibrarySearchKind[]>([
    'document',
    'tag',
    'chunk'
  ]);
  const queryClient = useQueryClient();

  const documentsQuery = useQuery({
    queryKey: ['documents', showTrash],
    queryFn: () => api.listDocuments(showTrash)
  });

  // 设置：用于首次重建图片资源索引后的一次性提示（不阻塞界面）。
  const settingsQuery = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.getSettings()
  });

  // 把「设置 → 界面字号 / 会话字号」接通到 CSS 变量。
  // 界面字号 → --kr-fs-scale（相对设计基准 14px 的缩放比）；会话字号 → --kr-user-answer-size。
  useEffect(() => {
    const rootEl = document.documentElement;
    const readSize = (value: unknown, fallback: number): number => {
      const parsed = Number.parseInt(String(value ?? ''), 10);
      return Number.isFinite(parsed) ? parsed : fallback;
    };
    const uiSize = Math.min(18, Math.max(12, readSize(settingsQuery.data?.['ui.fontSize'], 14)));
    const answerSize = Math.min(
      22,
      Math.max(13, readSize(settingsQuery.data?.['ui.answerFontSize'], 16))
    );
    rootEl.style.setProperty('--kr-fs-scale', String(uiSize / 14));
    rootEl.style.setProperty('--kr-user-answer-size', `${answerSize}px`);
    window.dispatchEvent(new Event('studianda:type-settings'));
  }, [settingsQuery.data]);

  const [assetIndexAck, setAssetIndexAck] = useState(() => {
    try {
      return window.localStorage.getItem(ASSET_INDEX_ACK_STORAGE_KEY) ?? '';
    } catch {
      return '';
    }
  });
  const showAssetIndexNotice = shouldShowAssetIndexNotice(
    settingsQuery.data,
    assetIndexAck
  );
  const assetIndexFiles = Number(settingsQuery.data?.['note_assets.indexed_files'] ?? '0');
  const assetIndexRefs = Number(settingsQuery.data?.['note_assets.indexed_refs'] ?? '0');
  const dismissAssetIndexNotice = (): void => {
    const indexedAt = settingsQuery.data?.['note_assets.indexed_at'] ?? '';
    try {
      window.localStorage.setItem(ASSET_INDEX_ACK_STORAGE_KEY, indexedAt);
    } catch {
      // 本地存储不可用时只关闭本次会话的提示。
    }
    setAssetIndexAck(indexedAt);
  };

  // 侧栏文件夹树（真实文件夹 + 未分类）。计数由服务端按未删除文献统计。
  const foldersQuery = useQuery({
    queryKey: ['folders'],
    queryFn: () => api.listFolders()
  });

  // 独立笔记：侧栏计数与独立笔记工作区共用。
  const standaloneNotesQuery = useQuery({
    queryKey: ['standalone-notes'],
    queryFn: () => api.listStandaloneNotes()
  });
  // 独立笔记回收站：按需加载。
  const [standaloneTrashOpen, setStandaloneTrashOpen] = useState(false);
  const standaloneTrashQuery = useQuery({
    queryKey: ['standalone-notes', 'trash'],
    queryFn: () => api.listStandaloneNotes(true),
    enabled: standaloneTrashOpen
  });

  // 独立笔记文件夹与标签（含空文件夹）。
  const noteFoldersQuery = useQuery({
    queryKey: ['note-folders'],
    queryFn: () => api.listNoteFolders()
  });
  const noteTagsQuery = useQuery({
    queryKey: ['note-tags'],
    queryFn: () => api.listNoteTags()
  });

  // 全库引用关系图：默认 all 全量模式，一次返回全部节点+全部边（A 与 B/C/D 的关系边一次画全，
  // 不再有「D 在别的页只显示 stub」的问题）；只有全库超过服务端硬上限、hasMore=true 时，
  // 类型筛选/关键字/分页才改走服务端兜底（见 ReferenceGraphView 的 serverSideFilter）。
  const referenceGraphQuery = useQuery({
    queryKey: [
      'reference-graph',
      referenceGraphOffset,
      referenceGraphKinds.join(','),
      referenceGraphSearch
    ],
    queryFn: () =>
      api.getReferenceGraph({
        all: true,
        limit: REFERENCE_GRAPH_PAGE_SIZE,
        offset: referenceGraphOffset,
        kinds: referenceGraphKinds,
        search: referenceGraphSearch
      }),
    enabled: showReferenceGraph,
    placeholderData: keepPreviousData
  });

  // 极端情况：库从「超过全量硬上限」缩小到上限以内后，清掉残留的服务端筛选，
  // 让全量 + 客户端过滤重新接管（否则再勾选别的类型会因为数据已被服务端筛掉而看不到）。
  useEffect(() => {
    const data = referenceGraphQuery.data;
    if (!data) return;
    const counts = data.kindCounts;
    const fullTotal = counts
      ? counts.document + counts.note + counts.annotation
      : data.totalNodes;
    const allNodeLimit = data.allNodeLimit ?? REFERENCE_GRAPH_ALL_NODE_LIMIT;
    if (fullTotal > allNodeLimit) return;
    if (referenceGraphKinds.length === 0 && !referenceGraphSearch) return;
    setReferenceGraphKinds([]);
    setReferenceGraphSearch('');
    setReferenceGraphOffset(0);
  }, [referenceGraphQuery.data, referenceGraphKinds.length, referenceGraphSearch]);

  // 工作台卡片的翻译状态：对当前列表一次批量查询，避免每张卡片各发一次请求。
  // 有翻译任务运行时轮询，任务结束后停止，避免无谓的常驻请求。
  const translationOverviewIds = (documentsQuery.data ?? []).map((document) => document.id);
  const translationOverviewQuery = useQuery({
    queryKey: ['translation-overview', translationOverviewIds.join(',')],
    enabled: translationOverviewIds.length > 0,
    queryFn: () => api.getTranslationOverview(translationOverviewIds),
    refetchInterval: (query) =>
      (query.state.data ?? []).some((item) => item.status === 'running') ? 5000 : false
  });
  const translationStatus = Object.fromEntries(
    (translationOverviewQuery.data ?? []).map((item) => [
      item.documentId,
      {
        status: item.status,
        translatedPages: item.translatedPages,
        totalPages: item.totalPages,
        segments: item.segments,
        error: item.error
      }
    ])
  );

  // 文献工作台的检索只回答"哪些文献命中"：命中段落不再单独成栏展示，
  // 而是直接过滤下方的文献列表，避免出现一个和列表割裂的"搜索结果栏"。
  // 回收站/Zotero 页不提供检索（检索索引只覆盖在用文献），搜索栏随视图隐藏。
  const searchActive =
    !showTrash && !showZotero && !showStandaloneNotes && deferredSearch.length > 0 && searchKinds.length > 0;
  const searchQuery = useQuery({
    queryKey: ['library-search-documents', deferredSearch, searchKinds.join(',')],
    enabled: searchActive,
    placeholderData: keepPreviousData,
    queryFn: () => api.searchLibraryDocuments(deferredSearch, searchKinds)
  });
  const searchMatchedIds = useMemo(() => new Set(searchQuery.data ?? []), [searchQuery.data]);

  const availableTags = [
    ...new Set((documentsQuery.data ?? []).flatMap((document) => document.tags))
  ].sort();
  // 默认排序 = manual（拖拽顺序）；其它排序只是浏览排序，不改 manualOrder。
  const [sortMode, setSortMode] = useState<LibrarySort>(readLibrarySort);
  const [libraryView, setLibraryView] = useState<LibraryView>(readLibraryView);
  const [tagFilter, setTagFilter] = useState('');
  const [translationNotice, setTranslationNotice] = useState('');
  const [libraryNotice, setLibraryNotice] = useState('');
  /**
   * 文件健康检查结果浮窗：检查是用户主动点的一次性动作，结果应该「顶部弹出、几秒消失」，
   * 而不是一直挂在文献库页内（原来的 libraryNotice 不会自动消失）。
   * 只有健康检查走这个浮窗，导入错误等其它提示仍留在页内。
   */
  const [fileHealthToast, setFileHealthToast] = useState<{
    message: string;
    tone: 'ok' | 'warn';
  } | null>(null);
  useEffect(() => {
    if (!fileHealthToast) return undefined;
    // 约 4.5 秒后自动消失；再次点击检查会替换内容并重新计时。
    const timer = window.setTimeout(() => setFileHealthToast(null), 4500);
    return () => window.clearTimeout(timer);
  }, [fileHealthToast]);
  useEffect(() => {
    try {
      window.localStorage.setItem(LIBRARY_SORT_STORAGE_KEY, sortMode);
    } catch {
      // 本地存储不可用时只保留本次会话
    }
  }, [sortMode]);
  useEffect(() => {
    try {
      window.localStorage.setItem(LIBRARY_VIEW_STORAGE_KEY, libraryView);
    } catch {
      // 本地存储不可用时只保留本次会话
    }
  }, [libraryView]);
  const [translationJobs, setTranslationJobs] = useState<Record<string, TranslationJobRecord>>(
    {}
  );
  const runningTranslationKey = Object.values(translationJobs)
    .filter((job) => job.status === 'running')
    .map((job) => job.documentId)
    .sort()
    .join(',');
  const translatingDocuments = Object.fromEntries(
    Object.values(translationJobs)
      .filter((job) => job.status === 'running')
      .map((job) => [
        job.documentId,
        job.total > 0 ? `翻译中 ${job.done}/${job.total}` : '翻译中…'
      ])
  );
  useEffect(() => {
    const ids = runningTranslationKey ? runningTranslationKey.split(',') : [];
    if (ids.length === 0) return;
    let cancelled = false;
    const poll = (): void => {
      for (const id of ids) {
        void api
          .getTranslationJob(id)
          .then((job) => {
            if (cancelled) return;
            setTranslationJobs((previous) => {
              const current = previous[id];
              if (!current || current.status !== 'running') return previous;
              return { ...previous, [id]: job };
            });
          })
          .catch(() => undefined);
      }
    };
    const timer = window.setInterval(poll, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [api, runningTranslationKey]);
  // 检索生效时，下方列表只保留命中文献；"范围"（指定文献/标签）在命中集上再收窄。
  const searchScopeReady =
    scopeMode === 'all' ||
    (scopeMode === 'documents' ? scopeDocuments.length > 0 : scopeTags.length > 0);
  const allDocuments = documentsQuery.data ?? [];
  const folders = foldersQuery.data?.folders ?? [];
  const unfiledTotal = foldersQuery.data?.unfiled.counts.total ?? null;

  // 文件夹只收窄「文献库」的列表；回收站/Zotero 保持各自口径（回收站按分栏筛选，不按文件夹）。
  const folderScopedDocuments =
    showTrash || showZotero || folderId === null
      ? allDocuments
      : allDocuments.filter((document) => (document.folderId ?? '') === folderId);
  const folderNames = Object.fromEntries(folders.map((folder) => [folder.id, folder.name]));
  const activeFolderName =
    folderId === null
      ? null
      : folderId === ''
        ? '未分类'
        : (folders.find((folder) => folder.id === folderId)?.name ?? '文件夹');

  // 文件夹被删掉后（例如在别的窗口删除）不要让列表停在空文件夹上。
  useEffect(() => {
    if (folderId === null || folderId === '') return;
    if (foldersQuery.isSuccess && !folders.some((folder) => folder.id === folderId)) {
      setFolderId(null);
    }
  }, [folderId, folders, foldersQuery.isSuccess]);

  // 搜索 / 标签筛选之后的文献：分栏数量、类型下拉都以这个范围为准，保证数字与列表一致。
  const filteredDocuments = folderScopedDocuments
    .filter((document) => !searchActive || searchMatchedIds.has(document.id))
    .filter((document) => {
      if (!searchActive || scopeMode === 'all' || !searchScopeReady) return true;
      if (scopeMode === 'documents') return scopeDocuments.includes(document.id);
      return document.tags.some((tag) => scopeTags.includes(tag));
    })
    .filter((document) => !tagFilter || document.tags.includes(tagFilter));

  const categoryCounts: DocumentCategoryCounts = {
    total: filteredDocuments.length,
    book: 0,
    paper: 0,
    other: 0,
    unknown: 0
  };
  for (const document of filteredDocuments) categoryCounts[documentCategory(document)] += 1;

  // 先按分栏收窄，再算类型下拉：下拉里只出现当前分栏里真实存在的具体 Zotero 类型。
  const categoryScopedDocuments = filteredDocuments.filter((document) => {
    if (categoryFilter === 'all') return true;
    const category = documentCategory(document);
    if (categoryFilter === 'other') return category === 'other' || category === 'unknown';
    return category === categoryFilter;
  });
  const typeCounts = new Map<string, number>();
  for (const document of categoryScopedDocuments) {
    const value = (document.docType ?? '').trim();
    if (value) typeCounts.set(value, (typeCounts.get(value) ?? 0) + 1);
  }
  const typeOrder = new Map(
    DOCUMENT_TYPE_OPTIONS.map((option, index) => [option.value, index])
  );
  const typeOptions: LibraryTypeFilterOption[] = [...typeCounts.entries()]
    .map(([value, count]) => ({ value, label: documentTypeLabel(value), count }))
    .sort((left, right) => {
      const leftOrder = typeOrder.get(left.value) ?? Number.MAX_SAFE_INTEGER;
      const rightOrder = typeOrder.get(right.value) ?? Number.MAX_SAFE_INTEGER;
      return leftOrder - rightOrder || right.count - left.count;
    });
  // 派生一个"当前范围内有效"的类型：切换文件夹/分栏的那一刻列表不会闪成空结果。
  const activeTypeFilter = typeOptions.some((option) => option.value === typeFilter)
    ? typeFilter
    : '';
  useEffect(() => {
    // 切换文件夹 / 分栏 / 搜索后，原先选中的类型可能已不在当前范围里，回退到「全部类型」。
    if (typeFilter && !activeTypeFilter) setTypeFilter('');
  }, [typeFilter, activeTypeFilter]);

  const visibleDocuments = categoryScopedDocuments
    .filter((document) => !activeTypeFilter || (document.docType ?? '').trim() === activeTypeFilter)
    .sort((left, right) => {
      if (sortMode === 'manual') {
        // 默认排序：manualOrder 升序；没有 manualOrder 的旧数据排到后面并按导入时间稳定排序。
        const leftOrder =
          typeof left.manualOrder === 'number' && Number.isFinite(left.manualOrder)
            ? left.manualOrder
            : null;
        const rightOrder =
          typeof right.manualOrder === 'number' && Number.isFinite(right.manualOrder)
            ? right.manualOrder
            : null;
        if (leftOrder !== null && rightOrder !== null && leftOrder !== rightOrder) {
          return leftOrder - rightOrder;
        }
        if (leftOrder !== null && rightOrder === null) return -1;
        if (leftOrder === null && rightOrder !== null) return 1;
        const byCreated = left.created.localeCompare(right.created);
        return byCreated !== 0 ? byCreated : left.id.localeCompare(right.id);
      }
      if (sortMode === 'title') return left.name.localeCompare(right.name, 'zh-CN');
      if (sortMode === 'author') return left.author.localeCompare(right.author, 'zh-CN');
      if (sortMode === 'pages') return right.pages - left.pages;
      if (sortMode === 'progress') {
        const leftRatio = left.pages > 0 ? left.currentPage / left.pages : 0;
        const rightRatio = right.pages > 0 ? right.currentPage / right.pages : 0;
        return rightRatio - leftRatio;
      }
      return right.created.localeCompare(left.created);
    });

  // 文件夹自身的计数（不随搜索变化）：工作台标题下方显示口径。
  const folderScopeCounts: DocumentCategoryCounts = {
    total: folderScopedDocuments.length,
    book: 0,
    paper: 0,
    other: 0,
    unknown: 0
  };
  for (const document of folderScopedDocuments) {
    folderScopeCounts[documentCategory(document)] += 1;
  }

  // 附件缺失的文献：卡片仍保留（索引/批注/笔记都在），但要在列表上方显式提示并可重新连接。
  const missingDocuments = (documentsQuery.data ?? []).filter(
    (document) => document.missing_file === true
  );

  // ---- 导入任务（后台解析 + 进度轮询 + 取消） ----
  const [importJob, setImportJob] = useState<ImportJobRecord | null>(null);
  const importActive =
    importJob != null && ['queued', 'running', 'cancelling'].includes(importJob.state);
  const importElapsed = useElapsedSeconds(importActive);
  const importRetryRef = useRef<{
    path: string;
    confirmLarge: boolean;
    confirmDuplicate: boolean;
  } | null>(null);

  const importStageLabel = (stage: string): string =>
    ({
      queued: '排队中',
      reading: '读取文件',
      hashing: '校验文件',
      parsing: '解析 PDF',
      writing: '写入索引',
      cancelling: '正在取消',
      done: '完成',
      cancelled: '已取消'
    })[stage] ?? stage;

  const startImportPath = async (
    path: string,
    confirmLarge: boolean,
    confirmDuplicate: boolean
  ): Promise<void> => {
    importRetryRef.current = { path, confirmLarge, confirmDuplicate };
    try {
      const { jobId } = await api.startDocumentImport(path, confirmLarge, confirmDuplicate);
      setLibraryNotice('');
      setImportJob({
        id: jobId,
        state: 'queued',
        progress: 0,
        stage: 'queued',
        startedAt: new Date().toISOString()
      });
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 409) {
        if (error.code === API_ERROR_CODES.confirmationRequired) {
          if (appDialogs.confirm(error.message)) {
            await startImportPath(path, true, confirmDuplicate);
          }
          return;
        }
        if (error.code === API_ERROR_CODES.duplicateRequired) {
          handleImportFailure({ code: error.code, message: error.message, details: error.details });
          return;
        }
      }
      setLibraryNotice(`导入失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const handleImportFailure = (error: {
    code?: string;
    message: string;
    details?: unknown;
  }): void => {
    if (error.code === API_ERROR_CODES.duplicateRequired) {
      const details = error.details as
        | {
            candidates?: Array<{
              id: string;
              name: string;
              author?: string;
              publication?: string;
              reasons?: string[];
            }>;
            canOverride?: boolean;
          }
        | undefined;
      const candidates = details?.candidates ?? [];
      const lines = candidates.map(
        (candidate) =>
          `《${candidate.name}》${candidate.author ? ` · ${candidate.author}` : ''}（${(
            candidate.reasons ?? []
          ).join('、')}）`
      );
      if (details?.canOverride) {
        if (
          appDialogs.confirm(
            `文献库中已有相同或相似的文献：\n\n${lines.join('\n')}\n\n仍然导入一篇新的记录吗？`
          )
        ) {
          const retry = importRetryRef.current;
          if (retry) void startImportPath(retry.path, retry.confirmLarge, true);
        }
        return;
      }
      if (
        candidates[0] &&
        appDialogs.confirm(`文献库中已有同一文件：\n\n${lines.join('\n')}\n\n打开已有文献？`)
      ) {
        void api
          .getDocument(candidates[0].id)
          .then((document) => setSelected({ document }))
          .catch(() => undefined);
        return;
      }
      setLibraryNotice(error.message);
      return;
    }
    setLibraryNotice(`导入失败：${error.message}`);
  };

  const finishImportJob = (job: ImportJobRecord): void => {
    setImportJob(null);
    if (job.state === 'done') {
      setShowTrash(false);
      void queryClient.invalidateQueries({ queryKey: ['documents'] });
      void queryClient.invalidateQueries({ queryKey: ['search'] });
      void queryClient.invalidateQueries({ queryKey: ['folders'] });
      setLibraryNotice(
        `已导入《${job.documentName ?? '文献'}》${job.pages ? `（${job.pages} 页）` : ''}。`
      );
      if (job.documentId) {
        void api
          .getDocument(job.documentId)
          .then((document) => setSelected({ document }))
          .catch(() => undefined);
      }
      return;
    }
    if (job.state === 'cancelled') {
      setLibraryNotice('导入已取消。');
      return;
    }
    handleImportFailure(job.error ?? { message: '导入失败' });
  };

  // 轮询任务：只在 queued/running/cancelling 时继续；终态只处理一次。
  useEffect(() => {
    if (!importJob || !importActive) return undefined;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const next = await api.getDocumentImportJob(importJob.id);
          if (cancelled) return;
          if (next.state === 'done' || next.state === 'failed' || next.state === 'cancelled') {
            finishImportJob(next);
          } else {
            setImportJob(next);
          }
        } catch (error) {
          if (cancelled) return;
          setImportJob(null);
          setLibraryNotice(
            `导入任务状态读取失败：${error instanceof Error ? error.message : String(error)}`
          );
        }
      })();
    }, 500);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [importJob, importActive]);

  const startImport = async (): Promise<void> => {
    const path = await adapter.pickPdf();
    if (!path) return;
    await startImportPath(path, false, false);
  };

  const cancelImport = async (): Promise<void> => {
    if (!importJob) return;
    try {
      const next = await api.cancelDocumentImport(importJob.id);
      setImportJob(next);
    } catch (error) {
      setLibraryNotice(
        `取消导入失败：${error instanceof Error ? error.message : String(error)}`
      );
    }
  };

  // 文件健康检查：只读 stat，不读正文；缺失的文献在列表里用「重新连接」修复。
  // 结果进顶部浮窗（约 4.5 秒自动消失），不再占用页内 libraryNotice 常驻提示。
  const fileHealthMutation = useMutation({
    mutationFn: () => api.getFileHealth(),
    onSuccess: (report) => {
      if (report.missing === 0) {
        setFileHealthToast({
          message: `文件健康检查完成：${report.checked} 篇文献的文件都在。`,
          tone: 'ok'
        });
        return;
      }
      const names = report.issues
        .slice(0, 5)
        .map((issue) => `《${issue.name}》`)
        .join('、');
      setFileHealthToast({
        message: `文件健康检查完成：${report.checked} 篇中 ${report.missing} 篇文件缺失（${names}${
          report.issues.length > 5 ? ' 等' : ''
        }）。可在文献卡片的「更多」里重新连接。`,
        tone: 'warn'
      });
    },
    onError: (error: Error) =>
      setFileHealthToast({ message: `文件健康检查失败：${error.message}`, tone: 'warn' })
  });

  const deleteMutation = useMutation({
    mutationFn: (document: DocumentSummary) => api.deleteDocument(document.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['documents'] });
      void queryClient.invalidateQueries({ queryKey: ['folders'] });
    }
  });

  const restoreMutation = useMutation({
    mutationFn: (document: DocumentSummary) => api.restoreDocument(document.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['documents'] });
      void queryClient.invalidateQueries({ queryKey: ['folders'] });
    }
  });

  const purgeMutation = useMutation({
    mutationFn: (document: DocumentSummary) => api.purgeDocument(document.id, document.name),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['documents'] });
      void queryClient.invalidateQueries({ queryKey: ['folders'] });
    }
  });

  const renameMutation = useMutation({
    mutationFn: (input: { id: string; name: string }) =>
      api.updateDocument(input.id, { name: input.name }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['documents'] });
    }
  });

  const authorMutation = useMutation({
    mutationFn: (input: { id: string; author: string }) =>
      api.setDocumentAuthor(input.id, input.author),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['documents'] });
    }
  });

  const tagsMutation = useMutation({
    mutationFn: (input: { id: string; tags: string[] }) =>
      api.setDocumentTags(input.id, input.tags),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['documents'] });
    }
  });

  // ---- 文件夹：单层、单归属；`id === ''` 的「未分类」是虚拟集合，不落库 ----
  const createFolderMutation = useMutation({
    mutationFn: (name: string) => api.createFolder(name),
    onSuccess: (folder) => {
      void queryClient.invalidateQueries({ queryKey: ['folders'] });
      void queryClient.invalidateQueries({ queryKey: ['documents'] });
      setFolderDialog(null);
      setFolderDialogError('');
      setFolderNotice(`已新建文件夹「${folder.name}」。`);
    },
    onError: (error: Error) => setFolderDialogError(error.message)
  });

  const renameFolderMutation = useMutation({
    mutationFn: (input: { id: string; name: string }) =>
      api.renameFolder(input.id, input.name),
    onSuccess: (folder) => {
      void queryClient.invalidateQueries({ queryKey: ['folders'] });
      void queryClient.invalidateQueries({ queryKey: ['documents'] });
      setFolderDialog(null);
      setFolderDialogError('');
      setFolderNotice(`文件夹已重命名为「${folder.name}」。`);
    },
    onError: (error: Error) => setFolderDialogError(error.message)
  });

  const deleteFolderMutation = useMutation({
    mutationFn: (folder: FolderSummary) => api.deleteFolder(folder.id),
    onSuccess: (result, folder) => {
      void queryClient.invalidateQueries({ queryKey: ['folders'] });
      void queryClient.invalidateQueries({ queryKey: ['documents'] });
      // 删除后其中文献出现在「未分类」：如果正停在该文件夹，直接带用户过去。
      if (folderId === folder.id) setFolderId('');
      setFolderNotice(
        `已删除文件夹「${folder.name}」，${result.movedDocuments} 篇文献已移到「未分类」（文献本身没有删除）。`
      );
    },
    onError: (error: Error) => appDialogs.alert(`删除文件夹失败：${error.message}`)
  });

  // 「编辑分类」：一次改文献类型与所属文件夹，保存后同时刷新文献库与文件夹计数。
  const classifyMutation = useMutation({
    mutationFn: (input: { id: string; docType: string; folderId: string }) =>
      api.updateDocument(input.id, { docType: input.docType, folderId: input.folderId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['documents'] });
      void queryClient.invalidateQueries({ queryKey: ['folders'] });
      setClassifyEdit(null);
      setClassifyError('');
    },
    onError: (error: Error) => setClassifyError(error.message)
  });

  // 阅读页「文献信息」：标题/类型/文件夹走 PATCH，作者与标签各有一个专用接口，
  // 只在确实改动时才多发请求。接口按顺序执行，失败时停在下错的字段并在弹窗里如实报错。
  const documentInfoMutation = useMutation({
    mutationFn: async (input: { document: DocumentSummary; draft: DocumentInfoDraft }) => {
      let updated = await api.updateDocument(input.document.id, {
        name: input.draft.name,
        docType: input.draft.docType,
        folderId: input.draft.folderId
      });
      if (input.draft.author !== input.document.author) {
        updated = await api.setDocumentAuthor(input.document.id, input.draft.author);
      }
      const tagsChanged =
        input.draft.tags.length !== input.document.tags.length ||
        input.draft.tags.some((tag, index) => tag !== input.document.tags[index]);
      if (tagsChanged) {
        const saved = await api.setDocumentTags(input.document.id, input.draft.tags);
        updated = { ...updated, tags: saved.tags };
      }
      return updated;
    },
    onSuccess: (updated) => {
      setDocumentInfo(null);
      setDocumentInfoError('');
      // 阅读页用的是选中文献的快照：保存后立刻替换，标题/标签不必等列表重新拉取。
      setSelected((current) =>
        current && current.document.id === updated.id
          ? { ...current, document: { ...current.document, ...updated } }
          : current
      );
      void queryClient.invalidateQueries({ queryKey: ['documents'] });
      void queryClient.invalidateQueries({ queryKey: ['folders'] });
      void queryClient.invalidateQueries({ queryKey: ['document', updated.id] });
    },
    onError: (error: Error, input) => {
      setDocumentInfoError(`保存失败：${error.message}（可再次保存重试）`);
      // 多个接口顺序执行：失败前可能已有字段落库。刷新文献库并回读本文献，
      // 让界面显示的是库里真实的字段，而不是弹窗里的草稿。
      void queryClient.invalidateQueries({ queryKey: ['documents'] });
      void queryClient.invalidateQueries({ queryKey: ['folders'] });
      void api
        .getDocument(input.document.id)
        .then((latest) => {
          setSelected((current) =>
            current && current.document.id === latest.id
              ? { ...current, document: { ...current.document, ...latest } }
              : current
          );
        })
        .catch(() => {
          // 文献已被删除或读不到时保持现有快照，下一次打开文献库会重新拉取。
        });
    }
  });

  // 默认排序拖拽：按当前显示顺序里的邻居调用 moveDocument；其它排序不触碰 manualOrder。
  const moveDocumentMutation = useMutation({
    mutationFn: (input: { id: string } & DocumentReorderTarget) =>
      api.moveDocument(input.id, { beforeId: input.beforeId, afterId: input.afterId }),
    onSuccess: () => {
      setLibraryNotice('');
      void queryClient.invalidateQueries({ queryKey: ['documents'] });
    },
    onError: (error: Error) => setLibraryNotice(`调整顺序失败：${error.message}`)
  });

  // 独立笔记（不依附文献）：新建 / 保存 / 删除。
  const createStandaloneNoteMutation = useMutation({
    mutationFn: (content: string) => api.createStandaloneNote(content),
    onSuccess: (note) => {
      void queryClient.invalidateQueries({ queryKey: ['standalone-notes'] });
      setStandaloneNoteId(note.id);
    },
    onError: (error: Error) => appDialogs.alert(`新建独立笔记失败：${error.message}`)
  });

  const updateStandaloneNoteMutation = useMutation({
    mutationFn: (input: { id: string; content: string }) =>
      api.updateNote(input.id, { page: 0, content: input.content }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['standalone-notes'] });
    },
    onError: (error: Error) => appDialogs.alert(`保存独立笔记失败：${error.message}`)
  });

  const invalidateNoteLibrary = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['standalone-notes'] });
    void queryClient.invalidateQueries({ queryKey: ['note-folders'] });
    void queryClient.invalidateQueries({ queryKey: ['note-tags'] });
    void queryClient.invalidateQueries({ queryKey: ['note-asset-usage'] });
  };

  interface NoteCacheSnapshot {
    active?: NoteRecord[];
    trash?: NoteRecord[];
    folders?: NoteFolderRecord[];
    tags?: string[];
  }

  const snapshotNoteCaches = (): NoteCacheSnapshot => ({
    active: queryClient.getQueryData<NoteRecord[]>(['standalone-notes']),
    trash: queryClient.getQueryData<NoteRecord[]>(['standalone-notes', 'trash']),
    folders: queryClient.getQueryData<NoteFolderRecord[]>(['note-folders']),
    tags: queryClient.getQueryData<string[]>(['note-tags'])
  });

  const restoreNoteCaches = (snapshot: NoteCacheSnapshot | undefined): void => {
    if (!snapshot) return;
    if (snapshot.active) queryClient.setQueryData(['standalone-notes'], snapshot.active);
    if (snapshot.trash) queryClient.setQueryData(['standalone-notes', 'trash'], snapshot.trash);
    if (snapshot.folders) queryClient.setQueryData(['note-folders'], snapshot.folders);
    if (snapshot.tags) queryClient.setQueryData(['note-tags'], snapshot.tags);
  };

  const cancelNoteCaches = async (): Promise<void> => {
    await Promise.all([
      queryClient.cancelQueries({ queryKey: ['standalone-notes'] }),
      queryClient.cancelQueries({ queryKey: ['note-folders'] }),
      queryClient.cancelQueries({ queryKey: ['note-tags'] })
    ]);
  };

  const updateNoteCaches = (updater: (note: NoteRecord) => NoteRecord): void => {
    for (const key of [['standalone-notes'], ['standalone-notes', 'trash']] as const) {
      queryClient.setQueryData<NoteRecord[]>(key, (current) =>
        (current ?? []).map(updater)
      );
    }
  };

  const updateFolderCaches = (
    updater: (folder: NoteFolderRecord) => NoteFolderRecord | null
  ): void => {
    queryClient.setQueryData<NoteFolderRecord[]>(['note-folders'], (current) =>
      (current ?? []).map(updater).filter((folder): folder is NoteFolderRecord => Boolean(folder))
    );
  };

  const updateTagCaches = (nextTags: string[]): void => {
    queryClient.setQueryData<string[]>(['note-tags'], (current) => {
      const set = new Set(current ?? []);
      for (const tag of nextTags) set.add(tag);
      return [...set].sort((left, right) => left.localeCompare(right, 'zh-Hans-CN'));
    });
  };

  const createNoteFolderMutation = useMutation({
    mutationFn: (path: string) => api.createNoteFolder(path),
    onMutate: async (path) => {
      await cancelNoteCaches();
      const snapshot = snapshotNoteCaches();
      queryClient.setQueryData<NoteFolderRecord[]>(['note-folders'], (current) => [
        ...(current ?? []).filter((folder) => folder.path !== path),
        { path, noteCount: 0, createdAt: new Date().toISOString() }
      ]);
      return snapshot;
    },
    onSuccess: (folder) => {
      setFolderNotice(`已新建文件夹「${folder.path}」。`);
    },
    onError: (error: Error, _path, context) => {
      restoreNoteCaches(context);
      appDialogs.alert(`新建文件夹失败：${error.message}`);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['note-folders'] });
    }
  });

  const renameNoteFolderMutation = useMutation({
    mutationFn: (input: { from: string; to: string }) =>
      api.renameNoteFolder(input.from, input.to),
    onMutate: async (input) => {
      await cancelNoteCaches();
      const snapshot = snapshotNoteCaches();
      const folders = snapshot.folders ?? [];
      const fromFolder = folders.find((folder) => folder.path === input.from);
      const target = folders.find((folder) => folder.path === input.to);
      updateFolderCaches((folder) => {
        if (folder.path === input.from) {
          return target ? null : { ...folder, path: input.to };
        }
        if (folder.path.startsWith(`${input.from}/`)) {
          return { ...folder, path: input.to + folder.path.slice(input.from.length) };
        }
        if (target && folder.path === input.to) {
          return { ...folder, noteCount: folder.noteCount + (fromFolder?.noteCount ?? 0) };
        }
        return folder;
      });
      updateNoteCaches((note) => {
        const path = note.folderPath ?? '';
        if (path === input.from) return { ...note, folderPath: input.to };
        if (path.startsWith(`${input.from}/`)) {
          return { ...note, folderPath: input.to + path.slice(input.from.length) };
        }
        return note;
      });
      return snapshot;
    },
    onSuccess: (result) => {
      // 服务端返回规范快照：精确覆盖缓存，避免整片失效。
      if (result.folders) {
        queryClient.setQueryData(['note-folders'], result.folders);
      }
      if (result.notes) {
        const moved = new Map(result.notes.map((note) => [note.id, note.folderPath]));
        updateNoteCaches((note) =>
          moved.has(note.id) ? { ...note, folderPath: moved.get(note.id) ?? '' } : note
        );
      }
      const movedDeleted = result.movedDeletedNotes ?? 0;
      setFolderNotice(
        `文件夹已重命名${result.movedNotes > 0 ? `，移动 ${result.movedNotes} 篇笔记` : ''}${
          movedDeleted > 0 ? `，另移动 ${movedDeleted} 篇回收站笔记` : ''
        }。`
      );
    },
    onError: (error: Error, _input, context) => {
      restoreNoteCaches(context);
      appDialogs.alert(`重命名/合并文件夹失败：${error.message}`);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['note-folders'] });
      void queryClient.invalidateQueries({ queryKey: ['standalone-notes'] });
    }
  });

  const deleteNoteFolderMutation = useMutation({
    mutationFn: (path: string) => api.deleteNoteFolder(path),
    onMutate: async (path) => {
      await cancelNoteCaches();
      const snapshot = snapshotNoteCaches();
      const parentPath = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
      updateFolderCaches((folder) => (folder.path === path ? null : folder));
      updateNoteCaches((note) => {
        const notePath = note.folderPath ?? '';
        if (notePath === path) return { ...note, folderPath: parentPath };
        return note;
      });
      return snapshot;
    },
    onSuccess: (result) => {
      if (result.folders) {
        queryClient.setQueryData(['note-folders'], result.folders);
      }
      if (result.notes) {
        const moved = new Map(result.notes.map((note) => [note.id, note.folderPath]));
        updateNoteCaches((note) =>
          moved.has(note.id) ? { ...note, folderPath: moved.get(note.id) ?? '' } : note
        );
      }
      const movedDeleted = result.movedDeletedNotes ?? 0;
      setFolderNotice(
        result.movedNotes > 0
          ? `文件夹已删除，${result.movedNotes} 篇笔记已移到上一级/根目录${
              movedDeleted > 0 ? `，另移动 ${movedDeleted} 篇回收站笔记` : ''
            }。`
          : '文件夹已删除。'
      );
    },
    onError: (error: Error, _path, context) => {
      restoreNoteCaches(context);
      appDialogs.alert(`删除文件夹失败：${error.message}`);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['note-folders'] });
      void queryClient.invalidateQueries({ queryKey: ['standalone-notes'] });
    }
  });

  const moveNoteToFolderMutation = useMutation({
    mutationFn: (input: { id: string; folderPath: string }) =>
      api.moveNoteToFolder(input.id, input.folderPath),
    onMutate: async (input) => {
      await cancelNoteCaches();
      const snapshot = snapshotNoteCaches();
      updateNoteCaches((note) =>
        note.id === input.id ? { ...note, folderPath: input.folderPath } : note
      );
      return snapshot;
    },
    onSuccess: (_result, input) => {
      setFolderNotice(
        input.folderPath ? `笔记已移动到「${input.folderPath}」。` : '笔记已移动到根目录。'
      );
    },
    onError: (error: Error, _input, context) => {
      restoreNoteCaches(context);
      appDialogs.alert(`移动笔记失败：${error.message}（已恢复原位置）`);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['standalone-notes'] });
      void queryClient.invalidateQueries({ queryKey: ['note-folders'] });
    }
  });

  // 独立笔记：列表内拖拽排序（乐观更新当前文件夹内的显示顺序，失败回滚）。
  const reorderStandaloneNotesMutation = useMutation({
    mutationFn: (input: { folderPath: string; ids: string[] }) =>
      api.reorderStandaloneNotes(input.folderPath, input.ids),
    onMutate: async (input) => {
      await cancelNoteCaches();
      const snapshot = snapshotNoteCaches();
      const normalizeFolder = (path?: string): string =>
        (path ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
      queryClient.setQueryData<NoteRecord[]>(['standalone-notes'], (current) => {
        if (!current) return current;
        const inFolder = current.filter(
          (note) => normalizeFolder(note.folderPath) === input.folderPath
        );
        if (inFolder.length === 0) return current;
        const byId = new Map(inFolder.map((note) => [note.id, note]));
        const ordered = input.ids
          .map((id) => byId.get(id))
          .filter((note): note is NoteRecord => Boolean(note));
        const listed = new Set(ordered.map((note) => note.id));
        const nextFolderNotes = [
          ...ordered,
          ...inFolder.filter((note) => !listed.has(note.id))
        ];
        let cursor = 0;
        return current.map((note) =>
          normalizeFolder(note.folderPath) === input.folderPath
            ? (nextFolderNotes[cursor++] ?? note)
            : note
        );
      });
      return snapshot;
    },
    onSuccess: () => {
      setFolderNotice('笔记顺序已保存。');
    },
    onError: (error: Error, _input, context) => {
      restoreNoteCaches(context);
      appDialogs.alert(`保存笔记顺序失败：${error.message}（已恢复原顺序）`);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['standalone-notes'] });
    }
  });

  // 独立笔记：批量移入回收站。
  const batchDeleteStandaloneNotesMutation = useMutation({
    mutationFn: (ids: string[]) => api.batchDeleteStandaloneNotes(ids),
    onSuccess: (result, ids) => {
      invalidateNoteLibrary();
      setFolderNotice(`已将 ${result.deleted || ids.length} 篇笔记移入回收站。`);
    },
    onError: (error: Error) => appDialogs.alert(`批量移入回收站失败：${error.message}`)
  });

  // 独立笔记：批量移动到文件夹（乐观更新 folderPath，失败回滚）。
  const batchMoveStandaloneNotesMutation = useMutation({
    mutationFn: (input: { ids: string[]; folderPath: string }) =>
      api.batchMoveStandaloneNotes(input.ids, input.folderPath),
    onMutate: async (input) => {
      await cancelNoteCaches();
      const snapshot = snapshotNoteCaches();
      const ids = new Set(input.ids);
      updateNoteCaches((note) =>
        ids.has(note.id) ? { ...note, folderPath: input.folderPath } : note
      );
      return snapshot;
    },
    onSuccess: (result, input) => {
      setFolderNotice(
        input.folderPath
          ? `已将 ${result.moved} 篇笔记移动到「${input.folderPath}」。`
          : `已将 ${result.moved} 篇笔记移动到根目录。`
      );
    },
    onError: (error: Error, _input, context) => {
      restoreNoteCaches(context);
      appDialogs.alert(`批量移动笔记失败：${error.message}（已恢复原位置）`);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['standalone-notes'] });
      void queryClient.invalidateQueries({ queryKey: ['note-folders'] });
    }
  });

  const setNoteTagsMutation = useMutation({
    mutationFn: (input: { id: string; tags: string[] }) =>
      api.setNoteTags(input.id, input.tags),
    onMutate: async (input) => {
      await cancelNoteCaches();
      const snapshot = snapshotNoteCaches();
      updateNoteCaches((note) =>
        note.id === input.id ? { ...note, tags: input.tags } : note
      );
      updateTagCaches(input.tags);
      return snapshot;
    },
    onSuccess: (result, input) => {
      updateNoteCaches((note) =>
        note.id === input.id ? { ...note, tags: result.tags } : note
      );
      queryClient.setQueryData(['note-tags'], result.tags);
    },
    onError: (error: Error, _input, context) => {
      restoreNoteCaches(context);
      appDialogs.alert(`保存标签失败：${error.message}`);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['standalone-notes'] });
      void queryClient.invalidateQueries({ queryKey: ['note-tags'] });
    }
  });

  const deleteStandaloneNoteMutation = useMutation({
    mutationFn: (id: string) => api.deleteNote(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['standalone-notes'] });
      void queryClient.invalidateQueries({ queryKey: ['note-asset-usage'] });
      setFolderNotice('独立笔记已移入回收站，可恢复或彻底删除。');
    },
    onError: (error: Error) => appDialogs.alert(`移入回收站失败：${error.message}`)
  });

  const restoreStandaloneNoteMutation = useMutation({
    mutationFn: (id: string) => api.restoreNote(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['standalone-notes'] });
      void queryClient.invalidateQueries({ queryKey: ['note-asset-usage'] });
      setFolderNotice('独立笔记已恢复。');
    },
    onError: (error: Error) => appDialogs.alert(`恢复独立笔记失败：${error.message}`)
  });

  const purgeStandaloneNoteMutation = useMutation({
    mutationFn: (id: string) => api.purgeNote(id),
    onSuccess: (result, id) => {
      void queryClient.invalidateQueries({ queryKey: ['standalone-notes'] });
      void queryClient.invalidateQueries({ queryKey: ['note-asset-usage'] });
      if (standaloneNoteId === id) setStandaloneNoteId(null);
      setFolderNotice(
        result.freedAssets > 0
          ? `已彻底删除独立笔记，释放 ${result.freedAssets} 个图片资源（${formatByteSize(
              result.freedBytes
            )}）。`
          : '已彻底删除独立笔记。'
      );
    },
    onError: (error: Error) => appDialogs.alert(`彻底删除独立笔记失败：${error.message}`)
  });

  /** 统一从独立笔记视图打开某篇文献的指定页。 */
  const openDocumentFromStandalone = (documentId: string, page?: number): void => {
    const document = (documentsQuery.data ?? []).find((item) => item.id === documentId);
    if (!document) {
      appDialogs.alert('引用的文献不存在或已从文献库删除。');
      return;
    }
    const targetPage = page && page > 0 ? page : document.currentPage;
    setShowReferenceGraph(false);
    setShowStandaloneNotes(false);
    setShowTrash(false);
    setShowZotero(false);
    setShowQa(false);
    setSelected({
      document,
      page: Math.min(Math.max(1, targetPage || 1), Math.max(1, document.pages))
    });
  };

  const openStandaloneView = (): void => {
    setSelected(null);
    setShowTrash(false);
    setShowZotero(false);
    setShowReferenceGraph(false);
    setShowQa(false);
    setFolderId(null);
    resetLibraryFilters();
    setShowStandaloneNotes(true);
    setLibraryNotice('');
  };

  const openReferenceGraphView = (): void => {
    setSelected(null);
    setShowTrash(false);
    setShowZotero(false);
    setShowStandaloneNotes(false);
    setShowQa(false);
    setFolderId(null);
    resetLibraryFilters();
    setShowReferenceGraph(true);
    // 每次打开都回到「默认一屏看整体」：清空服务端筛选、回到第一页。
    const hadFilter = referenceGraphKinds.length > 0 || referenceGraphSearch.length > 0;
    setReferenceGraphKinds([]);
    setReferenceGraphSearch('');
    setReferenceGraphOffset(0);
    if (!hadFilter && referenceGraphOffset === 0) {
      void referenceGraphQuery.refetch();
    }
    setLibraryNotice('');
  };

  /**
   * 打开独立会话页：清掉当前文献与其它视图/文件夹/筛选，避免会话页顶部标题与筛选条件残留。
   * 对话本身由 QaView 自己从 localStorage 恢复。
   */
  const openQaView = (): void => {
    setSelected(null);
    setShowTrash(false);
    setShowZotero(false);
    setShowStandaloneNotes(false);
    setShowReferenceGraph(false);
    setFolderId(null);
    resetLibraryFilters();
    setShowQa(true);
    setLibraryNotice('');
  };

  /** 关系图节点点击：文献直接打开；独立笔记切视图；文献笔记/批注打开对应文献页。 */
  const openReferenceNode = (node: ReferenceGraphNode): void => {
    if (node.kind === 'document') {
      const documentId =
        node.documentId ||
        (node.id.startsWith('document:') ? node.id.slice('document:'.length) : node.id);
      openDocumentFromStandalone(documentId);
      return;
    }
    if (node.kind === 'note' && !node.documentId) {
      const noteId = node.id.startsWith('note:') ? node.id.slice('note:'.length) : node.id;
      void openStandaloneNoteById(noteId);
      return;
    }
    openDocumentFromStandalone(node.documentId, node.page);
  };

  /** 打开指定独立笔记（会先刷新列表，确认它仍存在）。 */
  const openStandaloneNoteById = async (noteId: string): Promise<void> => {
    try {
      const notes = await api.listStandaloneNotes();
      queryClient.setQueryData(['standalone-notes'], notes);
      if (!notes.some((note) => note.id === noteId)) {
        appDialogs.alert('引用的独立笔记不存在或已删除。');
        return;
      }
      setSelected(null);
      setShowTrash(false);
      setShowZotero(false);
      setShowReferenceGraph(false);
      setShowQa(false);
      setShowStandaloneNotes(true);
      setStandaloneNoteId(noteId);
    } catch (error) {
      appDialogs.alert(`打开独立笔记失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  /**
   * 打开会话来源里的笔记/批注：
   * - 独立笔记（documentId 为空）→ 切到独立笔记视图；
   * - 文献笔记/批注 → 打开对应文献页并直接展开笔记/批注面板（批注附带原文高亮）。
   */
  const openMemorySource = (source: ChatSource): void => {
    if (!source.documentId) {
      if (source.memoryId) {
        void openStandaloneNoteById(source.memoryId);
      } else {
        appDialogs.alert('这条笔记来源缺少记录编号，无法打开。');
      }
      return;
    }
    const document = (documentsQuery.data ?? []).find((item) => item.id === source.documentId);
    if (!document) {
      appDialogs.alert('这条笔记/批注所属的文献不存在或已从文献库删除。');
      return;
    }
    setSelected({
      document,
      page: source.page > 0 ? source.page : document.currentPage,
      // 笔记/批注的摘引只作定位锚点（跳页高亮），不是文献证据。
      quote: source.quotes?.[0] ?? source.anchor,
      panel: source.kind === 'note' ? 'notes' : 'annotations'
    });
  };

  /** 独立笔记视图内的 [[内部引用]] 导航：document / 独立笔记 / 文献笔记 / 批注。 */
  const openStandaloneInternal = async (target: MarkdownInternalTarget): Promise<void> => {
    if (target.kind === 'note' && !target.documentId) {
      await openStandaloneNoteById(target.noteId);
      return;
    }
    const targetDocument = (documentsQuery.data ?? []).find(
      (item) => item.id === target.documentId
    );
    if (!targetDocument) {
      appDialogs.alert('引用的文献不存在或已从文献库删除。');
      return;
    }
    if (target.kind === 'document') {
      openDocumentFromStandalone(targetDocument.id, targetDocument.currentPage);
      return;
    }
    try {
      const itemId = target.kind === 'annotation' ? target.annotationId : target.noteId;
      const items = (await (target.kind === 'annotation'
        ? api.listAnnotations(target.documentId)
        : api.listNotes(target.documentId))) as Array<{ id: string; page: number }>;
      const entry = items.find((item) => item.id === itemId);
      if (!entry) {
        appDialogs.alert(
          `引用的${target.kind === 'annotation' ? '批注' : '笔记'}不存在或已删除。`
        );
        return;
      }
      openDocumentFromStandalone(
        targetDocument.id,
        entry.page > 0 ? entry.page : targetDocument.currentPage
      );
    } catch (error) {
      appDialogs.alert(`打开内部引用失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  /** 独立笔记卡片上的反向链接：独立笔记 → 切到该笔记；文献来源 → 打开阅读页。 */
  const openStandaloneBacklink = (backlink: BacklinkRecord): void => {
    if (!backlink.documentId) {
      void openStandaloneNoteById(backlink.id);
      return;
    }
    openDocumentFromStandalone(
      backlink.documentId,
      backlink.page > 0 ? backlink.page : 1
    );
  };

  const resetLibraryFilters = (): void => {
    setCategoryFilter('all');
    setTypeFilter('');
  };

  const openAllDocuments = (): void => {
    setSelected(null);
    setShowTrash(false);
    setShowZotero(false);
    setShowStandaloneNotes(false);
    setShowReferenceGraph(false);
    setShowQa(false);
    setFolderId(null);
    resetLibraryFilters();
    setFolderNotice('');
    setLibraryNotice('');
  };

  const openFolder = (id: string): void => {
    setSelected(null);
    setShowTrash(false);
    setShowZotero(false);
    setShowStandaloneNotes(false);
    setShowReferenceGraph(false);
    setShowQa(false);
    setFolderId(id);
    resetLibraryFilters();
    setFolderNotice('');
    setLibraryNotice('');
  };

  const openTrashView = (): void => {
    setSelected(null);
    setShowZotero(false);
    setShowStandaloneNotes(false);
    setShowReferenceGraph(false);
    setShowQa(false);
    setShowTrash(true);
    setFolderId(null);
    resetLibraryFilters();
    setLibraryNotice('');
  };

  const openZoteroView = (): void => {
    setSelected(null);
    setShowTrash(false);
    setShowStandaloneNotes(false);
    setShowReferenceGraph(false);
    setShowQa(false);
    setShowZotero(true);
    setFolderId(null);
    resetLibraryFilters();
    setLibraryNotice('');
  };

  const openCreateFolder = (): void => {
    setFolderDialog({ mode: 'create' });
    setFolderNameInput('');
    setFolderDialogError('');
    setFolderNotice('');
  };

  const openRenameFolder = (folder: FolderSummary): void => {
    setFolderDialog({ mode: 'rename', folder });
    setFolderNameInput(folder.name);
    setFolderDialogError('');
    setFolderNotice('');
  };

  const submitFolderDialog = (): void => {
    if (!folderDialog) return;
    const name = folderNameInput.trim();
    if (!name) {
      setFolderDialogError('文件夹名称不能为空。');
      return;
    }
    if (name.length > 60) {
      setFolderDialogError('文件夹名称最多 60 个字符。');
      return;
    }
    if (folderDialog.mode === 'create') {
      createFolderMutation.mutate(name);
    } else {
      renameFolderMutation.mutate({ id: folderDialog.folder.id, name });
    }
  };

  const confirmDeleteFolder = (folder: FolderSummary): void => {
    const confirmed = appDialogs.confirm(
      `删除文件夹「${folder.name}」？\n\n只会把文献移到「未分类」（含回收站里的），不会删除任何文献。其中在用文献 ${folder.counts.total} 篇。`
    );
    if (confirmed) deleteFolderMutation.mutate(folder);
  };

  const openClassificationEditor = (document: DocumentSummary): void => {
    setClassifyEdit({
      document,
      docType: document.docType ?? '',
      folderId: document.folderId ?? ''
    });
    setClassifyError('');
  };

  const saveClassification = (): void => {
    if (!classifyEdit) return;
    classifyMutation.mutate({
      id: classifyEdit.document.id,
      docType: classifyEdit.docType,
      folderId: classifyEdit.folderId
    });
  };

  /** 阅读页「文献信息」：标题/作者/标签/类型/文件夹一次改完，保存后同步文献库。 */
  const openDocumentInfo = (document: DocumentSummary): void => {
    setDocumentInfo(document);
    setDocumentInfoError('');
  };

  // 附件缺失时重新连接：选文件 → relink；大文件 409 让用户确认后再试。
  const relinkMutation = useMutation({
    mutationFn: async (document: DocumentSummary) => {
      const filePath = await adapter.pickPdf();
      if (!filePath) return null;
      try {
        return await api.relinkDocument(document.id, filePath);
      } catch (error) {
        if ((error as { status?: number }).status === 409) {
          const confirmed = appDialogs.confirm(
            '这个 PDF 比较大，重新连接会增加解析时间，后续会话/翻译/`CR 可能更慢。仍要继续吗？'
          );
          if (confirmed) return await api.relinkDocument(document.id, filePath, true);
        }
        throw error;
      }
    },
    onSuccess: (document) => {
      if (!document) return;
      void queryClient.invalidateQueries({ queryKey: ['documents'] });
      void queryClient.invalidateQueries({ queryKey: ['document', document.id] });
      // 页数变化/批注页码越界要如实告诉用户，不能只说"已重新连接"。
      appDialogs.alert(
        `已重新连接「${document.name}」。${document.warning ? `\n\n${document.warning}` : ''}`
      );
    },
    onError: (error: Error) => appDialogs.alert(`重新连接失败：${error.message}`)
  });

  const translateDocument = useMutation({
    mutationFn: (document: DocumentSummary) => api.startTranslation(document.id),
    onSuccess: (job, document) => {
      setTranslationJobs((previous) => ({ ...previous, [document.id]: job }));
      setTranslationNotice(`「${document.name}」已加入后台翻译队列。`);
      void queryClient.invalidateQueries({ queryKey: ['translation-summary', document.id] });
      void queryClient.invalidateQueries({ queryKey: ['translation-overview'] });
    },
    onError: (error: Error, document) => {
      setTranslationJobs((previous) => {
        const next = { ...previous };
        delete next[document.id];
        return next;
      });
      setTranslationNotice(`翻译启动失败：${error.message}`);
    }
  });

  const openMetaEdit = (
    document: DocumentSummary,
    field: 'name' | 'author' | 'tags'
  ): void => {
    const title =
      field === 'name' ? '重命名文献' : field === 'author' ? '编辑作者' : '编辑标签';
    const value =
      field === 'name' ? document.name : field === 'author' ? document.author : document.tags.join(', ');
    setMetaEdit({ document, field, title });
    setMetaValue(value);
    setMetaTags(document.tags);
    setTagInput('');
    setMetaError('');
  };

  const saveMetaEdit = (): void => {
    if (!metaEdit) return;
    const value = metaEdit.field === 'tags' ? metaTags.join(', ') : metaValue.trim();
    if (metaEdit.field === 'name' && !value) {
      setMetaError('标题不能为空。');
      return;
    }
    if (metaEdit.field === 'name') {
      renameMutation.mutate(
        { id: metaEdit.document.id, name: value },
        { onError: (error: Error) => setMetaError(error.message) }
      );
    } else if (metaEdit.field === 'author') {
      authorMutation.mutate(
        { id: metaEdit.document.id, author: value },
        { onError: (error: Error) => setMetaError(error.message) }
      );
    } else {
      tagsMutation.mutate(
        {
          id: metaEdit.document.id,
          tags: value
            .split(/[,，]/)
            .map((tag) => tag.trim())
            .filter(Boolean)
        },
        { onError: (error: Error) => setMetaError(error.message) }
      );
    }
    setMetaEdit(null);
  };

  // 文件夹弹窗与「编辑分类」弹窗：文献库与阅读视图都要能打开（侧栏在两处都常驻）。
  const libraryDialogs = (
    <>
      {folderDialog ? (
        <div
          className="kr-modal-backdrop"
          role="presentation"
          onClick={() => setFolderDialog(null)}
        >
          <div
            className="kr-modal kr-modal--folder"
            role="dialog"
            aria-modal="true"
            aria-label={folderDialog.mode === 'create' ? '新建文件夹' : '重命名文件夹'}
            onClick={(event) => event.stopPropagation()}
          >
            <h2>{folderDialog.mode === 'create' ? '新建文件夹' : '重命名文件夹'}</h2>
            {folderDialog.mode === 'rename' ? (
              <p className="kr-muted">原名称：{folderDialog.folder.name}</p>
            ) : (
              <p className="kr-muted">文件夹是单层结构，一篇文献只属于一个文件夹。</p>
            )}
            <label className="kr-modal__field">
              文件夹名称
              <input
                autoFocus
                maxLength={60}
                value={folderNameInput}
                placeholder="例如：待读、方法论、我的论文"
                onChange={(event) => setFolderNameInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    submitFolderDialog();
                  }
                  if (event.key === 'Escape') setFolderDialog(null);
                }}
              />
            </label>
            {folderDialogError ? (
              <p className="kr-modal__error" role="alert">
                {folderDialogError}
              </p>
            ) : null}
            <div className="kr-modal__actions">
              <button type="button" className="kr-ghost" onClick={() => setFolderDialog(null)}>
                取消
              </button>
              <button
                type="button"
                className="kr-primary"
                onClick={submitFolderDialog}
                disabled={
                  (folderDialog.mode === 'create'
                    ? createFolderMutation.isPending
                    : renameFolderMutation.isPending) || folderNameInput.trim().length === 0
                }
              >
                {folderDialog.mode === 'create' ? '新建' : '保存'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {classifyEdit ? (
        <div
          className="kr-modal-backdrop"
          role="presentation"
          onClick={() => setClassifyEdit(null)}
        >
          <div
            className="kr-modal kr-modal--classify"
            role="dialog"
            aria-modal="true"
            aria-label="编辑分类"
            onClick={(event) => event.stopPropagation()}
          >
            <h2>编辑分类</h2>
            <p className="kr-muted">{classifyEdit.document.name}</p>
            <label className="kr-modal__field">
              文献类型
              <select
                value={classifyEdit.docType}
                onChange={(event) =>
                  setClassifyEdit({ ...classifyEdit, docType: event.target.value })
                }
              >
                <option value="">未分类</option>
                {DOCUMENT_TYPE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="kr-modal__field">
              所在文件夹
              <select
                value={classifyEdit.folderId}
                onChange={(event) =>
                  setClassifyEdit({ ...classifyEdit, folderId: event.target.value })
                }
              >
                <option value="">未分类</option>
                {folders.map((folder) => (
                  <option key={folder.id} value={folder.id}>
                    {folder.name}
                  </option>
                ))}
              </select>
            </label>
            <p className="kr-modal__hint">分类会同步到文献库的分栏与文件夹计数。</p>
            {classifyError ? (
              <p className="kr-modal__error" role="alert">
                {classifyError}
              </p>
            ) : null}
            <div className="kr-modal__actions">
              <button type="button" className="kr-ghost" onClick={() => setClassifyEdit(null)}>
                取消
              </button>
              <button
                type="button"
                className="kr-primary"
                onClick={saveClassification}
                disabled={classifyMutation.isPending}
              >
                {classifyMutation.isPending ? '保存中…' : '保存'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );

  // 阅读页「文献信息」弹窗：文献库分支也渲染，避免切换视图时状态丢失。
  const documentInfoDialog = documentInfo ? (
    <DocumentInfoDialog
      document={documentInfo}
      folders={folders}
      saving={documentInfoMutation.isPending}
      error={documentInfoError}
      onClose={() => {
        setDocumentInfo(null);
        setDocumentInfoError('');
      }}
      onSave={(draft) => {
        if (documentInfoMutation.isPending) return;
        setDocumentInfoError('');
        documentInfoMutation.mutate({ document: documentInfo, draft });
      }}
    />
  ) : null;

  // 使用须知弹窗（欢迎引导页 / 设置页共用）：关闭时记录已读版本；
  // 欢迎页据「已读当前版本」启用勾选确认框。
  const usageNoticeDialog = usageNoticeOpen ? (
    <UsageNoticeDialog
      adapter={adapter}
      onClose={() => {
        setUsageNoticeOpen(false);
        setUsageNoticeRead(hasReadCurrentUsageNotice());
      }}
    />
  ) : null;

  if (showGuide) {
    return (
      <>
        <div className="kr-guide">
          <div className="kr-guide__card">
            <header className="kr-guide__header">
              <div className="kr-guide__seal">
                <BrandMark size={52} />
              </div>
              <div className="kr-guide__intro">
                <h1>欢迎使用勘读</h1>
                <p className="kr-guide__lead">本地优先的学术空间：阅读、翻译、批注与会话。</p>
              </div>
            </header>
            <ol>
              <li>
                <strong>导入 PDF</strong>
                <span>复制进资料目录</span>
              </li>
              <li>
                <strong>阅读与提问</strong>
                <span>批注、笔记、会话同页</span>
              </li>
              <li>
                <strong>按需配置外部服务</strong>
                <span>不配置也能本地检索</span>
              </li>
            </ol>
            <p className="kr-guide__notice">
              本机数据与备份均为明文、未内置加密；内容只保存在本机，只有你主动使用外部服务时才会发送相应内容。请只导入你拥有合法权利或已获授权的资料；AI
              生成的回答、译文与摘要可能出错，请以文献原文为准。文本层 PDF 不配置外部服务也能本地检索；扫描件需先在设置中下载本机
              OCR 语言包，才能识别文字并检索。
            </p>
            <div className="kr-guide__consent-box">
              <p className="kr-guide__notice-link">
                <button type="button" onClick={() => setUsageNoticeOpen(true)}>
                  查看使用须知与隐私说明
                </button>
                <span className="kr-muted">
                  {' '}
                  · 版本 {USAGE_NOTICE_VERSION}
                  {usageNoticeRead ? '（已读）' : '（需先打开阅读）'}
                </span>
              </p>
              <label className="kr-guide__consent">
                <input
                  type="checkbox"
                  checked={noticeAcknowledged}
                  disabled={!usageNoticeRead}
                  onChange={(event) => {
                    setNoticeAcknowledged(event.target.checked);
                    setUsageNoticeAcknowledged(event.target.checked);
                  }}
                />
                <span>已查看使用须知与隐私说明（版本 {USAGE_NOTICE_VERSION}）</span>
              </label>
              {!usageNoticeRead ? (
                <p className="kr-guide__consent-hint" data-tone="info" role="status">
                  先打开阅读须知，即可勾选此项。
                </p>
              ) : !noticeAcknowledged ? (
                <p className="kr-guide__consent-hint" data-tone="info" role="status">
                  勾选后才能开始使用。
                </p>
              ) : null}
              <label className="kr-guide__consent">
                <input
                  type="checkbox"
                  checked={ageConfirmed}
                  onChange={(event) => setAgeConfirmed(event.target.checked)}
                />
                <span>我已年满 18 周岁，并知悉本工具不面向未成年人。</span>
              </label>
              {!ageConfirmed ? (
                <p className="kr-guide__consent-hint" role="status">
                  未满 18 周岁请勿使用。
                </p>
              ) : null}
            </div>
            <div className="kr-guide__actions">
              <button
                type="button"
                disabled={!ageConfirmed || !usageNoticeRead || !noticeAcknowledged}
                onClick={() => {
                  markAgeConfirmed();
                  setUsageNoticeAcknowledged(true);
                  setAgeConfirmed(true);
                  setNoticeAcknowledged(true);
                  try {
                    window.localStorage.setItem('studianda.guide.seen', 'yes');
                  } catch {
                    // 存储不可用时只在本次会话关闭
                  }
                  setShowGuide(false);
                }}
              >
                开始使用
              </button>
            </div>
          </div>
        </div>
        {usageNoticeDialog}
      </>
    );
  }

  /**
   * 「清空全部本地数据」成功后：退出可能引用已删除文献的视图/选择，并清掉本机里
   * 指向已删除会话的键；随后让所有查询失效，列表与统计按空库重新加载。
   */
  const handleUserDataCleared = (): void => {
    setSelected(null);
    setShowQa(false);
    setShowTrash(false);
    setShowZotero(false);
    setShowStandaloneNotes(false);
    setShowReferenceGraph(false);
    setStandaloneNoteId(null);
    setFolderId(null);
    setCategoryFilter('all');
    setTypeFilter('');
    setSearchTerm('');
    setTagFilter('');
    try {
      const staleKeys: string[] = [];
      for (let index = 0; index < window.localStorage.length; index += 1) {
        const key = window.localStorage.key(index);
        if (!key) continue;
        if (
          key.startsWith('studianda.chat.history.') ||
          key.startsWith('studianda.chat.activeSession.') ||
          key === 'studianda.qa.history' ||
          key === 'studianda.qa.activeSession'
        ) {
          staleKeys.push(key);
        }
      }
      for (const key of staleKeys) window.localStorage.removeItem(key);
    } catch {
      // 本机存储不可用时忽略：界面状态已清空，不影响后续使用。
    }
    void queryClient.invalidateQueries();
  };

  // 设置改成覆盖层：不再卸载阅读视图，避免 PDF 重载、滚动位置、草稿与译文栏状态丢失。
  const settingsOverlay = showSettings ? (
    <SettingsView
      api={api}
      adapter={adapter}
      onBack={() => setShowSettings(false)}
      onUserDataCleared={handleUserDataCleared}
      onShowGuide={() => {
        try {
          window.localStorage.removeItem('studianda.guide.seen');
        } catch {
          // 存储不可用时只在本次会话显示
        }
        // 用户在设置页可能刚读过/勾选过须知，重新展示引导页前同步一次本机状态。
        setUsageNoticeRead(hasReadCurrentUsageNotice());
        setNoticeAcknowledged(hasAcknowledgedCurrentUsageNotice());
        setShowSettings(false);
        setShowGuide(true);
      }}
    />
  ) : null;

  if (selected) {
    return (
      <div
        className={`kr-app-shell${sidebarCollapsed ? ' is-sidebar-collapsed' : ''}`}
        style={shellStyle}
      >
        {isNarrowSidebar && !sidebarCollapsed ? (
          <button
            type="button"
            className="kr-app-sidebar-backdrop"
            aria-label="收起侧栏"
            onClick={() => setSidebarPref(true)}
          />
        ) : null}
        {!sidebarCollapsed ? (
          <LibrarySidebar
            documents={documentsQuery.data ?? []}
            selectedId={selected.document.id}
            showTrash={false}
            showZotero={false}
            showStandaloneNotes={showStandaloneNotes}
            standaloneCount={standaloneNotesQuery.data?.length ?? null}
            showReferenceGraph={false}
            showQa={false}
            importing={importActive}
            folders={folders}
            unfiledTotal={unfiledTotal}
            foldersLoading={foldersQuery.isLoading}
            foldersError={foldersQuery.isError ? foldersQuery.error.message : ''}
            selectedFolderId={folderId}
            onSelectFolder={openFolder}
            onCreateFolder={openCreateFolder}
            onRenameFolder={openRenameFolder}
            onDeleteFolder={confirmDeleteFolder}
            onHome={openAllDocuments}
            onOpen={(document) => setSelected({ document })}
            onToggleTrash={openTrashView}
            onZotero={openZoteroView}
            onStandaloneNotes={openStandaloneView}
            onReferenceGraph={openReferenceGraphView}
            onQa={openQaView}
            onImport={() => void startImport()}
            onSettings={() => setShowSettings(true)}
          />
        ) : null}
        {!sidebarCollapsed ? (
          <div
            className="kr-sidebar-splitter"
            role="separator"
            aria-orientation="vertical"
            aria-label="调整文献库宽度"
            title="拖动调整文献库宽度，双击恢复默认"
            onPointerDown={(event) => {
              event.preventDefault();
              setSidebarResize({ startX: event.clientX, startWidth: sidebarWidth });
            }}
            onDoubleClick={() => setSidebarWidth(260)}
          />
        ) : null}
        <main className="kr-app-main">
          <header className="kr-app-header">
            <div className="kr-app-header__left">
              <button
                type="button"
                className="kr-sidebar-toggle"
                aria-label={sidebarCollapsed ? '展开侧栏' : '收起侧栏'}
                onClick={toggleSidebar}
              >
                <BooksIcon collapsed={sidebarCollapsed} />
              </button>
              <div className="kr-breadcrumb">
              <button type="button" onClick={() => setSelected(null)}>
                我的文献库
              </button>
              <span>/</span>
              <strong title={selected.document.name}>{selected.document.name}</strong>
              <button
                type="button"
                className="kr-breadcrumb__doc-info"
                aria-label="编辑文献信息"
                title="编辑本文献的标题、作者、标签、分类与文件夹"
                onClick={() => openDocumentInfo(selected.document)}
              >
                <IconTag />
                文献信息
              </button>
            </div>
            </div>
            <p className="kr-app-header__quote" title="勘读 · 本地学术空间">
              读全文，逐段核对，引用可回原文。
              <span>——勘读 Studianda</span>
            </p>
            <div className="kr-app-header__actions">
              <button type="button" onClick={() => setShowSettings(true)}>
                设置
              </button>
            </div>
          </header>
          <div className="kr-app-content kr-app-content--reader">
            <ReaderView
              key={`${selected.document.id}:${selected.page ?? ''}:${selected.panel ?? ''}`}
              api={api}
              adapter={adapter}
              document={selected.document}
              documents={documentsQuery.data ?? []}
              standaloneNotes={standaloneNotesQuery.data ?? []}
              initialPage={selected.page}
              initialQuote={selected.quote}
              initialPanel={selected.panel}
              onOpenDocument={(documentId, page, quote) => {
                const target = documentsQuery.data?.find((item) => item.id === documentId);
                if (target) setSelected({ document: target, page, quote });
              }}
              onOpenStandaloneNote={(noteId) => void openStandaloneNoteById(noteId)}
              onBack={() => {
                setSelected(null);
                void queryClient.invalidateQueries({ queryKey: ['documents'] });
              }}
            />
          </div>
        </main>
        {settingsOverlay}
        {libraryDialogs}
        {documentInfoDialog}
        {usageNoticeDialog}
      </div>
    );
  }

  if (documentsQuery.isLoading) {
    return <p className="kr-page-status">正在读取文献库…</p>;
  }

  if (documentsQuery.isError) {
    return (
      <div className="kr-page-error" role="alert">
        <p>文献库读取失败：{documentsQuery.error.message}</p>
        <button type="button" onClick={() => void documentsQuery.refetch()}>
          重试
        </button>
      </div>
    );
  }

  const openHit = async (hit: SearchHit): Promise<void> => {
    let document = documentsQuery.data?.find((item) => item.id === hit.documentId);
    if (!document) {
      document = await api.getDocument(hit.documentId);
    }
    setSelected({ document, page: hit.page });
  };

  // 工作台标题：会话 / 关系图 / 独立笔记 / Zotero / 回收站优先，其次显示当前文件夹名。
  const workspaceTitle = showQa
    ? '会话'
    : showReferenceGraph
      ? '关系图'
      : showStandaloneNotes
        ? '独立笔记'
        : showZotero
          ? '从 Zotero 导入'
          : showTrash
            ? '回收站'
            : (activeFolderName ?? '文献工作台');

  // 工作台级操作（文件健康 / + 导入文献 / 导入进度）只属于文献库类视图：
  // 会话、Zotero、独立笔记、关系图、回收站都有自己的头部，不能出现悬浮的导入按钮。
  const showLibraryHeadingActions =
    !showQa && !showZotero && !showStandaloneNotes && !showReferenceGraph && !showTrash;

  return (
    <div
      className={`kr-app-shell${sidebarCollapsed ? ' is-sidebar-collapsed' : ''}`}
      style={shellStyle}
    >
      {isNarrowSidebar && !sidebarCollapsed ? (
        <button
          type="button"
          className="kr-app-sidebar-backdrop"
          aria-label="收起侧栏"
          onClick={() => setSidebarPref(true)}
        />
      ) : null}
      {!sidebarCollapsed ? (
        <LibrarySidebar
          documents={documentsQuery.data ?? []}
          showTrash={showTrash}
          showZotero={showZotero}
          showStandaloneNotes={showStandaloneNotes}
          standaloneCount={standaloneNotesQuery.data?.length ?? null}
          showReferenceGraph={showReferenceGraph}
          showQa={showQa}
          importing={importActive}
          folders={folders}
          unfiledTotal={unfiledTotal}
          foldersLoading={foldersQuery.isLoading}
          foldersError={foldersQuery.isError ? foldersQuery.error.message : ''}
          selectedFolderId={folderId}
          onSelectFolder={openFolder}
          onCreateFolder={openCreateFolder}
          onRenameFolder={openRenameFolder}
          onDeleteFolder={confirmDeleteFolder}
          onHome={openAllDocuments}
          onOpen={(document) => {
            if (showTrash) return;
            if (document.missing_file) {
              const confirmed = appDialogs.confirm(
                `「${document.name}」的 PDF 附件缺失。现在选择文件重新连接吗？`
              );
              if (confirmed) relinkMutation.mutate(document);
              return;
            }
            setSelected({ document });
          }}
          onToggleTrash={() => {
            if (showTrash) openAllDocuments();
            else openTrashView();
          }}
          onZotero={openZoteroView}
          onStandaloneNotes={openStandaloneView}
          onReferenceGraph={openReferenceGraphView}
          onQa={openQaView}
          onImport={() => void startImport()}
          onSettings={() => setShowSettings(true)}
        />
      ) : null}
      {!sidebarCollapsed ? (
        <div
          className="kr-sidebar-splitter"
          role="separator"
          aria-orientation="vertical"
          aria-label="调整文献库宽度"
          title="拖动调整文献库宽度，双击恢复默认"
          onPointerDown={(event) => {
            event.preventDefault();
            setSidebarResize({ startX: event.clientX, startWidth: sidebarWidth });
          }}
          onDoubleClick={() => setSidebarWidth(260)}
        />
      ) : null}
      <main className="kr-app-main">
        <header className="kr-app-header">
          <button
            type="button"
            className="kr-sidebar-toggle"
            aria-label={sidebarCollapsed ? '展开侧栏' : '收起侧栏'}
            onClick={toggleSidebar}
          >
            <BooksIcon collapsed={sidebarCollapsed} />
          </button>
          <div className="kr-breadcrumb">
            <button type="button" onClick={openAllDocuments}>
              我的文献库
            </button>
            <span>/</span>
            <strong>{workspaceTitle}</strong>
          </div>
          <p className="kr-app-header__quote" title="勘读 · 本地学术空间">
            读全文，逐段核对，引用可回原文。
            <span>——勘读 Studianda</span>
          </p>
          <div className="kr-app-header__actions">
            <button type="button" onClick={() => setShowSettings(true)}>
              设置
            </button>
          </div>
        </header>
        <div className={`kr-app-content${showQa ? ' kr-app-content--qa' : ''}`}>
          {showAssetIndexNotice ? (
            <div className="kr-asset-index-notice" role="status">
              <span>
                已重建图片资源索引：{assetIndexFiles} 个文件、{assetIndexRefs}{' '}
                条引用。首次升级后的启动可能比平时稍慢，之后不再全量扫描。
              </span>
              <button
                type="button"
                className="kr-link-button"
                onClick={dismissAssetIndexNotice}
                title="关闭提示（资源索引重建后才会再次提示）"
              >
                知道了
              </button>
            </div>
          ) : null}
          <div className={`kr-workspace-heading${compactHeader ? ' is-compact' : ''}`}>
            <div>
              <h1>{workspaceTitle}</h1>
              <p>
                {showQa
                  ? '不依附任何文献：默认在文献库里检索原文页、笔记与批注后回答，需要通读多篇时选「跨文献精读」。'
                  : showStandaloneNotes
                    ? '不依附任何文献的 Markdown 笔记，可互相引用。'
                    : !showZotero && !showTrash && folderId !== null
                      ? `共 ${folderScopeCounts.total} 篇 · 著作 ${folderScopeCounts.book} · 论文 ${folderScopeCounts.paper} · 其他 ${folderScopeCounts.other + folderScopeCounts.unknown}`
                      : '管理文献、继续阅读，让资料有序积累。'}
              </p>
            </div>
            <div className="kr-workspace-heading__actions">
              {showLibraryHeadingActions ? (
                <>
                  <button
                    type="button"
                    className="kr-secondary"
                    onClick={() => fileHealthMutation.mutate()}
                    disabled={fileHealthMutation.isPending}
                    title="检查文献库里每篇文献的 PDF 是否仍在磁盘上（只读检查，不读取正文）"
                  >
                    {fileHealthMutation.isPending ? '检查中…' : '文件健康'}
                  </button>
                  {importActive ? (
                    <>
                      <span className="kr-settings__message" role="status">
                        导入中… {importJob?.progress ?? 0}%（
                        {importStageLabel(importJob?.stage ?? '')}，已用时 {importElapsed}s）
                      </span>
                      <button
                        type="button"
                        className="kr-secondary"
                        onClick={() => void cancelImport()}
                        disabled={importJob?.state === 'cancelling'}
                      >
                        {importJob?.state === 'cancelling' ? '正在取消…' : '取消导入'}
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="kr-library__import"
                      onClick={() => void startImport()}
                    >
                      + 导入文献
                    </button>
                  )}
                </>
              ) : null}
            </div>
          </div>
          <div className={`kr-workspace${compactHeader ? ' is-compact' : ''}`}>
      <section
        className={`kr-search${
          showQa || showZotero || showTrash || showStandaloneNotes || showReferenceGraph
            ? ' is-hidden'
            : ''
        }`}
        aria-label="全文搜索"
      >
        <div className="kr-search__kinds">
          {(
            [
              ['document', '标题 / 作者'],
              ['tag', '标签'],
              ['chunk', '正文'],
              ['annotation', '批注'],
              ['note', '笔记']
            ] as const
          ).map(([kind, label]) => (
            <button
              key={kind}
              type="button"
              className={searchKinds.includes(kind) ? 'is-active' : ''}
              onClick={() =>
                setSearchKinds((current) =>
                  current.includes(kind)
                    ? current.filter((item) => item !== kind)
                    : [...current, kind]
                )
              }
            >
              {label}
            </button>
          ))}
        </div>
        <input
          type="search"
          value={searchTerm}
          onChange={(event) => setSearchTerm(event.target.value)}
          placeholder="搜索文献全文（标题或正文）"
        />
        <div className="kr-search__scope">
          <label>
            范围
            <select
              value={scopeMode}
              onChange={(event) => {
                setScopeMode(event.target.value as 'all' | 'tags' | 'documents');
                setScopeTags([]);
                setScopeDocuments([]);
              }}
            >
              <option value="all">全部文献</option>
              <option value="documents">指定文献</option>
              <option value="tags">标签</option>
            </select>
          </label>
          {scopeMode === 'documents' ? (
            <select
              className="kr-search__scope-list"
              multiple
              size={4}
              aria-label="指定文献"
              value={scopeDocuments}
              onChange={(event) =>
                setScopeDocuments(
                  [...event.target.selectedOptions]
                    .map((option) => option.value)
                    .filter(Boolean)
                )
              }
            >
              {(documentsQuery.data ?? []).map((document) => (
                <option key={document.id} value={document.id}>
                  {document.name}
                </option>
              ))}
            </select>
          ) : null}
          {scopeMode === 'tags' ? (
            <select
              className="kr-search__scope-list"
              multiple
              size={4}
              aria-label="标签"
              value={scopeTags}
              onChange={(event) =>
                setScopeTags(
                  [...event.target.selectedOptions]
                    .map((option) => option.value)
                    .filter(Boolean)
                )
              }
            >
              {availableTags.map((tag) => (
                <option key={tag} value={tag}>
                  {tag}
                </option>
              ))}
            </select>
          ) : null}
          {scopeMode !== 'all' &&
          (scopeMode === 'tags' ? scopeTags.length : scopeDocuments.length) === 0 ? (
            <span className="kr-search__scope-warn">请至少选择 1 项</span>
          ) : null}
        </div>
        {searchActive && searchQuery.isPending ? (
          <p className="kr-search__status">正在搜索…</p>
        ) : null}
        {searchActive && searchQuery.isError ? (
          <p className="kr-page-error">搜索失败：{searchQuery.error.message}</p>
        ) : null}
        {deferredSearch.length > 0 && searchKinds.length === 0 ? (
          <p className="kr-search__status">请至少选择一种搜索类型。</p>
        ) : null}
      </section>

      {!showQa &&
      !showZotero &&
      !showTrash &&
      !showStandaloneNotes &&
      !showReferenceGraph &&
      missingDocuments.length > 0 ? (
        <div className="kr-health" role="status">
          <strong>
            附件缺失 {missingDocuments.length} 篇：索引、批注与笔记仍在，阅读/检索需要重新连接 PDF。
          </strong>
          <ul>
            {missingDocuments.map((document) => (
              <li key={document.id}>
                <span>{document.name}</span>
                <button
                  type="button"
                  onClick={() => relinkMutation.mutate(document)}
                  disabled={relinkMutation.isPending}
                >
                  {relinkMutation.isPending ? '连接中…' : '重新连接'}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {!showQa && !showZotero && !showStandaloneNotes && !showReferenceGraph ? (
        <LibraryFilters
          category={categoryFilter}
          counts={categoryCounts}
          onCategoryChange={setCategoryFilter}
          typeFilter={activeTypeFilter}
          typeOptions={typeOptions}
          onTypeFilterChange={setTypeFilter}
        />
      ) : null}

      {showQa ? (
        <QaView
          api={api}
          adapter={adapter}
          documents={documentsQuery.data ?? []}
          onOpenDocument={(documentId, page, quote) => {
            const target = documentsQuery.data?.find((item) => item.id === documentId);
            if (!target) {
              appDialogs.alert('来源文献不存在或已从文献库删除。');
              return;
            }
            setSelected({
              document: target,
              page: page > 0 ? page : target.currentPage,
              quote
            });
          }}
          onOpenStandaloneNote={(noteId) => void openStandaloneNoteById(noteId)}
          onOpenMemorySource={openMemorySource}
        />
      ) : showReferenceGraph ? (
        <ReferenceGraphView
          graph={referenceGraphQuery.data ?? null}
          loading={referenceGraphQuery.isLoading || referenceGraphQuery.isFetching}
          error={referenceGraphQuery.isError ? referenceGraphQuery.error.message : ''}
          onRetry={() => void referenceGraphQuery.refetch()}
          onOpenNode={openReferenceNode}
          limit={REFERENCE_GRAPH_PAGE_SIZE}
          onPageChange={(offset) => setReferenceGraphOffset(Math.max(0, offset))}
          onKindFilterChange={(kinds) => {
            setReferenceGraphKinds(kinds);
            setReferenceGraphOffset(0);
          }}
          onSearchChange={(search) => {
            setReferenceGraphSearch(search);
            setReferenceGraphOffset(0);
          }}
        />
      ) : showStandaloneNotes ? (
        <StandaloneNotesView
          confirmAction={appDialogs.confirm}
          notes={standaloneNotesQuery.data ?? []}
          loading={standaloneNotesQuery.isLoading}
          error={standaloneNotesQuery.isError ? standaloneNotesQuery.error.message : ''}
          creating={createStandaloneNoteMutation.isPending}
          saving={updateStandaloneNoteMutation.isPending}
          deleting={deleteStandaloneNoteMutation.isPending}
          selectedId={standaloneNoteId}
          documents={documentsQuery.data ?? []}
          loadAnnotations={(documentId) => api.listAnnotations(documentId)}
          loadNotes={(documentId) => api.listNotes(documentId)}
          uploadImage={(input) => api.uploadNoteAsset(input)}
          loadBacklinks={(target) => api.listBacklinks(target)}
          onOpenBacklink={openStandaloneBacklink}
          onOpenInternal={(target) => void openStandaloneInternal(target)}
          onSelect={setStandaloneNoteId}
          onCreate={() => createStandaloneNoteMutation.mutate('')}
          onSave={(id, content) => updateStandaloneNoteMutation.mutate({ id, content })}
          onDelete={(id) => deleteStandaloneNoteMutation.mutate(id)}
          onRestore={(id) => restoreStandaloneNoteMutation.mutate(id)}
          onPurge={(id) => purgeStandaloneNoteMutation.mutate(id)}
          trashNotes={standaloneTrashQuery.data ?? []}
          trashLoading={standaloneTrashQuery.isLoading || standaloneTrashQuery.isFetching}
          onTrashChange={setStandaloneTrashOpen}
          onPickMarkdownVault={
            adapter.pickMarkdownVault
              ? () => adapter.pickMarkdownVault?.() ?? Promise.resolve(null)
              : undefined
          }
          scanMarkdownVault={(vaultPath) => api.scanMarkdownVault(vaultPath)}
          startMarkdownScan={(vaultPath) => api.startMarkdownScan(vaultPath)}
          getMarkdownScanStatus={() => api.getMarkdownScanStatus()}
          cancelMarkdownScan={() => api.cancelMarkdownScan()}
          getMarkdownImportStatus={() => api.getMarkdownImportStatus()}
          getMarkdownJobs={() => api.getMarkdownJobs()}
          getMarkdownJobsSummary={() => api.getMarkdownJobsSummary()}
          getMarkdownScanTree={(vaultPath, parent, offset, limit) =>
            api.getMarkdownScanTree(vaultPath, parent, offset, limit)
          }
          resolveMarkdownSelection={(input) => api.resolveMarkdownSelection(input)}
          getMarkdownImportReportPage={(offset, limit) =>
            api.getMarkdownImportReportPage(offset, limit)
          }
          searchMarkdownScan={(vaultPath, query, limit, offset) =>
            api.searchMarkdownScan(vaultPath, query, limit, offset)
          }
          subscribeMarkdownJobs={(handler, options) =>
            api.subscribeMarkdownJobs(handler, options)
          }
          folders={noteFoldersQuery.data ?? []}
          tags={noteTagsQuery.data ?? []}
          onCreateFolder={(path) => createNoteFolderMutation.mutate(path)}
          onRenameFolder={(from, to) => renameNoteFolderMutation.mutate({ from, to })}
          onDeleteFolder={(path) => deleteNoteFolderMutation.mutate(path)}
          onMoveNote={(id, folderPath) =>
            moveNoteToFolderMutation.mutateAsync({ id, folderPath }).then(() => undefined)
          }
          onReorderNotes={(folderPath, ids) =>
            reorderStandaloneNotesMutation
              .mutateAsync({ folderPath, ids })
              .then(() => undefined)
          }
          onBatchDeleteNotes={(ids) =>
            batchDeleteStandaloneNotesMutation.mutateAsync(ids).then(() => undefined)
          }
          onBatchMoveNotes={(ids, folderPath) =>
            batchMoveStandaloneNotesMutation
              .mutateAsync({ ids, folderPath })
              .then(() => undefined)
          }
          onRenameNote={(id, content) =>
            updateStandaloneNoteMutation.mutateAsync({ id, content }).then(() => undefined)
          }
          onSetTags={(id, tags) =>
            setNoteTagsMutation.mutateAsync({ id, tags }).then(() => undefined)
          }
          startMarkdownImport={(input) => api.startMarkdownImport(input)}
          previewMarkdownImportDuplicates={(input) => api.previewMarkdownImport(input)}
          cancelMarkdownImport={() => api.cancelMarkdownImport()}
          onOpenAsset={async (url) => {
            if (!adapter.openNoteAsset) {
              throw new Error('当前运行环境不支持打开本地附件');
            }
            const result = await adapter.openNoteAsset(url);
            if (!result.ok) throw new Error(result.message || '打开附件失败');
          }}
          onMarkdownImported={(report) => {
            void queryClient.invalidateQueries({ queryKey: ['standalone-notes'] });
            void queryClient.invalidateQueries({ queryKey: ['note-folders'] });
            void queryClient.invalidateQueries({ queryKey: ['note-tags'] });
            void queryClient.invalidateQueries({ queryKey: ['note-asset-usage'] });
            const first = report.notes.find(
              (item) =>
                (item.status === 'imported' || item.status === 'updated') && item.noteId
            );
            if (first?.noteId) setStandaloneNoteId(first.noteId);
            setFolderNotice(
              `Markdown 笔记导入完成：导入 ${report.imported} 篇、更新 ${report.updated} 篇、跳过 ${report.skipped} 篇${
                (report.skippedExisting ?? 0) > 0
                  ? `（其中跳过已存在 ${report.skippedExisting} 篇）`
                  : ''
              }、失败 ${report.failed} 篇。`
            );
          }}
          onRetry={() => void standaloneNotesQuery.refetch()}
        />
      ) : showZotero ? (
        <ZoteroBrowser
          api={api}
          onOpen={(document) => {
            setShowZotero(false);
            setSelected({ document });
          }}
        />
      ) : (
      <DocumentList
        documents={visibleDocuments}
        trash={showTrash}
        searchQuery={searchActive ? deferredSearch : ''}
        folderName={!showTrash ? activeFolderName : null}
        categoryLabel={
          categoryFilter === 'all' ? '' : DOCUMENT_CATEGORY_LABELS[categoryFilter]
        }
        typeLabel={activeTypeFilter ? documentTypeLabel(activeTypeFilter) : ''}
        onClearFilters={resetLibraryFilters}
        folderNames={folderNames}
        onEditClassification={openClassificationEditor}
        sort={sortMode}
        onSortChange={setSortMode}
        view={libraryView}
        onViewChange={setLibraryView}
        reorderable={sortMode === 'manual' && !showTrash}
        reorderPending={moveDocumentMutation.isPending}
        onReorder={(documentId, target) =>
          moveDocumentMutation.mutate({ id: documentId, ...target })
        }
        tags={availableTags}
        tagFilter={tagFilter}
        onTagFilterChange={setTagFilter}
        onTranslate={(document) => {
          setTranslationJobs((previous) => ({
            ...previous,
            [document.id]: {
              documentId: document.id,
              status: 'running',
              total: document.pages,
              done: 0,
              currentPage: null,
              error: ''
            }
          }));
          translateDocument.mutate(document);
        }}
        translating={translatingDocuments}
        translationStatus={translationStatus}
        onDelete={(document) => {
          if (appDialogs.confirm(`将「${document.name}」移入回收站？`)) {
            deleteMutation.mutate(document);
          }
        }}
        onRestore={(document) => restoreMutation.mutate(document)}
        onPurge={(document) => {
          if (appDialogs.confirm(`彻底删除「${document.name}」？该操作不可恢复。`)) {
            purgeMutation.mutate(document);
          }
        }}
        onRename={(document) => openMetaEdit(document, 'name')}
        onEditAuthor={(document) => openMetaEdit(document, 'author')}
        onEditTags={(document) => openMetaEdit(document, 'tags')}
        onOpen={(document) => {
          if (showTrash) return;
          if (document.missing_file) {
            const confirmed = appDialogs.confirm(
              `「${document.name}」的 PDF 附件缺失。现在选择文件重新连接吗？`
            );
            if (confirmed) relinkMutation.mutate(document);
            return;
          }
          setSelected({ document });
        }}
        onRelink={(document) => relinkMutation.mutate(document)}
      />
      )}
      {translationNotice ? (
        <p className="kr-settings__message" role="status">
          {translationNotice}
        </p>
      ) : null}
      {folderNotice ? (
        <p className="kr-settings__message" role="status">
          {folderNotice}
        </p>
      ) : null}
      {libraryNotice ? (
        <p className="kr-page-error" role="alert">
          {libraryNotice}
        </p>
      ) : null}
          </div>
        </div>
      </main>
      {metaEdit ? (
        <div
          className="kr-modal-backdrop"
          role="presentation"
          onClick={() => setMetaEdit(null)}
        >
          <div
            className="kr-modal"
            role="dialog"
            aria-modal="true"
            aria-label={metaEdit.title}
            onClick={(event) => event.stopPropagation()}
          >
            <h2>{metaEdit.title}</h2>
            <p className="kr-muted">{metaEdit.document.name}</p>
            {metaEdit.field === 'tags' ? (
              <div className="kr-tag-editor">
                <div className="kr-tag-editor__chips">
                  {metaTags.map((tag) => (
                    <button
                      key={tag}
                      type="button"
                      onClick={() => setMetaTags((current) => current.filter((item) => item !== tag))}
                      title="移除标签"
                    >
                      {tag} ×
                    </button>
                  ))}
                </div>
                <div className="kr-tag-editor__input">
                  <input
                    autoFocus
                    value={tagInput}
                    placeholder="输入标签，按 Enter 添加"
                    onChange={(event) => setTagInput(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        const tag = tagInput.trim();
                        if (tag && !metaTags.includes(tag)) setMetaTags([...metaTags, tag]);
                        setTagInput('');
                      }
                      if (event.key === 'Escape') setMetaEdit(null);
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => {
                      const tag = tagInput.trim();
                      if (tag && !metaTags.includes(tag)) setMetaTags([...metaTags, tag]);
                      setTagInput('');
                    }}
                  >
                    添加
                  </button>
                </div>
              </div>
            ) : (
              <label className="kr-modal__field">
                {metaEdit.field === 'name' ? '文献标题' : '作者'}
                <input
                  autoFocus
                  value={metaValue}
                  onChange={(event) => setMetaValue(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      saveMetaEdit();
                    }
                    if (event.key === 'Escape') setMetaEdit(null);
                  }}
                />
              </label>
            )}
            {metaError ? (
              <p className="kr-modal__error" role="alert">
                {metaError}
              </p>
            ) : null}
            <div className="kr-modal__actions">
              <button type="button" className="kr-ghost" onClick={() => setMetaEdit(null)}>
                取消
              </button>
              <button type="button" className="kr-primary" onClick={saveMetaEdit}>
                保存
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {settingsOverlay}
      {libraryDialogs}
      {documentInfoDialog}
      {usageNoticeDialog}
      {/* 顶部浮窗：文件健康检查结果，固定居中、几秒后自动消失，可手动关闭。 */}
      {fileHealthToast ? (
        <div
          className={`kr-health-toast kr-health-toast--${fileHealthToast.tone}`}
          role="status"
          aria-live="polite"
        >
          <span className="kr-health-toast__text">{fileHealthToast.message}</span>
          <button
            type="button"
            className="kr-health-toast__close"
            aria-label="关闭健康检查提示"
            title="关闭提示"
            onClick={() => setFileHealthToast(null)}
          >
            ×
          </button>
        </div>
      ) : null}
    </div>
  );
}

const ANNOTATION_COLORS: Record<string, string> = {
  yellow: '#ebc743',
  green: '#74ba6a',
  blue: '#66aadb',
  pink: '#e58cac',
  purple: '#b083d2',
  orange: '#efaa57'
};

/**
 * 把浮窗夹在窗口内：宽度/高度用元素当前实际尺寸量，不用估计值——
 * 批注弹窗里有摘引、输入框和操作行，实际高度常常比 300px 高得多，
 * 按固定 260/280 夹取会让它下半截跑到屏幕外。
 */
function clampBoxToViewport(
  x: number,
  y: number,
  width: number,
  height: number
): { x: number; y: number } {
  const margin = 8;
  const maxX = Math.max(margin, window.innerWidth - width - margin);
  const maxY = Math.max(margin, window.innerHeight - height - margin);
  return {
    x: Math.max(margin, Math.min(x, maxX)),
    y: Math.max(margin, Math.min(y, maxY))
  };
}

type SelectionStyle = 'highlight' | 'underline' | 'margin';

interface SelectionDraft {
  quote: string;
  rects: number[][];
  paragraphQuote?: string;
  paragraphRects?: number[][];
  left: number;
  top: number;
  isRegion?: boolean;
}

function maskAppliesToPage(
  mask: {
    page: number;
    scope?: string;
    rangeStart?: number;
    rangeEnd?: number;
    excludePages?: number[];
  },
  page: number
): boolean {
  switch (mask.scope ?? (mask.page === 0 ? 'all' : 'page')) {
    case 'all':
      return true;
    case 'odd':
      return page % 2 === 1;
    case 'even':
      return page % 2 === 0;
    case 'range':
      return page >= (mask.rangeStart ?? 1) && page <= (mask.rangeEnd ?? page);
    case 'exclude':
      return !(mask.excludePages ?? []).includes(page);
    default:
      return mask.page === page;
  }
}

function hintBoxStyle(bbox: readonly number[] | undefined): CSSProperties | undefined {  if (!bbox || bbox.length !== 4) return undefined;
  const [x0, y0, x1, y1] = bbox;
  if (
    ![x0, y0, x1, y1].every(
      (value) => typeof value === 'number' && Number.isFinite(value)
    )
  ) {
    return undefined;
  }
  const left = Math.min(x0!, x1!);
  const top = Math.min(y0!, y1!);
  const width = Math.abs(x1! - x0!);
  const height = Math.abs(y1! - y0!);
  return {
    left: `${left * 100}%`,
    top: `${top * 100}%`,
    width: `${width * 100}%`,
    height: `${height * 100}%`
  };
}

const APP_CITE_NUMERIC = /\[(\d{1,3}(?:\s*[,，、\-–—~至]\s*\d{1,3})*)\]/g;
const APP_CITE_AUTHOR_YEAR =
  /\(\s*([A-Z][A-Za-zÀ-ÿ'’\-]{1,30})(?:\s+et\s+al\.?)?\s*,\s*((?:19|20)\d{2}[a-z]?)\s*\)/g;

function expandAppCitationLabels(body: string): string[] {
  const labels: string[] = [];
  for (const part of body.split(/[,，、]/)) {
    const range = part.match(/^(\d{1,3})\s*[-–—~至]\s*(\d{1,3})$/);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      if (end >= start && end - start <= 20) {
        for (let value = start; value <= end; value += 1) labels.push(String(value));
      }
      continue;
    }
    const single = part.trim().match(/^\d{1,3}$/);
    if (single) labels.push(single[0]);
  }
  return labels;
}

/** 一行文字里的引用标记（`[1]`、`[1–3]`、`(Smith, 2020)`）及其字符下标范围。 */
function citationMarkersInLine(
  text: string
): Array<{ labels: string[]; start: number; end: number }> {
  const markers: Array<{ labels: string[]; start: number; end: number }> = [];
  APP_CITE_NUMERIC.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = APP_CITE_NUMERIC.exec(text)) !== null) {
    const labels = expandAppCitationLabels(match[1] ?? '');
    if (labels.length > 0) {
      markers.push({ labels, start: match.index, end: match.index + match[0].length });
    }
  }
  APP_CITE_AUTHOR_YEAR.lastIndex = 0;
  while ((match = APP_CITE_AUTHOR_YEAR.exec(text)) !== null) {
    markers.push({
      labels: [`${match[1]} ${match[2]}`],
      start: match.index,
      end: match.index + match[0].length
    });
  }
  return markers.sort((left, right) => left.start - right.start);
}

/**
 * 点击正文某一点时，命中哪条引用标记。
 *
 * 行数据来自 PDF 文本层（与文本层同一坐标口径），标记位置按字符比例估算；
 * 点在标记附近（同行、字符范围或行宽的 12% 内）才算命中，避免随便点正文就弹窗。
 */
function citationLabelsAtPoint(
  lines: ParagraphLine[],
  x: number,
  y: number
): string[] {
  const line = lines.find(
    (item) =>
      y >= item.top - 0.006 &&
      y <= item.bottom + 0.006 &&
      x >= item.left - 0.006 &&
      x <= item.right + 0.006
  );
  if (!line) return [];
  const text = line.text;
  if (!text) return [];
  const width = Math.max(1e-6, line.right - line.left);
  const xAt = (index: number): number => line.left + (index / Math.max(1, text.length)) * width;
  const markers = citationMarkersInLine(text);
  if (markers.length === 0) return [];
  const direct = markers.find(
    (marker) => x >= xAt(marker.start) - 0.006 && x <= xAt(marker.end) + 0.006
  );
  if (direct) return direct.labels;
  let best: (typeof markers)[number] | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const marker of markers) {
    const center = (xAt(marker.start) + xAt(marker.end)) / 2;
    const distance = Math.abs(x - center);
    if (distance < bestDistance) {
      best = marker;
      bestDistance = distance;
    }
  }
  const tolerance = Math.max(0.02, width * 0.12);
  return best && bestDistance <= tolerance ? best.labels : [];
}

function referenceEntrySummary(entry: ReferenceEntry): string {
  const parts = [entry.authors, entry.year, entry.title].filter((part) => part.trim());
  if (parts.length > 0) return parts.join(' · ');
  return entry.raw.length > 140 ? `${entry.raw.slice(0, 140)}…` : entry.raw;
}

function ReaderPage({
  pdf,
  api,
  documentId,
  pageNumber,
  width,
  renderQuality = 1,
  annotations,
  regionMode,
  maskMode,
  ocrRegionMode,
  masks,
  totalPages,
  locatedBoxes,
  references,
  onRequestReferences,
  onLocateReferenceEntry,
  onAddMask,
  onUpdateMask,
  onDeleteMask,
  onRecognizeRegion,
  onAskRegion,
  onQuickAction,
  onUpdateAnnotation,
  onDeleteAnnotation,
  onCreate,
  onSelectText
}: {
  pdf: PDFDocumentProxy;
  api: ApiClient;
  documentId: string;
  pageNumber: number;
  width: number;
  /** 仅用于提高 canvas 内部分辨率（缩放停止后重绘），不影响页面布局尺寸。 */
  renderQuality?: number;
  annotations: AnnotationRecord[];
  regionMode: boolean;
  maskMode: boolean;
  ocrRegionMode: boolean;
  masks: Array<{
    id: string;
    page: number;
    scope: string;
    x0: number;
    y0: number;
    x1: number;
    y1: number;
  }>;
  totalPages: number;
  locatedBoxes?: number[][];
  /** 参考文献识别结果（正文点击引用标记时弹条目）。 */
  references?: DocumentReferences | null;
  /** 还没加载参考文献时，点引用标记触发的按需加载。 */
  onRequestReferences?(): void;
  /** 从弹窗跳到某条参考文献。 */
  onLocateReferenceEntry?(entryId: string): void;
  onAddMask(input: {
    page: number;
    scope?: 'page' | 'all' | 'odd' | 'even' | 'range' | 'exclude';
    rangeStart?: number;
    rangeEnd?: number;
    excludePages?: number[];
    x0: number;
    y0: number;
    x1: number;
    y1: number;
  }): void;
  onUpdateMask?(
    maskId: string,
    input: {
      scope?: 'page' | 'all' | 'odd' | 'even' | 'range' | 'exclude';
      page?: number;
      rangeStart?: number;
      rangeEnd?: number;
      excludePages?: number[];
      x0?: number;
      y0?: number;
      x1?: number;
      y1?: number;
    }
  ): void;
  onDeleteMask?(maskId: string): void;
  onRecognizeRegion?(region: {
    page: number;
    x0: number;
    y0: number;
    x1: number;
    y1: number;
  }): void;
  /** 框选区域后「对此处提问」：识别这块区域的文字并作为阅读伙伴引用（不创建批注）。 */
  onAskRegion?(region: { page: number; x0: number; y0: number; x1: number; y1: number }): void;
  onQuickAction?(action: 'translate' | 'ask' | 'float' | 'copy', quote: string): void;
  onUpdateAnnotation?(id: string, input: { content: string; color: string; style: string }): void;
  onDeleteAnnotation?(id: string): void;
  onCreate(input: {
    page: number;
    quote: string;
    rects: number[][];
    content: string;
    color: string;
    style: string;
  }): void;
  onSelectText?(page: number, quote: string): void;
}): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const renderedKeyRef = useRef('');
  const textLayerRef = useRef<HTMLDivElement | null>(null);
  const layoutLinesRef = useRef<ParagraphLine[]>([]);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [pageRatio, setPageRatio] = useState(1.414);
  const [active, setActive] = useState(false);
  const [renderError, setRenderError] = useState('');
  const [renderAttempt, setRenderAttempt] = useState(0);
  /** 正文引用的弹窗：点 `[1]`、`(Smith, 2020)` 时显示对应条目。 */
  const [citationPopup, setCitationPopup] = useState<{
    label: string;
    x: number;
    y: number;
  } | null>(null);
  const [draft, setDraft] = useState<SelectionDraft | null>(null);
  const [maskMenu, setMaskMenu] = useState<{
    id: string;
    page: number;
    x: number;
    y: number;
  } | null>(null);
  const [excludeEditor, setExcludeEditor] = useState<{
    id: string;
    value: string;
  } | null>(null);
  const [maskEditing, setMaskEditing] = useState<{
    id: string;
    rect: { x0: number; y0: number; x1: number; y1: number };
  } | null>(null);
  // 遮罩对齐提示：只在编辑遮罩时取当前页文本行/文本项框，仅用于显示，不写任何数据。
  const pageDataHintQuery = useQuery({
    queryKey: ['page-data', documentId, pageNumber],
    queryFn: () => api.getPageData(documentId, pageNumber),
    enabled: Boolean(maskEditing)
  });
  const maskDragRef = useRef<{
    startX: number;
    startY: number;
    rect: { x0: number; y0: number; x1: number; y1: number };
  } | null>(null);
  const maskResizeRef = useRef<{
    corner: 'nw' | 'ne' | 'sw' | 'se';
    startX: number;
    startY: number;
    rect: { x0: number; y0: number; x1: number; y1: number };
  } | null>(null);
  const [selectionRects, setSelectionRects] = useState<number[][]>([]);
  const [activeAnnotation, setActiveAnnotation] = useState<AnnotationRecord | null>(null);
  const [activeAnnotationNote, setActiveAnnotationNote] = useState('');
  const [activeAnnotationColor, setActiveAnnotationColor] = useState('yellow');
  const [activeAnnotationStyle, setActiveAnnotationStyle] = useState('highlight');
  const [annotationPopoverPos, setAnnotationPopoverPos] = useState({ x: 420, y: 120 });
  const annotationPopoverRef = useRef<HTMLDivElement | null>(null);
  const [annotationPopoverDrag, setAnnotationPopoverDrag] = useState<{
    offsetX: number;
    offsetY: number;
  } | null>(null);

  // 打开、窗口变化、用户拖右下角改大小时，都按元素真实尺寸重新夹回窗口内。
  useLayoutEffect(() => {
    if (!activeAnnotation) return;
    const element = annotationPopoverRef.current;
    if (!element) return;
    const apply = (): void => {
      setAnnotationPopoverPos((current) => {
        const next = clampBoxToViewport(
          current.x,
          current.y,
          element.offsetWidth,
          element.offsetHeight
        );
        return next.x === current.x && next.y === current.y ? current : next;
      });
    };
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(element);
    window.addEventListener('resize', apply);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', apply);
    };
  }, [activeAnnotation]);

  useEffect(() => {
    if (!annotationPopoverDrag) return;
    const move = (event: PointerEvent): void => {
      const element = annotationPopoverRef.current;
      setAnnotationPopoverPos(
        clampBoxToViewport(
          event.clientX - annotationPopoverDrag.offsetX,
          event.clientY - annotationPopoverDrag.offsetY,
          element?.offsetWidth ?? 360,
          element?.offsetHeight ?? 320
        )
      );
    };
    const up = (): void => setAnnotationPopoverDrag(null);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }, [annotationPopoverDrag]);
  const [annotationEditor, setAnnotationEditor] = useState<{
    style: SelectionStyle;
    color: string;
  } | null>(null);
  const [annotationEditorPos, setAnnotationEditorPos] = useState({ x: 0, y: 0 });
  const annotationEditorRef = useRef<HTMLDivElement | null>(null);
  const [annotationEditorDrag, setAnnotationEditorDrag] = useState<{
    offsetX: number;
    offsetY: number;
  } | null>(null);
  useLayoutEffect(() => {
    if (!annotationEditor) return;
    const element = annotationEditorRef.current;
    if (!element) return;
    const apply = (): void => {
      setAnnotationEditorPos((current) => {
        const width = element.offsetWidth || 460;
        const height = element.offsetHeight || 300;
        // 第一次打开居中；之后保留用户上次拖动后的位置（不再强制居中）。
        const base =
          current.x === 0 && current.y === 0
            ? {
                x: window.innerWidth / 2 - width / 2,
                y: window.innerHeight / 2 - height / 2
              }
            : current;
        const next = clampBoxToViewport(base.x, base.y, width, height);
        return next.x === current.x && next.y === current.y ? current : next;
      });
    };
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(element);
    window.addEventListener('resize', apply);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', apply);
    };
  }, [annotationEditor]);
  useEffect(() => {
    if (!annotationEditorDrag) return;
    const move = (event: PointerEvent): void => {
      const element = annotationEditorRef.current;
      setAnnotationEditorPos(
        clampBoxToViewport(
          event.clientX - annotationEditorDrag.offsetX,
          event.clientY - annotationEditorDrag.offsetY,
          element?.offsetWidth ?? 460,
          element?.offsetHeight ?? 300
        )
      );
    };
    const up = (): void => setAnnotationEditorDrag(null);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }, [annotationEditorDrag]);
  const [style, setStyle] = useState<SelectionStyle>('highlight');
  const [note, setNote] = useState('');
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(null);
  const [dragCurrent, setDragCurrent] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const dismiss = (event: MouseEvent | PointerEvent): void => {
      const target = event.target as Element | null;
      if (target?.closest('.kr-selection-actions, .kr-annotation-editor')) return;
      setDraft((current) => (current ? null : current));
      setAnnotationEditor((current) => (current ? null : current));
      setSelectionRects((current) => (current.length > 0 ? [] : current));
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setDraft(null);
        setAnnotationEditor(null);
        setSelectionRects([]);
      }
    };
    window.document.addEventListener('pointerdown', dismiss, true);
    window.document.addEventListener('keydown', onKey);
    return () => {
      window.document.removeEventListener('pointerdown', dismiss, true);
      window.document.removeEventListener('keydown', onKey);
    };
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const near = entries.some((entry) => entry.isIntersecting);
        setActive(near);
        // 不在这里清空 canvas：卸载/取消一次正在进行的 render 会留下白页。
        // 页面内容只在宽度变化或用户重试时重新绘制，滚动时直接复用。
      },
      { rootMargin: '3000px 0px' }
    );
    observer.observe(host);
    const fallback = window.setTimeout(() => {
      const rect = host.getBoundingClientRect();
      if (rect.bottom > 0 && rect.top < window.innerHeight) setActive(true);
    }, 900);
    return () => {
      window.clearTimeout(fallback);
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    if (!active || size || renderError) return;
    const timer = window.setTimeout(
      () => setRenderError('页面渲染超时，可以点击重试。'),
      12000
    );
    return () => window.clearTimeout(timer);
  }, [active, size, renderError]);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setRenderError('');
    const render = async (): Promise<void> => {
      const renderKey = `${pageNumber}:${width}:${renderQuality}:${renderAttempt}`;
      if (renderedKeyRef.current === renderKey) return;
      const pdfPage = await pdf.getPage(pageNumber);
      const canvas = canvasRef.current;
      if (cancelled || !canvas) return;
      renderedKeyRef.current = renderKey;
      const base = pdfPage.getViewport({ scale: 1 });
      setPageRatio(base.height / base.width);
      const scale = width / base.width;
      const viewport = pdfPage.getViewport({ scale });
      const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
      // 清晰度倍率只影响 canvas 内部分辨率，不影响页面布局/文本层坐标；
      // 缩放停止后提高倍率重绘，画面变清晰但不会引起重排或跳动。
      const quality = Math.max(1, Math.min(2, renderQuality));
      let pixelScale = scale * dpr * quality;
      let renderViewport = pdfPage.getViewport({ scale: pixelScale });
      const maxPixels = 10_000_000;
      if (renderViewport.width * renderViewport.height > maxPixels) {
        pixelScale *= Math.sqrt(
          maxPixels / (renderViewport.width * renderViewport.height)
        );
        renderViewport = pdfPage.getViewport({ scale: pixelScale });
      }
      const offscreen = window.document.createElement('canvas');
      offscreen.width = Math.max(1, Math.ceil(renderViewport.width));
      offscreen.height = Math.max(1, Math.ceil(renderViewport.height));
      const offscreenContext = offscreen.getContext('2d');
      if (!offscreenContext) throw new Error('无法创建 Canvas 上下文');
      await pdfPage.render({
        canvasContext: offscreenContext,
        canvas: offscreen,
        viewport: renderViewport,
        intent: 'print'
      }).promise;
      if (cancelled) return;
      canvas.width = offscreen.width;
      canvas.height = offscreen.height;
      // 画布 CSS 尺寸由样式表统一为「铺满页面框」：缩放时页面框先按目标宽度变化、
      // 清晰位图稍后补上，位图会被浏览器拉伸到页面框而不是留下半页空白（批注/文本层不跳位）。
      const context = canvas.getContext('2d');
      if (!context) throw new Error('无法创建 Canvas 上下文');
      context.drawImage(offscreen, 0, 0);
      setSize({ width: viewport.width, height: viewport.height });

      const layer = textLayerRef.current;
      if (!layer) return;
      layer.replaceChildren();
      layer.style.width = `${Math.floor(viewport.width)}px`;
      layer.style.height = `${Math.floor(viewport.height)}px`;
      const textContent = await pdfPage.getTextContent();
      if (cancelled) return;
      const layoutLines: ParagraphLine[] = [];
      let currentLine: {
        text: string;
        x0: number;
        x1: number;
        baseline: number;
        size: number;
        lastRight: number;
        lastFont: number;
      } | null = null;
      const finishLine = (): void => {
        if (!currentLine) return;
        const text = currentLine.text.replace(/\s+/g, ' ').trim();
        if (text && currentLine.x1 > currentLine.x0) {
          layoutLines.push({
            text,
            left: Math.max(0, Math.min(1, currentLine.x0 / viewport.width)),
            top: Math.max(
              0,
              Math.min(1, (currentLine.baseline - currentLine.size) / viewport.height)
            ),
            right: Math.min(1, currentLine.x1 / viewport.width),
            bottom: Math.min(1, currentLine.baseline / viewport.height),
            size: currentLine.size / viewport.height
          });
        }
        currentLine = null;
      };
      for (const item of textContent.items) {
        if (!('str' in item)) continue;
        if (!item.str) {
          // PDF.js 用"空字符串 + hasEOL"标出版面行的结束。双栏页左右两栏的基线
          // 完全一样，只靠纵坐标会把两栏并成一行，段落识别就会横跨两栏。
          if ((item as { hasEOL?: boolean }).hasEOL) finishLine();
          continue;
        }
        const tx = Util.transform(viewport.transform, item.transform);
        const fontHeight =
          Math.hypot(tx[2] ?? 0, tx[3] ?? 0) || (item.height ?? 0) * viewport.scale;
        if (!fontHeight) continue;
        const itemWidth = Math.max(0, (item.width ?? 0) * viewport.scale);
        const left = tx[4]!;
        const baseline = tx[5] ?? 0;
        const startsNewLine =
          currentLine == null ||
          Math.abs(baseline - currentLine.baseline) >
            0.55 * Math.max(fontHeight, currentLine.size) ||
          left - currentLine.x1 > Math.max(0.9 * Math.max(fontHeight, currentLine.size), 2) ||
          left + fontHeight < currentLine.x0;
        if (startsNewLine) {
          finishLine();
          currentLine = {
            text: '',
            x0: left,
            x1: left + itemWidth,
            baseline,
            size: fontHeight,
            lastRight: left + itemWidth,
            lastFont: fontHeight
          };
        }
        const line = currentLine as NonNullable<typeof currentLine>;
        const raw = item.str;
        const text = raw.replace(/\s+/g, ' ').trim();
        if (text) {
          const gap = left - line.lastRight;
          const separator =
            line.text && (gap > 0.18 * Math.max(fontHeight, line.lastFont) || /^\s/.test(raw))
              ? ' '
              : '';
          line.text += separator + text;
          line.lastRight = left + itemWidth;
          line.lastFont = fontHeight;
        }
        line.x0 = Math.min(line.x0, left);
        line.x1 = Math.max(line.x1, left + itemWidth);
        line.size = Math.max(line.size, fontHeight);
        if (text) {
          const span = window.document.createElement('span');
          span.textContent = text;
          span.style.left = `${tx[4]}px`;
          span.style.top = `${(tx[5] ?? 0) - fontHeight}px`;
          span.style.fontSize = `${fontHeight}px`;
          span.style.fontFamily = textContent.styles?.[item.fontName]?.fontFamily ?? '"Studianda Sans"';
          span.style.whiteSpace = 'pre';
          layer.appendChild(span);
          const naturalWidth = span.getBoundingClientRect().width;
          const expectedWidth = itemWidth * (text.length / Math.max(1, item.str.length));
          if (naturalWidth > 0 && expectedWidth > 0) {
            span.style.transform = `scaleX(${expectedWidth / naturalWidth})`;
            span.style.transformOrigin = '0 0';
          }
        }
        if ((item as { hasEOL?: boolean }).hasEOL) finishLine();
      }
      finishLine();
      layoutLinesRef.current = layoutLines;
    };
    void render().catch((error: unknown) => {
      renderedKeyRef.current = '';
      if (!cancelled) {
        setRenderError(error instanceof Error ? error.message : '页面渲染失败');
      }
    });
    return () => {
      cancelled = true;
    };
  }, [active, pdf, pageNumber, width, renderQuality, renderAttempt]);

  const rectsFor = (annotation: AnnotationRecord): number[][] => {
    if (!annotation.rects) return [];
    try {
      const parsed = JSON.parse(annotation.rects) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(
        (rect): rect is number[] =>
          Array.isArray(rect) && rect.length === 4 && rect.every((value) => typeof value === 'number')
      );
    } catch {
      return [];
    }
  };

  const startSelection = (): void => {
    if (regionMode || ocrRegionMode) return;
    if (!size || !textLayerRef.current || !canvasRef.current) return;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    if (!textLayerRef.current.contains(range.commonAncestorContainer)) return;
    const quote = selection.toString().replace(/\s+/g, ' ').trim();
    if (!quote) return;
    onSelectText?.(pageNumber, quote);
    const canvasRect = canvasRef.current.getBoundingClientRect();
    const rawRects = [...range.getClientRects()]
      .map(
        (rect): [number, number, number, number] => [
          Math.max(0, (rect.left - canvasRect.left) / canvasRect.width),
          Math.max(0, (rect.top - canvasRect.top) / canvasRect.height),
          Math.min(1, (rect.right - canvasRect.left) / canvasRect.width),
          Math.min(1, (rect.bottom - canvasRect.top) / canvasRect.height)
        ]
      )
      .filter((rect) => rect[2] - rect[0] > 0.002 && rect[3] - rect[1] > 0.002);
    const rects: Array<[number, number, number, number]> = [];
    for (const rect of rawRects) {
      const sameLine = rects.find(
        (item) =>
          Math.abs(item[1] - rect[1]) < 0.012 &&
          Math.abs(item[3] - rect[3]) < 0.012 &&
          rect[0] <= item[2] + 0.006 &&
          rect[2] >= item[0] - 0.006
      );
      if (sameLine) {
        sameLine[0] = Math.min(sameLine[0], rect[0]);
        sameLine[2] = Math.max(sameLine[2], rect[2]);
      } else {
        rects.push(rect);
      }
    }
    if (rects.length === 0) return;
    setSelectionRects(rects);
    const bounds = range.getBoundingClientRect();
    const spans = [...textLayerRef.current.querySelectorAll('span')].sort(
      (left, right) => left.getBoundingClientRect().left - right.getBoundingClientRect().left
    );
    const lineItems: Array<{
      top: number;
      bottom: number;
      left: number;
      right: number;
      texts: string[];
      size: number;
    }> = [];
    for (const span of spans) {
      const rect = span.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      const top = (rect.top - canvasRect.top) / canvasRect.height;
      const bottom = (rect.bottom - canvasRect.top) / canvasRect.height;
      const left = (rect.left - canvasRect.left) / canvasRect.width;
      const right = (rect.right - canvasRect.left) / canvasRect.width;
      const fontSize = Number.parseFloat(span.style.fontSize) || 0;
      const line = lineItems.find(
        (item) =>
          Math.abs(item.top - top) < 0.014 ||
          (top >= item.top - 0.006 && bottom <= item.bottom + 0.01)
      );
      if (line) {
        line.top = Math.min(line.top, top);
        line.bottom = Math.max(line.bottom, bottom);
        line.left = Math.min(line.left, left);
        line.right = Math.max(line.right, right);
        line.size = Math.max(line.size, fontSize);
        if (span.textContent) line.texts.push(span.textContent);
      } else {
        lineItems.push({
          top,
          bottom,
          left,
          right,
          size: fontSize,
          texts: span.textContent ? [span.textContent] : []
        });
      }
    }
    const selectionTop = Math.min(...rects.map((rect) => rect[1]!));
    const selectionBottom = Math.max(...rects.map((rect) => rect[3]!));
    const selectionLeft = Math.min(...rects.map((rect) => rect[0]!));
    const selectionRight = Math.max(...rects.map((rect) => rect[2]!));
    const aspect = canvasRect.height / Math.max(1, canvasRect.width);
    const domLines: ParagraphLine[] = [...lineItems]
      .sort((left, right) => left.top - right.top)
      .map((line) => ({
        text: line.texts.join(' ').replace(/\s+/g, ' ').trim(),
        left: line.left,
        right: line.right,
        top: line.top,
        bottom: line.bottom,
        size: line.size / Math.max(1, canvasRect.height)
      }))
      .filter((line) => line.text.length > 0);
    const layoutLines = layoutLinesRef.current;
    const candidateLines = layoutLines.length > 0 ? layoutLines : domLines;
    const coversSelection = (line: ParagraphLine): number => {
      const vertical =
        Math.min(line.bottom, selectionBottom) - Math.max(line.top, selectionTop);
      const horizontal =
        Math.min(line.right, selectionRight) - Math.max(line.left, selectionLeft);
      return vertical > 0 && horizontal > 0 ? vertical * horizontal : 0;
    };
    const bestLineIndex = (lines: ParagraphLine[]): number => {
      let best = -1;
      let score = 0;
      lines.forEach((line, index) => {
        const value = coversSelection(line);
        if (value > score) {
          score = value;
          best = index;
        }
      });
      return best;
    };
    let paragraph: ReturnType<typeof paragraphAt> = null;
    const candidateIndex = bestLineIndex(candidateLines);
    if (candidateIndex >= 0) {
      paragraph = paragraphAt(candidateLines, candidateIndex, aspect);
    } else if (layoutLines.length > 0 && domLines.length > 0) {
      // 文本层与结构化行对不上时退回按 DOM 行识别（例如页面上是复核后的文字层）。
      const fallbackIndex = bestLineIndex(domLines);
      if (fallbackIndex >= 0) paragraph = paragraphAt(domLines, fallbackIndex, aspect);
    }
    const paragraphQuote = paragraph?.quote ?? quote;
    // 段落侧线只存"段落左边缘的一条竖线"：整段 bbox 会盖住正文、让已批注段落
    // 里的文字无法再被选中（选文提问），而侧线本来只需要位置和高度。
    const paragraphRects: number[][] | undefined = paragraph
      ? [
          [
            paragraph.rect[0],
            paragraph.rect[1],
            Math.min(paragraph.rect[2], paragraph.rect[0] + 0.008),
            paragraph.rect[3]
          ]
        ]
      : undefined;
    setStyle('highlight');
    setNote('');
    setDraft({
      quote,
      rects,
      paragraphQuote: paragraphQuote || quote,
      paragraphRects,
      left: Math.max(8, Math.min(bounds.left - canvasRect.left, size.width - 300)),
      top: Math.max(8, Math.min(bounds.bottom - canvasRect.top + 8, size.height - 120))
    });
  };

  const commit = (nextStyle: SelectionStyle, color: string): void => {
    if (!draft) return;
    onCreate({
      page: pageNumber,
      quote:
        nextStyle === 'margin' && draft.paragraphQuote
          ? draft.paragraphQuote
          : draft.quote,
      rects:
        nextStyle === 'margin' && draft.paragraphRects
          ? draft.paragraphRects
          : draft.rects,
      content: note.trim(),
      color,
      style: nextStyle
    });
    setDraft(null);
    setNote('');
    setSelectionRects([]);
    window.getSelection()?.removeAllRanges();
  };

  const pointAt = (event: { clientX: number; clientY: number }): { x: number; y: number } | null => {
    if (!canvasRef.current) return null;
    const rect = canvasRef.current.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height))
    };
  };

  const startRegion = (event: { clientX: number; clientY: number }): void => {
    if (!regionMode && !maskMode && !ocrRegionMode) return;
    const point = pointAt(event);
    if (!point) return;
    setDragStart(point);
    setDragCurrent(point);
  };

  const moveRegion = (event: { clientX: number; clientY: number }): void => {
    if (!dragStart) return;
    const point = pointAt(event);
    if (point) setDragCurrent(point);
  };

  const finishRegion = (): void => {
    if (!dragStart || !dragCurrent || !size) {
      setDragStart(null);
      setDragCurrent(null);
      return;
    }
    const x0 = Math.min(dragStart.x, dragCurrent.x);
    const y0 = Math.min(dragStart.y, dragCurrent.y);
    const x1 = Math.max(dragStart.x, dragCurrent.x);
    const y1 = Math.max(dragStart.y, dragCurrent.y);
    setDragStart(null);
    setDragCurrent(null);
    if (x1 - x0 < 0.005 || y1 - y0 < 0.005) return;
    if (ocrRegionMode) {
      // 区域识别只把这一块交给 OCR，不创建批注草稿、也不写回页面文字。
      onRecognizeRegion?.({ page: pageNumber, x0, y0, x1, y1 });
      return;
    }
    if (maskMode) {
      onAddMask({ page: pageNumber, x0, y0, x1, y1 });
      return;
    }
    setStyle('highlight');
    setNote('');
    setDraft({
      quote: '',
      rects: [[x0, y0, x1, y1]],
      left: Math.max(8, Math.min(x0 * size.width, size.width - 300)),
      top: Math.max(8, Math.min(y1 * size.height + 8, size.height - 120)),
      isRegion: true
    });
  };

  const draftRect =
    dragStart && dragCurrent
      ? {
          left: `${Math.min(dragStart.x, dragCurrent.x) * 100}%`,
          top: `${Math.min(dragStart.y, dragCurrent.y) * 100}%`,
          width: `${Math.abs(dragCurrent.x - dragStart.x) * 100}%`,
          height: `${Math.abs(dragCurrent.y - dragStart.y) * 100}%`
        }
      : null;

  useEffect(() => {
    if (!citationPopup) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setCitationPopup(null);
    };
    const dismiss = (event: PointerEvent): void => {
      const target = event.target as Element | null;
      if (target?.closest('.kr-cite-pop')) return;
      setCitationPopup(null);
    };
    window.document.addEventListener('keydown', onKey);
    window.document.addEventListener('pointerdown', dismiss, true);
    return () => {
      window.document.removeEventListener('keydown', onKey);
      window.document.removeEventListener('pointerdown', dismiss, true);
    };
  }, [citationPopup]);

  const handleTextClick = (event: ReactMouseEvent<HTMLDivElement>): void => {
    if (regionMode || maskMode || ocrRegionMode) return;
    const host = hostRef.current;
    if (!host) return;
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) return;
    const bounds = host.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return;
    const x = (event.clientX - bounds.left) / bounds.width;
    const y = (event.clientY - bounds.top) / bounds.height;
    const labels = citationLabelsAtPoint(layoutLinesRef.current, x, y);
    if (labels.length === 0) {
      setCitationPopup(null);
      return;
    }
    event.stopPropagation();
    setCitationPopup({
      label: labels[0]!,
      x: Math.min(0.72, Math.max(0.03, x)),
      y: Math.min(0.72, Math.max(0.03, y))
    });
    // 首次点引用时按需加载参考文献数据（面板没打开也没关系）。
    onRequestReferences?.();
  };

  // 弹窗内容：按引用标签找页面引用 → 条目；识别没覆盖到时按标签直接匹配条目兜底。
  const popupCitations =
    citationPopup && references
      ? (references.citations[String(pageNumber)] ?? []).filter(
          (citation) => citation.label === citationPopup.label
        )
      : [];
  const popupEntries: ReferenceEntry[] = [];
  const pushEntry = (entry: ReferenceEntry | undefined): void => {
    if (entry && !popupEntries.some((item) => item.id === entry.id)) popupEntries.push(entry);
  };
  for (const citation of popupCitations) {
    for (const id of citation.entryIds) {
      pushEntry(references?.entries.find((entry) => entry.id === id));
    }
  }
  if (popupEntries.length === 0 && references && citationPopup) {
    const label = citationPopup.label;
    if (/^\d{1,3}$/.test(label)) {
      for (const entry of references.entries) {
        if (entry.kind === 'end' && entry.label === label) pushEntry(entry);
      }
    } else {
      const space = label.lastIndexOf(' ');
      const surname = label.slice(0, space).trim().toLowerCase();
      const year = label.slice(space + 1).trim().toLowerCase();
      for (const entry of references.entries) {
        if (
          entry.year.toLowerCase() === year &&
          (entry.authors.toLowerCase().includes(surname) ||
            entry.raw.toLowerCase().includes(surname))
        ) {
          pushEntry(entry);
        }
      }
    }
  }

  // 页面框宽度（width）在缩放停止后会立刻变成目标值，但文本层 span 还是按上一次渲染的
  // 像素坐标定位的。先把整个文本层 transform 缩放到新宽度（和画布拉伸、百分比定位的
  // 批注层保持同一口径），等清晰位图与文本层重绘完成后自然回到 1，避免文本层/批注错位。
  const textScaleRaw = size && size.width > 0 ? width / size.width : 1;
  const textScale = Math.abs(textScaleRaw - 1) < 0.002 ? 1 : textScaleRaw;

  return (
    <div
      ref={hostRef}
      className="kr-pdf-page"
      data-page={pageNumber}
      style={{
        width: `${Math.floor(width)}px`,
        aspectRatio: `${1} / ${pageRatio}`
      }}
    >
      <canvas
        ref={canvasRef}
        className="kr-page__image"
        aria-hidden="true"
      />
      {renderError ? (
        <div className="kr-page-error" role="alert">
          <p>
            第 {pageNumber} 页渲染失败：{renderError}
          </p>
          <button
            type="button"
            onClick={() => {
              setRenderError('');
              setSize(null);
              setRenderAttempt((value) => value + 1);
            }}
          >
            重试这一页
          </button>
        </div>
      ) : null}
      <div className="kr-highlights" aria-hidden>
        {maskEditing && pageDataHintQuery.data ? (
          <>
            {pageDataHintQuery.data.lines.map((line, index) => (
              <span
                key={`text-line-hint-${index}`}
                className="kr-text-line-hint"
                style={hintBoxStyle(line.bbox)}
              />
            ))}
            {(pageDataHintQuery.data.spans ?? []).map((span, index) => (
              <span
                key={`text-span-hint-${index}`}
                className="kr-text-span-hint"
                style={hintBoxStyle(span.bbox)}
              />
            ))}
            <span className="kr-text-hint-legend">
              细框=文本行，虚线框=文本项（用于对齐无关区域）
            </span>
          </>
        ) : null}
        {masks.map((mask) => {
          const editing = maskEditing?.id === mask.id;
          const rect = editing ? maskEditing.rect : mask;
          return (
          <div
            key={mask.id}
            className={`kr-page-mask${maskMode ? ' is-editing' : ''}${
              editing ? ' is-resizing' : ''
            }`}
            title={maskMode ? '点击删除此屏蔽区域' : undefined}
            onClick={
              maskMode
                ? (event) => {
                    event.stopPropagation();
                    onDeleteMask?.(mask.id);
                  }
                : undefined
            }
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setMaskMenu({
                id: mask.id,
                page: mask.page || pageNumber,
                x: event.clientX,
                y: event.clientY
              });
            }}
            onPointerDown={
              editing
                ? (event) => {
                    event.stopPropagation();
                    event.currentTarget.setPointerCapture(event.pointerId);
                    maskDragRef.current = {
                      startX: event.clientX,
                      startY: event.clientY,
                      rect: { x0: rect.x0, y0: rect.y0, x1: rect.x1, y1: rect.y1 }
                    };
                  }
                : undefined
            }
            onPointerMove={
              editing
                ? (event) => {
                    const drag = maskDragRef.current;
                    const host = hostRef.current;
                    if (!drag || !host) return;
                    const bounds = host.getBoundingClientRect();
                    const dx = (event.clientX - drag.startX) / bounds.width;
                    const dy = (event.clientY - drag.startY) / bounds.height;
                    const width = drag.rect.x1 - drag.rect.x0;
                    const height = drag.rect.y1 - drag.rect.y0;
                    const x0 = Math.min(1 - width, Math.max(0, drag.rect.x0 + dx));
                    const y0 = Math.min(1 - height, Math.max(0, drag.rect.y0 + dy));
                    setMaskEditing({
                      id: mask.id,
                      rect: { x0, y0, x1: x0 + width, y1: y0 + height }
                    });
                  }
                : undefined
            }
            onPointerUp={
              editing
                ? () => {
                    const current = maskEditing;
                    maskDragRef.current = null;
                    if (current) {
                      onUpdateMask?.(current.id, current.rect);
                    }
                    setMaskEditing(null);
                  }
                : undefined
            }
            style={{
              left: `${rect.x0 * 100}%`,
              top: `${rect.y0 * 100}%`,
              width: `${(rect.x1 - rect.x0) * 100}%`,
              height: `${(rect.y1 - rect.y0) * 100}%`
            }}
          >
            {editing
              ? (['nw', 'ne', 'sw', 'se'] as const).map((corner) => (
                  <span
                    key={corner}
                    className={`kr-mask-handle kr-mask-handle--${corner}`}
                    onPointerDown={(event) => {
                      event.stopPropagation();
                      event.currentTarget.setPointerCapture(event.pointerId);
                      maskResizeRef.current = {
                        corner,
                        startX: event.clientX,
                        startY: event.clientY,
                        rect: { x0: rect.x0, y0: rect.y0, x1: rect.x1, y1: rect.y1 }
                      };
                    }}
                    onPointerMove={(event) => {
                      const drag = maskResizeRef.current;
                      const host = hostRef.current;
                      if (!drag || !host) return;
                      const bounds = host.getBoundingClientRect();
                      const dx = (event.clientX - drag.startX) / bounds.width;
                      const dy = (event.clientY - drag.startY) / bounds.height;
                      const next = { ...drag.rect };
                      if (drag.corner.includes('w')) next.x0 = Math.min(
                        next.x1 - 0.01,
                        Math.max(0, drag.rect.x0 + dx)
                      );
                      if (drag.corner.includes('e')) next.x1 = Math.max(
                        next.x0 + 0.01,
                        Math.min(1, drag.rect.x1 + dx)
                      );
                      if (drag.corner.includes('n')) next.y0 = Math.min(
                        next.y1 - 0.01,
                        Math.max(0, drag.rect.y0 + dy)
                      );
                      if (drag.corner.includes('s')) next.y1 = Math.max(
                        next.y0 + 0.01,
                        Math.min(1, drag.rect.y1 + dy)
                      );
                      setMaskEditing({ id: mask.id, rect: next });
                    }}
                    onPointerUp={() => {
                      maskResizeRef.current = null;
                      const current = maskEditing;
                      if (current) onUpdateMask?.(current.id, current.rect);
                      setMaskEditing(null);
                    }}
                  />
                ))
              : null}
          </div>
          );
        })}
        {locatedBoxes?.map((rect, index) => (
          <div
            key={`located-${index}`}
            className="kr-located"
            style={{
              left: `${rect[0]! * 100}%`,
              top: `${rect[1]! * 100}%`,
              width: `${(rect[2]! - rect[0]!) * 100}%`,
              height: `${(rect[3]! - rect[1]!) * 100}%`
            }}
          />
        ))}
        {size
          ? annotations.flatMap((annotation) => {
              const annotationStyle = annotation.style || 'highlight';
              const rawRects = rectsFor(annotation);
              const displayRects =
                annotationStyle === 'margin' && rawRects.length > 0
                  ? [
                      [
                        Math.min(...rawRects.map((rect) => rect[0]!)),
                        Math.min(...rawRects.map((rect) => rect[1]!)),
                        Math.min(...rawRects.map((rect) => rect[0]!)) + 0.008,
                        Math.max(...rawRects.map((rect) => rect[3]!))
                      ]
                    ]
                  : rawRects;
              return displayRects.map((rect, index) => {
                const color = ANNOTATION_COLORS[annotation.color] ?? ANNOTATION_COLORS.yellow!;
                const underline = annotationStyle === 'underline';
                const margin = annotationStyle === 'margin';
                const region = annotationStyle === 'region';
                return (
                  <div
                    key={`${annotation.id}-${index}`}
                    className={`kr-highlight kr-highlight--${annotationStyle}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      setActiveAnnotation(annotation);
                      setActiveAnnotationNote(annotation.content);
                      setActiveAnnotationColor(annotation.color || 'yellow');
                      setActiveAnnotationStyle(annotation.style || 'highlight');
                      setAnnotationPopoverPos({
                        x: Math.max(8, Math.min(window.innerWidth - 380, event.clientX - 40)),
                        y: Math.max(8, Math.min(window.innerHeight - 260, event.clientY + 12))
                      });
                    }}
                    style={{
                      left: `${rect[0]! * 100}%`,
                      top: `${rect[1]! * 100}%`,
                      width: `${(rect[2]! - rect[0]!) * 100}%`,
                      height: `${(rect[3]! - rect[1]!) * 100}%`,
                      background: underline
                        ? 'transparent'
                        : margin
                          ? 'transparent'
                          : `${color}66`,
                      borderBottom: underline ? `3px solid ${color}` : '2px solid transparent',
                      borderLeft: margin ? `2px solid ${color}` : undefined,
                      color: margin ? color : undefined,
                      border: region ? `2px solid ${color}` : undefined,
                      ['--kr-annotation-color' as string]: color
                    }}
                  />
                );
              });
            })
          : null}
      </div>
      <div
        ref={textLayerRef}
        className="kr-text-layer"
        style={textScale === 1 ? undefined : { transform: `scale(${textScale})` }}
        onMouseUp={startSelection}
        onClick={handleTextClick}
      />
      {citationPopup ? (
        <div
          className="kr-cite-pop"
          style={{ left: `${citationPopup.x * 100}%`, top: `${citationPopup.y * 100}%` }}
          onClick={(event) => event.stopPropagation()}
        >
          <div className="kr-cite-pop__head">
            <strong>引用 {citationPopup.label}</strong>
            <button
              type="button"
              aria-label="关闭引用弹窗"
              onClick={() => setCitationPopup(null)}
            >
              ×
            </button>
          </div>
          {!references ? (
            <p className="kr-cite-pop__empty">正在识别参考文献…</p>
          ) : popupEntries.length === 0 ? (
            <p className="kr-cite-pop__empty">未在参考文献表中找到对应条目。</p>
          ) : (
            <ul>
              {popupEntries.map((entry) => (
                <li key={entry.id}>
                  <button
                    type="button"
                    onClick={() => {
                      onLocateReferenceEntry?.(entry.id);
                      setCitationPopup(null);
                    }}
                  >
                    {referenceEntrySummary(entry)}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
      {regionMode || maskMode || ocrRegionMode ? (
        <div
          className="kr-region-layer"
          onMouseDown={startRegion}
          onMouseMove={moveRegion}
          onMouseUp={finishRegion}
          onMouseLeave={finishRegion}
        >
          {draftRect ? <div className="kr-region-draft" style={draftRect} /> : null}
        </div>
      ) : null}
      {draft?.isRegion
        ? draft.rects.map((rect, index) => (
            <div
              key={`region-selection-${index}`}
              className="kr-region-selection"
              style={{
                left: `${rect[0]! * 100}%`,
                top: `${rect[1]! * 100}%`,
                width: `${(rect[2]! - rect[0]!) * 100}%`,
                height: `${(rect[3]! - rect[1]!) * 100}%`
              }}
            />
          ))
        : null}
      {draft ? (
        <div
          className="kr-selection-actions"
          style={{ left: `${draft.left}px`, top: `${draft.top}px` }}
          onMouseDown={(event) => event.preventDefault()}
        >
          {draft.isRegion ? <span className="kr-selection-actions__hint">框选区域</span> : null}
          {draft.isRegion ? (
            <button
              type="button"
              title="识别这块区域的文字，并以它作为引用向阅读伙伴提问（不会创建批注）"
              onClick={() => {
                const rect = draft.rects[0];
                onAskRegion?.({
                  page: pageNumber,
                  x0: rect?.[0] ?? 0,
                  y0: rect?.[1] ?? 0,
                  x1: rect?.[2] ?? 1,
                  y1: rect?.[3] ?? 1
                });
                setDraft(null);
                setSelectionRects([]);
              }}
            >对此处提问</button>
          ) : (
            <>
              <button type="button" onClick={() => onQuickAction?.('translate', draft.quote)}>翻译</button>
              <button type="button" onClick={() => onQuickAction?.('float', draft.quote)}>浮窗提问</button>
              <button type="button" onClick={() => onQuickAction?.('ask', draft.quote)}>提问</button>
            </>
          )}
          <button type="button" onClick={() => setAnnotationEditor({ style: 'highlight', color: 'yellow' })}>高亮</button>
          <button type="button" onClick={() => setAnnotationEditor({ style: 'underline', color: 'yellow' })}>下划线</button>
          <button type="button" onClick={() => setAnnotationEditor({ style: 'margin', color: 'yellow' })}>段落批注</button>
          {draft.quote ? (
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard.writeText(draft.quote);
                onQuickAction?.('copy', draft.quote);
              }}
            >复制</button>
          ) : null}
        </div>
      ) : null}
      {draft && annotationEditor ? (
        <div className="kr-annotation-editor-backdrop" onMouseDown={() => setAnnotationEditor(null)}>
          <div
            ref={annotationEditorRef}
            className="kr-annotation-editor"
            style={{
              position: 'fixed',
              left: annotationEditorPos.x,
              top: annotationEditorPos.y,
              margin: 0
            }}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header
              onPointerDown={(event) => {
                const rect = event.currentTarget.parentElement?.getBoundingClientRect();
                if (!rect) return;
                setAnnotationEditorDrag({
                  offsetX: event.clientX - rect.left,
                  offsetY: event.clientY - rect.top
                });
              }}
            >
              <strong>添加批注 · 第 {pageNumber} 页</strong>
              <button
                type="button"
                className="kr-annotation-editor__reset"
                onClick={() => {
                  setNote('');
                  setAnnotationEditor({ style: 'highlight', color: 'yellow' });
                }}
              >清空</button>
            </header>
            <blockquote>
              {annotationEditor.style === 'margin' && draft.paragraphQuote
                ? draft.paragraphQuote
                : draft.quote || '区域批注'}
            </blockquote>
            <textarea
              value={note}
              placeholder="写下想法，或直接保存原文高亮"
              onChange={(event) => setNote(event.target.value)}
            />
            <div className="kr-annotation-editor__row">
              <label>标记颜色
                <select
                  value={annotationEditor.color}
                  onChange={(event) => setAnnotationEditor({ ...annotationEditor, color: event.target.value })}
                >
                  <option value="yellow">黄色</option>
                  <option value="green">绿色</option>
                  <option value="blue">蓝色</option>
                  <option value="pink">粉色</option>
                  <option value="purple">紫色</option>
                  <option value="orange">橙色</option>
                </select>
              </label>
              <label>样式
                <select
                  value={annotationEditor.style}
                  onChange={(event) =>
                    setAnnotationEditor({
                      ...annotationEditor,
                      style: event.target.value as SelectionStyle
                    })
                  }
                >
                  <option value="highlight">高亮</option>
                  <option value="underline">下划线</option>
                  <option value="margin">段落批注</option>
                </select>
              </label>
            </div>
            <footer>
              <button type="button" onClick={() => setAnnotationEditor(null)}>取消</button>
              <button
                type="button"
                className="kr-primary"
                onClick={() => {
                  commit(annotationEditor.style, annotationEditor.color);
                  setAnnotationEditor(null);
                }}
              >保存批注</button>
            </footer>
          </div>
        </div>
      ) : null}
      {activeAnnotation ? (
        <div
          ref={annotationPopoverRef}
          className="kr-annotation-popover"
          style={{ left: annotationPopoverPos.x, top: annotationPopoverPos.y }}
        >
            <header
              onPointerDown={(event) => {
                const rect = event.currentTarget.parentElement?.getBoundingClientRect();
                if (!rect) return;
                setAnnotationPopoverDrag({
                  offsetX: event.clientX - rect.left,
                  offsetY: event.clientY - rect.top
                });
              }}
            >
              <strong>
                {activeAnnotationStyle === 'margin'
                  ? '段落侧线'
                  : activeAnnotationStyle === 'underline'
                    ? '下划线'
                    : '高亮'}{' '}
                · 第 {activeAnnotation.page} 页
              </strong>
              <button type="button" onClick={() => setActiveAnnotation(null)}>关闭</button>
            </header>
            {activeAnnotation.quote ? <blockquote>{activeAnnotation.quote}</blockquote> : null}
            <textarea
              value={activeAnnotationNote}
              placeholder="仅标记，无文字批注"
              onChange={(event) => setActiveAnnotationNote(event.target.value)}
            />
            <div className="kr-annotation-editor__row">
              <label>标记颜色
                <select value={activeAnnotationColor} onChange={(event) => setActiveAnnotationColor(event.target.value)}>
                  <option value="yellow">黄色</option>
                  <option value="green">绿色</option>
                  <option value="blue">蓝色</option>
                  <option value="pink">粉色</option>
                  <option value="purple">紫色</option>
                  <option value="orange">橙色</option>
                </select>
              </label>
              <label>样式
                <select value={activeAnnotationStyle} onChange={(event) => setActiveAnnotationStyle(event.target.value)}>
                  <option value="highlight">高亮</option>
                  <option value="underline">下划线</option>
                  <option value="margin">段落批注</option>
                </select>
              </label>
            </div>
            <footer>
              <button
                type="button"
                onClick={() => {
                  onDeleteAnnotation?.(activeAnnotation.id);
                  setActiveAnnotation(null);
                }}
              >删除批注</button>
              <button
                type="button"
                className="kr-primary"
                onClick={() => {
                  onUpdateAnnotation?.(activeAnnotation.id, {
                    content: activeAnnotationNote,
                    color: activeAnnotationColor,
                    style: activeAnnotationStyle
                  });
                  setActiveAnnotation(null);
                }}
              >保存</button>
            </footer>
        </div>
      ) : null}
      {maskMenu ? (
        <div
          className="kr-mask-menu"
          style={{ left: maskMenu.x, top: maskMenu.y }}
          role="menu"
        >
          <strong>屏蔽区域</strong>
          <button
            type="button"
            onClick={() => {
              onUpdateMask?.(maskMenu.id, { scope: 'page', page: pageNumber });
              setMaskMenu(null);
            }}
          >
            仅当前页
          </button>
          <button
            type="button"
            onClick={() => {
              onUpdateMask?.(maskMenu.id, { scope: 'all', page: 0 });
              setMaskMenu(null);
            }}
          >
            所有页
          </button>
          <button
            type="button"
            onClick={() => {
              onUpdateMask?.(maskMenu.id, { scope: 'odd' });
              setMaskMenu(null);
            }}
          >
            奇数页
          </button>
          <button
            type="button"
            onClick={() => {
              onUpdateMask?.(maskMenu.id, { scope: 'even' });
              setMaskMenu(null);
            }}
          >
            偶数页
          </button>
          <button
            type="button"
            onClick={() => {
              onUpdateMask?.(maskMenu.id, {
                scope: 'range',
                page: pageNumber,
                rangeStart: pageNumber,
                rangeEnd: totalPages
              });
              setMaskMenu(null);
            }}
          >
            当前页到末页
          </button>
          <button
            type="button"
            onClick={() => {
              const mask = masks.find((item) => item.id === maskMenu.id);
              if (mask) {
                setMaskEditing({
                  id: mask.id,
                  rect: { x0: mask.x0, y0: mask.y0, x1: mask.x1, y1: mask.y1 }
                });
              }
              setMaskMenu(null);
            }}
          >
            调整区域
          </button>
          <button
            type="button"
            onClick={() => {
              setExcludeEditor({ id: maskMenu.id, value: '' });
              setMaskMenu(null);
            }}
          >
            排除指定页…
          </button>
          <button
            type="button"
            className="kr-danger"
            onClick={() => {
              onDeleteMask?.(maskMenu.id);
              setMaskMenu(null);
            }}
          >
            删除
          </button>
          <button type="button" onClick={() => setMaskMenu(null)}>
            关闭
          </button>
        </div>
      ) : null}
      {excludeEditor ? (
        <div className="kr-mask-dialog" role="dialog" aria-label="排除指定页">
          <strong>排除指定页</strong>
          <p>输入页码，例如 1,3,5-7；屏蔽应用到除这些页外的全部页面。</p>
          <input
            autoFocus
            value={excludeEditor.value}
            onChange={(event) =>
              setExcludeEditor({ ...excludeEditor, value: event.target.value })
            }
            placeholder="1,3,5-7"
          />
          <div className="kr-mask-dialog__actions">
            <button type="button" onClick={() => setExcludeEditor(null)}>
              取消
            </button>
            <button
              type="button"
              className="kr-primary"
              disabled={!excludeEditor.value.trim()}
              onClick={() => {
                const pages = new Set<number>();
                for (const part of excludeEditor.value.split(/[,，、\s]+/)) {
                  if (!part) continue;
                  const range = /^(\d+)\s*[-–—]\s*(\d+)$/.exec(part);
                  if (range) {
                    const start = Number(range[1]);
                    const end = Number(range[2]);
                    for (
                      let page = Math.min(start, end);
                      page <= Math.max(start, end);
                      page += 1
                    ) {
                      if (page >= 1 && page <= totalPages) pages.add(page);
                    }
                  } else if (/^\d+$/.test(part)) {
                    const page = Number(part);
                    if (page >= 1 && page <= totalPages) pages.add(page);
                  }
                }
                if (pages.size === 0) return;
                onUpdateMask?.(excludeEditor.id, {
                  scope: 'exclude',
                  page: 0,
                  excludePages: [...pages].sort((a, b) => a - b)
                });
                setExcludeEditor(null);
              }}
            >
              应用
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

interface OutlineEntry {
  title: string;
  page: number | null;
  items: OutlineEntry[];
}

function PageThumbnail({
  pdf,
  pageNumber,
  active,
  onOpen
}: {
  pdf: PDFDocumentProxy;
  pageNumber: number;
  active: boolean;
  onOpen(page: number): void;
}): JSX.Element {
  const hostRef = useRef<HTMLButtonElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [rendered, setRendered] = useState(false);
  useEffect(() => {
    let cancelled = false;
    let started = false;
    const load = (): void => {
      if (started) return;
      started = true;
      void (async () => {
        const page = await pdf.getPage(pageNumber);
        const canvas = canvasRef.current;
        if (cancelled || !canvas) return;
        const viewport = page.getViewport({ scale: 0.4 });
        canvas.width = Math.max(1, Math.ceil(viewport.width));
        canvas.height = Math.max(1, Math.ceil(viewport.height));
        const context = canvas.getContext('2d');
        if (!context) return;
        await page.render({ canvasContext: context, canvas, viewport }).promise;
        if (!cancelled) setRendered(true);
      })().catch(() => undefined);
    };
    const host = hostRef.current;
    if (!host) {
      load();
      return () => undefined;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          load();
          observer.disconnect();
        }
      },
      { rootMargin: '260px' }
    );
    observer.observe(host);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [pdf, pageNumber]);
  return (
    <button
      ref={hostRef}
      type="button"
      className={`kr-thumbnail${active ? ' is-active' : ''}`}
      title={`第 ${pageNumber} 页`}
      aria-label={`第 ${pageNumber} 页`}
      onClick={() => onOpen(pageNumber)}
    >
      <canvas
        ref={canvasRef}
        className="kr-thumbnail__canvas"
        style={{ display: rendered ? 'block' : 'none' }}
        aria-hidden="true"
      />
      {rendered ? null : <span className="kr-thumbnail__placeholder" />}
      <span className="kr-thumbnail__number">{pageNumber}</span>
    </button>
  );
}

function PageThumbnails({
  pdf,
  pages,
  current,
  onOpen
}: {
  pdf: PDFDocumentProxy;
  pages: number;
  current: number;
  onOpen(page: number): void;
}): JSX.Element {
  return (
    <div className="kr-thumbnails-panel">
      <div className="kr-thumbnails">
        {Array.from({ length: pages }, (_, index) => (
          <PageThumbnail
            key={index + 1}
            pdf={pdf}
            pageNumber={index + 1}
            active={current === index + 1}
            onOpen={onOpen}
          />
        ))}
      </div>
    </div>
  );
}

function OutlineList({
  items,
  onOpen,
  depth = 0
}: {
  items: OutlineEntry[];
  onOpen(entry: OutlineEntry): void;
  depth?: number;
}): JSX.Element {
  return (
    <ul className="kr-outline" style={{ paddingLeft: depth === 0 ? 0 : 14 }}>
      {items.map((item, index) => (
        <li key={`${item.title}-${index}`}>
          <button
            type="button"
            disabled={item.page == null}
            onClick={() => {
              if (item.page != null) onOpen(item);
            }}
          >
            {item.title || '（无标题）'}
          </button>
          {item.items.length > 0 ? (
            <OutlineList items={item.items} onOpen={onOpen} depth={depth + 1} />
          ) : null}
        </li>
      ))}
    </ul>
  );
}

// 实验原型：连续滚动来自 O修改建议.txtO，未纳入重构方案/parity 范围；保留待定。
function matchesShortcut(event: KeyboardEvent, spec: string): boolean {
  const parts = spec
    .split('+')
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  if (parts.length === 0) return false;
  const key = parts[parts.length - 1] ?? '';
  const ctrl = parts.includes('ctrl') || parts.includes('control');
  const shift = parts.includes('shift');
  const alt = parts.includes('alt') || parts.includes('option');
  const meta = parts.includes('meta') || parts.includes('cmd') || parts.includes('command');
  if (event.ctrlKey !== ctrl || event.shiftKey !== shift || event.altKey !== alt) return false;
  if (event.metaKey !== meta) return false;
  const eventKey = event.key.toLowerCase();
  const normalizedKey =
    key === 'space' ? ' ' : key === 'esc' ? 'escape' : key === 'del' ? 'delete' : key;
  return eventKey === normalizedKey;
}

function chatHistoryKey(documentId: string): string {
  return `studianda.chat.history.${documentId}`;
}

/** 阅读伙伴：上次打开的会话 id（每篇文献一个；仅本地偏好，会话清单在服务端）。 */
function activeChatSessionKey(documentId: string): string {
  return `studianda.chat.activeSession.${documentId}`;
}

function readActiveChatSessionId(documentId: string): string {
  try {
    return window.localStorage.getItem(activeChatSessionKey(documentId))?.trim() ?? '';
  } catch {
    return '';
  }
}

function writeActiveChatSessionId(documentId: string, sessionId: string): void {
  try {
    window.localStorage.setItem(activeChatSessionKey(documentId), sessionId);
  } catch {
    // 本地存储不可用时只影响下次打开时默认选中哪个会话。
  }
}

/** 新建一个空的阅读伙伴会话（标题在首条用户问题后填充）。 */
function newChatSessionRecord(): DocumentChatSessionRecord {
  const now = new Date().toISOString();
  return { id: crypto.randomUUID(), title: '', created: now, updated: now };
}

/** 会话下拉里的显示名：有标题用标题，否则按序号/legacy 兜底。 */
function documentChatSessionLabel(session: DocumentChatSessionRecord, index: number): string {
  const title = session.title.trim();
  if (title) return title;
  return session.id === 'legacy' ? '默认对话' : `对话 ${index + 1}`;
}

/**
 * 读取该文献旧的 localStorage 会话历史（仅用于一次性迁移到 legacy 会话）。
 */
function loadChatHistory(documentId: string): ChatMessageView[] {
  try {
    const raw = window.localStorage.getItem(chatHistoryKey(documentId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (item): item is ChatMessageView =>
          Boolean(item) &&
          typeof item === 'object' &&
          ((item as ChatMessageView).role === 'user' ||
            (item as ChatMessageView).role === 'assistant') &&
          typeof (item as ChatMessageView).content === 'string'
      )
      .slice(-100);
  } catch {
    return [];
  }
}

/**
 * 写进 `messages.metadata` 的整轮回答。
 *
 * `sources` 已经单独存在同名数据库列里：metadata 里再存一份会让同一批来源在 DB 里存两遍，
 * 所以这里只去掉 `sources`，其余字段（notice/audit/coverage/citation_support/reading_scope…）
 * 原样保留，重启后能完整恢复回答面板。
 */
function chatResponseForStorage(response: ChatResponse): Record<string, unknown> {
  const { sources: _sources, ...rest } = response;
  return { ...rest };
}

/**
 * 从 DB 行恢复助手回答（用户行没有 response）：
 * - 新行：`metadata.response` 里存了整轮 ChatResponse（已去掉 sources），拼回单独列的 sources；
 * - 旧行：只有 content + sources 列，退回最小回答 `{answer, sources}`，兼容旧数据。
 */
function chatResponseFromRecord(row: ChatMessageRecord): ChatResponse | undefined {
  if (row.role !== 'assistant') return undefined;
  const sources = Array.isArray(row.sources) ? row.sources : [];
  const stored = (row.metadata ?? {}).response;
  if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
    return { ...(stored as ChatResponse), sources };
  }
  return { answer: row.content, sources };
}

/** 阅读伙伴消息分页：默认每页条数（最新一页）。 */
const MESSAGE_PAGE_SIZE = 60;

/** 阅读伙伴会话内搜索的返回结构（含命中片段与总数）。 */
type MessageSearchResult = Awaited<ReturnType<ApiClient['searchDocumentMessages']>>;

/** DB 行 → ChatPanel 的消息视图（富 response 从 metadata.response 恢复）。 */
function chatMessageViewFromRecord(row: ChatMessageRecord): ChatMessageView {
  const metadata = row.metadata ?? {};
  return {
    id: `db-${row.id}`,
    role: row.role,
    content: row.content,
    quote: typeof metadata.quote === 'string' ? metadata.quote : undefined,
    quotePage: typeof metadata.quotePage === 'number' ? metadata.quotePage : undefined,
    quoteName: typeof metadata.quoteName === 'string' ? metadata.quoteName : undefined,
    response: chatResponseFromRecord(row)
  };
}

/** `db-123` → 123；本地 uuid 消息 → null。 */
function dbIdOfMessageId(messageId: string): number | null {
  const match = /^db-(\d+)$/.exec(messageId);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

// 同一文献的会话清单初始化任务：StrictMode 双调用/页面快速重建时共享同一个任务，
// 避免重复建初始会话或重复迁移旧 localStorage 历史。
const documentChatBootstrapTasks = new Map<
  string,
  Promise<DocumentChatSessionRecord[]>
>();

/**
 * 打开文献时初始化阅读伙伴会话清单。
 *
 * - 清单为空：DB 全空 + localStorage 旧历史非空 → 逐条迁移成 legacy 会话；
 *   有旧消息（无 sessionId）→ 建 legacy 会话；都没有 → 新建 uuid 空会话；
 * - 初始会话用细粒度 `create`（服务端幂等，不覆盖摘要/版本），创建后再 GET 权威清单。
 */
function bootstrapDocumentChatSessions(
  api: ApiClient,
  documentId: string
): Promise<DocumentChatSessionRecord[]> {
  const running = documentChatBootstrapTasks.get(documentId);
  if (running) return running;
  const task = (async (): Promise<DocumentChatSessionRecord[]> => {
    const sessions = await api.listDocumentChatSessions(documentId);
    if (sessions.length > 0) return sessions;
    const allMessages = await api.listMessages(documentId);
    const legacyLocal = loadChatHistory(documentId);
    const now = new Date().toISOString();
    let initialSessions: DocumentChatSessionRecord[];
    if (allMessages.length === 0 && legacyLocal.length > 0) {
      // 旧版 localStorage 历史一次性迁移成 legacy 会话（消息本身不带 sessionId）。
      for (const message of legacyLocal) {
        const response = message.response;
        const userMeta =
          message.role === 'user'
            ? {
                quote: message.quote ?? null,
                quotePage: message.quotePage ?? null,
                quoteName: message.quoteName ?? null
              }
            : {};
        const assistantMeta = response
          ? {
              response: chatResponseForStorage(response),
              taskId: response.taskId ?? null,
              scope: response.reading_scope ?? null
            }
          : {};
        await api.addMessage({
          documentId,
          role: message.role,
          content: message.content,
          sources: response?.sources ?? [],
          metadata: { sessionId: 'legacy', ...userMeta, ...assistantMeta }
        });
      }
      try {
        window.localStorage.removeItem(chatHistoryKey(documentId));
      } catch {
        // 移除失败不影响迁移结果
      }
      initialSessions = [{ id: 'legacy', title: '默认对话', created: now, updated: now }];
    } else if (allMessages.length > 0) {
      // 已有旧消息（没有 sessionId）：建 legacy 会话承接，不重复写消息。
      initialSessions = [{ id: 'legacy', title: '默认对话', created: now, updated: now }];
    } else {
      initialSessions = [newChatSessionRecord()];
    }
    // 细粒度 create：同 id 已存在时服务端返回已有记录，不覆盖摘要/版本。
    for (const session of initialSessions) {
      await api.createDocumentChatSession(documentId, session);
    }
    const listed = await api.listDocumentChatSessions(documentId);
    return listed.length > 0 ? listed : initialSessions;
  })();
  const tracked = task.then(
    (value) => {
      documentChatBootstrapTasks.delete(documentId);
      return value;
    },
    (error: unknown) => {
      documentChatBootstrapTasks.delete(documentId);
      throw error;
    }
  );
  documentChatBootstrapTasks.set(documentId, tracked);
  return tracked;
}

/**
 * 把「最新一页」DB 快照合并进本地消息。
 *
 * - 以 DB 最新一页为准（富 response 从 metadata 恢复），这样回答/编辑/删除后一定用上 DB 快照；
 * - 本地还有尚未落库或写入失败的消息（非 db-* 且角色+内容不在 DB 页里）时按原顺序补在末尾，
 *   避免 DB 落后把本地刚产生的历史清短。
 */
function mergeLatestMessagePage(
  current: ChatMessageView[],
  rows: ChatMessageRecord[]
): ChatMessageView[] {
  const page = rows.map(chatMessageViewFromRecord);
  const dbKeys = new Set(page.map((message) => `${message.role}\u0000${message.content.trim()}`));
  const localOnly = current.filter((message) => {
    if (dbIdOfMessageId(message.id) !== null) return false;
    return !dbKeys.has(`${message.role}\u0000${message.content.trim()}`);
  });
  return localOnly.length > 0 ? [...page, ...localOnly] : page;
}


/** 存为笔记里的一条来源：文献来源给「文档名 第 x 页」，联网来源给 URL。 */
function chatSourceLine(source: ChatSource, index: number): string {
  const name = source.documentName?.trim() || '未命名来源';
  if (source.kind === 'web' || source.url) {
    return `[${index}] ${name}${source.url ? `（联网来源：${source.url}）` : ''}`;
  }
  const pageEnd =
    source.pageEnd && source.page > 0 && source.pageEnd > source.page ? `–${source.pageEnd}` : '';
  const page = source.page > 0 ? ` 第 ${source.page}${pageEnd} 页` : '';
  return `[${index}] ${name}${page}`;
}

/** 笔记/批注来源：明确标注是用户记录，不是文献原文证据。 */
function chatMemorySourceLine(source: ChatSource): string {
  const kind = source.kind === 'annotation' ? '批注' : '笔记';
  const name = source.documentName?.trim() || `本机${kind}`;
  const page = source.page > 0 ? ` 第 ${source.page} 页` : '';
  return `- ${name}${page}（笔记/批注，非原文证据）`;
}

/**
 * 「存为笔记」的 Markdown：回答正文 + 依据列表。
 *
 * - 文献来源给「文档名 第 N 页」；网页来源给可点击 URL；
 * - 笔记/批注来源单独成节并标注「非文献原文证据」（它们是用户自己的记录，不是原文证据）。
 */
function chatAnswerAsMarkdown(message: ChatMessageView): string {
  const response = message.response;
  const lines: string[] = [message.content.trim() || '（这一轮没有产生文字回答。）'];
  const sources = response?.sources ?? [];
  if (sources.length > 0) {
    lines.push('', '## 依据', '');
    sources.forEach((source, index) => lines.push(`- ${chatSourceLine(source, index + 1)}`));
  }
  const memorySources = response?.memory_sources ?? [];
  if (memorySources.length > 0) {
    lines.push('', '## 参考的本机笔记/批注（非文献原文证据）', '');
    for (const source of memorySources) lines.push(chatMemorySourceLine(source));
  }
  // 文件头写 AI 生成显式提示 + 隐式注释；用户正文原样保留。
  return withAiNoteHeader(`${lines.join('\n').trimEnd()}\n`);
}

/** 格式化本地时间（搜索结果/会话时间显示用，时区跟随本机）。 */
function formatChatExportTime(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}`;
}

/**
 * 「存为笔记」的 externalKey（幂等用）：按回答正文算稳定的 32 位 hash。
 *
 * 阅读页消息 id 有本地 uuid 与 DB 行 id（`db-*`）两种形态，不能只靠 id；
 * 同一回答重复点「存为笔记」时，服务端用 documentId + externalKey 返回已有笔记。
 */
function chatAnswerExternalKey(documentId: string, content: string): string {
  let hash = 0;
  for (let index = 0; index < content.length; index += 1) {
    // Math.imul 固定 32 位乘法溢出行为，保证不同引擎/会话算出的 hash 一致。
    hash = (Math.imul(hash, 31) + content.charCodeAt(index)) | 0;
  }
  return `chat-answer:${documentId}:${(hash >>> 0).toString(36)}`;
}

function recentReadingHistory(
  messages: ChatMessageView[],
  rounds: number
): Array<{ question: string; answer?: string }> {
  const pairs: Array<{ question: string; answer?: string }> = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message?.role !== 'user') continue;
    const next = messages[index + 1];
    pairs.push({
      question: message.content,
      answer: next?.role === 'assistant' ? next.content : undefined
    });
  }
  return pairs.slice(-Math.max(1, rounds));
}

function isMeaningfulNavigationLabel(label: string): boolean {
  const cleaned = label
    .replace(/[\s\d.,，。、；;:：""''（）()[\]《》〈〉\-—_/\\|]/g, '')
    .trim();
  return cleaned.length >= 2;
}

/**
 * 解析「目录页」输入：支持 `3`、`3,4`、`3-5`、`3–5`，去重排序并限制在 1..total。
 * 非法输入返回空数组（界面据此禁用按钮）。
 */
function parseTocPagesInput(input: string, total: number): number[] {
  const result = new Set<number>();
  const text = input.trim().replace(/[，、]/g, ',').replace(/[–—~至]/g, '-');
  if (!text) return [];
  for (const part of text.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const range = trimmed.match(/^(\d{1,4})\s*-\s*(\d{1,4})$/);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      if (end >= start && end - start <= 200) {
        for (let page = start; page <= end; page += 1) {
          if (page >= 1 && (total <= 0 || page <= total)) result.add(page);
        }
      }
      continue;
    }
    const single = trimmed.match(/^\d{1,4}$/);
    if (single) {
      const page = Number(single[0]);
      if (page >= 1 && (total <= 0 || page <= total)) result.add(page);
    }
  }
  return [...result].sort((left, right) => left - right);
}

/** 批注 id → 与摘引重叠的译文（面板只显示有译文的那几条）。 */
function annotationTranslationMap(rows: AnnotationRecord[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const row of rows) {
    const text = row.translation?.[0]?.text?.trim();
    if (text) map[row.id] = text;
  }
  return map;
}

/**
 * 解析批注保存的 0..1 归一化矩形（左上原点）；坏数据返回空数组。
 * 有 rects 的批注（含从 Zotero 坐标换算来的）定位时直接按这些框跳转，不再逐字查文本层。
 */
function normalizedAnnotationRects(raw: string): number[][] {
  if (!raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (rect): rect is number[] =>
        Array.isArray(rect) &&
        rect.length === 4 &&
        rect.every(
          (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
        ) &&
        rect[0]! < rect[2]! &&
        rect[1]! < rect[3]!
    );
  } catch {
    return [];
  }
}

function ReaderView({
  api,
  adapter,
  document,
  documents,
  standaloneNotes,
  initialPage,
  initialQuote,
  initialPanel,
  onOpenDocument,
  onOpenStandaloneNote,
  onBack
}: {
  api: ApiClient;
  adapter: AppRuntimeAdapter;
  document: DocumentSummary;
  documents?: DocumentSummary[];
  /** 独立笔记列表：阅读侧栏新建笔记时可在内部引用里选独立笔记。 */
  standaloneNotes?: NoteRecord[];
  initialPage?: number;
  initialQuote?: string;
  /** 打开时的默认侧栏面板：会话来源里的笔记/批注可直接落到对应面板。 */
  initialPanel?: 'annotations' | 'notes' | 'chat' | 'references';
  onOpenDocument?(documentId: string, page: number, quote?: string): void;
  /** 内部引用目标是独立笔记（documentId=''）时切到独立笔记视图。 */
  onOpenStandaloneNote?(noteId: string): void;
  onBack(): void;
}): JSX.Element {
  const queryClient = useQueryClient();
  // 译文栏「版式」呈现用：按需拉当前页页面图像（服务端渲染并带缓存，不改原 PDF）。
  const loadTranslationPageImage = useCallback(
    (targetPage: number, width: number) =>
      api.getPageImage(document.id, targetPage, width),
    [api, document.id]
  );
  // 断点 1180（§6.5）：≤1180 时右栏/译文栏都是覆盖层，需要 JS 参与默认开合与互斥。
  const isOverlay = useMediaQuery('(max-width: 1180px)');
  const [notePurgeNotice, setNotePurgeNotice] = useState('');
  // 阅读伙伴多会话：会话清单存服务端 settings（随备份），消息归属靠 metadata.sessionId；
  // 没有 sessionId 的旧消息归到 `legacy` 会话。
  const chatSessionsRef = useRef<DocumentChatSessionRecord[]>([]);
  // 会话清单保存的序号：并发保存时只用最新一次的结果写回 state，避免旧响应覆盖新状态。
  const sessionsWriteSeqRef = useRef(0);
  const [chatSessions, setChatSessions] = useState<DocumentChatSessionRecord[]>([]);
  const [sessionsReady, setSessionsReady] = useState(false);
  const [activeSessionId, setActiveSessionId] = useState('');
  /**
   * 内联重命名草稿：「更多 → 改名」后会话下拉位置换成输入框。
   * Electron 渲染进程没有 window.prompt，所以改名必须在应用内完成（Enter 提交 / Esc 取消 / 失焦提交）。
   * ref 与 state 同步保存草稿：Enter 里先结束再提交时，blur 不会再重复提交一次。
   */
  const [chatRenameDraft, setChatRenameDraft] = useState<{
    sessionId: string;
    value: string;
  } | null>(null);
  const chatRenameDraftRef = useRef<{ sessionId: string; value: string } | null>(null);
  // 消息历史分页：默认只拉「最新一页」，往前翻由「加载更早」按 beforeId 取上一页并前置合并。
  // staleTime=Infinity + 关闭焦点自动刷新：由业务动作显式 invalidate/refetch，避免后台刷新
  // 把用户已经展开的更早历史又折叠回最新一页。
  const chatPageQuery = useQuery({
    queryKey: ['messages', document.id, activeSessionId, 'page'],
    queryFn: () =>
      api.listMessagesPage(document.id, {
        sessionId: activeSessionId,
        limit: MESSAGE_PAGE_SIZE
      }),
    enabled: activeSessionId !== '',
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false
  });
  const readingTasksQuery = useQuery({
    queryKey: ['reading-tasks', document.id],
    queryFn: () => api.listReadingTasks(document.id)
  });
  // 文档级反向链接：右栏「被引用」页签的计数徽标要在打开侧栏时立刻可见，
  // 所以随阅读页一起拉取（本地 API，一次请求；页签内容复用同一份数据）。
  const documentBacklinksQuery = useQuery({
    queryKey: ['backlinks', 'document', document.id],
    queryFn: () => api.listBacklinks({ kind: 'document', documentId: document.id })
  });
  const shortcutSettings = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.getSettings()
  });
  const shortcut = (name: string, fallback: string): string =>
    shortcutSettings.data?.[`shortcut.${name}`] || fallback;
  const [page, setPage] = useState(Math.max(1, initialPage ?? document.currentPage));
  const restoredPageRef = useRef(false);
  /**
   * 键盘快捷键用 ref 保存"最新一次渲染的 handler"再注册一次监听：
   * 避免 effect 依赖不全导致闭包读到旧的面板状态（stale closure），
   * 也避免每次面板/设置变化都重复 add/removeEventListener。
   */
  const keyHandlerRef = useRef<(event: KeyboardEvent) => void>(() => {});
  keyHandlerRef.current = (event: KeyboardEvent): void => {
    const target = event.target as HTMLElement | null;
    const tag = target?.tagName?.toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || target?.isContentEditable) {
      return;
    }
    // 设置以覆盖层打开时，阅读器快捷键不应在背后响应（焦点/输入仍归设置）。
    if (window.document.querySelector('.kr-settings-backdrop')) return;
    if (matchesShortcut(event, shortcut('prevPage', 'PageUp')) || event.key === 'ArrowLeft') {
      event.preventDefault();
      setPage((value) => Math.max(1, value - 1));
      return;
    }
    if (matchesShortcut(event, shortcut('nextPage', 'PageDown')) || event.key === 'ArrowRight') {
      event.preventDefault();
      setPage((value) => Math.min(document.pages, value + 1));
      return;
    }
    if (matchesShortcut(event, shortcut('zoomIn', 'Ctrl+='))) {
      event.preventDefault();
      setZoomAnchored(Math.min(240, Math.round(zoomRef.current * 100) + 5) / 100);
      return;
    }
    if (matchesShortcut(event, shortcut('zoomOut', 'Ctrl+-'))) {
      event.preventDefault();
      setZoomAnchored(Math.max(60, Math.round(zoomRef.current * 100) - 5) / 100);
      return;
    }
    if (matchesShortcut(event, shortcut('fitWidth', 'Ctrl+0'))) {
      event.preventDefault();
      setZoomAnchored(1);
      return;
    }
    if (matchesShortcut(event, shortcut('toggleSidebar', 'Ctrl+Shift+L'))) {
      event.preventDefault();
      togglePanel();
      return;
    }
    if (matchesShortcut(event, shortcut('ocrBox', 'Ctrl+Shift+O'))) {
      event.preventDefault();
      setRegionMode((value) => !value);
      setMaskMode(false);
      return;
    }
    if (matchesShortcut(event, shortcut('askSelection', 'Ctrl+Enter'))) {
      const selection = window.getSelection()?.toString().replace(/\s+/g, ' ').trim() ?? '';
      if (selection) {
        event.preventDefault();
        setChatQuote(selection);
        setChatDraft(`关于选中的原文「${selection.slice(0, 80)}」：`);
        setPanel('chat');
        openPanel();
      }
      return;
    }
    if (matchesShortcut(event, shortcut('stop', 'Escape'))) {
      setRegionMode(false);
      setMaskMode(false);
      setOcrRegionMode(false);
      setOcrRegionResult(null);
      setOcrRegionError(null);
      askAbortRef.current?.abort();
      return;
    }
  };
  useEffect(() => {
    const listener = (event: KeyboardEvent): void => keyHandlerRef.current(event);
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, []);
  const [annotationScope, setAnnotationScope] = useState<'page' | 'document'>('page');
  const [panel, setPanel] = useState<
    'annotations' | 'notes' | 'chat' | 'references' | 'backlinks'
  >(initialPanel ?? 'chat');
  /** 正文里点了引用标记、但还没打开「参考」面板时，按需拉取参考文献数据。 */
  const [referencesWanted, setReferencesWanted] = useState(false);
  const [readerNav, setReaderNav] = useState<'pages' | 'outline' | null>(null);
  const [structureOpen, setStructureOpen] = useState(false);
  const blocksQuery = useQuery({
    queryKey: ['document-blocks', document.id],
    queryFn: () => api.getDocumentBlocks(document.id),
    enabled: structureOpen,
    staleTime: 60_000
  });
  useEffect(() => {
    if (!readerNav) return;
    const closeOnOutside = (event: PointerEvent): void => {
      const target = event.target as Element | null;
      if (target?.closest('.kr-reader-nav, .kr-reader__reader-nav')) return;
      setReaderNav(null);
    };
    window.document.addEventListener('pointerdown', closeOnOutside, true);
    return () => {
      window.document.removeEventListener('pointerdown', closeOnOutside, true);
    };
  }, [readerNav]);
  const [translationQuote, setTranslationQuote] = useState<string | null>(null);
  // 译文对照：由阅读区上方功能栏打开，作为原文与阅读伙伴之间的独立一栏；可与阅读伙伴同时展开。
  const [translationOpen, setTranslationOpen] = useState(false);
  const [ocrText, setOcrText] = useState<string | null>(null);
  const [outline, setOutline] = useState<OutlineEntry[]>([]);
  const [outlineEditing, setOutlineEditing] = useState(false);
  const [outlineDraft, setOutlineDraft] = useState<Array<{ page: number; label: string }>>([]);
  /** 目录面板当前展示哪个来源：PDF 内置目录优先，其次本地目录。 */
  const [outlineSource, setOutlineSource] = useState<'embedded' | 'local'>('embedded');
  /** 「按目录页生成」输入（如 3-5 / 3,4）。 */
  const [tocPagesInput, setTocPagesInput] = useState('');
  const saveOutline = useMutation({
    mutationFn: (nodes: Array<{ page: number; label: string }>) =>
      api.saveNavigation(document.id, nodes),
    onSuccess: () => {
      setOutlineEditing(false);
      // 保存的是本地目录：切到本地来源，避免用户改完还停在"PDF 内置目录"上。
      setOutlineSource('local');
      void queryClient.invalidateQueries({ queryKey: ['navigation', document.id] });
      void queryClient.invalidateQueries({ queryKey: ['navigation-preview', document.id] });
      void queryClient.invalidateQueries({ queryKey: ['navigation-status', document.id] });
    }
  });
  const [pageInput, setPageInput] = useState(String(page));
  const [maskAllPages, setMaskAllPages] = useState(false);
  const [maskScope, setMaskScope] = useState<
    'page' | 'all' | 'odd' | 'even' | 'range' | 'exclude'
  >('page');
  const [regionMode, setRegionMode] = useState(false);
  const [maskMode, setMaskMode] = useState(false);
  // 区域 OCR：框选页面的一块，只识别/展示这块文字，不写回页面文字（避免覆盖整页 OCR）。
  const [ocrRegionMode, setOcrRegionMode] = useState(false);
  const [ocrRegionPending, setOcrRegionPending] = useState(false);
  const ocrRegionElapsed = useElapsedSeconds(ocrRegionPending);
  const [ocrJob, setOcrJob] = useState<OcrJobRecord | null>(null);
  const [ocrRegionError, setOcrRegionError] = useState<string | null>(null);
  /** 区域识别来源提示（如「识别方式是 MinerU，本次改用视觉模型、MinerU 没有被调用」）。 */
  const [ocrRegionNotice, setOcrRegionNotice] = useState('');
  useEffect(() => {
    if (!ocrRegionNotice) return undefined;
    // 来源提示是信息性的：顶部横幅展示，10 秒后自动消失；重新识别时也会清空。
    const timer = window.setTimeout(() => setOcrRegionNotice(''), 10_000);
    return () => window.clearTimeout(timer);
  }, [ocrRegionNotice]);
  const [ocrRegionResult, setOcrRegionResult] = useState<{
    page: number;
    text: string;
    textReflowed: string;
    bbox: [number, number, number, number];
    engine: string;
    /** 来源说明：识别方式为 MinerU 时明确写「改用视觉模型、MinerU 没有被调用」。 */
    engine_note?: string;
    /** 回退来源（mineru_online / mineru_agent 等）。 */
    fallback_from?: string;
  } | null>(null);
  const [ocrRegionCopyMessage, setOcrRegionCopyMessage] = useState('');
  /**
   * 区域识别完成后做什么：'result' = 弹出识别结果（原 OCR 框选按钮的流程）；
   * 'ask' = 不弹结果，直接把识别出的文字作为引用打开阅读伙伴提问。
   */
  const ocrRegionIntentRef = useRef<'result' | 'ask'>('result');

  const recognizeRegion = async (
    region: {
      page: number;
      x0: number;
      y0: number;
      x1: number;
      y1: number;
    },
    options?: { ask?: boolean }
  ): Promise<void> => {
    if (ocrRegionPending) return;
    ocrRegionIntentRef.current = options?.ask ? 'ask' : 'result';
    setOcrRegionPending(true);
    setOcrRegionError(null);
    setOcrRegionNotice('');
    setOcrJob(null);
    try {
      const { jobId } = await api.startOcrRegionJob(document.id, region.page, {
        x0: region.x0,
        y0: region.y0,
        x1: region.x1,
        y1: region.y1
      });
      setOcrJob({
        id: jobId,
        state: 'queued',
        progress: 0,
        stage: 'queued',
        page: region.page,
        startedAt: new Date().toISOString()
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : '未知错误';
      setOcrRegionPending(false);
      if (ocrRegionIntentRef.current === 'ask') {
        // 识别服务起不来也要能问：退回「第 N 页框选区域」说明，不打断提问流程。
        ocrRegionIntentRef.current = 'result';
        askWithRegionQuote(region.page, '');
      } else {
        setOcrRegionError(`区域识别失败：${message}`);
      }
    }
  };

  /**
   * 把「框选区域」作为提问引用打开阅读伙伴：识别出文字就用文字，
   * 识别不到（或识别服务不可用）时用页码 + 区域说明兜底，而不是只报错。
   */
  const askWithRegionQuote = (pageNumber: number, text?: string | null): void => {
    const clean = (text ?? '').replace(/\s+/g, ' ').trim();
    setChatQuote(
      clean ||
        `第 ${pageNumber} 页的框选区域（未能识别出文字，请根据这块区域的页面截图回答）`
    );
    setPanel('chat');
    openPanel();
  };

  /** 框选区域便捷菜单「对此处提问」：复用区域 OCR，完成后不弹结果窗，直接进入会话引用。 */
  const askRegion = (region: {
    page: number;
    x0: number;
    y0: number;
    x1: number;
    y1: number;
  }): void => {
    setRegionMode(false);
    if (ocrRegionPending) {
      setOcrRegionError('区域识别还在进行中，请稍候再提问。');
      return;
    }
    void recognizeRegion(region, { ask: true });
  };

  // 轮询区域 OCR 任务：识别在 Core 内异步执行，按钮显示进度；取消后丢弃结果。
  useEffect(() => {
    if (!ocrJob || !['queued', 'running', 'cancelling'].includes(ocrJob.state)) {
      return undefined;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const next = await api.getOcrRegionJob(document.id, ocrJob.id);
          if (cancelled) return;
          if (next.state === 'done') {
            const intent = ocrRegionIntentRef.current;
            ocrRegionIntentRef.current = 'result';
            setOcrRegionMode(false);
            setOcrRegionCopyMessage('');
            setOcrRegionPending(false);
            setOcrJob(null);
            if (intent === 'ask') {
              // 「对此处提问」：不弹识别结果窗，直接把区域文字带进阅读伙伴。
              // 但来源说明不能丢：识别方式为 MinerU 时会改用视觉模型，
              // 用 ReaderView 自己的通知条说清「本次没有使用 MinerU」。
              const note = next.result?.engine_note;
              if (note) setOcrRegionNotice(note);
              askWithRegionQuote(
                next.page,
                next.result?.textReflowed || next.result?.text
              );
              return;
            }
            setOcrRegionResult(next.result ? { ...next.result, page: next.page } : null);
          } else if (next.state === 'failed') {
            const message = next.error?.message ?? '未知错误';
            setOcrRegionPending(false);
            setOcrJob(null);
            if (ocrRegionIntentRef.current === 'ask') {
              ocrRegionIntentRef.current = 'result';
              askWithRegionQuote(next.page, '');
            } else {
              setOcrRegionError(`区域识别失败：${message}`);
            }
          } else if (next.state === 'cancelled') {
            setOcrRegionPending(false);
            setOcrJob(null);
            if (ocrRegionIntentRef.current === 'ask') {
              ocrRegionIntentRef.current = 'result';
              askWithRegionQuote(next.page, '');
            } else {
              setOcrRegionError('区域识别已取消。');
            }
          } else {
            setOcrJob(next);
          }
        } catch (error) {
          if (cancelled) return;
          setOcrRegionPending(false);
          setOcrJob(null);
          if (ocrRegionIntentRef.current === 'ask') {
            ocrRegionIntentRef.current = 'result';
            askWithRegionQuote(ocrJob.page, '');
          } else {
            setOcrRegionError(
              `区域识别状态读取失败：${error instanceof Error ? error.message : '未知错误'}`
            );
          }
        }
      })();
    }, 500);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [ocrJob, document.id, api]);

  const cancelOcrRegion = async (): Promise<void> => {
    if (!ocrJob) return;
    try {
      setOcrJob(await api.cancelOcrRegionJob(document.id, ocrJob.id));
    } catch (error) {
      setOcrRegionError(
        `取消区域识别失败：${error instanceof Error ? error.message : '未知错误'}`
      );
    }
  };

  const copyReflowedRegionText = async (): Promise<void> => {
    const text = ocrRegionResult?.textReflowed || ocrRegionResult?.text || '';
    // 识别文本可能来自视觉模型或本机 OCR：复制时强制附带显式标识，避免无感知传播。
    const marked = `${text}${AI_OCR_COPY_SUFFIX}`;
    try {
      await navigator.clipboard.writeText(marked);
      setOcrRegionCopyMessage('已复制整理后的文本（含 AI/机器识别标识）。');
    } catch {
      setOcrRegionCopyMessage('复制失败：请手动选中文本复制。');
    }
  };
  // 指定了默认面板（从会话来源的笔记/批注跳进来）时直接展开侧栏，窄窗口也照常打开。
  const [panelOpen, setPanelOpen] = useState(
    () => Boolean(initialPanel) || window.innerWidth > 1180
  );
  // 覆盖档（≤1180）下右栏与译文栏都是浮层：同一时刻只留一个，避免两块同位置重叠。
  const openPanel = (): void => {
    if (isOverlay && translationOpen) setTranslationOpen(false);
    setPanelOpen(true);
  };
  const togglePanel = (): void => {
    if (panelOpen) {
      setPanelOpen(false);
      return;
    }
    openPanel();
  };
  const openTranslation = (): void => {
    if (isOverlay && panelOpen) setPanelOpen(false);
    setTranslationOpen(true);
  };
  const toggleTranslation = (): void => {
    if (translationOpen) {
      setTranslationOpen(false);
      return;
    }
    openTranslation();
  };
  // 从宽屏（两块可同时开）缩进覆盖档：保留译文、收起右栏，跨档不丢用户状态。
  useEffect(() => {
    if (isOverlay && panelOpen && translationOpen) setPanelOpen(false);
    // 只在跨过 1180 时执行；开合本身由上面的 helper 保证互斥。
  }, [isOverlay]);
  const [chatComposerFocused, setChatComposerFocused] = useState(false);
  const [sideWidth, setSideWidth] = useState(() => {
    try {
      const stored = Number(window.localStorage.getItem('studianda.side.width'));
      if (Number.isFinite(stored) && stored >= 240 && stored <= 560) return stored;
    } catch {
      // 忽略不可用的本地存储
    }
    return 320;
  });
  const [sideResize, setSideResize] = useState<{
    startX: number;
    startWidth: number;
  } | null>(null);
  useEffect(() => {
    if (!sideResize) return;
    const move = (event: PointerEvent): void => {
      setSideWidth(
        Math.min(560, Math.max(240, sideResize.startWidth + sideResize.startX - event.clientX))
      );
    };
    const up = (): void => setSideResize(null);
    window.document.body.classList.add('kr-resizing-side');
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
    return () => {
      window.document.body.classList.remove('kr-resizing-side');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }, [sideResize]);
  useEffect(() => {
    try {
      window.localStorage.setItem('studianda.side.width', String(sideWidth));
    } catch {
      // 本地存储不可用时只保留本次会话
    }
  }, [sideWidth]);
  const sideStyle = { '--kr-side-width': `${sideWidth}px` } as CSSProperties;
  // 阅读区内的译文栏：独立宽度、可拖动，默认比「阅读伙伴」宽一些（逐段对照需要更多字）。
  const [translationWidth, setTranslationWidth] = useState(() => {
    try {
      const stored = Number(window.localStorage.getItem('studianda.translation.width'));
      if (Number.isFinite(stored) && stored >= 340 && stored <= 760) return stored;
    } catch {
      // 忽略不可用的本地存储
    }
    return 460;
  });
  const [translationResize, setTranslationResize] = useState<{
    startX: number;
    startWidth: number;
  } | null>(null);
  useEffect(() => {
    if (!translationResize) return;
    const move = (event: PointerEvent): void => {
      setTranslationWidth(
        Math.min(
          760,
          Math.max(
            340,
            translationResize.startWidth + translationResize.startX - event.clientX
          )
        )
      );
    };
    const up = (): void => setTranslationResize(null);
    window.document.body.classList.add('kr-resizing-side');
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
    return () => {
      window.document.body.classList.remove('kr-resizing-side');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }, [translationResize]);
  useEffect(() => {
    try {
      window.localStorage.setItem('studianda.translation.width', String(translationWidth));
    } catch {
      // 本地存储不可用时只保留本次会话
    }
  }, [translationWidth]);
  const translationStyle = {
    '--kr-translation-width': `${translationWidth}px`
  } as CSSProperties;
  const [chatDraft, setChatDraft] = useState('');
  const [chatQuote, setChatQuote] = useState('');
  // 语音转写纠错提示：needs_review 时把服务端 reason 原样显示在输入框附近，供用户核对后再发。
  const [voiceNotice, setVoiceNotice] = useState<string | null>(null);
  // 聊天操作（重新生成/编辑重问/删除分支）的准备失败：和提问错误分开显示，不清掉已有历史。
  const [chatActionError, setChatActionError] = useState<string | null>(null);
  const [located, setLocated] = useState<{ page: number; boxes: number[][] } | null>(null);
  const [hoverLocated, setHoverLocated] = useState<{ page: number; boxes: number[][] } | null>(
    null
  );
  const hoverTokenRef = useRef(0);
  // 悬停译文段落时的跳转去抖：快速划过多段时只处理最后停留的那一段，避免原文视图来回跳。
  const hoverTimerRef = useRef<number | null>(null);
  // 悬停期间锁住当前页：滚动把目标区域带进视口时，不要让 handleScroll 把页码改掉、
  // 让译文栏切到下一页把正在悬停的段落顶掉。
  const hoverActiveRef = useRef(false);
  useEffect(
    () => () => {
      if (hoverTimerRef.current !== null) window.clearTimeout(hoverTimerRef.current);
    },
    []
  );
  /**
   * 缩放只做视觉变换：页面布局宽度始终是 baseWidth，滚动范围由 spacer 按 zoom 放大。
   * 这样缩放过程不重排 266 页、不重绘画布、不触发 React 渲染，也就没有松手跳变和闪烁。
   * 工具栏百分比用 ref 命令式更新，不进入 React state。
   */
  const pagesFrameRef = useRef<HTMLDivElement | null>(null);
  const pagesSpacerRef = useRef<HTMLDivElement | null>(null);
  const frameSizeRef = useRef<{ width: number; height: number }>({ width: 0, height: 0 });
  const zoomRef = useRef(1);
  const [renderQuality, setRenderQuality] = useState(1);
  const zoomInputRef = useRef<HTMLInputElement | null>(null);
  const zoomAnchorRef = useRef<{
    page: number;
    fx: number;
    fy: number;
    viewX: number;
    viewY: number;
  } | null>(null);
  const zoomSettleTimerRef = useRef(0);
  /** 缩放校正滚动期间跳过昂贵的页码检测（避免每个滚轮 tick 扫描 266 页 DOM）。 */
  const zoomingRef = useRef(false);
  const handleScrollRef = useRef<() => void>(() => {});

  const syncZoomInput = (value: number): void => {
    const input = zoomInputRef.current;
    if (input) input.value = `${Math.round(value * 100)}%`;
  };

  /** 预览时把占位层尺寸一起缩放：transform 不改布局，不扩占位层则滚动范围/锚点会被旧尺寸夹住。 */
  const setSpacerSize = (preview: number): void => {
    const spacer = pagesSpacerRef.current;
    if (!spacer) return;
    const size = frameSizeRef.current;
    if (size.width <= 0 || size.height <= 0) return;
    spacer.style.width = `${Math.round(size.width * preview)}px`;
    spacer.style.height = `${Math.round(size.height * preview)}px`;
  };

  /** 以页面锚点校正滚动位置：让鼠标下（或视口中心）的那一点在缩放前后保持不动。 */
  const correctZoomAnchor = (): void => {
    const anchor = zoomAnchorRef.current;
    const container = scrollRef.current;
    if (!anchor || !container) return;
    const page = container.querySelector<HTMLElement>(`[data-page="${anchor.page}"]`);
    if (!page) return;
    const pageRect = page.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    container.scrollLeft +=
      pageRect.left + pageRect.width * anchor.fx - (containerRect.left + anchor.viewX);
    container.scrollTop +=
      pageRect.top + pageRect.height * anchor.fy - (containerRect.top + anchor.viewY);
  };

  /**
   * 统一缩放入口：transform + spacer 同步更新，纯 DOM 操作。
   * `center` 为 true 时（工具栏/快捷键/输入框）以阅读区中心为锚点；滚轮由 onWheel 自己设鼠标锚点。
   */
  const applyZoomValue = (nextValue: number, options?: { center?: boolean }): void => {
    const clamped = Math.min(2.4, Math.max(0.6, nextValue));
    zoomRef.current = clamped;
    const container = scrollRef.current;
    const frame = pagesFrameRef.current;
    if (options?.center && container) {
      const containerRect = container.getBoundingClientRect();
      const viewX = containerRect.width / 2;
      const viewY = containerRect.height / 2;
      const element = window.document.elementFromPoint(
        containerRect.left + viewX,
        containerRect.top + viewY
      );
      const pageEl =
        (element?.closest?.('.kr-pdf-page') as HTMLElement | null) ??
        container.querySelector<HTMLElement>(`[data-page="${page}"]`);
      if (pageEl) {
        const rect = pageEl.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          zoomAnchorRef.current = {
            page: Number(pageEl.dataset.page ?? '1'),
            fx: Math.max(0, Math.min(1, (containerRect.left + viewX - rect.left) / rect.width)),
            fy: Math.max(0, Math.min(1, (containerRect.top + viewY - rect.top) / rect.height)),
            viewX,
            viewY
          };
        }
      }
    }
    syncZoomInput(clamped);
    if (!container || !frame) return;
    zoomingRef.current = true;
    frameSizeRef.current = { width: frame.offsetWidth, height: frame.offsetHeight };
    container.style.setProperty('--kr-preview-zoom', String(clamped));
    container.classList.toggle('is-zooming', clamped !== 1);
    frame.style.willChange = clamped === 1 ? '' : 'transform';
    setSpacerSize(clamped);
    window.requestAnimationFrame(() => {
      correctZoomAnchor();
      if (zoomSettleTimerRef.current) window.clearTimeout(zoomSettleTimerRef.current);
      zoomSettleTimerRef.current = window.setTimeout(() => {
        correctZoomAnchor();
        zoomAnchorRef.current = null;
        zoomingRef.current = false;
        // 缩放停止后提高位图分辨率重绘（只改 canvas 内部分辨率，不改布局）。
        const targetQuality = zoomRef.current >= 1.3 ? 2 : 1;
        setRenderQuality((previous) => (previous === targetQuality ? previous : targetQuality));
        // 缩放结束后补一次页码检测（缩放期间的滚动事件被跳过了）。
        handleScrollRef.current();
      }, 260);
    });
  };

  const setZoomAnchored = (nextValue: number): void => {
    applyZoomValue(nextValue, { center: true });
  };

  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    const onWheel = (event: WheelEvent): void => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      const nextPercent = Math.min(
        240,
        Math.max(60, Math.round(zoomRef.current * 100) + (event.deltaY < 0 ? 10 : -10))
      );
      const next = nextPercent / 100;
      if (next === zoomRef.current) return;
      const containerRect = container.getBoundingClientRect();
      const target = (event.target as Element | null)?.closest?.('.kr-pdf-page');
      const rect = target?.getBoundingClientRect();
      if (target && rect && rect.width > 0 && rect.height > 0) {
        zoomAnchorRef.current = {
          page: Number((target as HTMLElement).dataset.page ?? '1'),
          fx: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
          fy: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
          viewX: event.clientX - containerRect.left,
          viewY: event.clientY - containerRect.top
        };
      }
      // 直接改 DOM，不 setState：滚轮期间完全不触发 React 渲染。
      applyZoomValue(next);
    };
    container.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      container.removeEventListener('wheel', onWheel);
      if (zoomSettleTimerRef.current) {
        window.clearTimeout(zoomSettleTimerRef.current);
        zoomSettleTimerRef.current = 0;
      }
    };
  }, []);
  const [baseWidth, setBaseWidth] = useState(820);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const suppressScrollRef = useRef(false);
  const scrollFrameRef = useRef(0);
  const pageRef = useRef(page);
  pageRef.current = page;
  const exportMenuRef = useRef<HTMLDetailsElement | null>(null);
  useEffect(() => {
    const close = (event: MouseEvent): void => {
      const menu = exportMenuRef.current;
      if (menu?.open && !menu.contains(event.target as Node)) menu.removeAttribute('open');
    };
    window.document.addEventListener('mousedown', close);
    return () => window.document.removeEventListener('mousedown', close);
  }, []);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [pdfError, setPdfError] = useState<string | null>(null);
  useLayoutEffect(() => {
    const frame = pagesFrameRef.current;
    if (!frame || typeof ResizeObserver === 'undefined') return undefined;
    const measure = (): void => {
      frameSizeRef.current = { width: frame.offsetWidth, height: frame.offsetHeight };
      if (zoomRef.current === 1) setSpacerSize(1);
      else setSpacerSize(zoomRef.current);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(frame);
    return () => observer.disconnect();
  }, [pdf]);

  const annotationsQuery = useQuery({
    queryKey: ['annotations', document.id],
    queryFn: () => api.listAnnotations(document.id)
  });

  // 批注摘引的译文（只读派生；没有译文时面板不显示这一块）。
  const annotationTranslationsQuery = useQuery({
    queryKey: ['annotation-translations', document.id],
    queryFn: () => api.getAnnotationTranslations(document.id)
  });

  const notesQuery = useQuery({
    queryKey: ['notes', document.id],
    queryFn: () => api.listNotes(document.id)
  });

  // 参考文献识别（文末列表 + 页下注 + 页面内引用）：只在切到「参考」面板时请求一次。
  const referencesQuery = useQuery({
    queryKey: ['references', document.id],
    queryFn: () => api.getReferences(document.id),
    enabled: panel === 'references' || referencesWanted,
    retry: false,
    staleTime: 60_000
  });
  const applyReferenceResult = (data: DocumentReferences): void => {
    queryClient.setQueryData(['references', document.id], data);
  };
  const updateReference = useMutation({
    mutationFn: (input: { entryId: string; patch: ReferenceEntryInput }) =>
      api.updateReferenceEntry(document.id, input.entryId, input.patch),
    onSuccess: applyReferenceResult
  });
  const addReference = useMutation({
    mutationFn: (input: ReferenceEntryInput) => api.addReferenceEntry(document.id, input),
    onSuccess: applyReferenceResult
  });
  const deleteReference = useMutation({
    mutationFn: (entryId: string) => api.deleteReferenceEntry(document.id, entryId),
    onSuccess: applyReferenceResult
  });
  const resetReferences = useMutation({
    mutationFn: () => api.resetReferenceEdits(document.id),
    onSuccess: applyReferenceResult
  });

  // 回收站按需加载：只有切到笔记/批注回收站视图时才请求。
  const [notesTrashOpen, setNotesTrashOpen] = useState(false);
  const [annotationsTrashOpen, setAnnotationsTrashOpen] = useState(false);
  const trashNotesQuery = useQuery({
    queryKey: ['notes', document.id, 'trash'],
    queryFn: () => api.listNotes(document.id, true),
    enabled: notesTrashOpen
  });
  const trashAnnotationsQuery = useQuery({
    queryKey: ['annotations', document.id, 'trash'],
    queryFn: () => api.listAnnotations(document.id, true),
    enabled: annotationsTrashOpen
  });

  const navigationQuery = useQuery({
    queryKey: ['navigation', document.id],
    queryFn: () => api.listNavigation(document.id)
  });

  // 目录预览：前 120 条 + nodes_truncated，状态仍以 navigation-status 为准。
  const navigationPreviewQuery = useQuery({
    queryKey: ['navigation-preview', document.id],
    queryFn: () => api.getNavigationPreview(document.id)
  });

  const visualNodesQuery = useQuery({
    queryKey: ['visual-nodes', document.id],
    queryFn: () => api.getVisualNodes(document.id),
    enabled: readerNav === 'outline'
  });

  // 著作章节（目录派生）：只对著作请求；失败或无目录按"不可分章"处理，不阻断会话。
  const chaptersQuery = useQuery({
    queryKey: ['chapters', document.id],
    queryFn: () => api.getChapters(document.id),
    enabled: document.docCategory === 'book',
    staleTime: 60_000
  });

  const navigationStatusQuery = useQuery({
    queryKey: ['navigation-status', document.id],
    queryFn: () => api.getNavigationStatus(document.id),
    refetchInterval: (query) =>
      query.state.data?.state === 'building' ? 800 : false
  });

  const masksQuery = useQuery({
    queryKey: ['masks', document.id],
    queryFn: () => api.listPageMasks(document.id)
  });

  // 页遮罩索引重建状态：后台重建超过页数阈值时轮询，结束后停止；失败如实展示。
  const maskStatusQuery = useQuery({
    queryKey: ['mask-status', document.id],
    queryFn: () => api.getMaskIndexStatus(document.id),
    refetchInterval: (query) =>
      query.state.data?.state === 'rebuilding' ? 1500 : false
  });
  // 遮罩变更后服务端可能异步启动后台重建：稍后再刷一次状态，才能看到 rebuilding 并开始轮询。
  const refreshMaskStatusSoon = (): void => {
    window.setTimeout(() => {
      void queryClient.invalidateQueries({ queryKey: ['mask-status', document.id] });
    }, 800);
  };

  const createAnnotation = useMutation({
    mutationFn: (input: {
      page: number;
      content?: string;
      quote?: string;
      rects?: string;
      color?: string;
      style?: string;
    }) => api.createAnnotation({ documentId: document.id, ...input }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['annotations', document.id] });
    }
  });

  const deleteAnnotation = useMutation({
    mutationFn: (id: string) => api.deleteAnnotation(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['annotations', document.id] });
      void queryClient.invalidateQueries({ queryKey: ['note-asset-usage'] });
      setAnnotationPurgeNotice('批注已移入回收站，可在批注回收站恢复或彻底删除。');
    },
    onError: (error: Error) => setAnnotationPurgeNotice(`移入回收站失败：${error.message}`)
  });

  const restoreAnnotation = useMutation({
    mutationFn: (id: string) => api.restoreAnnotation(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['annotations', document.id] });
      void queryClient.invalidateQueries({ queryKey: ['note-asset-usage'] });
      setAnnotationPurgeNotice('批注已恢复。');
    },
    onError: (error: Error) => setAnnotationPurgeNotice(`恢复批注失败：${error.message}`)
  });

  const purgeAnnotation = useMutation({
    mutationFn: (id: string) => api.purgeAnnotation(id),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ['annotations', document.id] });
      void queryClient.invalidateQueries({ queryKey: ['note-asset-usage'] });
      setAnnotationPurgeNotice(
        result.freedAssets > 0
          ? `已彻底删除批注，释放 ${result.freedAssets} 个图片资源（${formatByteSize(
              result.freedBytes
            )}）。`
          : '已彻底删除批注。'
      );
    },
    onError: (error: Error) =>
      setAnnotationPurgeNotice(`彻底删除批注失败：${error.message}`)
  });

  const updateAnnotation = useMutation({
    mutationFn: ({
      id,
      input
    }: {
      id: string;
      input: { content: string; color: string; style: string };
    }) => api.updateAnnotation(id, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['annotations', document.id] });
    }
  });

  const createNote = useMutation({
    mutationFn: (input: { page: number; content: string }) =>
      api.createNote({ documentId: document.id, page: input.page, content: input.content }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['notes', document.id] });
    }
  });

  const updateNote = useMutation({
    mutationFn: ({ id, input }: { id: string; input: { page: number; content: string } }) =>
      api.updateNote(id, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['notes', document.id] });
    }
  });

  const deleteNote = useMutation({
    mutationFn: (id: string) => api.deleteNote(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['notes', document.id] });
      void queryClient.invalidateQueries({ queryKey: ['note-asset-usage'] });
      setNotePurgeNotice('笔记已移入回收站，可在笔记回收站恢复或彻底删除。');
    },
    onError: (error: Error) => setNotePurgeNotice(`移入回收站失败：${error.message}`)
  });

  const restoreNote = useMutation({
    mutationFn: (id: string) => api.restoreNote(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['notes', document.id] });
      void queryClient.invalidateQueries({ queryKey: ['note-asset-usage'] });
      setNotePurgeNotice('笔记已恢复。');
    },
    onError: (error: Error) => setNotePurgeNotice(`恢复笔记失败：${error.message}`)
  });

  const purgeNote = useMutation({
    mutationFn: (id: string) => api.purgeNote(id),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ['notes', document.id] });
      void queryClient.invalidateQueries({ queryKey: ['standalone-notes'] });
      void queryClient.invalidateQueries({ queryKey: ['note-asset-usage'] });
      setNotePurgeNotice(
        result.freedAssets > 0
          ? `已彻底删除笔记，释放 ${result.freedAssets} 个图片资源（${formatByteSize(
              result.freedBytes
            )}）。`
          : '已彻底删除笔记。'
      );
    },
    onError: (error: Error) => setNotePurgeNotice(`彻底删除笔记失败：${error.message}`)
  });

  // 阅读视图内的「从 Zotero 导入批注与笔记」入口（设置页的 Zotero 分区仍有同一入口）。
  // 只对 Zotero 来源文献显示；流程为预览 → window.confirm → 导入，结果/错误都显示在批注面板内。
  const [zoteroNotice, setZoteroNotice] = useState<string | null>(null);
  const [annotationPurgeNotice, setAnnotationPurgeNotice] = useState('');
  const [zoteroError, setZoteroError] = useState<string | null>(null);
  const importZoteroAnnotations = useMutation({
    mutationFn: async () => {
      const preview = await api.previewZoteroAnnotations(document.id);
      // 预览报告 message 说明将导入的批注/笔记数量；这里再把"已存在/跳过"与警告补进确认框。
      const details: string[] = [preview.message];
      const already = preview.skippedExisting + preview.notesSkippedExisting;
      if (already) details.push(`已存在 ${already} 条，不会重复导入。`);
      const skipped =
        preview.skippedType +
        preview.skippedPage +
        preview.skippedEmpty +
        preview.notesSkippedEmpty;
      if (skipped) {
        details.push(`另有 ${skipped} 条无法导入（类型不支持 / 缺少位置 / 内容为空），会跳过。`);
      }
      for (const warning of preview.warnings.slice(0, 2)) details.push(`提示：${warning}`);
      if (!appDialogs.confirm(`${details.join('\n')}\n\n确认导入？`)) return null;
      return api.importZoteroAnnotations(document.id);
    },
    onSuccess: (report) => {
      // 用户在确认框里取消：保持面板现有内容不变。
      if (!report) return;
      void queryClient.invalidateQueries({ queryKey: ['annotations', document.id] });
      void queryClient.invalidateQueries({ queryKey: ['notes', document.id] });
      void queryClient.invalidateQueries({ queryKey: ['documents'] });
      setZoteroError(null);
      setZoteroNotice(
        `${report.message}${report.warnings.length ? `；${report.warnings[0]}` : ''}`
      );
    },
    onError: (error: Error) => {
      setZoteroNotice(null);
      setZoteroError(`从 Zotero 导入批注与笔记失败：${error.message}`);
    }
  });
  const zoteroAvailable =
    document.fileState.storageKind === 'zotero' ||
    document.fileState.storageKind === 'zotero_cache';

  const askAbortRef = useRef<AbortController | null>(null);
  // 本轮提问的起始时间戳：回答成功后算耗时传给 ChatPanel；新提问/重新生成开始时清空显示。
  const askStartedAtRef = useRef<number | null>(null);
  // 上一条回答的生成耗时（毫秒）；没有可显示的新回答时为 null。
  const [lastAnswerDurationMs, setLastAnswerDurationMs] = useState<number | null>(null);
  // 消息落库串行队列：用户消息与助手消息按顺序 POST，避免先发后到把 DB 顺序写乱，
  // 也保证「一条写入完成」后才继续下一条。ReaderView 以 document.id 为 key 重建，
  // 所以这条链（useRef）天然只服务一篇文献。
  const persistQueueRef = useRef<Promise<unknown>>(Promise.resolve());
  // 消息落库失败的用户可见提示：本地仍保留，但刷新/重开后会丢；不能只写 console。
  const [chatPersistNotice, setChatPersistNotice] = useState('');
  // 「重新生成」防止连点重入：rewind 是异步的，期间入口还没因 asking 变成 pending。
  const regeneratingRef = useRef(false);
  // 消息级操作（编辑并重问 / 从此分支删除）防止连点重入：都含异步的 DB 准备步骤。
  const messageActionRef = useRef(false);
  // 直接语音提问（全模态）：用户消息先本地占位「（语音提问）」，等回答返回 audio_transcript
  // 后再落库最终正文（「（语音）转写」；失败则落占位）。这样不必先落库再用会删后续消息的 PATCH。
  const pendingVoiceTurnRef = useRef<{
    messageId: string;
    sessionId: string;
    quote?: string;
    quotePage?: number;
    quoteName?: string;
  } | null>(null);
  // 待发送的语音录音（base64）：mutationFn 读取一次后立即清空，避免它被 React Query
  // 作为 mutation 变量长期持有；录音本身不写数据库，只有转写文字进入会话。
  const voiceAudioRef = useRef<{
    data: string;
    mimeType: string;
    filename?: string;
  } | null>(null);
  const [chatMessages, setChatMessages] = useState<ChatMessageView[]>([]);
  // 历史分页状态：是否还有更早一页、是否正在加载更早一页。
  const [hasEarlierMessages, setHasEarlierMessages] = useState(false);
  const [loadingEarlierMessages, setLoadingEarlierMessages] = useState(false);
  // 对话内搜索状态：关键词、结果面板、错误、以及「正在查看搜索结果（完整历史）」模式。
  const searchViewRef = useRef(false);
  const [viewingSearchResult, setViewingSearchResult] = useState(false);
  const [messageSearchQuery, setMessageSearchQuery] = useState('');
  const [messageSearching, setMessageSearching] = useState(false);
  const [messageSearchError, setMessageSearchError] = useState('');
  const [messageSearchResult, setMessageSearchResult] = useState<MessageSearchResult | null>(
    null
  );
  // 从搜索结果跳到完整历史后，等 messages 渲染完再滚动到目标消息。
  const [pendingScrollDbId, setPendingScrollDbId] = useState<number | null>(null);
  // 紧凑工具栏：搜索输入只在点「搜索」后展开一行；「更多」的 details 菜单用 ref 收起。
  const [searchBarOpen, setSearchBarOpen] = useState(false);
  const moreMenuRef = useRef<HTMLDetailsElement | null>(null);
  const [contextRounds, setContextRounds] = useState(() => {
    try {
      const stored = Number(window.localStorage.getItem('studianda.chat.contextRounds'));
      if ([1, 2, 3, 5, 10].includes(stored)) return stored;
    } catch {
      // 使用默认上下文轮数
    }
    return 3;
  });
  useEffect(() => {
    const page = chatPageQuery.data;
    if (!page) return;
    // 正在看搜索结果对应的完整历史时，不应用「最新一页」（等用户点「回到最新」再恢复）。
    if (searchViewRef.current) return;
    setHasEarlierMessages(page.hasMore);
    setChatMessages((current) => mergeLatestMessagePage(current, page.messages));
  }, [chatPageQuery.data]);
  useEffect(() => {
    try {
      window.localStorage.setItem('studianda.chat.contextRounds', String(contextRounds));
    } catch {
      // 本地存储不可用时只保留当前设置
    }
  }, [contextRounds]);
  const reportPersistFailure = (error: unknown): void => {
    // 写入失败不打断阅读：本地历史仍保留；同时给用户可见提示（刷新/重开后可能丢失）。
    console.warn('阅读页会话：消息写入数据库失败，保留本地历史', error);
    setChatPersistNotice(
      '这条消息未能写入本地数据库：当前仍显示在页面上，但刷新或重开文献后可能丢失。请检查磁盘空间/数据目录权限后重试。'
    );
  };
  /**
   * 把一条消息写进 Core DB，返回 Promise：调用方可以等它成功后再刷新消息列表。
   *
   * 同一篇文献的用户/助手消息串行排队：前一条无论成功失败都不阻塞后一条，
   * 保证「用户提问」先于「助手回答」落库，且外部拿到的 Promise 反映本次写入的真实结果。
   * 落库时统一补 `metadata.sessionId`，消息归属于当前会话。
   */
  const persistMessage = (
    role: 'user' | 'assistant',
    content: string,
    sources?: ChatSource[],
    metadata?: Record<string, unknown>,
    // 显式会话 id：语音轮的回答返回后才落库用户消息，期间用户可能已切换会话，
    // 必须写回提问时的那一个会话（undefined = 用当前 activeSessionId）。
    sessionIdOverride?: string | null
  ): Promise<void> => {
    const sessionId = sessionIdOverride === undefined ? activeSessionId : sessionIdOverride;
    const write = persistQueueRef.current
      .catch(() => undefined)
      .then(() =>
        api.addMessage({
          documentId: document.id,
          role,
          content,
          sources,
          metadata: { ...(metadata ?? {}), ...(sessionId ? { sessionId } : {}) }
        })
      )
      .then(() => undefined);
    // 队列尾只关心"这条写完了"：失败已经通过 write 交给调用方，不能卡住后续消息。
    persistQueueRef.current = write.catch(() => undefined);
    // 成功写入后清掉上一条失败提示（如果还有）。
    void write.then(() => setChatPersistNotice('')).catch(() => undefined);
    return write;
  };
  const [lastQuestion, setLastQuestion] = useState('');
  // 搜索计划审批凭证：继续阅读重发同一请求时复用（服务端 10 分钟内幂等）。
  const [lastSearchToken, setLastSearchToken] = useState<string | undefined>(undefined);
  const [lastSearchSelection, setLastSearchSelection] = useState('');
  // 预算确认/继续阅读要重发同一请求：保留这次提问附带的范围标签、改写联网词与笔记/批注口径。
  const [lastAskExtras, setLastAskExtras] = useState<{
    scopeTags?: string[];
    webQuery?: string;
    includeMemory?: boolean;
  }>({});
  const [budgetWarning, setBudgetWarning] = useState<BudgetEstimate | null>(null);
  // 「本次会话对这篇文献不再提示」：sessionStorage 存文献 id，关窗口即失效；只影响预算提示，不影响阅读范围。
  const [budgetSkipDocs, setBudgetSkipDocs] = useState<Set<string>>(() => {
    try {
      const raw = sessionStorage.getItem('studianda.budget-skip-docs');
      const parsed = raw ? (JSON.parse(raw) as unknown) : [];
      return new Set(
        Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []
      );
    } catch {
      return new Set();
    }
  });
  const budgetSkipActive = budgetSkipDocs.has(document.id);
  const setBudgetSkipForDocument = (skip: boolean): void => {
    setBudgetSkipDocs((current) => {
      const next = new Set(current);
      if (skip) next.add(document.id);
      else next.delete(document.id);
      try {
        sessionStorage.setItem('studianda.budget-skip-docs', JSON.stringify([...next]));
      } catch {
        // 会话存储不可用时只影响"记住"，不影响本次勾选。
      }
      return next;
    });
  };
  const [askProgress, setAskProgress] = useState<{ done: number; total: number } | null>(null);
  const [draftAnswer, setDraftAnswer] = useState('');
  const [askStage, setAskStage] = useState('');
  const [auditDraft, setAuditDraft] = useState<
    Array<{ claim: number; verdict: string; text?: string }>
  >([]);

  // ---------------------------------------------------------------------------
  // 阅读伙伴多会话：清单初始化/迁移、会话切换与清单维护
  // ---------------------------------------------------------------------------

  /** 会话清单 state 的写回序号：并发请求只让最新一次结果写回 state。 */
  const nextSessionsSeq = (): number => {
    sessionsWriteSeqRef.current += 1;
    return sessionsWriteSeqRef.current;
  };

  /**
   * 首问填标题 / 每轮成功更新 updated：只 PATCH 这两个字段。
   *
   * 不再读全量清单再整表保存——细粒度更新不会覆盖别的窗口/服务端刚写入的摘要与版本。
   * 本地先乐观更新，失败只 warn，不阻断回答。
   */
  const touchChatSession = (
    sessionId: string,
    options: { title?: string } = {}
  ): Promise<void> => {
    if (!sessionId) return Promise.resolve();
    const seq = nextSessionsSeq();
    const updated = new Date().toISOString();
    const patch: { title?: string; updated: string } = { updated };
    if (options.title !== undefined) patch.title = options.title;
    // 本地立即生效（下拉标题不用等网络）；只改 title/updated，摘要/版本字段保持原样。
    chatSessionsRef.current = chatSessionsRef.current.map((session) =>
      session.id === sessionId
        ? { ...session, ...(patch.title !== undefined ? { title: patch.title } : {}), updated }
        : session
    );
    setChatSessions(chatSessionsRef.current);
    return api
      .updateDocumentChatSession(document.id, sessionId, patch)
      .then((saved) => {
        if (seq !== sessionsWriteSeqRef.current) return;
        // 服务端返回的是完整记录（含摘要/版本），用它替换本地这条即可。
        chatSessionsRef.current = chatSessionsRef.current.map((session) =>
          session.id === saved.id ? saved : session
        );
        setChatSessions(chatSessionsRef.current);
      })
      .catch((error: unknown) => {
        console.warn('阅读页会话：更新会话标题/更新时间失败', error);
      });
  };

  /**
   * 重新拉取会话清单（只读 GET）。
   *
   * 服务端在回答后可能更新 `contextSummary/summaryUpto`（预算超限压缩早期轮次），
   * 编辑/分支删除到被摘要覆盖的消息时也可能清掉摘要——操作成功后调用这里同步显示。
   * 失败只 warn，不阻断会话。
   */
  const refreshChatSessions = async (): Promise<void> => {
    const seq = nextSessionsSeq();
    try {
      const sessions = await api.listDocumentChatSessions(document.id);
      if (seq !== sessionsWriteSeqRef.current) return;
      chatSessionsRef.current = sessions;
      setChatSessions(sessions);
      setActiveSessionId((current) =>
        current && sessions.some((session) => session.id === current)
          ? current
          : sessions[0]?.id ?? current
      );
    } catch (error) {
      console.warn('阅读页会话：刷新会话清单失败', error);
    }
  };

  /** 切换/新建/删除会话后清空上一个会话的本地状态（消息由 query 按新会话重新加载）。 */
  const resetChatTransientState = (): void => {
    setChatMessages([]);
    setLastQuestion('');
    setLastSearchSelection('');
    setLastSearchToken(undefined);
    setLastAskExtras({});
    setBudgetWarning(null);
    setDraftAnswer('');
    setAskStage('');
    setAuditDraft([]);
    setAskProgress(null);
    setLastAnswerDurationMs(null);
    setChatActionError(null);
    setVoiceNotice(null);
    // 分页/对话内搜索状态跟着会话重置（消息列表已清空，等新会话最新一页加载）。
    setHasEarlierMessages(false);
    setLoadingEarlierMessages(false);
    searchViewRef.current = false;
    setViewingSearchResult(false);
    setMessageSearchQuery('');
    setMessageSearching(false);
    setMessageSearchError('');
    setMessageSearchResult(null);
    setPendingScrollDbId(null);
    // 紧凑工具栏的展开态也随会话重置。
    setSearchBarOpen(false);
    if (moreMenuRef.current) moreMenuRef.current.open = false;
    // 上一个会话的提问结果/错误不能串到新会话（ChatPanel 的 error/answer 来自 mutation 状态）。
    askMutation.reset();
  };

  // 打开文献时初始化会话清单（模块级任务去重，StrictMode 双调用/页面重建不会重复建会话）；
  // 选中上次打开的会话（localStorage），否则第一个。
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const sessions = await bootstrapDocumentChatSessions(api, document.id);
        if (cancelled) return;
        sessionsWriteSeqRef.current += 1;
        chatSessionsRef.current = sessions;
        setChatSessions(sessions);
        const stored = readActiveChatSessionId(document.id);
        const active =
          sessions.find((session) => session.id === stored)?.id ?? sessions[0]?.id ?? '';
        setActiveSessionId(active);
        if (active) writeActiveChatSessionId(document.id, active);
        setSessionsReady(true);
        // 后台预热单篇检索索引：不阻塞打开文献，失败不影响后续提问（提问时仍会按需构建）。
        void api.prewarmRetrieval(document.id).catch(() => undefined);
      } catch (error) {
        if (cancelled) return;
        setChatActionError(
          `加载阅读伙伴会话失败：${error instanceof Error ? error.message : '未知错误'}`
        );
        // 兜底：至少还能用 legacy 会话，避免整个会话不可用（下次打开会按旧消息重建清单）。
        const now = new Date().toISOString();
        const fallback: DocumentChatSessionRecord = {
          id: 'legacy',
          title: '默认对话',
          created: now,
          updated: now
        };
        sessionsWriteSeqRef.current += 1;
        chatSessionsRef.current = [fallback];
        setChatSessions([fallback]);
        setActiveSessionId('legacy');
        setSessionsReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [document.id, api]);

  /** 会话级操作前检查：重新生成/编辑删除还在进行时不允许切换或管理会话。 */
  const ensureNoMessageAction = (): boolean => {
    if (regeneratingRef.current || messageActionRef.current) {
      setChatActionError('消息操作还在进行中，请稍后再切换或管理会话。');
      return false;
    }
    return true;
  };

  /** 切换会话：先等落库队列写完，避免上一会话的消息串到新会话；再清空本地状态并持久化选择。 */
  const switchChatSession = async (nextSessionId: string): Promise<void> => {
    if (!nextSessionId || nextSessionId === activeSessionId) return;
    if (!chatSessionsRef.current.some((session) => session.id === nextSessionId)) return;
    if (!ensureNoMessageAction()) return;
    await persistQueueRef.current.catch(() => undefined);
    setActiveSessionId(nextSessionId);
    writeActiveChatSessionId(document.id, nextSessionId);
    resetChatTransientState();
  };

  /** 新建会话：uuid 空标题，create 后切过去；失败保持原会话并提示。 */
  const createChatSession = async (): Promise<void> => {
    if (!ensureNoMessageAction()) return;
    await persistQueueRef.current.catch(() => undefined);
    try {
      const saved = await api.createDocumentChatSession(
        document.id,
        newChatSessionRecord()
      );
      // 本地按创建顺序追加/替换（服务端 list 也是按创建顺序返回）。
      sessionsWriteSeqRef.current += 1;
      chatSessionsRef.current = chatSessionsRef.current.some(
        (session) => session.id === saved.id
      )
        ? chatSessionsRef.current.map((session) =>
            session.id === saved.id ? saved : session
          )
        : [...chatSessionsRef.current, saved];
      setChatSessions(chatSessionsRef.current);
      setActiveSessionId(saved.id);
      writeActiveChatSessionId(document.id, saved.id);
      resetChatTransientState();
      // 再 GET 一次拿权威清单（别的窗口可能刚建/刚改会话）；只读，不整表写。
      void refreshChatSessions();
    } catch (error) {
      setChatActionError(
        `新建会话失败：${error instanceof Error ? error.message : '未知错误'}`
      );
    }
  };

  /**
   * 打开内联改名输入框（替代原 window.prompt：Electron 渲染进程不支持 prompt，
   * 之前点「改名」没有任何反应）。标题留空是允许的，列表会显示「对话 N」。
   */
  const beginChatSessionRename = (): void => {
    const current = chatSessionsRef.current.find((session) => session.id === activeSessionId);
    if (!current) return;
    if (!ensureNoMessageAction()) return;
    const draft = { sessionId: current.id, value: current.title };
    chatRenameDraftRef.current = draft;
    setChatRenameDraft(draft);
  };

  /** 取消内联改名（Esc / 点取消）：清空草稿，不写服务端。 */
  const cancelChatSessionRename = (): void => {
    chatRenameDraftRef.current = null;
    setChatRenameDraft(null);
  };

  /**
   * 提交内联改名（Enter / 失焦）。先收起输入框再发请求，
   * 这样随后的 blur 看到草稿已清空，不会再提交一次。
   */
  const commitChatSessionRename = async (): Promise<void> => {
    const draft = chatRenameDraftRef.current;
    if (!draft) return;
    chatRenameDraftRef.current = null;
    setChatRenameDraft(null);
    const existing = chatSessionsRef.current.find((session) => session.id === draft.sessionId);
    // 标题没变（仅去掉首尾空格后相同）就不发请求，避免无意义的 updated 变更。
    if (existing && existing.title.trim() === draft.value.trim()) return;
    await renameActiveChatSession(draft.value, draft.sessionId);
  };

  /** 重命名会话（内联输入框调用）；只 PATCH title/updated。 */
  const renameActiveChatSession = async (
    titleInput: string,
    sessionId?: string
  ): Promise<void> => {
    const targetId = sessionId ?? activeSessionId;
    const current = chatSessionsRef.current.find((session) => session.id === targetId);
    if (!current) return;
    if (!ensureNoMessageAction()) return;
    const title = titleInput.trim().slice(0, 120);
    await persistQueueRef.current.catch(() => undefined);
    try {
      const saved = await api.updateDocumentChatSession(document.id, targetId, {
        title,
        updated: new Date().toISOString()
      });
      // 服务端返回完整记录（含摘要/版本），只替换本地这一条即可。
      sessionsWriteSeqRef.current += 1;
      chatSessionsRef.current = chatSessionsRef.current.map((session) =>
        session.id === saved.id ? saved : session
      );
      setChatSessions(chatSessionsRef.current);
    } catch (error) {
      setChatActionError(
        `重命名会话失败：${error instanceof Error ? error.message : '未知错误'}`
      );
      // 会话可能已在别处被删/改：刷新一次清单同步（GET，不改服务端）。
      void refreshChatSessions();
    }
  };

  /** 删除当前会话：服务端删消息并从清单移除；删后切到剩余第一个，没有剩余则新建。 */
  const deleteActiveChatSession = async (): Promise<void> => {
    if (chatSessionsRef.current.length === 0) return;
    if (!ensureNoMessageAction()) return;
    const target = chatSessionsRef.current.find((session) => session.id === activeSessionId);
    if (!target) return;
    const label = documentChatSessionLabel(
      target,
      chatSessionsRef.current.findIndex((session) => session.id === target.id)
    );
    if (
      !appDialogs.confirm(`删除会话「${label}」以及它的全部内容？删除后不能恢复。`)
    ) {
      return;
    }
    await persistQueueRef.current.catch(() => undefined);
    try {
      const result = await api.deleteDocumentChatSession(document.id, activeSessionId);
      let sessions = result.sessions ?? [];
      if (!result.ok) throw new Error('删除会话失败');
      let nextActive = sessions[0]?.id ?? '';
      if (sessions.length === 0) {
        const saved = await api.createDocumentChatSession(
          document.id,
          newChatSessionRecord()
        );
        sessions = [saved];
        nextActive = saved.id;
      }
      sessionsWriteSeqRef.current += 1;
      chatSessionsRef.current = sessions;
      setChatSessions(sessions);
      resetChatTransientState();
      if (nextActive) {
        setActiveSessionId(nextActive);
        writeActiveChatSessionId(document.id, nextActive);
      } else {
        setActiveSessionId('');
      }
    } catch (error) {
      setChatActionError(
        `删除会话失败：${error instanceof Error ? error.message : '未知错误'}`
      );
    }
  };

  // ---------------------------------------------------------------------------
  // 消息历史分页 + 对话内搜索
  // ---------------------------------------------------------------------------

  /** 「回到最新」：退出搜索结果/完整历史模式，恢复「最新一页」并拉一次最新页。 */
  const showLatestMessages = (): void => {
    searchViewRef.current = false;
    setViewingSearchResult(false);
    setMessageSearchResult(null);
    setMessageSearchQuery('');
    setMessageSearchError('');
    setPendingScrollDbId(null);
    const page = chatPageQuery.data;
    if (page) {
      setHasEarlierMessages(page.hasMore);
      setChatMessages((current) => mergeLatestMessagePage(current, page.messages));
    }
    void chatPageQuery.refetch();
  };

  /** 「加载更早」：用当前最早一条 db 消息 id 作 beforeId 拉上一页，前置合并且按 id 去重。 */
  const loadEarlierMessages = async (): Promise<void> => {
    if (loadingEarlierMessages || !hasEarlierMessages || !activeSessionId) return;
    const firstDbId = chatMessages
      .map((message) => dbIdOfMessageId(message.id))
      .find((id): id is number => id !== null);
    if (firstDbId === undefined) return;
    setLoadingEarlierMessages(true);
    try {
      const page = await api.listMessagesPage(document.id, {
        sessionId: activeSessionId,
        limit: MESSAGE_PAGE_SIZE,
        beforeId: firstDbId
      });
      setChatMessages((current) => {
        const existing = new Set(current.map((message) => message.id));
        const prepend = page.messages
          .map(chatMessageViewFromRecord)
          .filter((message) => !existing.has(message.id));
        return prepend.length > 0 ? [...prepend, ...current] : current;
      });
      setHasEarlierMessages(page.hasMore);
    } catch (error) {
      setChatActionError(
        `加载更早消息失败：${error instanceof Error ? error.message : '未知错误'}`
      );
    } finally {
      setLoadingEarlierMessages(false);
    }
  };

  /** 执行「搜索本会话」：回车触发；结果显示在会话上方的结果面板。 */
  const runMessageSearch = async (): Promise<void> => {
    const query = messageSearchQuery.trim();
    if (!query || !activeSessionId || messageSearching) return;
    setMessageSearching(true);
    setMessageSearchError('');
    setMessageSearchResult(null);
    try {
      const result = await api.searchDocumentMessages(document.id, {
        sessionId: activeSessionId,
        query,
        limit: 50
      });
      setMessageSearchResult(result);
    } catch (error) {
      setMessageSearchResult(null);
      setMessageSearchError(
        `搜索失败：${error instanceof Error ? error.message : '未知错误'}`
      );
    } finally {
      setMessageSearching(false);
    }
  };

  /** 关闭搜索结果面板：如果之前跳到了完整历史，恢复最新一页；同时收起搜索输入行。 */
  const closeMessageSearch = (): void => {
    setSearchBarOpen(false);
    if (viewingSearchResult) {
      showLatestMessages();
      return;
    }
    setMessageSearchResult(null);
    setMessageSearchQuery('');
    setMessageSearchError('');
  };

  /** 收起「更多」details 菜单（点击菜单项后手动关闭，原生 details 不会自动收）。 */
  const closeMoreMenu = (): void => {
    if (moreMenuRef.current) moreMenuRef.current.open = false;
  };

  /** 点搜索结果：按需拉该会话完整消息并切换显示，再滚动定位到目标消息。 */
  const openMessageSearchResult = async (match: { id: number }): Promise<void> => {
    if (!activeSessionId) return;
    try {
      // 先等本组件的落库队列写完，避免刚产生的消息还没进全量列表。
      await persistQueueRef.current.catch(() => undefined);
      const rows = await api.listMessages(document.id, activeSessionId);
      searchViewRef.current = true;
      setChatMessages(rows.map(chatMessageViewFromRecord));
      setHasEarlierMessages(false);
      setViewingSearchResult(true);
      setPendingScrollDbId(match.id);
    } catch (error) {
      setChatActionError(
        `打开搜索结果失败：${error instanceof Error ? error.message : '未知错误'}`
      );
    }
  };

  // 跳到搜索结果后滚动定位：ChatPanel 会在 messages 变化后滚到底，等两帧再居中目标消息。
  useEffect(() => {
    if (pendingScrollDbId === null) return;
    const index = chatMessages.findIndex(
      (message) => message.id === `db-${pendingScrollDbId}`
    );
    if (index < 0) return;
    setPendingScrollDbId(null);
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        const nodes = window.document.querySelectorAll<HTMLElement>('.kr-chat__message');
        const node = nodes[index];
        if (!node) return;
        node.scrollIntoView({ block: 'center' });
        node.classList.add('is-search-hit');
        window.setTimeout(() => node.classList.remove('is-search-hit'), 2000);
      });
    });
  }, [pendingScrollDbId, chatMessages]);

  // 紧凑工具栏的「更多」details：点击菜单外部或按 Esc 时收起（原生 details 不会自动收）。
  useEffect(() => {
    const onPointerDown = (event: PointerEvent): void => {
      const details = moreMenuRef.current;
      if (details?.open && !details.contains(event.target as Node)) details.open = false;
    };
    window.document.addEventListener('pointerdown', onPointerDown, true);
    return () =>
      window.document.removeEventListener('pointerdown', onPointerDown, true);
  }, []);

  const askMutation = useMutation({
    mutationFn: (input: {
      question: string;
      selection: string;
      taskId?: string;
      confirmBudget?: boolean;
      confirmSearch?: boolean;
      history?: Array<{ question: string; answer?: string }>;
      audio?: { data: string; mimeType: string; filename?: string };
      /**
       * 语音直问标记：真正的二进制/ base64 音频放在 voiceAudioRef 里，只在 mutationFn
       * 内取一次并立即清空，避免它随 React Query 的 mutation 变量长期驻留内存。
       */
      voice?: boolean;
      readingScope?: 'auto' | 'local' | 'document' | 'corpus';
      readingRigor?: 'auto' | 'fast' | 'standard' | 'exhaustive';
      readingChapterIndex?: number;
      sourcePolicy?: 'auto' | 'document_only';
      scopeDocuments?: string[];
      searchToken?: string;
      scopeTags?: string[];
      webQuery?: string;
      confirmGapSearch?: boolean;
      /** 本轮是否把本机笔记/批注作为补充材料纳入（不算文献原文证据）。 */
      includeMemory?: boolean;
    }) => {
      const controller = new AbortController();
      askAbortRef.current = controller;
      // 语音直问的录音只在这里取一次并立刻清空：不放进 mutation 变量，
      // 避免 React Query 持有上一次录音的 base64 字符串（内存不随轮次累积）。
      const voiceAudio = input.voice ? voiceAudioRef.current ?? undefined : input.audio;
      if (input.voice) voiceAudioRef.current = null;
      // 计时从真正发出请求开始；旧回答的耗时不跨轮显示（新提问/重新生成开始时已清空）。
      askStartedAtRef.current = performance.now();
      setLastAnswerDurationMs(null);
      return api
        .askStream(
          {
            question: input.question,
            documentId: document.id,
            // 阅读伙伴会话 id：服务端据此读该会话完整历史，超预算时压缩更早轮次到会话摘要。
            chat_session_id: activeSessionId,
            page,
            selection: input.selection || undefined,
            taskId: input.taskId,
            confirmSearch: input.confirmSearch,
            search_token: input.searchToken,
            history: input.history,
            audio: voiceAudio,
            reading_scope: input.readingScope,
            reading_rigor: input.readingRigor,
            reading_chapter_index: input.readingChapterIndex,
            source_policy: input.sourcePolicy,
            scope_documents: input.scopeDocuments,
            scope_tags: input.scopeTags,
            web_query: input.webQuery,
            confirm_gap_search: input.confirmGapSearch,
            confirm_budget: input.confirmBudget,
            include_memory: input.includeMemory
          },
          {
            signal: controller.signal,
            onProgress: (done, total) => setAskProgress({ done, total }),
            onDraft: (text) => setDraftAnswer((current) => current + text),
            onDraftReset: () => setDraftAnswer(''),
            onStage: (text) => setAskStage(text),
            onAudit: (claims) =>
              setAuditDraft(
                claims.map((claim) => {
                  const item = claim as {
                    claim?: number;
                    verdict?: string;
                    text?: string;
                  };
                  return {
                    claim: Number(item.claim ?? 0),
                    verdict: String(item.verdict ?? ''),
                    text: item.text
                  };
                })
              )
          }
        )
        .catch((error: unknown) => {
          if (controller.signal.aborted) throw new Error('已取消阅读');
          throw error;
        })
        .finally(() => {
          setAskProgress(null);
          if (askAbortRef.current === controller) askAbortRef.current = null;
        });
    },
    onSuccess: (data) => {
      const response = data as ChatResponse;
      if (response.needs_confirmation && response.budget) {
        // 预算确认不是回答：不追加空助手消息、不落库；清掉草稿/阶段/审计，等用户确认后重发。
        setBudgetWarning(response.budget);
        setDraftAnswer('');
        setAskStage('');
        setAuditDraft([]);
        return;
      }
      // 直接语音（全模态）：模型返回逐字转写后，用户消息才按最终正文落库。
      // 先落库再改需要 PATCH（会删掉后续消息），所以这里在拿到回答后用最终正文写一次，
      // 并排在助手消息写入之前（persistMessage 队列保证顺序）。
      const voiceTurn = pendingVoiceTurnRef.current;
      pendingVoiceTurnRef.current = null;
      if (voiceTurn) {
        const transcript =
          typeof response.audio_transcript === 'string' ? response.audio_transcript.trim() : '';
        const voiceContent = transcript ? `（语音）${transcript}` : '（语音提问）';
        setChatMessages((current) =>
          current.map((message) =>
            message.id === voiceTurn.messageId ? { ...message, content: voiceContent } : message
          )
        );
        void persistMessage(
          'user',
          voiceContent,
          undefined,
          {
            quote: voiceTurn.quote,
            quotePage: voiceTurn.quotePage,
            quoteName: voiceTurn.quoteName
          },
          voiceTurn.sessionId
        ).catch(reportPersistFailure);
        // 首条就是语音时，用转写补一个可读标题（只在标题仍为空时写，不覆盖用户改过的标题）。
        if (transcript) {
          const session = chatSessionsRef.current.find(
            (item) => item.id === voiceTurn.sessionId
          );
          if (session && !session.title.trim()) {
            void touchChatSession(voiceTurn.sessionId, {
              title: `（语音）${transcript}`.slice(0, 40)
            });
          }
        }
      }
      setBudgetWarning(null);
      setDraftAnswer('');
      setAskStage('');
      setAuditDraft([]);
      // 新一轮回答后回到最新一页（用户可能正在看搜索结果对应的完整历史）。
      searchViewRef.current = false;
      setViewingSearchResult(false);
      // 回答耗时：从发出请求到拿到完整回答（含流式生成）。预算确认不是回答，不设置。
      const startedAt = askStartedAtRef.current;
      setLastAnswerDurationMs(
        startedAt === null ? null : Math.max(0, Math.round(performance.now() - startedAt))
      );
      askStartedAtRef.current = null;
      const answerContent = response.answer?.trim() || '这一轮没有产生文字回答。';
      // 先本地追加（保留整轮富 response，界面立即可见），再按队列顺序落库。
      setChatMessages((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: answerContent,
          response
        }
      ]);
      void (async () => {
        try {
          await persistMessage('assistant', answerContent, response.sources, {
            taskId: response.taskId ?? null,
            scope: response.reading_scope ?? null,
            // 整轮回答一起存：重启/重开文献后 notice、审计、覆盖、引用校验、阅读范围等都能恢复，
            // 而不是只剩正文+来源。sources 已单独存列，metadata 里去掉避免重复。
            response: chatResponseForStorage(response)
          });
          // 持久化成功后才刷新消息列表：这时 GET 一定拿得到刚写入的助手消息，
          // 不会出现"最新一条短暂消失"或被 DB 旧数据覆盖。
          await queryClient.invalidateQueries({
            queryKey: ['messages', document.id, activeSessionId]
          });
        } catch (error) {
          // 写入失败：保留本地历史（含富回答），不刷新消息列表，避免被 DB 旧数据清短。
          reportPersistFailure(error);
        }
      })();
      // 每轮成功都推进会话的 updated（只 PATCH 该字段，失败不阻断回答）；
      // 更新完成后再拉一次清单，让服务端刚生成的摘要及时显示（get 只读，不整表写）。
      void touchChatSession(activeSessionId).finally(() => {
        void refreshChatSessions();
      });
      void queryClient.invalidateQueries({ queryKey: ['reading-tasks', document.id] });
    },
    onError: (error: Error) => {
      // 直接语音失败：用户消息按占位正文落库，保证刷新后仍能看到这一轮。
      const voiceTurn = pendingVoiceTurnRef.current;
      pendingVoiceTurnRef.current = null;
      if (voiceTurn) {
        void persistMessage(
          'user',
          '（语音提问）',
          undefined,
          {
            quote: voiceTurn.quote,
            quotePage: voiceTurn.quotePage,
            quoteName: voiceTurn.quoteName
          },
          voiceTurn.sessionId
        ).catch(reportPersistFailure);
      }
      if (error instanceof ApiRequestError && error.status === 409) {
        const details = error.details as { budget?: BudgetEstimate } | undefined;
        if (details?.budget) {
          setBudgetWarning(details.budget);
          return;
        }
      }
      setBudgetWarning(null);
      setDraftAnswer('');
      setAskStage('');
      setAuditDraft([]);
      setChatMessages((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: `回答未完成：${error.message}`
        }
      ]);
      // 失败提示同样排队落库，但**不**刷新消息列表：DB 里可能没有这条，刷新会把本地历史清短。
      void persistMessage('assistant', `回答未完成：${error.message}`).catch(reportPersistFailure);
    }
  });

  /**
   * 「重新生成」上一轮回答：先删掉 DB 里**当前会话**「最后一条用户消息之后」的消息
   * （旧回答/失败占位），再把本地历史截断到最后一条用户消息，用同一问题/选区/范围重新提问。
   *
   * 服务端接口已按 sessionId 限定，不会影响其它会话；本地不追加、也不重复持久化用户消息，
   * `history` 必须用截断后的数组显式计算——setChatMessages 是异步的，不能等下一次渲染再从
   * 闭包里的 chatMessages 取，否则会把刚删掉的旧回答又当成上下文发出去。
   */
  const regenerateAnswer = async (): Promise<void> => {
    if (regeneratingRef.current) return;
    if (!activeSessionId) {
      setChatActionError('阅读伙伴会话还在准备中，请稍后再试。');
      return;
    }
    const lastUserIndex = (() => {
      for (let index = chatMessages.length - 1; index >= 0; index -= 1) {
        if (chatMessages[index]?.role === 'user') return index;
      }
      return -1;
    })();
    if (lastUserIndex < 0) return;
    const lastUserMessage = chatMessages[lastUserIndex];
    const trimmed = chatMessages.slice(0, lastUserIndex + 1);
    const localQuestion = lastUserMessage?.content.trim() ?? '';
    // 语音提问在历史里是「（语音）转写」/占位，不能当文字问题重发；这一步放在 rewind 之前，
    // 避免"删了 DB 旧回答却又不重发"把两边弄成不一致。
    if (!localQuestion || localQuestion.startsWith('（语音')) {
      setChatActionError('没有可重新生成的文字问题（语音提问无法重新生成）。');
      return;
    }
    setChatActionError(null);
    // 重新生成开始时清掉上一条回答的耗时，等新回答成功后再更新。
    setLastAnswerDurationMs(null);
    regeneratingRef.current = true;
    try {
      // 上一轮助手消息可能还在落库队列里：先等它写完。否则 rewind 可能删不到它，
      // 旧回答随后落库，和重新生成的新回答在 DB 里并存（还会被下次刷新恢复出来）。
      await persistQueueRef.current.catch(() => undefined);
      // 取消可能在飞的旧消息快照请求，避免它带着刚被删掉的旧回答回来覆盖本地的截断结果。
      await queryClient.cancelQueries({ queryKey: ['messages', document.id, activeSessionId] });
      // rewind 按 sessionId 限定：只清当前会话最后一条 user 之后的消息，不动其它会话。
      const rewind = await api.rewindDocumentMessages(document.id, activeSessionId);
      if (!rewind.ok) throw new Error('清理上一轮回答失败');
      // 重新生成后回到最新一页（用户可能正在看搜索结果对应的完整历史），并让缓存与 DB 一致。
      searchViewRef.current = false;
      setViewingSearchResult(false);
      void queryClient.invalidateQueries({
        queryKey: ['messages', document.id, activeSessionId]
      });
      const rewindQuestion = rewind.content?.trim() ?? '';
      // 优先用本次会话最后发送的问题；重开文献后 lastQuestion 为空，退回 DB 里最后一条用户问题，
      // 都不可用（例如 DB 里只有「（语音）…」转写正文）时才用本地最后一条用户问题。
      const question =
        (lastQuestion.trim().startsWith('（语音') ? '' : lastQuestion.trim()) ||
        (rewindQuestion.startsWith('（语音') ? '' : rewindQuestion) ||
        localQuestion;
      setLastQuestion(question);
      setBudgetWarning(null);
      setDraftAnswer('');
      setAskStage('');
      setAuditDraft([]);
      // 先截断本地（丢弃旧回答/失败占位），再重发：请求失败时 onError 会追加错误占位，
      // 不会把已经删掉的旧回答恢复回来。
      setChatMessages(trimmed);
      askMutation.mutate({
        question,
        // 选区沿用上一次提问（重开文献后从本地消息的 quote 恢复）。
        selection: lastSearchSelection || lastUserMessage?.quote || '',
        confirmBudget: budgetSkipActive,
        confirmSearch: lastSearchToken ? true : undefined,
        searchToken: lastSearchToken,
        ...lastAskExtras,
        // 显式传截断后的 history：setChatMessages 还没生效，不能等下一渲染再从闭包取，
        // 否则会把刚删掉的旧回答又当成上下文发出去。
        history: recentReadingHistory(trimmed, contextRounds)
      });
    } catch (error) {
      // 清理旧回答失败：保持本地历史不动，只提示；不重发，避免 DB 里新旧回答并存。
      setChatActionError(`重新生成失败：${error instanceof Error ? error.message : '未知错误'}`);
    } finally {
      regeneratingRef.current = false;
    }
  };

  /**
   * 「存为笔记」：把一条助手回答（正文 + 依据）存成笔记。
   *
   * 优先落到回答引用的第一篇文献页（笔记挂到该文献/页码，quote 用可定位片段）；
   * 没有可用的文献页来源时存成独立笔记。失败直接 reject，交给按钮显示重试。
   */
  const saveAnswerAsNote = async (message: ChatMessageView): Promise<void> => {
    // 失败占位不是有效回答，存成笔记只会留下一条无意义的错误文本。
    if (message.content.trim().startsWith('回答未完成：')) {
      throw new Error('这条回答没有完成，无法存为笔记');
    }
    const markdown = chatAnswerAsMarkdown(message);
    // 内容指纹做 externalKey：同一回答重复点「存为笔记」时服务端返回已有笔记（幂等）。
    // 消息 id 有本地 uuid 与 db-* 两种形态，不能只靠 id，所以按正文算稳定 hash。
    const externalKey = chatAnswerExternalKey(document.id, message.content.trim());
    const source = (message.response?.sources ?? []).find(
      (item) => Boolean(item.documentId) && item.page > 0
    );
    if (source) {
      await api.createNote({
        documentId: source.documentId,
        page: source.page,
        quote: source.locate || source.quotes?.[0] || source.snippet.slice(0, 200),
        content: markdown,
        externalKey
      });
      void queryClient.invalidateQueries({ queryKey: ['notes'] });
      return;
    }
    // 独立笔记：走同一个 /notes 接口（documentId=''），externalKey 才能一起带上做去重。
    await api.createNote({ documentId: '', page: 0, content: markdown, externalKey });
    void queryClient.invalidateQueries({ queryKey: ['standalone-notes'] });
  };

  /**
   * 把本地消息 id 解析成 DB 里的数字 id（编辑/删除接口需要稳定 DB id）。
   *
   * - `db-123` 直接取数字；
   * - 本地 uuid 消息可能刚追加还没落库：先等落库队列写完，再按「本地第几条」去 DB 列表对齐
   *   （数量对不上时从后往前找相同角色+内容的最近一条）。
   * - 实在拿不到时抛错，界面提示「请等这轮保存完成后再编辑」。
   */
  const resolveMessageDbId = async (
    message: ChatMessageView,
    localIndex: number
  ): Promise<number> => {
    const direct = /^db-(\d+)$/.exec(message.id);
    if (direct) {
      const parsed = Number(direct[1]);
      if (Number.isInteger(parsed) && parsed > 0) return parsed;
    }
    await persistQueueRef.current.catch(() => undefined);
    let rows: ChatMessageRecord[];
    try {
      rows = await api.listMessages(document.id, activeSessionId);
    } catch (error) {
      throw new Error(
        `读取消息保存状态失败：${error instanceof Error ? error.message : '未知错误'}`
      );
    }
    const content = message.content.trim();
    // 分页显示时本地 index 与 DB 全量列表有偏移（只加载了最新一页/更早几页）：
    // 用「已显示 db-* 消息条数」算出 DB 全量列表里的起点，再做位置对齐。
    const displayedDbCount = chatMessages.reduce(
      (count, item) => count + (dbIdOfMessageId(item.id) !== null ? 1 : 0),
      0
    );
    const offset = Math.max(0, rows.length - displayedDbCount);
    const byIndex = rows[offset + localIndex];
    // 位置 + 角色 + 内容都对上才可信（宁可提示稍后再试，也不改/删错消息）。
    if (byIndex && byIndex.role === message.role && byIndex.content.trim() === content) {
      return byIndex.id;
    }
    // 本地历史与 DB 数量对不上（有过写入失败）时，从后往前找相同角色+内容的最近一条。
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      const row = rows[index];
      if (row && row.role === message.role && row.content.trim() === content) return row.id;
    }
    throw new Error('这条消息还没保存完成，请等这轮保存完成后再编辑');
  };

  /**
   * 「编辑并重问」：改数据库里那条 user 消息内容并删掉它之后的回答（DB），
   * 本地同步替换内容、丢弃其后消息，再用新内容重问。
   *
   * 不追加、也不重复持久化用户消息；history 用「该 user 之前的消息」显式计算，
   * 避免把刚被删掉的后半段又当上下文发出去。失败时本地历史保持原样，inline 错误条提示。
   */
  const editUserMessageAndReask = async (
    message: ChatMessageView,
    content: string
  ): Promise<void> => {
    const trimmedContent = content.trim();
    if (!trimmedContent) throw new Error('问题不能为空');
    if (message.role !== 'user') throw new Error('只能编辑用户消息');
    if (!activeSessionId) throw new Error('会话还在准备中，请稍后再试');
    if (askMutation.isPending) throw new Error('正在回答中，请等这一轮结束再编辑');
    if (messageActionRef.current) throw new Error('上一次消息操作还在进行中，请稍候');
    const localMessages = chatMessages;
    const localIndex = localMessages.findIndex((item) => item.id === message.id);
    if (localIndex < 0) throw new Error('这条消息已不在当前对话里，请刷新后再试');
    setChatActionError(null);
    messageActionRef.current = true;
    try {
      // 与「重新生成」同一时序：先等本组件的落库队列写完，再取消旧 messages 快照，
      // 避免 PATCH 删掉的消息又被在飞的旧 GET 恢复出来。
      await persistQueueRef.current.catch(() => undefined);
      await queryClient.cancelQueries({ queryKey: ['messages', document.id, activeSessionId] });
      const dbId = await resolveMessageDbId(message, localIndex);
      // PATCH 按 sessionId 限定：只删当前会话里目标之后的消息，不动其它会话。
      const result = await api.editDocumentMessage(
        document.id,
        dbId,
        trimmedContent,
        activeSessionId
      );
      if (!result.ok) throw new Error('数据库里没有这条用户消息，可能已被删除');
      // 编辑可能落在被摘要覆盖的消息上（服务端会清摘要）：刷新清单同步摘要显示。
      void refreshChatSessions();
      // 编辑并重问后回到最新一页（用户可能正在看搜索结果对应的完整历史），并让缓存与 DB 一致。
      searchViewRef.current = false;
      setViewingSearchResult(false);
      void queryClient.invalidateQueries({
        queryKey: ['messages', document.id, activeSessionId]
      });
      const trimmedLocal = localMessages
        .slice(0, localIndex + 1)
        .map((item, index) => (index === localIndex ? { ...item, content: trimmedContent } : item));
      // 该 user 之前的消息才进本轮上下文（后半段已在 DB/本地删除）。
      const history = recentReadingHistory(trimmedLocal.slice(0, localIndex), contextRounds);
      const selection = message.quote || '';
      setLastQuestion(trimmedContent);
      setLastSearchSelection(selection);
      // 编辑后问题变了，旧的搜索审批凭证不再适用。
      setLastSearchToken(undefined);
      setBudgetWarning(null);
      setDraftAnswer('');
      setAskStage('');
      setAuditDraft([]);
      setLastAnswerDurationMs(null);
      setChatMessages(trimmedLocal);
      askMutation.mutate({
        question: trimmedContent,
        selection,
        confirmBudget: budgetSkipActive,
        // 沿用本轮的笔记/批注口径与范围标签；旧问题的联网改写词不再适用，不带上。
        scopeTags: lastAskExtras.scopeTags,
        includeMemory: lastAskExtras.includeMemory ?? true,
        history
      });
    } catch (error) {
      setChatActionError(
        `编辑并重问失败：${error instanceof Error ? error.message : '未知错误'}`
      );
      throw error;
    } finally {
      messageActionRef.current = false;
    }
  };

  /**
   * 「从此分支删除」：删除数据库里这条消息及其后的全部消息，本地同步截断到它之前。
   *
   * 确认框由 ChatPanel（消息旁按钮）弹出，这里不再重复确认。
   * 本地截断后立即与 DB 一致；随后 invalidate messages 只为让缓存对齐，不会用旧快照覆盖
   * （DB 行数比本地少时安全合并会保留本地截断结果）。
   */
  const deleteMessagesFrom = async (message: ChatMessageView): Promise<void> => {
    if (!activeSessionId) throw new Error('会话还在准备中，请稍后再试');
    if (askMutation.isPending) throw new Error('正在回答中，请等这一轮结束再删除');
    if (messageActionRef.current) throw new Error('上一次消息操作还在进行中，请稍候');
    const localMessages = chatMessages;
    const localIndex = localMessages.findIndex((item) => item.id === message.id);
    if (localIndex < 0) throw new Error('这条消息已不在当前对话里，请刷新后再试');
    setChatActionError(null);
    messageActionRef.current = true;
    try {
      // 同一时序：先等落库队列写完，再取消旧 messages 快照，之后才从 DB 删除。
      await persistQueueRef.current.catch(() => undefined);
      await queryClient.cancelQueries({ queryKey: ['messages', document.id, activeSessionId] });
      const dbId = await resolveMessageDbId(message, localIndex);
      // DELETE 按 sessionId 限定：只删当前会话里该消息及其后的消息，不动其它会话。
      const result = await api.deleteDocumentMessagesFrom(document.id, dbId, activeSessionId);
      if (!result.ok) throw new Error('数据库里没有这条消息，可能已被删除');
      // 删除可能落在被摘要覆盖的消息上（服务端会清摘要）：刷新清单同步摘要显示。
      void refreshChatSessions();
      // 删除后回到最新一页（用户可能正在看搜索结果对应的完整历史）。
      searchViewRef.current = false;
      setViewingSearchResult(false);
      const remaining = localMessages.slice(0, localIndex);
      setChatMessages(remaining);
      setLastAnswerDurationMs(null);
      setBudgetWarning(null);
      setDraftAnswer('');
      setAskStage('');
      setAuditDraft([]);
      // 同步「上一问」状态，避免之后的重新生成/重发用到已删除的轮次。
      const lastUserLeft = [...remaining].reverse().find((item) => item.role === 'user');
      setLastQuestion(lastUserLeft?.content ?? '');
      setLastSearchSelection(lastUserLeft?.quote ?? '');
      setLastSearchToken(undefined);
      // 本地已与 DB 一致；刷新一次让缓存对齐（合并 guard 不会把本地清短）。
      void queryClient.invalidateQueries({
        queryKey: ['messages', document.id, activeSessionId]
      });
    } catch (error) {
      setChatActionError(`删除分支失败：${error instanceof Error ? error.message : '未知错误'}`);
      throw error;
    } finally {
      messageActionRef.current = false;
    }
  };

  const speakMutation = useMutation({
    mutationFn: (text: string) => api.speak(text),
    onSuccess: (blob) => {
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      let reported = false;
      const fail = (message: string): void => {
        if (reported) return;
        reported = true;
        URL.revokeObjectURL(url);
        appDialogs.alert(message);
      };
      audio.onended = () => URL.revokeObjectURL(url);
      audio.onerror = () =>
        fail('语音播报失败：音频无法播放（可能音频为空或格式不受支持）。');
      void audio.play().catch((error) => {
        fail(
          `语音播报失败：${
            error instanceof Error ? error.message : '浏览器拦截了音频播放'
          }`
        );
      });
    },
    onError: (error: Error) => {
      appDialogs.alert(`语音播报失败：${error.message}`);
    }
  });

  const speechConfigQuery = useQuery({
    queryKey: ['speech-config'],
    queryFn: () => api.getSpeechConfig()
  });
  // 语音按钮是否可用：环境能力 + 设置里的语音输入开关 + 识别服务是否配好。
  // 不可用时按钮保持可见但禁用，并把原因显示在输入框旁。
  const speechRecordingSupport = mediaRecordingSupport();
  const speechInputDisabledReason = ((): string | null => {
    if (!speechRecordingSupport.supported) return speechRecordingSupport.message;
    const speechConfig = speechConfigQuery.data;
    if (!speechConfig) return null;
    if (!speechConfig.input_enabled) return '语音输入未开启：请到设置 → 语音识别里开启';
    // 直接语音（全模态）由模型自己转写，不依赖本地 ASR 是否已配置；只有普通
    // 「把语音转成文字填入输入框」才要求识别服务可用。
    if (
      !speechConfig.direct_audio &&
      speechConfig.asr_mode !== 'system' &&
      !speechConfig.has_asr_key
    ) {
      return '还没有可用的语音识别模型：请在设置 → 语音识别里填写识别服务与密钥';
    }
    return null;
  })();
  const searchConfigQuery = useQuery({
    queryKey: ['search-config'],
    queryFn: () => api.getSearchConfig()
  });

  const translationConfigQuery = useQuery({
    queryKey: ['translation-config'],
    queryFn: () => api.getTranslationConfig()
  });
  const translationPageQuery = useQuery({
    queryKey: ['translation-page', document.id, page],
    queryFn: () => api.getTranslationPage(document.id, page)
  });
  const saveTranslationConfig = useMutation({
    // 阅读器面板只保存目标语言（只传 target_language）；翻译服务本身在设置页配置。
    mutationFn: (input: { target_language?: string }) =>
      api.updateTranslationConfig(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['translation-config'] });
    }
  });
  const translateMutation = useMutation<TranslationPagePayload, Error, boolean>({
    mutationFn: (includeFurniture) =>
      api.translatePage(document.id, page, undefined, false, includeFurniture),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['translation-page'] });
      void queryClient.invalidateQueries({ queryKey: ['translation-summary'] });
      void queryClient.invalidateQueries({ queryKey: ['translation-overview'] });
    }
  });
  const forceTranslateMutation = useMutation<TranslationPagePayload, Error, boolean>({
    mutationFn: (includeFurniture) =>
      api.translatePage(document.id, page, undefined, true, includeFurniture),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['translation-page'] });
      void queryClient.invalidateQueries({ queryKey: ['translation-summary'] });
      void queryClient.invalidateQueries({ queryKey: ['translation-overview'] });
    }
  });
  // 选文翻译只发文本、不落库：mutation 不做任何缓存/持久化副作用。
  // 试译按钮已挪到设置页的 TranslationSettingsPanel（那边自己调用 api.probeTranslation）。
  const translateQuoteMutation = useMutation({
    mutationFn: (text: string) =>
      api.translateQuote({
        text,
        ...(translationConfigQuery.data?.target_language
          ? { language: translationConfigQuery.data.target_language }
          : {})
      })
  });
  const recognizeMutation = useMutation({
    mutationFn: () => api.recognizePage(document.id, page),
    onSuccess: (result) => {
      setOcrText(result.text);
      void queryClient.invalidateQueries({ queryKey: ['translation-page'] });
    }
  });
  const translationJobQuery = useQuery({
    queryKey: ['translation-job', document.id],
    queryFn: () => api.getTranslationJob(document.id),
    refetchInterval: (query) =>
      (query.state.data as TranslationJobRecord | undefined)?.status === 'running'
        ? 1000
        : false
  });
  const translationSummaryQuery = useQuery({
    queryKey: ['translation-summary', document.id],
    queryFn: () => api.getTranslationSummary(document.id)
  });
  const pageTextQuery = useQuery({
    queryKey: ['page-text', document.id, page],
    queryFn: () => api.getPageText(document.id, page)
  });
  const savePageText = useMutation({
    mutationFn: (text: string) => api.savePageText(document.id, page, text),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['page-text'] });
      void queryClient.invalidateQueries({ queryKey: ['translation-page'] });
      void queryClient.invalidateQueries({ queryKey: ['translation-summary'] });
      void queryClient.invalidateQueries({ queryKey: ['translation-overview'] });
    }
  });
  const startTranslation = useMutation<
    TranslationJobRecord,
    Error,
    { force: boolean; includeFurniture: boolean }
  >({
    mutationFn: (input) => api.startTranslation(document.id, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['translation-job'] });
      void queryClient.invalidateQueries({ queryKey: ['translation-page'] });
      void queryClient.invalidateQueries({ queryKey: ['translation-summary'] });
      void queryClient.invalidateQueries({ queryKey: ['translation-overview'] });
    }
  });
  const stopTranslation = useMutation({
    mutationFn: () => api.stopTranslation(document.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['translation-job'] });
      void queryClient.invalidateQueries({ queryKey: ['translation-overview'] });
    }
  });
  const editTranslationSegment = useMutation({
    mutationFn: (input: { segmentId: string; text: string }) =>
      api.editTranslationSegment(document.id, input.segmentId, input.text),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['translation-page'] });
    }
  });
  const restoreTranslationSegment = useMutation({
    mutationFn: (segmentId: string) =>
      api.restoreTranslationSegment(document.id, segmentId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['translation-page'] });
    }
  });
  const retranslateTranslationSegment = useMutation<
    TranslationPagePayload,
    Error,
    number
  >({
    mutationFn: (index) =>
      api.retranslateTranslationSegment(document.id, page, index),
    onSuccess: (payload) => {
      // 服务端已返回整页 payload：直接替换缓存，避免整页重译/刷新闪烁。
      // payload 不带版面度量（与 GET /translation/pages/:page 同形状），沿用上一次的版面信息，
      // 免得"重译一段"把版面那一行弄没了。
      const queryKey = ['translation-page', document.id, page] as const;
      const previous = queryClient.getQueryData<TranslationPagePayload>([
        ...queryKey
      ]);
      queryClient.setQueryData([...queryKey], {
        ...payload,
        pageSize: payload.pageSize ?? previous?.pageSize ?? null,
        columns: payload.pageSize ? payload.columns : previous?.columns ?? payload.columns,
        bodyLineHeight: payload.pageSize
          ? payload.bodyLineHeight
          : previous?.bodyLineHeight ?? payload.bodyLineHeight,
        bodyFontSize: payload.pageSize
          ? payload.bodyFontSize
          : previous?.bodyFontSize ?? payload.bodyFontSize,
        furniture: payload.pageSize ? payload.furniture : previous?.furniture ?? payload.furniture
      });
      void queryClient.invalidateQueries({ queryKey: ['translation-summary'] });
      void queryClient.invalidateQueries({ queryKey: ['translation-overview'] });
    }
  });

  /**
   * 导出下载：优先交给壳的"保存到用户选择位置"（桌面弹保存框），
   * 宿主未实现 saveBlob 时退回浏览器下载，保证 DSH/Web 宿主也能用。
   */
  const downloadBlob = async (blob: Blob, filename: string): Promise<void> => {
    if (adapter.saveBlob) {
      const result = await adapter.saveBlob(new Uint8Array(await blob.arrayBuffer()), filename);
      if (result.ok) return;
    }
    const url = URL.createObjectURL(blob);
    const anchor = window.document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const exportMutation = useMutation({
    mutationFn: () => api.exportDocument(document.id),
    onSuccess: (markdown) => {
      // 文件头加显式导出声明、学术披露提示与隐式注释：导出内容可能包含 AI 生成的笔记。
      const blob = new Blob([withAiExportHeader(markdown)], {
        type: 'text/markdown;charset=utf-8'
      });
      void downloadBlob(blob, `${document.name.replace(/\.pdf$/i, '')}-批注.md`);
    }
  });

  const exportAnnotatedPdf = useMutation({
    mutationFn: () => api.exportAnnotatedPdf(document.id),
    onSuccess: ({ bytes }) => {
      const blob = new Blob([bytes], { type: 'application/pdf' });
      void downloadBlob(blob, `${document.name.replace(/\.pdf$/i, '')}-批注.pdf`);
    }
  });

  const buildNavigation = useMutation({
    mutationFn: (options?: { tocPages?: number[] }) =>
      api.buildNavigation(document.id, options),
    onSuccess: () => {
      // 生成的是本地目录：切到本地来源，让用户马上看到结果。
      setOutlineSource('local');
      void queryClient.invalidateQueries({ queryKey: ['navigation', document.id] });
      void queryClient.invalidateQueries({ queryKey: ['navigation-preview', document.id] });
      void queryClient.invalidateQueries({ queryKey: ['navigation-status', document.id] });
    },
    onError: () => {
      // 失败（含"0 条目录"这种明确错误）要刷新状态，面板才能显示 failed 与原因，
      // 而不是停在旧的"已就绪"上让用户以为没反应。
      void queryClient.invalidateQueries({ queryKey: ['navigation-status', document.id] });
      void queryClient.invalidateQueries({ queryKey: ['navigation-preview', document.id] });
    }
  });

  // 「按目录页生成目录」：先预览识别结果（条目 + 页码偏移），确认后再生成。
  const previewTocNavigation = useMutation({
    mutationFn: (tocPages: number[]) => api.previewTocNavigation(document.id, tocPages)
  });

  // 勾选启用、但当前只有 PDF 内置目录（或本地目录已过期）时：先把内置目录保存成本地副本。
  const materializeOutline = useMutation({
    mutationFn: (nodes: Array<{ page: number; label: string }>) =>
      api.saveNavigation(document.id, nodes, { materialize: true }),
    onSuccess: () => {
      setOutlineSource('local');
      void queryClient.invalidateQueries({ queryKey: ['navigation', document.id] });
      void queryClient.invalidateQueries({ queryKey: ['navigation-preview', document.id] });
      void queryClient.invalidateQueries({ queryKey: ['navigation-status', document.id] });
    }
  });

  const setNavigationEnabled = useMutation({
    mutationFn: (enabled: boolean) => api.setNavigationEnabled(document.id, enabled),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['navigation-status', document.id] });
      void queryClient.invalidateQueries({ queryKey: ['navigation', document.id] });
      void queryClient.invalidateQueries({ queryKey: ['navigation-preview', document.id] });
    }
  });

  const addMask = useMutation({
    mutationFn: (input: {
      page: number;
      scope?: 'page' | 'all' | 'odd' | 'even' | 'range' | 'exclude';
      rangeStart?: number;
      rangeEnd?: number;
      excludePages?: number[];
      x0: number;
      y0: number;
      x1: number;
      y1: number;
    }) => api.addPageMask(document.id, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['masks', document.id] });
      void queryClient.invalidateQueries({ queryKey: ['page-data', document.id] });
      void queryClient.invalidateQueries({ queryKey: ['navigation-status', document.id] });
      void queryClient.invalidateQueries({ queryKey: ['mask-status', document.id] });
      refreshMaskStatusSoon();
    }
  });

  const deleteMask = useMutation({
    mutationFn: (maskId: string) => api.deletePageMask(document.id, maskId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['masks', document.id] });
      void queryClient.invalidateQueries({ queryKey: ['page-data', document.id] });
      void queryClient.invalidateQueries({ queryKey: ['navigation-status', document.id] });
      void queryClient.invalidateQueries({ queryKey: ['mask-status', document.id] });
      refreshMaskStatusSoon();
    }
  });

  const updateMask = useMutation({
    mutationFn: (input: {
      maskId: string;
      scope?: 'page' | 'all' | 'odd' | 'even' | 'range' | 'exclude';
      page?: number;
      rangeStart?: number;
      rangeEnd?: number;
      excludePages?: number[];
      x0?: number;
      y0?: number;
      x1?: number;
      y1?: number;
    }) => api.updatePageMask(document.id, input.maskId, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['masks', document.id] });
      void queryClient.invalidateQueries({ queryKey: ['page-data', document.id] });
      void queryClient.invalidateQueries({ queryKey: ['navigation-status', document.id] });
      void queryClient.invalidateQueries({ queryKey: ['mask-status', document.id] });
      refreshMaskStatusSoon();
    }
  });

  useEffect(() => {
    if (navigationStatusQuery.data?.state === 'ready') {
      void queryClient.invalidateQueries({ queryKey: ['navigation', document.id] });
      void queryClient.invalidateQueries({ queryKey: ['navigation-preview', document.id] });
    }
  }, [navigationStatusQuery.data?.state, document.id, queryClient]);

  useEffect(() => {
    const updateWidth = (): void => {
      const available = scrollRef.current?.clientWidth ?? window.innerWidth - 420;
      setBaseWidth(Math.min(920, Math.max(360, available - 56)));
    };
    updateWidth();
    window.addEventListener('resize', updateWidth);
    return () => window.removeEventListener('resize', updateWidth);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setPdf(null);
    setPdfError(null);
    const baseUrl =
      window.location.protocol === 'file:'
        ? // 打包后渲染页从 file:// 加载，pdf.js 的 cmaps/wasm/standard_fonts/iccs 走
          // studianda-asset 自定义协议；固定用 `app` 主机名，主进程会把 `app/`
          // 前缀剥掉再映射到 out/renderer/（空主机名写法在 Electron 里可能被当成
          // 非法 base URL）。
          'studianda-asset://app/'
        : new URL('.', window.location.href).href;
    const source = api.getDocumentFileSource(document.id);
    const task = getDocument({
      // 通过本地 HTTP Range 按需读取，不把整本 PDF 复制进渲染进程。
      url: source.url,
      httpHeaders: source.httpHeaders,
      rangeChunkSize: 256 * 1024,
      // 页面在 Chromium 中绘制：嵌入字体走字形路径，缺字体交给系统回退。
      disableAutoFetch: true,
      disableStream: false,
      disableFontFace: true,
      useSystemFonts: true,
      cMapUrl: new URL('cmaps/', baseUrl).href,
      cMapPacked: true,
      standardFontDataUrl: new URL('standard_fonts/', baseUrl).href,
      iccUrl: new URL('iccs/', baseUrl).href,
      wasmUrl: new URL('wasm/', baseUrl).href
    });
    task.promise
      .then((loaded) => {
        if (!cancelled) setPdf(loaded);
      })
      .catch((error: unknown) => {
        if (!cancelled) setPdfError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
      void task.destroy();
    };
  }, [api, document.id]);

  useEffect(() => {
    if (!pdf || restoredPageRef.current) return;
    restoredPageRef.current = true;
    const target = Math.min(Math.max(1, initialPage ?? document.currentPage), pdf.numPages);
    setPage(target);
    // 只恢复一次；不能因为阅读过程中 currentPage 更新而反复把用户拉回页首。
    const frame = window.requestAnimationFrame(() => {
      const container = scrollRef.current;
      const element = container?.querySelector<HTMLElement>(`[data-page="${target}"]`);
      if (container && element) {
        container.scrollTop +=
          element.getBoundingClientRect().top - container.getBoundingClientRect().top - 8;
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [pdf]);

  useEffect(() => {
    void api.updateDocument(document.id, { currentPage: page });
  }, [api, document.id, page]);

  useEffect(() => {
    return () => {
      // 页面在渲染进程绘制，离开阅读页时无需清理服务端页面缓存。
    };
  }, []);

  useEffect(() => {
    setPageInput(String(page));
  }, [page]);

  useEffect(() => {
    if (!pdf) {
      setOutline([]);
      return;
    }
    let cancelled = false;
    const pageForDestination = async (destination: unknown): Promise<number | null> => {
      try {
        const resolved =
          typeof destination === 'string'
            ? await pdf.getDestination(destination)
            : destination;
        if (!Array.isArray(resolved) || resolved.length === 0) return null;
        const index = await pdf.getPageIndex(resolved[0] as Parameters<typeof pdf.getPageIndex>[0]);
        return index + 1;
      } catch {
        return null;
      }
    };
    const build = async (nodes: unknown[]): Promise<OutlineEntry[]> => {
      const entries: OutlineEntry[] = [];
      for (const node of nodes) {
        if (!node || typeof node !== 'object') continue;
        const item = node as {
          title?: unknown;
          dest?: unknown;
          items?: unknown[];
        };
        entries.push({
          title: typeof item.title === 'string' ? item.title : '',
          page: item.dest != null ? await pageForDestination(item.dest) : null,
          items: Array.isArray(item.items) ? await build(item.items) : []
        });
      }
      return entries;
    };
    void pdf.getOutline().then(async (nodes) => {
      if (cancelled) return;
      setOutline(await build((nodes ?? []) as unknown[]));
    });
    return () => {
      cancelled = true;
    };
  }, [pdf]);

  const annotations = (annotationsQuery.data ?? []).filter(
    (annotation: AnnotationRecord) => annotation.page === page
  );

  const commitZoomInput = (): void => {
    const raw = zoomInputRef.current?.value ?? '100%';
    const next = Number(raw.replace('%', '').trim());
    if (!Number.isFinite(next)) {
      syncZoomInput(zoomRef.current);
      return;
    }
    const percent = Math.min(240, Math.max(60, Math.round(next)));
    setZoomAnchored(percent / 100);
  };

  const clearMasks = (): void => {
    const targets = (masksQuery.data ?? []).filter(
      (mask) => maskAllPages || mask.page === 0 || mask.page === page
    );
    for (const mask of targets) deleteMask.mutate(mask.id);
  };

  const fitWidth = (): void => {
    const targetPage = page;
    suppressScrollRef.current = true;
    setZoomAnchored(1);
    setPage(targetPage);
    window.requestAnimationFrame(() => {
      const container = scrollRef.current;
      if (container) container.scrollLeft = 0;
      const target = container?.querySelector<HTMLElement>(`[data-page="${targetPage}"]`);
      if (container && target) {
        container.scrollTop +=
          target.getBoundingClientRect().top - container.getBoundingClientRect().top - 8;
      }
      window.setTimeout(() => {
        suppressScrollRef.current = false;
      }, 420);
    });
  };

  const scrollToPage = (next: number): void => {
    const total = pdf?.numPages ?? document.pages;
    const target = Math.min(Math.max(1, next), total);
    suppressScrollRef.current = true;
    setPage(target);
    const container = scrollRef.current;
    const element = container?.querySelector<HTMLElement>(`[data-page="${target}"]`);
    if (container && element) {
      container.scrollTop +=
        element.getBoundingClientRect().top - container.getBoundingClientRect().top - 8;
    }
    window.setTimeout(() => {
      suppressScrollRef.current = false;
    }, 420);
  };

  /**
   * 把某一页的目标区域滚到阅读区里；只在目标不在视口舒适区时才滚，
   * 避免悬停相邻译文段落时原文区域来回抖动。
   */
  const scrollPdfToBox = (targetPage: number, box: number[]): void => {
    const container = scrollRef.current;
    if (!container) return;
    const pageElement = container.querySelector<HTMLElement>(`[data-page="${targetPage}"]`);
    if (!pageElement) return;
    const containerRect = container.getBoundingClientRect();
    const pageRect = pageElement.getBoundingClientRect();
    const top = pageRect.top - containerRect.top + box[1]! * pageRect.height;
    const bottom = pageRect.top - containerRect.top + box[3]! * pageRect.height;
    const comfort = container.clientHeight * 0.32;
    if (top >= comfort && bottom <= container.clientHeight - comfort) return;
    // 悬停跳转期间不更新当前页，否则译文栏会跟着跳到下一页、把用户刚悬停的那一段顶掉。
    // 悬停属于“指哪打哪”，用即时滚动比平滑动画更跟手，也不会被重渲染打断。
    suppressScrollRef.current = true;
    container.scrollTop = Math.max(
      0,
      container.scrollTop + top - container.clientHeight * 0.32
    );
    window.setTimeout(() => {
      suppressScrollRef.current = false;
    }, 600);
  };

  const openOutlineEntry = (entry: OutlineEntry): void => {
    if (entry.page == null) return;
    const targetPage = entry.page;
    scrollToPage(targetPage);
    setLocated(null);
    void (async () => {
      try {
        const location = await api.locateQuote(document.id, targetPage, entry.title);
        const boxes = location.boxes;
        if (location.corrected) {
          scrollToPage(location.page);
          appDialogs.alert(location.message);
        }
        const first = boxes[0];
        const container = scrollRef.current;
        const element = container?.querySelector<HTMLElement>(`[data-page="${location.page}"]`);
        if (!first || !container || !element) return;
        const containerRect = container.getBoundingClientRect();
        const pageRect = element.getBoundingClientRect();
        const y = first.bbox[1];
        container.scrollTop += pageRect.top - containerRect.top + y * pageRect.height - 48;
        setLocated({ page: location.page, boxes: boxes.map((box) => box.bbox) });
        window.setTimeout(() => setLocated(null), 3500);
      } catch {
        // 找不到标题位置时保留滚到页首的降级行为。
      }
    })();
  };

  const handleScroll = (): void => {
    // 跳页/悬停跳转期间锁住页码；悬停时页码一变，译文栏会切页并清掉高亮。
    if (suppressScrollRef.current || hoverActiveRef.current || zoomingRef.current) return;
    const container = scrollRef.current;
    if (!container || scrollFrameRef.current) return;
    // 滚动事件很密集：每帧最多检测一次，避免每个事件都遍历 266 个页面读布局。
    scrollFrameRef.current = window.requestAnimationFrame(() => {
      scrollFrameRef.current = 0;
      const container = scrollRef.current;
      if (!container || suppressScrollRef.current || hoverActiveRef.current || zoomingRef.current) {
        return;
      }
      const containerRect = container.getBoundingClientRect();
      const anchor = containerRect.top + containerRect.height * 0.28;
      let bestPage = pageRef.current;
      let bestDistance = Number.POSITIVE_INFINITY;
      for (const element of container.querySelectorAll<HTMLElement>('[data-page]')) {
        const rect = element.getBoundingClientRect();
        if (rect.bottom < containerRect.top || rect.top > containerRect.bottom) continue;
        const distance = Math.abs(rect.top - anchor);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestPage = Number(element.dataset.page ?? '1');
        }
      }
      if (bestPage !== pageRef.current) setPage(bestPage);
    });
  };
  handleScrollRef.current = handleScroll;

  // 预算确认的响应没有回答内容：沿用上一条助手回答，避免把已有依据/审计面板清空。
  const lastAssistantResponse = [...chatMessages]
    .reverse()
    .find((message) => message.role === 'assistant' && message.response)?.response;
  // 当前会话的早期摘要（服务端压缩生成；只是上下文，不是文献原文/证据）。
  const activeChatSession = chatSessions.find((session) => session.id === activeSessionId);
  const activeSessionSummary = activeChatSession?.contextSummary?.trim() ?? '';
  const activeSessionSummaryLabel = ((): string => {
    const summaryUpto = activeChatSession?.summaryUpto ?? 0;
    if (summaryUpto <= 0) return '本会话早期摘要';
    // summaryUpto 是最后一条被压缩消息的 DB id；换算成「本会话第几条消息」更好读。
    let covered = 0;
    for (const message of chatMessages) {
      const match = /^db-(\d+)$/.exec(message.id);
      if (match && Number(match[1]) <= summaryUpto) covered += 1;
    }
    return covered > 0
      ? `本会话早期摘要（已压缩到第 ${covered} 条消息前）`
      : '本会话早期摘要';
  })();
  const rawChatData = askMutation.data as ChatResponse | undefined;
  const chatData =
    rawChatData?.needs_confirmation ? lastAssistantResponse : rawChatData ?? lastAssistantResponse;
  const spokenAnswer = useRef('');
  useEffect(() => {
    const answer = chatData?.answer;
    if (!answer || !speechConfigQuery.data?.auto_read) return;
    if (spokenAnswer.current === answer) return;
    spokenAnswer.current = answer;
    speakMutation.mutate(answer);
  }, [chatData?.answer, speechConfigQuery.data?.auto_read, speakMutation]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || target?.isContentEditable) {
        return;
      }
      if (!matchesShortcut(event, shortcut('readAnswer', 'Ctrl+Shift+R'))) return;
      const answer = chatData?.answer;
      if (!answer) return;
      event.preventDefault();
      speakMutation.mutate(answer);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [chatData?.answer, shortcutSettings.data, speakMutation]);
  const generatedOutline: OutlineEntry[] = (
    navigationPreviewQuery.data?.nodes ??
    navigationQuery.data ??
    []
  )
    .filter((node) => isMeaningfulNavigationLabel(node.label))
    .map((node) => ({
      title: node.label,
      page: node.page,
      items: []
    }));
  const navigationBuilding = navigationStatusQuery.data?.state === 'building';
  // 目录启用门禁的如实说明：未生成/过期/失败时不能假装已启用。
  const navigationGateReason = (() => {
    const status = navigationStatusQuery.data;
    if (!status) return '';
    if (status.state === 'missing') {
      return status.enabled
        ? '目录已启用，但还没有生成：请先生成目录'
        : '目录未生成（默认关闭，需要手动生成并启用）';
    }
    if (status.state === 'stale') {
      return status.stale_reason
        ? `目录已过期（${status.stale_reason}）：请重新生成`
        : '目录已过期（文献文件已变化/无关区域规则已变化/索引已过期）：请重新生成';
    }
    if (status.state === 'failed') return `目录生成失败：${status.error || '未知原因'}`;
    if (status.state === 'building') {
      return `目录正在生成中：${status.done ?? 0}/${status.total ?? document.pages} 页`;
    }
    if (status.state === 'ready') {
      return status.enabled
        ? '目录已启用：参与章节选择与阅读范围建议（不进入回答与证据）'
        : '目录已生成，但未启用（启用后参与章节选择与阅读范围建议，不进入回答与证据）';
    }
    return '';
  })();
  const navigationGateDisabled =
    setNavigationEnabled.isPending ||
    materializeOutline.isPending ||
    saveOutline.isPending ||
    navigationStatusQuery.data?.state === 'building' ||
    (navigationStatusQuery.data?.state !== 'ready' && outline.length === 0);
  /**
   * 启用目录参与阅读规划。
   *
   * 阅读规划只读本地目录（`doc_navigation`）；如果当前只有 PDF 内置目录（或本地目录已过期），
   * 勾选时先把内置目录落成本地目录（标记为 materialized）再启用，避免"有内置目录却无法勾选"。
   */
  const toggleNavigationEnabled = async (enabled: boolean): Promise<void> => {
    const state = navigationStatusQuery.data?.state;
    if (enabled && state !== 'ready' && outline.length > 0) {
      try {
        await materializeOutline.mutateAsync(
          outline
            .filter((entry) => entry.page != null)
            .map((entry) => ({ page: entry.page as number, label: entry.title }))
        );
        setNavigationEnabled.mutate(true);
      } catch {
        // 错误由 enableError 文案展示，这里不再覆盖。
      }
      return;
    }
    setNavigationEnabled.mutate(enabled);
  };
  useEffect(() => {
    if (!pdf || !initialQuote) return;
    let cancelled = false;
    const targetPage = Math.min(Math.max(1, initialPage ?? 1), pdf.numPages);
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const location = await api.locateQuote(document.id, targetPage, initialQuote);
          if (cancelled) return;
          if (location.corrected) scrollToPage(location.page);
          if (location.boxes.length === 0) {
            // 全文都找不到时如实说明，不静默停在目标页装作已定位。
            if (location.method === 'none') appDialogs.alert(location.message);
            return;
          }
          setLocated({
            page: location.page,
            boxes: location.boxes.map((box) => box.bbox)
          });
          if (location.corrected) appDialogs.alert(location.message);
          window.setTimeout(() => {
            if (!cancelled) setLocated(null);
          }, 6000);
        } catch {
          // 跨文献引用定位失败时仍停留在目标页
        }
      })();
    }, 500);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [api, document.id, initialPage, initialQuote, pdf]);
  const openSource = async (source: ChatSource): Promise<void> => {
    // 定位优先级：逐字摘引 > 复核锚点 > 命中行定位；locate 只用于定位，不是引用证据。
    const quote = source.quotes?.[0] ?? source.anchor ?? source.locate;
    const memoryPanel =
      source.kind === 'note' ? 'notes' : source.kind === 'annotation' ? 'annotations' : null;
    if (memoryPanel) {
      // 独立笔记来源（documentId 为空）：切到独立笔记视图，不在阅读页里硬开。
      if (!source.documentId) {
        if (source.memoryId) onOpenStandaloneNote?.(source.memoryId);
        return;
      }
      if (source.documentId !== document.id) {
        onOpenDocument?.(source.documentId, source.page, quote);
        return;
      }
      // 同一篇文献：先切到对应的笔记/批注面板；批注带摘引时下面继续逐字定位高亮。
      setPanel(memoryPanel);
      openPanel();
    } else if (source.documentId !== document.id) {
      onOpenDocument?.(source.documentId, source.page, quote);
      return;
    }
    setLocated(null);
    scrollToPage(source.page);
    if (!quote) return;
    try {
      const location = await api.locateQuote(document.id, source.page, quote);
      if (location.corrected) {
        // 记录页不对：回到返回的真实页再标框，并如实说明更正过。
        scrollToPage(location.page);
        appDialogs.alert(location.message);
      }
      if (location.boxes.length === 0) {
        if (location.method === 'none') appDialogs.alert(location.message);
        return;
      }
      const targetPage = location.page;
      const container = scrollRef.current;
      const pageElement = container?.querySelector<HTMLElement>(
        `[data-page="${targetPage}"]`
      );
      if (container && pageElement) {
        const containerRect = container.getBoundingClientRect();
        const pageRect = pageElement.getBoundingClientRect();
        const first = location.boxes[0]!;
        container.scrollTop +=
          pageRect.top - containerRect.top + first.bbox[1] * pageRect.height - 72;
      }
      setLocated({
        page: targetPage,
        boxes: location.boxes.map((box) => box.bbox)
      });
      window.setTimeout(() => setLocated(null), 6000);
    } catch {
      // 页码已经跳转；逐字定位失败时不伪造高亮。
    }
  };

  /** 参考文献面板跳转：翻到目标页并高亮条目/引用所在的块。 */
  const locateReference = (target: { page: number; bbox: [number, number, number, number] }): void => {
    scrollToPage(target.page);
    setLocated({ page: target.page, boxes: [target.bbox] });
    window.setTimeout(() => setLocated(null), 4000);
  };

  const locateTranslationSource = async (quote: string): Promise<void> => {
    if (!quote.trim()) return;
    try {
      const location = await api.locateQuote(document.id, page, quote);
      if (location.corrected) {
        scrollToPage(location.page);
        appDialogs.alert(location.message);
      }
      if (location.boxes.length > 0) {
        const boxes = location.boxes.map((box) => box.bbox);
        setLocated({ page: location.page, boxes });
        window.setTimeout(() => setLocated(null), 4000);
        // 等目标页渲染/跳页生效后再把区域滚到阅读区中部。
        window.setTimeout(() => scrollPdfToBox(location.page, boxes[0]!), 80);
      } else if (location.method === 'none') {
        appDialogs.alert(location.message);
      }
    } catch {
      // 页码已跳转；定位失败不伪造高亮。
    }
  };

  const hoverTranslationSource = (quote: string | null): void => {
    const token = ++hoverTokenRef.current;
    if (hoverTimerRef.current !== null) {
      window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    if (!quote) {
      hoverActiveRef.current = false;
      setHoverLocated(null);
      return;
    }
    hoverActiveRef.current = true;
    // 悬停即跳转：去抖后定位原文，把对应区域滚进阅读区并高亮。
    // 注意先滚动再 setHoverLocated：高亮渲染会触发重渲染，在合成事件/快速移动时可能
    // 立刻触发一次 mouseleave，把 token 推进、导致“滚了但没高亮”或“高亮但没滚”。
    hoverTimerRef.current = window.setTimeout(() => {
      hoverTimerRef.current = null;
      void (async () => {
        try {
          const location = await api.locateQuote(document.id, page, quote);
          if (token !== hoverTokenRef.current) return;
          if (location.corrected) scrollToPage(location.page);
          const boxes = location.boxes.map((box) => box.bbox);
          if (boxes.length === 0) {
            setHoverLocated(null);
            return;
          }
          scrollPdfToBox(location.page, boxes[0]!);
          if (token !== hoverTokenRef.current) return;
          setHoverLocated({ page: location.page, boxes });
        } catch {
          if (token === hoverTokenRef.current) setHoverLocated(null);
        }
      })();
    }, 80);
  };

  // 关闭译文栏时收掉悬停高亮与待执行的跳转，避免原文里留下残影。
  useEffect(() => {
    if (translationOpen) return;
    if (hoverTimerRef.current !== null) {
      window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    hoverActiveRef.current = false;
    setHoverLocated(null);
  }, [translationOpen]);

  const askAboutAnnotation = (annotation: AnnotationRecord): void => {
    const quote = annotation.quote.trim();
    const content = annotation.content.trim();
    setChatQuote(quote);
    setChatDraft(
      content
        ? `关于我在第 ${annotation.page} 页的批注「${content}」：请结合${
            quote ? '上面引用的原文' : '这一页的原文'
          }说明。`
        : `请结合上下文解释我在第 ${annotation.page} 页标记的这段原文。`
    );
    setPanel('chat');
  };

  // [[内部引用]] 跳转：document 直接打开；annotation/note 先查列表拿页码再打开并跳页。
  // 同一文献内跳页依赖 Workspace 给 ReaderView 的 key=`${id}:${page}`：selected.page 变化会重建阅读视图。
  const loadAnnotationsForReference = (documentId: string): Promise<AnnotationRecord[]> =>
    api.listAnnotations(documentId);
  const loadNotesForReference = (documentId: string): Promise<NoteRecord[]> =>
    api.listNotes(documentId);
  const openMarkdownInternal = async (target: MarkdownInternalTarget): Promise<void> => {
    // 独立笔记（没有 documentId）：切到独立笔记工作区并选中该笔记。
    if (target.kind === 'note' && !target.documentId) {
      onOpenStandaloneNote?.(target.noteId);
      return;
    }
    const targetDocument = (documents ?? []).find((item) => item.id === target.documentId);
    if (!targetDocument) {
      appDialogs.alert('引用的文献不存在或已从文献库删除。');
      return;
    }
    const fallbackPage = Math.max(1, targetDocument.currentPage || 1);
    if (target.kind === 'document') {
      // 同一文献内不重建阅读视图（保留当前面板与缩放），只滚动到当前阅读页。
      if (targetDocument.id === document.id) {
        scrollToPage(Math.max(1, page));
        return;
      }
      onOpenDocument?.(targetDocument.id, fallbackPage);
      return;
    }
    try {
      const itemId = target.kind === 'annotation' ? target.annotationId : target.noteId;
      const entries = (await (target.kind === 'annotation'
        ? loadAnnotationsForReference(target.documentId)
        : loadNotesForReference(target.documentId))) as Array<{ id: string; page: number }>;
      const entry = entries.find((item) => item.id === itemId);
      if (!entry) {
        appDialogs.alert(`引用的${target.kind === 'annotation' ? '批注' : '笔记'}不存在或已删除。`);
        return;
      }
      // 页码 0 表示整篇笔记/无页码：退回到文献当前阅读页，而不是报"找不到"。
      const targetPageNumber = entry.page > 0 ? entry.page : fallbackPage;
      if (targetDocument.id === document.id) {
        // 同一文献内跳页：直接滚动并更新当前页，避免重建阅读视图把侧栏面板切回对话。
        scrollToPage(entry.page > 0 ? entry.page : Math.max(1, page));
        return;
      }
      onOpenDocument?.(targetDocument.id, targetPageNumber);
    } catch (error) {
      appDialogs.alert(`打开内部引用失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  // 反向链接跳转：打开来源文献并跳到来源页；同文献直接滚动，跨文献走 onOpenDocument。
  const openBacklink = (backlink: BacklinkRecord): void => {
    const targetDocument = (documents ?? []).find((item) => item.id === backlink.documentId);
    if (!targetDocument) {
      appDialogs.alert('反向链接的来源文献不存在或已从文献库删除。');
      return;
    }
    const pageNumber =
      backlink.page > 0 ? backlink.page : Math.max(1, targetDocument.currentPage || 1);
    if (targetDocument.id === document.id) {
      // 同一文献：滚动到来源页，并把侧栏切到来源类型，方便继续看上下文。
      setPanel(backlink.kind === 'note' ? 'notes' : 'annotations');
      scrollToPage(pageNumber);
      return;
    }
    onOpenDocument?.(targetDocument.id, pageNumber);
  };

  const locateAnnotation = async (annotation: AnnotationRecord): Promise<void> => {
    // 优先用批注自己的矩形（应用内框选、或从 Zotero 坐标换算来的高亮/下划线）：
    // 不再拿字号/空格可能不一致的文本层重新查找。
    const ownBoxes = normalizedAnnotationRects(annotation.rects);
    if (ownBoxes.length > 0) {
      scrollToPage(annotation.page);
      // 跳页后继续滚到批注所在位置（页首不等于批注位置，尤其是长页/双栏页）。
      const first = ownBoxes[0];
      window.requestAnimationFrame(() => {
        if (first) scrollPdfToBox(annotation.page, first);
      });
      setLocated({ page: annotation.page, boxes: ownBoxes });
      window.setTimeout(() => setLocated(null), 4000);
      return;
    }
    // 页级批注 / 没有可用框也没有摘引：直接滚到它记录的页，不弹"找不到原文"。
    if (annotation.style === 'page' || !annotation.quote.trim()) {
      scrollToPage(annotation.page);
      setLocated(null);
      return;
    }
    try {
      const location = await api.locateQuote(document.id, annotation.page, annotation.quote);
      if (location.boxes.length === 0) {
        appDialogs.alert(location.message || '没有在这页原文中逐字找到这段摘引，未猜测位置。');
        return;
      }
      if (location.corrected) {
        scrollToPage(location.page);
        appDialogs.alert(location.message);
      } else {
        scrollToPage(annotation.page);
      }
      // 同样滚到命中位置本身，而不是只停在页首。
      const firstBox = location.boxes[0]?.bbox;
      window.requestAnimationFrame(() => {
        if (firstBox) scrollPdfToBox(location.page, firstBox);
      });
      setLocated({
        page: location.page,
        boxes: location.boxes.map((box) => box.bbox)
      });
      window.setTimeout(() => setLocated(null), 4000);
    } catch (error) {
      appDialogs.alert(error instanceof Error ? error.message : '定位失败');
    }
  };

  const jumpToPageInput = (): void => {
    const next = Number(pageInput);
    if (Number.isFinite(next)) {
      scrollToPage(next);
      setPageInput(String(Math.min(Math.max(1, Math.trunc(next)), pdf?.numPages ?? document.pages)));
    } else {
      setPageInput(String(page));
    }
  };

  // 「重新生成」入口条件：最后一条是助手回答、存在可重发的文字问题（语音占位不算）、当前没有提问在飞。
  const lastChatMessage = chatMessages[chatMessages.length - 1];
  const lastUserMessageForRegenerate = [...chatMessages]
    .reverse()
    .find((message) => message.role === 'user');
  const lastUserQuestionForRegenerate = lastUserMessageForRegenerate?.content.trim() ?? '';
  const canRegenerate =
    !askMutation.isPending &&
    lastChatMessage?.role === 'assistant' &&
    lastUserQuestionForRegenerate !== '' &&
    !lastUserQuestionForRegenerate.startsWith('（语音');

  return (
    <div className="kr-reader">
      <header className="kr-reader__bar">
        <button
          type="button"
          className="kr-back kr-icon-btn"
          onClick={onBack}
          aria-label="返回文献库"
          title="返回文献库"
        >
          <IconBack />
        </button>
        <div className="kr-reader__reader-nav" role="group" aria-label="页面与目录">
          <button
            type="button"
            className={readerNav ? 'kr-icon-btn is-active' : 'kr-icon-btn'}
            aria-pressed={Boolean(readerNav)}
            aria-label="页面与目录"
            title="页面与目录"
            onClick={() => setReaderNav((value) => (value ? null : 'pages'))}
          >
            <IconNav />
          </button>
          <button
            type="button"
            className={translationOpen ? 'kr-icon-btn is-active' : 'kr-icon-btn'}
            aria-pressed={translationOpen}
            aria-label="翻译"
            title="在原文右侧逐段对照译文；悬停译文段落会跳转并高亮对应原文区域"
            onClick={toggleTranslation}
          >
            <IconTranslate />
          </button>
          <button
            type="button"
            className={structureOpen ? 'kr-icon-btn is-active' : 'kr-icon-btn'}
            aria-pressed={structureOpen}
            aria-label="结构/内容块"
            title="浏览章节与内容块（标题/正文/列表/图表/公式/脚注/参考文献），点击跳到对应页"
            onClick={() => setStructureOpen(true)}
          >
            <IconBlocks />
          </button>
        </div>
        <div className="kr-reader__pagebar">
          <button
            type="button"
            className="kr-reader__page-arrow"
            aria-label="上一页"
            disabled={page <= 1}
            onClick={() => scrollToPage(page - 1)}
          >
            ‹
          </button>
          <input
            className="kr-reader__page-input"
            value={pageInput}
            inputMode="numeric"
            aria-label="跳转页码"
            onChange={(event) => setPageInput(event.target.value)}
            onBlur={jumpToPageInput}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                jumpToPageInput();
              }
            }}
          />
          <span className="kr-reader__page-total">/ {pdf?.numPages ?? document.pages}</span>
          <button
            type="button"
            className="kr-reader__page-arrow"
            aria-label="下一页"
            disabled={page >= (pdf?.numPages ?? document.pages)}
            onClick={() => scrollToPage(page + 1)}
          >
            ›
          </button>
        </div>
        <select
          className="kr-reader__section-select"
          value=""
          aria-label="按章节跳转"
          onChange={(event) => {
            const target = Number(event.target.value);
            if (Number.isFinite(target) && target > 0) scrollToPage(target);
          }}
        >
          <option value="">章节跳转…</option>
          {(navigationPreviewQuery.data?.nodes ?? navigationQuery.data ?? [])
            .filter((entry) => isMeaningfulNavigationLabel(entry.label))
            .map((entry) => (
            <option value={entry.page} key={`${entry.page}-${entry.label}`}>
              第 {entry.page} 页 · {entry.label}
            </option>
          ))}
        </select>
        <div className="kr-reader__zoom" role="group" aria-label="缩放">
          <button
            type="button"
            onClick={() =>
              setZoomAnchored(Math.max(60, Math.round(zoomRef.current * 100) - 5) / 100)
            }
          >
            −
          </button>
          <input
            ref={zoomInputRef}
            className="kr-reader__zoom-input"
            defaultValue="100%"
            inputMode="numeric"
            aria-label="缩放百分比"
            onBlur={commitZoomInput}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                commitZoomInput();
              }
            }}
          />
          <button
            type="button"
            onClick={() =>
              setZoomAnchored(Math.min(240, Math.round(zoomRef.current * 100) + 5) / 100)
            }
          >
            +
          </button>
          <button
            type="button"
            className="kr-icon-btn"
            onClick={fitWidth}
            aria-label="适合宽度"
            title="适合宽度"
          >
            <IconFitWidth />
          </button>
        </div>
        <div className="kr-reader__edit-tools">
          <button
            type="button"
            className={regionMode ? 'kr-icon-btn is-active' : 'kr-icon-btn'}
            aria-pressed={regionMode}
            aria-label="区域框选"
            title="框选一块区域：可直接「对此处提问」，也可保存为区域批注"
            onClick={() => {
              setRegionMode((value) => !value);
              setMaskMode(false);
              setOcrRegionMode(false);
            }}
          >
            <IconRegion />
          </button>
          <button
            type="button"
            className={maskMode ? 'kr-icon-btn is-active' : 'kr-icon-btn'}
            aria-pressed={maskMode}
            aria-label="屏蔽区域"
            title="把选中的区域从阅读与检索里屏蔽"
            onClick={() => {
              setMaskMode((value) => !value);
              setRegionMode(false);
              setOcrRegionMode(false);
            }}
          >
            <IconMask />
          </button>
          <button
            type="button"
            className={ocrRegionMode ? 'kr-icon-btn is-active' : 'kr-icon-btn'}
            aria-pressed={ocrRegionMode}
            disabled={ocrRegionPending}
            aria-label="识别区域"
            title={
              ocrRegionPending
                ? `区域识别中… ${ocrJob?.progress ?? 0}%（已用时 ${ocrRegionElapsed} 秒）`
                : '框选一块区域做 OCR 识别'
            }
            onClick={() => {
              setOcrRegionMode((value) => !value);
              setRegionMode(false);
              setMaskMode(false);
              setOcrRegionError(null);
            }}
          >
            {ocrRegionPending ? '识别中…' : <IconOcr />}
          </button>
          {ocrRegionPending ? (
            <button
              type="button"
              className="kr-icon-btn"
              onClick={() => void cancelOcrRegion()}
              disabled={ocrJob?.state === 'cancelling'}
              aria-label="取消区域识别"
              title={ocrJob?.state === 'cancelling' ? '正在取消…' : '取消区域识别'}
            >
              {ocrJob?.state === 'cancelling' ? '取消中…' : '取消'}
            </button>
          ) : null}
          {maskMode ? (
            <span className="kr-reader__mask-controls">
              <select
                className="kr-reader__mask-scope"
                value={maskScope}
                onChange={(event) => {
                  const scope = event.target.value as typeof maskScope;
                  setMaskScope(scope);
                  setMaskAllPages(scope === 'all' || scope === 'range');
                }}
                title="屏蔽范围"
              >
                <option value="page">仅当前页</option>
                <option value="all">全部页</option>
                <option value="odd">奇数页</option>
                <option value="even">偶数页</option>
                <option value="range">当前页到末页</option>
              </select>
              <button type="button" onClick={clearMasks}>
                清除
              </button>
            </span>
          ) : null}
        </div>
        {ocrRegionError ? (
          <p className="kr-reader__ocr-region-error" role="alert">
            {ocrRegionError}
            <button
              type="button"
              onClick={() => setOcrRegionError(null)}
              aria-label="关闭识别错误提示"
              title="关闭"
            >
              ×
            </button>
          </p>
        ) : null}
        <div className="kr-reader__nav">
          <details className="kr-export-menu" ref={exportMenuRef}>
            <summary className="kr-icon-btn" title="导出（Markdown 文件头含 AI 生成声明）" aria-label="导出"><IconExport /></summary>
            <div className="kr-export-menu__items">
              <button
                type="button"
                disabled={exportMutation.isPending}
                onClick={(event) => {
                  (event.currentTarget.closest('details') as HTMLDetailsElement | null)?.removeAttribute('open');
                  exportMutation.mutate();
                }}
              >
                {exportMutation.isPending ? '导出中…' : '导出批注（Markdown 含 AI 声明）'}
              </button>
              <button
                type="button"
                disabled={exportAnnotatedPdf.isPending}
                onClick={(event) => {
                  (event.currentTarget.closest('details') as HTMLDetailsElement | null)?.removeAttribute('open');
                  exportAnnotatedPdf.mutate();
                }}
              >
                {exportAnnotatedPdf.isPending ? '生成 PDF…' : '导出带批注 PDF'}
              </button>
            </div>
          </details>
          <button
            type="button"
            className="kr-reader__panel-toggle kr-icon-btn"
            aria-expanded={panelOpen}
            aria-label={panelOpen ? '收起阅读伙伴' : '展开阅读伙伴'}
            title={panelOpen ? '收起阅读伙伴' : '展开阅读伙伴'}
            onClick={togglePanel}
          >
            <IconCompanion />
          </button>
        </div>
      </header>

      {ocrRegionNotice ? (
        // 区域识别来源提示：框选区域识别不会调用 MinerU；回退到视觉模型时在这里说清来源，
        // 避免用户把视觉模型的结果当成 MinerU 的结果（「MinerU 是否出错」也就有了答案）。
        <p
          className="kr-outline2__hint"
          role="status"
          aria-live="polite"
          style={{ margin: 0, padding: '6px 14px' }}
        >
          {ocrRegionNotice}
        </p>
      ) : null}

      {structureOpen ? (
        <StructurePanel
          data={blocksQuery.data}
          loading={blocksQuery.isLoading}
          error={
            blocksQuery.error instanceof Error
              ? blocksQuery.error.message
              : blocksQuery.isError
                ? '读取结构失败'
                : null
          }
          currentPage={page}
          onOpenPage={(targetPage) => {
            setStructureOpen(false);
            scrollToPage(targetPage);
          }}
          onClose={() => setStructureOpen(false)}
        />
      ) : null}

      <div
        className={`kr-reader__body${readerNav ? ' has-reader-nav' : ''}${
          panelOpen ? '' : ' is-side-closed'
        }${translationOpen ? ' is-translation-open' : ''}`}
        style={{ ...sideStyle, ...translationStyle }}
      >
        {panel === 'chat' && panelOpen && chatComposerFocused ? (
          <div className="kr-current-page-anchor" aria-hidden="true">
            <span>当前页判断锚点 · 第 {page} 页</span>
          </div>
        ) : null}
        {readerNav ? (
          <aside className={`kr-reader-nav${readerNav === 'outline' ? ' is-outline' : ''}`}>
            <div className="kr-reader-nav__head">
              <div className="kr-reader-nav__tabs" role="tablist" aria-label="页面与目录">
                <button
                  type="button"
                  role="tab"
                  aria-selected={readerNav === 'pages'}
                  className={readerNav === 'pages' ? 'is-active' : ''}
                  onClick={() => setReaderNav('pages')}
                >
                  缩略图
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={readerNav === 'outline'}
                  className={readerNav === 'outline' ? 'is-active' : ''}
                  onClick={() => setReaderNav('outline')}
                >
                  目录
                </button>
              </div>
              <button
                type="button"
                className="kr-reader-nav__close"
                aria-label="关闭页面与目录"
                onClick={() => setReaderNav(null)}
              >
                ×
              </button>
            </div>
            <div className="kr-reader-nav__body">
              {readerNav === 'pages' ? (
                pdf ? (
                  <PageThumbnails
                    pdf={pdf}
                    pages={pdf.numPages}
                    current={page}
                    onOpen={(target) => scrollToPage(target)}
                  />
                ) : (
                  <p className="kr-muted">正在加载页面…</p>
                )
              ) : (
                <div className="kr-outline-panel">
                  {navigationBuilding ? (
                    <p className="kr-outline2__hint">
                      正在生成目录 {navigationStatusQuery.data?.done ?? 0} /{' '}
                      {navigationStatusQuery.data?.total ?? document.pages} 页…
                    </p>
                  ) : null}
                  {maskStatusQuery.data?.state === 'rebuilding' ? (
                    <p className="kr-outline2__hint">
                      正在重建遮罩索引 {maskStatusQuery.data.done ?? 0}/
                      {maskStatusQuery.data.total ?? 0} 页…
                    </p>
                  ) : null}
                  {maskStatusQuery.data?.state === 'failed' ? (
                    <p className="kr-page-error">
                      遮罩索引重建失败：{maskStatusQuery.data.error || '未知原因'}
                    </p>
                  ) : null}
                  <OutlinePanel
                    totalPages={document.pages}
                    currentPage={page}
                    embedded={outline.map((entry) => ({
                      title: entry.title,
                      page: entry.page
                    }))}
                    generated={generatedOutline.map((entry) => ({
                      title: entry.title,
                      page: entry.page
                    }))}
                    source={outlineSource}
                    onSourceChange={setOutlineSource}
                    status={navigationStatusQuery.data ?? null}
                    statusLoading={navigationStatusQuery.isLoading}
                    gateReason={navigationGateReason}
                    enabled={Boolean(navigationStatusQuery.data?.enabled)}
                    enabledDisabled={navigationGateDisabled}
                    enableError={
                      setNavigationEnabled.isError
                        ? setNavigationEnabled.error instanceof Error
                          ? setNavigationEnabled.error.message
                          : '更新目录启用状态失败'
                        : materializeOutline.isError
                          ? materializeOutline.error instanceof Error
                            ? materializeOutline.error.message
                            : '保存内置目录失败'
                          : saveOutline.isError && !outlineEditing
                            ? saveOutline.error instanceof Error
                              ? saveOutline.error.message
                              : '保存目录失败'
                            : ''
                    }
                    onToggleEnabled={(value) => void toggleNavigationEnabled(value)}
                    tocPagesInput={tocPagesInput}
                    onTocPagesInputChange={setTocPagesInput}
                    tocPagesValid={parseTocPagesInput(tocPagesInput, document.pages).length > 0}
                    preview={previewTocNavigation.data ?? null}
                    previewPending={previewTocNavigation.isPending}
                    previewError={
                      previewTocNavigation.isError
                        ? previewTocNavigation.error instanceof Error
                          ? previewTocNavigation.error.message
                          : '识别目录页失败'
                        : ''
                    }
                    onPreview={() =>
                      previewTocNavigation.mutate(
                        parseTocPagesInput(tocPagesInput, document.pages)
                      )
                    }
                    onGenerateFromToc={() =>
                      buildNavigation.mutateAsync({
                        tocPages:
                          previewTocNavigation.data?.toc_pages ??
                          parseTocPagesInput(tocPagesInput, document.pages)
                      })
                    }
                    onClearTocPages={() => buildNavigation.mutate({ tocPages: [] })}
                    onGenerateFromTitles={() => buildNavigation.mutateAsync({ tocPages: [] })}
                    generating={buildNavigation.isPending || navigationBuilding}
                    buildError={buildNavigation.isError ? buildNavigation.error.message : ''}
                    editing={outlineEditing}
                    draft={outlineDraft}
                    onDraftChange={setOutlineDraft}
                    onStartEdit={(seed) => {
                      setOutlineSource((current) =>
                        current === 'embedded' && outline.length > 0 ? current : 'local'
                      );
                      setOutlineDraft(seed);
                      setOutlineEditing(true);
                    }}
                    onStartManual={() => {
                      setOutlineSource('local');
                      setOutlineDraft([]);
                      setOutlineEditing(true);
                    }}
                    onSave={() =>
                      saveOutline.mutate(
                        outlineDraft
                          .filter((entry) => entry.label.trim())
                          .map((entry) => ({ ...entry, label: entry.label.trim() }))
                      )
                    }
                    onCancelEdit={() => setOutlineEditing(false)}
                    saving={saveOutline.isPending}
                    saveError={saveOutline.isError ? saveOutline.error.message : ''}
                    onOpenEntry={(entry) =>
                      openOutlineEntry({
                        title: entry.title,
                        page: entry.page ?? page,
                        items: []
                      })
                    }
                    truncated={
                      navigationPreviewQuery.data?.nodes_truncated
                        ? {
                            shown: navigationPreviewQuery.data.nodes.length,
                            total: navigationPreviewQuery.data.total_nodes
                          }
                        : null
                    }
                    footer={
                      visualNodesQuery.data && visualNodesQuery.data.length > 0 ? (
                        <details className="kr-visual-nodes">
                          <summary>图表与公式 · {visualNodesQuery.data.length} 条</summary>
                          <ul>
                            {visualNodesQuery.data.slice(0, 80).map((node, index) => (
                              <li key={`${node.page}-${index}`}>
                                <button type="button" onClick={() => scrollToPage(node.page)}>
                                  {node.kind === 'equation'
                                    ? '公式'
                                    : node.kind === 'table'
                                      ? '表格'
                                      : '图'}{' '}
                                  · 第 {node.page} 页
                                </button>
                                <span>{node.caption}</span>
                              </li>
                            ))}
                          </ul>
                        </details>
                      ) : null
                    }
                  />
                </div>
              )}
            </div>
          </aside>
        ) : null}
        <div
          className="kr-reader__scroll"
          ref={scrollRef}
          onScroll={handleScroll}
        >
          {pdfError ? <p className="kr-page-error">PDF 解析失败：{pdfError}</p> : null}
          {!pdf && !pdfError ? <p className="kr-page-status">正在渲染 PDF…</p> : null}
          {pdf ? (
            <div className="kr-pages">
              {/*
                缩放预览层：用 transform 缩放整页内容（画布位图 + 文本层 + 批注/高亮/区域框）。
                transform 不触发重排（CSS zoom 会让 266 页全部重新布局，滚轮缩放时明显粘滞），
                视觉上立刻跟手且互不错位；静止 160ms 后才把目标缩放写进真实页宽并重绘清晰画布。
              */}
              <div ref={pagesSpacerRef} className="kr-pages__spacer">
                <div
                  ref={pagesFrameRef}
                  className="kr-pages__frame"
                  style={{ width: `${Math.round(baseWidth)}px` }}
                >
              {Array.from({ length: pdf.numPages }, (_, index) => (
                <ReaderPage
                  key={index + 1}
                  pdf={pdf}
                  api={api}
                  documentId={document.id}
                  pageNumber={index + 1}
                  width={Math.round(baseWidth)}
                  renderQuality={renderQuality}
                  regionMode={regionMode}
                  maskMode={maskMode}
                  ocrRegionMode={ocrRegionMode}
                  onRecognizeRegion={(region) => void recognizeRegion(region)}
                  onAskRegion={(region) => void askRegion(region)}
                  totalPages={pdf.numPages}
                  references={referencesQuery.data ?? null}
                  onRequestReferences={() => setReferencesWanted(true)}
                  onLocateReferenceEntry={(entryId) => {
                    const entry = referencesQuery.data?.entries.find(
                      (item) => item.id === entryId
                    );
                    if (entry) locateReference(entry);
                  }}
                  masks={(masksQuery.data ?? [])
                    .filter((mask) => maskAppliesToPage(mask, index + 1))
                    .map((mask) => ({
                      id: mask.id,
                      page: mask.page,
                      scope: mask.scope,
                      x0: mask.x0,
                      y0: mask.y0,
                      x1: mask.x1,
                      y1: mask.y1
                    }))}
                  onAddMask={(input) =>
                    addMask.mutate({
                      ...input,
                      page: maskScope === 'page' ? input.page : 0,
                      scope: maskScope,
                      ...(maskScope === 'range'
                        ? { rangeStart: input.page, rangeEnd: pdf.numPages }
                        : {}),
                      ...(maskScope === 'exclude'
                        ? { excludePages: [input.page] }
                        : {})
                    })
                  }
                  onDeleteMask={(maskId) => deleteMask.mutate(maskId)}
                  onUpdateMask={(maskId, input) =>
                    updateMask.mutate({ maskId, ...input })
                  }
                  onQuickAction={(action, quote) => {
                    if (action === 'translate') {
                      setTranslationQuote(quote);
                      openTranslation();
                    } else if (action === 'ask' || action === 'float') {
                      setChatQuote(quote);
                      setPanel('chat');
                      openPanel();
                    }
                  }}
                  onUpdateAnnotation={(id, input) => updateAnnotation.mutate({ id, input })}
                  onDeleteAnnotation={(id) => deleteAnnotation.mutate(id)}
                  locatedBoxes={
                    located?.page === index + 1
                      ? located.boxes
                      : hoverLocated?.page === index + 1
                        ? hoverLocated.boxes
                        : undefined
                  }
                  onSelectText={(_pageNumber, quote) => {
                    if (translationOpen) setTranslationQuote(quote);
                  }}
                  annotations={(annotationsQuery.data ?? []).filter(
                    (annotation) => annotation.page === index + 1
                  )}
                  onCreate={(input) =>
                    createAnnotation.mutate({
                      ...input,
                      rects: JSON.stringify(input.rects)
                    })
                  }
                />
                ))}
                </div>
              </div>
            </div>
          ) : null}
        </div>

        {translationOpen ? (
          <div
            className="kr-side-splitter kr-reader__translation-splitter"
            role="separator"
            aria-orientation="vertical"
            aria-label="调整译文栏宽度"
            title="拖动调整译文栏宽度，双击恢复默认"
            onPointerDown={(event) => {
              event.preventDefault();
              setTranslationResize({ startX: event.clientX, startWidth: translationWidth });
            }}
            onDoubleClick={() => setTranslationWidth(460)}
          />
        ) : null}
        {panelOpen ? (
          <div
            className="kr-side-splitter"
            role="separator"
            aria-orientation="vertical"
            aria-label="调整阅读伙伴宽度"
            title="拖动调整阅读伙伴宽度，双击恢复默认"
            onPointerDown={(event) => {
              event.preventDefault();
              setSideResize({ startX: event.clientX, startWidth: sideWidth });
            }}
            onDoubleClick={() => setSideWidth(320)}
          />
        ) : null}
        {panelOpen || translationOpen ? (
          <button
            type="button"
            className="kr-side-backdrop"
            aria-label={translationOpen ? '关闭译文' : '关闭侧栏'}
            onClick={() => {
              if (translationOpen) setTranslationOpen(false);
              if (panelOpen) setPanelOpen(false);
            }}
          />
        ) : null}
        {translationOpen ? (
          <aside className="kr-reader__translation" aria-label="译文">
            <div className="kr-reader__translation-head">
              <strong>译文</strong>
              <span>
                第 {page} 页 · {document.name}
              </span>
              <button
                type="button"
                className="kr-reader__translation-close"
                aria-label="关闭译文"
                title="关闭译文"
                onClick={() => setTranslationOpen(false)}
              >
                ×
              </button>
            </div>
            <TranslationPanel
              config={translationConfigQuery.data ?? null}
              page={(translationPageQuery.data as TranslationPagePayload | undefined) ?? null}
              job={translationJobQuery.data ?? null}
              summary={translationSummaryQuery.data ?? null}
              highlightQuote={translationQuote}
              currentPage={page}
              translating={
                translateMutation.isPending || forceTranslateMutation.isPending
              }
              saving={saveTranslationConfig.isPending}
              recognizing={recognizeMutation.isPending}
              ocrText={ocrText}
              pageText={pageTextQuery.data?.text ?? null}
              pageTextOrigin={pageTextQuery.data?.origin}
              savingPageText={savePageText.isPending}
              onSavePageText={(text) => savePageText.mutate(text)}
              error={
                translateMutation.isError
                  ? translateMutation.error.message
                  : forceTranslateMutation.isError
                    ? forceTranslateMutation.error.message
                    : saveTranslationConfig.isError
                      ? saveTranslationConfig.error.message
                      : recognizeMutation.isError
                        ? recognizeMutation.error.message
                        : startTranslation.isError
                          ? startTranslation.error.message
                          : stopTranslation.isError
                            ? stopTranslation.error.message
                            : retranslateTranslationSegment.isError
                              ? retranslateTranslationSegment.error.message
                              : null
              }
              onSaveTargetLanguage={(language) =>
                saveTranslationConfig.mutate({ target_language: language })
              }
              onTranslate={(includeFurniture) => translateMutation.mutate(includeFurniture)}
              onForceTranslate={(includeFurniture) =>
                forceTranslateMutation.mutate(includeFurniture)
              }
              onRecognize={() => recognizeMutation.mutate()}
              onStartTranslation={(includeFurniture) =>
                startTranslation.mutate({ force: false, includeFurniture })
              }
              onForceStartTranslation={(includeFurniture) =>
                startTranslation.mutate({ force: true, includeFurniture })
              }
              onStopTranslation={() => stopTranslation.mutate()}
              onLocateSegment={(source) => void locateTranslationSource(source)}
              onHoverSegment={(source) => void hoverTranslationSource(source)}
              onEditSegment={(segmentId, text) =>
                editTranslationSegment.mutate({ segmentId, text })
              }
              onRestoreSegment={(segmentId) => restoreTranslationSegment.mutate(segmentId)}
              onRetranslateSegment={(index) =>
                retranslateTranslationSegment.mutate(index)
              }
              retranslatingIndex={
                retranslateTranslationSegment.isPending
                  ? retranslateTranslationSegment.variables ?? null
                  : null
              }
              quoteTranslation={
                translateQuoteMutation.isPending
                  ? { text: '', pending: true }
                  : translateQuoteMutation.isError
                    ? {
                        text: '',
                        error: translateQuoteMutation.error.message,
                        pending: false
                      }
                    : translateQuoteMutation.data
                      ? { text: translateQuoteMutation.data.text, pending: false }
                      : null
              }
              onTranslateQuote={(text) => translateQuoteMutation.mutate(text)}
              onAnchorTranslation={async (anchorPage, excerpt) => {
                // 只读锚点：译文选区映射回原文，交给面板定位；不写库、不建批注。
                const result = await api.anchorTranslationSelection(
                  document.id,
                  anchorPage,
                  { excerpt }
                );
                return {
                  quote: result.quote,
                  matched: result.matched,
                  exact: result.exact,
                  located: result.located,
                  message: result.message
                };
              }}
              documentId={document.id}
              loadPageImage={loadTranslationPageImage}
              onEnterLayoutView={() =>
                // 版式要放下整页：进版式时把译文栏加宽到至少 660px（仍可再拖动）。
                setTranslationWidth((value) => Math.max(value, 660))
              }
              onPageChange={(next) => setPage(next)}
              onOpenTranslationWindow={
                adapter.openTranslationWindow
                  ? () => {
                      void adapter.openTranslationWindow?.({
                        documentId: document.id,
                        page
                      });
                    }
                  : undefined
              }
              compact
            />
          </aside>
        ) : null}

        {panelOpen ? (
          <aside className={`kr-side${panelOpen ? ' is-open' : ''}`}>
          <button
            type="button"
            className="kr-side__close"
            aria-label="关闭侧栏"
            onClick={() => setPanelOpen(false)}
          >
            ×
          </button>
          <div className="kr-side__heading">
            <strong>阅读伙伴</strong>
            <span>第 {page} 页 · {document.name}</span>
          </div>
          <div className="kr-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={panel === 'annotations'}
              className={panel === 'annotations' ? 'is-active' : ''}
              onClick={() => setPanel('annotations')}
            >
              批注
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={panel === 'notes'}
              className={panel === 'notes' ? 'is-active' : ''}
              onClick={() => setPanel('notes')}
            >
              笔记
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={panel === 'chat'}
              className={panel === 'chat' ? 'is-active' : ''}
              onClick={() => setPanel('chat')}
            >
              对话
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={panel === 'references'}
              className={panel === 'references' ? 'is-active' : ''}
              onClick={() => setPanel('references')}
            >
              参考
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={panel === 'backlinks'}
              className={panel === 'backlinks' ? 'is-active' : ''}
              title="查看哪些笔记与批注引用了本文献"
              onClick={() => setPanel('backlinks')}
            >
              被引用
              {documentBacklinksQuery.data ? (
                <span
                  className={`kr-tab__count${
                    documentBacklinksQuery.data.length === 0 ? ' is-zero' : ''
                  }`}
                >
                  {documentBacklinksQuery.data.length}
                </span>
              ) : null}
            </button>
          </div>

          {panel === 'backlinks' ? (
            <Backlinks
              target={{ kind: 'document', documentId: document.id }}
              expanded
              loadBacklinks={(target) => api.listBacklinks(target)}
              onOpenBacklink={(backlink) => openBacklink(backlink)}
            />
          ) : null}

          {panel === 'annotations' ? (
            <>
              {annotationPurgeNotice ? (
                <p className="kr-settings__message" role="status">
                  {annotationPurgeNotice}
                </p>
              ) : null}
              <AnnotationPanel
                confirmAction={appDialogs.confirm}
                annotations={annotationScope === 'document' ? (annotationsQuery.data ?? []) : annotations}
                translations={annotationTranslationMap(annotationTranslationsQuery.data ?? [])}
                scope={annotationScope}
                onScopeChange={setAnnotationScope}
                creating={createAnnotation.isPending}
                updating={updateAnnotation.isPending}
                onCreate={(content) => createAnnotation.mutate({ page, content })}
                onUpdate={(id, input) => updateAnnotation.mutate({ id, input })}
                onAsk={askAboutAnnotation}
                onLocate={(annotation) => void locateAnnotation(annotation)}
                onDelete={(id) => deleteAnnotation.mutate(id)}
                onRestore={(id) => restoreAnnotation.mutate(id)}
                onPurge={(id) => purgeAnnotation.mutate(id)}
                trashAnnotations={trashAnnotationsQuery.data ?? []}
                trashLoading={trashAnnotationsQuery.isLoading || trashAnnotationsQuery.isFetching}
                onTrashChange={setAnnotationsTrashOpen}
                zoteroAvailable={zoteroAvailable}
                zoteroImporting={importZoteroAnnotations.isPending}
                zoteroNotice={zoteroNotice}
                zoteroError={zoteroError}
                onImportZotero={() => {
                  setZoteroError(null);
                  importZoteroAnnotations.mutate();
                }}
                onDismissZoteroNotice={() => setZoteroNotice(null)}
                documents={documents ?? []}
                loadAnnotations={loadAnnotationsForReference}
                loadNotes={loadNotesForReference}
                standaloneNotes={standaloneNotes ?? []}
                onOpenInternal={(target) => void openMarkdownInternal(target)}
                uploadImage={(input) => api.uploadNoteAsset(input)}
                onOpenAsset={async (url) => {
                  if (!adapter.openNoteAsset) {
                    throw new Error('当前运行环境不支持打开本地附件');
                  }
                  const result = await adapter.openNoteAsset(url);
                  if (!result.ok) throw new Error(result.message || '打开附件失败');
                }}
                loadBacklinks={(target) => api.listBacklinks(target)}
                onOpenBacklink={(backlink) => openBacklink(backlink)}
              />
            </>
          ) : panel === 'chat' ? (
            <>
              {voiceNotice ? (
                <p className="kr-settings__message" role="status">
                  {voiceNotice}
                  <button
                    type="button"
                    className="kr-link-button"
                    onClick={() => setVoiceNotice(null)}
                  >
                    知道了
                  </button>
                </p>
              ) : null}
              {chatActionError ? (
                <p className="kr-settings__message" role="alert">
                  {chatActionError}
                  <button
                    type="button"
                    className="kr-link-button"
                    onClick={() => setChatActionError(null)}
                  >
                    知道了
                  </button>
                </p>
              ) : null}
              {activeSessionSummary ? (
                // 会话早期摘要：只用于理解上下文，不是文献原文/证据，因此单独放在会话上方并明确标注。
                <details className="kr-chat__session-summary">
                  <summary>{activeSessionSummaryLabel}</summary>
                  <p
                    className="kr-chat__session-summary-text"
                    style={{ whiteSpace: 'pre-wrap' }}
                  >
                    {activeSessionSummary}
                  </p>
                  <p className="kr-chat__session-summary-note">
                    AI 生成（会话模型）· 可能出错；只是上下文，不是文献原文/证据。
                  </p>
                </details>
              ) : null}
              {viewingSearchResult ? (
                <p className="kr-chat__search-view-notice" role="status">
                  正在查看搜索结果对应的完整历史。
                  <button type="button" className="kr-link-button" onClick={showLatestMessages}>
                    回到最新
                  </button>
                </p>
              ) : null}
              {messageSearching || messageSearchError || messageSearchResult ? (
                <div
                  className="kr-chat__search-panel"
                  role="region"
                  aria-label="本会话搜索结果"
                >
                  <div className="kr-chat__search-panel-head">
                    <span>
                      {messageSearching
                        ? '正在搜索…'
                        : messageSearchError
                          ? messageSearchError
                          : `命中 ${messageSearchResult?.total ?? 0} 条`}
                    </span>
                    <button type="button" className="kr-link-button" onClick={closeMessageSearch}>
                      关闭
                    </button>
                  </div>
                  {messageSearchResult && messageSearchResult.matches.length > 0 ? (
                    <ul
                      className="kr-chat__search-panel-list"
                      style={{ maxHeight: 220, overflow: 'auto' }}
                    >
                      {messageSearchResult.matches.map((match) => (
                        <li key={match.id}>
                          <button
                            type="button"
                            className="kr-chat__search-hit"
                            onClick={() => void openMessageSearchResult(match)}
                          >
                            <span className="kr-chat__search-hit-role">
                              {match.role === 'user' ? '你' : '阅读伙伴'}
                            </span>
                            <span className="kr-chat__search-hit-snippet">{match.snippet}</span>
                            <span className="kr-chat__search-hit-time">
                              {match.created ? formatChatExportTime(new Date(match.created)) : ''}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {messageSearchResult && messageSearchResult.matches.length === 0 ? (
                    <p className="kr-chat__search-empty">没有匹配的消息。</p>
                  ) : null}
                  {messageSearchResult &&
                  messageSearchResult.total > messageSearchResult.matches.length ? (
                    <p className="kr-chat__search-more">
                      只显示前 {messageSearchResult.matches.length} 条，共{' '}
                      {messageSearchResult.total} 条
                    </p>
                  ) : null}
                </div>
              ) : null}
              <ChatPanel
              confirmAction={appDialogs.confirm}
              messages={chatMessages}
              // 历史分页：默认只显示最新一页；hasEarlier 时 ChatPanel 显示「加载更早的消息」。
              hasEarlier={hasEarlierMessages}
              loadingEarlier={loadingEarlierMessages}
              onLoadEarlier={() => void loadEarlierMessages()}
              draftAnswer={draftAnswer}
              stage={askStage}
              auditDraft={auditDraft}
              pendingTasks={(readingTasksQuery.data ?? []).filter(
                (task) => task.unreadPages.length > 0
              )}
              onResumeTask={(task) => {
                if (!activeSessionId) {
                  setChatActionError('阅读伙伴会话还在准备中，请稍后再试。');
                  return;
                }
                // 恢复阅读任务等于用原问题继续问：首条时同样用它填会话标题。
                const activeSession = chatSessionsRef.current.find(
                  (session) => session.id === activeSessionId
                );
                void touchChatSession(activeSessionId, {
                  title: activeSession?.title.trim() ? undefined : task.question.slice(0, 40)
                });
                setLastQuestion(task.question);
                setBudgetWarning(null);
                setDraftAnswer('');
      setAskStage('');
      setAuditDraft([]);
                askMutation.mutate({
                  question: task.question,
                  selection: '',
                  taskId: task.taskId,
                  // 笔记/批注默认纳入：恢复阅读任务与重发路径沿用最近一次口径。
                  includeMemory: lastAskExtras.includeMemory ?? true
                });
              }}
              availableDocuments={(documents ?? []).map((item) => ({
                id: item.id,
                name: item.name,
                tags: item.tags
              }))}
              // 阅读内默认把本机笔记/批注作为补充材料纳入（界面可取消勾选）。
              includeMemoryDefault
              currentPage={page}
              contextRounds={contextRounds}
              // 阅读伙伴有会话时服务端按会话完整历史拼上下文（超预算自动压缩更早轮次），
              // 所以不再选「最近 N 轮」；contextRounds/history 仍作为 fallback 传给服务端。
              contextStrategy="full"
              onContextRoundsChange={setContextRounds}
              // 紧凑工具栏：ChatPanel 不再永久显示字号行和「完整会话」长说明（说明放进「更多」菜单）。
              compactToolbar
              // 工具栏左侧：紧凑单行（会话下拉 + ＋新对话 + 搜索 + 更多菜单）；
              // 搜索输入只在点「搜索」后展开一行，窄侧栏不溢出。
              toolbarExtra={
                <div className="kr-chat__session-bar">
                  <div className="kr-chat__session-row">
                    {chatRenameDraft ? (
                      <>
                        <input
                          className="kr-chat__session-rename-input"
                          value={chatRenameDraft.value}
                          autoFocus
                          aria-label="会话名称"
                          placeholder="会话名称（留空显示为「对话 N」）"
                          title="Enter 保存，Esc 取消"
                          onFocus={(event) => event.currentTarget.select()}
                          onChange={(event) => {
                            const next = {
                              sessionId: chatRenameDraft.sessionId,
                              value: event.target.value
                            };
                            chatRenameDraftRef.current = next;
                            setChatRenameDraft(next);
                          }}
                          onKeyDown={(event) => {
                            // 输入法组词中的 Enter/Esc 交给输入法，避免中文标题被提前提交。
                            if (event.nativeEvent.isComposing) return;
                            if (event.key === 'Enter') {
                              event.preventDefault();
                              void commitChatSessionRename();
                            } else if (event.key === 'Escape') {
                              event.preventDefault();
                              cancelChatSessionRename();
                            }
                          }}
                          onBlur={() => {
                            // Enter/Esc 已经把草稿清空时，随后的 blur 不再提交一次。
                            if (chatRenameDraftRef.current) void commitChatSessionRename();
                          }}
                        />
                        <button
                          type="button"
                          className="kr-chat__session-rename-save"
                          // 阻止输入框失焦：点「保存」不会先触发 blur 提交一次。
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => void commitChatSessionRename()}
                          title="保存会话名称（Enter）"
                        >
                          保存
                        </button>
                        <button
                          type="button"
                          className="kr-chat__session-rename-cancel"
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={cancelChatSessionRename}
                          title="取消改名（Esc）"
                        >
                          取消
                        </button>
                      </>
                    ) : (
                      <select
                        className="kr-chat__session-select"
                        value={activeSessionId}
                        onChange={(event) => void switchChatSession(event.target.value)}
                        disabled={
                          !sessionsReady || askMutation.isPending || chatSessions.length === 0
                        }
                        aria-label="阅读伙伴会话"
                        title="切换阅读伙伴会话：每个会话独立保存历史"
                      >
                        {!sessionsReady ? <option value="">加载会话…</option> : null}
                        {chatSessions.map((session, index) => (
                          <option key={session.id} value={session.id}>
                            {documentChatSessionLabel(session, index)}
                          </option>
                        ))}
                      </select>
                    )}
                    <button
                      type="button"
                      className="kr-chat__session-new"
                      onClick={() => void createChatSession()}
                      disabled={!sessionsReady || askMutation.isPending}
                      aria-label="新对话"
                      title="新建一个空的阅读伙伴会话"
                    >
                      ＋
                    </button>
                    <button
                      type="button"
                      className={`kr-chat__session-search-toggle${
                        searchBarOpen ? ' is-active' : ''
                      }`}
                      onClick={() => setSearchBarOpen((open) => !open)}
                      disabled={!sessionsReady || !activeSessionId}
                      aria-label="搜索本会话"
                      aria-expanded={searchBarOpen}
                      title={searchBarOpen ? '收起搜索' : '搜索本会话消息'}
                    >
                      搜索
                    </button>
                    <details
                      className="kr-chat__session-more"
                      ref={moreMenuRef}
                      onKeyDown={(event) => {
                        if (event.key !== 'Escape') return;
                        event.stopPropagation();
                        closeMoreMenu();
                      }}
                    >
                      <summary
                        className="kr-chat__session-more-summary"
                        aria-label="更多会话操作"
                        title="更多会话操作（改名 / 删除）"
                      >
                        更多
                      </summary>
                      <div className="kr-chat__session-more-menu" role="menu">
                        <button
                          type="button"
                          role="menuitem"
                          className="kr-chat__session-rename"
                          onClick={() => {
                            closeMoreMenu();
                            beginChatSessionRename();
                          }}
                          disabled={!sessionsReady || askMutation.isPending || !activeSessionId}
                          title="重命名当前会话（Enter 保存 / Esc 取消）"
                        >
                          改名
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          className="kr-chat__session-delete"
                          onClick={() => {
                            closeMoreMenu();
                            void deleteActiveChatSession();
                          }}
                          disabled={!sessionsReady || askMutation.isPending || !activeSessionId}
                          title="删除当前会话及其全部内容（不可恢复）"
                        >
                          删除会话
                        </button>
                        <p className="kr-chat__session-more-note">
                          完整会话 · 超预算自动压缩；早期轮次摘要由会话模型生成，不是文献原文/证据。
                        </p>
                      </div>
                    </details>
                  </div>
                  {searchBarOpen ? (
                    <div className="kr-chat__session-search-row">
                      <input
                        type="search"
                        className="kr-chat__message-search"
                        value={messageSearchQuery}
                        onChange={(event) => setMessageSearchQuery(event.target.value)}
                        onKeyDown={(event) => {
                          // 输入法组词时的回车不触发搜索。
                          if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
                          event.preventDefault();
                          void runMessageSearch();
                        }}
                        placeholder="搜索本会话（回车）"
                        aria-label="搜索本会话消息"
                        disabled={!sessionsReady || !activeSessionId}
                        autoFocus
                      />
                      <button
                        type="button"
                        className="kr-chat__message-search-clear"
                        onClick={closeMessageSearch}
                        disabled={
                          !messageSearchQuery && !messageSearchResult && !viewingSearchResult
                        }
                        title="清除搜索并回到最新一页"
                      >
                        清除
                      </button>
                    </div>
                  ) : null}
                </div>
              }
              // 本轮回答耗时：只在最后一条 assistant 上显示；新提问/重新生成开始时已清空。
              lastAnswerDurationMs={lastAnswerDurationMs ?? undefined}
              asking={askMutation.isPending}
              progress={askProgress}
              answer={chatData?.answer ?? null}
              sources={chatData?.sources ?? []}
              notice={chatPersistNotice || chatData?.notice}
              coverageLedger={chatData?.coverage_ledger}
              unreadPages={chatData?.unread_pages}
              taskId={chatData?.taskId}
              citationSupport={chatData?.citation_support}
              invalidCitations={chatData?.invalid_citations}
              audit={chatData?.audit}
              falsify={chatData?.falsify}
              error={budgetWarning ? null : askMutation.isError ? askMutation.error.message : null}
              budget={budgetWarning}
              onConfirmBudget={() => {
                if (!activeSessionId) {
                  setChatActionError('阅读伙伴会话还在准备中，请稍后再试。');
                  return;
                }
                setBudgetWarning(null);
                askMutation.mutate({
                  question: lastQuestion,
                  selection: chatQuote,
                  confirmBudget: true,
                  ...lastAskExtras
                });
              }}
              onCancelBudget={() => setBudgetWarning(null)}
              budgetSkipActive={budgetSkipActive}
              onBudgetSkipChange={setBudgetSkipForDocument}
              chapters={
                chaptersQuery.data?.available ? chaptersQuery.data.chapters : undefined
              }
              onNextChapter={(chapterIndex) => {
                if (!activeSessionId) {
                  setChatActionError('阅读伙伴会话还在准备中，请稍后再试。');
                  return;
                }
                askMutation.mutate({
                  question: lastQuestion,
                  selection: chatQuote,
                  readingChapterIndex: chapterIndex,
                  ...lastAskExtras
                });
              }}
              draftQuestion={chatDraft}
              selectionQuote={chatQuote}
              onClearQuote={() => setChatQuote('')}
              onAsk={(question, options) => {
                if (!activeSessionId) {
                  setChatActionError('阅读伙伴会话还在准备中，请稍后再试。');
                  return;
                }
                const normalizedQuestion = question.replace(
                  /当前页|这一页/g,
                  `第 ${page} 页`
                );
                // ChatPanel 新增的字段可能先于 ui 包类型声明落地：按可选字段读取，缺了就忽略。
                const extraOptions = options as
                  | (typeof options & {
                      scopeTags?: string[];
                      webQuery?: string;
                      confirmGapSearch?: boolean;
                    })
                  | undefined;
                setLastQuestion(normalizedQuestion);
                setChatActionError(null);
                // 新提问开始时清掉上一条回答的耗时，避免旧耗时显示在本轮上。
                setLastAnswerDurationMs(null);
                setBudgetWarning(null);
                setDraftAnswer('');
      setAskStage('');
      setAuditDraft([]);
                setChatMessages((current) => [
                  ...current,
                  {
                    id: crypto.randomUUID(),
                    role: 'user',
                    content: normalizedQuestion,
                    quote: chatQuote || undefined,
                    quotePage: page,
                    quoteName: document.name
                  }
                ]);
                // 用户消息也走串行队列：先于本轮助手回答落库，失败只警告、不清本地历史。
                void persistMessage('user', normalizedQuestion, undefined, {
                  quote: chatQuote || undefined,
                  quotePage: page,
                  quoteName: document.name
                }).catch(reportPersistFailure);
                setLastAskExtras({
                  scopeTags: extraOptions?.scopeTags,
                  webQuery: extraOptions?.webQuery,
                  includeMemory: options?.includeMemory
                });
                askMutation.mutate({
                  question: normalizedQuestion,
                  selection: chatQuote,
                  confirmBudget: budgetSkipActive,
                  confirmSearch: options?.confirmSearch,
                  searchToken: options?.search_token,
                  readingScope: options?.readingScope,
                  readingRigor: options?.readingRigor,
                  readingChapterIndex: options?.readingChapterIndex,
                  sourcePolicy: options?.sourcePolicy,
                  scopeDocuments: options?.scopeDocuments,
                  scopeTags: extraOptions?.scopeTags,
                  webQuery: extraOptions?.webQuery,
                  confirmGapSearch: extraOptions?.confirmGapSearch,
                  includeMemory: options?.includeMemory,
                  history: recentReadingHistory(chatMessages, contextRounds)
                });
                // 记住审批凭证与指纹相关输入：继续阅读重发同一请求时可以幂等复用，
                // 不必让用户再确认一次"已过期的计划"。
                setLastSearchToken(options?.search_token);
                setLastSearchSelection(chatQuote);
                setChatQuote('');
                // 首条用户问题拿来当会话标题；同时推进 updated（异步保存，失败不阻断回答）。
                const activeSession = chatSessionsRef.current.find(
                  (session) => session.id === activeSessionId
                );
                void touchChatSession(activeSessionId, {
                  title: activeSession?.title.trim()
                    ? undefined
                    : normalizedQuestion.slice(0, 40)
                });
              }}
              onContinue={() => {
                if (!chatData?.taskId) return;
                if (!activeSessionId) {
                  setChatActionError('阅读伙伴会话还在准备中，请稍后再试。');
                  return;
                }
                askMutation.mutate({
                  question: lastQuestion,
                  selection: lastSearchSelection,
                  taskId: chatData.taskId,
                  confirmBudget: budgetSkipActive,
                  confirmSearch: lastSearchToken ? true : undefined,
                  searchToken: lastSearchToken,
                  // 重发同一请求：沿用最近一次的笔记/批注口径（默认纳入）。
                  includeMemory: lastAskExtras.includeMemory ?? true
                });
              }}
              // 重新生成：仅当最后一条是助手回答、有可重发的文字问题、且当前没有提问在飞时给入口。
              onRegenerate={canRegenerate ? () => void regenerateAnswer() : undefined}
              // 回答存为笔记：正文 + 依据；ChatPanel 负责 saving/saved/error 按钮状态。
              onSaveAsNote={saveAnswerAsNote}
              // 编辑 user 消息并用新内容重问；删除从该 user 消息起的分支。
              onEditUserMessage={editUserMessageAndReask}
              onDeleteFromMessage={deleteMessagesFrom}
              onCancel={() => askAbortRef.current?.abort()}
              onOpenSource={(source) => void openSource(source)}
              onSpeak={
                chatData?.answer
                  ? () => {
                      if (chatData.answer) speakMutation.mutate(chatData.answer);
                    }
                  : undefined
              }
              onSpeakText={(text) => speakMutation.mutate(text)}
              speaking={speakMutation.isPending}
              onTranscribe={async (audio) => {
                // 语音转写在进入输入框之前先做"只校正转写"的纠错：
                // 失败/坏 JSON 保留原文并给出 needs_review 提示，不阻塞用户继续改字。
                setVoiceNotice(null);
                // 系统语音识别（Windows）只接受 WAV；MediaRecorder 一般录 webm/opus，
                // 这里在渲染进程解码重采样成 16k 单声道 WAV 再上传，其余模式直接发 webm。
                let payload = audio;
                if (speechConfigQuery.data?.asr_mode === 'system') {
                  try {
                    payload = await blobToWav(audio);
                  } catch (error) {
                    throw new Error(
                      `无法把录音转成系统识别需要的 WAV 格式：${
                        error instanceof Error ? error.message : '未知错误'
                      }；也可以改用模型语音识别`
                    );
                  }
                }
                const isWav = payload.type.includes('wav');
                const transcribed = await api.transcribeAudio(
                  payload,
                  isWav ? 'speech.wav' : 'speech.webm'
                );
                // 直接语音（全模态）里的转写只用于在会话中显示「说了什么」，
                // 不再额外调用「按当前页术语校正」——那会多一次模型往返，让语音提问变慢。
                if (speechConfigQuery.data?.direct_audio) return transcribed.text;
                if (!speechConfigQuery.data?.correction) return transcribed.text;
                try {
                  const corrected = await api.correctSpeech({
                    documentId: document.id,
                    page,
                    text: transcribed.text
                  });
                  if (corrected.needs_review) {
                    setVoiceNotice(
                      corrected.reason ?? '语音已识别，请检查校正后的文本再发送。'
                    );
                  } else if (corrected.corrected) {
                    setVoiceNotice('已按当前页术语校正语音转写，请确认后再发送。');
                  }
                  return corrected.text;
                } catch (error) {
                  setVoiceNotice(
                    `语音纠错未完成：${
                      error instanceof Error ? error.message : '未知错误'
                    }；原始文字已保留，可直接修改后发送。`
                  );
                  return transcribed.text;
                }
              }}
              // 语音输入：转写/纠错结果只填输入框，不自动发送（由用户在输入框核对后手动发送）。
              speechTriggerMode={speechConfigQuery.data?.trigger_mode ?? 'hold'}
              speechDisabledReason={speechInputDisabledReason}
              sendShortcut={shortcut('send', 'Enter')}
              newlineShortcut={shortcut('newline', 'Shift+Enter')}
              searchPermission={searchConfigQuery.data?.permission ?? 'off'}
              onCreateSearchPlan={({ question, selection }) =>
                api.createSearchPlan({
                  // 与 onAsk 一样先把「当前页」归一成具体页码：计划指纹必须与实际发送的问题一致。
                  question: question.replace(/当前页|这一页/g, `第 ${page} 页`),
                  documentId: document.id,
                  selection
                })
              }
              searchWarning={chatData?.search_warning}
              onComposerFocusChange={setChatComposerFocused}
              directAudio={speechConfigQuery.data?.direct_audio}
              speechAutoSend={speechConfigQuery.data?.auto_send ?? false}
              onAskAudio={async (audio) => {
                if (!activeSessionId) {
                  setChatActionError('阅读伙伴会话还在准备中，请稍后再试。');
                  return;
                }
                // 直接语音（全模态）：先把录音转成 16k 单声道 WAV——webm/opus 多数全模态
                // 接口不支持，之前把 webm 直接发出去会 400；转换失败就退回原始录音，不阻断。
                // 语音转写由全模态模型完成（不再在客户端先跑 ASR）。
                let payload = audio;
                try {
                  payload = await blobToWav(audio);
                } catch {
                  payload = audio;
                }
                const dataUrl = await new Promise<string>((resolve, reject) => {
                  const reader = new FileReader();
                  reader.onload = () => resolve(String(reader.result));
                  reader.onerror = () => reject(reader.error);
                  reader.readAsDataURL(payload);
                });
                const comma = dataUrl.indexOf(',');
                const data = comma >= 0 ? dataUrl.slice(comma + 1) : '';
                if (!data) return;
                setLastQuestion('（语音直接输入）');
                setBudgetWarning(null);
                setDraftAnswer('');
                setAskStage('');
                setAuditDraft([]);
                const localMessageId = crypto.randomUUID();
                setChatMessages((current) => [
                  ...current,
                  {
                    id: localMessageId,
                    role: 'user',
                    // 先显示占位；回答返回后按 response.audio_transcript 更新为「（语音）转写」。
                    content: '（语音提问）',
                    quote: chatQuote || undefined,
                    quotePage: page,
                    quoteName: document.name
                  }
                ]);
                // 用户消息不在提问前落库：等回答返回后按最终正文落一次（避免先落库再用
                // 会删后续消息的 PATCH 改正文）。onSuccess/onError 会消费这条待写记录。
                pendingVoiceTurnRef.current = {
                  messageId: localMessageId,
                  sessionId: activeSessionId,
                  quote: chatQuote || undefined,
                  quotePage: page,
                  quoteName: document.name
                };
                // 音频只放进 ref，由 mutationFn 取一次并清空（不随 mutation 变量驻留）；
                // 录音本身不落库，会话里只保存转写文字。
                voiceAudioRef.current = {
                  data,
                  mimeType: payload.type || 'audio/webm',
                  filename: payload.type.includes('wav') ? 'speech.wav' : 'speech.webm'
                };
                askMutation.mutate({
                  // 不传文字问题：转写由全模态模型完成。
                  question: '',
                  selection: chatQuote,
                  confirmSearch: false,
                  // 语音直接提问没有 options：沿用最近一次口径（默认纳入笔记/批注）。
                  includeMemory: lastAskExtras.includeMemory ?? true,
                  voice: true
                });
                setChatQuote('');
                // 语音提问：首条时先记占位标题，回答返回后若标题仍为空再用转写补上。
                const activeSession = chatSessionsRef.current.find(
                  (session) => session.id === activeSessionId
                );
                void touchChatSession(activeSessionId, {
                  title: activeSession?.title.trim() ? undefined : '（语音提问）'
                });
              }}
              />
            </>

          ) : panel === 'references' ? (
            <ReferencePanel
              confirmAction={appDialogs.confirm}
              currentPage={page}
              references={referencesQuery.data ?? null}
              loading={referencesQuery.isLoading || referencesQuery.isFetching}
              error={referencesQuery.isError ? referencesQuery.error.message : ''}
              saving={
                updateReference.isPending ||
                addReference.isPending ||
                deleteReference.isPending ||
                resetReferences.isPending
              }
              onLocateEntry={(entry) => locateReference(entry)}
              onLocateCitation={(citation) => locateReference(citation)}
              onEditEntry={(entryId, patch) => updateReference.mutate({ entryId, patch })}
              onDeleteEntry={(entryId) => deleteReference.mutate(entryId)}
              onAddEntry={(input) => addReference.mutate(input)}
              onResetEdits={() => resetReferences.mutate()}
            />
          ) : panel === 'notes' ? (
            <>
              {notePurgeNotice ? (
                <p className="kr-settings__message" role="status">
                  {notePurgeNotice}
                </p>
              ) : null}
              <NotesPanel
                confirmAction={appDialogs.confirm}
                notes={notesQuery.data ?? []}
                currentPage={page}
                creating={createNote.isPending}
                updating={updateNote.isPending}
                documents={documents ?? []}
                loadAnnotations={loadAnnotationsForReference}
                loadNotes={loadNotesForReference}
                standaloneNotes={standaloneNotes ?? []}
                onOpenInternal={(target) => void openMarkdownInternal(target)}
                uploadImage={(input) => api.uploadNoteAsset(input)}
                onOpenAsset={async (url) => {
                  if (!adapter.openNoteAsset) {
                    throw new Error('当前运行环境不支持打开本地附件');
                  }
                  const result = await adapter.openNoteAsset(url);
                  if (!result.ok) throw new Error(result.message || '打开附件失败');
                }}
                loadBacklinks={(target) => api.listBacklinks(target)}
                onOpenBacklink={(backlink) => openBacklink(backlink)}
                onCreate={(targetPage, content) =>
                  createNote.mutate({ page: targetPage, content })
                }
                onUpdate={(id, input) => updateNote.mutate({ id, input })}
                onDelete={(id) => deleteNote.mutate(id)}
                onRestore={(id) => restoreNote.mutate(id)}
                onPurge={(id) => purgeNote.mutate(id)}
                trashNotes={trashNotesQuery.data ?? []}
                trashLoading={trashNotesQuery.isLoading || trashNotesQuery.isFetching}
                onTrashChange={setNotesTrashOpen}
              />
            </>
          ) : null}
          </aside>
        ) : null}
      </div>
      {ocrRegionResult ? (
        <div
          className="kr-modal-backdrop"
          role="presentation"
          onClick={() => setOcrRegionResult(null)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation();
              setOcrRegionResult(null);
            }
          }}
        >
          <div
            className="kr-modal kr-modal--ocr-region"
            role="dialog"
            aria-modal="true"
            aria-label="区域识别结果"
            onClick={(event) => event.stopPropagation()}
          >
            <h2>区域识别结果</h2>
            <p className="kr-muted" role="note">
              机器识别 · 可能由 AI 或本机 OCR 生成，可能出错，请核对原图。
            </p>
            <p className="kr-muted">
              第 {ocrRegionResult.page} 页 · 识别方式：{ocrRegionResult.engine || '未知'}
            </p>
            {ocrRegionResult.engine_note ? (
              <p className="kr-settings__message" role="note">
                {ocrRegionResult.fallback_from
                  ? `来源说明（本次区域识别没有使用 ${ocrRegionResult.fallback_from}）：`
                  : '来源说明：'}
                {ocrRegionResult.engine_note}
              </p>
            ) : null}
            <p className="kr-muted">
              这里只展示框选区域识别出的文字，不会自动写回页面文字；引用前请回原页核对。
            </p>
            <label className="kr-modal__field">
              整理后的文本（可编辑）
              <textarea
                className="kr-ocr-region__text"
                data-ai-copy="ocr"
                value={ocrRegionResult.textReflowed}
                rows={8}
                onChange={(event) =>
                  setOcrRegionResult((current) =>
                    current ? { ...current, textReflowed: event.target.value } : current
                  )
                }
              />
            </label>
            {ocrRegionResult.text &&
            ocrRegionResult.text !== ocrRegionResult.textReflowed ? (
              <details className="kr-ocr-region__raw">
                <summary>逐行原文</summary>
                <pre data-ai-copy="ocr">{ocrRegionResult.text}</pre>
              </details>
            ) : null}
            {ocrRegionCopyMessage ? (
              <p className="kr-settings__message" role="status">
                {ocrRegionCopyMessage}
              </p>
            ) : null}
            <div className="kr-modal__actions">
              <button
                type="button"
                className="kr-ghost"
                onClick={() => setOcrRegionResult(null)}
              >
                关闭
              </button>
              <button
                type="button"
                className="kr-primary"
                title="复制整理后文本（自动附带机器识别标识）"
                onClick={() => void copyReflowedRegionText()}
              >
                复制整理后文本
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function StudiandaApp({
  adapter,
  pdfWorkerUrl,
  dialogs
}: {
  adapter: AppRuntimeAdapter;
  /** pdf.js worker 资源 URL；桌面壳传 Vite `?url`，其它宿主传自己的资源地址。 */
  pdfWorkerUrl?: string;
  /** 可选：宿主覆盖确认/提示/输入对话框实现（默认浏览器原生）。 */
  dialogs?: Partial<AppDialogs>;
}): JSX.Element {
  // 全局弹窗焦点陷阱（设置页有自己的更严格实现，这里跳过）。
  useDialogFocusTrap();
  // Ctrl+C / 右键复制 AI 内容时也补 AI 标识（专用复制按钮仍走各自逻辑）。
  useAiCopyGuard();
  if (pdfWorkerUrl) configurePdfWorker(pdfWorkerUrl);
  useEffect(() => {
    setAppDialogs(dialogs ?? null);
    return () => setAppDialogs(null);
  }, [dialogs]);
  return (
    <div className="kr-root">
      <QueryClientProvider client={queryClient}>
        <RuntimeGate adapter={adapter} />
      </QueryClientProvider>
    </div>
  );
}



