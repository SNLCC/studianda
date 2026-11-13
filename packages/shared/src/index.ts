export const APP_NAME = 'studianda' as const;
export const API_PREFIX = '/api/v1' as const;
export const API_VERSION = 1 as const;

/**
 * HTTP 错误码（`{ error, message, details? }` 中的 `error`）。
 * 服务端与客户端共用，避免各处自造字符串；`message` 始终保留人类可读的中文说明。
 */
export const API_ERROR_CODES = {
  badRequest: 'bad_request',
  unauthorized: 'unauthorized',
  forbidden: 'forbidden',
  notFound: 'not_found',
  conflict: 'conflict',
  duplicateRequired: 'duplicate_required',
  confirmationRequired: 'confirmation_required',
  attachmentChanged: 'attachment_changed',
  scanUnavailable: 'scan_unavailable',
  resultMissing: 'result_missing',
  exportFailed: 'export_failed',
  backupFailed: 'backup_failed',
  diagnosticsFailed: 'diagnostics_failed',
  badGateway: 'bad_gateway',
  tooManyRequests: 'too_many_requests',
  busy: 'busy',
  cancelled: 'cancelled',
  internal: 'internal'
} as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[keyof typeof API_ERROR_CODES];
/**
 * 本地 Core 与所有客户端共用的鉴权头名。
 *
 * 放在 shared 里是为了只有一个事实源：server 的 CORS/鉴权、api-client、桌面主进程
 * （Core 健康检查与密钥推送）都从常量取值，避免改一处漏一处。
 */
export const TOKEN_HEADER = 'x-studianda-token' as const;
/** Core 启动握手文件名（写在数据目录下，内容为 RuntimeInfo）。 */
export const RUNTIME_FILE_NAME = 'runtime.json' as const;

/**
 * 密钥名称白名单：Core 的 SecretStore 与桌面主进程的 safeStorage 持久化共用。
 *
 * 两处各自维护会出现“一处接受、另一处静默丢弃”的漂移：设置里填了密钥，重启后又要重填。
 * 新增密钥只改这里，并同步 `packages/core/src/secrets.ts` 的使用方与测试。
 */
const FIXED_SECRET_NAMES = new Set([
  'parsing.service_key',
  'zotero.api_key',
  'zotero.webdav_password',
  'speech.asr_key',
  'speech.tts_key',
  'search.api_key'
]);

export function isAllowedSecretName(name: string): boolean {
  return (
    FIXED_SECRET_NAMES.has(name) ||
    /^platform\.[A-Za-z0-9_-]+\.api_key$/.test(name) ||
    /^speech\.[A-Za-z0-9_-]+\.key$/.test(name)
  );
}

export interface HealthResponse {
  application: typeof APP_NAME;
  version: string;
  api_version: number;
  closing: boolean;
}

export interface RuntimeInfo {
  port: number;
  token: string;
  pid: number;
  version: string;
  startedAt: string;
}

export interface ApiErrorBody {
  error: string;
  message?: string;
  details?: unknown;
}

export interface FileState {
  state: 'ok' | 'missing' | 'changed' | 'unknown';
  detail: string;
  storageKind: string;
}

/** 文献体裁：Zotero itemType 原文（小写驼峰，如 book / journalArticle）；空串 = 未分类。 */
export type DocumentType = string;

/** 文献库分栏用的粗分类：著作 / 论文 / 其他 / 未分类。 */
export type DocumentCategory = 'book' | 'paper' | 'other' | 'unknown';

/** 文件夹里的各分类数量（全部+四个分栏）。 */
export interface DocumentCategoryCounts {
  total: number;
  book: number;
  paper: number;
  other: number;
  unknown: number;
}

/** 单层文件夹；`id === ''` 表示「未分类」这个虚拟集合。 */
export interface FolderSummary {
  id: string;
  name: string;
  created: string;
  counts: DocumentCategoryCounts;
}

/** 侧栏文件树：真实文件夹 + 未分类集合。 */
export interface FolderOverview {
  folders: FolderSummary[];
  unfiled: FolderSummary;
}

/**
 * Zotero itemType → 中文类型名。
 *
 * 覆盖 Zotero 常见条目类型；未知类型由界面回退显示原始 itemType，
 * 不因为没登记而丢掉它。
 */
export const DOCUMENT_TYPE_LABELS: Record<string, string> = {
  book: '图书',
  bookSection: '图书章节',
  encyclopediaArticle: '百科条目',
  dictionaryEntry: '词典条目',
  journalArticle: '期刊论文',
  magazineArticle: '杂志文章',
  newspaperArticle: '报纸文章',
  conferencePaper: '会议论文',
  thesis: '学位论文',
  report: '报告',
  preprint: '预印本',
  manuscript: '手稿',
  webpage: '网页',
  blogPost: '博客文章',
  forumPost: '论坛帖子',
  document: '文档',
  letter: '信件',
  interview: '访谈',
  presentation: '演示文稿',
  dataset: '数据集',
  patent: '专利',
  standard: '标准',
  artwork: '图像资料',
  film: '影片',
  audioRecording: '音频',
  videoRecording: '视频',
  computerProgram: '软件',
  attachment: '附件',
  note: '笔记',
  annotation: '批注',
  other: '其他'
};

/** 类型选项（顺序按 著作 → 论文 → 其他整理），界面下拉直接用。 */
export interface DocumentTypeOption {
  value: DocumentType;
  label: string;
  category: DocumentCategory;
}

const TYPE_CATEGORY: Record<string, DocumentCategory> = {
  book: 'book',
  bookSection: 'book',
  encyclopediaArticle: 'book',
  dictionaryEntry: 'book',
  journalArticle: 'paper',
  magazineArticle: 'paper',
  newspaperArticle: 'paper',
  conferencePaper: 'paper',
  thesis: 'paper',
  report: 'paper',
  preprint: 'paper',
  manuscript: 'paper'
};

const TYPE_ORDER: DocumentType[] = [
  'book',
  'bookSection',
  'encyclopediaArticle',
  'dictionaryEntry',
  'journalArticle',
  'conferencePaper',
  'thesis',
  'preprint',
  'report',
  'magazineArticle',
  'newspaperArticle',
  'manuscript',
  'webpage',
  'blogPost',
  'forumPost',
  'document',
  'letter',
  'interview',
  'presentation',
  'dataset',
  'patent',
  'standard',
  'artwork',
  'film',
  'audioRecording',
  'videoRecording',
  'computerProgram',
  'attachment',
  'note',
  'annotation',
  'other'
];

export const DOCUMENT_TYPE_OPTIONS: DocumentTypeOption[] = TYPE_ORDER.map((value) => ({
  value,
  label: DOCUMENT_TYPE_LABELS[value] ?? value,
  category: TYPE_CATEGORY[value] ?? 'other'
}));

/** 由 Zotero itemType（或用户手选值）得到分栏分类；空串为未分类。 */
export function documentCategoryOf(type: string | null | undefined): DocumentCategory {
  const value = (type ?? '').trim();
  if (!value) return 'unknown';
  return TYPE_CATEGORY[value] ?? 'other';
}

/** 类型中文名；未登记的类型回退显示原值（不丢信息）。 */
export function documentTypeLabel(type: string | null | undefined): string {
  const value = (type ?? '').trim();
  if (!value) return '未分类';
  return DOCUMENT_TYPE_LABELS[value] ?? value;
}

export const DOCUMENT_CATEGORY_LABELS: Record<DocumentCategory, string> = {
  book: '著作',
  paper: '论文',
  other: '其他',
  unknown: '未分类'
};

export interface DocumentSummary {
  id: string;
  name: string;
  pages: number;
  currentPage: number;
  created: string;
  author: string;
  /** 期刊、会议或出版社；无法识别时为空。 */
  publication: string;
  sizeBytes: number;
  tags: string[];
  deleted: boolean;
  fileState: FileState;
  /** 附件（应用内副本或 Zotero 外部路径）当前是否缺失；列表可直接显示提示。 */
  missing_file?: boolean;
  /** 文献体裁（Zotero itemType 原文）；空串 = 未分类。服务端 DTO 总会带上。 */
  docType?: DocumentType;
  /** 分栏粗分类（服务端按 docType 算好）；空 = 未分类。 */
  docCategory?: DocumentCategory;
  /** 所属文件夹 id；空串 = 未分类。 */
  folderId?: string;
  /** 「默认排序」的手动位置（越小越靠前）；其它排序方式不改变它。 */
  manualOrder?: number;
}

export interface DocumentDetail extends DocumentSummary {
  sha256: string;
}

/** 重新连接（relink）结果：页数可能变化，批注页码可能越界，必须如实告知用户。 */
export interface RelinkResult extends DocumentDetail {
  page_count_before: number;
  page_count_after: number;
  annotations_out_of_range: number;
  warning: string | null;
}

export interface AnnotationRecord {
  id: string;
  documentId: string;
  page: number;
  quote: string;
  content: string;
  rects: string;
  color: string;
  style: string;
  created: string;
  /** 批注摘引对应的译文（只读派生，不落库）；没有译文时为空数组。 */
  translation?: AnnotationTranslationItem[];
  translation_engine?: string;
}

export interface AnnotationTranslationItem {
  segment: number;
  source: string;
  text: string;
  /** 只译了摘引所在的一小句时，这里是该段完整译文。 */
  full_text: string;
  narrowed: boolean;
  excerpt: string;
  edited: boolean;
  engine: string;
}

export interface TranslationPageState {
  page: number;
  status: string;
  done: number;
  total: number;
  error: string;
  updated: string;
}

export interface TranslationProgress {
  total_pages: number;
  translated_pages: number;
  segments: number;
  pages: TranslationPageState[];
  job: {
    status: string;
    done: number;
    total: number;
    currentPage: number | null;
    error: string;
  } | null;
}

/** 工作台批量卡片状态。 */
export interface TranslationOverviewItem {
  documentId: string;
  name: string;
  totalPages: number;
  translatedPages: number;
  segments: number;
  status: 'none' | 'running' | 'partial' | 'done' | 'error';
  error: string;
}

export interface CreateAnnotationInput {
  documentId: string;
  page: number;
  quote?: string;
  content?: string;
  rects?: string;
  color?: string;
  style?: string;
  externalKey?: string;
}

export interface UpdateAnnotationInput {
  content?: string;
  color?: string;
  style?: string;
}

export interface NoteRecord {
  id: string;
  documentId: string;
  page: number;
  quote: string;
  content: string;
  created: string;
  /** Markdown 导入时的来源文件夹层级（相对路径，'' = 根目录）。 */
  folderPath?: string;
  /** 笔记标签（规范化、去重后的字符串数组）。 */
  tags?: string[];
}

export interface CreateNoteInput {
  documentId: string;
  page: number;
  quote?: string;
  content?: string;
  /**
   * 外部来源的稳定标识（例如 Zotero note item key），用于重复导入去重。
   * 应用内手工创建的笔记不传；同一文献内同一 externalKey 只应存在一条。
   */
  externalKey?: string;
  /** 独立笔记的来源文件夹层级（Markdown 导入用）。 */
  folderPath?: string;
  /** 笔记标签（规范化、去重后的字符串数组）。 */
  tags?: string[];
}

export interface UpdateNoteInput {
  page?: number;
  quote?: string;
  content?: string;
  folderPath?: string;
  tags?: string[];
}

export interface NavigationStatus {
  state: 'missing' | 'ready' | 'stale' | 'building' | 'failed';
  enabled: boolean;
  nodeCount: number;
  builtAt: string;
  sourceHash: string;
  error: string;
  done: number;
  total: number;
  /** 过期原因：文献文件已变化 / 无关区域规则已变化 / 索引已过期。 */
  stale_reason?: string;
  /** 上次被阅读规划实际使用的时间；未用过为空。 */
  last_used?: string;
  /** 用户指定的「目录页」范围；空数组表示按标题规则/PDF 书签生成。 */
  toc_pages?: number[];
  /** 目录是否为用户手动编辑/保存（`build_state='manual'`）。 */
  manual?: boolean;
  /** 目录是否为「PDF 内置目录自动保存的本地副本」（`build_state='materialized'`）。 */
  materialized?: boolean;
}

/** 「按目录页生成目录」预览：解析目录页得到的条目 + 页码偏移估计（不保存）。 */
export interface TocNavigationPreview {
  toc_pages: number[];
  nodes: Array<{ page: number; kind: string; label: string }>;
  entries: Array<{
    title: string;
    printedPage: number | null;
    /** 页码标签原文（`12`、`xii`）。 */
    printedPageLabel?: string;
    /** arabic=阿拉伯页码；roman=罗马数字页码（i/ii/iii）。 */
    pageKind?: 'arabic' | 'roman' | 'none';
    level: number;
    raw: string;
  }>;
  stats: {
    entries: number;
    offset: number;
    offsetConfidence: number;
    /** 罗马数字页码条目数。 */
    romanEntries?: number;
    /** 罗马页码条目的偏移（物理页 = 罗马序号 + offset）。 */
    romanOffset?: number;
    romanOffsetConfidence?: number;
    nodes: number;
    skipped: number;
  };
  warnings: string[];
}

/** 目录预览（`GET /documents/:id/navigation/preview`）：前 120 条 + 截断标记 + 状态。 */
export interface NavigationPreview {
  status: NavigationStatus;
  nodes: Array<{ page: number; kind: string; label: string }>;
  nodes_truncated: boolean;
  total_nodes: number;
}

export interface PageMaskRecord {
  id: string;
  documentId: string;
  page: number;
  scope: 'page' | 'all' | 'odd' | 'even' | 'range' | 'exclude';
  rangeStart?: number;
  rangeEnd?: number;
  excludePages?: number[];
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** 页遮罩重建索引的进度/状态（`GET /documents/:id/masks/status`）。 */
export interface MaskIndexStatus {
  state: 'idle' | 'rebuilding' | 'ready' | 'failed';
  done: number;
  total: number;
  error: string;
  revision: string;
}

/** 页面数据接口：一行文字 + 它的归一化 bbox（0..1，左上原点）。 */
export interface PageDataLine {
  text: string;
  bbox: [number, number, number, number];
}

/**
 * 一页的版面数据。
 *
 * - `width`/`height` 是**页面尺寸（PDF 点）**，只用于换算比例；行坐标一律归一化 0..1；
 * - `lines` 已按当前页遮罩过滤（被遮住的页眉/页脚等不出现）；
 * - `masks` 是该页生效的遮罩规则，`masks_revision` 是遮罩集合的摘要（变了 = 版面视图需要刷新）。
 */
export interface PageData {
  page: number;
  width: number;
  height: number;
  lines: PageDataLine[];
  /** 文本项粒度（通常词/片段）的归一化框；比 lines 更细，用于选区/高亮对齐。 */
  spans?: PageDataLine[];
  /** PDF 页 viewport 的旋转矩阵（6 个数），与 spans 坐标同一变换。 */
  rotation_matrix?: number[];
  masks: PageMaskRecord[];
  masks_revision: string;
}

/**
 * 识别/解析服务自检结果。
 */
export interface ParsingCheckResult {
  mode: string;
  url: string;
  /** 服务归属层级（本机 / 局域网 / 公网），只描述可达性，不评价优劣。 */
  tier: string;
  ok: boolean;
  message: string;
  detail: string[];
}

/**
 * 本机诊断包（zip）：只含脱敏诊断报告与最近错误日志，**不含 PDF、正文或密钥**。
 * path 是本机绝对路径，界面可显示/交给系统打开所在目录。
 */
export interface DiagnosticsPackageRecord {
  name: string;
  path: string;
  bytes: number;
  createdAt: string;
}

/**
 * 运维维护状态（只做 stat/计数，不读取用户正文或 PDF）。
 * core_pid 是当前提供 API 的 core 进程；孤儿 core 进程守护尚未实现。
 */
export interface MaintenanceStatus {
  version: string;
  data_dir: string;
  database_bytes: number;
  log_bytes: number;
  diagnostics_count: number;
  backups_count: number;
  last_backup?: string;
  platform: string;
  uptime_seconds?: number;
  core_pid?: number;
}

/**
 * 清空全部本地用户数据（文献、笔记、批注、会话、译文、索引、缓存、备份）的结果。
 * 只删除用户资料，不删除程序目录；删除后不可恢复。
 */
export interface ClearUserDataResult {
  ok: true;
  removed: {
    documents: number;
    notes: number;
    annotations: number;
    messages: number;
    sessions: number;
    translations: number;
    note_assets: number;
    backups: number;
  };
}

/** 文件健康检查：仅 stat 文献文件是否存在，不读取正文。 */
export interface FileHealthIssue {
  documentId: string;
  name: string;
  path: string;
}

export interface FileHealthReport {
  /** 参与检查的文献数（不含回收站）。 */
  checked: number;
  /** 文件正常的文献数。 */
  ok: number;
  /** 文件缺失的文献数。 */
  missing: number;
  issues: FileHealthIssue[];
}

/** 导入任务状态（后端后台解析 PDF；前端轮询进度并可请求取消）。 */
export type ImportJobState = 'queued' | 'running' | 'cancelling' | 'done' | 'failed' | 'cancelled';

export interface ImportJobRecord {
  id: string;
  state: ImportJobState;
  /** 0–100；解析阶段是粗粒度估计，不是逐页精确进度。 */
  progress: number;
  /** 当前阶段（reading/hashing/parsing/writing/done）。 */
  stage: string;
  documentId?: string;
  documentName?: string;
  pages?: number;
  error?: {
    code?: string;
    message: string;
    details?: unknown;
  };
  startedAt: string;
  finishedAt?: string;
}

/** 备份任务状态（创建 zip 是本地任务；文件收集阶段可取消）。 */
export type BackupJobState = 'queued' | 'running' | 'cancelling' | 'done' | 'failed' | 'cancelled';

export interface BackupJobRecord {
  id: string;
  state: BackupJobState;
  progress: number;
  stage: string;
  filesDone?: number;
  filesTotal?: number;
  backup?: BackupRecord;
  error?: {
    message: string;
  };
  startedAt: string;
  finishedAt?: string;
}

export interface StructureNode {
  title: string;
  page: number;
  level: number;
  origin: string;
  endPage: number;
  parent: number | null;
}

/** 目录接口：与阅读规划共用同一份结构树，并如实标明来源。 */
export interface OutlineResult {
  sections: Array<{
    title: string;
    page: number;
    level: number;
    end_page: number;
    origin: string;
  }>;
  total_pages: number;
  origins: string[];
  message: string;
}

export interface QuoteBox {
  bbox: [number, number, number, number];
  text: string;
}

/** 摘引定位来源：PDF 文本层字形行 / 扫描页 OCR 行框 / 完全没找到。 */
export type QuoteLocateMethod = 'text_layer' | 'ocr' | 'none';

/**
 * 一次摘引定位的完整结果。
 *
 * - `page`：命中所在的**真实**页码（可能因跨页找回而与请求页不同）；
 * - `corrected`：请求页没找到、在全文其它页找到时为 true；
 * - `method==='none'` 表示这一页和全文都没逐字找到，位置不猜；
 * - `message` 是给用户看的如实说明（可直接展示）。
 */
export interface QuoteLocation {
  boxes: QuoteBox[];
  page: number;
  method: QuoteLocateMethod;
  corrected: boolean;
  message: string;
}

export interface TranslationPageRecord {
  documentId: string;
  page: number;
  sourceHash: string;
  engine: string;
  status: string;
  error: string;
  done: number;
  total: number;
  updated: string;
}

export interface TranslationSegmentRecord {
  id: string;
  documentId: string;
  page: number;
  segment: number;
  source: string;
  sourceHash: string;
  text: string;
  engine: string;
  service: string;
  /** 占位：本版未实现术语表，恒为 `'[]'`；新代码不要依赖。 */
  terms: string;
  /** 占位：本版未实现术语表，恒为 `'[]'`；新代码不要依赖。 */
  unknownTerms: string;
  /** 占位：本版未实现覆盖率计算，恒为 0；新代码不要依赖。 */
  coverage: number | null;
  edited: boolean;
  origin: string;
  previousText: string;
  previousOrigin: string;
  state?: 'reused' | 'edited' | 'missing' | 'stale';
  truncated?: boolean;
  skipped?: boolean;
  para?: number;
  kind?: string;
  column?: string;
  /**
   * 这一段的原文在页面上的位置（归一化 0..1，左上原点），只读、不落库。
   *
   * 供译文栏的「版式」呈现方式把译文放回原文位置；没有版面/行框的页为 null。
   */
  bbox?: [number, number, number, number] | null;
  /**
   * 这一段原文的**逐行**框（阅读顺序，归一化 0..1，只读、不落库）。
   *
   * 版式呈现按行摆放译文：跨栏段落会得到左栏底部 + 右栏顶部的多段行框，
   * 不会用一个跨栏大矩形把中间内容一起盖住。没有行框的页为空数组。
   */
  lineBoxes?: Array<[number, number, number, number]>;
}

export interface TranslationPagePayload {
  page: TranslationPageRecord | null;
  segments: TranslationSegmentRecord[];
  pageSize?: { width: number; height: number } | null;
  columns?: number;
  bodyLineHeight?: number;
  bodyFontSize?: number;
  targetLanguage?: string;
  furniture?: number;
}

export interface TranslationConfigRecord {
  target_language: string;
  targets: Array<{ id: string; name: string }>;
}

export interface TranslationJobRecord {
  documentId: string;
  status: 'idle' | 'running' | 'done' | 'stopped' | 'failed';
  total: number;
  done: number;
  currentPage: number | null;
  error: string;
}

export interface TranslationServiceSummary {
  total: number;
  legacy: number;
  services: Array<{ service: string; count: number }>;
}

export interface ParsingConfigRecord {
  mode: 'local' | 'vision' | 'mineru_online' | 'mineru_agent' | 'custom';
  connection_id: string;
  model: string;
  service_url: string;
  allow_remote: boolean;
  mineru_online_model: 'vlm' | 'pipeline';
  auto_ocr: boolean;
  /** 本机 Tesseract OCR 选用的语言包 code（空/缺省按 eng+chi_sim）；仅 local 模式生效。 */
  ocr_langs?: string[];
  has_key: boolean;
}

export interface ParsingConfigUpdate extends Partial<Omit<ParsingConfigRecord, 'has_key'>> {
  service_key?: string;
  clear_service_key?: boolean;
  /** 本机 Tesseract OCR 选用的语言包 code；下载/安装状态见 OcrLanguageStatus。 */
  ocr_langs?: string[];
}

/** 一个本机 Tesseract OCR 语言包的安装状态（目录来自官方 tessdata_fast）。 */
export interface OcrLanguagePack {
  code: string;
  label: string;
  /** 数据目录里已有 `<code>.traineddata` 且 >100KB 时为 true。 */
  installed: boolean;
  bytes: number;
  /** 来源说明（官方 tessdata_fast 仓库地址）。 */
  source: string;
  /** 许可证说明（Apache-2.0）。 */
  license: string;
}

/** 语言包下载任务（后台进行；同一时间最多一个）。 */
export interface OcrLanguageJob {
  running: boolean;
  codes: string[];
  done: number;
  total: number;
  /** 中文错误摘要；部分失败时保留已成功的包，error 里写清失败项。 */
  error: string;
}

export interface OcrLanguageStatus {
  packs: OcrLanguagePack[];
  /** 当前选中的语言（parsing config ocr_langs；空时默认 eng+chi_sim）。 */
  selected: string[];
  job: OcrLanguageJob | null;
  /** 语言包实际存放目录（`<dataDir>/ocr-tessdata/langs`）。 */
  dataDir: string;
}

export interface OcrLine {
  text: string;
  confidence: number;
  bbox: [number, number, number, number];
}

export interface OcrPageResult {
  page: number;
  text: string;
  lines: OcrLine[];
  image: { width: number; height: number };
  engine: string;
}

/** 框选区域识别：text 是逐行原文（用于检索/引用），textReflowed 是展示用整段。 */
export interface RegionOcrResult {
  text: string;
  textReflowed: string;
  bbox: [number, number, number, number];
  engine: string;
  /**
   * 来源说明：这次区域识别实际用了哪种方式、是否发生回退、为什么。
   * 例：识别方式是 MinerU 时会明确写「MinerU 不支持框选，本次改用视觉模型 xxx；MinerU 没有被调用」。
   */
  engine_note?: string;
  /** 回退来源：识别方式是 mineru_* 等不支持裁图的方式时，记录原始识别方式。 */
  fallback_from?: string;
}

/** 区域 OCR 后台任务：识别在 Core 内异步执行，前端轮询进度；取消只能在识别结束后丢弃结果。 */
export type OcrJobState = 'queued' | 'running' | 'cancelling' | 'done' | 'failed' | 'cancelled';

export interface OcrJobRecord {
  id: string;
  state: OcrJobState;
  progress: number;
  stage: string;
  page: number;
  result?: RegionOcrResult;
  error?: {
    code?: string;
    message: string;
  };
  startedAt: string;
  finishedAt?: string;
}

export interface PageTextRecord {
  page: number;
  text: string;
  origin: string;
  boxes: string;
}

export interface BackupRecord {
  name: string;
  path: string;
  sizeBytes: number;
  created: string;
}

export interface BackupVerification {
  name: string;
  sizeBytes: number;
  entries: number;
  databases: string[];
  integrity: string;
}

export interface PendingRestore {
  backup: string;
  requestedAt: string;
}

export interface ModelTestResult {
  ok: boolean;
  model: string;
  baseUrl: string;
  latencyMs: number;
  message: string;
}

export interface ZoteroConfigRecord {
  mode: 'local' | 'cloud' | 'webdav';
  library_type: 'users' | 'groups';
  library_id: string;
  webdav_url: string;
  webdav_user: string;
  has_key: boolean;
  has_password: boolean;
}

export interface ZoteroProbeResult {
  ok: boolean;
  /** 请求的连接方式（= 设置里的 zotero.mode）；字段保持向后兼容。 */
  mode: 'local' | 'cloud' | 'webdav';
  latencyMs: number;
  message: string;
  /** 请求的连接方式（与 mode 相同，显式给出便于界面说明"为什么报的是云端错误"）。 */
  requestedMode?: 'local' | 'cloud' | 'webdav';
  /**
   * 实际探测的 Zotero API 端点：WebDAV 模式的分类/条目仍从 api.zotero.org 读取，
   * 因此这里会是 cloud（local 模式才是 local）。
   */
  actualMode?: 'local' | 'cloud';
  /** 探测步骤说明（只含地址/状态码/耗时，不含 API Key 或 WebDAV 密码）。 */
  detail?: string[];
  /** WebDAV 附件目录探测结果（仅 webdav 模式；含是否已配置凭据）。 */
  webdav?: {
    checked: boolean;
    ok: boolean;
    status: number;
    latencyMs: number;
    message: string;
  };
}

export interface ZoteroCollection {
  key: string;
  name: string;
  parentCollection: string;
}

export interface ZoteroItem {
  key: string;
  title: string;
  creators: string;
  publication: string;
  date: string;
  itemType: string;
}

export interface SpeechConfigRecord {
  input_enabled: boolean;
  output_enabled: boolean;
  auto_send: boolean;
  auto_read: boolean;
  correction: boolean;
  context: boolean;
  trigger_mode: 'hold' | 'click';
  direct_audio: boolean;
  language: string;
  asr_mode: 'system' | 'model' | 'custom';
  tts_mode: 'system' | 'model' | 'custom';
  asr_url: string;
  tts_url: string;
  asr_model: string;
  tts_model: string;
  asr_connection_id: string;
  tts_connection_id: string;
  voice: string;
  has_asr_key: boolean;
  has_tts_key: boolean;
}

export interface SpeechTranscription {
  text: string;
  confidence: number | null;
  source: string;
}

/**
 * 本机语音系统自检结果（只读：Windows 系统语音/识别语言）。
 *
 * 由 Core `GET /speech/system` 返回；放在 shared 而不是 api-client，
 * 是因为它属于服务端响应契约，未来其它客户端（DSH Host/CLI）也要用。
 */
export interface SpeechSystemStatus {
  platform: string;
  ok: boolean;
  tts_voices: string[];
  asr_languages: string[];
  message: string;
  detail: string[];
}

export interface SearchConfigRecord {
  provider: 'deepseek' | 'tavily';
  base_url: string;
  has_key: boolean;
  permission: 'off' | 'review' | 'auto';
  followup: boolean;
  planner: boolean;
  privacy_mode: 'keywords-only' | 'question' | 'scope';
  allow_question: boolean;
  allow_history: boolean;
  allow_selection: boolean;
  allow_notes: boolean;
  allow_annotations: boolean;
  allow_answer: boolean;
  allow_document: boolean;
  allow_current_page: boolean;
  allow_surrounding: boolean;
  allow_title: boolean;
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  retrieved_at: string;
  kind: 'web';
  tier?: string;
  tierLabel?: string;
}

/** 搜索计划请求：只包含用户已允许用于搜索规划的输入。 */
export interface SearchPlanRequest {
  question: string;
  documentId?: string;
  selection?: string;
  history?: Array<{ question: string; answer?: string }>;
  /** 缺口查证：已逐字核验的原文摘引（可空）。 */
  gap_claim?: string;
}

/**
 * 搜索计划（审批凭证）。
 *
 * - `token` 10 分钟内有效，绑定"问题/选中原文 + 当前搜索配置"的指纹；
 * - 校验通过后可在同一请求重发时**重复使用**（继续阅读不能因为重发而丢批准）；
 * - `queries` 是脱敏后的公共搜索词，真正发请求时只能用它。
 */
export interface SearchPlan {
  token: string;
  queries: string[];
  method: string;
  provider: string;
  review: boolean;
  inputs: string[];
  planner_destination: string;
  warning: string;
}

/**
 * Zotero 批注/笔记导入报告（预览与导入共用一次调用）。
 *
 * 向后兼容约定：批注相关字段（`total`/`imported`/`wouldImport`/`skipped*`/
 * `located`/`pageLevel`/`unknownColor`/`items`）保持旧语义不变；笔记相关字段
 * 为 schema_version 7 新增，旧消费方可以忽略。`items` 里新增的 `kind`
 * 为可选字段，已有调用方不依赖它也能继续工作。
 */
export interface ZoteroAnnotationImportReport {
  attachmentKey: string;
  mode: 'preview' | 'import';
  /** 批注条数（不含笔记，旧语义）。 */
  total: number;
  imported: number;
  wouldImport: number;
  skippedExisting: number;
  skippedType: number;
  skippedPage: number;
  skippedEmpty: number;
  located: number;
  pageLevel: number;
  /**
   * 本次按 Zotero 自带 annotationPosition.rects 直接换算位置（不再依赖文本层逐字定位）
   * 的新导入批注条数。预览与导入都计数。
   */
  positioned: number;
  /**
   * 已存在、但仍只有页级位置（rects 为空或 style=page）的批注中，
   * 本次按 Zotero 坐标升级为高亮/下划线位置的条数。预览与导入都计数。
   */
  repositioned: number;
  unknownColor: number;
  warnings: string[];
  message: string;
  items: ZoteroAnnotationImportItem[];
  /** 从父条目 children 里读到的 Zotero 笔记条数（不含已删除）。 */
  noteTotal: number;
  /** 本次实际写入笔记表的笔记条数（预览恒为 0）。 */
  notesImported: number;
  /** 预览时将会写入的笔记条数（导入时恒为 0，与 wouldImport 语义一致）。 */
  notesWouldImport: number;
  /** 因 external_key 已存在而跳过的笔记条数。 */
  notesSkippedExisting: number;
  /** 因笔记正文为空而跳过的条数。 */
  notesSkippedEmpty: number;
  /** 笔记逐条明细；正文只保留前 500 字符，完整正文写入 notes 表。 */
  noteItems: ZoteroNoteImportItem[];
}

export interface ZoteroAnnotationImportItem {
  /** 新增（可选）：区分批注与笔记，旧消费方忽略即可。 */
  kind?: 'annotation' | 'note';
  zoteroKey: string;
  type: string;
  page: number;
  quote: string;
  comment: string;
  action: string;
  reason: string;
}

export interface ZoteroNoteImportItem {
  kind: 'note';
  zoteroKey: string;
  type: 'note';
  /** 整篇文献笔记固定写在第 0 页。 */
  page: number;
  /** HTML 转纯文本后的正文预览（最多 500 字符）。 */
  content: string;
  /** 完整纯文本正文的字符数（未截断）。 */
  contentLength: number;
  action: 'import' | 'would-import' | 'skip' | 'skip-existing';
  reason: string;
}

export interface DiagnosticsReport {
  generatedAt: string;  app: {
    name: string;
    version: string;
    platform: string;
    node: string;
  };
  counts: Record<string, number>;
  integrity: string;
  missingFiles: number;
  recentErrors: Array<{ timestamp: string; context: string; message: string }>;
  failedTasks: Array<{
    category: string;
    count: number;
    lastContext: string;
    lastMessage: string;
    lastTimestamp: string;
  }>;
  usage: {
    databaseBytes: number;
    papersBytes: number;
    backupsBytes: number;
    backups: number;
  };
  /** 运行环境与依赖版本（只读；读不到的包列在 missing，不阻断诊断包）。 */
  dependencies?: {
    node: string;
    electron?: string;
    packages: Record<string, string>;
    missing: string[];
  };
}

export interface ReadingPlanRecord {
  breadth: 'document' | 'local' | 'discovery';
  reason: string;
  origin: '规则' | '模型规划' | '保守回退';
  pages: number[];
  queries: string[];
  dimensions: Array<{ code: string; label: string }>;
}

export interface PlannedReadingPreview {
  plan: ReadingPlanRecord;
  pages: number[];
  batchCount: number;
  multiPass: boolean;
  batches: Array<Array<{ index: number; page: number; name: string }>>;
}

/** 著作章节（由目录派生，只用于展示与"读哪一章"的选择，不是新的证据来源）。 */
export interface DocumentChapter {
  index: number;
  title: string;
  page: number;
  end_page: number;
  level: number;
}

export interface DocumentChapters {
  chapters: DocumentChapter[];
  total_pages: number;
  /** 目录是否足以分章（至少 2 章）；false 时界面不显示章节选择。 */
  available: boolean;
  /** 章节来源：启用的本地目录，或 PDF 书签/标题规则的结构树。 */
  source?: 'navigation' | 'structure';
}

export interface BudgetEstimate {
  pages: number;
  tokens: number;
  documents: number;
  thresholds: { pages: number; tokens: number };
  exceeded: boolean;
  estimated: true;
  method: string;
  note: string;
  /** 估算对应的阅读范围（显式 scope 或规划结论），用于界面如实显示。 */
  scope?: 'local' | 'document' | 'discovery';
  /** 范围内总页数：`pages` 是本轮预计读取页数时，用它与总数区分"先读多少、还剩多少"。 */
  total_pages?: number;
  /** 单轮批次上限（`reading.max_read_batches`）。 */
  max_batches?: number;
}

export interface SettingsMap extends Record<string, string> {}

export interface ProviderPreset {
  id: string;
  name: string;
  baseUrl: string;
  models: string[];
  requiresKey: boolean;
  /** 平台说明（界面显示在平台选择/Key 输入附近，例如 M Plan 与按量计费 Key 的区别）。 */
  description?: string;
  /** 官方接入文档地址（界面可点击打开；只放 https 链接）。 */
  docsUrl?: string;
  /** API Key 的获取位置/前缀提示（只用于界面说明，不做校验）。 */
  keyHint?: string;
}

export type ModelServiceKind =
  | 'chat'
  | 'embedding'
  | 'rerank'
  | 'translation'
  | 'asr'
  | 'tts'
  /** 视觉读页：图表/公式/结构的派生解读，不是逐字原文。 */
  | 'vision'
  /** 全模态：一个模型同时承担会话、视觉与音频。 */
  | 'omni';

export interface ModelServiceModel {
  id: string;
  name: string;
  capabilities: string[];
  source: 'preset' | 'fetched' | 'manual' | 'user';
  enabled: boolean;
  /** 平台/官方元数据给出的上下文窗口（token，8192–4000000）；未提供时缺省。 */
  context_window?: number;
  /**
   * 容量设置方式：`auto` = 优先用平台/官方元数据（拿不到则用全局设置）；
   * `manual` = 用本模型上用户填的 `context_window`。
   */
  capacity_mode?: 'auto' | 'manual';
  /**
   * 用户显式要求「任务型调用关闭深度思考」。
   * 说明：仅对支持思考开关的平台有意义；当前版本只保存设置并在界面展示，
   * **不会**向平台发送猜测出来的私有参数（默认行为不变）。
   */
  task_thinking?: boolean;
  /** 容量来源说明（平台元数据 / 官方文档快照 / 手动指定）。 */
  capacity_source?: string;
  /**
   * 官方文档登记的最大输出 token 数（只读，由 core 按平台地址 + 模型名查官方快照后填入；
   * 不落库，保存时会被丢弃后重新按当前快照填充）。未登记时缺省。
   */
  max_output?: number;
  /** 最大输出的来源说明（含官方文档快照日期）；未登记时缺省。 */
  max_output_source?: string;
  /** 官方来源链接（模型元数据快照给出时展示，便于用户核对）。 */
  metadata_url?: string;
}

export interface ModelServiceConnection {
  id: string;
  name: string;
  platform: string;
  baseUrl: string;
  models: ModelServiceModel[];
  hasKey?: boolean;
}

export interface ModelServiceAssignment {
  connectionId: string;
  model: string;
}

export interface ModelServiceRouting {
  chat?: ModelServiceAssignment;
  embedding?: ModelServiceAssignment;
  rerank?: ModelServiceAssignment;
  translation?: ModelServiceAssignment;
  asr?: ModelServiceAssignment;
  tts?: ModelServiceAssignment;
  /** 视觉读页专用模型（可选；未选时回退 omni / 带视觉能力的会话模型）。 */
  vision?: ModelServiceAssignment;
  /** 全模态模型（同时可承担会话、视觉读页与音频）。 */
  omni?: ModelServiceAssignment;
}

export interface ModelServicesConfig {
  connections: ModelServiceConnection[];
  routing: ModelServiceRouting;
}

/** 删除平台连接会影响哪些用途（确认前如实提示）。 */
export interface ModelServicesImpact {
  /** 路由里指向该连接的用途（chat/embedding/rerank/translation/asr/tts/vision/omni）。 */
  kinds: string[];
  parsing: boolean;
  speechAsr: boolean;
  speechTts: boolean;
}

export type LibrarySearchKind =
  | 'document'
  | 'tag'
  | 'annotation'
  | 'note'
  | 'chunk';

export interface LibrarySearchHit {
  kind: LibrarySearchKind;
  id: string;
  documentId: string;
  documentName: string;
  page?: number;
  title: string;
  snippet: string;
  /** 命中词所在的整行（与全文检索一致）；只对 chunk 命中有效。 */
  match?: string;
  /** 命中的是译文派生块（不是原文）。 */
  translation?: boolean;
  /** 命中的是结构/视觉等派生块（不是逐字原文）。 */
  derived?: boolean;
}

export interface SearchHit {
  chunkId: string;
  documentId: string;
  documentName: string;
  page: number;
  snippet: string;
  /** 命中词所在的整行（跨标点/空白回退匹配），用于精确高亮；没命中时是首行。 */
  match?: string;
  score: number;
  derived?: boolean;
  translation?: boolean;
  sourceText?: string;
  /** 译文命中时的段号（0 起），与译文派生检索记录的段号一致。 */
  segment?: number;
  /** 译文是否被人工改稿（true 时来源不是机器译文）。 */
  edited?: boolean;
  /** 译文段的原始 id。 */
  translation_id?: string;
  /** 译文引擎（模型名或 'manual' 等，由翻译服务记录）。 */
  engine?: string;
  warning?: string;
  /**
   * 命中位置所在章节标题（结构与内容块识别的产物）。
   *
   * 只在识别缓存已就绪时给出（不会为了检索结果列表去解析整篇 PDF）；没有时缺省，
   * 界面应照常显示页码。它只说明"命中在文献哪一节"，不是新的证据。
   */
  sectionTitle?: string;
  /** 命中位置所属内容块 id（`b{index}`，见 `ContentBlock`）。 */
  blockId?: string;
}

export interface SearchRequest {
  query: string;
  documentId: string;
  page?: number;
  crossBook?: boolean;
  scope?: 'all' | 'tags' | 'documents';
  scopeTags?: string[];
  scopeDocuments?: string[];
  mode?: 'close' | 'wide';
  selection?: string;
  limit?: number;
}

export interface ChatSource {
  documentId: string;
  documentName: string;
  page: number;
  snippet: string;
  quotes?: string[];
  /** 复核没有逐字摘引时，正文与原文的逐字重合片段（仅用于定位，不是证据）。 */
  anchor?: string;
  /** 外部网页来源的域名分层（预印本/期刊/机构/政府/一般网页），只用于显示与排序。 */
  tier?: string;
  tierLabel?: string;
  /** 网页来源时可直接打开。 */
  url?: string;
  /**
   * 来源类型：document=文献原文页；web=外部网页；
   * note=用户笔记；annotation=用户批注（后两者是用户自己的记录，不是文献原文证据）。
   */
  kind?: 'document' | 'web' | 'note' | 'annotation';
  /**
   * 笔记/批注来源的本地记录 id（kind 为 note/annotation 时给出）。
   * 独立笔记的 documentId 为空串，page 为 0；界面据此切到独立笔记视图。
   */
  memoryId?: string;
  /**
   * 来源性质：document=原文页面；visual_model=视觉读页的派生解读
   * （图表/公式/结构，不是逐字原文，不能当逐字证据）；web=外部网页；
   * note/annotation=用户自己的笔记/批注（同样不是文献原文）。
   */
  sourceType?: 'document' | 'visual_model' | 'web' | 'note' | 'annotation';
  /**
   * 命中位置所在章节标题（结构与内容块识别的产物）。
   *
   * 只用于显示与说明"命中在文献的哪一节"；来源证据仍是原文页面/片段，
   * 不因为带了章节标题就变成新的证据。
   */
  sectionTitle?: string;
  /** 命中片段覆盖到的最后一页（片段跨页时 > page）；缺省同 page。 */
  pageEnd?: number;
  /**
   * 跳转到原文时用于逐字定位的片段（通常就是检索命中的那一行）。
   *
   * 只用于定位高亮，**不参与**引用核验/证据判定（与 `quotes`/`anchor` 的语义不同）；
   * 没有时回退到 `quotes`/`anchor`。
   */
  locate?: string;
}

export interface ChatMessageRecord {
  id: number;
  documentId: string;
  role: 'user' | 'assistant';
  content: string;
  sources: ChatSource[];
  metadata: Record<string, unknown>;
  created: string;
}

/** 阅读伙伴（按文献）的会话清单记录；消息归属靠消息 metadata 里的 sessionId。 */
export interface DocumentChatSessionRecord {
  id: string;
  title: string;
  created: string;
  updated: string;
  /** 会话早期历史的摘要（会话模型生成，只用于理解上下文，不是文献原文/证据）。 */
  contextSummary?: string;
  /** 摘要覆盖到哪条消息 id（该 id 及之前的早期轮次已被压缩）。 */
  summaryUpto?: number;
  /** 会话消息版本：任何消息增删改都会递增；摘要写回用它做条件更新。 */
  transcriptVersion?: number;
}

/** 单轮回答的模型 token 用量（供应商不返回时按字符估算，estimated=true）。 */
export interface ChatUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  /** 本轮实际发生的模型调用次数（阅读链路可能多次）。 */
  calls?: number;
  /** true = 至少有一次调用没有拿到供应商 usage，按字符估算。 */
  estimated?: boolean;
}

export interface ReadingTaskSummary {
  taskId: string;
  question: string;
  pagesRead: number[];
  unreadPages: number[];
  answer: string;
  updated: number;
}

export interface ChatRequest {
  question: string;
  documentId?: string;
  page?: number;
  /** 用户显式带入的选中原文（批注 quote 等），会参与检索并附在提示里。 */
  selection?: string;
  /** 搜索权限为 review 时，用户是否已确认本次允许联网搜索。 */
  confirmSearch?: boolean;
  /** 最近对话，仅在用户允许用于搜索规划时发送。 */
  history?: Array<{ question: string; answer?: string }>;
  /**
   * 阅读伙伴会话 id（配合 documentId）：服务端据此读取该会话完整消息，
   * 超出上下文预算时把更早轮次压缩进会话摘要，本轮送入「摘要 + 最近轮次」。
   */
  chat_session_id?: string;
  /** 全模态模型直接接收的录音；有值时跳过 ASR 转文字。 */
  audio?: { data: string; mimeType: string; filename?: string };
  /** 继续阅读：上次回答返回的阅读任务编号。 */
  taskId?: string;
  /** 预算超限后用户确认继续读取。 */
  confirm_budget?: boolean;
  /** 智能阅读范围：auto 自动判断，local 本页与相邻页，document 整篇，corpus 跨文献。 */
  reading_scope?: 'auto' | 'local' | 'document' | 'corpus';
  /** 智能阅读深度：是否在缺口后回读。 */
  reading_rigor?: 'auto' | 'fast' | 'standard' | 'exhaustive';
  /** 用户显式指定读第几章（1 起）；仅著作且有目录时生效，优先于自动选章。 */
  reading_chapter_index?: number;
  /** 智能来源：document_only 时本轮不联网、不补充模型知识。 */
  source_policy?: 'auto' | 'document_only';
  /**
   * 是否把本机笔记与批注纳入本轮问答（默认不纳入；界面默认勾选）。
   *
   * - 有 documentId（文献阅读内提问）：纳入该文献的笔记与批注；
   * - 无 documentId（独立问答）：按 scope_documents/scope_tags/全部文献取笔记与批注，
   *   范围是「全部文献」时一并纳入独立笔记。
   *
   * 笔记/批注是用户自己的记录，只能作为理解用户关注点的补充材料，
   * 不作为文献原文证据，也不参与引用编号。
   */
  include_memory?: boolean;
  /** 跨文献范围：用户明确选择的文献 id；空数组表示全部文献。 */
  scope_documents?: string[];
  /** 跨文献范围：按标签圈定（与 scope_documents 二选一，优先显式文献）。 */
  scope_tags?: string[];
  /** 语音提问的原始转写（随消息元数据保存，用于回显原始说法）。 */
  voice_original?: string;
  /** 用户改写过的联网查询词；有值时优先用它发搜索。 */
  web_query?: string;
  /** 搜索计划凭证：有值时按计划里的脱敏查询词搜索（不自行生成新的搜索词）。 */
  search_token?: string;
  /**
   * 审计发现「需要外部依据」后，用户在回答下方点了「允许联网补查」。
   * 仅 review 权限需要；为 true 时本轮允许按缺口自动补查（仍只发脱敏查询词）。
   */
  confirm_gap_search?: boolean;
}

export interface CoverageSummary {
  dimensions: string[];
  batches: number;
  recorded_batches: number;
  hits: string[];
  states: Record<string, string>;
  evidence: Record<string, string[]>;
  evidence_pages: Record<string, number>;
  /** 跨文献阅读时逐篇的读取范围与页数（只用于如实报告，不参与证据判定）。 */
  documents?: CorpusDocumentReport[];
  /** 本轮是否读到全篇（无缺页/无可读性问题）。 */
  full_extracted_text?: boolean;
  indexed_pages?: number;
  total_pages?: number;
  candidate_documents?: number;
  selected_documents?: number;
  /** 跨文献发现排序记录（排序≠筛选）。 */
  discovery?: DiscoveryReportRecord;
  /** 有字但疑似乱码/字体异常的页（不能当作"读到全篇"）。 */
  quality_pages?: number[];
  strategy?: string;
  /**
   * 链路自己发起的定向联网查证记账。
   * 状态必须如实：只有真的发出过请求才可写"已查证"；未发起要带原因。
   */
  auto_source_search?: {
    queries: string[];
    claims: number[];
    reason: string;
    /** 如「已按论断缺口查证（3 条网页依据）」「未发起：用户已关闭联网搜索」等。 */
    status: string;
    /** 是否真的获得授权并发出请求（false 时不得声称已查）。 */
    approved: boolean;
    /** 这一问本身需要外部资料（路由判断 search=true）时带上。 */
    requested?: boolean;
    /** 实际取得的网页依据条数（没查或没结果时缺省）。 */
    results?: number;
  };
  /** 联网补查的多轮复核合并结果（目前只有一轮补查，字段预留；`web_support_review`）。 */
  web_support_review?: Record<string, unknown>;
  /** 读后缺口检索记录：ran/searched/pages/question 等。 */
  gap_search?: Record<string, unknown>;
  /** 台账摘要：只用于展示"哪些方面读到/未见到"，不参与证据判定。 */
  coverage_summary?: Record<string, unknown>;
  /** 台账口径说明（例如"有批次没回报覆盖维度，不据此判断文献里有没有"）。 */
  coverage_note?: string;
  /** 本轮送入模型的原文总字符数。 */
  characters?: number;
  /** 本轮请求使用的上下文窗口与输入预算（token）。 */
  context_window?: number;
  input_budget?: number;
  /** 估算器说明：本机 tokenizer 实测 / 按字符类别估算。 */
  estimator?: string;
  /** 为什么这一轮又要读一遍原文（页面文字/OCR/视觉解读复用，模型阅读按新问题重读）。 */
  reading_reuse?: string;
  /** 多遍阅读时实际送入综合的本轮材料（单遍为空串）。 */
  final_context?: string;
}

export interface CorpusDocumentReport {
  document_id: string;
  name: string;
  total_pages: number;
  readable_pages: number;
  /** 本轮真正读过的页（延期页不在内）。 */
  read_pages: number[];
  missing_pages: number[];
  ocr_pages: number[];
  /** 文本质量可疑（替换字符/私用区字体占比过高）的页。 */
  quality_pages?: number[];
  /** 本轮因批次上限未读的页（延期页；继续阅读时只补这些页）。 */
  unread_pages?: number[];
  /** 是否只读了部分批次；与 whole_document 一起使用，避免报告自相矛盾。 */
  partial?: boolean;
  whole_document: boolean;
}

export interface DiscoveryReportRecord {
  ordered_ids: string[];
  scores: Record<string, number>;
  candidates: number;
  hit_documents: number;
  terms: string[];
  basis: string;
  note: string;
}

export interface CoverageLedgerRowRecord {
  dimension: string;
  label: string;
  status: string;
  evidence: string[];
  unreadable_pages?: number[];
  reason?: string;
  reviewed_pages?: number;
  gap_search_pages?: number[];
}

export interface ChatResponse {
  answer: string | null;
  sources: ChatSource[];
  /**
   * 全模态语音直问时，模型返回的逐字转写。
   *
   * 只有「录音直接交给全模态模型」的路径才会返回：客户端据此把会话里的用户消息从
   * 「（语音提问）」占位更新为「（语音）转写」。模型没按约定返回 JSON 时为空。
   */
  audio_transcript?: string;
  /** 本轮模型 token 用量（估算/供应商返回）；没有模型调用时不返回。 */
  usage?: ChatUsage;
  /**
   * 本轮实际参考的笔记与批注（`kind` 为 note/annotation）。
   *
   * 这些是用户自己的记录，**不计入 `sources`**：它们不是文献原文证据，
   * 不参与引用编号与逐字核验；界面单独列出并允许跳回对应笔记/批注。
   */
  memory_sources?: ChatSource[];
  /** 笔记/批注纳入情况说明（纳入了多少条、没命中、未勾选等）；如实报告，不含糊。 */
  memory_notice?: string;
  /**
   * 本轮回答方式（供界面如实标注）：
   * direct=直接回复（问候/界面问题）；web=仅联网结果；reading=文献精读；
   * library=库内检索问答（不读全文）。
   */
  answer_mode?: 'direct' | 'web' | 'reading';
  /**
   * 本轮没有重新调用模型，回答/来源复用上一轮已保存结果（例如「继续阅读」时已无未读页）。
   * 界面与调用方据此不要声称本轮读过文献或纳入过笔记/批注。
   */
  reused_answer?: boolean;
  /**
   * 预算闸门：本轮预计超过确认阈值，需要用户确认后才开始读取原文。
   * 这是 **HTTP 200 的正常响应**（不是错误）；确认后带 `confirm_budget: true` 重发同一问题。
   */
  needs_confirmation?: boolean;
  /** `needs_confirmation` 为真时的估算明细（页数/预计 token/阈值等）。 */
  budget?: BudgetEstimate;
  notice?: string;
  blocked_sources?: string[];
  source_routing?: {
    claims: number;
    needs_external: number;
    document_only: number;
    blocked_kinds: string[];
    by_suggestion: Record<string, number>;
  };
  audit_summary?: {
    claims: number;
    supported: number;
    inference: number;
    unsupported: number;
    heading: number;
    claim_types: Record<string, number>;
  };
  plan?: ReadingPlanRecord;
  /** 本轮实际按章阅读时的章信息（著作默认按章读或用户指定章节时返回）。 */
  chapter?: DocumentChapter;
  /** 全书章数，配合 `chapter.index` 显示"第 2/12 章"与"下一章"。 */
  chapter_total?: number;
  /** 本轮实际采用的阅读范围与深度（用于界面如实显示）。 */
  reading_scope?: 'auto' | 'local' | 'document' | 'corpus';
  reading_rigor?: 'auto' | 'fast' | 'standard' | 'exhaustive';
  /** 当前文献对这个问题“答到什么程度”：SUFFICIENT/PARTIAL/MENTION_ONLY/ABSENT/UNCERTAIN。 */
  answerability?: 'SUFFICIENT' | 'PARTIAL' | 'MENTION_ONLY' | 'ABSENT' | 'UNCERTAIN';
  /** 外部网页依据的域名分层清单（只说明域名归属，不代表内容质量）。 */
  source_tiers?: {
    counts: Record<string, number>;
    groups: Array<{ tier: string; label: string; count: number; hosts: string[] }>;
    note: string;
  };
  /** 本轮是否允许模型通用知识与联网来源。 */
  model_knowledge?: boolean;
  web_search?: boolean;
  /** 联网搜索的非致命提示（例如部分网页正文未能抓取，只用了搜索摘要）。 */
  search_warning?: string;
  routing?: { document: boolean; search: boolean; reason: string };
  coverage?: CoverageSummary;
  gap_search?: {
    searched: boolean;
    matched_pages: number[];
    read_pages: number[];
    searched_pages?: number[];
    terms?: string[];
    pages?: Array<{ page: number; hit: boolean; read: boolean }>;
    /** 这一轮是否真的跑过缺口检索（台账升级资格只看它）。 */
    ran?: boolean;
    /** 缺口检索/扫读新增的页码区间（只增不减）。 */
    added_pages?: number[];
    sweep?: {
      terms: string[];
      scanned_pages: number;
      hit_pages: number[];
      semantic_hit_pages?: number[];
      regions: Array<[number, number]>;
      missing_terms: string[];
      added_pages: number[];
      truncated: number;
    };
  };
  /**
   * review 权限下、审计发现外部依据缺口时的确认信息：界面据此显示「允许联网补查」。
   * 用户确认后带 `confirm_gap_search: true` 重发同一问题。
   */
  gap_search_approval?: {
    queries: string[];
    claims: number[];
    reason: string;
  };
  /** 审计缺口触发的追加搜索轮次记录（第一轮 + followup）。 */
  search_followup?: {
    rounds: number;
    queries: string[];
    results: number;
    /** 是否因为"没有新查询词/没有新资料"提前停止（成功=false 不是错误）。 */
    stopped_reason?: string;
  };
  coverage_ledger?: CoverageLedgerRowRecord[];
  unread_pages?: number[];
  /** 本轮因批次上限没有执行的批次数；剩余页已存入阅读任务，可继续阅读。 */
  deferred_batches?: number;
  /** 延期批次涉及的页码（按文献分组，页码是文献内页码）。 */
  deferred_documents?: Record<string, number[]>;
  /** 证据银行预算装载/对账报告；dropped 与 unaccounted 必须如实展示。 */
  evidence_bank?: {
    available: number;
    kept: number;
    dropped: number;
    deduped?: number;
    dropped_keys?: string[];
  };
  /** 各批核验过的证据是否都有下落；unaccounted 必须为空。 */
  evidence_accounting?: {
    batch_items: number;
    unique_items: number;
    kept: number;
    deduped: number;
    dropped: number;
    unaccounted: string[];
  };
  /** 路由兜底/规划说明（例如“已核对术语：…”），不改变回答本身。 */
  route_note?: string;
  taskId?: string;
  citation_support?: {
    citations: number;
    verified: number;
    anchor_only: number;
    page_only: number[];
  };
  invalid_citations?: number[];
  citation_bindings?: Array<{ index: number; line: number; quote: string }>;
  audit?: {
    status: string;
    issues: string[];
    claims: Array<{
      claim: number;
      text?: string;
      verdict: string;
      reason?: string;
      claim_type?: string;
      evidence_standard?: string;
      evidence?: Array<{ source: number; quote: string; evidence_key?: string; page?: number }>;
      review_problem?: string;
      candidate_text?: string;
    }>;
    /** 审计后删除的无证据页码表述。 */
    page_mentions_removed?: Array<{ claim: number; text: string }>;
    /** 命中逐段复用缓存的段数。 */
    reused_claims?: number;
    /** 本轮审计分组数。 */
    audit_groups?: number;
    /** 审计阶段因容量省略的历史轮数（仅当真的发生丢弃时出现）。 */
    history_dropped?: number;
    evidence_scope?: { mode: string; groups?: unknown[] };
    routing?: Array<{
      claim: number;
      claim_type: string;
      evidence_standard: string;
      suggested: string;
      execution?: 'searched' | 'blocked' | 'needs_confirmation' | 'not_needed';
      /** 按 claim 性质“本该去找、但本轮没有授权”的来源（中文名）。 */
      blocked_external?: string[];
      reason: string;
    }>;
  };
  falsify?: {
    scanned_pages: number;
    contrast_pages: number[];
    semantic_pages: number[];
    marked_pages: number[];
    added_pages: number[];
    evidence: Record<string, string[]>;
    truncated: number;
  };
}

export interface EmbeddingStatus {
  chunks: number;
  vectors: number;
  model: string | null;
  external: boolean;
  configuredModel: string;
}

export interface EmbeddingIndexResult {
  indexed: number;
  model: string;
  external: boolean;
}

export interface LegacyMigrationReport {
  documents: number;
  chunks: number;
  annotations: number;
  notes: number;
  messages: number;
  settings: number;
  embeddings: number;
  translations: number;
  pageEdits: number;
  navigation: number;
  pageMasks: number;
  readingTasks: number;
  structures: number;
  connections: number;
  skippedDocuments: number;
  warnings: string[];
  backupPath?: string;
}


export * from './markdown.js';
export * from './update.js';
export * from './ai-marker.js';

/** 笔记/批注里插入的本地图片资源（存于数据目录 note-assets/）。 */
export interface NoteAssetRecord {
  id: string;
  /** 可直接用于 Markdown 图片地址（studianda-asset://note-assets/...）。 */
  url: string;
  filename: string;
  mime: string;
  sizeBytes: number;
}

/** 反向链接：某条笔记/批注引用了当前目标。 */
export interface BacklinkRecord {
  /** 来源类型：笔记或批注。 */
  kind: 'note' | 'annotation';
  id: string;
  documentId: string;
  documentName: string;
  page: number;
  /** 来源内容里引用处附近的纯文本摘要。 */
  snippet: string;
}

export type BacklinkTargetKind = 'note' | 'annotation' | 'document';

/**
 * 关系图全量模式一次可返回的节点硬上限。
 * 超过该值时服务端退回分页（hasMore=true、truncated=true），避免超大库拖垮渲染。
 */
export const REFERENCE_GRAPH_ALL_NODE_LIMIT = 5000;

/** 全库引用网络：节点 = 文献 / 笔记 / 批注，边 = 内部引用。 */
export type ReferenceNodeKind = 'document' | 'note' | 'annotation';

export interface ReferenceGraphNode {
  /** 全局唯一：`document:<id>` / `note:<id>` / `annotation:<id>`。 */
  id: string;
  kind: ReferenceNodeKind;
  /** 节点显示名：文献名 / 笔记标题（首行）/ 批注摘引或内容摘要。 */
  label: string;
  /** 所属文献；独立笔记为空串。 */
  documentId: string;
  page?: number;
}

export interface ReferenceGraphEdge {
  from: string;
  to: string;
}

export interface ReferenceGraph {
  nodes: ReferenceGraphNode[];
  edges: ReferenceGraphEdge[];
  /** 跨页引用（一端在当前页、另一端在页外）；最多返回 200 条。 */
  crossEdges: ReferenceGraphCrossEdge[];
  /** 跨页引用总数（未截断前）。 */
  crossEdgeTotal: number;
  /** 去重后的悬空引用数：同一来源引用同一不存在目标只计一次。 */
  unresolved: number;
  /** 当前页节点/边；未分页时等于全图。 */
  totalNodes: number;
  totalEdges: number;
  offset: number;
  limit: number;
  hasMore: boolean;
  /**
   * 全库各类型节点总数（不受 kinds/search 过滤影响，便于 UI 提示「只看文献+笔记」）。
   * 旧服务端可能不返回该字段。
   */
  kindCounts?: Record<ReferenceNodeKind, number>;
  /**
   * 是否因超过全量模式硬上限（allNodeLimit）被截断、退回分页。
   * 只有请求带 all=1 且过滤后节点数超限时才会为 true。
   */
  truncated?: boolean;
  /** 本次请求生效的全量模式节点硬上限（仅 all 模式返回，便于 UI 如实提示）。 */
  allNodeLimit?: number;
}

/** 本地图片资源清理报告。 */
export interface NoteAssetGcReport {
  scannedFiles: number;
  referencedFiles: number;
  deletedFiles: number;
  keptFiles: number;
  skippedRecent: number;
  bytesFreed: number;
}

/** 跨页引用：一端在当前页节点、另一端在页外（用于关系图分页时画出“出页/入页”虚线）。 */
export interface ReferenceGraphCrossEdge {
  from: string;
  to: string;
  /** 页外端点 id。 */
  externalId: string;
  /** 页外端点显示名，便于在边界标注。 */
  externalLabel: string;
  /** out = 当前页 → 页外；in = 页外 → 当前页。 */
  direction: 'out' | 'in';
}

/** 本地图片资源使用情况（设置页展示）。 */
export interface NoteAssetUsage {
  fileCount: number;
  totalBytes: number;
  /** 仍被未删除/已删除内容引用的文件数（按资源引用表）。 */
  referencedFiles: number;
  /** 无任何引用（孤儿）的文件数。 */
  orphanFiles: number;
  /** 上次清理完成时间（ISO 字符串；从未清理为空串）。 */
  lastGcAt: string;
  /** 仍被未删除笔记/批注引用的文件数。 */
  activeReferencedFiles: number;
  /** 只被已删除笔记/批注引用的文件数（取消保留后才会清理）。 */
  deletedReferencedFiles: number;
  /** 资源索引重建时间（首次启动迁移/重建；空串表示未记录）。 */
  indexedAt: string;
  /** 资源索引扫描到的文件数。 */
  indexedFiles: number;
  /** 资源索引建立的引用条数。 */
  indexedRefs: number;
}

/** 彻底删除笔记后的资源回收结果。 */
export interface NotePurgeResult {
  freedAssets: number;
  freedBytes: number;
}

/** 重建图片资源引用索引后的统计。 */
export interface NoteAssetReindexResult {
  indexedFiles: number;
  indexedRefs: number;
  indexedAt: string;
}

/** 图片资源索引重建任务（后台分块执行，供设置页显示进度）。 */
export interface NoteAssetReindexJob {
  status: 'idle' | 'running' | 'done' | 'error';
  phase: 'idle' | 'scanning' | 'notes' | 'annotations' | 'finalizing';
  total: number;
  done: number;
  indexedFiles: number;
  indexedRefs: number;
  indexedAt: string;
  error: string;
}

/** Markdown 库扫描结果：Markdown 笔记与附件清单。 */
export interface MarkdownVaultFile {
  /** 相对库根目录的路径（用 / 分隔）。 */
  relativePath: string;
  name: string;
  sizeBytes: number;
  modified: string;
}

export interface MarkdownVaultScan {
  vaultPath: string;
  vaultName: string;
  notes: MarkdownVaultFile[];
  attachments: MarkdownVaultFile[];
}

/** 单篇 Markdown 笔记导入结果。 */
export interface MarkdownImportItem {
  relativePath: string;
  status: 'imported' | 'updated' | 'skipped' | 'failed';
  noteId?: string;
  message?: string;
}

export interface MarkdownImportReport {
  vaultPath: string;
  requested: number;
  imported: number;
  updated: number;
  skipped: number;
  /** 其中因「已导入过」且 duplicatePolicy='skip' 而跳过的篇数（旧报告缺失时按 0 处理）。 */
  skippedExisting: number;
  failed: number;
  imagesCopied: number;
  linksRewritten: number;
  unresolvedLinks: number;
  skippedAttachments: number;
  attachmentsCopied: number;
  notes: MarkdownImportItem[];
  warnings: string[];
  /**
   * 非错误的处理提示（frontmatter 移除、模板占位未解析、重名附件按最近路径选择等）。
   * 与 warnings 分开：这些不意味着内容丢失，不应在界面上显示成需要核错的警告。
   * 旧报告没有该字段时按空数组处理。
   */
  notices?: string[];
  /** 本次导入中「附件重名、已按最近路径选择」的次数（详情见 notices）。 */
  duplicateAttachments?: number;
}

/**
 * Markdown 导入「重复检查」预览：按 externalKey（vault 绝对路径 hash + 规范化相对路径）
 * 判断哪些文件此前已导入，不能用文件名/标题判断（同名不同目录是不同笔记）。
 */
export interface MarkdownImportDuplicatePreview {
  /** 本次请求的文件总数（与导入接口的 requested 一致）。 */
  total: number;
  /** 已导入过的文件数（= items.length）。 */
  alreadyImported: number;
  /** 尚未导入、会新建的文件数。 */
  newCount: number;
  items: Array<{
    relativePath: string;
    noteId: string;
    title: string;
  }>;
}

/** Markdown 导入后台任务（扫描/导入/解析链接分块执行，可取消）。 */
export interface MarkdownImportJob {
  status: 'idle' | 'running' | 'done' | 'error' | 'cancelled' | 'interrupted';
  phase: 'idle' | 'scanning' | 'importing' | 'resolving' | 'finalizing';
  total: number;
  done: number;
  currentPath: string;
  report: MarkdownImportReport | null;
  error: string;
  /** 持久化后用于「重新开始上次导入」的参数；运行中/完成后保留。 */
  input?: { vaultPath: string; files: string[] } | null;
  /** 结果文件对应的上次成功完成时间；null 表示无成功结果。 */
  resultCompletedAt?: string | null;
  /** 结果是否早于最近一次尝试（失败/取消后仍显示旧成功结果）。 */
  resultStale?: boolean;
  /** 成功状态但结果文件缺失/损坏。 */
  resultMissing?: boolean;
  /** 最近一次尝试的终态（用于提示旧结果）。 */
  lastAttemptStatus?: 'done' | 'error' | 'cancelled' | 'interrupted' | 'running' | '';
}

/** 笔记文件夹（note_folders 中的虚拟目录，notes.folder_path 引用它）。 */
export interface NoteFolderRecord {
  path: string;
  noteCount: number;
  createdAt: string;
}

/** 后台扫描 Markdown 库任务（可取消；scan 为完成后的结果）。 */
export interface MarkdownScanJob {
  status: 'idle' | 'running' | 'done' | 'error' | 'cancelled' | 'interrupted';
  phase: 'idle' | 'scanning' | 'done';
  total: number;
  done: number;
  currentPath: string;
  scan: MarkdownVaultScan | null;
  error: string;
  /** 持久化后用于「重新开始上次扫描」的参数。 */
  input?: { vaultPath: string } | null;
  /** 结果文件对应的上次成功完成时间；null 表示无成功结果。 */
  resultCompletedAt?: string | null;
  /** 结果是否早于最近一次尝试（失败/取消后仍显示旧成功结果）。 */
  resultStale?: boolean;
  /** 成功状态但结果文件缺失/损坏。 */
  resultMissing?: boolean;
  /** 最近一次尝试的终态（用于提示旧结果）。 */
  lastAttemptStatus?: 'done' | 'error' | 'cancelled' | 'interrupted' | 'running' | '';
}

/** 文件夹重命名/删除的批量操作结果。 */
export interface NoteFolderOperationResult {
  ok: boolean;
  /** 移动/合并的未删除笔记数。 */
  movedNotes: number;
  /** 顺带移动的回收站笔记数（不计入 movedNotes）。 */
  movedDeletedNotes?: number;
  message?: string;
  /** 操作后的规范文件夹快照（用于前端精确替换缓存）。 */
  folders?: NoteFolderRecord[];
  /** 受影响的笔记及新路径（用于前端精确替换缓存）。 */
  notes?: Array<{ id: string; folderPath: string }>;
}

/** Markdown 后台任务实时快照（SSE）。 */
export interface MarkdownJobSnapshot {
  scanJob: MarkdownScanJob;
  importJob: MarkdownImportJob;
  /** true 表示只含进度摘要（无完整 scan/report），终态事件为完整快照。 */
  lite?: boolean;
  /** true 表示这是终态通知；客户端应调用 status 接口读取完整结果/input。 */
  terminal?: boolean;
}

/** 任务指纹输入：只取区分「某一次终态结果」所需的字段。 */
export interface MarkdownJobFingerprintInput {
  status: string;
  resultCompletedAt?: string | null;
  lastAttemptStatus?: string;
  error?: string;
}

/**
 * Markdown 扫描/导入任务指纹：UI 用它记住用户已关闭的终态任务，
 * 避免页面轮询/SSE/重新进入页面时把已关闭的终态卡片自动弹回。
 *
 * 同一任务的多次状态读取得到相同指纹；重新完成的扫描/导入（新的完成时间）
 * 或不同失败原因会得到不同指纹，因此新任务仍会正常显示。
 *
 * 注意：不包含 input/scan/report——lite 快照（SSE/摘要接口）为保证体积会裁掉这些字段，
 * 引用它们会让同一任务在完整状态与 lite 状态之间得到不同指纹。新任务观测到 running
 * 时 UI 会清除关闭标记，所以「发起新任务」不受影响。
 */
export function markdownJobFingerprint(job: MarkdownJobFingerprintInput): string {
  return [
    job.status,
    job.resultCompletedAt ?? '',
    job.lastAttemptStatus ?? '',
    job.error ?? ''
  ].join('|');
}

/** 扫描树懒加载节点（文件夹或文件）。 */
export interface MarkdownTreeEntry {
  path: string;
  name: string;
  kind: 'folder' | 'file';
  sizeBytes?: number;
  modified?: string;
  noteCount?: number;
  childCount?: number;
}

export interface MarkdownScanTreePage {
  vaultPath: string;
  parent: string;
  total: number;
  entries: MarkdownTreeEntry[];
}

/** 服务端解析“全选/文件夹选择/单文件”后的最终导入清单。 */
export interface MarkdownSelectionInput {
  vaultPath: string;
  all?: boolean;
  folders?: string[];
  files?: string[];
  excludedFolders?: string[];
  excludedFiles?: string[];
}

export interface MarkdownSelectionResult {
  files: string[];
  count: number;
  /** 请求中存在但扫描结果里找不到的路径（用于提示用户）。 */
  missingFiles?: string[];
}

/** 扫描结果服务端搜索（按路径/文件名）。 */
export interface MarkdownScanSearchResult {
  total: number;
  offset: number;
  limit: number;
  entries: MarkdownTreeEntry[];
}

/** 导入报告明细分页。 */
export interface MarkdownImportReportPage {
  total: number;
  offset: number;
  limit: number;
  items: MarkdownImportItem[];
}

// ---------------------------------------------------------------------------
// 文献内容块 / 章节识别（结构与内容块，供导航、引用锚定与问答索引使用）
//
// 这些类型是**识别结果**，不是原文证据本身：块的 `text` 来自版面上的同一段文字，
// 识别只是把它归入可引用的单位（章节 / 自然段 / 列表项 / 题注…），不新增原文内容。
// ---------------------------------------------------------------------------

/** 内容块类别。`heading` 之外的类目都带正文，可参与问答索引。 */
export type ContentBlockKind =
  | 'heading'
  | 'paragraph'
  | 'list'
  | 'caption'
  | 'table'
  | 'formula'
  | 'footnote'
  | 'reference';

export interface ContentBlock {
  /** 文档内稳定 id：按阅读顺序 `b{index}`；重算同一版面结果不变。 */
  id: string;
  page: number;
  kind: ContentBlockKind;
  /** 标题层级（1 起，数字小节号 `2.1` 为 2 级）；非标题块没有。 */
  level?: number;
  /** 所属章节下标（`DocumentBlocks.sections`）；前置部分为 -1。 */
  section: number;
  text: string;
  /** 归一化页面坐标 [x0, y0, x1, y1]，左上原点；多行块为外接框。 */
  bbox: [number, number, number, number];
  /** 组成这一块的行数（1 = 单行块）。 */
  lines: number;
}

export type DocumentSectionKind = 'front' | 'body' | 'abstract' | 'references' | 'appendix';

export interface DocumentSection {
  /** 下标 = 在 `sections` 数组中的位置。 */
  index: number;
  /** 标题文本；前置部分（封面/版权页等）为空字符串。 */
  title: string;
  /** 标题层级；前置部分为 0。 */
  level: number;
  kind: DocumentSectionKind;
  /** 标题来源：PDF 书签目录 / 版面标题规则。 */
  origin: 'outline' | 'heading';
  pageStart: number;
  pageEnd: number;
  /** 章节覆盖的块下标范围（闭区间）；空章节 blockStart > blockEnd。 */
  blockStart: number;
  blockEnd: number;
  parent: number | null;
}

export interface DocumentBlocksStats {
  pages: number;
  blocks: number;
  headings: number;
  paragraphs: number;
  lists: number;
  tables: number;
  captions: number;
  formulas: number;
  footnotes: number;
  references: number;
  sections: number;
  /** 章节边界的识别依据：PDF 目录 / 标题规则 / 没有可用章节（blocks 仍可用）。 */
  basis: 'outline' | 'heading' | 'none';
}

export interface DocumentBlocks {
  documentId: string;
  /** 章节按页码/块顺序排列；`index` 与数组下标一致。 */
  sections: DocumentSection[];
  /** 内容块按阅读顺序排列；`id` 稳定。 */
  blocks: ContentBlock[];
  stats: DocumentBlocksStats;
}

/** 章节级索引片段：把"章节标题 + 连续正文"作为问答检索单元，替代按行/页切碎。 */
export interface SectionIndexChunk {
  /** 稳定 id：`{documentId}:s{section}:{part}`。 */
  id: string;
  documentId: string;
  section: number;
  sectionTitle: string;
  level: number;
  /** 片段起始页。 */
  page: number;
  /** 片段结束页（跨页片段才有意义）。 */
  pageEnd: number;
  /** 片段正文（含章节标题前缀）。 */
  text: string;
  characters: number;
}

export interface DocumentSectionIndex {
  documentId: string;
  chunks: SectionIndexChunk[];
  totalCharacters: number;
  maxChunkCharacters: number;
}

// ---------------------------------------------------------------------------
// 参考文献识别（文末参考文献列表 + 页面底部脚注式引用）
//
// 识别结果用于阅读时"这条引用指的是哪篇文献"：条目的 `raw` 是原文条目文字，
// `authors/year/title/venue` 是尽力解析的结构化字段（可能为空），**不是**新的证据。
// ---------------------------------------------------------------------------

export interface ReferenceEntry {
  /** 文档内稳定 id：识别条目 `r{index}`；用户新增条目 `u{...}`。 */
  id: string;
  /** end=文末参考文献列表条目；footnote=页面底部的脚注式引用；manual=用户手动添加。 */
  kind: 'end' | 'footnote' | 'manual';
  /** 条目来源：识别得到 / 用户手动添加。 */
  source: 'recognized' | 'manual';
  /** 是否被用户编辑过（识别条目被覆盖时 true）。 */
  edited?: boolean;
  /** 规范化标签：数字条目为数字字符串（如 `3`），无编号时为空。 */
  label: string;
  /** 原文条目文字（未改动；用户编辑后是用户改后的文字）。 */
  raw: string;
  /** 解析到的作者（可能为空：识别不出就不猜）。 */
  authors: string;
  /** 解析到的年份（4 位；可能为空）。 */
  year: string;
  /** 解析到的标题（可能为空）。 */
  title: string;
  /** 解析到的期刊/出版社/会议等（可能为空）。 */
  venue: string;
  page: number;
  pageEnd: number;
  /** 条目所在内容块 id（`ContentBlock.id`）；手动条目为空。 */
  blockId: string;
  /** 条目所在块的归一化 bbox，用于跳转高亮；手动条目为整页。 */
  bbox: [number, number, number, number];
  /** 所属章节标题（文末列表通常是「参考文献」）。 */
  sectionTitle: string;
}

/** 用户编辑/新增参考文献条目的输入（缺省字段不改）。 */
export interface ReferenceEntryInput {
  label?: string;
  raw?: string;
  authors?: string;
  year?: string;
  title?: string;
  venue?: string;
  /** 手动条目的页码（默认 1）；手动条目没有版面位置，跳转按页。 */
  page?: number;
  /** 手动条目的类别，默认 end。 */
  kind?: 'end' | 'footnote' | 'manual';
}

export interface ReferenceCitation {
  page: number;
  /** 引用标记原文，如 `[1]`、`[1–3]`、`(Smith, 2020)`。 */
  text: string;
  /** 规范化标签（数字或 `surname year`）。 */
  label: string;
  /** 解析到的参考文献条目 id；解析不到时为空数组（不猜）。 */
  entryIds: string[];
  /** 引用所在内容块 id。 */
  blockId: string;
  /** 引用所在块 bbox，用于跳转高亮。 */
  bbox: [number, number, number, number];
}

export interface DocumentReferences {
  documentId: string;
  /** 识别缓存版本（文件 size/mtime + 页遮罩版本）；编辑只对同一版本生效。 */
  version: string;
  /** 文末 + 页下注 + 手动三类条目，按阅读顺序。 */
  entries: ReferenceEntry[];
  /** 页面内引用标记，按页码分组（JSON 对象键为页码字符串）。 */
  citations: Record<string, ReferenceCitation[]>;
  stats: {
    pages: number;
    endEntries: number;
    footnoteEntries: number;
    /** 用户手动添加的条目数。 */
    manualEntries: number;
    /** 被用户编辑过的识别条目数。 */
    editedEntries: number;
    citations: number;
    /** 能解析到条目的引用数。 */
    resolvedCitations: number;
    /** 解析不到条目的引用数（如实统计，不猜）。 */
    unresolvedCitations: number;
    /** 因识别版本变化而失效的用户编辑条数（失效编辑会被忽略并提示）。 */
    staleEdits: number;
  };
}

/**
 * 段落识别（内容块 / 章节识别与阅读区批注共用同一套版式规则）。
 *
 * 放在 shared 是为了让阅读器与 Core 对"同一段文字"的边界判断完全一致。
 */
export {
  paragraphAt,
  paragraphGroups,
  isHeadingLine,
  startsBlockLine,
  type ParagraphLine,
  type ParagraphResult,
  type ParagraphGroup
} from './paragraph.js';
