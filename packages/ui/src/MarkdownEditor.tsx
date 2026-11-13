import { useEffect, useRef, useState } from 'react';
import type React from 'react';
import {
  applyMarkdownCommand,
  applyMarkdownFormatting,
  captureMarkdownFormatting,
  formatMarkdownInternalLink,
  renderMarkdown,
  type AnnotationRecord,
  type DocumentSummary,
  type MarkdownCommand,
  type MarkdownFormatting,
  type MarkdownInternalTarget,
  type MarkdownInternalTargetInput,
  type NoteRecord
} from '@studianda/shared';
import { MarkdownContent } from './MarkdownContent.js';
import { ASSET_SOURCE_ATTRIBUTE, resolveAssetUrl } from './asset-url.js';
import {
  escapeHtmlAttribute,
  escapeHtmlText,
  htmlToMarkdown
} from './markdown-serializer.js';
import { planTableEdit, type TableEditAction } from './table-editor.js';

/** 富文本模式在本次应用会话内记住选择（默认源码；组件重挂载也沿用）。 */
type EditorMode = 'source' | 'rich';
let sessionEditorMode: EditorMode = 'source';

/** 内部引用弹窗「选择文献」里代表独立笔记的哨兵值。 */
const STANDALONE_DOC_VALUE = '__standalone__';

/** 富文本光标所在表格单元格的上下文。 */
interface RichTableContext {
  table: HTMLTableElement;
  row: HTMLTableRowElement;
  cell: HTMLTableCellElement;
  rowIndex: number;
  columnIndex: number;
}

/** 撤销/重做历史上限。 */
const HISTORY_LIMIT = 100;
/** 连续输入时把短时间内的小改动合并成一步撤销，避免逐字撤销。 */
const TYPING_COALESCE_MS = 500;
/**
 * 本地图片安全硬上限（仅防止误选超大文件）：20MB。
 * 真正的大小/像素上限由服务端设置（note_image.max_mb / max_pixels）决定，上传失败时如实报错、不回退内联。
 */
const IMAGE_MAX_BYTES = 20 * 1024 * 1024;
/** 渲染层只支持这几种图片 MIME。 */
const IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** 预设文字颜色（与宣纸主题搭配）。 */
const PRESET_COLORS: Array<{ name: string; hex: string }> = [
  { name: '朱砂', hex: '#b23b2e' },
  { name: '青瓷', hex: '#7fa38a' },
  { name: '靛蓝', hex: '#3f6f9f' },
  { name: '赭石', hex: '#8a6d3b' },
  { name: '紫', hex: '#6b4f8a' }
];

interface HistoryEntry {
  value: string;
  selectionStart: number;
  selectionEnd: number;
}

interface InternalItem {
  id: string;
  label: string;
}

type InternalKind = 'document' | 'annotation' | 'note';

function summarizeInternalLabel(text: string, max = 36): string {
  const plain = (text ?? '')
    .replace(/\[\[[^\]]*\]\]/g, '内部引用')
    .replace(/[#>*`~=_+]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!plain) return '未命名';
  return plain.length > max ? `${plain.slice(0, max)}…` : plain;
}

const TOOLBAR_GROUPS: Array<Array<{ command: MarkdownCommand; label: string; title: string; aria: string }>> = [
  [
    { command: 'h1', label: 'H1', title: '一级标题', aria: '一级标题' },
    { command: 'h2', label: 'H2', title: '二级标题', aria: '二级标题' },
    { command: 'h3', label: 'H3', title: '三级标题', aria: '三级标题' }
  ],
  [
    { command: 'bold', label: 'B', title: '加粗（**文字**）', aria: '加粗' },
    { command: 'italic', label: 'I', title: '斜体（*文字*）', aria: '斜体' },
    { command: 'underline', label: 'U', title: '下划线（++文字++）', aria: '下划线' },
    { command: 'strike', label: 'S', title: '删除线（~~文字~~）', aria: '删除线' },
    { command: 'highlight', label: '标记', title: '高亮（==文字==）', aria: '高亮' }
  ],
  [
    { command: 'quote', label: '❝', title: '引用块', aria: '引用' },
    { command: 'ul', label: '•', title: '无序列表', aria: '无序列表' },
    { command: 'ol', label: '1.', title: '有序列表', aria: '有序列表' },
    { command: 'task', label: '☑', title: '任务清单', aria: '任务清单' }
  ],
  [
    { command: 'code', label: '</>', title: '行内代码', aria: '行内代码' },
    { command: 'table', label: '表', title: '插入表格', aria: '插入表格' },
    { command: 'link', label: '链', title: '插入链接', aria: '插入链接' },
    { command: 'clear', label: '清除', title: '清除选中文字的格式', aria: '清除格式' }
  ],
  [
    { command: 'align-left', label: '左', title: '左对齐（再次点击同一对齐取消）', aria: '左对齐' },
    { command: 'align-center', label: '中', title: '居中（再次点击同一对齐取消）', aria: '居中对齐' },
    { command: 'align-right', label: '右', title: '右对齐（再次点击同一对齐取消）', aria: '右对齐' },
    {
      command: 'align-justify',
      label: '两端',
      title: '两端对齐（再次点击同一对齐取消）',
      aria: '两端对齐'
    }
  ],
  [
    { command: 'indent', label: '→|', title: '增加缩进（行首加 2 空格）', aria: '增加缩进' },
    { command: 'outdent', label: '|←', title: '减少缩进（去掉行首 2 空格）', aria: '减少缩进' },
    { command: 'move-up', label: '↑', title: '当前行上移', aria: '上移当前行' },
    { command: 'move-down', label: '↓', title: '当前行下移', aria: '下移当前行' }
  ]
];

/** 插入图片时的上传器：把 data URL 换成可长期引用的 studianda-asset 地址。 */
export type MarkdownImageUpload = (input: {
  dataUrl: string;
  filename: string;
}) => Promise<{ url: string }>;

/**
 * 决定图片最终写进 Markdown 的地址。
 *
 * - 有 uploader：走服务端上传（服务端按设置检查大小/像素）；失败返回 null + 中文错误，
 *   **不回退内联 data URL**，避免绕过服务端上限；
 * - 无 uploader（预览/测试）：保持内联 data URL。
 */
export async function resolveImageSource(
  fileName: string,
  dataUrl: string,
  uploadImage?: MarkdownImageUpload
): Promise<{ url: string | null; notice: string }> {
  const displayName = fileName || '图片';
  const sizeLabel = `${Math.round(dataUrl.length / 1024)}KB`;
  if (!uploadImage) {
    return {
      url: dataUrl,
      notice: `已插入图片「${displayName}」（约 ${sizeLabel}，内联 data URL）。`
    };
  }
  try {
    const asset = await uploadImage({ dataUrl, filename: displayName });
    const url = asset?.url?.trim();
    if (!url) throw new Error('上传结果缺少图片地址');
    return {
      url,
      notice: `已上传为本地图片资源「${displayName}」（不占笔记文本体积）。`
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      url: null,
      notice: `图片上传失败：${message}（未插入；请压缩图片或调整「笔记图片上限」后重试）。`
    };
  }
}

/**
 * 富文本编辑区专用渲染：图片 src 使用宿主解析后的地址，同时把原始资产地址
 * 挂在 data 属性上；序列化时优先读它，避免把显示地址写回 Markdown。
 */
function renderEditableMarkdown(source: string): string {
  return renderMarkdown(source, {
    resolveAssetUrl,
    assetSourceAttribute: ASSET_SOURCE_ATTRIBUTE
  });
}

export interface MarkdownEditorProps {
  value: string;
  onChange(value: string): void;
  /** 内部引用选择弹窗里的文献列表。 */
  documents?: DocumentSummary[];
  /** 内部引用弹窗选择批注时使用；不传则「批注」类型不可用。 */
  loadAnnotations?(documentId: string): Promise<AnnotationRecord[]>;
  /** 内部引用弹窗选择笔记时使用；不传则「笔记」类型不可用。 */
  loadNotes?(documentId: string): Promise<NoteRecord[]>;
  /** 独立笔记（documentId=''）列表：note 引用 tab 里可直接引用它们（`[[note:<noteId>]]`）。 */
  standaloneNotes?: NoteRecord[];
  /** 预览/渲染内容里点击内部引用时回调（独立笔记视图用于导航）。 */
  onOpenInternal?(target: MarkdownInternalTarget): void;
  /** 预览里点击 studianda-asset: 附件链接时回调（app 用 adapter.openNoteAsset）。 */
  onOpenAsset?(url: string): void | Promise<void>;
  /**
   * 图片上传器：提供时图片选择/粘贴会先上传，成功后插入返回的 studianda-asset 地址；
   * 上传失败只显示中文错误、不回退内联（避免绕过服务端大小/像素上限）。
   * 不提供时（预览/测试）保持内联 data URL 行为。
   */
  uploadImage?: MarkdownImageUpload;
  rows?: number;
  placeholder?: string;
  disabled?: boolean;
  /** 阅读侧栏等窄容器里的紧凑样式。 */
  compact?: boolean;
  autoFocus?: boolean;
  ariaLabel?: string;
}

/**
 * Markdown 编辑器：受控 textarea + 工具栏 + 自建撤销/重做 + 内部引用选择弹窗。
 *
 * 存储仍是 Markdown 文本；旧纯文本可以原样编辑。
 * 撤销历史由编辑器自己维护（文本 + 选区，上限 100 步）；父组件的受控值若被外部重置
 * （例如提交后清空、切换到另一条笔记），历史也同步重置，避免撤销到别的文本。
 */
export function MarkdownEditor({
  value,
  onChange,
  documents = [],
  loadAnnotations,
  loadNotes,
  standaloneNotes = [],
  uploadImage,
  onOpenInternal,
  onOpenAsset,
  rows,
  placeholder = '支持 Markdown；可插入 [[内部引用]]',
  disabled = false,
  compact = false,
  autoFocus = false,
  ariaLabel = 'Markdown 编辑器'
}: MarkdownEditorProps): React.JSX.Element {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const selectionRef = useRef({ start: 0, end: 0 });
  const pendingSelectionRef = useRef<{ start: number; end: number } | null>(null);
  const restoreSelectionOnFocusRef = useRef(false);
  const lastInputAtRef = useRef(0);
  // 最新文本：图片上传是异步的，完成时用最新值插入，避免覆盖上传期间用户继续输入的内容。
  const valueRef = useRef(value);
  valueRef.current = value;

  // 格式刷：null = 未激活；有值表示已从选区吸取，等下一次点击应用到目标选区。
  const [painting, setPainting] = useState<MarkdownFormatting | null>(null);
  // 预览态：用 MarkdownContent 只读渲染当前 value；撤销历史不受影响。
  const [preview, setPreview] = useState(false);
  // 图片/格式刷等操作的中文提示（体积超限、吸取失败、已应用等）。
  const [editorNotice, setEditorNotice] = useState('');
  // 图片上传中：禁用「图」按钮并显示提示，避免重复触发。
  const [imageUploading, setImageUploading] = useState(false);

  // 源码 / 富文本模式。默认源码；本次会话内记住（sessionEditorMode）。
  const [editorMode, setEditorMode] = useState<EditorMode>(() => sessionEditorMode);
  const editorModeRef = useRef<EditorMode>(editorMode);
  editorModeRef.current = editorMode;
  const richRef = useRef<HTMLDivElement | null>(null);
  const richTimerRef = useRef<number | null>(null);
  const richRangeRef = useRef<Range | null>(null);
  const lastSerializedRef = useRef(value);
  // 富文本模式「链接」的小弹窗（应用内，不用 window.prompt）。
  const [richLinkDialog, setRichLinkDialog] = useState<{
    text: string;
    url: string;
    error: string;
  } | null>(null);
  // 富文本光标所在表格（用于表格行列编辑工具条）；null 表示不在表格里。
  const [tableContext, setTableContext] = useState<RichTableContext | null>(null);

  const [history, setHistory] = useState<{ entries: HistoryEntry[]; index: number }>(() => ({
    entries: [{ value, selectionStart: 0, selectionEnd: 0 }],
    index: 0
  }));

  // 内部引用弹窗。
  const [internalOpen, setInternalOpen] = useState(false);
  const [internalKind, setInternalKind] = useState<InternalKind>('document');
  const [internalSearch, setInternalSearch] = useState('');
  const [internalDocId, setInternalDocId] = useState('');
  const [internalItemId, setInternalItemId] = useState('');
  const [internalAnnotations, setInternalAnnotations] = useState<AnnotationRecord[]>([]);
  const [internalNotes, setInternalNotes] = useState<NoteRecord[]>([]);
  const [internalLoading, setInternalLoading] = useState(false);
  const [internalError, setInternalError] = useState('');
  const internalAnchorRef = useRef({ start: 0, end: 0 });
  // loader 由 props 传入，可能每次渲染都是新函数；放进 ref 避免弹窗数据请求被重复触发。
  const loadersRef = useRef({ loadAnnotations, loadNotes });
  loadersRef.current = { loadAnnotations, loadNotes };

  // 父组件从外部重置 value（提交后清空等）：撤销历史一并重置。
  useEffect(() => {
    setHistory((current) => {
      const entry = current.entries[current.index];
      if (entry && entry.value === value) return current;
      lastInputAtRef.current = 0;
      return { entries: [{ value, selectionStart: 0, selectionEnd: 0 }], index: 0 };
    });
  }, [value]);

  // 工具栏/撤销/插入引用后恢复光标位置（必须在 DOM 更新后）。
  useEffect(() => {
    const pending = pendingSelectionRef.current;
    if (!pending) return;
    const element = textareaRef.current;
    if (!element) return;
    pendingSelectionRef.current = null;
    if (document.activeElement !== element) element.focus({ preventScroll: true });
    element.setSelectionRange(pending.start, pending.end);
    selectionRef.current = { start: pending.start, end: pending.end };
  }, [value, history]);

  // 进入富文本：用安全渲染的 HTML 作为初始内容（只做一次，避免打断输入光标）。
  useEffect(() => {
    if (editorMode !== 'rich') return;
    const element = richRef.current;
    if (!element) return;
    element.innerHTML = renderEditableMarkdown(valueRef.current);
    lastSerializedRef.current = valueRef.current;
    return () => {
      if (richTimerRef.current !== null) {
        window.clearTimeout(richTimerRef.current);
        richTimerRef.current = null;
      }
    };
  }, [editorMode]);

  // 父级回显值：等于上次序列化结果时忽略（避免 setInnerHTML 丢光标）；
  // 只有外部重置（提交后清空、切换编辑对象）才重写可编辑区。
  useEffect(() => {
    if (editorMode !== 'rich') return;
    if (value === lastSerializedRef.current) return;
    const element = richRef.current;
    if (!element) return;
    element.innerHTML = renderEditableMarkdown(value);
    lastSerializedRef.current = value;
  }, [editorMode, value]);

  // 富文本模式：跟踪光标是否在表格单元格里，用于显示表格行列编辑工具。
  const findRichTableContext = (): RichTableContext | null => {
    const element = richRef.current;
    if (!element) return null;
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return null;
    let node: Node | null = selection.getRangeAt(0).startContainer;
    if (!element.contains(node)) return null;
    let cell: HTMLElement | null = null;
    while (node && node !== element) {
      if (node.nodeType === 1) {
        const current = node as HTMLElement;
        if (current.tagName === 'TD' || current.tagName === 'TH') {
          cell = current;
          break;
        }
      }
      node = node.parentNode;
    }
    if (!cell) return null;
    const row = cell.parentElement as HTMLTableRowElement | null;
    if (!row || row.tagName !== 'TR') return null;
    const table = row.closest('table') as HTMLTableElement | null;
    if (!table) return null;
    const rows = Array.from(table.rows);
    const rowIndex = rows.indexOf(row as HTMLTableRowElement);
    const columnIndex = Array.from(row.cells).indexOf(cell as HTMLTableCellElement);
    if (rowIndex < 0 || columnIndex < 0) return null;
    return {
      table,
      row: row as HTMLTableRowElement,
      cell: cell as HTMLTableCellElement,
      rowIndex,
      columnIndex
    };
  };

  useEffect(() => {
    if (editorMode !== 'rich') {
      setTableContext(null);
      return;
    }
    const update = (): void => {
      if (document.activeElement !== richRef.current) {
        setTableContext((current) => (current ? null : current));
        return;
      }
      setTableContext(findRichTableContext());
    };
    update();
    document.addEventListener('selectionchange', update);
    return () => document.removeEventListener('selectionchange', update);
    // findRichTableContext 只依赖 richRef，无需加入依赖。
  }, [editorMode]);

  // 批注/笔记列表：先选文献再加载。
  useEffect(() => {
    if (!internalOpen || internalKind === 'document') {
      setInternalAnnotations([]);
      setInternalNotes([]);
      setInternalLoading(false);
      setInternalError('');
      return;
    }
    if (!internalDocId) {
      setInternalAnnotations([]);
      setInternalNotes([]);
      setInternalLoading(false);
      setInternalError('');
      return;
    }
    if (internalDocId === STANDALONE_DOC_VALUE) {
      // 独立笔记直接用传入的 standaloneNotes，不需要按文献加载。
      setInternalAnnotations([]);
      setInternalNotes([]);
      setInternalLoading(false);
      setInternalError('');
      return;
    }
    const loader =
      internalKind === 'annotation' ? loadersRef.current.loadAnnotations : loadersRef.current.loadNotes;
    if (!loader) {
      setInternalLoading(false);
      setInternalError(
        internalKind === 'note'
          ? '当前上下文不支持读取该文献的笔记；可在「选择文献」里选「独立笔记」或切回源码模式插入。'
          : '当前上下文不支持读取该文献的批注。'
      );
      return;
    }
    let cancelled = false;
    setInternalLoading(true);
    setInternalError('');
    setInternalItemId('');
    loader(internalDocId)
      .then((items) => {
        if (cancelled) return;
        if (internalKind === 'annotation') setInternalAnnotations(items as AnnotationRecord[]);
        else setInternalNotes(items as NoteRecord[]);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setInternalError(error instanceof Error ? error.message : '读取失败');
      })
      .finally(() => {
        if (!cancelled) setInternalLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [internalOpen, internalKind, internalDocId]);

  const clamp = (position: number): number => Math.max(0, Math.min(position, value.length));

  const currentSelection = (): { start: number; end: number } => {
    const element = textareaRef.current;
    if (element && document.activeElement === element) {
      return { start: element.selectionStart, end: element.selectionEnd };
    }
    return { start: clamp(selectionRef.current.start), end: clamp(selectionRef.current.end) };
  };

  const saveSelection = (): void => {
    const element = textareaRef.current;
    if (!element) return;
    selectionRef.current = { start: element.selectionStart, end: element.selectionEnd };
  };

  const commit = (
    nextValue: string,
    selectionStart: number,
    selectionEnd: number,
    options?: { coalesce?: boolean; focus?: boolean }
  ): void => {
    if (disabled) return;
    setHistory((current) => {
      let entries: HistoryEntry[];
      let index: number;
      if (options?.coalesce && current.entries.length > 1) {
        // 连续输入：替换当前状态而不是新压一步，保证仍有上一个撤销点。
        entries = current.entries.slice(0, current.index + 1);
        entries[entries.length - 1] = { value: nextValue, selectionStart, selectionEnd };
        index = entries.length - 1;
      } else {
        entries = [
          ...current.entries.slice(0, current.index + 1),
          { value: nextValue, selectionStart, selectionEnd }
        ];
        index = entries.length - 1;
      }
      if (entries.length > HISTORY_LIMIT) {
        const drop = entries.length - HISTORY_LIMIT;
        entries = entries.slice(drop);
        index -= drop;
      }
      return { entries, index };
    });
    if (options?.focus !== false) {
      pendingSelectionRef.current = { start: selectionStart, end: selectionEnd };
    }
    onChange(nextValue);
  };

  const applyCommand = (command: MarkdownCommand, commandValue?: string): void => {
    if (disabled) return;
    lastInputAtRef.current = 0;
    const { start, end } = currentSelection();
    const result = applyMarkdownCommand(value, start, end, command, commandValue);
    commit(result.text, result.selectionStart, result.selectionEnd);
  };

  const buttonsDisabled = disabled || preview;

  // ---- 富文本（contenteditable）模式 ----
  const serializeRich = (): string | null => {
    const element = richRef.current;
    if (!element) return null;
    return htmlToMarkdown(element).trim();
  };

  const scheduleRichSerialize = (): void => {
    if (richTimerRef.current !== null) window.clearTimeout(richTimerRef.current);
    richTimerRef.current = window.setTimeout(() => {
      richTimerRef.current = null;
      const markdown = serializeRich();
      if (markdown === null || markdown === lastSerializedRef.current) return;
      lastSerializedRef.current = markdown;
      onChange(markdown);
    }, 250);
  };

  const flushRichInput = (): void => {
    if (richTimerRef.current !== null) {
      window.clearTimeout(richTimerRef.current);
      richTimerRef.current = null;
    }
    const markdown = serializeRich();
    if (markdown === null || markdown === lastSerializedRef.current) return;
    lastSerializedRef.current = markdown;
    onChange(markdown);
  };

  const saveRichRange = (): void => {
    const element = richRef.current;
    if (!element) return;
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    if (element.contains(range.commonAncestorContainer)) {
      richRangeRef.current = range.cloneRange();
    }
  };

  const restoreRichRange = (): void => {
    const element = richRef.current;
    if (!element) return;
    element.focus({ preventScroll: true });
    const range = richRangeRef.current;
    if (range && element.contains(range.commonAncestorContainer)) {
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
  };

  const insertRichHtml = (html: string): void => {
    const element = richRef.current;
    if (!element) return;
    restoreRichRange();
    const selection = window.getSelection();
    const inside =
      selection && selection.rangeCount > 0
        ? element.contains(selection.getRangeAt(0).commonAncestorContainer)
        : false;
    if (selection && !inside) {
      const range = window.document.createRange();
      range.selectNodeContents(element);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    const inserted = window.document.execCommand('insertHTML', false, html);
    if (!inserted) {
      const current = window.getSelection();
      if (current && current.rangeCount > 0) {
        const range = current.getRangeAt(0);
        range.deleteContents();
        const template = window.document.createElement('template');
        template.innerHTML = html;
        range.insertNode(template.content.cloneNode(true));
      } else {
        element.insertAdjacentHTML('beforeend', html);
      }
    }
    scheduleRichSerialize();
  };

  const insertRichText = (text: string): void => {
    const element = richRef.current;
    if (!element) return;
    element.focus({ preventScroll: true });
    if (!window.document.execCommand('insertText', false, text)) {
      element.textContent = `${element.textContent ?? ''}${text}`;
    }
    scheduleRichSerialize();
  };

  const execRich = (command: string, commandValue?: string): boolean => {
    const element = richRef.current;
    if (!element) return false;
    restoreRichRange();
    return window.document.execCommand(command, false, commandValue);
  };

  const execRichFormatBlock = (tag: string): void => {
    if (!execRich('formatBlock', `<${tag}>`)) execRich('formatBlock', tag);
  };

  const insertRichTable = (): void => {
    insertRichHtml(
      '<table><thead><tr><th>列1</th><th>列2</th></tr></thead><tbody><tr><td>内容</td><td>内容</td></tr><tr><td></td><td></td></tr></tbody></table>'
    );
  };

  const wrapSelectedInlineCode = (): void => {
    const selection = window.getSelection();
    const text = selection?.toString() ?? '';
    insertRichHtml(`<code>${escapeHtmlText(text || '代码')}</code>`);
  };

  const clearRichFormatting = (): void => {
    execRich('removeFormat');
    execRich('unlink');
    // removeFormat 不一定移除颜色 span / mark，这里再解开选区最近的这类节点。
    const element = richRef.current;
    const selection = window.getSelection();
    if (!element || !selection || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    let node: Node | null = range.commonAncestorContainer;
    while (node && node !== element) {
      if (node.nodeType === 1) {
        const current = node as HTMLElement;
        const isColorSpan =
          current.tagName === 'SPAN' && Boolean(current.style.color || current.style.backgroundColor);
        if (isColorSpan || current.tagName === 'MARK') {
          const parent = current.parentNode;
          if (parent) {
            while (current.firstChild) parent.insertBefore(current.firstChild, current);
            parent.removeChild(current);
          }
          break;
        }
      }
      node = node.parentNode;
    }
  };

  const openRichLinkDialog = (): void => {
    const selection = window.getSelection();
    const text = selection?.toString() ?? '';
    if (text) saveRichRange();
    setRichLinkDialog({ text, url: '', error: '' });
  };

  const confirmRichLink = (): void => {
    if (!richLinkDialog) return;
    const url = richLinkDialog.url.trim();
    if (!/^https?:\/\//i.test(url) && !/^mailto:/i.test(url)) {
      setRichLinkDialog({
        ...richLinkDialog,
        error: '请输入以 http(s):// 或 mailto: 开头的地址。'
      });
      return;
    }
    const label = richLinkDialog.text.trim() || url;
    setRichLinkDialog(null);
    insertRichHtml(
      `<a href="${escapeHtmlAttribute(url)}" target="_blank" rel="noreferrer">${escapeHtmlText(
        label
      )}</a>`
    );
  };

  const insertRichImage = (fileName: string, url: string, notice: string): void => {
    const alt =
      (fileName.replace(/\.[^.]+$/, '') || '图片').replace(/[[\]()]/g, ' ').trim() || '图片';
    const displayUrl = resolveAssetUrl(url);
    const sourceAttribute =
      displayUrl !== url ? ` ${ASSET_SOURCE_ATTRIBUTE}="${escapeHtmlAttribute(url)}"` : '';
    insertRichHtml(
      `<img src="${escapeHtmlAttribute(displayUrl)}"${sourceAttribute} alt="${escapeHtmlAttribute(
        alt
      )}" />`
    );
    setEditorNotice(notice);
  };

  /** 把光标放到指定单元格开头（表格行列编辑后使用），并刷新表格上下文。 */
  const focusRichCell = (cell: HTMLTableCellElement | undefined | null): void => {
    const element = richRef.current;
    if (!element || !cell) return;
    element.focus({ preventScroll: true });
    const range = window.document.createRange();
    range.selectNodeContents(cell);
    range.collapse(true);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    saveRichRange();
    setTableContext(findRichTableContext());
  };

  /** 富文本表格行列编辑：操作 DOM 后立即序列化（保持 Markdown 存储最新）。 */
  const editRichTable = (edit: TableEditAction): void => {
    const context = tableContext;
    if (!context || !richRef.current) return;
    const { table, row, rowIndex, columnIndex } = context;
    const rows = Array.from(table.rows);
    const rowCount = rows.length;
    const columnCount = Math.max(1, ...rows.map((item) => item.cells.length));
    const plan = planTableEdit(edit, { rowCount, columnCount, rowIndex, columnIndex });

    if (plan.kind === 'remove-table') {
      table.remove();
      setTableContext(null);
      flushRichInput();
      return;
    }

    if (plan.kind === 'insert-row') {
      const referenceRow = rows[Math.min(plan.rowIndex, rowCount - 1)] ?? row;
      const newRow = window.document.createElement('tr');
      for (const referenceCell of Array.from(referenceRow.cells)) {
        const newCell = window.document.createElement(
          referenceCell.tagName === 'TH' ? 'th' : 'td'
        );
        newCell.innerHTML = '&nbsp;';
        newRow.appendChild(newCell);
      }
      if (plan.rowIndex < rowCount) {
        const beforeRow = rows[plan.rowIndex];
        beforeRow?.parentNode?.insertBefore(newRow, beforeRow);
      } else {
        const lastRow = rows[rowCount - 1] ?? referenceRow;
        lastRow.parentNode?.insertBefore(newRow, lastRow.nextSibling);
      }
      setTableContext(null);
      flushRichInput();
      focusRichCell(newRow.cells[0]);
      return;
    }

    if (plan.kind === 'insert-column') {
      for (const currentRow of rows) {
        const referenceCell =
          currentRow.cells[Math.min(plan.columnIndex, currentRow.cells.length - 1)];
        const newCell = window.document.createElement(
          referenceCell?.tagName === 'TH' ? 'th' : 'td'
        );
        newCell.innerHTML = '&nbsp;';
        if (plan.columnIndex < currentRow.cells.length) {
          currentRow.insertBefore(newCell, currentRow.cells[plan.columnIndex] ?? null);
        } else {
          const lastCell = currentRow.cells[currentRow.cells.length - 1];
          if (lastCell) currentRow.insertBefore(newCell, lastCell.nextSibling);
          else currentRow.appendChild(newCell);
        }
      }
      const focusRow = rows[Math.min(rowIndex, rowCount - 1)] ?? row;
      const focusCell = focusRow.cells[Math.min(plan.columnIndex, focusRow.cells.length - 1)];
      setTableContext(null);
      flushRichInput();
      focusRichCell(focusCell);
      return;
    }

    if (plan.kind === 'delete-row') {
      rows[plan.rowIndex]?.remove();
      const remaining = Array.from(table.rows);
      const focusRow = remaining[Math.min(plan.focusRowIndex, remaining.length - 1)];
      setTableContext(null);
      flushRichInput();
      focusRichCell(focusRow?.cells[0]);
      return;
    }

    // delete-column
    for (const currentRow of rows) {
      currentRow.cells[plan.columnIndex]?.remove();
    }
    const focusRowAfter = Array.from(table.rows)[Math.min(rowIndex, table.rows.length - 1)];
    const focusCellAfter =
      focusRowAfter?.cells[Math.min(plan.focusColumnIndex, Math.max(0, focusRowAfter.cells.length - 1))];
    setTableContext(null);
    flushRichInput();
    focusRichCell(focusCellAfter);
  };

  /** 富文本模式的工具栏路由：全部走 execCommand，不调用 shared 的源码命令。 */
  const applyRichCommand = (command: MarkdownCommand, commandValue?: string): void => {
    if (buttonsDisabled) return;
    switch (command) {
      case 'bold':
        execRich('bold');
        break;
      case 'italic':
        execRich('italic');
        break;
      case 'underline':
        execRich('underline');
        break;
      case 'strike':
        execRich('strikeThrough');
        break;
      case 'highlight':
        execRich('hiliteColor', '#f0dfa2');
        break;
      case 'color':
        execRich('foreColor', commandValue ?? '#b23b2e');
        break;
      case 'h1':
        execRichFormatBlock('h1');
        break;
      case 'h2':
        execRichFormatBlock('h2');
        break;
      case 'h3':
        execRichFormatBlock('h3');
        break;
      case 'quote':
        execRichFormatBlock('blockquote');
        break;
      case 'ul':
        execRich('insertUnorderedList');
        break;
      case 'ol':
        execRich('insertOrderedList');
        break;
      case 'align-left':
        execRich('justifyLeft');
        break;
      case 'align-center':
        execRich('justifyCenter');
        break;
      case 'align-right':
        execRich('justifyRight');
        break;
      case 'align-justify':
        execRich('justifyFull');
        break;
      case 'indent':
        execRich('indent');
        break;
      case 'outdent':
        execRich('outdent');
        break;
      case 'clear':
        clearRichFormatting();
        break;
      case 'table':
        insertRichTable();
        break;
      case 'link':
        openRichLinkDialog();
        return;
      case 'code':
        wrapSelectedInlineCode();
        break;
      case 'image':
        openImagePicker();
        return;
      case 'task':
        setEditorNotice('任务清单请在源码模式使用。');
        return;
      default:
        return;
    }
    scheduleRichSerialize();
  };

  const handleRichInput = (): void => {
    scheduleRichSerialize();
  };

  const handleRichBlur = (): void => {
    saveRichRange();
    flushRichInput();
  };

  const handleRichPaste = (event: React.ClipboardEvent<HTMLDivElement>): void => {
    const clipboard = event.clipboardData;
    if (!clipboard) return;
    let imageItem: DataTransferItem | null = null;
    for (const item of clipboard.items ?? []) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        imageItem = item;
        break;
      }
    }
    if (imageItem) {
      event.preventDefault();
      saveRichRange();
      const file = imageItem.getAsFile();
      if (!file) {
        setEditorNotice('剪贴板里的图片无法读取，请重试。');
        return;
      }
      readImageFile(file);
      return;
    }
    // HTML 粘贴只取 text/plain（没有时退回 HTML 的 textContent），全部按纯文本插入，防 XSS。
    event.preventDefault();
    const plain = clipboard.getData('text/plain');
    let text = plain;
    if (!text) {
      const html = clipboard.getData('text/html');
      if (html) {
        try {
          text = new DOMParser().parseFromString(html, 'text/html').body.textContent ?? '';
        } catch {
          text = '';
        }
      }
    }
    if (text) insertRichText(text);
  };

  const switchEditorMode = (next: EditorMode): void => {
    if (disabled || next === editorMode) return;
    if (richTimerRef.current !== null) {
      window.clearTimeout(richTimerRef.current);
      richTimerRef.current = null;
    }
    if (next === 'rich') {
      sessionEditorMode = 'rich';
      setPreview(false);
      setPainting(null);
      setEditorNotice('');
      setEditorMode('rich');
      return;
    }
    // 富文本 → 源码：先序列化回 Markdown，并压入源码撤销历史。
    sessionEditorMode = 'source';
    const markdown = serializeRich();
    setEditorMode('source');
    if (markdown !== null) {
      // 只比较去掉首尾空白后的正文：渲染/序列化本身可能规范化空行或行尾空格，
      // 没有真实修改时不能把它误判成「未保存」。
      const changed = markdown.trim() !== lastSerializedRef.current.trim();
      lastSerializedRef.current = markdown;
      if (changed) {
        lastInputAtRef.current = 0;
        commit(markdown, markdown.length, markdown.length, { focus: false });
      }
    }
  };

  const applyColor = (hex: string): void => {
    if (buttonsDisabled) return;
    if (editorMode === 'rich') {
      execRich('foreColor', hex);
      scheduleRichSerialize();
      return;
    }
    applyCommand('color', hex);
  };

  const togglePreview = (): void => {
    if (disabled || editorMode === 'rich') return;
    if (!preview) {
      saveSelection();
      setPainting(null);
      setPreview(true);
      return;
    }
    setPreview(false);
    // 回到编辑态：恢复之前的选区（不动撤销历史）。
    window.requestAnimationFrame(() => {
      const element = textareaRef.current;
      if (!element) return;
      element.focus({ preventScroll: true });
      element.setSelectionRange(clamp(selectionRef.current.start), clamp(selectionRef.current.end));
    });
  };

  const toggleFormatBrush = (): void => {
    if (buttonsDisabled || editorMode === 'rich') return;
    if (!painting) {
      const { start, end } = currentSelection();
      if (start === end) {
        setEditorNotice('先选中一段带格式的文字，再点「格式刷」吸取格式。');
        return;
      }
      const formatting = captureMarkdownFormatting(value.slice(start, end));
      if (formatting.markers.length === 0 && !formatting.color) {
        setEditorNotice('选中的文字没有可吸取的格式（加粗/斜体/下划线/删除线/高亮/颜色）。');
        return;
      }
      setPainting(formatting);
      setEditorNotice('格式已吸取：选中目标文字后再次点「格式刷」应用（Esc 取消）。');
      return;
    }
    const { start, end } = currentSelection();
    if (start === end) {
      setEditorNotice('请先选中要应用格式的文字。');
      return;
    }
    lastInputAtRef.current = 0;
    const result = applyMarkdownFormatting(value, start, end, painting);
    setPainting(null);
    setEditorNotice('格式刷已应用到选中文字。');
    commit(result.text, result.selectionStart, result.selectionEnd);
  };

  const openImagePicker = (): void => {
    if (buttonsDisabled || imageUploading) return;
    // 富文本模式：文件选择会抢焦点，先把可编辑区选区存下来。
    if (editorMode === 'rich') saveRichRange();
    imageInputRef.current?.click();
  };

  /** 在指定位置插入独占一行的 Markdown 图片。 */
  const insertImageMarkdown = (
    fileName: string,
    url: string,
    notice: string,
    anchor?: { start: number; end: number }
  ): void => {
    const alt =
      (fileName.replace(/\.[^.]+$/, '') || '图片').replace(/[[\]()]/g, ' ').trim() || '图片';
    const snippet = `![${alt}](${url})`;
    const currentValue = valueRef.current;
    const { start, end } = anchor ?? currentSelection();
    const safeStart = Math.max(0, Math.min(start, currentValue.length));
    const safeEnd = Math.max(safeStart, Math.min(end, currentValue.length));
    const before = currentValue.slice(0, safeStart);
    const after = currentValue.slice(safeEnd);
    // 图片独占一行：前后不是换行时自动补换行，渲染出来不会挤进正文段落。
    const prefix = before && !before.endsWith('\n') ? '\n' : '';
    const suffix = after && !after.startsWith('\n') ? '\n' : '';
    const inserted = `${prefix}${snippet}${suffix}`;
    const caret = safeStart + inserted.length;
    lastInputAtRef.current = 0;
    commit(`${before}${inserted}${after}`, caret, caret);
    setEditorNotice(notice);
  };

  /** 图片最终落点：富文本 insertHTML `<img>`；源码插入 Markdown 图片。 */
  const deliverImage = (
    fileName: string,
    url: string,
    notice: string,
    sourceAnchor: { start: number; end: number } | null
  ): void => {
    if (editorModeRef.current === 'rich') {
      insertRichImage(fileName, url, notice);
      return;
    }
    insertImageMarkdown(fileName, url, notice, sourceAnchor ?? currentSelection());
  };

  const readImageFile = (file: File): void => {
    if (!IMAGE_MIME_TYPES.has(file.type)) {
      setEditorNotice('只支持 PNG / JPEG / GIF / WebP 图片，未插入。');
      return;
    }
    if (file.size > IMAGE_MAX_BYTES) {
      setEditorNotice(
        `图片 ${(file.size / 1024 / 1024).toFixed(
          1
        )}MB 超过 20MB 安全上限，未插入；可压缩图片或调整「笔记图片上限」后再试。`
      );
      return;
    }
    // 先记住插入位置：上传/读取是异步的，期间光标可能移动。
    const insertionMode = editorModeRef.current;
    const sourceAnchor = insertionMode === 'source' ? currentSelection() : null;
    if (insertionMode === 'rich') saveRichRange();
    const filename =
      file.name || `pasted.${(file.type.split('/')[1] ?? 'png').replace('jpeg', 'jpg')}`;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = typeof reader.result === 'string' ? reader.result : '';
      if (!dataUrl.startsWith('data:image/')) {
        setEditorNotice('读取图片失败：文件不是有效图片。');
        return;
      }
      if (dataUrl.length > IMAGE_MAX_BYTES) {
        setEditorNotice(
          '图片转成 data URL 后超过 20MB 安全上限，未插入；可压缩图片或调整「笔记图片上限」后再试。'
        );
        return;
      }
      const uploader = uploadImage;
      if (!uploader) {
        deliverImage(
          filename,
          dataUrl,
          `已插入图片「${filename || '图片'}」（约 ${Math.round(
            dataUrl.length / 1024
          )}KB，内联 data URL）。`,
          sourceAnchor
        );
        return;
      }
      setImageUploading(true);
      setEditorNotice('正在上传图片…');
      void resolveImageSource(filename, dataUrl, uploader)
        .then((result) => {
          // 上传失败不再回退内联：只显示服务端中文错误，避免绕过大小/像素限制。
          if (!result.url) {
            setEditorNotice(result.notice);
            return;
          }
          deliverImage(filename, result.url, result.notice, sourceAnchor);
        })
        .finally(() => setImageUploading(false));
    };
    reader.onerror = () => setEditorNotice('读取图片失败，请重试。');
    reader.readAsDataURL(file);
  };

  const handleImageFile = (event: React.ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0];
    // 清空 value，允许再次选择同一个文件。
    event.target.value = '';
    if (file) readImageFile(file);
  };

  const handlePasteImage = (event: React.ClipboardEvent<HTMLTextAreaElement>): void => {
    const items = event.clipboardData?.items;
    if (!items) return;
    let imageItem: DataTransferItem | null = null;
    for (const item of items) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        imageItem = item;
        break;
      }
    }
    if (!imageItem) return; // 普通文本粘贴交给浏览器默认行为
    event.preventDefault();
    const file = imageItem.getAsFile();
    if (!file) {
      setEditorNotice('剪贴板里的图片无法读取，请重试。');
      return;
    }
    readImageFile(file);
  };

  const cancelFormatBrush = (): void => {
    if (!painting) return;
    setPainting(null);
    setEditorNotice('已取消格式刷。');
  };

  const goToHistory = (index: number): void => {
    const entry = history.entries[index];
    if (!entry) return;
    lastInputAtRef.current = 0;
    setHistory({ ...history, index });
    pendingSelectionRef.current = { start: entry.selectionStart, end: entry.selectionEnd };
    onChange(entry.value);
  };

  const undo = (): void => {
    if (disabled || history.index <= 0) return;
    goToHistory(history.index - 1);
  };

  const redo = (): void => {
    if (disabled || history.index >= history.entries.length - 1) return;
    goToHistory(history.index + 1);
  };

  const handleChange = (event: React.ChangeEvent<HTMLTextAreaElement>): void => {
    const nextValue = event.target.value;
    const selectionStart = event.target.selectionStart;
    const selectionEnd = event.target.selectionEnd;
    const now = Date.now();
    const coalesce = now - lastInputAtRef.current < TYPING_COALESCE_MS;
    lastInputAtRef.current = now;
    commit(nextValue, selectionStart, selectionEnd, { coalesce });
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Escape' && painting) {
      event.preventDefault();
      event.stopPropagation();
      cancelFormatBrush();
      return;
    }
    const modifier = event.ctrlKey || event.metaKey;
    if (!modifier) return;
    const key = event.key.toLowerCase();
    if (key === 'z' && !event.shiftKey) {
      event.preventDefault();
      undo();
      return;
    }
    if (key === 'y' || (key === 'z' && event.shiftKey)) {
      event.preventDefault();
      redo();
    }
  };

  const canReference = !disabled && (documents.length > 0 || standaloneNotes.length > 0);
  const internalAvailable: Record<InternalKind, boolean> = {
    document: documents.length > 0,
    annotation: Boolean(loadAnnotations),
    note: Boolean(loadNotes) || standaloneNotes.length > 0
  };

  const visibleDocuments = (() => {
    const keyword = internalSearch.trim().toLowerCase();
    if (!keyword) return documents;
    return documents.filter(
      (item) =>
        item.name.toLowerCase().includes(keyword) ||
        (item.author ?? '').toLowerCase().includes(keyword) ||
        (item.publication ?? '').toLowerCase().includes(keyword)
    );
  })();

  const standaloneNoteItems: InternalItem[] = standaloneNotes.map((item) => ({
    id: item.id,
    label: `独立笔记 · ${summarizeInternalLabel(item.content || '空笔记', 30)}`
  }));

  const internalItems: InternalItem[] =
    internalKind === 'annotation'
      ? internalAnnotations.map((item) => ({
          id: item.id,
          label: `第 ${item.page} 页 · ${summarizeInternalLabel(item.quote || item.content || '空批注', 30)}`
        }))
      : internalKind === 'note'
        ? internalDocId === STANDALONE_DOC_VALUE
          ? standaloneNoteItems
          : internalNotes.map((item) => ({
              id: item.id,
              label: `${item.page === 0 ? '整篇' : `第 ${item.page} 页`} · ${summarizeInternalLabel(
                item.content,
                30
              )}`
            }))
        : [];

  const openInternalDialog = (): void => {
    if (!canReference) return;
    if (editorMode === 'rich') saveRichRange();
    const element = textareaRef.current;
    internalAnchorRef.current = element
      ? { start: element.selectionStart, end: element.selectionEnd }
      : { ...selectionRef.current };
    setInternalOpen(true);
    setInternalKind('document');
    setInternalSearch('');
    setInternalDocId('');
    setInternalItemId('');
    setInternalAnnotations([]);
    setInternalNotes([]);
    setInternalError('');
  };

  const closeInternalDialog = (): void => {
    setInternalOpen(false);
    if (editorMode === 'rich') {
      restoreRichRange();
      return;
    }
    restoreSelectionOnFocusRef.current = true;
    window.requestAnimationFrame(() => {
      const element = textareaRef.current;
      if (!element) return;
      element.focus({ preventScroll: true });
      element.setSelectionRange(selectionRef.current.start, selectionRef.current.end);
    });
  };

  const insertInternalReference = (): void => {
    const standaloneNoteTarget =
      internalKind === 'note' && internalDocId === STANDALONE_DOC_VALUE;
    const targetDocument = standaloneNoteTarget
      ? undefined
      : documents.find((item) => item.id === internalDocId);
    if (!standaloneNoteTarget && !targetDocument) return;
    const selectedItem = internalItems.find((item) => item.id === internalItemId);
    if (internalKind !== 'document' && !selectedItem) return;
    let target: MarkdownInternalTargetInput;
    let label: string;
    if (internalKind === 'document') {
      if (!targetDocument) return;
      target = { kind: 'document', documentId: targetDocument.id };
      label = targetDocument.name;
    } else if (internalKind === 'annotation') {
      if (!targetDocument) return;
      target = {
        kind: 'annotation',
        documentId: targetDocument.id,
        annotationId: internalItemId
      };
      label = `批注：${selectedItem?.label ?? '批注'}`;
    } else if (standaloneNoteTarget) {
      // 独立笔记：documentId 为空，序列化为 [[note:<noteId>]]。
      target = { kind: 'note', documentId: '', noteId: internalItemId };
      label = `笔记：${selectedItem?.label ?? '笔记'}`;
    } else {
      if (!targetDocument) return;
      target = { kind: 'note', documentId: targetDocument.id, noteId: internalItemId };
      label = `笔记：${selectedItem?.label ?? '笔记'}`;
    }
    if (editorModeRef.current === 'rich') {
      // 富文本：插入带 data-internal-* 的链接，切回源码时会序列化成 [[...]]。
      let attrs: string;
      if (target.kind === 'document') {
        attrs = `data-internal-kind="document" data-internal-doc="${escapeHtmlAttribute(
          target.documentId
        )}"`;
      } else if (target.kind === 'annotation') {
        attrs = `data-internal-kind="annotation" data-internal-doc="${escapeHtmlAttribute(
          target.documentId
        )}" data-internal-id="${escapeHtmlAttribute(target.annotationId)}"`;
      } else {
        attrs = `data-internal-kind="note" data-internal-doc="${escapeHtmlAttribute(
          target.documentId
        )}" data-internal-id="${escapeHtmlAttribute(target.noteId)}"`;
      }
      setInternalOpen(false);
      insertRichHtml(
        `<a class="kr-md-link kr-md-internal" href="#" ${attrs} data-internal-label="${escapeHtmlAttribute(
          label
        )}">${escapeHtmlText(label)}</a>`
      );
      return;
    }
    const link = formatMarkdownInternalLink(target, label);
    const anchor = internalAnchorRef.current;
    const start = clamp(anchor.start);
    const end = Math.max(start, clamp(anchor.end));
    const before = value.slice(0, start);
    const after = value.slice(end);
    const prefix = before && !/[\s([（]$/.test(before) ? ' ' : '';
    const suffix = after && !/^[\s.,，。!?！？)\]）]/.test(after) ? ' ' : '';
    const inserted = `${prefix}${link}${suffix}`;
    const caret = start + inserted.length;
    lastInputAtRef.current = 0;
    commit(`${before}${inserted}${after}`, caret, caret);
    setInternalOpen(false);
    restoreSelectionOnFocusRef.current = true;
    window.requestAnimationFrame(() => {
      const element = textareaRef.current;
      if (!element) return;
      element.focus({ preventScroll: true });
      element.setSelectionRange(caret, caret);
    });
  };

  const editorRows = rows ?? (compact ? 3 : 5);

  return (
    <div
      className={`kr-md-editor${compact ? ' is-compact' : ''}${disabled ? ' is-disabled' : ''}${
        preview ? ' is-preview' : ''
      }${editorMode === 'rich' ? ' is-rich' : ''}`}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        if (painting) {
          event.stopPropagation();
          cancelFormatBrush();
          return;
        }
        if (preview) {
          event.stopPropagation();
          event.preventDefault();
          togglePreview();
        }
      }}
    >
      <div className="kr-md-modebar" role="group" aria-label="编辑模式">
        <button
          type="button"
          className={editorMode === 'source' ? 'is-active' : ''}
          aria-pressed={editorMode === 'source'}
          disabled={disabled}
          title="源码模式：直接编辑 Markdown（格式刷 / 上移下移 / 预览可用）"
          onClick={() => switchEditorMode('source')}
        >
          源码
        </button>
        <button
          type="button"
          className={editorMode === 'rich' ? 'is-active' : ''}
          aria-pressed={editorMode === 'rich'}
          disabled={disabled}
          title="富文本模式：所见即所得编辑（格式刷 / 上移下移 / 预览请切回源码）"
          onClick={() => switchEditorMode('rich')}
        >
          富文本
        </button>
      </div>
      <div className="kr-md-toolbar" role="toolbar" aria-label="Markdown 工具栏">
        {TOOLBAR_GROUPS.map((group, groupIndex) => (
          <span className="kr-md-toolbar__group" key={groupIndex}>
            {group.map((item) => {
              const blockedInRich =
                editorMode === 'rich' &&
                (item.command === 'move-up' ||
                  item.command === 'move-down' ||
                  item.command === 'task');
              const title = blockedInRich
                ? '该操作请切回源码模式使用'
                : editorMode === 'rich' && item.command === 'image'
                  ? '插入本地图片（≤20MB 安全上限；实际上限由设置决定）'
                  : item.title;
              return (
                <button
                  key={item.command}
                  type="button"
                  className="kr-md-toolbar__button"
                  title={title}
                  aria-label={item.aria}
                  disabled={buttonsDisabled || blockedInRich}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() =>
                    editorMode === 'rich'
                      ? applyRichCommand(item.command)
                      : applyCommand(item.command)
                  }
                >
                  {item.label}
                </button>
              );
            })}
          </span>
        ))}
        <span className="kr-md-toolbar__group kr-md-toolbar__colors" role="group" aria-label="文字颜色">
          {PRESET_COLORS.map((color) => (
            <button
              key={color.hex}
              type="button"
              className="kr-md-color-swatch"
              style={{ backgroundColor: color.hex }}
              title={`文字颜色：${color.name}（${color.hex}）`}
              aria-label={`文字颜色 ${color.name}`}
              disabled={buttonsDisabled}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => applyColor(color.hex)}
            />
          ))}
        </span>
        <span className="kr-md-toolbar__group">
          <button
            type="button"
            className="kr-md-toolbar__button"
            title={
              editorMode === 'rich' ? '撤销（富文本使用浏览器原生撤销，Ctrl+Z）' : '撤销（Ctrl+Z）'
            }
            aria-label="撤销"
            disabled={
              buttonsDisabled || (editorMode === 'source' && history.index <= 0)
            }
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              if (editorMode === 'rich') {
                execRich('undo');
                scheduleRichSerialize();
                return;
              }
              undo();
            }}
          >
            ↶
          </button>
          <button
            type="button"
            className="kr-md-toolbar__button"
            title={
              editorMode === 'rich'
                ? '重做（富文本使用浏览器原生重做，Ctrl+Y / Ctrl+Shift+Z）'
                : '重做（Ctrl+Y / Ctrl+Shift+Z）'
            }
            aria-label="重做"
            disabled={
              buttonsDisabled ||
              (editorMode === 'source' && history.index >= history.entries.length - 1)
            }
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              if (editorMode === 'rich') {
                execRich('redo');
                scheduleRichSerialize();
                return;
              }
              redo();
            }}
          >
            ↷
          </button>
        </span>
        <span className="kr-md-toolbar__group">
          <button
            type="button"
            className={`kr-md-toolbar__button kr-md-toolbar__brush${painting ? ' is-active' : ''}`}
            title={
              editorMode === 'rich'
                ? '格式刷请切回源码模式使用'
                : painting
                  ? '格式刷已激活：选中目标文字后再次点击应用（Esc 取消）'
                  : '格式刷：先选中带格式的文字，点击吸取格式'
            }
            aria-label="格式刷"
            aria-pressed={Boolean(painting)}
            disabled={buttonsDisabled || editorMode === 'rich'}
            onMouseDown={(event) => event.preventDefault()}
            onClick={toggleFormatBrush}
          >
            刷
          </button>
          <button
            type="button"
            className="kr-md-toolbar__button"
            title={
              imageUploading
                ? '正在上传图片…'
                : editorMode === 'rich'
                  ? '插入本地图片（≤20MB 安全上限；实际上限由设置决定）'
                  : '插入本地图片（≤20MB 安全上限；也可以直接粘贴图片）'
            }
            aria-label="插入本地图片"
            disabled={buttonsDisabled || imageUploading}
            onMouseDown={(event) => event.preventDefault()}
            onClick={openImagePicker}
          >
            {imageUploading ? '传…' : '图'}
          </button>
          <button
            type="button"
            className={`kr-md-toolbar__button kr-md-toolbar__preview-toggle${preview ? ' is-active' : ''}`}
            title={
              editorMode === 'rich'
                ? '富文本模式已是可视化编辑；预览请切回源码模式'
                : preview
                  ? '返回编辑（撤销历史保留）'
                  : '预览 Markdown 渲染效果'
            }
            aria-label={preview ? '返回编辑' : '预览'}
            aria-pressed={preview}
            disabled={disabled || editorMode === 'rich'}
            onMouseDown={(event) => event.preventDefault()}
            onClick={togglePreview}
          >
            {preview ? '返回编辑' : '预览'}
          </button>
        </span>
        <button
          type="button"
          className="kr-md-toolbar__button kr-md-toolbar__internal"
          title={
            preview
              ? '预览态不能插入内部引用，请先返回编辑'
              : canReference
                ? '插入内部引用（文献 / 批注 / 笔记）'
                : '文献库为空，暂无可引用的内容'
          }
          aria-label="插入内部引用"
          disabled={!canReference || preview}
          onMouseDown={(event) => event.preventDefault()}
          onClick={openInternalDialog}
        >
          [[ ]]
        </button>
      </div>
      {editorMode === 'rich' ? (
        <div className="kr-md-table-tools" role="group" aria-label="表格行列编辑">
          <span className="kr-md-table-tools__label">表格</span>
          <button
            type="button"
            className="kr-md-table-tools__button"
            title="在光标所在行上方插入一行"
            aria-label="上方插入行"
            disabled={!tableContext}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => editRichTable('row-above')}
          >
            ↑行
          </button>
          <button
            type="button"
            className="kr-md-table-tools__button"
            title="在光标所在行下方插入一行"
            aria-label="下方插入行"
            disabled={!tableContext}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => editRichTable('row-below')}
          >
            ↓行
          </button>
          <button
            type="button"
            className="kr-md-table-tools__button"
            title="在光标所在列左侧插入一列"
            aria-label="左侧插入列"
            disabled={!tableContext}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => editRichTable('column-left')}
          >
            ←列
          </button>
          <button
            type="button"
            className="kr-md-table-tools__button"
            title="在光标所在列右侧插入一列"
            aria-label="右侧插入列"
            disabled={!tableContext}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => editRichTable('column-right')}
          >
            →列
          </button>
          <button
            type="button"
            className="kr-md-table-tools__button"
            title="删除光标所在行（只有一行时删除整张表）"
            aria-label="删除行"
            disabled={!tableContext}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => editRichTable('delete-row')}
          >
            删行
          </button>
          <button
            type="button"
            className="kr-md-table-tools__button"
            title="删除光标所在列（只有一列时删除整张表）"
            aria-label="删除列"
            disabled={!tableContext}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => editRichTable('delete-column')}
          >
            删列
          </button>
          <span className="kr-md-table-tools__hint">
            {tableContext
              ? `第 ${tableContext.rowIndex + 1} 行 / 第 ${tableContext.columnIndex + 1} 列`
              : '把光标放到表格单元格里可编辑行列'}
          </span>
        </div>
      ) : null}
      <input
        ref={imageInputRef}
        className="kr-md-image-input"
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        tabIndex={-1}
        aria-hidden="true"
        onChange={handleImageFile}
      />
      {editorNotice ? (
        <p className="kr-md-editor__notice" role="status">
          {editorNotice}
        </p>
      ) : null}
      {editorMode === 'rich' ? (
        <div
          ref={richRef}
          className={`kr-md kr-rich-editor${compact ? ' is-compact' : ''}`}
          contentEditable={!disabled}
          suppressContentEditableWarning
          role="textbox"
          aria-multiline="true"
          aria-label={ariaLabel}
          data-placeholder={placeholder}
          onInput={handleRichInput}
          onKeyUp={saveRichRange}
          onMouseUp={saveRichRange}
          onPaste={handleRichPaste}
          onBlur={handleRichBlur}
        />
      ) : preview ? (
        <div className="kr-md-preview" aria-label="Markdown 预览">
          {value.trim() ? (
            <MarkdownContent
              source={value}
              onOpenInternal={onOpenInternal}
              onOpenAsset={onOpenAsset}
            />
          ) : (
            <p className="kr-muted">还没有内容可预览。</p>
          )}
        </div>
      ) : (
        <textarea
          ref={textareaRef}
          className="kr-md-editor__input"
          rows={editorRows}
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          autoFocus={autoFocus}
          aria-label={ariaLabel}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onPaste={handlePasteImage}
          onSelect={saveSelection}
          onKeyUp={saveSelection}
          onClick={saveSelection}
          onBlur={saveSelection}
          onFocus={() => {
            const element = textareaRef.current;
            if (!element || !restoreSelectionOnFocusRef.current) return;
            restoreSelectionOnFocusRef.current = false;
            element.setSelectionRange(selectionRef.current.start, selectionRef.current.end);
          }}
        />
      )}

      {internalOpen ? (
        <div
          className="kr-modal-backdrop"
          role="presentation"
          onClick={closeInternalDialog}
        >
          <div
            className="kr-modal kr-modal--md-ref"
            role="dialog"
            aria-modal="true"
            aria-label="插入内部引用"
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.stopPropagation();
                closeInternalDialog();
              }
            }}
          >
            <h2>插入内部引用</h2>
            <p className="kr-muted">引用文献、批注或笔记；点击引用会跳到对应位置（Phase 1 单向）。</p>
            <div className="kr-md-ref__kinds" role="tablist" aria-label="引用类型">
              {(['document', 'annotation', 'note'] as const).map((kind) => (
                <button
                  key={kind}
                  type="button"
                  role="tab"
                  aria-selected={internalKind === kind}
                  className={internalKind === kind ? 'is-active' : ''}
                  disabled={!internalAvailable[kind]}
                  title={
                    internalAvailable[kind]
                      ? kind === 'document'
                        ? '引用文献'
                        : kind === 'annotation'
                          ? '引用批注'
                          : '引用笔记'
                      : '当前上下文不支持这种引用'
                  }
                  onClick={() => {
                    setInternalKind(kind);
                    setInternalItemId('');
                    setInternalError('');
                  }}
                >
                  {kind === 'document' ? '文献' : kind === 'annotation' ? '批注' : '笔记'}
                </button>
              ))}
            </div>
            <label className="kr-modal__field">
              搜索文献
              <input
                autoFocus
                value={internalSearch}
                placeholder="按标题、作者或出版物筛选…"
                onChange={(event) => setInternalSearch(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') closeInternalDialog();
                }}
              />
            </label>
            <label className="kr-modal__field">
              选择文献
              <select
                value={internalDocId}
                size={Math.min(7, Math.max(3, visibleDocuments.length))}
                onChange={(event) => {
                  setInternalDocId(event.target.value);
                  setInternalItemId('');
                }}
              >
                <option value="">— 请选择文献 —</option>
                {internalKind === 'note' && standaloneNotes.length > 0 ? (
                  <option value={STANDALONE_DOC_VALUE}>独立笔记（不属于任何文献）</option>
                ) : null}
                {visibleDocuments.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                    {item.author ? ` · ${item.author}` : ''}
                  </option>
                ))}
              </select>
            </label>
            {internalKind !== 'document' ? (
              <div className="kr-modal__field kr-md-ref__items">
                <span>{internalKind === 'annotation' ? '选择批注' : '选择笔记'}</span>
                {!internalDocId ? (
                  <p className="kr-muted">先选择文献，再读取该文献的{internalKind === 'annotation' ? '批注' : '笔记'}。</p>
                ) : internalLoading ? (
                  <p className="kr-muted">正在读取{internalKind === 'annotation' ? '批注' : '笔记'}…</p>
                ) : internalError ? (
                  <p className="kr-page-error" role="alert">
                    {internalError}
                  </p>
                ) : internalItems.length === 0 ? (
                  <p className="kr-muted">这篇文献还没有{internalKind === 'annotation' ? '批注' : '笔记'}。</p>
                ) : (
                  <select
                    value={internalItemId}
                    size={Math.min(6, Math.max(3, internalItems.length))}
                    onChange={(event) => setInternalItemId(event.target.value)}
                  >
                    <option value="">— 请选择 —</option>
                    {internalItems.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.label}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            ) : null}
            <div className="kr-modal__actions">
              <button type="button" className="kr-ghost" onClick={closeInternalDialog}>
                取消
              </button>
              <button
                type="button"
                className="kr-primary"
                disabled={
                  !internalDocId ||
                  internalLoading ||
                  (internalKind !== 'document' && !internalItemId)
                }
                onClick={insertInternalReference}
              >
                插入引用
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {richLinkDialog ? (
        <div
          className="kr-modal-backdrop"
          role="presentation"
          onClick={() => setRichLinkDialog(null)}
        >
          <div
            className="kr-modal kr-modal--md-ref"
            role="dialog"
            aria-modal="true"
            aria-label="插入链接"
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.stopPropagation();
                setRichLinkDialog(null);
              }
            }}
          >
            <h2>插入链接</h2>
            <p className="kr-muted">
              链接文字：{richLinkDialog.text.trim() || '（未选中文字时使用地址作为文字）'}
            </p>
            <label className="kr-modal__field">
              链接地址
              <input
                autoFocus
                value={richLinkDialog.url}
                placeholder="https://…"
                onChange={(event) =>
                  setRichLinkDialog({ ...richLinkDialog, url: event.target.value, error: '' })
                }
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    confirmRichLink();
                  }
                }}
              />
            </label>
            {richLinkDialog.error ? (
              <p className="kr-modal__error" role="alert">
                {richLinkDialog.error}
              </p>
            ) : null}
            <div className="kr-modal__actions">
              <button
                type="button"
                className="kr-ghost"
                onClick={() => setRichLinkDialog(null)}
              >
                取消
              </button>
              <button type="button" className="kr-primary" onClick={confirmRichLink}>
                插入链接
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

