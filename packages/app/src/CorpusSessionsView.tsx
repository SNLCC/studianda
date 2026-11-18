/**
 * 「跨篇会话」最小可用界面：会话列表 + 详情（历史、追问、删除、新建多选文献）。
 *
 * 设计约束（与项目视图 ProjectsView 保持同一套组织方式）：
 * - 只消费 api-client 已封装的 `/corpus-sessions` 方法，不直接拼 HTTP；
 * - 追问走 `askCorpusSessionStream()`（SSE）：`stage` 作为实时状态主文案，`progress`
 *   只作辅助（当前服务端 unit 只有「批」，粒度粗，不假设 done/total 的值域）；
 *   正文只在 `result` 事件里一次性到达，界面不拼接任何增量；
 * - 收到 `result` 后才把完整 `ChatResponse` 交给 `ChatPanel` 渲染，引用 / 缺证 /
 *   原文已变更 / 越界引用等审计展示全部复用 ChatPanel 既有逻辑，不另写一套；
 * - 视觉全部复用 @studianda/ui 的 kr-* 类名，不新增 CSS 文件、不引入图标库。
 *
 * 不做：项目范围实时绑定（只保存建会话时的来源项目快照）、预算闸门、继续阅读。
 */
import { appDialogs } from './dialogs.js';
import { ApiRequestError, type ApiClient, type CorpusAskProgress } from '@studianda/api-client';
import type {
  ChatMessageRecord,
  ChatResponse,
  ChatSource,
  CorpusSessionSummary,
  DocumentSummary
} from '@studianda/shared';
import { ChatPanel, type ChatMessageView } from '@studianda/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState, type JSX } from 'react';

/** 服务端错误原样变成界面文案：中文错误（范围失效、会话不存在等）不能被吞成「操作失败」。 */
export function corpusErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  return '操作失败';
}

/**
 * 追问失败文案：409 表示「会话范围里的文献已全部不可用」，界面固定提示一遍，
 * 再原样附上服务端说明；其它错误（含 SSE error 事件）原样显示。
 */
export function corpusAskErrorMessage(error: unknown): string {
  if (error instanceof ApiRequestError && error.status === 409) {
    return `所选文献已全部不可用：${error.message}`;
  }
  return corpusErrorMessage(error);
}

/** 「最近更新时间」的本地短文案；空串/非法时间不抛错。 */
export function formatCorpusTime(iso: string): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
}

/** 从项目打开跨篇会话时的来源项目：建立会话直接传 projectId（服务端解析成当前文献快照）。 */
export interface CorpusProjectSource {
  id: string;
  name: string;
  /** 项目当前文献数（空项目不允许建会话，界面先拦，不等服务端 400）。 */
  documentCount: number;
}

/** 取消（AbortController）不是错误：不把它当成红色报错上屏。 */
function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === 'AbortError') ||
    (error instanceof Error && error.name === 'AbortError')
  );
}

/**
 * DB 行 → ChatPanel 的消息视图。
 *
 * 跨篇会话的助手消息没有把整轮 ChatResponse 存进 `metadata.response`（服务端只落
 * corpusSessionId/skipped_document_ids 等元数据），重开历史时从 `content + sources` 恢复
 * 「正文 + 依据」；审计信息由 schema_version 24 的 `messages.audit_summary` 恢复成
 * `ChatResponse.audit_summary`（只含计数/状态），ChatPanel 复用既有缺证/原文已变更/越界引用
 * 渲染逻辑展示。本轮刚返回的完整结果由容器按 message id 覆盖，保留逐段明细。
 */
export function corpusMessageView(
  row: ChatMessageRecord,
  liveResponse?: ChatResponse
): ChatMessageView {
  const metadata = row.metadata ?? {};
  const sources = Array.isArray(row.sources) ? row.sources : [];
  let response: ChatResponse | undefined;
  if (liveResponse) {
    response = liveResponse;
  } else if (row.role === 'assistant') {
    const stored = metadata.response;
    if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
      const restored = { ...(stored as ChatResponse), sources };
      // 旧行可能只有摘要列、没有完整 response 里的 audit_summary：补回去再渲染。
      if (!restored.audit_summary && row.auditSummary) {
        restored.audit_summary = row.auditSummary;
      }
      response = restored;
    } else {
      response = {
        answer: row.content,
        sources,
        ...(row.auditSummary ? { audit_summary: row.auditSummary } : {})
      };
    }
  }
  return {
    id: `db-${row.id}`,
    role: row.role,
    content: row.content,
    quote: typeof metadata.quote === 'string' ? metadata.quote : undefined,
    quotePage: typeof metadata.quotePage === 'number' ? metadata.quotePage : undefined,
    quoteName: typeof metadata.quoteName === 'string' ? metadata.quoteName : undefined,
    response
  };
}

/** 会话列表（纯展示，便于 SSR 冒烟覆盖列表 / 空态 / 错误态）。 */
export function CorpusSessionsList({
  sessions,
  loading,
  error,
  pending,
  notice,
  actionError,
  onCreate,
  onOpen,
  onDelete,
  onRetry
}: {
  sessions: CorpusSessionSummary[];
  loading: boolean;
  error: string;
  pending: boolean;
  notice: string;
  actionError: string;
  onCreate(): void;
  onOpen(session: CorpusSessionSummary): void;
  onDelete(session: CorpusSessionSummary): void;
  onRetry(): void;
}): JSX.Element {
  return (
    <section className="kr-library kr-qa" style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
      <div className="kr-library__filters">
        <div className="kr-library__count">
          {loading ? '正在读取跨篇会话…' : `${sessions.length} 个会话`}
        </div>
        <button type="button" className="kr-primary" onClick={onCreate}>
          + 新建跨篇会话
        </button>
      </div>
      <p className="kr-muted">
        选几篇文献一起提问；范围在建立会话时冻结，之后新增文献不自动加入。
      </p>
      {notice ? (
        <p className="kr-settings__message" role="status">
          {notice}
        </p>
      ) : null}
      {actionError ? (
        <p className="kr-page-error" role="alert">
          {actionError}
        </p>
      ) : null}
      {error ? (
        <div className="kr-page-error" role="alert">
          <p>跨篇会话读取失败：{error}</p>
          <button type="button" onClick={onRetry}>
            重试
          </button>
        </div>
      ) : loading && sessions.length === 0 ? (
        <p className="kr-page-status">正在读取跨篇会话…</p>
      ) : sessions.length === 0 ? (
        <div className="kr-empty">
          <p>还没有跨篇会话。</p>
          <p className="kr-muted">
            点「+ 新建跨篇会话」选几篇文献一起提问；范围在建立时冻结，引用仍可点回原文。
          </p>
        </div>
      ) : (
        <ul className="kr-doc-list kr-doc-list--rows">
          {sessions.map((session) => (
            <li
              className="kr-doc-row"
              key={session.id}
              role="button"
              tabIndex={0}
              title={`打开跨篇会话「${session.title}」`}
              onClick={(event) => {
                if (event.target instanceof Element && event.target.closest('button')) return;
                onOpen(session);
              }}
              onKeyDown={(event) => {
                if (event.target !== event.currentTarget) return;
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onOpen(session);
                }
              }}
            >
              <div className="kr-doc-row__main">
                <span className="kr-doc-row__title">{session.title}</span>
                <span className="kr-doc-row__badges">
                  <span className="kr-doc-card__tag">{session.documentIds.length} 篇文献</span>
                  {session.sourceProjectName ? (
                    <span
                      className="kr-doc-card__folder"
                      title={`范围来自项目「${session.sourceProjectName}」，建立会话时已冻结`}
                    >
                      来自项目 {session.sourceProjectName}
                    </span>
                  ) : null}
                  {session.skippedDocumentIds.length > 0 ? (
                    <span className="kr-doc-row__state">
                      {session.skippedDocumentIds.length} 篇已不可用
                    </span>
                  ) : null}
                </span>
              </div>
              <span className="kr-doc-row__meta">最近更新 {formatCorpusTime(session.updatedAt)}</span>
              <span className="kr-doc-row__actions">
                <button
                  type="button"
                  className="kr-danger"
                  title={`删除会话「${session.title}」（只删会话与消息，不删除文献）`}
                  onClick={() => onDelete(session)}
                  disabled={pending}
                >
                  删除
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * 新建跨篇会话弹窗：两种范围来源——
 * - 手选文献（文献库「新建跨篇会话」）：多选，至少 1 篇，提交 documentIds；
 * - 来源项目（项目详情「用这些文献新建跨篇会话」）：不再手选，提交 projectId，
 *   服务端把项目**当前**文献解析成快照；空项目只提示「该项目暂无文献」、不允许提交。
 */
export function CorpusSessionCreateDialog({
  documents,
  project,
  selectedIds,
  search,
  title,
  pending,
  error,
  onChangeSearch,
  onChangeTitle,
  onToggle,
  onSubmit,
  onClose
}: {
  documents: DocumentSummary[];
  /** 从项目进入时的来源项目；有值时按项目建立会话。 */
  project?: CorpusProjectSource | null;
  selectedIds: string[];
  search: string;
  title: string;
  pending: boolean;
  error: string;
  onChangeSearch(value: string): void;
  onChangeTitle(value: string): void;
  onToggle(documentId: string): void;
  onSubmit(): void;
  onClose(): void;
}): JSX.Element {
  const query = search.trim().toLowerCase();
  const candidates = documents.filter((document) => {
    if (!query) return true;
    return `${document.name} ${document.author}`.toLowerCase().includes(query);
  });
  const projectEmpty = Boolean(project) && (project?.documentCount ?? 0) <= 0;
  return (
    <div className="kr-modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="kr-modal kr-modal--folder"
        style={{ width: 'min(560px, 94vw)' }}
        role="dialog"
        aria-modal="true"
        aria-label="新建跨篇会话"
        onClick={(event) => event.stopPropagation()}
      >
        <h2>{project ? `新建跨篇会话 · 项目「${project.name}」` : '新建跨篇会话'}</h2>
        {project ? (
          <>
            <p className="kr-muted">
              范围：项目「{project.name}」当前的 {project.documentCount} 篇文献。建立会话时冻结为
              快照，之后项目增删文献不影响本会话。
            </p>
            {projectEmpty ? (
              <p className="kr-modal__error" role="status">
                该项目暂无文献
              </p>
            ) : null}
          </>
        ) : (
          <p className="kr-muted">
            选择要一起提问的文献（至少 1 篇）。范围会冻结为快照；之后新增文献不自动加入。
          </p>
        )}
        <label className="kr-modal__field">
          会话标题（选填）
          <input
            maxLength={60}
            value={title}
            placeholder="例如：北宋史料互证"
            onChange={(event) => onChangeTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                onSubmit();
              }
              if (event.key === 'Escape') onClose();
            }}
          />
        </label>
        {project ? null : (
          <>
            <div className="kr-library__filters">
              <label>
                搜索文献
                <input
                  type="search"
                  value={search}
                  placeholder="标题或作者"
                  onChange={(event) => onChangeSearch(event.target.value)}
                />
              </label>
              <span className="kr-library__count">
                已选 {selectedIds.length} 篇 · 可添加 {candidates.length} 篇
              </span>
            </div>
            {documents.length === 0 ? (
              <p className="kr-muted">文献库还没有文献。</p>
            ) : candidates.length === 0 ? (
              <p className="kr-muted">没有匹配的文献。</p>
            ) : (
              <ul
                className="kr-doc-list kr-doc-list--rows"
                style={{ maxHeight: '240px', overflowY: 'auto' }}
              >
                {candidates.map((document) => (
                  <li className="kr-doc-row" key={document.id}>
                    <label className="kr-doc-row__main">
                      <span className="kr-doc-row__title">
                        <input
                          type="checkbox"
                          checked={selectedIds.includes(document.id)}
                          onChange={() => onToggle(document.id)}
                        />{' '}
                        {document.name}
                      </span>
                      <span className="kr-doc-row__badges">
                        {document.author ? (
                          <span className="kr-doc-card__tag">@{document.author}</span>
                        ) : null}
                        <span className="kr-doc-row__meta">{document.pages} 页</span>
                        {document.missing_file ? (
                          <span className="kr-doc-card__missing">附件缺失</span>
                        ) : null}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
        {error ? (
          <p className="kr-modal__error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="kr-modal__actions">
          <button type="button" className="kr-ghost" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="kr-primary"
            onClick={onSubmit}
            disabled={
              pending || (project ? projectEmpty : selectedIds.length === 0)
            }
          >
            {pending
              ? '正在建立…'
              : project
                ? `建立会话（项目内 ${project.documentCount} 篇）`
                : `建立会话（${selectedIds.length} 篇）`}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * 会话详情（纯展示，便于 SSR 冒烟覆盖「进行中」与「错误」两态）。
 *
 * 消息区直接挂 `ChatPanel`：引用编号、缺证/原文已变更、越界引用、本轮记录等
 * 全部由它渲染；这里只负责会话头（范围、删除、返回）与把 SSE 的 stage/progress
 * 状态传给它的 pending 气泡。
 */
export function CorpusSessionDetailView({
  session,
  messages,
  loading,
  loadError,
  asking,
  stage,
  progress,
  askError,
  askNotice,
  actionError,
  onBack,
  onAsk,
  onCancel,
  onDelete,
  onOpenSource,
  onRetryMessages
}: {
  session: CorpusSessionSummary;
  messages: ChatMessageView[];
  loading: boolean;
  loadError: string;
  asking: boolean;
  stage: string;
  progress: CorpusAskProgress | null;
  askError: string;
  askNotice: string;
  actionError: string;
  onBack(): void;
  onAsk(question: string, sourcePolicy?: 'auto' | 'document_only'): void;
  onCancel(): void;
  onDelete(): void;
  onOpenSource(source: ChatSource): void;
  onRetryMessages(): void;
}): JSX.Element {
  // ChatPanel 的进度行固定按「批」展示；当前服务端 unit 只有「批」。
  // 换 unit 时不再把 done/total 交给它，避免把「批」错标成别的单位。
  const chatProgress =
    progress &&
    (progress.unit === undefined || progress.unit === '批') &&
    Number.isFinite(progress.done) &&
    Number.isFinite(progress.total) &&
    progress.total > 0
      ? { done: Math.max(0, progress.done), total: progress.total }
      : null;
  // 进度条只做视觉辅助：夹取到 0–100%，不假设服务端的值域/总量稳定。
  const progressPercent =
    progress &&
    Number.isFinite(progress.done) &&
    Number.isFinite(progress.total) &&
    progress.total > 0
      ? Math.max(0, Math.min(100, Math.round((progress.done / progress.total) * 100)))
      : null;
  const progressLabel =
    progress && progress.unit !== '批' && progress.total > 0
      ? `已推进 ${progress.done} / ${progress.total}${progress.unit ? ` ${progress.unit}` : ''}`
      : '';
  return (
    <section
      className="kr-library kr-qa"
      style={{
        flex: 1,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        overflow: 'hidden'
      }}
    >
      <div className="kr-library__filters">
        <button type="button" onClick={onBack}>
          ← 返回会话列表
        </button>
        <div className="kr-library__count" title={session.title}>
          {session.title} · {session.documentIds.length} 篇文献
        </div>
        {asking && progressPercent !== null ? (
          <span
            className="kr-doc-card__progress"
            style={{ width: '120px' }}
            role="progressbar"
            aria-label="跨篇阅读进度"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progressPercent}
          >
            <span style={{ width: `${progressPercent}%` }} />
          </span>
        ) : null}
        {asking && progressLabel ? (
          <span className="kr-doc-row__meta" role="status">
            {progressLabel}
          </span>
        ) : null}
        <span className="kr-doc-row__meta">最近更新 {formatCorpusTime(session.updatedAt)}</span>
        <button
          type="button"
          className="kr-danger"
          onClick={onDelete}
          disabled={asking}
          title="删除会话与全部消息（不删除文献）"
        >
          删除会话
        </button>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
        {session.sourceProjectName ? (
          <span
            className="kr-doc-card__folder"
            title="会话范围在建立时按该项目当前文献冻结；之后项目增删/改名/删除都不影响本会话的展示名"
          >
            来自项目 {session.sourceProjectName}
          </span>
        ) : null}
        {session.documents.map((document) => (
          <span className="kr-doc-card__tag" key={document.id} title={`${document.pages} 页`}>
            {document.name}
          </span>
        ))}
        {session.skippedDocumentIds.length > 0 ? (
          <span className="kr-doc-row__state" title="这些文献已删除或不在当前文献库，追问时会跳过">
            范围里 {session.skippedDocumentIds.length} 篇文献已不可用
          </span>
        ) : null}
      </div>
      <p className="kr-muted" style={{ margin: 0 }}>
        范围在建立会话时冻结；回答经过审计后才整段显示，引用编号可点回原文。
      </p>
      {askNotice ? (
        <p className="kr-settings__message" role="status">
          {askNotice}
        </p>
      ) : null}
      {actionError ? (
        <p className="kr-page-error" role="alert">
          {actionError}
        </p>
      ) : null}
      {loadError ? (
        <div className="kr-page-error" role="alert">
          <p>会话消息读取失败：{loadError}</p>
          <button type="button" onClick={onRetryMessages}>
            重试
          </button>
        </div>
      ) : loading ? (
        <p className="kr-page-status">正在读取会话消息…</p>
      ) : (
        <ChatPanel
          messages={messages}
          stage={stage}
          standalone
          contextStrategy="full"
          asking={asking}
          progress={chatProgress}
          answer={null}
          sources={[]}
          error={askError || null}
          onAsk={(question, options) => onAsk(question, options?.sourcePolicy)}
          onCancel={onCancel}
          onOpenSource={onOpenSource}
        />
      )}
    </section>
  );
}

/** 会话详情容器：消息查询 + SSE 追问状态；只把渲染交给 DetailView。 */
function CorpusSessionDetail({
  api,
  session,
  actionError,
  onBack,
  onOpenSource,
  onDelete
}: {
  api: ApiClient;
  session: CorpusSessionSummary;
  actionError: string;
  onBack(): void;
  onOpenSource(source: ChatSource): void;
  onDelete(): void;
}): JSX.Element {
  const queryClient = useQueryClient();
  const [asking, setAsking] = useState(false);
  const [stage, setStage] = useState('');
  const [progress, setProgress] = useState<CorpusAskProgress | null>(null);
  const [askError, setAskError] = useState('');
  const [askNotice, setAskNotice] = useState('');
  // 本轮在本地立即显示的 user/assistant 消息（服务端 message id 已知后按 id 去重）。
  const [localTurns, setLocalTurns] = useState<ChatMessageView[]>([]);
  // 本轮 result 的完整 ChatResponse：历史接口只存 content+sources，用 id 挂回去保留审计展示。
  const [liveResponses, setLiveResponses] = useState<Record<string, ChatResponse>>({});
  const abortRef = useRef<AbortController | null>(null);

  const messagesQuery = useQuery({
    queryKey: ['corpus-messages', session.id],
    queryFn: () => api.listCorpusSessionMessages(session.id)
  });

  const messages = useMemo(() => {
    const rows = (messagesQuery.data ?? []).map((row) =>
      corpusMessageView(row, liveResponses[`db-${row.id}`])
    );
    const known = new Set(rows.map((row) => row.id));
    const extras = localTurns.filter((turn) => !known.has(turn.id));
    // 服务端在开始回答前就落库了本轮用户消息：流式期间若消息查询被重新拉取，
    // 同一条提问会同时以 DB 行和本地乐观行出现，这里去重。
    const lastRow = rows[rows.length - 1];
    const pendingUser =
      extras.length === 1 && extras[0]?.role === 'user' ? extras[0] : null;
    const dedupedExtras =
      pendingUser && lastRow?.role === 'user' && lastRow.content.trim() === pendingUser.content.trim()
        ? []
        : extras;
    return [...rows, ...dedupedExtras];
  }, [messagesQuery.data, liveResponses, localTurns]);

  // 切换会话/离开视图时中止在飞的追问（服务端按断开取消，不落失败消息）。
  useEffect(() => {
    return () => abortRef.current?.abort();
  }, [session.id]);

  const ask = (question: string, sourcePolicy?: 'auto' | 'document_only'): void => {
    const trimmed = question.trim();
    if (!trimmed || asking) return;
    setAskError('');
    setAskNotice('');
    setStage('正在准备跨篇会话…');
    setProgress(null);
    setAsking(true);
    const controller = new AbortController();
    abortRef.current = controller;
    setLocalTurns([{ id: `local-user-${Date.now()}`, role: 'user', content: trimmed }]);
    void (async () => {
      try {
        // SSE 只推 stage/progress/error/result；正文只在 result 一次性到达，这里不拼增量。
        const result = await api.askCorpusSessionStream(
          session.id,
          {
            question: trimmed,
            ...(sourcePolicy && sourcePolicy !== 'auto'
              ? { source_policy: sourcePolicy }
              : {})
          },
          {
            signal: controller.signal,
            onStage: (text) => {
              if (!controller.signal.aborted) setStage(text);
            },
            onProgress: (value) => {
              if (!controller.signal.aborted) setProgress(value);
            }
          }
        );
        setLiveResponses((current) => ({
          ...current,
          [`db-${result.assistant_message_id}`]: result
        }));
        setLocalTurns([
          { id: `db-${result.user_message_id}`, role: 'user', content: trimmed },
          {
            id: `db-${result.assistant_message_id}`,
            role: 'assistant',
            content: result.answer ?? '',
            response: result
          }
        ]);
        void queryClient.invalidateQueries({ queryKey: ['corpus-messages', session.id] });
        void queryClient.invalidateQueries({ queryKey: ['corpus-sessions'] });
      } catch (error) {
        setLocalTurns([]);
        if (controller.signal.aborted || isAbortError(error)) {
          setAskNotice('已取消本轮提问。');
        } else {
          // error 事件与前置失败的文案原样显示；409（范围全失）由 corpusAskErrorMessage 固定提示。
          setAskError(corpusAskErrorMessage(error));
        }
        // 服务端在用户消息之后失败时会落一条「回答未完成」助手消息：刷新让历史如实显示。
        void queryClient.invalidateQueries({ queryKey: ['corpus-messages', session.id] });
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
        setAsking(false);
        setStage('');
        setProgress(null);
      }
    })();
  };

  return (
    <CorpusSessionDetailView
      session={session}
      messages={messages}
      loading={messagesQuery.isLoading}
      loadError={messagesQuery.isError ? corpusErrorMessage(messagesQuery.error) : ''}
      asking={asking}
      stage={stage}
      progress={progress}
      askError={askError}
      askNotice={askNotice}
      actionError={actionError}
      onBack={() => {
        abortRef.current?.abort();
        onBack();
      }}
      onAsk={ask}
      onCancel={() => abortRef.current?.abort()}
      onDelete={onDelete}
      onOpenSource={onOpenSource}
      onRetryMessages={() => void messagesQuery.refetch()}
    />
  );
}

/**
 * 跨篇会话工作区：列表 ↔ 详情由内部状态切换，不新增导航体系。
 *
 * 从文献库进入时可通过 `openCreateRequested` 直接打开多选弹窗（消费后回调清标记）；
 * 从项目详情进入时带 `projectSource`，建立会话直接传 `projectId`；「来自项目 X」由服务端
 * 返回的 sourceProjectName 展示（建会话时快照，项目改名/删除后仍显示当时名字）。
 */
export function CorpusSessionsView({
  api,
  documents,
  openCreateRequested = false,
  projectSource = null,
  onOpenCreateConsumed,
  onProjectSourceConsumed,
  onOpenSource
}: {
  api: ApiClient;
  documents: DocumentSummary[];
  openCreateRequested?: boolean;
  /** 从项目「用这些文献新建跨篇会话」进入时的来源项目（建立会话直接传 projectId）。 */
  projectSource?: CorpusProjectSource | null;
  onOpenCreateConsumed?(): void;
  /** 来源项目已消费（建立成功 / 取消 / 项目失效降级）后通知父级清掉，避免下次进入还带着。 */
  onProjectSourceConsumed?(): void;
  onOpenSource(source: ChatSource): void;
}): JSX.Element {
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [pickedIds, setPickedIds] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const [title, setTitle] = useState('');
  const [createError, setCreateError] = useState('');
  const [notice, setNotice] = useState('');
  const [actionError, setActionError] = useState('');

  const sessionsQuery = useQuery({
    queryKey: ['corpus-sessions'],
    queryFn: () => api.listCorpusSessions()
  });
  const sessions = sessionsQuery.data ?? [];
  const selectedSession = selectedId
    ? (sessions.find((session) => session.id === selectedId) ?? null)
    : null;

  const openCreateDialog = (): void => {
    setPickedIds([]);
    setSearch('');
    setTitle('');
    setCreateError('');
    setNotice('');
    setActionError('');
    setCreateOpen(true);
  };

  // 从文献库「新建跨篇会话」/ 项目「用这些文献新建跨篇会话」进来：挂载后直接打开弹窗。
  useEffect(() => {
    if (!openCreateRequested) return;
    onOpenCreateConsumed?.();
    openCreateDialog();
    // 只在挂载时消费一次（父级标记已清掉）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const createMutation = useMutation({
    mutationFn: () =>
      projectSource
        ? api.createCorpusSession({
            // 来源是项目时直接传 projectId：服务端解析成项目**当前**文献并固化快照，
            // 不再和手选 documentIds 同时给（两者互斥，同时给会 400）。
            projectId: projectSource.id,
            ...(title.trim() ? { title: title.trim() } : {})
          })
        : api.createCorpusSession({
            documentIds: [...pickedIds],
            ...(title.trim() ? { title: title.trim() } : {})
          }),
    onSuccess: (session) => {
      const createdFromProject = projectSource;
      setCreateOpen(false);
      setPickedIds([]);
      setSearch('');
      setTitle('');
      setCreateError('');
      setSelectedId(session.id);
      if (createdFromProject) {
        // 来源项目已由服务端写入会话（sourceProjectId/sourceProjectName），前端不再本地记录；
        // 这里只负责通知父级清掉「从项目进入」的临时状态。
        onProjectSourceConsumed?.();
      }
      setNotice(
        session.skippedDocumentIds.length > 0
          ? `已建立会话「${session.title}」；范围内 ${session.skippedDocumentIds.length} 篇文献当前不可用，追问时会跳过。`
          : createdFromProject
            ? `已用项目「${createdFromProject.name}」当前 ${createdFromProject.documentCount} 篇文献建立会话「${session.title}」（范围已冻结）。`
            : `已建立会话「${session.title}」。`
      );
      // 列表查询可能比建立请求先返回：把新会话补进缓存，详情才能立刻找到它。
      queryClient.setQueryData<CorpusSessionSummary[]>(['corpus-sessions'], (current) => {
        const list = current ?? [];
        return list.some((item) => item.id === session.id) ? list : [session, ...list];
      });
      void queryClient.invalidateQueries({ queryKey: ['corpus-sessions'] });
    },
    onError: (error: Error) => {
      // 来源项目在建立过程中被删除/归档：降级为手选文献，不把 404 当成「操作失败」唯一提示。
      if (projectSource && error instanceof ApiRequestError && error.status === 404) {
        onProjectSourceConsumed?.();
        setCreateError(`${corpusErrorMessage(error)}；已改为手动选择文献。`);
        return;
      }
      setCreateError(corpusErrorMessage(error));
    }
  });

  const deleteMutation = useMutation({
    mutationFn: (session: CorpusSessionSummary) => api.deleteCorpusSession(session.id),
    onSuccess: (result, session) => {
      if (selectedId === session.id) setSelectedId(null);
      setNotice(
        `已删除会话「${session.title}」${result.removed > 0 ? `，共 ${result.removed} 条消息` : ''}；文献本身未删除。`
      );
      setActionError('');
      void queryClient.invalidateQueries({ queryKey: ['corpus-sessions'] });
    },
    onError: (error: Error) => setActionError(corpusErrorMessage(error))
  });

  const confirmDelete = (session: CorpusSessionSummary): void => {
    const confirmed = appDialogs.confirm(
      `删除跨篇会话「${session.title}」？\n\n会一并删除该会话的全部消息记录，但不会删除文献本身。此操作不可恢复。`
    );
    if (!confirmed) return;
    setNotice('');
    setActionError('');
    deleteMutation.mutate(session);
  };

  const togglePicked = (documentId: string): void => {
    setPickedIds((current) =>
      current.includes(documentId)
        ? current.filter((id) => id !== documentId)
        : [...current, documentId]
    );
  };

  const submitCreate = (): void => {
    // 来源是项目：直接传 projectId，不要求手选；空项目在界面就拦下，不发请求。
    if (projectSource) {
      if (projectSource.documentCount <= 0) {
        setCreateError('该项目暂无文献');
        return;
      }
      setCreateError('');
      createMutation.mutate();
      return;
    }
    if (pickedIds.length === 0) {
      setCreateError('请至少选择 1 篇文献。');
      return;
    }
    setCreateError('');
    createMutation.mutate();
  };

  if (selectedSession) {
    return (
      <CorpusSessionDetail
        api={api}
        session={selectedSession}
        actionError={actionError}
        onDelete={() => confirmDelete(selectedSession)}
        onBack={() => {
          setSelectedId(null);
          setActionError('');
        }}
        onOpenSource={onOpenSource}
      />
    );
  }

  return (
    <>
      <CorpusSessionsList
        sessions={sessions}
        loading={sessionsQuery.isLoading}
        error={sessionsQuery.isError ? corpusErrorMessage(sessionsQuery.error) : ''}
        pending={deleteMutation.isPending}
        notice={notice}
        actionError={actionError}
        onCreate={openCreateDialog}
        onOpen={(session) => {
          setSelectedId(session.id);
          setNotice('');
          setActionError('');
        }}
        onDelete={confirmDelete}
        onRetry={() => void sessionsQuery.refetch()}
      />
      {createOpen ? (
        <CorpusSessionCreateDialog
          documents={documents}
          project={projectSource}
          selectedIds={pickedIds}
          search={search}
          title={title}
          pending={createMutation.isPending}
          error={createError}
          onChangeSearch={setSearch}
          onChangeTitle={setTitle}
          onToggle={togglePicked}
          onSubmit={submitCreate}
          onClose={() => {
            setCreateOpen(false);
            setCreateError('');
            // 取消时也消费来源项目：下次从侧栏「新建跨篇会话」进来应是手选文献。
            if (projectSource) onProjectSourceConsumed?.();
          }}
        />
      ) : null}
    </>
  );
}
