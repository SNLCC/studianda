/**
 * 文献信息弹窗：阅读页直接改当前文献的标题、作者、标签、类型与文件夹。
 *
 * 与文献库里的「重命名 / 编辑作者 / 编辑标签 / 编辑分类」是同一批字段，
 * 只是合并到一处，避免只为改一个标签先退回文献库。字段的落库由调用方拆分调用
 * Core 接口（见 `StudiandaApp` 的 `documentInfoMutation`）。
 */
import {
  DOCUMENT_TYPE_OPTIONS,
  type BookSummaryResult,
  type DocumentSummary,
  type FolderSummary
} from '@studianda/shared';
import type { ApiClient } from '@studianda/api-client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type JSX } from 'react';
import { onHostKeyDown } from '@studianda/ui';
import { appDialogs } from './dialogs.js';
import { requestReaderJump } from './reader-jump.js';
import type { RuntimeAdapter } from './runtime.js';

/** 导出用的 Markdown：注明摘要层与覆盖范围，章节保留页码便于回原文核对。 */
function buildBookSummaryMarkdown(
  documentName: string,
  result: BookSummaryResult
): string {
  const lastBlock = result.blocks[result.blocks.length - 1];
  const coverage = lastBlock ? `覆盖第 1–${lastBlock.end_page} 页` : '覆盖范围未知';
  return [
    `# ${documentName} · 全书摘要`,
    '',
    `> 生成时间：${new Date(result.created).toLocaleString('zh-CN')}；模型：${result.model}；${coverage}；合并层级：${result.merge_levels}。`,
    '> 本摘要由分层章节摘要合并生成，属于**摘要层**，不是逐字原文；关键结论请回到对应章节核对。',
    '> 仅供个人学习研究使用，请勿公开传播或用于替代原文；引用原文请遵守原文献的版权许可。',
    '',
    result.content,
    '',
    '## 章节 / 部分',
    ...result.blocks.map(
      (block) =>
        `- ${block.title}（第 ${block.page}–${block.end_page} 页，${block.cached ? '已缓存' : '待生成'}）`
    ),
    ''
  ].join('\n');
}

/** 弹窗提交的草稿：全部是清洗后的最终值，调用方不再二次加工。 */
export interface DocumentInfoDraft {
  name: string;
  author: string;
  tags: string[];
  docType: string;
  folderId: string;
}

export interface DocumentInfoDialogProps {
  api: ApiClient;
  adapter: RuntimeAdapter;
  document: DocumentSummary;
  folders: FolderSummary[];
  /** 调用方正在保存：按钮禁用，避免重复提交。 */
  saving: boolean;
  /** 调用方保存失败的原因；本地校验错误单独显示。 */
  error: string;
  onClose(): void;
  onSave(draft: DocumentInfoDraft): void;
}

/** 标签上限与 Core 的 setDocumentTags 校验保持一致：50 字、无控制字符。 */
const TAG_MAX_LENGTH = 50;
const CONTROL_CHARACTERS = /[\u0000-\u001f]/;

export function DocumentInfoDialog({
  api,
  adapter,
  document,
  folders,
  saving,
  error,
  onClose,
  onSave
}: DocumentInfoDialogProps): JSX.Element {
  const [name, setName] = useState(document.name);
  const [author, setAuthor] = useState(document.author);
  const [tags, setTags] = useState<string[]>(() => [...document.tags]);
  const [tagInput, setTagInput] = useState('');
  const [docType, setDocType] = useState(document.docType ?? '');
  const [folderId, setFolderId] = useState(document.folderId ?? '');
  const [localError, setLocalError] = useState('');

  useEffect(() => {
    return onHostKeyDown((event) => {
      if (event.key === 'Escape') onClose();
    });
  }, [onClose]);

  // 全书摘要：只读计划与缓存状态；生成在 Core 后台跑，弹窗轮询进度。
  const queryClient = useQueryClient();
  const summaryQuery = useQuery({
    queryKey: ['book-summary', document.id],
    queryFn: () => api.getBookSummary(document.id),
    refetchInterval: (query) =>
      query.state.data?.job.status === 'running' ? 1500 : false
  });
  const summaryData = summaryQuery.data;
  const summaryJob = summaryData?.job;
  const summaryInvalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['book-summary', document.id] });
  };
  const startSummary = useMutation({
    mutationFn: () => api.startBookSummary(document.id),
    onSuccess: summaryInvalidate
  });
  const cancelSummary = useMutation({
    mutationFn: () => api.cancelBookSummary(document.id),
    onSuccess: summaryInvalidate
  });
  const resetSummary = useMutation({
    mutationFn: () => api.resetBookSummary(document.id),
    onSuccess: summaryInvalidate
  });
  const formatTokenCount = (value: number): string =>
    value >= 10_000 ? `${Math.round(value / 1000)}k` : `${value}`;
  const beginBookSummary = (): void => {
    const plan = summaryData?.plan;
    if (!plan) return;
    if (plan.estimate.calls > 0) {
      const tokens = plan.estimate.input_tokens + plan.estimate.output_tokens;
      const ok = appDialogs.confirm(
        `生成全书摘要：共 ${plan.total} 个部分（已缓存 ${plan.cached} 个），` +
          `预计 ${plan.estimate.calls} 次模型调用、约 ${formatTokenCount(tokens)} token` +
          `（${plan.estimate.model || '当前会话模型'}）。已缓存的部分不会重复读；` +
          '生成结果保存在本机，之后可直接复用。',
        { title: '生成全书摘要' }
      );
      if (!ok) return;
    }
    startSummary.mutate();
  };
  const exportBookSummary = async (): Promise<void> => {
    const result = summaryData?.result;
    if (!result) return;
    const markdown = buildBookSummaryMarkdown(document.name, result);
    const filename = `${document.name.replace(/\.pdf$/i, '')}-全书摘要.md`;
    const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
    try {
      if (adapter.saveBlob) {
        await adapter.saveBlob(new Uint8Array(await blob.arrayBuffer()), filename);
        return;
      }
    } catch {
      // 用户取消保存：不提示错误。
      return;
    }
    // 宿主没有 saveBlob 时退回浏览器下载（DSH/Web 宿主）。
    const url = URL.createObjectURL(blob);
    const link = globalThis.document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  /** 校验并追加输入框里的标签；返回是否已加进草稿。 */
  const addTag = (): boolean => {
    const tag = tagInput.trim();
    if (!tag) return false;
    if (CONTROL_CHARACTERS.test(tag)) {
      setLocalError('标签不能包含控制字符。');
      return false;
    }
    if (tag.length > TAG_MAX_LENGTH) {
      setLocalError(`单个标签最多 ${TAG_MAX_LENGTH} 个字符。`);
      return false;
    }
    if (!tags.includes(tag)) setTags([...tags, tag]);
    setTagInput('');
    setLocalError('');
    return true;
  };

  const submit = (): void => {
    if (saving) return;
    const nextName = name.trim();
    if (!nextName) {
      setLocalError('标题不能为空。');
      return;
    }
    // 输入框里还没按 Enter 的标签也一起保存：避免用户以为填了就丢。
    const pendingTag = tagInput.trim();
    const nextTags = [...tags];
    if (pendingTag && !nextTags.includes(pendingTag)) {
      if (CONTROL_CHARACTERS.test(pendingTag) || pendingTag.length > TAG_MAX_LENGTH) {
        setLocalError(`单个标签最多 ${TAG_MAX_LENGTH} 个字符，且不能包含控制字符。`);
        return;
      }
      nextTags.push(pendingTag);
    }
    onSave({
      name: nextName,
      author: author.trim(),
      tags: nextTags,
      docType,
      folderId
    });
  };

  return (
    <div className="kr-modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="kr-modal kr-modal--doc-info"
        role="dialog"
        aria-modal="true"
        aria-label="文献信息"
        onClick={(event) => event.stopPropagation()}
      >
        <h2>文献信息</h2>
        <p className="kr-muted" title={document.name}>
          {document.name}
        </p>
        <div className="kr-doc-info">
          <label className="kr-modal__field">
            标题
            <input
              autoFocus
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                setLocalError('');
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  submit();
                }
              }}
            />
          </label>
          <label className="kr-modal__field">
            作者
            <input
              value={author}
              placeholder="多位作者可用分号或逗号分隔"
              onChange={(event) => setAuthor(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  submit();
                }
              }}
            />
          </label>
          <div className="kr-doc-info__row">
            <label className="kr-modal__field">
              文献类型
              <select
                value={docType}
                onChange={(event) => setDocType(event.target.value)}
              >
                <option value="">未分类</option>
                {DOCUMENT_TYPE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="kr-modal__field">
              所在文件夹
              <select
                value={folderId}
                onChange={(event) => setFolderId(event.target.value)}
              >
                <option value="">未分类</option>
                {folders.map((folder) => (
                  <option key={folder.id} value={folder.id}>
                    {folder.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="kr-modal__field">
            标签
            <div className="kr-tag-editor">
              <div className="kr-tag-editor__chips">
                {tags.length === 0 ? (
                  <span className="kr-doc-info__empty">还没有标签</span>
                ) : null}
                {tags.map((tag) => (
                  <button
                    key={tag}
                    type="button"
                    title={`移除标签「${tag}」`}
                    aria-label={`移除标签 ${tag}`}
                    onClick={() =>
                      setTags((current) => current.filter((item) => item !== tag))
                    }
                  >
                    {tag} ×
                  </button>
                ))}
              </div>
              <div className="kr-tag-editor__input">
                <input
                  value={tagInput}
                  placeholder="输入标签，按 Enter 添加"
                  aria-label="添加标签"
                  onChange={(event) => setTagInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      addTag();
                    }
                  }}
                />
                <button type="button" onClick={() => void addTag()}>
                  添加
                </button>
              </div>
            </div>
          </div>
        </div>
        {summaryData ? (
          <div className="kr-book-summary">
            <div className="kr-book-summary__head">
              <strong>全书摘要</strong>
              <span className="kr-muted">
                {summaryData.plan.total > 0
                  ? `${summaryData.plan.cached}/${summaryData.plan.total} 个部分已缓存`
                  : '没有可摘要的页面'}
              </span>
            </div>
            {summaryData.overview ? (
              <details className="kr-book-summary__result">
                <summary>目录 / 页区间概览（T1，不调用模型）</summary>
                <pre className="kr-book-summary__content">{summaryData.overview}</pre>
              </details>
            ) : null}
            {summaryData.result ? (
              <details className="kr-book-summary__result">
                <summary>
                  查看已生成的全书摘要（摘要层，非逐字原文；
                  {summaryData.result.blocks.length > 0
                    ? `覆盖第 1–${summaryData.result.blocks[summaryData.result.blocks.length - 1]!.end_page} 页`
                    : '覆盖范围未知'}
                  ）
                </summary>
                <pre className="kr-book-summary__content">{summaryData.result.content}</pre>
                <ul className="kr-book-summary__chapters">
                  {summaryData.result.blocks.map((block) => (
                    <li key={`${block.page}-${block.end_page}`}>
                      <button
                        type="button"
                        className="kr-link-button"
                        onClick={() => {
                          if (!requestReaderJump(block.page)) {
                            appDialogs.alert('请先在阅读页打开这篇文献，再点页码跳转。');
                            return;
                          }
                          onClose();
                        }}
                      >
                        {block.title}（第 {block.page}–{block.end_page} 页）
                      </button>
                    </li>
                  ))}
                </ul>
              </details>
            ) : (
              <p className="kr-muted">
                尚未生成。生成会按章节/页区间逐块摘要再合并；已缓存的部分不会重复调用模型。
              </p>
            )}
            {summaryJob?.status === 'running' ? (
              <p className="kr-muted" role="status">
                正在生成：{summaryJob.phase}（{summaryJob.done}/{summaryJob.total}）
              </p>
            ) : null}
            {summaryJob?.status === 'error' ? (
              <p className="kr-modal__error" role="alert">
                生成失败：{summaryJob.error ?? '未知错误'}
              </p>
            ) : null}
            {startSummary.error ? (
              <p className="kr-modal__error" role="alert">
                {startSummary.error.message}
              </p>
            ) : null}
            {summaryData.plan.estimate.calls > 0 ? (
              <p className="kr-modal__hint">
                预计还需 {summaryData.plan.estimate.calls} 次模型调用、约{' '}
                {formatTokenCount(
                  summaryData.plan.estimate.input_tokens +
                    summaryData.plan.estimate.output_tokens
                )}{' '}
                token（{summaryData.plan.estimate.model || '当前会话模型'}）。
              </p>
            ) : null}
            <p className="kr-modal__hint">
              全书摘要是 AI 生成的衍生摘要，仅用于个人学习研究，请勿公开传播或用于替代原文；
              导出文件会保留这一说明。
            </p>
            <div className="kr-book-summary__actions">
              {summaryJob?.status === 'running' ? (
                <button
                  type="button"
                  className="kr-ghost"
                  onClick={() => cancelSummary.mutate()}
                  disabled={cancelSummary.isPending}
                >
                  取消生成
                </button>
              ) : (
                <button
                  type="button"
                  className="kr-primary"
                  onClick={beginBookSummary}
                  disabled={startSummary.isPending || summaryData.plan.estimate.calls === 0}
                  title={
                    summaryData.plan.estimate.calls === 0
                      ? '所有部分都已缓存，无需重新生成'
                      : undefined
                  }
                >
                  {startSummary.isPending
                    ? '生成中…'
                    : summaryData.result
                      ? '继续生成缺失部分'
                      : '生成全书摘要'}
                </button>
              )}
              {summaryData.plan.cached > 0 ? (
                <button
                  type="button"
                  className="kr-ghost"
                  onClick={() => {
                    if (!appDialogs.confirm('清空这篇文献的全书摘要缓存？下次需要重新生成。')) {
                      return;
                    }
                    resetSummary.mutate();
                  }}
                  disabled={resetSummary.isPending || summaryJob?.status === 'running'}
                >
                  清空缓存
                </button>
              ) : null}
              {summaryData.result ? (
                <button type="button" className="kr-ghost" onClick={() => void exportBookSummary()}>
                  导出 Markdown
                </button>
              ) : null}
            </div>
          </div>
        ) : (
          <p className="kr-modal__hint">正在读取全书摘要状态…</p>
        )}
        <p className="kr-modal__hint">保存后会同步到文献库的分栏、文件夹计数与标签筛选。</p>
        {localError || error ? (
          <p className="kr-modal__error" role="alert">
            {localError || error}
          </p>
        ) : null}
        <div className="kr-modal__actions">
          <button
            type="button"
            className="kr-ghost"
            onClick={onClose}
            disabled={saving}
          >
            取消
          </button>
          <button
            type="button"
            className="kr-primary"
            onClick={submit}
            disabled={saving}
          >
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  );
}
