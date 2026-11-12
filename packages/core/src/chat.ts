import type {
  ChatRequest,
  ChatResponse,
  ChatSource,
  DocumentBlocks,
  DocumentSectionIndex,
  QaSessionRecord,
  SearchHit,
  SearchResult
} from '@studianda/shared';
import type { SecretStore } from './secrets.js';
import type { Store } from './store.js';
import { retrieve } from './retrieval.js';
import { routeQuestion, type QuestionRoute } from './question-route.js';
import { planQuestion, withDefaultDimensions } from './planning.js';
import {
  answerWithCorpus,
  answerWithReading,
  callChatModel,
  chatInputLimit,
  prepareHistory,
  type HistoryMessage
} from './reading-chat.js';
import { collectModelUsage } from './model-usage.js';
import { resolveModelCapacity, resolveModelService, resolveOmniService } from './model-services.js';
import { prepareReadingSessionContext } from './reading-session-context.js';
import {
  consumeSearchPlan,
  getSearchConfig,
  searchWeb,
  searchWebQueries
} from './web-search.js';
import type { SourceKind } from './routing.js';
import { listing } from './source-tier.js';
import { extractKeywords } from './keywords.js';
import { documentMentions, type DocumentMentionGuard } from './mentions.js';
import { chapterRecord, resolveChapterReading } from './chapters.js';
import {
  auditAnswer,
  type AuditOriginal,
  type AuditReport,
  type ClaimRoute
} from './audit.js';
import { autoSourceQueries, mergeWebReviews, whyNotOnline } from './web-support.js';
import {
  searchMemory,
  memoryMaterial,
  memoryChatSources,
  MEMORY_RULES,
  type MemoryHit
} from './memory-sources.js';
import { citationSupport, invalidCitations } from './citations.js';
import { locateSectionContext } from './section-context.js';
import {
  prepareQaConversation,
  qaHistoryPairsFromSession,
  retrievalQueryForConversation,
  staleCitationBlock
} from './qa-context.js';
import { inputCost, messages as budgetMessages } from './request-budget.js';

interface ChatConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  taskThinking?: boolean;
  /** 证据审计输出模式（见 ReadingChatConfig.auditRewrite）：默认 rewrite（确定性按证据改写）。 */
  auditRewrite?: 'annotate' | 'rewrite';
}

function getConfig(store: Store, secrets: SecretStore): ChatConfig | null {
  const routed = resolveModelService(store, secrets, 'chat');
  if (routed) {
    // 平台元数据里的 task_thinking 只通过模型服务路由生效。
    const capacity = resolveModelCapacity(store, 'chat');
    return {
      baseUrl: routed.baseUrl,
      apiKey: routed.apiKey,
      model: routed.model,
      ...(capacity?.taskThinking !== undefined
        ? { taskThinking: capacity.taskThinking }
        : {}),
      auditRewrite: store.getSettings()['audit.rewrite_mode'] === 'annotate' ? 'annotate' : 'rewrite'
    };
  }
  // 环境变量覆盖：只给无界面运行与调试用。
  const baseUrl = process.env.STUDIANDA_MODEL_BASE_URL?.trim();
  const model = process.env.STUDIANDA_MODEL_NAME?.trim();
  if (!baseUrl || !model) return null;
  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    apiKey: process.env.STUDIANDA_MODEL_API_KEY?.trim() ?? '',
    model,
    auditRewrite: store.getSettings()['audit.rewrite_mode'] === 'annotate' ? 'annotate' : 'rewrite'
  };
}

function trimText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}…`;
}

/**
 * 仅联网回答的结构化来源：与阅读链路里的 web 来源字段一致，让 [Wn]/[n] 引用与来源列表
 * 都能点开具体网页。
 */
function webSourcesOf(results: readonly SearchResult[]): ChatSource[] {
  return results.map((item) => ({
    documentId: `web:${item.url}`,
    documentName: item.title,
    page: 1,
    snippet: item.snippet,
    quotes: [],
    url: item.url,
    kind: 'web' as const,
    ...(item.tier ? { tier: item.tier } : {}),
    ...(item.tierLabel ? { tierLabel: item.tierLabel } : {})
  }));
}

/** 把修订回答里的 [W1]/[W 1]/[w1] 换成审计需要的数字编号（Web 来源从 base+1 起）。 */
function remapWebCitations(answer: string, base: number): string {
  return answer.replace(/\[\s*[Ww]\s*(\d{1,2})\s*\]/g, (_match, number: string) => {
    return `[${base + Number(number)}]`;
  });
}

/** 审计报告里指向 Web 来源的证据：补回 [Wn] 语义（数字来源号 + 可读标签），供界面展示。 */
function mapWebReviewCitations(report: AuditReport, base: number): AuditReport {
  const claims = report.claims.map((claim) => ({
    ...claim,
    evidence: (claim.evidence ?? []).map((evidence) => {
      if (evidence.source <= base) return evidence;
      return {
        ...evidence,
        source_type: 'web',
        citation: `[W${evidence.source - base}]`
      } as typeof evidence & { citation: string };
    })
  }));
  return { ...report, claims, web_source_offset: base } as AuditReport & {
    web_source_offset: number;
  };
}

/** 可见行数（非空行），用于两轮审计合并时的 claim 编号平移。 */
function visibleLineCount(text: string): number {
  return text.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
}

/**
 * 核对没命中时给用户的说明：
 * 三种情形必须分开说——本机压根没有可查文字 / 问题里提不出可核对的术语 / 核对过了没找到。
 * 只说一句「请开启知识补充」会让用户以为系统根本没看文献。
 */
function routeNoteForMissedGuard(guard: DocumentMentionGuard | null): string | undefined {
  if (!guard) return undefined;
  if (!guard.hasText) {
    return '这篇文献目前没有任何可检索的文字（可能是扫描件且尚未识别），因此无法核对问题术语；'
      + '如果你认为答案就在文献里，请先选择「读全篇」或对本机扫描页做 OCR 后重试。';
  }
  if (guard.terms.length === 0) {
    return '本轮问题里没有可用于核对文献内容的术语，未读取文献。';
  }
  return `已用「${guard.terms.slice(0, 3).join('、')}」在本篇文献中核对，没有找到相关表述，因此未读取文献。`;
}

/**
 * 解析全模态语音回复：约定模型返回 JSON {"transcript":"逐字转写","answer":"回答"}。
 *
 * 模型不一定听话（返回 Markdown 代码块 / 前后夹解释 / 只给纯文字回答）：尽量从中找出
 * transcript+answer 合法 JSON；找不到时返回 null，调用方退回「整段文字当回答、无转写」，
 * 不能因为解析失败让整轮语音提问失败。
 */
function parseOmniAudioReply(raw: string): { transcript: string; answer: string } | null {
  const text = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  if (!text) return null;
  const candidates = [text];
  const brace = /\{[\s\S]*\}/.exec(text);
  if (brace && brace[0] !== text) candidates.push(brace[0]);
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as { transcript?: unknown; answer?: unknown } | null;
      if (!parsed || typeof parsed !== 'object') continue;
      const answer = typeof parsed.answer === 'string' ? parsed.answer.trim() : '';
      if (!answer) continue;
      const transcript =
        typeof parsed.transcript === 'string' ? parsed.transcript.trim() : '';
      return { transcript, answer };
    } catch {
      // 尝试下一个候选（例如去掉 Markdown 代码块后的整段 JSON）
    }
  }
  return null;
}

async function answerQuestionInner(
  store: Store,
  secrets: SecretStore,
  input: ChatRequest,
  signal?: AbortSignal,
  onProgress?: (done: number, total: number) => void,
  onDraft?: (text: string) => void,
  onDraftReset?: () => void,
  onStage?: (text: string) => void,
  onAudit?: (claims: unknown[]) => void
): Promise<ChatResponse> {
  // 笔记/批注是否纳入本轮问答。提前返回的路径（直接回复/联网/语音/任务过期）也要如实说明
  // 「未使用笔记与批注」，不能因为没走到材料拼装就假装纳入过。
  const includeMemory = input.include_memory === true;
  const memoryUnused = (reason: string): Pick<ChatResponse, 'memory_notice'> =>
    includeMemory ? { memory_notice: `本轮${reason}，未使用笔记与批注。` } : {};
  if (input.audio?.data) {
    // 全模态模型优先；未单独分配时回退到支持音频的会话模型。
    const config = resolveOmniService(store, secrets) ?? getConfig(store, secrets);
    if (!config) {
      return {
        answer: null,
        sources: [],
        ...memoryUnused('没有可用的语音模型'),
        notice: '尚未配置支持音频的全模态模型，无法直接识别语音。'
      };
    }
    // 输入音频必须是「裸 base64」：OpenAI 兼容/全模态接口的 input_audio.data 不接受
    // `data:audio/x;base64,` 前缀（带上会被判 400）。客户端仍可能传 data URL，
    // 这里统一去掉前缀，保证请求体合法。
    const audioData = input.audio.data.replace(/^data:[^,]*,/, '').trim();
    // format 由 mimeType 推导（wav 优先）：多数全模态模型只稳定支持 wav/mp3，
    // 之前的实现把所有非 wav 都写成 webm，遇到 mp3/ogg/m4a 会直接 400。
    const audioMime = String(input.audio.mimeType ?? '').toLowerCase();
    const format = audioMime.includes('wav')
      ? 'wav'
      : audioMime.includes('mpeg') || audioMime.includes('mp3')
        ? 'mp3'
        : audioMime.includes('ogg') || audioMime.includes('opus')
          ? 'ogg'
          : audioMime.includes('m4a') || audioMime.includes('mp4') || audioMime.includes('aac')
            ? 'm4a'
            : 'webm';
    // 语音直问由全模态模型自己转写：不再要求客户端先用 ASR。同一请求若带文字
    // （旧客户端/文字+语音混合）仍作为 text part 一起发送，模型可以对照。
    const audioTranscript = (input.question ?? '').trim() || (input.voice_original ?? '').trim();
    const audioSystem =
      '你是全模态文献助手。请先逐字转写用户语音的内容，再据此回答：' +
      '如果语音是在提问，就回答；如果语音是选中文字/指令，就按语音要求处理。' +
      '不要假装听到了不存在的内容。' +
      '只返回一个 JSON 对象 {"transcript":"逐字转写","answer":"回答"}，' +
      '不要输出其它文字、解释或 Markdown 代码块。';
    // 独立问答的多会话：语音提问也要能看到本会话更早的文字轮次，否则口头追问同样会丢指代。
    const audioSession =
      !input.documentId && typeof input.qa_session_id === 'string' && input.qa_session_id.trim()
        ? store.getQaSession(input.qa_session_id)
        : null;
    let audioPrior: HistoryMessage[] = [];
    let audioDropped = 0;
    if (audioSession) {
      const prepared = prepareHistory(
        // 本轮转写（audioTranscript）要一起传进来：服务端已把带「（语音）」前缀的本轮消息落库，
        // 不排除掉它会把同一句口头提问在历史里再发一遍。
        qaHistoryPairsFromSession(store, audioSession, audioTranscript),
        Math.max(
          0,
          chatInputLimit(store) -
            inputCost(budgetMessages(audioSystem, '语音输入')) -
            // 音频/source 与协议开销留足余量，避免把文字历史挤到超过输入预算。
            8192
        )
      );
      audioPrior = prepared.prior;
      audioDropped = prepared.dropped;
    }
    const requestMessages: Array<{ role: string; content: unknown }> = [
      {
        role: 'system',
        content: audioSystem + (audioPrior.length > 0 ? staleCitationBlock(true, false) : '')
      },
      ...audioPrior,
      {
        role: 'user',
        content: [
          ...(audioTranscript ? [{ type: 'text', text: audioTranscript }] : []),
          {
            type: 'input_audio',
            input_audio: {
              data: audioData,
              format
            }
          }
        ]
      }
    ];
    const response = await fetch(`${config.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.apiKey}`
      },
      body: JSON.stringify({
        model: config.model,
        temperature: 0.2,
        messages: requestMessages
      }),
      signal: signal ?? AbortSignal.timeout(120_000)
    });
    if (!response.ok) {
      // 错误信息带上 provider 响应体摘要：HTTP 400 常见原因是音频格式/字段不符合该平台，
      // 没有响应体用户（和日志）都无法判断到底是哪一种。
      let detail = '';
      try {
        detail = (await response.text()).replace(/\s+/g, ' ').trim().slice(0, 300);
      } catch {
        // 响应体读不到时只报状态码。
      }
      throw new Error(
        `全模态模型返回 HTTP ${response.status}${detail ? `：${detail}` : ''}`
      );
    }
    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: unknown } }>;
    };
    const rawAnswer = payload.choices?.[0]?.message?.content;
    if (typeof rawAnswer !== 'string' || !rawAnswer.trim()) {
      throw new Error('全模态模型没有返回文字回答');
    }
    // 约定模型返回 {"transcript":"逐字转写","answer":"回答"}。解析成功时把逐字转写作为
    // 可选字段回传（界面显示/持久化用）；模型没按格式返回时整段文字当回答、转写留空，
    // 不能因为解析失败让整轮语音提问失败。
    const parsedReply = parseOmniAudioReply(rawAnswer);
    const answerText = parsedReply?.answer ?? rawAnswer.trim();
    const modelTranscript = parsedReply?.transcript ?? '';
    const audioNoticeParts = [
      modelTranscript
        ? '本轮录音由全模态模型直接理解并给出逐字转写；转写文字会写入会话的用户消息。'
        : '本轮录音由全模态模型直接理解；模型没有返回可用的逐字转写，用户消息保留为语音占位。'
    ];
    if (audioPrior.length > 0) {
      audioNoticeParts.push('本轮语音提问已带入本会话更早轮次的文字记录作为上下文。');
    }
    if (audioDropped > 0) {
      audioNoticeParts.push(
        `会话文字历史超出输入预算，为容量省略了 ${audioDropped} 轮（从最旧开始）。`
      );
    }
    return {
      answer: answerText,
      sources: [],
      ...(modelTranscript ? { audio_transcript: modelTranscript } : {}),
      ...memoryUnused('为语音直接回答'),
      ...(audioSession
        ? {
            qa_context: {
              messages: audioSession.messageCount,
              summary_used: false,
              compacted: 0,
              dropped: audioDropped
            }
          }
        : {}),
      notice: audioNoticeParts.join('；')
    };
  }
  // 继续阅读：跨文献任务必须还原「多篇一起读」的范围。否则带着 taskId 重发会被当成
  // 单篇任务（当前文献），把跨文献阅读静默降级成只读一篇——用户看到的就是"继续阅读越读越少"。
  const resumeTask = input.taskId
    ? store.loadReadingTask<{
        kind?: string;
        question?: string;
        selection?: string;
        documentIds?: string[];
      }>(input.taskId)
    : null;
  if (input.taskId && !resumeTask) {
    // 任务已被读完删除（或超过保留期）：不能把"继续阅读"静默当成一次新的单篇阅读——
    // 那会用当前文献重读一遍、还可能因输出上限报错（真实 E2E 踩到）。
    return {
      answer: null,
      sources: [],
      ...memoryUnused('没有重新阅读'),
      notice: '这次「继续阅读」的进度已不存在（可能已读完或已过期），本轮没有重新读文献；请重新提问。'
    };
  }
  const corpusResume =
    resumeTask?.payload?.kind === 'corpus' &&
    Array.isArray(resumeTask.payload.documentIds) &&
    resumeTask.payload.documentIds.length > 0
      ? resumeTask.payload
      : null;
  const question = (corpusResume?.question ?? input.question)?.trim();
  if (!question) throw new Error('问题不能为空');
  const selection = input.selection?.trim() || (corpusResume?.selection ?? '');
  // 独立问答的多会话：历史由服务端按会话保存，这里不再只取客户端传来的「最近 N 轮」。
  // 库内检索路径随后会按输入预算把早期轮次压缩成摘要（见 qa-context.ts）；其它回答方式
  // （联网/跨文献精读/直接回复）沿用各自的既有容量规则使用这份完整历史。
  const qaSession: QaSessionRecord | null =
    !input.documentId && typeof input.qa_session_id === 'string' && input.qa_session_id.trim()
      ? store.getQaSession(input.qa_session_id)
      : null;
  if (qaSession) {
    input.history = qaHistoryPairsFromSession(store, qaSession, question);
  }
  // 追问检索：短问题/含指代的问题把最近两轮问答拼进**检索查询**（只用于定位命中位置，
  // 不当作证据）。独立问答与会话历史都走这里；阅读页仍按原来的「最近 N 轮」历史，只是
  // 检索/规划阶段也能看到指代对象。
  const retrievalQuestion = retrievalQueryForConversation(
    question,
    Array.isArray(input.history) ? input.history : []
  );
  // 续读不再重跑问题路由：范围与问题都在任务里，再问一次模型只会多一次调用，还可能改范围。
  const route: QuestionRoute = corpusResume
    ? {
        document: true,
        search: false,
        reason: '继续阅读：恢复上次未读的页',
        reply: '',
        modelPlan: false,
        plan: null
      }
    : await routeQuestion(store, secrets, { ...input, question, selection });
  onStage?.('正在判断阅读范围');
  const plan = route.plan ? withDefaultDimensions(route.plan) : undefined;
  // 路由兜底说明：只在“模型判成与文献无关”这一支路上产生，不改变回答本身。
  let routeNote: string | undefined;
  // 术语核对把「闲聊」翻回「读文献」时，本轮不再走「只给联网搜索结果」的近路：
  // 问题里的词既然出现在这篇文献里，先读文献才是这个兜底要保证的事。
  let forcedByDocumentTerms = false;

  if (!route.document && route.reply.trim()) {
    // document_mentions 兜底：模型判「与文献无关」时，
    // 本机先用问题术语在本文献里做一次确定性核对。命中了就必须继续读文献——
    // 判错的代价是用户拿不到文献里本来就有的答案。
    const guard = input.documentId
      ? documentMentions(store, input.documentId, retrievalQuestion)
      : null;
    if (guard?.hit) {
      route.document = true;
      route.reason = `${route.reason}（问题中的术语出现在本文献中，自动核对）`;
      forcedByDocumentTerms = true;
      routeNote =
        `已核对术语「${guard.matched.slice(0, 3).join('、')}」：出现在本文献中，继续阅读文献。`;
    } else {
      routeNote = routeNoteForMissedGuard(guard);
      return {
        answer: route.reply.trim(),
        sources: [],
        plan,
        routing: {
          document: route.document,
          search: route.search,
          reason: route.reason
        },
        route_note: routeNote,
        answer_mode: 'direct',
        ...memoryUnused('为直接回复')
      };
    }
  }

  const routing = {
    document: route.document,
    search: route.search,
    reason: route.reason
  };

  const readingPlan = plan ?? planQuestion(retrievalQuestion, selection);
  const scope = input.reading_scope ?? 'auto';
  const scopePage = input.page ?? 1;
  const scopedReadingPlan =
    scope === 'local'
      ? {
          ...readingPlan,
          breadth: 'local' as const,
          reason: '用户指定：本页与相邻页',
          origin: '规则' as const,
          pages: [scopePage - 1, scopePage, scopePage + 1].filter((page) => page >= 1)
        }
      : scope === 'document'
        ? {
            ...readingPlan,
            breadth: 'document' as const,
            reason: '用户指定：整篇文献',
            origin: '规则' as const,
            pages: []
          }
        : readingPlan;
  // 著作默认按章读；用户显式指定章节时按指定章读。两种都由同一个解析器决定。
  const chapterResolution = await resolveChapterReading(
    store,
    input.documentId,
    scopedReadingPlan,
    {
      scope,
      page: scopePage,
      question,
      selection,
      chapterIndex:
        typeof input.reading_chapter_index === 'number' &&
        Number.isInteger(input.reading_chapter_index) &&
        input.reading_chapter_index >= 1
          ? input.reading_chapter_index
          : undefined
    }
  );
  const chapteredPlan = chapterResolution.plan;
  const chapterInfo = chapterResolution.chapter
    ? chapterRecord(chapterResolution.chapter)
    : undefined;
  const chapterTotal = chapterResolution.total || undefined;
  const chapterFields = chapterInfo
    ? { chapter: chapterInfo, chapter_total: chapterTotal }
    : {};
  const readingConfig = getConfig(store, secrets);
  const searchConfig = getSearchConfig(store, secrets);
  const plannedSearch = Boolean(input.search_token && input.search_token.trim());
  if (plannedSearch) {
    // 有审批凭证：review 模式必须显式确认；过期/指纹不符由 consumeSearchPlan 明确报错，
    // 不能静默降级成"自己重新生成搜索词"（那会绕过用户批准的范围）。
    if (searchConfig.permission === 'off') {
      throw new Error('请先在模型设置中允许联网搜索');
    }
    if (searchConfig.permission === 'review' && input.confirmSearch !== true) {
      throw new Error('搜索计划需要确认后才能使用');
    }
  }
  const searchPermitted =
    input.source_policy !== 'document_only' &&
    (searchConfig.permission === 'auto' ||
      (searchConfig.permission === 'review' && input.confirmSearch === true));
  const keywordOnly = searchConfig.privacy_mode === 'keywords-only';
  // 用户改写过的联网查询词优先（web_query）；没有时用问题本身。
  const webQuery = input.web_query?.trim() || question;
  const keywordQuery = keywordOnly ? extractKeywords(webQuery) : question;
  const shouldSearch =
    readingConfig &&
    !forcedByDocumentTerms &&
    (plannedSearch
      ? input.source_policy !== 'document_only'
      : searchConfig.permission !== 'off' &&
        searchPermitted &&
        (route.search || (keywordOnly && !route.document && keywordQuery.length > 0)));
  if (shouldSearch && readingConfig) {
    let results: SearchResult[] = [];
    let searchWarning = '';
    let plannedQueries: string[] | null = null;
    try {
      if (plannedSearch) {
        // token 校验通过后才执行；计划里的搜索词是唯一允许发出的关键词。
        const queries = consumeSearchPlan(store, secrets, input);
        plannedQueries = queries;
        results = await searchWebQueries(store, secrets, queries);
      } else {
        results = await searchWeb(store, secrets, keywordOnly ? keywordQuery : webQuery);
      }
      if (results.length > 0) {
        const context = results
          .map((item, index) => {
            return `[${index + 1}] ${item.title}\n${item.url}\n${item.snippet}`;
          })
          .join('\n\n');
        const webSystemBase =
          '你是联网搜索助手。只根据给出的搜索结果回答；引用网页时用 [W1] 这样的编号标注'
          + '（编号对应给出的搜索结果），并保留 URL；不确定时明确说明。';
        const webUser = `问题：${question}\n\n搜索结果：\n${context}`;
        // 独立问答（服务端会话）：追问也要能看到更早轮次，否则「那它呢」这类问题会丢失指代对象。
        // 阅读页（有 documentId）保持原样：仅联网结果这条路不带历史。
        const webPrior = qaSession
          ? prepareHistory(
              input.history,
              Math.max(
                0,
                // 200 安全余量：下面可能会追加「历史旧引用编号不属于本轮」的规则。
                chatInputLimit(store) - inputCost(budgetMessages(webSystemBase, webUser)) - 200
              )
            )
          : { prior: [], dropped: 0 };
        const webSystem =
          webSystemBase + (webPrior.prior.length > 0 ? staleCitationBlock(true, false) : '');
        const answer = await callChatModel(
          readingConfig,
          webSystem,
          webUser,
          1600,
          signal,
          undefined,
          undefined,
          undefined,
          '',
          webPrior.prior
        );
        const searchNotice = plannedSearch
          ? `已按确认的搜索计划（${(plannedQueries ?? []).join('、')}）搜索 ${results.length} 条结果；回答仅基于本次搜索结果。`
          : keywordOnly
            ? `已用本地提取的关键词「${keywordQuery}」搜索 ${results.length} 条结果；未把文献正文用于搜索规划。`
            : `已按你的联网搜索设置搜索 ${results.length} 条结果；回答仅基于本次搜索结果。`;
        const historyNotice =
          webPrior.dropped > 0
            ? `为容量省略了 ${webPrior.dropped} 轮会话历史（从最旧开始）。`
            : '';
        const noticeParts = [searchNotice, searchWarning, historyNotice].filter(
          (part): part is string => Boolean(part)
        );
        return {
          answer,
          // 结构化网页来源：界面据此列出可点击的 [Wn] 链接（不再只有域名分层）。
          sources: webSourcesOf(results),
          plan,
          routing,
          route_note: routeNote,
          web_search: true,
          answer_mode: 'web',
          ...memoryUnused('只使用了联网结果'),
          // 本轮回答只基于这些网页结果：附上按域名归属的分层清单（只用于显示，不代表质量）。
          source_tiers: listing(results),
          ...(searchWarning ? { search_warning: searchWarning } : {}),
          ...(qaSession
            ? {
                qa_context: {
                  messages: qaSession.messageCount,
                  summary_used: Boolean(qaSession.contextSummary),
                  compacted: 0,
                  dropped: webPrior.dropped
                }
              }
            : {}),
          notice: noticeParts.join('；')
        };
      }
    } catch (error) {
      // 有计划时：过期/指纹不符/审核未确认必须让用户重新确认，不能静默走本地检索。
      if (plannedSearch) throw error;
      // 无计划时保持旧行为：搜索失败继续走本地检索，不伪造联网结果。
    }
  }
  // 跨文献精读（corpus）与独立问答的库内检索共用同一套范围解析：
  // 显式 scope_documents 优先；否则按 scope_tags 圈；都没有 = 全部文献。
  // 没有 documentId 时默认走「库内检索问答」，不能落到"读当前文献"（根本没有当前文献）。
  const corpusScope = input.reading_scope === 'corpus' || Boolean(corpusResume);
  const libraryScope = !input.documentId && !corpusScope;
  const allDocumentsScope =
    !corpusResume &&
    !(input.scope_documents && input.scope_documents.length > 0) &&
    !(input.scope_tags && input.scope_tags.length > 0);
  const scopeDocumentIds: string[] | undefined =
    corpusScope || libraryScope
      ? corpusResume
        ? corpusResume.documentIds!
        : !allDocumentsScope
          ? input.scope_documents && input.scope_documents.length > 0
            ? input.scope_documents
            : store
                .listDocuments()
                .filter((document) =>
                  document.tags.some((tag) => input.scope_tags!.includes(tag))
                )
                .map((document) => document.id)
          : store.listDocuments().map((document) => document.id)
      : undefined;
  const corpusDocumentIds = scopeDocumentIds;

  // 笔记/批注纳入问答：只作为最终回答的补充材料——它们是用户自己的记录，
  // 不是文献原文，不能进入 sources / 逐字证据 / 引用编号（由 reading-chat 的提示词约束）。
  let memoryReadFailure = '';
  let memoryHits: MemoryHit[] = [];
  if (includeMemory) {
    // 阅读内只看当前文献；跨文献/独立问答按范围取；范围是「全部文献」时也纳入独立笔记。
    const memoryDocumentIds = input.documentId
      ? corpusScope
        ? allDocumentsScope
          ? undefined
          : scopeDocumentIds
        : [input.documentId]
      : allDocumentsScope
        ? undefined
        : scopeDocumentIds;
    try {
      memoryHits = searchMemory(store, {
        question,
        selection,
        documentIds: memoryDocumentIds,
        includeNotes: true,
        includeAnnotations: true
      });
    } catch (error) {
      // 笔记/批注只是补充材料：读取失败不能阻断本轮回答，但要如实说明失败，不能谎报"没有匹配"。
      memoryReadFailure = error instanceof Error ? error.message : '未知错误';
      memoryHits = [];
    }
  }
  const memoryText = memoryMaterial(memoryHits);
  const memorySources = memoryChatSources(memoryHits);
  const memoryNotice = includeMemory
    ? memoryReadFailure
      ? `读取笔记/批注失败，本轮未纳入：${trimText(memoryReadFailure, 120)}`
      : memoryHits.length > 0
        ? `已纳入 ${memoryHits.filter((hit) => hit.kind === 'note').length} 条笔记、${
            memoryHits.filter((hit) => hit.kind === 'annotation').length
          } 条批注作为补充材料（你的个人记录，不计入文献引用与逐字证据）。`
        : '已勾选纳入笔记与批注，但本轮范围内没有匹配到相关内容。'
    : undefined;
  const memoryFields: Pick<ChatResponse, 'memory_sources' | 'memory_notice'> =
    includeMemory
      ? {
          memory_sources: memorySources,
          ...(memoryNotice ? { memory_notice: memoryNotice } : {})
        }
      : {};
  // 阅读伙伴会话上下文：有 chat_session_id 时由服务端读该会话完整消息，超预算把更早轮次
  // 压缩进会话摘要（摘要不是文献原文/证据），本轮送入「摘要 + 最近轮次」。
  let readingHistory = input.history;
  let readingSummary = '';
  let readingContextNotice = '';
  if (readingConfig && input.documentId && !corpusScope && input.chat_session_id) {
    try {
      const prepared = await prepareReadingSessionContext({
        store,
        config: readingConfig,
        documentId: input.documentId,
        sessionId: input.chat_session_id,
        fallbackHistory: input.history,
        signal
      });
      readingHistory = prepared.history;
      readingSummary = prepared.summary;
      if (prepared.notice) readingContextNotice = prepared.notice;
    } catch (error) {
      readingContextNotice = `读取阅读会话上下文失败，本轮只带最近轮次：${
        error instanceof Error ? error.message : '未知错误'
      }`;
    }
  }
  let readingFailure = '';
  if (readingConfig && input.documentId && !corpusScope) {
    try {
      const readingAnswer = await answerWithReading(
        store,
        secrets,
        readingConfig,
        question,
        selection,
        input.documentId,
        input.page ?? 1,
        chapteredPlan,
        Number(
          input.reading_rigor === 'exhaustive'
            ? 8000
            : input.reading_rigor === 'fast'
              ? 4000
              : process.env.STUDIANDA_READING_BUDGET ?? 6000
        ),
        signal,
        onProgress,
        input.taskId,
        input.source_policy !== 'document_only',
        onDraft,
        input.reading_rigor ?? 'auto',
        onDraftReset,
        onStage,
        onAudit,
        searchPermitted
          ? ([
              'PRIMARY_EXTERNAL_SOURCE',
              'SCHOLARLY_REFERENCE',
              'OFFICIAL_SOURCE',
              'GENERAL_WEB'
            ] as SourceKind[])
          : [],
        // 多轮历史进入最终回答/审计（超容量时由 reading-chat 从最旧丢并在 notice 说明）。
        readingHistory,
        // 笔记/批注补充材料：只进最终回答，不进证据链。
        memoryText,
        // 会话早期摘要（模型生成，不是文献原文/证据）。
        readingSummary
      );
      if (readingAnswer) {
        let finalReading = readingAnswer;
        const routes = finalReading.audit?.routing ?? [];
        const externalClaims = routes.filter(
          (route) => route.suggested === '联网搜索' || route.suggested === '学术资料'
        );
        // 链路自己发起的定向联网查证：查询词由论断性质 + 首个问题术语生成
        // （最多 3 条），不再用「问题+整段论断」拼接。
        // 状态/是否真的发出请求都要如实记账，review/仅文献/关闭联网等分支不发起。
        const executedClaims = new Set<number>();
        const questionTerms = extractKeywords(question)
          .split(/\s+/)
          .filter((term) => term.length >= 2);
        const auto = autoSourceQueries(
          // shared 的 `audit.routing` 字段比 `ClaimRoute` 窄（缺 source_order/needs_external），
          // 运行期由 audit.routeClaims 填满；这里按 ClaimRoute 断言以复用路由字段。
          routes as unknown as ClaimRoute[],
          questionTerms,
          question,
          { searchRequested: Boolean(route.search) }
        );
        const autoSource: NonNullable<
          NonNullable<ChatResponse['coverage']>['auto_source_search']
        > = {
          queries: auto.queries,
          claims: auto.claims,
          reason: auto.reason,
          status: '未发起',
          approved: false,
          ...(auto.requested ? { requested: true } : {})
        };
        let autoAttempted = false;
        let autoWebResults = 0;
        // review 档的“回答后确认再补查”：未获准时只返回审批信息，绝不发请求。
        let gapApproval: ChatResponse['gap_search_approval'];
        let searchFollowup: ChatResponse['search_followup'];
        let webSupportReview: Record<string, unknown> | undefined;
        let webReviewFailed = false;
        if (input.source_policy === 'document_only') {
          autoSource.status = '未发起：设置里「智能来源」选的是「仅文献」，本轮不发送任何外部请求';
        } else if (externalClaims.length === 0) {
          autoSource.status = '未发起：本轮没有需要外部依据的论断';
        } else if (searchConfig.permission === 'off') {
          autoSource.status = '用户已关闭联网搜索，未发起';
        } else if (searchConfig.permission === 'review' && input.confirm_gap_search !== true) {
          // 不伪造中途弹窗：本轮一个外部请求都不发，只把“允许补查”的选择交给用户。
          autoSource.status = '未发起：需要你先确认是否允许联网补查（本轮没有自动弹确认）';
          gapApproval = {
            queries: auto.queries,
            claims: auto.claims,
            reason: auto.reason
          };
        } else if (auto.queries.length === 0) {
          autoSource.status = '未发起：本轮没有需要外部依据的论断';
        } else {
          try {
            const baseSourceCount = (finalReading.sources ?? []).length;
            const docSources = [...(finalReading.sources ?? [])];
            const webSourcesAll: ChatSource[] = [];
            const searchedQueries: string[] = [];
            let rounds = 0;
            let previousAnswer = '';
            let previousVisibleLines = 0;
            let rawReview: AuditReport | null = null;
            let mergedReview: AuditReport | null = null;
            let pendingQueries = auto.queries.slice();
            let remainingClaimNumbers: number[] = [];
            let stoppedReason: string | undefined;
            const runWebSupportAudit = async (revised: string): Promise<void> => {
              try {
                // 修订回答里的 [Wn] 先换成数字编号（来源顺序=文献来源+网页来源），再走现有审计。
                const numericAnswer = remapWebCitations(revised, baseSourceCount);
                const originals: AuditOriginal[] = [...docSources, ...webSourcesAll].map(
                  (source, index) => ({
                    source: index + 1,
                    ...(source.kind === 'web' ? {} : { document_id: source.documentId }),
                    page: source.page,
                    text: source.snippet,
                    source_type: source.kind === 'web' ? 'web' : 'document'
                  })
                );
                const report = await auditAnswer(
                  numericAnswer,
                  (instruction, material) =>
                    callChatModel(readingConfig, instruction, material, 1200, signal),
                  { originals, contextPrefix: question }
                );
                // auditAnswer 对单包失败是“软失败”（写进 issues/status），不抛异常；
                // 同样要如实标记“联网补充未完成复核”，不能把部分报告当完整复核。
                if (report.status !== '已进行模型证据支持复核') {
                  webReviewFailed = true;
                }
                if (rawReview) {
                  // 两轮都有报告：按“上一轮答案可见行数+1”平移并合并。
                  mergedReview = mapWebReviewCitations(
                    mergeWebReviews(rawReview, report, previousVisibleLines + 1),
                    baseSourceCount
                  );
                } else {
                  mergedReview = mapWebReviewCitations(report, baseSourceCount);
                }
                rawReview = report;
              } catch (error) {
                if ((error as { name?: string } | null)?.name === 'AbortError') throw error;
                // 复核失败不阻断：保留修订回答，只在 notice 如实说明未完成复核。
                webReviewFailed = true;
              }
            };
            for (let round = 1; round <= 2; round += 1) {
              const queries = pendingQueries
                .filter((query) => !searchedQueries.includes(query))
                .slice(0, 3);
              if (queries.length === 0) {
                stoppedReason ??= '没有新的查询词';
                break;
              }
              searchedQueries.push(...queries);
              rounds = round;
              autoAttempted = true;
              const roundSources: ChatSource[] = [];
              const contextBlocks: string[] = [];
              const claimList = round === 1 ? auto.claims : remainingClaimNumbers;
              for (let index = 0; index < queries.length; index += 1) {
                const query = queries[index]!;
                const claimNumber = claimList[index] ?? claimList[0];
                const claimText =
                  finalReading.audit?.claims.find((claim) => claim.claim === claimNumber)
                    ?.text ?? '';
                if (claimNumber !== undefined) executedClaims.add(claimNumber);
                const results = await searchWeb(store, secrets, query);
                if (results.length === 0) continue;
                const block = results
                  .slice(0, 3)
                  .map((item) => {
                    const webNumber = webSourcesAll.length + roundSources.length + 1;
                    roundSources.push({
                      documentId: `web:${item.url}`,
                      documentName: item.title,
                      page: 1,
                      snippet: item.snippet,
                      quotes: [],
                      url: item.url,
                      kind: 'web' as const,
                      // 域名分层（预印本/期刊/机构/政府/一般网页）：只用于显示与排序。
                      tier: item.tier,
                      tierLabel: item.tierLabel
                    });
                    return `[W${webNumber}] ${item.title}\n${item.url}\n${item.snippet}`;
                  })
                  .join('\n\n');
                contextBlocks.push(
                  `第 ${claimNumber ?? index + 1} 段：${claimText.slice(0, 300)}\n${block}`
                );
              }
              if (roundSources.length === 0) {
                if (round === 1) {
                  autoSource.status = '已查证，但没有取得可用网页依据';
                } else {
                  stoppedReason = '没有新的网页依据';
                }
                break;
              }
              webSourcesAll.push(...roundSources);
              // 先把网页来源并入结果：即使随后修订请求失败，用户仍能看到本轮真的取到了哪些网页。
              finalReading = {
                ...finalReading,
                sources: [...docSources, ...webSourcesAll],
                web_search: true,
                // 网页来源的分层清单：只按域名归属分组，不代表质量，也不等于查过学术资料库。
                source_tiers: listing(webSourcesAll)
              };
              const baseAnswer = round === 1 ? (finalReading.answer ?? '') : previousAnswer;
              let revised = baseAnswer;
              try {
                const next = await callChatModel(
                  readingConfig,
                  '根据原回答和网页补充，逐段修订回答。只补充确实由网页支持的内容；保留原有文献引用编号；网页依据继续用 [W1] 这类编号（不要改用其它编号）；无法确认的内容不要写成定论。',
                  `问题：${question}\n\n原回答：\n${baseAnswer}\n\n需补查的段落与网页结果：\n${contextBlocks.join('\n\n')}`,
                  1200,
                  signal
                );
                // 修订结果必须是文字；异常/空结果时保留原回答（不把 undefined 当回答）。
                if (typeof next === 'string' && next.trim()) revised = next;
              } catch (error) {
                if ((error as { name?: string } | null)?.name === 'AbortError') throw error;
                // 修订失败：保留原回答与已取到的网页来源，并如实标记复核未完成。
                webReviewFailed = true;
              }
              previousAnswer = revised;
              finalReading = { ...finalReading, answer: revised };
              await runWebSupportAudit(revised);
              previousVisibleLines = visibleLineCount(previousAnswer);
              if (round === 1) {
                const remaining = externalClaims.filter(
                  (claimRoute) => !executedClaims.has(claimRoute.claim)
                );
                if (remaining.length === 0) {
                  stoppedReason = '没有剩余的外部论断';
                  break;
                }
                const follow = autoSourceQueries(
                  remaining as unknown as ClaimRoute[],
                  questionTerms,
                  question,
                  { searchRequested: false }
                );
                const newQueries = follow.queries.filter(
                  (query) => !searchedQueries.includes(query)
                );
                if (newQueries.length === 0) {
                  stoppedReason = '没有新的查询词';
                  break;
                }
                pendingQueries = newQueries;
                remainingClaimNumbers = remaining.map((claimRoute) => claimRoute.claim);
              }
            }
            autoWebResults = webSourcesAll.length;
            autoSource.approved = autoAttempted;
            autoSource.results = autoWebResults;
            if (autoAttempted && autoWebResults === 0) {
              autoSource.status = '已查证，但没有取得可用网页依据';
            } else if (autoAttempted) {
              autoSource.status = `已按论断缺口查证（${autoWebResults} 条网页依据）`;
            }
            if (rounds > 0) {
              searchFollowup = {
                rounds: Math.max(1, rounds),
                queries: searchedQueries,
                results: autoWebResults,
                ...(stoppedReason ? { stopped_reason: stoppedReason } : {})
              };
            }
            if (mergedReview) {
              webSupportReview = mergedReview as unknown as Record<string, unknown>;
            }
          } catch (error) {
            if ((error as { name?: string } | null)?.name === 'AbortError') throw error;
            if (autoAttempted) autoSource.approved = true;
            const message = error instanceof Error ? error.message : '未知错误';
            const detail = message.slice(0, 120);
            // 权限/搜索计划类拒绝是「未发起」，其它异常是「查证未完成」。
            autoSource.status = /没有获准|未获准|允许联网搜索|搜索平台密钥|搜索计划/.test(
              message
            )
              ? `未发起：${detail}`
              : `查证未完成：${detail}`;
          }
        }
        const blockedSources =
          input.source_policy === 'document_only'
            ? [
                ...new Set(
                  externalClaims.map((route) =>
                    route.suggested === '学术资料' ? '学术资料' : '联网搜索'
                  )
                )
              ]
            : [];
        const bySuggestion = externalClaims.reduce<Record<string, number>>(
          (counts, route) => {
            counts[route.suggested] = (counts[route.suggested] ?? 0) + 1;
            return counts;
          },
          {}
        );
        const auditClaims = finalReading.audit?.claims ?? [];
        const auditSummary = {
          claims: auditClaims.length,
          supported: auditClaims.filter((claim) => claim.verdict === 'supported').length,
          inference: auditClaims.filter((claim) => claim.verdict === 'inference').length,
          unsupported: auditClaims.filter((claim) => claim.verdict === 'unsupported').length,
          heading: auditClaims.filter((claim) => claim.verdict === 'heading').length,
          claim_types: auditClaims.reduce<Record<string, number>>((counts, claim) => {
            if (claim.claim_type) {
              counts[claim.claim_type] = (counts[claim.claim_type] ?? 0) + 1;
            }
            return counts;
          }, {})
        };
        const sourceRouting = {
          claims: routes.length,
          needs_external: externalClaims.length,
          document_only: Math.max(0, routes.length - externalClaims.length),
          blocked_kinds: blockedSources,
          by_suggestion: bySuggestion
        };
        for (const route of routes) {
          if (!externalClaims.includes(route)) route.execution = 'not_needed';
          else if (input.source_policy === 'document_only') route.execution = 'blocked';
          else if (executedClaims.has(route.claim)) route.execution = 'searched';
          else route.execution = 'needs_confirmation';
        }
        // 用户可见的「为什么没联网」：只在确有外部论断、且本轮没有真正发出请求时补一句；
        // 已联网时保留补查摘要，不用「说明」重复同一事实。
        const noticeParts: string[] = [];
        if (finalReading.notice) noticeParts.push(finalReading.notice);
        if (readingContextNotice) noticeParts.push(readingContextNotice);
        if (autoWebResults > 0) {
          noticeParts.push(`已按审计来源建议逐段补查 ${autoWebResults} 条网页结果。`);
        } else if (autoAttempted) {
          noticeParts.push(`说明：${autoSource.status}`);
        } else if (externalClaims.length > 0) {
          const why = whyNotOnline(input.source_policy, autoSource);
          if (why && !noticeParts.includes(why)) noticeParts.push(why);
        }
        if (gapApproval) {
          noticeParts.push(
            `发现 ${gapApproval.claims.length || gapApproval.queries.length} 处结论按性质需要外部依据；` +
              '需要你允许后补查（本轮未发送任何外部请求）。'
          );
        }
        if (webReviewFailed) {
          noticeParts.push('联网补充未完成复核：已保留修订后的回答，但网页依据未经模型逐条核对。');
        }
        if (searchFollowup && searchFollowup.rounds > 1) {
          noticeParts.push('联网补查已追加一轮（共 2 轮），仍无法确认的结论请以文献原文为准。');
        }
        const coverage: NonNullable<ChatResponse['coverage']> = {
          dimensions: finalReading.coverage?.dimensions ?? [],
          batches: finalReading.coverage?.batches ?? 0,
          recorded_batches: finalReading.coverage?.recorded_batches ?? 0,
          hits: finalReading.coverage?.hits ?? [],
          states: finalReading.coverage?.states ?? {},
          evidence: finalReading.coverage?.evidence ?? {},
          evidence_pages: finalReading.coverage?.evidence_pages ?? {},
          ...finalReading.coverage,
          auto_source_search: autoSource,
          ...(webSupportReview ? { web_support_review: webSupportReview } : {})
        };
        // 续读（taskId）时以阅读链路返回的章信息为准：续读按"下一章"对齐，
        // 不能用本轮规划另选一章来覆盖它。
        const resumedChapterFields =
          input.taskId && finalReading.chapter
            ? { chapter: finalReading.chapter, chapter_total: finalReading.chapter_total }
            : chapterFields;
        return {
          ...finalReading,
          ...resumedChapterFields,
          coverage,
          // 复用上一轮已保存回答（没有重新调用模型）：不能声称本轮纳入过笔记/批注。
          ...(readingAnswer.reused_answer
            ? includeMemory
              ? { memory_notice: '本轮复用上一轮已保存的回答，未重新使用笔记与批注。' }
              : {}
            : memoryFields),
          answer_mode: 'reading',
          ...(noticeParts.length > 0 ? { notice: noticeParts.join('；') } : {}),
          ...(gapApproval ? { gap_search_approval: gapApproval } : {}),
          ...(searchFollowup ? { search_followup: searchFollowup } : {}),
          routing,
          route_note: routeNote,
          blocked_sources: blockedSources,
          source_routing: sourceRouting,
          audit_summary: auditSummary,
          reading_scope: scope,
          reading_rigor: input.reading_rigor ?? 'auto',
          model_knowledge: input.source_policy !== 'document_only',
          web_search: Boolean(shouldSearch) || Boolean(finalReading.web_search)
        };
      }
      readingFailure = '完整阅读没有返回结果';
    } catch (error) {
      readingFailure = error instanceof Error ? error.message : '完整阅读失败';
      // 分批阅读失败时保留检索回答路径，并在回答下方明确说明，不伪装成完整阅读。
    }
  }

  if (corpusScope && readingConfig && corpusDocumentIds) {
    try {
      const corpusAnswer = await answerWithCorpus(
        store,
        secrets,
        readingConfig,
        question,
        selection,
        corpusDocumentIds,
        Number(
          input.reading_rigor === 'exhaustive'
            ? 8000
            : input.reading_rigor === 'fast'
              ? 4000
              : process.env.STUDIANDA_READING_BUDGET ?? 6000
        ),
        signal,
        onDraft,
        input.source_policy !== 'document_only',
        // 多轮历史进入跨文献最终回答/审计（超容量从最旧丢，notice 说明）。
        input.history,
        onProgress,
        // 继续阅读：同一任务只补读未读页；任务在 answerWithCorpus 里按需保留/销掉。
        input.taskId,
        // 规划维度/查询词：corpus 也沿用问题规划（不再固定 D1–D6 / 只用问题字面词）。
        scopedReadingPlan,
        // 笔记/批注补充材料：只进最终回答，不进证据链。
        memoryText
      );
      if (corpusAnswer) {
        return {
          ...corpusAnswer,
          routing,
          route_note: routeNote,
          reading_scope: 'corpus',
          reading_rigor: input.reading_rigor ?? 'auto',
          model_knowledge: input.source_policy !== 'document_only',
          web_search: Boolean(shouldSearch),
          // 复用上一轮已保存回答（没有重新调用模型）：不能声称本轮纳入过笔记/批注。
          ...(corpusAnswer.reused_answer
            ? includeMemory
              ? { memory_notice: '本轮复用上一轮已保存的回答，未重新使用笔记与批注。' }
              : {}
            : memoryFields),
          answer_mode: 'reading'
        };
      }
    } catch (error) {
      readingFailure = error instanceof Error ? error.message : '跨文献阅读失败';
    }
  }

  // 没有 documentId（独立问答）时，这里是默认回答路径：库内检索原文页 + 笔记/批注后回答。
  // 有 documentId 时这里是「完整阅读失败后的退回路径」，保持原有整页检索行为。
  // 显式范围一个文献都没圈中：如实报告，不静默改成全库检索。
  if (!allDocumentsScope && scopeDocumentIds && scopeDocumentIds.length === 0) {
    return {
      answer: null,
      sources: [],
      ...chapterFields,
      routing,
      route_note: routeNote,
      reading_scope: scope,
      reading_rigor: input.reading_rigor ?? 'auto',
      model_knowledge: input.source_policy !== 'document_only',
      web_search: Boolean(shouldSearch),
      answer_mode: 'library',
      ...memoryFields,
      notice:
        '所选范围没有匹配到任何文献（可能是标签没有对应文献），本轮没有读取任何内容；请重新选择范围。' +
        (readingFailure ? ` 完整阅读未完成：${trimText(readingFailure, 200)}` : '')
    };
  }

  // 追问检索：短问题/含指代的问题会把最近两轮上文拼进检索查询，
  // 否则「那它的测量口径呢？」这类问题在检索阶段就丢了指代对象。拼进去的上文只用于
  // 检索定位，不进 sources、也不是本轮证据（详见 qa-context.ts）。
  const baseRetrievalQuery = retrievalQuestion;
  const retrievalAugmented = baseRetrievalQuery !== question;
  const hits = await retrieve(
    store,
    secrets,
    selection ? `${baseRetrievalQuery}\n${selection}` : baseRetrievalQuery,
    input.documentId,
    input.page ?? 1,
    'close',
    8,
    scopeDocumentIds ? { scopeDocumentIds } : {}
  );

  // 库内检索问答：检索排序不变，只把"命中页 → 整页原文"改成"命中页 → 命中位置所在段落/章节片段"。
  // 识别不出块（扫描页/校订页/无文本）时退回整页，保持旧行为；片段仍是原文文字，不是新证据。
  const sectionCache = new Map<
    string,
    { blocks: DocumentBlocks; index: DocumentSectionIndex } | null
  >();
  const sectionContextFor = async (hit: SearchHit) => {
    if (!libraryScope) return null;
    // 用户校订过的页：块文字来自 PDF 文本层，可能与校订后的正文不一致，退回整页。
    const edit = store.getPageEdit(hit.documentId, hit.page);
    if (edit?.origin === 'user' && edit.text.trim()) return null;
    if (!sectionCache.has(hit.documentId)) {
      try {
        const blocks = await store.getDocumentBlocks(hit.documentId);
        const index = await store.getSectionIndex(hit.documentId);
        sectionCache.set(hit.documentId, { blocks, index });
      } catch {
        sectionCache.set(hit.documentId, null);
      }
    }
    const cached = sectionCache.get(hit.documentId);
    if (!cached) return null;
    return locateSectionContext(
      {
        documentId: hit.documentId,
        page: hit.page,
        match: hit.match,
        snippet: hit.snippet
      },
      cached.blocks,
      cached.index
    );
  };

  const sources: ChatSource[] = [];
  const seenPages = new Set<string>();
  let sectionContextCount = 0;
  for (const hit of hits) {
    const context = await sectionContextFor(hit);
    const key = context
      ? `${hit.documentId}:sec:${context.sectionIndex}:${hit.page}`
      : `${hit.documentId}:page:${hit.page}`;
    if (seenPages.has(key)) continue;
    seenPages.add(key);
    if (context) sectionContextCount += 1;
    const pageText = store.getPageText(hit.documentId, hit.page);
    sources.push({
      documentId: hit.documentId,
      documentName: hit.documentName,
      page: hit.page,
      // 命中片段优先（命中段落/所在章节）；否则退回整页上下文，避免“行首/行尾碎片”。
      snippet: context ? trimText(context.text, 5000) : trimText(pageText || hit.snippet, 6000),
      quotes: [],
      ...(context?.sectionTitle ? { sectionTitle: context.sectionTitle } : {}),
      ...(context && context.pageEnd > hit.page ? { pageEnd: context.pageEnd } : {}),
      // 跳转定位用命中行：点来源时能高亮到具体那一行（不是引用证据，不参与核验）。
      ...(context && hit.match?.trim() ? { locate: trimText(hit.match.trim(), 400) } : {})
    });
  }

  // 检索不到时，至少把当前页作为上下文，避免"问了同一页却没有依据"。
  if (sources.length === 0 && input.documentId) {
    const document = store.getDocument(input.documentId);
    const page = input.page ?? document?.currentPage ?? 1;
    const pageText = store.getPageText(input.documentId, page);
    if (document && pageText) {
      sources.push({
        documentId: document.id,
        documentName: document.name,
        page,
        snippet: trimText(pageText, 6000),
        quotes: []
      });
    }
  }

  const memoryOnly = sources.length === 0 && memoryHits.length > 0;
  const config = getConfig(store, secrets);
  if (!config) {
    return {
      answer: null,
      sources,
      ...chapterFields,
      routing,
      route_note: routeNote,
      reading_scope: scope,
      reading_rigor: input.reading_rigor ?? 'auto',
      model_knowledge: input.source_policy !== 'document_only',
      web_search: Boolean(shouldSearch),
      answer_mode: 'library',
      ...memoryFields,
      notice:
        `尚未配置模型服务，因此只返回本地检索到的原文片段${
          memoryHits.length > 0 ? '与本地笔记/批注' : ''
        }。请到「设置 → 模型服务」添加平台，并在「会话模型」里选择模型。` +
        (readingFailure ? ` 完整阅读未完成：${trimText(readingFailure, 200)}` : '')
    };
  }

  if (sources.length === 0 && memoryHits.length === 0) {
    // 无文献内容聊天：
    // - document_only：用户明确要求只用文献，保持「无法回答」，不偷偷改用模型知识；
    // - 其它来源策略：库内没有命中 ≠ 不能聊天。通用知识/纯聊天改为直接调用会话模型
    //   凭自身知识回答（answer_mode='direct'），并如实说明没有使用库内原文、不编号引用。
    if (input.source_policy === 'document_only') {
      return {
        answer: null,
        sources,
        ...chapterFields,
        routing,
        route_note: routeNote,
        reading_scope: scope,
        reading_rigor: input.reading_rigor ?? 'auto',
        model_knowledge: false,
        web_search: Boolean(shouldSearch),
        answer_mode: 'library',
        ...memoryFields,
        notice:
          '本地没有检索到相关原文，且本轮来源限定为「仅文献」，暂时无法回答。可以先确认 PDF 是否包含可提取文本（扫描件需要 OCR）；独立问答也可以勾选「笔记/批注」后再问。' +
          (readingFailure ? ` 完整阅读未完成：${trimText(readingFailure, 200)}` : '')
      };
    }
    const knowledgeSystem =
      '你是文献阅读助手。本轮没有检索到任何库内原文页，也没有可用的笔记/批注。' +
      '请直接回答用户的问题：通用知识、常识、日常对话可以凭你自己的知识回答；' +
      '如果问题需要具体文献依据而当前没有，请明确说明「本次没有检索到库内原文」，' +
      '不要编造页码、文献原句或 [1][2] 这类引用编号。';
    const knowledgeUser = `问题：${question}${
      selection ? `\n\n用户引用的原文：\n${trimText(selection, 2000)}` : ''
    }`;
    const knowledgeConversation = qaSession
      ? await prepareQaConversation({
          store,
          session: qaSession,
          config,
          baseSystem: knowledgeSystem,
          user: knowledgeUser,
          question,
          inputLimit: chatInputLimit(store),
          signal,
          onStage
        })
      : null;
    let knowledgeSystemPrompt = knowledgeSystem;
    if (knowledgeConversation?.summaryBlock) {
      knowledgeSystemPrompt += knowledgeConversation.summaryBlock;
    }
    if (knowledgeConversation?.omittedBlock) {
      knowledgeSystemPrompt += knowledgeConversation.omittedBlock;
    }
    if (qaSession) knowledgeSystemPrompt += staleCitationBlock(true, false);
    const knowledgeAnswer = await callChatModel(
      config,
      knowledgeSystemPrompt,
      knowledgeUser,
      1600,
      signal,
      onDraft,
      undefined,
      qaSession ? chatInputLimit(store) : undefined,
      '通用知识回答',
      knowledgeConversation?.prior ?? []
    );
    const knowledgeNoticeParts = [
      '本轮没有检索到库内原文；以下回答来自模型自身知识，未引用库内页。'
    ];
    if (readingFailure) {
      knowledgeNoticeParts.push(
        `完整阅读未完成，已退回模型知识回答：${trimText(readingFailure, 200)}`
      );
    }
    if (knowledgeConversation) {
      if (knowledgeConversation.stats.compacted > 0) {
        knowledgeNoticeParts.push(
          `已把本会话更早的 ${knowledgeConversation.stats.compacted} 轮对话压缩成摘要（完整历史仍在会话里）。`
        );
      }
      if (knowledgeConversation.stats.dropped > 0) {
        knowledgeNoticeParts.push(
          `会话历史超出模型输入预算，为容量省略了 ${knowledgeConversation.stats.dropped} 轮（从最旧开始）。`
        );
      }
    }
    return {
      answer: knowledgeAnswer,
      sources: [],
      ...chapterFields,
      routing,
      route_note: routeNote,
      reading_scope: scope,
      reading_rigor: input.reading_rigor ?? 'auto',
      model_knowledge: true,
      web_search: Boolean(shouldSearch),
      answer_mode: 'direct',
      ...memoryFields,
      ...(knowledgeConversation ? { qa_context: knowledgeConversation.stats } : {}),
      notice: knowledgeNoticeParts.join('；')
    };
  }

  const context = sources
    .map((source, index) => {
      // 命中片段会标明所在章节与覆盖页；退回整页时仍标「整页原文」。
      const label = source.sectionTitle
        ? `命中片段 · ${trimText(source.sectionTitle, 80)}${
            source.pageEnd && source.pageEnd > source.page ? `（第 ${source.page}–${source.pageEnd} 页）` : ''
          }`
        : '整页原文';
      return `[${index + 1}] ${source.documentName} 第 ${source.page} 页（${label}）\n${trimText(source.snippet, 5000)}`;
    })
    .join('\n\n');

  // 库内检索只给命中片段/命中页，不能声称"读到全文"；笔记/批注是用户记录，不能当文献证据。
  // 没勾选/没命中时提示词里也不要提用户笔记，否则口径与材料不一致（模型可能凭空以"你的笔记"口吻回答）。
  const libraryPrompt = memoryText
    ? '你是本地文献库问答助手。只根据给出的检索原文片段与用户笔记/批注回答；文献原文用 [编号] 标注依据；'
      + '笔记/批注是用户自己的记录，不是文献原文，不能编号引用，也不能当成文献主张。'
      + '片段是命中位置所在的段落/章节（标「整页原文」的才是整页），不代表已读全文；原文不足时明确说明，不要编造。'
    : '你是本地文献库问答助手。只根据给出的检索原文片段回答；文献原文用 [编号] 标注依据；'
      + '片段是命中位置所在的段落/章节（标「整页原文」的才是整页），不代表已读全文；原文不足时明确说明，不要编造。';
  let systemPrompt =
    (libraryScope
      ? libraryPrompt
      : '你是本地文献阅读助手。只根据用户问题与给出的原文回答；这里给的是整页或连续页原文，不是检索片段。'
          + '原文确实不足时再明确说明，不要编造。回答尽量简洁，并用 [编号] 标注依据。') +
    (memoryText ? `\n\n${MEMORY_RULES}` : '') +
    // 会话历史里的旧编号不属于本轮证据：先给模型立规矩，压缩摘要/历史里出现旧编号也不会被误用。
    (qaSession ? staleCitationBlock(true, false) : '');
  const userContent = `问题：${question}${
    selection ? `\n\n用户引用的原文：\n${trimText(selection, 2000)}` : ''
  }\n\n${
    libraryScope
      ? '库内检索原文片段（命中位置所在的段落/章节；标「整页原文」的是命中页全文）'
      : '原文'
  }：\n${context}${memoryText ? `\n\n${memoryText}` : ''}`;

  // 独立问答（会话已由服务端持久化）：完整历史进上下文；超出模型输入预算时把更早轮次
  // 压缩成摘要（摘要存回会话，后续轮次复用），而不是像阅读页那样只取「最近 N 轮」。
  // 阅读内（有 documentId）不传 qa_session_id，仍走客户端传的最近 N 轮，行为不变。
  const qaConversation = qaSession
    ? await prepareQaConversation({
        store,
        session: qaSession,
        config,
        baseSystem: systemPrompt,
        user: userContent,
        question,
        inputLimit: chatInputLimit(store),
        signal,
        onStage
      })
    : null;
  if (qaConversation?.summaryBlock) systemPrompt += qaConversation.summaryBlock;
  if (qaConversation?.omittedBlock) systemPrompt += qaConversation.omittedBlock;

  // 统一走 callChatModel：带用户取消 signal（默认 120s 超时）、支持 SSE 流式草稿、
  // 并在发送前按输入预算校验（独立问答会话才启用，阅读页退回路径保持原行为）。
  const answer = await callChatModel(
    config,
    systemPrompt,
    userContent,
    2400,
    signal,
    onDraft,
    undefined,
    qaSession ? chatInputLimit(store) : undefined,
    '库内检索回答',
    qaConversation?.prior ?? []
  );

  const noticeParts: string[] = [];
  if (memoryOnly) noticeParts.push('本轮没有检索到相关原文页，回答只参考了你的笔记与批注。');
  if (retrievalAugmented) {
    noticeParts.push('本轮检索结合了本会话上文的指代信息（只用于定位命中位置，不是本轮证据）。');
  }
  if (libraryScope && sectionContextCount > 0) {
    noticeParts.push(
      `本轮命中 ${sectionContextCount} 处段落/章节片段作为上下文（不是整页原文）；需要完整论证请选「跨文献精读」。`
    );
  }
  if (readingFailure) {
    noticeParts.push(`完整阅读未完成，已退回整页检索：${trimText(readingFailure, 200)}`);
  }
  if (qaConversation) {
    if (qaConversation.stats.compacted > 0) {
      noticeParts.push(
        `已把本会话更早的 ${qaConversation.stats.compacted} 轮对话压缩成摘要（完整历史仍在会话里）；`
          + '本轮不再逐字携带这些轮次。'
      );
    }
    if (qaConversation.stats.dropped > 0) {
      noticeParts.push(
        `会话历史超出模型输入预算，为容量省略了 ${qaConversation.stats.dropped} 轮（从最旧开始）。`
      );
    }
  }
  return {
    answer,
    sources,
    ...chapterFields,
    routing,
    route_note: routeNote,
    reading_scope: scope,
    reading_rigor: input.reading_rigor ?? 'auto',
    model_knowledge: input.source_policy !== 'document_only',
    web_search: Boolean(shouldSearch),
    answer_mode: 'library',
    citation_support: citationSupport(answer, sources),
    invalid_citations: invalidCitations(answer, sources.length),
    ...memoryFields,
    ...(qaConversation ? { qa_context: qaConversation.stats } : {}),
    ...(noticeParts.length > 0 ? { notice: noticeParts.join('；') } : {})
  };
}


/**
 * 对外入口：包一层 token 用量收集（供应商返回 usage 就如实累计，没返回则按字符估算并标记）。
 * 阅读链路内部所有 callChatModel（规划/批次/综合/审计/修订）都会通过 AsyncLocalStorage 计入本轮。
 */
export async function answerQuestion(
  store: Store,
  secrets: SecretStore,
  input: ChatRequest,
  signal?: AbortSignal,
  onProgress?: (done: number, total: number) => void,
  onDraft?: (text: string) => void,
  onDraftReset?: () => void,
  onStage?: (text: string) => void,
  onAudit?: (claims: unknown[]) => void
): Promise<ChatResponse> {
  const { result, usage } = await collectModelUsage(() =>
    answerQuestionInner(
      store,
      secrets,
      input,
      signal,
      onProgress,
      onDraft,
      onDraftReset,
      onStage,
      onAudit
    )
  );
  return usage ? { ...result, usage } : result;
}
