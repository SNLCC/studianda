import type { FastifyInstance } from 'fastify';
import {
  API_ERROR_CODES,
  API_PREFIX,
  type MarkdownJobSnapshot
} from '@studianda/shared';
import {
  cancelMarkdownImport,
  cancelMarkdownScan,
  getMarkdownImportReportPage,
  getMarkdownImportStatus,
  getMarkdownJobSnapshot,
  getMarkdownScanStatus,
  getMarkdownScanTree,
  importMarkdownNotes,
  previewMarkdownImportDuplicates,
  resolveMarkdownSelection,
  scanMarkdownVault,
  searchMarkdownScan,
  startMarkdownImport,
  startMarkdownScan,
  subscribeMarkdownJobChanges
} from '../markdown-import.js';
import type { Store } from '../store.js';
import { badRequest } from './http.js';
import { sendJsonMaybeGzip } from './json-response.js';

export interface MarkdownRouteOptions {
  store: Store;
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

/** Markdown 库扫描/导入/SSE 任务路由（含进程级 SSE 状态）。从 server.ts 抽出。 */
export function registerMarkdownRoutes(app: FastifyInstance, options: MarkdownRouteOptions): void {
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

  // Markdown 导入前的重复检查：按 externalKey 判断哪些文件已导入（不读正文、不写库）。
  app.post(`${API_PREFIX}/markdown/import/preview`, async (request, reply) => {
    const body = (request.body ?? {}) as { vaultPath?: unknown; files?: unknown };
    if (typeof body.vaultPath !== 'string' || !body.vaultPath.trim()) {
      return badRequest(reply, '需要库目录路径');
    }
    if (!Array.isArray(body.files) || !body.files.every((file) => typeof file === 'string')) {
      return badRequest(reply, 'files 必须是字符串数组');
    }
    try {
      return previewMarkdownImportDuplicates(options.store, {
        vaultPath: body.vaultPath,
        files: body.files as string[]
      });
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '检查重复导入失败');
    }
  });

  // Markdown 选择性导入：把选中的 Markdown 笔记导入为独立笔记（去重更新）。
  app.post(`${API_PREFIX}/markdown/import`, async (request, reply) => {
    const body = (request.body ?? {}) as {
      vaultPath?: unknown;
      files?: unknown;
      duplicatePolicy?: unknown;
    };
    if (typeof body.vaultPath !== 'string' || !body.vaultPath.trim()) {
      return badRequest(reply, '需要库目录路径');
    }
    if (!Array.isArray(body.files) || !body.files.every((file) => typeof file === 'string')) {
      return badRequest(reply, 'files 必须是字符串数组');
    }
    if (
      body.duplicatePolicy !== undefined &&
      body.duplicatePolicy !== 'update' &&
      body.duplicatePolicy !== 'skip'
    ) {
      return badRequest(reply, 'duplicatePolicy 必须是 update 或 skip');
    }
    try {
      return await importMarkdownNotes(options.store, {
        vaultPath: body.vaultPath,
        files: body.files as string[],
        duplicatePolicy: body.duplicatePolicy as 'update' | 'skip' | undefined
      });
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '导入 Markdown 笔记失败');
    }
  });

  // 后台分块导入（带进度/取消；单并发）。
  app.post(`${API_PREFIX}/markdown/import/start`, async (request, reply) => {
    const body = (request.body ?? {}) as {
      vaultPath?: unknown;
      files?: unknown;
      duplicatePolicy?: unknown;
    };
    if (typeof body.vaultPath !== 'string' || !body.vaultPath.trim()) {
      return badRequest(reply, '需要库目录路径');
    }
    if (!Array.isArray(body.files) || !body.files.every((file) => typeof file === 'string')) {
      return badRequest(reply, 'files 必须是字符串数组');
    }
    if (
      body.duplicatePolicy !== undefined &&
      body.duplicatePolicy !== 'update' &&
      body.duplicatePolicy !== 'skip'
    ) {
      return badRequest(reply, 'duplicatePolicy 必须是 update 或 skip');
    }
    try {
      return startMarkdownImport(options.store, {
        vaultPath: body.vaultPath,
        files: body.files as string[],
        duplicatePolicy: body.duplicatePolicy as 'update' | 'skip' | undefined
      });
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '启动 Markdown 笔记导入失败');
    }
  });

  app.get(`${API_PREFIX}/markdown/import/status`, async (request, reply) =>
    sendJsonMaybeGzip(request, reply, getMarkdownImportStatus())
  );

  app.post(`${API_PREFIX}/markdown/import/cancel`, async () => cancelMarkdownImport());
}
