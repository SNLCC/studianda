import { useState, type FormEvent } from 'react';
import type React from 'react';
import type {
  AnnotationRecord,
  BacklinkRecord,
  DocumentSummary,
  MarkdownInternalTarget,
  NoteRecord
} from '@studianda/shared';
import { Backlinks, type BacklinkTarget } from './Backlinks.js';
import { MarkdownContent } from './MarkdownContent.js';
import { MarkdownEditor, type MarkdownImageUpload } from './MarkdownEditor.js';
import { confirmPurgeNote } from './note-purge.js';
import type { ConfirmAction } from './dialog-utils.js';

export interface NotesPanelProps {
  notes: NoteRecord[];
  currentPage: number;
  onCreate(page: number, content: string): void;
  onUpdate(id: string, input: { page: number; content: string }): void;
  /** 软删除：移入回收站（可恢复）。 */
  onDelete(id: string): void;
  /** 从回收站恢复。 */
  onRestore(id: string): void;
  /** 彻底删除（不可恢复，同时回收只被它引用的图片资源）。 */
  onPurge(id: string): void;
  /** 确认框实现（宿主注入；默认浏览器原生 confirm）。 */
  confirmAction?: ConfirmAction;
  /** 回收站里的笔记（按需加载）。 */
  trashNotes?: NoteRecord[];
  trashLoading?: boolean;
  /** 切换回收站视图：上层据此按需请求 trash 列表。 */
  onTrashChange?(showTrash: boolean): void;
  /** 初始是否显示回收站（默认 false，主要便于测试/恢复视图状态）。 */
  defaultShowTrash?: boolean;
  creating?: boolean;
  updating?: boolean;
  /** 内部引用弹窗的文献列表；不传则编辑器不可插入内部引用。 */
  documents?: DocumentSummary[];
  /** 内部引用弹窗选择批注时使用。 */
  loadAnnotations?(documentId: string): Promise<AnnotationRecord[]>;
  /** 内部引用弹窗选择笔记时使用。 */
  loadNotes?(documentId: string): Promise<NoteRecord[]>;
  /** 独立笔记列表：note 引用 tab 里可直接引用它们。 */
  standaloneNotes?: NoteRecord[];
  /** 点击笔记内容里的 [[内部引用]]：由上层负责打开文献/批注/笔记。 */
  onOpenInternal?(target: MarkdownInternalTarget): void;
  /** 点击 studianda-asset: 附件链接时回调（app 用 adapter.openNoteAsset）。 */
  onOpenAsset?(url: string): void | Promise<void>;
  /** 图片上传器：有则把图片存成 studianda-asset 资源；失败只报错、不回退内联。 */
  uploadImage?: MarkdownImageUpload;
  /** 反向链接懒加载；不传则笔记卡片不显示「被引用」。 */
  loadBacklinks?(target: BacklinkTarget): Promise<BacklinkRecord[]>;
  /** 点击反向链接：打开来源文献并跳到来源页。 */
  onOpenBacklink?(backlink: BacklinkRecord): void;
}

export function NotesPanel({
  notes,
  currentPage,
  onCreate,
  onUpdate,
  onDelete,
  onRestore,
  onPurge,
  confirmAction,
  trashNotes = [],
  trashLoading = false,
  onTrashChange,
  defaultShowTrash = false,
  creating = false,
  updating = false,
  documents = [],
  loadAnnotations,
  loadNotes,
  standaloneNotes,
  onOpenInternal,
  onOpenAsset,
  uploadImage,
  loadBacklinks,
  onOpenBacklink
}: NotesPanelProps): React.JSX.Element {
  const [content, setContent] = useState('');
  const [wholeDocument, setWholeDocument] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState('');
  const [editPage, setEditPage] = useState('0');
  const [showTrash, setShowTrash] = useState(defaultShowTrash);

  const toggleTrash = (next: boolean): void => {
    setShowTrash(next);
    onTrashChange?.(next);
  };

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const value = content.trim();
    if (!value) return;
    onCreate(wholeDocument ? 0 : currentPage, value);
    setContent('');
    setWholeDocument(false);
  };

  /** 彻底删除仅用于回收站：确认后由 app 调 api.purgeNote 并回收孤立图片。 */
  const purge = (id: string): void => {
    if (confirmPurgeNote(confirmAction)) {
      onPurge(id);
    }
  };

  const startEdit = (note: NoteRecord): void => {
    setEditingId(note.id);
    setEditContent(note.content);
    setEditPage(String(note.page));
  };

  const saveEdit = (note: NoteRecord): void => {
    const page = Number(editPage);
    if (!Number.isInteger(page) || page < 0) return;
    onUpdate(note.id, { page, content: editContent });
    setEditingId(null);
  };

  return (
    <aside className="kr-annotations">
      <div className="kr-annotations__head">
        <h3>{showTrash ? '笔记回收站' : '笔记'}</h3>
        <button
          type="button"
          onClick={() => toggleTrash(!showTrash)}
          aria-pressed={showTrash}
          title="查看已移入回收站的笔记"
        >
          {showTrash ? '返回笔记' : '回收站'}
        </button>
      </div>
      <p className="kr-muted">笔记可以关联当前页，也可以写成整篇文献的笔记；支持 Markdown 与内部引用。</p>
      <p className="kr-muted kr-notes__hint">
        删除的笔记/批注会进入回收站，可恢复或彻底删除；只有彻底删除才会清理仅被它引用的图片。
      </p>
      {!showTrash ? (
      <form onSubmit={submit} className="kr-notes__form">
        <MarkdownEditor
          value={content}
          onChange={setContent}
          documents={documents}
          loadAnnotations={loadAnnotations}
          loadNotes={loadNotes}
          standaloneNotes={standaloneNotes}
          onOpenAsset={onOpenAsset}
          uploadImage={uploadImage}
          rows={3}
          compact
          placeholder="写一条笔记…（支持 Markdown，可用工具栏插入内部引用）"
          ariaLabel="新笔记内容"
        />
        <label className="kr-notes__whole">
          <input
            type="checkbox"
            checked={wholeDocument}
            onChange={(event) => setWholeDocument(event.target.checked)}
          />
          整篇文献笔记
        </label>
        <button type="submit" disabled={creating || !content.trim()}>
          添加笔记
        </button>
      </form>
      ) : null}

      {showTrash ? (
        <div className="kr-notes__trash">
          {trashLoading ? (
            <p className="kr-muted">正在读取笔记回收站…</p>
          ) : trashNotes.length === 0 ? (
            <p className="kr-muted">回收站为空。</p>
          ) : (
            <ul>
              {trashNotes.map((note) => (
                <li key={note.id} className="kr-note kr-note--trash">
                  <div className="kr-note__head">
                    <span>{note.page === 0 ? '整篇文献' : `第 ${note.page} 页`}</span>
                    <span className="kr-muted">
                      {new Date(note.created).toLocaleDateString()}
                    </span>
                  </div>
                  {note.quote ? <blockquote>{note.quote}</blockquote> : null}
                  {note.content.trim() ? (
                    <MarkdownContent
                      className="kr-note__body"
                      source={note.content}
                      onOpenAsset={onOpenAsset}
                    />
                  ) : (
                    <p className="kr-muted">（空笔记）</p>
                  )}
                  <div className="kr-notes__actions">
                    <button type="button" onClick={() => onRestore(note.id)}>
                      恢复
                    </button>
                    <button
                      type="button"
                      onClick={() => purge(note.id)}
                      title="彻底删除这条笔记（不可恢复，并回收只被它引用的图片资源）"
                    >
                      彻底删除
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : notes.length === 0 ? (
        <p className="kr-muted">还没有笔记。</p>
      ) : (
        <ul>
          {notes.map((note) => (
            <li key={note.id} className="kr-note">
              {editingId === note.id ? (
                <>
                  <MarkdownEditor
                    value={editContent}
                    onChange={setEditContent}
                    documents={documents}
                    loadAnnotations={loadAnnotations}
                    loadNotes={loadNotes}
                    standaloneNotes={standaloneNotes}
                    onOpenAsset={onOpenAsset}
                    uploadImage={uploadImage}
                    rows={3}
                    compact
                    autoFocus
                    placeholder="编辑笔记…"
                    ariaLabel="编辑笔记内容"
                  />
                  <label className="kr-notes__page">
                    页码
                    <input
                      type="number"
                      min={0}
                      value={editPage}
                      onChange={(event) => setEditPage(event.target.value)}
                    />
                  </label>
                  <div className="kr-notes__actions">
                    <button type="button" disabled={updating} onClick={() => saveEdit(note)}>
                      保存
                    </button>
                    <button type="button" onClick={() => setEditingId(null)}>
                      取消
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <div className="kr-note__head">
                    <span>{note.page === 0 ? '整篇文献' : `第 ${note.page} 页`}</span>
                    <span className="kr-muted">
                      {new Date(note.created).toLocaleDateString()}
                    </span>
                  </div>
                  {note.quote ? <blockquote>{note.quote}</blockquote> : null}
                  {note.content.trim() ? (
                    <MarkdownContent
                      className="kr-note__body"
                      source={note.content}
                      onOpenInternal={onOpenInternal}
                      onOpenAsset={onOpenAsset}
                    />
                  ) : (
                    <p className="kr-muted">（空笔记）</p>
                  )}
                  {loadBacklinks ? (
                    <Backlinks
                      target={{ kind: 'note', documentId: note.documentId, id: note.id }}
                      loadBacklinks={loadBacklinks}
                      onOpenBacklink={onOpenBacklink}
                    />
                  ) : null}
                  <div className="kr-notes__actions">
                    <button type="button" onClick={() => startEdit(note)}>
                      编辑
                    </button>
                    <button
                      type="button"
                      onClick={() => onDelete(note.id)}
                      title="移入回收站（可恢复）"
                    >
                      移入回收站
                    </button>
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
