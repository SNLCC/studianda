import { useEffect, useRef, useState } from 'react';
import type React from 'react';
import { documentTypeLabel, type DocumentSummary } from '@studianda/shared';

export interface DocumentTranslationStatus {
  status: 'none' | 'running' | 'partial' | 'done' | 'error';
  translatedPages: number;
  totalPages: number;
  segments: number;
  error: string;
}

/** 文献库排序方式；manual = 默认排序（拖拽调整，只有拖拽会改变它）。 */
export type LibrarySort = 'manual' | 'recent' | 'title' | 'pages' | 'progress' | 'author';

/** 文献库视图：卡片网格 / 紧凑列表。 */
export type LibraryView = 'card' | 'list';

/** 拖拽重排落点：把文献插入到当前显示顺序里这两个邻居之间（null = 最前/最后）。 */
export interface DocumentReorderTarget {
  beforeId: string | null;
  afterId: string | null;
}

/**
 * 按当前显示顺序计算拖拽落点邻居。
 *
 * 返回 null 表示不需要移动（原位、找不到目标，或拖到自身）。
 * 逻辑抽成纯函数，方便单元/冒烟验证拖到最前/最后与中间的情况。
 */
export function computeReorderTarget(
  orderedIds: string[],
  sourceId: string,
  targetId: string,
  position: 'before' | 'after'
): DocumentReorderTarget | null {
  if (sourceId === targetId) return null;
  const sourceIndex = orderedIds.indexOf(sourceId);
  if (sourceIndex === -1) return null;
  // 先在"去掉被拖动项"的顺序里找目标位置，再取它两侧的邻居。
  const remaining = orderedIds.filter((id) => id !== sourceId);
  const targetIndex = remaining.indexOf(targetId);
  if (targetIndex === -1) return null;
  const insertIndex = targetIndex + (position === 'after' ? 1 : 0);
  const beforeId = insertIndex > 0 ? (remaining[insertIndex - 1] ?? null) : null;
  const afterId = insertIndex < remaining.length ? (remaining[insertIndex] ?? null) : null;
  const originalBefore = orderedIds[sourceIndex - 1] ?? null;
  const originalAfter = orderedIds[sourceIndex + 1] ?? null;
  if (beforeId === originalBefore && afterId === originalAfter) return null;
  return { beforeId, afterId };
}

/** 卡片上的一行中文翻译状态；none（未开始）返回空串，不占位置。 */
function translationStatusLabel(translation: DocumentTranslationStatus): string {
  if (translation.status === 'running') {
    return `译文 ${translation.translatedPages}/${translation.totalPages} 页 · 翻译中`;
  }
  if (translation.status === 'partial') {
    return `部分译文 ${translation.translatedPages}/${translation.totalPages} 页`;
  }
  if (translation.status === 'done') {
    return `译文已完成 · ${translation.totalPages} 页`;
  }
  if (translation.status === 'error') {
    const reason = translation.error || '未知原因';
    return `译文失败：${reason.length > 40 ? `${reason.slice(0, 40)}…` : reason}`;
  }
  return '';
}

export interface DocumentListProps {
  documents: DocumentSummary[];
  onOpen(document: DocumentSummary): void;
  trash?: boolean;
  onDelete?(document: DocumentSummary): void;
  onRestore?(document: DocumentSummary): void;
  onPurge?(document: DocumentSummary): void;
  onRename?(document: DocumentSummary): void;
  onEditAuthor?(document: DocumentSummary): void;
  onEditTags?(document: DocumentSummary): void;
  onTranslate?(document: DocumentSummary): void;
  /** 附件缺失时重新连接（选择文件并重建副本/索引）。 */
  onRelink?(document: DocumentSummary): void;
  /** documentId -> 翻译中的状态文字（例如“翻译中 3/20”）。 */
  translating?: Record<string, string>;
  /** documentId -> 整篇翻译状态（工作台卡片显示“译文 x/y 页”等）。 */
  translationStatus?: Record<string, DocumentTranslationStatus>;
  sort?: LibrarySort;
  onSortChange?(sort: LibrarySort): void;
  /** 卡片视图 / 列表视图；默认卡片。 */
  view?: LibraryView;
  onViewChange?(view: LibraryView): void;
  /**
   * 默认排序拖拽是否可用（sort === 'manual' 且非回收站时由上层传 true）。
   * 拖拽落点按 `documents` 当前显示顺序计算（已叠加文件夹/分栏/类型/搜索过滤）。
   */
  reorderable?: boolean;
  /** 拖拽重排请求进行中：暂时停止再次拖动，避免用过期顺序计算邻居。 */
  reorderPending?: boolean;
  onReorder?(documentId: string, target: DocumentReorderTarget): void;
  tags?: string[];
  tagFilter?: string;
  onTagFilterChange?(tag: string): void;
  /**
   * 当前生效的检索词（空串表示没有检索）：列表已被上层过滤，
   * 这里只负责把数量与空状态文案换成"搜索结果"口径，避免显示"还没有文献"。
   */
  searchQuery?: string;
  /** 当前选中的文件夹名（null/undefined = 全部文献），用于标题与空状态口径。 */
  folderName?: string | null;
  /** 当前分栏的中文名（全部/著作/论文/其他）；空串表示未启用分栏。 */
  categoryLabel?: string;
  /** 当前类型筛选的中文名；空串表示全部类型。 */
  typeLabel?: string;
  /** 清除分栏/类型筛选（空状态里的按钮，只有筛选生效时才显示）。 */
  onClearFilters?(): void;
  /** documentId -> 文件夹名，卡片上显示归属；当前文件夹内不重复显示。 */
  folderNames?: Record<string, string>;
  /** 「编辑分类」入口：同时修改文献类型与所属文件夹。 */
  onEditClassification?(document: DocumentSummary): void;
}

function ViewToggle({
  view,
  onViewChange
}: {
  view: LibraryView;
  onViewChange?(view: LibraryView): void;
}): React.JSX.Element {
  return (
    <span className="kr-library__view" role="group" aria-label="文献视图切换">
      <button
        type="button"
        className={view === 'card' ? 'is-active' : ''}
        aria-pressed={view === 'card'}
        title="卡片视图"
        onClick={() => onViewChange?.('card')}
      >
        卡片
      </button>
      <button
        type="button"
        className={view === 'list' ? 'is-active' : ''}
        aria-pressed={view === 'list'}
        title="列表视图（紧凑行）"
        onClick={() => onViewChange?.('list')}
      >
        列表
      </button>
    </span>
  );
}

export function DocumentList({
  documents,
  onOpen,
  trash = false,
  onDelete,
  onRestore,
  onPurge,
  onRename,
  onEditAuthor,
  onEditTags,
  onTranslate,
  onRelink,
  translating = {},
  translationStatus = {},
  sort = 'manual',
  onSortChange,
  view = 'card',
  onViewChange,
  reorderable = false,
  reorderPending = false,
  onReorder,
  tags = [],
  tagFilter = '',
  onTagFilterChange,
  searchQuery = '',
  folderName = null,
  categoryLabel = '',
  typeLabel = '',
  onClearFilters,
  folderNames,
  onEditClassification
}: DocumentListProps): React.JSX.Element {
  const searching = searchQuery.length > 0;
  const filterActive = categoryLabel.length > 0 || typeLabel.length > 0;
  const filterSummary = [categoryLabel, typeLabel].filter(Boolean).join(' / ');
  // 手柄在有手动排序能力时一直显示；请求进行中暂时禁用拖动（避免用过期顺序计算邻居）。
  const canReorder = Boolean(reorderable && onReorder && !trash);
  const canDrag = canReorder && !reorderPending;

  // 拖拽只在默认排序使用；落点按当前显示顺序（documents 已经过滤/排序）计算邻居。
  const [dragState, setDragState] = useState<{
    sourceId: string;
    overId: string;
    position: 'before' | 'after';
  } | null>(null);
  const dragRef = useRef<{ sourceId: string; overId: string; position: 'before' | 'after' } | null>(
    null
  );
  // HTML5 拖拽结束后个别平台仍会补一次 click，拖拽后的 300ms 内忽略打开动作。
  const lastDragEndAt = useRef(0);

  // 行级操作统一收进「⋯」菜单：同一时刻只开一个；点空白处或 Esc 关闭。
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const menuTriggerRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!openMenuId) return undefined;
    const closeOnOutside = (event: Event): void => {
      const target = event.target;
      if (target instanceof Element && target.closest('.kr-doc-menu')) return;
      setOpenMenuId(null);
    };
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      setOpenMenuId(null);
      menuTriggerRef.current?.focus();
    };
    document.addEventListener('pointerdown', closeOnOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutside);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [openMenuId]);

  const clearDrag = (): void => {
    dragRef.current = null;
    setDragState(null);
  };

  const handleDragStart = (
    event: React.DragEvent<HTMLLIElement>,
    document: DocumentSummary
  ): void => {
    if (!canDrag) return;
    // 从操作按钮上按下时不要启动拖拽，避免影响点击操作。
    if (event.target instanceof Element && event.target.closest('button')) {
      event.preventDefault();
      return;
    }
    dragRef.current = { sourceId: document.id, overId: '', position: 'before' };
    setDragState(dragRef.current);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', document.id);
  };

  const handleDragOver = (
    event: React.DragEvent<HTMLLIElement>,
    document: DocumentSummary
  ): void => {
    const current = dragRef.current;
    if (!current || !canDrag) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    if (current.sourceId === document.id) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const position: 'before' | 'after' =
      event.clientY - rect.top > rect.height / 2 ? 'after' : 'before';
    if (current.overId !== document.id || current.position !== position) {
      const next = { ...current, overId: document.id, position };
      dragRef.current = next;
      setDragState(next);
    }
  };

  const handleDragLeave = (
    event: React.DragEvent<HTMLLIElement>,
    document: DocumentSummary
  ): void => {
    const current = dragRef.current;
    if (!current || current.overId !== document.id) return;
    const next = event.relatedTarget;
    if (next instanceof Node && event.currentTarget.contains(next)) return;
    const cleared = { ...current, overId: '' };
    dragRef.current = cleared;
    setDragState(cleared);
  };

  const handleDrop = (event: React.DragEvent<HTMLLIElement>, document: DocumentSummary): void => {
    event.preventDefault();
    const current = dragRef.current;
    if (
      !current ||
      !canDrag ||
      current.sourceId === document.id ||
      current.overId !== document.id
    ) {
      clearDrag();
      return;
    }
    clearDrag();
    lastDragEndAt.current = Date.now();
    const target = computeReorderTarget(
      documents.map((item) => item.id),
      current.sourceId,
      document.id,
      current.position
    );
    if (!target) return;
    onReorder?.(current.sourceId, target);
  };

  const handleDragEnd = (): void => {
    lastDragEndAt.current = Date.now();
    clearDrag();
  };

  const dragProps = (
    document: DocumentSummary
  ): Partial<React.HTMLAttributes<HTMLLIElement>> =>
    canDrag
      ? {
          draggable: true,
          onDragStart: (event) => handleDragStart(event, document),
          onDragOver: (event) => handleDragOver(event, document),
          onDragLeave: (event) => handleDragLeave(event, document),
          onDrop: (event) => handleDrop(event, document),
          onDragEnd: handleDragEnd
        }
      : {};

  const dragClassName = (document: DocumentSummary): string => {
    if (!canDrag) return '';
    let value = '';
    if (dragState?.sourceId === document.id) value += ' is-dragging';
    if (dragState && dragState.overId === document.id && dragState.sourceId !== document.id) {
      value += dragState.position === 'after' ? ' is-drop-after' : ' is-drop-before';
    }
    return value;
  };

  // 数量口径：回收站 / 搜索结果 / 文件夹 / 全部文献，再叠加分栏与类型。
  const scopeLabel = trash
    ? '回收站'
    : searching
      ? '搜索结果'
      : folderName
        ? `「${folderName}」`
        : '全部文献';

  // 空状态要能区分：回收站空 / 搜索无结果 / 文件夹为空 / 当前分栏或类型下没有文献。
  let emptyTitle: string;
  let emptyHint: string;
  if (trash) {
    emptyTitle = '回收站是空的。';
    emptyHint = '从文献库删除的文献会先进入这里。';
  } else if (searching) {
    emptyTitle = `没有找到含有「${searchQuery}」的文献。`;
    emptyHint = filterActive
      ? `当前还叠加了「${filterSummary}」筛选，可以换关键词或清除筛选后再试。`
      : '换个关键词，或清空搜索框查看全部文献。';
  } else if (filterActive) {
    emptyTitle = folderName
      ? `「${folderName}」里没有「${filterSummary}」的文献。`
      : `当前范围没有「${filterSummary}」的文献。`;
    emptyHint = '切换上面的分栏或类型，或清除筛选查看全部文献。';
  } else if (folderName) {
    emptyTitle = `「${folderName}」还没有文献。`;
    emptyHint = '在文献卡片上点「编辑分类」可以把已有文献移入这个文件夹，或导入新文献。';
  } else {
    emptyTitle = '还没有文献。';
    emptyHint = '点击右上角「导入文献」，文件会复制到本地资料目录。';
  }

  const sortHint =
    sort === 'manual'
      ? '默认排序：拖动卡片/列表可调整顺序，其它排序只是浏览'
      : '仅浏览排序，不改变默认顺序；拖拽请切回「默认排序」';
  const dragHint = searching
    ? '拖动 ⋮⋮ 可在当前搜索结果内调整默认顺序'
    : '拖动 ⋮⋮ 调整默认顺序';

  // 卡片与列表共用的类型/文件夹徽标。
  const renderBadges = (
    typeBadge: string,
    typeUnfiled: boolean,
    folderLabel: string
  ): React.JSX.Element => (
    <span className="kr-doc-card__badges">
      <span
        className={`kr-doc-card__type${typeUnfiled ? ' is-unfiled' : ''}`}
        title={`文献类型：${typeBadge}`}
      >
        {typeBadge}
      </span>
      {folderLabel ? (
        <span className="kr-doc-card__folder" title={`所在文件夹：${folderLabel}`}>
          {folderLabel}
        </span>
      ) : null}
    </span>
  );

  // 行级操作统一收进「⋯」菜单（卡片右上角 / 列表行尾）。
  // 附件缺失的「重新连接」仍单独可见：它是"继续读"的主路径，不藏进菜单。
  const renderDocMenu = (
    document: DocumentSummary,
    translatingLabel: string | undefined
  ): React.JSX.Element => {
    const open = openMenuId === document.id;
    const items: Array<{
      key: string;
      label: string;
      onSelect?: (document: DocumentSummary) => void;
      disabled?: boolean;
      danger?: boolean;
      separatorBefore?: boolean;
    }> = [];
    if (trash) {
      if (onRestore) items.push({ key: 'restore', label: '恢复', onSelect: onRestore });
      if (onPurge) {
        items.push({ key: 'purge', label: '彻底删除', onSelect: onPurge, danger: true });
      }
    } else {
      if (onTranslate) {
        items.push({
          key: 'translate',
          label: translatingLabel ?? '翻译整篇',
          disabled: Boolean(translatingLabel),
          onSelect: onTranslate
        });
      }
      if (onRename) items.push({ key: 'rename', label: '重命名', onSelect: onRename });
      if (onEditAuthor) items.push({ key: 'author', label: '编辑作者', onSelect: onEditAuthor });
      if (onEditTags) items.push({ key: 'tags', label: '编辑标签', onSelect: onEditTags });
      if (onEditClassification) {
        items.push({ key: 'classify', label: '编辑分类', onSelect: onEditClassification });
      }
      if (onDelete) {
        items.push({
          key: 'delete',
          label: '移入应用回收站',
          onSelect: onDelete,
          danger: true,
          separatorBefore: true
        });
      }
    }
    if (items.length === 0) return <span className="kr-doc-menu" />;
    return (
      <span className="kr-doc-menu">
        <button
          type="button"
          className="kr-doc-menu__trigger"
          title={open ? '收起操作菜单' : '更多操作'}
          aria-label={open ? '收起操作菜单' : '更多操作'}
          aria-haspopup="menu"
          aria-expanded={open}
          ref={open ? menuTriggerRef : undefined}
          onClick={(event) => {
            event.stopPropagation();
            setOpenMenuId(open ? null : document.id);
          }}
        >
          ⋯
        </button>
        {open ? (
          <span
            className="kr-doc-menu__items"
            role="menu"
            aria-label={`《${document.name}》的操作`}
          >
            {items.map((item) => (
              <button
                key={item.key}
                type="button"
                role="menuitem"
                disabled={item.disabled}
                className={
                  item.danger
                    ? `is-danger${item.separatorBefore ? ' is-separated' : ''}`
                    : undefined
                }
                onClick={(event) => {
                  event.stopPropagation();
                  if (item.disabled) return;
                  setOpenMenuId(null);
                  item.onSelect?.(document);
                }}
              >
                {item.label}
              </button>
            ))}
          </span>
        ) : null}
      </span>
    );
  };

  const renderMissingChip = (): React.JSX.Element => (
    <span className="kr-doc-card__missing" title="附件缺失：索引、批注与笔记仍在">
      附件缺失
    </span>
  );

  const renderRelinkButton = (document: DocumentSummary): React.JSX.Element | null =>
    missingRelink(document) ? (
      <button
        type="button"
        className="kr-doc-card__relink"
        title="选择文件重新连接这份文献"
        onClick={(event) => {
          event.stopPropagation();
          onRelink?.(document);
        }}
      >
        重新连接
      </button>
    ) : null;

  const missingRelink = (document: DocumentSummary): boolean =>
    document.missing_file === true && !trash && Boolean(onRelink);

  const activate = (document: DocumentSummary): void => {
    if (Date.now() - lastDragEndAt.current < 300) return;
    if (missingRelink(document)) {
      onRelink?.(document);
      return;
    }
    onOpen(document);
  };

  const renderCard = (document: DocumentSummary): React.JSX.Element => {
    const translatingLabel = translating[document.id];
    const translation = translationStatus[document.id];
    const missing = document.missing_file === true && !trash;
    const typeBadge = documentTypeLabel(document.docType);
    const typeUnfiled = !(document.docType ?? '').trim();
    const folderLabel =
      !trash && !folderName && document.folderId
        ? (folderNames?.[document.folderId] ?? '')
        : '';
    const progress = Math.max(
      3,
      Math.min(100, (document.currentPage / Math.max(1, document.pages)) * 100)
    );
    return (
      <li
        key={document.id}
        className={`kr-doc-card${trash ? ' is-trash' : ''}${missing ? ' is-missing-file' : ''}${dragClassName(document)}`}
        role={trash ? undefined : 'button'}
        tabIndex={trash ? undefined : 0}
        title={
          trash
            ? undefined
            : missing
              ? `${document.name}（附件缺失，点击重新连接）`
              : document.name
        }
        onClick={
          trash
            ? undefined
            : (event) => {
                if (event.target instanceof Element && event.target.closest('button')) return;
                activate(document);
              }
        }
        onKeyDown={
          trash
            ? undefined
            : (event) => {
                if (event.target !== event.currentTarget) return;
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  activate(document);
                }
              }
        }
        {...dragProps(document)}
      >
        <div className="kr-doc-card__menu">{renderDocMenu(document, translatingLabel)}</div>

        <div className="kr-doc-card__body">
          <div className="kr-doc-card__title-row">
            {canReorder ? (
              <span
                className="kr-doc-card__drag"
                title="拖动调整默认顺序"
                aria-hidden="true"
                onClick={(event) => event.stopPropagation()}
              >
                ⋮⋮
              </span>
            ) : null}
            <span className="kr-doc-card__title">{document.name}</span>
            {missing ? renderMissingChip() : null}
            {renderRelinkButton(document)}
          </div>
          {renderBadges(typeBadge, typeUnfiled, folderLabel)}
          <span className="kr-doc-card__meta">
            {document.pages} 页 · 读至第 {Math.min(document.currentPage, document.pages)} 页
          </span>
          {translation && translation.status !== 'none' ? (
            <span className="kr-doc-card__state">{translationStatusLabel(translation)}</span>
          ) : null}
          <span className="kr-doc-card__state">
            {document.fileState.storageKind === 'zotero'
              ? 'Zotero 本地只读链接 · 不复制附件'
              : document.fileState.storageKind === 'zotero_cache'
                ? 'Zotero 云端附件缓存副本'
                : '应用保存的 PDF 副本 · 原文件不变'}
          </span>
          <span className="kr-doc-card__progress" aria-hidden="true">
            <span style={{ width: `${progress}%` }} />
          </span>
          <div className="kr-doc-card__byline">
            {document.author ? (
              <span className="kr-doc-card__author">@{document.author}</span>
            ) : null}
            {document.publication ? (
              <span className="kr-doc-card__publication" title={document.publication}>
                {document.publication}
              </span>
            ) : null}
            {document.tags.map((tag) => (
              <span className="kr-doc-card__tag" key={tag}>
                {tag}
              </span>
            ))}
          </div>
        </div>
      </li>
    );
  };

  const renderRow = (document: DocumentSummary): React.JSX.Element => {
    const translatingLabel = translating[document.id];
    const translation = translationStatus[document.id];
    const missing = document.missing_file === true && !trash;
    const typeBadge = documentTypeLabel(document.docType);
    const typeUnfiled = !(document.docType ?? '').trim();
    const folderLabel =
      !trash && !folderName && document.folderId
        ? (folderNames?.[document.folderId] ?? '')
        : '';
    const progress = Math.max(
      3,
      Math.min(100, (document.currentPage / Math.max(1, document.pages)) * 100)
    );
    return (
      <li
        key={document.id}
        className={`kr-doc-row${trash ? ' is-trash' : ''}${missing ? ' is-missing-file' : ''}${dragClassName(document)}`}
        role={trash ? undefined : 'button'}
        tabIndex={trash ? undefined : 0}
        title={
          trash
            ? undefined
            : missing
              ? `${document.name}（附件缺失，点击重新连接）`
              : document.name
        }
        onClick={
          trash
            ? undefined
            : (event) => {
                if (event.target instanceof Element && event.target.closest('button')) return;
                activate(document);
              }
        }
        onKeyDown={
          trash
            ? undefined
            : (event) => {
                if (event.target !== event.currentTarget) return;
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  activate(document);
                }
              }
        }
        {...dragProps(document)}
      >
        {canReorder ? (
          <span
            className="kr-doc-row__drag"
            title="拖动调整默认顺序"
            aria-hidden="true"
            onClick={(event) => event.stopPropagation()}
          >
            ⋮⋮
          </span>
        ) : null}
        <div className="kr-doc-row__main">
          <span className="kr-doc-row__title">{document.name}</span>
          <span className="kr-doc-row__badges">
            {renderBadges(typeBadge, typeUnfiled, folderLabel)}
            {missing ? renderMissingChip() : null}
            {renderRelinkButton(document)}
          </span>
        </div>
        <span className="kr-doc-row__meta">
          {document.pages} 页 · 读至第 {Math.min(document.currentPage, document.pages)} 页
        </span>
        {translation && translation.status !== 'none' ? (
          <span className="kr-doc-row__state">{translationStatusLabel(translation)}</span>
        ) : null}
        <span className="kr-doc-row__progress" aria-hidden="true">
          <span style={{ width: `${progress}%` }} />
        </span>
        <span className="kr-doc-row__actions">
          {renderDocMenu(document, translatingLabel)}
        </span>
      </li>
    );
  };

  return (
    <section className="kr-library">
      <div className="kr-library__filters">
        <div className="kr-library__count">
          {scopeLabel}
          {filterSummary ? ` · ${filterSummary}` : ''} · {documents.length} 份
        </div>
        {!trash ? (
          <>
            <label>
              排序
              <select
                value={sort}
                title={sortHint}
                onChange={(event) => onSortChange?.(event.target.value as LibrarySort)}
              >
                <option value="manual">默认排序（可拖拽）</option>
                <option value="recent">最近导入</option>
                <option value="title">标题</option>
                <option value="author">作者</option>
                <option value="progress">阅读进度</option>
                <option value="pages">页数</option>
              </select>
            </label>
            <label>
              标签
              <select
                value={tagFilter}
                onChange={(event) => onTagFilterChange?.(event.target.value)}
              >
                <option value="">全部标签</option>
                {tags.map((tag) => (
                  <option key={tag} value={tag}>
                    {tag}
                  </option>
                ))}
              </select>
            </label>
            {canReorder ? <span className="kr-library__hint">{dragHint}</span> : null}
          </>
        ) : null}
        <ViewToggle view={view} onViewChange={onViewChange} />
      </div>

      {documents.length === 0 ? (
        <div className="kr-empty">
          <p>{emptyTitle}</p>
          <p className="kr-muted">{emptyHint}</p>
          {filterActive && onClearFilters ? (
            <button type="button" className="kr-empty__clear" onClick={() => onClearFilters()}>
              清除分类/类型筛选
            </button>
          ) : null}
        </div>
      ) : (
        <ul className={view === 'list' ? 'kr-doc-list kr-doc-list--rows' : 'kr-doc-list'}>
          {documents.map((document) =>
            view === 'list' ? renderRow(document) : renderCard(document)
          )}
        </ul>
      )}
    </section>
  );
}
