import { useEffect, useState } from 'react';
import type React from 'react';
import type { BacklinkRecord, BacklinkTargetKind } from '@studianda/shared';

/** 反向链接查询目标：笔记 / 批注（或整篇文献）。 */
export interface BacklinkTarget {
  kind: BacklinkTargetKind;
  documentId: string;
  id?: string;
}

export interface BacklinksProps {
  target: BacklinkTarget;
  /** 点击「被引用」时才请求（懒加载）；不传则组件不渲染。 */
  loadBacklinks?(target: BacklinkTarget): Promise<BacklinkRecord[]>;
  /** 点击某条反向链接：打开来源文献并跳到来源页。 */
  onOpenBacklink?(backlink: BacklinkRecord): void;
  /** 折叠按钮文案，默认「被引用」。 */
  label?: string;
  /**
   * 内联展开（例如阅读页右栏「被引用」页签）：不渲染折叠按钮，
   * 挂载即加载并始终展示列表，由外层负责滚动。
   */
  expanded?: boolean;
}

const KIND_LABELS: Record<'note' | 'annotation', string> = {
  note: '笔记',
  annotation: '批注'
};

function pageLabel(page: number): string {
  return page > 0 ? `第 ${page} 页` : '整篇';
}

/**
 * 反向链接折叠区：显示哪些笔记/批注引用了当前笔记或批注。
 *
 * 懒加载：只有第一次点击「被引用」时才调用 loadBacklinks；再次点击折叠不重复请求，
 * 出错时可以点「重试」。目标变化时重置（正常列表里每条卡片一个实例）。
 */
export function Backlinks({
  target,
  loadBacklinks,
  onOpenBacklink,
  label = '被引用',
  expanded = false
}: BacklinksProps): React.JSX.Element | null {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<BacklinkRecord[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [loadedKey, setLoadedKey] = useState<string | null>(null);

  const targetKey = `${target.kind}:${target.documentId}:${target.id ?? ''}`;

  useEffect(() => {
    setOpen(false);
    setItems(null);
    setError('');
    setLoading(false);
    setLoadedKey(null);
  }, [targetKey]);

  const load = async (force = false): Promise<void> => {
    if (!loadBacklinks) return;
    if (!force && loadedKey === targetKey && items !== null) return;
    setLoading(true);
    setError('');
    try {
      const result = await loadBacklinks(target);
      setItems(result);
      setLoadedKey(targetKey);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '读取反向链接失败');
    } finally {
      setLoading(false);
    }
  };

  // 内联展开（页签内容）没有折叠按钮，挂载/换目标时自动加载一次。
  useEffect(() => {
    if (!expanded || !loadBacklinks) return;
    if (loadedKey === targetKey && items !== null) return;
    void load();
    // load 已用 loadedKey/items 守卫，避免重复请求。
  }, [expanded, targetKey, loadedKey, items]);

  if (!loadBacklinks) return null;

  const toggle = (): void => {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (loadedKey !== targetKey) void load();
  };

  const showBody = expanded || open;

  return (
    <div className={`kr-backlinks${expanded ? ' kr-backlinks--inline' : ''}`}>
      {expanded ? null : (
        <button
          type="button"
          className={`kr-backlinks__toggle${open ? ' is-open' : ''}`}
          aria-expanded={open}
          title="查看引用了本条内容的笔记与批注"
          onClick={toggle}
        >
          {label}
          {items ? `（${items.length}）` : ''}
        </button>
      )}
      {showBody ? (
        loading ? (
          <p className="kr-backlinks__hint">正在读取反向链接…</p>
        ) : error ? (
          <p className="kr-backlinks__error" role="alert">
            {error}
            <button type="button" className="kr-link-button" onClick={() => void load(true)}>
              重试
            </button>
          </p>
        ) : !items || items.length === 0 ? (
          <p className="kr-backlinks__hint">
            {expanded ? '还没有笔记或批注引用本文献。' : '还没有其他笔记或批注引用它。'}
          </p>
        ) : (
          <ul className="kr-backlinks__list">
            {items.map((item) => (
              <li key={`${item.kind}:${item.id}`}>
                <button
                  type="button"
                  className="kr-backlinks__item"
                  title={
                    onOpenBacklink
                      ? `打开来源${KIND_LABELS[item.kind]}：《${item.documentName}》${pageLabel(
                          item.page
                        )}`
                      : '暂不支持跳转'
                  }
                  disabled={!onOpenBacklink}
                  onClick={() => onOpenBacklink?.(item)}
                >
                  <span className="kr-backlinks__source">
                    {KIND_LABELS[item.kind]} · 《{item.documentName}》{pageLabel(item.page)}
                  </span>
                  <span className="kr-backlinks__snippet">
                    {item.snippet || '（无内容摘要）'}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )
      ) : null}
    </div>
  );
}
