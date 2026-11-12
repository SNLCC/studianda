import { appDialogs } from './dialogs.js';
import { ApiRequestError, type ApiClient } from '@studianda/api-client';
import { withAiNoteHeader } from '@studianda/shared';
import type {
  BudgetEstimate,
  ChatRequest,
  ChatResponse,
  ChatSource,
  DocumentSummary,
  QaImportMessage,
  QaMessageRecord,
  QaSessionDetail,
  QaSessionSummary
} from '@studianda/shared';
import { ChatPanel, type ChatMessageView, type ChatPanelProps } from '@studianda/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import type { RuntimeAdapter } from './runtime.js';
import { blobToWav, mediaRecordingSupport } from './runtime.js';

/** 旧版独立会话历史的本机键：新版只在一次性迁移时读取，导入成功后就删除。 */
export const QA_HISTORY_STORAGE_KEY = 'studianda.qa.history';
/** 迁移时最多导入的旧消息条数（控制单次导入量，避免一次导入过大）。 */
const LEGACY_QA_HISTORY_LIMIT = 200;
/** 旧历史迁移每批导入条数：分批顺序调用，避免一次性写库过大；全部成功才删旧键。 */
const LEGACY_QA_IMPORT_BATCH_SIZE = 40;
/** 会话消息分页大小：打开会话只取最新一页，更早的按需加载。 */
const QA_MESSAGE_PAGE_SIZE = 60;
/**
 * 当前选中的会话 id 存本机：刷新/重开应用后回到上次打开的会话。
 *
 * 会话与消息本身存在本机数据库（服务端），这里只记「上次看的是哪个」。
 */
const QA_ACTIVE_SESSION_STORAGE_KEY = 'studianda.qa.activeSession';
/** 旧版历史一次性迁移后写入的会话标题。 */
const LEGACY_QA_SESSION_TITLE = '旧版会话记录';

/**
 * 本地化会话更新时间：相对时间优先，其次当天时间/日期。
 *
 * 服务端 `updatedAt` 可能是空串或非法值（例如旧数据缺失），此时返回空串，界面据此不显示。
 */
function formatSessionTime(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  const timestamp = Date.parse(trimmed);
  if (!Number.isFinite(timestamp)) return '';
  const now = Date.now();
  const diff = now - timestamp;
  // 时钟偏差（服务端时间略晚于本机）按当天日期显示，不显示「-1 分钟」。
  if (diff < 0) return new Date(timestamp).toLocaleDateString('zh-CN');
  const minute = 60_000;
  if (diff < minute) return '刚刚';
  if (diff < 60 * minute) return `${Math.floor(diff / minute)} 分钟前`;
  const updated = new Date(timestamp);
  const today = new Date(now);
  if (updated.toDateString() === today.toDateString()) {
    return updated.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  }
  if (updated.getFullYear() === today.getFullYear()) {
    return updated.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
  }
  return updated.toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric'
  });
}

/** 读取本机记住的当前会话 id（本地存储不可用时当作没有）。 */
function readActiveSessionId(): string | null {
  try {
    const stored = window.localStorage.getItem(QA_ACTIVE_SESSION_STORAGE_KEY);
    return stored && stored.trim() ? stored : null;
  } catch {
    return null;
  }
}

/**
 * 读取旧版本地会话历史（只用于一次性迁移）。
 *
 * 只保留结构合法的 user/assistant 消息；数据损坏时当空历史，绝不让整页白屏。
 */
function readLegacyQaHistory(): ChatMessageView[] {
  try {
    const raw = window.localStorage.getItem(QA_HISTORY_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (item): item is ChatMessageView =>
          Boolean(item) &&
          typeof item === 'object' &&
          ((item as ChatMessageView).role === 'user' ||
            (item as ChatMessageView).role === 'assistant') &&
          typeof (item as ChatMessageView).content === 'string'
      )
      .slice(-LEGACY_QA_HISTORY_LIMIT);
  } catch {
    return [];
  }
}

/** 旧版消息 → 导入接口的消息：失败占位回答不算有效回答（不进入后续上下文）。 */
function toImportedMessage(message: ChatMessageView): QaImportMessage {
  const content = message.content.trim();
  const answered =
    message.role === 'user'
      ? true
      : Boolean(message.response) || (content !== '' && !content.startsWith('回答未完成'));
  return {
    role: message.role,
    content: message.content,
    response: message.response ?? null,
    answered
  };
}

/** 服务端消息记录 → ChatPanel 的消息视图。 */
function toMessageView(record: {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  response: ChatResponse | null;
}): ChatMessageView {
  return {
    id: String(record.id),
    role: record.role,
    content: record.content,
    response: record.response ?? undefined
  };
}

/** 导出里的一条来源：文献来源给「[n] 文档名 第 x 页」，联网来源给 URL。 */
function describeSource(source: ChatSource, index: number): string {
  const name = source.documentName?.trim() || '未命名来源';
  if (source.kind === 'web') {
    return `[${index}] ${name}${source.url ? `（联网来源：${source.url}）` : ''}`;
  }
  if (source.page <= 0) return `[${index}] ${name}`;
  const pageEnd = source.pageEnd && source.pageEnd > source.page ? `–${source.pageEnd}` : '';
  return `[${index}] ${name} 第 ${source.page}${pageEnd} 页`;
}

/** 导出里的一条笔记/批注来源：明确标注是用户记录，不是文献原文证据。 */
function describeMemorySource(source: ChatSource): string {
  const name = source.documentName?.trim() || '独立笔记';
  const page = source.page > 0 ? ` 第 ${source.page} 页` : '';
  return `- ${name}${page}（笔记/批注，非原文证据）`;
}

/** 把一条助手回答整理成笔记 Markdown：正文 + 依据 + 笔记/批注标注。 */
function buildAnswerNoteMarkdown(message: ChatMessageView): string {
  const response = message.response;
  const lines: string[] = [message.content.trim() || '（这一轮没有产生文字回答。）'];
  const sources = response?.sources ?? [];
  if (sources.length > 0) {
    lines.push('', '## 依据', '');
    for (const [index, source] of sources.entries()) {
      lines.push(`- ${describeSource(source, index + 1)}`);
    }
  }
  const memorySources = response?.memory_sources ?? [];
  if (memorySources.length > 0) {
    lines.push('', '## 参考的笔记与批注（你的记录，非原文证据）', '');
    for (const source of memorySources) lines.push(describeMemorySource(source));
  }
  // 文件头写 AI 生成显式提示 + 隐式注释；用户正文与来源原样保留。
  return withAiNoteHeader(`${lines.join('\n').trimEnd()}\n`);
}

/** 预算确认/继续阅读重发同一请求时，除了问题本身还要复用的本轮口径。 */
interface QaAskExtras {
  readingScope?: 'auto' | 'local' | 'document' | 'corpus';
  readingRigor?: 'auto' | 'fast' | 'standard' | 'exhaustive';
  sourcePolicy?: 'auto' | 'document_only';
  scopeDocuments?: string[];
  scopeTags?: string[];
  includeMemory?: boolean;
  webQuery?: string;
}

interface QaAskInput extends QaAskExtras {
  question: string;
  selection?: string;
  /** 继续阅读：上次回答返回的阅读任务编号（库内检索一般不产生任务）。 */
  taskId?: string;
  confirmBudget?: boolean;
  confirmSearch?: boolean;
  confirmGapSearch?: boolean;
  searchToken?: string;
  /** 重新生成上一轮回答（不追加用户消息；服务端保留最后一条用户问题并重答）。 */
  regenerate?: boolean;
  audio?: { data: string; mimeType: string; filename?: string };
  /**
   * 语音直问标记：音频放在 voiceAudioRef，mutationFn 取一次后立即清空，
   * 避免录音 base64 随 React Query mutation 变量长期驻留。
   */
  voice?: boolean;
}

export interface QaViewProps {
  api: ApiClient;
  /** 壳适配器：会话页自身不直接调用壳能力，保留在 props 里便于与阅读页统一装配。 */
  adapter: RuntimeAdapter;
  documents: DocumentSummary[];
  /** 文献来源跳转：由父级切到阅读页并定位页码/摘引。 */
  onOpenDocument(documentId: string, page: number, quote?: string): void;
  /** 独立笔记来源跳转：由父级切到独立笔记视图。 */
  onOpenStandaloneNote(noteId: string): void;
  /** 笔记/批注来源跳转：由父级打开对应文献的笔记/批注面板。 */
  onOpenMemorySource(source: ChatSource): void;
}

/**
 * 独立会话页：不依附任何文献，直接在整个文献库提问。
 *
 * 默认由服务端走「库内检索会话」（检索原文页 + 笔记/批注后回答，不整库精读）；
 * 用户显式选「跨文献精读」时才走 corpus。
 *
 * 会话与消息存在服务端本机数据库：左侧会话栏切换/重命名/删除，首问自动建会话并生成标题；
 * 上下文由服务端按会话完整历史构建（超预算自动压缩），客户端不再传「最近 N 轮」。
 * 本机 localStorage 只记当前会话 id；旧版历史（`studianda.qa.history`）在列表为空时
 * 一次性导入为「旧版会话记录」会话。
 */
export function QaView({
  api,
  adapter,
  documents,
  onOpenDocument,
  onOpenStandaloneNote,
  onOpenMemorySource
}: QaViewProps): JSX.Element {
  const queryClient = useQueryClient();
  const [activeSessionId, setActiveSessionId] = useState<string | null>(() => readActiveSessionId());
  /** 提问过程中先显示在末尾的本地用户消息；会话详情刷新后清掉（真实消息已落库）。 */
  const [optimisticUser, setOptimisticUser] = useState<ChatMessageView | null>(null);
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  // 正在重命名的会话 id（用 ref 防止 Enter/Esc 之后 blur 再提交一次）。
  const renamingRef = useRef<string | null>(null);
  // 旧历史迁移/首次选中会话各只做一次，避免列表刷新后重复建会话或强行切走用户当前会话。
  const legacyMigratedRef = useRef(false);
  const initialSessionResolvedRef = useRef(false);
  const missingSessionHandledRef = useRef<string | null>(null);

  const [askProgress, setAskProgress] = useState<{ done: number; total: number } | null>(null);
  /** 本轮回答耗时（毫秒）：独立会话自己计时，传给 ChatPanel 显示在最后一条回答下方。 */
  const [lastAnswerDurationMs, setLastAnswerDurationMs] = useState<number | null>(null);
  const askStartedAtRef = useRef<number | null>(null);
  const [draftAnswer, setDraftAnswer] = useState('');
  const [askStage, setAskStage] = useState('');
  const [auditDraft, setAuditDraft] = useState<
    Array<{ claim: number; verdict: string; text?: string }>
  >([]);
  const [budgetWarning, setBudgetWarning] = useState<BudgetEstimate | null>(null);
  // 独立会话没有单篇文献：「不再提示」只作用于本次会话的会话页。
  const [budgetSkip, setBudgetSkip] = useState(false);
  const [lastQuestion, setLastQuestion] = useState('');
  const [lastSelection, setLastSelection] = useState('');
  const [lastExtras, setLastExtras] = useState<QaAskExtras>({});
  // 搜索计划审批凭证：预算确认/继续阅读重发同一请求时复用（服务端 10 分钟内幂等）。
  const [lastSearchToken, setLastSearchToken] = useState<string | undefined>(undefined);
  // ChatPanel 内部维护「笔记/批注」勾选；父级只记最近一次的口径，重发路径沿用它（默认勾选）。
  const [lastIncludeMemory, setLastIncludeMemory] = useState(true);
  const askAbortRef = useRef<AbortController | null>(null);
  // 待发送的语音录音（base64）：mutationFn 读取一次后立即清空，避免被 mutation 变量长期持有；
  // 录音不落库，会话里只保存转写文字（防止逐轮累积音频）。
  const voiceAudioRef = useRef<{
    data: string;
    mimeType: string;
    filename?: string;
  } | null>(null);
  // 当前乐观用户消息的 id：请求结束只清掉「这一条」，避免清掉用户刚发的下一条。
  const askedOptimisticIdRef = useRef<string | null>(null);

  // 会话搜索：输入框即时更新，查询词 250ms 防抖后再请求（避免每个按键打一次接口）。
  const [sessionSearch, setSessionSearch] = useState('');
  const [debouncedSessionSearch, setDebouncedSessionSearch] = useState('');
  // 历史分页：只缓存「更早一页」，带会话 id，切会话/产生新回答后丢弃。
  const [earlierPage, setEarlierPage] = useState<{
    sessionId: string;
    messages: QaMessageRecord[];
    hasMore: boolean;
  } | null>(null);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [earlierError, setEarlierError] = useState('');

  // 会话搜索 250ms 防抖：停手后才发一次请求。
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSessionSearch(sessionSearch.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [sessionSearch]);

  const sessionsQueryKey = useMemo(
    () => ['qa-sessions', debouncedSessionSearch] as const,
    [debouncedSessionSearch]
  );
  const sessionsQuery = useQuery({
    queryKey: sessionsQueryKey,
    queryFn: () => api.listQaSessions(debouncedSessionSearch || undefined)
  });
  const sessions = useMemo(() => sessionsQuery.data ?? [], [sessionsQuery.data]);
  const sessionQuery = useQuery({
    queryKey: ['qa-session', activeSessionId],
    queryFn: () => {
      if (!activeSessionId) return Promise.reject(new Error('没有选中的会话'));
      // 只取最新一页；更早的消息由「加载更早的消息」按 before 分页补。
      return api.getQaSession(activeSessionId, { limit: QA_MESSAGE_PAGE_SIZE });
    },
    // 没有选中会话（新建对话尚未提问）时不请求详情。
    enabled: Boolean(activeSessionId)
  });
  const latestMessages = useMemo(() => sessionQuery.data?.messages ?? [], [sessionQuery.data]);
  /** 当前会话已加载的更早消息（切会话/产生新回答后清空）。 */
  const earlierMessages = useMemo(
    () => (earlierPage && earlierPage.sessionId === activeSessionId ? earlierPage.messages : []),
    [earlierPage, activeSessionId]
  );
  const sessionRecords = useMemo<QaMessageRecord[]>(() => {
    if (earlierMessages.length === 0) return latestMessages;
    const seen = new Set<number>();
    const merged: QaMessageRecord[] = [];
    for (const record of [...earlierMessages, ...latestMessages]) {
      if (seen.has(record.id)) continue;
      seen.add(record.id);
      merged.push(record);
    }
    // 分页边界不应重叠；排序只是兜底，保证「更早 → 最新」。
    merged.sort((left, right) => left.id - right.id);
    return merged;
  }, [earlierMessages, latestMessages]);
  const sessionMessages = useMemo<ChatMessageView[]>(
    () => sessionRecords.map(toMessageView),
    [sessionRecords]
  );
  /** 还有更早的消息：未加载过更早一页时用最新一页的 hasMore，加载过就用那一页的 hasMore。 */
  const hasEarlier =
    earlierMessages.length > 0
      ? Boolean(earlierPage?.hasMore)
      : Boolean(sessionQuery.data?.hasMore);
  /** 提问中把乐观用户消息接在列表末尾；详情刷新后由真实消息替换。 */
  const messages = useMemo<ChatMessageView[]>(
    () => (optimisticUser ? [...sessionMessages, optimisticUser] : sessionMessages),
    [sessionMessages, optimisticUser]
  );
  const activeSession = useMemo(
    () => sessions.find((item) => item.id === activeSessionId) ?? null,
    [sessions, activeSessionId]
  );
  /** 当前会话标题：搜索过滤后列表可能不含它，优先用详情里的会话记录。 */
  const activeSessionTitle =
    sessionQuery.data?.session.title.trim() || activeSession?.title.trim() || '';

  // 记住当前会话：刷新后回到上次打开的会话；空值表示「新对话」。
  useEffect(() => {
    try {
      if (activeSessionId) {
        window.localStorage.setItem(QA_ACTIVE_SESSION_STORAGE_KEY, activeSessionId);
      } else {
        window.localStorage.removeItem(QA_ACTIVE_SESSION_STORAGE_KEY);
      }
    } catch {
      // 本地存储不可用时只保留当前会话。
    }
  }, [activeSessionId]);

  // 切换会话：丢弃上一会话加载过的更早消息与加载错误（新会话从自己最新一页开始）。
  useEffect(() => {
    setEarlierPage(null);
    setEarlierError('');
    setLoadingEarlier(false);
  }, [activeSessionId]);

  // 会话列表首次加载后校正选中项：存的 id 还在就用它，否则用列表第一个，列表为空则 null。
  useEffect(() => {
    if (initialSessionResolvedRef.current || !sessionsQuery.isSuccess) return;
    // 搜索态不自动校正选中会话：列表变化只是过滤结果，不代表用户要切换会话。
    if (debouncedSessionSearch) return;
    initialSessionResolvedRef.current = true;
    const list = sessionsQuery.data ?? [];
    setActiveSessionId((current) => {
      if (current && list.some((item) => item.id === current)) return current;
      return list[0]?.id ?? null;
    });
  }, [sessionsQuery.isSuccess, sessionsQuery.data, debouncedSessionSearch]);

  // 旧版本地历史迁移：只在会话列表为空时做一次，导入成功后删除旧键。
  useEffect(() => {
    if (!sessionsQuery.isSuccess || legacyMigratedRef.current) return;
    // 搜索态列表本来就可能为空/不全，不据此判断「没有会话」。
    if (debouncedSessionSearch) return;
    if ((sessionsQuery.data ?? []).length > 0) {
      legacyMigratedRef.current = true;
      return;
    }
    const legacyMessages = readLegacyQaHistory();
    if (legacyMessages.length === 0) {
      legacyMigratedRef.current = true;
      return;
    }
    legacyMigratedRef.current = true;
    void (async () => {
      let createdSessionId: string | null = null;
      try {
        const created = await api.createQaSession(LEGACY_QA_SESSION_TITLE);
        createdSessionId = created.id;
        // 分批顺序导入：每批 40 条，全部成功后才删除旧键（失败保留旧键下次重试）。
        let lastImported: QaSessionDetail | null = null;
        for (let index = 0; index < legacyMessages.length; index += LEGACY_QA_IMPORT_BATCH_SIZE) {
          const batch = legacyMessages
            .slice(index, index + LEGACY_QA_IMPORT_BATCH_SIZE)
            .map(toImportedMessage);
          lastImported = await api.importQaMessages(created.id, batch);
        }
        if (!lastImported) throw new Error('没有可导入的旧历史');
        try {
          window.localStorage.removeItem(QA_HISTORY_STORAGE_KEY);
        } catch {
          // 旧键删除失败时仍按已迁移处理，下次启动列表非空就不会再导入。
        }
        queryClient.setQueryData(['qa-session', lastImported.session.id], lastImported);
        // 迁移后进入新会话：清掉计时，避免把启动前的空状态带到界面上。
        askStartedAtRef.current = null;
        setLastAnswerDurationMs(null);
        setActiveSessionId(lastImported.session.id);
        void queryClient.invalidateQueries({ queryKey: ['qa-sessions'] });
      } catch (error) {
        // 迁移失败不弹窗打断会话：保留旧键，下次打开应用还会再试。
        console.warn('旧版会话历史迁移失败：', error);
        if (createdSessionId) {
          try {
            await api.deleteQaSession(createdSessionId);
          } catch {
            // 清理空会话失败时留给下次启动重试。
          }
        }
      }
    })();
  }, [sessionsQuery.isSuccess, sessionsQuery.data, debouncedSessionSearch, api, queryClient]);

  // 会话在别处被删除（详情 404）时回退到列表第一个，不让页面停在一个打不开的会话上。
  useEffect(() => {
    if (!sessionQuery.isError || !activeSessionId) return;
    const error = sessionQuery.error;
    if (!(error instanceof ApiRequestError) || error.status !== 404) return;
    if (missingSessionHandledRef.current === activeSessionId) return;
    missingSessionHandledRef.current = activeSessionId;
    void (async () => {
      try {
        await queryClient.invalidateQueries({ queryKey: ['qa-sessions'] });
        const list = queryClient.getQueryData<QaSessionSummary[]>(sessionsQueryKey) ?? [];
        // 会话已不存在：当前界面的耗时不适用新会话，清掉。恢复历史后点击「上一轮」也没有本轮计时。
        askStartedAtRef.current = null;
        setLastAnswerDurationMs(null);
        setActiveSessionId((current) => {
          if (current && list.some((item) => item.id === current)) return current;
          return list[0]?.id ?? null;
        });
      } catch {
        // 列表刷新失败时保留错误提示，用户仍可手动切换会话。
      }
    })();
  }, [sessionQuery.isError, sessionQuery.error, activeSessionId, queryClient, sessionsQueryKey]);

  const resetDraft = (): void => {
    setDraftAnswer('');
    setAskStage('');
    setAuditDraft([]);
  };

  /** 清掉只属于「当前这一轮提问」的本地状态（切换/新建/删除会话时用）。 */
  const resetAskState = (): void => {
    askMutation.reset();
    resetDraft();
    setBudgetWarning(null);
    askedOptimisticIdRef.current = null;
    setOptimisticUser(null);
    askStartedAtRef.current = null;
    setLastAnswerDurationMs(null);
    // 消息被编辑/删除或切会话后，已加载的更早分页可能失效：回到最新一页。
    setEarlierPage(null);
    setEarlierError('');
    setLoadingEarlier(false);
    setLastQuestion('');
    setLastSelection('');
    setLastExtras({});
    setLastSearchToken(undefined);
  };

  /** 收起内联重命名输入框（切换/新建/删除会话时）。 */
  const closeRenameEditor = (): void => {
    renamingRef.current = null;
    setEditingSessionId(null);
    setRenameDraft('');
  };

  const askMutation = useMutation({
    mutationFn: (input: QaAskInput) => {
      const controller = new AbortController();
      askAbortRef.current = controller;
      // 语音直问的录音只在这里取一次并立即清空：不放进 mutation 变量，
      // 避免上一次录音的 base64 长期驻留内存；录音不落库，只有转写文字进入会话。
      const voiceAudio = input.voice ? voiceAudioRef.current ?? undefined : input.audio;
      if (input.voice) voiceAudioRef.current = null;
      // 每轮提问都重新计时（预算确认/继续阅读/重新生成的重发也一样）。
      askStartedAtRef.current = performance.now();
      setLastAnswerDurationMs(null);
      const request: ChatRequest = {
        // 独立会话故意不带 documentId：服务端据此走库内检索（而不是"读当前文献"）。
        question: input.question,
        selection: input.selection || undefined,
        taskId: input.taskId,
        confirmSearch: input.confirmSearch,
        search_token: input.searchToken,
        confirm_gap_search: input.confirmGapSearch,
        audio: voiceAudio,
        // auto 即「库内检索会话」；只有用户显式选跨文献精读才传 corpus。
        reading_scope: input.readingScope,
        reading_rigor: input.readingRigor,
        source_policy: input.sourcePolicy,
        scope_documents: input.scopeDocuments,
        scope_tags: input.scopeTags,
        include_memory: input.includeMemory,
        web_query: input.webQuery,
        confirm_budget: input.confirmBudget,
        // 会话上下文由服务端按完整历史拼：不传 history，也不传「最近 N 轮」。
        // 没有选中会话时缺省，服务端会新建一个并在响应里返回 qa_session_id。
        qa_session_id: activeSessionId ?? undefined,
        // 重新生成：服务端删除该会话最后一条助手消息、保留最后的用户问题并重答。
        qa_regenerate: input.regenerate === true ? true : undefined
      };
      return api
        .askStream(request, {
          signal: controller.signal,
          onProgress: (done, total) => setAskProgress({ done, total }),
          onDraft: (text) => setDraftAnswer((current) => current + text),
          onDraftReset: () => setDraftAnswer(''),
          onStage: (text) => setAskStage(text),
          onAudit: (claims) =>
            setAuditDraft(
              claims.map((claim) => {
                const item = claim as {
                  claim?: number;
                  verdict?: string;
                  text?: string;
                };
                return {
                  claim: Number(item.claim ?? 0),
                  verdict: String(item.verdict ?? ''),
                  text: item.text
                };
              })
            )
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) throw new Error('已取消会话');
          throw error;
        })
        .finally(() => {
          setAskProgress(null);
          if (askAbortRef.current === controller) askAbortRef.current = null;
        });
    },
    onSuccess: (response) => {
      if (response.needs_confirmation && response.budget) {
        // 预算确认不是回答：不追加空助手消息，清掉草稿/阶段/审计，等用户确认后重发。
        askStartedAtRef.current = null;
        setBudgetWarning(response.budget);
        resetDraft();
        return;
      }
      setBudgetWarning(null);
      resetDraft();
      // 语音直问：全模态模型返回逐字转写后，先把乐观用户消息显示成「（语音）转写」；
      // 服务端已把持久化的用户消息补写成同样内容，随后刷新会话详情会保持一致。
      const audioTranscript =
        typeof response.audio_transcript === 'string' ? response.audio_transcript.trim() : '';
      if (audioTranscript) {
        setOptimisticUser((current) =>
          current ? { ...current, content: `（语音）${audioTranscript}` } : current
        );
      }
      // 本轮回答耗时：从 mutationFn 开始算到拿到完整响应（预算确认重发会重新计时）。
      const answerStartedAt = askStartedAtRef.current;
      askStartedAtRef.current = null;
      setLastAnswerDurationMs(
        answerStartedAt === null ? null : performance.now() - answerStartedAt
      );
      // 产生了新回答：之前加载过的更早消息可能因分页窗口移动而失效，回到最新一页。
      setEarlierPage(null);
      setEarlierError('');
      void queryClient.invalidateQueries({ queryKey: ['qa-sessions'] });
      // 只清「这一条」乐观消息：若用户在详情刷新完成前又发了一问，不能把新消息抹掉。
      const optimisticId = askedOptimisticIdRef.current;
      const responseSessionId =
        typeof response.qa_session_id === 'string' && response.qa_session_id.trim()
          ? response.qa_session_id
          : null;
      void (async () => {
        try {
          if (responseSessionId && responseSessionId !== activeSessionId) {
            // 首问自动建会话：先切过去（乐观消息先占位，不会闪空白），再取回完整详情。
            setActiveSessionId(responseSessionId);
            await queryClient.fetchQuery({
              queryKey: ['qa-session', responseSessionId],
              queryFn: () => api.getQaSession(responseSessionId),
              staleTime: 0
            });
          } else if (activeSessionId) {
            await queryClient.invalidateQueries({
              queryKey: ['qa-session', activeSessionId]
            });
          }
        } catch {
          // 详情刷新失败不影响已经拿到的回答：切到正确的会话由下次进入时恢复。
        } finally {
          if (optimisticId) {
            if (askedOptimisticIdRef.current === optimisticId) {
              askedOptimisticIdRef.current = null;
            }
            setOptimisticUser((current) => (current?.id === optimisticId ? null : current));
          }
        }
      })();
    },
    onError: (error: Error) => {
      askStartedAtRef.current = null;
      setLastAnswerDurationMs(null);
      if (error instanceof ApiRequestError && error.status === 409) {
        const details = error.details as { budget?: BudgetEstimate } | undefined;
        if (details?.budget) {
          setBudgetWarning(details.budget);
          return;
        }
      }
      setBudgetWarning(null);
      resetDraft();
      const optimisticId = askedOptimisticIdRef.current;
      askedOptimisticIdRef.current = null;
      setOptimisticUser((current) => (optimisticId && current?.id === optimisticId ? null : current));
      void (async () => {
        try {
          await queryClient.invalidateQueries({ queryKey: ['qa-sessions'] });
          if (!activeSessionId) {
            // 服务端可能已经建了会话并落了失败占位消息：切到最近使用的那个。
            const list = queryClient.getQueryData<QaSessionSummary[]>(sessionsQueryKey) ?? [];
            const latest = list[0];
            if (latest) setActiveSessionId(latest.id);
            return;
          }
          await queryClient.invalidateQueries({ queryKey: ['qa-session', activeSessionId] });
        } catch {
          // 刷新失败时保留当前界面，失败原因已显示在输入区上方。
        }
      })();
    }
  });

  const renameMutation = useMutation({
    mutationFn: (input: { id: string; title: string }) =>
      api.renameQaSession(input.id, input.title),
    onSuccess: (updated) => {
      void queryClient.invalidateQueries({ queryKey: ['qa-sessions'] });
      void queryClient.invalidateQueries({ queryKey: ['qa-session', updated.id] });
    }
  });

  /** 置顶/取消置顶：服务端列表排序 pinned DESC，成功后刷新列表与当前会话。失败留给按钮重试。 */
  const pinSessionMutation = useMutation({
    mutationFn: (input: { id: string; pinned: boolean }) =>
      api.setQaSessionPinned(input.id, input.pinned),
    onSuccess: (updated) => {
      void queryClient.invalidateQueries({ queryKey: ['qa-sessions'] });
      void queryClient.invalidateQueries({ queryKey: ['qa-session', updated.id] });
    }
  });

  const deleteSessionMutation = useMutation({
    mutationFn: (id: string) => api.deleteQaSession(id),
    onSuccess: (_result, id) => {
      const remaining = sessions.filter((item) => item.id !== id);
      if (editingSessionId === id) closeRenameEditor();
      if (id === activeSessionId) {
        // 删除当前会话：清掉这一轮的重发口径，再切到列表第一个（或空态）。
        askAbortRef.current?.abort();
        resetAskState();
        const next = remaining[0];
        setActiveSessionId(next ? next.id : null);
      }
      queryClient.removeQueries({ queryKey: ['qa-session', id] });
      void queryClient.invalidateQueries({ queryKey: ['qa-sessions'] });
    }
  });

  /** 切换会话：清掉上一轮的重发口径与预算提示，避免把问题带到别的会话。 */
  const selectSession = (id: string): void => {
    if (id === activeSessionId) return;
    if (askMutation.isPending) return;
    askAbortRef.current?.abort();
    closeRenameEditor();
    resetAskState();
    setActiveSessionId(id);
  };

  /** 新对话：不立即建库行，首问时服务端自动建会话（能避免点开又放弃留下空会话）。 */
  const startNewConversation = (): void => {
    if (askMutation.isPending) return;
    askAbortRef.current?.abort();
    closeRenameEditor();
    resetAskState();
    setActiveSessionId(null);
  };

  const beginRename = (session: QaSessionSummary): void => {
    if (askMutation.isPending) return;
    renamingRef.current = session.id;
    setEditingSessionId(session.id);
    setRenameDraft(session.title);
  };

  /**
   * 结束内联重命名。
   *
   * commit=false（Esc）直接放弃；空标题/标题没变也只收起输入框。
   * 用 ref 记录正在改的会话，保证 Enter/Esc 之后可能出现的 blur 不会再提交一次。
   */
  const finishRename = (commit: boolean): void => {
    const id = renamingRef.current;
    if (!id) return;
    renamingRef.current = null;
    const title = renameDraft.trim();
    setEditingSessionId(null);
    setRenameDraft('');
    if (!commit || !title) return;
    const existing = sessions.find((item) => item.id === id);
    if (existing && existing.title.trim() === title) return;
    renameMutation.mutate({ id, title });
  };

  const requestDeleteSession = (sessionId: string, title: string): void => {
    if (askMutation.isPending || deleteSessionMutation.isPending) return;
    const safeTitle = title.trim() || '新对话';
    if (
      !appDialogs.confirm(`删除会话「${safeTitle}」？会话与全部消息会从本机数据库删除，不能恢复。`)
    ) {
      return;
    }
    deleteSessionMutation.mutate(sessionId);
  };

  /** 工具栏「删除会话」：只对当前会话，且有消息时才可用（空会话删起来没有意义）。 */
  const requestDeleteActiveSession = (): void => {
    if (!activeSessionId || sessionMessages.length === 0) return;
    requestDeleteSession(activeSessionId, activeSessionTitle);
  };

  /** 「加载更早的消息」：用当前最早消息 id 作为 before 取上一页，拼到消息流最前面。 */
  const loadEarlier = (): void => {
    // 提问中不翻页：新回答成功后本来也会回到最新页，翻了也会被重置。
    if (!activeSessionId || loadingEarlier || askMutation.isPending) return;
    const earliest = sessionRecords[0];
    if (!earliest) return;
    const sessionId = activeSessionId;
    const before = earliest.id;
    setLoadingEarlier(true);
    setEarlierError('');
    void (async () => {
      try {
        const page = await api.getQaSession(sessionId, {
          limit: QA_MESSAGE_PAGE_SIZE,
          before
        });
        setEarlierPage((current) => {
          const base = current && current.sessionId === sessionId ? current.messages : [];
          const seen = new Set(base.map((item) => item.id));
          const merged = [
            ...page.messages.filter((item) => !seen.has(item.id)),
            ...base
          ].sort((left, right) => left.id - right.id);
          return { sessionId, messages: merged, hasMore: page.hasMore === true };
        });
      } catch (error) {
        setEarlierError(error instanceof Error ? error.message : '未知错误');
      } finally {
        setLoadingEarlier(false);
      }
    })();
  };

  /**
   * 「存为笔记」：优先存到回答引用的第一篇文献页（带摘引/定位），否则存独立笔记。
   *
   * externalKey 用「会话 id + 消息 id」做幂等键：同一轮回答重复保存/刷新后再保存，
   * 服务端按 documentId + externalKey 返回已有笔记，不会新增重复笔记。
   * 失败直接抛给 ChatPanel 显示「保存失败，重试」，不弹窗打断。
   */
  const saveAnswerAsNote = async (message: ChatMessageView): Promise<void> => {
    const content = buildAnswerNoteMarkdown(message);
    const externalKey = activeSessionId
      ? `chat-answer:${activeSessionId}:${message.id}`
      : undefined;
    const withExternalKey = externalKey ? { externalKey } : {};
    const sources = message.response?.sources ?? [];
    const documentSource = sources.find(
      (source) => source.kind !== 'web' && Boolean(source.documentId) && source.page > 0
    );
    if (documentSource?.documentId) {
      const documentId = documentSource.documentId;
      const quote =
        documentSource.locate ||
        documentSource.quotes?.[0] ||
        documentSource.snippet?.slice(0, 200) ||
        '';
      await api.createNote({
        documentId,
        page: documentSource.page,
        quote,
        content,
        ...withExternalKey
      });
      void queryClient.invalidateQueries({ queryKey: ['notes', documentId] });
      return;
    }
    // 独立笔记（documentId 为空）：同样带 externalKey 去重。
    // 这里走 createNote 而不是 createStandaloneNote，因为只有前者能携带 externalKey。
    await api.createNote({
      documentId: '',
      page: 0,
      content,
      ...withExternalKey
    });
    void queryClient.invalidateQueries({ queryKey: ['standalone-notes'] });
  };

  /**
   * 「编辑并重问」：服务端把这条 user 消息改成新内容并删除其后所有消息，随后重问。
   *
   * 重问走 regenerate 链路（服务端保留最后一条 user 即刚编辑的这条、不重复记用户消息），
   * 普通提问会再追加一条重复的 user 消息，所以这里不用普通 ask。
   * 失败直接抛回 ChatPanel 显示「失败：…」，可重试。
   */
  const editUserMessage = async (message: ChatMessageView, content: string): Promise<void> => {
    if (!activeSessionId) throw new Error('没有选中的会话');
    const sessionId = activeSessionId;
    const messageId = Number(message.id);
    if (!Number.isInteger(messageId) || messageId <= 0) {
      throw new Error('这条消息还没有保存，不能编辑');
    }
    const trimmed = content.trim();
    if (!trimmed) throw new Error('内容不能为空');
    askAbortRef.current?.abort();
    await api.editQaMessage(sessionId, messageId, trimmed);
    // 编辑成功：清掉本轮旧状态与分页缓存，先刷新详情（显示新内容），再按新内容重问。
    resetAskState();
    setLastQuestion(trimmed);
    setLastExtras({ includeMemory: lastIncludeMemory });
    await queryClient.invalidateQueries({ queryKey: ['qa-session', sessionId] });
    void queryClient.invalidateQueries({ queryKey: ['qa-sessions'] });
    askMutation.mutate({
      question: trimmed,
      regenerate: true,
      includeMemory: lastIncludeMemory
    });
  };

  /** 「删除此轮及之后」：删掉该 user 消息及其后全部消息；不自动重问。 */
  const deleteFromMessage = async (message: ChatMessageView): Promise<void> => {
    if (!activeSessionId) throw new Error('没有选中的会话');
    const sessionId = activeSessionId;
    const messageId = Number(message.id);
    if (!Number.isInteger(messageId) || messageId <= 0) {
      throw new Error('这条消息还没有保存，不能删除');
    }
    askAbortRef.current?.abort();
    await api.deleteQaMessagesFrom(sessionId, messageId);
    // 清空草稿/预算/乐观消息/耗时与分页缓存。
    resetAskState();
    // 本地先过滤掉该消息及之后，避免详情刷新前后残留半截历史。
    queryClient.setQueryData<QaSessionDetail>(['qa-session', sessionId], (current) =>
      current
        ? { ...current, messages: current.messages.filter((item) => item.id < messageId) }
        : current
    );
    void queryClient.invalidateQueries({ queryKey: ['qa-session', sessionId] });
    void queryClient.invalidateQueries({ queryKey: ['qa-sessions'] });
  };

  const searchConfigQuery = useQuery({
    queryKey: ['search-config'],
    queryFn: () => api.getSearchConfig()
  });
  const speechConfigQuery = useQuery({
    queryKey: ['speech-config'],
    queryFn: () => api.getSpeechConfig()
  });
  const speakMutation = useMutation({
    mutationFn: (text: string) => api.speak(text),
    onSuccess: (blob) => {
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.onended = () => URL.revokeObjectURL(url);
      void audio.play().catch(() => URL.revokeObjectURL(url));
    },
    onError: (error: Error) => {
      appDialogs.alert(`语音播报失败：${error.message}`);
    }
  });
  // 语音按钮是否可用：环境能力 + 设置里的语音输入开关 + 识别服务是否配好。
  // 与阅读内一致：不可用时按钮保持可见但禁用，原因显示在输入框旁。
  const speechRecordingSupport = mediaRecordingSupport();
  const speechInputDisabledReason = ((): string | null => {
    if (!speechRecordingSupport.supported) return speechRecordingSupport.message;
    const speechConfig = speechConfigQuery.data;
    if (!speechConfig) return null;
    if (!speechConfig.input_enabled) return '语音输入未开启：请到设置 → 语音识别里开启';
    // 直接语音（全模态）由模型自己转写，不依赖本地 ASR 是否已配置；只有普通
    // 「语音转文字填入输入框」才要求识别服务可用。
    if (!speechConfig.direct_audio && speechConfig.asr_mode !== 'system' && !speechConfig.has_asr_key) {
      return '还没有可用的语音识别模型：请在设置 → 语音识别里填写识别服务与密钥';
    }
    return null;
  })();

  // 恢复历史会话时，sources/notice/继续按钮要能照常使用：退回该会话最后一条助手回答。
  // mutation 的最新响应只在本轮仍属于当前会话时优先，避免切会话后沿用别的会话的 taskId。
  const lastAssistantResponse = useMemo(
    () =>
      [...sessionMessages]
        .reverse()
        .find((message) => message.role === 'assistant' && message.response)?.response,
    [sessionMessages]
  );
  const chatData = useMemo((): ChatResponse | undefined => {
    const raw = askMutation.data;
    if (!raw || raw.needs_confirmation) return lastAssistantResponse;
    const rawSessionId = typeof raw.qa_session_id === 'string' ? raw.qa_session_id : '';
    if (rawSessionId && activeSessionId && rawSessionId !== activeSessionId) {
      return lastAssistantResponse;
    }
    return raw;
  }, [askMutation.data, activeSessionId, lastAssistantResponse]);

  // 重新生成：用该会话最后一条用户问题重答（服务端会保留它并删掉最后一条助手消息）。
  const lastUserMessage = useMemo(
    () => [...sessionMessages].reverse().find((message) => message.role === 'user'),
    [sessionMessages]
  );

  const handleAsk: ChatPanelProps['onAsk'] = (question, options) => {
    // 独立会话不依附页：问题原样发送，不做「当前页」这类页码归一。
    const includeMemory = options?.includeMemory ?? lastIncludeMemory;
    const extras: QaAskExtras = {
      readingScope: options?.readingScope,
      readingRigor: options?.readingRigor,
      sourcePolicy: options?.sourcePolicy,
      scopeDocuments: options?.scopeDocuments,
      scopeTags: options?.scopeTags,
      includeMemory,
      webQuery: options?.webQuery
    };
    setLastQuestion(question);
    setLastSelection('');
    setLastExtras(extras);
    setLastIncludeMemory(includeMemory);
    setLastSearchToken(options?.search_token);
    setBudgetWarning(null);
    resetDraft();
    // 先本地追加用户消息：等待回答时能看到自己刚问的问题（请求结束后由落库消息替换）。
    const optimisticId = `local-${crypto.randomUUID()}`;
    askedOptimisticIdRef.current = optimisticId;
    setOptimisticUser({ id: optimisticId, role: 'user', content: question });
    askMutation.mutate({
      question,
      confirmBudget: budgetSkip,
      confirmSearch: options?.confirmSearch,
      searchToken: options?.search_token,
      confirmGapSearch: options?.confirmGapSearch,
      ...extras
    });
  };

  const handleAskAudio = async (audio: Blob): Promise<void> => {
    // 直接语音（全模态）：先转成 16k 单声道 WAV 再发送——webm/opus 多数全模态接口不支持，
    // 之前直接把 webm + `data:` 前缀发出去会 400。转换失败就退回原始录音，不阻断提问。
    // 语音转写由全模态模型完成（不再在客户端先跑 ASR）；转写会随响应 audio_transcript 回来。
    let payload = audio;
    try {
      payload = await blobToWav(audio);
    } catch {
      payload = audio;
    }
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(payload);
    });
    const comma = dataUrl.indexOf(',');
    const data = comma >= 0 ? dataUrl.slice(comma + 1) : '';
    if (!data) return;
    setLastQuestion('（语音直接输入）');
    setBudgetWarning(null);
    resetDraft();
    const optimisticId = `local-${crypto.randomUUID()}`;
    askedOptimisticIdRef.current = optimisticId;
    // 先显示占位；服务端在模型返回逐字转写后把会话里的用户消息补写成「（语音）转写」，
    // 本轮响应也会带 audio_transcript，这里在 onSuccess 里同步更新乐观消息。
    setOptimisticUser({ id: optimisticId, role: 'user', content: '（语音提问）' });
    // 音频只放进 ref，由 mutationFn 取一次并清空（不随 mutation 变量驻留）。
    voiceAudioRef.current = {
      data,
      mimeType: payload.type || 'audio/webm',
      filename: payload.type.includes('wav') ? 'speech.wav' : 'speech.webm'
    };
    askMutation.mutate({
      // 不再传文字问题：转写由全模态模型完成（服务端会先落占位，成功后补写正文）。
      question: '',
      confirmSearch: false,
      includeMemory: lastIncludeMemory,
      voice: true
    });
  };

  /** 联网来源优先交给壳打开系统浏览器；宿主不支持时退回浏览器新窗口。 */
  const openWebSource = async (url: string): Promise<void> => {
    if (adapter.openExternal) {
      const result = await adapter.openExternal(url);
      if (result.ok) return;
    }
    // 宿主未提供 openExternal 时的兜底：浏览器新窗口（globalThis.open 便于测试替换）。
    globalThis.open?.(url, '_blank', 'noopener,noreferrer');
  };

  const openSource = (source: ChatSource): void => {
    // 联网来源现在会作为结构化 sources 返回：用系统浏览器/新窗口打开，不当作文献页。
    if (source.kind === 'web' && source.url) {
      void openWebSource(source.url);
      return;
    }
    if (source.kind === 'note' || source.kind === 'annotation') {
      // 独立笔记来源（documentId 为空）→ 独立笔记视图；
      // 文献笔记/批注 → 交给父级打开对应文献页并展开笔记/批注面板。
      if (!source.documentId && source.memoryId) {
        onOpenStandaloneNote(source.memoryId);
        return;
      }
      onOpenMemorySource(source);
      return;
    }
    onOpenDocument(source.documentId, source.page, source.quotes?.[0] ?? source.anchor ?? source.locate);
  };

  const asking = askMutation.isPending;
  // 会话压缩摘要：服务端把更早轮次压成摘要后，把摘要正文与覆盖范围如实展示给用户。
  // 详情查询按 activeSessionId 缓存，切换会话时自动换成新会话的摘要（没有就整块不渲染）。
  const sessionRecord = sessionQuery.data?.session;
  const contextSummary = sessionRecord?.contextSummary.trim() ?? '';
  const summaryCoveredMessages = (() => {
    const upto = sessionRecord ? Math.trunc(sessionRecord.summaryUpto) : 0;
    if (Number.isFinite(upto) && upto > 0) return upto;
    // 旧数据可能只存了摘要没有 summaryUpto：用消息条数近似覆盖范围，措辞仍注明是「覆盖前 N 条」。
    return sessionRecord ? sessionRecord.messageCount : 0;
  })();
  const sessionActionError = renameMutation.isError
    ? renameMutation.error.message
    : deleteSessionMutation.isError
      ? deleteSessionMutation.error.message
      : pinSessionMutation.isError
        ? pinSessionMutation.error.message
        : '';
  const sessionListHint = sessionActionError ? `会话操作失败：${sessionActionError}` : '';

  const renderSessionItem = (session: QaSessionSummary): JSX.Element => {
    const title = session.title.trim() || '新对话';
    const updatedLabel = formatSessionTime(session.updatedAt);
    if (editingSessionId === session.id) {
      return (
        <div className="kr-qa__session is-editing" key={session.id}>
          <input
            className="kr-qa__session-edit"
            value={renameDraft}
            autoFocus
            aria-label="会话标题"
            onChange={(event) => setRenameDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                finishRename(true);
              } else if (event.key === 'Escape') {
                event.preventDefault();
                finishRename(false);
              }
            }}
            onBlur={() => {
              // Enter/Esc 已结束重命名时 renamingRef 为空，blur 不会再提交一次。
              if (renamingRef.current) finishRename(true);
            }}
          />
        </div>
      );
    }
    const isActive = session.id === activeSessionId;
    return (
      <div className={`kr-qa__session${isActive ? ' is-active' : ''}`} key={session.id}>
        <button
          type="button"
          className="kr-qa__session-main"
          onClick={() => selectSession(session.id)}
          onDoubleClick={() => beginRename(session)}
          disabled={asking}
          title={`打开会话：${title}`}
          aria-current={isActive ? 'true' : undefined}
        >
          <span className="kr-qa__session-title">{title}</span>
          <span className="kr-qa__session-meta">
            {session.messageCount} 条消息{updatedLabel ? ` · ${updatedLabel}` : ''}
          </span>
        </button>
        {session.compacted ? (
          <span className="kr-qa__session-badge" title="更早轮次已压缩为摘要">
            已压缩
          </span>
        ) : null}
        {session.pinned ? (
          <span
            className="kr-qa__session-badge kr-qa__session-badge--pinned"
            title="已置顶：列表里排在最前"
          >
            置顶
          </span>
        ) : null}
        <span className="kr-qa__session-actions">
          <button
            type="button"
            className={session.pinned ? 'is-pinned' : undefined}
            onClick={() =>
              pinSessionMutation.mutate({ id: session.id, pinned: !session.pinned })
            }
            disabled={asking || pinSessionMutation.isPending}
            title={session.pinned ? '取消置顶' : '置顶会话（排序时排在最前）'}
            aria-label={`${session.pinned ? '取消置顶' : '置顶'}会话：${title}`}
            aria-pressed={session.pinned}
          >
            {session.pinned ? '取消置顶' : '置顶'}
          </button>
          <button
            type="button"
            onClick={() => beginRename(session)}
            disabled={asking}
            title="重命名会话（也可双击会话名）"
            aria-label={`重命名会话：${title}`}
          >
            改名
          </button>
          <button
            type="button"
            className="is-danger"
            onClick={() => requestDeleteSession(session.id, title)}
            disabled={asking || deleteSessionMutation.isPending}
            title="删除会话（不可恢复）"
            aria-label={`删除会话：${title}`}
          >
            删除
          </button>
        </span>
      </div>
    );
  };

  return (
    <section className="kr-qa" aria-label="独立会话">
      {documents.length === 0 ? (
        <p className="kr-qa__empty">
          文献库还是空的：仍可以直接提问（联网/模型知识），但库内检索暂时没有可检索的文献页与笔记。
        </p>
      ) : null}
      <div className="kr-qa__layout">
        <aside className="kr-qa__sessions" aria-label="会话列表">
          <div className="kr-qa__sessions-head">
            <span className="kr-qa__sessions-title">会话</span>
            <button
              type="button"
              className="kr-qa__new"
              onClick={startNewConversation}
              disabled={asking}
              title="开始一个新对话（首问后自动保存为新会话）"
            >
              ＋ 新对话
            </button>
          </div>
          <div className="kr-qa__sessions-search">
            <input
              type="search"
              value={sessionSearch}
              onChange={(event) => setSessionSearch(event.target.value)}
              placeholder="搜索会话…"
              aria-label="搜索会话（标题或消息内容）"
              title="按标题或消息内容搜索会话"
            />
          </div>
          <div className="kr-qa__session-list">
            {sessionsQuery.isLoading ? (
              <p className="kr-qa__sessions-hint" role="status">
                正在加载会话…
              </p>
            ) : null}
            {sessionsQuery.isError ? (
              <div className="kr-qa__sessions-hint">
                <p>会话列表加载失败：{sessionsQuery.error.message}</p>
                <button
                  type="button"
                  className="kr-qa__new"
                  onClick={() => void sessionsQuery.refetch()}
                >
                  重试
                </button>
              </div>
            ) : null}
            {sessionListHint ? <p className="kr-qa__sessions-hint">{sessionListHint}</p> : null}
            {sessionsQuery.isSuccess ? (
              <>
                {activeSessionId === null ? (
                  <div
                    className="kr-qa__session kr-qa__session--draft is-active"
                    aria-current="true"
                  >
                    <span className="kr-qa__session-title">新对话</span>
                    <span className="kr-qa__session-meta">提问后自动保存</span>
                  </div>
                ) : null}
                {sessions.length === 0 ? (
                  <p className="kr-qa__sessions-hint">
                    {debouncedSessionSearch
                      ? `没有匹配「${debouncedSessionSearch}」的会话。`
                      : '还没有会话：直接提问会自动新建一个。'}
                  </p>
                ) : null}
                {sessions.map(renderSessionItem)}
              </>
            ) : null}
          </div>
        </aside>
        <div className="kr-qa__panel">
          {contextSummary ? (
            <details className="kr-qa__summary">
              <summary title="摘要覆盖更早的轮次；覆盖条数按服务端记录的消息范围近似，仅供了解上下文范围。">
                {summaryCoveredMessages > 0
                  ? `已压缩早期历史（覆盖前 ${summaryCoveredMessages} 条消息）`
                  : '已压缩早期历史'}
              </summary>
              <div className="kr-qa__summary-body">
                <p className="kr-qa__summary-text">{contextSummary}</p>
                <p className="kr-qa__summary-note">
                  AI 生成（会话模型）· 可能出错；摘要只是上下文，不是文献原文/证据；后续轮次模型
                  看到的是这份摘要 + 未被压缩的消息原文。
                </p>
              </div>
            </details>
          ) : null}
          {sessionQuery.isLoading && activeSessionId ? (
            <p className="kr-qa__loading" role="status">
              正在加载会话…
            </p>
          ) : null}
          {earlierError ? (
            <p className="kr-page-error">加载更早消息失败：{earlierError}</p>
          ) : null}
          <ChatPanel
            confirmAction={appDialogs.confirm}
            toolbarExtra={
              <>
                <button
                  type="button"
                  className="kr-qa__clear"
                  onClick={requestDeleteActiveSession}
                  disabled={asking || !activeSessionId || sessionMessages.length === 0}
                  title="删除当前会话（会话与消息从本机数据库删除，不能恢复）"
                >
                  删除会话
                </button>
                <button
                  type="button"
                  className="kr-qa__clear"
                  onClick={startNewConversation}
                  disabled={asking}
                  title="开始一个新对话（首问后自动保存为新会话）"
                >
                  新对话
                </button>
              </>
            }
            messages={messages}
            hasEarlier={hasEarlier}
            loadingEarlier={loadingEarlier}
            onLoadEarlier={loadEarlier}
            draftAnswer={draftAnswer}
            stage={askStage}
            auditDraft={auditDraft}
            standalone
            // 独立会话的上下文由服务端按会话完整历史构建（超预算自动压缩）。
            contextStrategy="full"
            includeMemoryDefault
            availableDocuments={documents.map((item) => ({
              id: item.id,
              name: item.name,
              tags: item.tags
            }))}
            asking={asking}
            lastAnswerDurationMs={lastAnswerDurationMs ?? undefined}
            progress={askProgress}
            answer={chatData?.answer ?? null}
            sources={chatData?.sources ?? []}
            notice={chatData?.notice}
            taskId={chatData?.taskId}
            citationSupport={chatData?.citation_support}
            invalidCitations={chatData?.invalid_citations}
            error={budgetWarning ? null : askMutation.isError ? askMutation.error.message : null}
            budget={budgetWarning}
            onConfirmBudget={() => {
              setBudgetWarning(null);
              // 确认后重发同一问题：沿用同一个会话 id（mutationFn 里带），服务端继续记录本轮。
              askMutation.mutate({
                question: lastQuestion,
                selection: lastSelection,
                confirmBudget: true,
                ...lastExtras,
                // 保留联网审批凭证与多轮上下文，避免确认后上下文/搜索结果断片。
                confirmSearch: lastSearchToken ? true : undefined,
                searchToken: lastSearchToken
              });
            }}
            onCancelBudget={() => {
              setBudgetWarning(null);
              // 预算确认被取消：服务端还没有落这轮用户消息，乐观消息一并撤掉。
              askedOptimisticIdRef.current = null;
              setOptimisticUser(null);
            }}
            budgetSkipActive={budgetSkip}
            onBudgetSkipChange={setBudgetSkip}
            onAsk={handleAsk}
            onAskAudio={(audio) => void handleAskAudio(audio)}
            onContinue={() => {
              if (!chatData?.taskId) return;
              // 继续阅读重发同一个 taskId + 同一个会话：服务端不会重复记用户消息。
              askMutation.mutate({
                question: lastQuestion,
                selection: lastSelection,
                taskId: chatData.taskId,
                confirmBudget: budgetSkip,
                confirmSearch: lastSearchToken ? true : undefined,
                searchToken: lastSearchToken,
                ...lastExtras
              });
            }}
            onRegenerate={
              activeSessionId &&
              lastUserMessage &&
              lastUserMessage.content.trim() !== '' &&
              // 语音提问（正文是「（语音）转写」或占位）不能拿它当文字问题重答。
              !lastUserMessage.content.trim().startsWith('（语音')
                ? () => {
                    if (!activeSessionId || !lastUserMessage) return;
                    setBudgetWarning(null);
                    resetDraft();
                    // 重新生成不追加乐观用户消息：服务端保留最后的用户问题，删掉最后一条回答后重答。
                    askMutation.mutate({
                      question: lastUserMessage.content,
                      regenerate: true,
                      includeMemory: lastIncludeMemory
                    });
                  }
                : undefined
            }
            onSaveAsNote={saveAnswerAsNote}
            onEditUserMessage={editUserMessage}
            onDeleteFromMessage={deleteFromMessage}
            onCancel={() => askAbortRef.current?.abort()}
            onOpenSource={openSource}
            onSpeak={
              chatData?.answer
                ? () => {
                    if (chatData.answer) speakMutation.mutate(chatData.answer);
                  }
                : undefined
            }
            onSpeakText={(text) => speakMutation.mutate(text)}
            speaking={speakMutation.isPending}
            onTranscribe={async (audio) => {
              // 独立会话没有单篇文献，不做「按当前页术语」的转写纠错，只做必要的格式转换 + 转写。
              let payload = audio;
              if (speechConfigQuery.data?.asr_mode === 'system') {
                try {
                  payload = await blobToWav(audio);
                } catch (error) {
                  throw new Error(
                    `无法把录音转成系统识别需要的 WAV 格式：${
                      error instanceof Error ? error.message : '未知错误'
                    }；也可以改用模型语音识别`
                  );
                }
              }
              const isWav = payload.type.includes('wav');
              const transcribed = await api.transcribeAudio(
                payload,
                isWav ? 'speech.wav' : 'speech.webm'
              );
              return transcribed.text;
            }}
            speechTriggerMode={speechConfigQuery.data?.trigger_mode ?? 'hold'}
            speechDisabledReason={speechInputDisabledReason}
            searchPermission={searchConfigQuery.data?.permission ?? 'off'}
            onCreateSearchPlan={({ question, selection }) =>
              // 独立会话没有 documentId：搜索计划只按问题（与选中摘引）生成。
              api.createSearchPlan({ question, selection })
            }
            searchWarning={chatData?.search_warning}
            directAudio={speechConfigQuery.data?.direct_audio}
            speechAutoSend={speechConfigQuery.data?.auto_send ?? false}
          />
        </div>
      </div>
    </section>
  );
}
