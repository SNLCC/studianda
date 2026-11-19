import type { FastifyInstance, FastifyReply } from 'fastify';
import { API_ERROR_CODES, API_PREFIX } from '@studianda/shared';
import { clearSummaryCoveringMessage } from '../document-chat-sessions.js';
import type { Store } from '../store.js';
import { ChatTurnRegistry, chatTurnKeyOf } from './chat-turn-registry.js';
import { badRequest, notFound } from './http.js';

export interface ChatMessageRouteOptions {
  store: Store;
  /**
   * 轮次互斥表（每 server 实例一个，由 `buildServer` 创建后注入）：只被 3 条危险写路由
   * （rewind / PATCH / DELETE）使用，`POST /messages` 不拿锁。
   */
  chatTurns: ChatTurnRegistry;
}

/**
 * 阅读伙伴消息模块（7 条）：读 3 条 GET `/documents/:id/messages`、`/messages/page`、
 * `/messages/search`；写 4 条 POST `/messages`（bodyLimit 8MB）、POST `/messages/rewind`、
 * PATCH `/messages/:messageId`、DELETE `/messages/:messageId`。从 server.ts 抽出。
 *
 * **注册点故意分成两个函数**（Step 8 恢复原相对位置）：读 3 条 + POST `/messages` 在
 * `retrieval/prewarm` 之后、`reading-tasks` 之前注册；3 条危险写在 book-summary 之后、
 * notes 之前注册——这是拆分前内联路由的原始顺序。`scripts/check-route-order.mjs` 以
 * git 基线逐条比对，这个拆分让它保持"逐条一致"（同一模块的注册点被提前会报顺序差异）。
 * 两条路由集合互不重叠、method+path 也互不影子化，拆开注册没有行为差异。
 *
 * 写路由里的 rewind / PATCH / DELETE 是危险写操作：与两个 ask 路由共用**同一把轮次锁**
 * （`ChatTurnRegistry`，锁粒度是文献），回答在飞时返回 409。`POST /messages` **不拿锁**——
 * 消息由客户端直接落库，历史和并发行为都依赖这一点，不要顺手统一。
 * 锁内清摘要（`clearSummaryCoveringMessage`）是无 CAS 的整行读改写，必须持 doc 锁调用。
 *
 * 行为差异**是历史选择、不要顺手统一**：
 * - GET `/messages`（旧接口，仍兼容其它调用方）**不检查文档是否存在**，直接返回列表；
 * - `/messages/page` 与 `/messages/search` **检查**文档存在（404）；
 * - POST `/messages` 单独放宽 body 上限到 8MB：整轮 ChatResponse（notice/audit/coverage）
 *   与来源正文可能很大，默认 2MB 会 413；
 * - rewind 返回 `{ ok: true, ...store.rewindDocumentMessagesTail(...) }`（展开结构不变）；
 * - PATCH 的 404 文案是「用户消息不存在」，DELETE 的 404 文案是「消息不存在」。
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

  // 阅读页问答消息可能带整轮 ChatResponse（notice/audit/coverage 等）与来源正文，
  // 单独放宽这一条路由的 body 上限，避免大回答因默认 2MB 被 413 丢掉。
  // 注意：这条**不参与轮次互斥**（客户端直接落库，与 ask/rewind/edit/delete 不同）。
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
    }
  );
}

/**
 * 3 条危险写路由（重新生成/编辑并重问/分支删除）。
 *
 * 独立注册函数的原因见文件头：注册点必须留在拆分前的原始位置（book-summary 之后、
 * notes 之前），否则 `scripts/check-route-order.mjs` 会报相对基线顺序变化。
 * 与 `registerChatMessageRoutes` 共用 `ChatMessageRouteOptions.chatTurns`。
 */
export function registerChatMessageWriteRoutes(
  app: FastifyInstance,
  options: ChatMessageRouteOptions
): void {
  /**
   * 危险写操作（重新生成/编辑并重问/分支删除）的本地薄封装：占用轮次锁，失败即回 409。
   * 两种 409 文案归路由层所有（薄封装一种、两个 ask 路由另一种），registry 只回答 boolean。
   */
  const tryBeginChatWrite = (key: string, reply: FastifyReply): boolean => {
    if (!options.chatTurns.begin(key)) {
      reply.code(409).send({
        error: API_ERROR_CODES.busy,
        message: '该会话/文献正在回答中，请等这一轮结束后再试'
      });
      return false;
    }
    return true;
  };

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
      options.chatTurns.end(lockKey);
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
      clearSummaryCoveringMessage(options.store, id, sessionId, numericId);
      return result;
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '编辑消息失败');
    } finally {
      options.chatTurns.end(lockKey);
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
      clearSummaryCoveringMessage(options.store, id, sessionId, numericId);
      return result;
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '删除消息失败');
    } finally {
      options.chatTurns.end(lockKey);
    }
  });
}
