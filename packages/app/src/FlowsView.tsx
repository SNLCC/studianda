/**
 * 「阅读流程」最小可用界面：流程列表 + 被跳过条目原因 + 新建/编辑（Markdown）+ 启停/删除。
 *
 * - 只消费 api-client 已封装的 `/flows` 方法，不直接拼 HTTP；
 * - 服务端中文错误（id 不合法、正文超长、空名称、本版不支持脚本流程等）原样上屏；
 * - 视觉全部复用 @studianda/ui 的 kr-* 类名（kr-library / kr-doc-list / kr-doc-row /
 *   kr-empty / kr-page-status / kr-page-error / kr-modal* / kr-health），不新增 CSS 或图标库；
 * - 正文使用 ui 包已有的 MarkdownEditor；8000 字符上限在列表与编辑器里都以计数/警告呈现；
 * - 被服务端跳过的条目（含声明 scripts 的流程）在下方单独列出 id 与原因，避免「为什么没生效」
 *   在界面上无解释。
 */
import { appDialogs } from './dialogs.js';
import type { ApiClient } from '@studianda/api-client';
import type { FlowSummaryRecord, SkippedFlowRecord } from '@studianda/shared';
import { MarkdownEditor } from '@studianda/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState, type JSX } from 'react';

/** 服务端未返回 `max_chars` 时的兜底（与 core 的 FLOW_MAX_CHARS 一致）。 */
const DEFAULT_FLOW_MAX_CHARS = 8000;
/** 与 core 的 FLOW_NAME_MAX_CHARS 一致（输入框也限长）。 */
const FLOW_NAME_MAX_CHARS = 60;

/** 服务端错误原样变成界面文案：中文错误（超长/id 不合法等）不能被吞成「操作失败」。 */
export function flowErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  return '操作失败';
}

/** 「最近更新时间」的本地短文案；空串/非法时间不抛错。 */
export function formatFlowTime(iso: string): string {
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

function flowCharsLabel(flow: FlowSummaryRecord, maxChars: number): string {
  return `${flow.chars} / ${maxChars} 字符`;
}

type FlowDialogState = { mode: 'create' } | { mode: 'edit'; flow: FlowSummaryRecord };

/**
 * 新建/编辑共用弹窗（纯展示，便于 SSR 冒烟）。
 *
 * 字符计数与超限提示始终可见；超限时保存按钮禁用并给出「正文 N 字符，超过 8000 字符上限」。
 * scripts 说明放在正文编辑器下方：本版只保存 Markdown 方法说明，不提供脚本字段。
 */
export function FlowEditorDialog({
  mode,
  name,
  markdown,
  maxChars,
  error,
  pending,
  loading,
  onChangeName,
  onChangeMarkdown,
  onSubmit,
  onClose
}: {
  mode: 'create' | 'edit';
  name: string;
  markdown: string;
  maxChars: number;
  error: string;
  pending: boolean;
  loading: boolean;
  onChangeName(value: string): void;
  onChangeMarkdown(value: string): void;
  onSubmit(): void;
  onClose(): void;
}): JSX.Element {
  const overLimit = markdown.length > maxChars;
  const canSubmit =
    !pending &&
    !loading &&
    name.trim().length > 0 &&
    markdown.trim().length > 0 &&
    !overLimit;
  return (
    <div className="kr-modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="kr-modal"
        role="dialog"
        aria-modal="true"
        aria-label={mode === 'create' ? '新建阅读流程' : '编辑阅读流程'}
        style={{ width: 'min(760px, 94vw)', maxHeight: '88vh', overflowY: 'auto' }}
        onClick={(event) => event.stopPropagation()}
      >
        <h2>{mode === 'create' ? '新建阅读流程' : '编辑阅读流程'}</h2>
        <p className="kr-muted">
          阅读流程会作为 L1 方法参考注入精读请求，只影响阅读方法，不覆盖安全与证据规则。
        </p>
        <label className="kr-modal__field">
          流程名称
          <input
            autoFocus
            maxLength={FLOW_NAME_MAX_CHARS}
            value={name}
            placeholder="例如：先方法后结论、课题组读法"
            onChange={(event) => onChangeName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') onClose();
            }}
          />
        </label>
        <div className="kr-modal__field" style={{ marginTop: 12 }}>
          <span>
            流程正文（Markdown）· {markdown.length} / {maxChars} 字符
          </span>
          <MarkdownEditor
            value={markdown}
            onChange={onChangeMarkdown}
            rows={14}
            ariaLabel="阅读流程正文"
            placeholder="例如：先读摘要与方法，再核对结论；引用必须能回到原文。不要写成系统指令。"
          />
        </div>
        {overLimit ? (
          <p className="kr-modal__error" role="alert">
            正文 {markdown.length} 字符，超过 {maxChars} 字符上限，请精简后再保存。
          </p>
        ) : null}
        <p className="kr-muted">
          正文上限 {maxChars} 字符。本版不支持脚本流程：界面只保存 Markdown 方法说明，不提供 scripts
          字段；若手工在 flow.json 声明 scripts，该流程会被服务端拒绝加载并列入下方的跳过清单。
        </p>
        {loading ? <p className="kr-page-status">正在读取流程正文…</p> : null}
        {error ? (
          <p className="kr-modal__error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="kr-modal__actions">
          <button type="button" className="kr-ghost" onClick={onClose}>
            取消
          </button>
          <button type="button" className="kr-primary" onClick={onSubmit} disabled={!canSubmit}>
            {pending ? '保存中…' : mode === 'create' ? '新建' : '保存'}
          </button>
        </div>
      </div>
    </div>
  );
}

/** 流程列表（纯展示，便于 SSR 冒烟覆盖列表/空态/跳过原因/超限提示）。 */
export function FlowsList({
  flows,
  skipped,
  maxChars,
  loading,
  error,
  notice,
  actionError,
  pending,
  onCreate,
  onEdit,
  onToggleEnabled,
  onDelete,
  onRetry
}: {
  flows: FlowSummaryRecord[];
  skipped: SkippedFlowRecord[];
  maxChars: number;
  loading: boolean;
  error: string;
  notice: string;
  actionError: string;
  pending: boolean;
  onCreate(): void;
  onEdit(flow: FlowSummaryRecord): void;
  onToggleEnabled(flow: FlowSummaryRecord): void;
  onDelete(flow: FlowSummaryRecord): void;
  onRetry(): void;
}): JSX.Element {
  const enabledCount = flows.filter((flow) => flow.enabled).length;
  return (
    <section className="kr-library">
      <div className="kr-library__filters">
        <div className="kr-library__count">
          {loading
            ? '正在读取阅读流程…'
            : `${flows.length} 个流程（启用 ${enabledCount}）${
                skipped.length > 0 ? ` · ${skipped.length} 个被跳过` : ''
              }`}
        </div>
        <button type="button" className="kr-primary" onClick={onCreate}>
          + 新建阅读流程
        </button>
      </div>
      <p className="kr-muted">
        阅读流程只作为 L1 方法参考注入精读请求，不覆盖安全与证据规则；停用后不再注入。正文上限{' '}
        {maxChars} 字符，超出上限的内容不会生效。本版不支持脚本流程：声明了 scripts 的流程会被跳过，
        原因列在下方。
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
          <p>阅读流程读取失败：{error}</p>
          <button type="button" onClick={onRetry}>
            重试
          </button>
        </div>
      ) : loading && flows.length === 0 && skipped.length === 0 ? (
        <p className="kr-page-status">正在读取阅读流程…</p>
      ) : flows.length === 0 ? (
        <div className="kr-empty">
          <p>还没有阅读流程。</p>
          <p className="kr-muted">
            新建一个流程，写下你希望精读时遵循的步骤（例如先看方法、再核对结论）；它会作为方法参考
            加入精读请求，最多 {maxChars} 字符。
          </p>
        </div>
      ) : (
        <ul className="kr-doc-list kr-doc-list--rows">
          {flows.map((flow) => (
            <li className="kr-doc-row" key={flow.id}>
              <div className="kr-doc-row__main">
                <span className="kr-doc-row__title">{flow.name}</span>
                <span className="kr-doc-row__badges">
                  <span className="kr-doc-card__tag">v{flow.version}</span>
                  {flow.enabled ? (
                    <span className="kr-doc-card__tag">已启用</span>
                  ) : (
                    <span className="kr-doc-card__folder">已停用</span>
                  )}
                  {flow.truncated ? (
                    <span className="kr-search__scope-warn">
                      超过 {maxChars} 字符，仅注入前 {maxChars} 字符
                    </span>
                  ) : null}
                </span>
              </div>
              <span className="kr-doc-row__meta">
                {flowCharsLabel(flow, maxChars)} · 更新 {formatFlowTime(flow.updated_at)}
              </span>
              <span className="kr-doc-row__actions">
                <button
                  type="button"
                  title={`编辑「${flow.name}」的 Markdown 正文与名称`}
                  onClick={() => onEdit(flow)}
                  disabled={pending}
                >
                  编辑
                </button>
                <button
                  type="button"
                  title={
                    flow.enabled
                      ? `停用「${flow.name}」：不再注入精读请求，文件保留`
                      : `启用「${flow.name}」：恢复注入精读请求`
                  }
                  onClick={() => onToggleEnabled(flow)}
                  disabled={pending}
                >
                  {flow.enabled ? '停用' : '启用'}
                </button>
                <button
                  type="button"
                  className="kr-danger"
                  title={`删除「${flow.name}」（删除 flow.md 与 flow.json，不可恢复）`}
                  onClick={() => onDelete(flow)}
                  disabled={pending}
                >
                  删除
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {skipped.length > 0 ? (
        <div className="kr-health" role="status">
          <strong>
            被跳过的流程 {skipped.length} 个：这些条目没有生效，原因如下（修复后可重新出现在列表里）。
          </strong>
          <ul>
            {skipped.map((row, index) => (
              <li key={`${row.id}-${index}`}>
                <span>{row.id}</span>
                <span className="kr-muted">{row.reason}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

/**
 * 阅读流程工作区：列表 ↔ 新建/编辑弹窗由内部状态切换，不新增导航体系。
 *
 * 编辑时的完整正文通过 `GET /flows/:id` 读取；启用/停用走同一个 `PUT /flows/:id`，
 * 只提交 `enabled` 字段，其余内容由服务端保留。
 */
export function FlowsView({ api }: { api: ApiClient }): JSX.Element {
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<FlowDialogState | null>(null);
  const [nameInput, setNameInput] = useState('');
  const [markdownInput, setMarkdownInput] = useState('');
  const [dialogError, setDialogError] = useState('');
  const [dialogLoading, setDialogLoading] = useState(false);
  const [notice, setNotice] = useState('');
  const [actionError, setActionError] = useState('');
  const editRequestRef = useRef(0);

  const flowsQuery = useQuery({
    queryKey: ['flows'],
    queryFn: () => api.listFlows()
  });
  const flows = flowsQuery.data?.flows ?? [];
  const skipped = flowsQuery.data?.skipped ?? [];
  const maxChars = flowsQuery.data?.max_chars ?? DEFAULT_FLOW_MAX_CHARS;

  const refreshFlows = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['flows'] });
  };
  const resetTransient = (): void => {
    setNotice('');
    setActionError('');
  };

  const createMutation = useMutation({
    mutationFn: (input: { name: string; markdown: string }) => api.createFlow(input),
    onSuccess: (flow) => {
      refreshFlows();
      setDialog(null);
      setDialogError('');
      resetTransient();
      setNotice(`已新建阅读流程「${flow.name}」。`);
    },
    onError: (error: Error) => setDialogError(flowErrorMessage(error))
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, input }: { id: string; input: { name: string; markdown: string } }) =>
      api.updateFlow(id, input),
    onSuccess: (flow) => {
      refreshFlows();
      setDialog(null);
      setDialogError('');
      resetTransient();
      setNotice(`已保存阅读流程「${flow.name}」（v${flow.version}）。`);
    },
    onError: (error: Error) => setDialogError(flowErrorMessage(error))
  });

  const toggleMutation = useMutation({
    mutationFn: (flow: FlowSummaryRecord) =>
      api.updateFlow(flow.id, { enabled: !flow.enabled }),
    onSuccess: (flow, previous) => {
      refreshFlows();
      resetTransient();
      setNotice(
        `${flow.enabled ? '已启用' : '已停用'}阅读流程「${previous.name}」${
          flow.enabled ? '。' : '，文件保留，不再注入精读请求。'
        }`
      );
    },
    onError: (error: Error) => setActionError(flowErrorMessage(error))
  });

  const deleteMutation = useMutation({
    mutationFn: (flow: FlowSummaryRecord) => api.deleteFlow(flow.id),
    onSuccess: (_result, flow) => {
      refreshFlows();
      resetTransient();
      setNotice(`已删除阅读流程「${flow.name}」。`);
    },
    onError: (error: Error) => setActionError(flowErrorMessage(error))
  });

  const closeDialog = (): void => {
    editRequestRef.current += 1;
    setDialog(null);
    setDialogError('');
    setDialogLoading(false);
  };

  const openCreateDialog = (): void => {
    resetTransient();
    editRequestRef.current += 1;
    setDialog({ mode: 'create' });
    setNameInput('');
    setMarkdownInput('');
    setDialogError('');
    setDialogLoading(false);
  };

  const openEditDialog = (flow: FlowSummaryRecord): void => {
    resetTransient();
    const requestId = editRequestRef.current + 1;
    editRequestRef.current = requestId;
    setDialog({ mode: 'edit', flow });
    setNameInput(flow.name);
    setMarkdownInput('');
    setDialogError('');
    setDialogLoading(true);
    void api
      .getFlow(flow.id)
      .then((detail) => {
        if (requestId !== editRequestRef.current) return;
        setNameInput(detail.name);
        setMarkdownInput(detail.content);
      })
      .catch((error: unknown) => {
        if (requestId !== editRequestRef.current) return;
        setDialog(null);
        setActionError(flowErrorMessage(error));
      })
      .finally(() => {
        if (requestId === editRequestRef.current) setDialogLoading(false);
      });
  };

  const submitDialog = (): void => {
    if (!dialog || dialogLoading) return;
    const name = nameInput.trim();
    if (!name) {
      setDialogError('请输入流程名称。');
      return;
    }
    if (!markdownInput.trim()) {
      setDialogError('流程正文不能为空。');
      return;
    }
    if (markdownInput.length > maxChars) {
      setDialogError(`正文 ${markdownInput.length} 字符，超过 ${maxChars} 字符上限，请精简后再保存。`);
      return;
    }
    setDialogError('');
    if (dialog.mode === 'create') {
      createMutation.mutate({ name, markdown: markdownInput });
    } else {
      updateMutation.mutate({
        id: dialog.flow.id,
        input: { name, markdown: markdownInput }
      });
    }
  };

  const confirmDelete = (flow: FlowSummaryRecord): void => {
    const confirmed = appDialogs.confirm(
      `删除阅读流程「${flow.name}」？\n\n会删除资料目录里的 flow.md 与 flow.json；已注入过该流程的历史回答不受影响。此操作不可恢复。`
    );
    if (!confirmed) return;
    resetTransient();
    deleteMutation.mutate(flow);
  };

  return (
    <>
      <FlowsList
        flows={flows}
        skipped={skipped}
        maxChars={maxChars}
        loading={flowsQuery.isLoading}
        error={flowsQuery.isError ? flowErrorMessage(flowsQuery.error) : ''}
        notice={notice}
        actionError={actionError}
        pending={
          createMutation.isPending ||
          updateMutation.isPending ||
          toggleMutation.isPending ||
          deleteMutation.isPending
        }
        onCreate={openCreateDialog}
        onEdit={openEditDialog}
        onToggleEnabled={(flow) => {
          resetTransient();
          toggleMutation.mutate(flow);
        }}
        onDelete={confirmDelete}
        onRetry={() => void flowsQuery.refetch()}
      />
      {dialog ? (
        <FlowEditorDialog
          mode={dialog.mode}
          name={nameInput}
          markdown={markdownInput}
          maxChars={maxChars}
          error={dialogError}
          pending={createMutation.isPending || updateMutation.isPending}
          loading={dialogLoading}
          onChangeName={setNameInput}
          onChangeMarkdown={setMarkdownInput}
          onSubmit={submitDialog}
          onClose={closeDialog}
        />
      ) : null}
    </>
  );
}
