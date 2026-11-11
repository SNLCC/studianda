/** 首次重建图片资源索引的提示条已读标记（值为 `note_assets.indexed_at`）。 */
export const ASSET_INDEX_ACK_STORAGE_KEY = 'studianda.assetIndexNoticeAck';

/**
 * 是否需要显示「已重建图片资源索引」提示条。
 *
 * 条件：indexedAt 非空、索引文件数或引用条数 > 0、且本地 ack 与当前 indexedAt 不同。
 * 旧 core 缺字段/全为 0 时不显示，不阻塞使用。
 */
export function shouldShowAssetIndexNotice(
  settings: Record<string, string> | undefined,
  ack: string
): boolean {
  if (!settings) return false;
  const indexedAt = (settings['note_assets.indexed_at'] ?? '').trim();
  if (!indexedAt) return false;
  const files = Number(settings['note_assets.indexed_files'] ?? '0');
  const refs = Number(settings['note_assets.indexed_refs'] ?? '0');
  if (!(files > 0) && !(refs > 0)) return false;
  return ack !== indexedAt;
}
