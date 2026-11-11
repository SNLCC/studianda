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
import { confirmPurgeAnnotation } from './note-purge.js';
import type { ConfirmAction } from './dialog-utils.js';
import { MarkdownContent } from './MarkdownContent.js';
import { MarkdownEditor, type MarkdownImageUpload } from './MarkdownEditor.js';

function ActionIcon({ name }: { name: 'edit' | 'ask' | 'locate' | 'delete' | 'save' | 'cancel' }): React.JSX.Element {
  const paths = {
    edit: <path d="M4 16.5V20h3.5L18 9.5 14.5 6 4 16.5ZM13.5 7l3.5 3.5" />,
    save: <path d="m4 12 5 5L20 6" />,
    cancel: <path d="M6 6l12 12M18 6 6 18" />,
    ask: (
      <>
        <path d="M4 5h16v11H9l-4 3v-3H4V5Z" />
        <path d="M8 9h8M8 12h5" />
      </>
    ),
    locate: (
      <>
        <circle cx="12" cy="12" r="5" />
        <path d="M12 2v4M12 18v4M2 12h4M18 12h4" />
      </>
    ),
    delete: (
      <>
        <path d="M5 7h14M9 7V5h6v2M7 7l1 13h8l1-13" />
        <path d="M10 10v6M14 10v6" />
      </>
    )
  } as const;
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}


export interface AnnotationPanelProps {
  annotations: AnnotationRecord[];
  /** 批注 id → 与摘引重叠的译文（只读；没有译文时不显示）。 */
  translations?: Record<string, string>;
  onCreate(content: string): void;
  onUpdate(
    id: string,
    input: { content: string; color: string; style: string }
  ): void;
  onAsk(annotation: AnnotationRecord): void;
  onLocate(annotation: AnnotationRecord): void;
  /** 软删除：移入回收站（可恢复）。 */
  onDelete(id: string): void;
  /** 从回收站恢复批注。 */
  onRestore(id: string): void;
  /** 彻底删除批注（不可恢复，同时回收只被它引用的图片资源）。 */
  onPurge(id: string): void;
  /** 确认框实现（宿主注入；默认浏览器原生 confirm）。 */
  confirmAction?: ConfirmAction;
  /** 回收站里的批注（按需加载）。 */
  trashAnnotations?: AnnotationRecord[];
  trashLoading?: boolean;
  /** 切换回收站视图：上层据此按需请求 trash 列表。 */
  onTrashChange?(showTrash: boolean): void;
  /** 初始是否显示回收站（默认 false，主要便于测试/恢复视图状态）。 */
  defaultShowTrash?: boolean;
  scope?: 'page' | 'document';
  onScopeChange?(scope: 'page' | 'document'): void;
  creating?: boolean;
  updating?: boolean;
  /**
   * 当前文献来自 Zotero（storageKind 为 zotero / zotero_cache）时传 true，
   * 面板顶部显示「从 Zotero 导入批注与笔记」入口；默认不显示。
   */
  zoteroAvailable?: boolean;
  /** 预览/导入流程进行中：按钮禁用并显示进行中文案。 */
  zoteroImporting?: boolean;
  /** 导入结果说明（含批注/笔记数量、已存在/跳过）；null 不显示。 */
  zoteroNotice?: string | null;
  /** 预览/导入失败说明；显示在面板内，不使用 alert。 */
  zoteroError?: string | null;
  /** 点击「从 Zotero 导入批注与笔记」：由调用方完成预览→确认→导入。 */
  onImportZotero?(): void;
  /** 关闭导入结果提示。 */
  onDismissZoteroNotice?(): void;
  /** 内部引用弹窗的文献列表；不传则编辑器不可插入内部引用。 */
  documents?: DocumentSummary[];
  /** 内部引用弹窗选择批注时使用。 */
  loadAnnotations?(documentId: string): Promise<AnnotationRecord[]>;
  /** 内部引用弹窗选择笔记时使用。 */
  loadNotes?(documentId: string): Promise<NoteRecord[]>;
  /** 独立笔记列表：note 引用 tab 里可直接引用它们。 */
  standaloneNotes?: NoteRecord[];
  /** 点击批注内容里的 [[内部引用]]：由上层负责打开文献/批注/笔记。 */
  onOpenInternal?(target: MarkdownInternalTarget): void;
  /** 点击 studianda-asset: 附件链接时回调（app 用 adapter.openNoteAsset）。 */
  onOpenAsset?(url: string): void | Promise<void>;
  /** 图片上传器：有则把图片存成 studianda-asset 资源，失败回退内联 data URL。 */
  uploadImage?: MarkdownImageUpload;
  /** 反向链接懒加载；不传则批注卡片不显示「被引用」。 */
  loadBacklinks?(target: BacklinkTarget): Promise<BacklinkRecord[]>;
  /** 点击反向链接：打开来源文献并跳到来源页。 */
  onOpenBacklink?(backlink: BacklinkRecord): void;
}

const COLORS: Record<string, string> = {
  yellow: '#ebc743',
  green: '#74ba6a',
  blue: '#66aadb',
  pink: '#e58cac',
  purple: '#b083d2',
  orange: '#efaa57'
};

const COLOR_NAMES: Record<string, string> = {
  yellow: '黄色',
  green: '绿色',
  blue: '蓝色',
  pink: '粉色',
  purple: '紫色',
  orange: '橙色'
};

const STYLES: Record<string, string> = {
  highlight: '高亮',
  underline: '下划线',
  margin: '段落侧线',
  region: '区域框选',
  page: '整页批注'
};

export function AnnotationPanel({
  annotations,
  translations,
  onCreate,
  onUpdate,
  onAsk,
  onLocate,
  onDelete,
  onRestore,
  onPurge,
  confirmAction,
  trashAnnotations = [],
  trashLoading = false,
  onTrashChange,
  defaultShowTrash = false,
  scope = 'page',
  onScopeChange,
  creating = false,
  updating = false,
  zoteroAvailable = false,
  zoteroImporting = false,
  zoteroNotice = null,
  zoteroError = null,
  onImportZotero,
  onDismissZoteroNotice,
  documents = [],
  loadAnnotations,
  loadNotes,
  standaloneNotes,
  onOpenInternal,
  onOpenAsset,
  uploadImage,
  loadBacklinks,
  onOpenBacklink
}: AnnotationPanelProps): React.JSX.Element {
  const [content, setContent] = useState('');
  const [showTrash, setShowTrash] = useState(defaultShowTrash);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState('');
  const [editColor, setEditColor] = useState('yellow');
  const [editStyle, setEditStyle] = useState('highlight');

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const value = content.trim();
    if (!value) return;
    onCreate(value);
    setContent('');
  };

  const startEdit = (annotation: AnnotationRecord): void => {
    setEditingId(annotation.id);
    setEditContent(annotation.content);
    setEditColor(annotation.color || 'yellow');
    setEditStyle(annotation.rects ? annotation.style || 'highlight' : 'page');
  };

  const saveEdit = (annotation: AnnotationRecord): void => {
    onUpdate(annotation.id, {
      content: editContent,
      color: editColor,
      style: annotation.rects ? editStyle : 'page'
    });
    setEditingId(null);
  };

  /** 批注彻底删除仅用于回收站：确认后由 app 调 api.purgeAnnotation 并回收孤立图片。 */
  const purge = (annotation: AnnotationRecord): void => {
    if (confirmPurgeAnnotation(confirmAction)) onPurge(annotation.id);
  };

  const toggleTrash = (next: boolean): void => {
    setShowTrash(next);
    onTrashChange?.(next);
  };

  return (
    <aside className="kr-annotations">
      <div className="kr-annotations__head">
        <h3>{showTrash ? '批注回收站' : scope === 'document' ? '全部批注' : '本页批注'}</h3>
        <button
          type="button"
          onClick={() => toggleTrash(!showTrash)}
          aria-pressed={showTrash}
          title="查看已移入回收站的批注"
        >
          {showTrash ? '返回批注' : '回收站'}
        </button>
      </div>
      <p className="kr-muted kr-annotations__hint">
        删除的笔记/批注会进入回收站，可恢复或彻底删除；只有彻底删除才会清理仅被它引用的图片。
      </p>
      {!showTrash && zoteroAvailable ? (
        <div>
          <button
            type="button"
            onClick={() => onImportZotero?.()}
            disabled={zoteroImporting || !onImportZotero}
          >
            {zoteroImporting ? '正在从 Zotero 读取…' : '从 Zotero 导入批注与笔记'}
          </button>
          {zoteroNotice ? (
            <p className="kr-settings__message" role="status">
              {zoteroNotice}
              {onDismissZoteroNotice ? (
                <button type="button" className="kr-link-button" onClick={onDismissZoteroNotice}>
                  知道了
                </button>
              ) : null}
            </p>
          ) : null}
          {zoteroError ? (
            <p className="kr-page-error" role="alert">
              {zoteroError}
            </p>
          ) : null}
        </div>
      ) : null}
      {!showTrash && onScopeChange ? (
        <div className="kr-annotation-scope" role="group" aria-label="批注范围">
          <button
            type="button"
            className={scope === 'page' ? 'is-active' : ''}
            onClick={() => onScopeChange('page')}
          >本页</button>
          <button
            type="button"
            className={scope === 'document' ? 'is-active' : ''}
            onClick={() => onScopeChange('document')}
          >全部</button>
        </div>
      ) : null}
      {!showTrash ? (
        <>
          <p className="kr-muted">
            在页面上选中文字可高亮、下划线或加段落侧线；也可以写一条本页批注。
          </p>
          <form onSubmit={submit} className="kr-annotations__form">
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
          placeholder="写一条与本页相关的批注…（支持 Markdown 与内部引用）"
          ariaLabel="新批注内容"
        />
        <button type="submit" disabled={creating || !content.trim()}>
          添加批注
        </button>
      </form>
        </>
      ) : null}
      {showTrash ? (
        <div className="kr-annotations__trash">
          {trashLoading ? (
            <p className="kr-muted">正在读取批注回收站…</p>
          ) : trashAnnotations.length === 0 ? (
            <p className="kr-muted">回收站为空。</p>
          ) : (
            <ul>
              {trashAnnotations.map((annotation) => (
                <li key={annotation.id} className="kr-annotation kr-annotation--trash">
                  <div className="kr-note__head">
                    <span>{annotation.page ? `第 ${annotation.page} 页` : '—'}</span>
                    <span className="kr-muted">
                      {new Date(annotation.created).toLocaleDateString()}
                    </span>
                  </div>
                  {annotation.quote ? <blockquote>{annotation.quote}</blockquote> : null}
                  <MarkdownContent
                    className="kr-annotation__body"
                    source={annotation.content || '（空批注）'}
                    onOpenAsset={onOpenAsset}
                  />
                  <div className="kr-annotation__actions">
                    <button type="button" onClick={() => onRestore(annotation.id)}>
                      恢复
                    </button>
                    <button
                      type="button"
                      onClick={() => purge(annotation)}
                      title="彻底删除这条批注（不可恢复，并回收只被它引用的图片资源）"
                    >
                      彻底删除
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : annotations.length === 0 ? (
        <p className="kr-muted">这一页还没有批注。</p>
      ) : (
        <ul>
          {annotations.map((annotation) => {
            const isPage = !annotation.rects;
            if (editingId === annotation.id) {
              return (
                <li key={annotation.id} className="kr-annotation kr-annotation--editing">
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
                    placeholder="批注内容（支持 Markdown）"
                    ariaLabel="编辑批注内容"
                  />
                  {!isPage ? (
                    <div className="kr-annotation__controls">
                      <select
                        value={editStyle}
                        onChange={(event) => setEditStyle(event.target.value)}
                        aria-label="批注样式"
                      >
                        {Object.entries(STYLES)
                          .filter(([value]) => value !== 'page')
                          .map(([value, label]) => (
                            <option key={value} value={value}>
                              {label}
                            </option>
                          ))}
                      </select>
                      <select
                        value={editColor}
                        onChange={(event) => setEditColor(event.target.value)}
                        aria-label="批注颜色"
                      >
                        {Object.entries(COLORS).map(([value]) => (
                          <option key={value} value={value}>
                            {COLOR_NAMES[value] ?? value}
                          </option>
                        ))}
                      </select>
                    </div>
                  ) : (
                    <p className="kr-muted">整页批注没有页面标记样式。</p>
                  )}
                  <div className="kr-annotation__actions">
                    <button type="button" title="保存" aria-label="保存" disabled={updating} onClick={() => saveEdit(annotation)}>
                      <ActionIcon name="save" />
                    </button>
                    <button type="button" title="取消" aria-label="取消" onClick={() => setEditingId(null)}>
                      <ActionIcon name="cancel" />
                    </button>
                  </div>
                </li>
              );
            }
            return (
              <li
                key={annotation.id}
                className="kr-annotation"
                onClick={(event) => {
                  if ((event.target as HTMLElement).closest('button, a, textarea, input, select')) {
                    return;
                  }
                  onLocate(annotation);
                }}
                title="点击定位到原文"
              >
                <div className="kr-annotation__head">
                  <span
                    className="kr-annotation__dot"
                    style={{
                      background:
                        annotation.style === 'page'
                          ? '#8b95a7'
                          : COLORS[annotation.color] ?? COLORS.yellow
                    }}
                  />
                  <span className="kr-annotation__kind">
                    {STYLES[annotation.style] ?? annotation.style ?? '批注'}
                  </span>
                </div>
                {annotation.content.trim() ? (
                  <MarkdownContent
                    className="kr-annotation__body"
                    source={annotation.content}
                    onOpenInternal={onOpenInternal}
                    onOpenAsset={onOpenAsset}
                  />
                ) : annotation.quote ? (
                  <p>{annotation.quote}</p>
                ) : (
                  <p className="kr-muted">（空批注）</p>
                )}
                {annotation.content && annotation.quote ? (
                  <blockquote>{annotation.quote}</blockquote>
                ) : null}
                {translations?.[annotation.id] ? (
                  <blockquote className="kr-annotation__translation">
                    译文：{translations[annotation.id]}
                  </blockquote>
                ) : null}
                {loadBacklinks ? (
                  <Backlinks
                    target={{
                      kind: 'annotation',
                      documentId: annotation.documentId,
                      id: annotation.id
                    }}
                    loadBacklinks={loadBacklinks}
                    onOpenBacklink={onOpenBacklink}
                  />
                ) : null}
                <div className="kr-annotation__actions">
                  <button type="button" title="编辑" aria-label="编辑" onClick={() => startEdit(annotation)}>
                    <ActionIcon name="edit" />
                  </button>
                  <button type="button" title="引用到提问" aria-label="引用到提问" onClick={() => onAsk(annotation)}>
                    <ActionIcon name="ask" />
                  </button>
                  <button type="button" title="定位原文" aria-label="定位原文" onClick={() => onLocate(annotation)}>
                    <ActionIcon name="locate" />
                  </button>
                  <button
                    type="button"
                    title="移入回收站（可恢复）"
                    aria-label="移入回收站"
                    onClick={() => onDelete(annotation.id)}
                  >
                    <ActionIcon name="delete" />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}
