import { useEffect, useState, type JSX, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { NavigationStatus, TocNavigationPreview } from '@studianda/shared';
import { getAppPortalRoot } from './portal-root.js';

/**
 * 阅读器「目录」面板。
 *
 * 展示优先级：有 PDF 内置目录时默认展示内置目录；没有时展示本地目录。
 * 两者都有时用页签切换。编辑对「当前展示的目录」生效：保存后写成本地目录并切到本地。
 *
 * 生成入口收进「目录生成…」按钮里，不再默认铺开；两种方式都保留：
 * 1. 按目录页生成（指定书前印刷目录页，识别标题/页码并对齐物理页）；
 * 2. 按标题规则生成（扫描全文标题/字号规则）。
 */
export interface OutlineDraftEntry {
  page: number;
  label: string;
}

export interface OutlineNodeView {
  title: string;
  page: number | null;
}

export type OutlineSource = 'embedded' | 'local';

export interface OutlinePanelProps {
  totalPages: number;
  currentPage: number;
  embedded: OutlineNodeView[];
  generated: OutlineNodeView[];
  source: OutlineSource;
  onSourceChange(source: OutlineSource): void;
  status?: NavigationStatus | null;
  statusLoading?: boolean;
  gateReason?: string;
  enabled: boolean;
  enabledDisabled?: boolean;
  enableError?: string;
  onToggleEnabled(enabled: boolean): void;

  /** 「按目录页生成」输入（如 3-5 / 3,4）。 */
  tocPagesInput: string;
  onTocPagesInputChange(value: string): void;
  tocPagesValid: boolean;
  preview?: TocNavigationPreview | null;
  previewPending?: boolean;
  previewError?: string;
  onPreview(): void;
  onGenerateFromToc(): void;
  onGenerateFromTitles(): void;
  onClearTocPages(): void;
  generating?: boolean;
  buildError?: string;

  /** 手动编辑：传入要编辑的初始条目（内置目录或本地目录）。 */
  editing: boolean;
  draft: OutlineDraftEntry[];
  onDraftChange(next: OutlineDraftEntry[]): void;
  onStartEdit(seed: OutlineDraftEntry[]): void;
  onStartManual(): void;
  onSave(): void;
  onCancelEdit(): void;
  saving?: boolean;
  saveError?: string;

  onOpenEntry(entry: OutlineNodeView): void;
  truncated?: { shown: number; total: number } | null;
  /** 面板底部额外内容（图表/公式节点等）。 */
  footer?: ReactNode;
}

const STATUS_LABELS: Record<NavigationStatus['state'], string> = {
  missing: '未生成',
  ready: '已就绪',
  stale: '已过期',
  building: '生成中',
  failed: '生成失败'
};

function statusText(status: NavigationStatus | null | undefined): string {
  if (!status) return '未生成';
  const base = STATUS_LABELS[status.state] ?? status.state;
  if (status.state === 'ready') {
    if (status.manual) return '手动编辑';
    if (status.materialized) return '内置目录副本';
  }
  if (status.state === 'building') {
    return `${base} ${status.done ?? 0}/${status.total ?? 0}`;
  }
  return base;
}

function statusTone(status: NavigationStatus | null | undefined): string {
  if (!status) return 'missing';
  if (status.state === 'ready') {
    if (status.manual) return 'manual';
    if (status.materialized) return 'materialized';
    return 'ready';
  }
  return status.state;
}

function formatOffset(value: number | undefined): string {
  if (value === undefined) return '—';
  if (value === 0) return '0';
  return value > 0 ? `+${value}` : String(value);
}

export function OutlinePanel({
  totalPages,
  currentPage,
  embedded,
  generated,
  source,
  onSourceChange,
  status,
  statusLoading,
  gateReason,
  enabled,
  enabledDisabled,
  enableError,
  onToggleEnabled,
  tocPagesInput,
  onTocPagesInputChange,
  tocPagesValid,
  preview,
  previewPending,
  previewError,
  onPreview,
  onGenerateFromToc,
  onGenerateFromTitles,
  onClearTocPages,
  generating,
  buildError,
  editing,
  draft,
  onDraftChange,
  onStartEdit,
  onStartManual,
  onSave,
  onCancelEdit,
  saving,
  saveError,
  onOpenEntry,
  truncated,
  footer
}: OutlinePanelProps): JSX.Element {
  const [generatorOpen, setGeneratorOpen] = useState(false);
  useEffect(() => {
    if (!generatorOpen) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setGeneratorOpen(false);
    };
    window.document.addEventListener('keydown', onKey);
    return () => window.document.removeEventListener('keydown', onKey);
  }, [generatorOpen]);
  const tocPages = status?.toc_pages ?? [];
  const hasEmbedded = embedded.length > 0;
  const hasLocal = generated.length > 0;
  // 只有内置目录、还没生成本地目录时，状态徽标要说明"内置目录可用"，而不是误导成"什么都没生成"。
  const embeddedOnlyMissing = hasEmbedded && (!status || status.state === 'missing');
  const displayedGateReason = embeddedOnlyMissing
    ? 'PDF 有内置目录；勾选「启用目录参与阅读规划」时会自动把内置目录保存为本地目录。'
    : gateReason;
  const shown = source === 'embedded' && hasEmbedded ? embedded : generated;
  const sourceLabel =
    source === 'embedded' && hasEmbedded ? 'PDF 内置目录' : '本地目录';
  const draftInvalid = draft.some(
    (entry) =>
      !entry.label.trim() ||
      !Number.isInteger(entry.page) ||
      entry.page < 1 ||
      entry.page > totalPages
  );
  const updateDraft = (index: number, patch: Partial<OutlineDraftEntry>): void => {
    onDraftChange(draft.map((entry, itemIndex) => (itemIndex === index ? { ...entry, ...patch } : entry)));
  };
  const seedOf = (nodes: OutlineNodeView[]): OutlineDraftEntry[] =>
    nodes
      .filter((entry) => entry.page != null)
      .map((entry) => ({ page: entry.page as number, label: entry.title }));

  return (
    <div className="kr-outline2">
      <header className="kr-outline2__head">
        <div className="kr-outline2__heading">
          <strong>目录</strong>
          <span className="kr-outline2__sub">
            第 {currentPage} 页 · 共 {totalPages} 页
          </span>
        </div>
        <span
          className={`kr-outline2__badge is-${embeddedOnlyMissing ? 'ready' : statusTone(status)}`}
        >
          {statusLoading ? '读取中…' : embeddedOnlyMissing ? '内置目录' : statusText(status)}
        </span>
      </header>

      {displayedGateReason ? <p className="kr-outline2__hint">{displayedGateReason}</p> : null}
      {buildError ? <p className="kr-page-error">{buildError}</p> : null}
      {status?.state === 'failed' ? (
        <p className="kr-page-error">{status.error || '目录生成失败'}</p>
      ) : null}

      <div className="kr-outline2__enable">
        <label>
          <input
            type="checkbox"
            checked={enabled}
            disabled={enabledDisabled}
            onChange={(event) => onToggleEnabled(event.target.checked)}
          />
          <span>启用目录参与阅读规划</span>
        </label>
        {enableError ? <span className="kr-page-error">{enableError}</span> : null}
      </div>

      {hasEmbedded && hasLocal ? (
        <div className="kr-outline2__sources" role="tablist" aria-label="目录来源">
          <button
            type="button"
            role="tab"
            aria-selected={source === 'embedded'}
            className={source === 'embedded' ? 'is-active' : ''}
            onClick={() => onSourceChange('embedded')}
          >
            PDF 内置目录 · {embedded.length}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={source === 'local'}
            className={source === 'local' ? 'is-active' : ''}
            onClick={() => onSourceChange('local')}
          >
            本地目录 · {generated.length}
          </button>
        </div>
      ) : null}

      <section className="kr-outline2__card">
        <div className="kr-outline2__card-head">
          <h4>{sourceLabel}</h4>
          <span className="kr-outline2__count">{shown.length} 条</span>
          {!editing ? (
            <div className="kr-outline2__actions">
              <button
                type="button"
                onClick={() => onStartEdit(seedOf(shown))}
                disabled={shown.length === 0}
              >
                编辑
              </button>
              <button type="button" onClick={onStartManual}>
                ＋ 手动
              </button>
              <button type="button" onClick={() => setGeneratorOpen(true)}>
                目录生成…
              </button>
            </div>
          ) : null}
        </div>

        {editing ? (
          <div className="kr-outline2__editor">
            {draft.length === 0 ? (
              <p className="kr-outline2__hint">还没有条目，点下面「＋ 添加一行」开始。</p>
            ) : (
              draft.map((entry, index) => (
                <div className="kr-outline2__editor-row" key={index}>
                  <input
                    className="kr-outline2__page-input"
                    type="number"
                    min={1}
                    max={totalPages}
                    value={entry.page}
                    aria-label="目录页码"
                    onChange={(event) => updateDraft(index, { page: Number(event.target.value) })}
                  />
                  <input
                    className="kr-outline2__label-input"
                    value={entry.label}
                    placeholder="章节标题"
                    aria-label="目录标题"
                    onChange={(event) => updateDraft(index, { label: event.target.value })}
                  />
                  <button
                    type="button"
                    className="kr-outline2__danger"
                    onClick={() => onDraftChange(draft.filter((_, itemIndex) => itemIndex !== index))}
                  >
                    删除
                  </button>
                </div>
              ))
            )}
            <div className="kr-outline2__actions kr-outline2__actions--row">
              <button
                type="button"
                onClick={() => onDraftChange([...draft, { page: currentPage, label: '' }])}
              >
                ＋ 添加一行
              </button>
              <button
                type="button"
                className="kr-outline2__primary"
                disabled={draft.length === 0 || draftInvalid || saving}
                onClick={onSave}
              >
                {saving ? '保存中…' : '保存为本地目录'}
              </button>
              <button type="button" onClick={onCancelEdit}>
                取消
              </button>
            </div>
            {draft.length > 0 && draftInvalid ? (
              <p className="kr-outline2__hint">页码必须是 1–{totalPages} 的整数，标题不能为空。</p>
            ) : null}
            {saveError ? <p className="kr-page-error">{saveError}</p> : null}
          </div>
        ) : shown.length > 0 ? (
          <>
            <ul className="kr-outline2__list">
              {shown.map((entry, index) => (
                <li key={`${entry.title}-${index}`}>
                  <button
                    type="button"
                    className="kr-outline2__row"
                    disabled={entry.page == null}
                    onClick={() => onOpenEntry(entry)}
                  >
                    <span className="kr-outline2__page">第 {entry.page ?? '?'} 页</span>
                    <span className="kr-outline2__title">{entry.title || '（无标题）'}</span>
                  </button>
                </li>
              ))}
            </ul>
            {truncated && source !== 'embedded' ? (
              <p className="kr-outline2__hint">
                仅显示前 {truncated.shown} 条，共 {truncated.total} 条
              </p>
            ) : null}
          </>
        ) : (
          <p className="kr-outline2__hint">
            还没有目录。用「目录生成…」按目录页或标题规则生成，或点「＋ 手动」直接录入。
          </p>
        )}
      </section>

      {generatorOpen
        ? createPortal(
        <div className="kr-root">
        <div
          className="kr-outline2-modal"
          role="dialog"
          aria-modal="true"
          aria-label="目录生成"
          onClick={(event) => {
            if (event.target === event.currentTarget) setGeneratorOpen(false);
          }}
        >
          <div className="kr-outline2-modal__dialog">
            <div className="kr-outline2-modal__head">
              <strong>目录生成</strong>
              <button
                type="button"
                className="kr-outline2-modal__close"
                aria-label="关闭目录生成"
                onClick={() => setGeneratorOpen(false)}
              >
                ×
              </button>
            </div>
            <section className="kr-outline2__generator">
              <div className="kr-outline2__card-head">
                <span className="kr-outline2__hint">选择一种方式生成本地目录</span>
                {tocPages.length > 0 ? (
                  <span className="kr-outline2__badge is-ready">目录页 {tocPages.join('、')}</span>
                ) : null}
              </div>

          <div className="kr-outline2__method">
            <strong>方式一 · 按目录页生成</strong>
            <p className="kr-outline2__hint">
              填书前印刷目录的页范围（如 <code>3-5</code> 或 <code>3,4</code>），识别标题与印刷页码并自动对齐物理页。
            </p>
            <div className="kr-outline2__toc-controls">
              <input
                value={tocPagesInput}
                onChange={(event) => onTocPagesInputChange(event.target.value)}
                placeholder="目录页，如 3-5"
                aria-label="目录页范围"
                className="kr-outline2__toc-input"
              />
              <button
                type="button"
                className="kr-outline2__primary"
                disabled={!tocPagesValid || previewPending}
                onClick={onPreview}
              >
                {previewPending ? '识别中…' : '识别目录页'}
              </button>
              {tocPages.length > 0 ? (
                <button type="button" disabled={generating} onClick={onClearTocPages}>
                  清除目录页
                </button>
              ) : null}
            </div>
            {!tocPagesValid && tocPagesInput.trim() ? (
              <p className="kr-outline2__hint">
                目录页格式不对：用 3、3,4 或 3-5（页码 1–{totalPages}）。
              </p>
            ) : null}
            {previewError ? <p className="kr-page-error">{previewError}</p> : null}
            {preview ? (
              <div className="kr-outline2__preview">
                <div className="kr-outline2__chips">
                  <span>条目 {preview.stats.entries}</span>
                  <span>页码偏移 {formatOffset(preview.stats.offset)}</span>
                  <span>置信度 {Math.round(preview.stats.offsetConfidence * 100)}%</span>
                  {preview.stats.romanEntries ? (
                    <span>
                      罗马页码 {preview.stats.romanEntries} 条（偏移{' '}
                      {formatOffset(preview.stats.romanOffset)}）
                    </span>
                  ) : null}
                  <span>可生成 {preview.stats.nodes} 条</span>
                  {preview.stats.skipped > 0 ? (
                    <span className="is-warn">跳过 {preview.stats.skipped}</span>
                  ) : null}
                </div>
                {preview.warnings.length > 0 ? (
                  <ul className="kr-outline2__warnings">
                    {preview.warnings.map((warning, index) => (
                      <li key={index}>{warning}</li>
                    ))}
                  </ul>
                ) : null}
                <ul className="kr-outline2__preview-list">
                  {preview.entries.slice(0, 40).map((entry, index) => {
                    const printed = entry.printedPage;
                    const offset =
                      entry.pageKind === 'roman' ? preview.stats.romanOffset : preview.stats.offset;
                    const physical = printed == null ? null : printed + (offset ?? 0);
                    const valid = physical != null && physical >= 1 && physical <= totalPages;
                    return (
                      <li key={`${entry.title}-${index}`}>
                        <span className="kr-outline2__title">{entry.title}</span>
                        <span className="kr-outline2__page">
                          {printed == null
                            ? '无页码'
                            : `${entry.printedPageLabel ?? printed} → ${valid ? `第 ${physical} 页` : '超出范围'}`}
                        </span>
                      </li>
                    );
                  })}
                </ul>
                {preview.entries.length > 40 ? (
                  <p className="kr-outline2__hint">
                    仅显示前 40 条，共 {preview.entries.length} 条。
                  </p>
                ) : null}
                <button
                  type="button"
                  className="kr-outline2__primary"
                  disabled={generating || preview.stats.nodes === 0}
                  onClick={() => {
                    onGenerateFromToc();
                    setGeneratorOpen(false);
                  }}
                >
                  {generating ? '生成中…' : '用这些条目生成本地目录'}
                </button>
              </div>
            ) : null}
          </div>

          <div className="kr-outline2__method">
            <strong>方式二 · 按标题规则生成</strong>
            <p className="kr-outline2__hint">
              扫描全文章节标题/字号规则生成本地目录（不需要目录页；旧版本地生成方式）。
            </p>
            <button
              type="button"
              disabled={generating}
              onClick={() => {
                onGenerateFromTitles();
                setGeneratorOpen(false);
              }}
            >
              {generating ? '生成中…' : '按标题规则生成本地目录'}
            </button>
          </div>
            </section>
            <div className="kr-outline2-modal__foot">
              <button type="button" onClick={() => setGeneratorOpen(false)}>
                关闭
              </button>
            </div>
          </div>
        </div>
        </div>,
        getAppPortalRoot()
      )
        : null}

      {footer}
    </div>
  );
}
