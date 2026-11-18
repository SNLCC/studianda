import type { FastifyInstance } from 'fastify';
import {
  API_ERROR_CODES,
  API_PREFIX,
  FAILED_ANSWER_PREFIX,
  type ChatAuditSummary,
  type ChatMessageRecord,
  type ChatResponse,
  type DocumentDetail
} from '@studianda/shared';
import { isAbortError, resolveReadingChatConfig } from '../chat.js';
import { auditSummaryFromResponse } from '../chat-audit-summary.js';
import { answerWithCorpus, readingBatchBudget } from '../reading-chat.js';
import { planQuestion } from '../planning.js';
import {
  corpusSessionView,
  defaultCorpusSessionTitle,
  normalizeCorpusSessionDocumentIds,
  skippedDocumentsNotice
} from '../corpus-sessions.js';
import { resolveProjectScope } from '../project-scope.js';
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
 * - 建立时支持 `projectId` 代替显式 `documentIds`：服务端解析成项目**当前**文献集合再固化快照，
 *   之后项目增删文献不影响已建会话（快照语义不变）；
 * - 消息复用 `messages`（document_id 空串哨兵 + session_id），服务端负责落 user/assistant；
 * - 追问直接复用 `answerWithCorpus()`：同一会话的后续问题按快照范围 + 已落库历史继续；
 * - 范围里已删除的文献**跳过并报告**（响应 skipped_document_ids + notice），不静默缩范围。
 *
 * 本版不接 UI；预算闸门也还没接到这条路由（见开发报告）。
 */
export function registerCorpusSessionRoutes(
  app: FastifyInstance,
  options: CorpusSessionRouteOptions
): void {
  const { store, secrets } = options;
  // 同一会话同时只允许一轮在飞：并发两轮会让 user/assistant 消息交错落库。
  const activeAsks = new Set<string>();

  /**
   * 续读任务校验结果：
   * - `live`：任务还在（本轮带 taskId 只补未读页）；
   * - `completed`：任务已不在库（已读完/文献被删除/过期），但本会话的回答记录过这个编号，
   *   按「无需续读」复用上一轮已保存的回答；
   * - `none`：本轮不是续读。
   */
  type ResumeResolution =
    | { kind: 'live'; taskId: string }
    | { kind: 'completed'; taskId: string; message: ChatMessageRecord }
    | { kind: 'none' };

  /** 阅读任务 payload 里续读校验需要的字段（完整形状由 reading-chat 维护，这里只读不写）。 */
  interface ResumeTaskPayload {
    kind?: string;
    documentIds?: string[];
  }

  /** 两个文献 id 集合是否相同（范围比较不看顺序，也不看重复）。 */
  const sameDocumentScope = (left: readonly string[], right: readonly string[]): boolean => {
    const leftSet = new Set(left);
    const rightSet = new Set(right);
    if (leftSet.size !== rightSet.size) return false;
    for (const id of leftSet) {
      if (!rightSet.has(id)) return false;
    }
    return true;
  };

  /**
   * 本会话里「返回过该 taskId」的最后一条 assistant 消息。
   *
   * 阅读任务表本身不带会话 id，所以「taskId 属于该会话」以「本会话落库的回答带过这个编号」
   * 为准：任务编号只可能由本会话自己的回答返回（persistAnswer 写 metadata.taskId），
   * 别的会话或 /chat/ask 跨文献入口产生的任务不会出现在这里。取最后一条，保证「全读完」
   * 后复用的是最新、最完整的那一轮回答。
   */
  const sessionTaskMessage = (sessionId: string, taskId: string): ChatMessageRecord | null => {
    const messages = store.listCorpusSessionMessages(sessionId);
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]!;
      if (message.role !== 'assistant') continue;
      if (message.metadata?.taskId === taskId) return message;
    }
    return null;
  };

  /**
   * 校验可选 taskId：必须由本会话产生，且**范围与会话快照一致**。
   *
   * 范围按建立会话时冻结的 `documentIds` 比较（不是按当前可读文献）：会话范围不可变，
   * 快照里文献被删除不该让已保存的续读进度失效；反过来，任务范围与快照不同（来自别的
   * 会话、或被改小/改大）时一律拒绝——把别的范围的任务接进来会把跨篇续读静默降级。
   *
   * 不匹配一律 400，并把「为什么不能续读」写进 message；只有「任务已读完/被删」但本会话
   * 确实返回过该编号时才走复用分支（那不是校验失败，是明确的「无需续读」行为）。
   */
  const resolveResumeTask = (
    sessionId: string,
    sessionDocumentIds: string[],
    requestedTaskId: string
  ): { resume?: ResumeResolution; error?: string } => {
    const saved = store.loadReadingTask<ResumeTaskPayload>(requestedTaskId);
    const recorded = sessionTaskMessage(sessionId, requestedTaskId);
    if (!saved) {
      if (!recorded) {
        return {
          error:
            'taskId 不存在，也不属于该会话：无法继续阅读（可能已读完或已过期，请重新提问）'
        };
      }
      return { resume: { kind: 'completed', taskId: requestedTaskId, message: recorded } };
    }
    const payload = saved.payload;
    if (payload?.kind !== 'corpus') {
      return {
        error: 'taskId 不是跨文献续读任务（单篇阅读任务不能用于跨文献会话续读）'
      };
    }
    const taskDocumentIds = Array.isArray(payload.documentIds) ? payload.documentIds : [];
    if (!sameDocumentScope(taskDocumentIds, sessionDocumentIds)) {
      return {
        error:
          'taskId 的文献范围与该会话快照不一致，不能继续阅读；请重新提问或新建会话'
      };
    }
    if (!recorded) {
      return {
        error: 'taskId 不属于该会话（该任务的回答不是本会话产生的），不能用于续读'
      };
    }
    return { resume: { kind: 'live', taskId: requestedTaskId } };
  };

  /**
   * 「已全部读完/任务已过期」时复用上一轮已保存的回答。
   *
   * 不重新调用模型、不改范围、不重读原文：正文与来源原样来自被复用的那条 assistant 消息，
   * 审计摘要由 persistAnswer 从该消息复制（复制而非重算），响应里也会带回去。
   */
  const reusedCompletedResponse = (taskId: string, message: ChatMessageRecord): ChatResponse => ({
    answer: message.content,
    sources: message.sources ?? [],
    taskId,
    reused_answer: true,
    notice:
      '这次「继续阅读」的进度已不存在（可能已读完、文献被删除或已过期），本轮没有重新阅读；' +
      '下面是上一轮已保存的回答。'
  });

  /**
   * 复用答案时继承原消息的审计摘要。
   *
   * `reused_answer` 表示本轮没有重新调用模型、正文原样来自上一轮已保存的回答
   * （`answerWithCorpus()` 的复用分支），所以响应里没有 audit。复用答案的审计结论**等于
   * 原答案的审计结论**：按正文回找被复用的那条 assistant 消息，把它的 `audit_summary`
   * 原样复制过来——不重算、不补 0。原消息没有摘要（旧数据/失败占位）时保持 NULL。
   */
  const reusedAnswerAuditSummary = (
    sessionId: string,
    answerText: string
  ): ChatAuditSummary | null => {
    const messages = store.listCorpusSessionMessages(sessionId);
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]!;
      if (message.role !== 'assistant' || message.content !== answerText) continue;
      return message.auditSummary ?? null;
    }
    return null;
  };

  /**
   * 组装并落库本轮回答。
   *
   * JSON 模式与 SSE 模式共用这一个函数：SSE 的 `result` 事件就是它返回的对象，
   * 所以两种形态的响应结构完全一致（JSON 是这一对象直接序列化，SSE 是同一对象装进事件）。
   */
  const persistAnswer = (
    sessionId: string,
    userMessageId: number,
    answer: ChatResponse,
    allowKnowledge: boolean,
    skippedDocumentIds: string[]
  ) => {
    const answerText = answer.answer ?? '';
    const notice = [answer.notice, skippedDocumentsNotice(store, skippedDocumentIds)]
      .filter((part): part is string => Boolean(part && part.trim()))
      .join('；');
    // 正常回答从响应压摘要；复用答案（没有重新调用模型）则复制原消息的摘要。
    const auditSummary =
      auditSummaryFromResponse(answer) ??
      (answer.reused_answer ? reusedAnswerAuditSummary(sessionId, answerText) : null);
    const assistantMessage = store.addCorpusSessionMessage({
      sessionId,
      role: 'assistant',
      content: answerText,
      sources: answer.sources ?? [],
      // 审计结果压成摘要落库：重开会话后「缺证 / 原文已变更 / 越界引用」仍可展示，
      // 只存计数与选区状态，不存正文/原文/完整 ChatResponse（避免库膨胀与重复存储）。
      auditSummary,
      metadata: {
        corpusSessionId: sessionId,
        reading_scope: 'corpus',
        ...(answer.taskId ? { taskId: answer.taskId } : {}),
        ...(skippedDocumentIds.length > 0 ? { skipped_document_ids: skippedDocumentIds } : {})
      }
    });
    store.touchCorpusSession(sessionId);
    return {
      ...answer,
      // 审计摘要同时进响应：复用答案（没有重新调用模型）时它是从原消息复制的结论，
      // 正常回答时是从本轮 audit 压出的计数；两者都不该只落库、不返回给调用方。
      ...(auditSummary ? { audit_summary: auditSummary } : {}),
      answer_mode: answer.answer_mode ?? 'reading',
      model_knowledge: allowKnowledge,
      ...(notice ? { notice } : {}),
      session_id: sessionId,
      user_message_id: userMessageId,
      assistant_message_id: assistantMessage.id,
      skipped_document_ids: skippedDocumentIds
    };
  };

  /** 失败也如实落成一条失败消息（JSON 与 SSE 共用，口径与改造前一致）。 */
  const recordFailure = (sessionId: string, reason: string): void => {
    store.addCorpusSessionMessage({
      sessionId,
      role: 'assistant',
      content: `${FAILED_ANSWER_PREFIX}${reason}`,
      metadata: { corpusSessionId: sessionId, failed: true }
    });
    store.touchCorpusSession(sessionId);
  };

  app.post(`${API_PREFIX}/corpus-sessions`, async (request, reply) => {
    const body = (request.body ?? {}) as {
      documentIds?: unknown;
      projectId?: unknown;
      title?: unknown;
    };
    // 范围来源二选一：显式 documentIds，或用 projectId 代替（服务端解析成项目当前文献集合）。
    // 两者同时给是调用方歧义，明确 400；项目不存在 404；项目为空 400（建会话至少要一篇文献）。
    const rawProjectId = body.projectId;
    const projectId = typeof rawProjectId === 'string' ? rawProjectId.trim() : '';
    if (rawProjectId !== undefined && !projectId) {
      return badRequest(reply, 'projectId 必须是非空字符串');
    }
    let documentIds = normalizeCorpusSessionDocumentIds(body.documentIds);
    if (projectId) {
      if (documentIds.length > 0) {
        return badRequest(
          reply,
          'projectId 与 documentIds 不能同时给：请二选一（用项目范围时不要显式传文献列表）'
        );
      }
      const projectScope = resolveProjectScope(store, projectId);
      if (projectScope === null) return notFound(reply, '项目不存在');
      if (projectScope.length === 0) {
        return badRequest(reply, '项目里没有可用于跨文献会话的文献');
      }
      documentIds = projectScope;
    } else if (documentIds.length === 0) {
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

  /**
   * 追问：默认一次性 JSON；`Accept: text/event-stream` 时改为 SSE。
   *
   * 为什么用 Accept 而不是新增 path/query：method + path 与改造前完全一致（契约不变），
   * 旧客户端不带该头（fetch 默认 `* / *`）继续走原来的 JSON 分支，行为零变化；本仓库的
   * SSE 客户端都是 `fetch`（不是 EventSource），可以自定义请求头，因此不需要 query token
   * 或 `?stream=1` 开关。
   *
   * SSE 只允许四类事件：`stage`（阶段文字）、`progress`（{done,total,unit}）、`error`
   * （失败原因）、`result`（**审计完成后**的完整响应，结构与 JSON 完全一致）。
   * 任何阶段都不下发正文增量：精读回答要经过逐字核验/缺证替换/页码裁剪，未审计的正文
   * 一旦发出就收不回。
   */
  app.post(`${API_PREFIX}/corpus-sessions/:id/ask`, async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = store.getCorpusSession(id);
    if (!session) return notFound(reply, '跨文献会话不存在');
    const body = (request.body ?? {}) as {
      question?: unknown;
      selection?: unknown;
      source_policy?: unknown;
      taskId?: unknown;
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

    // 2) 可选续读编号：必须由本会话产生、范围与会话快照一致；不匹配 400 且不落任何消息。
    //    校验放在写 user 消息之前，避免一次非法续读在会话里留下半条记录。
    const requestedTaskId = typeof body.taskId === 'string' ? body.taskId.trim() : '';
    let resume: ResumeResolution = { kind: 'none' };
    if (requestedTaskId) {
      const resolved = resolveResumeTask(id, session.documentIds, requestedTaskId);
      if (resolved.error) return badRequest(reply, resolved.error);
      resume = resolved.resume ?? { kind: 'none' };
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
      // 3) 历史来自该会话已落库的消息（复用 prepareHistory 的裁剪口径），不要求客户端重传。
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
      const plan = planQuestion(question, selection);

      // 兼容分支：不带 Accept 的调用方仍拿一次性 JSON（旧客户端/旧脚本不变）。
      if (!String(request.headers.accept ?? '').includes('text/event-stream')) {
        // 「全读完/任务已过期」：不调用模型，直接复用上一轮已保存的完整回答（审计摘要一并复制）。
        if (resume.kind === 'completed') {
          return persistAnswer(
            id,
            userMessage.id,
            reusedCompletedResponse(resume.taskId, resume.message),
            allowKnowledge,
            skippedDocumentIds
          );
        }
        // 4) 复用既有跨文献阅读链路；范围、预算、规划都走与 /chat/ask corpus 相同的口径。
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
            // 续读：只补未读页；任务由 answerWithCorpus 按需保留/销掉。
            resume.kind === 'live' ? resume.taskId : undefined,
            plan
          );
        } catch (error) {
          // 取消要冒泡（由 server 的 AbortError 处理），其它失败如实落成一条失败消息。
          if (isAbortError(error)) throw error;
          failure = error instanceof Error ? error.message : '跨文献阅读失败';
        }
        if (failure || !answer || !answer.answer || !answer.answer.trim()) {
          const reason = failure || '跨文献阅读没有返回可用回答';
          recordFailure(id, reason);
          return reply.code(502).send({
            error: API_ERROR_CODES.badGateway,
            message: reason,
            user_message_id: userMessage.id,
            skipped_document_ids: skippedDocumentIds
          });
        }
        // 4) 回答落库（同会话消息按 id 顺序）；跳过文献写进 notice 与元数据，便于复核。
        return persistAnswer(id, userMessage.id, answer, allowKnowledge, skippedDocumentIds);
      }

      // SSE 分支：复用与 /chat/ask/stream 同一套写法（hijack → 事件 → close/aborted 取消）。
      // 注意：上面的参数校验/404/409/400 仍返回普通 JSON（带正确状态码），只有进入回答阶段才开流。
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
      // 用响应流的 close/aborted 判断真正的取消（客户端中途断开）。
      raw.once('close', abort);
      request.raw.once('aborted', abort);
      try {
        // 「全读完/任务已过期」：不调用模型，照样只走 result 事件（事件类型不变），
        // 复用上一轮已保存的完整回答（审计摘要一并复制回去）。
        if (resume.kind === 'completed') {
          send(
            'result',
            persistAnswer(
              id,
              userMessage.id,
              reusedCompletedResponse(resume.taskId, resume.message),
              allowKnowledge,
              skippedDocumentIds
            )
          );
          return;
        }
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
            controller.signal,
            undefined,
            allowKnowledge,
            history,
            // 进度只报批次数（unit=批）；正文不在任何阶段下发。
            (done, total) => send('progress', { done, total, unit: '批' }),
            // 续读：只补未读页；任务由 answerWithCorpus 按需保留/销掉。
            resume.kind === 'live' ? resume.taskId : undefined,
            plan,
            '',
            // 阶段点由 answerWithCorpus 提供：准备范围 / 读第几篇 / 综合 / 核对论断。
            (text) => send('stage', { text })
          );
        } catch (error) {
          // 客户端断开：冒泡到外层按「连接已没了」安静收尾，不写事件、不记失败消息。
          if (isAbortError(error)) throw error;
          failure = error instanceof Error ? error.message : '跨文献阅读失败';
        }
        if (failure || !answer || !answer.answer || !answer.answer.trim()) {
          const reason = failure || '跨文献阅读没有返回可用回答';
          recordFailure(id, reason);
          // 失败只发 error，绝不发 result（没有可用回答，也没有可审计的正文）。
          send('error', { message: reason });
          return;
        }
        // 到这里正文已通过审计/逐字核验/页码裁剪：一次性下发完整响应，绝不提前流正文。
        send('result', persistAnswer(id, userMessage.id, answer, allowKnowledge, skippedDocumentIds));
      } catch (error) {
        // 取消（客户端断开）：写不出去也不需要写；其它失败只发 error。
        if (isAbortError(error)) return;
        send('error', { message: error instanceof Error ? error.message : '跨文献阅读失败' });
      } finally {
        request.raw.off('aborted', abort);
        raw.off('close', abort);
        raw.end();
      }
    } finally {
      activeAsks.delete(id);
    }
  });
}
