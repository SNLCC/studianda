import type {
  AnnotationRecord,
  ApiErrorBody,
  BacklinkRecord,
  BackupRecord,
  BackupVerification,
  BudgetEstimate,
  ChatMessageRecord,
  ChatRequest,
  ChatResponse,
  ChatSource,
  ClearUserDataResult,
  CreateAnnotationInput,
  CreateNoteInput,
  DocumentDetail,
  DocumentSummary,
  DocumentChatSessionRecord,
  DiagnosticsPackageRecord,
  DiagnosticsReport,
  EmbeddingIndexResult,
  EmbeddingStatus,
  FolderOverview,
  FolderSummary,
  FileHealthReport,
  BackupJobRecord,
  HealthResponse,
  ImportJobRecord,
  NoteAssetRecord,
  NoteAssetGcReport,
  NoteAssetUsage,
  NoteFolderOperationResult,
  NoteFolderRecord,
  MarkdownImportReport,
  MarkdownImportReportPage,
  MarkdownImportJob,
  MarkdownScanTreePage,
  MarkdownSelectionInput,
  MarkdownSelectionResult,
  MarkdownScanSearchResult,
  MarkdownJobSnapshot,
  MarkdownScanJob,
  MarkdownVaultScan,
  NoteAssetReindexJob,
  NoteAssetReindexResult,
  NotePurgeResult,
  ReferenceGraph,
  LegacyMigrationReport,
  MaintenanceStatus,
  ModelTestResult,
  ModelServicesConfig,
  ModelServicesImpact,
  MaskIndexStatus,
  RelinkResult,
  ModelServiceConnection,
  LibrarySearchHit,
  LibrarySearchKind,
  NavigationStatus,
  TocNavigationPreview,
  NavigationPreview,
  OcrPageResult,
  OcrJobRecord,
  OcrLanguageStatus,
  OutlineResult,
  RegionOcrResult,
  PageData,
  PageTextRecord,
  NoteRecord,
  PageMaskRecord,
  ParsingCheckResult,
  ParsingConfigRecord,
  ParsingConfigUpdate,
  PendingRestore,
  QaImportMessage,
  QaSessionDetail,
  QaSessionRecord,
  QaSessionSummary,
  QuoteLocation,
  ProviderPreset,
  DocumentChapters,
  DocumentBlocks,
  DocumentReferences,
  ReferenceEntryInput,
  DocumentSectionIndex,
  ReadingPlanRecord,
  ReadingTaskSummary,
  PlannedReadingPreview,
  SearchHit,
  SearchRequest,
  SettingsMap,
  StructureNode,
  TranslationConfigRecord,
  TranslationJobRecord,
  TranslationOverviewItem,
  TranslationProgress,
  TranslationServiceSummary,
  TranslationPagePayload,
  TranslationPageRecord,
  UpdateAnnotationInput,
  UpdateNoteInput,
  SearchConfigRecord,
  SearchResult,
  SearchPlan,
  SearchPlanRequest,
  SpeechConfigRecord,
  SpeechSystemStatus,
  SpeechTranscription,
  ZoteroConfigRecord,
  ZoteroCollection,
  ZoteroItem,
  ZoteroAnnotationImportReport,
  ZoteroProbeResult
} from '@studianda/shared';
import { API_PREFIX, TOKEN_HEADER } from '@studianda/shared';

// 兼容既有调用方：语音自检结果现在是 shared 的服务端契约，但仍从 api-client 转出，
// 避免所有消费方（当前是设置页）为了迁移类型而改 import。
export type { SpeechSystemStatus } from '@studianda/shared';

export interface ApiClientOptions {
  baseUrl: string;
  token: string;
}

export class ApiRequestError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly details?: unknown;

  constructor(status: number, message: string, code?: string, details?: unknown) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export interface ApiClient {
  health(): Promise<HealthResponse>;
  listDocuments(trash?: boolean): Promise<DocumentSummary[]>;
  getDocument(id: string): Promise<DocumentDetail>;
  importDocument(
    path: string,
    confirmLarge?: boolean,
    confirmDuplicate?: boolean
  ): Promise<DocumentDetail>;
  /** 启动后台导入任务；用 getDocumentImportJob 轮询进度。 */
  startDocumentImport(
    path: string,
    confirmLarge?: boolean,
    confirmDuplicate?: boolean
  ): Promise<{ jobId: string }>;
  getDocumentImportJob(id: string): Promise<ImportJobRecord>;
  /** 请求取消导入：解析阶段结束后、写库前生效。 */
  cancelDocumentImport(id: string): Promise<ImportJobRecord>;
  uploadDocument(
    file: Blob,
    filename: string,
    confirmLarge?: boolean,
    confirmDuplicate?: boolean
  ): Promise<DocumentDetail & { chunks?: number }>;
  relinkDocument(id: string, path: string, confirmLarge?: boolean): Promise<RelinkResult>;
  getDocumentFile(id: string): Promise<ArrayBuffer>;
  getDocumentFileSource(id: string): {
    url: string;
    httpHeaders: Record<string, string>;
  };
  updateDocument(
    id: string,
    input: {
      currentPage?: number;
      name?: string;
      /** 文献体裁（Zotero itemType 原文）；空串恢复未分类。 */
      docType?: string;
      /** 文件夹 id；空串移到未分类。 */
      folderId?: string;
    }
  ): Promise<DocumentDetail>;
  /** 文件夹：单层、单归属；未分类是 id='' 的虚拟集合。 */
  listFolders(): Promise<FolderOverview>;
  createFolder(name: string): Promise<FolderSummary>;
  renameFolder(id: string, name: string): Promise<FolderSummary>;
  deleteFolder(id: string): Promise<{ movedDocuments: number }>;
  /** 默认排序：把文献移动到 beforeId 与 afterId 之间（两者为当前显示顺序里的邻居，可空）。 */
  moveDocument(
    id: string,
    input: { beforeId?: string | null; afterId?: string | null }
  ): Promise<DocumentDetail>;
  /** 上传笔记/批注里粘贴或选择的本地图片，返回可写进 Markdown 的 studianda-asset 地址。 */
  uploadNoteAsset(input: { dataUrl: string; filename?: string }): Promise<NoteAssetRecord>;
  /** 反向链接：哪些笔记/批注引用了当前目标。 */
  listBacklinks(input: {
    kind: 'note' | 'annotation' | 'document';
    documentId: string;
    id?: string;
  }): Promise<BacklinkRecord[]>;
  /** 全库引用网络（关系图），支持按节点分页。 */
  getReferenceGraph(options?: { limit?: number; offset?: number }): Promise<ReferenceGraph>;
  /** 清理没有任何笔记/批注引用的本地图片资源；dryRun 只统计不删除。 */
  gcNoteAssets(dryRun?: boolean, includeDeleted?: boolean): Promise<NoteAssetGcReport>;
  /** 本地图片资源使用情况（文件数/占用/孤儿/上次清理）。 */
  getNoteAssetUsage(): Promise<NoteAssetUsage>;
  /** 彻底删除笔记（不可恢复）并回收其独占图片资源。 */
  purgeNote(id: string): Promise<NotePurgeResult>;
  /** 彻底删除批注（不可恢复）并回收其独占图片资源。 */
  purgeAnnotation(id: string): Promise<NotePurgeResult>;
  /** 从回收站恢复软删除的批注。 */
  restoreAnnotation(id: string): Promise<{ ok: boolean }>;
  /** 扫描 Markdown 库目录（Markdown/附件清单）。 */
  scanMarkdownVault(vaultPath: string): Promise<MarkdownVaultScan>;
  /** 后台扫描 Markdown 库（进度/取消）。 */
  startMarkdownScan(vaultPath: string): Promise<MarkdownScanJob>;
  /** 扫描树懒加载：按父目录分页读取子项。 */
  getMarkdownScanTree(
    vaultPath: string,
    parent: string,
    offset: number,
    limit: number
  ): Promise<MarkdownScanTreePage>;
  /** 服务端搜索扫描结果（路径/文件名，分页）。 */
  searchMarkdownScan(
    vaultPath: string,
    query: string,
    limit: number,
    offset?: number
  ): Promise<MarkdownScanSearchResult>;
  /** 服务端解析全选/文件夹/单文件选择，返回最终导入清单。 */
  resolveMarkdownSelection(input: MarkdownSelectionInput): Promise<MarkdownSelectionResult>;
  /** 导入报告明细分页。 */
  getMarkdownImportReportPage(offset: number, limit: number): Promise<MarkdownImportReportPage>;
  getMarkdownScanStatus(): Promise<MarkdownScanJob>;
  /** 任务摘要（lite，不含完整 scan/report），终态通知后使用。 */
  getMarkdownJobsSummary(): Promise<MarkdownJobSnapshot>;
  /** 一次读取扫描+导入完整状态（终态只需一个请求）。 */
  getMarkdownJobs(): Promise<MarkdownJobSnapshot>;
  cancelMarkdownScan(): Promise<MarkdownScanJob>;
  /** 订阅扫描/导入任务的实时快照（SSE；返回取消订阅函数）。lite 事件只含进度摘要。 */
  subscribeMarkdownJobs(
    handler: (snapshot: MarkdownJobSnapshot) => void,
    options?: {
      onError?: (error: Event) => void;
      onOpen?: () => void;
    }
  ): () => void;
  /** 笔记文件夹 CRUD。 */
  listNoteFolders(): Promise<NoteFolderRecord[]>;
  createNoteFolder(path: string): Promise<NoteFolderRecord>;
  renameNoteFolder(from: string, to: string): Promise<NoteFolderOperationResult>;
  deleteNoteFolder(path: string): Promise<NoteFolderOperationResult>;
  moveNoteToFolder(id: string, folderPath: string): Promise<{ ok: boolean }>;
  /** 笔记标签：列出全部标签 / 更新某条笔记标签。 */
  listNoteTags(): Promise<string[]>;
  setNoteTags(id: string, tags: string[]): Promise<{ ok: boolean; tags: string[] }>;
  /** 选择性导入 Markdown Markdown 笔记（复制引用图片、重写 wikilink、按外部 key 去重）。 */
  importMarkdownNotes(input: { vaultPath: string; files: string[] }): Promise<MarkdownImportReport>;
  /** 后台分块导入 Markdown（可进度/取消）。 */
  startMarkdownImport(input: {
    vaultPath: string;
    files: string[];
  }): Promise<MarkdownImportJob>;
  getMarkdownImportStatus(): Promise<MarkdownImportJob>;
  cancelMarkdownImport(): Promise<MarkdownImportJob>;
  /** 重新扫描所有笔记/批注内容，重建图片资源引用索引。 */
  reindexNoteAssets(): Promise<NoteAssetReindexResult>;
  /** 后台分块重建图片资源索引（带进度）。 */
  startNoteAssetReindex(): Promise<NoteAssetReindexJob>;
  getNoteAssetReindexStatus(): Promise<NoteAssetReindexJob>;
  deleteDocument(id: string): Promise<{ ok: boolean }>;
  exportDocument(id: string): Promise<string>;
  exportAnnotatedPdf(id: string): Promise<{
    bytes: ArrayBuffer;
    placed: number;
    unplaced: number;
  }>;
  restoreDocument(id: string): Promise<{ ok: boolean }>;
  purgeDocument(id: string, confirmName: string): Promise<{ ok: boolean }>;
  setDocumentTags(id: string, tags: string[]): Promise<{ ok: boolean; tags: string[] }>;
  setDocumentAuthor(id: string, author: string): Promise<DocumentDetail>;
  listAnnotations(documentId: string, trash?: boolean): Promise<AnnotationRecord[]>;
  createAnnotation(input: CreateAnnotationInput): Promise<AnnotationRecord>;
  updateAnnotation(id: string, input: UpdateAnnotationInput): Promise<AnnotationRecord>;
  deleteAnnotation(id: string): Promise<void>;
  listNotes(documentId: string, trash?: boolean): Promise<NoteRecord[]>;
  /** 独立笔记（不属于任何文献）：存于 notes.document_id=''；trash=true 查询回收站。 */
  listStandaloneNotes(trash?: boolean): Promise<NoteRecord[]>;
  createStandaloneNote(content: string): Promise<NoteRecord>;
  listMessages(documentId: string, sessionId?: string): Promise<ChatMessageRecord[]>;
  /** 阅读伙伴消息分页：最新一页；beforeId 往前翻。 */
  listMessagesPage(
    documentId: string,
    options?: { sessionId?: string; limit?: number; beforeId?: number }
  ): Promise<{ messages: ChatMessageRecord[]; hasMore: boolean }>;
  /** 打开文献后后台预热单篇检索索引（不阻塞界面，失败不影响提问）。 */
  prewarmRetrieval(documentId: string): Promise<{ ok: boolean }>;
  /** 阅读伙伴会话内搜索（词面匹配，返回命中片段）。 */
  searchDocumentMessages(
    documentId: string,
    options: { sessionId?: string; query: string; limit?: number }
  ): Promise<{
    matches: Array<{
      id: number;
      role: 'user' | 'assistant';
      content: string;
      snippet: string;
      created: string;
    }>;
    total: number;
  }>;
  /** 阅读伙伴按文献的会话清单（存本机 settings，随备份）。 */
  listDocumentChatSessions(documentId: string): Promise<DocumentChatSessionRecord[]>;
  saveDocumentChatSessions(
    documentId: string,
    sessions: DocumentChatSessionRecord[]
  ): Promise<DocumentChatSessionRecord[]>;
  createDocumentChatSession(
    documentId: string,
    session: DocumentChatSessionRecord
  ): Promise<DocumentChatSessionRecord>;
  updateDocumentChatSession(
    documentId: string,
    sessionId: string,
    patch: {
      title?: string;
      updated?: string;
      contextSummary?: string;
      summaryUpto?: number;
    }
  ): Promise<DocumentChatSessionRecord>;
  deleteDocumentChatSession(
    documentId: string,
    sessionId: string
  ): Promise<{ ok: boolean; removed: number; sessions: DocumentChatSessionRecord[] }>;
  addMessage(input: {
    documentId: string;
    role: 'user' | 'assistant';
    content: string;
    sources?: ChatSource[];
    metadata?: Record<string, unknown>;
  }): Promise<ChatMessageRecord>;
  /**
   * 阅读页「重新生成」：删除该文献「最后一条用户消息之后」的助手消息/失败记录（数据库内），
   * 返回最后一条用户消息正文；没有可重生成的轮次时 content 为 null。
   */
  rewindDocumentMessages(
    documentId: string,
    sessionId?: string
  ): Promise<{ ok: boolean; content: string | null; removed: number }>;
  /** 编辑阅读页一条用户消息并删除其后所有消息（随后由界面重问）；可按会话限定。 */
  editDocumentMessage(
    documentId: string,
    messageId: number,
    content: string,
    sessionId?: string
  ): Promise<{ ok: boolean; removed: number }>;
  /** 从阅读页某条消息起删除（该消息及其后全部）；可按会话限定。 */
  deleteDocumentMessagesFrom(
    documentId: string,
    messageId: number,
    sessionId?: string
  ): Promise<{ ok: boolean; removed: number }>;
  /** 编辑独立问答一条用户消息并删除其后所有消息（随后由界面重问）。 */
  editQaMessage(
    sessionId: string,
    messageId: number,
    content: string
  ): Promise<{ ok: boolean; removed: number }>;
  /** 从独立问答某条消息起删除（该消息及其后全部）。 */
  deleteQaMessagesFrom(
    sessionId: string,
    messageId: number
  ): Promise<{ ok: boolean; removed: number }>;
  /** 独立问答会话列表（按最近使用排序）；传 query 时按标题/消息内容做词面过滤。 */
  listQaSessions(query?: string): Promise<QaSessionSummary[]>;
  createQaSession(title?: string): Promise<QaSessionRecord>;
  /**
   * 打开一个独立问答会话：会话元数据 + 消息。
   * 传 `limit` 时只取最新一页（配合 `before` 加载更早），返回值带 `hasMore`。
   */
  getQaSession(
    id: string,
    options?: { limit?: number; before?: number }
  ): Promise<QaSessionDetail>;
  renameQaSession(id: string, title: string): Promise<QaSessionRecord>;
  /** 置顶/取消置顶独立问答会话（置顶会话排在列表最前）。 */
  setQaSessionPinned(id: string, pinned: boolean): Promise<QaSessionRecord>;
  deleteQaSession(id: string): Promise<{ ok: boolean }>;
  /** 迁移旧版 localStorage 问答历史：把旧消息一次性导进指定会话。 */
  importQaMessages(id: string, messages: QaImportMessage[]): Promise<QaSessionDetail>;
  listReadingTasks(documentId: string): Promise<ReadingTaskSummary[]>;
  createNote(input: CreateNoteInput): Promise<NoteRecord>;
  updateNote(id: string, input: UpdateNoteInput): Promise<NoteRecord>;
  deleteNote(id: string): Promise<void>;
  restoreNote(id: string): Promise<{ ok: boolean }>;
  listNavigation(
    documentId: string
  ): Promise<Array<{ page: number; kind: string; label: string }>>;
  getNavigationStatus(documentId: string): Promise<NavigationStatus>;
  saveNavigation(
    documentId: string,
    nodes: Array<{ page: number; label: string }>,
    options?: { materialize?: boolean }
  ): Promise<Array<{ page: number; kind: string; label: string }>>;
  listSections(documentId: string): Promise<Array<{ page: number; kind: string; label: string }>>;
  readSection(
    documentId: string,
    section: string,
    pages?: number[]
  ): Promise<{ pages: number[]; text: string }>;
  buildNavigation(
    documentId: string,
    options?: { rebuild?: boolean; tocPages?: number[] }
  ): Promise<NavigationStatus>;
  /** 预览「按目录页生成目录」：解析目录页并估计页码偏移，不保存。 */
  previewTocNavigation(documentId: string, tocPages: number[]): Promise<TocNavigationPreview>;
  setNavigationEnabled(documentId: string, enabled: boolean): Promise<NavigationStatus>;
  getStructure(documentId: string): Promise<StructureNode[]>;
  /** 内容块/章节识别（段落、标题、列表、题注、公式、脚注、参考文献）。 */
  getDocumentBlocks(documentId: string): Promise<DocumentBlocks>;
  /** 章节级问答索引片段（带章节标题与起止页）；索引材料，不作原文证据。 */
  getSectionIndex(
    documentId: string,
    options?: { maxChars?: number; overlap?: number }
  ): Promise<DocumentSectionIndex>;
  /** 参考文献识别（文末列表 + 页下注条目 + 页面内引用标记）。 */
  getReferences(documentId: string): Promise<DocumentReferences>;
  /** 修改一条参考文献（识别条目 → 覆盖；手动条目 → 合并）。 */
  updateReferenceEntry(
    documentId: string,
    entryId: string,
    patch: ReferenceEntryInput
  ): Promise<DocumentReferences>;
  /** 新增一条手动参考文献条目。 */
  addReferenceEntry(documentId: string, input: ReferenceEntryInput): Promise<DocumentReferences>;
  /** 删除一条参考文献（识别条目隐藏，手动条目移除）。 */
  deleteReferenceEntry(documentId: string, entryId: string): Promise<DocumentReferences>;
  /** 清空该文献的全部参考文献编辑，恢复自动识别结果。 */
  resetReferenceEdits(documentId: string): Promise<DocumentReferences>;
  /** 著作章节（目录派生）：用于界面选择"读哪一章"；目录不足时 available=false。 */
  getChapters(documentId: string): Promise<DocumentChapters>;
  /** 目录预览：前 120 条 + 截断标记 + 状态（完整列表仍走 getNavigation）。 */
  getNavigationPreview(documentId: string): Promise<NavigationPreview>;
  getVisualNodes(
    documentId: string
  ): Promise<Array<{ kind: string; page: number; caption: string }>>;
  locateQuote(documentId: string, page: number, quote: string): Promise<QuoteLocation>;
  listPageMasks(documentId: string): Promise<PageMaskRecord[]>;
  addPageMask(
    documentId: string,
    input: {
      page: number;
      scope?: 'page' | 'all' | 'odd' | 'even' | 'range' | 'exclude';
      rangeStart?: number;
      rangeEnd?: number;
      excludePages?: number[];
      x0: number;
      y0: number;
      x1: number;
      y1: number;
    }
  ): Promise<PageMaskRecord>;
  updatePageMask(
    documentId: string,
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
  ): Promise<PageMaskRecord>;
  deletePageMask(documentId: string, maskId: string): Promise<void>;
  /** 页遮罩重建索引的进度/状态（改规则后进度条与失败原因）。 */
  getMaskIndexStatus(documentId: string): Promise<MaskIndexStatus>;
  getSettings(): Promise<SettingsMap>;
  listProviders(): Promise<ProviderPreset[]>;
  getModelServices(): Promise<ModelServicesConfig>;
  getModelServicesImpact(connectionId: string): Promise<ModelServicesImpact>;
  getTokenizerStatus(): Promise<{
    configured: boolean;
    tokenizer_id: string;
    message: string;
  }>;
  importTokenizer(input: {
    data?: string;
    text?: string;
  }): Promise<{ tokenizer_id: string; message: string }>;
  updateModelServices(input: Partial<ModelServicesConfig>): Promise<
    ModelServicesConfig & {
      /** 删除连接时触发的降级清单（语音改回本机、视觉改回本机 OCR 等中文说明）。 */
      unbound?: Array<{ kind: string; label: string; result: string }>;
    }
  >;
  fetchModelServiceModels(connectionId: string): Promise<string[]>;
  /** 同一次 /models 调用，额外带平台元数据里的上下文窗口（没给的模型不出现在 metadata 里）。 */
  fetchConnectionModelsDetailed(connectionId: string): Promise<{
    models: string[];
    metadata: Record<
      string,
      {
        contextWindow?: number;
        capacitySource?: string;
        capabilities?: string[];
        source?: string;
        metadataUrl?: string;
      }
    >;
    /** 服务端把平台容量回写到已保存模型时，实际更新的模型数量（幂等：无变化为 0）。 */
    updated?: number;
    /** 实时列表失败时的中文说明；有值时 models 是“已保存模型 + 官方语音快照”。 */
    notice?: string;
  }>;
  listBackups(): Promise<BackupRecord[]>;
  createBackup(includeLogs?: boolean): Promise<{ backup: BackupRecord; files: number }>;
  verifyBackup(name: string): Promise<BackupVerification>;
  restoreBackup(name: string): Promise<{ marker: string; pending: PendingRestore }>;
  getDiagnostics(): Promise<DiagnosticsReport>;
  getMaintenanceStatus(): Promise<MaintenanceStatus>;
  /** 清空全部本地用户数据（文献、笔记、批注、会话、译文、索引、缓存、备份）；不可恢复。 */
  clearUserData(): Promise<ClearUserDataResult>;
  /** 文件健康检查：只 stat 文献文件是否存在，不读正文。 */
  getFileHealth(): Promise<FileHealthReport>;
  startBackupJob(includeLogs?: boolean): Promise<{ jobId: string }>;
  getBackupJob(id: string): Promise<BackupJobRecord>;
  cancelBackupJob(id: string): Promise<BackupJobRecord>;
  createDiagnosticsPackage(): Promise<{ path: string; name: string; bytes: number }>;
  listDiagnosticsPackages(): Promise<DiagnosticsPackageRecord[]>;
  testModel(): Promise<ModelTestResult>;
  getZoteroConfig(): Promise<ZoteroConfigRecord>;
  updateZoteroConfig(input: {
    mode?: 'local' | 'cloud' | 'webdav';
    library_type?: 'users' | 'groups';
    library_id?: string;
    webdav_url?: string;
    webdav_user?: string;
    api_key?: string;
    webdav_password?: string;
    clear_key?: boolean;
    clear_password?: boolean;
  }): Promise<ZoteroConfigRecord>;
  testZotero(): Promise<ZoteroProbeResult>;
  /** Zotero 只读诊断：连接模式、成功/失败原因与细节；不含任何密钥。 */
  diagnoseZotero(): Promise<{
    mode: 'local' | 'cloud' | 'webdav';
    mode_name: string;
    ok: boolean;
    message: string;
    detail: string[];
    suggested_library_id?: string;
  }>;
  listZoteroCollections(): Promise<ZoteroCollection[]>;
  listZoteroItems(collection?: string, start?: number, q?: string): Promise<ZoteroItem[]>;
  openZoteroItem(itemKey: string, confirmDuplicate?: boolean): Promise<DocumentDetail>;
  snapshotZoteroDocument(documentId: string): Promise<DocumentDetail>;
  previewZoteroAnnotations(documentId: string): Promise<ZoteroAnnotationImportReport>;
  importZoteroAnnotations(documentId: string): Promise<ZoteroAnnotationImportReport>;
  getSpeechConfig(): Promise<SpeechConfigRecord>;
  getSpeechVoices(options?: {
    connectionId?: string;
    model?: string;
  }): Promise<{
    voices: string[];
    labels?: Record<string, string>;
    message?: string;
    source?: string;
    metadata_url?: string;
  }>;
  getSpeechSystemStatus(): Promise<SpeechSystemStatus>;
  updateSpeechConfig(input: Partial<SpeechConfigRecord> & {
    asr_key?: string;
    tts_key?: string;
    clear_asr?: boolean;
    clear_tts?: boolean;
  }): Promise<SpeechConfigRecord>;
  speak(text: string): Promise<Blob>;
  transcribeAudio(audio: Blob, filename?: string): Promise<SpeechTranscription>;
  /** 语音转写纠错：只校正转写（同音字/断句/术语），失败时保留原文并 needs_review。 */
  correctSpeech(input: {
    documentId: string;
    page: number;
    text: string;
    history?: Array<{ question?: string; answer?: string }>;
  }): Promise<{ text: string; needs_review: boolean; corrected: boolean; reason?: string }>;
  getSearchConfig(): Promise<SearchConfigRecord>;
  updateSearchConfig(input: Partial<SearchConfigRecord> & {
    api_key?: string;
    clear_key?: boolean;
  }): Promise<SearchConfigRecord>;
  searchWeb(query: string): Promise<SearchResult[]>;
  /** 生成搜索计划：返回脱敏后的公共搜索词、审批要求与 warning（token 10 分钟有效）。 */
  createSearchPlan(input: SearchPlanRequest): Promise<SearchPlan>;
  getParsingConfig(): Promise<ParsingConfigRecord>;
  updateParsingConfig(input: ParsingConfigUpdate): Promise<ParsingConfigRecord>;
  /** 本机 Tesseract 语言包目录/安装状态/当前选择（不联网）。 */
  getOcrLanguages(): Promise<OcrLanguageStatus>;
  /** 显式触发后台下载语言包；立即返回 job.running=true 的状态，界面轮询 getOcrLanguages。 */
  downloadOcrLanguages(codes: string[]): Promise<OcrLanguageStatus>;
  checkParsing(): Promise<ParsingCheckResult>;
  recognizePage(documentId: string, page: number, scale?: number): Promise<OcrPageResult>;
  getOutline(documentId: string): Promise<OutlineResult>;
  recognizeRegion(
    documentId: string,
    page: number,
    region: { x0: number; y0: number; x1: number; y1: number }
  ): Promise<RegionOcrResult>;
  startOcrRegionJob(
    documentId: string,
    page: number,
    region: { x0: number; y0: number; x1: number; y1: number }
  ): Promise<{ jobId: string }>;
  getOcrRegionJob(documentId: string, jobId: string): Promise<OcrJobRecord>;
  cancelOcrRegionJob(documentId: string, jobId: string): Promise<OcrJobRecord>;
  getPageText(documentId: string, page: number): Promise<PageTextRecord>;
  /** 页数据：归一化行坐标 + 该页生效遮罩（文字层/高亮对齐用）。 */
  getPageData(documentId: string, page: number): Promise<PageData>;
  /** 页图 PNG（可请求缩小宽度；服务端只缩小不放大）。 */
  getPageImage(documentId: string, page: number, width?: number): Promise<Blob>;
  /** 缩略图 PNG（固定小宽度）。 */
  getThumbnail(documentId: string, page: number): Promise<Blob>;
  savePageText(
    documentId: string,
    page: number,
    text: string
  ): Promise<{ text: string; origin: string; boxes: string }>;
  listTranslationPages(documentId: string): Promise<TranslationPageRecord[]>;
  getTranslationPage(documentId: string, page: number): Promise<TranslationPagePayload>;
  translatePage(
    documentId: string,
    page: number,
    language?: string,
    force?: boolean,
    includeFurniture?: boolean
  ): Promise<TranslationPagePayload>;
  /** 单段重译：只送该段原文，更新该段后返回整页 payload。 */
  retranslateTranslationSegment(
    documentId: string,
    page: number,
    index: number,
    language?: string
  ): Promise<TranslationPagePayload>;
  /** 把译文里选中的一小段映射回原文（句级对齐优先）+ 原页 bbox；只读，不写库。 */
  anchorTranslationSelection(
    documentId: string,
    page: number,
    input: { excerpt: string; segment?: number }
  ): Promise<{
    quote: string;
    page: number;
    bbox: [number, number, number, number] | null;
    boxes: Array<{ bbox: [number, number, number, number]; text: string }>;
    exact: boolean;
    matched: boolean;
    located: boolean;
    fallback: boolean;
    segment?: number;
    source?: string;
    translated?: string;
    message?: string;
  }>;
  /** 按文字反查它属于哪一段译文（只读）。 */
  lookupTranslationSegments(
    documentId: string,
    page: number,
    quote: string
  ): Promise<
    Array<{ segment: number; source: string; text: string; match: 'source' | 'translation' }>
  >;
  getTranslationConfig(): Promise<TranslationConfigRecord>;
  /** 选文翻译：只翻选中的文本，不落库、不保存设置。 */
  translateQuote(input: { text: string; language?: string }): Promise<{
    source: string;
    text: string;
    engine: string;
    service: string;
    target_language: string;
    saved: false;
  }>;
  /** 试译一句：只发示例文本，不发送文献内容；无配置时 ok=false + reason。 */
  probeTranslation(text?: string): Promise<{
    ok: boolean;
    source: string;
    text: string;
    engine: string;
    service: string;
    target_language: string;
    saved: false;
    reason?: string;
    message?: string;
  }>;
  updateTranslationConfig(input: {
    target_language?: string;
  }): Promise<TranslationConfigRecord>;
  getTranslationJob(documentId: string): Promise<TranslationJobRecord>;
  getTranslationSummary(documentId: string): Promise<TranslationServiceSummary>;
  getTranslationProgress(documentId: string): Promise<TranslationProgress>;
  getTranslationOverview(documentIds: string[]): Promise<TranslationOverviewItem[]>;
  getAnnotationTranslations(documentId: string): Promise<AnnotationRecord[]>;
  startTranslation(
    documentId: string,
    input?: {
      pages?: number[];
      language?: string;
      force?: boolean;
      includeFurniture?: boolean;
    }
  ): Promise<TranslationJobRecord>;
  stopTranslation(documentId: string): Promise<TranslationJobRecord>;
  editTranslationSegment(
    documentId: string,
    segmentId: string,
    text: string
  ): Promise<{ ok: true; id: string }>;
  restoreTranslationSegment(
    documentId: string,
    segmentId: string
  ): Promise<{ ok: true; restored: boolean; message?: string }>;
  updateSettings(patch: SettingsMap): Promise<SettingsMap>;
  search(
    query: string,
    documentId?: string,
    page?: number,
    mode?: 'close' | 'wide'
  ): Promise<SearchHit[]>;
  searchScoped(request: SearchRequest): Promise<SearchHit[]>;
  searchLibrary(query: string, kinds: LibrarySearchKind[]): Promise<LibrarySearchHit[]>;
  /** 命中检索条件的文献 id（文献工作台的搜索过滤用）。 */
  searchLibraryDocuments(query: string, kinds: LibrarySearchKind[]): Promise<string[]>;
  ask(input: ChatRequest, signal?: AbortSignal): Promise<ChatResponse>;
  estimateBudget(input: {
    question: string;
    documentId: string;
    selection?: string;
  }): Promise<BudgetEstimate>;
  askStream(
    input: ChatRequest,
    options?: {
      signal?: AbortSignal;
      onProgress?(done: number, total: number): void;
      onDraft?(text: string): void;
      onDraftReset?(): void;
      onStage?(text: string): void;
      onAudit?(claims: unknown[]): void;
    }
  ): Promise<ChatResponse>;
  plan(question: string, selection?: string): Promise<ReadingPlanRecord>;
  plan(question: string, selection?: string): Promise<ReadingPlanRecord>;
  planReading(input: {
    question: string;
    documentId: string;
    selection?: string;
    page?: number;
    budget?: number;
    overlap?: number;
  }): Promise<PlannedReadingPreview>;
  getEmbeddingStatus(): Promise<EmbeddingStatus>;
  indexEmbeddings(documentId?: string): Promise<EmbeddingIndexResult>;
  migrateLegacy(legacyDir: string): Promise<LegacyMigrationReport>;
}

async function readJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  const body = text ? (JSON.parse(text) as T | ApiErrorBody) : null;
  if (!response.ok) {
    const error = body as ApiErrorBody | null;
    throw new ApiRequestError(
      response.status,
      error?.message ?? error?.error ?? `HTTP ${response.status}`,
      error?.error,
      error?.details
    );
  }
  return body as T;
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  // base 统一带上 API 前缀：下面所有路径都不再硬编码 ``。
  const base = `${options.baseUrl.replace(/\/+$/, '')}${API_PREFIX}`;
  const headers = { [TOKEN_HEADER]: options.token };

  const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const response = await fetch(`${base}${path}`, {
      ...init,
      headers: { ...headers, ...(init?.body ? { 'content-type': 'application/json' } : {}) }
    });
    return readJson<T>(response);
  };

  /** GET 任务状态的有限重试：网络错误/5xx/截断 gzip 时重试，4xx 不重试。 */
  const requestRetry = async <T>(
    path: string,
    attempts = 3
  ): Promise<T> => {
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return await request<T>(path);
      } catch (error) {
        lastError = error;
        if (error instanceof ApiRequestError && error.status < 500) throw error;
        if (attempt < attempts - 1) {
          await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
        }
      }
    }
    throw lastError;
  };

  /** 二进制下载（页图/缩略图）：错误响应仍是 JSON，按 ApiRequestError 抛出。 */
  const requestBlob = async (path: string): Promise<Blob> => {
    const response = await fetch(`${base}${path}`, { headers });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      let payload: ApiErrorBody | null = null;
      try {
        payload = text ? (JSON.parse(text) as ApiErrorBody) : null;
      } catch {
        payload = null;
      }
      throw new ApiRequestError(
        response.status,
        (payload?.message ?? payload?.error ?? text) || `HTTP ${response.status}`,
        payload?.error,
        payload?.details
      );
    }
    return response.blob();
  };

  return {
    health: () => request<HealthResponse>('/health'),

    listDocuments: (trash) =>
      request<DocumentSummary[]>(`/documents${trash ? '?trash=true' : ''}`),

    getDocument: (id) => request<DocumentDetail>(`/documents/${encodeURIComponent(id)}`),

    importDocument: (path, confirmLarge = false, confirmDuplicate = false) =>
      request<DocumentDetail>('/documents/import', {
        method: 'POST',
        body: JSON.stringify({ path, confirmLarge, confirmDuplicate })
      }),

    startDocumentImport: (path, confirmLarge = false, confirmDuplicate = false) =>
      request<{ jobId: string }>('/documents/import/start', {
        method: 'POST',
        body: JSON.stringify({ path, confirmLarge, confirmDuplicate })
      }),

    getDocumentImportJob: (id) =>
      request<ImportJobRecord>(`/documents/import/jobs/${encodeURIComponent(id)}`),

    cancelDocumentImport: (id) =>
      request<ImportJobRecord>(`/documents/import/jobs/${encodeURIComponent(id)}/cancel`, {
        method: 'POST'
      }),

    async uploadDocument(file, filename, confirmLarge = false, confirmDuplicate = false) {
      const form = new FormData();
      form.append('file', file, filename);
      const response = await fetch(`${base}/documents`, {
        method: 'POST',
        headers: {
          ...headers,
          ...(confirmLarge ? { 'x-studianda-confirm-large': 'true' } : {}),
          ...(confirmDuplicate ? { 'x-studianda-confirm-duplicate': 'true' } : {})
        },
        body: form
      });
      return readJson<DocumentDetail & { chunks?: number }>(response);
    },

    relinkDocument: (id, path, confirmLarge = false) =>
      request<RelinkResult>(`/documents/${encodeURIComponent(id)}/relink`, {
        method: 'POST',
        body: JSON.stringify({ path, confirmLarge })
      }),

    getDocumentFileSource: (id) => ({
      url: `${base}/documents/${encodeURIComponent(id)}/file`,
      httpHeaders: headers
    }),

    async getDocumentFile(id) {
      const response = await fetch(`${base}/documents/${encodeURIComponent(id)}/file`, {
        headers
      });
      if (!response.ok) {
        const text = await response.text();
        let message = `HTTP ${response.status}`;
        try {
          const body = JSON.parse(text) as ApiErrorBody;
          message = body.message ?? body.error ?? message;
        } catch {
          // 保持 HTTP 状态码
        }
        throw new Error(message);
      }
      return response.arrayBuffer();
    },

    updateDocument: (id, input) =>
      request<DocumentDetail>(`/documents/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify(input)
      }),

    listFolders: () => request<FolderOverview>('/folders'),

    createFolder: (name) =>
      request<FolderSummary>('/folders', {
        method: 'POST',
        body: JSON.stringify({ name })
      }),

    renameFolder: (id, name) =>
      request<FolderSummary>(`/folders/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ name })
      }),

    deleteFolder: (id) =>
      request<{ movedDocuments: number }>(`/folders/${encodeURIComponent(id)}`, {
        method: 'DELETE'
      }),

    moveDocument: (id, input) =>
      request<DocumentDetail>(`/documents/${encodeURIComponent(id)}/move`, {
        method: 'POST',
        body: JSON.stringify(input)
      }),

    uploadNoteAsset: (input) =>
      request<NoteAssetRecord>('/note-assets', {
        method: 'POST',
        body: JSON.stringify(input)
      }),

    listBacklinks: (input) => {
      const query = new URLSearchParams({
        kind: input.kind,
        documentId: input.documentId
      });
      if (input.id) query.set('id', input.id);
      return request<BacklinkRecord[]>(`/backlinks?${query.toString()}`);
    },

    getReferenceGraph: (options) => {
      const query = new URLSearchParams();
      if (typeof options?.limit === 'number') query.set('limit', String(options.limit));
      if (typeof options?.offset === 'number') query.set('offset', String(options.offset));
      const suffix = query.toString() ? `?${query.toString()}` : '';
      return request<ReferenceGraph>(`/reference-graph${suffix}`);
    },

    gcNoteAssets: (dryRun = false, includeDeleted = false) =>
      request<NoteAssetGcReport>('/note-assets/gc', {
        method: 'POST',
        body: JSON.stringify({ dryRun, includeDeleted })
      }),

    getNoteAssetUsage: () => request<NoteAssetUsage>('/note-assets/usage'),

    purgeNote: (id) =>
      request<NotePurgeResult>(`/notes/${encodeURIComponent(id)}/purge`, {
        method: 'DELETE'
      }),

    purgeAnnotation: (id) =>
      request<NotePurgeResult>(`/annotations/${encodeURIComponent(id)}/purge`, {
        method: 'DELETE'
      }),

    restoreAnnotation: (id) =>
      request<{ ok: boolean }>(`/annotations/${encodeURIComponent(id)}/restore`, {
        method: 'POST'
      }),

    scanMarkdownVault: (vaultPath) =>
      request<MarkdownVaultScan>('/markdown/scan', {
        method: 'POST',
        body: JSON.stringify({ vaultPath })
      }),

    startMarkdownScan: (vaultPath) =>
      request<MarkdownScanJob>('/markdown/scan/start', {
        method: 'POST',
        body: JSON.stringify({ vaultPath })
      }),

    getMarkdownScanStatus: () => requestRetry<MarkdownScanJob>('/markdown/scan/status'),

    getMarkdownJobsSummary: () =>
      requestRetry<MarkdownJobSnapshot>('/markdown/jobs?summary=1'),

    getMarkdownScanTree: (vaultPath, parent, offset, limit) =>
      request<MarkdownScanTreePage>(
        `/markdown/scan/tree?vaultPath=${encodeURIComponent(
          vaultPath
        )}&parent=${encodeURIComponent(parent)}&offset=${offset}&limit=${limit}`
      ),

    resolveMarkdownSelection: (input) =>
      request<MarkdownSelectionResult>('/markdown/selection/resolve', {
        method: 'POST',
        body: JSON.stringify(input)
      }),

    searchMarkdownScan: (vaultPath, query, limit, offset = 0) =>
      request<MarkdownScanSearchResult>(
        `/markdown/scan/search?vaultPath=${encodeURIComponent(
          vaultPath
        )}&q=${encodeURIComponent(query)}&limit=${limit}&offset=${offset}`
      ),

    getMarkdownImportReportPage: (offset, limit) =>
      request<MarkdownImportReportPage>(
        `/markdown/import/report?offset=${offset}&limit=${limit}`
      ),

    getMarkdownJobs: () => requestRetry<MarkdownJobSnapshot>('/markdown/jobs'),

    cancelMarkdownScan: () =>
      request<MarkdownScanJob>('/markdown/scan/cancel', { method: 'POST' }),

    subscribeMarkdownJobs: (handler, eventOptions) => {
      if (typeof EventSource === 'undefined') {
        try {
          eventOptions?.onError?.(new Event('error'));
        } catch {
          // 忽略环境异常
        }
        return () => undefined;
      }
      const source = new EventSource(
        `${base}/markdown/events?token=${encodeURIComponent(options.token)}`
      );
      source.onopen = () => eventOptions?.onOpen?.();
      source.onerror = (event) => eventOptions?.onError?.(event);
      source.onmessage = (event) => {
        try {
          handler(JSON.parse(event.data) as MarkdownJobSnapshot);
        } catch {
          // 忽略单条损坏事件
        }
      };
      return () => source.close();
    },

    listNoteFolders: () => request<NoteFolderRecord[]>('/notes/folders'),

    createNoteFolder: (path) =>
      request<NoteFolderRecord>('/notes/folders', {
        method: 'POST',
        body: JSON.stringify({ path })
      }),

    renameNoteFolder: (from, to) =>
      request<NoteFolderOperationResult>('/notes/folders/rename', {
        method: 'POST',
        body: JSON.stringify({ from, to })
      }),

    deleteNoteFolder: (path) =>
      request<NoteFolderOperationResult>(
        `/notes/folders?path=${encodeURIComponent(path)}`,
        { method: 'DELETE' }
      ),

    moveNoteToFolder: (id, folderPath) =>
      request<{ ok: boolean }>(`/notes/${encodeURIComponent(id)}/folder`, {
        method: 'PATCH',
        body: JSON.stringify({ folderPath })
      }),

    listNoteTags: () => request<string[]>('/notes/tags'),

    setNoteTags: (id, tags) =>
      request<{ ok: boolean; tags: string[] }>(`/notes/${encodeURIComponent(id)}/tags`, {
        method: 'PUT',
        body: JSON.stringify({ tags })
      }),

    importMarkdownNotes: (input) =>
      request<MarkdownImportReport>('/markdown/import', {
        method: 'POST',
        body: JSON.stringify(input)
      }),

    startMarkdownImport: (input) =>
      request<MarkdownImportJob>('/markdown/import/start', {
        method: 'POST',
        body: JSON.stringify(input)
      }),

    getMarkdownImportStatus: () =>
      requestRetry<MarkdownImportJob>('/markdown/import/status'),

    cancelMarkdownImport: () =>
      request<MarkdownImportJob>('/markdown/import/cancel', {
        method: 'POST'
      }),

    reindexNoteAssets: () =>
      request<NoteAssetReindexResult>('/note-assets/reindex', {
        method: 'POST'
      }),

    startNoteAssetReindex: () =>
      request<NoteAssetReindexJob>('/note-assets/reindex/start', {
        method: 'POST'
      }),

    getNoteAssetReindexStatus: () =>
      request<NoteAssetReindexJob>('/note-assets/reindex/status'),

    deleteDocument: (id) =>
      request<{ ok: boolean }>(`/documents/${encodeURIComponent(id)}`, {
        method: 'DELETE'
      }),

    async exportDocument(id) {
      const response = await fetch(`${base}/documents/${encodeURIComponent(id)}/export`, {
        headers
      });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(text || `HTTP ${response.status}`);
      }
      return response.text();
    },

    async exportAnnotatedPdf(id) {
      const response = await fetch(
        `${base}/documents/${encodeURIComponent(id)}/annotated.pdf`,
        { headers }
      );
      if (!response.ok) {
        const text = await response.text();
        throw new Error(text || `HTTP ${response.status}`);
      }
      return {
        bytes: await response.arrayBuffer(),
        placed: Number(response.headers.get('x-studianda-placed') ?? 0),
        unplaced: Number(response.headers.get('x-studianda-unplaced') ?? 0)
      };
    },

    restoreDocument: (id) =>
      request<{ ok: boolean }>(`/documents/${encodeURIComponent(id)}/restore`, {
        method: 'POST'
      }),

    purgeDocument: (id, confirmName) =>
      request<{ ok: boolean }>(`/documents/${encodeURIComponent(id)}/purge`, {
        method: 'POST',
        body: JSON.stringify({ confirmName })
      }),

    setDocumentTags: (id, tags) =>
      request<{ ok: boolean; tags: string[] }>(
        `/documents/${encodeURIComponent(id)}/tags`,
        { method: 'PUT', body: JSON.stringify({ tags }) }
      ),

    setDocumentAuthor: (id, author) =>
      request<DocumentDetail>(`/documents/${encodeURIComponent(id)}/author`, {
        method: 'PUT',
        body: JSON.stringify({ author })
      }),

    listAnnotations: (documentId, trash = false) =>
      request<AnnotationRecord[]>(
        `/documents/${encodeURIComponent(documentId)}/annotations${trash ? '?trash=true' : ''}`
      ),

    createAnnotation: (input) =>
      request<AnnotationRecord>('/annotations', {
        method: 'POST',
        body: JSON.stringify(input)
      }),

    updateAnnotation: (id, input) =>
      request<AnnotationRecord>(`/annotations/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify(input)
      }),

    async deleteAnnotation(id) {
      const response = await fetch(`${base}/annotations/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers
      });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(text || `HTTP ${response.status}`);
      }
    },

    listNotes: (documentId, trash = false) =>
      request<NoteRecord[]>(
        `/documents/${encodeURIComponent(documentId)}/notes${trash ? '?trash=true' : ''}`
      ),

    listStandaloneNotes: (trash = false) =>
      request<NoteRecord[]>(`/notes/standalone${trash ? '?trash=true' : ''}`),

    createStandaloneNote: (content) =>
      request<NoteRecord>('/notes', {
        method: 'POST',
        body: JSON.stringify({ documentId: '', page: 0, content })
      }),

    listMessages: (documentId, sessionId) =>
      request<ChatMessageRecord[]>(
        `/documents/${encodeURIComponent(documentId)}/messages${
          sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''
        }`
      ),

    listMessagesPage: (documentId, options = {}) => {
      const params = new URLSearchParams();
      if (options.sessionId) params.set('sessionId', options.sessionId);
      if (options.limit) params.set('limit', String(options.limit));
      if (options.beforeId) params.set('before', String(options.beforeId));
      const suffix = params.toString() ? `?${params.toString()}` : '';
      return request<{ messages: ChatMessageRecord[]; hasMore: boolean }>(
        `/documents/${encodeURIComponent(documentId)}/messages/page${suffix}`
      );
    },

    prewarmRetrieval: (documentId) =>
      request<{ ok: boolean }>(
        `/documents/${encodeURIComponent(documentId)}/retrieval/prewarm`,
        { method: 'POST', body: JSON.stringify({}) }
      ),

    searchDocumentMessages: (documentId, options) => {
      const params = new URLSearchParams();
      if (options.sessionId) params.set('sessionId', options.sessionId);
      params.set('q', options.query);
      if (options.limit) params.set('limit', String(options.limit));
      return request<{
        matches: Array<{
          id: number;
          role: 'user' | 'assistant';
          content: string;
          snippet: string;
          created: string;
        }>;
        total: number;
      }>(
        `/documents/${encodeURIComponent(documentId)}/messages/search?${params.toString()}`
      );
    },

    listDocumentChatSessions: (documentId) =>
      request<{ sessions: DocumentChatSessionRecord[] }>(
        `/documents/${encodeURIComponent(documentId)}/chat-sessions`
      ).then((payload) => payload.sessions ?? []),

    saveDocumentChatSessions: (documentId, sessions) =>
      request<{ sessions: DocumentChatSessionRecord[] }>(
        `/documents/${encodeURIComponent(documentId)}/chat-sessions`,
        { method: 'PUT', body: JSON.stringify({ sessions }) }
      ).then((payload) => payload.sessions ?? []),

    createDocumentChatSession: (documentId, session) =>
      request<DocumentChatSessionRecord>(
        `/documents/${encodeURIComponent(documentId)}/chat-sessions`,
        { method: 'POST', body: JSON.stringify({ session }) }
      ),

    updateDocumentChatSession: (documentId, sessionId, patch) =>
      request<DocumentChatSessionRecord>(
        `/documents/${encodeURIComponent(documentId)}/chat-sessions/${encodeURIComponent(
          sessionId
        )}`,
        { method: 'PATCH', body: JSON.stringify(patch) }
      ),

    deleteDocumentChatSession: (documentId, sessionId) =>
      request<{ ok: boolean; removed: number; sessions: DocumentChatSessionRecord[] }>(
        `/documents/${encodeURIComponent(documentId)}/chat-sessions/${encodeURIComponent(
          sessionId
        )}`,
        { method: 'DELETE', body: JSON.stringify({}) }
      ),

    addMessage: (input) =>
      request<ChatMessageRecord>(
        `/documents/${encodeURIComponent(input.documentId)}/messages`,
        {
          method: 'POST',
          body: JSON.stringify({
            role: input.role,
            content: input.content,
            sources: input.sources ?? [],
            metadata: input.metadata ?? {}
          })
        }
      ),

    rewindDocumentMessages: (documentId, sessionId) =>
      request<{ ok: boolean; content: string | null; removed: number }>(
        `/documents/${encodeURIComponent(documentId)}/messages/rewind`,
        { method: 'POST', body: JSON.stringify({ sessionId: sessionId ?? '' }) }
      ),

    editDocumentMessage: (documentId, messageId, content, sessionId) =>
      request<{ ok: boolean; removed: number }>(
        `/documents/${encodeURIComponent(documentId)}/messages/${encodeURIComponent(
          String(messageId)
        )}`,
        {
          method: 'PATCH',
          body: JSON.stringify({ content, sessionId: sessionId ?? '' })
        }
      ),

    async deleteDocumentMessagesFrom(documentId, messageId, sessionId) {
      return request<{ ok: boolean; removed: number }>(
        `/documents/${encodeURIComponent(documentId)}/messages/${encodeURIComponent(
          String(messageId)
        )}`,
        {
          method: 'DELETE',
          body: JSON.stringify({ sessionId: sessionId ?? '' })
        }
      );
    },

    editQaMessage: (sessionId, messageId, content) =>
      request<{ ok: boolean; removed: number }>(
        `/qa/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(
          String(messageId)
        )}`,
        { method: 'PATCH', body: JSON.stringify({ content }) }
      ),

    async deleteQaMessagesFrom(sessionId, messageId) {
      return request<{ ok: boolean; removed: number }>(
        `/qa/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(
          String(messageId)
        )}`,
        { method: 'DELETE', body: JSON.stringify({}) }
      );
    },

    listReadingTasks: (documentId) =>
      request<ReadingTaskSummary[]>(
        `/documents/${encodeURIComponent(documentId)}/reading-tasks`
      ),

    listQaSessions: (query) =>
      request<QaSessionSummary[]>(
        `/qa/sessions${query?.trim() ? `?q=${encodeURIComponent(query.trim())}` : ''}`
      ),

    createQaSession: (title) =>
      request<QaSessionRecord>('/qa/sessions', {
        method: 'POST',
        body: JSON.stringify({ title: title ?? '' })
      }),

    getQaSession: (id, options) => {
      const params = new URLSearchParams();
      if (options?.limit && Number.isInteger(options.limit) && options.limit > 0) {
        params.set('limit', String(options.limit));
      }
      if (options?.before && Number.isInteger(options.before) && options.before > 0) {
        params.set('before', String(options.before));
      }
      const query = params.toString();
      return request<QaSessionDetail>(
        `/qa/sessions/${encodeURIComponent(id)}${query ? `?${query}` : ''}`
      );
    },

    renameQaSession: (id, title) =>
      request<QaSessionRecord>(`/qa/sessions/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ title })
      }),

    setQaSessionPinned: (id, pinned) =>
      request<QaSessionRecord>(`/qa/sessions/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ pinned })
      }),

    async deleteQaSession(id) {
      return request<{ ok: boolean }>(`/qa/sessions/${encodeURIComponent(id)}`, {
        method: 'DELETE'
      });
    },

    importQaMessages: (id, messages) =>
      request<QaSessionDetail>(`/qa/sessions/${encodeURIComponent(id)}/import`, {
        method: 'POST',
        body: JSON.stringify({ messages })
      }),

    createNote: (input) =>
      request<NoteRecord>('/notes', {
        method: 'POST',
        body: JSON.stringify(input)
      }),

    updateNote: (id, input) =>
      request<NoteRecord>(`/notes/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify(input)
      }),

    async deleteNote(id) {
      const response = await fetch(`${base}/notes/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers
      });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(text || `HTTP ${response.status}`);
      }
    },

    restoreNote: (id) =>
      request<{ ok: boolean }>(`/notes/${encodeURIComponent(id)}/restore`, {
        method: 'POST'
      }),

    listNavigation: (documentId) =>
      request<Array<{ page: number; kind: string; label: string }>>(
        `/documents/${encodeURIComponent(documentId)}/navigation`
      ),

    getNavigationStatus: (documentId) =>
      request<NavigationStatus>(
        `/documents/${encodeURIComponent(documentId)}/navigation/status`
      ),

    listSections: (documentId) =>
      request<Array<{ page: number; kind: string; label: string }>>(
        `/documents/${encodeURIComponent(documentId)}/sections`
      ),

    saveNavigation: (documentId, nodes, options) =>
      request<Array<{ page: number; kind: string; label: string }>>(
        `/documents/${encodeURIComponent(documentId)}/navigation/entries`,
        {
          method: 'POST',
          body: JSON.stringify({
            nodes,
            ...(options?.materialize ? { source: 'materialize' } : {})
          })
        }
      ),

    readSection: (documentId, section, pages) =>
      request<{ pages: number[]; text: string }>(
        `/documents/${encodeURIComponent(documentId)}/sections/read`,
        {
          method: 'POST',
          body: JSON.stringify({ section, pages })
        }
      ),

    buildNavigation: (documentId, options) =>
      request<NavigationStatus>(
        `/documents/${encodeURIComponent(documentId)}/navigation`,
        {
          method: 'POST',
          body: JSON.stringify({
            ...(options?.rebuild !== undefined ? { rebuild: options.rebuild } : {}),
            ...(options?.tocPages !== undefined ? { toc_pages: options.tocPages } : {})
          })
        }
      ),

    previewTocNavigation: (documentId, tocPages) =>
      request<TocNavigationPreview>(
        `/documents/${encodeURIComponent(documentId)}/navigation/toc-preview`,
        { method: 'POST', body: JSON.stringify({ toc_pages: tocPages }) }
      ),

    setNavigationEnabled: (documentId, enabled) =>
      request<NavigationStatus>(
        `/documents/${encodeURIComponent(documentId)}/navigation/enabled`,
        { method: 'PUT', body: JSON.stringify({ enabled }) }
      ),

    getReferences: (documentId) =>
      request<DocumentReferences>(
        `/documents/${encodeURIComponent(documentId)}/references`
      ),

    updateReferenceEntry: (documentId, entryId, patch) =>
      request<DocumentReferences>(
        `/documents/${encodeURIComponent(documentId)}/references/entries/${encodeURIComponent(entryId)}`,
        { method: 'PUT', body: JSON.stringify(patch) }
      ),

    addReferenceEntry: (documentId, input) =>
      request<DocumentReferences>(
        `/documents/${encodeURIComponent(documentId)}/references/entries`,
        { method: 'POST', body: JSON.stringify(input) }
      ),

    deleteReferenceEntry: (documentId, entryId) =>
      request<DocumentReferences>(
        `/documents/${encodeURIComponent(documentId)}/references/entries/${encodeURIComponent(entryId)}`,
        { method: 'DELETE' }
      ),

    resetReferenceEdits: (documentId) =>
      request<DocumentReferences>(
        `/documents/${encodeURIComponent(documentId)}/references/reset`,
        { method: 'POST' }
      ),

    getStructure: (documentId) =>
      request<StructureNode[]>(
        `/documents/${encodeURIComponent(documentId)}/structure`
      ),

    getDocumentBlocks: (documentId) =>
      request<DocumentBlocks>(
        `/documents/${encodeURIComponent(documentId)}/blocks`
      ),

    getSectionIndex: (documentId, options) => {
      const params = new URLSearchParams();
      if (options?.maxChars !== undefined) params.set('max_chars', String(options.maxChars));
      if (options?.overlap !== undefined) params.set('overlap', String(options.overlap));
      const query = params.size > 0 ? `?${params.toString()}` : '';
      return request<DocumentSectionIndex>(
        `/documents/${encodeURIComponent(documentId)}/section-index${query}`
      );
    },

    getChapters: (documentId) =>
      request<DocumentChapters>(
        `/documents/${encodeURIComponent(documentId)}/chapters`
      ),

    getNavigationPreview: (documentId) =>
      request<NavigationPreview>(
        `/documents/${encodeURIComponent(documentId)}/navigation/preview`
      ),

    getVisualNodes: (documentId) =>
      request<Array<{ kind: string; page: number; caption: string }>>(
        `/documents/${encodeURIComponent(documentId)}/visual-nodes`
      ),

    locateQuote: (documentId, page, quote) =>
      request<QuoteLocation>(
        `/documents/${encodeURIComponent(documentId)}/quote-locate`,
        { method: 'POST', body: JSON.stringify({ page, quote }) }
      ),

    listPageMasks: (documentId) =>
      request<PageMaskRecord[]>(
        `/documents/${encodeURIComponent(documentId)}/masks`
      ),

    addPageMask: (documentId, input) =>
      request<PageMaskRecord>(
        `/documents/${encodeURIComponent(documentId)}/masks`,
        { method: 'POST', body: JSON.stringify(input) }
      ),

    updatePageMask: (documentId, maskId, input) =>
      request<PageMaskRecord>(
        `/documents/${encodeURIComponent(documentId)}/masks/${encodeURIComponent(maskId)}`,
        { method: 'PATCH', body: JSON.stringify(input) }
      ),

    async deletePageMask(documentId, maskId) {
      const response = await fetch(
        `${base}/documents/${encodeURIComponent(documentId)}/masks/${encodeURIComponent(maskId)}`,
        { method: 'DELETE', headers }
      );
      if (!response.ok) {
        const text = await response.text();
        throw new Error(text || `HTTP ${response.status}`);
      }
    },

    getMaskIndexStatus: (documentId) =>
      request<MaskIndexStatus>(
        `/documents/${encodeURIComponent(documentId)}/masks/status`
      ),

    getSettings: () => request<SettingsMap>('/settings'),
    listProviders: () => request<ProviderPreset[]>('/providers'),
    getModelServices: () => request<ModelServicesConfig>('/model-services'),
    getTokenizerStatus: () =>
      request<{ configured: boolean; tokenizer_id: string; message: string }>(
        '/settings/tokenizer'
      ),
    importTokenizer: (input) =>
      request<{ tokenizer_id: string; message: string }>('/settings/tokenizer', {
        method: 'POST',
        body: JSON.stringify(input)
      }),
    getModelServicesImpact: (connectionId) =>
      request<ModelServicesImpact>(
        `/model-services/impact?connectionId=${encodeURIComponent(connectionId)}`
      ),
    updateModelServices: (input) =>
      request<
        ModelServicesConfig & {
          unbound?: Array<{ kind: string; label: string; result: string }>;
        }
      >('/model-services', {
        method: 'PUT',
        body: JSON.stringify(input)
      }),
    fetchModelServiceModels: (connectionId) =>
      request<{ models: string[]; notice?: string }>('/model-services/models', {
        method: 'POST',
        body: JSON.stringify({ connectionId })
      }).then((response) => response.models),
    fetchConnectionModelsDetailed: (connectionId) =>
      request<{
        models: string[];
        metadata: Record<
          string,
          {
            contextWindow?: number;
            capacitySource?: string;
            capabilities?: string[];
            source?: string;
            metadataUrl?: string;
          }
        >;
        updated?: number;
        notice?: string;
      }>('/model-services/models', {
        method: 'POST',
        body: JSON.stringify({ connectionId, metadata: true })
      }),
    listBackups: () => request<BackupRecord[]>('/backups'),
    createBackup: (includeLogs) =>
      request<{ backup: BackupRecord; files: number }>('/backups', {
        method: 'POST',
        body: JSON.stringify({ include_logs: includeLogs === true })
      }),
    startBackupJob: (includeLogs = false) =>
      request<{ jobId: string }>('/backups/start', {
        method: 'POST',
        body: JSON.stringify({ include_logs: includeLogs })
      }),
    getBackupJob: (id) => request<BackupJobRecord>(`/backups/jobs/${encodeURIComponent(id)}`),
    cancelBackupJob: (id) =>
      request<BackupJobRecord>(`/backups/jobs/${encodeURIComponent(id)}/cancel`, {
        method: 'POST'
      }),
    verifyBackup: (name) =>
      request<BackupVerification>(
        `/backups/${encodeURIComponent(name)}/verify`,
        { method: 'POST', body: '{}' }
      ),
    restoreBackup: (name) =>
      request<{ marker: string; pending: PendingRestore }>(
        `/backups/${encodeURIComponent(name)}/restore`,
        { method: 'POST', body: '{}' }
      ),
    getDiagnostics: () => request<DiagnosticsReport>('/diagnostics'),
    getMaintenanceStatus: () =>
      request<MaintenanceStatus>('/maintenance/status'),
    clearUserData: () =>
      request<ClearUserDataResult>('/maintenance/clear-user-data', {
        method: 'POST',
        body: JSON.stringify({ confirm: true })
      }),
    getFileHealth: () => request<FileHealthReport>('/maintenance/file-health'),
    createDiagnosticsPackage: () =>
      request<{ path: string; name: string; bytes: number }>(
        '/maintenance/diagnostics',
        { method: 'POST', body: JSON.stringify({}) }
      ),
    listDiagnosticsPackages: () =>
      request<DiagnosticsPackageRecord[]>('/maintenance/diagnostics'),
    testModel: () =>
      request<ModelTestResult>('/model/test', {
        method: 'POST',
        body: '{}'
      }),
    getZoteroConfig: () => request<ZoteroConfigRecord>('/zotero/config'),
    updateZoteroConfig: (input) =>
      request<ZoteroConfigRecord>('/zotero/config', {
        method: 'PUT',
        body: JSON.stringify(input)
      }),
    testZotero: () =>
      request<ZoteroProbeResult>('/zotero/test', {
        method: 'POST',
        body: '{}'
      }),
    diagnoseZotero: () =>
      request<{
        mode: 'local' | 'cloud' | 'webdav';
        mode_name: string;
        ok: boolean;
        message: string;
        detail: string[];
        suggested_library_id?: string;
      }>('/zotero/diagnose'),
    listZoteroCollections: () => request<ZoteroCollection[]>('/zotero/collections'),
    listZoteroItems: (collection, start, q) => {
      const params = new URLSearchParams();
      params.set('collection', collection ?? '');
      params.set('start', String(start ?? 0));
      if (q?.trim()) params.set('q', q.trim());
      return request<ZoteroItem[]>(`/zotero/items?${params.toString()}`);
    },
    openZoteroItem: (itemKey, confirmDuplicate = false) =>
      request<DocumentDetail>(
        `/zotero/items/${encodeURIComponent(itemKey)}/open`,
        { method: 'POST', body: JSON.stringify({ confirmDuplicate }) }
      ),
    snapshotZoteroDocument: (documentId) =>
      request<DocumentDetail>(
        `/documents/${encodeURIComponent(documentId)}/snapshot`,
        { method: 'POST', body: '{}' }
      ),
    previewZoteroAnnotations: (documentId) =>
      request<ZoteroAnnotationImportReport>(
        `/documents/${encodeURIComponent(documentId)}/zotero-annotations/preview`,
        { method: 'POST', body: '{}' }
      ),
    importZoteroAnnotations: (documentId) =>
      request<ZoteroAnnotationImportReport>(
        `/documents/${encodeURIComponent(documentId)}/zotero-annotations/import`,
        { method: 'POST', body: '{}' }
      ),
    getSpeechConfig: () => request<SpeechConfigRecord>('/speech/config'),
    getSpeechVoices: (options) => {
      const params = new URLSearchParams();
      if (options?.connectionId) params.set('connection_id', options.connectionId);
      if (options?.model) params.set('model', options.model);
      const query = params.toString();
      return request<{
        voices: string[];
        labels?: Record<string, string>;
        message?: string;
        source?: string;
        metadata_url?: string;
      }>(`/speech/voices${query ? `?${query}` : ''}`);
    },
    getSpeechSystemStatus: () =>
      request<SpeechSystemStatus>('/speech/system'),
    updateSpeechConfig: (input) =>
      request<SpeechConfigRecord>('/speech/config', {
        method: 'PUT',
        body: JSON.stringify(input)
      }),
    async speak(text) {
      const response = await fetch(`${base}/speech/speak`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ text })
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as
          | { message?: string; error?: string }
          | null;
        throw new Error(payload?.message ?? payload?.error ?? `语音播报失败：HTTP ${response.status}`);
      }
      return response.blob();
    },
    async transcribeAudio(audio, filename = 'speech.webm') {
      const form = new FormData();
      form.append('file', audio, filename);
      const response = await fetch(`${base}/speech/transcribe`, {
        method: 'POST',
        headers,
        body: form
      });
      return readJson<SpeechTranscription>(response);
    },
    correctSpeech: (input) =>
      request<{
        text: string;
        needs_review: boolean;
        corrected: boolean;
        reason?: string;
      }>('/speech/correct', {
        method: 'POST',
        body: JSON.stringify({
          documentId: input.documentId,
          document_id: input.documentId,
          page: input.page,
          text: input.text,
          history: input.history
        })
      }),
    getSearchConfig: () => request<SearchConfigRecord>('/web-search/config'),
    updateSearchConfig: (input) =>
      request<SearchConfigRecord>('/web-search/config', {
        method: 'PUT',
        body: JSON.stringify(input)
      }),
    searchWeb: (query) =>
      request<SearchResult[]>('/web-search/search', {
        method: 'POST',
        body: JSON.stringify({ query })
      }),
    createSearchPlan: (input) =>
      request<SearchPlan>('/search-plan', {
        method: 'POST',
        body: JSON.stringify(input)
      }),

    getParsingConfig: () =>
      request<ParsingConfigRecord>('/parsing/config'),

    updateParsingConfig: (input) =>
      request<ParsingConfigRecord>('/parsing/config', {
        method: 'PUT',
        body: JSON.stringify(input)
      }),

    getOcrLanguages: () =>
      request<OcrLanguageStatus>('/parsing/ocr-languages'),

    downloadOcrLanguages: (codes) =>
      request<OcrLanguageStatus>('/parsing/ocr-languages/download', {
        method: 'POST',
        body: JSON.stringify({ codes })
      }),

    checkParsing: () =>
      request<ParsingCheckResult>('/parsing/check', {
        method: 'POST',
        body: JSON.stringify({})
      }),

    getOutline: (documentId) =>
      request<OutlineResult>(
        `/documents/${encodeURIComponent(documentId)}/outline`
      ),

    recognizePage: (documentId, page, scale) =>
      request<OcrPageResult>(
        `/documents/${encodeURIComponent(documentId)}/ocr/pages/${page}`,
        { method: 'POST', body: JSON.stringify(scale ? { scale } : {}) }
      ),

    recognizeRegion: (documentId, page, region) =>
      request<RegionOcrResult>(
        `/documents/${encodeURIComponent(documentId)}/ocr`,
        { method: 'POST', body: JSON.stringify({ page, ...region }) }
      ),

    startOcrRegionJob: (documentId, page, region) =>
      request<{ jobId: string }>(`/documents/${encodeURIComponent(documentId)}/ocr/start`, {
        method: 'POST',
        body: JSON.stringify({ page, ...region })
      }),

    getOcrRegionJob: (documentId, jobId) =>
      request<OcrJobRecord>(
        `/documents/${encodeURIComponent(documentId)}/ocr/jobs/${encodeURIComponent(jobId)}`
      ),

    cancelOcrRegionJob: (documentId, jobId) =>
      request<OcrJobRecord>(
        `/documents/${encodeURIComponent(documentId)}/ocr/jobs/${encodeURIComponent(jobId)}/cancel`,
        { method: 'POST' }
      ),

    getPageText: (documentId, page) =>
      request<PageTextRecord>(
        `/documents/${encodeURIComponent(documentId)}/pages/${page}/text`
      ),

    getPageData: (documentId, page) =>
      request<PageData>(
        `/documents/${encodeURIComponent(documentId)}/pages/${page}`
      ),

    getPageImage: (documentId, page, width) => {
      const query =
        typeof width === 'number' && Number.isFinite(width) && width > 0
          ? `?width=${Math.round(width)}`
          : '';
      return requestBlob(
        `/documents/${encodeURIComponent(documentId)}/pages/${page}/image${query}`
      );
    },

    getThumbnail: (documentId, page) =>
      requestBlob(
        `/documents/${encodeURIComponent(documentId)}/pages/${page}/thumbnail`
      ),

    savePageText: (documentId, page, text) =>
      request<{ text: string; origin: string; boxes: string }>(
        `/documents/${encodeURIComponent(documentId)}/pages/${page}/text`,
        { method: 'PUT', body: JSON.stringify({ text }) }
      ),

    listTranslationPages: (documentId) =>
      request<TranslationPageRecord[]>(
        `/documents/${encodeURIComponent(documentId)}/translation/pages`
      ),

    getTranslationPage: (documentId, page) =>
      request<TranslationPagePayload>(
        `/documents/${encodeURIComponent(documentId)}/translation/pages/${page}`
      ),

    translatePage: (documentId, page, language, force, includeFurniture) =>
      request<TranslationPagePayload>(
        `/documents/${encodeURIComponent(documentId)}/translation/pages/${page}`,
        {
          method: 'POST',
          body: JSON.stringify({
            ...(language ? { language } : {}),
            ...(force ? { force: true } : {}),
            ...(includeFurniture ? { include_furniture: true } : {})
          })
        }
      ),

    getTranslationConfig: () =>
      request<TranslationConfigRecord>('/translation/config'),

    retranslateTranslationSegment: (documentId, page, index, language) =>
      request<TranslationPagePayload>(
        `/documents/${encodeURIComponent(documentId)}/translation/pages/${page}/segments/${index}`,
        {
          method: 'POST',
          body: JSON.stringify(language ? { language } : {})
        }
      ),

    anchorTranslationSelection: (documentId, page, input) =>
      request<{
        quote: string;
        page: number;
        bbox: [number, number, number, number] | null;
        boxes: Array<{ bbox: [number, number, number, number]; text: string }>;
        exact: boolean;
        matched: boolean;
        located: boolean;
        fallback: boolean;
        segment?: number;
        source?: string;
        translated?: string;
        message?: string;
      }>(`/documents/${encodeURIComponent(documentId)}/translation/anchor`, {
        method: 'POST',
        body: JSON.stringify({
          page,
          excerpt: input.excerpt,
          ...(input.segment === undefined ? {} : { segment: input.segment })
        })
      }),

    lookupTranslationSegments: (documentId, page, quote) =>
      request<
        Array<{
          segment: number;
          source: string;
          text: string;
          match: 'source' | 'translation';
        }>
      >(
        `/documents/${encodeURIComponent(documentId)}/translation/lookup?page=${page}&quote=${encodeURIComponent(
          quote
        )}`
      ),

    updateTranslationConfig: (input) =>
      request<TranslationConfigRecord>('/translation/config', {
        method: 'PUT',
        body: JSON.stringify(input)
      }),

    translateQuote: (input) =>
      request<{
        source: string;
        text: string;
        engine: string;
        service: string;
        target_language: string;
        saved: false;
      }>('/translation/quote', {
        method: 'POST',
        body: JSON.stringify({
          text: input.text,
          ...(input.language ? { language: input.language } : {})
        })
      }),

    probeTranslation: (text) =>
      request<{
        ok: boolean;
        source: string;
        text: string;
        engine: string;
        service: string;
        target_language: string;
        saved: false;
        reason?: string;
        message?: string;
      }>('/translation/probe', {
        method: 'POST',
        body: JSON.stringify(text === undefined ? {} : { text })
      }),

    getTranslationJob: (documentId) =>
      request<TranslationJobRecord>(
        `/documents/${encodeURIComponent(documentId)}/translation`
      ),

    getTranslationSummary: (documentId) =>
      request<TranslationServiceSummary>(
        `/documents/${encodeURIComponent(documentId)}/translation/summary`
      ),

    getTranslationProgress: (documentId) =>
      request<TranslationProgress>(
        `/documents/${encodeURIComponent(documentId)}/translation/progress`
      ),

    getTranslationOverview: (documentIds) =>
      request<TranslationOverviewItem[]>(
        `/translation/overview?ids=${encodeURIComponent(documentIds.join(','))}`
      ),

    getAnnotationTranslations: (documentId) =>
      request<AnnotationRecord[]>(
        `/documents/${encodeURIComponent(documentId)}/translation/annotations`
      ),

    startTranslation: (documentId, input = {}) =>
      request<TranslationJobRecord>(
        `/documents/${encodeURIComponent(documentId)}/translation`,
        { method: 'POST', body: JSON.stringify(input) }
      ),

    stopTranslation: (documentId) =>
      request<TranslationJobRecord>(
        `/documents/${encodeURIComponent(documentId)}/translation/stop`,
        { method: 'POST', body: '{}' }
      ),

    editTranslationSegment: (documentId, segmentId, text) =>
      request<{ ok: true; id: string }>(
        `/documents/${encodeURIComponent(documentId)}/translation/segments/${encodeURIComponent(segmentId)}`,
        { method: 'PATCH', body: JSON.stringify({ text }) }
      ),

    restoreTranslationSegment: (documentId, segmentId) =>
      request<{ ok: true; restored: boolean; message?: string }>(
        `/documents/${encodeURIComponent(documentId)}/translation/segments/${encodeURIComponent(segmentId)}/restore`,
        { method: 'POST', body: '{}' }
      ),

    updateSettings: (patch) =>
      request<SettingsMap>('/settings', {
        method: 'PUT',
        body: JSON.stringify(patch)
      }),

    search: (query, documentId, page, mode) => {
      const params = new URLSearchParams({ q: query });
      if (documentId) params.set('documentId', documentId);
      if (page != null) params.set('page', String(page));
      if (mode) params.set('mode', mode);
      return request<SearchHit[]>(`/search?${params.toString()}`);
    },

    searchScoped: (input) =>
      request<SearchHit[]>('/search', {
        method: 'POST',
        body: JSON.stringify(input)
      }),

    searchLibrary: (query, kinds) =>
      request<LibrarySearchHit[]>(
        `/library-search?q=${encodeURIComponent(query)}&types=${encodeURIComponent(
          kinds.join(',')
        )}`
      ),

    searchLibraryDocuments: (query, kinds) =>
      request<string[]>(
        `/library-search/documents?q=${encodeURIComponent(
          query
        )}&types=${encodeURIComponent(kinds.join(','))}`
      ),

    ask: (input, signal) =>
      request<ChatResponse>('/chat/ask', {
        method: 'POST',
        body: JSON.stringify(input),
        signal
      }),

    estimateBudget: (input) =>
      request<BudgetEstimate>('/chat/budget', {
        method: 'POST',
        body: JSON.stringify(input)
      }),

    async askStream(input, options = {}) {
      const response = await fetch(`${base}/chat/ask/stream`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify(input),
        signal: options.signal
      });
      if (!response.ok || !response.body) {
        const text = await response.text().catch(() => '');
        let payload: { error?: string; message?: string; code?: string } | null = null;
        try {
          payload = JSON.parse(text) as { error?: string; message?: string; code?: string };
        } catch {
          payload = null;
        }
        throw new ApiRequestError(
          response.status,
          (payload?.error ?? payload?.message ?? text) || `HTTP ${response.status}`,
          payload?.code,
          payload
        );
      }
      // 预算确认这类"不进入阅读"的响应是 200 + application/json（不是 SSE）：
      // 按普通 JSON 解析返回，让调用方拿到 needs_confirmation/budget 后弹确认框。
      const contentType = response.headers.get('content-type') ?? '';
      if (!contentType.includes('text/event-stream')) {
        return (await response.json()) as ChatResponse;
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let result: ChatResponse | null = null;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf('\n\n');
        while (boundary >= 0) {
          const chunk = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const event = /^event: (.+)$/m.exec(chunk)?.[1] ?? '';
          const dataLine = /^data: (.+)$/m.exec(chunk)?.[1] ?? '';
          if (event === 'progress') {
            const progress = JSON.parse(dataLine) as { done: number; total: number };
            options.onProgress?.(progress.done, progress.total);
          } else if (event === 'draft') {
            const draft = JSON.parse(dataLine) as { text?: string };
            if (draft.text) options.onDraft?.(draft.text);
          } else if (event === 'draft_reset') {
            options.onDraftReset?.();
          } else if (event === 'stage') {
            const stage = JSON.parse(dataLine) as { text?: string };
            if (stage.text) options.onStage?.(stage.text);
          } else if (event === 'audit') {
            const audit = JSON.parse(dataLine) as { claims?: unknown[] };
            if (Array.isArray(audit.claims)) options.onAudit?.(audit.claims);
          } else if (event === 'result') {
            result = JSON.parse(dataLine) as ChatResponse;
          } else if (event === 'error') {
            const error = JSON.parse(dataLine) as { message?: string };
            throw new Error(error.message ?? '回答失败');
          }
          boundary = buffer.indexOf('\n\n');
        }
      }
      if (!result) throw new Error('回答流意外结束');
      return result;
    },

    plan: (question, selection = '') =>
      request<ReadingPlanRecord>('/plan', {
        method: 'POST',
        body: JSON.stringify({ question, selection })
      }),

    planReading: (input) =>
      request<PlannedReadingPreview>('/plan-reading', {
        method: 'POST',
        body: JSON.stringify(input)
      }),

    getEmbeddingStatus: () => request<EmbeddingStatus>('/embeddings/status'),

    indexEmbeddings: (documentId) =>
      request<EmbeddingIndexResult>('/embeddings/index', {
        method: 'POST',
        body: JSON.stringify(documentId ? { documentId } : {})
      }),

    migrateLegacy: (legacyDir) =>
      request<LegacyMigrationReport>('/migrate/legacy', {
        method: 'POST',
        body: JSON.stringify({ path: legacyDir })
      })
  };
}

