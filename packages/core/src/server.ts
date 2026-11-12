import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync
} from 'node:fs';import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import {
  gzipJsonForResponse,
  recordStreamAbort,
  shouldStreamGzip,
  streamGzipJsonForResponse
} from './json-gzip.js';
import multipart from '@fastify/multipart';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import {
  API_ERROR_CODES,
  API_PREFIX,
  API_VERSION,
  APP_NAME,
  TOKEN_HEADER,
  type ChatRequest,
  type ChatResponse,
  type ClearUserDataResult,
  type FileHealthReport,
  type HealthResponse,
  type ImportJobRecord,
  type MaintenanceStatus,
  type MarkdownJobSnapshot,
  type OutlineResult,
  type PageData,
  type QaImportMessage,
  type QaMessageRecord,
  type QaSessionRecord,
  type ReadingPlanRecord,
  type ReferenceNodeKind,
  type SearchRequest,
  type SettingsMap,
  type TranslationConfigRecord
} from '@studianda/shared';
import { answerQuestion } from './chat.js';
import { planQuestion } from './planning.js';
import { planReading } from './reading-plan.js';
import {
  bookChapterPlan,
  chapterOutline,
  chaptersFromLocalNavigation,
  resolveChapterReading
} from './chapters.js';
import {
  budgetThresholds,
  estimateBudgetForScope,
  estimateTurnBudget
} from './budget.js';
import { readCapacity } from './capacity.js';
import { listBackups } from './backup.js';
import { registerBackupRoutes } from './server/backup-routes.js';
import { registerOcrRoutes } from './server/ocr-routes.js';
import {
  createDiagnosticsPackage,
  generateDiagnostics,
  listDiagnosticsPackages
} from './diagnostics.js';
import { testModelConnection } from './model-test.js';
import { appendErrorLog, redactSensitive } from './error-log.js';
import { listProviders } from './providers.js';
import { searchLibrary, searchLibraryDocuments } from './library-search.js';
import {
  applyFetchedCapacityToConnection,
  fetchConnectionModelsDetailed,
  modelServicesImpact,
  publicModelServices,
  resolveModelConnection,
  saveModelServices
} from './model-services.js';
import {
  createSearchPlan,
  getSearchConfig,
  resetSearchPlans,
  saveSearchConfig,
  searchWeb
} from './web-search.js';
import {
  correctTranscript,
  getSpeechConfig,
  listSystemVoices,
  mimoVoiceList,
  saveSpeechConfig,
  synthesizeSpeech,
  systemSpeechStatus,
  transcribeAudio,
  validateWav,
  voicesForSpeechConnection
} from './speech.js';
import {
  diagnoseZotero,
  getZoteroConfig,
  importZoteroAnnotations,
  listZoteroCollections,
  listZoteroItems,
  probeZotero,
  saveZoteroConfig,
  zoteroAttachment
} from './zotero.js';
import {
  ensureOcrBoxes,
  hasUsableOcrBoxes,
  renderPdfPage
} from './ocr.js';
import { masksForPage, visibleLines } from './structure.js';
import { getPageSpans } from './page-spans-cache.js';
import { importTokenizer, loadActiveTokenizer, tokenizerStatus } from './tokenizer.js';
import {
  ParsingConfigError,
  checkParsingService,
  getParsingConfig,
  saveParsingConfig
} from './parsing-config.js';
import { downloadOcrLanguages, ocrLanguageStatus } from './ocr-languages.js';
import {
  anchorTranslationSelection,
  annotationTranslations,
  getTranslationPagePayload,
  lookupTranslationSegments,
  probeTranslation,
  retranslateTranslationSegment,
  startDocumentTranslation,
  stopDocumentTranslation,
  translatePage,
  translateQuote,
  translationJobState,
  translationOverview,
  translationProgress
} from './translation-service.js';
import { embeddingStatus, indexChunks } from './embeddings.js';
import { retrieve, warmRetrievalIndex } from './retrieval.js';
import { annotateSearchHits } from './section-context.js';
import { resolveScopeIds } from './scope.js';
import type { SecretStore } from './secrets.js';
import { AttachmentChangedError, DuplicateImportError, ImportCancelledError, type Store } from './store.js';import {
  normalizeDocumentChatSessions,
  readDocumentChatSessions,
  writeDocumentChatSessions
} from './document-chat-sessions.js';
import {
  cancelMarkdownImport,
  cancelMarkdownScan,
  getMarkdownImportReportPage,
  getMarkdownImportStatus,
  getMarkdownJobSnapshot,
  getMarkdownScanStatus,
  getMarkdownScanTree,
  importMarkdownNotes,
  resolveMarkdownSelection,
  scanMarkdownVault,
  searchMarkdownScan,
  startMarkdownImport,
  startMarkdownScan,
  subscribeMarkdownJobChanges
} from './markdown-import.js';

export interface ServerOptions {
  token: string;
  version: string;
  store: Store;
  secrets: SecretStore;
  isClosing?: () => boolean;
}

const TRANSLATION_TARGETS = [
  { id: 'zh', name: '简体中文' },
  { id: 'en', name: 'English' },
  { id: 'ja', name: '日本語' },
  { id: 'ko', name: '한국어' },
  { id: 'fr', name: 'Français' },
  { id: 'de', name: 'Deutsch' },
  { id: 'es', name: 'Español' },
  { id: 'ru', name: 'Русский' }
];

function translationConfig(options: {
  store: Store;
}): TranslationConfigRecord {
  const settings = options.store.getSettings();
  return {
    target_language: settings['translation.target_language'] ?? 'zh',
    targets: TRANSLATION_TARGETS
  };
}

import { badRequest, duplicateReply, notFound } from './server/http.js';

/** 允许的 Host 主机名：本机回环名 + Fastify inject/测试用的 testserver。 */
const ALLOWED_HOSTS = new Set(['localhost', '127.0.0.1', '::1', 'testserver']);
/** 允许页面来源的本机主机名（开发时 vite 在 localhost:5173）。 */
const LOCAL_ORIGIN_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

/** 从 Host 头取主机名：去掉端口；IPv6 支持 `[::1]:8765` 与裸 `::1`。 */
function hostnameOfHostHeader(value: string | undefined): string {
  const raw = (value ?? '').trim().toLowerCase();
  if (!raw) return '';
  if (raw.startsWith('[')) {
    const end = raw.indexOf(']');
    return end > 0 ? raw.slice(1, end) : '';
  }
  const colon = raw.lastIndexOf(':');
  // 只有一个冒号才当"主机:端口"；多个冒号是裸 IPv6 地址。
  if (colon >= 0 && raw.indexOf(':') === colon) return raw.slice(0, colon);
  return raw;
}

/**
 * Origin 是否来自本应用页面。
 *
 * - `null`：Electron 生产页面来自 file://，Chromium 对 fetch 会发 `Origin: null`；
 * - `file://...`：部分环境直接给完整 file URL；
 * - `app://studianda`：自定义协议的备用来源；
 * - `http://localhost|127.0.0.1|[::1]:<port>`：开发时 renderer（vite 5173 / 任意本机端口）。
 */
function isAllowedOrigin(value: string): boolean {
  const origin = value.trim();
  if (!origin) return true;
  if (origin === 'null') return true;
  if (origin === 'app://studianda') return true;
  if (origin.startsWith('file://')) return true;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:') return false;
  const host = url.hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  return LOCAL_ORIGIN_HOSTS.has(host);
}

/** 批注 PDF 的下载文件名：中文走 filename*，ASCII 兜底保证旧客户端可用。 */
function annotatedContentDisposition(name: string): string {
  const cleaned =
    name
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
      .trim()
      .slice(0, 80) || '文献';
  const ascii = cleaned.replace(/[^\x20-\x7e]/g, '_') || 'document';
  return (
    `attachment; filename="${ascii}-annotated.pdf"; ` +
    `filename*=UTF-8''${encodeURIComponent(`${cleaned}-批注副本.pdf`)}`
  );
}

/** 页图缩小的最小目标宽度：更小的请求直接忽略，避免请求 1px 的图。 */
const MIN_SCALED_PAGE_WIDTH = 160;
/** 缩略图固定宽度。 */
const THUMBNAIL_WIDTH = 240;

/**
 * 把整页渲染 PNG 缩到目标宽度。**只允许缩小**：
 * 目标宽度必须 >160 且小于原图宽度，否则原样返回整页 PNG（不做放大）。
 */
async function scalePagePng(
  png: Uint8Array,
  fullWidth: number,
  targetWidth: number
): Promise<Uint8Array> {
  if (!Number.isFinite(targetWidth) || targetWidth <= MIN_SCALED_PAGE_WIDTH) return png;
  if (fullWidth <= MIN_SCALED_PAGE_WIDTH) return png;
  const width = Math.max(1, Math.min(fullWidth, Math.round(targetWidth)));
  if (width >= fullWidth) return png;
  const image = await loadImage(Buffer.from(png));
  const height = Math.max(1, Math.round((image.height * width) / image.width));
  const canvas = createCanvas(width, height);
  const context = canvas.getContext('2d');
  context.drawImage(image, 0, 0, width, height);
  return canvas.encode('png');
}

// ---------------------------------------------------------------------------
// Markdown 任务 SSE 全局状态：所有连接共享一个 300ms 节流窗口，订阅上限 8。
// ---------------------------------------------------------------------------

const MARKDOWN_SSE_THROTTLE_MS = 300;

/** SSE 订阅上限：环境变量可配，默认 32，范围 1-256。 */
function maxMarkdownSseClients(): number {
  const raw = Number(process.env.STUDIANDA_SSE_MAX_CLIENTS);
  if (!Number.isFinite(raw)) return 32;
  return Math.min(256, Math.max(1, Math.trunc(raw)));
}

/** SSE 空闲超时（默认 60s）：长时间无成功写入后关闭释放名额。 */
function markdownSseIdleTimeoutMs(): number {
  const raw = Number(process.env.STUDIANDA_SSE_IDLE_TIMEOUT_MS);
  if (!Number.isFinite(raw)) return 60000;
  return Math.min(3600000, Math.max(1000, Math.trunc(raw)));
}

interface MarkdownSseClient {
  send: (snapshot: MarkdownJobSnapshot) => void;
  lastWriteAt: number;
  heartbeatFailures: number;
}

const markdownSseClients = new Set<MarkdownSseClient>();
let markdownSseFlushTimer: ReturnType<typeof setTimeout> | null = null;
const markdownSsePending = new Map<MarkdownSseClient, MarkdownJobSnapshot>();

function flushMarkdownSse(): void {
  markdownSseFlushTimer = null;
  const entries = [...markdownSsePending];
  markdownSsePending.clear();
  for (const [client, snapshot] of entries) {
    if (!markdownSseClients.has(client)) continue;
    client.send(snapshot);
  }
}

/** 进程级节流：运行中事件进共享窗口（每 300ms 最多一批），终态立即发送。 */
function pushMarkdownSse(client: MarkdownSseClient, snapshot: MarkdownJobSnapshot): void {
  const running =
    snapshot.scanJob.status === 'running' || snapshot.importJob.status === 'running';
  if (!running) {
    // 终态：立即发送；丢弃该连接尚未发出的进度快照。
    markdownSsePending.delete(client);
    if (markdownSseFlushTimer && markdownSsePending.size === 0) {
      clearTimeout(markdownSseFlushTimer);
      markdownSseFlushTimer = null;
    }
    client.send(snapshot);
    return;
  }
  markdownSsePending.set(client, snapshot);
  if (!markdownSseFlushTimer) {
    // 窗口开启：立即把当前状态发给该连接（低延迟），其余连接/后续事件在窗口内合并。
    markdownSsePending.delete(client);
    client.send(snapshot);
    markdownSseFlushTimer = setTimeout(flushMarkdownSse, MARKDOWN_SSE_THROTTLE_MS);
  }
}

function removeMarkdownSseClient(client: MarkdownSseClient): void {
  markdownSseClients.delete(client);
  markdownSsePending.delete(client);
  if (markdownSseFlushTimer && markdownSsePending.size === 0) {
    clearTimeout(markdownSseFlushTimer);
    markdownSseFlushTimer = null;
  }
}

/** 生成 SSE / jobs summary 共用的 lite 快照：裁掉完整 scan/report/input，保留进度与 result*。 */
function toLiteMarkdownSnapshot(snapshot: MarkdownJobSnapshot): MarkdownJobSnapshot {
  const running =
    snapshot.scanJob.status === 'running' || snapshot.importJob.status === 'running';
  const terminal =
    !running && (snapshot.scanJob.status !== 'idle' || snapshot.importJob.status !== 'idle');
  return {
    scanJob: { ...snapshot.scanJob, scan: null, input: null },
    importJob: { ...snapshot.importJob, report: null, input: null },
    lite: true,
    terminal
  };
}

/**
 * 客户端 Accept-Encoding 含 gzip 时压缩 JSON 响应：
 * - 大 payload 走 worker 流式分块（chunked，不设 content-length）；
 * - 小 payload / worker 未开始输出即失败时回退完整 buffer（content-length）；
 * - 不需要 gzip 时直接返回普通 JSON。
 */
/** 流式响应写出响应头前缓存的 chunk 数；1 = 最低首字节延迟（失败不可回退），默认 2。 */
function streamPrebufferChunks(): number {
  const value = Number(process.env.STUDIANDA_STREAM_PREBUFFER_CHUNKS);
  if (!Number.isFinite(value)) return 2;
  return Math.max(1, Math.min(4, Math.floor(value)));
}

async function sendJsonMaybeGzip(
  request: { headers: Record<string, string | string[] | undefined> },
  reply: FastifyReply,
  data: unknown
): Promise<unknown> {
  const rawAccept = request.headers['accept-encoding'];
  const accept = Array.isArray(rawAccept) ? rawAccept.join(',') : String(rawAccept ?? '');
  if (!/\bgzip\b/i.test(accept)) return data;

  const sendBuffer = async (): Promise<unknown> => {
    const buffer = (await gzipJsonForResponse(data)).buffer;
    reply.header('content-type', 'application/json; charset=utf-8');
    reply.header('content-encoding', 'gzip');
    reply.header('vary', 'Accept-Encoding');
    reply.header('cache-control', 'no-store');
    reply.header('content-length', String(buffer.length));
    return reply.send(buffer);
  };

  // `STUDIANDA_STREAM_RELIABILITY=buffer`：大 payload 也先完整压缩再发送。
  // 代价是内存/首字节，但可在 worker 失败时回退，不会出现“已写 chunk 后断连”。
  const forceBuffer = process.env.STUDIANDA_STREAM_RELIABILITY === 'buffer';
  if (forceBuffer || !shouldStreamGzip(data)) {
    try {
      return await sendBuffer();
    } catch {
      return data;
    }
  }

  // 大 payload：流式。先缓存前几个 chunk，直到确认有多个 chunk 或流结束再写响应头；
  // 这样 worker 在真正写出前失败仍可回退完整 buffer。
  const raw = reply.raw;
  let hijacked = false;
  let writtenBytes = 0;
  const pendingChunks: Buffer[] = [];
  const writeHeadOnce = (): void => {
    if (hijacked) return;
    reply.hijack();
    hijacked = true;
    raw.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'content-encoding': 'gzip',
      vary: 'Accept-Encoding',
      'cache-control': 'no-store'
      // 流式：不设 content-length（chunked）
    });
  };
  const flushPending = (): void => {
    if (pendingChunks.length === 0) return;
    writeHeadOnce();
    for (const chunk of pendingChunks) {
      writtenBytes += chunk.length;
      raw.write(chunk);
    }
    pendingChunks.length = 0;
  };
  try {
    await streamGzipJsonForResponse(data, (chunk) => {
      if (!hijacked && pendingChunks.length < streamPrebufferChunks()) {
        pendingChunks.push(chunk);
        return;
      }
      flushPending();
      writtenBytes += chunk.length;
      raw.write(chunk);
    });
    // 流成功结束：若还从未写出，则把缓存的首块们写出（单 chunk 的小 gzip 流）。
    flushPending();
    if (!hijacked) {
      // 理论上不会发生（stream 至少产生一个 chunk）；保守回退 buffer。
      return await sendBuffer();
    }
    raw.end();
    return reply;
  } catch {
    if (!hijacked) {
      // 尚未写出任何内容：丢弃缓存 chunks，回退完整 buffer。
      pendingChunks.length = 0;
      try {
        return await sendBuffer();
      } catch {
        return data;
      }
    }
    // 已经写出 chunk：无法回退；记录统计并中断连接（worker 由池内 failTask 清理）。
    recordStreamAbort(writtenBytes);
    pendingChunks.length = 0;
    try {
      raw.destroy();
    } catch {
      // 忽略
    }
    return reply;
  }
}

export function buildServer(options: ServerOptions): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024 });
  // 导入任务（进程内、按 Core 实例隔离）：解析 PDF 在后台跑，前端轮询状态并可请求取消。
  const importJobs = new Map<string, ImportJobRecord>();
  // 维护状态里的运行时长：进程启动即记录，只用于展示，不持久化。
  const startedAt = Date.now();
  // 已导入的本地 tokenizer：启动即生效；文件缺失/损坏时停在保守估算，不影响启动。
  loadActiveTokenizer(options.store);
  // 进行中的请求按文献登记：彻底删除文献之前先取消这些请求，避免后台任务继续
  // 读写已删除的数据。
  const documentRequests = new Map<string, Set<AbortController>>();
  const trackDocumentRequests = (
    documentIds: Array<string | undefined>,
    controller: AbortController
  ): (() => void) => {
    const ids = [...new Set(documentIds.filter((id): id is string => Boolean(id)))];
    for (const id of ids) {
      const set = documentRequests.get(id) ?? new Set<AbortController>();
      set.add(controller);
      documentRequests.set(id, set);
    }
    return () => {
      for (const id of ids) {
        const set = documentRequests.get(id);
        if (!set) continue;
        set.delete(controller);
        if (set.size === 0) documentRequests.delete(id);
      }
    };
  };
  const abortDocumentRequests = (documentId: string): void => {
    const set = documentRequests.get(documentId);
    if (!set) return;
    documentRequests.delete(documentId);
    for (const controller of set) controller.abort();
  };
  void app.register(multipart, {
    limits: {
      files: 1,
      // 技术安全上限，远高于提醒阈值；普通文件不会被这里拒绝。
      fileSize: 4 * 1024 * 1024 * 1024
    }
  });
  registerBackupRoutes(app, options.store);
  registerOcrRoutes(app, { store: options.store, secrets: options.secrets });

  app.addHook('onRequest', async (request, reply) => {
    // 安全边界：
    // 1) Host 必须是本机名字符串，防 DNS rebinding / 跨站访问本机服务；
    // 2) 有 Origin 时必须来自本应用页面：Electron 生产页面是 file://（Chromium 常发
    //    `Origin: null`）或 app://studianda，开发时 renderer 在 http://localhost:<port>。
    // 顺序：先校验 Host/Origin，再设 CORS 头，最后才是预检 204 与 token 校验。
    const host = hostnameOfHostHeader(request.headers.host);
    if (!ALLOWED_HOSTS.has(host)) {
      return reply.code(403).send({ error: API_ERROR_CODES.forbidden, message: 'Invalid host' });
    }
    const origin =
      typeof request.headers.origin === 'string' ? request.headers.origin : '';
    if (origin && !isAllowedOrigin(origin)) {
      return reply.code(403).send({ error: API_ERROR_CODES.forbidden, message: 'Invalid origin' });
    }
    // CORS 只对浏览器有意义：有合法 Origin 时**回显该 Origin**（不能用 *，
    // 否则任意站点都能读到本机接口的响应），无 Origin 的本机进程/curl 请求不需要 CORS 头。
    if (origin) {
      reply.header('access-control-allow-origin', origin);
      reply.header('vary', 'origin');
    }
    reply.header('access-control-allow-headers', `${TOKEN_HEADER}, content-type, range`);
    reply.header('access-control-allow-methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    reply.header('access-control-expose-headers', 'content-range, content-length, accept-ranges');
    if (request.method === 'OPTIONS') return reply.code(204).send();
    // 仅 Markdown 任务 SSE 允许 query token（EventSource 不能自定义 header）。
    const urlPath = String(request.url ?? '').split('?')[0];
    const isMarkdownEvents =
      request.method === 'GET' && urlPath === `${API_PREFIX}/markdown/events`;
    const headerToken = request.headers[TOKEN_HEADER];
    let token: string | null = typeof headerToken === 'string' ? headerToken : null;
    if (isMarkdownEvents && !token) {
      try {
        token = new URL(String(request.url ?? ''), 'http://127.0.0.1').searchParams.get('token');
      } catch {
        token = null;
      }
    }
    if (token !== options.token) {
      return reply.code(401).send({ error: API_ERROR_CODES.unauthorized });
    }
  });

  app.setErrorHandler((error, request, reply) => {
    const summary = error instanceof Error ? error.message : String(error);
    const redactedContext = redactSensitive(`${request.method} ${request.url}`);
    console.error('[core] request failed:', redactSensitive(summary));
    appendErrorLog(options.store.dataDir, redactedContext, error);
    const message = summary;
    // 422 阶段错误：材料装不进有效输入上限时明确拒绝，不截断原文。
    if (message.includes('预计输入') && message.includes('有效输入上限')) {
      return reply.code(422).send({ error: message, code: 'input_too_large' });
    }
    // Zotero 本机附件被外部替换：索引指向旧文件，必须让用户重新连接（返回 409）。
    if (error instanceof AttachmentChangedError) {
      return reply.code(409).send({ error: API_ERROR_CODES.attachmentChanged, message: error.message });
    }
    void reply.code(500).send({ error: API_ERROR_CODES.internal, message });
  });

  app.get(`${API_PREFIX}/health`, async (): Promise<HealthResponse> => ({
    application: APP_NAME,
    version: options.version,
    api_version: API_VERSION,
    closing: options.isClosing?.() ?? false
  }));

  app.get(`${API_PREFIX}/documents`, async (request) => {
    const query = request.query as { trash?: string };
    return options.store.listDocuments(query.trash === 'true' || query.trash === '1');
  });

  // 单层文件夹 + 未分类（id='' 的虚拟集合）。删除文件夹只把文献移回未分类，不删文献。
  app.get(`${API_PREFIX}/folders`, async () => options.store.listFolders());

  app.post(`${API_PREFIX}/folders`, async (request, reply) => {
    const body = (request.body ?? {}) as { name?: unknown };
    if (typeof body.name !== 'string') return badRequest(reply, 'name 必须是字符串');
    try {
      return options.store.createFolder(body.name);
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '创建文件夹失败');
    }
  });

  app.patch(`${API_PREFIX}/folders/:id`, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { name?: unknown };
    if (typeof body.name !== 'string') return badRequest(reply, 'name 必须是字符串');
    try {
      return options.store.renameFolder(id, body.name);
    } catch (error) {
      const message = error instanceof Error ? error.message : '重命名文件夹失败';
      if (message === '文件夹不存在') return notFound(reply, message);
      return badRequest(reply, message);
    }
  });

  app.delete(`${API_PREFIX}/folders/:id`, async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      return options.store.deleteFolder(id);
    } catch (error) {
      return notFound(reply, error instanceof Error ? error.message : '文件夹不存在');
    }
  });

  // 笔记/批注里粘贴的本地图片：base64 data URL → 数据目录 note-assets/ 下的资源文件。
  // 路由放宽 body 上限：图片上限由设置控制（1..20MB），20MB 经 base64 后约 26.7MB，
  // 这里留到 32MB；真正的单图大小/像素限制在 store 里按解码结果判断，返回中文 400。
  app.post(
    `${API_PREFIX}/note-assets`,
    { bodyLimit: 32 * 1024 * 1024 },
    async (request, reply) => {
      const body = (request.body ?? {}) as { dataUrl?: unknown; filename?: unknown };
      if (typeof body.dataUrl !== 'string' || !body.dataUrl.trim()) {
        return badRequest(reply, '需要 dataUrl 图片数据');
      }
      if (body.filename != null && typeof body.filename !== 'string') {
        return badRequest(reply, 'filename 必须是字符串');
      }
      try {
        return await options.store.saveNoteAsset({
          dataUrl: body.dataUrl,
          filename: typeof body.filename === 'string' ? body.filename : undefined
        });
      } catch (error) {
        return badRequest(reply, error instanceof Error ? error.message : '保存图片失败');
      }
    }
  );

  // 图片资源 GC：默认只清理「无引用且早于 24h」的文件；dryRun 只统计。
  app.post(`${API_PREFIX}/note-assets/gc`, async (request, reply) => {
    const body = request.body as
      | { dryRun?: unknown; includeDeleted?: unknown }
      | null
      | undefined;
    if (body != null && (typeof body !== 'object' || Array.isArray(body))) {
      return badRequest(reply, '请求体必须是对象');
    }
    if (body?.dryRun != null && typeof body.dryRun !== 'boolean') {
      return badRequest(reply, 'dryRun 必须是布尔值');
    }
    if (body?.includeDeleted != null && typeof body.includeDeleted !== 'boolean') {
      return badRequest(reply, 'includeDeleted 必须是布尔值');
    }
    return options.store.gcNoteAssets({
      dryRun: body?.dryRun === true,
      includeDeleted:
        typeof body?.includeDeleted === 'boolean' ? body.includeDeleted : undefined
    });
  });

  // 本地图片资源使用统计（文件数/占用/被引用/孤儿/上次清理时间）。
  app.get(`${API_PREFIX}/note-assets/usage`, async () =>
    options.store.getNoteAssetUsage()
  );

  // 手动重建资源索引：修复外部直接改库造成的 refs 漂移，返回并更新 indexed 统计。
  app.post(`${API_PREFIX}/note-assets/reindex`, async () => options.store.reindexNoteAssets());

  // 后台分块重建资源索引（带进度，单并发）。
  app.post(`${API_PREFIX}/note-assets/reindex/start`, async () =>
    options.store.startNoteAssetReindex()
  );
  app.get(`${API_PREFIX}/note-assets/reindex/status`, async () =>
    options.store.getNoteAssetReindexStatus()
  );

  // Markdown 库扫描：只读目录，返回可导入的 Markdown 笔记与非 Markdown 附件清单。
  app.post(`${API_PREFIX}/markdown/scan`, async (request, reply) => {
    const body = (request.body ?? {}) as { vaultPath?: unknown };
    if (typeof body.vaultPath !== 'string' || !body.vaultPath.trim()) {
      return badRequest(reply, '需要库目录路径');
    }
    try {
      return scanMarkdownVault(body.vaultPath);
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '扫描笔记文件夹失败');
    }
  });

  // Markdown 后台扫描（带进度/取消；单并发）。同步 scan 保留。
  app.post(`${API_PREFIX}/markdown/scan/start`, async (request, reply) => {
    const body = (request.body ?? {}) as { vaultPath?: unknown };
    if (typeof body.vaultPath !== 'string' || !body.vaultPath.trim()) {
      return badRequest(reply, '需要库目录路径');
    }
    try {
      return startMarkdownScan(options.store, body.vaultPath);
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '启动扫描失败');
    }
  });

  app.get(`${API_PREFIX}/markdown/scan/status`, async (request, reply) =>
    sendJsonMaybeGzip(request, reply, getMarkdownScanStatus())
  );

  app.post(`${API_PREFIX}/markdown/scan/cancel`, async () => cancelMarkdownScan());

  // 一次读取扫描+导入完整状态（含完整 scan/report/input），避免终态分开两次请求。
  app.get(`${API_PREFIX}/markdown/jobs`, async (request, reply) => {
    const query = request.query as { summary?: string };
    const snapshot = getMarkdownJobSnapshot();
    const summary = query.summary === '1' || query.summary === 'true';
    return sendJsonMaybeGzip(
      request,
      reply,
      summary ? toLiteMarkdownSnapshot(snapshot) : snapshot
    );
  });

  // 扫描结果树懒加载：parent 目录的直接子项 + 分页。
  app.get(`${API_PREFIX}/markdown/scan/tree`, async (request, reply) => {
    const query = request.query as {
      vaultPath?: string;
      parent?: string;
      offset?: string;
      limit?: string;
    };
    if (typeof query.vaultPath !== 'string' || !query.vaultPath.trim()) {
      return badRequest(reply, '需要库目录路径');
    }
    let offset = 0;
    if (query.offset !== undefined) {
      if (!/^\d+$/.test(query.offset.trim())) return badRequest(reply, 'offset 必须是非负整数');
      offset = Number(query.offset);
    }
    let limit = 100;
    if (query.limit !== undefined) {
      if (!/^\d+$/.test(query.limit.trim())) return badRequest(reply, 'limit 必须是 1..500 的整数');
      limit = Number(query.limit);
      if (limit < 1 || limit > 500) return badRequest(reply, 'limit 必须是 1..500 的整数');
    }
    try {
      return getMarkdownScanTree({
        vaultPath: query.vaultPath,
        parent: query.parent ?? '',
        offset,
        limit
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : '读取扫描目录失败';
      if (message === '扫描结果不可用，请先完成扫描') {
        return reply.code(409).send({ error: API_ERROR_CODES.scanUnavailable, message });
      }
      return badRequest(reply, message);
    }
  });

  // 扫描结果搜索：相对路径/文件名大小写不敏感子串匹配（只查最近完成的扫描结果）。
  app.get(`${API_PREFIX}/markdown/scan/search`, async (request, reply) => {
    const query = request.query as {
      vaultPath?: string;
      q?: string;
      limit?: string;
      offset?: string;
    };
    if (typeof query.vaultPath !== 'string' || !query.vaultPath.trim()) {
      return badRequest(reply, '需要库目录路径');
    }
    let limit = 50;
    if (query.limit !== undefined) {
      if (!/^\d+$/.test(query.limit.trim())) return badRequest(reply, 'limit 必须是 1..200 的整数');
      limit = Number(query.limit);
      if (limit < 1 || limit > 200) return badRequest(reply, 'limit 必须是 1..200 的整数');
    }
    let offset = 0;
    if (query.offset !== undefined) {
      if (!/^\d+$/.test(query.offset.trim())) return badRequest(reply, 'offset 必须是非负整数');
      offset = Number(query.offset);
    }
    try {
      return searchMarkdownScan(query.vaultPath, query.q ?? '', limit, offset);
    } catch (error) {
      const message = error instanceof Error ? error.message : '搜索扫描结果失败';
      if (message === '扫描结果不可用，请先完成扫描') {
        return reply.code(409).send({ error: API_ERROR_CODES.scanUnavailable, message });
      }
      return badRequest(reply, message);
    }
  });

  // 服务端解析选择（全选/文件夹/单文件 + 排除），返回最终导入清单。
  app.post(`${API_PREFIX}/markdown/selection/resolve`, async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    if (typeof body.vaultPath !== 'string' || !body.vaultPath.trim()) {
      return badRequest(reply, '需要库目录路径');
    }
    const stringArray = (value: unknown): value is string[] =>
      Array.isArray(value) && value.every((item) => typeof item === 'string');
    for (const field of ['folders', 'files', 'excludedFolders', 'excludedFiles'] as const) {
      if (body[field] !== undefined && !stringArray(body[field])) {
        return badRequest(reply, `${field} 必须是字符串数组`);
      }
    }
    if (body.all !== undefined && typeof body.all !== 'boolean') {
      return badRequest(reply, 'all 必须是布尔值');
    }
    try {
      return resolveMarkdownSelection({
        vaultPath: body.vaultPath,
        all: body.all === true,
        folders: (body.folders as string[] | undefined) ?? [],
        files: (body.files as string[] | undefined) ?? [],
        excludedFolders: (body.excludedFolders as string[] | undefined) ?? [],
        excludedFiles: (body.excludedFiles as string[] | undefined) ?? []
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : '解析选择失败';
      if (message === '扫描结果不可用，请先完成扫描') {
        return reply.code(409).send({ error: API_ERROR_CODES.scanUnavailable, message });
      }
      return badRequest(reply, message);
    }
  });

  // 最近一次导入报告的明细分页。
  app.get(`${API_PREFIX}/markdown/import/report`, async (request, reply) => {
    const query = request.query as { offset?: string; limit?: string };
    let offset = 0;
    if (query.offset !== undefined) {
      if (!/^\d+$/.test(query.offset.trim())) return badRequest(reply, 'offset 必须是非负整数');
      offset = Number(query.offset);
    }
    let limit = 50;
    if (query.limit !== undefined) {
      if (!/^\d+$/.test(query.limit.trim())) return badRequest(reply, 'limit 必须是 1..500 的整数');
      limit = Number(query.limit);
      if (limit < 1 || limit > 500) return badRequest(reply, 'limit 必须是 1..500 的整数');
    }
    const page = getMarkdownImportReportPage(offset, limit);
    if (!page) {
      return reply.code(404).send({
        error: API_ERROR_CODES.resultMissing,
        message: '导入报告缺失，请重新导入'
      });
    }
    return page;
  });

  // Markdown 任务实时快照 SSE：连接即推送 lite 快照，任务状态变化推送，15s 心跳。
  // 所有事件一律 lite（scan/report/input=null），终态事件带 terminal:true；UI 需要详情调 status。
  // token 从 query 读取（EventSource 不能自定义 header；仅此路由允许）。
  app.get(`${API_PREFIX}/markdown/events`, async (request, reply) => {
    if (markdownSseClients.size >= maxMarkdownSseClients()) {
      return reply.code(503).send({ error: API_ERROR_CODES.tooManyRequests, message: '实时任务订阅连接过多，请稍后重试' });
    }
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive'
    });
    const isRunning = (snapshot: MarkdownJobSnapshot): boolean =>
      snapshot.scanJob.status === 'running' || snapshot.importJob.status === 'running';
    void isRunning;
    const client: MarkdownSseClient = {
      lastWriteAt: Date.now(),
      heartbeatFailures: 0,
      send: (snapshot: MarkdownJobSnapshot): void => {
        if (raw.writableEnded || raw.destroyed) return;
        const payload = toLiteMarkdownSnapshot(snapshot);
        try {
          raw.write(`data: ${JSON.stringify(payload)}\n\n`);
          client.lastWriteAt = Date.now();
          client.heartbeatFailures = 0;
        } catch {
          // 连接已断开：交给 close 回调清理
        }
      }
    };
    markdownSseClients.add(client);
    // 初始事件：同样 lite；已终态则带 terminal:true，未终止（idle/running）不带。
    client.send(getMarkdownJobSnapshot());
    const unsubscribe = subscribeMarkdownJobChanges((snapshot) =>
      pushMarkdownSse(client, snapshot)
    );
    const HEARTBEAT_MS = 15000;
    const heartbeat = setInterval(() => {
      if (raw.writableEnded || raw.destroyed) {
        cleanup();
        return;
      }
      // 空闲超时：超过阈值没有任何成功写入（如对端不读/连接半死）→ 主动关闭释放名额。
      if (Date.now() - client.lastWriteAt > markdownSseIdleTimeoutMs()) {
        cleanup();
        raw.destroy();
        return;
      }
      try {
        raw.write(': ping\n\n');
        client.lastWriteAt = Date.now();
        client.heartbeatFailures = 0;
      } catch {
        client.heartbeatFailures += 1;
        if (client.heartbeatFailures * HEARTBEAT_MS >= markdownSseIdleTimeoutMs()) {
          cleanup();
          raw.destroy();
        }
      }
    }, HEARTBEAT_MS);
    let cleaned = false;
    const cleanup = (): void => {
      if (cleaned) return;
      cleaned = true;
      clearInterval(heartbeat);
      removeMarkdownSseClient(client);
      unsubscribe();
    };
    request.raw.on('close', cleanup);
    request.raw.on('error', cleanup);
    raw.on('close', cleanup);
  });

  // Markdown 选择性导入：把选中的 Markdown 笔记导入为独立笔记（去重更新）。
  app.post(`${API_PREFIX}/markdown/import`, async (request, reply) => {
    const body = (request.body ?? {}) as { vaultPath?: unknown; files?: unknown };
    if (typeof body.vaultPath !== 'string' || !body.vaultPath.trim()) {
      return badRequest(reply, '需要库目录路径');
    }
    if (!Array.isArray(body.files) || !body.files.every((file) => typeof file === 'string')) {
      return badRequest(reply, 'files 必须是字符串数组');
    }
    try {
      return await importMarkdownNotes(options.store, {
        vaultPath: body.vaultPath,
        files: body.files as string[]
      });
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '导入 Markdown 笔记失败');
    }
  });

  // 后台分块导入（带进度/取消；单并发）。
  app.post(`${API_PREFIX}/markdown/import/start`, async (request, reply) => {
    const body = (request.body ?? {}) as { vaultPath?: unknown; files?: unknown };
    if (typeof body.vaultPath !== 'string' || !body.vaultPath.trim()) {
      return badRequest(reply, '需要库目录路径');
    }
    if (!Array.isArray(body.files) || !body.files.every((file) => typeof file === 'string')) {
      return badRequest(reply, 'files 必须是字符串数组');
    }
    try {
      return startMarkdownImport(options.store, {
        vaultPath: body.vaultPath,
        files: body.files as string[]
      });
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '启动 Markdown 笔记导入失败');
    }
  });

  app.get(`${API_PREFIX}/markdown/import/status`, async (request, reply) =>
    sendJsonMaybeGzip(request, reply, getMarkdownImportStatus())
  );

  app.post(`${API_PREFIX}/markdown/import/cancel`, async () => cancelMarkdownImport());

  // 全库引用关系图：文献/笔记/批注节点 + `[[…]]` 引用边。
  // all=1 为全量模式（一次返回全部节点/边，超硬上限才退回分页）；旧 limit/offset 分页参数保留兼容。
  app.get(`${API_PREFIX}/reference-graph`, async (request, reply) => {
    const query = request.query as {
      limit?: string;
      offset?: string;
      kinds?: string;
      search?: string;
      all?: string;
    };
    const paging: {
      limit?: number;
      offset?: number;
      kinds?: ReferenceNodeKind[];
      search?: string;
      all?: boolean;
    } = {};
    // 全量模式开关：all=1/true（或 0/false 显式关闭）；非法值 400。
    if (query.all !== undefined) {
      const raw = query.all.trim().toLowerCase();
      if (raw === '1' || raw === 'true') paging.all = true;
      else if (raw === '0' || raw === 'false') paging.all = false;
      else return badRequest(reply, 'all 必须是 1/0 或 true/false');
    }
    if (query.limit !== undefined) {
      if (!/^\d+$/.test(query.limit.trim())) {
        return badRequest(reply, 'limit 必须是 1..500 的整数');
      }
      const limit = Number(query.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
        return badRequest(reply, 'limit 必须是 1..500 的整数');
      }
      paging.limit = limit;
    }
    if (query.offset !== undefined) {
      if (!/^\d+$/.test(query.offset.trim())) {
        return badRequest(reply, 'offset 必须是非负整数');
      }
      const offset = Number(query.offset);
      if (!Number.isInteger(offset) || offset < 0) {
        return badRequest(reply, 'offset 必须是非负整数');
      }
      paging.offset = offset;
    }
    // 可选类型过滤（document,note,annotation 逗号分隔）：先过滤再分页，totalNodes 为过滤后总数。
    if (query.kinds !== undefined) {
      const kinds = query.kinds
        .split(',')
        .map((kind) => kind.trim())
        .filter((kind) => kind.length > 0);
      if (
        kinds.length === 0 ||
        kinds.some((kind) => kind !== 'document' && kind !== 'note' && kind !== 'annotation')
      ) {
        return badRequest(reply, 'kinds 必须是 document/note/annotation（逗号分隔）');
      }
      paging.kinds = [...new Set(kinds)] as ReferenceNodeKind[];
    }
    // 可选节点名关键字过滤（不区分大小写子串）：同样发生在分页之前。
    if (query.search !== undefined) {
      const search = query.search.trim();
      if (search.length > 100) return badRequest(reply, 'search 最多 100 个字符');
      if (search) paging.search = search;
    }
    try {
      // 全量图可能包含数千节点，统一交给带 gzip 的 JSON 响应（客户端没带 Accept-Encoding 时退回普通 JSON）。
      return await sendJsonMaybeGzip(request, reply, options.store.getReferenceGraph(paging));
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '读取关系图失败');
    }
  });

  // 反向链接：哪些笔记/批注引用了指定笔记/批注/文献。
  app.get(`${API_PREFIX}/backlinks`, async (request, reply) => {
    const query = request.query as { kind?: string; documentId?: string; id?: string };
    const kind = (query.kind ?? '').trim();
    if (kind !== 'note' && kind !== 'annotation' && kind !== 'document') {
      return badRequest(reply, 'kind 必须是 note/annotation/document');
    }
    const documentId = (query.documentId ?? '').trim();
    // 独立笔记目标：kind=note 且 documentId 为空串，不做文献存在性检查（404 会误报）。
    const standaloneNoteTarget = kind === 'note' && !documentId;
    if (!documentId && !standaloneNoteTarget) return badRequest(reply, '需要 documentId');
    const id = (query.id ?? '').trim();
    if (kind !== 'document' && !id) return badRequest(reply, '需要 id');
    if (!standaloneNoteTarget && !options.store.getDocument(documentId)) {
      return notFound(reply, '文献不存在');
    }
    return options.store.listBacklinks({ kind, documentId, id: id || undefined });
  });

  // 文献上传：multipart/form-data。
  app.post(`${API_PREFIX}/documents`, async (request, reply) => {
    let upload;
    try {
      upload = await request.file();
    } catch {
      return badRequest(reply, '需要 multipart 文件上传');
    }
    if (!upload) return badRequest(reply, '缺少 PDF 文件');

    const tempDir = path.join(options.store.dataDir, 'imports');
    mkdirSync(tempDir, { recursive: true });
    const tempPath = path.join(tempDir, `${randomUUID()}.pdf`);
    try {
      await pipeline(upload.file, createWriteStream(tempPath));
      const stats = statSync(tempPath);
      const warningThreshold = Number(
        process.env.STUDIANDA_LARGE_FILE_WARN_BYTES ?? 100 * 1024 * 1024
      );
      const confirmed = request.headers['x-studianda-confirm-large'] === 'true';
      if (!confirmed && stats.size > warningThreshold) {
        return reply.code(409).send({
          error: API_ERROR_CODES.confirmationRequired,
          message:
            '这个 PDF 比较大。继续导入会增加解析时间；后续问答、翻译或 OCR 可能消耗更多 token、占用更多内存并变慢。确认后仍会导入。',
          details: { sizeBytes: stats.size, thresholdBytes: warningThreshold }
        });
      }
      const safeName =
        path.basename(upload.filename || '未命名.pdf').replace(/[\\/]/g, '') || '未命名.pdf';
      const confirmDuplicate = request.headers['x-studianda-confirm-duplicate'] === 'true';
      const document = await options.store.importDocument(tempPath, safeName, confirmDuplicate);
      return { ...document, chunks: options.store.listChunks(document.id).length };
    } catch (error) {
      if (error instanceof DuplicateImportError) return duplicateReply(reply, error);
      return badRequest(reply, error instanceof Error ? error.message : '上传失败');
    } finally {
      try {
        unlinkSync(tempPath);
      } catch {
        // 临时文件已清理
      }
    }
  });

  app.post(`${API_PREFIX}/documents/import`, async (request, reply) => {
    const body = request.body as {
      path?: unknown;
      confirmLarge?: unknown;
      confirmDuplicate?: unknown;
    } | null;
    if (!body || typeof body.path !== 'string' || body.path.trim() === '') {
      return badRequest(reply, '需要文件路径');
    }
    const warningThreshold = Number(process.env.STUDIANDA_LARGE_FILE_WARN_BYTES ?? 100 * 1024 * 1024);
    try {
      const stats = statSync(body.path);
      if (!body.confirmLarge && stats.size > warningThreshold) {
        return reply.code(409).send({
          error: API_ERROR_CODES.confirmationRequired,
          message:
            '这个 PDF 比较大。继续导入会增加解析时间；后续问答、翻译或 OCR 可能消耗更多 token、占用更多内存并变慢。' +
            '这不是硬性拒绝，确认后仍会导入。',
          details: {
            sizeBytes: stats.size,
            thresholdBytes: warningThreshold
          }
        });
      }
      return await options.store.importDocument(
        body.path,
        undefined,
        body.confirmDuplicate === true
      );
    } catch (error) {
      if (error instanceof DuplicateImportError) return duplicateReply(reply, error);
      return badRequest(reply, error instanceof Error ? error.message : '导入失败');
    }
  });

  // 导入任务：解析在后台跑，返回 jobId；前端轮询 /documents/import/jobs/:id 显示进度并可取消。
  app.post(`${API_PREFIX}/documents/import/start`, async (request, reply) => {
    const body = request.body as {
      path?: unknown;
      confirmLarge?: unknown;
      confirmDuplicate?: unknown;
    } | null;
    if (!body || typeof body.path !== 'string' || body.path.trim() === '') {
      return badRequest(reply, '需要文件路径');
    }
    const sourcePath = body.path;
    const warningThreshold = Number(process.env.STUDIANDA_LARGE_FILE_WARN_BYTES ?? 100 * 1024 * 1024);
    try {
      const stats = statSync(sourcePath);
      if (!body.confirmLarge && stats.size > warningThreshold) {
        return reply.code(409).send({
          error: API_ERROR_CODES.confirmationRequired,
          message:
            '这个 PDF 比较大。继续导入会增加解析时间；后续问答、翻译或 OCR 可能消耗更多 token、占用更多内存并变慢。' +
            '这不是硬性拒绝，确认后仍会导入。',
          details: {
            sizeBytes: stats.size,
            thresholdBytes: warningThreshold
          }
        });
      }
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '文件不存在');
    }

    const id = randomUUID();
    const record: ImportJobRecord = {
      id,
      state: 'queued',
      progress: 0,
      stage: 'queued',
      startedAt: new Date().toISOString()
    };
    importJobs.set(id, record);
    const confirmDuplicate = body.confirmDuplicate === true;
    void (async () => {
      record.state = 'running';
      try {
        const document = await options.store.importDocument(sourcePath, undefined, confirmDuplicate, {
          onProgress: (progress) => {
            record.progress = progress.percent;
            record.stage = progress.stage;
          },
          isCancelled: () => record.state === 'cancelling' || record.state === 'cancelled'
        });
        record.state = 'done';
        record.progress = 100;
        record.stage = 'done';
        record.documentId = document.id;
        record.documentName = document.name;
        record.pages = document.pages;
      } catch (error) {
        if (error instanceof ImportCancelledError) {
          record.state = 'cancelled';
          record.progress = 0;
          record.stage = 'cancelled';
        } else if (error instanceof DuplicateImportError) {
          const names = error.candidates.map((candidate) => candidate.name).slice(0, 3).join('；');
          record.state = 'failed';
          record.error = {
            code: 'duplicate_required',
            message: `文献库中已有相同或高度相似的文献：${names}`,
            details: {
              candidates: error.candidates,
              canOverride: error.canOverride
            }
          };
        } else {
          record.state = 'failed';
          record.error = {
            message: error instanceof Error ? error.message : '导入失败'
          };
        }
      } finally {
        record.finishedAt = new Date().toISOString();
      }
    })();
    // 任务记录保留 10 分钟供轮询；之后清理，避免内存无限增长。
    const cleanup = setTimeout(() => importJobs.delete(id), 10 * 60 * 1000);
    cleanup.unref?.();
    return { jobId: id };
  });

  app.get(`${API_PREFIX}/documents/import/jobs/:id`, async (request, reply) => {
    const { id } = request.params as { id: string };
    const record = importJobs.get(id);
    return record ?? notFound(reply, '导入任务不存在或已过期');
  });

  app.post(`${API_PREFIX}/documents/import/jobs/:id/cancel`, async (request, reply) => {
    const { id } = request.params as { id: string };
    const record = importJobs.get(id);
    if (!record) return notFound(reply, '导入任务不存在或已过期');
    if (record.state === 'queued' || record.state === 'running') {
      record.state = 'cancelling';
      record.stage = 'cancelling';
    }
    return record;
  });

  app.get(`${API_PREFIX}/documents/:id`, async (request, reply) => {
    const { id } = request.params as { id: string };
    const document = options.store.getDocument(id);
    return document ?? notFound(reply, '文档不存在');
  });
  app.post(`${API_PREFIX}/model/test`, async (request, reply) => {
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    // 用响应流的 close / request 的 aborted 判断真正的取消：
    // request.raw 的 'close' 在正常收完请求体时也会触发，会把还在跑的测试立刻取消。
    reply.raw.once('close', abort);
    request.raw.once('aborted', abort);
    try {
      return await testModelConnection(options.store, options.secrets, controller.signal);
    } finally {
      request.raw.off('aborted', abort);
      reply.raw.off('close', abort);
    }
  });

  app.get(`${API_PREFIX}/speech/config`, async () =>
    getSpeechConfig(options.store, options.secrets)
  );

  // 系统语音只读自检：不发送音频/文本，仅读取本机 Windows 语音组件信息。
  app.get(`${API_PREFIX}/speech/system`, async () => systemSpeechStatus());

  /**
   * 音色列表：按客户端当前正在编辑的播报方式取，而不是只按已保存的配置取。
   *
   * 关键约束：`mode=model` 时必须用「选中的平台连接 + 模型」取音色；拿不到连接就直接
   * 返回可操作的中文说明，**绝不回退**到 `config.tts_url`（旧版本存下来的 MiMo 地址）。
   * 之前正是这个回退导致用户「配置了模型，检测音色还是 MiMo」。
   */
  app.get(`${API_PREFIX}/speech/voices`, async (request) => {
    const query = request.query as {
      connection_id?: string;
      model?: string;
      mode?: string;
      url?: string;
    };
    const config = getSpeechConfig(options.store, options.secrets);
    const mode: 'system' | 'model' | 'custom' =
      query.mode === 'system' || query.mode === 'model' || query.mode === 'custom'
        ? query.mode
        : config.tts_mode;
    if (mode === 'model') {
      const connectionId = (query.connection_id ?? '').trim();
      if (!connectionId) {
        return {
          mode,
          voices: [],
          message:
            '模型服务模式需要先选择「语音平台」：请在上方选择平台与模型后再获取音色（不会回退到旧的 TTS 地址）。'
        };
      }
      const connection = resolveModelConnection(
        options.store,
        options.secrets,
        connectionId
      );
      if (!connection) {
        return {
          mode,
          connection_id: connectionId,
          voices: [],
          message: '模型服务连接不存在（可能已删除），请重新选择语音平台。'
        };
      }
      // 显式传来的 model（即使是空串）优先：避免用户换了模型后，服务端还拿已保存的旧模型名。
      const model = query.model !== undefined ? query.model.trim() : config.tts_model.trim();
      try {
        const list = await voicesForSpeechConnection(
          connection.baseUrl,
          connection.apiKey,
          model
        );
        return {
          mode,
          connection_id: connectionId,
          model,
          voices: list.voices.map((voice) => voice.id),
          labels: Object.fromEntries(list.voices.map((voice) => [voice.id, voice.label])),
          source: list.source,
          metadata_url: list.metadata_url,
          message: list.note
        };
      } catch (error) {
        return {
          mode,
          connection_id: connectionId,
          model,
          voices: [],
          message: error instanceof Error ? error.message : '获取音色失败'
        };
      }
    }
    if (mode === 'system') {
      try {
        const voices = await listSystemVoices();
        return {
          mode,
          voices,
          source: '系统语音',
          message:
            voices.length > 0
              ? `本机 Windows 已安装 ${voices.length} 个 TTS 音色；留空使用系统默认音色。`
              : '没有检测到已安装的系统 TTS 音色；可留空使用系统默认，或先安装 Windows 语音包。'
        };
      } catch {
        return {
          mode,
          voices: [],
          source: '系统语音',
          message: '系统语音音色列表读取失败，可留空使用系统默认。'
        };
      }
    }
    // 自定义 OpenAI 兼容服务：优先用客户端当前填写的地址（未保存也能取），其次已保存地址。
    const url = (query.url ?? config.tts_url).trim();
    const model = query.model !== undefined ? query.model.trim() : config.tts_model.trim();
    if (!url) return { mode, voices: [], message: '请先填写 TTS 服务地址。' };
    const key = options.secrets.get('speech.tts_key')?.trim() ?? '';
    const base = url.replace(/\/+$/, '');
    for (const path of ['/audio/voices', '/voices']) {
      try {
        const response = await fetch(`${base}${path}`, {
          headers: key ? { Authorization: `Bearer ${key}` } : {},
          signal: AbortSignal.timeout(15_000)
        });
        if (!response.ok) continue;
        const payload = (await response.json()) as {
          voices?: Array<unknown>;
          data?: Array<unknown>;
        };
        const rows = payload.voices ?? payload.data ?? [];
        const voices = rows
          .map((item) => {
            if (typeof item === 'string') return item;
            if (item && typeof item === 'object') {
              const value = item as Record<string, unknown>;
              return typeof value.id === 'string'
                ? value.id
                : typeof value.voice_id === 'string'
                  ? value.voice_id
                  : typeof value.name === 'string'
                    ? value.name
                    : '';
            }
            return '';
          })
          .filter(Boolean);
        if (voices.length > 0) {
          return {
            mode,
            url,
            model,
            voices,
            source: '服务接口',
            message: `来自 TTS 服务 ${base}${path} 的音色列表，共 ${voices.length} 个。`
          };
        }
      } catch {
        // try next path
      }
    }
    let host = '';
    try {
      host = new URL(url).hostname;
    } catch {
      host = '';
    }
    if (host === 'api.xiaomimimo.com') {
      const list = mimoVoiceList(model);
      return {
        mode,
        url,
        model,
        voices: list.voices.map((voice) => voice.id),
        labels: Object.fromEntries(list.voices.map((voice) => [voice.id, voice.label])),
        source: list.source,
        metadata_url: list.metadata_url,
        message: list.note
      };
    }
    return {
      mode,
      url,
      model,
      voices: [],
      message: '服务没有返回音色列表，可手动填写音色 ID。'
    };
  });

  app.put(`${API_PREFIX}/speech/config`, async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    try {
      return saveSpeechConfig(options.store, options.secrets, {
        input_enabled: typeof body.input_enabled === 'boolean' ? body.input_enabled : undefined,
        output_enabled: typeof body.output_enabled === 'boolean' ? body.output_enabled : undefined,
        auto_send: typeof body.auto_send === 'boolean' ? body.auto_send : undefined,
        auto_read: typeof body.auto_read === 'boolean' ? body.auto_read : undefined,
        correction: typeof body.correction === 'boolean' ? body.correction : undefined,
        context: typeof body.context === 'boolean' ? body.context : undefined,
        trigger_mode:
          body.trigger_mode === 'hold' || body.trigger_mode === 'click'
            ? body.trigger_mode
            : undefined,
        direct_audio:
          typeof body.direct_audio === 'boolean' ? body.direct_audio : undefined,
        language: typeof body.language === 'string' ? body.language : undefined,
        asr_mode: body.asr_mode as never,
        tts_mode: body.tts_mode as never,
        asr_url: typeof body.asr_url === 'string' ? body.asr_url : undefined,
        tts_url: typeof body.tts_url === 'string' ? body.tts_url : undefined,
        asr_model: typeof body.asr_model === 'string' ? body.asr_model : undefined,
        tts_model: typeof body.tts_model === 'string' ? body.tts_model : undefined,
        // 「模型服务」模式必须记住选的是哪条平台连接：只存模型名的话，识别/播报时
        // 无法找回服务地址与密钥，界面刷新后也会退回「选择平台/选择模型」。
        asr_connection_id:
          typeof body.asr_connection_id === 'string' ? body.asr_connection_id : undefined,
        tts_connection_id:
          typeof body.tts_connection_id === 'string' ? body.tts_connection_id : undefined,
        voice: typeof body.voice === 'string' ? body.voice : undefined,
        asr_key: typeof body.asr_key === 'string' ? body.asr_key : undefined,
        tts_key: typeof body.tts_key === 'string' ? body.tts_key : undefined,
        clear_asr: body.clear_asr === true,
        clear_tts: body.clear_tts === true
      });
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '保存语音配置失败');
    }
  });

  app.post(`${API_PREFIX}/speech/transcribe`, async (request, reply) => {
    let upload;
    try {
      upload = await request.file();
    } catch {
      return badRequest(reply, '需要 multipart 音频文件');
    }
    if (!upload) return badRequest(reply, '缺少音频文件');
    try {
      const bytes = await upload.toBuffer();
      const data = new Uint8Array(bytes);
      // 上传接口先做录音校验（WAV 严格解析；webm 等非 WAV 保持原有逻辑）。
      validateWav(data);
      return await transcribeAudio(
        options.store,
        options.secrets,
        data,
        upload.filename,
        upload.mimetype
      );
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '语音识别失败');
    }
  });

  app.post(`${API_PREFIX}/speech/speak`, async (request, reply) => {
    const body = (request.body ?? {}) as { text?: unknown };
    if (typeof body.text !== 'string' || !body.text.trim()) {
      return badRequest(reply, '需要 text');
    }
    try {
      const result = await synthesizeSpeech(options.store, options.secrets, body.text);
      return reply.header('content-type', result.contentType).send(Buffer.from(result.bytes));
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '语音播报失败');
    }
  });

  // 语音转写纠错：
  // 只校正转写文本，不回答问题；失败时由 correctTranscript 保留原文返回 needs_review。
  app.post(`${API_PREFIX}/speech/correct`, async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const documentId =
      typeof body.documentId === 'string'
        ? body.documentId
        : typeof body.document_id === 'string'
          ? body.document_id
          : '';
    const text = typeof body.text === 'string' ? body.text : '';
    const page = typeof body.page === 'number' ? body.page : Number(body.page);
    if (!text.trim()) return badRequest(reply, '需要非空 text');
    if (text.length > 8000) return badRequest(reply, '语音文本过长（上限 8000 字符）');
    if (!documentId) return badRequest(reply, '需要 documentId');
    const document = options.store.getDocument(documentId);
    if (!document) return notFound(reply, '文档不存在');
    if (!Number.isInteger(page) || page < 1 || page > document.pages) {
      return badRequest(reply, '页码超出范围');
    }
    const history = Array.isArray(body.history)
      ? (body.history as Array<Record<string, unknown>>)
          .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
          .map((item) => ({
            question: typeof item.question === 'string' ? item.question : undefined,
            answer: typeof item.answer === 'string' ? item.answer : undefined
          }))
      : undefined;
    try {
      return await correctTranscript(options.store, options.secrets, {
        documentId,
        page,
        text,
        history
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : '语音纠错失败';
      if (message === '语音输入未开启') {
        return reply.code(403).send({ error: API_ERROR_CODES.forbidden, message });
      }
      // 兜底：纠错链路的异常不应变成 500（正常情况下 correctTranscript 已自行吞掉）。
      return badRequest(reply, message);
    }
  });

  app.get(`${API_PREFIX}/web-search/config`, async () =>
    getSearchConfig(options.store, options.secrets)
  );

  app.put(`${API_PREFIX}/web-search/config`, async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    try {
      return saveSearchConfig(options.store, options.secrets, {
        provider: body.provider as never,
        base_url: typeof body.base_url === 'string' ? body.base_url : undefined,
        permission: body.permission as never,
        followup: typeof body.followup === 'boolean' ? body.followup : undefined,
        planner: typeof body.planner === 'boolean' ? body.planner : undefined,
        privacy_mode:
          body.privacy_mode === 'keywords-only' ||
          body.privacy_mode === 'question' ||
          body.privacy_mode === 'scope'
            ? body.privacy_mode
            : undefined,
        allow_question:
          typeof body.allow_question === 'boolean' ? body.allow_question : undefined,
        allow_history: typeof body.allow_history === 'boolean' ? body.allow_history : undefined,
        allow_selection:
          typeof body.allow_selection === 'boolean' ? body.allow_selection : undefined,
        allow_notes: typeof body.allow_notes === 'boolean' ? body.allow_notes : undefined,
        allow_annotations:
          typeof body.allow_annotations === 'boolean' ? body.allow_annotations : undefined,
        allow_answer: typeof body.allow_answer === 'boolean' ? body.allow_answer : undefined,
        allow_document: typeof body.allow_document === 'boolean' ? body.allow_document : undefined,
        allow_current_page:
          typeof body.allow_current_page === 'boolean' ? body.allow_current_page : undefined,
        allow_surrounding:
          typeof body.allow_surrounding === 'boolean' ? body.allow_surrounding : undefined,
        allow_title: typeof body.allow_title === 'boolean' ? body.allow_title : undefined,
        api_key: typeof body.api_key === 'string' ? body.api_key : undefined,
        clear_key: body.clear_key === true
      });
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '保存搜索配置失败');
    }
  });

  app.post(`${API_PREFIX}/web-search/search`, async (request, reply) => {
    const body = (request.body ?? {}) as { query?: unknown };
    if (typeof body.query !== 'string' || !body.query.trim()) {
      return badRequest(reply, '需要 query');
    }
    try {
      return await searchWeb(options.store, options.secrets, body.query.trim());
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '联网搜索失败');
    }
  });

  // 搜索计划（审批凭证）：先给出脱敏后的公共搜索词与 warning，review 模式下由用户确认后
  // 再把 token + confirmSearch 带进 /chat/ask。
  app.post(`${API_PREFIX}/search-plan`, async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    if (typeof body.question !== 'string' || !body.question.trim()) {
      return badRequest(reply, '需要 question');
    }
    try {
      return await createSearchPlan(options.store, options.secrets, {
        question: body.question,
        documentId: typeof body.documentId === 'string' ? body.documentId : undefined,
        selection: typeof body.selection === 'string' ? body.selection : undefined,
        history: Array.isArray(body.history) ? (body.history as never) : undefined,
        gap_claim: typeof body.gap_claim === 'string' ? body.gap_claim : undefined
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : '搜索计划生成失败';
      if (message.includes('允许联网搜索')) {
        return reply.code(403).send({ error: API_ERROR_CODES.forbidden, message });
      }
      if (message.includes('搜索规划失败')) {
        return reply.code(502).send({ error: API_ERROR_CODES.badGateway, message });
      }
      return badRequest(reply, message);
    }
  });

  app.get(`${API_PREFIX}/zotero/config`, async () =>
    getZoteroConfig(options.store, options.secrets)
  );

  app.put(`${API_PREFIX}/zotero/config`, async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    try {
      // WebDAV 附件模式要保存地址、账号与应用密码；少透传任何一个字段都会让
      // 用户在设置里填好却仍然下载不了附件（保存后地址变空）。
      return saveZoteroConfig(options.store, options.secrets, {
        mode: body.mode as never,
        library_type: body.library_type as never,
        library_id: typeof body.library_id === 'string' ? body.library_id : undefined,
        webdav_url: typeof body.webdav_url === 'string' ? body.webdav_url : undefined,
        webdav_user: typeof body.webdav_user === 'string' ? body.webdav_user : undefined,
        api_key: typeof body.api_key === 'string' ? body.api_key : undefined,
        clear_key: body.clear_key === true,
        webdav_password:
          typeof body.webdav_password === 'string' ? body.webdav_password : undefined,
        clear_password: body.clear_password === true
      });
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '保存 Zotero 配置失败');
    }
  });

  app.get(`${API_PREFIX}/zotero/collections`, async (_request, reply) => {
    try {
      return await listZoteroCollections(options.store, options.secrets);
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '读取 Zotero 分类失败');
    }
  });

  app.get(`${API_PREFIX}/zotero/items`, async (request, reply) => {
    const query = request.query as { collection?: string; start?: string; q?: string };
    const collection = (query.collection ?? '').trim();
    if (collection && !/^[A-Z0-9]{8}$/.test(collection)) {
      return badRequest(reply, '分类标识无效');
    }
    const start = query.start === undefined ? 0 : Number(query.start);
    if (!Number.isInteger(start) || start < 0) {
      return badRequest(reply, 'start 必须是非负整数');
    }
    const q = (query.q ?? '').trim();
    if (q.length > 500) return badRequest(reply, '搜索词过长（上限 500 字符）');
    try {
      return await listZoteroItems(
        options.store,
        options.secrets,
        collection,
        start,
        q
      );
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '读取 Zotero 条目失败');
    }
  });

  // Zotero 只读诊断：返回连接模式、成功/失败原因与可执行细节；不返回任何密钥。
  app.get(`${API_PREFIX}/zotero/diagnose`, async () => diagnoseZotero(options.store, options.secrets));

  app.post(`${API_PREFIX}/zotero/items/:key/open`, async (request, reply) => {
    const { key } = request.params as { key: string };
    const body = request.body as { confirmDuplicate?: unknown } | null;
    try {
      const attachment = await zoteroAttachment(options.store, options.secrets, key);
      return await options.store.importZoteroDocument({
        ...attachment,
        confirmDuplicate: body?.confirmDuplicate === true
      });
    } catch (error) {
      if (error instanceof DuplicateImportError) return duplicateReply(reply, error);
      return badRequest(reply, error instanceof Error ? error.message : '打开 Zotero 附件失败');
    }
  });

  app.post(
    `${API_PREFIX}/documents/:id/zotero-annotations/preview`,
    async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!options.store.getDocument(id)) return notFound(reply, '文档不存在');
      try {
        return await importZoteroAnnotations(options.store, options.secrets, id, false);
      } catch (error) {
        return badRequest(
          reply,
          error instanceof Error ? error.message : '读取 Zotero 批注与笔记失败'
        );
      }
    }
  );

  app.post(
    `${API_PREFIX}/documents/:id/zotero-annotations/import`,
    async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!options.store.getDocument(id)) return notFound(reply, '文档不存在');
      try {
        return await importZoteroAnnotations(options.store, options.secrets, id, true);
      } catch (error) {
        return badRequest(
          reply,
          error instanceof Error ? error.message : '导入 Zotero 批注与笔记失败'
        );
      }
    }
  );

  app.post(`${API_PREFIX}/zotero/test`, async () =>
    probeZotero(options.store, options.secrets)
  );

  app.get(`${API_PREFIX}/diagnostics`, async () =>
    generateDiagnostics(options.store, { name: APP_NAME, version: options.version })
  );

  // 文件健康检查：只 stat 文献文件是否存在，不读正文、不修改记录；缺失的可在文献列表里手动重连。
  app.get(`${API_PREFIX}/maintenance/file-health`, async (): Promise<FileHealthReport> => {
    const rows = options.store.documentHealth();
    const issues = rows
      .filter((row) => row.missing)
      .map((row) => ({ documentId: row.documentId, name: row.name, path: row.path }));
    return {
      checked: rows.length,
      ok: rows.length - issues.length,
      missing: issues.length,
      issues
    };
  });

  // 运维维护状态：只做 stat/目录计数，不读用户正文或 PDF。任何一步失败都给 0/空，不 500。
  app.get(`${API_PREFIX}/maintenance/status`, async (): Promise<MaintenanceStatus> => {
    const dataDir = options.store.dataDir;
    const sizeOf = (file: string): number => {
      try {
        const info = statSync(file);
        return info.isFile() ? info.size : 0;
      } catch {
        return 0;
      }
    };
    let diagnosticsCount = 0;
    try {
      const folder = path.join(dataDir, 'diagnostics');
      if (existsSync(folder)) {
        diagnosticsCount = readdirSync(folder).filter(
          (name) => name.startsWith('studianda-diagnostics-') && name.endsWith('.zip')
        ).length;
      }
    } catch {
      diagnosticsCount = 0;
    }
    let backups: ReturnType<typeof listBackups> = [];
    try {
      backups = listBackups(dataDir);
    } catch {
      backups = [];
    }
    return {
      version: options.version,
      data_dir: dataDir,
      database_bytes: sizeOf(path.join(dataDir, 'reader.sqlite3')),
      log_bytes:
        sizeOf(path.join(dataDir, 'application.log')) +
        sizeOf(path.join(dataDir, 'application.log.1')),
      diagnostics_count: diagnosticsCount,
      backups_count: backups.length,
      ...(backups[0]?.name ? { last_backup: backups[0].name } : {}),
      platform: process.platform,
      uptime_seconds: Math.max(0, Math.round((Date.now() - startedAt) / 1000)),
      // 当前 core 进程 PID；孤儿 core 进程守护尚未实现（不伪称已守护）。
      core_pid: process.pid
    };
  });

  // 诊断包：只含脱敏诊断报告 + 最近错误日志，不含 PDF/正文；最多保留 5 个。
  app.post(`${API_PREFIX}/maintenance/diagnostics`, async (_request, reply) => {
    try {
      return createDiagnosticsPackage(options.store, {
        name: APP_NAME,
        version: options.version
      });
    } catch (error) {
      return reply.code(500).send({
        error: API_ERROR_CODES.diagnosticsFailed,
        message: error instanceof Error ? error.message : '生成诊断包失败'
      });
    }
  });

  app.get(`${API_PREFIX}/maintenance/diagnostics`, async () =>
    listDiagnosticsPackages(options.store)
  );

  // 清空全部本地用户数据（合规整改 P1-6）：必须显式 `confirm: true`，避免误触/误调。
  // 只删用户内容（文献/笔记/批注/会话/译文/索引/缓存/备份/诊断包）；settings 与 secrets
  // （模型配置、密钥）保留，清空后不需要重新配置模型。返回 shared 的 ClearUserDataResult。
  app.post(
    `${API_PREFIX}/maintenance/clear-user-data`,
    async (request, reply): Promise<ClearUserDataResult | FastifyReply> => {
      const body = request.body as { confirm?: unknown } | null | undefined;
      if (body?.confirm !== true) {
        return badRequest(reply, '清空数据需要显式确认（confirm: true）');
      }
      // 先取消所有进行中的文献请求/翻译/Markdown 任务：避免后台任务在删除后继续写回已删数据；
      // 同时清掉内存里的搜索计划（含用户问题派生的关键词）。
      for (const documentId of [...documentRequests.keys()]) abortDocumentRequests(documentId);
      for (const document of [...options.store.listDocuments(), ...options.store.listDocuments(true)]) {
        stopDocumentTranslation(document.id);
      }
      cancelMarkdownScan();
      cancelMarkdownImport();
      resetSearchPlans();
      try {
        return options.store.clearUserData();
      } catch (error) {
        return reply.code(500).send({
          error: API_ERROR_CODES.internal,
          message: error instanceof Error ? error.message : '清空用户数据失败'
        });
      }
    }
  );

  app.get(`${API_PREFIX}/parsing/config`, async () =>
    getParsingConfig(options.store, options.secrets)
  );

  app.put(`${API_PREFIX}/parsing/config`, async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    try {
      return saveParsingConfig(options.store, options.secrets, {
        mode: body.mode as never,
        connection_id: typeof body.connection_id === 'string' ? body.connection_id : undefined,
        model: typeof body.model === 'string' ? body.model : undefined,
        service_url: typeof body.service_url === 'string' ? body.service_url : undefined,
        allow_remote: typeof body.allow_remote === 'boolean' ? body.allow_remote : undefined,
        mineru_online_model: body.mineru_online_model as never,
        // 空文本页自动 OCR 是用户显式开关；不透传会让界面勾选后永远退回关闭。
        auto_ocr: typeof body.auto_ocr === 'boolean' ? body.auto_ocr : undefined,
        // 本机 Tesseract 语言包选择：其它模式也可保存，但只有 local 实际生效。
        ocr_langs: Array.isArray(body.ocr_langs)
          ? (body.ocr_langs as string[])
          : undefined,
        service_key: typeof body.service_key === 'string' ? body.service_key : undefined,
        clear_service_key: body.clear_service_key === true
      });
    } catch (error) {
      if (error instanceof ParsingConfigError) {
        return reply.code(error.status).send({ error: API_ERROR_CODES.badRequest, message: error.message });
      }
      return badRequest(reply, error instanceof Error ? error.message : '保存识别配置失败');
    }
  });

  // 识别服务只读自检：不发送页面内容、不写库、不发起网络探测。
  app.post(`${API_PREFIX}/parsing/check`, async () =>
    checkParsingService(options.store, options.secrets)
  );

  // 本机 Tesseract 语言包：只读目录/安装状态；下载必须显式 POST（不自动联网）。
  app.get(`${API_PREFIX}/parsing/ocr-languages`, async () =>
    ocrLanguageStatus(options.store)
  );

  app.post(`${API_PREFIX}/parsing/ocr-languages/download`, async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const codes = Array.isArray(body.codes)
      ? body.codes.filter((code): code is string => typeof code === 'string')
      : [];
    try {
      return downloadOcrLanguages(options.store, codes);
    } catch (error) {
      return reply.code(400).send({
        error: API_ERROR_CODES.badRequest,
        message: error instanceof Error ? error.message : '下载语言包失败'
      });
    }
  });

  app.get(`${API_PREFIX}/translation/config`, async () => translationConfig(options));

  // 只保存目标语言；翻译服务本身在「模型服务」里按用途路由配置。
  app.put(`${API_PREFIX}/translation/config`, async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    if (body.target_language !== undefined) {
      if (typeof body.target_language !== 'string') {
        return badRequest(reply, 'target_language 必须是字符串');
      }
      options.store.updateSettings({
        'translation.target_language': body.target_language.trim()
      });
    }
    return translationConfig(options);
  });

  // 选文翻译：只翻用户选中的一小段，不落库、不保存设置、不发送整页。
  app.post(`${API_PREFIX}/translation/quote`, async (request, reply) => {
    const body = (request.body ?? {}) as { text?: unknown; language?: unknown };
    if (typeof body.text !== 'string' || !body.text.trim()) {
      return badRequest(reply, '需要待翻译的选文');
    }
    if (body.text.length > 5000) return badRequest(reply, '选文过长（上限 5000 字符）');
    try {
      return await translateQuote(options.store, options.secrets, {
        text: body.text,
        language: typeof body.language === 'string' ? body.language : undefined
      });
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '选文翻译失败');
    }
  });

  // 试译一句：不发送文献内容、不保存设置；没有配置时返回 ok=false（不是 500）。
  app.post(`${API_PREFIX}/translation/probe`, async (request, reply) => {
    const body = (request.body ?? {}) as { text?: unknown };
    if (body.text !== undefined && typeof body.text !== 'string') {
      return badRequest(reply, 'text 必须是字符串');
    }
    const text = typeof body.text === 'string' ? body.text : undefined;
    if (text !== undefined && text.length > 500) {
      return badRequest(reply, '试译文本过长（上限 500 字符）');
    }
    try {
      return await probeTranslation(options.store, options.secrets, text);
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '试译失败');
    }
  });

  app.get(`${API_PREFIX}/documents/:id/translation/summary`, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!options.store.getDocument(id)) return notFound(reply, '文档不存在');
    return options.store.translationServiceSummary(id);
  });

  // 批注页的原文与译文对照（只读，不自动建批注）。
  app.get(`${API_PREFIX}/documents/:id/translation/annotations`, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!options.store.getDocument(id)) return notFound(reply, '文档不存在');
    try {
      return annotationTranslations(options.store, id, options.store.listAnnotations(id));
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '读取批注译文失败');
    }
  });

  // 整篇翻译进度：逐页状态 + 后台任务（工作台可显示"已翻 N/M 页/继续翻译"）。
  app.get(`${API_PREFIX}/documents/:id/translation/progress`, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!options.store.getDocument(id)) return notFound(reply, '文档不存在');
    return translationProgress(options.store, id);
  });

  // 批量翻译状态：工作台 N 张卡片一次请求拿齐，不用逐篇轮询。
  app.get(`${API_PREFIX}/translation/overview`, async (request) => {
    const query = request.query as { ids?: string };
    const requested = (query.ids ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean);
    const ids =
      requested.length > 0
        ? requested
        : options.store.listDocuments(false).slice(0, 100).map((document) => document.id);
    return translationOverview(options.store, ids);
  });

  app.get(`${API_PREFIX}/documents/:id/translation`, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!options.store.getDocument(id)) return notFound(reply, '文档不存在');
    return translationJobState(options.store, id) ?? {
      documentId: id,
      status: 'idle',
      total: 0,
      done: 0,
      currentPage: null,
      error: ''
    };
  });

  app.post(`${API_PREFIX}/documents/:id/translation`, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!options.store.getDocument(id)) return notFound(reply, '文档不存在');
    const body = (request.body ?? {}) as {
      pages?: unknown;
      language?: unknown;
      force?: unknown;
      include_furniture?: unknown;
    };
    const pages = Array.isArray(body.pages)
      ? body.pages.filter((page): page is number => Number.isInteger(page))
      : undefined;
    try {
      return startDocumentTranslation(options.store, options.secrets, id, {
        pages,
        language: typeof body.language === 'string' ? body.language : undefined,
        force: body.force === true,
        includeFurniture: body.include_furniture === true
      });
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '翻译失败');
    }
  });

  app.post(`${API_PREFIX}/documents/:id/translation/stop`, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!options.store.getDocument(id)) return notFound(reply, '文档不存在');
    const state = stopDocumentTranslation(id);
    if (state) options.store.saveTranslationJob(state);
    return (
      state ?? {
        documentId: id,
        status: 'idle',
        total: 0,
        done: 0,
        currentPage: null,
        error: ''
      }
    );
  });

  app.patch(
    `${API_PREFIX}/documents/:id/translation/segments/:segmentId`,
    async (request, reply) => {
      const { id, segmentId } = request.params as { id: string; segmentId: string };
      if (!options.store.getDocument(id)) return notFound(reply, '文档不存在');
      const body = (request.body ?? {}) as { text?: unknown };
      if (typeof body.text !== 'string' || !body.text.trim()) {
        return badRequest(reply, '需要非空 text');
      }
      try {
        return options.store.editTranslationSegment(id, segmentId, body.text);
      } catch (error) {
        return reply.code(404).send({
          error: API_ERROR_CODES.notFound,
          message: error instanceof Error ? error.message : '译文不存在'
        });
      }
    }
  );

  app.post(
    `${API_PREFIX}/documents/:id/translation/segments/:segmentId/restore`,
    async (request, reply) => {
      const { id, segmentId } = request.params as { id: string; segmentId: string };
      if (!options.store.getDocument(id)) return notFound(reply, '文档不存在');
      try {
        return options.store.restoreTranslationSegment(id, segmentId);
      } catch (error) {
        return reply.code(404).send({
          error: API_ERROR_CODES.notFound,
          message: error instanceof Error ? error.message : '译文不存在'
        });
      }
    }
  );

  app.post(`${API_PREFIX}/documents/:id/translation/pages/:page`, async (request, reply) => {
    const { id, page: rawPage } = request.params as { id: string; page: string };
    if (!options.store.getDocument(id)) return notFound(reply, '文档不存在');
    const page = Number(rawPage);
    if (!Number.isInteger(page) || page < 1) {
      return badRequest(reply, '页码必须是正整数');
    }
    const body = (request.body ?? {}) as {
      language?: unknown;
      force?: unknown;
      include_furniture?: unknown;
    };
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    const untrackDocument = trackDocumentRequests([id], controller);
    // 用响应流的 close / request 的 aborted 判断真正的取消：
    // request.raw 的 'close' 在正常收完请求体时也会触发，会让翻译一开始就被取消（499）。
    reply.raw.once('close', abort);
    request.raw.once('aborted', abort);
    try {
      return await translatePage(options.store, options.secrets, id, page, {
        language: typeof body.language === 'string' ? body.language : undefined,
        force: body.force === true,
        includeFurniture: body.include_furniture === true,
        signal: controller.signal
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        return reply.code(499).send({ error: API_ERROR_CODES.cancelled, message: '翻译已取消' });
      }
      return badRequest(reply, error instanceof Error ? error.message : '翻译失败');
    } finally {
      untrackDocument();
      request.raw.off('aborted', abort);
      reply.raw.off('close', abort);
    }
  });

  // 单段重译：只把这一段 source 送模型，更新目标段后返回整页 payload（UI 直接替换）。
  app.post(
    `${API_PREFIX}/documents/:id/translation/pages/:page/segments/:index`,
    async (request, reply) => {
      const { id, page: rawPage, index: rawIndex } = request.params as {
        id: string;
        page: string;
        index: string;
      };
      if (!options.store.getDocument(id)) return notFound(reply, '文档不存在');
      const page = Number(rawPage);
      const index = Number(rawIndex);
      if (!Number.isInteger(page) || page < 1) {
        return badRequest(reply, '页码必须是正整数');
      }
      if (!Number.isInteger(index) || index < 0) {
        return badRequest(reply, '段号必须是非负整数');
      }
      const body = (request.body ?? {}) as { language?: unknown };
      try {
        return await retranslateTranslationSegment(
          options.store,
          options.secrets,
          id,
          page,
          index,
          typeof body.language === 'string' ? body.language : undefined
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : '重译失败';
        if (message === '文档不存在' || message.includes('不存在')) {
          return notFound(reply, message);
        }
        return badRequest(reply, message);
      }
    }
  );

  // 译文锚点：把译文里选中的一小段映射回原文（句级对齐优先）+ 原页 bbox；只读，不写库/不建批注。
  app.post(`${API_PREFIX}/documents/:id/translation/anchor`, async (request, reply) => {
    const { id } = request.params as { id: string };
    const document = options.store.getDocument(id);
    if (!document) return notFound(reply, '文档不存在');
    const body = (request.body ?? {}) as {
      page?: unknown;
      excerpt?: unknown;
      segment?: unknown;
    };
    const page = typeof body.page === 'number' ? body.page : Number(body.page);
    if (!Number.isInteger(page) || page < 1 || page > document.pages) {
      return badRequest(reply, '页码超出范围');
    }
    if (typeof body.excerpt !== 'string' || !body.excerpt.trim()) {
      return badRequest(reply, '需要非空 excerpt');
    }
    if (body.excerpt.length > 5000) {
      return badRequest(reply, '选中的译文过长（上限 5000 字符）');
    }
    const segment =
      body.segment === undefined || body.segment === null
        ? undefined
        : Number(body.segment);
    if (segment !== undefined && (!Number.isInteger(segment) || segment < 0)) {
      return badRequest(reply, '段号必须是非负整数');
    }
    try {
      return await anchorTranslationSelection(
        options.store,
        id,
        page,
        body.excerpt,
        segment
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : '定位译文失败';
      if (message.includes('文档不存在')) return notFound(reply, message);
      return badRequest(reply, message);
    }
  });

  // 按文字反查属于哪一段译文（只显示译文时也能定位原文）；只读。
  app.get(`${API_PREFIX}/documents/:id/translation/lookup`, async (request, reply) => {
    const { id } = request.params as { id: string };
    const document = options.store.getDocument(id);
    if (!document) return notFound(reply, '文档不存在');
    const query = request.query as { page?: string; quote?: string };
    const page = Number(query.page ?? 1);
    if (!Number.isInteger(page) || page < 1 || page > document.pages) {
      return badRequest(reply, '页码超出范围');
    }
    const quote = typeof query.quote === 'string' ? query.quote.slice(0, 2000) : '';
    try {
      return { matches: lookupTranslationSegments(options.store, id, page, quote) };
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '查找译文失败');
    }
  });

  app.post(`${API_PREFIX}/documents/:id/snapshot`, async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      return await options.store.snapshotZoteroDocument(id);
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '保存本机副本失败');
    }
  });

  app.get(`${API_PREFIX}/documents/:id/pages/:page/text`, async (request, reply) => {
    const { id, page: rawPage } = request.params as { id: string; page: string };
    if (!options.store.getDocument(id)) return notFound(reply, '文档不存在');
    const page = Number(rawPage);
    if (!Number.isInteger(page) || page < 1) return badRequest(reply, '页码必须是正整数');
    const edit = options.store.getPageEdit(id, page);
    return {
      page,
      text: options.store.getPageText(id, page),
      origin: edit?.origin ?? 'native',
      boxes: edit?.boxes ?? ''
    };
  });

  app.put(`${API_PREFIX}/documents/:id/pages/:page/text`, async (request, reply) => {
    const { id, page: rawPage } = request.params as { id: string; page: string };
    const document = options.store.getDocument(id);
    if (!document) return notFound(reply, '文档不存在');
    const page = Number(rawPage);
    if (!Number.isInteger(page) || page < 1) return badRequest(reply, '页码必须是正整数');
    if (page > document.pages) return badRequest(reply, '页码超出范围');
    const body = (request.body ?? {}) as { text?: unknown };
    if (typeof body.text !== 'string') return badRequest(reply, '需要 text');
    if (!body.text.trim()) return badRequest(reply, '页文本不能为空');
    if (body.text.length > 500_000) return badRequest(reply, '页文本过长（上限 500000 字符）');
    return options.store.savePageTextEdit(id, page, body.text);
  });

  // 页数据：
  // 返回归一化行坐标 + 该页生效的遮罩，界面用于文字层/高亮对齐。
  app.get(`${API_PREFIX}/documents/:id/pages/:page`, async (request, reply) => {
    const { id, page: rawPage } = request.params as { id: string; page: string };
    const document = options.store.getDocument(id);
    if (!document) return notFound(reply, '文档不存在');
    const page = Number(rawPage);
    if (!Number.isInteger(page) || page < 1) return badRequest(reply, '页码必须是正整数');
    if (page > document.pages) return badRequest(reply, '页码超出范围');
    try {
      // 旧 OCR 页只有整页文本、没有行框：按需补识别一次（失败静默），再读版面。
      const editBefore = options.store.getPageEdit(id, page);
      const oldOcrPage =
        editBefore?.origin === 'ocr' &&
        Boolean(editBefore.text.trim()) &&
        !hasUsableOcrBoxes(editBefore.boxes);
      if (oldOcrPage) {
        await ensureOcrBoxes(options.store, options.secrets, id, page).catch(() => undefined);
      }
      const layout = await options.store.getPageLayout(id);
      const pageLayout = layout?.pages.find((item) => item.page === page) ?? null;
      const masks = options.store.listPageMasks(id);
      const lines = pageLayout ? visibleLines(pageLayout, masks) : [];
      // width/height 是 PDF 点（只用于比例换算）；布局缺失时退回行 bbox 最大边界。
      const width =
        pageLayout?.width ??
        (lines.length > 0 ? Math.max(...lines.map((line) => line.bbox[2])) : 1);
      const height =
        pageLayout?.height ??
        (lines.length > 0 ? Math.max(...lines.map((line) => line.bbox[3])) : 1);
      const payload: PageData = {
        page,
        width,
        height,
        lines: lines.map((line) => ({ text: line.text, bbox: line.bbox })),
        masks: masksForPage(masks, page),
        masks_revision: options.store.pageMaskRevision(id)
      };
      if (oldOcrPage) {
        // 补出来的 lines 来自 OCR 行框（原本就没有文本项），不伪造 spans；遮罩过滤沿用上面逻辑。
        payload.spans = [];
      } else {
        // 文本项粒度 + 旋转矩阵：比整行更细，供前端精确对齐选区；失败不影响页数据。
        try {
          const documentPath = options.store.getDocumentPath(id);
          if (documentPath) {
            const spanInfo = await getPageSpans(documentPath, page);
            payload.spans = spanInfo.spans.map((span) => ({
              text: span.text,
              bbox: span.bbox
            }));
            payload.rotation_matrix = spanInfo.rotationMatrix;
          }
        } catch {
          // 可选增强：拿不到就不返回 spans。
        }
      }
      return payload;
    } catch (error) {
      if (error instanceof AttachmentChangedError) {
        return reply.code(409).send({ error: API_ERROR_CODES.attachmentChanged, message: error.message });
      }
      return notFound(reply, error instanceof Error ? error.message : '页面数据不可用');
    }
  });

  // 页图：整页渲染 PNG；`width` 只允许缩小（>160 才处理），不放大。
  app.get(`${API_PREFIX}/documents/:id/pages/:page/image`, async (request, reply) => {
    const { id, page: rawPage } = request.params as { id: string; page: string };
    const document = options.store.getDocument(id);
    if (!document) return notFound(reply, '文档不存在');
    const page = Number(rawPage);
    if (!Number.isInteger(page) || page < 1) return badRequest(reply, '页码必须是正整数');
    if (page > document.pages) return badRequest(reply, '页码超出范围');
    const query = request.query as { width?: string };
    const requested = query.width === undefined ? 0 : Number(query.width);
    try {
      const rendered = await renderPdfPage(id, page, options.store, 2);
      const png = await scalePagePng(rendered.png, rendered.width, requested);
      return reply
        .header('content-type', 'image/png')
        .header('cache-control', 'private, max-age=3600')
        .send(png);
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '页面图像不可用');
    }
  });

  // 缩略图：固定小宽度，复用同一缩放逻辑。
  app.get(`${API_PREFIX}/documents/:id/pages/:page/thumbnail`, async (request, reply) => {
    const { id, page: rawPage } = request.params as { id: string; page: string };
    const document = options.store.getDocument(id);
    if (!document) return notFound(reply, '文档不存在');
    const page = Number(rawPage);
    if (!Number.isInteger(page) || page < 1) return badRequest(reply, '页码必须是正整数');
    if (page > document.pages) return badRequest(reply, '页码超出范围');
    try {
      const rendered = await renderPdfPage(id, page, options.store, 2);
      const png = await scalePagePng(rendered.png, rendered.width, THUMBNAIL_WIDTH);
      return reply
        .header('content-type', 'image/png')
        .header('cache-control', 'private, max-age=3600')
        .send(png);
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '页面缩略图不可用');
    }
  });

  app.get(`${API_PREFIX}/documents/:id/translation/pages`, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!options.store.getDocument(id)) return notFound(reply, '文档不存在');
    return options.store.listTranslationPages(id);
  });

  app.get(`${API_PREFIX}/documents/:id/translation/pages/:page`, async (request, reply) => {
    const { id, page: rawPage } = request.params as { id: string; page: string };
    if (!options.store.getDocument(id)) return notFound(reply, '文档不存在');
    const page = Number(rawPage);
    if (!Number.isInteger(page) || page < 1) {
      return badRequest(reply, '页码必须是正整数');
    }
    // 按当前分段重新对齐旧译文：分段算法升级后，旧译文行（例如把表格单元格翻成正文、
    // 参考文献挤成一段）如果哈希已不一致，会标记 stale 并清空，避免继续显示错误结果。
    return getTranslationPagePayload(options.store, id, page);
  });

  app.get(`${API_PREFIX}/documents/:id/export`, async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const exported = options.store.exportMarkdown(id);
      return reply
        .header('content-type', 'text/markdown; charset=utf-8')
        .header('content-disposition', 'attachment; filename="reading-notes.md"')
        .send(exported.markdown);
    } catch (error) {
      return notFound(reply, error instanceof Error ? error.message : '导出失败');
    }
  });

  app.get(`${API_PREFIX}/documents/:id/annotated.pdf`, async (request, reply) => {
    const { id } = request.params as { id: string };
    const document = options.store.getDocument(id);
    if (!document) return notFound(reply, '文档不存在');
    try {
      const exported = await options.store.exportAnnotatedPdf(id);
      return reply
        .header('content-type', 'application/pdf')
        // 固定名会让多篇文献互相覆盖；用「文献名-批注副本.pdf」并给 ASCII 兜底。
        .header('content-disposition', annotatedContentDisposition(document.name))
        .header('cache-control', 'no-store')
        .header('x-studianda-placed', String(exported.placed))
        .header('x-studianda-unplaced', String(exported.unplaced))
        .header('x-studianda-unplaced-reasons', JSON.stringify(exported.unplacedReasons))
        .send(Buffer.from(exported.bytes));
    } catch (error) {
      const message = error instanceof Error ? error.message : '导出 PDF 失败';
      // 打不开/写不出/加密等文件级失败：用 409 表明"原文件未改动"，与参数错误区分。
      if (/未改动|写入|打开|占用|加密|锁定/.test(message)) {
        return reply.code(409).send({ error: API_ERROR_CODES.exportFailed, message });
      }
      return badRequest(reply, message);
    }
  });

  app.patch(`${API_PREFIX}/documents/:id`, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as {
      currentPage?: unknown;
      name?: unknown;
      author?: unknown;
      docType?: unknown;
      folderId?: unknown;
    };
    try {
      const document = options.store.updateDocument(id, {
        currentPage:
          typeof body.currentPage === 'number' && Number.isFinite(body.currentPage)
            ? body.currentPage
            : undefined,
        name: typeof body.name === 'string' ? body.name : undefined,
        author: typeof body.author === 'string' ? body.author : undefined,
        // 文献类型（Zotero itemType 原文，'' = 未分类）与文件夹归属（'' = 未分类）。
        docType: typeof body.docType === 'string' ? body.docType : undefined,
        folderId: typeof body.folderId === 'string' ? body.folderId : undefined
      });
      return document ?? notFound(reply, '文档不存在');
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '更新失败');
    }
  });

  // 默认排序拖拽：把文献移动到 beforeId 与 afterId 之间（null 表示最前/最后）。
  app.post(`${API_PREFIX}/documents/:id/move`, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { beforeId?: unknown; afterId?: unknown };
    if (body.beforeId != null && typeof body.beforeId !== 'string') {
      return badRequest(reply, 'beforeId 必须是字符串或 null');
    }
    if (body.afterId != null && typeof body.afterId !== 'string') {
      return badRequest(reply, 'afterId 必须是字符串或 null');
    }
    try {
      return options.store.moveDocument(id, {
        beforeId: (body.beforeId as string | null | undefined) ?? null,
        afterId: (body.afterId as string | null | undefined) ?? null
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : '移动文献失败';
      if (message === '文献不存在' || message === '相邻文献不存在') {
        return notFound(reply, message);
      }
      return badRequest(reply, message);
    }
  });

  app.delete(`${API_PREFIX}/documents/:id`, async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      options.store.deleteDocument(id);
      return { ok: true };
    } catch (error) {
      return notFound(reply, error instanceof Error ? error.message : '文档不存在');
    }
  });

  app.post(`${API_PREFIX}/documents/:id/restore`, async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      options.store.restoreDocument(id);
      return { ok: true };
    } catch (error) {
      return notFound(reply, error instanceof Error ? error.message : '文档不存在');
    }
  });

  app.post(`${API_PREFIX}/documents/:id/purge`, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { confirmName?: unknown };
    if (typeof body.confirmName !== 'string') return badRequest(reply, '需要确认文献名称');
    try {
      // 彻底删除是破坏性操作：先停掉这份文献上正在进行的阅读/翻译请求，
      // 否则后台任务会继续写已删除的数据，并在控制台抛出“文档不存在”。
      abortDocumentRequests(id);
      stopDocumentTranslation(id);
      options.store.purgeDocument(id, body.confirmName);
      return { ok: true };
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '彻底删除失败');
    }
  });

  app.put(`${API_PREFIX}/documents/:id/tags`, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { tags?: unknown };
    if (!Array.isArray(body.tags) || !body.tags.every((tag) => typeof tag === 'string')) {
      return badRequest(reply, 'tags 必须是字符串数组');
    }
    try {
      const tags = options.store.setDocumentTags(id, body.tags as string[]);
      return { ok: true, tags };
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '保存标签失败');
    }
  });

  app.put(`${API_PREFIX}/documents/:id/author`, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { author?: unknown };
    if (typeof body.author !== 'string') return badRequest(reply, 'author 必须是字符串');
    const document = options.store.updateDocument(id, { author: body.author });
    return document ?? notFound(reply, '文档不存在');
  });

  app.post(`${API_PREFIX}/documents/:id/relink`, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { path?: unknown; confirmLarge?: unknown } | null;
    if (!body || typeof body.path !== 'string' || body.path.trim() === '') {
      return badRequest(reply, '需要文件路径');
    }
    const warningThreshold = Number(process.env.STUDIANDA_LARGE_FILE_WARN_BYTES ?? 100 * 1024 * 1024);
    try {
      const stats = statSync(body.path);
      if (!body.confirmLarge && stats.size > warningThreshold) {
        return reply.code(409).send({
          error: API_ERROR_CODES.confirmationRequired,
          message:
            '这个 PDF 比较大。继续重新连接会增加解析时间，后续问答/翻译/OCR 可能消耗更多 token 并变慢。' +
            '确认后仍会重新连接并重建索引。',
          details: { sizeBytes: stats.size, thresholdBytes: warningThreshold }
        });
      }
      return await options.store.relinkDocument(id, body.path);
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '重新连接失败');
    }
  });

  app.get(`${API_PREFIX}/documents/:id/file`, async (request, reply) => {
    const { id } = request.params as { id: string };
    const filePath = options.store.getDocumentPath(id);
    if (!filePath) return notFound(reply, '文档文件不存在');
    const size = statSync(filePath).size;
    const range = request.headers.range;
    reply.header('accept-ranges', 'bytes');
    reply.header('content-type', 'application/pdf');
    reply.header('content-disposition', 'inline');
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      if (!match) {
        return reply.code(416).header('content-range', `bytes */${size}`).send();
      }
      const start = match[1] ? Number(match[1]) : 0;
      const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
      if (start > end || start >= size) {
        return reply.code(416).header('content-range', `bytes */${size}`).send();
      }
      return reply
        .code(206)
        .header('content-range', `bytes ${start}-${end}/${size}`)
        .header('content-length', String(end - start + 1))
        .send(createReadStream(filePath, { start, end }));
    }
    return reply.header('content-length', String(size)).send(createReadStream(filePath));
  });

  app.get(`${API_PREFIX}/documents/:id/annotations`, async (request) => {
    const { id } = request.params as { id: string };
    const query = request.query as { trash?: string };
    return options.store.listAnnotations(id, query.trash === 'true' || query.trash === '1');
  });

  app.post(`${API_PREFIX}/annotations`, async (request, reply) => {
    const body = request.body as
      | {
          documentId?: unknown;
          page?: unknown;
          quote?: unknown;
          content?: unknown;
          rects?: unknown;
          color?: unknown;
          style?: unknown;
        }
      | null;
    if (!body || typeof body.documentId !== 'string' || typeof body.page !== 'number') {
      return badRequest(reply, '需要 documentId 与 page');
    }
    if (!options.store.getDocument(body.documentId)) return notFound(reply, '文档不存在');
    try {
      return options.store.createAnnotation({
        documentId: body.documentId,
        page: body.page,
        quote: typeof body.quote === 'string' ? body.quote : '',
        content: typeof body.content === 'string' ? body.content : '',
        rects: typeof body.rects === 'string' ? body.rects : '',
        color: typeof body.color === 'string' ? body.color : 'yellow',
        style: typeof body.style === 'string' ? body.style : 'highlight'
      });
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '保存批注失败');
    }
  });

  app.patch(`${API_PREFIX}/annotations/:id`, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as {
      content?: unknown;
      color?: unknown;
      style?: unknown;
    };
    const annotation = options.store.updateAnnotation(id, {
      content: typeof body.content === 'string' ? body.content : undefined,
      color: typeof body.color === 'string' ? body.color : undefined,
      style: typeof body.style === 'string' ? body.style : undefined
    });
    return annotation ?? notFound(reply, '批注不存在');
  });

  app.delete(`${API_PREFIX}/annotations/:id`, async (request, reply) => {
    const { id } = request.params as { id: string };
    options.store.deleteAnnotation(id);
    return reply.code(204).send();
  });

  // 彻底删除批注（不可恢复）并回收其独占图片资源。
  app.delete(`${API_PREFIX}/annotations/:id/purge`, async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      return options.store.purgeAnnotation(id);
    } catch (error) {
      return notFound(reply, error instanceof Error ? error.message : '批注不存在');
    }
  });

  // 从回收站恢复软删除的批注。
  app.post(`${API_PREFIX}/annotations/:id/restore`, async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      options.store.restoreAnnotation(id);
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : '恢复批注失败';
      if (message === '批注不存在') return notFound(reply, message);
      return badRequest(reply, message);
    }
  });

  // 阅读伙伴会话清单存在 settings 表（JSON），不新增表；消息归属靠 metadata.sessionId。
  // 读写在 document-chat-sessions.ts（阅读摘要压缩也会更新其中的 contextSummary）。

  // 编辑/分支删除到被摘要覆盖的消息时，旧摘要不再可信：清掉该会话摘要，下一轮重新压缩。
  const clearSummaryCoveringMessage = (
    documentId: string,
    sessionId: string,
    messageId: number
  ): void => {
    if (!sessionId) return;
    const sessions = readDocumentChatSessions(options.store, documentId);
    let changed = false;
    const updated = sessions.map((session) => {
      if (
        session.id === sessionId &&
        typeof session.summaryUpto === 'number' &&
        session.summaryUpto >= messageId
      ) {
        changed = true;
        return { ...session, contextSummary: undefined, summaryUpto: 0 };
      }
      return session;
    });
    if (changed) writeDocumentChatSessions(options.store, documentId, updated);
  };

  app.get(`${API_PREFIX}/documents/:id/chat-sessions`, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!options.store.getDocument(id)) return notFound(reply, '文档不存在');
    return { sessions: readDocumentChatSessions(options.store, id) };
  });

  app.post(`${API_PREFIX}/documents/:id/chat-sessions`, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!options.store.getDocument(id)) return notFound(reply, '文档不存在');
    const body = (request.body ?? {}) as { session?: unknown };
    if (!body.session || typeof body.session !== 'object') {
      return badRequest(reply, '需要 session 对象');
    }
    const normalized = normalizeDocumentChatSessions([body.session]);
    const session = normalized[0];
    if (!session) return badRequest(reply, 'session.id 不能为空');
    try {
      return options.store.createDocumentChatSession(id, session);
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '创建会话失败');
    }
  });

  // 细粒度更新：只改显式字段（标题/更新时间/摘要），不再要求客户端提交整张清单。
  app.patch(
    `${API_PREFIX}/documents/:id/chat-sessions/:sessionId`,
    async (request, reply) => {
      const { id, sessionId } = request.params as { id: string; sessionId: string };
      if (!options.store.getDocument(id)) return notFound(reply, '文档不存在');
      const body = (request.body ?? {}) as {
        title?: unknown;
        updated?: unknown;
        contextSummary?: unknown;
        summaryUpto?: unknown;
      };
      const patch: {
        title?: string;
        updated?: string;
        contextSummary?: string | undefined;
        summaryUpto?: number;
      } = {};
      if (body.title !== undefined) {
        if (typeof body.title !== 'string') return badRequest(reply, 'title 必须是字符串');
        patch.title = body.title;
      }
      if (body.updated !== undefined) {
        if (typeof body.updated !== 'string') return badRequest(reply, 'updated 必须是字符串');
        patch.updated = body.updated;
      }
      if (body.contextSummary !== undefined) {
        if (typeof body.contextSummary !== 'string') {
          return badRequest(reply, 'contextSummary 必须是字符串');
        }
        patch.contextSummary = body.contextSummary;
        if (body.summaryUpto !== undefined) {
          if (
            typeof body.summaryUpto !== 'number' ||
            !Number.isInteger(body.summaryUpto) ||
            body.summaryUpto < 0
          ) {
            return badRequest(reply, 'summaryUpto 必须是非负整数');
          }
          patch.summaryUpto = body.summaryUpto;
        }
      }
      try {
        const updated = options.store.updateDocumentChatSession(id, sessionId, patch);
        if (!updated) return notFound(reply, '会话不存在');
        return updated;
      } catch (error) {
        return badRequest(reply, error instanceof Error ? error.message : '更新会话失败');
      }
    }
  );

  app.put(`${API_PREFIX}/documents/:id/chat-sessions`, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!options.store.getDocument(id)) return notFound(reply, '文档不存在');
    const body = (request.body ?? {}) as { sessions?: unknown };
    if (!Array.isArray(body.sessions)) return badRequest(reply, '需要 sessions 数组');
    const sessions = normalizeDocumentChatSessions(body.sessions);
    try {
      const saved = writeDocumentChatSessions(options.store, id, sessions);
      return { sessions: saved };
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '保存会话清单失败');
    }
  });

  app.delete(
    `${API_PREFIX}/documents/:id/chat-sessions/:sessionId`,
    async (request, reply) => {
      const { id, sessionId } = request.params as { id: string; sessionId: string };
      if (!options.store.getDocument(id)) return notFound(reply, '文档不存在');
      try {
        const removed = options.store.deleteDocumentChatSession(id, sessionId);
        const sessions = readDocumentChatSessions(options.store, id);
        return { ok: true, removed, sessions };
      } catch (error) {
        return badRequest(reply, error instanceof Error ? error.message : '删除会话消息失败');
      }
    }
  );

  // 打开文献后在后台预热单篇检索索引，减少第一问的冷启动分词（纯本机内存缓存）。
  app.post(`${API_PREFIX}/documents/:id/retrieval/prewarm`, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!options.store.getDocument(id)) return notFound(reply, '文档不存在');
    // 不阻塞请求：索引构建在下一个事件循环执行；失败不影响打开文献/提问。
    setImmediate(() => {
      try {
        warmRetrievalIndex(options.store, id);
      } catch {
        // 预热失败时提问仍会按需构建索引
      }
    });
    return { ok: true };
  });

  app.get(`${API_PREFIX}/documents/:id/messages`, async (request) => {
    const { id } = request.params as { id: string };
    const query = (request.query ?? {}) as { sessionId?: unknown };
    const sessionId = typeof query.sessionId === 'string' ? query.sessionId : '';
    return options.store.listMessages(id, sessionId ? { sessionId } : {});
  });

  // 阅读伙伴消息分页：最新一页 + hasMore；beforeId 往前翻（旧接口仍返回全部，兼容其它调用方）。
  app.get(`${API_PREFIX}/documents/:id/messages/page`, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!options.store.getDocument(id)) return notFound(reply, '文档不存在');
    const query = (request.query ?? {}) as {
      sessionId?: unknown;
      limit?: unknown;
      before?: unknown;
    };
    const sessionId = typeof query.sessionId === 'string' ? query.sessionId : '';
    const limit = Number(query.limit);
    const beforeId = Number(query.before);
    return options.store.listMessagesPage(id, {
      ...(sessionId ? { sessionId } : {}),
      ...(Number.isInteger(limit) && limit > 0 ? { limit } : {}),
      ...(Number.isInteger(beforeId) && beforeId > 0 ? { beforeId } : {})
    });
  });

  // 阅读伙伴会话内搜索：在完整会话消息里做词面匹配，返回命中片段（供界面定位/预览）。
  app.get(`${API_PREFIX}/documents/:id/messages/search`, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!options.store.getDocument(id)) return notFound(reply, '文档不存在');
    const query = (request.query ?? {}) as {
      sessionId?: unknown;
      q?: unknown;
      limit?: unknown;
    };
    const sessionId = typeof query.sessionId === 'string' ? query.sessionId : '';
    const term = typeof query.q === 'string' ? query.q.trim().slice(0, 200) : '';
    if (!term) return { matches: [], total: 0 };
    const limit = Number(query.limit);
    return options.store.searchDocumentSessionMessages(id, {
      ...(sessionId ? { sessionId } : {}),
      query: term,
      ...(Number.isInteger(limit) && limit > 0 ? { limit } : {})
    });
  });

  // 阅读页问答消息可能带整轮 ChatResponse（notice/audit/coverage 等）与来源正文，
  // 单独放宽这一条路由的 body 上限，避免大回答因默认 2MB 被 413 丢掉。
  app.post(
    `${API_PREFIX}/documents/:id/messages`,
    { bodyLimit: 8 * 1024 * 1024 },
    async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as {
      role?: unknown;
      content?: unknown;
      sources?: unknown;
      metadata?: unknown;
    };
    if (
      (body.role !== 'user' && body.role !== 'assistant') ||
      typeof body.content !== 'string'
    ) {
      return badRequest(reply, '需要 role 与 content');
    }
    try {
      return options.store.addMessage({
        documentId: id,
        role: body.role,
        content: body.content,
        sources: Array.isArray(body.sources) ? (body.sources as never) : undefined,
        metadata:
          body.metadata && typeof body.metadata === 'object'
            ? (body.metadata as Record<string, unknown>)
            : undefined
      });
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '保存消息失败');
    }
  });

  app.get(`${API_PREFIX}/documents/:id/reading-tasks`, async (request) => {
    const { id } = request.params as { id: string };
    return options.store.listReadingTasks(id);
  });

  // 阅读页「重新生成」：删除最后一轮助手回答（DB 内），保留用户问题；返回最后用户问题正文。
  // body.sessionId 可选：多会话时只在该会话内删除，避免误删其它会话的消息。
  app.post(`${API_PREFIX}/documents/:id/messages/rewind`, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!options.store.getDocument(id)) return notFound(reply, '文档不存在');
    const body = (request.body ?? {}) as { sessionId?: unknown };
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
    const lockKey = `doc:${id}`;
    if (!tryBeginChatWrite(lockKey, reply)) return;
    try {
      return { ok: true, ...options.store.rewindDocumentMessagesTail(id, sessionId) };
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '重置上一轮回答失败');
    } finally {
      endChatTurn(lockKey);
    }
  });

  // 阅读页「编辑并重问」：改 user 消息内容并删掉它之后的消息（DB），后续由客户端重问。
  app.patch(`${API_PREFIX}/documents/:id/messages/:messageId`, async (request, reply) => {
    const { id, messageId } = request.params as { id: string; messageId: string };
    if (!options.store.getDocument(id)) return notFound(reply, '文档不存在');
    const body = (request.body ?? {}) as { content?: unknown; sessionId?: unknown };
    if (typeof body.content !== 'string' || !body.content.trim()) {
      return badRequest(reply, '需要 content');
    }
    const numericId = Number(messageId);
    if (!Number.isInteger(numericId) || numericId <= 0) {
      return badRequest(reply, '消息 id 不合法');
    }
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
    const lockKey = `doc:${id}`;
    if (!tryBeginChatWrite(lockKey, reply)) return;
    try {
      const result = options.store.editDocumentUserMessage(
        id,
        numericId,
        body.content.trim(),
        sessionId
      );
      if (!result.ok) return notFound(reply, '用户消息不存在');
      clearSummaryCoveringMessage(id, sessionId, numericId);
      return result;
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '编辑消息失败');
    } finally {
      endChatTurn(lockKey);
    }
  });

  // 阅读页「从这个分支删除」：删除该消息及其后所有消息（可按会话限定）。
  app.delete(`${API_PREFIX}/documents/:id/messages/:messageId`, async (request, reply) => {
    const { id, messageId } = request.params as { id: string; messageId: string };
    if (!options.store.getDocument(id)) return notFound(reply, '文档不存在');
    const numericId = Number(messageId);
    if (!Number.isInteger(numericId) || numericId <= 0) {
      return badRequest(reply, '消息 id 不合法');
    }
    const body = (request.body ?? {}) as { sessionId?: unknown };
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
    const lockKey = `doc:${id}`;
    if (!tryBeginChatWrite(lockKey, reply)) return;
    try {
      const result = options.store.deleteDocumentMessagesFrom(id, numericId, sessionId);
      if (!result.ok) return notFound(reply, '消息不存在');
      clearSummaryCoveringMessage(id, sessionId, numericId);
      return result;
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '删除消息失败');
    } finally {
      endChatTurn(lockKey);
    }
  });

  // ---------------------------------------------------------------------------
  // 独立问答会话（多会话）：会话与消息存本机数据库，不依附任何文献；
  // 与阅读内 `documents/:id/messages` 完全分开，阅读页行为不受影响。
  // 会话表随数据目录一起备份/恢复（见 docs/QA-STANDALONE.md）。
  // ---------------------------------------------------------------------------

  app.get(`${API_PREFIX}/qa/sessions`, async (request) => {
    const query = (request.query ?? {}) as { q?: unknown };
    const term = typeof query.q === 'string' ? query.q : '';
    return options.store.listQaSessions(term);
  });

  app.post(`${API_PREFIX}/qa/sessions`, async (request, reply) => {
    const body = (request.body ?? {}) as { title?: unknown };
    const title = typeof body.title === 'string' ? body.title.trim().slice(0, 120) : '';
    try {
      return options.store.createQaSession(title);
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '创建问答会话失败');
    }
  });

  app.get(`${API_PREFIX}/qa/sessions/:id`, async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = options.store.getQaSession(id);
    if (!session) return notFound(reply, '问答会话不存在');
    const query = (request.query ?? {}) as { limit?: unknown; before?: unknown };
    const limit = Number(query.limit);
    const before = Number(query.before);
    const paged = Number.isInteger(limit) && limit > 0;
    const messages = options.store.listQaMessages(id, {
      ...(paged ? { limit } : {}),
      ...(Number.isInteger(before) && before > 0 ? { beforeId: before } : {})
    });
    if (!paged) return { session, messages };
    const first = messages[0];
    return {
      session,
      messages,
      hasMore: first ? options.store.hasOlderQaMessages(id, first.id) : false
    };
  });

  app.patch(`${API_PREFIX}/qa/sessions/:id`, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { title?: unknown; pinned?: unknown };
    if (body.title === undefined && body.pinned === undefined) {
      return badRequest(reply, '需要 title 或 pinned');
    }
    if (body.title !== undefined && (typeof body.title !== 'string' || !body.title.trim())) {
      return badRequest(reply, 'title 必须是非空字符串');
    }
    if (body.pinned !== undefined && typeof body.pinned !== 'boolean') {
      return badRequest(reply, 'pinned 必须是布尔值');
    }
    if (typeof body.title === 'string') {
      const renamed = options.store.renameQaSession(id, body.title.trim().slice(0, 120));
      if (!renamed) return notFound(reply, '问答会话不存在');
    }
    if (typeof body.pinned === 'boolean') {
      const updated = options.store.setQaSessionPinned(id, body.pinned);
      if (!updated) return notFound(reply, '问答会话不存在');
      return updated;
    }
    return options.store.getQaSession(id) ?? notFound(reply, '问答会话不存在');
  });

  app.delete(`${API_PREFIX}/qa/sessions/:id`, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!options.store.getQaSession(id)) return notFound(reply, '问答会话不存在');
    const lockKey = `qa:${id}`;
    if (!tryBeginChatWrite(lockKey, reply)) return;
    try {
      options.store.deleteQaSession(id);
      return { ok: true };
    } finally {
      endChatTurn(lockKey);
    }
  });

  // 旧版独立问答历史存在 localStorage：迁移时一次性导入（不经过模型，不触发压缩）。
  // 旧历史可能接近 1.8M 字符（中文 UTF-8 后 >2MB），因此这一条路由单独放宽 body 上限；
  // 客户端也会分批导入（见 QaView），两边共同避免 413。
  app.post(
    `${API_PREFIX}/qa/sessions/:id/import`,
    { bodyLimit: 8 * 1024 * 1024 },
    async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { messages?: unknown };
    if (!Array.isArray(body.messages)) return badRequest(reply, '需要 messages 数组');
    const messages: QaImportMessage[] = [];    for (const item of body.messages) {
      if (!item || typeof item !== 'object') continue;
      const row = item as Record<string, unknown>;
      if (row.role !== 'user' && row.role !== 'assistant') continue;
      if (typeof row.content !== 'string' || !row.content.trim()) continue;
      messages.push({
        role: row.role,
        content: row.content,
        response:
          row.response && typeof row.response === 'object'
            ? (row.response as ChatResponse)
            : null,
        answered: typeof row.answered === 'boolean' ? row.answered : undefined,
        created: typeof row.created === 'string' ? row.created : undefined
      });
    }
    if (messages.length === 0) return badRequest(reply, '没有可导入的消息');
    const lockKey = `qa:${id}`;
    if (!tryBeginChatWrite(lockKey, reply)) return;
    try {
      return options.store.importQaMessages(id, messages);
    } catch (error) {
      const message = error instanceof Error ? error.message : '导入问答历史失败';
      return message === '问答会话不存在' ? notFound(reply, message) : badRequest(reply, message);
    } finally {
      endChatTurn(lockKey);
    }
  });

  // 独立问答「编辑并重问」：改 user 消息内容并删掉它之后的消息，后续由客户端重问。
  app.patch(`${API_PREFIX}/qa/sessions/:id/messages/:messageId`, async (request, reply) => {
    const { id, messageId } = request.params as { id: string; messageId: string };
    if (!options.store.getQaSession(id)) return notFound(reply, '问答会话不存在');
    const body = (request.body ?? {}) as { content?: unknown };
    if (typeof body.content !== 'string' || !body.content.trim()) {
      return badRequest(reply, '需要 content');
    }
    const numericId = Number(messageId);
    if (!Number.isInteger(numericId) || numericId <= 0) {
      return badRequest(reply, '消息 id 不合法');
    }
    const lockKey = `qa:${id}`;
    if (!tryBeginChatWrite(lockKey, reply)) return;
    try {
      const result = options.store.editQaUserMessage(id, numericId, body.content.trim());
      if (!result.ok) return notFound(reply, '用户消息不存在');
      return result;
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '编辑消息失败');
    } finally {
      endChatTurn(lockKey);
    }
  });

  // 独立问答「从这个分支删除」：删除该消息及其后所有消息。
  app.delete(`${API_PREFIX}/qa/sessions/:id/messages/:messageId`, async (request, reply) => {
    const { id, messageId } = request.params as { id: string; messageId: string };
    if (!options.store.getQaSession(id)) return notFound(reply, '问答会话不存在');
    const numericId = Number(messageId);
    if (!Number.isInteger(numericId) || numericId <= 0) {
      return badRequest(reply, '消息 id 不合法');
    }
    const lockKey = `qa:${id}`;
    if (!tryBeginChatWrite(lockKey, reply)) return;
    try {
      const result = options.store.deleteQaMessagesFrom(id, numericId);
      if (!result.ok) return notFound(reply, '消息不存在');
      return result;
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '删除消息失败');
    } finally {
      endChatTurn(lockKey);
    }
  });

  app.get(`${API_PREFIX}/documents/:id/notes`, async (request) => {
    const { id } = request.params as { id: string };
    const query = request.query as { trash?: string };
    return options.store.listNotes(id, query.trash === 'true' || query.trash === '1');
  });

  app.get(`${API_PREFIX}/documents/:id/navigation`, async (request) => {
    const { id } = request.params as { id: string };
    return options.store.listNavigation(id);
  });

  app.post(`${API_PREFIX}/documents/:id/navigation/entries`, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { nodes?: unknown; source?: unknown };
    if (!Array.isArray(body.nodes)) return badRequest(reply, '需要 nodes');
    if (
      body.source !== undefined &&
      body.source !== 'manual' &&
      body.source !== 'materialize'
    ) {
      return badRequest(reply, 'source 只能是 manual 或 materialize');
    }
    const nodes = body.nodes.filter(
      (node): node is { page: number; label: string } =>
        Boolean(node) &&
        typeof node === 'object' &&
        Number.isInteger((node as { page?: unknown }).page) &&
        typeof (node as { label?: unknown }).label === 'string'
    );
    try {
      // materialize：勾选启用时把 PDF 内置目录保存成本地副本；manual：用户编辑/手动添加后保存。
      return options.store.saveNavigation(
        id,
        nodes,
        body.source === 'materialize' ? 'materialized' : 'manual'
      );
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '保存目录失败');
    }
  });

  app.get(`${API_PREFIX}/documents/:id/sections`, async (request) => {
    const { id } = request.params as { id: string };
    return options.store.listNavigation(id);
  });

  app.post(`${API_PREFIX}/documents/:id/sections/read`, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { section?: unknown; pages?: unknown };
    if (typeof body.section !== 'string' || !body.section.trim()) {
      return badRequest(reply, '需要 section');
    }
    try {
      const section = options.store.readSection(
        id,
        body.section,
        Array.isArray(body.pages)
          ? (body.pages as unknown[]).filter(
              (page): page is number => Number.isInteger(page)
            )
          : undefined
      );
      if (!section) return reply.code(404).send({ error: API_ERROR_CODES.notFound, message: '没有找到该章节' });
      return section;
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '读取章节失败');
    }
  });

  app.get(`${API_PREFIX}/documents/:id/outline`, async (request, reply) => {
    const { id } = request.params as { id: string };
    const document = options.store.getDocument(id);
    if (!document) return notFound(reply, '文档不存在');
    const tree = await options.store.getStructure(id);
    const origins = [...new Set(tree.map((node) => node.origin).filter(Boolean))].sort();
    const message = !tree.length
      ? '这份文献没有可用的目录信息：可先用缩略图或页码跳转。'
      : origins.length === 1 && origins[0] === 'PDF 目录'
        ? '目录来自 PDF 自带书签。'
        : 'PDF 没有自带书签，目录由标题规则识别，可能不完整。';
    const result: OutlineResult = {
      sections: tree.slice(0, 500).map((node) => ({
        title: node.title,
        page: node.page,
        level: node.level,
        end_page: node.endPage,
        origin: node.origin
      })),
      total_pages: document.pages,
      origins,
      message
    };
    return result;
  });

  app.get(`${API_PREFIX}/documents/:id/navigation/status`, async (request) => {
    const { id } = request.params as { id: string };
    return options.store.navigationStatus(id);
  });

  // 目录预览：限制条数并带上截断标记与状态（GET /navigation 仍返回完整数组，兼容旧客户端）。
  app.get(`${API_PREFIX}/documents/:id/navigation/preview`, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!options.store.getDocument(id)) return notFound(reply, '文档不存在');
    const nodes = options.store.listNavigation(id);
    const limit = 120;
    return {
      status: options.store.navigationStatus(id),
      nodes: nodes.slice(0, limit),
      nodes_truncated: nodes.length > limit,
      total_nodes: nodes.length
    };
  });

  // 「按目录页生成目录」预览：只解析目录页并估计页码偏移，不保存、不改现有目录。
  app.post(`${API_PREFIX}/documents/:id/navigation/toc-preview`, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!options.store.getDocument(id)) return notFound(reply, '文档不存在');
    const body = (request.body ?? {}) as { toc_pages?: unknown };
    if (!Array.isArray(body.toc_pages) || body.toc_pages.length === 0) {
      return badRequest(reply, '需要 toc_pages（目录页页码数组，1 起）');
    }
    const pages = body.toc_pages.map((value) => Number(value));
    if (pages.some((page) => !Number.isInteger(page) || page < 1)) {
      return badRequest(reply, 'toc_pages 必须是正整数数组');
    }
    try {
      return await sendJsonMaybeGzip(
        request,
        reply,
        await options.store.previewTocNavigation(id, pages)
      );
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '识别目录页失败');
    }
  });

  app.post(`${API_PREFIX}/documents/:id/navigation`, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as {
      rebuild?: unknown;
      enabled?: unknown;
      toc_pages?: unknown;
    };
    let tocPages: number[] | undefined;
    if (body.toc_pages !== undefined) {
      if (!Array.isArray(body.toc_pages)) return badRequest(reply, 'toc_pages 必须是数组');
      tocPages = body.toc_pages.map((value) => Number(value));
      if (tocPages.some((page) => !Number.isInteger(page) || page < 1)) {
        return badRequest(reply, 'toc_pages 必须是正整数数组');
      }
    }
    try {
      // 默认仍强制重建（旧客户端/「生成」按钮行为不变）；显式 rebuild=false 时已最新就不重算。
      const status = await options.store.buildNavigation(id, body.rebuild !== false, {
        ...(tocPages !== undefined ? { tocPages } : {})
      });
      // NavigationBuildInput：body.enabled 存在时，构建后按该值启用/停用并返回最新状态。
      if (typeof body.enabled === 'boolean') {
        return options.store.setNavigationEnabled(id, body.enabled);
      }
      return status;
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '生成目录失败');
    }
  });

  app.delete(`${API_PREFIX}/documents/:id/navigation`, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!options.store.getDocument(id)) return notFound(reply, '文档不存在');
    options.store.deleteNavigation(id);
    return reply.code(204).send();
  });

  app.put(`${API_PREFIX}/documents/:id/navigation`, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { enabled?: unknown };
    if (typeof body.enabled !== 'boolean') return badRequest(reply, 'enabled 必须是布尔值');
    try {
      return options.store.setNavigationEnabled(id, body.enabled);
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '更新目录状态失败');
    }
  });

  // 目录启用开关（独立路由，与上面的 POST/PUT /navigation 不冲突）。
  app.put(`${API_PREFIX}/documents/:id/navigation/enabled`, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!options.store.getDocument(id)) return notFound(reply, '文档不存在');
    const body = (request.body ?? {}) as { enabled?: unknown };
    if (typeof body.enabled !== 'boolean') return badRequest(reply, 'enabled 必须是布尔值');
    try {
      return options.store.setNavigationEnabled(id, body.enabled);
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '更新目录启用状态失败');
    }
  });

  app.get(`${API_PREFIX}/documents/:id/structure`, async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      return await options.store.getStructure(id);
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '读取结构失败');
    }
  });

  /**
   * 内容块 / 章节识别（版面粒度）：段落、标题、列表、题注、公式、脚注、参考文献条目，
   * 每块带文字、页码、bbox 与所属章节。`?text=0` 只返回类别与位置（结构视图用）。
   *
   * 识别结果不是原文证据：块文字来自版面上的同一段文字；问答索引消费的是
   * `/section-index`（章节级片段），命中后仍要回原页逐字核对。
   */
  app.get(`${API_PREFIX}/documents/:id/blocks`, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!options.store.getDocument(id)) return notFound(reply, '文档不存在');
    const query = request.query as { text?: string };
    try {
      const result = await options.store.getDocumentBlocks(id);
      const includeText = query.text !== '0' && query.text !== 'false';
      const payload = includeText
        ? result
        : {
            ...result,
            blocks: result.blocks.map(({ text: _text, ...rest }) => rest)
          };
      return await sendJsonMaybeGzip(request, reply, payload);
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '读取内容块失败');
    }
  });

  /**
   * 参考文献识别：文末参考文献列表 + 页面底部脚注式引用 + 页面内引用标记
   * （`[1]`、`[1–3]`、`(Smith, 2020)`、（张三，2020））。
   *
   * 条目字段（作者/年份/标题/出处）是尽力解析；解析不出留空，不做猜测。
   * 识别结果只用于阅读时查看"这条引用是哪篇文献"，不是新的原文证据。
   */
  app.get(`${API_PREFIX}/documents/:id/references`, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!options.store.getDocument(id)) return notFound(reply, '文档不存在');
    try {
      const result = await options.store.getDocumentReferences(id);
      return await sendJsonMaybeGzip(request, reply, result);
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '读取参考文献失败');
    }
  });

  /**
   * 参考文献用户编辑：修改 / 删除 / 新增 / 重置。
   *
   * 编辑是识别结果之上的覆盖层（改坏了可重置恢复自动识别）；识别版本变化后旧编辑失效，
   * 接口返回的 `stats.staleEdits` 会如实说明。
   */
  app.put(`${API_PREFIX}/documents/:id/references/entries/:entryId`, async (request, reply) => {
    const { id, entryId } = request.params as { id: string; entryId: string };
    if (!options.store.getDocument(id)) return notFound(reply, '文档不存在');
    const body = (request.body ?? {}) as Record<string, unknown>;
    if (typeof body !== 'object' || Array.isArray(body)) return badRequest(reply, '需要条目字段');
    try {
      return await sendJsonMaybeGzip(
        request,
        reply,
        await options.store.updateReferenceEntry(id, entryId, body)
      );
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '修改参考文献失败');
    }
  });

  app.post(`${API_PREFIX}/documents/:id/references/entries`, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!options.store.getDocument(id)) return notFound(reply, '文档不存在');
    const body = (request.body ?? {}) as Record<string, unknown>;
    if (typeof body !== 'object' || Array.isArray(body)) return badRequest(reply, '需要条目字段');
    try {
      return await sendJsonMaybeGzip(
        request,
        reply,
        await options.store.addReferenceEntry(id, body)
      );
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '新增参考文献失败');
    }
  });

  app.delete(`${API_PREFIX}/documents/:id/references/entries/:entryId`, async (request, reply) => {
    const { id, entryId } = request.params as { id: string; entryId: string };
    if (!options.store.getDocument(id)) return notFound(reply, '文档不存在');
    try {
      return await sendJsonMaybeGzip(
        request,
        reply,
        await options.store.deleteReferenceEntry(id, entryId)
      );
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '删除参考文献失败');
    }
  });

  app.post(`${API_PREFIX}/documents/:id/references/reset`, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!options.store.getDocument(id)) return notFound(reply, '文档不存在');
    try {
      return await sendJsonMaybeGzip(request, reply, await options.store.resetReferenceEdits(id));
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '重置参考文献失败');
    }
  });

  /** 章节级问答索引片段（带章节标题与起止页）；索引材料，不作原文证据。 */
  app.get(`${API_PREFIX}/documents/:id/section-index`, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!options.store.getDocument(id)) return notFound(reply, '文档不存在');
    const query = request.query as { max_chars?: string; overlap?: string };
    let maxChars: number | undefined;
    let overlap: number | undefined;
    if (query.max_chars !== undefined) {
      if (!/^\d+$/.test(query.max_chars.trim())) {
        return badRequest(reply, 'max_chars 必须是 200..20000 的整数');
      }
      maxChars = Number(query.max_chars);
      if (maxChars < 200 || maxChars > 20_000) {
        return badRequest(reply, 'max_chars 必须是 200..20000 的整数');
      }
    }
    if (query.overlap !== undefined) {
      if (!/^\d+$/.test(query.overlap.trim())) {
        return badRequest(reply, 'overlap 必须是 0..1000 的整数');
      }
      overlap = Number(query.overlap);
      if (overlap > 1000) return badRequest(reply, 'overlap 必须是 0..1000 的整数');
    }
    try {
      const result = await options.store.getSectionIndex(id, { maxChars, overlap });
      return await sendJsonMaybeGzip(request, reply, result);
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '生成章节索引失败');
    }
  });

  /** 著作章节：目录派生，只用于展示与"读哪一章"的选择；目录不足/非著作时 available=false。 */
  app.get(`${API_PREFIX}/documents/:id/chapters`, async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const document = options.store.getDocument(id);
      if (!document) return reply.code(404).send({ error: API_ERROR_CODES.notFound, message: '文献不存在' });
      // 启用的本地目录优先（用户编辑过的目录要能影响"读哪一章"）；否则回退结构树。
      let chapters = await chaptersFromLocalNavigation(options.store, id, document.pages);
      let source: 'navigation' | 'structure' = 'navigation';
      if (chapters.length < 2) {
        const tree = await options.store.getStructure(id);
        chapters = chapterOutline(tree, document.pages);
        source = 'structure';
      }
      const available = document.docCategory === 'book' && chapters.length >= 2;
      return {
        chapters: chapters.map((chapter) => ({
          index: chapter.index,
          title: chapter.title,
          page: chapter.page,
          end_page: chapter.endPage,
          level: chapter.level
        })),
        total_pages: document.pages,
        available,
        source
      };
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '读取章节失败');
    }
  });

  app.get(`${API_PREFIX}/documents/:id/visual-nodes`, async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      return await options.store.getVisualNodes(id);
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '读取图表结构失败');
    }
  });

  app.post(`${API_PREFIX}/documents/:id/quote-locate`, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { page?: unknown; quote?: unknown };
    if (typeof body.page !== 'number' || typeof body.quote !== 'string' || !body.quote.trim()) {
      return badRequest(reply, '需要 page 与 quote');
    }
    try {
      // 旧 OCR 页若缺行框，先按需补识别一次再定位。
      await ensureOcrBoxes(options.store, options.secrets, id, body.page);
      // 返回详细结果：命中页、来源（text_layer/ocr）、是否跨页更正与如实说明。
      return await options.store.locateCitationEx(id, body.page, body.quote);
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '定位失败');
    }
  });

  app.get(`${API_PREFIX}/documents/:id/masks`, async (request) => {
    const { id } = request.params as { id: string };
    return options.store.listPageMasks(id);
  });

  // 页遮罩重建状态：用户改一条规则后能看到"正在重建/已完成/失败原因"。
  app.get(`${API_PREFIX}/documents/:id/masks/status`, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!options.store.getDocument(id)) return notFound(reply, '文档不存在');
    return options.store.maskIndexStatus(id);
  });

  app.post(`${API_PREFIX}/documents/:id/masks`, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as {
      page?: unknown;
      scope?: unknown;
      rangeStart?: unknown;
      rangeEnd?: unknown;
      excludePages?: unknown;
      x0?: unknown;
      y0?: unknown;
      x1?: unknown;
      y1?: unknown;
    };
    if (
      typeof body.page !== 'number' ||
      typeof body.x0 !== 'number' ||
      typeof body.y0 !== 'number' ||
      typeof body.x1 !== 'number' ||
      typeof body.y1 !== 'number'
    ) {
      return badRequest(reply, '需要 page 与四个坐标');
    }
    try {
      return await options.store.addPageMask(id, {
        page: body.page,
        scope: typeof body.scope === 'string' ? (body.scope as never) : undefined,
        rangeStart: typeof body.rangeStart === 'number' ? body.rangeStart : undefined,
        rangeEnd: typeof body.rangeEnd === 'number' ? body.rangeEnd : undefined,
        excludePages: Array.isArray(body.excludePages)
          ? body.excludePages.filter((item): item is number => Number.isInteger(item))
          : undefined,
        x0: body.x0,
        y0: body.y0,
        x1: body.x1,
        y1: body.y1
      });
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '保存屏蔽规则失败');
    }
  });

  app.patch(
    `${API_PREFIX}/documents/:id/masks/:maskId`,
    async (request, reply) => {
      const { id, maskId } = request.params as { id: string; maskId: string };
      const body = (request.body ?? {}) as Record<string, unknown>;
      try {
        return await options.store.updatePageMask(id, maskId, {
          scope: typeof body.scope === 'string' ? (body.scope as never) : undefined,
          page: typeof body.page === 'number' ? body.page : undefined,
          rangeStart: typeof body.rangeStart === 'number' ? body.rangeStart : undefined,
          rangeEnd: typeof body.rangeEnd === 'number' ? body.rangeEnd : undefined,
          excludePages: Array.isArray(body.excludePages)
            ? body.excludePages.filter((item): item is number => Number.isInteger(item))
            : undefined,
          x0: typeof body.x0 === 'number' ? body.x0 : undefined,
          y0: typeof body.y0 === 'number' ? body.y0 : undefined,
          x1: typeof body.x1 === 'number' ? body.x1 : undefined,
          y1: typeof body.y1 === 'number' ? body.y1 : undefined
        });
      } catch (error) {
        return badRequest(
          reply,
          error instanceof Error ? error.message : '更新屏蔽规则失败'
        );
      }
    }
  );

  app.delete(`${API_PREFIX}/documents/:id/masks/:maskId`, async (request, reply) => {
    const { id, maskId } = request.params as { id: string; maskId: string };
    try {
      await options.store.removePageMask(id, maskId);
      return reply.code(204).send();
    } catch (error) {
      return notFound(reply, error instanceof Error ? error.message : '屏蔽规则不存在');
    }
  });

  // 独立笔记（不属于任何文献）：document_id=''。
  app.get(`${API_PREFIX}/notes/standalone`, async (request) => {
    const query = request.query as { trash?: string };
    return options.store.listStandaloneNotes(
      query.trash === 'true' || query.trash === '1'
    );
  });

  app.post(`${API_PREFIX}/notes`, async (request, reply) => {
    const body = (request.body ?? {}) as {
      documentId?: unknown;
      page?: unknown;
      quote?: unknown;
      content?: unknown;
      externalKey?: unknown;
    };
    if (body.documentId != null && typeof body.documentId !== 'string') {
      return badRequest(reply, 'documentId 必须是字符串');
    }
    const documentId = typeof body.documentId === 'string' ? body.documentId.trim() : '';
    const pageValue = body.page == null ? 0 : body.page;
    if (typeof pageValue !== 'number' || !Number.isInteger(pageValue)) {
      return badRequest(reply, 'page 必须是整数');
    }
    // 独立笔记没有页码；带上非 0 页码视为参数错误。
    if (!documentId && pageValue !== 0) {
      return badRequest(reply, '独立笔记的 page 必须为 0');
    }
    try {
      return options.store.createNote({
        documentId,
        page: pageValue,
        quote: typeof body.quote === 'string' ? body.quote : '',
        content: typeof body.content === 'string' ? body.content : '',
        // 外部稳定标识（例如「回答存为笔记」的 chat-answer:...）：同 key 重复保存返回已有笔记。
        externalKey: typeof body.externalKey === 'string' ? body.externalKey : undefined
      });
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '保存笔记失败');
    }
  });

  app.patch(`${API_PREFIX}/notes/:id`, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as {
      page?: unknown;
      quote?: unknown;
      content?: unknown;
      folderPath?: unknown;
    };
    try {
      return options.store.updateNote(id, {
        page:
          typeof body.page === 'number' && Number.isInteger(body.page) ? body.page : undefined,
        quote: typeof body.quote === 'string' ? body.quote : undefined,
        content: typeof body.content === 'string' ? body.content : undefined,
        folderPath: typeof body.folderPath === 'string' ? body.folderPath : undefined
      });
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '更新笔记失败');
    }
  });

  app.delete(`${API_PREFIX}/notes/:id/purge`, async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      return options.store.purgeNote(id);
    } catch (error) {
      return notFound(reply, error instanceof Error ? error.message : '笔记不存在');
    }
  });

  app.delete(`${API_PREFIX}/notes/:id`, async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      options.store.deleteNote(id);
      return reply.code(204).send();
    } catch (error) {
      return notFound(reply, error instanceof Error ? error.message : '笔记不存在');
    }
  });

  app.post(`${API_PREFIX}/notes/:id/restore`, async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      options.store.restoreNote(id);
      return { ok: true };
    } catch (error) {
      return notFound(reply, error instanceof Error ? error.message : '笔记不存在');
    }
  });

  // ---- 笔记虚拟文件夹 ----
  app.get(`${API_PREFIX}/notes/folders`, async () => options.store.listNoteFolders());

  app.post(`${API_PREFIX}/notes/folders`, async (request, reply) => {
    const body = (request.body ?? {}) as { path?: unknown };
    if (typeof body.path !== 'string' || !body.path.trim()) {
      return badRequest(reply, '需要文件夹路径');
    }
    try {
      return options.store.createNoteFolder(body.path);
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '创建文件夹失败');
    }
  });

  app.post(`${API_PREFIX}/notes/folders/rename`, async (request, reply) => {
    const body = (request.body ?? {}) as { from?: unknown; to?: unknown };
    if (typeof body.from !== 'string' || typeof body.to !== 'string') {
      return badRequest(reply, '需要原路径与目标路径');
    }
    try {
      return options.store.renameNoteFolder(body.from, body.to);
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '重命名文件夹失败');
    }
  });

  app.delete(`${API_PREFIX}/notes/folders`, async (request, reply) => {
    const query = request.query as { path?: string };
    if (!query.path || !query.path.trim()) return badRequest(reply, '需要文件夹路径');
    try {
      return options.store.deleteNoteFolder(query.path);
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '删除文件夹失败');
    }
  });

  app.patch(`${API_PREFIX}/notes/:id/folder`, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { folderPath?: unknown };
    if (typeof body.folderPath !== 'string') return badRequest(reply, '需要文件夹路径');
    try {
      return options.store.moveNoteToFolder(id, body.folderPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : '移动笔记失败';
      if (message === '笔记不存在') return notFound(reply, message);
      return badRequest(reply, message);
    }
  });

  // ---- 笔记标签 ----
  app.get(`${API_PREFIX}/notes/tags`, async () => options.store.listNoteTags());

  app.put(`${API_PREFIX}/notes/:id/tags`, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { tags?: unknown };
    if (!Array.isArray(body.tags) || !body.tags.every((tag) => typeof tag === 'string')) {
      return badRequest(reply, '标签必须是字符串数组');
    }
    try {
      return options.store.setNoteTags(id, body.tags as string[]);
    } catch (error) {
      const message = error instanceof Error ? error.message : '设置标签失败';
      if (message === '笔记不存在') return notFound(reply, message);
      return badRequest(reply, message);
    }
  });

  app.get(`${API_PREFIX}/providers`, async () => listProviders());

  app.get(`${API_PREFIX}/model-services`, async () =>
    publicModelServices(options.store, options.secrets)
  );

  // 删除平台连接前的只读影响预览：哪些用途会一起解绑。
  app.get(`${API_PREFIX}/model-services/impact`, async (request, reply) => {
    const query = request.query as { connectionId?: string };
    if (!query.connectionId?.trim()) return badRequest(reply, '需要 connectionId');
    return modelServicesImpact(options.store, query.connectionId.trim());
  });

  app.put(`${API_PREFIX}/model-services`, async (request, reply) => {
    const body = (request.body ?? {}) as {
      connections?: unknown;
      routing?: unknown;
    };
    try {
      const saved = saveModelServices(
        options.store,
        {
          connections: Array.isArray(body.connections)
            ? (body.connections as never)
            : undefined,
          routing:
            body.routing && typeof body.routing === 'object'
              ? (body.routing as never)
              : undefined
        },
        options.secrets
      );
      // 删除连接时触发的降级清单（unbound）：
      // 让界面能如实提示"语音已改回本机/视觉已改回本机 OCR"等，而不是只报保存成功。
      const publicConfig = publicModelServices(options.store, options.secrets) ?? saved;
      return { ...publicConfig, unbound: saved.unbound };
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '保存模型服务失败');
    }
  });

  app.post(`${API_PREFIX}/model-services/models`, async (request, reply) => {
    const body = (request.body ?? {}) as { connectionId?: unknown; metadata?: unknown };
    if (typeof body.connectionId !== 'string') {
      return badRequest(reply, '需要 connectionId');
    }
    // 默认响应保持 `{models:[...]}`（既有 UI/客户端不变）；加 metadata 时才多带容量元数据。
    const query = (request.query ?? {}) as { metadata?: unknown };
    const wantsMetadata =
      body.metadata === true || query.metadata === 'true' || query.metadata === true;
    try {
      if (wantsMetadata) {
        const detailed = await fetchConnectionModelsDetailed(
          options.store,
          options.secrets,
          body.connectionId
        );
        // 显式要 metadata 时，把平台容量回写到**已保存**的模型上（manual 不覆盖、幂等）；
        // 默认路径（只要模型名）保持只读，不产生隐藏写库副作用。
        const { updated } = applyFetchedCapacityToConnection(
          options.store,
          body.connectionId,
          detailed.metadata
        );
        return { ...detailed, updated };
      }
      // 默认路径也走同一份解析：失败时返回 {models, notice}（已保存模型+官方语音快照），
      // 保持既有 `{models:[...]}` 形状不变，旧调用只读 models 不会崩。
      const detailed = await fetchConnectionModelsDetailed(
        options.store,
        options.secrets,
        body.connectionId
      );
      return {
        models: detailed.models,
        ...(detailed.notice ? { notice: detailed.notice } : {})
      };
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '获取模型列表失败');
    }
  });

  app.get(`${API_PREFIX}/settings`, async () => options.store.getSettings());

  app.get(`${API_PREFIX}/settings/tokenizer`, async () => tokenizerStatus(options.store));

  // 导入本地 tokenizer.json（base64 或纯文本 JSON），校验后保存并立即生效。
  app.post(
    `${API_PREFIX}/settings/tokenizer`,
    { bodyLimit: 45 * 1024 * 1024 },
    async (request, reply) => {
      const body = (request.body ?? {}) as { data?: unknown; text?: unknown };
      try {
        return importTokenizer(options.store, {
          data: typeof body.data === 'string' ? body.data : undefined,
          text: typeof body.text === 'string' ? body.text : undefined
        });
      } catch (error) {
        return badRequest(reply, error instanceof Error ? error.message : '导入 tokenizer 失败');
      }
    }
  );

  app.get(`${API_PREFIX}/secrets/status`, async () => ({
    configured: options.secrets.configured()
  }));

  app.post(`${API_PREFIX}/secrets`, async (request, reply) => {
    const body = request.body as { name?: unknown; value?: unknown } | null;
    if (!body || typeof body.name !== 'string' || typeof body.value !== 'string') {
      return badRequest(reply, '需要 name 与 value');
    }
    try {
      options.secrets.set(body.name, body.value);
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '保存密钥失败');
    }
    return { configured: options.secrets.configured() };
  });

  app.delete(`${API_PREFIX}/secrets/:name`, async (request, reply) => {
    const { name } = request.params as { name: string };
    try {
      options.secrets.clear(name);
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '清除密钥失败');
    }
    return { configured: options.secrets.configured() };
  });

  app.get(`${API_PREFIX}/library-search`, async (request, reply) => {
    const query = request.query as { q?: string; types?: string };
    if (!query.q?.trim()) return badRequest(reply, '需要 q');
    const allowed = new Set(['document', 'tag', 'annotation', 'note', 'chunk']);
    const kinds = (query.types ?? '')
      .split(',')
      .filter((kind) => allowed.has(kind)) as Array<
      'document' | 'tag' | 'annotation' | 'note' | 'chunk'
    >;
    return searchLibrary(
      options.store,
      options.secrets,
      query.q,
      kinds.length > 0 ? kinds : ['document', 'tag', 'annotation', 'note', 'chunk']
    );
  });

  // 文献列表的搜索过滤：只返回命中的文献 id，不返回命中段落（界面直接过滤下方列表）。
  app.get(`${API_PREFIX}/library-search/documents`, async (request, reply) => {
    const query = request.query as { q?: string; types?: string };
    if (!query.q?.trim()) return badRequest(reply, '需要 q');
    const allowed = new Set(['document', 'tag', 'annotation', 'note', 'chunk']);
    const kinds = (query.types ?? '')
      .split(',')
      .filter((kind) => allowed.has(kind)) as Array<
      'document' | 'tag' | 'annotation' | 'note' | 'chunk'
    >;
    return searchLibraryDocuments(
      options.store,
      options.secrets,
      query.q,
      kinds.length > 0 ? kinds : ['document', 'tag', 'annotation', 'note', 'chunk']
    );
  });

  app.get(`${API_PREFIX}/search`, async (request) => {
    const query = request.query as {
      q?: string;
      documentId?: string;
      page?: string;
      mode?: string;
      limit?: string;
    };
    const limit = query.limit ? Number(query.limit) : 20;
    const page = query.page ? Number(query.page) : 1;
    const mode = query.mode === 'wide' ? 'wide' : 'close';
    const hits = await retrieve(
      options.store,
      options.secrets,
      query.q ?? '',
      query.documentId,
      Number.isFinite(page) ? page : 1,
      mode,
      Number.isFinite(limit) ? limit : 20
    );
    // 命中结果附"命中在哪一节"（只用已就绪的识别缓存，缺失时后台预热，不拖慢检索）。
    return annotateSearchHits(options.store, hits, { warm: true });
  });

  app.post(`${API_PREFIX}/search`, async (request, reply) => {
    const body = (request.body ?? {}) as Partial<SearchRequest>;
    if (typeof body.query !== 'string' || !body.query.trim() || typeof body.documentId !== 'string') {
      return badRequest(reply, '需要 query 与 documentId');
    }
    if (!options.store.getDocument(body.documentId)) return notFound(reply, '文档不存在');
    const documents = options.store.listDocuments(false);
    let scopeIds: string[];
    try {
      scopeIds = resolveScopeIds(
        documents.map((document) => ({ id: document.id, tags: document.tags })),
        {
          documentId: body.documentId,
          crossBook: Boolean(body.crossBook),
          scope: body.scope,
          scopeTags: body.scopeTags,
          scopeDocuments: body.scopeDocuments
        }
      );
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '跨文献范围无效');
    }
    try {
      const hits = await retrieve(
        options.store,
        options.secrets,
        body.query,
        body.documentId,
        typeof body.page === 'number' && Number.isFinite(body.page) ? body.page : 1,
        body.mode === 'wide' ? 'wide' : 'close',
        typeof body.limit === 'number' && Number.isFinite(body.limit) ? body.limit : 20,
        {
          selection: typeof body.selection === 'string' ? body.selection : undefined,
          scopeDocumentIds: scopeIds,
          includeDerived: true
        }
      );
      return await annotateSearchHits(options.store, hits, { warm: true });
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '检索失败');
    }
  });

  app.get(`${API_PREFIX}/embeddings/status`, async () =>
    embeddingStatus(options.store, options.secrets)
  );

  app.post(`${API_PREFIX}/embeddings/index`, async (request, reply) => {
    const body = (request.body ?? {}) as { documentId?: unknown };
    try {
      return await indexChunks(
        options.store,
        options.secrets,
        typeof body.documentId === 'string' ? body.documentId : undefined
      );
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '建立索引失败');
    }
  });

  app.post(`${API_PREFIX}/migrate/legacy`, async (request, reply) => {
    const body = (request.body ?? {}) as { path?: unknown };
    if (typeof body.path !== 'string' || body.path.trim() === '') {
      return badRequest(reply, '需要旧版 data 目录路径');
    }
    try {
      return options.store.migrateLegacy(body.path.trim());
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '迁移失败');
    }
  });

  app.post(`${API_PREFIX}/plan`, async (request, reply) => {
    const body = (request.body ?? {}) as { question?: unknown; selection?: unknown };
    if (typeof body.question !== 'string' || !body.question.trim()) {
      return badRequest(reply, '需要 question');
    }
    return planQuestion(
      body.question,
      typeof body.selection === 'string' ? body.selection : ''
    );
  });

  app.post(`${API_PREFIX}/plan-reading`, async (request, reply) => {
    const body = (request.body ?? {}) as {
      question?: unknown;
      documentId?: unknown;
      selection?: unknown;
      page?: unknown;
      budget?: unknown;
      overlap?: unknown;
    };
    if (typeof body.question !== 'string' || typeof body.documentId !== 'string') {
      return badRequest(reply, '需要 question 与 documentId');
    }
    try {
      const plan = planQuestion(
        body.question,
        typeof body.selection === 'string' ? body.selection : ''
      );
      const reading = planReading(
        options.store,
        body.documentId,
        plan,
        typeof body.page === 'number' && Number.isFinite(body.page) ? body.page : 1,
        typeof body.budget === 'number' && Number.isFinite(body.budget) ? body.budget : 6000,
        typeof body.overlap === 'number' && Number.isFinite(body.overlap) ? body.overlap : 1
      );
      return {
        plan,
        pages: reading.pages,
        batchCount: reading.batchCount,
        multiPass: reading.multiPass,
        batches: reading.batches.map((group) =>
          group.map(([index, source]) => ({
            index,
            page: source.page,
            name: source.name
          }))
        )
      };
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '规划阅读失败');
    }
  });

  /**
   * 闸门估算用的阅读范围：显式 `reading_scope` 优先（用户在输入栏选了就按它估），
   * 否则用不调模型的规则规划（`planQuestion`）。
   *
   * 这里刻意**不**调模型路由：闸门必须在任何模型调用之前给出提示，不能为了估成本先花一次调用。
   * 代价是 auto 时按规则/保守规划估，可能比模型最终判定的范围保守——所以下面用"单轮口径"截断，
   * 让提示反映"这一轮到底会读多少"。
   */
  function planForBudget(
    body: Pick<Partial<ChatRequest>, 'question' | 'selection' | 'page' | 'reading_scope'>
  ): ReadingPlanRecord {
    const base = planQuestion(
      body.question ?? '',
      typeof body.selection === 'string' ? body.selection : ''
    );
    const page =
      typeof body.page === 'number' && Number.isFinite(body.page)
        ? Math.max(1, Math.trunc(body.page))
        : 1;
    if (body.reading_scope === 'local') {
      return {
        ...base,
        breadth: 'local',
        pages: [page - 1, page, page + 1].filter((value) => value >= 1),
        reason: '用户指定：本页与相邻页',
        origin: '规则'
      };
    }
    if (body.reading_scope === 'document') {
      return {
        ...base,
        breadth: 'document',
        pages: [],
        reason: '用户指定：整篇文献',
        origin: '规则'
      };
    }
    return base;
  }

  function pageFrom(body: { page?: unknown }): number {
    return typeof body.page === 'number' && Number.isFinite(body.page)
      ? Math.max(1, Math.trunc(body.page))
      : 1;
  }

  app.post(`${API_PREFIX}/chat/budget`, async (request, reply) => {
    const body = (request.body ?? {}) as {
      question?: unknown;
      documentId?: unknown;
      selection?: unknown;
      page?: unknown;
      budget?: unknown;
      reading_scope?: unknown;
      reading_chapter_index?: unknown;
      scopeDocuments?: unknown;
      scope_documents?: unknown;
    };
    if (typeof body.question !== 'string' || body.question.trim() === '') {
      return badRequest(reply, '需要 question');
    }
    const settings = options.store.getSettings();
    const thresholds = budgetThresholds(settings);
    const page = pageFrom(body);
    const plan = planForBudget({
      question: body.question,
      selection: typeof body.selection === 'string' ? body.selection : '',
      page,
      reading_scope: body.reading_scope as ChatRequest['reading_scope']
    });
    const scopeDocuments = scopeDocumentIds(body.scopeDocuments, body.scope_documents);
    const corpus = isCorpusBudgetRequest(body.reading_scope, body.documentId, scopeDocuments);
    try {
      if (corpus) {
        const scopeIds =
          scopeDocuments.length > 0
            ? scopeDocuments
            : options.store.listDocuments(false).map((document) => document.id);
        if (scopeIds.length === 0) return badRequest(reply, '没有可估算的文献');
        // 跨文献请求按"整轮要读这些文献"估：用 discovery 口径（页数=scope 内页数之和）。
        return estimateBudgetForScope(
          options.store,
          { ...plan, breadth: 'discovery' },
          scopeIds,
          { thresholds, scope: 'discovery' }
        );
      }
      if (typeof body.documentId !== 'string') {
        return badRequest(reply, '需要 question 与 documentId');
      }
      const document = options.store.getDocument(body.documentId);
      // 著作默认按章读；估算口径必须与实际阅读一致，否则又会出现"提示整本、实际读一章"。
      const chaptered = (
        await resolveChapterReading(options.store, body.documentId, plan, {
          scope: (body.reading_scope ?? 'auto') as 'auto' | 'local' | 'document' | 'corpus',
          page,
          question: body.question,
          selection: typeof body.selection === 'string' ? body.selection : '',
          chapterIndex:
            typeof body.reading_chapter_index === 'number' &&
            Number.isInteger(body.reading_chapter_index) &&
            body.reading_chapter_index >= 1
              ? body.reading_chapter_index
              : undefined
        })
      ).plan;
      return estimateTurnBudget(options.store, chaptered, body.documentId, {
        page,
        maxBatches: readCapacity(settings).maxReadBatches,
        thresholds,
        scope: chaptered.breadth === 'local' ? 'local' : 'document',
        documentCategory: document?.docCategory
      });
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '预算估算失败');
    }
  });

  /** `/chat/budget` 与 budgetGate 共用的 scope 参数解析：同时接受 camel 与 snake 写法。 */
  function scopeDocumentIds(camel: unknown, snake: unknown): string[] {
    const source = Array.isArray(camel) ? camel : Array.isArray(snake) ? snake : [];
    const seen = new Set<string>();
    const ids: string[] = [];
    for (const value of source) {
      if (typeof value !== 'string') continue;
      const id = value.trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
    return ids;
  }

  /**
   * 这一轮要不要按"跨文献精读"估算：显式 corpus，或旧调用没有当前文献但给了跨书范围。
   * 独立问答的「库内检索」（reading_scope='auto' + scope_documents）只做检索，不读全文，不估算。
   */
  function isCorpusBudgetRequest(
    readingScope: unknown,
    documentId: unknown,
    scopeDocuments: readonly string[]
  ): boolean {
    if (readingScope === 'corpus') return true;
    return (
      readingScope === undefined &&
      typeof documentId !== 'string' &&
      scopeDocuments.length > 0
    );
  }

  /**
   * 预算闸门：超过确认阈值返回估算（调用方回 200 + needs_confirmation），不拒绝、不读任何页。
   *
   * 单篇用**单轮口径**（estimateTurnBudget）：按 `reading.max_read_batches` 截断后本轮实际会读的页算，
   * 不再拿整本页数吓人；跨文献仍按 scope 总页数（discovery 口径）。
   * 阈值来自设置 `reading.budget_pages` / `reading.budget_tokens`（默认 20 页 / 60000 token）。
   */
  const budgetGate = async (body: Partial<ChatRequest>) => {
    // 语音直接提问没有文字问题（录音本身是输入），不做预算估算。
    if (body.confirm_budget || !body.question || body.audio) return null;
    const settings = options.store.getSettings();
    const thresholds = budgetThresholds(settings);
    const page = pageFrom(body);
    const scopeDocuments = scopeDocumentIds(undefined, body.scope_documents);
    if (isCorpusBudgetRequest(body.reading_scope, body.documentId, scopeDocuments)) {
      const scopeIds =
        scopeDocuments.length > 0
          ? scopeDocuments
          : options.store.listDocuments(false).map((document) => document.id);
      if (scopeIds.length === 0) return null;
      try {
        return estimateBudgetForScope(
          options.store,
          { ...planForBudget(body), breadth: 'discovery' },
          scopeIds,
          { thresholds, scope: 'discovery' }
        );
      } catch {
        // 估算失败不阻断请求：预算闸门只是提醒，不能因为估算错误让提问失败。
        return null;
      }
    }
    if (!body.documentId) return null;
    const document = options.store.getDocument(body.documentId);
    let plan = planForBudget(body);
    try {
      // 与真实阅读保持一致：著作默认按章读，闸门也按"这一章"估，而不是整本。
      plan = (
        await resolveChapterReading(options.store, body.documentId, plan, {
          scope: (body.reading_scope ?? 'auto') as 'auto' | 'local' | 'document' | 'corpus',
          page,
          question: body.question,
          selection: typeof body.selection === 'string' ? body.selection : '',
          chapterIndex:
            typeof body.reading_chapter_index === 'number' &&
            Number.isInteger(body.reading_chapter_index) &&
            body.reading_chapter_index >= 1
              ? body.reading_chapter_index
              : undefined
        })
      ).plan;
      return estimateTurnBudget(options.store, plan, body.documentId, {
        page,
        maxBatches: readCapacity(settings).maxReadBatches,
        thresholds,
        scope: plan.breadth === 'local' ? 'local' : 'document',
        documentCategory: document?.docCategory
      });
    } catch {
      return null;
    }
  };

  /**
   * 独立问答会话：没有 documentId 的问答按会话持久化完整历史（agent-harness 式的做法）。
   *
   * - 带 `qa_session_id`：用该会话；
   * - 没带：新建一个会话（第一条问题会自动补标题），首问不必先建会话；
   * - 带了但不存在的 id：返回 null，调用方回 400（不静默改成新会话，避免历史错位）。
   */
  const qaSessionForRequest = (body: Partial<ChatRequest>): QaSessionRecord | null => {
    if (typeof body.documentId === 'string' && body.documentId) return null;
    const id = typeof body.qa_session_id === 'string' ? body.qa_session_id.trim() : '';
    return id ? options.store.getQaSession(id) : options.store.createQaSession('');
  };

  /**
   * 记本轮用户消息；「继续阅读」重发不重复记（同一问题不能出现两条用户消息）。
   *
   * 返回落库的消息记录（语音轮成功后用它补写转写正文）；没有落库时返回 null。
   */
  const persistQaUserTurn = (
    session: QaSessionRecord | null,
    body: Partial<ChatRequest>,
    question: string
  ): QaMessageRecord | null => {
    if (!session) return null;
    if (typeof body.taskId === 'string' && body.taskId) return null;
    try {
      const text = question.trim();
      // 语音直问不再由客户端预先 ASR：先如实落一条「（语音提问）」占位，等全模态模型
      // 返回 audio_transcript 后再补写正文（见 updateVoiceUserTurn）。文字提问照常立即落库。
      const content = text
        ? body.audio && typeof body.audio === 'object'
          ? `（语音）${text}`
          : text
        : '（语音提问）';
      const message = options.store.appendQaMessage({
        sessionId: session.id,
        role: 'user',
        content
      });
      if (text) options.store.autoTitleQaSession(session.id, text);
      return message;
    } catch {
      // 会话落库失败不阻断回答；下一轮仍按客户端带回的会话 id 继续。
      return null;
    }
  };

  /**
   * 语音直问成功后补写用户消息正文：全模态模型返回逐字转写时，把先前的「（语音提问）」
   * 占位改成「（语音）转写」，让会话历史里能看到用户说了什么。
   *
   * 时机在助手消息落库之前，用 editQaUserMessage 不会删掉任何有效回答（此后没有消息）；
   * 补写失败只影响会话里显示的正文，不影响本轮回答。
   */
  const updateVoiceUserTurn = (
    session: QaSessionRecord | null,
    userTurn: QaMessageRecord | null,
    result: ChatResponse
  ): void => {
    if (!session || !userTurn) return;
    const transcript =
      typeof result.audio_transcript === 'string' ? result.audio_transcript.trim() : '';
    if (!transcript) return;
    try {
      options.store.editQaUserMessage(session.id, userTurn.id, `（语音）${transcript}`);
      // 首条就是语音时，标题也用转写全文（autoTitleQaSession 只在标题为空时写入）。
      options.store.autoTitleQaSession(session.id, transcript);
    } catch {
      // 补写失败不影响回答；用户消息保留「（语音提问）」占位。
    }
  };

  /** 记本轮助手消息（保存整轮 ChatResponse，恢复历史会话时能还原来源/说明）。 */
  const persistQaAssistantTurn = (
    session: QaSessionRecord | null,
    result: ChatResponse
  ): void => {
    if (!session) return;
    const answer = typeof result.answer === 'string' ? result.answer.trim() : '';
    try {
      options.store.appendQaMessage({
        sessionId: session.id,
        role: 'assistant',
        content: answer || '这一轮没有产生文字回答。',
        response: result,
        answered: Boolean(answer)
      });
    } catch {
      // 同上：保存失败不影响本轮已经拿到的回答。
    }
  };

  /** 失败轮次也留在会话里（界面能看到哪一轮失败），但不进入后续上下文。 */
  const persistQaAssistantFailure = (
    session: QaSessionRecord | null,
    message: string
  ): void => {
    if (!session) return;
    try {
      options.store.appendQaMessage({
        sessionId: session.id,
        role: 'assistant',
        content: `回答未完成：${message}`,
        response: null,
        answered: false
      });
    } catch {
      // 失败记录写不进去时只丢这一条记录，不改变向用户报告的失败原因。
    }
  };

  // 同一会话/同一文献同一时刻只处理一轮问答：两个窗口同时提问会让 user/assistant 交错落库，
  // 历史拼接按「user 后紧邻的 assistant」配对会配错。进程内集合足够（单机 Core）。
  const activeChatTurns = new Set<string>();
  const beginChatTurn = (key: string | null): boolean => {
    if (!key) return true;
    if (activeChatTurns.has(key)) return false;
    activeChatTurns.add(key);
    return true;
  };
  const endChatTurn = (key: string | null): void => {
    if (key) activeChatTurns.delete(key);
  };
  /** 并发锁的键：独立问答按会话 id，阅读页按文献 id；其它请求不锁。 */
  const chatTurnKeyOf = (
    session: QaSessionRecord | null,
    documentId?: string
  ): string | null =>
    session ? `qa:${session.id}` : documentId ? `doc:${documentId}` : null;

  /** 危险写操作（重新生成/编辑/分支删除/导入/删会话）也要占用同一把锁。 */
  const tryBeginChatWrite = (key: string, reply: FastifyReply): boolean => {
    if (!beginChatTurn(key)) {
      reply.code(409).send({ error: API_ERROR_CODES.busy, message: '该会话/文献正在回答中，请等这一轮结束后再试' });
      return false;
    }
    return true;
  };

  app.post(`${API_PREFIX}/chat/ask/stream`, async (request, reply) => {
    const body = request.body as Partial<ChatRequest> | null;
    // 语音直接提问（全模态）可以没有文字问题：录音本身就是问题。
    const hasAudio = Boolean(body?.audio && typeof body.audio === 'object');
    const questionText = typeof body?.question === 'string' ? body.question : '';
    if (!body || (!hasAudio && questionText.trim() === '')) {
      return badRequest(reply, '需要 question');
    }
    const gate = await budgetGate(body);
    if (gate?.exceeded) {
      // 预算确认不是错误：返回 200 + needs_confirmation，前端弹确认框后带 confirm_budget 重发。
      // stream 端点在这里返回**纯 JSON**（不 hijack、不发 SSE），api-client 会按 content-type 识别。
      return reply.send({
        needs_confirmation: true,
        budget: gate,
        answer: '',
        sources: [],
        metadata: {}
      });
    }
    // 独立问答会话：预算确认通过后才建/取会话，避免用户取消确认时留下空会话。
    const regenerate = body.qa_regenerate === true && !hasAudio;
    if (
      regenerate &&
      !(typeof body.qa_session_id === 'string' && body.qa_session_id.trim())
    ) {
      return badRequest(reply, '重新生成需要问答会话 id');
    }
    const qaSession = qaSessionForRequest(body);
    if (
      typeof body.qa_session_id === 'string' &&
      body.qa_session_id.trim() &&
      !qaSession &&
      !body.documentId
    ) {
      return badRequest(reply, '问答会话不存在');
    }
    let questionForTurn = questionText;
    // 语音轮先落占位；模型返回 audio_transcript 后补写用户消息正文（见 updateVoiceUserTurn）。
    let userTurn: QaMessageRecord | null = null;
    // 同一会话/文献只允许一轮在飞：并发请求直接 409（比让 user/assistant 交错落库安全）。
    const turnKey = chatTurnKeyOf(
      qaSession,
      typeof body.documentId === 'string' && body.documentId ? body.documentId : undefined
    );
    if (!beginChatTurn(turnKey)) {
      return reply.code(409).send({ error: API_ERROR_CODES.busy, message: '该会话/文献正在回答中，请等这一轮结束后再试' });
    }
    try {
    if (qaSession && regenerate) {
      // 重新生成：丢掉最后一轮助手消息（含失败占位），保留最后的用户问题，不重复记用户消息。
      const previous = options.store.rewindQaSessionTail(qaSession.id);
      if (previous === null) return badRequest(reply, '没有可重新生成的回答');
      questionForTurn = previous;
    } else {
      userTurn = persistQaUserTurn(qaSession, body, questionText);
    }
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive'
    });
    const send = (event: string, data: unknown): void => {
      raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    // 按文献登记，彻底删除该文献时中止本请求（含跨文献范围里列出的文献）。
    const untrackDocument = trackDocumentRequests(
      [
        typeof body.documentId === 'string' ? body.documentId : undefined,
        ...(Array.isArray(body.scope_documents) ? (body.scope_documents as string[]) : [])
      ],
      controller
    );
    // 用响应流的 close/aborted 判断真正的取消。
    raw.once('close', abort);
    request.raw.once('aborted', abort);
    try {
      const result = await answerQuestion(
        options.store,
        options.secrets,
        {
          question: questionForTurn,
          documentId: typeof body.documentId === 'string' ? body.documentId : undefined,
          page: typeof body.page === 'number' ? body.page : undefined,
          selection: typeof body.selection === 'string' ? body.selection : undefined,
          taskId: typeof body.taskId === 'string' ? body.taskId : undefined,
          confirmSearch: body.confirmSearch === true,
          confirm_gap_search: body.confirm_gap_search === true,
          search_token:
            typeof body.search_token === 'string' ? body.search_token : undefined,
          history: Array.isArray(body.history) ? (body.history as never) : undefined,
          reading_scope: body.reading_scope,
          reading_rigor: body.reading_rigor,
          source_policy: body.source_policy,
          include_memory: body.include_memory === true,
          scope_documents: Array.isArray(body.scope_documents) ? body.scope_documents as string[] : undefined,
          scope_tags: Array.isArray(body.scope_tags) ? (body.scope_tags as string[]) : undefined,
          voice_original:
            typeof body.voice_original === 'string' ? body.voice_original : undefined,
          web_query: typeof body.web_query === 'string' ? body.web_query : undefined,
          audio:
            body.audio && typeof body.audio === 'object'
              ? (body.audio as never)
              : undefined,
          // 独立问答：服务端按会话拼完整历史并持久化本轮（阅读页不传/不用该字段）。
          qa_session_id: qaSession?.id
        },
        controller.signal,
        (done, total) => send('progress', { done, total }),
        (text) => send('draft', { text }),
        () => send('draft_reset', {}),
        (text) => send('stage', { text }),
        (claims) => send('audit', { claims })
      );
      const response: ChatResponse = qaSession
        ? { ...result, qa_session_id: qaSession.id }
        : result;
      // 语音轮：模型返回逐字转写后补写用户消息正文（占位 → 「（语音）转写」）。
      updateVoiceUserTurn(qaSession, userTurn, response);
      persistQaAssistantTurn(qaSession, response);
      send('result', response);
    } catch (error) {
      const message =
        error instanceof Error && error.name === 'AbortError'
          ? '已取消阅读'
          : error instanceof Error
            ? error.message
            : '回答失败';
      persistQaAssistantFailure(qaSession, message);
      if (error instanceof Error && error.name === 'AbortError') {
        send('error', { message, status: 499 });
      } else {
        send('error', { message });
      }
    } finally {
      untrackDocument();
      request.raw.off('aborted', abort);
      raw.off('close', abort);
      raw.end();
    }
    } finally {
      endChatTurn(turnKey);
    }
  });

  app.post(`${API_PREFIX}/chat/ask`, async (request, reply) => {
    const body = request.body as Partial<ChatRequest> | null;
    // 与 stream 端点同口径：录音可以直接作为问题。
    const hasAudio = Boolean(body?.audio && typeof body.audio === 'object');
    const questionText = typeof body?.question === 'string' ? body.question : '';
    if (!body || (!hasAudio && questionText.trim() === '')) {
      return badRequest(reply, '需要 question');
    }
    const gate = await budgetGate(body);
    if (gate?.exceeded) {
      // 与 stream 端点同口径：200 + needs_confirmation，不是错误。
      return reply.send({
        needs_confirmation: true,
        budget: gate,
        answer: '',
        sources: [],
        metadata: {}
      });
    }
    // 独立问答会话：预算确认通过后才建/取会话（用户取消确认时不留空会话）。
    const regenerate = body.qa_regenerate === true && !hasAudio;
    if (
      regenerate &&
      !(typeof body.qa_session_id === 'string' && body.qa_session_id.trim())
    ) {
      return badRequest(reply, '重新生成需要问答会话 id');
    }
    const qaSession = qaSessionForRequest(body);
    if (
      typeof body.qa_session_id === 'string' &&
      body.qa_session_id.trim() &&
      !qaSession &&
      !body.documentId
    ) {
      return badRequest(reply, '问答会话不存在');
    }
    let questionForTurn = questionText;
    // 语音轮先落占位；模型返回 audio_transcript 后补写用户消息正文（见 updateVoiceUserTurn）。
    let userTurn: QaMessageRecord | null = null;
    // 同一会话/文献只允许一轮在飞：并发请求直接 409（比让 user/assistant 交错落库安全）。
    const turnKey = chatTurnKeyOf(
      qaSession,
      typeof body.documentId === 'string' && body.documentId ? body.documentId : undefined
    );
    if (!beginChatTurn(turnKey)) {
      return reply.code(409).send({ error: API_ERROR_CODES.busy, message: '该会话/文献正在回答中，请等这一轮结束后再试' });
    }
    try {
    if (qaSession && regenerate) {
      // 重新生成：丢掉最后一轮助手消息（含失败占位），保留最后的用户问题，不重复记用户消息。
      const previous = options.store.rewindQaSessionTail(qaSession.id);
      if (previous === null) return badRequest(reply, '没有可重新生成的回答');
      questionForTurn = previous;
    } else {
      userTurn = persistQaUserTurn(qaSession, body, questionText);
    }
    try {
      const controller = new AbortController();
      const abort = (): void => controller.abort();
      const untrackDocument = trackDocumentRequests(
        [
          typeof body.documentId === 'string' ? body.documentId : undefined,
          ...(Array.isArray(body.scope_documents) ? (body.scope_documents as string[]) : [])
        ],
        controller
      );
      // 用响应流的 close 判断真正的取消：请求体读完时 request.raw 也会触发 close，
      // 若监听 request.raw 会把正常的非流式请求误判为取消（真实模型 E2E 发现）。
      reply.raw.once('close', abort);
      request.raw.once('aborted', abort);
      try {
        const result = await answerQuestion(
          options.store,
          options.secrets,
          {
            question: questionForTurn,
            documentId: typeof body.documentId === 'string' ? body.documentId : undefined,
            page: typeof body.page === 'number' ? body.page : undefined,
            selection: typeof body.selection === 'string' ? body.selection : undefined,
            taskId: typeof body.taskId === 'string' ? body.taskId : undefined,
            confirmSearch: body.confirmSearch === true,
            confirm_gap_search: body.confirm_gap_search === true,
            search_token:
              typeof body.search_token === 'string' ? body.search_token : undefined,
            history: Array.isArray(body.history) ? (body.history as never) : undefined,
            reading_scope: body.reading_scope,
            reading_rigor: body.reading_rigor,
            source_policy: body.source_policy,
            include_memory: body.include_memory === true,
            scope_documents: Array.isArray(body.scope_documents) ? body.scope_documents as string[] : undefined,
          scope_tags: Array.isArray(body.scope_tags) ? (body.scope_tags as string[]) : undefined,
          voice_original:
            typeof body.voice_original === 'string' ? body.voice_original : undefined,
          web_query: typeof body.web_query === 'string' ? body.web_query : undefined,
            audio:
              body.audio && typeof body.audio === 'object'
                ? (body.audio as never)
                : undefined,
            // 独立问答：服务端按会话拼完整历史并持久化本轮（阅读页不传/不用该字段）。
            qa_session_id: qaSession?.id
          },
          controller.signal
        );
        const response: ChatResponse = qaSession
          ? { ...result, qa_session_id: qaSession.id }
          : result;
        // 语音轮：模型返回逐字转写后补写用户消息正文（占位 → 「（语音）转写」）。
        updateVoiceUserTurn(qaSession, userTurn, response);
        persistQaAssistantTurn(qaSession, response);
        return response;
      } finally {
        untrackDocument();
        reply.raw.off('close', abort);
        request.raw.off('aborted', abort);
      }
    } catch (error) {
      const message =
        error instanceof Error && error.name === 'AbortError'
          ? '请求已取消'
          : error instanceof Error
            ? error.message
            : '回答失败';
      persistQaAssistantFailure(qaSession, message);
      if (error instanceof Error && error.name === 'AbortError') {
        return reply.code(499).send({ error: API_ERROR_CODES.cancelled, message: '请求已取消' });
      }
      return badRequest(reply, message);
    }
    } finally {
      endChatTurn(turnKey);
    }
  });

  app.put(`${API_PREFIX}/settings`, async (request, reply) => {
    const body = request.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return badRequest(reply, '设置必须是对象');
    }
    const patch: SettingsMap = {};
    for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
      if (typeof value !== 'string') return badRequest(reply, `设置项 ${key} 必须是字符串`);
      patch[key] = value;
    }
    return options.store.updateSettings(patch);
  });

  return app;
}
