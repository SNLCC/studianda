import type { MetadataSource } from '@studianda/shared';
import { METADATA_SOURCE_PRIORITY } from '@studianda/shared';

/**
 * 题录来源（provenance）的覆盖规则。
 *
 * 背景：同一份文献的题录可能先后由不同路径写入（Zotero / PDF 内嵌元数据 /
 * 首页识别 / 文件名 / 用户手改）。规则只有两条：
 *
 * 1. 高优先级来源不被低优先级来源覆盖（例如 Zotero 不被文件名覆盖）；
 * 2. `manual`（用户手改）最高，自动路径永远不覆盖它；同等级来源可以刷新彼此
 *    （Zotero 重同步时字段更新要生效），因为用户手改会被标成 `manual`。
 *
 * 未知来源（迁移前的老记录，读取接口返回 `null`）视为最低优先级：
 * 不能证明它是用户数据，因此允许更高优先级的来源补全/刷新它；但读取时仍返回
 * `null`，不会把未知来源猜成任何具体值。
 */
export function metadataSourcePriority(source: MetadataSource | null | undefined): number {
  if (!source) return -1;
  return METADATA_SOURCE_PRIORITY[source] ?? -1;
}

/** 校验落库值：只接受枚举内的来源，其余（含空串/null）返回 `null`。 */
export function normalizeMetadataSource(value: unknown): MetadataSource | null {
  const text = typeof value === 'string' ? value.trim() : '';
  return text && Object.prototype.hasOwnProperty.call(METADATA_SOURCE_PRIORITY, text)
    ? (text as MetadataSource)
    : null;
}

/** 两个字来源取更可信的一个；都未知返回 `null`。 */
export function highestMetadataSource(
  left: MetadataSource | null | undefined,
  right: MetadataSource | null | undefined
): MetadataSource | null {
  const leftRank = metadataSourcePriority(left);
  const rightRank = metadataSourcePriority(right);
  if (leftRank < 0 && rightRank < 0) return null;
  return leftRank >= rightRank ? (normalizeMetadataSource(left) ?? null) : (normalizeMetadataSource(right) ?? null);
}

export interface MetadataOverwriteCheck {
  /** 本地当前值。 */
  existingValue: string;
  /** 本地当前值来源；未知为 null。 */
  existingSource: MetadataSource | null | undefined;
  /** 本次要写入的来源。 */
  incomingSource: MetadataSource;
}

/**
 * 本次来源是否允许覆盖本地已有值。
 *
 * - 本地没有值：允许补全（不构成覆盖）；
 * - 本地来源是 `manual`：永不覆盖；
 * - 否则按来源优先级：`incoming >= existing` 才覆盖（同等级允许刷新）。
 */
export function shouldOverwriteMetadataValue(input: MetadataOverwriteCheck): boolean {
  if (!String(input.existingValue ?? '').trim()) return true;
  const existing = normalizeMetadataSource(input.existingSource);
  if (existing === 'manual') return false;
  return (
    metadataSourcePriority(input.incomingSource) >= metadataSourcePriority(existing)
  );
}

export interface MergedMetadataField {
  value: string;
  /** 是否采用了本次来源的值（用于决定记录级 metadata_source）。 */
  applied: boolean;
}

/**
 * 单字段合并：允许覆盖才用新值，否则保留本地值。
 * 新值为空时永远不覆盖（不拿空值清掉已有题录）。
 */
export function mergeMetadataField(
  existingValue: string,
  existingSource: MetadataSource | null | undefined,
  incomingValue: string,
  incomingSource: MetadataSource
): MergedMetadataField {
  const incoming = String(incomingValue ?? '').trim();
  const current = String(existingValue ?? '');
  if (!incoming) return { value: current, applied: false };
  if (!shouldOverwriteMetadataValue({ existingValue: current, existingSource, incomingSource })) {
    return { value: current, applied: false };
  }
  return { value: incomingValue, applied: true };
}
