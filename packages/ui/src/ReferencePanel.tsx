import { resolveConfirm, type ConfirmAction } from './dialog-utils.js';
import { useState, type JSX } from 'react';
import type {
  DocumentReferences,
  ReferenceCitation,
  ReferenceEntry,
  ReferenceEntryInput
} from '@studianda/shared';

/**
 * 阅读侧「参考文献」面板：文末参考文献 + 页面底部脚注式引用 + 当前页引用标记。
 *
 * 只做展示与跳转；识别字段可能为空（识别不出时留空），界面按"能显示多少显示多少"，不编造。
 * 识别错误可以由用户兜底：条目可编辑、删除，也可以手动新增；编辑是覆盖层，可一键重置。
 */
export interface ReferencePanelProps {
  currentPage: number;
  references?: DocumentReferences | null;
  loading?: boolean;
  error?: string;
  /** 正在保存编辑（按钮显示"保存中"）。 */
  saving?: boolean;
  /** 跳到条目所在页并高亮条目块。 */
  onLocateEntry(entry: ReferenceEntry): void;
  /** 跳到引用所在页并高亮引用块。 */
  onLocateCitation(citation: ReferenceCitation): void;
  onEditEntry?(entryId: string, patch: ReferenceEntryInput): void;
  onDeleteEntry?(entryId: string): void;
  onAddEntry?(input: ReferenceEntryInput): void;
  onResetEdits?(): void;
  /** 确认框实现（宿主注入；默认浏览器原生 confirm）。 */
  confirmAction?: ConfirmAction;
}

interface EditorState {
  mode: 'edit' | 'add';
  entryId: string;
  draft: ReferenceEntryInput;
}

function entrySummary(entry: ReferenceEntry): string {
  const parts = [entry.authors, entry.year, entry.title].filter((part) => part.trim());
  if (parts.length > 0) return parts.join(' · ');
  return entry.raw.length > 140 ? `${entry.raw.slice(0, 140)}…` : entry.raw;
}

function editorDraftOf(entry: ReferenceEntry): ReferenceEntryInput {
  return {
    label: entry.label,
    authors: entry.authors,
    year: entry.year,
    title: entry.title,
    venue: entry.venue,
    raw: entry.raw
  };
}

function ReferenceEditor({
  state,
  saving,
  onCancel,
  onSave
}: {
  state: EditorState;
  saving?: boolean;
  onCancel(): void;
  onSave(draft: ReferenceEntryInput): void;
}): JSX.Element {
  const [draft, setDraft] = useState<ReferenceEntryInput>(state.draft);
  const update = (key: keyof ReferenceEntryInput, value: string): void =>
    setDraft((current) => ({ ...current, [key]: value }));
  return (
    <div className="kr-refs__editor">
      <div className="kr-refs__editor-row">
        <label>
          编号
          <input value={draft.label ?? ''} onChange={(event) => update('label', event.target.value)} />
        </label>
        <label>
          年份
          <input value={draft.year ?? ''} onChange={(event) => update('year', event.target.value)} />
        </label>
      </div>
      <label>
        作者
        <input
          value={draft.authors ?? ''}
          onChange={(event) => update('authors', event.target.value)}
        />
      </label>
      <label>
        标题
        <input value={draft.title ?? ''} onChange={(event) => update('title', event.target.value)} />
      </label>
      <label>
        出处（期刊/出版社）
        <input value={draft.venue ?? ''} onChange={(event) => update('venue', event.target.value)} />
      </label>
      <label>
        条目原文
        <textarea
          rows={2}
          value={draft.raw ?? ''}
          onChange={(event) => update('raw', event.target.value)}
        />
      </label>
      <div className="kr-refs__editor-actions">
        <button type="button" className="kr-refs__save" disabled={saving} onClick={() => onSave(draft)}>
          {saving ? '保存中…' : '保存'}
        </button>
        <button type="button" onClick={onCancel}>
          取消
        </button>
      </div>
    </div>
  );
}

export function ReferencePanel({
  currentPage,
  references,
  loading,
  error,
  saving,
  onLocateEntry,
  onLocateCitation,
  onEditEntry,
  onDeleteEntry,
  onAddEntry,
  onResetEdits,
  confirmAction
}: ReferencePanelProps): JSX.Element {
  const [editor, setEditor] = useState<EditorState | null>(null);
  const entries = references?.entries ?? [];
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const citations = references?.citations[String(currentPage)] ?? [];
  const endEntries = entries.filter((entry) => entry.kind === 'end');
  const footnoteEntries = entries.filter((entry) => entry.kind === 'footnote');
  const unresolved = citations.filter((citation) => citation.entryIds.length === 0);
  const editable = Boolean(onEditEntry && onDeleteEntry);

  const saveEditor = (draft: ReferenceEntryInput): void => {
    if (!editor) return;
    if (editor.mode === 'add') onAddEntry?.(draft);
    else onEditEntry?.(editor.entryId, draft);
    setEditor(null);
  };

  const renderEntryActions = (entry: ReferenceEntry): JSX.Element | null => {
    if (!editable) return null;
    return (
      <span className="kr-refs__actions">
        {entry.source === 'manual' ? <em className="kr-refs__badge">手动</em> : null}
        {entry.edited ? <em className="kr-refs__badge">已编辑</em> : null}
        <button
          type="button"
          onClick={() =>
            setEditor({ mode: 'edit', entryId: entry.id, draft: editorDraftOf(entry) })
          }
        >
          编辑
        </button>
        <button
          type="button"
          onClick={() => {
            if (!resolveConfirm(confirmAction)('删除这条参考文献？识别条目可以「恢复自动识别」找回。')) return;
            onDeleteEntry?.(entry.id);
          }}
        >
          删除
        </button>
      </span>
    );
  };

  return (
    <div className="kr-refs">
      {loading ? <p className="kr-refs__status">正在识别参考文献…</p> : null}
      {error ? <p className="kr-page-error">读取参考文献失败：{error}</p> : null}
      {!loading && !error && entries.length === 0 && citations.length === 0 ? (
        <p className="kr-refs__status">
          没有识别到参考文献。可能是扫描件（需要先 OCR）、没有「参考文献 / References」小节，
          或正文里没有可识别的引用标记（如 [1]、(Smith, 2020)）。可以手动新增条目兜底。
        </p>
      ) : null}

      {references ? (
        <>
          <p className="kr-refs__stats">
            文末条目 {references.stats.endEntries} 条 · 页下注 {references.stats.footnoteEntries} 条
            {references.stats.manualEntries > 0
              ? ` · 手动 ${references.stats.manualEntries} 条`
              : ''}
            {references.stats.editedEntries > 0
              ? ` · 已编辑 ${references.stats.editedEntries} 条`
              : ''}
            {' · '}全篇引用 {references.stats.citations} 处（未解析{' '}
            {references.stats.unresolvedCitations} 处）
          </p>
          {references.stats.staleEdits > 0 ? (
            <p className="kr-refs__stale">
              有 {references.stats.staleEdits} 条编辑因重新识别/换文件而失效，已被忽略。
            </p>
          ) : null}
          {onResetEdits ? (
            <p className="kr-refs__reset">
              <button
                type="button"
                onClick={() => {
                  if (!resolveConfirm(confirmAction)('清空本地的全部参考文献编辑，恢复自动识别结果？')) return;
                  onResetEdits();
                }}
              >
                恢复自动识别
              </button>
            </p>
          ) : null}
        </>
      ) : null}

      {editor ? (
        <ReferenceEditor
          key={`${editor.mode}:${editor.entryId}`}
          state={editor}
          saving={saving}
          onCancel={() => setEditor(null)}
          onSave={saveEditor}
        />
      ) : null}

      <section className="kr-refs__section">
        <h4>本页引用</h4>
        {citations.length === 0 ? (
          <p className="kr-refs__empty">第 {currentPage} 页没有识别到引用标记。</p>
        ) : (
          <ul className="kr-refs__list">
            {citations.map((citation) => {
              const resolved = citation.entryIds
                .map((id) => byId.get(id))
                .filter((entry): entry is ReferenceEntry => Boolean(entry));
              return (
                <li key={`${citation.blockId}-${citation.label}`} className="kr-refs__item">
                  <button
                    type="button"
                    className="kr-refs__jump"
                    onClick={() => onLocateCitation(citation)}
                    title="跳到这句引用在原文的位置"
                  >
                    {citation.label}
                  </button>
                  <div className="kr-refs__body">
                    <p className="kr-refs__snippet">{citation.text}</p>
                    {resolved.length > 0 ? (
                      <ul className="kr-refs__resolved">
                        {resolved.map((entry) => (
                          <li key={entry.id}>
                            <button
                              type="button"
                              className="kr-refs__entry-link"
                              onClick={() => onLocateEntry(entry)}
                              title="跳到这条参考文献"
                            >
                              {entrySummary(entry)}
                            </button>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="kr-refs__unresolved">未在参考文献表中找到对应条目。</p>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {unresolved.length > 0 ? (
          <p className="kr-refs__empty">
            其中 {unresolved.length} 处引用没有解析到条目，可能是参考文献表缺失或编号不一致。
          </p>
        ) : null}
      </section>

      <section className="kr-refs__section">
        <h4>
          文末参考文献 · {endEntries.length} 条
          {onAddEntry ? (
            <button
              type="button"
              className="kr-refs__add"
              onClick={() =>
                setEditor({
                  mode: 'add',
                  entryId: 'new',
                  draft: { kind: 'end', page: currentPage, label: '', raw: '' }
                })
              }
            >
              ＋ 添加条目
            </button>
          ) : null}
        </h4>
        {endEntries.length === 0 ? (
          <p className="kr-refs__empty">没有识别到文末参考文献条目。</p>
        ) : (
          <ul className="kr-refs__list">
            {endEntries.map((entry) => (
              <li key={entry.id} className="kr-refs__item">
                <button
                  type="button"
                  className="kr-refs__jump"
                  onClick={() => onLocateEntry(entry)}
                  title={`跳到第 ${entry.page} 页的这条参考文献`}
                >
                  {entry.label || '—'}
                </button>
                <div className="kr-refs__body">
                  <button
                    type="button"
                    className="kr-refs__entry-link"
                    onClick={() => onLocateEntry(entry)}
                  >
                    {entrySummary(entry)}
                  </button>
                  <p className="kr-refs__meta">
                    第 {entry.page} 页{entry.sectionTitle ? ` · ${entry.sectionTitle}` : ''}
                  </p>
                  {renderEntryActions(entry)}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="kr-refs__section">
        <h4>页面底部引用 · {footnoteEntries.length} 条</h4>
        {footnoteEntries.length === 0 ? (
          <p className="kr-refs__empty">没有识别到页面底部的脚注式引用。</p>
        ) : (
          <ul className="kr-refs__list">
            {footnoteEntries.map((entry) => (
              <li key={entry.id} className="kr-refs__item">
                <button
                  type="button"
                  className="kr-refs__jump"
                  onClick={() => onLocateEntry(entry)}
                  title={`跳到第 ${entry.page} 页的这条页下注`}
                >
                  {entry.label || '注'}
                </button>
                <div className="kr-refs__body">
                  <button
                    type="button"
                    className="kr-refs__entry-link"
                    onClick={() => onLocateEntry(entry)}
                  >
                    {entrySummary(entry)}
                  </button>
                  <p className="kr-refs__meta">第 {entry.page} 页</p>
                  {renderEntryActions(entry)}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
