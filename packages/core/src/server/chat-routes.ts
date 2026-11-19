import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  API_ERROR_CODES,
  API_PREFIX,
  type ChatRequest,
  type ChatResponse
} from '@studianda/shared';
import { answerQuestion } from '../chat.js';
import type { ChatBudgetPolicy } from '../chat-budget-policy.js';
import { resolveProjectScope } from '../project-scope.js';
import type { SecretStore } from '../secrets.js';
import type { Store } from '../store.js';
import { ChatTurnRegistry, chatTurnKeyOf } from './chat-turn-registry.js';
import type { DocumentRequestRegistry } from './document-request-registry.js';
import { badRequest, notFound } from './http.js';

/**
 * 问答路由（2 条）：`POST /chat/ask/stream`（SSE）与 `POST /chat/ask`（纯 JSON），
 * 从 `server.ts` 抽出（Step 7）。**本文件是逐字搬移，不要"顺手统一"写法**：
 * 两个 handler 的校验顺序、409 文案、字段透传、SSE 生命周期都是协议细节，
 * 回归见 `test/chat-stream-sse.test.ts`、`document-chat.test.ts`、`chat-http-abort.test.ts`。
 *
 * 依赖注入（由 `buildServer` 创建，每 server 实例一份，**不要做成模块级单例**）：
 * - `chatTurns`：单文献轮次互斥表（与 messages 写路由共用同一把锁）；
 * - `documentRequests`：文档级在途请求登记表（purge / 清空数据时 abort）；
 * - `budget`：无状态预算策略（闸门估算失败返回 null，不阻断提问），每次调用重读设置。
 *
 * 必须保持的行为（逐条对应设计文档 §5 Step 7 与 §6 R10）：
 * 1. 校验顺序：question/audio → documentId 必填（独立会话已移除的文案）→
 *    `applyChatProjectScope` → `budgetGate` → `needs_confirmation` → `chatTurns.begin`；
 * 2. 409 文案是「该文献正在回答中，请等这一轮结束后再试」（与 messages 写路由的
 *    「该会话/文献…」文案**不同**，不要统一）；
 * 3. `confirmSearch`/`confirm_gap_search`/`search_token`/`history`/`reading_scope`/
 *    `reading_chapter_index`/`chat_session_id`/`scope_tags`/`voice_original`/`web_query`/
 *    `audio` 等字段照旧透传；
 *    `chat_session_id` 用于服务端读会话完整历史/摘要压缩/审计继承（审计 §2.5 已补通）；
 *    `reading_chapter_index` 让预算闸门与真实阅读按同一章（闸门读 `body`，见下）；
 * 4. stream：hijack + `text/event-stream`，5 种事件 `progress/stage/audit/result/error`，
 *    `close`/`aborted` 监听在 finally 注销；断连 → AbortError 时发 `error{status:499}` 并
 *    `raw.end()`；非流式回 499 + `cancelled`。预算确认分支回 200 纯 JSON、**不 hijack**。
 *
 * 事件里 `progress`/`stage`/`audit` 由 `answerQuestion` 的回调驱动；草稿通道已停用，
 * 两个形参位保留占位（`undefined, undefined`）。
 */
export interface ChatRouteOptions {
  store: Store;
  secrets: SecretStore;
  /** 轮次互斥表：与 messages 写路由共用；registry 只回答 boolean，409 归路由层。 */
  chatTurns: ChatTurnRegistry;
  /** 在途请求登记表：purge / 清空数据前 abort 的唯一通道。 */
  documentRequests: DocumentRequestRegistry;
  /** 预算策略（无状态）：闸门估算失败吞错返回 null（不阻断提问）。 */
  budget: ChatBudgetPolicy;
}

/**
 * 注册 `/chat/ask` 与 `/chat/ask/stream`。
 *
 * 调用方（`buildServer`）必须保持注册相对位置：`/chat/budget` 之后、
 * `registerSettingsUpdateRoutes` 之前（注册顺序不是功能约束，但保持零成本、避免排查噪声）。
 * 直接挂在根实例上（不要改成 `app.register()` 子插件：钩子/错误处理器继承是另一套语义）。
 */
export function registerChatRoutes(app: FastifyInstance, options: ChatRouteOptions): void {
  // 与 `server.ts` 里的局部变量同名，保证搬移的 handler 逐字不变（仅来源从闭包换成注入）。
  const { chatTurns, documentRequests, budget } = options;

  /**
   * 预算闸门薄封装：实现见 chat-budget-policy.ts 的 `gate`（估算失败吞错返回 null）。
   * 调用点顺序必须保持：scope（applyChatProjectScope）→ gate → needs_confirmation → beginTurn；
   * 把闸门挪进轮次锁内会让"并发 + 超预算"的响应从 needs_confirmation 变成 409。
   *
   * 已知微窗口（设计文档 §6 R7 的入口侧变体，实测判为**数据无害**）：
   * 本函数是异步的，之后才 `chatTurns.begin` + `documentRequests.track`。闸门与 track 之间
   * 本身是同步代码（单线程不会被其它请求插进来），但闸门内部可能 await 章节结构 I/O；
   * 若 purge 恰在这段时间里完成，本请求尚未登记、收不到 abort，会继续为已删文献走到
   * `answerQuestion`。实测（`test/chat-budget-window.test.ts`）：`answerWithReading` 入口
   * 复查 `store.getDocument` 为 null → 响应 200 + `answer:null`（notice「完整阅读没有返回结果」），
   * purge 之后不写 messages / reading_tasks / checkpoints / 选区快照，轮次锁与登记表照常清理；
   * 唯一代价是复查前已发出的一次 QUESTION_ROUTE 路由模型调用。**因此不在这里加 track 前复查**：
   * 复查只多一次同步 DB 读、消不掉那次路由调用；把 track 前移到闸门前则会把
   * `needs_confirmation` 分支也纳入在途登记、改变其语义。
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
   *
   * 命名/互斥字段与 `/chat/budget` 的内联版本**故意不同**（设计文档 §7 第 2 条，已核实）：
   * 本函数只认 `ChatRequest` 声明的 snake_case（`scope_documents`/`scope_tags`），camelCase
   * `scopeDocuments` 不在 ask 契约里、按未知字段忽略；`/chat/budget` 侧收 camel 是它自带的
   * 旧命名兼容（见 chat-budget-policy.ts 的 `scopeDocumentIds`），400 文案也因此写 camelCase。
   * 现状不可由客户端触发：界面 `projectScopeAskPayload` 保证项目/文献/标签三选一且 ask 只发
   * snake_case，所以这里和 `/chat/budget` 的差异不会让同一个真实请求一边 400 一边通过。
   * **不要顺手统一**：让 ask 接受 camel 会把"显式文献范围"静默改成项目范围（或反过来），
   * 是行为变更而不是文案整理；真要统一得先改契约与产品口径。
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
  // 调 chatTurns.begin（文案不同）；危险写操作（重新生成/编辑并重问/分支删除）的薄封装
  // 与 3 条 messages 写路由同在 server/chat-message-routes.ts（通过 options.chatTurns 注入）。

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
          // 阅读伙伴会话 id：服务端据此读该会话完整消息（超预算压缩摘要、续读审计继承）。
          // 不传时 `answerQuestion` 的旧路径完全不变（只使用客户端 history）。
          chat_session_id:
            typeof body.chat_session_id === 'string' ? body.chat_session_id : undefined,
          // 用户显式选的章：预算闸门直接读 `body`（见 budgetGate），这里同步给实际阅读，
          // 保证"按第几章估算"与"按第几章读"是同一章。
          reading_chapter_index:
            typeof body.reading_chapter_index === 'number' &&
            Number.isInteger(body.reading_chapter_index) &&
            body.reading_chapter_index >= 1
              ? body.reading_chapter_index
              : undefined,
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
          // 阅读伙伴会话 id：与 stream 同口径，服务端读该会话完整消息并继承摘要。
          chat_session_id:
            typeof body.chat_session_id === 'string' ? body.chat_session_id : undefined,
          // 用户显式选的章：预算闸门读 `body`，这里同步给实际阅读，两者按同一章。
          reading_chapter_index:
            typeof body.reading_chapter_index === 'number' &&
            Number.isInteger(body.reading_chapter_index) &&
            body.reading_chapter_index >= 1
              ? body.reading_chapter_index
              : undefined,
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
}
