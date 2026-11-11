import { useMemo, useState } from 'react';
import type React from 'react';
import { renderMarkdown, type MarkdownInternalTarget } from '@studianda/shared';

export interface MarkdownContentProps {
  /** Markdown 源文本（存储格式；旧纯文本也是合法 Markdown）。 */
  source: string;
  /** 点击内部引用时回调；不传时内部引用按普通链接的默认行为（回到页首）。 */
  onOpenInternal?(target: MarkdownInternalTarget): void;
  /**
   * 点击 studianda-asset: 附件链接时回调（app 用 adapter.openNoteAsset 打开）。
   * 抛错/Reject 时组件内显示中文错误。
   */
  onOpenAsset?(url: string): void | Promise<void>;
  className?: string;
}

/** studianda-asset: 链接前缀（笔记图片/导入附件）。 */
export const ASSET_URL_PREFIX = 'studianda-asset:';

/** 是否为本地附件链接（studianda-asset:）。 */
export function isNoteAssetUrl(url: string): boolean {
  return (url ?? '').startsWith(ASSET_URL_PREFIX);
}

/**
 * 安全 Markdown 渲染。
 *
 * `renderMarkdown` 已在 shared 层转义所有用户输入并只生成白名单标签，
 * 这里只做事件委托：内部引用带 data-internal-*，点击后组 target 交给上层导航；
 * studianda-asset: 附件链接交给 onOpenAsset（不触发浏览器默认导航）。
 */
export function MarkdownContent({
  source,
  onOpenInternal,
  onOpenAsset,
  className
}: MarkdownContentProps): React.JSX.Element {
  const html = useMemo(() => renderMarkdown(source ?? ''), [source]);
  const [assetError, setAssetError] = useState('');

  const handleClick = (event: React.MouseEvent<HTMLDivElement>): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    const assetAnchor = target.closest(`a[href^="${ASSET_URL_PREFIX}"]`);
    if (assetAnchor instanceof HTMLAnchorElement) {
      event.preventDefault();
      event.stopPropagation();
      const href = assetAnchor.getAttribute('href') ?? '';
      if (!href.startsWith(ASSET_URL_PREFIX)) return;
      if (!onOpenAsset) {
        setAssetError('当前运行环境不支持打开本地附件。');
        return;
      }
      setAssetError('');
      void Promise.resolve(onOpenAsset(href)).catch((error: unknown) => {
        setAssetError(
          `打开附件失败：${error instanceof Error ? error.message : String(error)}`
        );
      });
      return;
    }

    const anchor = target.closest('.kr-md-internal');
    if (!(anchor instanceof HTMLElement) || !event.currentTarget.contains(anchor)) return;
    // 内部引用不跳转 href="#"，交给上层按 kind 打开文献/批注/笔记。
    event.preventDefault();
    event.stopPropagation();
    const kind = anchor.dataset.internalKind;
    const documentId = anchor.dataset.internalDoc ?? '';
    const itemId = anchor.dataset.internalId ?? '';
    const label = anchor.dataset.internalLabel || anchor.textContent || '';
    if (!onOpenInternal || !documentId) return;
    if (kind === 'annotation' && itemId) {
      onOpenInternal({ kind: 'annotation', documentId, annotationId: itemId, label });
      return;
    }
    if (kind === 'note' && itemId) {
      onOpenInternal({ kind: 'note', documentId, noteId: itemId, label });
      return;
    }
    if (kind === 'document') {
      onOpenInternal({ kind: 'document', documentId, label });
    }
  };

  return (
    <>
      <div
        className={`kr-md${className ? ` ${className}` : ''}`}
        onClick={handleClick}
        // renderMarkdown 的输出是白名单安全 HTML（所有用户文本都经过转义）。
        dangerouslySetInnerHTML={{ __html: html }}
      />
      {assetError ? (
        <p className="kr-page-error kr-md__asset-error" role="alert">
          {assetError}
        </p>
      ) : null}
    </>
  );
}

