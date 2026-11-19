import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import multipart from '@fastify/multipart';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
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
  type MaintenanceStatus,
  type OutlineResult,
  type SearchRequest,
  type TranslationConfigRecord
} from '@studianda/shared';
import { answerQuestion } from './chat.js';
import { BookSummaryRunner } from './book-summary-runner.js';
import { createChatBudgetPolicy } from './chat-budget-policy.js';
import { planQuestion } from './planning.js';
import { planReading } from './reading-plan.js';
import { listBackups } from './backup.js';
import { registerBackupRoutes } from './server/backup-routes.js';
import { registerCorpusSessionRoutes } from './server/corpus-session-routes.js';
import { registerFlowRoutes } from './server/flow-routes.js';
import { registerNoteAssetRoutes } from './server/note-assets-routes.js';
import { registerDocumentNotesRoute, registerNotesRoutes } from './server/notes-routes.js';
import { registerDocumentImportRoutes } from './server/document-import-routes.js';
import { registerDocumentManageRoutes } from './server/document-manage-routes.js';
import { registerChatMessageRoutes } from './server/chat-message-routes.js';
import { registerChatBookSummaryRoutes } from './server/chat-book-summary-routes.js';
import { registerChatBudgetRoutes } from './server/chat-budget-routes.js';
import { registerDocumentChatSessionRoutes } from './server/document-chat-session-routes.js';
import { ChatTurnRegistry, chatTurnKeyOf } from './server/chat-turn-registry.js';
import { DocumentRequestRegistry } from './server/document-request-registry.js';
import { registerDocumentPageRoutes, registerDocumentExportRoutes } from './server/document-pages-routes.js';
import { registerDocumentStructureRoutes } from './server/document-structure-routes.js';
import { registerLibraryRoutes } from './server/library-routes.js';
import { registerMarkdownRoutes } from './server/markdown-routes.js';
import { registerReferenceGraphRoutes } from './server/reference-graph-routes.js';
import { registerModelServiceRoutes, registerModelTestRoute } from './server/model-service-routes.js';
import { registerSettingsRoutes, registerSettingsUpdateRoutes } from './server/settings-routes.js';
import { registerSpeechRoutes } from './server/speech-routes.js';
import { registerWebSearchRoutes } from './server/web-search-routes.js';
import { registerZoteroRoutes } from './server/zotero-routes.js';
import { sendJsonMaybeGzip } from './server/json-response.js';
import { registerOcrRoutes } from './server/ocr-routes.js';
import {
  createDiagnosticsPackage,
  generateDiagnostics,
  listDiagnosticsPackages
} from './diagnostics.js';
import { appendErrorLog, redactSensitive } from './error-log.js';
import { searchLibrary, searchLibraryDocuments } from './library-search.js';
import { cancelMarkdownImport, cancelMarkdownScan } from './markdown-import.js';
import { resetSearchPlans } from './web-search.js';
import { loadActiveTokenizer } from './tokenizer.js';
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
import { resolveProjectScope } from './project-scope.js';
import type { SecretStore } from './secrets.js';
import { AttachmentChangedError, type Store } from './store.js';
import { readDocumentChatSessions, writeDocumentChatSessions } from './document-chat-sessions.js';

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

import { badRequest, notFound } from './server/http.js';

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

export function buildServer(options: ServerOptions): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024 });
  // 维护状态里的运行时长：进程启动即记录，只用于展示，不持久化。
  const startedAt = Date.now();
  // 已导入的本地 tokenizer：启动即生效；文件缺失/损坏时停在保守估算，不影响启动。
  loadActiveTokenizer(options.store);
  // 进行中的请求按文献登记：彻底删除文献之前先取消这些请求，避免后台任务继续
  // 读写已删除的数据。每实例一张表：chat / 翻译单页 / 全书摘要三处登记，
  // purge 与清空数据两处消费，因此不能做成模块级单例（会跨 server 实例泄漏）。
  const documentRequests = new DocumentRequestRegistry();
  // 同一文献同一时刻只处理一轮问答：两个窗口同时提问会让 user/assistant 交错落库。
  // 每实例一份（进程内集合足够，单机 Core）；与 documentRequests 分工不同，不要合并。
  const chatTurns = new ChatTurnRegistry();
  // 全书摘要长任务（进程内、按文献隔离）：后台跑，前端轮询进度；摘要缓存本身落库，重启后仍可复用。
  // 状态机在 book-summary-runner.ts；start 把 controller 登记进 documentRequests，purge/清空数据也能中止。
  const bookSummaries = new BookSummaryRunner({
    store: options.store,
    requests: documentRequests
  });
  // 预算策略（**无状态**）：`/chat/budget` 与 ask 的预算闸门共享同一套估算 helper。
  // 两套错误语义必须分开保留：闸门估算失败吞错返回 null（不阻断提问）；`/chat/budget`
  // 抛错由路由映射 400（项目不存在 404）。每次调用都重读设置，所以设置改动立即生效。
  const budget = createChatBudgetPolicy({ store: options.store });
  // 关停清理：全仓此前没有任何 `onClose` 接线（grep 确认），这是唯一一处，不新开第二个
  // 清理 hook。顺序按"共享中止通道 → 准入锁 → 任务状态"分层：
  // 1) 先 abort 在途请求：abort 只是发停止信号，让在途请求/后台 run 的 finally 收尾
  //    （释放锁、落库）仍可正常执行；它是 chat / 翻译单页 / 全书摘要三处共用的唯一中止通道；
  // 2) 再 close 轮次锁：拒绝后续 begin，是"不再接新轮次"的最后一道门；
  // 3) 最后 close 全书摘要运行器：中止它自己的 controller 并清空 job 表，让恢复中的 run
  //    因身份比较/closed 而放弃回写。三者都同步、不 await、各自容错：单个失败只记日志，
  //    不能阻断 app.close()。store 由调用方（index.ts shutdown / 测试 teardown）在
  //    app.close() 之后关闭，不并入这里。
  app.addHook('onClose', async () => {
    try {
      documentRequests.abortAll();
    } catch (error) {
      console.error('[core] onClose abortAll failed:', error instanceof Error ? error.message : error);
    }
    try {
      chatTurns.close();
    } catch (error) {
      console.error('[core] onClose chatTurns.close failed:', error instanceof Error ? error.message : error);
    }
    try {
      bookSummaries.close();
    } catch (error) {
      console.error(
        '[core] onClose bookSummaries.close failed:',
        error instanceof Error ? error.message : error
      );
    }
  });
  void app.register(multipart, {
    limits: {
      files: 1,
      // 技术安全上限，远高于提醒阈值；普通文件不会被这里拒绝。
      fileSize: 4 * 1024 * 1024 * 1024
    }
  });
  registerBackupRoutes(app, options.store);
  registerOcrRoutes(app, { store: options.store, secrets: options.secrets });
  // 跨文献（语料）会话（schema 23）：范围快照 + 可追问的跨篇精读会话。
  registerCorpusSessionRoutes(app, { store: options.store, secrets: options.secrets });

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

  // L1 用户阅读流程（文件系统）：清单/详情 + 新建/编辑/启停/删除。
  // 放在鉴权 onRequest 钩子之后注册，保证写接口与既有只读接口一样必须带 token。
  registerFlowRoutes(app, { dataDir: options.store.dataDir });

  app.get(`${API_PREFIX}/health`, async (): Promise<HealthResponse> => ({
    application: APP_NAME,
    version: options.version,
    api_version: API_VERSION,
    closing: options.isClosing?.() ?? false
  }));

  // 文献列表、单层文件夹、逻辑项目（文献分组）路由见 server/library-routes.ts。
  registerLibraryRoutes(app, { store: options.store });

  // 笔记/批注图片资源（note-assets）路由见 server/note-assets-routes.ts。
  registerNoteAssetRoutes(app, { store: options.store });

  // Markdown 库扫描/导入/SSE 任务路由见 server/markdown-routes.ts。
  registerMarkdownRoutes(app, { store: options.store });

  // 全库引用关系图与反向链接见 server/reference-graph-routes.ts。
  registerReferenceGraphRoutes(app, { store: options.store });

  // 文献上传与导入任务路由见 server/document-import-routes.ts。
  registerDocumentImportRoutes(app, { store: options.store });
  // 模型连接测试路由见 server/model-service-routes.ts。
  registerModelTestRoute(app, { store: options.store, secrets: options.secrets });

  // 语音配置/识别/播报/音色/纠错路由见 server/speech-routes.ts。
  registerSpeechRoutes(app, { store: options.store, secrets: options.secrets });

  // 联网搜索配置、搜索计划与搜索路由见 server/web-search-routes.ts。
  registerWebSearchRoutes(app, { store: options.store, secrets: options.secrets });

  // Zotero 连接/分类/条目/诊断/附件与批注导入路由见 server/zotero-routes.ts。
  registerZoteroRoutes(app, { store: options.store, secrets: options.secrets });

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
      documentRequests.abortAll();
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
    const untrackDocument = documentRequests.track([id], controller);
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

  // 页数据/页文本/页图/缩略图见 server/document-pages-routes.ts。
  registerDocumentPageRoutes(app, { store: options.store, secrets: options.secrets });

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

  // 文献导出（Markdown / 批注 PDF）见 server/document-pages-routes.ts。
  registerDocumentExportRoutes(app, { store: options.store, secrets: options.secrets });

  // 文献元数据/排序/回收站/标签/重新连接见 server/document-manage-routes.ts。
  registerDocumentManageRoutes(app, {
    store: options.store,
    abortDocumentRequests: (id) => documentRequests.abort(id)
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
          origin?: unknown;
        }
      | null;
    if (!body || typeof body.documentId !== 'string' || typeof body.page !== 'number') {
      return badRequest(reply, '需要 documentId 与 page');
    }
    // 内容来源：AI 译文/识别结果由系统写入时传 'ai'；用户手工新建不传（落库 'user'）。
    if (body.origin !== undefined && body.origin !== 'user' && body.origin !== 'ai') {
      return badRequest(reply, 'origin 必须是 user 或 ai');
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
        style: typeof body.style === 'string' ? body.style : 'highlight',
        origin: body.origin as 'user' | 'ai' | undefined
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

  // 阅读伙伴会话清单的 5 条读写路由见 server/document-chat-session-routes.ts。
  // 注册位置保持原内联路由的位置：在 retrieval/prewarm 与 messages 读路由之前、
  // settings-update 之前（顺序经 route-order 比对逐条一致）。
  registerDocumentChatSessionRoutes(app, { store: options.store });

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

  // 阅读伙伴消息的 3 条读路由见 server/chat-message-routes.ts（GET /messages 不检查文档存在，
  // /messages/page 与 /messages/search 检查；写路由仍在本文件，待下一步迁出）。
  // 注册位置保持原内联路由的位置：在 retrieval/prewarm 之后、POST /messages 之前。
  registerChatMessageRoutes(app, { store: options.store });

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

  // 全书摘要的 4 条路由见 server/chat-book-summary-routes.ts（状态机在 book-summary-runner.ts）。
  // 注册位置保持原内联路由的位置：在 reading-tasks 之后、messages 写路由之前。
  registerChatBookSummaryRoutes(app, {
    store: options.store,
    secrets: options.secrets,
    runner: bookSummaries
  });

  // 阅读页「重新生成」：删除最后一轮助手回答（DB 内），保留用户问题；返回最后用户问题正文。
  // body.sessionId 可选：多会话时只在该会话内删除，避免误删其它会话的消息。
  app.post(`${API_PREFIX}/documents/:id/messages/rewind`, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!options.store.getDocument(id)) return notFound(reply, '文档不存在');
    const body = (request.body ?? {}) as { sessionId?: unknown };
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
    // 路由参数 id 类型上仍可为 null；getDocument 已保证非空，这里显式收窄，不做 `!` 强断言。
    const lockKey = chatTurnKeyOf(id);
    if (!lockKey) return notFound(reply, '文档不存在');
    if (!tryBeginChatWrite(lockKey, reply)) return;
    try {
      return { ok: true, ...options.store.rewindDocumentMessagesTail(id, sessionId) };
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '重置上一轮回答失败');
    } finally {
      chatTurns.end(lockKey);
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
    // 路由参数 id 类型上仍可为 null；getDocument 已保证非空，这里显式收窄，不做 `!` 强断言。
    const lockKey = chatTurnKeyOf(id);
    if (!lockKey) return notFound(reply, '文档不存在');
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
      chatTurns.end(lockKey);
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
    // 路由参数 id 类型上仍可为 null；getDocument 已保证非空，这里显式收窄，不做 `!` 强断言。
    const lockKey = chatTurnKeyOf(id);
    if (!lockKey) return notFound(reply, '文档不存在');
    if (!tryBeginChatWrite(lockKey, reply)) return;
    try {
      const result = options.store.deleteDocumentMessagesFrom(id, numericId, sessionId);
      if (!result.ok) return notFound(reply, '消息不存在');
      clearSummaryCoveringMessage(id, sessionId, numericId);
      return result;
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '删除消息失败');
    } finally {
      chatTurns.end(lockKey);
    }
  });

  // 单篇文献的笔记清单（其余笔记路由见 server/notes-routes.ts）。
  registerDocumentNotesRoute(app, { store: options.store });

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

  // 结构/内容块/参考文献/章节/引文定位/页遮罩见 server/document-structure-routes.ts。
  registerDocumentStructureRoutes(app, { store: options.store, secrets: options.secrets });

  // 独立笔记（不含文献）：CRUD/回收站/批量操作/虚拟文件夹/标签，见 server/notes-routes.ts。
  registerNotesRoutes(app, { store: options.store });

  // 平台/模型服务配置与密钥状态路由见 server/model-service-routes.ts。
  registerModelServiceRoutes(app, { store: options.store, secrets: options.secrets });

  // 设置读取、tokenizer 导入、密钥状态与增删路由见 server/settings-routes.ts。
  registerSettingsRoutes(app, { store: options.store, secrets: options.secrets });

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
    const rawProjectId = body.projectId;
    // 不带 projectId：原逻辑原样保留（query + documentId，documentIds 由 scopeDocuments 圈定）。
    if (rawProjectId === undefined) {
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
    }

    // 带 projectId：服务端把项目解析成**当前**文献集合，再走上面的同一套检索/标注逻辑
    // （只复用项目现有读取口径，不新增 SQL 查询）。与显式范围互斥，避免两个来源打架。
    if (typeof body.query !== 'string' || !body.query.trim()) {
      return badRequest(reply, '需要 query');
    }
    const projectId = typeof rawProjectId === 'string' ? rawProjectId.trim() : '';
    if (!projectId) return badRequest(reply, 'projectId 必须是非空字符串');
    const explicitDocuments = Array.isArray(body.scopeDocuments)
      ? body.scopeDocuments.filter((id) => typeof id === 'string' && id.trim() !== '')
      : [];
    if (explicitDocuments.length > 0) {
      return badRequest(reply, 'projectId 与 scopeDocuments 不能同时给：请二选一');
    }
    const explicitTags = Array.isArray(body.scopeTags)
      ? body.scopeTags.filter((tag) => typeof tag === 'string' && tag.trim() !== '')
      : [];
    if (explicitTags.length > 0) {
      return badRequest(reply, 'projectId 与 scopeTags 不能同时给：请二选一');
    }
    const projectScopeIds = resolveProjectScope(options.store, projectId);
    if (projectScopeIds === null) return notFound(reply, '项目不存在');
    const scope = {
      kind: 'project' as const,
      projectId,
      documentIds: projectScopeIds,
      empty: projectScopeIds.length === 0
    };
    // 空项目不是错误：明确回空结果 + 范围回执，客户端据此区分「项目里没有文献」与「没命中」。
    if (projectScopeIds.length === 0) return { hits: [], scope };
    try {
      const hits = await retrieve(
        options.store,
        options.secrets,
        body.query,
        // documentId 在项目范围里只作为排序锚点（不加入范围）；不传也能检索整个项目。
        typeof body.documentId === 'string' && body.documentId.trim() ? body.documentId : undefined,
        typeof body.page === 'number' && Number.isFinite(body.page) ? body.page : 1,
        body.mode === 'wide' ? 'wide' : 'close',
        typeof body.limit === 'number' && Number.isFinite(body.limit) ? body.limit : 20,
        {
          selection: typeof body.selection === 'string' ? body.selection : undefined,
          scopeDocumentIds: projectScopeIds,
          includeDerived: true
        }
      );
      return { hits: await annotateSearchHits(options.store, hits, { warm: true }), scope };
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

  // 预算估算与闸门逻辑见 chat-budget-policy.ts（无状态，每次调用重读设置）；
  // `POST /chat/budget` 路由见 server/chat-budget-routes.ts。
  // 注册位置保持原 URL 的相对位置：/plan-reading 之后、/chat/ask* 之前。
  registerChatBudgetRoutes(app, { budget });

  /**
   * 预算闸门薄封装：实现见 chat-budget-policy.ts 的 `gate`（估算失败吞错返回 null）。
   * 调用点顺序必须保持：scope（applyChatProjectScope）→ gate → needs_confirmation → beginTurn；
   * 把闸门挪进轮次锁内会让"并发 + 超预算"的响应从 needs_confirmation 变成 409。
   */
  const budgetGate = (body: Partial<ChatRequest>) => budget.gate(body);

  /**
   * 跨文献精读入口：把逻辑项目 `projectId` 解析成项目**当前**文献集合，
   * 用解析结果代替显式 `scope_documents` 后交给原有链路（预算闸门与阅读完全同语义）。
   *
   * 规则与建跨文献会话一致：与显式范围同时给是调用方歧义 → 400；
   * 项目不存在 → 404；项目没有文献 → 400（空范围不能静默退化成"全库"）。
   * 项目范围本身就是跨文献：解析成功后一并把 reading_scope 定为 'corpus'，不让调用方
   * 因为漏传这个开关而把项目范围静默降级成"只读当前一篇"。
   * 返回 null 表示错误响应已发送，调用方直接返回。
   */
  const applyChatProjectScope = (
    body: Partial<ChatRequest>,
    reply: FastifyReply
  ): Partial<ChatRequest> | null => {
    const rawProjectId = body.projectId;
    if (rawProjectId === undefined) return body;
    const projectId = typeof rawProjectId === 'string' ? rawProjectId.trim() : '';
    if (!projectId) {
      badRequest(reply, 'projectId 必须是非空字符串');
      return null;
    }
    const explicitDocuments = Array.isArray(body.scope_documents)
      ? body.scope_documents.filter((id) => typeof id === 'string' && id.trim() !== '')
      : [];
    if (explicitDocuments.length > 0) {
      badRequest(reply, 'projectId 与 scope_documents 不能同时给：请二选一');
      return null;
    }
    const explicitTags = Array.isArray(body.scope_tags)
      ? body.scope_tags.filter((tag) => typeof tag === 'string' && tag.trim() !== '')
      : [];
    if (explicitTags.length > 0) {
      badRequest(reply, 'projectId 与 scope_tags 不能同时给：请二选一');
      return null;
    }
    const scopeDocumentIds = resolveProjectScope(options.store, projectId);
    if (scopeDocumentIds === null) {
      notFound(reply, '项目不存在');
      return null;
    }
    if (scopeDocumentIds.length === 0) {
      badRequest(reply, '项目里还没有可用于精读的文献');
      return null;
    }
    return { ...body, reading_scope: 'corpus', scope_documents: scopeDocumentIds };
  };

  // 同一文献同一时刻只处理一轮问答：两个窗口同时提问会让 user/assistant 交错落库。
  // 状态收在 chatTurns（server/chat-turn-registry.ts，每实例一份）。两个 ask 路由直接
  // 调 chatTurns.begin（文案不同）；危险写操作走下面这个本地薄封装（占用 + 失败即回 409）。
  /** 危险写操作（重新生成/编辑/分支删除/导入/删会话）也要占用同一把锁。 */
  const tryBeginChatWrite = (key: string, reply: FastifyReply): boolean => {
    if (!chatTurns.begin(key)) {
      reply.code(409).send({ error: API_ERROR_CODES.busy, message: '该会话/文献正在回答中，请等这一轮结束后再试' });
      return false;
    }
    return true;
  };

  app.post(`${API_PREFIX}/chat/ask/stream`, async (request, reply) => {
    let body = request.body as Partial<ChatRequest> | null;
    // 语音直接提问（全模态）可以没有文字问题：录音本身就是问题。
    const hasAudio = Boolean(body?.audio && typeof body.audio === 'object');
    const questionText = typeof body?.question === 'string' ? body.question : '';
    if (!body || (!hasAudio && questionText.trim() === '')) {
      return badRequest(reply, '需要 question');
    }
    if (typeof body.documentId !== 'string' || !body.documentId.trim()) {
      return badRequest(reply, '独立会话已移除，请先从文献库打开一篇文献再提问');
    }
    // 跨文献精读入口：projectId 代替显式 scope_documents（预算闸门与阅读都按解析后的范围）。
    const scopedBody = applyChatProjectScope(body, reply);
    if (!scopedBody) return reply;
    body = scopedBody;
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
    const questionForTurn = questionText;
    // 同一文献只允许一轮在飞：并发请求直接 409。
    const turnKey = chatTurnKeyOf(body.documentId);
    if (!chatTurns.begin(turnKey)) {
      return reply.code(409).send({ error: API_ERROR_CODES.busy, message: '该文献正在回答中，请等这一轮结束后再试' });
    }
    try {
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
    const untrackDocument = documentRequests.track(
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
          reading_force: body.reading_force,
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
        },
        controller.signal,
        (done, total) => send('progress', { done, total }),
        // 回答已改为整段返回：草稿通道停用，两个形参位保留占位。
        undefined,
        undefined,
        (text) => send('stage', { text }),
        (claims) => send('audit', { claims })
      );
      const response: ChatResponse = result;
      // 语音轮：模型返回逐字转写后补写用户消息正文（占位 → 「（语音）转写」）。
      send('result', response);
    } catch (error) {
      const message =
        error instanceof Error && error.name === 'AbortError'
          ? '已取消阅读'
          : error instanceof Error
            ? error.message
            : '回答失败';
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
      chatTurns.end(turnKey);
    }
  });

  app.post(`${API_PREFIX}/chat/ask`, async (request, reply) => {
    let body = request.body as Partial<ChatRequest> | null;
    // 与 stream 端点同口径：录音可以直接作为问题。
    const hasAudio = Boolean(body?.audio && typeof body.audio === 'object');
    const questionText = typeof body?.question === 'string' ? body.question : '';
    if (!body || (!hasAudio && questionText.trim() === '')) {
      return badRequest(reply, '需要 question');
    }
    if (typeof body.documentId !== 'string' || !body.documentId.trim()) {
      return badRequest(reply, '独立会话已移除，请先从文献库打开一篇文献再提问');
    }
    // 跨文献精读入口：projectId 代替显式 scope_documents（预算闸门与阅读都按解析后的范围）。
    const scopedBody = applyChatProjectScope(body, reply);
    if (!scopedBody) return reply;
    body = scopedBody;
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
    const questionForTurn = questionText;
    const turnKey = chatTurnKeyOf(body.documentId);
    if (!chatTurns.begin(turnKey)) {
      return reply.code(409).send({ error: API_ERROR_CODES.busy, message: '该文献正在回答中，请等这一轮结束后再试' });
    }
    try {
      const controller = new AbortController();
      const abort = (): void => controller.abort();
      const untrackDocument = documentRequests.track(
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
            reading_force: body.reading_force,
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
            },
          controller.signal
        );
        const response: ChatResponse = result;
        // 语音轮：模型返回逐字转写后补写用户消息正文（占位 → 「（语音）转写」）。
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
      if (error instanceof Error && error.name === 'AbortError') {
        return reply.code(499).send({ error: API_ERROR_CODES.cancelled, message: '请求已取消' });
      }
      return badRequest(reply, message);
    } finally {
      chatTurns.end(turnKey);
    }
  });

  // 设置写入路由见 server/settings-routes.ts（注册位置保持在 chat 之后不变）。
  registerSettingsUpdateRoutes(app, { store: options.store, secrets: options.secrets });

  return app;
}
