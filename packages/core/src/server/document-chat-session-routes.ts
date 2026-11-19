import type { FastifyInstance } from 'fastify';
import { API_PREFIX } from '@studianda/shared';
import {
  normalizeDocumentChatSessions,
  readDocumentChatSessions,
  writeDocumentChatSessions
} from '../document-chat-sessions.js';
import type { Store } from '../store.js';
import { badRequest, notFound } from './http.js';

export interface DocumentChatSessionRouteOptions {
  store: Store;
}

/**
 * 阅读伙伴会话清单读写（5 条）：GET/POST/PUT/DELETE `/documents/:id/chat-sessions`
 * 与 PATCH `/documents/:id/chat-sessions/:sessionId`。从 server.ts 抽出。
 *
 * 清单存在 `document_chat_sessions` 表（schema 15 起），消息归属靠 metadata.sessionId；
 * 读写在 `../document-chat-sessions.js`（阅读摘要压缩也会更新其中的 contextSummary）。
 * 本模块只依赖 store，不碰任何实例级注册表。
 *
 * 行为差异**是历史选择、不要顺手统一**：
 * - GET 与 DELETE 都检查文档存在（404）；
 * - POST 用 `normalizeDocumentChatSessions` 规整单条 session 后调 store 创建；
 * - PUT 用 `writeDocumentChatSessions`（逐行 upsert，不删除未带上的其它会话）；
 * - DELETE 返回 `{ ok, removed, sessions }`（removed 为被删会话 id 或 null）。
 */
export function registerDocumentChatSessionRoutes(
  app: FastifyInstance,
  options: DocumentChatSessionRouteOptions
): void {
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
}
