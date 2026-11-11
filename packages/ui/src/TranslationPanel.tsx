import { useEffect, useRef, useState, type FormEvent } from 'react';
import type React from 'react';
import { AI_TRANSLATION_COPY_SUFFIX } from '@studianda/shared';
import type {
  TranslationConfigRecord,
  TranslationJobRecord,
  TranslationPagePayload,
  TranslationServiceSummary
} from '@studianda/shared';
import { TranslationLayoutView } from './TranslationLayoutView.js';

/** 译文栏排版：上下堆叠（默认）或左右对照。 */
type TranslationLayout = 'stacked' | 'columns';
const LAYOUT_STORAGE_KEY = 'studianda.translation.layout';

/** 译文呈现方式：逐段列表（默认）或页面原位「版式」。 */
type TranslationView = 'segments' | 'layout';
const VIEW_STORAGE_KEY = 'studianda.translation.view';

/** 读取持久化的呈现方式；缺失/非法值一律回退「逐段」。 */
function readStoredView(): TranslationView {
  try {
    return window.localStorage.getItem(VIEW_STORAGE_KEY) === 'layout' ? 'layout' : 'segments';
  } catch {
    return 'segments';
  }
}

/** 读取持久化的排版偏好；缺失/非法值一律回退「上下」。 */
function readStoredLayout(): TranslationLayout {
  try {
    const stored = window.localStorage.getItem(LAYOUT_STORAGE_KEY);
    return stored === 'columns' ? 'columns' : 'stacked';
  } catch {
    return 'stacked';
  }
}

const SENTENCE_END = new Set(['。', '！', '？', '!', '?', '…', '.', ';', '；']);
const CLOSERS = new Set(['"', "'", '”', '’', '」', '』', '）', ')', ']', '】']);

function splitSentences(text: string): string[] {
  if (!text) return [];
  const out: string[] = [];
  let start = 0;
  let index = 0;
  while (index < text.length) {
    const char = text[index]!;
    const next = text[index + 1];
    const endAt =
      SENTENCE_END.has(char) &&
      !(char === '.' && next !== undefined && /\d/.test(next));
    if (endAt) {
      let end = index + 1;
      while (end < text.length && CLOSERS.has(text[end]!)) end += 1;
      const piece = text.slice(start, end).trim();
      if (piece) out.push(piece);
      start = end;
      index = end;
      continue;
    }
    index += 1;
  }
  const tail = text.slice(start).trim();
  if (tail) out.push(tail);
  return out;
}

function sentenceOffsets(text: string): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  let cursor = 0;
  for (const sentence of splitSentences(text)) {
    let at = text.indexOf(sentence, cursor);
    if (at < 0) at = cursor;
    out.push({ start: at, end: at + sentence.length });
    cursor = at + sentence.length;
  }
  return out;
}

function mapSentenceSpan(
  source: string,
  translated: string,
  part: string
): [number, number, boolean] | null {
  const needle = part.trim();
  if (!needle) return null;
  const at = source.indexOf(needle);
  if (at < 0) return null;
  const end = at + needle.length;
  const picked = sentenceOffsets(source)
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.start < end && item.end > at)
    .map(({ index }) => index);
  if (picked.length === 0) return null;
  const start = picked[0]!;
  const stop = picked[picked.length - 1]!;
  const left = sentenceOffsets(source);
  const right = sentenceOffsets(translated);
  if (left.length === right.length) {
    const span = right.slice(start, stop + 1);
    return span.length
      ? [span[0]!.start, span[span.length - 1]!.end, true]
      : null;
  }
  const first = Math.min(right.length - 1, Math.floor((start / left.length) * right.length));
  const last = Math.max(
    first,
    Math.min(right.length - 1, Math.floor(((stop + 1) / left.length) * right.length) - 1)
  );
  const span = right.slice(first, last + 1);
  return span.length
    ? [span[0]!.start, span[span.length - 1]!.end, false]
    : null;
}

function mapSourcePart(translated: string, source: string, part: string): string {
  const needle = part.trim();
  if (!needle) return '';
  const at = translated.indexOf(needle);
  if (at < 0) return '';
  const end = at + needle.length;
  const picked = sentenceOffsets(translated)
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.start < end && item.end > at)
    .map(({ index }) => index);
  if (picked.length === 0) return '';
  const left = sentenceOffsets(translated);
  const right = sentenceOffsets(source);
  const first = Math.min(right.length - 1, picked[0]!);
  const last = Math.min(right.length - 1, picked[picked.length - 1]!);
  return source.slice(right[first]!.start, right[last]!.end);
}

export interface TranslationPanelProps {
  config: TranslationConfigRecord | null;
  page: TranslationPagePayload | null;
  job: TranslationJobRecord | null;
  summary: TranslationServiceSummary | null;
  highlightQuote?: string | null;
  currentPage: number;
  translating: boolean;
  saving: boolean;
  recognizing: boolean;
  ocrText?: string | null;
  pageText?: string | null;
  pageTextOrigin?: string;
  savingPageText: boolean;
  error?: string | null;
  onSavePageText(text: string): void;
  /** 阅读器面板只保存目标语言；翻译服务配置统一在设置页的「翻译」里。 */
  onSaveTargetLanguage(language: string): void;
  onTranslate(includeFurniture: boolean): void;
  onForceTranslate(includeFurniture: boolean): void;
  onRecognize(): void;
  onStartTranslation(includeFurniture: boolean): void;
  onForceStartTranslation(includeFurniture: boolean): void;
  onStopTranslation(): void;
  onLocateSegment(source: string): void;
  onHoverSegment(source: string | null): void;
  onEditSegment(segmentId: string, text: string): void;
  onRestoreSegment(segmentId: string): void;
  /** 单段重译：只把这一段原文重新发给翻译服务。 */
  onRetranslateSegment(index: number): void;
  /** 正在重译的段号（只禁用该段按钮，其余段不受影响）。 */
  retranslatingIndex?: number | null;
  /** 选文翻译结果（不写回页面、不保存）；undefined/null 表示还没有结果。 */
  quoteTranslation?: { text: string; error?: string; pending: boolean } | null;
  onTranslateQuote?(text: string): void;
  /**
   * 把译文里选中的一小段映射回原文（只读，不写库/不建批注）。
   * 返回 null 表示没有结果；成功后由面板调用 onLocateSegment 定位原文。
   */
  onAnchorTranslation?(page: number, excerpt: string): Promise<{
    quote: string;
    matched: boolean;
    exact: boolean;
    located: boolean;
    message?: string;
  } | null>;
  /** 当前文献 id：用于与独立译文窗口通过 BroadcastChannel 同步页码。 */
  documentId?: string;
  /** 收到译文窗口翻页时调用（主窗口跟随）。 */
  onPageChange?(page: number): void;
  /** 打开独立译文窗口；壳不支持时 undefined（按钮禁用并提示）。 */
  onOpenTranslationWindow?(): void;
  /**
   * 拉取指定页的页面图像（版式呈现用）；不提供时只保留「逐段」呈现方式。
   * 阅读区传 `api.getPageImage`；其它宿主可以实现自己的页图来源。
   */
  loadPageImage?(page: number, width: number): Promise<Blob>;
  /** 切到「版式」时通知外层：阅读区可顺手把译文栏加宽，避免整页缩得太小。 */
  onEnterLayoutView?(): void;
  /**
   * 阅读区内的紧凑模式：目标语言收成一行内联选择，隐藏“左右对照”排版开关
   * （阅读区已有原文/译文两栏，窄栏内再分栏没有意义）。
   */
  compact?: boolean;
}

export function TranslationPanel({
  config,
  page,
  job,
  summary,
  highlightQuote,
  currentPage,
  translating,
  saving,
  recognizing,
  ocrText,
  error,
  onSaveTargetLanguage,
  onTranslate,
  onForceTranslate,
  onRecognize,
  onSavePageText,
  pageText,
  pageTextOrigin,
  savingPageText,
  onStartTranslation,
  onForceStartTranslation,
  onStopTranslation,
  onLocateSegment,
  onHoverSegment,
  onEditSegment,
  onRestoreSegment,
  onRetranslateSegment,
  retranslatingIndex,
  quoteTranslation,
  onTranslateQuote,
  onAnchorTranslation,
  documentId,
  onPageChange,
  onOpenTranslationWindow,
  loadPageImage,
  onEnterLayoutView,
  compact = false
}: TranslationPanelProps): React.JSX.Element {
  const [target, setTarget] = useState(config?.target_language ?? 'zh');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [includeFurniture, setIncludeFurniture] = useState(false);
  const [pageDraft, setPageDraft] = useState('');
  const [quoteCopied, setQuoteCopied] = useState(false);
  const [layout, setLayout] = useState<TranslationLayout>(readStoredLayout);
  // 阅读区译文栏默认收起原文，避免每段译文前都压一大段原文；可一键展开全部。
  const [showSources, setShowSources] = useState(false);
  useEffect(() => {
    try {
      window.localStorage.setItem(LAYOUT_STORAGE_KEY, layout);
    } catch {
      // 本地存储不可用时只保留本次会话
    }
  }, [layout]);
  // 呈现方式：逐段列表 / 版式（页面原位）。偏好跨文献保留，和排版选择一样持久化。
  const [view, setView] = useState<TranslationView>(readStoredView);
  useEffect(() => {
    try {
      window.localStorage.setItem(VIEW_STORAGE_KEY, view);
    } catch {
      // 本地存储不可用时只保留本次会话
    }
  }, [view]);
  // 版式呈现要页面图像：按当前页懒加载；换页/重取时释放旧的对象 URL。
  const loaderRef = useRef(loadPageImage);
  useEffect(() => {
    loaderRef.current = loadPageImage;
  }, [loadPageImage]);
  const imageUrlRef = useRef<string | null>(null);
  const [pageImage, setPageImage] = useState<{ page: number; url: string } | null>(null);
  const [pageImageLoading, setPageImageLoading] = useState(false);
  const [pageImageError, setPageImageError] = useState('');
  useEffect(() => {
    const releaseImage = (): void => {
      if (imageUrlRef.current) {
        URL.revokeObjectURL(imageUrlRef.current);
        imageUrlRef.current = null;
      }
    };
    if (view !== 'layout') return;
    const loader = loaderRef.current;
    if (!loader) return;
    let cancelled = false;
    releaseImage();
    setPageImage(null);
    setPageImageLoading(true);
    setPageImageError('');
    loader(currentPage, 1400)
      .then((blob) => {
        if (cancelled) return;
        const url = URL.createObjectURL(blob);
        imageUrlRef.current = url;
        setPageImage({ page: currentPage, url });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setPageImageError(
            error instanceof Error ? error.message : '页面图像加载失败'
          );
        }
      })
      .finally(() => {
        if (!cancelled) setPageImageLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [view, currentPage]);
  useEffect(
    () => () => {
      if (imageUrlRef.current) URL.revokeObjectURL(imageUrlRef.current);
    },
    []
  );
  // 译文选区锚点：选中译文的一小段 → 映射回原文并定位（只读，不建批注）。
  const [selectedTranslation, setSelectedTranslation] = useState('');
  const [anchorNotice, setAnchorNotice] = useState('');
  const [anchorError, setAnchorError] = useState('');
  const [anchoring, setAnchoring] = useState(false);
  const highlightRef = useRef<HTMLLIElement | null>(null);

  useEffect(() => {
    highlightRef.current?.scrollIntoView({ block: 'nearest' });
  }, [highlightQuote, page?.page?.page]);

  useEffect(() => {
    setPageDraft(pageText ?? '');
  }, [pageText, currentPage]);

  useEffect(() => {
    if (!config) return;
    setTarget(config.target_language);
  }, [config]);

  // 与独立译文窗口同步页码：面板广播当前页；收到译文窗口翻页时让主窗口跟随。
  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined' || !documentId) return;
    const channel = new BroadcastChannel('studianda-translation');
    channel.postMessage({
      type: 'page',
      documentId,
      page: currentPage,
      source: 'main'
    });
    return () => channel.close();
  }, [documentId, currentPage]);

  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined' || !documentId || !onPageChange) return;
    const channel = new BroadcastChannel('studianda-translation');
    channel.onmessage = (event: MessageEvent<unknown>) => {
      const data = event.data as
        | { type?: unknown; documentId?: unknown; page?: unknown; source?: unknown }
        | null;
      if (!data || data.type !== 'page' || data.source !== 'translation-window') return;
      if (data.documentId !== documentId) return;
      const next = Number(data.page);
      if (Number.isInteger(next) && next >= 1) onPageChange(next);
    };
    return () => channel.close();
  }, [documentId, onPageChange]);

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    onSaveTargetLanguage(target);
  };

  const segments = page?.segments ?? [];
  // 已有译文时，主按钮直接变成「重新翻译」，不用再去「更多」里找。
  const hasPageTranslation = segments.some((segment) => Boolean(segment.text?.trim()));
  const hasDocumentTranslation = Boolean(summary && summary.total > 0);
  const hasStaleSegments = segments.some((segment) => segment.state === 'stale');

  const runAnchor = async (): Promise<void> => {
    if (!onAnchorTranslation || !selectedTranslation.trim()) return;
    setAnchoring(true);
    setAnchorError('');
    setAnchorNotice('');
    try {
      const result = await onAnchorTranslation(currentPage, selectedTranslation.trim());
      if (!result) {
        setAnchorNotice('没有可用的译文段落可映射。');
        return;
      }
      if (!result.matched) {
        setAnchorNotice(
          '未能在本页已保存的译文里匹配到这段文字（可能这一页还没有译文，或译文已被改写）。'
        );
        return;
      }
      setAnchorNotice(
        result.message ??
          (result.exact ? '已定位到原文对应句子。' : '已定位到原文段落（未能精确到句）。')
      );
      if (result.quote.trim()) onLocateSegment(result.quote);
    } catch (error) {
      setAnchorError(
        error instanceof Error ? error.message : '定位选中译文失败'
      );
    } finally {
      setAnchoring(false);
    }
  };
  const selectView = (next: TranslationView): void => {
    setView(next);
    if (next === 'layout') onEnterLayoutView?.();
  };
  const viewToggle = loadPageImage ? (
    <span className="kr-translation__view" role="group" aria-label="译文呈现方式">
      <button
        type="button"
        className={view === 'segments' ? 'is-active' : ''}
        aria-pressed={view === 'segments'}
        onClick={() => selectView('segments')}
        title="逐段列表：原文与译文逐段对照"
      >
        逐段
      </button>
      <button
        type="button"
        className={view === 'layout' ? 'is-active' : ''}
        aria-pressed={view === 'layout'}
        onClick={() => selectView('layout')}
        title="版式：把译文放回原文在页面上的位置（表格/公式保持原样）"
      >
        版式
      </button>
    </span>
  ) : null;
  const layoutViewActive = view === 'layout';
  return (
    <div
      className={`kr-translation${layout === 'columns' ? ' kr-translation--columns' : ''}${
        compact ? ' kr-translation--compact' : ''
      }`}
    >
      {compact ? (
        <div className="kr-translation__config-inline">
          <label>
            目标语言
            <select
              value={target}
              onChange={(event) => {
                setTarget(event.target.value);
                // 阅读区里改语言立即生效，不额外占用一行“保存”按钮。
                onSaveTargetLanguage(event.target.value);
              }}
              disabled={saving}
            >
              {(config?.targets ?? [{ id: 'zh', name: '简体中文' }]).map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <span className="kr-muted">服务在设置 → 翻译里配置</span>
        </div>
      ) : (
        <form className="kr-translation__config" onSubmit={submit}>
          <h4>目标语言</h4>
          <label>
            目标语言
            <select value={target} onChange={(event) => setTarget(event.target.value)}>
              {(config?.targets ?? [{ id: 'zh', name: '简体中文' }]).map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <p className="kr-muted">
            翻译服务的地址、模型与密钥在设置页的「翻译」里配置；这里只选择目标语言。
          </p>
          <button type="submit" disabled={saving}>
            {saving ? '保存中…' : '保存目标语言'}
          </button>
        </form>
      )}

      <div className="kr-translation__body">
        <div className="kr-translation__head">
          <h4>第 {currentPage} 页翻译</h4>
          {compact ? (
            <div className="kr-translation__compact-actions">
              <button
                type="button"
                onClick={() =>
                  hasPageTranslation
                    ? onForceTranslate(includeFurniture)
                    : onTranslate(includeFurniture)
                }
                disabled={translating}
              >
                {translating ? '翻译中…' : hasPageTranslation ? '重新翻译本页' : '翻译本页'}
              </button>
              <button
                type="button"
                onClick={() =>
                  hasDocumentTranslation
                    ? onForceStartTranslation(includeFurniture)
                    : onStartTranslation(includeFurniture)
                }
                disabled={job?.status === 'running'}
              >
                {job?.status === 'running'
                  ? '翻译整篇中…'
                  : hasDocumentTranslation
                    ? '重新翻译整篇'
                    : '翻译整篇'}
              </button>
              {viewToggle}
              {layoutViewActive ? null : (
                <button
                  type="button"
                  className={showSources ? 'is-active' : ''}
                  aria-pressed={showSources}
                  onClick={() => setShowSources((value) => !value)}
                  title="逐段显示或收起原文"
                >
                  {showSources ? '收起原文' : '显示原文'}
                </button>
              )}
              <details className="kr-translation__more">
                <summary>更多</summary>
                <div className="kr-translation__more-items">
                  <button
                    type="button"
                    onClick={onRecognize}
                    disabled={recognizing}
                  >
                    {recognizing ? '识别中…' : '识别本页'}
                  </button>
                  <button
                    type="button"
                    onClick={() => onOpenTranslationWindow?.()}
                    disabled={!onOpenTranslationWindow}
                  >
                    独立译文窗口
                  </button>
                  {job?.status === 'running' ? (
                    <button type="button" onClick={onStopTranslation}>
                      停止
                    </button>
                  ) : null}
                  <label className="kr-translation__more-check">
                    <input
                      type="checkbox"
                      checked={includeFurniture}
                      onChange={(event) => setIncludeFurniture(event.target.checked)}
                    />
                    连同页眉/页脚/注释
                  </label>
                </div>
              </details>
            </div>
          ) : (
          <div>
            <button
              type="button"
              onClick={() => onTranslate(includeFurniture)}
              disabled={translating}
            >
              {translating ? '翻译中…' : '翻译本页'}
            </button>
            <button
              type="button"
              onClick={() => onForceTranslate(includeFurniture)}
              disabled={translating}
            >
              重新翻译本页
            </button>
            <button
              type="button"
              onClick={onRecognize}
              disabled={recognizing}
            >
              {recognizing ? '识别中…' : '识别本页'}
            </button>
            <button
              type="button"
              onClick={() => onStartTranslation(includeFurniture)}
              disabled={job?.status === 'running'}
            >
              翻译整篇
            </button>
            {summary && summary.total > 0 ? (
              <button
                type="button"
                onClick={() => onForceStartTranslation(includeFurniture)}
                disabled={job?.status === 'running'}
              >
                重新翻译整篇
              </button>
            ) : null}
            {job?.status === 'running' ? (
              <button type="button" onClick={onStopTranslation}>
                停止
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => onOpenTranslationWindow?.()}
              disabled={!onOpenTranslationWindow}
              title={
                onOpenTranslationWindow
                  ? '在独立窗口显示本页译文（可与主窗口页码同步，适合多显示器）'
                  : '当前运行环境不支持独立译文窗口'
              }
            >
              独立译文窗口
            </button>
            {compact ? null : (
              <span className="kr-translation__layout" role="group" aria-label="译文排版">
                <span className="kr-muted">排版</span>
                <button
                  type="button"
                  className={layout === 'stacked' ? 'is-active' : ''}
                  aria-pressed={layout === 'stacked'}
                  onClick={() => setLayout('stacked')}
                  title="上下排列：原文在上、译文在下"
                >
                  上下
                </button>
                <button
                  type="button"
                  className={layout === 'columns' ? 'is-active' : ''}
                  aria-pressed={layout === 'columns'}
                  onClick={() => setLayout('columns')}
                  title="左右对照：左原文、右译文；面板较窄时会自动回退为上下"
                >
                  左右对照
                </button>
              </span>
            )}
            {compact ? null : viewToggle}
          </div>
          )}
        </div>
        {hasPageTranslation ? (
          <p className="kr-translation__ai-notice" role="note">
            机器翻译 · 由 AI 生成，可能出错，请核对原文
          </p>
        ) : null}
        {highlightQuote?.trim() && onTranslateQuote ? (
          <div className="kr-translation__quote-card">
            <div className="kr-translation__quote-head">
              <strong>选文翻译</strong>
              <button
                type="button"
                className="kr-secondary"
                onClick={() => {
                  setQuoteCopied(false);
                  onTranslateQuote(highlightQuote);
                }}
                disabled={quoteTranslation?.pending}
              >
                {quoteTranslation?.pending ? '翻译中…' : '翻译选文'}
              </button>
            </div>
            <p className="kr-muted">
              只翻译你选中的这段文字；不写回页面、不保存，也不发送文献整页。
            </p>
            <blockquote>{highlightQuote}</blockquote>
            {quoteTranslation?.error ? (
              <p className="kr-page-error">选文翻译失败：{quoteTranslation.error}</p>
            ) : null}
            {quoteTranslation?.text ? (
              <>
                <p className="kr-translation__quote-text" data-ai-copy="translation">
                  {quoteTranslation.text}
                </p>
                <p className="kr-translation__ai-notice" role="note">
                  机器翻译 · 由 AI 生成，可能出错，请核对原文
                </p>
                <button
                  type="button"
                  title="复制译文（自动附带机器翻译标识）"
                  onClick={() => {
                    const text = quoteTranslation.text;
                    if (!navigator.clipboard) {
                      setQuoteCopied(false);
                      return;
                    }
                    void navigator.clipboard.writeText(`${text}${AI_TRANSLATION_COPY_SUFFIX}`).then(
                      () => setQuoteCopied(true),
                      () => setQuoteCopied(false)
                    );
                  }}
                >
                  {quoteCopied ? '已复制' : '复制译文'}
                </button>
              </>
            ) : null}
          </div>
        ) : null}
        {compact ? null : (
          <label className="kr-translation__check">
            <input
              type="checkbox"
              checked={includeFurniture}
              onChange={(event) => setIncludeFurniture(event.target.checked)}
            />
            翻译页眉/页脚/注释（默认跳过）
          </label>
        )}
        {!compact && job && job.status !== 'idle' ? (
          <p className="kr-muted">
            整篇：{job.status}，{job.done}/{job.total} 页
            {job.currentPage ? `，正在第 ${job.currentPage} 页` : ''}
            {job.error ? `；${job.error}` : ''}
          </p>
        ) : null}
        {compact && hasStaleSegments ? (
          <p className="kr-translation__notice">
            本页分段已更新，旧译文已清除；点「重新翻译本页」生成新译文。
          </p>
        ) : null}
        {compact ? (
          <p className="kr-translation__meta">
            {page?.page
              ? `${page.page.done}/${page.page.total} 段 · ${page.page.status}`
              : '本页还没有译文'}
            {summary && summary.total > 0 ? ` · 已有译文 ${summary.total} 段` : ''}
            {job?.status === 'running'
              ? ` · 整篇翻译中 ${job.done}/${job.total}`
              : ''}
          </p>
        ) : null}
        {!compact && summary && summary.total > 0 ? (
          <p className="kr-muted">
            已有译文 {summary.total} 段：
            {summary.services
              .map((row) => `${row.service || '旧版'}（${row.count}）`)
              .join('、')}
            {summary.legacy > 0 ? `；其中旧版 ${summary.legacy} 段` : ''}
            。“重新翻译整篇”会覆盖这些译文。
          </p>
        ) : null}
        {error ? <p className="kr-page-error">{error}</p> : null}
        {ocrText ? (
          <details className="kr-translation__ocr">
            <summary>本页 OCR 文本（{ocrText.length} 字符）</summary>
            <pre data-ai-copy="ocr">{ocrText}</pre>
          </details>
        ) : null}
        <details className="kr-translation__ocr">
          <summary>校对本页原文（{pageTextOrigin ?? 'native'}）</summary>
          <textarea
            value={pageDraft}
            rows={8}
            onChange={(event) => setPageDraft(event.target.value)}
          />
          <button
            type="button"
            onClick={() => onSavePageText(pageDraft)}
            disabled={savingPageText || !pageDraft.trim()}
          >
            {savingPageText ? '保存中…' : '保存原文校对'}
          </button>
        </details>
        {compact ? null : page?.page ? (
          <p className="kr-muted">
            状态：{page.page.status}，{page.page.done}/{page.page.total} 段
            {page.page.error ? `；${page.page.error}` : ''}
          </p>
        ) : (
          <p className="kr-muted">本页还没有译文。</p>
        )}
        {compact ? null : page?.pageSize ? (
          <p className="kr-muted">
            版面：{page.columns ?? 1} 栏，行高 {page.bodyLineHeight ?? 0}，字号{' '}
            {page.bodyFontSize || '—'}；页眉/脚注/图表区域 {page.furniture ?? 0} 段
          </p>
        ) : null}
        {layoutViewActive && loadPageImage ? (
          <TranslationLayoutView
            currentPage={currentPage}
            pageSize={page?.pageSize ?? null}
            segments={segments}
            bodyFontSize={page?.bodyFontSize}
            imageUrl={pageImage?.page === currentPage ? pageImage.url : null}
            loading={pageImageLoading}
            error={pageImageError || null}
            highlightQuote={highlightQuote}
            onHoverSegment={onHoverSegment}
            onLocateSegment={onLocateSegment}
          />
        ) : (
          <>
        {!compact && onAnchorTranslation ? (
          <div className="kr-translation__anchor">
            {selectedTranslation ? (
              <>
                <button
                  type="button"
                  className="kr-secondary"
                  onClick={() => void runAnchor()}
                  disabled={anchoring}
                >
                  {anchoring ? '定位中…' : '定位选中译文到原文'}
                </button>
                <button
                  type="button"
                  className="kr-secondary"
                  onClick={() => setSelectedTranslation('')}
                >
                  清除选择
                </button>
              </>
            ) : (
              <p className="kr-muted">
                在下方译文里选中一小段文字，可定位回原文对应句子；只读，不会创建批注、也不写库。
              </p>
            )}
            {anchorNotice ? <p className="kr-muted">{anchorNotice}</p> : null}
            {anchorError ? <p className="kr-page-error">{anchorError}</p> : null}
          </div>
        ) : null}
        <ul
          className="kr-translation__segments"
          onMouseUp={() => {
            const selected = window.getSelection()?.toString().trim() ?? '';
            if (selected.length >= 2) setSelectedTranslation(selected.slice(0, 5000));
          }}
        >
          {segments.map((segment) => {
            const normalizedQuote = (highlightQuote ?? '').replace(/\s+/g, '').trim();
            const normalizedSource = segment.source.replace(/\s+/g, '').trim();
            const highlighted =
              normalizedQuote.length >= 4 &&
              (normalizedSource.includes(normalizedQuote) ||
                normalizedQuote.includes(normalizedSource));
            const translatedSpan =
              highlightQuote && segment.text
                ? mapSentenceSpan(segment.source, segment.text, highlightQuote)
                : null;
            const translatedText = segment.text || '（未翻译）';
            return (
            <li
              key={`segment-${segment.segment}`}
              ref={highlighted ? highlightRef : undefined}
              className={`${highlighted ? 'is-highlighted' : ''}${
                layout === 'columns' ? ' kr-translation__segment-grid' : ''
              }`}
              onMouseEnter={() => {
                // 鼠标移到整段译文上即自动定位对应原文（不需要再点「定位原文」）。
                if (!segment.skipped && segment.source.trim()) onHoverSegment(segment.source);
              }}
              onMouseLeave={() => onHoverSegment(null)}
            >
              <div className="kr-translation__segment-head">
                <span>第 {segment.segment} 段</span>
                {!segment.service || segment.service.includes('术语') ? (
                  <span className="kr-translation__legacy">旧版译文</span>
                ) : null}
                {segment.skipped ? (
                  <span className="kr-translation__legacy">默认跳过：页眉/脚注/注释</span>
                ) : null}
                {segment.state === 'reused' ? (
                  <span className="kr-translation__badge">复用</span>
                ) : null}
                {segment.truncated ? (
                  <span className="kr-translation__legacy">可能未译完</span>
                ) : null}
                {!segment.skipped ? (
                  <details className="kr-translation__segment-more">
                    <summary aria-label="更多操作" title="更多操作">
                      ⋯
                    </summary>
                    <div className="kr-translation__segment-more-items">
                      <button
                        type="button"
                        onClick={() => {
                          setEditingId(segment.id);
                          setEditText(segment.text);
                        }}
                      >
                        编辑
                      </button>
                      <button
                        type="button"
                        onClick={() => onRetranslateSegment(segment.segment)}
                        disabled={
                          !segment.source.trim() ||
                          retranslatingIndex === segment.segment
                        }
                        title="只把这一段原文重新发给翻译服务，覆盖这一段译文"
                      >
                        {retranslatingIndex === segment.segment ? '重译中…' : '重译'}
                      </button>
                      {segment.edited ? (
                        <button type="button" onClick={() => onRestoreSegment(segment.id)}>
                          恢复机器译文
                        </button>
                      ) : null}
                    </div>
                  </details>
                ) : null}
              </div>
              {compact && !showSources ? (
                <details className="kr-translation__source-toggle">
                  <summary>对应原文</summary>
                  <p className="kr-translation__source">{segment.source}</p>
                </details>
              ) : (
                <p className="kr-translation__source">{segment.source}</p>
              )}
              {editingId === segment.id ? (
                <div className="kr-translation__edit">
                  <textarea
                    value={editText}
                    rows={4}
                    onChange={(event) => setEditText(event.target.value)}
                  />
                  <div>
                    <button
                      type="button"
                      onClick={() => {
                        if (editText.trim()) onEditSegment(segment.id, editText.trim());
                        setEditingId(null);
                      }}
                    >
                      保存
                    </button>
                    <button type="button" onClick={() => setEditingId(null)}>
                      取消
                    </button>
                  </div>
                </div>
              ) : segment.skipped ? (
                <p className="kr-translation__text kr-muted">
                  （默认不翻译页眉/页脚/注释；本段未发送给模型）
                </p>
              ) : (
              <p
                className="kr-translation__text"
                data-ai-copy="translation"
                onMouseUp={() => {
                  const selection = window.getSelection();
                  const part = selection?.toString().trim() ?? '';
                  if (!part) return;
                  const sourcePart = mapSourcePart(segment.text, segment.source, part);
                  if (sourcePart) onLocateSegment(sourcePart);
                }}
              >
                {translatedSpan ? (
                  <>
                    {translatedText.slice(0, translatedSpan[0])}
                    <mark>{translatedText.slice(translatedSpan[0], translatedSpan[1])}</mark>
                    {translatedText.slice(translatedSpan[1])}
                  </>
                ) : (
                  translatedText
                )}
              </p>
              )}
            </li>
            );
          })}
        </ul>
          </>
        )}
      </div>
    </div>
  );
}
