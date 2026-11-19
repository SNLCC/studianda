import type { FastifyInstance } from 'fastify';
import { API_PREFIX } from '@studianda/shared';
import type { Store } from '../store.js';
import { notFound } from './http.js';

export interface ChatMessageRouteOptions {
  store: Store;
}

/**
 * 阅读伙伴消息读路由（3 条）：GET `/documents/:id/messages`、
 * `/messages/page`、`/messages/search`。从 server.ts 抽出。
 *
 * 本步只迁**读**部分：POST `/documents/:id/messages`（bodyLimit 8MB）、
 * `/messages/rewind`、PATCH/DELETE `/messages/:messageId` 仍留在 server.ts，
 * 等写路由迁出时再并入本模块（届时注入 chatTurns）。
 *
 * 行为差异**是历史选择、不要顺手统一**：
 * - GET `/messages`（旧接口，仍兼容其它调用方）**不检查文档是否存在**，直接返回列表；
 * - `/messages/page` 与 `/messages/search` **检查**文档存在（404）。
 */
export function registerChatMessageRoutes(
  app: FastifyInstance,
  options: ChatMessageRouteOptions
): void {
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
}
