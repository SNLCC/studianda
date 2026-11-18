import type { FastifyInstance } from 'fastify';
import {
  API_ERROR_CODES,
  API_PREFIX,
  FAILED_ANSWER_PREFIX,
  type ChatResponse,
  type DocumentDetail
} from '@studianda/shared';
import { isAbortError, resolveReadingChatConfig } from '../chat.js';
import { answerWithCorpus, readingBatchBudget } from '../reading-chat.js';
import { planQuestion } from '../planning.js';
import {
  corpusSessionView,
  defaultCorpusSessionTitle,
  normalizeCorpusSessionDocumentIds,
  skippedDocumentsNotice
} from '../corpus-sessions.js';
import type { SecretStore } from '../secrets.js';
import type { Store } from '../store.js';
import { badRequest, notFound } from './http.js';

export interface CorpusSessionRouteOptions {
  store: Store;
  secrets: SecretStore;
}

/**
 * 跨文献（语料）会话的最小可用版：把一次跨文献精读变成一个可继续追问的会话。
 *
 * - 范围在建立会话时冻结为 documentIds 快照（之后新增文献不自动加入）；
 * - 消息复用 `messages`（document_id 空串哨兵 + session_id），服务端负责落 user/assistant；
 * - 追问直接复用 `answerWithCorpus()`：同一会话的后续问题按快照范围 + 已落库历史继续；
 * - 范围里已删除的文献**跳过并报告**（响应 skipped_document_ids + notice），不静默缩范围。
 *
 * 本版不接 UI / api-client / 项目绑定；预算闸门也还没接到这条路由（见开发报告）。
 */
export function registerCorpusSessionRoutes(
  app: FastifyInstance,
  options: CorpusSessionRouteOptions
): void {
  const { store, secrets } = options;
  // 同一会话同时只允许一轮在飞：并发两轮会让 user/assistant 消息交错落库。
  const activeAsks = new Set<string>();

  app.post(`${API_PREFIX}/corpus-sessions`, async (request, reply) => {
    const body = (request.body ?? {}) as { documentIds?: unknown; title?: unknown };
    const documentIds = normalizeCorpusSessionDocumentIds(body.documentIds);
    if (documentIds.length === 0) {
      return badRequest(reply, '需要 documentIds：至少一篇文献');
    }
    const readable: DocumentDetail[] = [];
    const skippedDocumentIds: string[] = [];
    for (const documentId of documentIds) {
      const document = store.getDocument(documentId);
      if (document) readable.push(document);
      else skippedDocumentIds.push(documentId);
    }
    if (readable.length === 0) {
      return badRequest(reply, 'documentIds 里的文献都已删除或不存在，无法建立跨文献会话');
    }
    const title = defaultCorpusSessionTitle(body.title, readable);
    let session;
    try {
      session = store.createCorpusSession(title, documentIds);
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : '创建跨文献会话失败');
    }
    // 响应如实报告：快照按请求原样保存，但当前不可读的文献已经在 skippedDocumentIds 里。
    return { session: corpusSessionView(store, session) };
  });

  app.get(`${API_PREFIX}/corpus-sessions`, async () => ({
    sessions: store.listCorpusSessions().map((session) => corpusSessionView(store, session))
  }));

  app.get(`${API_PREFIX}/corpus-sessions/:id/messages`, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!store.getCorpusSession(id)) return notFound(reply, '跨文献会话不存在');
    return store.listCorpusSessionMessages(id);
  });

  app.delete(`${API_PREFIX}/corpus-sessions/:id`, async (request, reply) => {
    const { id } = request.params as { id: string };
    const removed = store.deleteCorpusSession(id);
    if (removed === null) return notFound(reply, '跨文献会话不存在');
    return { ok: true, removed };
  });

  app.post(`${API_PREFIX}/corpus-sessions/:id/ask`, async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = store.getCorpusSession(id);
    if (!session) return notFound(reply, '跨文献会话不存在');
    const body = (request.body ?? {}) as {
      question?: unknown;
      selection?: unknown;
      source_policy?: unknown;
    };
    const question = typeof body.question === 'string' ? body.question.trim() : '';
    if (!question) return badRequest(reply, '需要 question');
    const selection = typeof body.selection === 'string' ? body.selection.trim() : '';
    const allowKnowledge = body.source_policy !== 'document_only';

    // 1) 范围按「当前」库状态解析：快照里的已删除/不存在文献跳过并报告（快照本身不改写）。
    const documents: DocumentDetail[] = [];
    const skippedDocumentIds: string[] = [];
    for (const documentId of session.documentIds) {
      const document = store.getDocument(documentId);
      if (document) documents.push(document);
      else skippedDocumentIds.push(documentId);
    }
    if (documents.length === 0) {
      return reply.code(409).send({
        error: API_ERROR_CODES.conflict,
        message: '会话范围里的文献都已删除或不存在，无法继续追问；请新建会话。',
        details: { skipped_document_ids: skippedDocumentIds }
      });
    }

    const config = resolveReadingChatConfig(store, secrets);
    if (!config) {
      return badRequest(reply, '还没有可用的模型服务配置，无法进行跨文献阅读');
    }
    if (activeAsks.has(id)) {
      return reply.code(409).send({
        error: API_ERROR_CODES.busy,
        message: '该会话正在回答中，请等这一轮结束后再试'
      });
    }
    activeAsks.add(id);
    try {
      // 2) 历史来自该会话已落库的消息（复用 prepareHistory 的裁剪口径），不要求客户端重传。
      const history = store.listCorpusSessionMessages(id).map((message) => ({
        role: message.role,
        content: message.content
      }));
      const userMessage = store.addCorpusSessionMessage({
        sessionId: id,
        role: 'user',
        content: question,
        metadata: {
          corpusSessionId: id,
          ...(selection ? { selection } : {})
        }
      });

      // 3) 复用既有跨文献阅读链路；范围、预算、规划都走与 /chat/ask corpus 相同的口径。
      let answer: ChatResponse | null = null;
      let failure = '';
      try {
        answer = await answerWithCorpus(
          store,
          secrets,
          config,
          question,
          selection,
          documents.map((document) => document.id),
          readingBatchBudget(store),
          undefined,
          undefined,
          allowKnowledge,
          history,
          undefined,
          undefined,
          planQuestion(question, selection)
        );
      } catch (error) {
        // 取消要冒泡（由 server 的 AbortError 处理），其它失败如实落成一条失败消息。
        if (isAbortError(error)) throw error;
        failure = error instanceof Error ? error.message : '跨文献阅读失败';
      }
      if (failure || !answer || !answer.answer || !answer.answer.trim()) {
        const reason = failure || '跨文献阅读没有返回可用回答';
        store.addCorpusSessionMessage({
          sessionId: id,
          role: 'assistant',
          content: `${FAILED_ANSWER_PREFIX}${reason}`,
          metadata: { corpusSessionId: id, failed: true }
        });
        store.touchCorpusSession(id);
        return reply.code(502).send({
          error: API_ERROR_CODES.badGateway,
          message: reason,
          user_message_id: userMessage.id,
          skipped_document_ids: skippedDocumentIds
        });
      }

      // 4) 回答落库（同会话消息按 id 顺序）；跳过文献写进 notice 与元数据，便于复核。
      const answerText = answer.answer;
      const notice = [answer.notice, skippedDocumentsNotice(store, skippedDocumentIds)]
        .filter((part): part is string => Boolean(part && part.trim()))
        .join('；');
      const assistantMessage = store.addCorpusSessionMessage({
        sessionId: id,
        role: 'assistant',
        content: answerText,
        sources: answer.sources ?? [],
        metadata: {
          corpusSessionId: id,
          reading_scope: 'corpus',
          ...(answer.taskId ? { taskId: answer.taskId } : {}),
          ...(skippedDocumentIds.length > 0 ? { skipped_document_ids: skippedDocumentIds } : {})
        }
      });
      store.touchCorpusSession(id);
      return {
        ...answer,
        answer_mode: answer.answer_mode ?? 'reading',
        model_knowledge: allowKnowledge,
        ...(notice ? { notice } : {}),
        session_id: id,
        user_message_id: userMessage.id,
        assistant_message_id: assistantMessage.id,
        skipped_document_ids: skippedDocumentIds
      };
    } finally {
      activeAsks.delete(id);
    }
  });
}
