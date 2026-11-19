import type { FastifyInstance } from 'fastify';
import { API_PREFIX } from '@studianda/shared';
import {
  bookSummaryPlan,
  outlineOverview,
  readCachedBookSummary,
  resetBookSummary
} from '../book-summary.js';
import type { BookSummaryRunner } from '../book-summary-runner.js';
import { resolveReadingChatConfig } from '../chat.js';
import type { SecretStore } from '../secrets.js';
import type { Store } from '../store.js';
import { badRequest, notFound } from './http.js';

export interface ChatBookSummaryRouteOptions {
  store: Store;
  secrets: SecretStore;
  /** 长任务状态机（每 server 实例一个），由 `buildServer` 创建后注入。 */
  runner: BookSummaryRunner;
}

/**
 * 全书摘要路由（4 条）：GET `/documents/:id/book-summary`、
 * POST `/book-summary/start`、POST `/book-summary/cancel`、DELETE `/book-summary`。
 * 从 server.ts 抽出；任务状态机在 `../book-summary-runner.js`，本模块只做 HTTP/缓存读写。
 *
 * 行为差异**是历史选择、不要顺手统一**：
 * - `start` 幂等：同一文献 running 时只返回 `{ job }`（**不带 plan**、不 409），且不解析
 *   模型配置（快速路径在原顺序上先于配置校验，见下）；
 * - `cancel` **不检查文档存在、不返回 404**：没有任务时返回 idle 视图；
 * - `DELETE` 顺序固定：先 abort 在途 run → 再移除任务条目 → 再清摘要缓存
 *   （顺序反了会留下继续写库的孤儿任务）。
 */
export function registerChatBookSummaryRoutes(
  app: FastifyInstance,
  options: ChatBookSummaryRouteOptions
): void {
  // 分层生成 + 缓存复用。plan 只读本地目录与缓存，不调用模型；
  // overview 是纯本地目录/页区间概览（T1，不调用模型）；start 在后台跑。
  app.get(`${API_PREFIX}/documents/:id/book-summary`, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!options.store.getDocument(id)) return notFound(reply, '文档不存在');
    const config = resolveReadingChatConfig(options.store, options.secrets);
    const plan = await bookSummaryPlan(options.store, id, config?.model ?? '');
    const result = readCachedBookSummary(options.store, id);
    const document = options.store.getDocument(id)!;
    return {
      plan,
      job: options.runner.view(id),
      result,
      overview: outlineOverview(document.name, plan.blocks)
    };
  });

  app.post(`${API_PREFIX}/documents/:id/book-summary/start`, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!options.store.getDocument(id)) return notFound(reply, '文档不存在');
    // 幂等快速路径保持原顺序：running 时不解析模型配置、不返回 plan、不 409。
    const current = options.runner.view(id);
    if (current.status === 'running') return { job: current };
    const config = resolveReadingChatConfig(options.store, options.secrets);
    if (!config) {
      return badRequest(reply, '请先在「平台与模型」里配置会话模型，再生成全书摘要');
    }
    // 真正的并发占位在 runner.start 内同步完成（路由层的检查只是快速路径）。
    return options.runner.start({ documentId: id, config });
  });

  app.post(`${API_PREFIX}/documents/:id/book-summary/cancel`, async (request) => {
    const { id } = request.params as { id: string };
    // 不检查文档存在、不返回 404：没有任务时返回 idle 视图（既有行为）。
    return options.runner.cancel(id);
  });

  app.delete(`${API_PREFIX}/documents/:id/book-summary`, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!options.store.getDocument(id)) return notFound(reply, '文档不存在');
    // 顺序固定：先 abort → 再删条目 → 再清缓存（缓存清理职责仍在路由，不在 runner）。
    options.runner.remove(id);
    resetBookSummary(options.store, id);
    return { ok: true };
  });
}
